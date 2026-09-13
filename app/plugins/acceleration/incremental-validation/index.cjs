'use strict'

/**
 * DS-Hns acceleration: incremental validation.
 *
 * Running the full suite after every one-line change is the most common way a fast
 * model becomes slow. Verification has three tiers and the *change* decides which
 * one it earns:
 *
 *   Tier 1  syntax / lint / type     after a patch
 *   Tier 2  affected tests           after a task step
 *   Tier 3  the full suite           before a completion claim
 *
 * Two rules keep it honest rather than merely fast:
 *
 *  * **Tier 3 is what completion requires.** A cheaper tier can *reject* a change
 *    early, but it can never approve a result: the acceptance gate reads the full
 *    tier, and this module says which tier a given moment is entitled to.
 *  * **Escalation is driven by the change.** A change that touches a manifest, the
 *    test configuration or many files is not a Tier-1 change, whatever the caller
 *    would prefer, so the tier is derived rather than requested.
 */

/** The tiers, weakest first. */
const TIERS = Object.freeze({
  TIER1: 'tier1',
  TIER2: 'tier2',
  TIER3: 'tier3'
})

const TIER_ORDER = Object.freeze([TIERS.TIER1, TIERS.TIER2, TIERS.TIER3])

/** What each tier means, for the report. */
const TIER_MEANING = Object.freeze({
  tier1: 'syntax, lint and type checks',
  tier2: 'the tests affected by the change',
  tier3: 'the repository\'s full required verification'
})

/** The operations each tier runs, in order. */
const TIER_OPERATIONS = Object.freeze({
  tier1: ['lint', 'typecheck'],
  tier2: ['focusedTest', 'affectedTest'],
  tier3: ['fullVerify']
})

/**
 * Which tier does this change warrant?
 *
 * The answer is the *highest* tier any property of the change demands, not the
 * lowest the caller asked for.
 *
 * @param {object} input
 * @param {string[]} [input.files] the files the change touched
 * @param {boolean} [input.manifestChanged] a manifest or lockfile was touched
 * @param {boolean} [input.testConfigChanged]
 */
function requiredTier(input = {}) {
  const files = Array.isArray(input.files) ? input.files.filter(Boolean) : []
  const reasons = []
  let tier = TIERS.TIER1
  if (files.some((file) => /package\.json|lock|pyproject|Cargo\.toml|go\.mod|pom\.xml|build\.gradle/i.test(file)) || input.manifestChanged === true) {
    tier = TIERS.TIER3
    reasons.push('a manifest or lockfile changed, which affects everything')
  } else if (files.some((file) => /(jest|vitest|pytest|test)[.\-/]?config|tsconfig/i.test(file)) || input.testConfigChanged === true) {
    tier = TIERS.TIER3
    reasons.push('the test or type configuration changed')
  } else if (files.length > 3) {
    tier = TIERS.TIER2
    reasons.push(`${files.length} files changed`)
  } else if (files.length === 0) {
    tier = TIERS.TIER1
    reasons.push('no file change was reported')
  } else {
    reasons.push(`${files.length} file(s) changed`)
  }
  return { tier, required: tier, reasons, files: files.length }
}

/** Which tier a *moment* is entitled to run, from the profile's policy. */
function tierForMoment(moment, policy = {}) {
  const map = {
    'after-patch': policy.afterPatch,
    'after-task': policy.afterTask,
    'before-commit': policy.beforeCommit,
    'before-completion': TIERS.TIER3
  }
  const requested = map[String(moment)] || null
  if (!requested || !TIER_ORDER.includes(requested)) return { tier: TIERS.TIER3, source: 'default', reason: `no policy names the ${moment} tier, so the full verification is used` }
  return { tier: requested, source: 'profile', reason: `the profile sets ${moment} to ${requested}` }
}

/**
 * Decide the tier for one validation, taking the stricter of "what the change
 * warrants" and "what the moment is entitled to".
 */
function decideTier(input = {}) {
  const required = requiredTier(input)
  const moment = tierForMoment(input.moment, input.policy)
  const wanted = TIER_ORDER.indexOf(required.tier) >= TIER_ORDER.indexOf(moment.tier) ? required : { tier: moment.tier, reasons: [moment.reason] }
  return {
    tier: wanted.tier,
    meaning: TIER_MEANING[wanted.tier],
    operations: TIER_OPERATIONS[wanted.tier],
    required: required.tier,
    moment: moment.tier,
    reasons: [...required.reasons, moment.reason],
    escalated: TIER_ORDER.indexOf(wanted.tier) > TIER_ORDER.indexOf(moment.tier)
  }
}

/**
 * Can this tier approve completion?
 *
 * Only Tier 3 can. Making that a function rather than a comment is what stops a
 * fast path from quietly becoming the acceptance criterion.
 */
function canApproveCompletion(tier) {
  return String(tier) === TIERS.TIER3
}

/**
 * Track the tiers one task has run, so the acceptance gate can ask "did the full
 * tier run after the last change?" rather than trusting a flag.
 *
 * @param {object} [options]
 * @param {Function} [options.now]
 * @param {number} [options.ringSize]
 */
function createValidationTracker(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const ringSize = Number.isInteger(options.ringSize) ? options.ringSize : 200
  const runs = []
  let lastChangeAt = null

  function record(entry) {
    runs.push(entry)
    if (runs.length > ringSize) runs.splice(0, runs.length - ringSize)
    return entry
  }

  return {
    TIERS,
    /** A change invalidates every tier that ran before it. */
    changed(detail = {}) {
      lastChangeAt = now()
      return record({ at: lastChangeAt, kind: 'change', files: Array.isArray(detail.files) ? detail.files.slice(0, 50) : [] })
    },
    /** One tier finished. */
    completed(tier, outcome = {}) {
      return record({ at: now(), kind: 'validation', tier, ok: outcome.ok === true, command: outcome.command || null })
    },
    /** The last run of one tier, or null. */
    lastRun(tier) {
      for (let index = runs.length - 1; index >= 0; index -= 1) {
        if (runs[index].kind === 'validation' && runs[index].tier === tier) return runs[index]
      }
      return null
    },
    /** Is this tier's evidence newer than the last change? */
    fresh(tier) {
      const run = this.lastRun(tier)
      if (!run) return { fresh: false, reason: `the ${tier} tier has never run` }
      if (lastChangeAt !== null && run.at < lastChangeAt) return { fresh: false, reason: `the ${tier} tier ran before the last change` }
      return { fresh: true, at: run.at, ok: run.ok }
    },
    /** What the acceptance gate needs: a fresh, passing full tier. */
    approval() {
      const fresh = this.fresh(TIERS.TIER3)
      if (!fresh.fresh) return { ok: false, reason: fresh.reason, tier: TIERS.TIER3 }
      if (fresh.ok !== true) return { ok: false, reason: `the ${TIERS.TIER3} tier did not pass`, tier: TIERS.TIER3 }
      return { ok: true, reason: 'the full verification passed after the last change', at: fresh.at, tier: TIERS.TIER3 }
    },
    runs() {
      return runs.slice()
    },
    summary() {
      return {
        runs: runs.length,
        lastChangeAt,
        tiers: Object.values(TIERS).map((tier) => ({ tier, last: this.lastRun(tier), fresh: this.fresh(tier).fresh })),
        approval: this.approval()
      }
    }
  }
}

module.exports = {
  TIERS,
  TIER_ORDER,
  TIER_MEANING,
  TIER_OPERATIONS,
  requiredTier,
  tierForMoment,
  decideTier,
  canApproveCompletion,
  createValidationTracker
}
