'use strict'

/**
 * Computer Use Runtime: autonomous continuation (plan §49).
 *
 * "Keep going by yourself until the task is genuinely finished, or until a
 * bounded stop condition is reached — instead of asking a human to press
 * continue after every hiccup."
 *
 * The plan is explicit that this is a *flag wired into the loop*, not a new
 * brain: `autonomyEnabled` decides whether a stopped run is re-issued with the
 * remaining plan, how many continuation rounds are allowed, and which stops are
 * final. Nothing here learns anything about the application (plan §42): the
 * decision uses only the run's own evidence and its remaining budget.
 */

const { CODES } = require('./errors.cjs')

/** Stops that no amount of continuation may override (plan §34/§35). */
const FINAL_CODES = Object.freeze([
  CODES.SAFETY_REFUSED,
  CODES.DESTRUCTIVE_FORBIDDEN,
  CODES.DESTRUCTIVE_NEEDS_CONFIRMATION,
  CODES.CAPABILITY_NOT_ALLOWED,
  CODES.CONTRACT_INVALID,
  CODES.CONTRACT_GOAL_MISSING,
  CODES.RUN_CANCELLED,
  CODES.STEP_LIMIT_REACHED,
  CODES.RUN_TIMEOUT
])

const DEFAULT_LIMITS = Object.freeze({
  maxContinuationRounds: 3,
  maxTotalSteps: 400
})

function createAutonomy(options = {}) {
  const enabled = Boolean(options.enabled)
  const limits = { ...DEFAULT_LIMITS, ...(options.limits || {}) }
  const decisions = []

  /**
   * @param {object} input
   * @param {object} input.report the report of the run that just stopped
   * @param {number} input.round continuation rounds already spent
   * @param {number} input.totalSteps steps spent across all rounds
   */
  function decide(input = {}) {
    const report = input.report || {}
    const round = Number.isInteger(input.round) ? input.round : 0
    const totalSteps = Number.isInteger(input.totalSteps) ? input.totalSteps : 0
    const base = { at: Date.now(), round, status: report.status, code: report.error ? report.error.code : null }

    if (!enabled) {
      return record({ ...base, continue: false, reason: 'autonomous continuation is disabled for this contract' })
    }
    if (report.status === 'completed') {
      return record({ ...base, continue: false, reason: 'the success criteria are satisfied' })
    }
    const code = report.error ? report.error.code : null
    if (code && FINAL_CODES.includes(code)) {
      return record({ ...base, continue: false, reason: `stop condition is final: ${code}` })
    }
    if (round >= limits.maxContinuationRounds) {
      return record({ ...base, continue: false, reason: `continuation budget exhausted (${round}/${limits.maxContinuationRounds} rounds)` })
    }
    if (totalSteps >= limits.maxTotalSteps) {
      return record({ ...base, continue: false, reason: `step budget exhausted (${totalSteps}/${limits.maxTotalSteps} steps)` })
    }
    const progress = hasProgress(report)
    if (!progress) {
      return record({ ...base, continue: false, reason: 'the last round produced no new evidence - continuing would be blind repetition' })
    }
    return record({
      ...base,
      continue: true,
      reason: `continuing with the remaining plan (round ${round + 1}/${limits.maxContinuationRounds})`,
      resume: resumeCursor(report)
    })
  }

  /**
   * Progress means the failed round still produced verified steps or a fresh
   * recovery decision — evidence that the next round starts from a different
   * state than the last one did.
   */
  function hasProgress(report) {
    const outcomes = Array.isArray(report.outcomes) ? report.outcomes : []
    if (outcomes.some((outcome) => outcome && outcome.status === 'success')) return true
    const decisions_ = Array.isArray(report.recoveryDecisions) ? report.recoveryDecisions : []
    if (decisions_.some((decision) => decision && (decision.step === 'alternative_action' || decision.step === 'replan'))) return true
    return false
  }

  /** Where the next round should resume: the plan cursor after the last step. */
  function resumeCursor(report) {
    const outcomes = Array.isArray(report.outcomes) ? report.outcomes : []
    const completedFromPlan = outcomes.filter((outcome) => outcome && outcome.status === 'success' && String(outcome.source || '').startsWith('plan:')).length
    return { completedPlanSteps: completedFromPlan }
  }

  function record(decision) {
    decisions.push(decision)
    return decision
  }

  return {
    enabled,
    limits,
    decide,
    decisions() {
      return decisions.slice()
    }
  }
}

module.exports = { createAutonomy, FINAL_CODES, DEFAULT_LIMITS }
