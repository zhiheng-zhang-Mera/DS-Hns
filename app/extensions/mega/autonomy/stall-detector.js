'use strict'

/**
 * DS-Hns autonomy: stall detector (Owner-Result.md Rev.2 §11/§10, §40).
 *
 * Accumulates progress-observer verdicts per episode across scheduler ticks.
 * Tracks how long an episode has been without semantic progress, when a probe
 * is due (soft deadline → QUIET → PROBE) and when the episode has reached a
 * hard stall that must enter the recovery ladder. Deterministic with an
 * injectable clock; never decides "kill" by itself — it only reports
 * shouldProbe / isStalled / isFailed so the continuation controller decides.
 */

const { DEFAULT_BOUNDS, observe } = require('./progress-observer')

class StallDetector {
  constructor(options = {}) {
    this.bounds = { ...DEFAULT_BOUNDS, ...(options.bounds || {}) }
    this.now = typeof options.now === 'function' ? options.now : () => Date.now()
    this.episodes = new Map()
  }

  /** Registers an episode (id → heartbeat + counters). */
  start(episodeId, startedAt = this.now()) {
    if (this.episodes.has(episodeId)) return this.episodes.get(episodeId)
    const record = {
      startedAt,
      lastHeartbeat: { startedAt, busy: false },
      consecutiveNoProgressTicks: 0,
      consecutiveStalledTicks: 0,
      probesRun: 0,
      stalledAt: null
    }
    this.episodes.set(episodeId, record)
    return record
  }

  /**
   * Feeds one observation for an episode. `heartbeat` may carry partial
   * updates (lastAnyActivityAt / lastSemanticProgressAt / lastResponseDeltaAt /
   * lastPageStateAt / busy). Returns the progress verdict plus detector state.
   */
  observe(episodeId, heartbeatUpdate = {}, now = this.now()) {
    const record = this.episodes.get(episodeId) || this.start(episodeId, heartbeatUpdate.startedAt || now)
    const previous = record.lastHeartbeat
    const heartbeat = {
      startedAt: previous.startedAt,
      busy: heartbeatUpdate.busy === undefined ? previous.busy : Boolean(heartbeatUpdate.busy),
      ...(heartbeatUpdate.lastAnyActivityAt !== undefined ? { lastAnyActivityAt: heartbeatUpdate.lastAnyActivityAt } : previous.lastAnyActivityAt !== undefined ? { lastAnyActivityAt: previous.lastAnyActivityAt } : {}),
      ...(heartbeatUpdate.lastSemanticProgressAt !== undefined ? { lastSemanticProgressAt: heartbeatUpdate.lastSemanticProgressAt } : previous.lastSemanticProgressAt !== undefined ? { lastSemanticProgressAt: previous.lastSemanticProgressAt } : {}),
      ...(heartbeatUpdate.lastResponseDeltaAt !== undefined ? { lastResponseDeltaAt: heartbeatUpdate.lastResponseDeltaAt } : previous.lastResponseDeltaAt !== undefined ? { lastResponseDeltaAt: previous.lastResponseDeltaAt } : {}),
      ...(heartbeatUpdate.lastPageStateAt !== undefined ? { lastPageStateAt: heartbeatUpdate.lastPageStateAt } : previous.lastPageStateAt !== undefined ? { lastPageStateAt: previous.lastPageStateAt } : {})
    }
    record.lastHeartbeat = heartbeat
    const observation = observe(now, heartbeat, this.bounds)

    if (observation.verdict === 'WORKING') {
      record.consecutiveNoProgressTicks = 0
      record.consecutiveStalledTicks = 0
      record.stalledAt = null
    } else if (observation.verdict === 'SLOW') {
      record.consecutiveNoProgressTicks += 1
      record.stalledAt = null
    } else if (observation.verdict === 'STALLED') {
      record.consecutiveNoProgressTicks += 1
      record.consecutiveStalledTicks += 1
      record.stalledAt = record.stalledAt || now
    } else {
      record.consecutiveNoProgressTicks += 1
      record.consecutiveStalledTicks += 1
    }
    return {
      ...observation,
      episodeId,
      consecutiveNoProgressTicks: record.consecutiveNoProgressTicks,
      consecutiveStalledTicks: record.consecutiveStalledTicks,
      stalledSinceMs: record.stalledAt ? now - record.stalledAt : 0,
      shouldProbe: observation.probeSuggested
    }
  }

  /**
   * Records a probe outcome. A probe that cannot prove activity (busy=false,
   * no activity) makes a SLOW episode advance toward its hard-stall bound; the
   * caller re-observes with the probe timestamp.
   */
  markProbe(episodeId, probe = {}) {
    const record = this.episodes.get(episodeId)
    if (!record) return null
    record.probesRun += 1
    if (probe.busy === false && probe.anyActivity === false) {
      // Probe proved nothing: refresh the heartbeat so the next observation
      // falls out of the quiet window and the hard-stall bound governs.
      record.lastHeartbeat = { ...record.lastHeartbeat, busy: false, lastPageStateAt: undefined, lastAnyActivityAt: undefined }
    } else if (probe.anyActivity === true) {
      record.lastHeartbeat = { ...record.lastHeartbeat, busy: probe.busy === true, lastPageStateAt: this.now() }
    }
    return record.probesRun
  }

  isStalled(episodeId) {
    const record = this.episodes.get(episodeId)
    return Boolean(record && record.consecutiveStalledTicks > 0)
  }

  drop(episodeId) {
    return this.episodes.delete(episodeId)
  }

  reset(episodeId) {
    const record = this.episodes.get(episodeId)
    if (!record) return
    record.consecutiveNoProgressTicks = 0
    record.consecutiveStalledTicks = 0
    record.probesRun = 0
    record.stalledAt = null
    record.lastHeartbeat = { startedAt: record.startedAt, busy: false }
  }
}

module.exports = { StallDetector }
