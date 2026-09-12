'use strict'

/**
 * Computer Use Runtime: typed failures.
 *
 * Every failure carries a stable `code` so the execution log, the recovery
 * ladder and the acceptance harness can reason about *what* failed without
 * parsing English. `retryable` is the executor's only input for "is another
 * attempt worth spending" (plan §18) and `controllerId` is what lets a failure
 * stay inside one controller's fault boundary (plan §37/§38).
 */

const CODES = Object.freeze({
  // Contract and task intake (plan §35)
  CONTRACT_INVALID: 'CONTRACT_INVALID',
  CONTRACT_GOAL_MISSING: 'CONTRACT_GOAL_MISSING',
  CONTRACT_LIMIT_EXCEEDED: 'CONTRACT_LIMIT_EXCEEDED',
  // Plan selection (plan §52)
  PLAN_EXHAUSTED: 'PLAN_EXHAUSTED',
  PLAN_INVALID: 'PLAN_INVALID',
  // State machine (plan §51/§52)
  STATE_INVALID: 'STATE_INVALID',
  STATE_TRANSITION_INVALID: 'STATE_TRANSITION_INVALID',
  // Target resolution (plan §7/§10)
  TARGET_INVALID: 'TARGET_INVALID',
  TARGET_NOT_FOUND: 'TARGET_NOT_FOUND',
  TARGET_STALE: 'TARGET_STALE',
  TARGET_NOT_ACTIONABLE: 'TARGET_NOT_ACTIONABLE',
  TARGET_AMBIGUOUS: 'TARGET_AMBIGUOUS',
  // Controller availability and fault isolation (plan §37/§38)
  CONTROLLER_UNAVAILABLE: 'CONTROLLER_UNAVAILABLE',
  CONTROLLER_FAILED: 'CONTROLLER_FAILED',
  CONTROLLER_TIMEOUT: 'CONTROLLER_TIMEOUT',
  CAPABILITY_NOT_ALLOWED: 'CAPABILITY_NOT_ALLOWED',
  // Action execution (plan §6/§16)
  ACTION_UNSUPPORTED: 'ACTION_UNSUPPORTED',
  ACTION_INVALID: 'ACTION_INVALID',
  ACTION_TIMEOUT: 'ACTION_TIMEOUT',
  // Verification and miss detection (plan §14/§17)
  VERIFICATION_FAILED: 'VERIFICATION_FAILED',
  VERIFICATION_UNKNOWN: 'VERIFICATION_UNKNOWN',
  ACTION_MISSED: 'ACTION_MISSED',
  // Stabilization (plan §9/§10/§13)
  UI_UNSTABLE: 'UI_UNSTABLE',
  WINDOW_MISMATCH: 'WINDOW_MISMATCH',
  FOCUS_MISMATCH: 'FOCUS_MISMATCH',
  // Safety (plan §30/§31/§33/§34)
  SAFETY_REFUSED: 'SAFETY_REFUSED',
  DESTRUCTIVE_FORBIDDEN: 'DESTRUCTIVE_FORBIDDEN',
  DESTRUCTIVE_NEEDS_CONFIRMATION: 'DESTRUCTIVE_NEEDS_CONFIRMATION',
  MODAL_BLOCKING: 'MODAL_BLOCKING',
  // Stalls and bounds (plan §20/§21)
  STALL_DETECTED: 'STALL_DETECTED',
  STEP_LIMIT_REACHED: 'STEP_LIMIT_REACHED',
  RUN_TIMEOUT: 'RUN_TIMEOUT',
  RUN_CANCELLED: 'RUN_CANCELLED',
  // Perception (plan §3/§4)
  OBSERVATION_EMPTY: 'OBSERVATION_EMPTY',
  VISION_UNAVAILABLE: 'VISION_UNAVAILABLE',
  SCREENSHOT_FAILED: 'SCREENSHOT_FAILED'
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
 */
function defaultRetryable(code) {
  switch (code) {
    case CODES.TARGET_STALE:
    case CODES.TARGET_NOT_ACTIONABLE:
    case CODES.ACTION_MISSED:
    case CODES.VERIFICATION_FAILED:
    case CODES.VERIFICATION_UNKNOWN:
    case CODES.ACTION_TIMEOUT:
    case CODES.CONTROLLER_TIMEOUT:
    case CODES.UI_UNSTABLE:
    case CODES.STALL_DETECTED:
    case CODES.MODAL_BLOCKING:
      return true
    default:
      return false
  }
}

const SENSITIVE_KEY = /pass(word|phrase)|token|secret|api[-_]?key|credential|authorization|cookie/i

/**
 * Plan §32: passwords and tokens are never written to the execution log. The
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
