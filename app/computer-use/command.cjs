'use strict'

/**
 * Computer Use Runtime: the bounded command execution contract
 * (Update-Plan/24h.md Task 13, §15 of the plan).
 *
 * "Just run this" is not an instruction a long-running executor can accept,
 * because it turns into an unbounded wait the moment the command decides not to
 * finish. Every shell action therefore has to state, before it runs:
 *
 *   command            what to run
 *   cwd                where (verified, or inherited from the verified workspace)
 *   timeout            how long it may take
 *   expected exit      what counts as success
 *   output capture     how much output is kept
 *   process mode       foreground (bounded) or long-running (owned and supervised)
 *
 * This module is the *contract*, not the executor: it normalizes, defaults and
 * validates, and it classifies what a process is expected to do so the supervisor
 * can tell a dev server from a hung build.
 *
 * `process mode` is the load-bearing field. A foreground command that outlives its
 * timeout is a failure and is terminated; a long-running one is expected to still
 * be there and is supervised rather than killed (24h.md Task 7, Scenario B/C).
 */

const { TIMING, STEP_RESULTS } = require('./constants.cjs')
const { CODES, ComputerUseError } = require('./errors.cjs')

/** Sane bounded defaults when the caller names nothing. */
const COMMAND_DEFAULTS = Object.freeze({
  timeoutMs: 120_000,
  maxTimeoutMs: 30 * 60_000,
  minTimeoutMs: 1000,
  outputBytes: 256 * 1024,
  maxOutputBytes: 4 * 1024 * 1024
})

/** How a command is expected to behave. */
const COMMAND_MODE = Object.freeze({
  FOREGROUND: 'foreground',
  LONG_RUNNING: 'long_running'
})

/**
 * Command shapes that are, by nature, long-running: a dev server, a watcher, a
 * compiler in watch mode. Recognising them is not "learning an app" — it is
 * reading the command the caller wrote — and getting it wrong in the other
 * direction (treating a dev server as a hung build) is what breaks a long run.
 */
const LONG_RUNNING_PATTERNS = Object.freeze([
  /\b(serve|server|dev|watch|preview)\b/i,
  /\bnpm\s+run\s+(dev|serve|start|watch)\b/i,
  /\bpnpm\s+(dev|serve|watch)\b/i,
  /\byarn\s+(dev|serve|watch)\b/i,
  /\bvite\b(?!\s+build)/i,
  /\bnext\s+dev\b/i,
  /\bnodemon\b/i,
  /\bwebpack(-dev-server)?\s+serve\b/i,
  /--watch\b/i
])

/**
 * Normalize a shell action's parameters into an explicit, bounded contract.
 *
 * @param {object} input `{ command, args, cwd, timeoutMs, expectExitCode, mode, outputBytes, shell, stdin }`
 * @param {object} [context] `{ cwd }` from the verified workspace
 * @returns {{ok:boolean, contract:object|null, issues:object[]}}
 */
function normalizeCommand(input = {}, context = {}) {
  const issues = []
  const command = input.command === undefined || input.command === null ? '' : String(input.command).trim()
  if (!command) issues.push(issue('command', 'a command is required', CODES.COMMAND_INVALID))

  const args = Array.isArray(input.args) ? input.args.map(String) : []
  const cwd = input.cwd === undefined || input.cwd === null || String(input.cwd).trim() === ''
    ? (context.cwd || null)
    : String(input.cwd)

  const requestedTimeout = Number(input.timeoutMs)
  const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
    ? clamp(requestedTimeout, COMMAND_DEFAULTS.minTimeoutMs, COMMAND_DEFAULTS.maxTimeoutMs)
    : (context.defaultTimeoutMs || COMMAND_DEFAULTS.timeoutMs)

  const expectedExit = input.expectExitCode === undefined || input.expectExitCode === null
    ? null
    : Number(input.expectExitCode)
  if (expectedExit !== null && !Number.isFinite(expectedExit)) {
    issues.push(issue('expectExitCode', 'expectExitCode must be a number when it is given', CODES.COMMAND_INVALID))
  }

  const requestedOutput = Number(input.outputBytes)
  const outputBytes = Number.isFinite(requestedOutput) && requestedOutput > 0
    ? clamp(requestedOutput, 1024, COMMAND_DEFAULTS.maxOutputBytes)
    : COMMAND_DEFAULTS.outputBytes

  const mode = input.mode ? String(input.mode) : inferMode(command, args)
  if (!Object.values(COMMAND_MODE).includes(mode)) {
    issues.push(issue('mode', `unknown command mode "${mode}"`, CODES.COMMAND_INVALID))
  }

  const contract = {
    command,
    args,
    cwd,
    timeoutMs,
    expectExitCode: expectedExit,
    outputBytes,
    mode,
    shell: input.shell === true,
    stdin: input.stdin === undefined ? null : String(input.stdin),
    // A long-running process is supervised, not waited on; its "bounded" field is
    // how long the runtime expects it to live, which is what makes an outlived
    // long-running process reportable instead of invisible.
    expectedLifetimeMs: mode === COMMAND_MODE.LONG_RUNNING
      ? (Number.isFinite(Number(input.expectedLifetimeMs)) ? Number(input.expectedLifetimeMs) : null)
      : timeoutMs
  }

  if (issues.length) return { ok: false, contract: null, issues }
  return { ok: true, contract, issues: [] }
}

/** Guess the mode from the command text. The caller can always declare it. */
function inferMode(command, args = []) {
  const text = `${command} ${args.join(' ')}`.trim()
  if (LONG_RUNNING_PATTERNS.some((pattern) => pattern.test(text))) return COMMAND_MODE.LONG_RUNNING
  return COMMAND_MODE.FOREGROUND
}

/**
 * Judge the outcome of a finished command against its contract.
 *
 * The verdict vocabulary is the runtime's own (`STEP_RESULTS`), so a shell result
 * flows through the same reporting as every other action:
 *
 *   success   the declared exit expectation held
 *   failure   a non-zero exit, or a timeout (which is a failure *with evidence*)
 *   unknown   the command finished but nothing declared what success looks like
 *             and the exit was not zero
 */
function judge(contract, receipt = {}) {
  if (!contract) return { result: STEP_RESULTS.UNKNOWN, reason: 'no command contract', exitCode: null }
  if (receipt.timedOut === true) {
    return {
      result: STEP_RESULTS.FAILURE,
      reason: `the command exceeded its ${contract.timeoutMs}ms bound and was terminated`,
      exitCode: receipt.exitCode === undefined ? null : receipt.exitCode,
      timedOut: true
    }
  }
  if (receipt.spawnError) {
    return { result: STEP_RESULTS.FAILURE, reason: `the command could not start: ${receipt.spawnError}`, exitCode: null }
  }
  const exitCode = typeof receipt.exitCode === 'number' ? receipt.exitCode : null
  if (contract.expectExitCode !== null) {
    return exitCode === contract.expectExitCode
      ? { result: STEP_RESULTS.SUCCESS, reason: `exit code ${exitCode} as expected`, exitCode }
      : { result: STEP_RESULTS.FAILURE, reason: `exit code ${exitCode}, expected ${contract.expectExitCode}`, exitCode }
  }
  if (exitCode === 0) return { result: STEP_RESULTS.SUCCESS, reason: 'exit code 0', exitCode }
  if (exitCode === null) return { result: STEP_RESULTS.UNKNOWN, reason: 'the command ended without reporting an exit code', exitCode }
  return { result: STEP_RESULTS.FAILURE, reason: `exit code ${exitCode}`, exitCode }
}

/**
 * The typed failure for a shell action with no usable contract.
 *
 * `COMMAND_INVALID` rather than a crash: an unbounded command is refused *before*
 * it runs, which is the only point at which refusing it is cheap.
 */
function invalidError(issues) {
  const first = issues && issues.length ? issues[0] : null
  return new ComputerUseError(
    CODES.COMMAND_INVALID,
    first ? first.message : 'the shell action has no bounded execution contract',
    { issues: issues || [] }
  )
}

function issue(field, message, code) {
  return { field, message, code: code || CODES.COMMAND_INVALID }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Math.round(value)))
}

/** The action timeout the executor should use for a command that names none. */
const DEFAULT_ACTION_TIMEOUT_MS = TIMING.defaultActionTimeoutMs

module.exports = {
  COMMAND_DEFAULTS,
  COMMAND_MODE,
  LONG_RUNNING_PATTERNS,
  DEFAULT_ACTION_TIMEOUT_MS,
  normalizeCommand,
  inferMode,
  judge,
  invalidError
}
