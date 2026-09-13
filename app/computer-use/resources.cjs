'use strict'

/**
 * Computer Use Runtime: long-running resource ceilings
 * (Update-Plan/24h.md Task 8, Task 18, §10 of the plan).
 *
 * A run that lasts hours accumulates things. Screenshots are the obvious one, but
 * the quieter leaks are the ones that end a long run: an observation history that
 * keeps every world state, a screenshot list that keeps every capture's metadata,
 * a trace array that grows once per step.
 *
 * This module owns the policy that keeps all of it bounded, and — just as
 * important — owns what must *not* be dropped:
 *
 *   transient captures   short-lived: a stall screenshot is diagnostic, and after
 *                        the stall is resolved nobody needs it
 *   failure evidence     retained: the capture that explains why the task stopped
 *                        is the one thing an 8-hour run must still have
 *
 * The retention classes come from `constants.SCREENSHOT_RETENTION`, so the policy
 * and the log agree about what a class means.
 */

const { SCREENSHOT_RETENTION } = require('./constants.cjs')

/** How long a transient capture may live in memory before it is dropped. */
const TRANSIENT_TTL_MS = 60_000

/** Default ceilings. All of them are small on purpose: a long run must not need memory. */
const DEFAULTS = Object.freeze({
  ringSize: 200,
  maxScreenshots: 32,
  maxEntries: 2000,
  transientTtlMs: TRANSIENT_TTL_MS,
  maxEvidenceBytes: 8 * 1024 * 1024
})

/**
 * Which retention class a capture belongs to.
 *
 * The plan's classes are `debug`, `audit`, `failure`, `requested`, `never`. The
 * `reason` a caller supplies maps onto them: a stall or recovery capture is
 * transient, a failure capture is kept, an explicitly requested one is kept.
 */
function classifyRetention(reason, { runFailed = false, explicit = false, mode = 'normal', retention = SCREENSHOT_RETENTION.FAILURE } = {}) {
  const text = String(reason || 'unspecified')
  if (explicit || text === SCREENSHOT_RETENTION.REQUESTED) return { retention: SCREENSHOT_RETENTION.REQUESTED, keep: true, rationale: 'explicitly requested' }
  if (mode === SCREENSHOT_RETENTION.DEBUG || mode === SCREENSHOT_RETENTION.AUDIT) return { retention: mode, keep: true, rationale: `${mode} mode` }
  if (retention === SCREENSHOT_RETENTION.NEVER) return { retention: SCREENSHOT_RETENTION.NEVER, keep: false, rationale: 'retention policy: never' }
  if (runFailed) return { retention: SCREENSHOT_RETENTION.FAILURE, keep: true, rationale: 'failure evidence' }
  // `stall-targeted` / `stall-full` / `recovery` are diagnostics: real evidence
  // while the condition lasts, dead weight once it is resolved.
  if (/stall|recovery|probe|diagnostic/i.test(text)) return { retention: SCREENSHOT_RETENTION.FAILURE, keep: false, transient: true, rationale: 'transient diagnostic capture' }
  return { retention: SCREENSHOT_RETENTION.FAILURE, keep: false, transient: true, rationale: 'transient capture - used and dropped' }
}

/**
 * @param {object} [options]
 * @param {Function} [options.now]
 * @param {number} [options.ringSize] observation/progress history length
 * @param {number} [options.maxScreenshots] live capture records
 * @param {number} [options.transientTtlMs] how long a transient capture survives
 */
function createResourceBudget(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const limits = {
    ringSize: Number.isInteger(options.ringSize) ? options.ringSize : DEFAULTS.ringSize,
    maxScreenshots: Number.isInteger(options.maxScreenshots) ? options.maxScreenshots : DEFAULTS.maxScreenshots,
    transientTtlMs: Number.isFinite(options.transientTtlMs) ? options.transientTtlMs : DEFAULTS.transientTtlMs,
    maxEvidenceBytes: Number.isFinite(options.maxEvidenceBytes) ? options.maxEvidenceBytes : DEFAULTS.maxEvidenceBytes
  }

  const screenshots = []
  let droppedScreenshots = 0
  let retainedScreenshots = 0
  let evidenceBytes = 0
  const pressure = []

  /**
   * Register a capture.
   *
   * @param {object} input
   * @param {number} [input.bytes]
   * @param {string} [input.reason] why the capture was taken
   * @param {number} [input.step]
   * @param {string} [input.level]
   * @param {boolean} [input.explicit]
   * @param {boolean} [input.runFailed]
   * @returns {{keep:boolean, retention:string, rationale:string, evicted:number}}
   */
  function registerScreenshot(input = {}) {
    const decision = classifyRetention(input.reason, {
      runFailed: input.runFailed,
      explicit: input.explicit,
      mode: input.mode,
      retention: input.retention
    })
    const entry = {
      at: now(),
      step: input.step === undefined ? null : input.step,
      reason: String(input.reason || 'unspecified'),
      level: input.level === undefined ? null : input.level,
      bytes: Number.isFinite(input.bytes) ? Number(input.bytes) : 0,
      retention: decision.retention,
      transient: Boolean(decision.transient),
      keep: decision.keep,
      path: input.path || null
    }
    screenshots.push(entry)
    if (decision.keep) retainedScreenshots += 1
    evidenceBytes += entry.bytes
    const evicted = enforce()
    return { keep: decision.keep, retention: decision.retention, rationale: decision.rationale, evicted }
  }

  /**
   * Apply the ceilings, oldest-and-least-valuable first.
   *
   * The eviction order matters: transient captures go before retained evidence,
   * and a retained capture is only ever dropped when the ceiling cannot be met
   * any other way — dropping the evidence that explains a failure is a last
   * resort, and it is counted when it happens.
   */
  function enforce() {
    let evicted = 0
    // 1. expired transients
    const deadline = now() - limits.transientTtlMs
    for (let index = screenshots.length - 1; index >= 0; index -= 1) {
      const entry = screenshots[index]
      if (entry.transient && entry.at < deadline) {
        evidenceBytes -= entry.bytes
        screenshots.splice(index, 1)
        droppedScreenshots += 1
        evicted += 1
      }
    }
    // 2. over the count ceiling: transients first, then the oldest retained.
    if (screenshots.length > limits.maxScreenshots) {
      const order = screenshots
        .map((entry, index) => ({ entry, index }))
        .sort((a, b) => (a.entry.transient === b.entry.transient ? a.entry.at - b.entry.at : (a.entry.transient ? -1 : 1)))
      for (const candidate of order) {
        if (screenshots.length <= limits.maxScreenshots) break
        if (candidate.entry.removed) continue
        candidate.entry.removed = true
        const at = screenshots.indexOf(candidate.entry)
        if (at < 0) continue
        evidenceBytes -= candidate.entry.bytes
        screenshots.splice(at, 1)
        droppedScreenshots += 1
        evicted += 1
      }
    }
    // 3. over the byte ceiling: the same order.
    if (evidenceBytes > limits.maxEvidenceBytes) {
      const order = screenshots.slice().sort((a, b) => (a.transient === b.transient ? a.at - b.at : (a.transient ? -1 : 1)))
      for (const entry of order) {
        if (evidenceBytes <= limits.maxEvidenceBytes) break
        const at = screenshots.indexOf(entry)
        if (at < 0) continue
        evidenceBytes -= entry.bytes
        screenshots.splice(at, 1)
        droppedScreenshots += 1
        evicted += 1
      }
    }
    if (evicted) {
      pressure.push({ at: now(), evicted, screenshots: screenshots.length })
      if (pressure.length > 50) pressure.splice(0, pressure.length - 50)
    }
    return evicted
  }

  /** A bounded ring buffer for anything a caller wants to keep per step. */
  function ring(size = limits.ringSize) {
    const capacity = Number.isInteger(size) && size > 0 ? size : limits.ringSize
    let items = []
    return {
      push(value) {
        items.push(value)
        if (items.length > capacity) items.splice(0, items.length - capacity)
        return items.length
      },
      toArray() {
        return items.slice()
      },
      last(count = 1) {
        return items.slice(-count)
      },
      clear() {
        items = []
      },
      get size() {
        return items.length
      },
      capacity
    }
  }

  function snapshot() {
    // "At the ceiling" is about *pressure*, not about the ring being non-empty:
    // the runtime is at its ceiling when it has already had to evict captures and
    // the retained evidence is close to its own byte bound. That is what the
    // health snapshot turns into a block reason (Task 8/19/20).
    const atCeiling = droppedScreenshots > 0 && (
      screenshots.length >= limits.maxScreenshots ||
      evidenceBytes >= limits.maxEvidenceBytes * 0.9
    )
    return {
      limits: { ...limits },
      screenshots: screenshots.length,
      retainedScreenshots,
      droppedScreenshots,
      evidenceBytes,
      atCeiling,
      pressure: pressure.slice(-5)
    }
  }

  return {
    limits,
    classifyRetention,
    registerScreenshot,
    enforce,
    ring,
    snapshot,
    get screenshotCount() {
      return screenshots.length
    },
    get dropped() {
      return droppedScreenshots
    },
    screenshots() {
      return screenshots.slice()
    }
  }
}

module.exports = { createResourceBudget, classifyRetention, DEFAULTS, TRANSIENT_TTL_MS }
