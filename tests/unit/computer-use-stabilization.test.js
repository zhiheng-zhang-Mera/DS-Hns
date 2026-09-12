'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')

const { createStabilizer } = require('../../app/computer-use/stabilization.cjs')
const { createWorldState, meaningfulChange, discardWorldState, summarizeWorldState } = require('../../app/computer-use/world-state.cjs')
const { createVirtualClock } = require('../helpers/computer-use-clock.cjs')
const { TIMING } = require('../../app/computer-use/constants.cjs')

/**
 * Phase 3 — transient stabilization (plan §8, §9, §10, §11, §12, §13, §23, §24, §25)
 * and the World State it stabilizes against (plan §5, §20).
 */

function world(overrides = {}) {
  return createWorldState({
    browser: {
      url: 'https://example.test/form',
      title: 'Form',
      readyState: 'complete',
      loading: false,
      revision: 7,
      focusedRef: 'cu-1',
      controls: [
        { ref: 'cu-1', role: 'textbox', name: 'username', selector: '#username', bbox: { x: 10, y: 10, width: 100, height: 20 }, disabled: false, visible: true },
        { ref: 'cu-2', role: 'button', name: 'Submit', selector: '#submit', bbox: { x: 10, y: 40, width: 80, height: 20 }, disabled: false, visible: true }
      ],
      ...(overrides.browser || {})
    },
    desktop: {
      windows: [{ handle: '1', title: 'Form - Browser', processId: 42, bounds: { x: 0, y: 0, width: 800, height: 600 }, foreground: true, visible: true, minimized: false }],
      ...(overrides.desktop || {})
    },
    system: { events: overrides.events || [] }
  })
}

function resolution(overrides = {}) {
  return {
    kind: 'selector',
    ref: 'cu-2',
    bbox: { x: 10, y: 40, width: 80, height: 20 },
    point: { x: 50, y: 50 },
    ...overrides
  }
}

test('the settle window spends the minimum delay and then checks stability', async () => {
  const clock = createVirtualClock()
  const stabilizer = createStabilizer({ clock })
  const seen = []
  const outcome = await stabilizer.settle({
    action: { stabilization: { minimumMs: 100, maximumMs: 300 } },
    previous: resolution(),
    observe: async () => {
      seen.push(clock.now())
      return world()
    },
    locateTarget: async () => resolution()
  })
  assert.equal(outcome.verdict, 'stable')
  assert.ok(outcome.waitedMs >= 100, `expected at least the minimum settle, saw ${outcome.waitedMs}`)
  assert.ok(outcome.waitedMs <= TIMING.settleMaxMs)
  assert.equal(seen.length >= 1, true)
})

test('an unstable UI is retried in dynamic steps and never overshoots the ceiling', async () => {
  const clock = createVirtualClock()
  const stabilizer = createStabilizer({ clock })
  let revision = 0
  const outcome = await stabilizer.settle({
    action: { stabilization: { minimumMs: 50, maximumMs: 300 } },
    previous: resolution(),
    // The baseline observation the executor would have taken before settling.
    world: world({ browser: { revision: 0 } }),
    // The DOM keeps changing: the settle loop must give up at the ceiling
    // instead of sleeping forever.
    observe: async () => world({ browser: { revision: (revision += 1) } }),
    locateTarget: async () => resolution()
  })
  assert.equal(outcome.verdict, 'wait_state')
  assert.ok(outcome.waitedMs <= TIMING.settleMaxMs + TIMING.cooldownStepMs)
  assert.ok(outcome.attempts > 1, 'the loop must have re-checked stability')
  assert.match(outcome.reason, /still changing/)
  assert.ok(outcome.signals.reasons.includes('DOM changed'))
})

test('a target that moved more than the update threshold during settling is reported as reobserve', async () => {
  const clock = createVirtualClock()
  const stabilizer = createStabilizer({ clock })
  const outcome = await stabilizer.settle({
    action: { stabilization: { minimumMs: 50, maximumMs: 300 } },
    // Detected at the old place before the settle window...
    previous: resolution(),
    world: world(),
    observe: async () => world(),
    // ...and found at the new place when it is re-detected after the minimum
    // settle. The runtime must not click the stale coordinate.
    locateTarget: async () => resolution({ bbox: { x: 640, y: 420, width: 80, height: 20 }, point: { x: 680, y: 430 } })
  })
  assert.equal(outcome.verdict, 'reobserve')
  assert.ok(outcome.revalidation.movement > 10)
  assert.match(outcome.reason, /moved/)
  assert.equal(outcome.resolved.point.x, 680)
})

test('a small movement is accepted and the refreshed coordinate is handed back', async () => {
  const clock = createVirtualClock()
  const stabilizer = createStabilizer({ clock })
  const outcome = await stabilizer.settle({
    action: { stabilization: { minimumMs: 50, maximumMs: 300 } },
    previous: resolution(),
    world: world(),
    observe: async () => world(),
    locateTarget: async () => resolution({ point: { x: 56, y: 50 }, bbox: { x: 16, y: 40, width: 80, height: 20 } })
  })
  assert.equal(outcome.verdict, 'updated')
  assert.equal(outcome.resolved.point.x, 56)
})

test('the dynamic cooldown ladder only uses this step\'s own signals (plan §23/§24)', () => {
  const stabilizer = createStabilizer({ clock: createVirtualClock() })
  assert.equal(stabilizer.dynamicCooldown({}).ms, TIMING.cooldownBaseMs)
  assert.equal(stabilizer.dynamicCooldown({ uiChanging: true }).ms, TIMING.cooldownBaseMs + TIMING.cooldownStepMs)
  const many = stabilizer.dynamicCooldown({ uiChanging: true, targetMoved: true, previousMiss: true, windowChanged: true, animationDetected: true })
  assert.equal(many.ms, TIMING.cooldownSoftMaxMs)
  assert.equal(many.exhausted, true)
  assert.deepEqual(many.signals, ['ui-changing', 'target-moved', 'previous-miss', 'window-changed', 'animation'])
  const navigation = stabilizer.dynamicCooldown({ navigationPending: true })
  assert.equal(navigation.ms, TIMING.navigationCooldownMs)
  assert.equal(navigation.ceiling, 'navigation')
  // The ladder is bounded: it can never grow into "sleep(5)" (plan §25).
  for (const state of [{}, { uiChanging: true }, { uiChanging: true, previousMiss: true, targetMoved: true }]) {
    assert.ok(stabilizer.dynamicCooldown(state).ms <= TIMING.cooldownHardMaxMs)
  }
})

test('the post-action grace is bounded and derived from the action', async () => {
  const clock = createVirtualClock()
  const stabilizer = createStabilizer({ clock })
  const grace = await stabilizer.grace({ stabilization: { minimumMs: 100 } })
  assert.ok(grace.waitedMs >= TIMING.graceMinMs)
  assert.ok(grace.waitedMs <= TIMING.graceMaxMs)
  const huge = await stabilizer.grace({ stabilization: { minimumMs: 300 } })
  assert.equal(huge.appliedMs, TIMING.graceMaxMs)
})

test('conditional waiting ends the moment the condition holds, not at the timeout (plan §12)', async () => {
  const clock = createVirtualClock()
  const stabilizer = createStabilizer({ clock })
  let polls = 0
  const wait = await stabilizer.waitFor(async () => {
    polls += 1
    if (polls < 3) return null
    clock.advance(5)
    return 'ready'
  }, { timeoutMs: 5000, pollMs: 20 })
  assert.equal(wait.ok, true)
  assert.equal(wait.value, 'ready')
  assert.ok(wait.waitedMs < 100, `the wait must end early, elapsed ${wait.waitedMs}`)

  const timeout = await stabilizer.waitFor(async () => null, { timeoutMs: 100, pollMs: 20 })
  assert.equal(timeout.ok, false)
  assert.equal(timeout.timedOut, true)
  assert.ok(timeout.waitedMs >= 100)
})

test('stability signals are cheap: DOM revision, accessibility, window, box and actionability', () => {
  const stabilizer = createStabilizer({ clock: createVirtualClock() })
  const before = world()
  assert.equal(stabilizer.stabilitySignals(before, world()).stable, true)

  const domChanged = stabilizer.stabilitySignals(before, world({ browser: { revision: 8 } }))
  assert.equal(domChanged.stable, false)
  assert.ok(domChanged.reasons.includes('DOM changed'))

  const loading = stabilizer.stabilitySignals(null, world({ browser: { loading: true, readyState: 'loading' } }))
  assert.equal(loading.stable, false)
  assert.ok(loading.reasons.includes('page still loading'))

  const movedTarget = stabilizer.stabilitySignals(before, world(), {
    previousResolution: resolution(),
    currentResolution: resolution({ bbox: { x: 12, y: 40, width: 80, height: 20 } })
  })
  assert.equal(movedTarget.stable, false)
  assert.ok(movedTarget.reasons.includes('target bounding box moved'))

  const disabled = stabilizer.stabilitySignals(before, world(), { currentResolution: resolution({ disabled: true }) })
  assert.ok(disabled.reasons.includes('target is disabled'))
})

test('the world state folds every source into one short-lived structure', () => {
  const state = world()
  assert.equal(state.url, 'https://example.test/form')
  assert.equal(state.focusedRef, 'cu-1')
  assert.equal(state.activeWindow, 'Form - Browser')
  assert.equal(state.controls.length, 2)
  assert.equal(state.visibleTargets.length, 2)
  assert.equal(state.confidence > 0.5, true)
  assert.equal(state.sources.browser.available, true)
})

test('a missing source degrades confidence and is recorded with its reason', () => {
  const state = createWorldState({
    browser: { available: false, reason: 'no page attached' },
    desktop: { windows: [{ handle: '1', title: 'Only window', processId: 7, bounds: { x: 0, y: 0, width: 10, height: 10 }, foreground: true }] }
  })
  assert.equal(state.sources.browser.available, false)
  assert.equal(state.sources.browser.reason, 'no page attached')
  assert.equal(state.confidence < 1, true)
})

test('meaningful change ignores cosmetic DOM churn but catches real state changes (plan §20)', () => {
  const before = world()
  const spin = world({ browser: { revision: 99 } })
  assert.equal(meaningfulChange(before, spin).changed, false, 'a spinner must not look like progress')

  const navigated = world({ browser: { url: 'https://example.test/done' } })
  assert.deepEqual(meaningfulChange(before, navigated).fields, ['url'])

  const unchecked = createWorldState({
    browser: {
      url: 'https://example.test/form',
      revision: 8,
      controls: [{ ref: 'cu-2', role: 'button', name: 'Submit', selector: '#submit', bbox: { x: 10, y: 40, width: 80, height: 20 }, disabled: true, visible: true }]
    },
    desktop: { windows: [{ handle: '1', title: 'Form - Browser', processId: 42, bounds: { x: 0, y: 0, width: 800, height: 600 }, foreground: true }] }
  })
  assert.equal(meaningfulChange(before, unchecked).changed, true)
})

test('the world state is discarded when the task ends and never becomes long-term memory (plan §5)', () => {
  const state = world()
  const summary = discardWorldState(state)
  assert.equal(state.discarded, true)
  assert.deepEqual(state.controls, [])
  assert.equal(state.url, null)
  assert.equal(summary.controls, 2)
  assert.equal(typeof summary.signature, 'string', 'the summary is taken before the state is emptied')
  assert.equal(summarizeWorldState(state).signature, null)
})
