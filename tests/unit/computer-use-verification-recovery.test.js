'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')

const { createVerifier } = require('../../app/computer-use/verification.cjs')
const { detectMiss } = require('../../app/computer-use/miss.cjs')
const { createRecoveryController, alternativeAction, mapType } = require('../../app/computer-use/recovery.cjs')
const { createStallDetector, STALL_RECOVERY_LADDER } = require('../../app/computer-use/stall.cjs')
const { createStateMachine } = require('../../app/computer-use/state-machine.cjs')
const { normalizeAction } = require('../../app/computer-use/action.cjs')
const { createWorldState } = require('../../app/computer-use/world-state.cjs')
const { CODES, ComputerUseError } = require('../../app/computer-use/errors.cjs')
const { CU_STATES, VERDICTS, SCREENSHOT_LEVELS } = require('../../app/computer-use/constants.cjs')

/**
 * Phases 4 and 5 — verification (plan §14, §15, §46), miss detection (§17),
 * retry and recovery (§18, §19), stall detection and recovery (§20, §21, §22)
 * and the explicit state machine (§51, §52).
 */

function world(overrides = {}) {
  return createWorldState({
    browser: {
      url: overrides.url === undefined ? 'https://example.test/form' : overrides.url,
      title: 'Form',
      readyState: 'complete',
      loading: false,
      revision: overrides.revision === undefined ? 5 : overrides.revision,
      focusedRef: overrides.focusedRef === undefined ? 'cu-1' : overrides.focusedRef,
      controls: overrides.controls || [
        { ref: 'cu-1', role: 'textbox', name: 'username', selector: '#username', value: overrides.value === undefined ? '' : overrides.value, bbox: { x: 10, y: 10, width: 100, height: 20 }, disabled: false, visible: true },
        { ref: 'cu-2', role: 'button', name: 'Save', selector: '#save', bbox: { x: 10, y: 40, width: 80, height: 20 }, disabled: false, visible: true }
      ],
      dialogs: overrides.dialogs || []
    },
    system: { events: overrides.events || [] }
  })
}

function action(overrides = {}) {
  return normalizeAction({ type: 'DOM_CLICK', target: '#save', ...overrides })
}

test('verification returns success / failure / unknown and never a boolean (plan §46)', async () => {
  const verifier = createVerifier()
  const success = await verifier.verify({ action: action(), before: world(), after: world({ revision: 6 }) })
  assert.equal(success.verdict, VERDICTS.SUCCESS)

  const failure = await verifier.verify({ action: action(), before: world(), after: world() })
  assert.equal(failure.verdict, VERDICTS.FAILURE)

  const unknown = await verifier.verify({ action: action(), before: null, after: null })
  assert.equal(unknown.verdict, VERDICTS.UNKNOWN)
})

test('every documented verification kind is implemented', async () => {
  const verifier = createVerifier()
  const navigation = await verifier.verify({
    action: action({ expected_effect: { any: [{ url_changed: true }] } }),
    before: world(),
    after: world({ url: 'https://example.test/done' })
  })
  assert.equal(navigation.verdict, VERDICTS.SUCCESS)
  assert.equal(navigation.kind, 'navigation')

  const state = await verifier.verify({
    action: normalizeAction({ type: 'DOM_TYPE', target: '#username', text: 'alice', expected_effect: { any: [{ value_equals: 'alice' }] } }),
    before: world(),
    after: world({ value: 'alice', focusedRef: 'cu-1', focusedElementValue: 'alice', revision: 6 })
  })
  assert.equal(state.verdict, VERDICTS.SUCCESS)

  const file = await verifier.verify({
    action: action({ expected_effect: { any: [{ file_created: 'out.txt' }] } }),
    before: world(),
    after: world({ revision: 6 }),
    facts: { fileExists: async (path) => path === 'out.txt' }
  })
  assert.equal(file.verdict, VERDICTS.SUCCESS)
  assert.equal(file.kind, 'file')

  const process = await verifier.verify({
    action: normalizeAction({ type: 'SHELL_EXEC', command: 'node', expected_effect: { any: [{ exit_code: 0 }, { stdout_matches: 'v2' }] } }),
    before: world(),
    after: world({ revision: 6 }),
    facts: { lastShell: { exited: true, exitCode: 0, stdout: 'v24.14.0', stderr: '' } }
  })
  assert.equal(process.verdict, VERDICTS.SUCCESS)
  assert.equal(process.kind, 'process')

  const focus = await verifier.verify({
    action: action({ type: 'FOCUS', expected_effect: { any: [{ focus_changed: true }] } }),
    before: world({ focusedRef: 'cu-1' }),
    after: world({ focusedRef: 'cu-2', revision: 6 })
  })
  assert.equal(focus.verdict, VERDICTS.SUCCESS)
  assert.equal(focus.kind, 'focus')

  const event = await verifier.verify({
    action: action({ expected_effect: { any: [{ event: 'saved' }] } }),
    before: world(),
    after: world({ revision: 6, events: [{ type: 'saved' }] })
  })
  assert.equal(event.verdict, VERDICTS.SUCCESS)
  assert.equal(event.kind, 'event')

  const visual = await verifier.verify({
    action: action({ expected_effect: { any: [{ visual_change: true }] } }),
    before: world(),
    after: world({ revision: 6 }),
    facts: { visualChange: async () => true }
  })
  assert.equal(visual.verdict, VERDICTS.SUCCESS)
  assert.equal(visual.kind, 'visual')
})

test('a verification whose facts are missing reports unknown, not success', async () => {
  const verifier = createVerifier()
  const result = await verifier.verify({
    action: action({ expected_effect: { any: [{ file_created: 'out.txt' }] } }),
    before: world(),
    after: world({ revision: 9 })
  })
  assert.equal(result.verdict, VERDICTS.UNKNOWN)
  assert.equal(result.evidence[0].ok, null)
})

test('all-mode requires every declared effect; any-mode requires one', async () => {
  const verifier = createVerifier()
  const all = await verifier.verify({
    action: action({ expected_effect: { all: [{ dom_mutated: true }, { url_changed: true }] } }),
    before: world(),
    after: world({ revision: 6 })
  })
  assert.equal(all.verdict, VERDICTS.FAILURE, 'a satisfied dom_mutated may not mask an unsatisfied url_changed')
  const any = await verifier.verify({
    action: action({ expected_effect: { any: [{ url_changed: true }, { dom_mutated: true }] } }),
    before: world(),
    after: world({ revision: 6 })
  })
  assert.equal(any.verdict, VERDICTS.SUCCESS)
})

test('miss detection separates "issued" from "had an effect" (plan §17)', () => {
  const click = action()
  const missed = detectMiss({ action: click, before: world(), after: world(), receipt: { ok: true, changed: false } })
  assert.equal(missed.missed, true)
  assert.ok(missed.signals.includes('no_state_change'))

  const worked = detectMiss({ action: click, before: world(), after: world({ revision: 6 }), receipt: { ok: true, changed: true } })
  assert.equal(worked.missed, false)

  const swallowed = detectMiss({ action: click, before: world(), after: world(), receipt: { ok: true, missed: true, detail: 'an overlay ate the click' } })
  assert.equal(swallowed.missed, true)
  assert.ok(swallowed.signals.includes('controller_reported_noop'))
  assert.equal(swallowed.confidence, 'high')

  const focusStuck = detectMiss({
    action: normalizeAction({ type: 'FOCUS', target: '#username' }),
    before: world({ focusedRef: 'cu-1' }),
    after: world({ focusedRef: 'cu-1' })
  })
  assert.equal(focusStuck.missed, true)
  assert.ok(focusStuck.signals.includes('focus_unchanged'))

  const identical = detectMiss({
    action: click,
    before: world(),
    after: world({ revision: 6 }),
    visualDigestBefore: 'abc',
    visualDigestAfter: 'abc',
    receipt: { ok: true, changed: true }
  })
  assert.ok(identical.signals.includes('visual_identical'))
  assert.equal(identical.missed, false, 'a verified DOM change outranks an identical screenshot')

  const blind = detectMiss({ action: click, before: world(), after: null })
  assert.equal(blind.confidence, 'unknown')
})

test('retry revalidates first, then switches to a different interaction channel (plan §18)', () => {
  const recovery = createRecoveryController({ maxRetriesPerAction: 2, maxStallRecoveries: 1 })
  const click = action()
  const first = recovery.decide({ action: click, attempt: 1, error: new ComputerUseError(CODES.ACTION_MISSED, 'no effect') })
  assert.equal(first.step, 'retry')
  assert.equal(first.revalidate, true)

  const second = recovery.decide({ action: click, attempt: 2, error: new ComputerUseError(CODES.ACTION_MISSED, 'no effect'), usedChannel: 'dom' })
  assert.equal(second.step, 'alternative_action')
  assert.equal(second.alternative.type, 'ACCESSIBILITY_INVOKE')

  const third = recovery.decide({
    action: second.alternative,
    attempt: 2,
    error: new ComputerUseError(CODES.ACTION_MISSED, 'no effect'),
    usedChannel: 'accessibility',
    stallRecoveries: 0
  })
  assert.equal(third.step, 'replan')

  // The ladder ends when the per-step round budget is spent: bounded, never an
  // infinite retry loop (plan §21).
  const last = recovery.decide({
    action: click,
    attempt: 3,
    error: new ComputerUseError(CODES.ACTION_MISSED, 'no effect'),
    usedChannel: 'dom',
    recoveryRounds: 4,
    maxRecoveryRounds: 4,
    stallRecoveries: 2
  })
  assert.equal(last.step, 'fail')
  assert.equal(last.terminal, true)
  assert.match(last.reason, /exhausted/)
})

test('a non-retryable failure stops immediately instead of burning attempts', () => {
  const recovery = createRecoveryController({})
  const decision = recovery.decide({
    action: action(),
    attempt: 1,
    error: new ComputerUseError(CODES.SAFETY_REFUSED, 'forbidden by the contract', { retryable: false })
  })
  assert.equal(decision.step, 'fail')
  assert.match(decision.reason, /not retryable/)
})

test('alternatives map intent to channel, and only where one exists', () => {
  assert.equal(mapType('activate', 'dom'), 'DOM_CLICK')
  assert.equal(mapType('activate', 'accessibility'), 'ACCESSIBILITY_INVOKE')
  assert.equal(mapType('activate', 'gui'), 'CLICK')
  assert.equal(mapType('set-text', 'dom'), 'DOM_TYPE')
  assert.equal(mapType('scroll', 'accessibility'), null)

  const click = action()
  const domToAx = alternativeAction(click, { usedChannel: 'dom' })
  assert.equal(domToAx.type, 'ACCESSIBILITY_INVOKE')
  assert.equal(domToAx.channel, 'accessibility')

  const domToGui = alternativeAction(click, { usedChannel: 'dom', point: { x: 50, y: 50 }, skipChannels: [] })
  assert.ok(['ACCESSIBILITY_INVOKE', 'CLICK'].includes(domToGui.type))

  const noPoint = normalizeAction({ type: 'CLICK', target: '#save' })
  const dom = alternativeAction(noPoint, { usedChannel: 'dom' })
  assert.equal(dom.type, 'ACCESSIBILITY_INVOKE', 'a DOM click escalates to an accessibility invoke')
  // An accessibility node with no coordinate cannot become a GUI click...
  assert.equal(alternativeAction(normalizeAction({ type: 'ACCESSIBILITY_INVOKE', target: '#save' }), { usedChannel: 'accessibility' }), null)
  // ...but with a known coordinate it can, and the action's own point is reused.
  assert.equal(
    alternativeAction(normalizeAction({ type: 'ACCESSIBILITY_INVOKE', target: '#save', point: { x: 1, y: 1 } }), { usedChannel: 'accessibility' }).type,
    'CLICK'
  )

  const typing = alternativeAction(normalizeAction({ type: 'TYPE', target: '#username', text: 'x' }), { usedChannel: 'gui' })
  assert.equal(typing.type, 'DOM_TYPE')
  // An action with only one channel has no alternative interaction to offer.
  const nothing = alternativeAction(normalizeAction({ type: 'MOVE', point: { x: 1, y: 1 } }), { usedChannel: 'gui' })
  assert.equal(nothing, null)
  assert.equal(alternativeAction(normalizeAction({ type: 'BROWSER_REFRESH' }), { usedChannel: 'api' }), null)
})

test('stall detection needs consecutive actions without meaningful change (plan §20)', () => {
  const stall = createStallDetector({ consecutiveActions: 3, maxRecoveries: 2 })
  const now = 1000
  const first = stall.record({ step: 1, actionType: 'CLICK', changed: false, signature: 'a' })
  assert.equal(first.stalled, false)
  const second = stall.record({ step: 2, actionType: 'CLICK', changed: false, signature: 'a' })
  assert.equal(second.stalled, false)
  const third = stall.record({ step: 3, actionType: 'CLICK', changed: false, signature: 'a' })
  assert.equal(third.stalled, true)
  assert.equal(third.consecutive, 3)

  const recovered = stall.record({ step: 4, actionType: 'CLICK', changed: true, signature: 'b' })
  assert.equal(recovered.stalled, false)
  assert.equal(recovered.consecutive, 0)

  // A different state signature is progress even when the change set is empty.
  const detector = createStallDetector({ consecutiveActions: 2 })
  detector.record({ step: 1, changed: false, signature: 'x' })
  const moved = detector.record({ step: 2, changed: false, signature: 'y' })
  assert.equal(moved.stalled, false)
  void now
})

test('stall recovery is laddered and bounded, ending in fail-with-context (plan §21)', () => {
  const stall = createStallDetector({ consecutiveActions: 1, maxRecoveries: 2 })
  const recovery = createRecoveryController({ maxStallRecoveries: 2 })
  const rungs = [0, 1, 2, 3, 4, 5, 6, 7].map((index) => recovery.stallStep(index).ladderStep)
  assert.deepEqual(rungs.slice(0, 3), ['structured_reobserve', 'window_check', 'target_re_resolution'])
  assert.equal(rungs[rungs.length - 1], 'fail_with_context')
  assert.equal(STALL_RECOVERY_LADDER.length, 8)

  const first = stall.registerRecovery()
  assert.equal(first.exhausted, false)
  const second = stall.registerRecovery()
  assert.equal(second.exhausted, true)
  assert.equal(stall.exhausted, true)
})

test('screenshot escalation climbs one level at a time and never straight to full (plan §22)', () => {
  const recovery = createRecoveryController({ visualLevelCeiling: SCREENSHOT_LEVELS.FULL })
  assert.equal(recovery.nextVisualLevel(SCREENSHOT_LEVELS.NONE), SCREENSHOT_LEVELS.REGION)
  assert.equal(recovery.nextVisualLevel(SCREENSHOT_LEVELS.REGION), SCREENSHOT_LEVELS.WINDOW)
  assert.equal(recovery.nextVisualLevel(SCREENSHOT_LEVELS.WINDOW), SCREENSHOT_LEVELS.FULL)
  assert.equal(recovery.nextVisualLevel(SCREENSHOT_LEVELS.FULL), SCREENSHOT_LEVELS.FULL)

  const noFull = createRecoveryController({ visualLevelCeiling: SCREENSHOT_LEVELS.WINDOW })
  assert.equal(noFull.nextVisualLevel(SCREENSHOT_LEVELS.WINDOW), SCREENSHOT_LEVELS.WINDOW)

  const decision = recovery.decide({ action: action(), attempt: 2, error: new ComputerUseError(CODES.TARGET_STALE, 'moved'), usedChannel: 'dom' })
  assert.equal(decision.visualLevel, SCREENSHOT_LEVELS.REGION, 'a first miss may not buy a full-screen capture')
  assert.ok(decision.cooldownSignals.includes('target-moved'))
})

test('the state machine allows the documented path and refuses invented ones', () => {
  const machine = createStateMachine()
  machine.transition(CU_STATES.RECEIVING_TASK)
  machine.transition(CU_STATES.OBSERVING)
  machine.transition(CU_STATES.PLANNING_ACTION)
  machine.transition(CU_STATES.STABILIZING)
  machine.transition(CU_STATES.REVALIDATING)
  machine.transition(CU_STATES.ACTING)
  machine.transition(CU_STATES.POST_ACTION_GRACE)
  machine.transition(CU_STATES.VERIFYING)
  machine.transition(CU_STATES.OBSERVING)
  machine.transition(CU_STATES.COMPLETED)
  assert.equal(machine.isTerminal(), true)
  assert.deepEqual(machine.path(), ['IDLE', 'RECEIVING_TASK', 'OBSERVING', 'PLANNING_ACTION', 'STABILIZING', 'REVALIDATING', 'ACTING', 'POST_ACTION_GRACE', 'VERIFYING', 'OBSERVING', 'COMPLETED'])

  assert.throws(() => machine.transition(CU_STATES.ACTING), (error) => error.code === CODES.STATE_TRANSITION_INVALID)

  const other = createStateMachine()
  other.transition(CU_STATES.RECEIVING_TASK)
  assert.throws(() => other.transition(CU_STATES.ACTING), (error) => error.code === CODES.STATE_TRANSITION_INVALID)
  other.transition(CU_STATES.FAILED, { reason: 'contract invalid' })
  assert.equal(other.isTerminal(), true)
  assert.equal(other.history().at(-1).reason, 'contract invalid')
})

test('terminal states cannot re-enter the loop, but teardown can force a stop from anywhere', () => {
  const machine = createStateMachine()
  machine.transition(CU_STATES.RECEIVING_TASK)
  machine.transition(CU_STATES.OBSERVING)
  machine.transition(CU_STATES.PLANNING_ACTION)
  machine.transition(CU_STATES.STABILIZING)
  machine.force(CU_STATES.FAILED, { reason: 'cancelled by the host' })
  assert.equal(machine.history().at(-1).direction, 'forced')
  assert.throws(() => machine.transition(CU_STATES.ACTING), (error) => error.code === CODES.STATE_TRANSITION_INVALID)
})
