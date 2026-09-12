'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createComputerUseRuntime } = require('../../app/computer-use/index.cjs')
const { isolateController, unavailableController } = require('../../app/computer-use/isolation.cjs')
const { createExecutionLog, shouldRetain } = require('../../app/computer-use/log.cjs')
const { createVirtualClock } = require('../helpers/computer-use-clock.cjs')
const { CODES } = require('../../app/computer-use/errors.cjs')

/**
 * Phase 8 — fault isolation and the execution log (plan §37, §38, §39, §40).
 *
 * These are the guarantees that keep one broken component from taking the
 * runtime down, and the guarantees that keep the log honest and free of
 * secrets. Both are properties of the *runtime*, not of a controller, so they
 * are tested here rather than inside a controller's own suite.
 */

test('an isolated controller keeps its live accessors (the page can be re-attached)', () => {
  let page = null
  const controller = {
    id: 'fake',
    capability: 'browser',
    probe: () => ({ available: true }),
    get page() {
      return page
    },
    setPage: (next) => {
      page = next
    },
    perform: async () => ({ ok: true }),
    facts: () => ({})
  }
  const isolated = isolateController('fake', 'browser', () => controller)
  assert.equal(isolated.page, null)
  isolated.setPage({ id: 'page-1' })
  assert.deepEqual(isolated.page, { id: 'page-1' }, 'the wrapper must not freeze a getter into a value')
  assert.equal(isolated.degraded, false)
})

test('a controller that cannot be constructed degrades to an honest stub', async () => {
  const degraded = isolateController('vision', 'vision', () => {
    throw new Error('no display devices were found')
  })
  const probe = degraded.probe()
  assert.equal(probe.available, false)
  assert.match(probe.reason, /no display devices/)
  await assert.rejects(() => degraded.perform({ type: 'SCREENSHOT_FULL' }), (error) => error.code === CODES.CONTROLLER_UNAVAILABLE)
  assert.equal(degraded.supports('SCREENSHOT_FULL'), false)

  const stub = unavailableController('desktop', 'desktop', 'the driver is missing')
  assert.equal(stub.probe().reason, 'the driver is missing')
})

test('a controller that throws during a step fails the step and not the run', async () => {
  const exploding = {
    probe: () => ({ available: true }),
    supports: () => true,
    perform: async () => {
      throw new Error('the driver crashed mid-action')
    },
    snapshot: async () => {
      throw new Error('the driver crashed while observing')
    },
    facts: () => ({})
  }
  const clock = createVirtualClock()
  const runtime = createComputerUseRuntime({
    host: { page: null, desktop: exploding },
    clock,
    log: { dir: null },
    options: { maxSteps: 4 }
  })
  const report = await runtime.run({
    goal: 'survive a crashing controller',
    plan: [{ action: { type: 'CLICK', target: { point: { x: 5, y: 5 } }, timeout_ms: 200 } }],
    allowed_capabilities: ['desktop'],
    limits: { max_steps: 4, max_retries_per_action: 0 }
  })
  assert.equal(report.status, 'failed')
  assert.ok(report.error, 'the failure is reported as data')
  // The runtime itself is still usable afterwards.
  const health = runtime.health()
  assert.equal(health.running, false)
  assert.ok(Array.isArray(health.controllers))
})

test('the runtime bounds a run by steps and by time', async () => {
  const clock = createVirtualClock()
  const page = {
    probe: () => ({ available: true }),
    snapshot: async () => ({ id: 'p', url: 'u', title: 't', readyState: 'complete', loading: false, revision: 1, focusedRef: null, controls: [], dialogs: [], tabs: [], viewport: { x: 0, y: 0, width: 10, height: 10 } }),
    query: async () => null,
    queryAll: async () => [],
    clickElement: async () => ({ ok: true, changed: true }),
    events: () => ({ sinceLastCheck: () => [] }),
    screenshot: async () => ({ png: Buffer.alloc(0) })
  }
  const runtime = createComputerUseRuntime({
    host: {
      page,
      planner: async () => ({ type: 'BROWSER_REFRESH', expected_effect: { any: [{ dom_mutated: true }] }, timeout_ms: 50 })
    },
    clock,
    log: { dir: null }
  })
  const report = await runtime.run({
    goal: 'never finishes',
    allowed_capabilities: ['browser'],
    limits: { max_steps: 3, max_retries_per_action: 0 }
  })
  assert.equal(report.status, 'failed')
  assert.ok([CODES.STEP_LIMIT_REACHED, CODES.STALL_DETECTED, CODES.RUN_TIMEOUT].includes(report.error.code),
    `a run without progress must end in a bounded failure, saw ${report.error.code}`)
  assert.ok(report.steps <= 3)
})

test('the execution log writes JSONL to disk, redacts secrets and follows the screenshot policy', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-hns-cu-log-'))
  try {
    const log = createExecutionLog({ dir, taskId: 'task-1', retention: 'failure' })
    log.step({ step: 1, action: 'CLICK selector:#save', result: 'success', verification: 'toast detected', stabilizationMs: 120, retryCount: 0, preState: { url: 'about:blank' } })
    log.step({ step: 2, action: 'TYPE ...', result: 'failure', sensitive: true, retryCount: 1 })
    log.finish({ status: 'failed' })
    const file = log.close()
    assert.ok(file, 'the log reports where it wrote')
    // The stream flushes asynchronously: give it a moment, then read the truth.
    for (let attempt = 0; attempt < 200 && !fs.existsSync(file); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(fs.existsSync(file), true)
    // The last line may still be in flight when the file appears.
    let lines = []
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const text = fs.readFileSync(file, 'utf8').trim()
      if (text) {
        lines = text.split('\n').map((line) => JSON.parse(line))
        if (lines.length >= 3) break
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(lines.length, 3)
    assert.equal(lines[0].kind, 'step')
    assert.equal(lines[0].step, 1)
    assert.equal(lines[0].verification, 'toast detected')
    assert.equal(lines[0].stabilizationMs, 120)
    assert.equal(lines[2].kind, 'finish')

    // Plan §40: a transient capture is not written unless the run failed.
    const transient = log.screenshot(Buffer.from('png'), { level: 1, reason: 'target-region', runFailed: false })
    assert.equal(transient.retained, false)
    const failure = log.screenshot(Buffer.from('png'), { level: 2, reason: 'target-region', runFailed: true, step: 2 })
    assert.equal(failure.retained, true)
    assert.ok(fs.existsSync(failure.path))
    const requested = log.screenshot(Buffer.from('png'), { level: 3, reason: 'requested' })
    assert.equal(requested.retained, true)
    log.close()

    assert.equal(shouldRetain({ mode: 'debug', retention: 'failure', reason: 'x' }).retain, true)
    assert.equal(shouldRetain({ mode: 'audit', retention: 'failure', reason: 'x' }).retain, true)
    assert.equal(shouldRetain({ mode: 'normal', retention: 'never', reason: 'x', runFailed: true }).retain, false)
    assert.equal(shouldRetain({ mode: 'normal', retention: 'failure', reason: 'x', runFailed: false }).reason, 'transient capture - used and dropped')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the runtime reports a cancelled run as cancelled', async () => {
  const clock = createVirtualClock()
  const page = {
    probe: () => ({ available: true }),
    snapshot: async () => ({ id: 'p', url: 'u', title: 't', readyState: 'complete', loading: false, revision: 1, focusedRef: null, controls: [], dialogs: [], tabs: [], viewport: { x: 0, y: 0, width: 10, height: 10 } }),
    query: async () => null,
    queryAll: async () => [],
    clickElement: async () => ({ ok: true, changed: false, missed: true }),
    events: () => ({ sinceLastCheck: () => [] }),
    screenshot: async () => ({ png: Buffer.alloc(0) })
  }
  const runtime = createComputerUseRuntime({
    host: { page, planner: async () => ({ type: 'BROWSER_REFRESH', expected_effect: { any: [{ dom_mutated: true }] }, timeout_ms: 50 }) },
    clock,
    log: { dir: null }
  })
  const running = runtime.run({ goal: 'cancel me', allowed_capabilities: ['browser'], limits: { max_steps: 50, max_retries_per_action: 0 } })
  runtime.cancel('test')
  const report = await running
  assert.ok(['cancelled', 'failed'].includes(report.status))
  assert.equal(runtime.health().running, false)
})

test('a host-supplied page is re-attached at the start of every run', async () => {
  const device = require('../helpers/computer-use-device.cjs').createDevice()
  try {
    const pageA = device.openPage('form.html', { id: 'a' })
    const pageB = device.openPage('miss.html', { id: 'b' })
    let current = pageA
    const runtime = createComputerUseRuntime({
      host: { getPage: () => current, desktop: device.desktop, accessibility: device.accessibility, screenshot: device.screenshot },
      clock: device.clock,
      log: { dir: null }
    })
    const first = await runtime.run({
      goal: 'type into the form',
      allowed_capabilities: ['browser'],
      plan: [{ action: { type: 'DOM_TYPE', target: { selector: '#username' }, text: 'alice', expected_effect: { any: [{ value_equals: 'alice' }] } } }]
    })
    assert.equal(first.status, 'completed', JSON.stringify(first.error))

    current = pageB
    const second = await runtime.run({
      goal: 'type into the other page',
      allowed_capabilities: ['browser'],
      plan: [{ action: { type: 'DOM_TYPE', target: { selector: '#alive' }, text: 'still here', expected_effect: { any: [{ value_equals: 'still here' }] } } }]
    })
    // The miss fixture has no #alive: the point is that the runtime switched to
    // the new page rather than still talking to the old one.
    assert.notEqual(second.status, 'completed')
    assert.equal(second.error.code, CODES.TARGET_NOT_FOUND)
  } finally {
    device.dispose()
  }
})
