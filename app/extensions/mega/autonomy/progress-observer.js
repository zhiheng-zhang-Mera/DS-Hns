'use strict'

/**
 * DS-Hns autonomy: progress observer (Owner-Result.md Rev.2 §16, §9–§11).
 *
 * headless episodes are observed through stdout/stderr, log size and file
 * modification times; official-session episodes only through the RPC surface
 * (session/list running/blank/metadata) — never by injecting code into the
 * official renderer (§16). The clock is injectable so every verdict is
 * deterministic and unit-testable.
 *
 * Verdict vocabulary (§40): SLOW means evidence of life exists but no semantic
 * progress (probe, never kill); STALLED means no evidence past the hard-stall
 * window (enter recovery); FAILED means the episode exceeded the absolute fail
 * bound. A busy flag is only as fresh as the page/log state it was observed
 * in — a stuck busy flag must never mask a hard stall.
 */

const DEFAULT_BOUNDS = Object.freeze({
  quietAfterMs: 20_000,
  hardStallAfterMs: 90_000,
  failAfterMs: 15 * 60_000
})

function normalizeBounds(bounds = {}) {
  const merged = { ...DEFAULT_BOUNDS, ...bounds }
  const { quietAfterMs, hardStallAfterMs, failAfterMs } = merged
  if (![quietAfterMs, hardStallAfterMs, failAfterMs].every((n) => Number.isFinite(n) && n > 0)) {
    throw new Error('progress-observer: bounds must be finite positive numbers')
  }
  if (!(quietAfterMs <= hardStallAfterMs && hardStallAfterMs <= failAfterMs)) {
    throw new Error('progress-observer: invalid bounds (0 < quiet <= hardStall <= fail)')
  }
  return merged
}

/** Heartbeat shape an observer needs (§9). All timestamps are epoch ms. */
function emptyHeartbeat(startedAt) {
  if (!Number.isFinite(startedAt) || startedAt < 0) throw new Error('progress-observer: startedAt must be a non-negative epoch ms')
  return { startedAt, busy: false }
}

function latestEvidenceMs(heartbeat) {
  const candidates = [
    heartbeat.lastAnyActivityAt,
    heartbeat.lastSemanticProgressAt,
    heartbeat.lastResponseDeltaAt,
    heartbeat.lastPageStateAt
  ].filter((value) => Number.isFinite(value))
  if (!candidates.length) return heartbeat.startedAt
  return Math.max(heartbeat.startedAt, ...candidates)
}

/**
 * Classifies one episode observation. Pure over (now, heartbeat, bounds).
 * Returns { verdict, lifecycle, probeSuggested, reason, stalenessMs }.
 */
function observe(now, heartbeat, bounds = DEFAULT_BOUNDS) {
  if (!Number.isFinite(now) || now < heartbeat.startedAt) {
    throw new Error('progress-observer: now must be finite and >= startedAt')
  }
  const merged = normalizeBounds(bounds)
  const stalenessMs = now - latestEvidenceMs(heartbeat)
  const within = (ms, windowMs) => typeof ms === 'number' && Number.isFinite(ms) && now - ms <= windowMs
  const semanticRecent = within(heartbeat.lastSemanticProgressAt, merged.quietAfterMs)
  const deltaRecent = within(heartbeat.lastResponseDeltaAt, merged.quietAfterMs)
  const pageRecent = within(heartbeat.lastPageStateAt, merged.quietAfterMs)
  const busyFresh = heartbeat.busy === true && stalenessMs <= merged.hardStallAfterMs

  if (semanticRecent || deltaRecent || pageRecent || busyFresh) {
    return {
      verdict: 'WORKING',
      lifecycle: 'ACTIVE',
      probeSuggested: false,
      reason: semanticRecent
        ? 'semantic progress observed'
        : deltaRecent
          ? 'response delta observed'
          : pageRecent
            ? 'page state observed'
            : 'fresh busy evidence',
      stalenessMs
    }
  }
  if (stalenessMs <= merged.hardStallAfterMs) {
    return {
      verdict: 'SLOW',
      lifecycle: heartbeat.busy === true ? 'QUIET' : 'PROBING',
      probeSuggested: true,
      reason: heartbeat.busy === true
        ? 'stale busy evidence with no output progress — soft deadline, probe'
        : `no evidence within quiet window — probe provider (stale ${stalenessMs}ms)`,
      stalenessMs
    }
  }
  if (stalenessMs <= merged.failAfterMs) {
    return {
      verdict: 'STALLED',
      lifecycle: 'RECOVERING',
      probeSuggested: false,
      reason: `no activity/busy/delta past hard-stall window (stale ${stalenessMs}ms) — recovery ladder`,
      stalenessMs
    }
  }
  return {
    verdict: 'FAILED',
    lifecycle: 'FAILED',
    probeSuggested: false,
    reason: `no evidence past absolute fail bound (stale ${stalenessMs}ms) — FAILED`,
    stalenessMs
  }
}

/** Stateful wrapper with an injectable clock (defaults to Date.now). */
class ProgressObserver {
  constructor(options = {}) {
    this.bounds = normalizeBounds(options.bounds)
    this.now = typeof options.now === 'function' ? options.now : () => Date.now()
  }

  observe(heartbeat, now = this.now()) {
    return observe(now, heartbeat, this.bounds)
  }

  /** Records a page/log observation into a heartbeat and classifies it. */
  tick(heartbeat, update = {}, now = this.now()) {
    const next = { ...heartbeat }
    if (update.busy !== undefined) next.busy = Boolean(update.busy)
    if (update.lastAnyActivityAt !== undefined) next.lastAnyActivityAt = update.lastAnyActivityAt
    if (update.lastPageStateAt !== undefined) next.lastPageStateAt = update.lastPageStateAt
    if (update.lastSemanticProgressAt !== undefined) next.lastSemanticProgressAt = update.lastSemanticProgressAt
    if (update.lastResponseDeltaAt !== undefined) next.lastResponseDeltaAt = update.lastResponseDeltaAt
    next.lastAnyActivityAt = Math.max(next.lastAnyActivityAt || next.startedAt, next.lastPageStateAt || next.startedAt, next.lastSemanticProgressAt || next.startedAt, next.lastResponseDeltaAt || next.startedAt)
    return { heartbeat: next, observation: observe(now, next, this.bounds) }
  }
}

module.exports = { DEFAULT_BOUNDS, emptyHeartbeat, normalizeBounds, observe, ProgressObserver }
