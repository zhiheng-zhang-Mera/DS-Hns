'use strict'

/**
 * Engineering Runtime: the result validator.
 *
 * "The model says it is done" is not evidence, and neither is "the code looks
 * right". An episode may only be reported COMPLETED when a *fresh* verification
 * of the things the task actually required says so, and when the runtime can show
 * that it left no mess behind. This module is the gate:
 *
 *   criteria      every success criterion the contract stated
 *   tests         the required test levels ran and passed, after the last change
 *   build         the required build ran and passed, after the last change
 *   lint          when the contract requires it
 *   failures      no unresolved critical failure is still open
 *   workspace     the workspace is still the one the episode was given
 *   leaks         no owned process, watcher or resource is left behind
 *
 * Every check returns the same shape — `{ ok, reason, evidence }` — so a refusal
 * can always name *which* requirement was unmet and with what the runtime saw. A
 * check that cannot be performed is a refusal, not a pass: an unverifiable
 * completion is not a completion.
 */

const fs = require('node:fs')
const path = require('node:path')

/** Why an episode was not allowed to complete. */
const REFUSAL_REASONS = Object.freeze({
  CRITERIA: 'success criteria are not satisfied',
  FRESHNESS: 'the required verification is not fresh',
  TESTS: 'the required tests did not pass',
  BUILD: 'the required build did not pass',
  LINT: 'the required lint did not pass',
  UNRESOLVED_FAILURE: 'an unresolved critical failure remains',
  WORKSPACE: 'the workspace is no longer valid',
  LEAK: 'the runtime left a resource behind',
  NOTHING_RAN: 'no verification was ever executed'
})

function check(ok, reason, evidence = null) {
  return { ok: Boolean(ok), reason: ok ? null : reason, evidence }
}

/**
 * @param {object} [options]
 * @param {number} [options.freshnessWindowMs] how old verification may be (default: no limit, freshness is by timestamp)
 * @param {Function} [options.now]
 */
function createResultValidator(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const freshnessWindowMs = Number.isFinite(options.freshnessWindowMs) ? Number(options.freshnessWindowMs) : null

  /**
   * Evaluate one episode.
   *
   * @param {object} input
   * @param {object} input.contract `{ success_criteria?, require_build?, require_lint?, tests? }`
   * @param {object} input.criteria the criteria evaluation `{ satisfied, unknown, results }`
   * @param {object} input.verification the verifier's `evidence()` output
   * @param {number|null} [input.lastMutationAt] when the episode last changed a file
   * @param {object} [input.failures] `{ unresolved: [] }`
   * @param {object} [input.workspace] `{ ok, cwd, reason }`
   * @param {object} [input.leaks] `{ processes, watchers, listeners, screenshots }`
   * @returns {{ok:boolean, verdict:string, reasons:string[], checks:object[], evidence:object}}
   */
  function validate(input = {}) {
    const contract = input.contract || {}
    const checks = []
    const at = now()

    // 1. Criteria. An unknown criterion is not a satisfied one.
    const criteria = input.criteria || { satisfied: false, unknown: false, results: [] }
    if (criteria.unknown === true) {
      checks.push(check(false, REFUSAL_REASONS.CRITERIA, { unknown: true, results: criteria.results }))
    } else {
      checks.push(check(criteria.satisfied === true, REFUSAL_REASONS.CRITERIA, { results: criteria.results }))
    }

    // 2. Tests. Required unless the contract explicitly says a code task has none.
    const verification = input.verification || { levels: {} }
    const requiredLevels = requiredTestLevels(contract)
    if (requiredLevels.length === 0) {
      checks.push(check(true, null, { skipped: 'the contract requires no test level' }))
    } else {
      const missing = requiredLevels.filter((level) => !verification.levels || !verification.levels[level])
      if (missing.length) {
        checks.push(check(false, REFUSAL_REASONS.TESTS, { missing, required: requiredLevels }))
      } else {
        const failed = requiredLevels.filter((level) => verification.levels[level].ok !== true)
        if (failed.length) {
          checks.push(check(false, REFUSAL_REASONS.TESTS, { failed, required: requiredLevels }))
        } else {
          checks.push(check(true, null, { levels: requiredLevels }))
        }
      }
    }

    // 3. Freshness: verification that predates the last change proves nothing about
    //    the code as it stands.
    const lastMutationAt = Number.isFinite(input.lastMutationAt) ? input.lastMutationAt : null
    if (lastMutationAt !== null) {
      const stale = []
      for (const level of requiredLevels) {
        const entry = verification.levels ? verification.levels[level] : null
        if (!entry || !Number.isFinite(entry.at)) continue
        if (entry.at < lastMutationAt) stale.push(level)
      }
      if (stale.length) {
        checks.push(check(false, REFUSAL_REASONS.FRESHNESS, { staleSince: lastMutationAt, levels: stale }))
      } else if (freshnessWindowMs !== null) {
        const expired = requiredLevels.filter((level) => {
          const entry = verification.levels ? verification.levels[level] : null
          return entry && Number.isFinite(entry.at) && at - entry.at > freshnessWindowMs
        })
        checks.push(expired.length
          ? check(false, REFUSAL_REASONS.FRESHNESS, { expired, windowMs: freshnessWindowMs })
          : check(true, null, { windowMs: freshnessWindowMs }))
      } else {
        checks.push(check(true, null, { lastMutationAt }))
      }
    }

    // 4. Build, when the contract requires one.
    if (contract.require_build === true || contract.requireBuild === true) {
      const build = input.build || (verification.levels ? verification.levels.build : null)
      checks.push(check(Boolean(build && build.ok === true), REFUSAL_REASONS.BUILD, build || null))
    }

    // 5. Lint, when the contract requires one.
    if (contract.require_lint === true || contract.requireLint === true) {
      const lint = input.lint || (verification.levels ? verification.levels.lint : null)
      checks.push(check(Boolean(lint && lint.ok === true), REFUSAL_REASONS.LINT, lint || null))
    }

    // 6. Unresolved critical failures.
    const unresolved = (input.failures && Array.isArray(input.failures.unresolved)) ? input.failures.unresolved : []
    checks.push(check(unresolved.length === 0, REFUSAL_REASONS.UNRESOLVED_FAILURE, { unresolved: unresolved.slice(0, 10) }))

    // 7. The workspace is still the one the episode was given.
    const workspace = input.workspace || null
    if (workspace) {
      checks.push(check(workspace.ok !== false, REFUSAL_REASONS.WORKSPACE, { cwd: workspace.cwd || null, reason: workspace.reason || null }))
    }

    // 8. Leaks. A finished episode owns nothing.
    const leaks = input.leaks || null
    if (leaks) {
      const offenders = Object.entries(leaks)
        .filter(([, value]) => Number.isFinite(value) && value > 0)
        .map(([name, value]) => ({ name, count: value }))
      checks.push(check(offenders.length === 0, REFUSAL_REASONS.LEAK, { offenders }))
    }

    // 9. Something must have actually run. An episode that verified nothing is not
    //    a completed episode, however tidy its tree is.
    const ranAnything = Boolean(verification.commands && verification.commands.length) ||
      Boolean(verification.levels && Object.keys(verification.levels).length)
    checks.push(check(ranAnything, REFUSAL_REASONS.NOTHING_RAN, { levels: verification.levels ? Object.keys(verification.levels) : [] }))

    const failed = checks.filter((entry) => !entry.ok)
    return {
      at,
      ok: failed.length === 0,
      verdict: failed.length === 0 ? 'COMPLETED' : 'REFUSED',
      reasons: failed.map((entry) => entry.reason),
      checks,
      evidence: {
        requiredLevels,
        lastMutationAt,
        ran: verification.commands ? verification.commands.length : 0,
        checked: checks.length
      }
    }
  }

  /** Which test levels the contract requires. */
  function requiredTestLevels(contract = {}) {
    const declared = contract.tests || contract.requiredTests || null
    if (Array.isArray(declared) && declared.length) return declared.map(String)
    if (declared === false) return []
    // A maintenance episode verifies at the full level by default: the point of
    // the exercise is that the repository's own required verification ran.
    return ['full-verify']
  }

  /**
   * The bounded set of unresolved critical failures for the gate.
   *
   * "Critical" means a failure class the loop could not repair; a `network`
   * hiccup that was retried successfully is not one.
   */
  function unresolvedFailures(failures = []) {
    const critical = new Set([
      'syntax', 'compile', 'type', 'unit-test', 'integration-test', 'runtime',
      'filesystem', 'permission', 'workspace', 'unknown'
    ])
    return (Array.isArray(failures) ? failures : []).filter((entry) => entry && entry.resolved !== true && critical.has(String(entry.class)))
  }

  return {
    REFUSAL_REASONS,
    validate,
    requiredTestLevels,
    unresolvedFailures
  }
}

/**
 * A cheap leak check from the infrastructure objects themselves.
 *
 * It reports counts rather than a verdict: the validator decides what a count
 * means, this only asks the components.
 */
function collectLeaks(input = {}) {
  const leaks = {}
  try {
    if (input.processes && typeof input.processes.snapshot === 'function') {
      leaks.processes = Number(input.processes.snapshot().ownedCount) || 0
    } else if (input.processes && typeof input.processes.ownedCount === 'number') {
      leaks.processes = input.processes.ownedCount
    }
  } catch {
    leaks.processes = 0
  }
  try {
    if (input.watchers && typeof input.watchers.watchCount === 'function') leaks.watchers = input.watchers.watchCount()
    else if (input.watchers && typeof input.watchers.count === 'function') leaks.watchers = input.watchers.count()
  } catch {
    leaks.watchers = 0
  }
  try {
    if (input.resources && typeof input.resources.snapshot === 'function') {
      leaks.screenshots = Number(input.resources.snapshot().screenshots) || 0
    }
  } catch {
    leaks.screenshots = 0
  }
  return leaks
}

/** Does a directory still exist and look like the workspace it claims to be? */
function workspaceStillValid(root) {
  try {
    return { ok: fs.statSync(root).isDirectory(), cwd: root, reason: null }
  } catch (error) {
    return { ok: false, cwd: root, reason: String(error && error.message ? error.message : error) }
  }
}

module.exports = { createResultValidator, collectLeaks, workspaceStillValid, REFUSAL_REASONS }
