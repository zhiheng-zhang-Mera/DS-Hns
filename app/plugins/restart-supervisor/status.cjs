'use strict'

/**
 * DS-Hns: `restart_status` — the formal, persisted record of a restart.
 *
 * A restart is the one operation in this product that destroys the memory it is running in: the
 * process that asked for it is gone before the answer arrives. So the status cannot live in a
 * variable, and it cannot be a log line — after the relaunch, "did the work continue?" is a question
 * somebody asks, and the answer has to have been written down *before* the process that knew it left.
 *
 * This module owns that file. Both halves of the restart authority use it — the in-process plugin and
 * the out-of-process companion — because both can be the executor: the deployed shape delegates to the
 * companion, a deployment with no companion executes in process, and neither may be the only one that
 * can describe what happened. Only one of them executes at a time (the restart lock), so the file has
 * one writer per restart.
 *
 * ## What it records, and why each field is not a log line
 *
 * | field | the question it answers |
 * | --- | --- |
 * | `reasonCode` / `reasonSummary` | *why* did this happen — a person reading it tomorrow needs the cause, not "restart 3 of 3" |
 * | `requestedAt` | when the request was accepted (this is the clock a support report wants) |
 * | `startedAt` / `stoppingAt` / `relaunchedAt` | how long each half took, so a slow restart is visible as a slow *stage* |
 * | `completedAt` | whether the restart finished at all, or was interrupted by the very thing it was doing |
 * | `phase` | what stage an interrupted restart reached — the difference between "stopped and came back" and "stopped" |
 * | `recovery.process` | the process came back (the readiness gates passed) |
 * | `recovery.task` | the interrupted work re-entered an executable state |
 * | `recovery.semantic` | it continues from what was actually done, rather than from the beginning |
 * | `recovery.failedReason` | why recovery did not reach the level it was asked for |
 * | `history` | the ring a loop is visible in — three restarts inside one window is a different story from three in a week |
 *
 * The three recovery kinds are kept apart on purpose. "The process restarted" and "the task resumed"
 * are different claims, and reporting the first as the second is the false success this whole file
 * exists to prevent.
 */

const fs = require('node:fs')
const path = require('node:path')

/** The phases a restart passes through, in order. `phase` is always one of these. */
const STATUS_PHASES = Object.freeze({
  IDLE: 'IDLE',
  REQUESTED: 'REQUESTED',
  REFUSED: 'REFUSED',
  CANCELLED: 'CANCELLED',
  CONTINUITY: 'CONTINUITY',
  BOUNDARY: 'BOUNDARY',
  STOPPING: 'STOPPING',
  STOPPED: 'STOPPED',
  RELAUNCHING: 'RELAUNCHING',
  READINESS: 'READINESS',
  RECOVERY: 'RECOVERY',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED'
})

/** How far recovery got. Ordered: a later value is a stronger claim than an earlier one. */
const RECOVERY_RESULTS = Object.freeze({
  NONE: 'NONE',
  FAILED: 'FAILED',
  PROCESS_ONLY: 'PROCESS_ONLY',
  PARTIAL: 'PARTIAL',
  FULL: 'FULL'
})

const RECOVERY_RANK = Object.freeze({
  NONE: 0,
  FAILED: 0,
  PROCESS_ONLY: 1,
  PARTIAL: 2,
  FULL: 3
})

/** The terminal phases: a status in one of these is not still happening. */
const TERMINAL_PHASES = Object.freeze([STATUS_PHASES.COMPLETED, STATUS_PHASES.FAILED, STATUS_PHASES.REFUSED, STATUS_PHASES.CANCELLED])

/** The default ring size: enough to see a loop, bounded so a flapping machine cannot grow the file. */
const DEFAULT_HISTORY_LIMIT = 50

function clampHistory(limit) {
  const wanted = Number(limit)
  if (!Number.isFinite(wanted) || wanted <= 0) return DEFAULT_HISTORY_LIMIT
  return Math.min(500, Math.floor(wanted))
}

function isTerminal(phase) {
  return TERMINAL_PHASES.includes(String(phase))
}

/**
 * Write JSON so a reader never sees half a file.
 *
 * A restart status that is truncated is worse than a missing one: "the file says STOPPING" and "the
 * file is not valid JSON" lead a person to opposite conclusions. Rename is atomic on every platform
 * this product runs on.
 */
function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp-${process.pid}`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, file)
  return file
}

function readJson(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * Judge the three recovery kinds from what the restart's own stages reported.
 *
 * `process` is the readiness verdict, `task` and `semantic` come from Core continuity (the layer that
 * owns the tasks, asked through `afterRestart`). A continuity layer that is not wired is *unknown*,
 * never "fine": the result is `PROCESS_ONLY` and the reason says so.
 */
function judgeRecovery({ process = null, task = null, semantic = null } = {}) {
  if (process && process.ok !== true) {
    return {
      result: RECOVERY_RESULTS.FAILED,
      process: process ? { ok: false, reason: process.reason || null, ms: process.ms || null } : null,
      task: null,
      semantic: null,
      failedReason: (process && (process.reason || process.detail)) || 'the process did not come back'
    }
  }
  const processPart = process ? { ok: true, reason: null, ms: process.ms || null, gates: process.gates || null } : { ok: false, reason: null, ms: null, gates: null }
  if (!task && !semantic) {
    return {
      result: RECOVERY_RESULTS.PROCESS_ONLY,
      process: processPart,
      task: null,
      semantic: null,
      failedReason: 'no continuity layer reported on the interrupted work, so only the process is known to have recovered'
    }
  }
  const taskPart = task
    ? {
      ok: task.ok === true,
      resumed: Array.isArray(task.resumed) ? task.resumed.slice(0, 50) : [],
      skipped: Array.isArray(task.skipped) ? task.skipped.slice(0, 50) : [],
      alreadyComplete: Array.isArray(task.alreadyComplete) ? task.alreadyComplete.slice(0, 50) : [],
      reason: task.reason || null
    }
    : null
  const semanticPart = semantic
    ? { ok: semantic.ok === true, from: semantic.from || null, detail: semantic.detail || null, reason: semantic.reason || null }
    : null
  const taskOk = taskPart ? taskPart.ok : false
  const semanticOk = semanticPart ? semanticPart.ok : false
  if (taskOk && semanticOk) {
    return { result: RECOVERY_RESULTS.FULL, process: processPart, task: taskPart, semantic: semanticPart, failedReason: null }
  }
  if (taskOk || semanticOk) {
    return {
      result: RECOVERY_RESULTS.PARTIAL,
      process: processPart,
      task: taskPart,
      semantic: semanticPart,
      failedReason: semanticPart && semanticPart.ok !== true
        ? (semanticPart.reason || 'the task resumed, but it could not be confirmed to continue from the recorded state')
        : (taskPart && taskPart.reason) || 'the interrupted work did not re-enter an executable state'
    }
  }
  return {
    result: RECOVERY_RESULTS.FAILED,
    process: processPart,
    task: taskPart,
    semantic: semanticPart,
    failedReason: (taskPart && taskPart.reason) || (semanticPart && semanticPart.reason) || 'the interrupted work was not recovered'
  }
}

/**
 * @param {object} input
 * @param {string} input.stateDir where the status file lives (shared with the companion)
 * @param {Function} [input.now]
 * @param {Function} [input.log]
 * @param {object} [input.config] `{ historyLimit, processLabel }`
 */
function createRestartStatus(input = {}) {
  const stateDir = String(input.stateDir || path.join(process.cwd(), 'data', 'state', 'restart-supervisor'))
  const now = typeof input.now === 'function' ? input.now : () => Date.now()
  const log = typeof input.log === 'function' ? input.log : () => {}
  const historyLimit = clampHistory(input.config && input.config.historyLimit)
  const file = path.join(stateDir, 'restart_status.json')

  /** Read what the previous process wrote, so a restarted plugin is not blind to the last attempt. */
  const previous = readJson(file)
  let current = previous && previous.current && typeof previous.current === 'object' ? previous.current : null
  let history = previous && Array.isArray(previous.history) ? previous.history.slice(-historyLimit) : []
  let counter = previous && Number.isFinite(Number(previous.counter)) ? Number(previous.counter) : history.length
  /** What this process observed about the last attempt before it was interrupted. */
  const recoveredFromInterruption = Boolean(current && !isTerminal(current.phase))

  function persist() {
    try {
      writeJsonAtomic(file, {
        version: 1,
        updatedAt: now(),
        /** The status a reader shows first. */
        current,
        /** Newest last, bounded: the ring a loop is visible in. */
        history: history.slice(-historyLimit),
        counter,
        /** Which half wrote it last, so a support report can tell the plugin from the companion. */
        writer: input.writer || null
      })
      lastWriteAt = now()
    } catch (error) {
      // A status that cannot be written must not stop a restart: the restart is the job. The failure
      // is reported through the caller's own journal instead.
      log(`restart status could not be written to ${file}: ${error && error.message ? error.message : error}`)
    }
    return current
  }

  let lastWriteAt = 0

  /**
   * Take the file back into memory when somebody else has written it since we did.
   *
   * Two processes share this file by design: the plugin records the *request*, and the companion —
   * which is the half that survives the application — records the execution. Without this, the
   * companion's in-memory copy (read at its start, when the file did not exist yet) would complete a
   * restart it never adopted, and the request the plugin wrote would be overwritten by a fresh entry
   * with no `requestedAt` of its own.
   */
  function refreshFromDisk() {
    const onDisk = readJson(file)
    if (!onDisk) return false
    const updatedAt = Number(onDisk.updatedAt || 0)
    if (updatedAt <= lastWriteAt) return false
    current = onDisk.current && typeof onDisk.current === 'object' ? onDisk.current : current
    if (Array.isArray(onDisk.history)) history = onDisk.history.slice(-historyLimit)
    if (Number.isFinite(Number(onDisk.counter))) counter = Number(onDisk.counter)
    lastWriteAt = updatedAt
    return true
  }

  function nextId(at) {
    counter += 1
    return `restart-${at}-${counter}`
  }

  /** A request that the policy refused: recorded, because "we tried and were told no" is history too. */
  function refuse({ request = {}, code, reason, refusedAt = null, by = null } = {}) {
    const at = Number.isFinite(refusedAt) ? refusedAt : now()
    const entry = {
      id: `refused-${at}-${counter + 1}`,
      phase: STATUS_PHASES.REFUSED,
      ok: false,
      reasonCode: String(request.reasonCode || 'UNKNOWN'),
      reasonSummary: request.reasonSummary || null,
      requestedBy: request.requestedBy || by || 'unknown',
      mode: request.mode || null,
      requestedAt: at,
      startedAt: null,
      stoppingAt: null,
      relaunchedAt: null,
      completedAt: at,
      code: code ? String(code) : null,
      detail: reason ? String(reason) : null,
      counted: false,
      recovery: { result: RECOVERY_RESULTS.NONE, process: null, task: null, semantic: null, failedReason: null },
      phases: [{ phase: STATUS_PHASES.REFUSED, at, detail: reason ? String(reason) : null }]
    }
    current = entry
    history = [...history, { ...entry, phases: undefined }].slice(-historyLimit)
    persist()
    return entry
  }

  /** A request that was accepted: this is where `requestedAt` is set. */
  function begin({ request = {}, executor = null, by = null, adopt = false } = {}) {
    refreshFromDisk()
    /**
     * Adopt a request that is already in flight.
     *
     * The deployed shape is two processes: the plugin accepts the request and writes it, the
     * companion executes it. The companion must continue *that* record — its `requestedAt` is when a
     * person asked, and an execution that reset it would report a restart nobody requested.
     */
    if (adopt && current && !isTerminal(current.phase)) {
      const at = now()
      if (executor) current.executor = executor
      current.phase = STATUS_PHASES.REQUESTED
      current.phases = [...(current.phases || []), { phase: STATUS_PHASES.REQUESTED, at, detail: `executed by ${executor || 'the supervisor'}` }].slice(-40)
      current.updatedAt = at
      persist()
      return current
    }
    const at = now()
    counter += 1
    const entry = {
      id: nextId(at),
      phase: STATUS_PHASES.REQUESTED,
      ok: null,
      reasonCode: String(request.reasonCode || 'UNKNOWN'),
      reasonSummary: request.reasonSummary || null,
      requestedBy: request.requestedBy || by || 'unknown',
      mode: request.mode || null,
      executor: executor || request.executor || null,
      requestedAt: at,
      startedAt: at,
      stoppingAt: null,
      relaunchedAt: null,
      completedAt: null,
      code: null,
      detail: null,
      counted: true,
      recovery: { result: RECOVERY_RESULTS.NONE, process: null, task: null, semantic: null, failedReason: null },
      phases: [{ phase: STATUS_PHASES.REQUESTED, at, detail: request.reasonSummary || null }]
    }
    current = entry
    persist()
    return entry
  }

  /** Move the current restart to a stage. A stage recorded after the fact is not rewritten. */
  function phase(name, detail = null) {
    const wanted = String(name)
    refreshFromDisk()
    if (!current) return null
    if (!Object.values(STATUS_PHASES).includes(wanted)) return null
    const at = now()
    // The three timing fields a person asks about are picked out of the phase trail rather than
    // passed in beside it, so the trail and the summary cannot disagree.
    if (wanted === STATUS_PHASES.STOPPING && current.stoppingAt === null) current.stoppingAt = at
    if (wanted === STATUS_PHASES.RELAUNCHING) current.relaunchedAt = at
    current.phase = wanted
    current.phases = [...(current.phases || []), { phase: wanted, at, detail: detail ? String(detail) : null }].slice(-40)
    current.updatedAt = at
    persist()
    return current
  }

  /**
   * Finish the restart.
   *
   * `process` is the readiness verdict, `task`/`semantic` are Core continuity's answers. The
   * `recovery` block is computed here so every writer of a status judges it the same way.
   */
  function complete({ ok, detail = null, code = null, process = null, task = null, semantic = null, counted = true, ms = null, at = null } = {}) {
    refreshFromDisk()
    if (!current) return null
    const finishedAt = Number.isFinite(at) ? at : now()
    const success = ok === true
    current.phase = success ? STATUS_PHASES.COMPLETED : STATUS_PHASES.FAILED
    current.ok = success
    current.code = code ? String(code) : null
    current.detail = detail ? String(detail) : null
    current.counted = counted !== false
    current.completedAt = finishedAt
    current.durationMs = Number.isFinite(ms) ? ms : (current.startedAt !== null ? finishedAt - current.startedAt : null)
    current.updatedAt = finishedAt
    current.recovery = success
      ? judgeRecovery({ process, task, semantic })
      : {
        result: RECOVERY_RESULTS.FAILED,
        process: process ? { ok: false, reason: (process && process.reason) || detail || null, ms: process && process.ms ? process.ms : null, gates: process && process.gates ? process.gates : null } : null,
        task: null,
        semantic: null,
        failedReason: (process && process.reason) || detail || code || 'the restart did not complete'
      }
    current.phases = [...(current.phases || []), { phase: current.phase, at: finishedAt, detail: current.detail }].slice(-40)
    history = [...history, { ...current, phases: undefined }].slice(-historyLimit)
    persist()
    return current
  }

  /** Everything a surface shows. */
  function describe(atMs = now()) {
    refreshFromDisk()
    const at = Number.isFinite(atMs) ? atMs : now()
    const last = current
    return {
      /** The formal name the requirement asks for, so a consumer can key off it rather than off a nickname. */
      status: 'restart_status',
      file,
      phase: last ? last.phase : STATUS_PHASES.IDLE,
      inFlight: Boolean(last && !isTerminal(last.phase)),
      /** True when this process started after an interrupted restart: the reason the file is read. */
      recoveredFromInterruption,
      at,
      last: last ? { ...last } : null,
      /** What the caller needs, flattened: a panel should not have to walk the trail. */
      reason: last ? { code: last.reasonCode, summary: last.reasonSummary, requestedBy: last.requestedBy, mode: last.mode } : null,
      requestedAt: last ? last.requestedAt : null,
      startedAt: last ? last.startedAt : null,
      completedAt: last ? last.completedAt : null,
      recoveryResult: last && last.recovery ? last.recovery.result : RECOVERY_RESULTS.NONE,
      failedRecoveryReason: last && last.recovery ? last.recovery.failedReason : null,
      /** The honest summary sentence, so three surfaces cannot phrase it differently. */
      summary: last
        ? `${last.ok === true ? 'restart completed' : last.ok === false ? 'restart failed' : `restart ${String(last.phase).toLowerCase()}`} (${last.reasonCode}${last.completedAt ? `, completed ${new Date(last.completedAt).toISOString()}` : ''}); recovery ${last.recovery ? last.recovery.result : RECOVERY_RESULTS.NONE}`
        : 'no restart has been recorded yet',
      history: history.map((entry) => ({
        id: entry.id,
        phase: entry.phase,
        ok: entry.ok,
        reasonCode: entry.reasonCode,
        reasonSummary: entry.reasonSummary,
        requestedAt: entry.requestedAt,
        completedAt: entry.completedAt,
        durationMs: entry.durationMs || null,
        code: entry.code || null,
        recoveryResult: entry.recovery ? entry.recovery.result : RECOVERY_RESULTS.NONE
      })),
      /** The ring is bounded, so the count is a floor rather than a total — say which one it is. */
      historyCount: history.length,
      historyLimit
    }
  }

  function reset(reason = 'reset by a person') {
    const at = now()
    const cleared = current
    current = null
    history = [...history, { id: `reset-${at}`, phase: STATUS_PHASES.IDLE, ok: null, reasonCode: 'RESET', reasonSummary: reason, requestedAt: at, completedAt: at, recovery: { result: RECOVERY_RESULTS.NONE } }].slice(-historyLimit)
    persist()
    return { ok: true, at, cleared: cleared ? cleared.id : null }
  }

  return {
    file,
    phases: STATUS_PHASES,
    results: RECOVERY_RESULTS,
    begin,
    phase,
    complete,
    refuse,
    describe,
    reset,
    /** The entry in flight, if any: a caller that took over the file can see what it interrupted. */
    interrupted: () => (current && !isTerminal(current.phase) ? { ...current } : null),
    judgeRecovery
  }
}

module.exports = {
  createRestartStatus,
  STATUS_PHASES,
  RECOVERY_RESULTS,
  RECOVERY_RANK,
  TERMINAL_PHASES,
  DEFAULT_HISTORY_LIMIT,
  isTerminal,
  judgeRecovery,
  writeJsonAtomic,
  readJson
}
