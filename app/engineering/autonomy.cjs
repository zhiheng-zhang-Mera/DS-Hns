'use strict'

/**
 * Engineering Runtime: autonomy authority.
 *
 * A long episode is supposed to keep going without a human pressing continue. The
 * plan states one rule about *who decides* that, and it is the reason this module
 * exists as a separate thing rather than a boolean threaded through:
 *
 *   runtime default  <  contract override  <  explicit run option
 *
 * The shipped default is `false`, so nothing continues on its own unless somebody
 * said so. A contract that says `autonomy_enabled: true` really does turn it on —
 * that is the bug this fixes: an autonomy controller created once at runtime
 * construction and never re-read can leave a contract's explicit request silently
 * ignored. The effective value is therefore computed *per run* from the three
 * sources, and the result reports which source won so the decision is auditable.
 *
 * Autonomy is bounded from three directions at once: continuation rounds, total
 * steps, and the stop conditions that no continuation may override. It is a
 * continuation flag, never a new planner: what it resumes with is the caller's own
 * remaining plan.
 */

/** Why a decision was made, in the vocabulary the report uses. */
const AUTONOMY_SOURCES = Object.freeze({
  RUNTIME: 'runtime',
  CONTRACT: 'contract',
  RUN_OPTION: 'run-option',
  OPTION: 'option'
})

/** Stops that no amount of continuation may override. */
const FINAL_REASONS = Object.freeze([
  'BLOCKED',
  'CANCELLED',
  'REFUSED',
  'completion is refused',
  'no further repair is available'
])

const DEFAULT_AUTONOMY_LIMITS = Object.freeze({
  maxContinuationRounds: 8,
  maxTotalSteps: 400
})

/**
 * Resolve the effective autonomy for one run.
 *
 * @param {object} input
 * @param {object} [input.runtime] `{ autonomyEnabled }` from the deployment config
 * @param {object} [input.contract] the episode's contract
 * @param {object} [input.runOptions] what the caller passed to `run()`
 * @returns {{enabled:boolean, source:string, requested:object, reason:string}}
 */
function resolveAutonomy(input = {}) {
  const runtime = input.runtime || {}
  const contract = input.contract || {}
  const runOptions = input.runOptions || {}
  const requested = {
    runtime: booleanOrNull(runtime.autonomyEnabled ?? runtime.enabled),
    contract: booleanOrNull(contract.autonomyEnabled ?? contract.autonomy_enabled),
    runOption: booleanOrNull(runOptions.autonomous ?? runOptions.autonomyEnabled)
  }
  // The last *stated* value wins, in the documented order.
  if (requested.runOption !== null) {
    return {
      enabled: requested.runOption,
      source: AUTONOMY_SOURCES.RUN_OPTION,
      requested,
      reason: `the run option ${requested.runOption ? 'enabled' : 'disabled'} autonomy for this run`
    }
  }
  if (requested.contract !== null) {
    return {
      enabled: requested.contract,
      source: AUTONOMY_SOURCES.CONTRACT,
      requested,
      reason: `the contract ${requested.contract ? 'enabled' : 'disabled'} autonomy`
    }
  }
  const fallback = requested.runtime === null ? false : requested.runtime
  return {
    enabled: fallback,
    source: AUTONOMY_SOURCES.RUNTIME,
    requested,
    reason: requested.runtime === null
      ? 'no source stated autonomy, so it stays off'
      : `the deployment default ${requested.runtime ? 'enabled' : 'disabled'} autonomy`
  }
}

function booleanOrNull(value) {
  if (value === undefined || value === null) return null
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase()
    if (text === 'true' || text === '1' || text === 'yes') return true
    if (text === 'false' || text === '0' || text === 'no') return false
    return null
  }
  return Boolean(value)
}

/**
 * A per-run autonomy controller.
 *
 * It is created for one episode and discarded with it: nothing about "how many
 * rounds did this repository need" may survive into the next episode.
 *
 * @param {object} input
 * @param {boolean} input.enabled the *effective* value from `resolveAutonomy`
 * @param {string} [input.source] where that value came from, for the record
 * @param {object} [input.limits] `{ maxContinuationRounds, maxTotalSteps }`
 * @param {Function} [input.now]
 */
function createEngineeringAutonomy(input = {}) {
  const enabled = Boolean(input.enabled)
  const source = input.source || AUTONOMY_SOURCES.RUNTIME
  const limits = { ...DEFAULT_AUTONOMY_LIMITS, ...(input.limits || {}) }
  const now = typeof input.now === 'function' ? input.now : () => Date.now()
  const decisions = []

  function record(decision) {
    decisions.push(decision)
    if (decisions.length > 100) decisions.splice(0, decisions.length - 100)
    return decision
  }

  /**
   * Decide whether a settled episode should continue with its remaining plan.
   *
   * @param {object} report the episode report that just settled
   * @param {object} [context] `{ round, totalSteps }`
   */
  function decide(report = {}, context = {}) {
    const round = Number.isInteger(context.round) ? context.round : 0
    const totalSteps = Number.isInteger(context.totalSteps) ? context.totalSteps : 0
    const base = { at: now(), round, totalSteps, result: report.result, source }
    if (!enabled) {
      return record({ ...base, continue: false, reason: 'autonomy is disabled for this run' })
    }
    if (report.result === 'COMPLETED') {
      // Completion already passed the result validator with fresh evidence: there
      // is nothing left to continue with.
      return record({ ...base, continue: false, reason: 'the episode completed with verified evidence' })
    }
    if (report.result === 'CANCELLED') {
      return record({ ...base, continue: false, reason: 'the caller cancelled the episode' })
    }
    if (report.result === 'BLOCKED') {
      // A blocked episode is missing an external condition; re-running it would
      // produce the same block, which is exactly the blind retry the plan forbids.
      return record({ ...base, continue: false, reason: 'the episode is blocked on an external condition' })
    }
    if (round >= limits.maxContinuationRounds) {
      return record({ ...base, continue: false, reason: `the continuation budget is spent (${round}/${limits.maxContinuationRounds} rounds)` })
    }
    if (totalSteps >= limits.maxTotalSteps) {
      return record({ ...base, continue: false, reason: `the step budget is spent (${totalSteps}/${limits.maxTotalSteps} steps)` })
    }
    const outcome = progressOf(report)
    if (!outcome.progressed) {
      return record({ ...base, continue: false, reason: `the last round produced no new evidence: ${outcome.reason}` })
    }
    return record({
      ...base,
      continue: true,
      reason: `continuing with the remaining plan (round ${round + 1}/${limits.maxContinuationRounds})`,
      resume: outcome.resume
    })
  }

  /**
   * Did the failed episode still move the world forward?
   *
   * Continuing is only honest when the next round starts from a *different* state:
   * a fresh mutation, a passed verification, or a plan step that completed. A round
   * that changed nothing would replay itself forever.
   */
  function progressOf(report = {}) {
    const mutations = report.mutations || null
    const applied = mutations && Number.isFinite(mutations.applied) ? mutations.applied : 0
    const files = Array.isArray(report.filesChanged) ? report.filesChanged : []
    const verification = report.verification || null
    const levels = verification && verification.levels ? verification.levels : {}
    const passedLevels = Object.entries(levels).filter(([, entry]) => entry && entry.ok === true).map(([level]) => level)
    if (applied === 0 && files.length === 0 && passedLevels.length === 0) {
      return { progressed: false, reason: 'no mutation and no passing verification', resume: null }
    }
    return {
      progressed: true,
      reason: `${applied} mutation(s) applied and ${passedLevels.length} verification level(s) passed`,
      // What the next round resumes from: the files this episode changed, so the
      // continuation re-verifies them rather than starting from nothing.
      resume: { filesChanged: files.slice(0, 50), passedLevels }
    }
  }

  return {
    enabled,
    source,
    limits,
    decide,
    decisions() {
      return decisions.slice()
    },
    state() {
      return {
        enabled,
        source,
        limits,
        decisions: decisions.slice(-5)
      }
    }
  }
}

module.exports = {
  AUTONOMY_SOURCES,
  FINAL_REASONS,
  DEFAULT_AUTONOMY_LIMITS,
  resolveAutonomy,
  createEngineeringAutonomy,
  booleanOrNull
}
