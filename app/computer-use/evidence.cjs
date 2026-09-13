'use strict'

/**
 * Computer Use Runtime: verification evidence grading.
 *
 * `verification.cjs` answers *what happened* (success / failure / unknown).
 * This module answers the second question a long-running executor has to ask:
 *
 *   is that answer strong enough to carry an action of THIS risk?
 *
 * Short tasks can get away with "something changed, assume it worked". A task
 * that runs for hours cannot: one false positive is multiplied by every step that
 * follows it, and the workspace ends up somewhere nobody intended. So evidence is
 * graded, and the grade has to clear the bar the action's own risk sets.
 *
 *   strong   a direct, specific, falsifiable observation of the intended effect
 *   medium   a specific observation of the target's own state or the navigation
 *   weak     "the world changed somewhere" — real evidence, but not of *this*
 *
 * The bar:
 *
 *   low        weak evidence is enough (a hover, a scroll, opening a menu)
 *   standard   medium evidence is required (a click that should change a control)
 *   high       strong evidence is required (saving, submitting, sending)
 *   critical   strong evidence *and* an explicit expected effect is required
 *              (delete, publish, install, purchase)
 *
 * "Critical demands an explicit expected effect" is deliberate: an action that
 * can destroy or publish something must say what success looks like before it
 * runs, otherwise nothing can distinguish success from a silent no-op.
 *
 * Nothing here is learned. The grade depends only on the action in front of it:
 * no profiles, no application learning.
 */

const { VERIFICATION_KINDS, DESTRUCTIVE_KINDS } = require('./constants.cjs')

/** Evidence grades, weakest first. */
const GRADES = Object.freeze({ WEAK: 'weak', MEDIUM: 'medium', STRONG: 'strong' })

/** The grade order, so a comparison is one index lookup instead of a table. */
const GRADE_ORDER = Object.freeze([GRADES.WEAK, GRADES.MEDIUM, GRADES.STRONG])

/** How much evidence an action's risk demands. */
const RISK = Object.freeze({ LOW: 'low', STANDARD: 'standard', HIGH: 'high', CRITICAL: 'critical' })

const RISK_ORDER = Object.freeze([RISK.LOW, RISK.STANDARD, RISK.HIGH, RISK.CRITICAL])

/** The evidence bar for each risk level. */
const RISK_BAR = Object.freeze({
  [RISK.LOW]: GRADES.WEAK,
  [RISK.STANDARD]: GRADES.MEDIUM,
  [RISK.HIGH]: GRADES.STRONG,
  [RISK.CRITICAL]: GRADES.STRONG
})

/**
 * Actions whose *whole purpose* is a side effect that must not be assumed: these
 * are the ones the plan names explicitly (TYPE / SAVE / DELETE / SEND / SUBMIT /
 * PUBLISH) plus their file and shell equivalents.
 */
const HIGH_RISK_ACTIONS = Object.freeze([
  'TYPE',
  'DOM_TYPE',
  'ACCESSIBILITY_SET_VALUE',
  'KEY_PRESS',
  'HOTKEY',
  'FILE_WRITE',
  'FILE_MOVE',
  'FILE_COPY',
  'FILE_DELETE',
  'FILE_MKDIR',
  'SHELL_EXEC',
  'BROWSER_NAVIGATE',
  'OPEN_APP',
  'CLOSE_WINDOW',
  'ACCESSIBILITY_INVOKE'
])

/** Actions that only move the pointer, the viewport or the focus. */
const LOW_RISK_ACTIONS = Object.freeze(['MOVE', 'SCROLL', 'FOCUS', 'SWITCH_WINDOW', 'WAIT_EVENT', 'WAIT_STATE', 'FILE_EXISTS', 'FILE_READ',
  'SCREENSHOT_REGION', 'SCREENSHOT_WINDOW', 'SCREENSHOT_FULL'])

/** Words that mark an action as touching something destructive or public. */
const CRITICAL_KEYWORDS = Object.freeze([
  /(^|[^a-z])(delete|remove|erase|unlink|rmdir|purge|destroy)([^a-z]|$)/i,
  /(^|[^a-z])(publish|deploy|release|upload|push|submit|send|post|share)([^a-z]|$)/i,
  /(^|[^a-z])(install|uninstall|upgrade|downgrade)([^a-z]|$)/i,
  /(^|[^a-z])(purchase|buy|pay|checkout|subscribe)([^a-z]|$)/i,
  /(^|[^a-z])(overwrite|replace|force)([^a-z]|$)/i
])

/**
 * Verification kinds that are *specific*: they observe the thing the action was
 * supposed to change, rather than "the world is different now".
 */
const STRONG_KINDS = Object.freeze([
  VERIFICATION_KINDS.FILE,
  VERIFICATION_KINDS.PROCESS,
  VERIFICATION_KINDS.NAVIGATION
])

/** Specific but indirect: the target's own state, or a focused element. */
const MEDIUM_KINDS = Object.freeze([VERIFICATION_KINDS.STATE, VERIFICATION_KINDS.FOCUS, VERIFICATION_KINDS.VISUAL])

/**
 * Classify the risk of one action.
 *
 * The *declared* destructive kinds win: an action the safety layer already
 * classified as DELETE/PUBLISH/INSTALL is critical whatever its type is called.
 * Otherwise the action type decides, and a destructive-sounding description or
 * target name can only raise the risk, never lower it.
 *
 * @param {object} action
 * @returns {{risk: string, reasons: string[]}}
 */
function classifyRisk(action) {
  if (!action) return { risk: RISK.STANDARD, reasons: ['no action given'] }
  const reasons = []
  // A dialog dismissal is a *safe* action by construction: `modal.cjs` only ever
  // produces one after classifying the control as non-destructive. Its own
  // description quotes the dialog it is answering (which may well name a
  // destructive effect), so it must not inherit that risk.
  if (action.params && action.params.__modalDismiss) {
    return { risk: RISK.LOW, reasons: ['dismissing a dialog changes nothing outside the dialog'] }
  }
  const declared = Array.isArray(action.destructive) ? action.destructive.filter((kind) => DESTRUCTIVE_KINDS.includes(kind)) : []
  if (action.destructive === true) reasons.push('the action declares itself destructive')
  const haystack = `${action.description || ''} ${describeTargetName(action.target)}`.trim()
  const keywordHit = CRITICAL_KEYWORDS.find((pattern) => pattern.test(haystack))
  if (keywordHit) reasons.push(`the action text names a destructive or public effect ("${keywordHit.source}")`)
  if (declared.length || action.destructive === true || keywordHit) {
    if (declared.length) reasons.push(`declared destructive kind(s): ${declared.join(', ')}`)
    return { risk: RISK.CRITICAL, reasons }
  }

  const type = String(action.type || '')
  const capability = String(action.capability || '')
  if (LOW_RISK_ACTIONS.includes(type)) return { risk: RISK.LOW, reasons: reasons.concat('the action only moves the pointer, the view or the focus') }
  if (HIGH_RISK_ACTIONS.includes(type)) return { risk: RISK.HIGH, reasons: reasons.concat(`${type} has a side effect that must not be assumed`) }
  if (capability === 'desktop' || capability === 'browser') return { risk: RISK.STANDARD, reasons: reasons.concat(`${type} is an interactive ${capability} action`) }
  return { risk: RISK.STANDARD, reasons }
}

function describeTargetName(target) {
  if (!target) return ''
  const parts = []
  if (target.selector) parts.push(target.selector)
  if (target.text) parts.push(target.text)
  if (target.semantic && target.semantic.text) parts.push(target.semantic.text)
  if (target.accessibility && target.accessibility.name) parts.push(target.accessibility.name)
  if (target.window && target.window.title) parts.push(target.window.title)
  if (target.path) parts.push(target.path)
  return parts.join(' ')
}

/**
 * Grade one verification result.
 *
 * @param {object} input
 * @param {object} input.verification the verifier's `{verdict, kind, evidence}`
 * @param {object} [input.action]
 * @param {boolean} [input.declaredEffect] did the action declare an expected effect?
 * @returns {{grade:string, specific:boolean, reasons:string[]}}
 */
function gradeEvidence(input = {}) {
  const verification = input.verification || {}
  const evidence = Array.isArray(verification.evidence) ? verification.evidence : []
  const action = input.action || null
  const reasons = []

  if (verification.verdict !== 'success') {
    return { grade: GRADES.WEAK, specific: false, reasons: ['no successful verification to grade'] }
  }

  // An evidence entry may carry its own strength (a controller can be explicit
  // about how directly it observed the effect). The strongest entry wins.
  const declared = evidence.map((entry) => (entry && entry.strength ? String(entry.strength) : null)).filter(Boolean)
  if (declared.length && declared.every((strength) => GRADE_ORDER.includes(strength))) {
    const best = declared.reduce((acc, strength) => (GRADE_ORDER.indexOf(strength) > GRADE_ORDER.indexOf(acc) ? strength : acc), GRADES.WEAK)
    return { grade: best, specific: best !== GRADES.WEAK, reasons: reasons.concat(`the evidence entry declared its own strength: ${best}`) }
  }

  const kind = String(verification.kind || VERIFICATION_KINDS.NONE)
  if (STRONG_KINDS.includes(kind)) {
    reasons.push(`${kind} verification observed the effect itself (a file, a process exit, a navigation)`)
    return { grade: GRADES.STRONG, specific: true, reasons }
  }

  // A declared expected effect that was evaluated and held is specific evidence:
  // "the value is alice", "Saved appeared", "the file exists". That is a strong
  // claim even when the observation channel is the DOM.
  const declaredEffect = input.declaredEffect === undefined ? Boolean(action && action.expectedEffect) : Boolean(input.declaredEffect)
  if (declaredEffect) {
    reasons.push('the action declared an expected effect and it held')
    if (MEDIUM_KINDS.includes(kind) || kind === VERIFICATION_KINDS.DIRECT || kind === VERIFICATION_KINDS.EVENT) {
      return { grade: GRADES.STRONG, specific: true, reasons }
    }
    return { grade: GRADES.MEDIUM, specific: true, reasons }
  }

  if (MEDIUM_KINDS.includes(kind)) {
    reasons.push(`${kind} verification observed the target's own state`)
    return { grade: GRADES.MEDIUM, specific: true, reasons }
  }

  if (kind === VERIFICATION_KINDS.DIRECT || kind === VERIFICATION_KINDS.EVENT) {
    // The implicit "something changed" check. It is real evidence that the action
    // had *an* effect, which is all a low-risk click needs and not enough for
    // anything that writes, sends or deletes — the bar comparison in `assess()`
    // is what decides that, so the grade is `weak` regardless of the risk.
    reasons.push('the effect was inferred from a change in the world, not from the intended state')
    return { grade: GRADES.WEAK, specific: false, reasons }
  }

  reasons.push(`verification kind ${kind} carries no specific observation`)
  return { grade: GRADES.WEAK, specific: false, reasons }
}

/**
 * Is this verification good enough for this action?
 *
 * @returns {{ok:boolean, grade:string, required:string, risk:string, reason:string, reasons:string[]}}
 */
function assess(input = {}) {
  const action = input.action || null
  const classified = classifyRisk(action)
  const graded = gradeEvidence({ verification: input.verification, action, declaredEffect: input.declaredEffect })
  const required = RISK_BAR[classified.risk] || GRADES.MEDIUM
  const verdict = input.verification ? String(input.verification.verdict) : 'unknown'

  if (verdict !== 'success') {
    return {
      ok: false,
      grade: graded.grade,
      required,
      risk: classified.risk,
      reason: `the action was not verified as a success (verdict: ${verdict})`,
      reasons: graded.reasons.concat(classified.reasons)
    }
  }

  // A critical action must have said what success looks like.
  //
  // Dismissing a dialog is exempt, and it is the only exemption: the *dismissal*
  // changes nothing outside the dialog (that is what `modal.cjs` established
  // before choosing the control), while the dialog's own message may name a
  // destructive effect it is asking the user about. Demanding a declared effect
  // for pressing "Cancel" on a "Delete this file?" prompt would leave the runtime
  // unable to answer a dialog without a human.
  const isModalDismissal = Boolean(action && action.params && action.params.__modalDismiss)
  if (classified.risk === RISK.CRITICAL && !isModalDismissal) {
    const declaredEffect = input.declaredEffect === undefined ? Boolean(action && action.expectedEffect) : Boolean(input.declaredEffect)
    if (!declaredEffect) {
      return {
        ok: false,
        grade: graded.grade,
        required,
        risk: classified.risk,
        reason: 'a destructive or publishing action must declare its expected effect before it can be accepted',
        reasons: graded.reasons.concat(classified.reasons)
      }
    }
  }

  const ok = GRADE_ORDER.indexOf(graded.grade) >= GRADE_ORDER.indexOf(required)
  return {
    ok,
    grade: graded.grade,
    required,
    risk: classified.risk,
    reason: ok
      ? `${graded.grade} evidence clears the ${required} bar for a ${classified.risk}-risk action`
      : `${graded.grade} evidence does not clear the ${required} bar for a ${classified.risk}-risk action: treat this as unverified rather than successful`,
    reasons: graded.reasons.concat(classified.reasons)
  }
}

module.exports = {
  GRADES,
  GRADE_ORDER,
  RISK,
  RISK_ORDER,
  RISK_BAR,
  HIGH_RISK_ACTIONS,
  LOW_RISK_ACTIONS,
  classifyRisk,
  gradeEvidence,
  assess
}
