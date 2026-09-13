'use strict'

/**
 * DS-Hns acceleration: the reasoning governor.
 *
 * A model like V4.1-Flash is fast because most calls are short and cheap. Spending
 * a `high` reasoning budget on "rename this symbol" throws that away, and staying
 * at `high` for the rest of a session after one hard bug is how a fast model
 * becomes a slow one. The governor is the mechanism that keeps the level matched to
 * the work:
 *
 *   L0  no reasoning     search, read, rename, format
 *   L1  low              a small patch, a lint or type error
 *   L2  medium           a cross-module change, an unknown bug
 *   L3  high             architecture, a repeated semantic failure
 *
 * Two rules are load-bearing, and both are about *coming back down*:
 *
 *  * escalation is driven by evidence — consecutive failures, an unknown bug, a
 *    cross-module change — never by a timer or by mood;
 *  * de-escalation is automatic. A level that was raised for a problem drops as
 *    soon as the problem is solved, so one hard task cannot leave the whole session
 *    reasoning at maximum. The plan states this as a requirement, which is why the
 *    governor tracks the *reason* a level was raised and how many clean steps have
 *    followed.
 *
 * The level is a *request*. The model layer narrows it to what the model can do, so
 * a governor may ask for L3 on a model whose ceiling is L2 and the run reports the
 * substitution rather than pretending.
 */

const { REASONING_LEVELS } = require('../../../core/contracts/model.cjs')

/** The task kinds the governor classifies, and the level each starts at. */
const TASK_KINDS = Object.freeze({
  SEARCH: 'search',
  READ: 'read',
  RENAME: 'rename',
  FORMAT: 'format',
  SMALL_PATCH: 'small-patch',
  LINT: 'lint',
  TYPE_ERROR: 'type-error',
  TEST: 'test',
  CROSS_MODULE: 'cross-module',
  UNKNOWN_BUG: 'unknown-bug',
  ARCHITECTURE: 'architecture',
  REPEATED_FAILURE: 'repeated-failure'
})

/** The base level for each task kind. */
const BASE_LEVEL = Object.freeze({
  [TASK_KINDS.SEARCH]: REASONING_LEVELS.NONE,
  [TASK_KINDS.READ]: REASONING_LEVELS.NONE,
  [TASK_KINDS.RENAME]: REASONING_LEVELS.NONE,
  [TASK_KINDS.FORMAT]: REASONING_LEVELS.NONE,
  [TASK_KINDS.TEST]: REASONING_LEVELS.NONE,
  [TASK_KINDS.SMALL_PATCH]: REASONING_LEVELS.LOW,
  [TASK_KINDS.LINT]: REASONING_LEVELS.LOW,
  [TASK_KINDS.TYPE_ERROR]: REASONING_LEVELS.LOW,
  [TASK_KINDS.CROSS_MODULE]: REASONING_LEVELS.MEDIUM,
  [TASK_KINDS.UNKNOWN_BUG]: REASONING_LEVELS.MEDIUM,
  [TASK_KINDS.ARCHITECTURE]: REASONING_LEVELS.HIGH,
  [TASK_KINDS.REPEATED_FAILURE]: REASONING_LEVELS.HIGH
})

/** What the escalations and de-escalations are called in the record. */
const REASONS = Object.freeze({
  BASE: 'the task kind sets this level',
  REPEATED_FAILURE: 'the same failure has repeated',
  UNKNOWN: 'the failure could not be classified',
  CROSS_MODULE: 'the change spans several modules',
  RECOVERED: 'the problem was solved, so the level drops back',
  CEILING: 'the profile caps the level for this run'
})

/**
 * Classify one step into a task kind.
 *
 * The classification reads the step the runtime is about to take — its action, its
 * operation, how many files it touches, whether it follows a failure — and never
 * anything about an application.
 */
function classifyStep(input = {}) {
  const action = String(input.action || '').toLowerCase()
  const operation = String(input.operation || '').toLowerCase()
  const files = Array.isArray(input.files) ? input.files.filter(Boolean).length : 0
  if (input.consecutiveFailures >= 2) return { kind: TASK_KINDS.REPEATED_FAILURE, reason: `${input.consecutiveFailures} consecutive failures` }
  if (input.failureClass === 'unknown' || input.unknown === true) return { kind: TASK_KINDS.UNKNOWN_BUG, reason: 'the failure could not be classified' }
  if (/^(architecture|design|refactor)/.test(action)) return { kind: TASK_KINDS.ARCHITECTURE, reason: 'a structural change' }
  if (files > 3 || input.crossModule === true) return { kind: TASK_KINDS.CROSS_MODULE, reason: `${files} files are touched` }
  if (operation === 'install' || operation === 'build') return { kind: TASK_KINDS.TEST, reason: 'a build or install step' }
  if (operation === 'lint') return { kind: TASK_KINDS.LINT, reason: 'a lint step' }
  if (operation === 'typecheck') return { kind: TASK_KINDS.TYPE_ERROR, reason: 'a typecheck step' }
  if (operation === 'test' || operation === 'focusedTest' || operation === 'fullVerify') return { kind: TASK_KINDS.TEST, reason: 'a test step' }
  if (/^(search|grep|find|inspect|read|list)/.test(action)) return { kind: TASK_KINDS.SEARCH, reason: 'a read-only inspection' }
  if (/^(rename|move)/.test(action)) return { kind: TASK_KINDS.RENAME, reason: 'a rename' }
  if (/^(format|fmt)/.test(action)) return { kind: TASK_KINDS.FORMAT, reason: 'a format' }
  if (input.files && files <= 1) return { kind: TASK_KINDS.SMALL_PATCH, reason: 'a single-file change' }
  return { kind: TASK_KINDS.SMALL_PATCH, reason: 'a default small change' }
}

/**
 * @param {object} [options]
 * @param {string} [options.defaultLevel] the profile's default
 * @param {string} [options.ceiling] the profile's ceiling
 * @param {number} [options.deescalateAfter] clean steps before a raised level drops
 * @param {number} [options.ringSize]
 */
function createReasoningGovernor(options = {}) {
  const defaultLevel = REASONING_LEVELS[String(options.defaultLevel || '').toUpperCase()] || options.defaultLevel || REASONING_LEVELS.LOW
  const ceiling = options.ceiling || REASONING_LEVELS.HIGH
  const deescalateAfter = Number.isInteger(options.deescalateAfter) ? options.deescalateAfter : 2
  const ringSize = Number.isInteger(options.ringSize) ? options.ringSize : 200
  const order = [REASONING_LEVELS.NONE, REASONING_LEVELS.LOW, REASONING_LEVELS.MEDIUM, REASONING_LEVELS.HIGH]

  let current = defaultLevel
  /** Why the current level is above the default, and when it was raised. */
  let raised = null
  let cleanSteps = 0
  let consecutiveFailures = 0
  const decisions = []

  function record(entry) {
    decisions.push(entry)
    if (decisions.length > ringSize) decisions.splice(0, decisions.length - ringSize)
    return entry
  }

  function clamp(level) {
    const wanted = order.indexOf(level)
    const allowed = order.indexOf(ceiling)
    if (wanted < 0) return { level: defaultLevel, clamped: true }
    if (allowed >= 0 && wanted > allowed) return { level: ceiling, clamped: true }
    return { level, clamped: false }
  }

  /**
   * Choose the level for one step.
   *
   * @param {object} input the step: `{ action, operation, files, failureClass, unknown }`
   * @returns {{level:string, kind:string, reason:string, escalated:boolean, clamped:boolean}}
   */
  function decide(input = {}) {
    const classified = classifyStep({ ...input, consecutiveFailures })
    const base = BASE_LEVEL[classified.kind] || defaultLevel
    const clamped = clamp(base)
    const escalated = order.indexOf(clamped.level) > order.indexOf(defaultLevel)
    if (escalated) {
      // Remember *why*, so the de-escalation knows what has to be resolved.
      raised = { level: clamped.level, kind: classified.kind, at: input.at || null }
      cleanSteps = 0
    }
    current = clamped.level
    return record({
      at: input.at || null,
      kind: classified.kind,
      level: current,
      base,
      escalated,
      clamped: clamped.clamped,
      reason: clamped.clamped ? `${classified.reason}; ${REASONS.CEILING}` : (escalated ? `${classified.reason}; ${classified.kind}` : REASONS.BASE),
      consecutiveFailures
    })
  }

  /**
   * Record how a step ended.
   *
   * A step that failed raises the failure count, which is what makes the *next*
   * step escalate; a step that succeeded counts towards de-escalation. This is the
   * whole "automatic downgrade" rule: the level comes down because the evidence
   * changed, not because time passed.
   */
  function observe(outcome = {}) {
    if (outcome.ok === true) {
      consecutiveFailures = 0
      if (raised) {
        cleanSteps += 1
        if (cleanSteps >= deescalateAfter) {
          const previous = current
          current = defaultLevel
          const note = record({ at: outcome.at || null, kind: 'deescalation', level: current, previous, escalated: false, clamped: false, reason: REASONS.RECOVERED, cleanSteps })
          raised = null
          cleanSteps = 0
          return note
        }
      }
      return { level: current, reason: 'the step succeeded' }
    }
    consecutiveFailures += 1
    cleanSteps = 0
    return { level: current, reason: `the step failed (${consecutiveFailures} consecutive)` }
  }

  return {
    TASK_KINDS,
    REASONS,
    decide,
    observe,
    classifyStep,
    get level() {
      return current
    },
    get defaultLevel() {
      return defaultLevel
    },
    get ceiling() {
      return ceiling
    },
    get escalated() {
      return Boolean(raised)
    },
    get consecutiveFailures() {
      return consecutiveFailures
    },
    /** Reset between tasks: nothing about one task's level survives into another. */
    reset() {
      current = defaultLevel
      raised = null
      cleanSteps = 0
      consecutiveFailures = 0
      return { level: current }
    },
    history() {
      return decisions.slice()
    },
    summary() {
      const escalatedDecisions = decisions.filter((entry) => entry.escalated === true).length
      const downgrades = decisions.filter((entry) => entry.kind === 'deescalation').length
      return {
        level: current,
        defaultLevel,
        ceiling,
        escalated: Boolean(raised),
        escalations: escalatedDecisions,
        downgrades,
        consecutiveFailures
      }
    }
  }
}

module.exports = { createReasoningGovernor, classifyStep, TASK_KINDS, BASE_LEVEL, REASONS }
