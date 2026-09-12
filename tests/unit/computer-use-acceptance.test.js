'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')

const { createComputerUseRuntime } = require('../../app/computer-use/index.cjs')
const { createCdpPage } = require('../../app/computer-use/drivers/cdp-page.cjs')
const { createDevice } = require('../helpers/computer-use-device.cjs')
const { CODES } = require('../../app/computer-use/errors.cjs')

/**
 * Plan §53 — the ten minimum acceptance cases, end to end.
 *
 * Each case drives the *real* runtime (executor, stabilizer, verifier, miss
 * detector, recovery ladder, stall detector, safety gates, execution log)
 * against the in-process device: a virtual computer with real DOM state, real
 * z-ordered windows, real screenshots and a virtual clock. Nothing here is a
 * canned answer — every assertion is about state the runtime changed itself:
 * which control really got clicked, which file was really written, which pixel
 * really matched the canvas paint, how much virtual time really elapsed.
 *
 * The same scenarios run against real hardware in
 * `scripts/computer-use-acceptance.cjs` (Electron + Win32/UIA/CDP); this suite is
 * the deterministic half that CI can run.
 */

function createRuntime(device, options = {}) {
  const runtime = createComputerUseRuntime({
    host: {
      // The visible surface changes as windows come and go, so the page is
      // re-attached per run exactly like the shell does with its views.
      getPage: options.page ? () => options.page : () => device.page(),
      desktop: device.desktop,
      accessibility: device.accessibility,
      screenshot: device.screenshot,
      workspace: options.workspace || null,
      confirm: options.confirm,
      // The device owns a virtual filesystem, so the host supplies the file
      // facts the success criteria read — the same extension point a real host
      // uses for an application's own API.
      facts: options.facts
    },
    // The device's virtual clock: waits advance virtual time, so a 700 ms UI
    // costs microseconds of wall clock and the assertion is exact.
    clock: device.clock,
    log: { dir: null },
    options: { maxSteps: options.maxSteps || 20, ...(options.options || {}) }
  })
  return runtime
}

function stateOf(page, id) {
  return page.document.getElementById(id)
}

function isVisible(element) {
  if (!element) return false
  return !element.hasAttribute('hidden') && element.getAttribute('style') !== 'display:none'
}

// ---------------------------------------------------------------------------
// Test 1 — browser form: DOM first, verify the input, verify the submission
// ---------------------------------------------------------------------------
test('Test 1: a browser form is filled and submitted through the DOM, and both are verified', async () => {
  const device = createDevice()
  const page = device.openPage('form.html')
  const runtime = createRuntime(device, { page })
  try {
    const report = await runtime.run({
      goal: 'sign in with the fixture credentials',
      success_criteria: [{ kind: 'dom_text', selector: '#status', text: 'Saved' }],
      allowed_capabilities: ['browser'],
      plan: [
        {
          id: 'username',
          action: {
            type: 'DOM_TYPE',
            target: { selector: '#username' },
            text: 'alice',
            expected_effect: { any: [{ value_equals: 'alice' }] }
          }
        },
        {
          id: 'password',
          action: {
            type: 'DOM_TYPE',
            target: { selector: '#password' },
            text: 'correct-horse',
            sensitive: true,
            expected_effect: { any: [{ value_equals: 'correct-horse' }] }
          }
        },
        {
          id: 'submit',
          action: {
            type: 'DOM_CLICK',
            target: { selector: '#sign-in' },
            expected_effect: { any: [{ text_appears: 'Saved' }] }
          }
        }
      ]
    })

    assert.equal(report.status, 'completed', JSON.stringify(report.error))
    assert.equal(report.criteria.satisfied, true)
    // The DOM really holds what was typed, and the form really submitted.
    assert.equal(stateOf(page, 'username').value, 'alice')
    assert.equal(stateOf(page, 'password').value, '')
    assert.equal(isVisible(stateOf(page, 'status')), true)
    assert.equal(stateOf(page, 'status').textContent.trim(), 'Saved')

    // Plan §3/§3.2: the browser work was carried by the DOM channel, and every
    // step was verified — no screenshot was needed at any point.
    const steps = runtime.log.steps()
    assert.ok(steps.length >= 3)
    for (const step of steps) {
      assert.equal(step.channel, 'dom', `step ${step.step} should use the DOM channel`)
      assert.ok(step.verification, `step ${step.step} has no verification`)
      assert.equal(step.result, 'success')
    }
    assert.equal(runtime.log.screenshots().length, 0, 'a structured browser task needs no screenshot')
  } finally {
    device.dispose()
  }
})

// ---------------------------------------------------------------------------
// Test 2 — dynamic target: a stale coordinate must never be clicked
// ---------------------------------------------------------------------------
test('Test 2: a control that moves after load is re-resolved, not clicked at its old position', async () => {
  const device = createDevice()
  const page = device.openPage('dynamic.html')
  const runtime = createRuntime(device, { page })
  try {
    const before = await page.query('#moving')
    const report = await runtime.run({
      goal: 'click the moving button',
      success_criteria: [{ kind: 'dom_text', selector: '#clicked', text: 'Clicked' }],
      allowed_capabilities: ['browser'],
      plan: [{
        id: 'move-wait',
        action: { type: 'WAIT_STATE', waitFor: { condition: 'idle' }, timeout_ms: 900 }
      }, {
        id: 'click',
        action: {
          type: 'DOM_CLICK',
          target: { selector: '#moving' },
          expected_effect: { any: [{ text_appears: 'Clicked' }] }
        }
      }]
    })
    assert.equal(report.status, 'completed', JSON.stringify(report.error))
    assert.equal(stateOf(page, 'clicked').textContent.trim(), 'Clicked')

    // The button really is somewhere else now, and the old coordinates really
    // are empty — a runtime that reused the first resolution would have missed.
    const moved = await page.query('#moving')
    assert.notDeepEqual({ x: before.bbox.x, y: before.bbox.y }, { x: moved.bbox.x, y: moved.bbox.y })
    assert.equal(moved.bbox.x, 640)
    assert.equal(moved.bbox.y, 420)
  } finally {
    device.dispose()
  }
})

// ---------------------------------------------------------------------------
// Test 3 — missed click: detect it, re-locate, retry
// ---------------------------------------------------------------------------
test('Test 3: a swallowed click is detected as a miss, re-validated and retried', async () => {
  const device = createDevice()
  const page = device.openPage('miss.html')
  const runtime = createRuntime(device, { page })
  try {
    const report = await runtime.run({
      goal: 'arm the fixture through a button that eats its first click',
      success_criteria: [{ kind: 'dom_text', selector: '#state', text: 'Armed' }],
      allowed_capabilities: ['browser'],
      plan: [{
        id: 'arm',
        action: {
          type: 'DOM_CLICK',
          target: { selector: '#arm' },
          expected_effect: { any: [{ text_appears: 'Armed' }] },
          timeout_ms: 400
        }
      }]
    })
    assert.equal(report.status, 'completed', JSON.stringify(report.error))
    assert.equal(stateOf(page, 'state').textContent.trim(), 'Armed')

    // The first attempt really was swallowed, and the runtime noticed: at least
    // one recovery decision exists and it is a re-validation retry or an
    // alternative interaction (never a blind repetition).
    const decisions = report.recoveryDecisions
    assert.ok(decisions.length >= 1, 'the miss must produce a recovery decision')
    assert.ok(['retry', 'alternative_action'].includes(decisions[0].step), `unexpected first decision ${decisions[0].step}`)
    if (decisions[0].step === 'retry') assert.equal(decisions[0].revalidate, true)
    assert.ok(runtime.log.steps().some((step) => step.retryCount > 0 || /miss signals/.test(String(step.notes))),
      'the log must show the miss or the retry')
  } finally {
    device.dispose()
  }
})

// ---------------------------------------------------------------------------
// Test 4 — unexpected modal: pause the flow, handle it, resume
// ---------------------------------------------------------------------------
test('Test 4: an unexpected modal pauses the flow, is dismissed, and the task resumes', async () => {
  const device = createDevice()
  const page = device.openPage('modal.html')
  const runtime = createRuntime(device, { page })
  try {
    const report = await runtime.run({
      goal: 'open the modal and then click the control behind it',
      success_criteria: [{ kind: 'dom_text', selector: '#behind-state', text: 'Behind clicked' }],
      allowed_capabilities: ['browser'],
      plan: [
        {
          id: 'open',
          action: { type: 'DOM_CLICK', target: { selector: '#open-modal' }, expected_effect: { any: [{ dom_mutated: true }] }, timeout_ms: 400 }
        },
        {
          id: 'behind',
          action: { type: 'DOM_CLICK', target: { selector: '#behind' }, expected_effect: { any: [{ text_appears: 'Behind clicked' }] }, timeout_ms: 400 }
        }
      ]
    })
    assert.equal(page.__state.modals.length, 0, 'the modal must have been dismissed')
    assert.equal(report.status, 'completed', JSON.stringify(report.error))
    assert.equal(stateOf(page, 'behind-state').textContent.trim(), 'Behind clicked')
    // The runtime paused for the dialog rather than clicking through the overlay.
    assert.ok(report.states.includes('RECOVERING'), 'the run must have gone through modal recovery')
    assert.ok(runtime.log.tail(200).some((entry) => entry.kind === 'step' && /dismiss dialog/.test(String(entry.description))),
      'the dismissal must appear as its own verified step')
  } finally {
    device.dispose()
  }
})

// ---------------------------------------------------------------------------
// Test 5 — desktop application: window, focus, edit, save, verify on disk
// ---------------------------------------------------------------------------
test('Test 5: a desktop application is launched, focused, edited and saved, with the file verified', async () => {
  const device = createDevice()
  const runtime = createRuntime(device)
  try {
    const opened = device.desktop.openApplication({
      title: 'Editor - doc.txt',
      className: 'VirtualEditor',
      fixture: 'editor.html'
    })
    assert.equal(opened.ok, true)
    const windowHandle = opened.detail.handle
    const page = device.page()
    // The editor's document lives in the device's virtual filesystem, so the
    // file criteria read it through the host facts hook.
    const runtime = createRuntime(device, {
      facts: {
        fileExists: async (target) => {
          try {
            device.files.read(String(target))
            return true
          } catch {
            return false
          }
        },
        fileContains: async (target, text) => {
          try {
            // The device's `read` returns the file's content as a string.
            return String(device.files.read(String(target))).includes(String(text))
          } catch {
            return false
          }
        },
        fileModifiedSince: async (target, since) => {
          try {
            const stats = device.files.stat ? device.files.stat(String(target)) : null
            if (!stats) return true
            return since === null || since === undefined ? true : Number(stats.mtime) >= Number(since)
          } catch {
            return false
          }
        }
      }
    })

    const report = await runtime.run({
      goal: 'open doc.txt, change it and save it',
      allowed_capabilities: ['desktop', 'browser', 'filesystem'],
      success_criteria: [
        { kind: 'window_exists', title: 'Editor - doc.txt' },
        { kind: 'file_contains', path: '/workspace/doc.txt', text: 'hello from computer use' }
      ],
      plan: [
        {
          id: 'focus',
          action: {
            type: 'FOCUS',
            // A window target with no declared effect: the implied verification
            // is "that window now has focus", which is what a FOCUS step means.
            target: { window: { handle: windowHandle } },
            timeout_ms: 500
          }
        },
        {
          id: 'edit',
          action: {
            type: 'DOM_TYPE',
            target: { selector: '#doc' },
            text: 'hello from computer use',
            expected_effect: { any: [{ value_equals: 'hello from computer use' }] },
            timeout_ms: 500
          }
        },
        {
          id: 'save',
          action: {
            type: 'HOTKEY',
            keys: ['ctrl', 's'],
            target: { selector: '#doc' },
            expected_effect: { any: [{ file_modified: '/workspace/doc.txt' }] },
            timeout_ms: 800
          }
        }
      ]
    })

    assert.equal(report.status, 'completed', JSON.stringify(report.error))
    // Plan §31/§33/§27: the window and the focus were verified as part of the run.
    const foreground = device.windows.find((window) => window.foreground)
    assert.equal(foreground.handle, windowHandle)
    assert.equal(page.document.activeElement.id, 'doc')
    // The save really happened: the file exists on the virtual disk with the
    // typed content (nothing was written before Ctrl+S).
    assert.equal(String(device.files.read('/workspace/doc.txt')), 'hello from computer use')
    assert.equal(stateOf(page, 'saved').textContent.trim(), 'Saved to doc.txt')
    assert.equal(report.criteria.satisfied, true)
  } finally {
    device.dispose()
  }
})

// ---------------------------------------------------------------------------
// Test 6 — slow UI: wait on the condition, never on a fixed sleep
// ---------------------------------------------------------------------------
test('Test 6: a 700 ms UI is waited for by condition and a fast one is not over-waited', async () => {
  const device = createDevice()
  const page = device.openPage('slow.html')
  const runtime = createRuntime(device, { page })
  try {
    const startedAt = device.clock.now()
    const report = await runtime.run({
      goal: 'run the slow task and then the fast task',
      allowed_capabilities: ['browser'],
      success_criteria: [
        { kind: 'dom_text', selector: '#slow-result', text: 'Slow finished' },
        { kind: 'dom_text', selector: '#fast-result', text: 'Fast finished' }
      ],
      plan: [
        {
          id: 'slow',
          action: { type: 'DOM_CLICK', target: { selector: '#slow' }, expected_effect: { any: [{ text_appears: 'Slow finished' }] }, timeout_ms: 2000 }
        },
        {
          id: 'fast',
          action: { type: 'DOM_CLICK', target: { selector: '#fast' }, expected_effect: { any: [{ text_appears: 'Fast finished' }] }, timeout_ms: 2000 }
        }
      ]
    })
    assert.equal(report.status, 'completed', JSON.stringify(report.error))
    const elapsed = device.clock.now() - startedAt
    // The slow effect needs 700 ms and the fast one 120 ms; the runtime must
    // have waited for both and must NOT have spent a fixed multi-second sleep.
    assert.ok(elapsed >= 820, `expected to wait for both effects, elapsed ${elapsed}`)
    assert.ok(elapsed < 2000, `a fixed sleep would have cost more than the effects need (elapsed ${elapsed})`)
    assert.equal(stateOf(page, 'slow-result').textContent.trim(), 'Slow finished')
    assert.equal(stateOf(page, 'fast-result').textContent.trim(), 'Fast finished')

    // The wait was an event wait: the log shows a real wait budget per step.
    const steps = runtime.log.steps()
    assert.ok(steps.some((step) => Number(step.waitMs) > 0), 'the log must show the conditional wait')
    assert.ok(steps.every((step) => Number(step.graceMs) <= 250), 'grace stays inside the documented bound')
  } finally {
    device.dispose()
  }
})

// ---------------------------------------------------------------------------
// Test 7 — canvas: DOM cannot address the target, so vision must
// ---------------------------------------------------------------------------
test('Test 7: a canvas-painted target with no DOM node is reached through vision', async () => {
  const device = createDevice()
  // A real application window hosts the page: the canvas is drawn into the
  // window's framebuffer exactly like a real canvas would be.
  const opened = device.desktop.openApplication({ title: 'Checkout', className: 'VirtualBrowser', fixture: 'canvas.html' })
  const page = device.page()
  const runtime = createRuntime(device)
  try {
    // Structure first: the only *structural* control that says "Submit order" is
    // the decoy, which reports the wrong target when clicked.
    const structural = await page.queryAll()
    const decoy = structural.find((element) => element.selector === '#decoy')
    assert.ok(decoy, 'the decoy button is the structural trap')
    assert.equal(structural.some((element) => element.tagName === 'canvas' && element.role !== 'img'), false,
      'the canvas is not an interactive control - structure cannot address it')

    // Vision: capture the window and find the painted control.
    const capture = await runtime.controllers.vision.capture(2, { windowHandle: opened.detail.handle, reason: 'acceptance-test-7' })
    assert.equal(capture.level, 2)
    const located = await runtime.controllers.vision.locateVisual(
      { visual: { paint: { color: '#ff8800', width: 200, height: 48 } } },
      { capture }
    )
    assert.equal(located.ok, true, located.reason)
    assert.equal(located.strategy, 'color-region')

    // The detected rectangle is the canvas rect, in screen coordinates.
    const rect = located.rect
    const canvasBox = canvasBoxOf(await page.query('#order'), device)
    assert.ok(Math.abs(rect.width - canvasBox.width) <= 2 && Math.abs(rect.height - canvasBox.height) <= 2,
      `vision must find the painted control (${JSON.stringify(rect)} vs ${JSON.stringify(canvasBox)})`)

    // Clicking the *detected* point reaches the real target; the decoy would
    // have produced "Wrong target" instead.
    const click = await device.desktop.click({ x: located.point.x, y: located.point.y })
    assert.equal(click.ok, true)
    assert.equal(stateOf(page, 'ordered').textContent.trim(), 'Ordered')
    assert.equal(isVisible(stateOf(page, 'wrong')), false, 'the decoy must not have been used')

    // And the runtime reports the vision controller as the reason it worked.
    assert.equal(runtime.health().controllers.find((controller) => controller.controller === 'vision').available, true)
  } finally {
    device.dispose()
  }
})

test('Test 7b: the same canvas target is reached by the run loop through the visual rung', async () => {
  const device = createDevice()
  const opened = device.desktop.openApplication({ title: 'Checkout', className: 'VirtualBrowser', fixture: 'canvas.html' })
  const page = device.page()
  const runtime = createRuntime(device)
  try {
    const report = await runtime.run({
      goal: 'place the order through the painted button',
      allowed_capabilities: ['browser', 'desktop', 'vision'],
      success_criteria: [{ kind: 'dom_text', selector: '#ordered', text: 'Ordered' }],
      plan: [{
        id: 'order',
        action: {
          type: 'CLICK',
          // No DOM node and no accessibility node exists for this target: the
          // only description of it is what it looks like.
          target: { visual: { paint: { color: '#ff8800', width: 200, height: 48 } }, window: { handle: opened.detail.handle } },
          expected_effect: { any: [{ text_appears: 'Ordered' }] },
          timeout_ms: 1500
        }
      }]
    })
    assert.equal(report.status, 'completed', JSON.stringify(report.error))
    assert.equal(stateOf(page, 'ordered').textContent.trim(), 'Ordered')
    assert.equal(isVisible(stateOf(page, 'wrong')), false)
    const steps = runtime.log.steps()
    assert.equal(steps.length, 1)
    assert.equal(steps[0].channel, 'gui', 'a visual target can only be clicked through real coordinates')
    assert.equal(steps[0].coordinateFallback, true)
  } finally {
    device.dispose()
  }
})

function canvasBoxOf(canvasDescriptor, device) {
  const window = device.windows[0]
  const content = window && window.contentBounds ? window.contentBounds : { x: 0, y: 24 }
  return {
    x: content.x + canvasDescriptor.bbox.x,
    y: content.y + canvasDescriptor.bbox.y,
    width: canvasDescriptor.bbox.width,
    height: canvasDescriptor.bbox.height
  }
}

// ---------------------------------------------------------------------------
// Test 8 — window overlay: never click the old coordinates of a covered window
// ---------------------------------------------------------------------------
test('Test 8: a target window that is covered is not clicked through', async () => {
  const device = createDevice()
  const target = device.desktop.openApplication({ title: 'Target App', className: 'TargetApp', fixture: 'form.html' })
  const runtime = createRuntime(device)
  try {
    const page = device.page()
    const button = await page.query('#sign-in')
    const window = device.windows.find((entry) => entry.handle === target.detail.handle)
    const content = window.contentBounds
    const point = { x: content.x + button.bbox.x + Math.round(button.bbox.width / 2), y: content.y + button.bbox.y + Math.round(button.bbox.height / 2) }

    // A second window is moved over that exact point and takes the focus.
    device.desktop.openApplication({
      title: 'Covering Window',
      className: 'CoveringApp',
      bounds: { x: 0, y: 0, width: 1024, height: 792 },
      fixture: 'modal.html'
    })
    const covering = device.windows.find((entry) => entry.foreground)
    assert.equal(covering.title, 'Covering Window')

    const report = await runtime.run({
      goal: 'click Sign in inside the target window',
      allowed_capabilities: ['desktop'],
      plan: [{
        id: 'click',
        action: {
          type: 'CLICK',
          target: { window: { title: 'Target App' } },
          point,
          expected_effect: { any: [{ text_appears: 'Saved' }] },
          timeout_ms: 300,
          retry: { max_attempts: 0 }
        }
      }],
      limits: { max_steps: 4, max_retries_per_action: 0 }
    })

    // The click either never happened, or was refused with the reason the plan
    // calls out: the expected window was not in front.
    assert.notEqual(report.status, 'completed')
    assert.ok(
      [CODES.WINDOW_MISMATCH, CODES.SAFETY_REFUSED, CODES.VERIFICATION_FAILED, CODES.CONTROLLER_UNAVAILABLE].includes(report.error.code),
      `unexpected refusal code ${report.error.code}`
    )
    assert.equal(stateOf(page, 'status').hasAttribute('hidden'), true, 'the covered page must not have been submitted')

    // Once the target window is brought back to the front, the same action works.
    device.desktop.focusWindow(target.detail.handle)
    const targetPage = device.page(device.windows.find((entry) => entry.handle === target.detail.handle).pageId)
    const retryRuntime = createRuntime(device, { page: targetPage })
    const retry = await retryRuntime.run({
      goal: 'click Sign in inside the focused target window',
      allowed_capabilities: ['desktop', 'browser'],
      plan: [{
        id: 'click',
        action: {
          type: 'DOM_CLICK',
          target: { selector: '#sign-in' },
          expected_effect: { any: [{ dom_mutated: true }] },
          timeout_ms: 500
        }
      }]
    })
    assert.equal(retry.status, 'completed', JSON.stringify(retry.error))
  } finally {
    device.dispose()
  }
})

// ---------------------------------------------------------------------------
// Test 9 — controller failure: the rest of the runtime keeps working
// ---------------------------------------------------------------------------
test('Test 9: a broken vision controller does not disable the structured controllers', async () => {
  const device = createDevice()
  const page = device.openPage('form.html')
  const broken = {
    probe: () => {
      throw new Error('the screenshot backend is unavailable on this host')
    },
    captureRegion: async () => {
      throw new Error('no display')
    },
    captureWindow: async () => {
      throw new Error('no display')
    },
    captureFull: async () => {
      throw new Error('no display')
    }
  }
  const runtime = createComputerUseRuntime({
    host: { page, desktop: device.desktop, accessibility: device.accessibility, screenshot: broken },
    clock: device.clock,
    log: { dir: null }
  })
  try {
    const health = runtime.health()
    const byId = (id) => health.controllers.find((controller) => controller.controller === id)
    assert.equal(byId('vision').available, false)
    assert.match(byId('vision').reason, /screenshot backend/)
    assert.equal(byId('browser').available, true)
    assert.equal(byId('desktop').available, true)
    assert.equal(byId('shell').available, true)
    assert.equal(byId('file').available, true)

    const report = await runtime.run({
      goal: 'sign in while vision is broken',
      success_criteria: [{ kind: 'dom_text', selector: '#status', text: 'Saved' }],
      allowed_capabilities: ['browser'],
      plan: [
        { action: { type: 'DOM_TYPE', target: { selector: '#username' }, text: 'alice', expected_effect: { any: [{ value_equals: 'alice' }] } } },
        { action: { type: 'DOM_TYPE', target: { selector: '#password' }, text: 'secret', sensitive: true, expected_effect: { any: [{ value_equals: 'secret' }] } } },
        { action: { type: 'DOM_CLICK', target: { selector: '#sign-in' }, expected_effect: { any: [{ text_appears: 'Saved' }] } } }
      ]
    })
    assert.equal(report.status, 'completed', JSON.stringify(report.error))
    assert.equal(runtime.health().faults.length, 0, 'a degraded controller must not register as a runtime fault')
  } finally {
    device.dispose()
  }
})

// ---------------------------------------------------------------------------
// Test 10 — stall: detect it, try to recover, fail gracefully at the limit
// ---------------------------------------------------------------------------
test('Test 10: an unresponsive page is detected as a stall, recovery runs, and the run fails with context', async () => {
  const device = createDevice()
  const page = device.openPage('stall.html')
  // A planner that keeps asking for the same stuck action: this is a task that
  // keeps trying on a page that never responds.
  const stuckAction = {
    type: 'DOM_CLICK',
    target: { selector: '#apply' },
    expected_effect: { any: [{ text_appears: 'Applied' }] },
    timeout_ms: 150
  }
  const runtime = createComputerUseRuntime({
    host: { page, desktop: device.desktop, accessibility: device.accessibility, screenshot: device.screenshot, planner: async () => stuckAction },
    clock: device.clock,
    log: { dir: null },
    options: { maxSteps: 20 }
  })
  try {
    const report = await runtime.run({
      goal: 'apply a change on a page that stops responding',
      allowed_capabilities: ['browser'],
      plan: [{ action: stuckAction }],
      limits: { max_steps: 20, max_retries_per_action: 1, max_stall_recoveries: 1 }
    })

    assert.equal(report.status, 'failed')
    assert.equal(report.error.code, CODES.STALL_DETECTED, `expected a stall failure, saw ${report.error.code}`)
    assert.ok(report.stallRecoveries >= 1, 'the stall recovery ladder must have run')
    assert.ok(report.states.includes('STALLED'), 'the state machine must show the stall')
    assert.ok(report.steps <= 20, 'the run must be bounded by its step limit')
    assert.equal(stateOf(page, 'applied').hasAttribute('hidden'), true, 'nothing was ever applied')

    // Graceful failure: the report carries the context that was gathered.
    assert.ok(Array.isArray(report.error.details.history) && report.error.details.history.length > 0)
    assert.ok(report.outcomes.length >= 3, 'the stall needs several actions without progress')
    assert.ok(runtime.log.tail(200).some((entry) => entry.kind === 'event' && entry.type === 'stall'))
  } finally {
    device.dispose()
  }
})

// ---------------------------------------------------------------------------
// Cross-cutting: the same runtime also drives a real CDP page adapter, so the
// production browser path is exercised (against the device's DOM through CDP).
// ---------------------------------------------------------------------------
test('the CDP page adapter maps the plan action surface onto real protocol calls', async () => {
  const calls = []
  const fakePage = {
    url: 'https://example.test/form',
    revision: 1,
    nodes: { '#username': 'node-1', '#sign-in': 'node-2' },
    transport: {
      probe: () => ({ available: true }),
      async send(method, params) {
        calls.push({ method, params })
        switch (method) {
          case 'Runtime.evaluate': {
            const expression = String(params.expression)
            if (expression.includes('__dshCu') && expression.includes('revision')) return { result: { value: { url: fakePage.url, revision: fakePage.revision, state: 'complete' } } }
            if (expression.includes('querySelectorAll')) return { result: { value: [] } }
            if (expression.includes('document.activeElement') || expression.includes('location.href')) return { result: { value: 'https://example.test/form' } }
            if (expression.includes('revision: state.revision')) return { result: { value: { url: fakePage.url, title: 'Form', readyState: 'complete', revision: fakePage.revision, focusedRef: null, viewport: { x: 0, y: 0, width: 1024, height: 768 }, controls: [] } } }
            return { result: { value: null } }
          }
          case 'Accessibility.getFullAXTree':
            return { nodes: [{ nodeId: '1', role: { value: 'button' }, name: { value: 'Sign in' }, properties: [{ name: 'focusable', value: { value: true } }] }] }
          case 'Page.navigate':
            return { loaderId: 'L1' }
          case 'Page.captureScreenshot':
            return { data: Buffer.from('89504e470d0a1a0a', 'hex').toString('base64') }
          default:
            return {}
        }
      }
    }
  }
  const page = createCdpPage({ transport: fakePage.transport })
  const probe = page.probe()
  assert.equal(probe.available, true)
  await page.attach()
  assert.ok(calls.some((call) => call.method === 'Page.enable'))
  assert.ok(calls.some((call) => call.method === 'Runtime.enable'))
  assert.ok(calls.some((call) => call.method === 'Accessibility.enable'))
  const tree = await page.accessibility()
  assert.equal(tree.length, 1)
  assert.equal(tree[0].role, 'button')
  assert.equal(tree[0].name, 'Sign in')
  const shot = await page.screenshot()
  assert.ok(Buffer.isBuffer(shot.png) && shot.png.length > 0)
  const navigated = await page.navigate('https://example.test/next')
  assert.equal(navigated.ok, true)
  assert.ok(calls.some((call) => call.method === 'Input.dispatchMouseEvent') === false)
})
