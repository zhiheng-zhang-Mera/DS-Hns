'use strict'

/**
 * Computer Use Runtime: typed failures.
 *
 * Every failure carries a stable `code` so the execution log, the recovery
 * ladder and the acceptance harness can reason about *what* failed without
 * parsing English. `retryable` is the executor's only input for "is another
 * attempt worth spending" and `controllerId` is what lets a failure stay inside
 * one controller's fault boundary.
 */

const CODES = Object.freeze({
  // Contract and task intake
  CONTRACT_INVALID: 'CONTRACT_INVALID',
  CONTRACT_GOAL_MISSING: 'CONTRACT_GOAL_MISSING',
  CONTRACT_LIMIT_EXCEEDED: 'CONTRACT_LIMIT_EXCEEDED',
  // Plan selection
  PLAN_EXHAUSTED: 'PLAN_EXHAUSTED',
  PLAN_INVALID: 'PLAN_INVALID',
  // State machine
  STATE_INVALID: 'STATE_INVALID',
  STATE_TRANSITION_INVALID: 'STATE_TRANSITION_INVALID',
  // Target resolution
  TARGET_INVALID: 'TARGET_INVALID',
  TARGET_NOT_FOUND: 'TARGET_NOT_FOUND',
  TARGET_STALE: 'TARGET_STALE',
  TARGET_NOT_ACTIONABLE: 'TARGET_NOT_ACTIONABLE',
  TARGET_AMBIGUOUS: 'TARGET_AMBIGUOUS',
  // Controller availability and fault isolation
  CONTROLLER_UNAVAILABLE: 'CONTROLLER_UNAVAILABLE',
  /**
   * The transport carrying a channel is gone, as opposed to the channel having
   * answered badly. Named here so a caller can tell "the pipe died" from "the
   * action failed" without parsing an English message; the reconnect policy
   * treats exactly this class as worth a bounded reconnect.
   */
  TRANSPORT_LOST: 'CONTROLLER_UNAVAILABLE',
  CONTROLLER_FAILED: 'CONTROLLER_FAILED',
  CONTROLLER_TIMEOUT: 'CONTROLLER_TIMEOUT',
  CAPABILITY_NOT_ALLOWED: 'CAPABILITY_NOT_ALLOWED',
  // A capability the action needs is not available right now. This is distinct
  // from CAPABILITY_NOT_ALLOWED (the contract withheld it) and from
  // CONTROLLER_UNAVAILABLE (the controller is gone): the capability exists and is
  // permitted, but the channel that carries it is degraded.
  CAPABILITY_UNAVAILABLE: 'CAPABILITY_UNAVAILABLE',
  // Action execution
  ACTION_UNSUPPORTED: 'ACTION_UNSUPPORTED',
  ACTION_INVALID: 'ACTION_INVALID',
  ACTION_TIMEOUT: 'ACTION_TIMEOUT',
  // Verification and miss detection
  VERIFICATION_FAILED: 'VERIFICATION_FAILED',
  VERIFICATION_UNKNOWN: 'VERIFICATION_UNKNOWN',
  ACTION_MISSED: 'ACTION_MISSED',
  // Stabilization
  UI_UNSTABLE: 'UI_UNSTABLE',
  WINDOW_MISMATCH: 'WINDOW_MISMATCH',
  FOCUS_MISMATCH: 'FOCUS_MISMATCH',
  // Safety
  SAFETY_REFUSED: 'SAFETY_REFUSED',
  DESTRUCTIVE_FORBIDDEN: 'DESTRUCTIVE_FORBIDDEN',
  DESTRUCTIVE_NEEDS_CONFIRMATION: 'DESTRUCTIVE_NEEDS_CONFIRMATION',
  MODAL_BLOCKING: 'MODAL_BLOCKING',
  /**
   * The same outcome named from the caller's side: a dialog the runtime may not
   * answer by itself. Both names carry the same code so a caller reasoning in
   * terms of "the modal needs a user" and one reasoning in terms of "the modal
   * blocked the step" are reading the same value.
   */
  MODAL_REQUIRES_USER: 'MODAL_BLOCKING',
  // Stalls and bounds
  STALL_DETECTED: 'STALL_DETECTED',
  STEP_LIMIT_REACHED: 'STEP_LIMIT_REACHED',
  RUN_TIMEOUT: 'RUN_TIMEOUT',
  RUN_CANCELLED: 'RUN_CANCELLED',
  // Perception
  OBSERVATION_EMPTY: 'OBSERVATION_EMPTY',
  VISION_UNAVAILABLE: 'VISION_UNAVAILABLE',
  SCREENSHOT_FAILED: 'SCREENSHOT_FAILED',
  // Long-running execution
  //
  // Every one of these is a *bounded, reported* outcome rather than a hang: the
  // runtime either recovers, degrades or stops with evidence.
  WORKSPACE_UNAVAILABLE: 'WORKSPACE_UNAVAILABLE',   // no verified cwd -> BLOCK
  WORKSPACE_MISMATCH: 'WORKSPACE_MISMATCH',         // the cwd drifted out of the workspace
  MUTATION_UNVERIFIED: 'MUTATION_UNVERIFIED',       // the file effect could not be confirmed
  COMMAND_INVALID: 'COMMAND_INVALID',               // a shell action with no bounded contract
  PROCESS_INVALID: 'PROCESS_INVALID',               // a process operation with no handle
  PROCESS_LOST: 'PROCESS_LOST',                     // an owned process disappeared
  RESOURCE_LIMIT: 'RESOURCE_LIMIT',                 // the runtime's own ceiling was reached
  RECONNECT_EXHAUSTED: 'RECONNECT_EXHAUSTED',       // bounded reconnection gave up
  EVIDENCE_INSUFFICIENT: 'EVIDENCE_INSUFFICIENT',   // verified, but not strongly enough
  STATE_INTEGRITY_UNCERTAIN: 'STATE_INTEGRITY_UNCERTAIN' // stop rather than guess
})

class ComputerUseError extends Error {
  /**
   * @param {string} code stable failure code, one of CODES
   * @param {string} message human readable detail (never carries secrets)
   * @param {object} [details] structured context for the log
   */
  constructor(code, message, details = {}) {
    super(message || code)
    this.name = 'ComputerUseError'
    this.code = code
    this.details = details
    this.retryable = details.retryable === undefined ? defaultRetryable(code) : Boolean(details.retryable)
    this.controllerId = details.controllerId || null
    this.state = details.state || null
    if (Error.captureStackTrace) Error.captureStackTrace(this, ComputerUseError)
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      controllerId: this.controllerId,
      state: this.state,
      details: redactDetails(this.details)
    }
  }
}

/**
 * Which failures may be retried without a human. This is intentionally short:
 * a stale target, a missed click, an unstable UI and a timeout are worth one
 * more attempt; a refused capability or a forbidden destructive action is not.
 *
 * The long-running additions follow the same rule: a *transient* condition (a
 * degraded capability, a lost process, a reconnect that was not exhausted) is
 * worth another attempt, while an unverifiable mutation or a drifted workspace is
 * not — retrying those would mean acting on a state the runtime cannot vouch for.
 */
function defaultRetryable(code) {
  switch (code) {
    case CODES.TARGET_STALE:
    case CODES.TARGET_NOT_ACTIONABLE:
    case CODES.ACTION_MISSED:
    case CODES.TRANSPORT_LOST:
    case CODES.VERIFICATION_FAILED:
    case CODES.VERIFICATION_UNKNOWN:
    case CODES.ACTION_TIMEOUT:
    case CODES.CONTROLLER_TIMEOUT:
    case CODES.UI_UNSTABLE:
    case CODES.STALL_DETECTED:
    case CODES.MODAL_BLOCKING:
    case CODES.CAPABILITY_UNAVAILABLE:
    case CODES.PROCESS_LOST:
    case CODES.EVIDENCE_INSUFFICIENT:
      return true
    default:
      return false
  }
}

const SENSITIVE_KEY = /pass(word|phrase)|token|secret|api[-_]?key|credential|authorization|cookie/i

/**
 * Passwords and tokens are never written to the execution log. The
 * redaction is applied to error details as well, because a typed password can
 * easily end up quoted inside a failure message.
 */
function redactDetails(details) {
  if (details === null || details === undefined) return details
  if (Array.isArray(details)) return details.map((item) => redactDetails(item))
  if (typeof details !== 'object') return details
  const out = {}
  for (const [key, value] of Object.entries(details)) {
    if (SENSITIVE_KEY.test(key)) out[key] = '[redacted]'
    else out[key] = redactDetails(value)
  }
  return out
}

function fail(code, message, details) {
  return new ComputerUseError(code, message, details)
}

module.exports = { CODES, ComputerUseError, fail, redactDetails, defaultRetryable }
