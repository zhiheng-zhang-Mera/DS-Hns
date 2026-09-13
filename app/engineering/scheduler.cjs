'use strict'

/**
 * Engineering Runtime: the 24-hour scheduler.
 *
 * An episode that is waiting is not an episode that is working. A dev server
 * takes 40 seconds to answer, a registry is down for two minutes, a build takes
 * an hour — none of those should occupy the active execution slot, and none of
 * them may become a busy loop. This module is the difference:
 *
 *   park      "nothing can happen until X" — a wake reason, a deadline and a
 *             backoff, held outside the working loop
 *   wake      which parked episodes are due now, and why
 *   deadline  how much of the episode's own budget is left, and what that
 *             permits: starting a new large round, finishing the current one,
 *             or only running final verification and reporting
 *
 * Waiting is event- or timer-driven, never `while (true) { inspect() }`. Nothing
 * here sleeps in a loop: `nextWakeMs()` returns how long the caller should wait,
 * and the caller decides how to spend it.
 */

const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')

/** Why an episode is parked. */
const WAKE_REASONS = Object.freeze({
  PROCESS: 'process',
  RETRY: 'retry',
  DEADLINE: 'deadline',
  FILE: 'file',
  PORT: 'port',
  EXTERNAL: 'external'
})

const DEFAULT_DEADLINE_MS = 24 * 60 * 60 * 1000
/** The backoff ladder for a transient failure, in milliseconds, with a ceiling. */
const DEFAULT_BACKOFF_MS = Object.freeze([30_000, 60_000, 120_000, 300_000, 600_000])

/**
 * How much of the episode's budget is left, and what it permits.
 *
 * The banding is the plan's rule made explicit: with enough time left the runtime
 * may start anything; near the end it finishes the safe unit it is in; at the
 * wire it runs the best verification available and reports.
 */
function deadlineState(input = {}) {
  const now = Number.isFinite(input.now) ? Number(input.now) : Date.now()
  const startedAt = Number.isFinite(input.startedAt) ? Number(input.startedAt) : now
  const deadline = Number.isFinite(input.deadline) ? Number(input.deadline) : startedAt + DEFAULT_DEADLINE_MS
  const remainingMs = deadline - now
  const totalMs = Math.max(1, deadline - startedAt)
  const ratio = remainingMs / totalMs
  // The bands are *relative to the episode's own budget*, with an absolute floor
  // for the last stretch. A fixed "ten minutes left" rule would put a ten-minute
  // episode into its final band before it started any work, which is exactly how a
  // short episode ends up doing nothing and reporting nothing.
  const wrapUpRatio = Number.isFinite(input.wrapUpRatio) ? Number(input.wrapUpRatio) : 0.25
  const finalRatio = Number.isFinite(input.finalRatio) ? Number(input.finalRatio) : 0.1
  const finalFloorMs = Number.isFinite(input.finalFloorMs) ? Number(input.finalFloorMs) : 15_000
  let band = 'full'
  if (remainingMs <= 0) band = 'expired'
  else if (ratio <= finalRatio || (totalMs > finalFloorMs && remainingMs <= finalFloorMs)) band = 'final'
  else if (ratio <= wrapUpRatio) band = 'wrap-up'
  return {
    startedAt,
    deadline,
    now,
    remainingMs,
    totalMs,
    ratio,
    expired: remainingMs <= 0,
    band,
    /** May a new large repair round start? */
    allowNewWork: band === 'full',
    /** May the current safe unit finish and be verified? */
    allowCurrentWork: band !== 'expired',
    /** Is only the final verification and report permitted? */
    finalOnly: band === 'final' || band === 'expired'
  }
}

/**
 * @param {object} [options]
 * @param {Function} [options.now]
 * @param {number[]} [options.backoffMs]
 * @param {number} [options.maxParked]
 */
function createScheduler(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const backoffLadder = Array.isArray(options.backoffMs) && options.backoffMs.length ? options.backoffMs.slice() : DEFAULT_BACKOFF_MS.slice()
  const maxParked = Number.isInteger(options.maxParked) ? options.maxParked : 64
  const parked = new Map()

  /**
   * Park an episode.
   *
   * @param {object} input
   * @param {string} input.id
   * @param {string} input.reason one of WAKE_REASONS
   * @param {number} [input.afterMs] wake no earlier than this
   * @param {number} [input.attempt] the retry attempt, which selects the backoff
   * @param {object} [input.condition] `{ kind, file, port, url, processId }`
   * @param {number} [input.deadline] the episode deadline, so a park cannot outlive it
   */
  function park(input = {}) {
    const id = String(input.id || '')
    if (!id) return { ok: false, reason: 'a parked episode needs an id' }
    if (parked.size >= maxParked && !parked.has(id)) {
      return { ok: false, reason: `the scheduler already holds ${parked.size} parked episodes` }
    }
    const reason = Object.values(WAKE_REASONS).includes(input.reason) ? input.reason : WAKE_REASONS.EXTERNAL
    const attempt = Number.isInteger(input.attempt) && input.attempt > 0 ? input.attempt : 1
    const backoff = reason === WAKE_REASONS.RETRY ? backoffFor(attempt) : 0
    const afterMs = Number.isFinite(input.afterMs) ? Number(input.afterMs) : backoff
    const entry = {
      id,
      reason,
      attempt,
      parkedAt: now(),
      wakeAt: now() + Math.max(0, afterMs),
      backoffMs: backoff,
      condition: input.condition ? { ...input.condition } : null,
      deadline: Number.isFinite(input.deadline) ? Number(input.deadline) : null
    }
    parked.set(id, entry)
    return { ok: true, entry: { ...entry } }
  }

  /** The bounded backoff for one retry attempt. */
  function backoffFor(attempt) {
    const index = Math.min(backoffLadder.length - 1, Math.max(0, attempt - 1))
    return backoffLadder[index]
  }

  /** Take an episode out of the parking lot. */
  function unpark(id) {
    return parked.delete(String(id))
  }

  /** Is this episode parked? */
  function parkedEntry(id) {
    const entry = parked.get(String(id))
    return entry ? { ...entry } : null
  }

  /**
   * Which parked episodes are due, and why.
   *
   * The condition is *checked*, not assumed: a process that died, a file that was
   * never written or a port that never opened does not wake the episode by the
   * passage of time alone.
   */
  function due(input = {}) {
    const at = Number.isFinite(input.now) ? Number(input.now) : now()
    const processAlive = typeof input.processAlive === 'function' ? input.processAlive : () => true
    const result = []
    for (const entry of parked.values()) {
      if (at < entry.wakeAt) continue
      if (entry.deadline !== null && at >= entry.deadline) {
        result.push({ ...entry, wakeReason: 'the episode deadline passed while parked', expired: true })
        continue
      }
      const condition = entry.condition
      if (!condition) {
        result.push({ ...entry, wakeReason: `${entry.reason} wait elapsed`, expired: false })
        continue
      }
      const checked = checkCondition(condition, processAlive)
      if (checked.ready) result.push({ ...entry, wakeReason: checked.reason, expired: false })
      else if (checked.failed) result.push({ ...entry, wakeReason: checked.reason, failed: true, expired: false })
    }
    return result
  }

  function checkCondition(condition, processAlive) {
    switch (condition.kind) {
      case WAKE_REASONS.FILE:
        return fs.existsSync(path.resolve(String(condition.file)))
          ? { ready: true, reason: `${condition.file} exists` }
          : { ready: false, failed: false, reason: `${condition.file} does not exist yet` }
      case WAKE_REASONS.PORT:
        return { ready: false, failed: false, reason: `the port ${condition.port} is checked asynchronously` }
      case WAKE_REASONS.PROCESS:
        return processAlive(condition.processId)
          ? { ready: false, failed: false, reason: 'the process is still running' }
          : { ready: true, reason: `process ${condition.processId} finished` }
      case WAKE_REASONS.DEADLINE:
        return { ready: true, reason: 'the deadline condition was reached' }
      default:
        return { ready: true, reason: `${condition.kind || 'external'} wait elapsed` }
    }
  }

  /** How long until the next parked episode is due, or null when none is. */
  function nextWakeMs() {
    let soonest = null
    for (const entry of parked.values()) {
      if (soonest === null || entry.wakeAt < soonest) soonest = entry.wakeAt
    }
    if (soonest === null) return null
    return Math.max(0, soonest - now())
  }

  return {
    WAKE_REASONS,
    park,
    unpark,
    parkedEntry,
    due,
    nextWakeMs,
    backoffFor,
    backoffLadder,
    count() {
      return parked.size
    },
    /** A bounded view for the episode report. */
    snapshot() {
      return [...parked.values()].slice(0, maxParked).map((entry) => ({
        id: entry.id,
        reason: entry.reason,
        parkedAt: entry.parkedAt,
        wakeAt: entry.wakeAt,
        attempt: entry.attempt
      }))
    }
  }
}

module.exports = {
  WAKE_REASONS,
  DEFAULT_DEADLINE_MS,
  DEFAULT_BACKOFF_MS,
  deadlineState,
  createScheduler
}
