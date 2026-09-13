'use strict'

/**
 * A scripted project: a real directory on disk, plus a command table that answers
 * with predetermined outcomes.
 *
 * Half of the engineering runtime's behaviour is about *what happens after a
 * failure*, and reproducing a timeout, a dependency outage or a flaky suite with a
 * real process is slow and non-deterministic. The scenario harness keeps the real
 * filesystem — mutations, hashes, drift and the completion gate all run for real —
 * and replaces only the command execution, so the tests stay honest about the
 * parts that matter.
 */

const fs = require('node:fs')
const path = require('node:path')

const { createProcessSupervisor, PROCESS_CLASS, READINESS } = require('../../app/engineering/process.cjs')

/**
 * Build a supervisor whose `start`/`waitForExit` are scripted.
 *
 * @param {object} [options]
 * @param {Function} [options.script] `(invocation, index) => outcome`
 *   where `invocation` is `{ command, args, cwd, class, step }` and the outcome is
 *   `{ exitCode, stdout, stderr, timedOut, durationMs, alive }`.
 * @param {Function} [options.now]
 * @param {number} [options.maxCommands]
 */
function createScriptedSupervisor(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const script = typeof options.script === 'function' ? options.script : () => ({ exitCode: 0 })
  const invocations = []
  const records = new Map()
  let sequence = 0

  function start(input = {}) {
    sequence += 1
    const invocation = {
      index: sequence,
      command: String(input.command || ''),
      args: Array.isArray(input.args) ? input.args.map(String) : [],
      cwd: input.cwd || null,
      class: input.class || PROCESS_CLASS.FOREGROUND,
      step: input.step === undefined ? null : input.step
    }
    const outcome = script(invocation) || { exitCode: 0 }
    invocations.push(invocation)
    const id = `scripted-${sequence}`
    records.set(id, {
      id,
      command: invocation.command,
      args: invocation.args,
      cwd: invocation.cwd,
      class: invocation.class,
      ownership: input.ownership || 'episode',
      startedAt: now(),
      status: outcome.alive ? 'running' : 'exited',
      exitCode: outcome.alive ? null : (Number.isInteger(outcome.exitCode) ? outcome.exitCode : 0),
      signal: null,
      timedOut: outcome.timedOut === true,
      killed: false,
      durationMs: Number.isFinite(outcome.durationMs) ? outcome.durationMs : 5,
      output: {
        text: `${outcome.stdout || ''}${outcome.stderr || ''}`,
        bytes: Buffer.byteLength(`${outcome.stdout || ''}${outcome.stderr || ''}`),
        originalBytes: Buffer.byteLength(`${outcome.stdout || ''}${outcome.stderr || ''}`),
        truncated: false,
        errorRegion: outcome.stderr || null,
        stdoutBytes: Buffer.byteLength(outcome.stdout || ''),
        stderrBytes: Buffer.byteLength(outcome.stderr || '')
      }
    })
    return records.get(id)
  }

  async function waitForExit(id) {
    const entry = records.get(id)
    if (!entry) return { ok: false, status: 'missing', exitCode: null, timedOut: false, killed: false, durationMs: 0, output: { text: '', bytes: 0, originalBytes: 0, truncated: false } }
    const ok = entry.exitCode === 0 && !entry.timedOut && !entry.killed
    return {
      ok,
      status: entry.status,
      exitCode: entry.exitCode,
      signal: entry.signal,
      timedOut: entry.timedOut,
      killed: entry.killed,
      durationMs: entry.durationMs,
      waitedMs: entry.durationMs,
      output: entry.output
    }
  }

  return {
    PROCESS_CLASS,
    READINESS,
    registry: {
      snapshot: () => ({ ownedCount: records.size, owned: [...records.values()].map((entry) => ({ id: entry.id })), ceiling: 8, atCapacity: false, finished: [], hungSuspected: [] }),
      get ownedCount() {
        return [...records.values()].filter((entry) => entry.status === 'running').length
      },
      release: () => null
    },
    start,
    waitForExit,
    progressingNow: () => true,
    kill: (id) => {
      const entry = records.get(id)
      if (!entry) return { ok: false, reason: 'not_owned', id }
      entry.killed = true
      entry.status = 'killed'
      return { ok: true, id }
    },
    dispose: () => ({ attempted: 0, stopped: 0, results: [] }),
    release: () => null,
    record: (id) => records.get(id) || null,
    running: () => [...records.values()].filter((entry) => entry.status === 'running').map((entry) => ({ id: entry.id, command: entry.command })),
    finished: () => [...records.values()].map((entry) => ({ id: entry.id, command: entry.command, exitCode: entry.exitCode, durationMs: entry.durationMs, timedOut: entry.timedOut })),
    ownedCount: () => [...records.values()].filter((entry) => entry.status === 'running').length,
    heartbeat: () => ({ at: now(), processes: 0, currentCommand: null, lastOutputAgoMs: null, progressing: true }),
    invocations
  }
}

/**
 * Answer one command by matching its text.
 *
 * @param {object} table `{ 'npm run test': { exitCode: 1, stderr: '...' } }`
 * @param {object} [fallback] the outcome for an unmatched command
 */
function commandTable(table, fallback = { exitCode: 0 }) {
  return (invocation) => {
    const line = `${invocation.command} ${invocation.args.join(' ')}`.trim()
    for (const [pattern, outcome] of Object.entries(table)) {
      if (line.includes(pattern)) {
        return typeof outcome === 'function' ? outcome(invocation) : outcome
      }
    }
    return typeof fallback === 'function' ? fallback(invocation) : fallback
  }
}

/**
 * A test-suite outcome that fails while a given predicate holds, and passes after.
 *
 * This is how "the failure is real and the fix is real" is scripted without
 * mocking the filesystem: the predicate reads the actual file.
 */
function suiteFollowsFile(file, predicates) {
  return () => {
    let content = ''
    try {
      content = fs.readFileSync(path.resolve(file), 'utf8')
    } catch {
      content = ''
    }
    for (const [pattern, outcome] of Object.entries(predicates)) {
      if (content.includes(pattern)) return outcome
    }
    return { exitCode: 0, stdout: '# tests 2\n# pass 2\n# fail 0\n' }
  }
}

module.exports = { createScriptedSupervisor, commandTable, suiteFollowsFile }
