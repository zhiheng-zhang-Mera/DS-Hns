'use strict'

/**
 * Computer Use Runtime: execution log (plan §39, §40).
 *
 * One JSON line per step, with the fields the plan asks for: step number,
 * action, target, the pre-state summary, how long stabilization took, the
 * result, the verification that decided it and the retry count. The log is
 * evidence, so it records what was observed and what was verified — never an
 * application profile, never a latency model (plan §42).
 *
 * Screenshots follow plan §40: they are written only in debug/audit mode, on a
 * failing run, or when the caller explicitly asks for one. Otherwise a capture
 * is used and dropped, so a normal run does not accumulate a visual history.
 */

const fs = require('node:fs')
const path = require('node:path')

const { SCREENSHOT_RETENTION, STEP_RESULTS } = require('./constants.cjs')
const { redactDetails } = require('./errors.cjs')

function createExecutionLog(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const mode = options.mode || 'normal'
  const retention = options.retention || SCREENSHOT_RETENTION.FAILURE
  const dir = options.dir === undefined ? path.join(__dirname, '..', '..', 'logs', 'computer-use') : options.dir
  const taskId = options.taskId || `cu-${now()}`
  const maxEntries = Number.isInteger(options.maxEntries) ? options.maxEntries : 2000
  const entries = []
  const screenshots = []
  let stream = null
  let streamPath = null

  if (dir) {
    try {
      fs.mkdirSync(dir, { recursive: true })
      streamPath = path.join(dir, `${String(taskId).replace(/[^a-zA-Z0-9._-]/g, '_')}.jsonl`)
      stream = fs.createWriteStream(streamPath, { flags: 'a' })
      stream.on('error', () => {
        // A log that cannot be written must not take the runtime down (plan §37).
        stream = null
      })
    } catch {
      stream = null
      streamPath = null
    }
  }

  function write(kind, payload) {
    const record = { at: now(), taskId, kind, ...redactDetails(payload) }
    entries.push(record)
    if (entries.length > maxEntries) entries.splice(0, entries.length - maxEntries)
    if (stream) {
      try {
        stream.write(`${JSON.stringify(record)}\n`)
      } catch {
        stream = null
      }
    }
    return record
  }

  /**
   * Plan §39 — the per-step record. Missing fields are recorded as `null`
   * rather than omitted, because "no verification happened" is exactly the
   * condition the plan wants to be visible.
   */
  function step(record = {}) {
    const entry = {
      step: Number.isInteger(record.step) ? record.step : entries.filter((item) => item.kind === 'step').length + 1,
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
      verification: record.verification || null,
      verificationKind: record.verificationKind || null,
      evidence: record.evidence || null,
      retryCount: Number.isInteger(record.retryCount) ? record.retryCount : 0,
      attempts: Array.isArray(record.attempts) ? record.attempts : [],
      error: record.error || null,
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
   * Plan §40 — screenshot policy.
   * @returns {{retained:boolean, path:string|null, reason:string}}
   */
  function screenshot(buffer, detail = {}) {
    const level = detail.level === undefined ? null : detail.level
    const reason = detail.reason || 'unspecified'
    const decision = shouldRetain({ mode, retention, reason, runFailed: Boolean(detail.runFailed), explicit: Boolean(detail.explicit) })
    const record = { level, reason, bytes: buffer ? buffer.length : 0, retained: decision.retain, decision: decision.reason, step: detail.step || null }
    if (!buffer || !decision.retain || !dir) {
      screenshots.push({ ...record, path: null })
      return { retained: false, path: null, reason: decision.reason }
    }
    try {
      const file = path.join(dir, `${String(taskId).replace(/[^a-zA-Z0-9._-]/g, '_')}-step${detail.step === undefined ? 'x' : detail.step}-${Math.round(now())}.png`)
      fs.writeFileSync(file, buffer)
      screenshots.push({ ...record, path: file })
      return { retained: true, path: file, reason: decision.reason }
    } catch (error) {
      screenshots.push({ ...record, path: null, error: String(error && error.message) })
      return { retained: false, path: null, reason: `write failed: ${error && error.message}` }
    }
  }

  function finish(summary = {}) {
    return write('finish', summary)
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
    mode,
    retention,
    path: streamPath,
    step,
    event,
    screenshot,
    finish,
    close,
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

/** Plan §40 decision table, exported so the policy itself is testable. */
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

module.exports = { createExecutionLog, shouldRetain }
