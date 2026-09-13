'use strict'

/**
 * Computer Use Runtime: owned development process supervision.
 *
 * A software-development task starts processes constantly: a build, a test run, a
 * linter, a dev server, a package manager, git. "Spawn and forget" is the failure
 * mode this module exists to prevent — a forgotten child is an orphan, a leaked
 * handle and, on a long run, a machine that is slowly filling up with things
 * nobody owns.
 *
 * Two modes are distinguished, and conflating them is what makes a supervisor
 * either kill a dev server or hang on it:
 *
 *   foreground   bounded work: wait, collect the exit code and the output, kill
 *                it at the timeout. `npm test` is this.
 *   long-running intended to stay alive: a dev server. It is never treated as
 *                hung, and it is never left behind — the runtime owns it and
 *                disposes of it at shutdown.
 *
 * The registry is the single source of truth for "what did this runtime start",
 * which is exactly what makes "kill only what we own" enforceable: a process the
 * runtime did not start cannot be in the registry, so it can never be killed.
 */

const { CODES, ComputerUseError } = require('./errors.cjs')

/** Process modes. */
const PROCESS_MODE = Object.freeze({
  FOREGROUND: 'foreground',
  LONG_RUNNING: 'long_running'
})

/** Registry status for one owned process. */
const PROCESS_STATUS = Object.freeze({
  RUNNING: 'running',
  EXITED: 'exited',
  TIMED_OUT: 'timed_out',
  KILLED: 'killed',
  FAILED: 'failed'
})

/** Terminal statuses: nothing else will happen to this process. */
const TERMINAL_STATUS = Object.freeze([PROCESS_STATUS.EXITED, PROCESS_STATUS.TIMED_OUT, PROCESS_STATUS.KILLED, PROCESS_STATUS.FAILED])

/**
 * @param {object} [options]
 * @param {Function} [options.now]
 * @param {Function} [options.spawn] injectable spawn (tests)
 * @param {Function} [options.killTree] injectable tree killer (defaults to a SIGKILL on the child)
 * @param {number} [options.ringSize] bounded history of finished processes
 * @param {number} [options.maxOwned] hard ceiling on simultaneously owned processes
 */
function createProcessRegistry(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const ringSize = Number.isInteger(options.ringSize) && options.ringSize > 0 ? options.ringSize : 100
  const maxOwned = Number.isInteger(options.maxOwned) && options.maxOwned > 0 ? options.maxOwned : 16

  /** Live owned processes, keyed by a stable id. */
  const owned = new Map()
  /** Finished processes, bounded. */
  const finished = []
  let sequence = 0

  function record(entry) {
    finished.push(entry)
    if (finished.length > ringSize) finished.splice(0, finished.length - ringSize)
    return entry
  }

  function describe(entry) {
    return {
      id: entry.id,
      pid: entry.child && entry.child.pid ? entry.child.pid : null,
      command: entry.command,
      args: entry.args,
      cwd: entry.cwd,
      mode: entry.mode,
      ownership: entry.ownership,
      expectedLifetimeMs: entry.expectedLifetimeMs,
      startedAt: entry.startedAt,
      status: entry.status,
      exitCode: entry.exitCode === undefined ? null : entry.exitCode,
      signal: entry.signal || null,
      durationMs: entry.finishedAt ? entry.finishedAt - entry.startedAt : now() - entry.startedAt,
      step: entry.step === undefined ? null : entry.step
    }
  }

  /** Would taking one more process exceed the runtime's ceiling? */
  function atCapacity() {
    return owned.size >= maxOwned
  }

  /**
   * Register a child the runtime just started.
   *
   * @param {object} input
   * @param {object} input.child the spawned child process
   * @param {string} input.command
   * @param {string[]} [input.args]
   * @param {string} [input.cwd]
   * @param {string} [input.mode] PROCESS_MODE, defaults to foreground
   * @param {number} [input.expectedLifetimeMs] how long this process is expected to live
   * @param {string} [input.ownership] a label for who asked for it (the run id)
   * @param {number} [input.step]
   */
  function register({ child, command, args = [], cwd = null, mode = PROCESS_MODE.FOREGROUND, expectedLifetimeMs = null, ownership = 'runtime', step = null } = {}) {
    if (!child) throw new ComputerUseError(CODES.PROCESS_INVALID, 'a process cannot be registered without a child handle')
    if (atCapacity()) {
      throw new ComputerUseError(CODES.RESOURCE_LIMIT, `the runtime already owns ${owned.size} processes (ceiling ${maxOwned}); refusing to start another`, {
        owned: owned.size,
        ceiling: maxOwned
      })
    }
    sequence += 1
    const id = `p${sequence}`
    const entry = {
      id,
      child,
      command: String(command || ''),
      args: Array.isArray(args) ? args.map(String) : [],
      cwd: cwd || null,
      mode: mode === PROCESS_MODE.LONG_RUNNING ? PROCESS_MODE.LONG_RUNNING : PROCESS_MODE.FOREGROUND,
      expectedLifetimeMs: Number.isFinite(expectedLifetimeMs) ? Number(expectedLifetimeMs) : null,
      ownership,
      step,
      startedAt: now(),
      finishedAt: null,
      status: PROCESS_STATUS.RUNNING,
      exitCode: null,
      signal: null
    }
    owned.set(id, entry)
    return { id, entry }
  }

  /**
   * Mark an owned process as finished. Returns null for a process this registry
   * does not own, which is the whole point: an unowned exit is not ours to record.
   */
  function settle(id, { status, exitCode = null, signal = null } = {}) {
    const entry = owned.get(id)
    if (!entry) return null
    owned.delete(id)
    entry.status = TERMINAL_STATUS.includes(status) ? status : PROCESS_STATUS.EXITED
    entry.exitCode = exitCode
    entry.signal = signal
    entry.finishedAt = now()
    return record(describe(entry))
  }

  /** Is a process we own still running? */
  function isRunning(id) {
    return owned.has(id)
  }

  /**
   * A long-running process is *expected* to keep running. It is only a leak if it
   * has outlived its declared expectation, and only a problem at all if the
   * runtime no longer wants it.
   */
  function looksHung(id) {
    const entry = owned.get(id)
    if (!entry) return false
    if (entry.mode === PROCESS_MODE.LONG_RUNNING) {
      if (entry.expectedLifetimeMs === null) return false
      return now() - entry.startedAt > entry.expectedLifetimeMs
    }
    if (entry.expectedLifetimeMs === null) return false
    return now() - entry.startedAt > entry.expectedLifetimeMs
  }

  /** Kill one owned process. Never touches a process that is not in the registry. */
  async function kill(id, reason = 'runtime shutdown') {
    const entry = owned.get(id)
    if (!entry) return { ok: false, reason: 'not_owned', id }
    try {
      if (options.killTree) await options.killTree(entry.child, { id, reason })
      else entry.child.kill('SIGKILL')
    } catch (error) {
      const noted = settle(id, { status: PROCESS_STATUS.FAILED })
      return { ok: false, reason: 'kill_failed', id, error: String(error && error.message), entry: noted }
    }
    const noted = settle(id, { status: PROCESS_STATUS.KILLED })
    return { ok: true, id, reason, entry: noted }
  }

  /**
   * Kill every process this runtime owns. Used by the runtime's own shutdown and
   * by the run's end: a disposable process must not survive the task that started
   * it: a disposable process must not survive the task that started it.
   */
  async function dispose(reason = 'shutdown') {
    const ids = [...owned.keys()]
    const results = []
    for (const id of ids) results.push(await kill(id, reason))
    return { disposed: results.filter((entry) => entry.ok).length, attempted: ids.length, results }
  }

  /**
   * Detach a long-running process from the runtime *without* killing it, and
   * report it as an orphan so the caller can decide.
   *
   * This exists so that "the runtime shut down while a dev server was running"
   * is never silent: either the shutdown disposes it, or it is explicitly
   * reported as deliberately left running.
   */
  function release(id) {
    const entry = owned.get(id)
    if (!entry) return null
    owned.delete(id)
    entry.status = PROCESS_STATUS.RUNNING
    entry.detachedAt = now()
    return record({ ...describe(entry), detached: true })
  }

  function snapshot() {
    return {
      owned: [...owned.values()].map(describe),
      ownedCount: owned.size,
      ceiling: maxOwned,
      atCapacity: atCapacity(),
      finished: finished.slice(-20),
      hungSuspected: [...owned.keys()].filter((id) => looksHung(id))
    }
  }

  return {
    PROCESS_MODE,
    PROCESS_STATUS,
    register,
    settle,
    kill,
    dispose,
    release,
    isRunning,
    looksHung,
    atCapacity,
    snapshot,
    get ownedCount() {
      return owned.size
    },
    get ceiling() {
      return maxOwned
    },
    finished() {
      return finished.slice()
    }
  }
}

module.exports = { createProcessRegistry, PROCESS_MODE, PROCESS_STATUS, TERMINAL_STATUS }
