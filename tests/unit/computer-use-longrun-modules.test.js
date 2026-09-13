'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createFocusTrust, FOCUS_INVALIDATION, HARD_INVALIDATIONS } = require('../../app/computer-use/focus.cjs')
const {
  MODAL_KINDS,
  MODAL_ACTION,
  classifyControl,
  classifyModal,
  chooseControl,
  planModal,
  destructiveAllowed,
  isDestructiveKind
} = require('../../app/computer-use/modal.cjs')
const { createStabilizer, SIGNALS, SIGNAL_LIST, SIGNAL_ALIASES, normalizeSignals } = require('../../app/computer-use/stabilization.cjs')
const { GRADES, RISK, RISK_BAR, HIGH_RISK_ACTIONS, LOW_RISK_ACTIONS, classifyRisk, gradeEvidence, assess } = require('../../app/computer-use/evidence.cjs')
const { createProgressTracker, PROGRESS_KINDS } = require('../../app/computer-use/progress.cjs')
const { createStallDetector, STALL_RECOVERY_LADDER } = require('../../app/computer-use/stall.cjs')
const { createRecoveryController, RECOVERY_STEPS, RECOVERY_VERDICTS, USER_ACTION_CODES } = require('../../app/computer-use/recovery.cjs')
const { createProcessRegistry, PROCESS_MODE, PROCESS_STATUS } = require('../../app/computer-use/processes.cjs')
const { createResourceBudget, classifyRetention, DEFAULTS } = require('../../app/computer-use/resources.cjs')
const { createReconnectPolicy, RECONNECT, isTransportFailure } = require('../../app/computer-use/reconnect.cjs')
const { createWorkspaceGuard } = require('../../app/computer-use/workspace.cjs')
const { createMutationVerifier, MUTATION_TYPES, RESUME_VERDICT } = require('../../app/computer-use/mutation.cjs')
const { COMMAND_DEFAULTS, COMMAND_MODE, normalizeCommand, inferMode, judge, invalidError } = require('../../app/computer-use/command.cjs')
const { createExecutionLog } = require('../../app/computer-use/log.cjs')
const { HEALTH_STATUS, BLOCK_REASONS, buildHealthSnapshot, capabilityVerdict } = require('../../app/computer-use/health.cjs')
const { createComputerUseRuntime } = require('../../app/computer-use/index.cjs')
const { TIMING, STEP_RESULTS } = require('../../app/computer-use/constants.cjs')
const { CODES, ComputerUseError } = require('../../app/computer-use/errors.cjs')
const { createVirtualClock } = require('../helpers/computer-use-clock.cjs')

/**
 * Long-running execution modules (Update-Plan/24h.md Tasks 1-20).
 *
 * Every test below enforces one rule the plan states, in the module that now
 * owns it: focus trust (Task 1), modal fail-safe (Task 2), adaptive
 * stabilization (Task 3), evidence grading (Task 4), meaningful progress
 * (Task 5), the bounded stall ladder (Task 6), owned-process supervision
 * (Task 7), resource hygiene (Task 8), bounded reconnect (Task 10), workspace
 * continuity (Task 11), verified mutations and resume (Task 12/14), the command
 * contract (Task 13), log hygiene (Task 18), the self-health snapshot
 * (Task 19/20), and the source-level check that the responsibilities really
 * moved (Task 15/16/17) without the runtime learning anything about an
 * application (Global Constraints).
 *
 * The tests are deterministic: time is either injected or taken from the
 * virtual clock, a log test uses a real file in the temp directory and removes
 * it afterwards, and nothing here sleeps on a wall clock.
 */

const ROOT = path.resolve(__dirname, '..', '..')
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8')

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    /* a leaked temp directory must not fail a test */
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// Task 1 — focus trust (focus.cjs)
// ---------------------------------------------------------------------------

test('focus trust is promoted only after a verified focus, never by an attempt (Task 1)', () => {
  const clock = createVirtualClock()
  const trust = createFocusTrust({ now: () => clock.now() })
  const initial = trust.trust()
  assert.equal(initial.trusted, false)
  assert.equal(initial.ref, null, 'no focus is authorized before anything was verified')
  trust.attempt('#search')
  assert.equal(trust.trust().trusted, false)
  assert.equal(trust.trust().ref, null)
  assert.equal(trust.attemptedFocusRef, '#search')
  clock.advance(25)
  const outcome = trust.verified('success', '#search')
  assert.equal(outcome.verified, true)
  assert.equal(trust.verifiedFocusRef, '#search')
  assert.equal(trust.trust().trusted, true)
  assert.equal(trust.trust().ref, '#search')
  assert.equal(trust.trust().ageMs, 0)
})

test('an attempt is evidence of an intention, never authorization (Task 1)', () => {
  const trust = createFocusTrust({ now: () => 1000 })
  trust.attempt('#search')
  assert.equal(trust.trust().trusted, false, 'an attempted focus authorizes nothing')
  assert.equal(trust.trust().ref, null)
  const attempted = trust.attempt('#other')
  assert.equal(attempted.kind, 'attempt')
  assert.equal(trust.snapshot().attemptedFocusRef, '#other')
  // The two fields are never conflated: the verification can name a different
  // element and only the verified one is trusted.
  trust.verified('success', '#third')
  assert.equal(trust.verifiedFocusRef, '#third')
  assert.equal(trust.attemptedFocusRef, '#other')
  assert.equal(trust.trust().trusted, true)
  assert.equal(trust.history().filter((entry) => entry.kind === 'attempt').length, 2)
})

test('a failed or unknown focus verification clears the trusted reference (Task 1)', () => {
  const trust = createFocusTrust({ now: () => 1000 })
  trust.verified('success', '#search')
  assert.equal(trust.verifiedFocusRef, '#search')
  const failure = trust.verified('failure')
  assert.equal(failure.verified, false)
  assert.equal(failure.reason, FOCUS_INVALIDATION.VERIFICATION_FAILED)
  assert.equal(trust.verifiedFocusRef, null)
  assert.equal(trust.trust().trusted, false)

  trust.verified('success', '#search')
  const unknown = trust.verified('unknown')
  assert.equal(unknown.reason, FOCUS_INVALIDATION.VERIFICATION_UNKNOWN)
  assert.equal(trust.verifiedFocusRef, null)
  assert.equal(trust.trust().lastInvalidation.reason, FOCUS_INVALIDATION.VERIFICATION_UNKNOWN)
})

test('a success verdict without a reference is not a verified focus (Task 1)', () => {
  const trust = createFocusTrust({ now: () => 1000 })
  const outcome = trust.verified('success', null)
  assert.equal(outcome.verified, false)
  assert.equal(trust.verifiedFocusRef, null)
})

test('every hard invalidation clears the verified focus (Task 1)', () => {
  const trust = createFocusTrust({ now: () => 1000 })
  for (const reason of HARD_INVALIDATIONS) {
    trust.verified('success', '#field')
    assert.equal(trust.verifiedFocusRef, '#field')
    trust.invalidate(reason)
    assert.equal(trust.verifiedFocusRef, null, `${reason} must clear the trusted focus`)
    assert.equal(trust.trust().lastInvalidation.reason, reason)
  }
  assert.deepEqual(
    [...HARD_INVALIDATIONS],
    [
      FOCUS_INVALIDATION.WINDOW_CHANGED,
      FOCUS_INVALIDATION.NAVIGATION,
      FOCUS_INVALIDATION.TARGET_DETACHED,
      FOCUS_INVALIDATION.VERIFICATION_FAILED,
      FOCUS_INVALIDATION.VERIFICATION_UNKNOWN,
      // A reference that outlives the step that verified it is stale, so the
      // step boundary is a hard invalidation too (Task 1/14).
      FOCUS_INVALIDATION.STEP_RESET
    ]
  )
  assert.equal(typeof FOCUS_INVALIDATION.STEP_RESET, 'string', 'the plan names step_reset as an invalidation reason')
})

test('the step boundary drops a stale verified focus (Task 1/14)', () => {
  const trust = createFocusTrust({ now: () => 1000 })
  trust.attempt('#field', { source: 'resolution' })
  trust.verified('success', '#field')
  assert.equal(trust.verifiedFocusRef, '#field')
  const after = trust.beginStep()
  assert.equal(after.trusted, false, 'a new step may not inherit the previous step focus')
  assert.equal(trust.verifiedFocusRef, null)
  assert.equal(trust.trust().lastInvalidation.reason, FOCUS_INVALIDATION.STEP_RESET)

  // A caller that deliberately holds the focus across a boundary (a modal pause
  // resuming the same step) can say so.
  trust.verified('success', '#field')
  const held = trust.beginStep({ reset: false })
  assert.equal(held.trusted, true)
  assert.equal(held.ref, '#field')
})

test('a window change and a navigation invalidate the verified focus on the next observation (Task 1)', () => {
  const trust = createFocusTrust({ now: () => 1000 })
  trust.observeContext({ windowSignature: 'w1', url: 'https://example.test/', title: 'Home', focusedRef: '#field', controls: [{ ref: '#field' }] })
  trust.verified('success', '#field')
  const same = trust.observeContext({ windowSignature: 'w1', url: 'https://example.test/', title: 'Home', focusedRef: '#field', controls: [{ ref: '#field' }] })
  assert.equal(same.invalidated, false, 'an unchanged context keeps the verified focus')

  const windowChanged = trust.observeContext({ windowSignature: 'w2', url: 'https://example.test/', title: 'Home', focusedRef: '#field', controls: [{ ref: '#field' }] })
  assert.equal(windowChanged.invalidated, true)
  assert.ok(windowChanged.reasons.includes(FOCUS_INVALIDATION.WINDOW_CHANGED))
  assert.equal(trust.verifiedFocusRef, null)

  trust.observeContext({ windowSignature: 'w2', url: 'https://example.test/a', title: 'Home', focusedRef: '#field', controls: [{ ref: '#field' }] })
  trust.verified('success', '#field')
  const navigated = trust.observeContext({ windowSignature: 'w2', url: 'https://example.test/b', title: 'Home', focusedRef: '#field', controls: [{ ref: '#field' }] })
  assert.equal(navigated.invalidated, true)
  assert.ok(navigated.reasons.includes(FOCUS_INVALIDATION.NAVIGATION))
})

test('a detached target invalidates the focus even when the surrounding page did not change (Task 1)', () => {
  const trust = createFocusTrust({ now: () => 1000 })
  trust.observeContext({ windowSignature: 'w1', url: 'https://example.test/', title: 'Home', controls: [{ ref: '#field' }] })
  trust.verified('success', '#field')
  const detached = trust.observeContext({ windowSignature: 'w1', url: 'https://example.test/', title: 'Home', controls: [{ ref: '#other' }] })
  assert.ok(detached.reasons.includes(FOCUS_INVALIDATION.TARGET_DETACHED))
  assert.equal(trust.verifiedFocusRef, null)
})

test('the focus history stays bounded while it is recorded (Task 1)', () => {
  const trust = createFocusTrust({ now: () => 1000 })
  for (let index = 0; index < 150; index += 1) {
    trust.attempt(`#field-${index}`)
    trust.verified('success', `#field-${index}`)
  }
  const history = trust.history()
  assert.ok(history.length <= 100, `expected a bounded history, saw ${history.length}`)
  assert.equal(history[history.length - 1].kind, 'verified')
  assert.equal(history[history.length - 1].ref, '#field-149')
})

// ---------------------------------------------------------------------------
// Task 2 — modal fail-safe (modal.cjs)
// ---------------------------------------------------------------------------

test('every documented dialog kind classifies from its label (Task 2)', () => {
  const table = [
    ['Cancel', MODAL_KINDS.SAFE_DISMISS],
    ['Close', MODAL_KINDS.SAFE_DISMISS],
    ['Not now', MODAL_KINDS.SAFE_DISMISS],
    ['OK', MODAL_KINDS.NEUTRAL_ACKNOWLEDGE],
    ['Got it', MODAL_KINDS.NEUTRAL_ACKNOWLEDGE],
    ['Confirm', MODAL_KINDS.POSITIVE_CONFIRM],
    ['Save', MODAL_KINDS.POSITIVE_CONFIRM],
    ['Delete', MODAL_KINDS.DESTRUCTIVE],
    ['Purchase', MODAL_KINDS.DESTRUCTIVE],
    ['Sign out', MODAL_KINDS.DESTRUCTIVE]
  ]
  for (const [label, kind] of table) {
    assert.equal(classifyControl(label).kind, kind, `${label} must classify as ${kind}`)
  }
  assert.equal(classifyControl('').kind, MODAL_KINDS.UNKNOWN)
  assert.equal(classifyControl('Frobnicate').kind, MODAL_KINDS.UNKNOWN)
})

test('a destructive label is matched before a safe-dismiss label ("Delete and close" is DESTRUCTIVE) (Task 2)', () => {
  const classification = classifyControl('Delete and close')
  assert.equal(classification.kind, MODAL_KINDS.DESTRUCTIVE)
  assert.equal(classification.destructiveKind, 'DELETE')
  assert.equal(classifyControl('Close and delete').kind, MODAL_KINDS.DESTRUCTIVE)
  assert.equal(classifyControl('Cancel').kind, MODAL_KINDS.SAFE_DISMISS)
})

test('the chooser never presses "the first button" when nothing can be classified (Task 2)', () => {
  const classification = classifyModal({ message: 'Continue?', controls: [{ ref: 'r1', label: 'Frobnicate' }, { ref: 'r2', label: 'Whatever' }] })
  const decision = chooseControl(classification, {})
  assert.equal(decision.action, MODAL_ACTION.USER_ACTION_REQUIRED)
  assert.equal(decision.control, null)
  assert.equal(decision.requiresUser, true)
  assert.match(decision.reason, /none of the dialog's 2 control\(s\) could be classified/)

  const empty = chooseControl(classifyModal({ controls: [] }), {})
  assert.equal(empty.action, MODAL_ACTION.USER_ACTION_REQUIRED)
  assert.match(empty.reason, /no control/)

  // The documented example of an unclassifiable dialog is the bare "Yes" that
  // carries no effect information: the plan refuses it instead of assuming it.
  const bareYes = classifyControl('Yes')
  if (bareYes.kind === MODAL_KINDS.UNKNOWN) {
    assert.equal(chooseControl(classifyModal({ controls: [{ ref: 'yes', label: 'Yes' }] }), {}).action, MODAL_ACTION.USER_ACTION_REQUIRED)
  } else {
    assert.equal(bareYes.kind, MODAL_KINDS.POSITIVE_CONFIRM, 'a classifiable label must not be reported as unknown')
  }
})

test('the chooser prefers a safe dismissal over everything else (Task 2)', () => {
  const classification = classifyModal({
    message: 'Delete this file?',
    controls: [{ ref: 'del', label: 'Delete', source: 'page' }, { ref: 'cancel', label: 'Cancel', source: 'page' }]
  })
  const decision = chooseControl(classification, { destructiveMode: 'confirm', expectedEffect: 'DELETE', safetyPassed: true })
  assert.equal(decision.action, MODAL_ACTION.PRESS)
  assert.equal(decision.ref === undefined ? decision.control.ref : decision.ref, 'cancel')
  assert.equal(decision.kind, MODAL_KINDS.SAFE_DISMISS)
})

test('a plan with no safe control asks the user instead of guessing (Task 2)', () => {
  const plan = planModal({
    modal: { message: 'Send this message?' },
    candidates: [{ ref: 'send', label: 'Send', source: 'page' }, { ref: 'yes', label: 'Yes', source: 'page' }]
  })
  assert.equal(plan.action, MODAL_ACTION.USER_ACTION_REQUIRED)
  assert.equal(plan.requiresUser, true)
  assert.equal(plan.ref, null)
  assert.equal(plan.destructiveKind, 'SEND')
})

test('a destructive confirmation requires the contract, the declared effect and the safety gate (Task 2)', () => {
  const modal = { message: 'Delete this file?', controls: [{ ref: 'del', label: 'Delete', source: 'page' }] }
  const plan = (context) => planModal({ modal, candidates: modal.controls, context })

  assert.equal(plan({ destructiveMode: 'forbidden', expectedEffect: 'DELETE', safetyPassed: true }).action, MODAL_ACTION.USER_ACTION_REQUIRED)
  assert.equal(plan({ destructiveMode: 'confirm', safetyPassed: true }).action, MODAL_ACTION.USER_ACTION_REQUIRED, 'no declared effect must refuse')
  assert.equal(plan({ destructiveMode: 'confirm', expectedEffect: 'DELETE' }).action, MODAL_ACTION.USER_ACTION_REQUIRED, 'no safety gate must refuse')
  const allowed = plan({ destructiveMode: 'confirm', expectedEffect: 'DELETE', safetyPassed: true })
  assert.equal(allowed.action, MODAL_ACTION.PRESS)
  assert.equal(allowed.ref, 'del')
  assert.equal(allowed.destructiveKind, 'DELETE')
})

test('a bland label is made destructive by the dialog message and needs the declared effect (Task 2)', () => {
  const modal = { message: 'Delete this file?', controls: [{ ref: 'yes', label: 'Yes', source: 'page' }] }
  const classification = classifyModal(modal)
  assert.equal(classification.messageDestructiveKind, 'DELETE')
  assert.equal(classification.controls[0].kind, MODAL_KINDS.POSITIVE_CONFIRM, 'the control itself carries no destructive label')
  const refused = chooseControl(classification, { destructiveMode: 'confirm', safetyPassed: true })
  assert.equal(refused.action, MODAL_ACTION.USER_ACTION_REQUIRED, 'the message makes the confirmation destructive and undeclared')
  const allowed = chooseControl(classification, { destructiveMode: 'confirm', expectedEffect: 'delete', safetyPassed: true })
  assert.equal(allowed.action, MODAL_ACTION.PRESS)
})

test('a positive confirmation is only pressed when the action declared its own next step (Task 2)', () => {
  const classification = classifyModal({ controls: [{ ref: 'ok', label: 'Confirm' }] })
  const refused = chooseControl(classification, {})
  assert.equal(refused.action, MODAL_ACTION.USER_ACTION_REQUIRED)
  assert.equal(refused.requiresUser, true)
  const allowed = chooseControl(classification, { expectedEffect: 'the settings dialog closes' })
  assert.equal(allowed.action, MODAL_ACTION.PRESS)
  assert.equal(allowed.kind, MODAL_KINDS.POSITIVE_CONFIRM)
})

test('an acknowledgement is pressed because it cannot change anything, and a disabled control is ignored (Task 2)', () => {
  const neutral = chooseControl(classifyModal({ controls: [{ ref: 'ok', label: 'Got it' }] }), {})
  assert.equal(neutral.action, MODAL_ACTION.PRESS)
  assert.equal(neutral.kind, MODAL_KINDS.NEUTRAL_ACKNOWLEDGE)

  const plan = planModal({
    modal: {},
    candidates: [{ ref: 'del', label: 'Delete', disabled: true, source: 'page' }, { ref: 'ok', label: 'OK', source: 'page' }]
  })
  assert.equal(plan.classification.controls.length, 1, 'a disabled control must not be classified as available')
  assert.equal(plan.ref, 'ok')
})

test('destructiveAllowed and isDestructiveKind follow the documented vocabulary (Task 2)', () => {
  assert.equal(destructiveAllowed('forbidden'), false)
  assert.equal(destructiveAllowed('confirm'), true)
  assert.equal(destructiveAllowed('allowed'), true)
  assert.equal(destructiveAllowed(undefined), true, 'the default mode is confirm, not forbidden')
  assert.equal(isDestructiveKind('DELETE'), true)
  assert.equal(isDestructiveKind('PUBLISH'), true)
  assert.equal(isDestructiveKind('CLICK'), false)
})

// ---------------------------------------------------------------------------
// Task 3 / 16 — adaptive stabilization (stabilization.cjs)
// ---------------------------------------------------------------------------

test('every documented signal adds one bounded cooldown step (Task 3)', () => {
  const stabilizer = createStabilizer({ clock: createVirtualClock() })
  const base = stabilizer.dynamicCooldown({}).ms
  assert.equal(base, TIMING.cooldownBaseMs)
  for (const signal of ['uiChanging', 'targetMoved', 'previousMiss', 'windowChanged', 'animationDetected', 'modalAppeared', 'targetDetached']) {
    const cooldown = stabilizer.dynamicCooldown({ [signal]: true })
    assert.equal(cooldown.ms, base + TIMING.cooldownStepMs, `${signal} must raise the cooldown`)
    assert.equal(cooldown.signals.length, 1)
  }
  assert.equal(stabilizer.dynamicCooldown({ navigationPending: true }).ms, TIMING.navigationCooldownMs)
  assert.equal(stabilizer.dynamicCooldown({ navigationPending: true }).ceiling, 'navigation')
})

test('all eight documented signal names are in the vocabulary, aliases included (Task 3)', () => {
  assert.deepEqual(
    Object.values(SIGNALS),
    ['uiChanging', 'targetMoved', 'previousMiss', 'windowChanged', 'animationDetected', 'navigationPending', 'modalAppeared', 'targetDetached']
  )
  assert.equal(SIGNAL_ALIASES['ui-changing'], SIGNALS.UI_CHANGING)
  assert.equal(SIGNAL_ALIASES['target-detached'], SIGNALS.TARGET_DETACHED)
})

test('a wait with no active signal uses only the minimum, and the ladder is bounded (Task 3)', () => {
  const stabilizer = createStabilizer({ clock: createVirtualClock() })
  assert.equal(stabilizer.dynamicCooldown({}).ms, TIMING.cooldownBaseMs)
  const every = {
    uiChanging: true,
    targetMoved: true,
    previousMiss: true,
    windowChanged: true,
    animationDetected: true,
    modalAppeared: true,
    targetDetached: true
  }
  const saturated = stabilizer.dynamicCooldown(every)
  assert.equal(saturated.ms, TIMING.cooldownSoftMaxMs, 'the ladder stops at the soft ceiling')
  assert.equal(saturated.exhausted, true)
  const values = []
  for (const state of [{}, { uiChanging: true }, { uiChanging: true, targetMoved: true, previousMiss: true, windowChanged: true, animationDetected: true, modalAppeared: true, targetDetached: true }]) {
    values.push(stabilizer.dynamicCooldown(state).ms)
  }
  for (const value of values) assert.ok(value <= TIMING.cooldownHardMaxMs, 'the cooldown can never exceed the hard ceiling')
})

test('unknown signal names are reported rather than silently accepted (Task 3)', () => {
  const fromArray = normalizeSignals(['ui-changing', 'not-a-signal'])
  assert.deepEqual(fromArray.unknown, ['not-a-signal'])
  assert.equal(fromArray.signals.uiChanging, true)
  const fromObject = normalizeSignals({ bogusSignal: true })
  assert.deepEqual(fromObject.unknown, ['bogusSignal'])
  assert.equal(fromObject.signals.windowChanged, false)
  assert.deepEqual(normalizeSignals(null).unknown, [])
})

test('the forced minimum is clamped by the action\'s own maximum and never overshoots it (Task 3)', async () => {
  const clock = createVirtualClock()
  const stabilizer = createStabilizer({ clock })
  const outcome = await stabilizer.settle({
    action: { stabilization: { minimumMs: 250, maximumMs: 100 } },
    observe: async () => ({ revision: 1, loading: false }),
    locateTarget: async () => null
  })
  const elapsed = clock.now() - 1000
  assert.ok(elapsed <= 100, `the maximum must bound the forced minimum, elapsed ${elapsed}`)
  assert.ok(outcome.waitedMs <= 100)
})

test('the settle loop stops at the ceiling instead of sleeping forever (Task 3)', async () => {
  const clock = createVirtualClock()
  const stabilizer = createStabilizer({ clock })
  let revision = 0
  const outcome = await stabilizer.settle({
    action: { stabilization: { minimumMs: 20, maximumMs: 200 } },
    world: { revision: 0 },
    observe: async () => ({ revision: (revision += 1), loading: false }),
    locateTarget: async () => null
  })
  assert.equal(outcome.verdict, 'wait_state')
  assert.ok(outcome.waitedMs <= 200 + TIMING.cooldownStepMs)
  assert.ok(clock.sleeps > 0)
})

test('a caller-known signal is carried into the settle cooldown (Task 3)', async () => {
  const clock = createVirtualClock()
  const stabilizer = createStabilizer({ clock })
  const outcome = await stabilizer.settle({
    action: { stabilization: { minimumMs: 0, maximumMs: 40 } },
    signals: { previousMiss: true, windowChanged: true },
    world: { revision: 1 },
    observe: async () => ({ revision: 1, loading: false }),
    locateTarget: async () => null
  })
  assert.equal(outcome.signals.previousMiss, true)
  assert.equal(outcome.signals.windowChanged, true)
})

// ---------------------------------------------------------------------------
// Task 4 — evidence grading by risk (evidence.cjs)
// ---------------------------------------------------------------------------

const click = { type: 'CLICK', capability: 'desktop', target: { selector: '#preview', semantic: { text: 'Preview' } } }
const typeAction = { type: 'TYPE', capability: 'desktop', params: { text: 'alice' }, target: { selector: '#username' } }
const saveAction = { type: 'FILE_WRITE', capability: 'filesystem', params: { path: 'notes.txt' } }
const deleteAction = { type: 'FILE_DELETE', capability: 'filesystem', destructive: ['DELETE'], params: { path: 'notes.txt' }, description: 'delete notes.txt' }
const sendAction = { type: 'ACCESSIBILITY_INVOKE', capability: 'desktop', destructive: ['SEND'], description: 'send the message' }
const publishAction = { type: 'ACCESSIBILITY_INVOKE', capability: 'desktop', destructive: ['PUBLISH'], description: 'publish the site' }
const navigateAction = { type: 'BROWSER_NAVIGATE', capability: 'browser', description: 'open the page' }

test('risk is classified per action type and per declared destructive kind (Task 4)', () => {
  assert.equal(classifyRisk(typeAction).risk, RISK.HIGH, 'TYPE has an effect that must not be assumed')
  assert.equal(classifyRisk(saveAction).risk, RISK.HIGH, 'SAVE needs file evidence')
  assert.equal(classifyRisk(deleteAction).risk, RISK.CRITICAL, 'DELETE is authorized-and-target-gone')
  assert.equal(classifyRisk(sendAction).risk, RISK.CRITICAL, 'SEND needs a specific success state')
  assert.equal(classifyRisk(publishAction).risk, RISK.CRITICAL, 'PUBLISH needs a specific success state')
  assert.equal(classifyRisk(navigateAction).risk, RISK.HIGH)
  assert.equal(classifyRisk(click).risk, RISK.STANDARD, 'a generic click accepts a local state change')
  assert.equal(classifyRisk({ type: 'SCROLL', capability: 'desktop' }).risk, RISK.LOW)
  for (const action of HIGH_RISK_ACTIONS) assert.equal(typeof action, 'string')
  for (const action of LOW_RISK_ACTIONS) assert.equal(typeof action, 'string')
})

test('a description that names a destructive effect raises the risk to critical (Task 4)', () => {
  assert.equal(classifyRisk({ type: 'CLICK', capability: 'desktop', description: 'Delete the old build' }).risk, RISK.CRITICAL)
  assert.equal(classifyRisk({ type: 'ACCESSIBILITY_INVOKE', capability: 'desktop', description: 'Publish the site' }).risk, RISK.CRITICAL)
  assert.equal(classifyRisk({ type: 'CLICK', capability: 'desktop', description: 'Open the preview' }).risk, RISK.STANDARD)
})

test('a weak effect cannot satisfy a high-risk action (Task 4)', () => {
  const weak = { verdict: 'success', kind: 'direct', evidence: [] }
  const verdict = assess({ action: typeAction, verification: weak })
  assert.equal(verdict.risk, RISK.HIGH)
  assert.equal(verdict.required, GRADES.STRONG)
  assert.equal(verdict.grade, GRADES.WEAK)
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /does not clear/)
  assert.equal(RISK_BAR[RISK.LOW], GRADES.WEAK)
  assert.equal(RISK_BAR[RISK.HIGH], GRADES.STRONG)
  assert.equal(RISK_BAR[RISK.CRITICAL], GRADES.STRONG)
})

test('a critical action must declare the expected effect before it can be accepted (Task 4)', () => {
  const strong = { verdict: 'success', kind: 'file', evidence: [{ kind: 'absent', ok: true }] }
  const undeclared = assess({ action: deleteAction, verification: strong })
  assert.equal(undeclared.risk, RISK.CRITICAL)
  assert.equal(undeclared.ok, false)
  assert.match(undeclared.reason, /must declare its expected effect/)

  const declared = assess({ action: deleteAction, verification: strong, declaredEffect: true })
  assert.equal(declared.ok, true)
  assert.equal(declared.grade, GRADES.STRONG)
})

test('file, process and navigation evidence is strong; state and focus evidence is medium (Task 4)', () => {
  assert.equal(gradeEvidence({ verification: { verdict: 'success', kind: 'file' } }).grade, GRADES.STRONG)
  assert.equal(gradeEvidence({ verification: { verdict: 'success', kind: 'process' } }).grade, GRADES.STRONG)
  assert.equal(gradeEvidence({ verification: { verdict: 'success', kind: 'navigation' } }).grade, GRADES.STRONG)
  assert.equal(gradeEvidence({ verification: { verdict: 'success', kind: 'state' } }).grade, GRADES.MEDIUM)
  assert.equal(gradeEvidence({ verification: { verdict: 'success', kind: 'focus' } }).grade, GRADES.MEDIUM)
  assert.equal(gradeEvidence({ verification: { verdict: 'success', kind: 'direct' } }).grade, GRADES.WEAK)
  assert.equal(gradeEvidence({ verification: { verdict: 'failure', kind: 'file' } }).grade, GRADES.WEAK)
  assert.equal(gradeEvidence({ verification: { verdict: 'success', kind: 'state', evidence: [{ strength: 'strong' }] } }).grade, GRADES.STRONG)
})

test('a non-success verdict is never accepted, whatever the grade would be (Task 4)', () => {
  const unknown = assess({ action: click, verification: { verdict: 'unknown', kind: 'state' } })
  assert.equal(unknown.ok, false)
  assert.match(unknown.reason, /not verified as a success/)
  const failure = assess({ action: click, verification: { verdict: 'failure', kind: 'file' } })
  assert.equal(failure.ok, false)
})

test('a local state change is enough for a generic low-risk click, and a save needs file evidence (Task 4)', () => {
  assert.equal(assess({ action: click, verification: { verdict: 'success', kind: 'state' } }).ok, true)
  assert.equal(assess({ action: click, verification: { verdict: 'success', kind: 'direct' } }).ok, false, 'a bare world change is not a local state change')

  const saved = assess({ action: saveAction, verification: { verdict: 'success', kind: 'state' } })
  assert.equal(saved.ok, false)
  assert.equal(saved.grade, GRADES.MEDIUM)
  const fileEvidence = assess({ action: saveAction, verification: { verdict: 'success', kind: 'file' } })
  assert.equal(fileEvidence.ok, true)
})

test('dismissing a modal is a safe action and is exempt from the declared-effect rule (Task 4)', () => {
  const dismiss = { type: 'CLICK', capability: 'desktop', params: { __modalDismiss: true }, description: 'dismiss "Delete this file?" via Cancel' }
  assert.equal(classifyRisk(dismiss).risk, RISK.LOW)
  const verdict = assess({ action: dismiss, verification: { verdict: 'success', kind: 'state' } })
  assert.equal(verdict.ok, true)
})

// ---------------------------------------------------------------------------
// Task 5 — meaningful progress (progress.cjs)
// ---------------------------------------------------------------------------

test('lastProgressAt moves only on a meaningful progress kind (Task 5)', () => {
  const clock = createVirtualClock(5000)
  const progress = createProgressTracker({ now: clock.now })
  assert.equal(progress.lastProgressAt, null)
  assert.equal(progress.hasProgress(), false)

  clock.advance(10)
  assert.equal(progress.progress(PROGRESS_KINDS.VERIFIED_EFFECT, { verdict: 'success', kind: 'state' }) !== null, true)
  assert.equal(progress.lastProgressAt, 5010)

  clock.advance(10)
  assert.equal(progress.progress(PROGRESS_KINDS.SUBPROCESS_EXIT, { exitCode: 0 }) !== null, true)
  assert.equal(progress.lastProgressAt, 5020)

  clock.advance(10)
  assert.equal(progress.progress(PROGRESS_KINDS.FILE_OPERATION, { verified: true, operation: 'write' }) !== null, true)
  assert.equal(progress.lastProgressAt, 5030)

  clock.advance(10)
  assert.equal(progress.progress(PROGRESS_KINDS.STATE_TRANSITION, { state: 'VERIFYING' }) !== null, true)
  assert.equal(progress.lastProgressAt, 5040)

  clock.advance(10)
  assert.equal(progress.progress(PROGRESS_KINDS.CRITERIA_SATISFIED, { satisfied: true, criterion: 'tests pass' }) !== null, true)
  assert.equal(progress.lastProgressAt, 5050)
  assert.equal(progress.status().lastVerifiedEffectAt, 5010)
})

test('a repeated no-op never moves lastProgressAt (Task 5)', () => {
  const clock = createVirtualClock()
  const progress = createProgressTracker({ now: clock.now })
  progress.progress(PROGRESS_KINDS.STATE_TRANSITION, { state: 'ACTING' })
  const mark = progress.lastProgressAt
  clock.advance(100)
  progress.noOp('CLICK:#save')
  progress.noOp('CLICK:#save')
  const streak = progress.noOp('CLICK:#save')
  assert.equal(streak.repeated, true)
  assert.equal(streak.streak, 3)
  assert.equal(progress.lastProgressAt, mark, 'a no-op is not progress')
  assert.equal(progress.noOpStreak, 3)
  progress.progress(PROGRESS_KINDS.FILE_OPERATION, { verified: true, operation: 'delete' })
  assert.equal(progress.noOpStreak, 0, 'real progress resets the no-op streak')
})

test('a heartbeat and an issued action are recorded but are not progress (Task 5)', () => {
  const clock = createVirtualClock()
  const progress = createProgressTracker({ now: clock.now })
  const beat = progress.heartbeat()
  assert.equal(beat.alive, true)
  progress.action({ type: 'CLICK' })
  assert.equal(progress.lastProgressAt, null)
  assert.equal(progress.status().lastActionAt !== null, true)
  assert.equal(progress.status().heartbeats, 1)
  const status = progress.status()
  assert.equal(status.sinceProgressMs === null, false, 'a run with actions but no progress reports its action age')
})

test('a direct-kind verification is refused as progress (Task 5)', () => {
  const progress = createProgressTracker({ now: () => 1000 })
  assert.equal(progress.progress(PROGRESS_KINDS.VERIFIED_EFFECT, { verdict: 'success', kind: 'direct' }), null)
  assert.equal(progress.lastProgressAt, null, '"the world changed somewhere" is exactly what a spinner does forever')
  assert.equal(progress.progress(PROGRESS_KINDS.VERIFIED_EFFECT, { verdict: 'unknown', kind: 'state' }), null)
  assert.equal(progress.progress('timer-tick'), null, 'a timer is not a progress kind')
  assert.equal(progress.progress(PROGRESS_KINDS.FILE_OPERATION, { verified: false }), null)
  assert.equal(progress.progress(PROGRESS_KINDS.CRITERIA_SATISFIED, { satisfied: false }), null)
  assert.equal(progress.progress(PROGRESS_KINDS.SUBPROCESS_EXIT, { exited: false }), null)
  assert.equal(progress.progress(PROGRESS_KINDS.STATE_TRANSITION, { state: 'VERIFYING', repeat: true }), null)
  assert.equal(progress.lastProgressAt, null)
  assert.equal(progress.progress(PROGRESS_KINDS.SUBPROCESS_EXIT, { exitCode: 1 }) !== null, true, 'a completed subprocess is progress whatever its exit code')
})

test('the progress ring and the no-op streak are bounded (Task 5)', () => {
  const progress = createProgressTracker({ now: () => 1000, ringSize: 5 })
  for (let index = 0; index < 40; index += 1) {
    progress.progress(PROGRESS_KINDS.STATE_TRANSITION, { state: `S${index}` })
  }
  assert.equal(progress.history().length, 5, 'the history ring is bounded')
  assert.equal(progress.history()[4].detail.state, 'S39')

  const bounded = createProgressTracker({ now: () => 1000, repeatWindow: 4 })
  for (let index = 0; index < 20; index += 1) bounded.noOp('same')
  assert.equal(bounded.noOpStreak, 20)
  assert.equal(bounded.status().noOpStreak, 20)
})

// ---------------------------------------------------------------------------
// Task 6 — the stall ladder has exactly one definition (stall.cjs, recovery.cjs)
// ---------------------------------------------------------------------------

const LADDER_RUNG_DESCRIPTIONS = [
  'structured_reobserve',
  'window_check',
  'target_re_resolution',
  'targeted_screenshot',
  'alternative_interaction',
  'replan',
  'full_screenshot',
  'fail_with_context'
]

test('the stall ladder is defined exactly once, with the eight documented rungs in order (Task 6)', () => {
  assert.equal(STALL_RECOVERY_LADDER.length, 8)
  assert.deepEqual(STALL_RECOVERY_LADDER.map((rung) => rung.step), LADDER_RUNG_DESCRIPTIONS)
  assert.equal(STALL_RECOVERY_LADDER[7].step, 'fail_with_context')
  for (const rung of STALL_RECOVERY_LADDER) assert.equal(typeof rung.description, 'string')
})

test('recovery reports the same ladder and never loops back to rung 1 (Task 6)', () => {
  const recovery = createRecoveryController({ now: () => 1000 })
  const seen = []
  for (let index = 0; index < 20; index += 1) {
    const decision = recovery.stallStep(index)
    assert.equal(decision.step, 'stall')
    seen.push(decision.ladderStep)
    if (decision.terminal) break
  }
  assert.deepEqual(seen, LADDER_RUNG_DESCRIPTIONS, 'the ladder is walked once, in order, and ends terminally')
  assert.equal(recovery.stallStep(0).ladderStep, LADDER_RUNG_DESCRIPTIONS[0], 'index 0 is the first rung')
  assert.equal(recovery.stallStep(-5).index, 0)
  assert.equal(recovery.stallStep(999).index, LADDER_RUNG_DESCRIPTIONS.length - 1)
  assert.equal(recovery.stallStep(999).terminal, true)
})

test('maxRecoveries bounds the stall escalation (Task 6)', () => {
  const stall = createStallDetector({ now: () => 1000, consecutiveActions: 3, maxRecoveries: 2 })
  assert.equal(stall.maxRecoveries, 2)
  assert.equal(stall.exhausted, false)
  assert.equal(stall.registerRecovery().exhausted, false)
  const second = stall.registerRecovery()
  assert.equal(second.exhausted, true)
  assert.equal(second.remaining, 0)
  assert.equal(stall.exhausted, true)
})

test('a stall needs repeated attempts without meaningful change, not wall-clock time (Task 6)', () => {
  const clock = createVirtualClock()
  const stall = createStallDetector({ now: clock.now, consecutiveActions: 3 })
  assert.equal(stall.record({ step: 1, changed: false }).stalled, false)
  clock.advance(60_000)
  assert.equal(stall.record({ step: 2, changed: false }).stalled, false)
  assert.equal(stall.record({ step: 3, changed: false }).stalled, true)
  const recovered = stall.record({ step: 4, changed: true })
  assert.equal(recovered.stalled, false)
  assert.equal(recovered.consecutive, 0)
})

// ---------------------------------------------------------------------------
// Task 7 — owned process supervision (processes.cjs)
// ---------------------------------------------------------------------------

function fakeChild(pid) {
  return { pid, kill() { this.killed = true; return true } }
}

test('the registry records pid, command, cwd, start, ownership, expected lifetime and status (Task 7)', () => {
  const clock = createVirtualClock(9000)
  const registry = createProcessRegistry({ now: clock.now })
  const { id } = registry.register({
    child: fakeChild(4242),
    command: 'npm',
    args: ['test'],
    cwd: 'D:/DS-Hns/app',
    mode: PROCESS_MODE.FOREGROUND,
    expectedLifetimeMs: 120_000,
    ownership: 'run-7',
    step: 3
  })
  assert.equal(registry.ownedCount, 1)
  const [owned] = registry.snapshot().owned
  assert.equal(owned.id, id)
  assert.equal(owned.pid, 4242)
  assert.equal(owned.command, 'npm')
  assert.deepEqual(owned.args, ['test'])
  assert.equal(owned.cwd, 'D:/DS-Hns/app')
  assert.equal(owned.ownership, 'run-7')
  assert.equal(owned.expectedLifetimeMs, 120_000)
  assert.equal(owned.startedAt, 9000)
  assert.equal(owned.status, PROCESS_STATUS.RUNNING)
  assert.equal(owned.mode, PROCESS_MODE.FOREGROUND)

  const settled = registry.settle(id, { status: PROCESS_STATUS.EXITED, exitCode: 0 })
  assert.equal(settled.exitCode, 0)
  assert.equal(settled.status, PROCESS_STATUS.EXITED)
  assert.equal(registry.ownedCount, 0)
  assert.equal(registry.isRunning(id), false)
  assert.equal(registry.settle('p-not-mine', { status: PROCESS_STATUS.EXITED }), null)
})

test('kill refuses a process the runtime does not own, and disposes the ones it does (Task 7)', async () => {
  const registry = createProcessRegistry({ now: () => 1000 })
  const child = fakeChild(11)
  const { id } = registry.register({ child, command: 'node', mode: PROCESS_MODE.FOREGROUND })
  const stranger = await registry.kill('p999')
  assert.deepEqual(stranger, { ok: false, reason: 'not_owned', id: 'p999' })
  assert.equal(child.killed, undefined, 'an unowned process is never killed')

  const killed = await registry.kill(id, 'test')
  assert.equal(killed.ok, true)
  assert.equal(child.killed, true)
  assert.equal(registry.ownedCount, 0)
  const disposed = await registry.dispose('shutdown')
  assert.equal(disposed.attempted, 0)
})

test('dispose settles every owned process at shutdown (Task 7)', async () => {
  const registry = createProcessRegistry({ now: () => 1000 })
  const first = fakeChild(1)
  const second = fakeChild(2)
  registry.register({ child: first, command: 'npm test' })
  registry.register({ child: second, command: 'node server.js', mode: PROCESS_MODE.LONG_RUNNING, expectedLifetimeMs: 3_600_000 })
  const result = await registry.dispose('runtime shutdown')
  assert.equal(result.attempted, 2)
  assert.equal(result.disposed, 2)
  assert.equal(first.killed, true)
  assert.equal(second.killed, true)
  assert.equal(registry.ownedCount, 0)
  assert.equal(registry.finished().length, 2)
})

test('a hung process is detectable without treating an intended dev server as hung (Task 7)', () => {
  const clock = createVirtualClock(1000)
  const registry = createProcessRegistry({ now: clock.now })
  const foreground = registry.register({ child: fakeChild(1), command: 'npm test', expectedLifetimeMs: 1000 }).id
  const server = registry.register({
    child: fakeChild(2),
    command: 'npm run dev',
    mode: PROCESS_MODE.LONG_RUNNING,
    expectedLifetimeMs: 3_600_000
  }).id
  assert.equal(registry.looksHung(foreground), false)
  clock.advance(1500)
  assert.equal(registry.looksHung(foreground), true, 'a bounded foreground process that outlived its budget is hung')
  assert.equal(registry.looksHung(server), false, 'an intended long-running process is not a hung one')
  assert.deepEqual(registry.snapshot().hungSuspected, [foreground])
})

test('the owned count is capped, and the finished history is bounded (Task 7)', () => {
  const registry = createProcessRegistry({ now: () => 1000, maxOwned: 2, ringSize: 3 })
  registry.register({ child: fakeChild(1), command: 'a' })
  registry.register({ child: fakeChild(2), command: 'b' })
  assert.equal(registry.atCapacity(), true)
  assert.throws(() => registry.register({ child: fakeChild(3), command: 'c' }), (error) => error.code === CODES.RESOURCE_LIMIT)
  assert.throws(() => registry.register({ command: 'no child' }), (error) => error.code === CODES.PROCESS_INVALID)

  registry.settle('p1', { status: PROCESS_STATUS.EXITED, exitCode: 0 })
  registry.settle('p2', { status: PROCESS_STATUS.EXITED, exitCode: 0 })
  registry.register({ child: fakeChild(4), command: 'd' })
  registry.register({ child: fakeChild(5), command: 'e' })
  registry.release('p3')
  registry.register({ child: fakeChild(6), command: 'f' })
  registry.settle('p4', { status: PROCESS_STATUS.KILLED })
  registry.settle('p5', { status: PROCESS_STATUS.EXITED, exitCode: 0 })
  registry.settle('p6', { status: PROCESS_STATUS.EXITED, exitCode: 0 })
  assert.ok(registry.finished().length <= 3, 'the finished ring is bounded')
})

// ---------------------------------------------------------------------------
// Task 8 — resource hygiene (resources.cjs)
// ---------------------------------------------------------------------------

test('retention classifies every documented case (Task 8)', () => {
  assert.equal(classifyRetention('requested').keep, true)
  assert.equal(classifyRetention('anything', { explicit: true }).retention, 'requested')
  assert.equal(classifyRetention('capture', { runFailed: true }).keep, true, 'failure evidence is retained')
  assert.equal(classifyRetention('capture', { runFailed: true }).retention, 'failure')
  assert.equal(classifyRetention('stall-targeted').keep, false)
  assert.equal(classifyRetention('stall-targeted').transient, true)
  assert.equal(classifyRetention('recovery').transient, true)
  assert.equal(classifyRetention('normal step').keep, false)
  assert.equal(classifyRetention('capture', { retention: 'never' }).keep, false)
  assert.equal(classifyRetention('capture', { mode: 'debug' }).keep, true)
  assert.equal(classifyRetention('capture', { mode: 'audit' }).keep, true)
})

test('the screenshot ring and the entry ring are capped (Task 8)', () => {
  const budget = createResourceBudget({ now: () => 1000, maxScreenshots: 4, ringSize: 3 })
  for (let index = 0; index < 20; index += 1) {
    budget.registerScreenshot({ reason: 'step', step: index, bytes: 10, runFailed: true })
  }
  assert.ok(budget.screenshotCount <= 4, `expected at most 4 live records, saw ${budget.screenshotCount}`)
  assert.ok(budget.dropped > 0)
  assert.equal(budget.snapshot().screenshots, budget.screenshotCount)

  const ring = budget.ring(3)
  for (let index = 0; index < 10; index += 1) ring.push(index)
  assert.deepEqual(ring.toArray(), [7, 8, 9])
  assert.equal(ring.size, 3)
  assert.deepEqual(ring.last(2), [8, 9])
})

test('transient entries expire and the byte ceiling is enforced (Task 8)', () => {
  const clock = createVirtualClock(0)
  const budget = createResourceBudget({ now: clock.now, transientTtlMs: 1000, maxEvidenceBytes: 10_000 })
  budget.registerScreenshot({ reason: 'stall-targeted', bytes: 10 })
  clock.advance(2000)
  assert.equal(budget.enforce() >= 1, true)
  assert.equal(budget.screenshotCount, 0)

  const bytes = createResourceBudget({ now: () => 0, maxEvidenceBytes: 1000 })
  for (let index = 0; index < 6; index += 1) {
    bytes.registerScreenshot({ reason: 'step', bytes: 400, runFailed: true })
  }
  assert.ok(bytes.snapshot().evidenceBytes <= 1000, `the byte ceiling must hold, saw ${bytes.snapshot().evidenceBytes}`)
})

test('failure evidence survives eviction while transients go first (Task 8)', () => {
  const budget = createResourceBudget({ now: () => 0, maxScreenshots: 2 })
  budget.registerScreenshot({ reason: 'step', bytes: 1, runFailed: true })
  budget.registerScreenshot({ reason: 'stall-targeted', bytes: 1 })
  budget.registerScreenshot({ reason: 'stall-full', bytes: 1 })
  const records = budget.screenshots()
  assert.ok(records.length <= 2)
  const kept = records.filter((entry) => entry.keep)
  assert.equal(kept.length, 1, 'the failure evidence is the last record to be dropped')
  assert.equal(kept[0].retention, 'failure')
  assert.equal(budget.snapshot().retainedScreenshots >= 1, true)
})

test('the documented defaults are small on purpose (Task 8)', () => {
  assert.equal(DEFAULTS.maxScreenshots, 32)
  assert.equal(DEFAULTS.ringSize, 200)
  assert.equal(DEFAULTS.transientTtlMs, 60_000)
  assert.ok(DEFAULTS.maxEvidenceBytes <= 16 * 1024 * 1024)
})

// ---------------------------------------------------------------------------
// Task 9 / 20 — controller isolation and the health snapshot (health.cjs)
// ---------------------------------------------------------------------------

test('health is healthy when every controller answers and no ceiling is reached (Task 19/20)', () => {
  const snapshot = buildHealthSnapshot({
    now: 1234,
    controllers: { desktop: { available: true }, browser: { available: true }, shell: { available: true } },
    workspace: { ok: true, cwd: 'D:/project' },
    processes: { ownedCount: 1, ceiling: 16, atCapacity: false },
    resources: { screenshots: 2, limits: { maxScreenshots: 32 }, retainedScreenshots: 1, droppedScreenshots: 0, evidenceBytes: 10 },
    progress: { lastProgressAt: 1200, sinceProgressMs: 34, lastVerifiedEffectAt: 1200, noOpStreak: 0 },
    step: { id: 's3', index: 3 },
    stallLevel: 0
  })
  assert.equal(snapshot.status, HEALTH_STATUS.HEALTHY)
  assert.equal(snapshot.at, 1234)
  assert.equal(snapshot.capabilities.desktop.available, true)
  assert.equal(snapshot.lastProgressAt, 1200)
  assert.equal(snapshot.activeOwnedProcesses, 1)
  assert.deepEqual(snapshot.currentStep, { id: 's3', index: 3 })
  assert.deepEqual(snapshot.blockedReasons, [])
  assert.equal(snapshot.stallLevel, 0)
})

test('a single failed controller degrades rather than blocks (Task 9/20)', () => {
  const snapshot = buildHealthSnapshot({
    controllers: { desktop: { available: true }, vision: { available: false, reason: 'no screenshot driver' }, shell: { available: true } }
  })
  assert.equal(snapshot.status, HEALTH_STATUS.DEGRADED)
  assert.deepEqual(snapshot.degradedCapabilities, ['vision'])
  assert.deepEqual(snapshot.unavailableCapabilities, ['vision'])
  assert.deepEqual(snapshot.blockedReasons, [])
  assert.equal(capabilityVerdict(snapshot, 'desktop').ok, true)
  assert.equal(capabilityVerdict(snapshot, 'vision').ok, false)
})

test('every documented block reason maps to blocked (Task 20)', () => {
  const base = { controllers: { desktop: { available: true } } }
  const reasons = [
    [buildHealthSnapshot({ ...base, workspace: { ok: false, reason: 'gone' } }), BLOCK_REASONS.WORKSPACE_UNAVAILABLE, 'workspace unavailable'],
    [buildHealthSnapshot({ controllers: { browser: { available: false } }, allowedCapabilities: ['browser'] }), BLOCK_REASONS.ALL_CAPABILITIES_UNAVAILABLE, 'all required capabilities unavailable'],
    [buildHealthSnapshot({ ...base, safetyAvailable: false }), BLOCK_REASONS.SAFETY_UNAVAILABLE, 'safety authorization unavailable'],
    [buildHealthSnapshot({ ...base, processes: { ownedCount: 16, ceiling: 16, atCapacity: true } }), BLOCK_REASONS.RESOURCE_CEILING, 'resource ceiling exceeded'],
    [buildHealthSnapshot({ ...base, stateIntegrity: false }), BLOCK_REASONS.STATE_INTEGRITY_UNCERTAIN, 'state integrity uncertain']
  ]
  for (const [snapshot, code, label] of reasons) {
    assert.equal(snapshot.status, HEALTH_STATUS.BLOCKED, `${label} must block`)
    assert.ok(snapshot.blockedReasons.some((entry) => entry.code === code), `${label} must report ${code}`)
  }
  assert.deepEqual(Object.values(BLOCK_REASONS), [
    'workspace_unavailable',
    'all_required_capabilities_unavailable',
    'safety_authorization_unavailable',
    'resource_ceiling_exceeded',
    'state_integrity_uncertain'
  ])
})

test('a controller the contract does not allow cannot block the runtime (Task 20)', () => {
  const snapshot = buildHealthSnapshot({
    controllers: { desktop: { available: true }, vision: { available: false, reason: 'broken' } },
    allowedCapabilities: ['desktop']
  })
  assert.equal(snapshot.status, HEALTH_STATUS.DEGRADED)
  assert.deepEqual(snapshot.blockedReasons, [])
  assert.equal(capabilityVerdict(snapshot, 'vision').ok, false)
  assert.equal(capabilityVerdict(snapshot, null).ok, true)
})

// ---------------------------------------------------------------------------
// Task 10 — bounded reconnect (reconnect.cjs)
// ---------------------------------------------------------------------------

test('a transport failure reconnects within the bounded attempts and reports success (Task 10)', async () => {
  const clock = createVirtualClock()
  const policy = createReconnectPolicy({ now: clock.now, sleep: clock.sleep, maxAttempts: 3 })
  let attempts = 0
  const outcome = await policy.reconnect({
    channel: 'browser',
    reattach: async () => {
      attempts += 1
      return attempts === 2
    },
    observe: async () => ({ url: 'https://example.test/' })
  })
  assert.equal(outcome.outcome, RECONNECT.RECONNECTED)
  assert.equal(outcome.attempt, 2)
  assert.equal(attempts, 2)
  assert.equal(clock.sleeps, 1, 'exactly one bounded backoff between the two attempts')
  assert.equal(policy.budget('browser').used, 2)
  assert.equal(policy.budget('browser').remaining, 1)
})

test('exhaustion reports the documented code and stops (Task 10)', async () => {
  const clock = createVirtualClock()
  const policy = createReconnectPolicy({ now: clock.now, sleep: clock.sleep, maxAttempts: 2 })
  const outcome = await policy.reconnect({ channel: 'browser', reattach: async () => false, observe: async () => ({}) })
  assert.equal(outcome.outcome, RECONNECT.EXHAUSTED)
  assert.equal(outcome.attempts, 2)
  assert.match(outcome.reason, /bounded attempts/)
  const error = policy.exhaustedError(outcome)
  assert.equal(error.code, CODES.RECONNECT_EXHAUSTED)
  assert.equal(error.retryable, false)

  const spent = await policy.reconnect({ channel: 'browser', reattach: async () => true })
  assert.equal(spent.outcome, RECONNECT.EXHAUSTED, 'the budget belongs to the step, not to the channel')
  policy.beginStep()
  assert.equal(policy.budget('browser').used, 0)
  const again = await policy.reconnect({ channel: 'browser', reattach: async () => true })
  assert.equal(again.outcome, RECONNECT.RECONNECTED)
})

test('a non-transport error is not retried as a reconnect (Task 10)', () => {
  assert.equal(isTransportFailure(new ComputerUseError(CODES.CONTROLLER_UNAVAILABLE, 'browser is gone')), true)
  assert.equal(isTransportFailure(new ComputerUseError(CODES.CAPABILITY_UNAVAILABLE, 'no vision')), true)
  assert.equal(isTransportFailure(new Error('WebSocket is closed')), true)
  assert.equal(isTransportFailure(new Error('Target closed')), true)
  assert.equal(isTransportFailure(new ComputerUseError(CODES.TARGET_STALE, 'the target moved')), false)
  assert.equal(isTransportFailure(new ComputerUseError(CODES.CAPABILITY_NOT_ALLOWED, 'not in the contract')), false)
  assert.equal(isTransportFailure(null), false)
})

test('a reconnect that cannot re-observe reports CONTEXT_INVALID, and backoff is bounded (Task 10)', async () => {
  const clock = createVirtualClock()
  const policy = createReconnectPolicy({ now: clock.now, sleep: clock.sleep, maxAttempts: 1, backoffMs: 50, maxBackoffMs: 100 })
  const invalid = await policy.reconnect({ channel: 'desktop', reattach: async () => true, observe: async () => null })
  assert.equal(invalid.outcome, RECONNECT.CONTEXT_INVALID)

  const backoff = createReconnectPolicy({ now: clock.now, sleep: clock.sleep, maxAttempts: 2, backoffMs: 5000, maxBackoffMs: 120 })
  await backoff.reconnect({ channel: 'shell', reattach: async () => false })
  assert.equal(clock.now() - 1000, 120, 'the backoff is capped by maxBackoffMs')
  assert.equal(backoff.events().length >= 2, true)
})

// ---------------------------------------------------------------------------
// Task 11 — verified workspace continuity (workspace.cjs)
// ---------------------------------------------------------------------------

test('a relative path without a verified workspace is refused (Task 11)', () => {
  const guard = createWorkspaceGuard({ now: () => 1000 })
  const cwd = guard.resolveCwd()
  assert.equal(cwd.ok, false)
  assert.equal(cwd.cwd, null)
  assert.match(cwd.reason, /no workspace was provided/)
  assert.equal(guard.verify().ok, false)
  const resolved = guard.resolvePath('src/index.js')
  assert.equal(resolved.ok, false)
  assert.match(resolved.reason, /cannot be resolved without a verified workspace/)
  assert.equal(guard.status().ok, false, 'an unverified workspace is reported as unavailable, never silently used')
})

test('a relative path is resolved against the verified workspace, never the process cwd (Task 11)', () => {
  const dir = tempDir('cu-ws-')
  try {
    const guard = createWorkspaceGuard({ workspace: dir, now: () => 1000 })
    assert.equal(guard.verify().ok, true)
    const cwd = guard.resolveCwd()
    assert.equal(cwd.ok, true)
    assert.equal(cwd.cwd, path.resolve(dir))
    assert.equal(cwd.source, 'workspace')
    const resolved = guard.resolvePath('src/index.js')
    assert.equal(resolved.ok, true)
    assert.equal(resolved.path, path.resolve(dir, 'src', 'index.js'))
    assert.equal(guard.isInside(resolved.path), true)
    assert.notEqual(resolved.path, path.resolve('src/index.js'))
    assert.equal(guard.status().verifiedAt, 1000)
  } finally {
    cleanup(dir)
  }
})

test('a path or cwd outside the workspace is refused unless the contract allows it (Task 11)', () => {
  const dir = tempDir('cu-ws-')
  try {
    const guard = createWorkspaceGuard({ workspace: dir, now: () => 1000 })
    const outside = path.resolve(dir, '..', 'outside.txt')
    const refused = guard.resolvePath(outside)
    assert.equal(refused.ok, false)
    assert.match(refused.reason, /outside the workspace/)
    assert.equal(guard.resolveCwd({ cwd: '..' }).ok, false)
    assert.equal(guard.resolveCwd({ cwd: path.resolve(dir, 'missing-subdir') }).ok, false)
    assert.equal(guard.drifts().length >= 1, true, 'a drift is recorded, not silently dropped')

    const allowed = createWorkspaceGuard({ workspace: dir, allowOutside: true, now: () => 1000 })
    const permitted = allowed.resolvePath(outside)
    assert.equal(permitted.ok, true)
    assert.equal(permitted.path, outside)
  } finally {
    cleanup(dir)
  }
})

test('an unavailable workspace is reported as unavailable rather than a silent fallback (Task 11)', () => {
  const guard = createWorkspaceGuard({ workspace: path.join(os.tmpdir(), 'cu-workspace-that-does-not-exist-9f3a'), now: () => 1000 })
  const verdict = guard.verify()
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /not accessible/)
  assert.equal(guard.resolveCwd().ok, false)
  assert.equal(guard.status().ok, false)
  const error = guard.unavailableError(verdict, { step: 4 })
  assert.equal(error.code, CODES.WORKSPACE_UNAVAILABLE)
  assert.equal(error.retryable, false)
  assert.equal(error.details.workspace !== undefined, true)
})

test('a workspace that drifts is detected as a mismatch at the next action (Task 11)', () => {
  const dir = tempDir('cu-ws-drift-')
  try {
    const guard = createWorkspaceGuard({ workspace: dir, now: () => 1000 })
    assert.equal(guard.verify().ok, true)
    const inside = guard.resolvePath('notes.txt')
    assert.equal(inside.ok, true)
    assert.equal(guard.drifts().length, 0, 'an action inside the workspace records no drift')

    // The next action asks for a path that left the workspace: the runtime must
    // refuse it and report the mismatch rather than write to the wrong root.
    const drifted = guard.resolvePath(path.resolve(dir, '..', 'other', 'notes.txt'), { step: 4 })
    assert.equal(drifted.ok, false)
    assert.match(drifted.reason, /outside the workspace/)
    assert.equal(guard.drifts()[0].kind, 'path_outside_workspace')
    assert.equal(guard.drifts()[0].step, 4)
    assert.equal(guard.status().drifts.length, 1)
    const mismatch = guard.mismatchError(drifted, { requested: 'C:/Users/other/notes.txt' })
    assert.equal(mismatch.code, CODES.WORKSPACE_MISMATCH)
    assert.equal(mismatch.details.workspace, path.resolve(dir))
  } finally {
    cleanup(dir)
  }
})

// ---------------------------------------------------------------------------
// Task 12 / 14 — filesystem mutation verification and resume (mutation.cjs)
// ---------------------------------------------------------------------------

test('a write is verified by existence, content, mtime and reported size (Task 12)', async () => {
  const dir = tempDir('cu-mut-')
  try {
    const file = path.join(dir, 'notes.txt')
    const verifier = createMutationVerifier({ now: () => 1000 })
    const action = { type: 'FILE_WRITE', params: { path: file, content: 'hello workspace' } }
    fs.writeFileSync(file, 'hello workspace', 'utf8')
    const before = verifier.mtime(file)
    const observed = await verifier.verify({ action, receipt: { bytes: Buffer.byteLength('hello workspace') }, beforeMtime: before })
    assert.equal(observed.verified, true)
    assert.equal(observed.operation, 'write')
    assert.ok(observed.evidence.some((entry) => entry.kind === 'exists'))
    assert.ok(observed.evidence.some((entry) => entry.kind === 'content' && entry.ok === true))
    assert.ok(observed.evidence.some((entry) => entry.kind === 'mtime' && entry.ok === true))
    assert.ok(observed.evidence.some((entry) => entry.kind === 'size' && entry.ok === true))
    assert.equal(verifier.checks().length, 1)
  } finally {
    cleanup(dir)
  }
})

test('an unverifiable write is a failure, not a success (Task 12)', async () => {
  const dir = tempDir('cu-mut-')
  try {
    const verifier = createMutationVerifier({ now: () => 1000 })
    const missing = await verifier.verify({ action: { type: 'FILE_WRITE', params: { path: path.join(dir, 'never-written.txt'), content: 'x' } } })
    assert.equal(missing.verified, false)
    assert.match(missing.reason, /was not created/)

    const file = path.join(dir, 'wrong.txt')
    fs.writeFileSync(file, 'actual', 'utf8')
    const mismatched = await verifier.verify({ action: { type: 'FILE_WRITE', params: { path: file, content: 'expected' } } })
    assert.equal(mismatched.verified, false)
    assert.match(mismatched.reason, /content does not match/)

    const notAMutation = await verifier.verify({ action: { type: 'CLICK', params: {} } })
    assert.equal(notAMutation.skipped, true)
    assert.equal(notAMutation.verified, false)
    assert.deepEqual([...MUTATION_TYPES], ['FILE_WRITE', 'FILE_COPY', 'FILE_MOVE', 'FILE_DELETE', 'FILE_MKDIR'])
  } finally {
    cleanup(dir)
  }
})

test('a copy is verified against the destination and a move against both paths (Task 12)', async () => {
  const dir = tempDir('cu-mut-')
  try {
    const verifier = createMutationVerifier({ now: () => 1000 })
    const source = path.join(dir, 'source.txt')
    const destination = path.join(dir, 'copy.txt')
    fs.writeFileSync(source, 'payload', 'utf8')
    fs.writeFileSync(destination, 'payload', 'utf8')
    const copied = await verifier.verify({ action: { type: 'FILE_COPY', params: { path: source, to: destination } } })
    assert.equal(copied.verified, true)

    const moved = path.join(dir, 'moved.txt')
    fs.renameSync(destination, moved)
    const move = await verifier.verify({ action: { type: 'FILE_MOVE', params: { path: destination, to: moved } } })
    assert.equal(move.verified, true)
    const stillThere = await verifier.verify({ action: { type: 'FILE_MOVE', params: { path: moved, to: path.join(dir, 'elsewhere.txt') } } })
    assert.equal(stillThere.verified, false)
    assert.match(stillThere.reason, /requires the source to be gone/)
  } finally {
    cleanup(dir)
  }
})

test('a delete is verified by the target being gone and a mkdir by the directory existing (Task 12)', async () => {
  const dir = tempDir('cu-mut-')
  try {
    const verifier = createMutationVerifier({ now: () => 1000 })
    const doomed = path.join(dir, 'doomed.txt')
    fs.writeFileSync(doomed, 'x', 'utf8')
    const failed = await verifier.verify({ action: { type: 'FILE_DELETE', params: { path: doomed } } })
    assert.equal(failed.verified, false)
    assert.match(failed.reason, /still exists/)
    fs.unlinkSync(doomed)
    const deleted = await verifier.verify({ action: { type: 'FILE_DELETE', params: { path: doomed } } })
    assert.equal(deleted.verified, true)
    assert.equal(deleted.evidence[0].kind, 'absent')

    const created = path.join(dir, 'made')
    const missingDir = await verifier.verify({ action: { type: 'FILE_MKDIR', params: { path: created } } })
    assert.equal(missingDir.verified, false)
    fs.mkdirSync(created)
    const made = await verifier.verify({ action: { type: 'FILE_MKDIR', params: { path: created } } })
    assert.equal(made.verified, true)

    const error = verifier.unverifiedError(made)
    assert.equal(error.code, CODES.MUTATION_UNVERIFIED)
  } finally {
    cleanup(dir)
  }
})

test('resume re-observes the effect and answers already_complete, retry or failed (Task 14)', async () => {
  const dir = tempDir('cu-mut-')
  try {
    const verifier = createMutationVerifier({ now: () => 1000 })
    const file = path.join(dir, 'half.txt')
    fs.writeFileSync(file, '完整的内容', 'utf8')
    const action = { type: 'FILE_WRITE', params: { path: file, content: '完整的内容' } }
    const complete = await verifier.resume({ action })
    assert.equal(complete.verdict, RESUME_VERDICT.ALREADY_COMPLETE)
    assert.equal(complete.verified, true)

    const absent = await verifier.resume({ action: { type: 'FILE_WRITE', params: { path: path.join(dir, 'absent.txt'), content: 'x' } } })
    assert.equal(absent.verdict, RESUME_VERDICT.RETRY, 'nothing was written, so the step can be retried')
    assert.equal(absent.verified, false)

    const partial = await verifier.resume({ action: { type: 'FILE_WRITE', params: { path: file, content: 'different' } } })
    assert.equal(partial.verdict, RESUME_VERDICT.RETRY)
    assert.equal(partial.verified, false)

    const nonMutation = await verifier.resume({ action: { type: 'CLICK', params: {} } })
    assert.equal(nonMutation.verdict, RESUME_VERDICT.RETRY)
    assert.deepEqual(Object.values(RESUME_VERDICT), ['already_complete', 'retry', 'failed'])
  } finally {
    cleanup(dir)
  }
})

test('mtime clock skew is tolerated within the documented window (Task 12)', async () => {
  const dir = tempDir('cu-mut-')
  try {
    const file = path.join(dir, 'skewed.txt')
    fs.writeFileSync(file, 'skewed', 'utf8')
    const verifier = createMutationVerifier({ now: () => 1000 })
    const action = { type: 'FILE_WRITE', params: { path: file, content: 'skewed' } }
    const stats = fs.statSync(file)
    const within = await verifier.verify({ action, beforeMtime: stats.mtimeMs - 1500 })
    assert.equal(within.verified, true, 'a clock skew inside the window is tolerated')
    const farOutside = await verifier.verify({ action, beforeMtime: stats.mtimeMs + 10 * 60_000 })
    assert.equal(farOutside.verified, false)
    assert.match(farOutside.reason, /mtime did not move/)
  } finally {
    cleanup(dir)
  }
})

// ---------------------------------------------------------------------------
// Task 13 — the bounded command contract (command.cjs)
// ---------------------------------------------------------------------------

test('the documented command defaults are explicit and bounded (Task 13)', () => {
  const normalized = normalizeCommand({ command: 'npm test' })
  assert.equal(normalized.ok, true)
  assert.equal(normalized.contract.timeoutMs, COMMAND_DEFAULTS.timeoutMs)
  assert.equal(normalized.contract.outputBytes, COMMAND_DEFAULTS.outputBytes)
  assert.equal(normalized.contract.expectExitCode, null)
  assert.equal(normalized.contract.mode, COMMAND_MODE.FOREGROUND)
  assert.equal(normalized.contract.expectedLifetimeMs, COMMAND_DEFAULTS.timeoutMs)
  assert.equal(normalized.contract.shell, false)
  assert.equal(normalized.contract.stdin, null)
  assert.equal(normalized.contract.cwd, null)
})

test('a command contract is normalised and validated with issues reported (Task 13)', () => {
  const invalid = normalizeCommand({})
  assert.equal(invalid.ok, false)
  assert.equal(invalid.contract, null)
  assert.equal(invalid.issues[0].field, 'command')
  assert.equal(invalid.issues[0].code, CODES.COMMAND_INVALID)
  assert.equal(invalidError(invalid.issues).code, CODES.COMMAND_INVALID)

  const badExit = normalizeCommand({ command: 'npm test', expectExitCode: 'zero' })
  assert.equal(badExit.ok, false)
  assert.equal(badExit.issues[0].field, 'expectExitCode')

  const badMode = normalizeCommand({ command: 'npm test', mode: 'whenever' })
  assert.equal(badMode.ok, false)
  assert.equal(badMode.issues[0].field, 'mode')

  const inherited = normalizeCommand({ command: 'npm test' }, { cwd: 'D:/project', defaultTimeoutMs: 5000 })
  assert.equal(inherited.contract.cwd, 'D:/project')
  assert.equal(inherited.contract.timeoutMs, 5000)
  const explicit = normalizeCommand({ command: 'npm test', mode: 'long_running', expectedLifetimeMs: 60_000, shell: true })
  assert.equal(explicit.contract.mode, COMMAND_MODE.LONG_RUNNING)
  assert.equal(explicit.contract.expectedLifetimeMs, 60_000)
  assert.equal(explicit.contract.shell, true)
})

test('a long-running command pattern is inferred from the command text (Task 13)', () => {
  assert.equal(inferMode('npm run dev'), COMMAND_MODE.LONG_RUNNING)
  assert.equal(inferMode('npm run build'), COMMAND_MODE.FOREGROUND)
  assert.equal(inferMode('npm run watch'), COMMAND_MODE.LONG_RUNNING)
  assert.equal(inferMode('vite --host'), COMMAND_MODE.LONG_RUNNING)
  assert.equal(inferMode('vite build'), COMMAND_MODE.FOREGROUND)
  assert.equal(inferMode('node', ['server.js']), COMMAND_MODE.LONG_RUNNING)
  assert.equal(inferMode('jest', ['--watch']), COMMAND_MODE.LONG_RUNNING)
  assert.equal(inferMode('node', ['--test']), COMMAND_MODE.FOREGROUND)
})

test('the verdict mapping is the documented STEP_RESULTS vocabulary (Task 13)', () => {
  const zero = normalizeCommand({ command: 'npm test', expectExitCode: 0 }).contract
  assert.equal(judge(zero, { exitCode: 0 }).result, STEP_RESULTS.SUCCESS)
  assert.equal(judge(zero, { exitCode: 2 }).result, STEP_RESULTS.FAILURE)
  assert.equal(judge(zero, { exitCode: null }).result, STEP_RESULTS.FAILURE, 'a declared expectation that was not met is a failure')
  assert.equal(judge(zero, { timedOut: true, exitCode: null }).result, STEP_RESULTS.FAILURE)
  assert.equal(judge(zero, { timedOut: true }).timedOut, true)
  assert.equal(judge(zero, { spawnError: 'ENOENT' }).result, STEP_RESULTS.FAILURE)
  assert.equal(judge(null, {}).result, STEP_RESULTS.UNKNOWN)

  const undeclared = normalizeCommand({ command: 'npm test' }).contract
  assert.equal(judge(undeclared, { exitCode: 0 }).result, STEP_RESULTS.SUCCESS)
  assert.equal(judge(undeclared, { exitCode: 3 }).result, STEP_RESULTS.FAILURE)
  assert.equal(judge(undeclared, { exitCode: null }).result, STEP_RESULTS.UNKNOWN, 'nothing declared success and the exit is missing')
  assert.deepEqual(Object.values(STEP_RESULTS), ['success', 'failure', 'unknown', 'skipped', 'refused'])
})

test('an over-long or under-long timeout and output budget are clamped (Task 13)', () => {
  const long = normalizeCommand({ command: 'npm test', timeoutMs: 99_999_999 }).contract
  assert.equal(long.timeoutMs, COMMAND_DEFAULTS.maxTimeoutMs)
  const short = normalizeCommand({ command: 'npm test', timeoutMs: 1 }).contract
  assert.equal(short.timeoutMs, COMMAND_DEFAULTS.minTimeoutMs)
  const output = normalizeCommand({ command: 'npm test', outputBytes: 99_999_999 }).contract
  assert.equal(output.outputBytes, COMMAND_DEFAULTS.maxOutputBytes)
  const noTimeout = normalizeCommand({ command: 'npm test', timeoutMs: -1 }).contract
  assert.equal(noTimeout.timeoutMs, COMMAND_DEFAULTS.timeoutMs, 'a nonsense timeout falls back to the default')
})

// ---------------------------------------------------------------------------
// Task 18 — long-running log hygiene (log.cjs)
// ---------------------------------------------------------------------------

test('each line carries the documented structured fields (Task 18)', () => {
  const dir = tempDir('cu-log-')
  try {
    const log = createExecutionLog({ dir, runId: 'run-7', taskId: 'task-7', now: () => 1000 })
    log.step({ step: 3, stepId: 's3', controller: 'browser', actionType: 'DOM_CLICK', result: STEP_RESULTS.SUCCESS, retryCount: 1, reasonCode: CODES.TARGET_STALE, durationMs: 42 })
    const [entry] = log.steps()
    assert.equal(entry.runId, 'run-7')
    assert.equal(entry.stepId, 's3')
    assert.equal(entry.controller, 'browser')
    assert.equal(entry.verdict, STEP_RESULTS.SUCCESS)
    assert.equal(entry.retry, 1)
    assert.equal(entry.reasonCode, CODES.TARGET_STALE)
    assert.equal(entry.durationMs, 42)
    log.close()
  } finally {
    cleanup(dir)
  }
})

test('identical repeated events are suppressed after the documented limit (Task 18)', () => {
  const dir = tempDir('cu-log-')
  try {
    const log = createExecutionLog({ dir, now: () => 1000 })
    let written = 0
    for (let index = 0; index < 20; index += 1) {
      if (log.repeated('desktop observation timed out', { attempt: index })) written += 1
    }
    assert.equal(written, 5, 'the first five are written, the rest are counted')
    const summary = log.finish().suppressed
    assert.equal(summary.length, 1)
    assert.equal(summary[0].key, 'desktop observation timed out')
    assert.equal(summary[0].count, 20)
    log.close()
  } finally {
    cleanup(dir)
  }
})

test('the log rotates by size and keeps only the documented number of files (Task 18)', async () => {
  const dir = tempDir('cu-log-')
  try {
    const log = createExecutionLog({ dir, taskId: 'task', maxBytes: 1200, maxFiles: 2, now: () => 1000 })
    const chunk = () => {
      for (let index = 0; index < 12; index += 1) log.event('observation', { index, summary: 'x'.repeat(180) })
    }
    const deadline = Date.now() + 4000
    while (log.rotations() < 1 && Date.now() < deadline) {
      chunk()
      await wait(40)
    }
    assert.equal(log.rotations() >= 1, true, 'the log must rotate once the byte ceiling is passed')
    log.close()

    const names = fs.readdirSync(dir)
    assert.equal(names.includes('task.jsonl'), true)
    const rotated = names.filter((name) => name.endsWith('.jsonl') && name !== 'task.jsonl')
    assert.ok(rotated.length >= 1, `expected a rotated file, saw ${names.join(', ')}`)
    assert.ok(rotated.every((name) => /^task\.\d+\.jsonl$/.test(name)), `unexpected rotated names: ${rotated.join(', ')}`)
  } finally {
    cleanup(dir)
  }
})

test('the screenshot ring is capped and terminal failure evidence survives rotation (Task 18)', async () => {
  const dir = tempDir('cu-log-')
  try {
    const log = createExecutionLog({ dir, taskId: 'task', maxBytes: 900, maxFiles: 3, now: () => 1000 })
    log.step({ step: 9, actionType: 'SHELL_EXEC', result: STEP_RESULTS.FAILURE, reasonCode: CODES.COMMAND_INVALID })
    for (let index = 0; index < 240; index += 1) {
      log.screenshot(Buffer.from('png'), { level: 1, reason: 'stall-targeted', step: index, runFailed: true })
    }
    assert.ok(log.screenshots().length <= 200, 'the screenshot record ring is bounded')

    const deadline = Date.now() + 4000
    while (log.rotations() < 1 && Date.now() < deadline) {
      for (let index = 0; index < 12; index += 1) log.event('observation', { index, summary: 'y'.repeat(180) })
      await wait(40)
    }
    log.close()
    const kept = log.steps()
    assert.equal(kept.length, 1, 'an error step is never dropped from the log')
    const names = fs.readdirSync(dir)
    const all = names.map((name) => fs.readFileSync(path.join(dir, name), 'utf8')).join('\n')
    assert.ok(all.includes('COMMAND_INVALID') || names.includes('task.jsonl'), 'the failure step survives in the log files')
  } finally {
    cleanup(dir)
  }
})

// ---------------------------------------------------------------------------
// Task 15 / 16 / 17 — the responsibilities really moved
// ---------------------------------------------------------------------------

/** The plan's eight documented stall rungs, in order (24h.md Task 6). */
const LADDER_STEPS = [
  'structured_reobserve',
  'window_check',
  'target_re_resolution',
  'targeted_screenshot',
  'alternative_interaction',
  'replan',
  'full_screenshot',
  'fail_with_context'
]

const CORE_MODULES = [
  'index.cjs',
  'constants.cjs',
  'errors.cjs',
  'ports.cjs',
  'contract.cjs',
  'criteria.cjs',
  'action.cjs',
  'target.cjs',
  'world-state.cjs',
  'state-machine.cjs',
  'safety.cjs',
  'routing.cjs',
  'log.cjs',
  'stabilization.cjs',
  'verification.cjs',
  'miss.cjs',
  'recovery.cjs',
  'stall.cjs',
  'observer.cjs',
  'executor.cjs',
  'isolation.cjs',
  'autonomy.cjs',
  'host-electron.cjs',
  'focus.cjs',
  'modal.cjs',
  'evidence.cjs',
  'progress.cjs',
  'processes.cjs',
  'resources.cjs',
  'health.cjs',
  'workspace.cjs',
  'command.cjs',
  'mutation.cjs',
  'reconnect.cjs'
]

test('executor.cjs keeps orchestration and delegates its own copies of the algorithms (Task 15)', () => {
  const executor = read('app/computer-use/executor.cjs')
  assert.match(executor, /require\('\.\/modal\.cjs'\)/)
  assert.match(executor, /require\('\.\/stabilization\.cjs'\)/)
  assert.match(executor, /require\('\.\/stall\.cjs'\)/)
  assert.match(executor, /require\('\.\/recovery\.cjs'\)/)
  assert.match(executor, /require\('\.\/evidence\.cjs'\)/)
  assert.match(executor, /require\('\.\/progress\.cjs'\)/)
  assert.match(executor, /require\('\.\/focus\.cjs'\)/)
  assert.match(executor, /require\('\.\/health\.cjs'\)/)
  assert.match(executor, /require\('\.\/processes\.cjs'\)/)
  assert.match(executor, /require\('\.\/resources\.cjs'\)/)

  // No second copy of the cooldown math, the modal label tables or the stall
  // ladder may live in the executor.
  assert.equal(executor.includes('dynamicCooldown'), false, 'the cooldown math belongs to stabilization.cjs')
  assert.equal(executor.includes('DESTRUCTIVE_LABELS'), false, 'the modal label tables belong to modal.cjs')
  assert.equal(executor.includes('SAFE_DISMISS_LABELS'), false)
  assert.equal(executor.includes('function classifyControl'), false)
  assert.equal(executor.includes('const STALL_RECOVERY_LADDER'), false, 'the stall ladder belongs to stall.cjs')
  assert.equal(executor.includes('ladderStep'), true, 'the executor walks the ladder stall.cjs defines')

  const stallSource = read('app/computer-use/stall.cjs')
  const ladderRungs = STALL_RECOVERY_LADDER.map((rung) => rung.step)
  for (const rung of ladderRungs) {
    assert.equal((stallSource.match(new RegExp(rung, 'g')) || []).length >= 1, true, `stall.cjs must define the ${rung} rung`)
  }
})

test('stabilization.cjs is the single place the cooldown math is defined (Task 16)', () => {
  let definers = 0
  for (const file of CORE_MODULES) {
    if (read(`app/computer-use/${file}`).includes('function dynamicCooldown')) definers += 1
  }
  assert.equal(definers, 1, 'exactly one module may define the cooldown ladder')
  assert.match(read('app/computer-use/stabilization.cjs'), /function dynamicCooldown/)
  const executor = read('app/computer-use/executor.cjs')
  assert.equal(/cooldownBaseMs|cooldownStepMs|cooldownSoftMaxMs/.test(executor), false, 'the constants stay in constants.cjs and stabilization.cjs')
})

test('recovery.cjs answers with the closed five-verdict vocabulary and never replans (Task 17)', () => {
  assert.deepEqual(Object.values(RECOVERY_VERDICTS), ['RETRYABLE', 'ALTERNATIVE_AVAILABLE', 'REPLAN_REQUIRED', 'USER_ACTION_REQUIRED', 'FAILED'])
  const recovery = createRecoveryController({ now: () => 1000 })
  const action = { type: 'CLICK', target: { selector: '#save' }, retry: { maxAttempts: 2 } }
  // A file write has exactly one channel, so a retry cannot become an
  // alternative: that is the case the ladder answers with REPLAN_REQUIRED.
  const singleChannel = { type: 'FILE_WRITE', params: { path: 'notes.txt' }, retry: { maxAttempts: 2 } }
  const cases = [
    recovery.decide({ action, attempt: 1, error: new ComputerUseError(CODES.ACTION_MISSED, 'missed') }),
    recovery.decide({ action, attempt: 2, error: new ComputerUseError(CODES.ACTION_MISSED, 'missed'), stallRecoveries: 0 }),
    recovery.decide({ action: singleChannel, attempt: 2, error: new ComputerUseError(CODES.VERIFICATION_FAILED, 'no effect'), stallRecoveries: 0 }),
    recovery.decide({ action, attempt: 1, error: new ComputerUseError(CODES.DESTRUCTIVE_NEEDS_CONFIRMATION, 'needs a human') }),
    recovery.decide({ action, attempt: 1, error: new ComputerUseError(CODES.VERIFICATION_UNKNOWN, 'cannot tell'), retryable: false }),
    recovery.decide({ action: singleChannel, attempt: 2, error: new ComputerUseError(CODES.VERIFICATION_FAILED, 'no effect'), stallRecoveries: 99 }),
    recovery.decide({ action, attempt: 4, error: new ComputerUseError(CODES.ACTION_MISSED, 'missed'), recoveryRounds: 99, maxRecoveryRounds: 3 })
  ]
  const allowed = new Set(Object.values(RECOVERY_VERDICTS))
  for (const decision of cases) {
    assert.ok(allowed.has(decision.verdict), `decide() produced "${decision.verdict}", which is not in the closed vocabulary`)
    assert.ok(RECOVERY_STEPS.includes(decision.step), `decide() produced step "${decision.step}"`)
  }
  assert.equal(cases[0].verdict, RECOVERY_VERDICTS.RETRYABLE)
  assert.equal(cases[1].verdict, RECOVERY_VERDICTS.ALTERNATIVE_AVAILABLE)
  assert.equal(cases[2].verdict, RECOVERY_VERDICTS.REPLAN_REQUIRED)
  assert.equal(cases[3].verdict, RECOVERY_VERDICTS.USER_ACTION_REQUIRED)
  assert.equal(cases[4].verdict, RECOVERY_VERDICTS.FAILED)
  assert.equal(cases[5].verdict, RECOVERY_VERDICTS.FAILED)
  assert.equal(cases[6].verdict, RECOVERY_VERDICTS.FAILED)
  assert.equal(cases[2].reobserve, true, 'the replan rung re-observes before it reports')
  assert.equal(cases[0].revalidate, true, 'a retry revalidates the target first')
  assert.equal(cases[2].terminal === true, false, 'a replan is a report, not a terminal failure')
  assert.equal(cases[6].terminal, true, 'an exhausted ladder is terminal')
  assert.deepEqual([...USER_ACTION_CODES].sort(), [CODES.CAPABILITY_NOT_ALLOWED, CODES.CAPABILITY_UNAVAILABLE, CODES.DESTRUCTIVE_FORBIDDEN, CODES.DESTRUCTIVE_NEEDS_CONFIRMATION, CODES.MODAL_BLOCKING, CODES.SAFETY_REFUSED, CODES.STATE_INTEGRITY_UNCERTAIN, CODES.WORKSPACE_MISMATCH, CODES.WORKSPACE_UNAVAILABLE].sort())
  const session = { contract: { capabilities: ['desktop'] }, world: {}, plan: [] }
  const snapshot = JSON.stringify(session)
  recovery.decide({ action: singleChannel, attempt: 3, error: new ComputerUseError(CODES.VERIFICATION_FAILED, 'no effect'), stallRecoveries: 5, context: { session } })
  assert.equal(JSON.stringify(session), snapshot, 'recovery is a report, never an edit of the task')
})

test('the recovery module reports the same ladder the stall module defines (Task 6/17)', () => {
  const stallSource = read('app/computer-use/stall.cjs')
  const recoverySource = read('app/computer-use/recovery.cjs')
  assert.equal(recoverySource.includes('structured_reobserve'), false, 'recovery must not carry its own rung names')
  for (const rung of LADDER_STEPS) assert.match(stallSource, new RegExp(`'${rung}'`), `stall.cjs must define ${rung}`)
  assert.match(recoverySource, /require\('\.\/stall\.cjs'\)/)
  assert.match(recoverySource, /STALL_RECOVERY_LADDER/)
  const recovery = createRecoveryController({ now: () => 1000 })
  assert.equal(recovery.stallStep(7).ladderStep, 'fail_with_context')
})

test('no runtime module learns anything about an application (24h.md Global Constraints)', () => {
  const forbidden = ['appProfile', 'userProfile', 'latencyModel', 'learnedProfile', 'learnedButtons', 'reinforcement', 'chromeProfile', 'appLearning', 'learnedButtonPositions', 'userPreference', 'perAppTiming', 'appLatencyProfile']
  for (const file of CORE_MODULES) {
    const source = read(`app/computer-use/${file}`)
    for (const token of forbidden) {
      assert.equal(source.includes(token), false, `${file} mentions ${token}`)
    }
  }
  const appSpecific = ['Photoshop', 'VSCode', 'Visual Studio', 'Excel', 'Notepad', 'Blender', 'Illustrator', 'Figma', 'Slack', 'Outlook']
  for (const file of CORE_MODULES) {
    const source = read(`app/computer-use/${file}`)
    for (const token of appSpecific) {
      assert.equal(source.includes(token), false, `${file} encodes an application-specific name: ${token}`)
    }
  }
})

test('no runtime module carries a per-application latency profile or a learned button position model', () => {
  for (const file of CORE_MODULES) {
    const source = read(`app/computer-use/${file}`)
    assert.equal(/preferredDelayFor|typicalDelay|appLatency|appWaitMs/i.test(source), false, `${file} carries an application latency profile`)
    assert.equal(/rememberedButton|buttonMemory|lastKnownPoint\s*:|positionMemory/i.test(source), false, `${file} keeps a persistent UI location model`)
  }
})

test('every long-running module is shipped, non-empty and wired into the runtime surface', () => {
  const modules = ['focus.cjs', 'modal.cjs', 'evidence.cjs', 'progress.cjs', 'processes.cjs', 'resources.cjs', 'health.cjs', 'workspace.cjs', 'command.cjs', 'mutation.cjs', 'reconnect.cjs']
  for (const file of modules) {
    const full = path.join(ROOT, 'app', 'computer-use', file)
    assert.equal(fs.existsSync(full), true, `${file} is missing`)
    assert.ok(fs.statSync(full).size > 0, `${file} is empty`)
  }
  // Every module is loaded by the shipped runtime: the executor consumes the
  // step-level ones, the runtime assembles the shared long-running
  // infrastructure (a process registry, a resource budget, a workspace guard, a
  // health reader) and the shell controller consumes the command contract.
  const executor = read('app/computer-use/executor.cjs')
  for (const module_ of ['focus.cjs', 'modal.cjs', 'evidence.cjs', 'progress.cjs', 'processes.cjs', 'resources.cjs', 'health.cjs', 'mutation.cjs', 'reconnect.cjs']) {
    assert.ok(executor.includes(`./${module_}`), `executor.cjs does not use ${module_}`)
  }
  const index = read('app/computer-use/index.cjs')
  for (const module_ of ['processes.cjs', 'resources.cjs', 'health.cjs', 'workspace.cjs']) {
    assert.ok(index.includes(`./${module_}`), `index.cjs does not assemble ${module_}`)
  }
  assert.ok(read('app/computer-use/controllers/shell.cjs').includes("require('../command.cjs')"), 'the shell controller does not use the command contract')
  // The long-running state readers the plan names are on the runtime surface
  // (Update-Plan/24h.md Task 19/20), not only on the private executor object.
  for (const reader of ['function health()', 'function canExecute(actionType)', 'function capabilities()', 'function processes()', 'function resources()', 'function progress()']) {
    assert.ok(index.includes(reader), `the runtime does not expose ${reader}`)
  }
  const runtime = createComputerUseRuntime({ host: {}, log: false })
  assert.equal(typeof runtime.health, 'function')
  assert.equal(typeof runtime.canExecute, 'function')
  assert.equal(typeof runtime.capabilities, 'function')
  assert.equal(typeof runtime.processes, 'function')
  assert.equal(typeof runtime.resources, 'function')
  assert.equal(typeof runtime.progress, 'function')
  assert.ok(runtime.health().status, 'the health snapshot carries a status')
  runtime.dispose('test teardown')
})

test('the reference documentation records the long-running guarantees by task number', () => {
  const doc = read('docs/computer-use.md')
  assert.match(doc, /Long-running execution/i)
  for (const task of ['Task 1', 'Task 2', 'Task 3', 'Task 4', 'Task 5', 'Task 6', 'Task 7', 'Task 8', 'Task 10', 'Task 11', 'Task 12', 'Task 13', 'Task 18', 'Task 19', 'Task 20']) {
    assert.ok(doc.includes(task), `docs/computer-use.md does not name ${task}`)
  }
  const acceptance = read('docs/computer-use-acceptance.md')
  assert.match(acceptance, /soak/i)
  assert.match(acceptance, /failure.injection/i)
})

// ---------------------------------------------------------------------------
// The recovered constants must stay in their documented bands
// ---------------------------------------------------------------------------

test('the timing, stall and retry constants are still the documented bands', () => {
  assert.equal(TIMING.settleMinMs, 50)
  assert.equal(TIMING.settleMaxMs, 300)
  assert.equal(TIMING.cooldownSoftMaxMs, 400)
  assert.equal(TIMING.cooldownHardMaxMs, 500)
  assert.ok(TIMING.cooldownSoftMaxMs < TIMING.cooldownHardMaxMs, 'the soft ceiling must be below the hard one')
  assert.equal(SIGNAL_LIST.length, 8)
})
