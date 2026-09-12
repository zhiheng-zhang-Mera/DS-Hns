'use strict'

/**
 * Computer Use Runtime: miss detection (plan §17).
 *
 * The distinction this module exists for:
 *
 *   "the action was issued"            ≠  "the action had an effect"
 *
 * A click can land, return success from the OS, and still do nothing: the
 * control moved, an invisible overlay swallowed it, the page was not ready.
 * Miss detection collects the cheap signals the plan lists — no state change, no
 * focus change, no control state change, no expected event, the same visible
 * target, the same active element — and calls it.
 *
 * A detected miss is *not* a task failure (plan §18): it is the trigger for
 * revalidate → retry, and on the second miss for a different interaction.
 */

const { meaningfulChange, evidenceDigest } = require('./world-state.cjs')

const MISS_SIGNALS = Object.freeze([
  'no_state_change',
  'focus_unchanged',
  'control_state_unchanged',
  'expected_event_missing',
  'visual_identical',
  'active_element_unchanged',
  'controller_reported_noop'
])

/**
 * @param {object} input
 * @param {object} input.action the action that was carried out
 * @param {object|null} input.before world state before acting
 * @param {object|null} input.after world state after grace
 * @param {object|null} [input.verification] verdict from the verifier
 * @param {object|null} [input.receipt] controller receipt
 * @param {string|null} [input.visualDigestBefore]
 * @param {string|null} [input.visualDigestAfter]
 */
function detectMiss(input) {
  const { action, before, after, verification, receipt } = input
  const signals = []
  const details = {}

  if (!after) {
    return { missed: false, confidence: 'unknown', signals: ['no_observation'], details: { reason: 'the world state could not be observed after the action' } }
  }

  if (receipt) {
    if (receipt.ok === false && receipt.retryable !== false) signals.push('controller_reported_noop')
    if (receipt.changed === false && receipt.silent === true) signals.push('controller_reported_noop')
    // A controller that explicitly reports "the click was swallowed" is
    // believed: that is what a real browser backend can tell us.
    if (receipt.missed === true) {
      signals.push('controller_reported_noop')
      details.controllerMiss = receipt.detail || true
    }
  }

  const change = meaningfulChange(before, after)
  if (before && !change.changed && !evidenceMoved(before, after)) {
    signals.push('no_state_change')
    details.unchangedFields = change.fields
  }

  if (verification && verification.verdict === 'failure') {
    const evidence = Array.isArray(verification.evidence) ? verification.evidence : []
    if (evidence.some((entry) => entry && entry.kind === 'world-change' && entry.ok === false)) {
      if (!signals.includes('no_state_change')) signals.push('no_state_change')
    }
    if (evidence.some((entry) => entry && entry.verificationKind === 'event' && entry.ok === false)) signals.push('expected_event_missing')
    if (evidence.some((entry) => entry && entry.verificationKind === 'focus' && entry.ok === false)) signals.push('focus_unchanged')
    if (evidence.some((entry) => entry && entry.verificationKind === 'state' && entry.ok === false)) signals.push('control_state_unchanged')
  }

  if (before && after && isFocusAction(action) && before.focusedRef === after.focusedRef) signals.push('focus_unchanged')
  if (before && after && before.focusedRef && after.focusedRef && before.focusedRef === after.focusedRef && isTypingAction(action)) {
    signals.push('active_element_unchanged')
  }

  if (input.visualDigestBefore && input.visualDigestAfter && input.visualDigestBefore === input.visualDigestAfter) {
    signals.push('visual_identical')
  }

  const unique = [...new Set(signals)]
  // Which signals can carry a miss *on their own*. An identical screenshot is
  // only evidence of a miss when nothing else moved either; a stuck active
  // element is a hint, never a verdict.
  const soft = ['active_element_unchanged']
  const conditional = ['visual_identical']
  const hard = unique.filter((signal) => !soft.includes(signal)
    && (!conditional.includes(signal) || !evidenceMoved(before, after)))
  const missed = hard.length > 0 && (!verification || verification.verdict !== 'success')
  return {
    missed,
    confidence: unique.length === 0 ? 'low' : unique.length === 1 ? 'medium' : 'high',
    signals: unique,
    details
  }
}

function isFocusAction(action) {
  return action && (action.type === 'FOCUS' || action.type === 'SELECT')
}

/**
 * A change in the *evidence* digest (DOM revision, event stream, value) is an
 * effect, even when it is not progress. Keeping the two notions apart is what
 * lets a cosmetic mutation satisfy verification while still counting toward a
 * stall (plan §17 vs §20).
 */
function evidenceMoved(before, after) {
  if (!before || !after) return false
  const first = evidenceDigest(before)
  const second = evidenceDigest(after)
  if (first === null || second === null) return false
  return first !== second
}

function isTypingAction(action) {
  return action && ['TYPE', 'DOM_TYPE', 'ACCESSIBILITY_SET_VALUE', 'KEY_PRESS', 'HOTKEY'].includes(action.type)
}

module.exports = { MISS_SIGNALS, detectMiss }
