'use strict'

/**
 * Engineering Runtime: process supervision.
 *
 * A 24-hour maintenance episode is mostly *waiting for processes*: builds, test
 * suites, dev servers, watchers. This module is the difference between waiting and
 * hanging. It reuses the Computer Use process registry — the runtime already owns
 * exactly one registry per runtime and knows how to kill only what it started — and
 * adds the four things an engineering loop needs on top of it:
 *
 *   readiness   a background server is ready when it answers, not when a timer
 *               expires: a port, an HTTP response, a stdout pattern or a file.
 *   liveness    a process that is alive and still producing output is *working*,
 *               never a stall, however long it runs.
 *   bounds      every process carries a soft timeout (inspect whether it is still
 *               progressing) and a hard timeout (terminate it).
 *   evidence    the outcome — exit code, signal, duration, the bounded tail of its
 *               output — is recorded whether it succeeded, failed or was killed.
 *
 * Nothing here decides whether a *test* passed; it decides whether a *process*
 * finished, and it never kills anything the runtime did not start.
 */

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const path = require('node:path')
const { createProcessRegistry, PROCESS_STATUS } = require('../computer-use/processes.cjs')
const { CODES, ComputerUseError } = require('../computer-use/errors.cjs')
const { truncateOutput } = require('./checkpoint.cjs')

/** How a supervised process is used. */
const PROCESS_CLASS = Object.freeze({
  FOREGROUND: 'foreground',
  BACKGROUND: 'background',
  WATCHER: 'watcher',
  BUILD: 'build',
  TEST: 'test',
  SERVER: 'server',
  HELPER: 'helper'
})

/** The readiness conditions a background process can be started with. */
const READINESS = Object.freeze({
  PORT: 'port',
  HTTP: 'http',
  STDOUT: 'stdout',
  FILE: 'file',
  EXIT: 'exit',
  NONE: 'none'
})

const DEFAULT_SOFT_TIMEOUT_MS = 10 * 60_000
const DEFAULT_HARD_TIMEOUT_MS = 60 * 60_000
const DEFAULT_READY_TIMEOUT_MS = 60_000
const DEFAULT_OUTPUT_BYTES = 256 * 1024

/**
 * @param {object} [options]
 * @param {object} [options.registry] a shared Computer Use process registry
 * @param {Function} [options.now]
 * @param {Function} [options.sleep] injectable (virtual clocks in tests)
 * @param {number} [options.maxOwned] forwarded to a registry this module creates
 * @param {number} [options.outputBytes] the retained-output ceiling per process
 */
function createProcessSupervisor(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const sleep = typeof options.sleep === 'function' ? options.sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const registry = options.registry || createProcessRegistry({ now, maxOwned: options.maxOwned })
  const outputBytes = Number.isInteger(options.outputBytes) ? options.outputBytes : DEFAULT_OUTPUT_BYTES
  const records = new Map()
  const history = []
  const historyLimit = Number.isInteger(options.historyLimit) ? options.historyLimit : 200

  function remember(record) {
    history.push({
      id: record.id,
      command: record.command,
      args: record.args.slice(),
      cwd: record.cwd,
      class: record.class,
      status: record.status,
      exitCode: record.exitCode,
      signal: record.signal,
      durationMs: record.durationMs,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      timedOut: record.timedOut,
      killed: record.killed,
      readiness: record.readiness ? record.readiness.kind : null
    })
    if (history.length > historyLimit) history.splice(0, history.length - historyLimit)
  }

  function record(id) {
    return records.get(id) || null
  }

  /**
   * Start one process under supervision.
   *
   * @param {object} input
   * @param {string} input.command
   * @param {string[]} [input.args]
   * @param {string} input.cwd must be inside the verified workspace
   * @param {string} [input.class] PROCESS_CLASS
   * @param {number} [input.softTimeoutMs]
   * @param {number} [input.hardTimeoutMs]
   * @param {object} [input.readiness] `{ kind, port, url, pattern, file, timeoutMs }`
   * @param {string} [input.ownership] the episode that owns it
   * @param {boolean} [input.shell]
   * @param {object} [input.env]
   */
  function start(input = {}) {
    const command = String(input.command || '')
    if (!command) throw new ComputerUseError(CODES.COMMAND_INVALID, 'a supervised process needs a command')
    const args = Array.isArray(input.args) ? input.args.map(String) : []
    const cwd = input.cwd ? path.resolve(String(input.cwd)) : undefined
    if (!cwd) throw new ComputerUseError(CODES.WORKSPACE_UNAVAILABLE, 'a supervised process needs an explicit working directory')
    const processClass = Object.values(PROCESS_CLASS).includes(input.class) ? input.class : PROCESS_CLASS.FOREGROUND
    const softTimeoutMs = Number.isFinite(input.softTimeoutMs) ? Number(input.softTimeoutMs) : DEFAULT_SOFT_TIMEOUT_MS
    const hardTimeoutMs = Number.isFinite(input.hardTimeoutMs) ? Number(input.hardTimeoutMs) : DEFAULT_HARD_TIMEOUT_MS
    if (hardTimeoutMs < softTimeoutMs) {
      throw new ComputerUseError(CODES.COMMAND_INVALID, 'the hard timeout cannot be shorter than the soft timeout')
    }

    const child = spawn(command, args, {
      cwd,
      env: input.env ? { ...process.env, ...input.env } : process.env,
      shell: input.shell === true,
      windowsHide: true
    })
    const registration = registry.register({
      child,
      command,
      args,
      cwd,
      mode: processClass === PROCESS_CLASS.FOREGROUND ? 'foreground' : 'long_running',
      expectedLifetimeMs: processClass === PROCESS_CLASS.FOREGROUND ? hardTimeoutMs : null,
      ownership: input.ownership || 'episode',
      step: input.step === undefined ? null : input.step
    })

    const entry = {
      id: registration.id,
      child,
      command,
      args,
      cwd,
      class: processClass,
      ownership: input.ownership || 'episode',
      startedAt: now(),
      finishedAt: null,
      status: 'running',
      exitCode: null,
      signal: null,
      timedOut: false,
      killed: false,
      softTimeoutMs,
      hardTimeoutMs,
      softTimedOut: false,
      stdout: '',
      stderr: '',
      stdoutBytes: 0,
      stderrBytes: 0,
      /** The last moment this process produced output: liveness, not patience. */
      lastOutputAt: now(),
      outputEvents: 0,
      readiness: null,
      readinessCondition: input.readiness ? { ...input.readiness } : { kind: READINESS.NONE },
      exitPromise: null
    }
    records.set(entry.id, entry)

    const collect = (chunk, stream) => {
      const text = chunk.toString('utf8')
      entry.lastOutputAt = now()
      entry.outputEvents += 1
      if (stream === 'stdout') {
        entry.stdoutBytes += Buffer.byteLength(text)
        entry.stdout = appendBounded(entry.stdout, text, outputBytes)
      } else {
        entry.stderrBytes += Buffer.byteLength(text)
        entry.stderr = appendBounded(entry.stderr, text, outputBytes)
      }
    }
    child.stdout?.on('data', (chunk) => collect(chunk, 'stdout'))
    child.stderr?.on('data', (chunk) => collect(chunk, 'stderr'))
    if (input.stdin !== undefined && child.stdin) {
      try {
        child.stdin.write(String(input.stdin))
        child.stdin.end()
      } catch {
        /* the child closed stdin early */
      }
    }

    entry.exitPromise = new Promise((resolve) => {
      let settled = false
      const finish = (exitCode, signal) => {
        if (settled) return
        settled = true
        if (entry.timer) clearTimeout(entry.timer)
        entry.finishedAt = now()
        entry.durationMs = entry.finishedAt - entry.startedAt
        entry.exitCode = typeof exitCode === 'number' ? exitCode : null
        entry.signal = signal || null
        entry.status = entry.killed ? PROCESS_STATUS.KILLED : (entry.timedOut ? PROCESS_STATUS.TIMED_OUT : PROCESS_STATUS.EXITED)
        registry.settle(entry.id, { status: entry.status, exitCode: entry.exitCode, signal: entry.signal })
        remember(entry)
        resolve(entry)
      }
      child.on('error', (error) => {
        entry.stderr = appendBounded(entry.stderr, String(error && error.message ? error.message : error), outputBytes)
        entry.spawnError = String(error && error.message ? error.message : error)
        entry.status = PROCESS_STATUS.FAILED
        finish(null, null)
      })
      child.on('close', (code, signal) => finish(code, signal))

      // The hard timeout terminates an owned process. The soft timeout only
      // *reports*: a long build that is still producing output is working.
      entry.timer = setTimeout(() => {
        entry.timedOut = true
        try {
          child.kill('SIGKILL')
        } catch {
          /* already gone */
        }
      }, hardTimeoutMs)
      entry.timer.unref?.()
    })

    return entry
  }

  /** Keep at most `limit` bytes of a stream, dropping from the front. */
  function appendBounded(existing, chunk, limit) {
    const combined = existing + chunk
    if (Buffer.byteLength(combined) <= limit) return combined
    const buffer = Buffer.from(combined)
    return buffer.subarray(buffer.length - limit).toString('utf8')
  }

  /**
   * Wait for a process's readiness condition.
   *
   * The condition is checked, not slept through: a server that answers in 200 ms
   * is ready in 200 ms and a server that never answers is reported as not ready at
   * the bound, never waited on forever.
   *
   * @returns {Promise<{ok:boolean, kind:string, waitedMs:number, attempts:number, reason:string|null}>}
   */
  async function waitForReady(id, override = {}) {
    const entry = record(id)
    if (!entry) return { ok: false, kind: READINESS.NONE, waitedMs: 0, attempts: 0, reason: `no process ${id}` }
    const condition = { ...entry.readinessCondition, ...override }
    const kind = condition.kind || READINESS.NONE
    const timeoutMs = Number.isFinite(condition.timeoutMs) ? Number(condition.timeoutMs) : DEFAULT_READY_TIMEOUT_MS
    const pollMs = Number.isFinite(condition.pollMs) ? Number(condition.pollMs) : 120
    const startedAt = now()
    let attempts = 0

    if (kind === READINESS.NONE) {
      entry.readiness = { kind, ok: true, waitedMs: 0, at: now(), reason: null }
      return { ok: true, kind, waitedMs: 0, attempts: 0, reason: null }
    }

    for (;;) {
      attempts += 1
      if (entry.exitCode !== null && kind !== READINESS.EXIT) {
        const outcome = { ok: false, kind, waitedMs: now() - startedAt, attempts, reason: `the process exited (${entry.exitCode}) before it became ready` }
        entry.readiness = { ...outcome, at: now() }
        return outcome
      }
      let ready = false
      let reason = null
      try {
        ready = await checkReady(kind, condition, entry)
      } catch (error) {
        reason = String(error && error.message ? error.message : error)
      }
      if (ready) {
        const outcome = { ok: true, kind, waitedMs: now() - startedAt, attempts, reason: null }
        entry.readiness = { ...outcome, at: now() }
        return outcome
      }
      if (now() - startedAt >= timeoutMs) {
        const outcome = { ok: false, kind, waitedMs: now() - startedAt, attempts, reason: reason || `the readiness condition (${kind}) was not met within ${timeoutMs}ms` }
        entry.readiness = { ...outcome, at: now() }
        return outcome
      }
      await sleep(Math.min(pollMs, Math.max(1, timeoutMs - (now() - startedAt))))
    }
  }

  async function checkReady(kind, condition, entry) {
    switch (kind) {
      case READINESS.PORT:
        return portOpen(condition.port, condition.host || '127.0.0.1', Number.isFinite(condition.connectTimeoutMs) ? condition.connectTimeoutMs : 500)
      case READINESS.HTTP:
        return httpOk(condition.url, Number.isFinite(condition.httpTimeoutMs) ? condition.httpTimeoutMs : 1500)
      case READINESS.STDOUT:
        return condition.pattern ? new RegExp(condition.pattern, 'i').test(`${entry.stdout}\n${entry.stderr}`) : false
      case READINESS.FILE:
        return Boolean(condition.file) && fs.existsSync(path.resolve(String(condition.file)))
      case READINESS.EXIT:
        return entry.exitCode !== null
      default:
        return true
    }
  }

  /** Is anything listening on this port? */
  function portOpen(port, host, timeoutMs) {
    return new Promise((resolve) => {
      if (!Number.isInteger(port) || port <= 0) {
        resolve(false)
        return
      }
      const socket = net.connect({ port, host })
      let settled = false
      const done = (value) => {
        if (settled) return
        settled = true
        socket.destroy()
        resolve(value)
      }
      socket.setTimeout(timeoutMs)
      socket.on('connect', () => done(true))
      socket.on('timeout', () => done(false))
      socket.on('error', () => done(false))
    })
  }

  /** Does this URL answer? */
  function httpOk(url, timeoutMs) {
    return new Promise((resolve) => {
      if (!url) {
        resolve(false)
        return
      }
      let settled = false
      const done = (value) => {
        if (settled) return
        settled = true
        resolve(value)
      }
      try {
        const request = http.get(url, (response) => {
          response.resume()
          done(response.statusCode >= 200 && response.statusCode < 500)
        })
        request.setTimeout(timeoutMs, () => {
          request.destroy()
          done(false)
        })
        request.on('error', () => done(false))
      } catch {
        done(false)
      }
    })
  }

  /**
   * Wait for a foreground process to finish, bounded by its own timeouts.
   *
   * A process that is alive and has produced output recently is reported as
   * *progressing* rather than stalled, which is what keeps a 45-minute test run
   * from being mistaken for a hang.
   */
  async function waitForExit(id, waitOptions = {}) {
    const entry = record(id)
    if (!entry) return { ok: false, status: 'missing', reason: `no process ${id}` }
    const softTimeoutMs = Number.isFinite(waitOptions.softTimeoutMs) ? Number(waitOptions.softTimeoutMs) : entry.softTimeoutMs
    const onSoftTimeout = typeof waitOptions.onSoftTimeout === 'function' ? waitOptions.onSoftTimeout : null
    let softFired = false
    const startedAt = now()

    for (;;) {
      if (entry.exitCode !== null || entry.status !== 'running') {
        return {
          ok: entry.exitCode === 0 && !entry.timedOut && !entry.killed,
          status: entry.status,
          exitCode: entry.exitCode,
          signal: entry.signal,
          timedOut: entry.timedOut,
          killed: entry.killed,
          durationMs: entry.durationMs === undefined ? now() - entry.startedAt : entry.durationMs,
          waitedMs: now() - startedAt,
          output: outputOf(entry)
        }
      }
      const elapsed = now() - startedAt
      if (!softFired && elapsed >= softTimeoutMs) {
        softFired = true
        entry.softTimedOut = true
        const progressing = progressingNow(entry, waitOptions.stallAfterMs)
        if (!progressing) {
          // A soft timeout on a process that has stopped producing output is the
          // moment to terminate it: waiting longer cannot produce new information.
          kill(id, 'the process stopped making progress within its soft timeout')
          continue
        }
        if (onSoftTimeout) onSoftTimeout({ id, elapsedMs: elapsed, progressing: true })
      }
      await sleep(Number.isFinite(waitOptions.pollMs) ? Number(waitOptions.pollMs) : 100)
    }
  }

  /** Is this process alive and still producing output? */
  function progressingNow(entry, stallAfterMs) {
    if (!entry || entry.status !== 'running') return false
    const window = Number.isFinite(stallAfterMs) ? Number(stallAfterMs) : 60_000
    return now() - entry.lastOutputAt <= window
  }

  /** The bounded evidence one process leaves behind. */
  function outputOf(entry) {
    const combined = `${entry.stdout}${entry.stderr}`
    const truncated = truncateOutput(combined, { maxBytes: outputBytes })
    return {
      text: truncated.text,
      bytes: truncated.bytes,
      originalBytes: truncated.originalBytes,
      truncated: truncated.truncated,
      errorRegion: truncated.errorRegion,
      stdoutBytes: entry.stdoutBytes,
      stderrBytes: entry.stderrBytes,
      outputEvents: entry.outputEvents,
      lastOutputAt: entry.lastOutputAt
    }
  }

  /** Stop one owned process. Refuses anything the runtime does not own. */
  function kill(id, reason = 'supervisor request') {
    const entry = record(id)
    if (!entry) return { ok: false, reason: 'not_owned', id }
    entry.killed = true
    entry.killReason = String(reason)
    try {
      entry.child.kill('SIGKILL')
    } catch (error) {
      entry.status = PROCESS_STATUS.FAILED
      return { ok: false, reason: 'kill_failed', id, error: String(error && error.message ? error.message : error) }
    }
    return { ok: true, id, reason }
  }

  /** Stop every process this supervisor owns. */
  function dispose(reason = 'episode teardown') {
    const ids = [...records.keys()].filter((id) => record(id) && record(id).status === 'running')
    const results = ids.map((id) => kill(id, reason))
    return { attempted: ids.length, stopped: results.filter((entry) => entry.ok).length, results }
  }

  /** Release a background process the contract asked to keep alive. */
  function release(id, reason = 'kept alive by contract') {
    const entry = record(id)
    if (!entry) return null
    entry.released = true
    entry.releaseReason = String(reason)
    return registry.release(id)
  }

  return {
    PROCESS_CLASS,
    READINESS,
    registry,
    start,
    waitForReady,
    waitForExit,
    progressingNow,
    kill,
    dispose,
    release,
    record,
    /** Every process this supervisor currently owns (bounded). */
    running() {
      return [...records.values()].filter((entry) => entry.status === 'running').map((entry) => ({
        id: entry.id,
        command: entry.command,
        args: entry.args.slice(),
        cwd: entry.cwd,
        class: entry.class,
        startedAt: entry.startedAt,
        lastOutputAt: entry.lastOutputAt,
        outputEvents: entry.outputEvents,
        progressing: progressingNow(entry)
      }))
    },
    /** The settled history, bounded. */
    finished() {
      return history.slice()
    },
    ownedCount() {
      return [...records.values()].filter((entry) => entry.status === 'running').length
    },
    /** The heartbeat line the plan asks for during a long wait. */
    heartbeat() {
      const running = [...records.values()].filter((entry) => entry.status === 'running')
      return {
        at: now(),
        processes: running.length,
        currentCommand: running.length ? running[running.length - 1].command : null,
        lastOutputAgoMs: running.length ? now() - running[running.length - 1].lastOutputAt : null,
        progressing: running.every((entry) => progressingNow(entry))
      }
    }
  }
}

module.exports = { createProcessSupervisor, PROCESS_CLASS, READINESS }
