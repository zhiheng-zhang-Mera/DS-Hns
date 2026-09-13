'use strict'

/**
 * Computer Use Runtime: execution log.
 *
 * One JSON line per step, with the fields a post-mortem needs: step number,
 * action, target, the pre-state summary, how long stabilization took, the
 * result, the verification that decided it and the retry count. The log is
 * evidence, so it records what was observed and what was verified — never an
 * application profile, never a latency model.
 *
 * A long run must be diagnosable *8 hours in* and must not grow without bound, so:
 *
 *  - the file rotates by size, and the rotated files are bounded in count;
 *  - the structured fields a post-mortem needs (`runId`, `taskId`, `stepId`,
 *    `controller`, `action`, `verdict`, `duration`, `retry`, `reasonCode`) are on
 *    every line;
 *  - repetitive dumps are *summarized* rather than re-written (a per-step
 *    observation is a summary, not the tree);
 *  - errors, terminal evidence and important recovery events are always kept.
 *
 * Screenshots are written only in debug/audit mode, on a
 * failing run, or when the caller explicitly asks for one. Otherwise a capture
 * is used and dropped, so a normal run does not accumulate a visual history.
 */

const fs = require('node:fs')
const path = require('node:path')

const { SCREENSHOT_RETENTION, STEP_RESULTS } = require('./constants.cjs')
const { redactDetails } = require('./errors.cjs')

/** Rotate when the current file passes this; keep at most `maxFiles` of them. */
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024
const DEFAULT_MAX_FILES = 5

function createExecutionLog(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const mode = options.mode || 'normal'
  const retention = options.retention || SCREENSHOT_RETENTION.FAILURE
  const dir = options.dir === undefined ? path.join(__dirname, '..', '..', 'logs', 'computer-use') : options.dir
  const taskId = options.taskId || `cu-${now()}`
  const runId = options.runId || taskId
  const maxEntries = Number.isInteger(options.maxEntries) ? options.maxEntries : 2000
  const maxBytes = Number.isFinite(options.maxBytes) ? Number(options.maxBytes) : DEFAULT_MAX_BYTES
  const maxFiles = Number.isInteger(options.maxFiles) && options.maxFiles > 0 ? options.maxFiles : DEFAULT_MAX_FILES
  const entries = []
  const screenshots = []
  let stream = null
  let streamPath = null
  let written = 0
  let rotations = 0

  if (dir) {
    try {
      fs.mkdirSync(dir, { recursive: true })
      streamPath = path.join(dir, `${fileName(taskId)}.jsonl`)
      stream = openStream(streamPath)
    } catch {
      stream = null
      streamPath = null
    }
  }

  function fileName(value) {
    return String(value).replace(/[^a-zA-Z0-9._-]/g, '_')
  }

  /**
   * Open (and create) the active log file.
   *
   * The file is created *synchronously* and every line is appended
   * synchronously. That is deliberate: an execution log is evidence, and evidence
   * that sits in a stream buffer when the process dies is not evidence. It also
   * makes the size ceiling real — a buffered stream leaves the file on disk
   * shorter than the bytes already written, so a rotation check against it is
   * simply wrong.
   */
  function openStream(file) {
    try {
      if (!fs.existsSync(file)) fs.writeFileSync(file, '')
      written = fs.statSync(file).size
    } catch {
      written = 0
    }
    // A sentinel: the writer only needs to know whether a file path is active.
    return { path: file, ended: false }
  }

  /**
   * Size-based rotation.
   *
   * The oldest rotated file is removed once the count ceiling is reached, so a
   * run that lasts hours cannot fill the disk with its own history.
   */
  function rotate() {
    if (!dir || !streamPath) return false
    try {
      if (stream) {
        try {
          stream.end()
        } catch {}
        stream = null
      }
      // A file that was never created cannot be renamed. The active path is
      // created eagerly (see `openStream`), but a rotation whose file has already
      // been removed must not be able to break rotation for the rest of the run.
      if (!fs.existsSync(streamPath)) {
        stream = openStream(streamPath)
        return false
      }
      const stamp = Math.round(now())
      fs.renameSync(streamPath, path.join(dir, `${fileName(taskId)}.${stamp}.jsonl`))
      rotations += 1
      prune()
      stream = openStream(streamPath)
      return true
    } catch {
      // Rotation failing must not stop logging: reopen the original file.
      try {
        stream = openStream(streamPath)
      } catch {
        stream = null
      }
      return false
    }
  }

  function prune() {
    try {
      const prefix = `${fileName(taskId)}.`
      const rotated = fs.readdirSync(dir)
        .filter((name) => name.startsWith(prefix) && name.endsWith('.jsonl'))
        .sort()
      while (rotated.length > maxFiles - 1) {
        const oldest = rotated.shift()
        try {
          fs.unlinkSync(path.join(dir, oldest))
        } catch {}
      }
    } catch {}
  }

  function write(kind, payload) {
    const record = { at: now(), taskId, runId, kind, ...redactDetails(payload) }
    entries.push(record)
    if (entries.length > maxEntries) entries.splice(0, entries.length - maxEntries)
    if (stream) {
      try {
        const line = `${JSON.stringify(record)}\n`
        // The ceiling is enforced against the file that is actually on disk, not
        // against this process's own arithmetic: a restarted process or a second
        // writer makes an internal counter lie.
        const onDisk = fileSize()
        if (onDisk !== null) written = onDisk
        // Rotate *before* the line that would cross the ceiling, so no single
        // file ever holds more than `maxBytes` (a line is atomic here).
        if (written > 0 && written + Buffer.byteLength(line) > maxBytes) rotate()
        if (stream) {
          // Synchronous on purpose: a line that is buffered when the runtime dies
          // is a line the post-mortem never sees.
          fs.appendFileSync(stream.path, line)
          written += Buffer.byteLength(line)
        }
      } catch {
        stream = null
      }
    }
    return record
  }

  /** The active file's real size, or null when it cannot be read. */
  function fileSize() {
    if (!streamPath) return null
    try {
      return fs.statSync(streamPath).size
    } catch {
      return null
    }
  }

  /**
   * The per-step record. Missing fields are recorded as `null`
   * rather than omitted, because "no verification happened" is exactly the
   * condition the log wants to be visible.
   *
   * The structured fields a post-mortem needs are all present: `runId`, `taskId`,
   * `stepId`, `controller`, `action`, `verdict`, `duration`, `retry`, `reasonCode`.
   */
  function step(record = {}) {
    const error = record.error && typeof record.error === 'object'
      ? { code: record.error.code || null, message: record.error.message || null, retryable: record.error.retryable === true }
      : null
    const entry = {
      step: Number.isInteger(record.step) ? record.step : entries.filter((item) => item.kind === 'step').length + 1,
      stepId: record.stepId || (Number.isInteger(record.step) ? `s${record.step}` : null),
      state: record.state || null,
      action: record.action || null,
      actionType: record.actionType || null,
      description: record.description || null,
      target: record.target || null,
      channel: record.channel || null,
      controller: record.controller || null,
      preState: record.preState || null,
      stabilizationMs: numberOrNull(record.stabilizationMs),
      graceMs: numberOrNull(record.graceMs),
      waitMs: numberOrNull(record.waitMs),
      durationMs: numberOrNull(record.durationMs),
      result: record.result || STEP_RESULTS.UNKNOWN,
      // `verdict` is the word the post-mortem greps for; it mirrors `result` for a
      // step and carries the verification verdict when there is one.
      verdict: record.verdict || (record.verification && record.verification.verdict) || record.result || STEP_RESULTS.UNKNOWN,
      verification: record.verification || null,
      verificationKind: record.verificationKind || null,
      evidence: record.evidence || null,
      evidenceGrade: record.evidenceGrade || null,
      evidenceAccepted: record.evidenceAccepted === undefined ? null : Boolean(record.evidenceAccepted),
      retryCount: Number.isInteger(record.retryCount) ? record.retryCount : 0,
      // A `retry` field is recorded by name as well as the count.
      retry: Number.isInteger(record.retryCount) ? record.retryCount : 0,
      attempts: Array.isArray(record.attempts) ? record.attempts : [],
      reasonCode: record.reasonCode || (error ? error.code : null),
      error,
      coordinateFallback: Boolean(record.coordinateFallback),
      resolvedPoint: record.resolvedPoint || null,
      notes: record.notes || null
    }
    return write('step', entry)
  }

  function event(type, payload = {}) {
    return write('event', { type, ...payload })
  }

  /**
   * A *once* summary for a repetitive condition.
   *
   * A long run observes the same degraded source on every step; writing that line
   * two thousand times is how a log becomes unreadable. Repeats are counted and
   * reported once.
   */
  const repeats = new Map()
  function repeated(key, payload = {}, { limit = 5 } = {}) {
    const name = String(key)
    const seen = repeats.get(name) || { count: 0, first: now(), last: null }
    seen.count += 1
    seen.last = now()
    repeats.set(name, seen)
    if (seen.count > limit) return null
    return write('event', { type: 'repeated', key: name, occurrence: seen.count, ...payload })
  }

  /** The repeat counts, so the summary still carries what was suppressed. */
  function suppressed() {
    return [...repeats.entries()]
      .filter(([, seen]) => seen.count > 1)
      .map(([key, seen]) => ({ key, count: seen.count, first: seen.first, last: seen.last }))
  }

  /**
   * Screenshot policy.
   * @returns {{retained:boolean, path:string|null, reason:string}}
   */
  function screenshot(buffer, detail = {}) {
    const level = detail.level === undefined ? null : detail.level
    const reason = detail.reason || 'unspecified'
    const decision = shouldRetain({ mode, retention, reason, runFailed: Boolean(detail.runFailed), explicit: Boolean(detail.explicit) })
    const record = {
      level,
      reason,
      bytes: buffer ? buffer.length : 0,
      retained: decision.retain,
      decision: decision.reason,
      step: detail.step || null,
      // Every capture carries why it exists, when, and which step it
      // belongs to, so a retention decision is auditable rather than implicit.
      retention: decision.retain ? 'retained' : 'transient'
    }
    if (!buffer || !decision.retain || !dir) {
      screenshots.push({ ...record, path: null })
      if (screenshots.length > 200) screenshots.splice(0, screenshots.length - 200)
      return { retained: false, path: null, reason: decision.reason }
    }
    try {
      const file = path.join(dir, `${fileName(taskId)}-step${detail.step === undefined ? 'x' : detail.step}-${Math.round(now())}.png`)
      fs.writeFileSync(file, buffer)
      screenshots.push({ ...record, path: file })
      if (screenshots.length > 200) screenshots.splice(0, screenshots.length - 200)
      return { retained: true, path: file, reason: decision.reason }
    } catch (error) {
      screenshots.push({ ...record, path: null, error: String(error && error.message) })
      return { retained: false, path: null, reason: `write failed: ${error && error.message}` }
    }
  }

  function finish(summary = {}) {
    const record = write('finish', { ...summary, rotations, suppressed: suppressed() })
    return record
  }

  function close() {
    if (stream) {
      try {
        stream.end()
      } catch {
        /* already gone */
      }
      stream = null
    }
    return streamPath
  }

  return {
    taskId,
    runId,
    mode,
    retention,
    path: streamPath,
    step,
    event,
    repeated,
    screenshot,
    finish,
    close,
    rotations: () => rotations,
    bytesWritten: () => written,
    entries() {
      return entries.slice()
    },
    steps() {
      return entries.filter((entry) => entry.kind === 'step')
    },
    screenshots() {
      return screenshots.slice()
    },
    /** Compact payload for the UI: the last N steps, no screenshot bytes. */
    tail(count = 20) {
      return entries.slice(-count)
    }
  }
}

/** Screenshot-retention decision table, exported so the policy itself is testable. */
function shouldRetain({ mode, retention, reason, runFailed, explicit }) {
  if (explicit || reason === SCREENSHOT_RETENTION.REQUESTED) return { retain: true, reason: 'explicitly requested' }
  if (mode === SCREENSHOT_RETENTION.DEBUG) return { retain: true, reason: 'debug mode' }
  if (mode === SCREENSHOT_RETENTION.AUDIT) return { retain: true, reason: 'audit mode' }
  if (retention === SCREENSHOT_RETENTION.NEVER) return { retain: false, reason: 'retention policy: never' }
  if (retention === SCREENSHOT_RETENTION.DEBUG && mode !== SCREENSHOT_RETENTION.DEBUG) return { retain: false, reason: 'debug retention without debug mode' }
  if (runFailed) return { retain: true, reason: 'failure evidence' }
  return { retain: false, reason: 'transient capture - used and dropped' }
}

function numberOrNull(value) {
  return Number.isFinite(Number(value)) ? Math.round(Number(value)) : null
}

// The ceilings are exported so the health snapshot, the docs and the acceptance
// harness can assert against the real numbers instead of restating them.
module.exports = { createExecutionLog, shouldRetain, DEFAULT_MAX_BYTES, DEFAULT_MAX_FILES }
