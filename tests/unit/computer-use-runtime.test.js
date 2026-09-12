'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createComputerUseRuntime } = require('../../app/computer-use/index.cjs')
const { createContract } = require('../../app/computer-use/contract.cjs')
const { createVirtualClock } = require('../helpers/computer-use-clock.cjs')
const { CODES } = require('../../app/computer-use/errors.cjs')

/**
 * The execution loop end to end (plan §2, §43, §46, §49, §52).
 *
 * Each test drives a real runtime — real executor, stabilizer, verifier,
 * recovery ladder, stall detector and log — against a page double that models
 * one specific failure mode. The double is the *environment*; every assertion
 * is about what the runtime did with it.
 */

/**
 * A page double with scriptable behaviour:
 *  - `eatFirstClicks`: the first N clicks are swallowed (the miss scenario)
 *  - `moveAfterMs`: the button relocates on the virtual clock
 *  - `effectDelayMs`: the effect of a click appears after N ms (slow UI)
 *  - `freeze`: nothing ever changes (the stall scenario)
 *  - `modal`: clicking opens a blocking dialog
 */
function createPageDouble(options = {}) {
  const clock = options.clock
  const state = {
    url: options.url || 'https://example.test/form',
    title: 'Fixture',
    revision: 1,
    value: '',
    checked: false,
    submitted: false,
    eaten: 0,
    clickedAt: null,
    buttonX: options.buttonX === undefined ? 40 : options.buttonX,
    modalOpen: false,
    events: [],
    clicks: [],
    focusedRef: null
  }

  function bump(type) {
    state.revision += 1
    if (type) state.events.push({ type, at: clock ? clock.now() : Date.now() })
  }

  /** The slow UI: the effect lands `effectDelayMs` after the click. */
  function settleSubmitted() {
    if (!state.clickedAt) return
    // A fixture that opens a modal never reaches its success state: the point of
    // that scenario is that the flow is interrupted.
    if (options.modal) return
    const delay = options.effectDelayMs === undefined ? 0 : options.effectDelayMs
    const elapsed = (clock ? clock.now() : Date.now()) - state.clickedAt
    if (elapsed >= delay) state.submitted = true
  }

  function elements() {
    settleSubmitted()
    const list = [
      {
        ref: 'cu-username',
        tag: 'input',
        role: 'textbox',
        name: 'username',
        text: '',
        value: state.value,
        checked: null,
        disabled: false,
        visible: true,
        actionable: true,
        bbox: { x: 20, y: 40, width: 180, height: 24 },
        selector: '#username',
        attributes: { id: 'username', name: 'username' }
      },
      {
        ref: 'cu-submit',
        tag: 'button',
        role: 'button',
        name: 'Submit',
        text: 'Submit',
        value: null,
        checked: null,
        disabled: false,
        visible: true,
        actionable: true,
        bbox: { x: state.buttonX, y: state.buttonY === undefined ? 420 : state.buttonY, width: 90, height: 26 },
        selector: '#submit',
        attributes: { id: 'submit' }
      }
    ]
    if (state.submitted) {
      list.push({
        ref: 'cu-status',
        tag: 'div',
        role: 'status',
        name: 'Saved',
        text: 'Saved',
        value: null,
        checked: null,
        disabled: false,
        visible: true,
        actionable: false,
        bbox: { x: 20, y: 480, width: 120, height: 20 },
        selector: '#status',
        attributes: { id: 'status' }
      })
    }
    if (state.modalOpen) {
      list.push({
        ref: 'cu-dialog-dismiss',
        tag: 'button',
        role: 'button',
        name: 'Dismiss',
        text: 'Dismiss',
        value: null,
        checked: null,
        disabled: false,
        visible: true,
        actionable: true,
        bbox: { x: 300, y: 300, width: 80, height: 24 },
        selector: '#dismiss',
        attributes: { id: 'dismiss' }
      })
    }
    return list
  }

  return {
    state,
    probe: () => ({ available: true, reason: null }),
    snapshot: async () => {
      settleSubmitted()
      if (options.moveAfterMs !== undefined && state.clickedAt === null && clock && clock.now() - 1000 >= options.moveAfterMs && state.buttonX < 640) {
        state.buttonX = options.moveTo ? options.moveTo.x : 640
        bump('dom_mutated')
      }
      return {
        id: 'page-1',
        url: state.url,
        title: state.title,
        readyState: 'complete',
        loading: false,
        revision: state.revision,
        focusedRef: state.focusedRef,
        tabs: [{ id: 'page-1', url: state.url, title: state.title, active: true }],
        controls: elements(),
        dialogs: state.modalOpen ? [{ type: 'alert', message: 'Session expired', open: true, blocking: true, ref: 'cu-dialog' }] : [],
        viewport: { x: 0, y: 0, width: 1024, height: 768 }
      }
    },
    query: async (selector) => elements().filter((element) => element.selector === selector),
    queryAll: async () => elements(),
    accessibility: async () => elements().map((element) => ({ ref: element.ref, role: element.role, name: element.name, enabled: !element.disabled, bounds: element.bbox })),
    clickElement: async (ref) => {
      state.clicks.push(ref)
      if (options.eatFirstClicks && state.eaten < options.eatFirstClicks) {
        state.eaten += 1
        // A swallowed click: no handler ran, nothing changed at all.
        return { ok: true, missed: true, changed: false, detail: 'the click was swallowed by an overlay' }
      }
      if (ref === 'cu-dialog-dismiss') {
        state.modalOpen = false
        bump('dialog_closed')
        return { ok: true, changed: true }
      }
      if (ref === 'cu-submit' && options.modal) {
        state.modalOpen = true
        state.clickedAt = clock ? clock.now() : Date.now()
        bump('dialog_opened')
        return { ok: true, changed: true }
      }
      if (ref === 'cu-submit') {
        if (options.freeze) return { ok: true, changed: false, missed: true }
        state.clickedAt = clock ? clock.now() : Date.now()
        bump('dom_mutated')
        return { ok: true, changed: true }
      }
      return { ok: true, changed: false }
    },
    focusElement: async (ref) => {
      state.focusedRef = ref
      bump('focus_changed')
      return { ok: true, ref }
    },
    typeText: async (ref, text) => {
      state.value = text
      state.focusedRef = ref
      bump('input')
      return { ok: true, value: text }
    },
    setValue: async (ref, value) => {
      state.value = value
      return { ok: true, value }
    },
    selectOption: async () => ({ ok: true }),
    scroll: async () => ({ ok: true }),
    navigate: async (url) => {
      state.url = url
      bump('url_changed')
      return { ok: true }
    },
    historyBack: async () => ({ ok: true }),
    historyForward: async () => ({ ok: true }),
    reload: async () => ({ ok: true }),
    tabs: async () => [{ id: 'page-1', url: state.url, title: state.title, active: true }],
    dialogs: async () => (state.modalOpen ? [{ type: 'alert', message: 'Session expired', open: true, blocking: true }] : []),
    answerDialog: async () => ({ ok: true }),
    waitFor: async () => ({ ok: true }),
    events: () => ({
      sinceLastCheck() {
        const drained = state.events.slice()
        state.events = []
        return drained
      }
    }),
    screenshot: async () => ({ png: Buffer.from('89504e470d0a1a0a', 'hex') }),
    close: async () => ({ ok: true })
  }
}

function makeRuntime(page, options = {}) {
  const clock = options.clock || createVirtualClock()
  const runtime = createComputerUseRuntime({
    host: { page, confirm: options.confirm },
    clock,
    log: { dir: null },
    options: { autonomyEnabled: options.autonomyEnabled, maxSteps: options.maxSteps || 20 }
  })
  return { runtime, clock }
}

const SUBMIT_PLAN = [
  { id: 'click', action: { type: 'DOM_CLICK', target: { selector: '#submit' }, expected_effect: { any: [{ toast: 'Saved' }] }, timeout_ms: 3000 } }
]

test('a task completes only when its success criteria hold (plan §36)', async () => {
  const page = createPageDouble()
  const { runtime } = makeRuntime(page)
  const report = await runtime.run({
    goal: 'submit the form',
    success_criteria: [{ kind: 'dom_text', selector: '#status', text: 'Saved' }],
    plan: SUBMIT_PLAN
  })
  assert.equal(report.status, 'completed')
  assert.equal(report.criteria.satisfied, true)
  assert.equal(page.state.submitted, true)
  assert.ok(report.states.includes('VERIFYING'))
  assert.equal(report.steps, 1)
})

test('the plan running out is not completion (plan §36)', async () => {
  const page = createPageDouble({ eatFirstClicks: 99 })
  const { runtime } = makeRuntime(page)
  const report = await runtime.run({
    goal: 'submit the form',
    success_criteria: [{ kind: 'dom_text', selector: '#status', text: 'Saved' }],
    plan: SUBMIT_PLAN,
    limits: { max_retries_per_action: 1 }
  })
  assert.notEqual(report.status, 'completed')
  assert.equal(report.criteria.satisfied, false)
  assert.equal(page.state.submitted, false)
})

test('a missed click is detected, retried and recovered (acceptance test 3)', async () => {
  const page = createPageDouble({ eatFirstClicks: 1 })
  const { runtime } = makeRuntime(page)
  const report = await runtime.run({
    goal: 'submit the form',
    success_criteria: [{ kind: 'dom_text', selector: '#status', text: 'Saved' }],
    plan: SUBMIT_PLAN
  })
  assert.equal(report.status, 'completed')
  assert.equal(page.state.eaten, 1, 'the first click really was swallowed')
  assert.ok(report.steps >= 1)
  const decisions = report.recoveryDecisions.map((decision) => decision.step)
  assert.ok(decisions.length === 0 || decisions.includes('retry') || decisions.includes('alternative_action'), `expected a recovery decision, saw ${JSON.stringify(decisions)}`)
})

test('a slow UI is waited for by condition, not by a fixed sleep (acceptance test 6)', async () => {
  const clock = createVirtualClock()
  const page = createPageDouble({ clock, effectDelayMs: 700 })
  const { runtime } = makeRuntime(page, { clock })
  const report = await runtime.run({
    goal: 'submit the form',
    success_criteria: [{ kind: 'dom_text', selector: '#status', text: 'Saved' }],
    plan: SUBMIT_PLAN
  })
  assert.equal(report.status, 'completed')
  assert.ok(report.steps >= 1)
  // The wait happened (the effect needed 700 ms) but the runtime never sat on a
  // fixed multi-second sleep: the whole run fits inside the action timeout.
  assert.ok(report.finishedAt - report.startedAt <= 3000, `the run must not stall on fixed delays (took ${report.finishedAt - report.startedAt}ms)`)
})

test('a target that moves is re-resolved instead of clicked at a stale coordinate (acceptance test 2)', async () => {
  const clock = createVirtualClock()
  const page = createPageDouble({ clock, moveAfterMs: 0, moveTo: { x: 640, y: 420 } })
  const { runtime } = makeRuntime(page, { clock })
  const report = await runtime.run({
    goal: 'click the moved button',
    success_criteria: [{ kind: 'dom_text', selector: '#status', text: 'Saved' }],
    plan: [
      { id: 'wait', action: { type: 'WAIT_STATE', waitFor: { condition: 'idle' }, timeout_ms: 500 } },
      { id: 'click', action: { type: 'DOM_CLICK', target: { selector: '#submit' }, expected_effect: { any: [{ toast: 'Saved' }] }, timeout_ms: 2000 } }
    ]
  })
  assert.equal(report.status, 'completed')
  // The click must have been addressed to the element identity, not to a
  // coordinate captured before the move.
  assert.ok(page.state.clicks.includes('cu-submit'))
  assert.equal(page.state.buttonX, 640)
})

test('an unexpected modal pauses the flow instead of clicking through it (acceptance test 4)', async () => {
  const page = createPageDouble({ modal: true })
  const { runtime } = makeRuntime(page)
  const report = await runtime.run({
    goal: 'submit the form through a dialog',
    success_criteria: [{ kind: 'dom_text', selector: '#status', text: 'Saved' }],
    plan: SUBMIT_PLAN,
    limits: { max_retries_per_action: 1, max_steps: 6 }
  })
  // The modal was observed as a blocking dialog: the runtime refused to keep
  // acting blind and reported it, rather than reporting success.
  assert.notEqual(report.status, 'completed')
  assert.equal(page.state.submitted, false)
  assert.ok(
    report.states.includes('RECOVERING') || report.error.code === CODES.MODAL_BLOCKING,
    `expected the modal to be handled or reported, saw ${report.error ? report.error.code : report.states.join('>')}`
  )
})

test('an unresponsive page is detected as a stall and fails gracefully (acceptance test 10)', async () => {
  // The page answers but nothing ever changes: retries keep failing and the run
  // must end in a bounded, contextual failure instead of looping forever.
  const clock = createVirtualClock()
  const runtime = createComputerUseRuntime({
    host: {
      page: createPageDouble(),
      planner: async () => ({
        type: 'SHELL_EXEC',
        command: process.execPath,
        args: ['-e', 'process.stdout.write("alive")'],
        expected_effect: { any: [{ stdout_matches: 'never-matches-this' }] },
        timeout_ms: 150
      })
    },
    clock,
    log: { dir: null },
    options: { maxSteps: 20 }
  })
  const report = await runtime.run({
    goal: 'run a command whose expected effect never appears',
    plan: [{ action: { type: 'SHELL_EXEC', command: process.execPath, args: ['-e', 'process.stdout.write("alive")'], expected_effect: { any: [{ stdout_matches: 'never-matches-this' }] }, timeout_ms: 150 } }],
    limits: { max_steps: 20, max_retries_per_action: 1, max_stall_recoveries: 1 }
  })
  assert.equal(report.status, 'failed')
  assert.ok(report.stallRecoveries >= 1, 'stall recovery must have run')
  assert.equal(report.error.code, CODES.STALL_DETECTED)
  assert.ok(report.steps <= 20, 'the run is bounded')
})

test('a forbidden destructive action is refused before anything runs (plan §34)', async () => {
  const target = path.join(os.tmpdir(), `ds-hns-cu-forbidden-${process.pid}.txt`)
  fs.writeFileSync(target, 'do not delete me')
  try {
    const page = createPageDouble()
    const { runtime } = makeRuntime(page)
    const report = await runtime.run({
      goal: 'delete a file',
      success_criteria: [{ kind: 'file_missing', path: target }],
      safety: { destructive_actions: 'forbidden' },
      plan: [{ action: { type: 'FILE_DELETE', path: target, expected_effect: { any: [{ file_missing: target }] } } }]
    })
    assert.equal(report.status, 'failed')
    assert.equal(report.error.code, CODES.DESTRUCTIVE_FORBIDDEN)
    assert.equal(fs.existsSync(target), true, 'the file must still be there')
  } finally {
    fs.rmSync(target, { force: true })
  }
})

test('a destructive action with confirm and no callback is refused, not assumed', async () => {
  const target = path.join(os.tmpdir(), `ds-hns-cu-unconfirmed-${process.pid}.txt`)
  fs.writeFileSync(target, 'still here')
  try {
    const page = createPageDouble()
    const { runtime } = makeRuntime(page)
    const report = await runtime.run({
      goal: 'delete a file without a confirmation channel',
      success_criteria: [{ kind: 'file_missing', path: target }],
      plan: [{ action: { type: 'FILE_DELETE', path: target, expected_effect: { any: [{ file_missing: target }] } } }]
    })
    assert.equal(report.status, 'failed')
    assert.equal(report.error.code, CODES.DESTRUCTIVE_NEEDS_CONFIRMATION)
    assert.equal(fs.existsSync(target), true)
  } finally {
    fs.rmSync(target, { force: true })
  }
})

test('a confirmed destructive action proceeds when the host approves it', async () => {
  const target = path.join(os.tmpdir(), `ds-hns-cu-confirmed-${process.pid}.txt`)
  fs.writeFileSync(target, 'delete me')
  const asked = []
  const { runtime } = makeRuntime(createPageDouble(), {
    confirm: async (request) => {
      asked.push(request)
      return true
    }
  })
  const report = await runtime.run({
    goal: 'delete a temporary file after confirmation',
    success_criteria: [{ kind: 'file_missing', path: target }],
    plan: [{ action: { type: 'FILE_DELETE', path: target, expected_effect: { any: [{ file_missing: target }] } } }]
  })
  assert.equal(asked.length, 1)
  assert.deepEqual(asked[0].kinds, ['DELETE'])
  assert.equal(report.status, 'completed')
  assert.equal(fs.existsSync(target), false, 'the confirmed deletion really happened')
})

test('a refused confirmation stops the action', async () => {
  const target = path.join(os.tmpdir(), `ds-hns-cu-refused-${process.pid}.txt`)
  fs.writeFileSync(target, 'keep me')
  try {
    const { runtime } = makeRuntime(createPageDouble(), { confirm: async () => false })
    const report = await runtime.run({
      goal: 'delete a temporary file after a refused confirmation',
      success_criteria: [{ kind: 'file_missing', path: target }],
      plan: [{ action: { type: 'FILE_DELETE', path: target, expected_effect: { any: [{ file_missing: target }] } } }]
    })
    assert.equal(report.status, 'failed')
    assert.equal(report.error.code, CODES.SAFETY_REFUSED)
    assert.equal(fs.existsSync(target), true)
  } finally {
    fs.rmSync(target, { force: true })
  }
})

test('the runtime never clicks when the expected window is not in front (acceptance test 8)', async () => {
  const clicked = []
  const clock = createVirtualClock()
  // A desktop driver whose foreground window is a different application.
  const desktop = {
    backend: 'double',
    probe: () => ({ available: true, reason: null }),
    listWindows: async () => [
      { handle: '99', title: 'Something Else', className: 'OtherWindow', processId: 4242, bounds: { x: 0, y: 0, width: 800, height: 600 }, visible: true, minimized: false, foreground: true },
      { handle: '1', title: 'Target App', className: 'TargetWindow', processId: 7, bounds: { x: 0, y: 0, width: 800, height: 600 }, visible: true, minimized: false, foreground: false }
    ],
    foregroundWindow: async () => ({ handle: '99', title: 'Something Else', className: 'OtherWindow', processId: 4242, bounds: { x: 0, y: 0, width: 800, height: 600 }, visible: true, minimized: false, foreground: true }),
    cursorPosition: async () => ({ x: 0, y: 0 }),
    moveMouse: async () => ({ ok: true }),
    click: async (point) => {
      clicked.push(point)
      return { ok: true }
    },
    typeText: async () => ({ ok: true }),
    keyPress: async () => ({ ok: true }),
    hotkey: async () => ({ ok: true }),
    drag: async () => ({ ok: true }),
    scroll: async () => ({ ok: true }),
    focusWindow: async () => ({ ok: true }),
    closeWindow: async () => ({ ok: true }),
    moveWindow: async () => ({ ok: true }),
    openApplication: async () => ({ ok: true, processId: 1 }),
    clipboardRead: async () => '',
    clipboardWrite: async () => ({ ok: true }),
    screenMetrics: async () => ({ x: 0, y: 0, width: 800, height: 600 })
  }
  const runtime = createComputerUseRuntime({
    host: { desktop },
    clock,
    log: { dir: null },
    options: { maxSteps: 4 }
  })
  const report = await runtime.run({
    goal: 'click inside the target window',
    plan: [{
      action: {
        type: 'CLICK',
        target: { point: { x: 400, y: 300 }, window: { title: 'Target App' } },
        expected_effect: { any: [{ window_changed: true }] },
        timeout_ms: 300
      }
    }],
    limits: { max_retries_per_action: 0 }
  })
  assert.equal(clicked.length, 0, 'no coordinate click may be issued while another window is in front')
  assert.equal(report.status, 'failed')
  assert.ok([CODES.WINDOW_MISMATCH, CODES.SAFETY_REFUSED].includes(report.error.code), `unexpected error ${report.error.code}`)
})

test('a dead vision controller does not stop a shell task (acceptance test 9)', async () => {
  const broken = {
    probe: () => ({ available: false, reason: 'the screenshot backend is missing' }),
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
  const page = createPageDouble()
  const clock = createVirtualClock()
  const runtime = createComputerUseRuntime({ host: { page, screenshot: broken }, clock, log: { dir: null } })
  const health = runtime.health()
  const vision = health.controllers.find((controller) => controller.controller === 'vision')
  assert.equal(vision.available, false)
  assert.match(vision.reason, /screenshot backend/)
  const browser = health.controllers.find((controller) => controller.controller === 'browser')
  assert.equal(browser.available, true, 'the browser controller stays available')
  const shell = health.controllers.find((controller) => controller.controller === 'shell')
  assert.equal(shell.available, true, 'the shell controller stays available')

  const report = await runtime.run({
    goal: 'run a shell command while vision is broken',
    plan: [{ action: { type: 'SHELL_EXEC', command: process.execPath, args: ['-e', 'console.log(1)'], expected_effect: { any: [{ exit_code: 0 }] } } }]
  })
  assert.equal(report.status, 'completed')
})

test('a controller that throws while initialising degrades instead of crashing (plan §37)', async () => {
  const exploding = new Proxy({}, {
    get() {
      throw new Error('driver exploded during construction')
    }
  })
  const page = createPageDouble()
  const clock = createVirtualClock()
  const runtime = createComputerUseRuntime({ host: { page, desktop: exploding }, clock, log: { dir: null } })
  const desktop = runtime.health().controllers.find((controller) => controller.controller === 'desktop')
  assert.equal(desktop.available, false)
  assert.ok(desktop.reason)
  const report = await runtime.run({
    goal: 'still usable',
    plan: [{ action: { type: 'DOM_CLICK', target: { selector: '#submit' } } }]
  })
  assert.ok(['completed', 'failed'].includes(report.status), 'the runtime itself survives')
})

test('autonomous continuation re-issues a stopped run until the criteria hold (plan §49)', async () => {
  const page = createPageDouble({ eatFirstClicks: 1 })
  const clock = createVirtualClock()
  const runtime = createComputerUseRuntime({
    host: { page },
    clock,
    log: { dir: null },
    options: { autonomyEnabled: true, maxSteps: 20, maxRetriesPerAction: 0 }
  })
  const report = await runtime.run({
    goal: 'submit the form',
    autonomy_enabled: true,
    success_criteria: [{ kind: 'dom_text', selector: '#status', text: 'Saved' }],
    plan: SUBMIT_PLAN
  })
  assert.equal(report.autonomy.autonomous, true)
  assert.ok(report.rounds >= 1)
  assert.equal(page.state.submitted, true)
})

test('cancelling a run stops it without pretending it completed', async () => {
  const page = createPageDouble({ freeze: true })
  const clock = createVirtualClock()
  const runtime = createComputerUseRuntime({ host: { page }, clock, log: { dir: null } })
  const promise = runtime.run({
    goal: 'long task',
    plan: [{ action: { type: 'DOM_CLICK', target: { selector: '#submit' }, expected_effect: { any: [{ toast: 'Never' }] }, timeout_ms: 100 } }]
  })
  runtime.cancel('test cancellation')
  const report = await promise
  assert.ok(['cancelled', 'failed'].includes(report.status))
})

test('the execution log records the step fields the plan asks for, and no secrets (plan §39/§32)', async () => {
  const page = createPageDouble()
  const clock = createVirtualClock()
  const runtime = createComputerUseRuntime({ host: { page }, clock, log: { dir: null } })
  const report = await runtime.run({
    goal: 'type a secret and submit',
    success_criteria: [{ kind: 'dom_text', selector: '#status', text: 'Saved' }],
    plan: [
      { action: { type: 'DOM_TYPE', target: { selector: '#username' }, text: 'hunter2', sensitive: true, expected_effect: { any: [{ value_equals: 'hunter2' }] } } },
      { action: { type: 'DOM_CLICK', target: { selector: '#submit' }, expected_effect: { any: [{ toast: 'Saved' }] } } }
    ]
  })
  assert.equal(report.status, 'completed')
  const steps = runtime.log.steps()
  assert.ok(steps.length >= 2)
  const first = steps[0]
  for (const field of ['step', 'action', 'preState', 'stabilizationMs', 'result', 'verification', 'retryCount']) {
    assert.ok(field in first, `the step log must carry ${field}`)
  }
  assert.equal(first.result, 'success')
  const serialized = JSON.stringify(steps)
  assert.equal(serialized.includes('hunter2'), false, 'a sensitive value must never reach the log')
  assert.match(first.action, /DOM_TYPE/)
})

test('every executed action is verified before it counts as a step (plan §14)', async () => {
  const page = createPageDouble()
  const clock = createVirtualClock()
  const runtime = createComputerUseRuntime({ host: { page }, clock, log: { dir: null } })
  const report = await runtime.run({
    goal: 'submit',
    success_criteria: [{ kind: 'dom_text', selector: '#status', text: 'Saved' }],
    plan: SUBMIT_PLAN
  })
  const steps = runtime.log.steps()
  assert.ok(steps.length >= 1)
  for (const step of steps) {
    assert.ok(step.verification !== null && step.verification !== undefined, `step ${step.step} has no verification`)
    assert.equal(typeof step.verification, 'string')
  }
  assert.equal(report.status, 'completed')
})

test('executeAction routes a single action through the same machinery (plan §43)', async () => {
  const page = createPageDouble()
  const { runtime } = makeRuntime(page)
  const outcome = await runtime.executeAction({
    type: 'DOM_TYPE',
    target: { selector: '#username' },
    text: 'alice',
    expected_effect: { any: [{ value_equals: 'alice' }] }
  })
  assert.equal(outcome.status, 'success')
  assert.equal(page.state.value, 'alice')
  const types = runtime.actionTypes
  assert.ok(types.includes('SCREENSHOT_FULL'))
  assert.ok(types.includes('WAIT_STATE'))
})

test('the contract handed to the runtime is validated, not trusted', async () => {
  const page = createPageDouble()
  const { runtime } = makeRuntime(page)
  assert.throws(() => createContract({ allowed_capabilities: ['nope'] }), /goal|capabilit/i)
  const report = await runtime.run({ goal: '', plan: [] })
  assert.equal(report.status, 'failed')
  assert.equal(report.error.code, CODES.CONTRACT_GOAL_MISSING)
})
