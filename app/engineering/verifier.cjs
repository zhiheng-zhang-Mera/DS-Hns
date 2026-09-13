'use strict'

/**
 * Engineering Runtime: verification from fresh evidence.
 *
 * A completion decision may not come from a model saying "looks right". It comes
 * from running the real commands and deciding from what they printed *after* the
 * last change. This module exists for that one sentence, and everything in it is
 * shaped by it:
 *
 *  * **The runtime runs the commands.** `run(level)` resolves the command from
 *    discovery and executes it through the process supervisor. The verifier never
 *    spawns anything itself: ownership, timeouts and killing stay in one place,
 *    which is what makes "kill only what we started" true.
 *
 *  * **Evidence is fresh or it is nothing.** A green test run from before the last
 *    mutation is not evidence about the current tree. `satisfied()` therefore
 *    refuses when the full verification level never ran, when it failed, when its
 *    evidence predates the most recent mutation, or when it predates the last
 *    `invalidate()`. `stale()` names the levels for which that is true.
 *
 *  * **A killed process is never a success.** A timeout is reported as a failure
 *    with the `timeout` class, and a signalled exit carries no exit code; both are
 *    refusals rather than passes, because "we stopped it" and "it passed" are
 *    different facts.
 *
 *  * **Output is bounded.** Every run truncates what it retains — a test suite can
 *    print a hundred megabytes and the runtime must not carry it — and every run
 *    carries a timeout, defaulting to the command's own bound or thirty minutes.
 *
 * Nothing here is remembered across episodes: one verifier belongs to one episode
 * and is discarded with it.
 */

const path = require('node:path')
const { classify } = require('./failure.cjs')

/** The verification ladder. Each level is strictly stronger than the one before. */
const VERIFICATION_LEVELS = Object.freeze({
  FOCUSED: 'focused-test',
  AFFECTED: 'affected-test',
  FULL: 'full-verify'
})

/** The ladder in order, weakest first. */
const VERIFICATION_LADDER = Object.freeze([VERIFICATION_LEVELS.FOCUSED, VERIFICATION_LEVELS.AFFECTED, VERIFICATION_LEVELS.FULL])

/** The command each level prefers, with the fallback the brief names. */
const LEVEL_COMMANDS = Object.freeze({
  [VERIFICATION_LEVELS.FOCUSED]: ['focusedTest', 'test'],
  [VERIFICATION_LEVELS.AFFECTED]: ['test', 'focusedTest'],
  [VERIFICATION_LEVELS.FULL]: ['test', 'focusedTest']
})

const DEFAULT_TIMEOUT_MS = 30 * 60_000
const DEFAULT_MAX_BYTES = 256 * 1024
const DEFAULT_HISTORY = 40

/**
 * The checkpoint module owns bounded output, and it is a shared runtime file
 * rather than something this module may copy: a second truncation implementation
 * would be a second answer to "what did the process actually print?".
 */
function truncateDependency() {
  const checkpoint = require('./checkpoint.cjs')
  if (typeof checkpoint.truncateOutput !== 'function') {
    throw new Error('app/engineering/checkpoint.cjs does not export truncateOutput(text, { maxBytes })')
  }
  return checkpoint.truncateOutput
}

/**
 * A numeric clause such as `1 failed` or `11 passed`.
 *
 * @returns {{value:number|null, matched:boolean}}
 */
function clause(text, result) {
  const pattern = new RegExp(`(\\d+)\\s+(${result})\\b`, 'i')
  const match = pattern.exec(text)
  if (!match) return { value: null, matched: false }
  return { value: Number(match[1]), matched: true }
}

function seconds(text, pattern) {
  const match = pattern.exec(text)
  return match ? Math.round(Number(match[1]) * 1000) : null
}

/**
 * `node --test` and its TAP-ish summary:
 *
 *   # tests 12
 *   # pass 11
 *   # fail 1
 *   # duration_ms 421.5
 *
 * @returns {object|null}
 */
function parseNodeTest(text) {
  const tests = /^#\s*tests\s+(\d+)/im.exec(text)
  const pass = /^#\s*pass\s+(\d+)/im.exec(text)
  const fail = /^#\s*fail\s+(\d+)/im.exec(text)
  if (!tests && !pass && !fail) return null
  const duration = /^#\s*duration_ms\s+([\d.]+)/im.exec(text)
  return {
    tests: tests ? Number(tests[1]) : null,
    passed: pass ? Number(pass[1]) : null,
    failed: fail ? Number(fail[1]) : null,
    durationMs: duration ? Math.round(Number(duration[1])) : null,
    framework: 'node-test'
  }
}

/**
 * Jest and Vitest:
 *
 *   Tests:       1 failed, 11 passed, 12 total
 *   Tests:       12 passed, 12 total
 *
 * @returns {object|null}
 */
function parseJestVitest(text) {
  const match = /^[ \t]*Tests:[ \t]+(.+)$/im.exec(text)
  if (!match) return null
  const line = match[1]
  const failed = clause(line, 'failed')
  const passed = clause(line, 'passed')
  const total = clause(line, 'total')
  const skipped = clause(line, 'skipped|pending|todo')
  if (!failed.matched && !passed.matched && !total.matched) return null
  const duration = /^[ \t]*Time:[ \t]+([\d.]+)\s*s/im.exec(text)
  const tests = total.matched ? total.value : passed.value !== null && failed.value !== null ? passed.value + failed.value : passed.value !== null ? passed.value : null
  return {
    tests,
    passed: passed.matched ? passed.value : null,
    failed: failed.matched ? failed.value : null,
    skipped: skipped.matched ? skipped.value : null,
    durationMs: duration ? Math.round(Number(duration[1]) * 1000) : null,
    framework: 'jest-vitest'
  }
}

/**
 * pytest:
 *
 *   ===== 1 failed, 11 passed in 2.34s =====
 *   ===== 12 passed in 0.41s =====
 *
 * @returns {object|null}
 */
function parsePytest(text) {
  const match = /(?:^|[=\s])((?:\d+\s+(?:passed|failed|error|errors|skipped|xfailed|xpassed|warnings?)(?:,\s*)?)+)\s+in\s+([\d.]+)s/im.exec(text)
  if (!match) return null
  const counts = match[1]
  const failed = clause(counts, 'failed')
  const errors = clause(counts, 'errors?')
  const passed = clause(counts, 'passed')
  const skipped = clause(counts, 'skipped')
  // pytest prints a failed clause only when something failed, so a bare
  // "11 passed" means no failures. Silence about *passed* is different: it stays
  // null rather than being guessed at zero.
  let failedCount = 0
  if (failed.matched) failedCount = failed.value
  else if (errors.matched) failedCount = errors.value
  const tests = passed.value !== null && failed.matched ? passed.value + failedCount : passed.matched ? passed.value : null
  return {
    tests,
    passed: passed.matched ? passed.value : null,
    failed: failedCount,
    errors: errors.matched ? errors.value : null,
    skipped: skipped.matched ? skipped.value : null,
    durationMs: Math.round(Number(match[2]) * 1000),
    framework: 'pytest'
  }
}

/**
 * cargo test:
 *
 *   test result: FAILED. 11 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out
 *   test result: ok. 12 passed; 0 failed; 0 ignored; 0 measured
 *
 * @returns {object|null}
 */
function parseCargoTest(text) {
  const match = /test result:\s*(ok|FAILED)\.\s*([^\n]*)/i.exec(text)
  if (!match) return null
  const counts = match[2]
  const passed = clause(counts, 'passed')
  const failed = clause(counts, 'failed')
  const ignored = clause(counts, 'ignored')
  const status = match[1].toLowerCase() === 'ok' ? 'ok' : 'failed'
  let failedCount = failed.matched ? failed.value : null
  if (!failed.matched && status === 'failed' && passed.matched) {
    // The summary line says the run failed but the exact count is elsewhere. The
    // parser still reports at least one failure rather than a reassuring zero.
    failedCount = 1
  }
  return {
    tests: passed.value !== null && failedCount !== null ? passed.value + failedCount : null,
    passed: passed.matched ? passed.value : null,
    failed: failedCount,
    ignored: ignored.matched ? ignored.value : null,
    durationMs: null,
    framework: 'cargo-test',
    status
  }
}

const PARSERS = Object.freeze([
  { framework: 'node-test', parse: parseNodeTest },
  { framework: 'jest-vitest', parse: parseJestVitest },
  { framework: 'pytest', parse: parsePytest },
  { framework: 'cargo-test', parse: parseCargoTest }
])

/**
 * Read a machine-readable test summary out of real suite output.
 *
 * This is what makes "the test count went down" measurable rather than felt. A
 * field that is not in the output is `null`, never a guess: a report that invents
 * `failed: 0` from silence is exactly the false evidence this module exists to
 * prevent.
 *
 * @param {string} text
 * @returns {{tests:number|null, passed:number|null, failed:number|null, durationMs:number|null, framework:string|null, status?:string, skipped?:number|null, errors?:number|null, ignored?:number|null}|null}
 */
function parseTestSummary(text) {
  const source = String(text === undefined || text === null ? '' : text)
  if (!source.trim()) return null
  for (const parser of PARSERS) {
    let parsed = null
    try {
      parsed = parser.parse(source)
    } catch {
      parsed = null
    }
    if (parsed) return { tests: null, passed: null, failed: null, durationMs: null, ...parsed, framework: parser.framework }
  }
  return null
}

/** Split a discovered command into what the supervisor starts. */
function splitCommand(text) {
  const source = String(text || '').trim()
  if (!source) return { command: '', args: [] }
  const tokens = []
  let current = ''
  let quote = null
  for (const character of source) {
    if (quote) {
      if (character === quote) quote = null
      else current += character
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (/\s/.test(character)) {
      if (current) tokens.push(current)
      current = ''
      continue
    }
    current += character
  }
  if (current) tokens.push(current)
  if (!tokens.length) return { command: source, args: [] }
  return { command: tokens[0], args: tokens.slice(1) }
}

/**
 * Is this level part of the verification ladder the runtime knows?
 *
 * @param {string} level
 */
function isVerificationLevel(level) {
  return VERIFICATION_LADDER.includes(String(level))
}

/**
 * @param {object} input
 * @param {object} input.supervisor the process supervisor (`start`, `waitForExit`)
 * @param {string} input.workspace the verified repository root
 * @param {object} [input.discovery] the discovery record (`commands`)
 * @param {Function} [input.now]
 * @param {Function} [input.truncate] injectable bounded-output helper (checkpoint's)
 * @param {string[]} [input.required] override the levels the gate requires
 * @param {number} [input.defaultTimeoutMs]
 * @param {number} [input.maxBytes]
 * @param {object|null} [input.mutations] a mutation log whose latest mutation bounds freshness
 * @returns {object} the verifier
 */
function createVerifier(input = {}) {
  if (!input || typeof input !== 'object') throw new Error('createVerifier needs an options object')
  const supervisor = input.supervisor
  if (!supervisor || typeof supervisor.start !== 'function' || typeof supervisor.waitForExit !== 'function') {
    throw new Error('createVerifier needs a process supervisor with start() and waitForExit()')
  }
  const workspace = input.workspace ? path.resolve(String(input.workspace)) : null
  if (!workspace) throw new Error('createVerifier needs the verified workspace path')
  const now = typeof input.now === 'function' ? input.now : () => Date.now()
  const defaultTimeoutMs = Number.isFinite(input.defaultTimeoutMs) ? Number(input.defaultTimeoutMs) : DEFAULT_TIMEOUT_MS
  const maxBytes = Number.isInteger(input.maxBytes) && input.maxBytes > 0 ? input.maxBytes : DEFAULT_MAX_BYTES
  const historyLimit = Number.isInteger(input.historyLimit) && input.historyLimit > 0 ? input.historyLimit : DEFAULT_HISTORY
  const required = Array.isArray(input.required) && input.required.length ? input.required.map(String) : VERIFICATION_LADDER.slice()
  // Bounded output is the checkpoint module's job, and this is the only place it
  // is resolved: a second truncation implementation would be a second answer to
  // "what did the process actually print?".
  const truncate = typeof input.truncate === 'function' ? input.truncate : truncateDependency()

  let discovery = input.discovery && typeof input.discovery === 'object' ? input.discovery : { commands: {} }
  const mutations = input.mutations && typeof input.mutations === 'object' ? input.mutations : null

  /** The latest run per level: one level, one piece of evidence. */
  const runs = new Map()
  /** Every run, bounded: the audit trail, not the state. */
  const history = []
  /** The last invalidation, if any: evidence older than this is not evidence. */
  let invalidation = null
  let invalidations = 0
  let lastMutationAt = null
  let mutationsNoted = 0

  function remember(entry) {
    history.push(entry)
    if (history.length > historyLimit) history.splice(0, history.length - historyLimit)
    return entry
  }

  function truncateOrFallback(text) {
    return truncate(text, { maxBytes })
  }

  /** The command one level runs, with the fallback the ladder declares. */
  function resolveCommand(level) {
    const commands = discovery && discovery.commands && typeof discovery.commands === 'object' ? discovery.commands : {}
    for (const operation of LEVEL_COMMANDS[level] || []) {
      if (commands[operation]) return { level, operation, command: commands[operation] }
    }
    return { level, operation: null, command: null }
  }

  /**
   * Run one verification level against the real workspace.
   *
   * @param {string} level one of VERIFICATION_LEVELS
   * @param {object} [options]
   * @param {string} [options.focus] the single test or path the level is about
   * @param {number} [options.timeoutMs]
   * @param {string} [options.cwd]
   * @returns {Promise<object>} `{ level, operation, command, cwd, ok, exitCode, signal, timedOut, killed, durationMs, output, testSummary, failure, at, reason }`
   */
  async function run(level, options = {}) {
    const name = String(level)
    const startedAt = now()
    if (!isVerificationLevel(name)) {
      return remember(failureResult({ level: name, at: startedAt, reason: `"${name}" is not a verification level`, startedAt }))
    }
    const resolved = resolveCommand(name)
    if (!resolved.operation) {
      return remember(failureResult({ level: name, at: startedAt, reason: `no command was discovered for ${name} (or its test fallback)`, startedAt }))
    }
    const command = resolved.command
    const text = String(command.command || '')
    if (!text.trim()) {
      return remember(failureResult({ level: name, operation: resolved.operation, at: startedAt, reason: `the ${name} command is empty`, startedAt }))
    }
    // The descriptor's own arguments are kept: a discovered command such as
    // `node --test` names both the executable and what it is told to do.
    const split = splitCommand(text)
    const declaredArgs = Array.isArray(command.args) ? command.args.map(String) : []
    const cwd = options.cwd ? path.resolve(String(options.cwd)) : command.cwd ? path.resolve(String(command.cwd)) : workspace
    // A focus argument is only appended to a command that declares it accepts
    // one: appending a path to `npm test` would change what the suite means.
    const acceptsFocus = command.acceptsFocus === true || resolved.operation === 'focusedTest'
    const focus = options.focus === undefined || options.focus === null ? null : String(options.focus)
    const args = focus && acceptsFocus ? [...split.args, ...declaredArgs, focus] : [...split.args, ...declaredArgs]
    const timeoutMs = Number.isFinite(options.timeoutMs) ? Number(options.timeoutMs) : Number.isFinite(command.timeoutMs) ? Number(command.timeoutMs) : defaultTimeoutMs

    let entry
    try {
      entry = supervisor.start({
        command: split.command,
        args,
        cwd,
        class: options.class || 'test',
        softTimeoutMs: timeoutMs,
        hardTimeoutMs: Number.isFinite(options.hardTimeoutMs) ? Number(options.hardTimeoutMs) : timeoutMs,
        ownership: options.ownership || 'episode',
        step: options.step === undefined ? null : options.step
      })
    } catch (error) {
      return remember(failureResult({ level: name, operation: resolved.operation, command: text, cwd, at: startedAt, reason: `the supervisor refused to start the ${name} command: ${messageOf(error)}`, startedAt }))
    }

    const id = entry && entry.id
    if (!entry || !id) {
      return remember(failureResult({ level: name, operation: resolved.operation, command: text, cwd, at: startedAt, reason: 'the supervisor started nothing (no process id)', startedAt }))
    }

    let waited
    try {
      waited = await supervisor.waitForExit(id, { softTimeoutMs: timeoutMs, pollMs: options.pollMs })
    } catch (error) {
      return remember(failureResult({ level: name, operation: resolved.operation, command: text, cwd, at: startedAt, reason: `the ${name} process could not be awaited: ${messageOf(error)}`, startedAt }))
    }

    const exitCode = firstInteger(waited && waited.exitCode, entry.exitCode)
    const signal = (waited && waited.signal) || entry.signal || null
    const timedOut = (waited && waited.timedOut === true) || entry.timedOut === true
    const killed = (waited && waited.killed === true) || entry.killed === true
    const durationMs = waited && Number.isFinite(waited.durationMs) ? Number(waited.durationMs) : now() - startedAt
    const rawOutput = outputText(waited, entry)
    const bounded = truncateOrFallback(rawOutput)
    const testSummary = parseTestSummary(bounded.text)
    // A timed-out or killed process is a failure even when it managed to exit 0:
    // "we stopped it" is not "it passed".
    const ok = timedOut !== true && killed !== true && signal === null && exitCode === 0
    const failure = ok
      ? null
      : classify({
          operation: resolved.operation,
          command: text,
          output: bounded.text,
          exitCode,
          timedOut,
          message: killed ? 'the process was killed before it finished' : ''
        })

    const result = {
      level: name,
      operation: resolved.operation,
      command: text,
      args,
      cwd,
      pid: id,
      ok,
      exitCode,
      signal,
      timedOut,
      killed,
      durationMs,
      output: bounded,
      testSummary,
      failure,
      at: now(),
      reason: ok ? null : failure ? `${failure.class}: ${failure.reason}` : 'the run did not succeed'
    }
    runs.set(name, result)
    return remember(result)
  }

  function failureResult(fields = {}) {
    const at = Number.isFinite(fields.at) ? fields.at : now()
    return {
      level: fields.level,
      operation: fields.operation || null,
      command: fields.command || null,
      args: [],
      cwd: fields.cwd || workspace,
      pid: null,
      ok: false,
      exitCode: null,
      signal: null,
      timedOut: false,
      killed: false,
      durationMs: Number.isFinite(fields.durationMs) ? fields.durationMs : 0,
      output: { text: '', bytes: 0, originalBytes: 0, truncated: false, head: '', tail: '', errorRegion: '' },
      testSummary: null,
      failure: {
        class: 'unknown',
        action: 'inspect',
        retryable: false,
        reason: fields.reason === undefined ? 'the run never started' : String(fields.reason),
        evidence: [fields.reason === undefined ? 'the run never started' : String(fields.reason)],
        signature: `unknown|${fields.level || 'unknown'}|nocmd|run-not-started`,
        timedOut: false,
        exitCode: null
      },
      at,
      reason: fields.reason === undefined ? 'the run never started' : String(fields.reason)
    }
  }

  function messageOf(error) {
    return String(error && error.message ? error.message : error)
  }

  function firstInteger(...values) {
    for (const value of values) {
      if (Number.isInteger(value)) return value
    }
    return null
  }

  function outputText(waited, entry) {
    const source = waited && waited.output !== undefined ? waited.output : entry ? `${entry.stdout || ''}${entry.stderr || ''}` : ''
    if (typeof source === 'string') return source
    if (source && typeof source.text === 'string') return source.text
    return ''
  }

  /**
   * Run the ladder in order and stop at the first level that breaks.
   *
   * Stopping is deliberate: a full suite run after a focused test failed produces
   * a slow, unreadable result for a question that was already answered.
   *
   * @param {string[]} [levels] defaults to the levels this verifier requires
   * @param {object} [options] forwarded to every `run`
   * @returns {Promise<{ok:boolean, broken:string|null, reason:string, ran:string[], results:object[]}>}
   */
  async function runLevels(levels, options = {}) {
    const ladder = Array.isArray(levels) && levels.length ? levels.map(String) : required.slice()
    const ran = []
    const results = []
    for (const level of ladder) {
      const result = await run(level, options)
      results.push(result)
      if (!result.ok) {
        return { ok: false, broken: level, reason: `the ${level} level failed: ${result.reason}`, ran, results }
      }
      ran.push(level)
    }
    return { ok: true, broken: null, reason: `every level passed: ${ran.join(', ')}`, ran, results }
  }

  /**
   * When this level last produced evidence, and whether anything invalidated it.
   *
   * Called with no level it answers the verifier-level question the episode report
   * asks — "when was anything last verified at all?" — rather than looking up a
   * level literally named `undefined`.
   *
   * @param {string} [level]
   * @returns {{at:number|null, ok:boolean, reason:string, run:object|null, level?:string|null, latestAt?:number|null, fresh?:boolean}}
   */
  function freshAt(level) {
    if (level === undefined || level === null || String(level).trim() === '') {
      const latest = latestRun()
      return {
        at: latest ? latest.at : null,
        ok: latest ? latest.ok && isFresh(latest.at) : false,
        reason: latest ? `the most recent verification was the ${latest.level} level at ${latest.at}` : 'nothing has been verified yet',
        run: latest,
        level: latest ? latest.level : null,
        latestAt: latest ? latest.at : null,
        fresh: latest ? isFresh(latest.at) : false
      }
    }
    const run_ = runs.get(String(level)) || null
    if (!run_) return { at: null, ok: false, reason: `the ${level} level has never run`, run: null }
    if (!run_.ok) return { at: run_.at, ok: false, reason: `the ${level} level last ran and did not pass: ${run_.reason}`, run: run_ }
    if (!isFresh(run_.at)) return { at: run_.at, ok: false, reason: `the ${level} evidence is older than the last change: ${freshnessReason()}`, run: run_ }
    return { at: run_.at, ok: true, reason: `${level} evidence is fresh`, run: run_ }
  }

  /** The most recent run across the ladder, whatever its outcome. */
  function latestRun() {
    let latest = null
    for (const entry of runs.values()) {
      if (!latest || entry.at > latest.at) latest = entry
    }
    return latest
  }

  function mutationBoundary() {
    if (mutations && typeof mutations.all === 'function') {
      const all = mutations.all()
      if (Array.isArray(all) && all.length) {
        const latest = all[all.length - 1]
        const at = Number.isFinite(latest.at) ? Number(latest.at) : null
        if (at !== null) return { at, source: 'mutation-log' }
      }
    }
    if (Number.isFinite(lastMutationAt)) return { at: lastMutationAt, source: 'noted' }
    return { at: null, source: null }
  }

  function freshnessReason(boundary = mutationBoundary().at) {
    const parts = []
    if (boundary !== null) parts.push(`the last change was at ${boundary}`)
    if (invalidation) parts.push(`the evidence was invalidated at ${invalidation.at} (${invalidation.reason})`)
    return parts.length ? parts.join(' and ') : 'nothing changed'
  }

  function isFresh(at) {
    if (!Number.isFinite(at)) return false
    const boundary = mutationBoundary().at
    if (boundary !== null && at <= boundary) return false
    if (invalidation && at <= invalidation.at) return false
    return true
  }

  /**
   * The completion gate.
   *
   * @param {object} [options]
   * @param {number} [options.sinceMs] the evidence must be no older than this
   * @param {number} [options.sinceAt] the evidence must be newer than this
   * @param {string[]} [options.levels] the levels the gate requires
   * @returns {{ok:boolean, reason:string, missing:string[], evidences:object[], checkedAt:number}}
   */
  function satisfied(options = {}) {
    const checkedAt = now()
    const levels = Array.isArray(options.levels) && options.levels.length ? options.levels.map(String) : required.slice()
    const missing = []
    const evidences = []
    const reasons = []

    for (const level of levels) {
      const verdict = freshAt(level)
      if (!verdict.ok) missing.push(level)
      reasons.push(verdict.reason)
      evidences.push({ level, at: verdict.at, ok: verdict.ok, run: verdict.run })
    }

    if (Number.isFinite(options.sinceAt)) {
      for (const entry of evidences) {
        if (entry.at === null || !(entry.at > Number(options.sinceAt))) {
          if (!missing.includes(entry.level)) missing.push(entry.level)
          reasons.push(`the ${entry.level} evidence is not newer than ${options.sinceAt}`)
        }
      }
    }
    if (Number.isFinite(options.sinceMs)) {
      const age = Number(options.sinceMs)
      for (const entry of evidences) {
        if (entry.at === null || checkedAt - entry.at > age) {
          if (!missing.includes(entry.level)) missing.push(entry.level)
          reasons.push(`the ${entry.level} evidence is older than ${age}ms`)
        }
      }
    }

    if (missing.length) {
      return { ok: false, reason: reasons.filter(Boolean).join('; '), missing, evidences, checkedAt }
    }
    return {
      ok: true,
      reason: `every required level passed with fresh evidence: ${levels.join(', ')}`,
      missing: [],
      evidences,
      checkedAt
    }
  }

  /**
   * Drop the evidence, because the tree changed.
   *
   * The supervisor calls this after a mutation: keeping a green run from before
   * the change is how a runtime convinces itself that an unverified edit works.
   *
   * @param {string} [reason]
   */
  function invalidate(reason = 'the workspace changed') {
    const at = now()
    invalidations += 1
    invalidation = { at, reason: String(reason), generation: invalidations }
    const stale = VERIFICATION_LADDER.filter((level) => {
      const run_ = runs.get(level)
      return !run_ || run_.at <= at
    })
    return { ok: true, at, reason: invalidation.reason, stale, generations: invalidations }
  }

  /**
   * Note a mutation this verifier was not given a mutation log for.
   *
   * @param {number|object} [detail] the time of the change, or `{ at }`
   * @returns {{at:number, count:number}}
   */
  function noteMutation(detail = {}) {
    const at = typeof detail === 'number' ? detail : Number.isFinite(detail.at) ? Number(detail.at) : now()
    lastMutationAt = Number.isFinite(lastMutationAt) ? Math.max(lastMutationAt, at) : at
    mutationsNoted += 1
    return { at: lastMutationAt, count: mutationsNoted }
  }

  /** Which levels carry evidence older than the last change or invalidation. */
  function stale() {
    const boundary = mutationBoundary().at
    const levels = {}
    for (const level of VERIFICATION_LADDER) {
      const run_ = runs.get(level) || null
      const expiresAt = Number.isFinite(boundary) ? boundary : null
      const invalidatedAt = invalidation ? invalidation.at : null
      const cutoff = expiresAt !== null && invalidatedAt !== null ? Math.max(expiresAt, invalidatedAt) : expiresAt !== null ? expiresAt : invalidatedAt
      levels[level] = {
        at: run_ ? run_.at : null,
        ran: Boolean(run_),
        ok: run_ ? run_.ok : false,
        stale: !run_ || (cutoff !== null && run_.at <= cutoff),
        reason: !run_ ? `the ${level} level has not run` : cutoff !== null && run_.at <= cutoff ? `the ${level} evidence predates the last change` : null
      }
    }
    const staleLevels = VERIFICATION_LADDER.filter((level) => levels[level].stale)
    return {
      at: now(),
      stale: staleLevels.length > 0,
      levels,
      staleLevels,
      since: cutoffFor(mutationBoundary().at, invalidation ? invalidation.at : null),
      invalidation: invalidation ? { ...invalidation } : null
    }
  }

  function cutoffFor(mutationAt, invalidatedAt) {
    if (Number.isFinite(mutationAt) && Number.isFinite(invalidatedAt)) return Math.max(mutationAt, invalidatedAt)
    if (Number.isFinite(mutationAt)) return mutationAt
    if (Number.isFinite(invalidatedAt)) return invalidatedAt
    return null
  }

  /**
   * The evidence record the episode report carries.
   *
   * @returns {{at:number, levels:object, fresh:boolean, stale:boolean, commands:object[], invalidation:object|null, mutations:number, checkedAt:number}}
   */
  function evidence() {
    const at = now()
    const levels = {}
    for (const level of VERIFICATION_LADDER) {
      const run_ = runs.get(level) || null
      levels[level] = run_
        ? {
            at: run_.at,
            ok: run_.ok,
            command: run_.command,
            exitCode: run_.exitCode,
            signal: run_.signal,
            timedOut: run_.timedOut,
            killed: run_.killed,
            durationMs: run_.durationMs,
            testSummary: run_.testSummary,
            failure: run_.failure,
            fresh: isFresh(run_.at),
            reason: run_.reason
          }
        : { at: null, ok: false, command: null, fresh: false, reason: `the ${level} level has not run` }
    }
    const gate = satisfied()
    return {
      at,
      levels,
      fresh: gate.ok,
      satisfied: gate.ok,
      missing: gate.missing,
      reason: gate.reason,
      stale: stale().stale,
      staleLevels: stale().staleLevels,
      invalidation: invalidation ? { ...invalidation } : null,
      invalidations,
      mutations: mutationsNoted,
      commands: history.map((entry) => ({
        level: entry.level,
        command: entry.command,
        args: entry.args.slice(),
        ok: entry.ok,
        exitCode: entry.exitCode,
        signal: entry.signal,
        timedOut: entry.timedOut,
        durationMs: entry.durationMs,
        at: entry.at,
        outputBytes: entry.output ? entry.output.originalBytes : 0,
        truncated: entry.output ? entry.output.truncated : false
      })),
      checkedAt: now()
    }
  }

  return {
    VERIFICATION_LEVELS,
    VERIFICATION_LADDER,
    run,
    runLevels,
    satisfied,
    evidence,
    invalidate,
    stale,
    freshAt,
    noteMutation,
    parseTestSummary,
    /** Point the verifier at a new command table without rebuilding it. */
    setDiscovery(next) {
      if (next && typeof next === 'object') discovery = next
      return discovery
    },
    /** The command one level would run, without running it. */
    commandFor(level) {
      return resolveCommand(String(level))
    },
    /** The last run of one level, unchanged. */
    lastRun(level) {
      return runs.get(String(level)) || null
    },
    /** Every run this verifier made, bounded. */
    history() {
      return history.map((entry) => ({ ...entry }))
    },
    get workspace() {
      return workspace
    },
    get required() {
      return required.slice()
    },
    get invalidations() {
      return invalidations
    }
  }
}

module.exports = {
  createVerifier,
  VERIFICATION_LEVELS,
  VERIFICATION_LADDER,
  LEVEL_COMMANDS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_BYTES,
  parseTestSummary,
  parseNodeTest,
  parseJestVitest,
  parsePytest,
  parseCargoTest,
  splitCommand,
  isVerificationLevel
}
