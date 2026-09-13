'use strict'

/**
 * Engineering Runtime: failure classification and hypotheses.
 *
 * A repair loop without classification is a loop that tries the same thing again.
 * Every real failure is put into one of a closed set of classes, and the class
 * decides what the runtime is allowed to do next:
 *
 *   syntax / type / compile / unit-test / integration-test / runtime
 *      → a code failure: inspect the evidence, form a hypothesis, patch
 *   timeout / resource
 *      → a bound was hit: the response is a bound, not a patch
 *   dependency / network
 *      → an external transient: bounded retry with backoff, then BLOCKED
 *   filesystem / permission / workspace
 *      → the environment refuses: BLOCKED with context
 *   transport / ui
 *      → the channel failed: bounded reconnect, then BLOCKED
 *   unknown
 *      → nothing is assumed; the next step is a targeted inspection
 *
 * Two rules the plan states explicitly are enforced here rather than documented:
 *
 *  * **No blind retry.** The same command, the same failure, the same environment
 *    and no state change is *the same attempt*. It is refused, not repeated.
 *  * **A failed hypothesis is not repeated.** Hypotheses are tracked by the
 *    evidence that motivated them, and the same one cannot be tried again.
 */

/** The closed classification vocabulary. */
const FAILURE_CLASSES = Object.freeze({
  SYNTAX: 'syntax',
  COMPILE: 'compile',
  TYPE: 'type',
  UNIT_TEST: 'unit-test',
  INTEGRATION_TEST: 'integration-test',
  RUNTIME: 'runtime',
  TIMEOUT: 'timeout',
  DEPENDENCY: 'dependency',
  NETWORK: 'network',
  FILESYSTEM: 'filesystem',
  PERMISSION: 'permission',
  WORKSPACE: 'workspace',
  UI: 'ui',
  TRANSPORT: 'transport',
  RESOURCE: 'resource',
  UNKNOWN: 'unknown'
})

/** What a class allows the loop to do next. */
const CLASS_POLICY = Object.freeze({
  [FAILURE_CLASSES.SYNTAX]: { action: 'repair', retryable: false, reason: 'a syntax error is fixed by editing, never by re-running' },
  [FAILURE_CLASSES.COMPILE]: { action: 'repair', retryable: false, reason: 'a compile error is fixed by editing' },
  [FAILURE_CLASSES.TYPE]: { action: 'repair', retryable: false, reason: 'a type error is fixed by editing' },
  [FAILURE_CLASSES.UNIT_TEST]: { action: 'repair', retryable: false, reason: 'a failing unit test needs a code change' },
  [FAILURE_CLASSES.INTEGRATION_TEST]: { action: 'repair', retryable: false, reason: 'a failing integration test needs a code or environment change' },
  [FAILURE_CLASSES.RUNTIME]: { action: 'repair', retryable: false, reason: 'a runtime error needs inspection before anything is re-run' },
  [FAILURE_CLASSES.TIMEOUT]: { action: 'bound', retryable: true, reason: 'a timeout is answered with a larger bound or a smaller unit of work' },
  [FAILURE_CLASSES.DEPENDENCY]: { action: 'retry-bounded', retryable: true, reason: 'a dependency failure may be transient' },
  [FAILURE_CLASSES.NETWORK]: { action: 'retry-bounded', retryable: true, reason: 'a network failure may be transient' },
  [FAILURE_CLASSES.FILESYSTEM]: { action: 'block', retryable: false, reason: 'the filesystem refused the operation' },
  [FAILURE_CLASSES.PERMISSION]: { action: 'block', retryable: false, reason: 'the operation is not permitted' },
  [FAILURE_CLASSES.WORKSPACE]: { action: 'block', retryable: false, reason: 'the workspace is not usable' },
  [FAILURE_CLASSES.UI]: { action: 'reconnect', retryable: true, reason: 'the UI channel failed, not the code' },
  [FAILURE_CLASSES.TRANSPORT]: { action: 'reconnect', retryable: true, reason: 'the transport failed, not the code' },
  [FAILURE_CLASSES.RESOURCE]: { action: 'degrade', retryable: false, reason: 'a resource ceiling was reached; the runtime must release before it continues' },
  [FAILURE_CLASSES.UNKNOWN]: { action: 'inspect', retryable: false, reason: 'nothing is assumed about an unclassified failure' }
})

/** Patterns that identify a class from real output, cheapest first. */
const PATTERNS = Object.freeze([
  { class: FAILURE_CLASSES.SYNTAX, pattern: /SyntaxError|Unexpected token|Unterminated|parse error|invalid syntax/i },
  { class: FAILURE_CLASSES.TYPE, pattern: /TS\d{3,5}|type error|TypeError:|is not assignable|cannot find name/i },
  { class: FAILURE_CLASSES.COMPILE, pattern: /error CS\d+|compilation failed|compile error|cannot compile|cargo: error|undefined reference/i },
  { class: FAILURE_CLASSES.PERMISSION, pattern: /\bEACCES\b|\bEPERM\b|permission denied|access is denied|operation not permitted/i },
  { class: FAILURE_CLASSES.NETWORK, pattern: /\bENOTFOUND\b|\bECONNREFUSED\b|\bECONNRESET\b|\bETIMEDOUT\b|network is unreachable|getaddrinfo|Could not resolve host|registry\.npmjs\.org/i },
  { class: FAILURE_CLASSES.DEPENDENCY, pattern: /\bERESOLVE\b|peer dep|No matching version found|package not found|404 Not Found - GET|cannot find module (?!.*\.\/)/i },
  { class: FAILURE_CLASSES.FILESYSTEM, pattern: /\bENOENT\b|\bENOSPC\b|\bEBUSY\b|\bEMFILE\b|no such file or directory|disk full/i },
  { class: FAILURE_CLASSES.TIMEOUT, pattern: /\btimed? ?out\b|timeout|deadline exceeded|exceeded its \d+ms budget/i },
  { class: FAILURE_CLASSES.TRANSPORT, pattern: /Target closed|disconnect|socket hang up|\bEPIPE\b|webSocket|detached from target/i },
  { class: FAILURE_CLASSES.UI, pattern: /modal|dialog|window mismatch|focus/i },
  { class: FAILURE_CLASSES.INTEGRATION_TEST, pattern: /integration test|e2e|end-to-end|cypress|playwright/i },
  { class: FAILURE_CLASSES.UNIT_TEST, pattern: /failing|✗|✖|not ok \d|AssertionError|Expected .* to (be|equal)|tests? failed|\d+ (failed|failing)/i },
  { class: FAILURE_CLASSES.RESOURCE, pattern: /out of memory|heap out of memory|resource ceiling|too many open files/i }
])

/**
 * The signature that makes two failures "the same failure".
 *
 * It is deliberately built from the *stable* part of the evidence — the class,
 * the command, and the normalized message with numbers, paths, hashes and timings
 * removed — because "failed at 12:00:03" and "failed at 12:00:04" are the same
 * failure and must not be counted as new evidence.
 */
function failureSignature(input = {}) {
  const normalized = normalizeMessage(input.message || input.output || '')
  return [input.class || FAILURE_CLASSES.UNKNOWN, input.operation || 'unknown', input.command ? hashish(String(input.command)) : 'nocmd', normalized].join('|')
}

/** Strip the parts of a message that change between two runs of the same failure. */
function normalizeMessage(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/\b[0-9a-f]{7,40}\b/gi, '<hash>')
    .replace(/\d+(\.\d+)?\s*(ms|s|m|h)\b/gi, '<time>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/([A-Za-z]:)?[\\/][^\s:]+/g, '<path>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400)
}

function hashish(text) {
  let hash = 0
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0
  }
  return Math.abs(hash).toString(36)
}

/**
 * Classify one failure from its evidence.
 *
 * @param {object} input
 * @param {string} [input.operation] the operation that failed (test, build, lint…)
 * @param {string} [input.command]
 * @param {string} [input.output] stdout/stderr
 * @param {string} [input.message]
 * @param {number|null} [input.exitCode]
 * @param {boolean} [input.timedOut]
 * @param {string} [input.code] a typed runtime error code, when there is one
 */
function classify(input = {}) {
  const haystack = `${input.message || ''}\n${input.output || ''}`
  const evidence = []
  let failureClass = null

  if (input.timedOut === true) {
    failureClass = FAILURE_CLASSES.TIMEOUT
    evidence.push('the process exceeded its time bound')
  }
  if (!failureClass && input.code) {
    const fromCode = fromErrorCode(String(input.code))
    if (fromCode) {
      failureClass = fromCode.class
      evidence.push(`the typed error code ${input.code} maps to ${fromCode.class}`)
    }
  }
  if (!failureClass) {
    for (const entry of PATTERNS) {
      const match = entry.pattern.exec(haystack)
      if (match) {
        failureClass = entry.class
        evidence.push(`"${String(match[0]).slice(0, 80)}" identifies ${entry.class}`)
        break
      }
    }
  }
  if (!failureClass) {
    // A non-zero exit with no recognised text is still a real failure; it is
    // simply one the runtime has to inspect rather than assume about.
    failureClass = FAILURE_CLASSES.UNKNOWN
    evidence.push('no known failure pattern matched')
  }

  const policy = CLASS_POLICY[failureClass] || CLASS_POLICY[FAILURE_CLASSES.UNKNOWN]
  return {
    class: failureClass,
    action: policy.action,
    retryable: policy.retryable,
    reason: policy.reason,
    evidence,
    signature: failureSignature({ class: failureClass, operation: input.operation, command: input.command, message: input.message || input.output }),
    timedOut: input.timedOut === true,
    exitCode: Number.isInteger(input.exitCode) ? input.exitCode : null
  }
}

/** Map a Computer Use error code onto an engineering failure class. */
function fromErrorCode(code) {
  const map = {
    WORKSPACE_UNAVAILABLE: FAILURE_CLASSES.WORKSPACE,
    WORKSPACE_MISMATCH: FAILURE_CLASSES.WORKSPACE,
    COMMAND_INVALID: FAILURE_CLASSES.SYNTAX,
    PROCESS_INVALID: FAILURE_CLASSES.RUNTIME,
    PROCESS_LOST: FAILURE_CLASSES.RUNTIME,
    RESOURCE_LIMIT: FAILURE_CLASSES.RESOURCE,
    ACTION_TIMEOUT: FAILURE_CLASSES.TIMEOUT,
    RECONNECT_EXHAUSTED: FAILURE_CLASSES.TRANSPORT,
    CAPABILITY_UNAVAILABLE: FAILURE_CLASSES.TRANSPORT,
    CONTROLLER_UNAVAILABLE: FAILURE_CLASSES.TRANSPORT,
    MUTATION_UNVERIFIED: FAILURE_CLASSES.FILESYSTEM
  }
  return map[code] ? { class: map[code] } : null
}

/**
 * The repair loop's memory for one episode.
 *
 * It exists to refuse two things: repeating an attempt that produced nothing new,
 * and repeating a hypothesis that already failed. Both refusals are the plan's
 * "no blind retry" rule made operational.
 *
 * @param {object} [options]
 * @param {Function} [options.now]
 * @param {number} [options.ringSize]
 * @param {number} [options.maxHypotheses] how many distinct hypotheses one failure may get
 */
function createRepairTracker(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const ringSize = Number.isInteger(options.ringSize) && options.ringSize > 0 ? options.ringSize : 200
  const maxHypotheses = Number.isInteger(options.maxHypotheses) && options.maxHypotheses > 0 ? options.maxHypotheses : 4
  const attempts = []
  const hypotheses = []

  /**
   * Would running this command again be a blind retry?
   *
   * The answer is yes when the same command already failed with the same
   * signature and nothing observable has changed since — no mutation, no
   * different environment, no new evidence.
   *
   * @returns {{blind:boolean, reason:string, previous:object|null}}
   */
  function wouldBeBlind(input = {}) {
    const signature = input.signature || failureSignature(input)
    const previous = attempts.find((entry) => entry.signature === signature)
    if (!previous) return { blind: false, reason: 'this failure has not been seen before', previous: null }
    if (input.stateChanged === true) {
      return { blind: false, reason: 'the state changed since the last attempt, so this is a new attempt', previous }
    }
    return {
      blind: true,
      reason: `the same failure was already produced ${previous.count} time(s) with no state change since`,
      previous
    }
  }

  /** Record one failed attempt. */
  function recordAttempt(input = {}) {
    const signature = input.signature || failureSignature(input)
    const existing = attempts.find((entry) => entry.signature === signature)
    if (existing) {
      existing.count += 1
      existing.lastAt = now()
      existing.mutations = (existing.mutations || 0) + (input.mutations || 0)
      return existing
    }
    const entry = {
      signature,
      class: input.class || FAILURE_CLASSES.UNKNOWN,
      operation: input.operation || null,
      command: input.command || null,
      count: 1,
      firstAt: now(),
      lastAt: now(),
      mutations: input.mutations || 0
    }
    attempts.push(entry)
    if (attempts.length > ringSize) attempts.splice(0, attempts.length - ringSize)
    return entry
  }

  /**
   * Register a hypothesis for the current failure.
   *
   * An identical statement is refused: a hypothesis that already failed is not a
   * new idea, and re-running it is exactly the loop the plan forbids.
   */
  function proposeHypothesis(input = {}) {
    const statement = String(input.statement || '').trim()
    if (!statement) return { ok: false, reason: 'a hypothesis needs a statement' }
    const signature = input.signature || failureSignature(input)
    const forThisFailure = hypotheses.filter((entry) => entry.signature === signature)
    if (forThisFailure.some((entry) => entry.statement === statement)) {
      return { ok: false, reason: 'this hypothesis has already been tried for this failure', hypothesis: null }
    }
    if (forThisFailure.length >= maxHypotheses) {
      return { ok: false, reason: `this failure already has ${forThisFailure.length} hypotheses; broaden the investigation instead`, hypothesis: null, exhausted: true }
    }
    const entry = {
      id: `h${hypotheses.length + 1}`,
      statement,
      signature,
      evidence: Array.isArray(input.evidence) ? input.evidence.slice() : [],
      changes: [],
      result: 'open',
      at: now()
    }
    hypotheses.push(entry)
    if (hypotheses.length > ringSize) hypotheses.splice(0, hypotheses.length - ringSize)
    return { ok: true, reason: 'a new hypothesis', hypothesis: entry }
  }

  /** Settle a hypothesis with its outcome. */
  function settleHypothesis(id, result, changes = []) {
    const entry = hypotheses.find((candidate) => candidate.id === id)
    if (!entry) return null
    entry.result = String(result)
    entry.changes = Array.isArray(changes) ? changes.slice() : []
    entry.settledAt = now()
    return entry
  }

  /** Has this failure been seen often enough to call it a stall? */
  function repeated(input = {}) {
    const signature = input.signature || failureSignature(input)
    const entry = attempts.find((candidate) => candidate.signature === signature)
    const count = entry ? entry.count : 0
    const threshold = Number.isInteger(input.threshold) ? input.threshold : 3
    return { repeated: count >= threshold, count, threshold, signature }
  }

  return {
    FAILURE_CLASSES,
    wouldBeBlind,
    recordAttempt,
    proposeHypothesis,
    settleHypothesis,
    repeated,
    attempts() {
      return attempts.map((entry) => ({ ...entry }))
    },
    hypotheses() {
      return hypotheses.map((entry) => ({ ...entry, evidence: entry.evidence.slice(), changes: entry.changes.slice() }))
    },
    /** The open hypotheses for one failure signature. */
    openFor(signature) {
      return hypotheses.filter((entry) => entry.signature === signature && entry.result === 'open')
    }
  }
}

module.exports = {
  FAILURE_CLASSES,
  CLASS_POLICY,
  PATTERNS,
  classify,
  fromErrorCode,
  failureSignature,
  normalizeMessage,
  createRepairTracker
}
