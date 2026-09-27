'use strict'

/**
 * DS-Hns: the restart budget, the backoff and the crash-loop ladder.
 *
 * Three questions, three answers, all of them pure functions over injected values — because "did this
 * restart loop" is exactly the kind of question that must be answerable without restarting anything:
 *
 *   1. **May this restart happen, and if not, why?** — `evaluate()`. Every refusal carries one of the
 *      closed codes from `policy.cjs`, so a caller never has to parse a sentence to branch.
 *   2. **How long must the next attempt wait?** — `backoffFor()`. Exponential, capped, and floored by
 *      a configured cooldown, because a restart is the most disruptive thing this product does.
 *   3. **Is this a loop?** — `healthOf()`. The ladder is `NORMAL → DEGRADED → SAFE_MODE`; `DEGRADED`
 *      is a *reporting* change (restarts stop looking routine), `SAFE_MODE` is a *behaviour* change
 *      (automatic execution stops and a human is asked).
 *
 * ## Why the ladder exists separately from the budget
 *
 * The budget already refuses the fourth restart inside its window, so an infinite loop cannot happen
 * even without safe mode. That is not enough. A product that restarts three times in ten minutes and
 * then quietly refuses forever is a product that looks fine and is not; safe mode is the state that
 * says so — it keeps the official UI and the diagnostics, stops the high-risk automation, exposes the
 * last error, and offers a human "restart now" and "reset budget". A tier that only counted would be
 * a counter, not a policy.
 *
 * ## The clock is injected
 *
 * Every function here takes the time it should reason about. That is what makes "the window has
 * rolled over" and "the cooldown has elapsed" testable in microseconds instead of by waiting, and it
 * is why this file has no timer of its own: the supervisor owns the clock, this owns the arithmetic.
 */

const {
  REFUSAL_CODES,
  SUPERVISOR_HEALTH,
  RESTART_MODES,
  REQUESTABLE_MODES,
  DEFAULT_RESTART_CONFIG
} = require('./policy.cjs')

function fault(code, reason, extra = {}) {
  return { ok: false, code, reason: String(reason), ...extra }
}

/** Deep-merge a partial configuration over the shipped defaults. */
function mergeConfig(base, override) {
  if (!override || typeof override !== 'object') return { ...base }
  const out = { ...base }
  for (const [key, value] of Object.entries(override)) {
    out[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? mergeConfig(base[key] && typeof base[key] === 'object' ? base[key] : {}, value)
      : value
  }
  return out
}

/**
 * @param {object} [options]
 * @param {object} [options.config] partial configuration, merged over `DEFAULT_RESTART_CONFIG`
 * @param {Function} [options.now]
 */
function createRestartBudget(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const config = mergeConfig(DEFAULT_RESTART_CONFIG, options.config)

  /**
   * The restart history, newest last.
   *
   * An entry is written for *every* attempt, including one that failed to execute: "we tried and it
   * did not work" is the most important thing a crash-loop detector can know, and recording only
   * successes would make a failing executor look like an idle product.
   */
  const history = []
  /** The instant of the last *accepted* restart, for the cooldown. `null` means never. */
  let lastRestartAt = null
  /** How many consecutive failures the current streak holds, for the backoff. */
  let consecutiveFailures = 0
  /** Whether safe mode has been entered, and why. Cleared only by an explicit reset. */
  let safeMode = null
  let degraded = false
  let pending = null

  function capHistory() {
    const max = Number.isFinite(config.history.maxEntries) ? config.history.maxEntries : 50
    while (history.length > max) history.shift()
  }

  /** Restarts whose `at` falls inside the rolling window. Everything the budget reasons about. */
  function withinWindow(atMs = now()) {
    const cutoff = atMs - config.budget.windowMs
    return history.filter((entry) => entry.at >= cutoff && entry.counted !== false)
  }

  /**
   * The backoff for the *next* attempt.
   *
   * Doubles per consecutive failure from `backoffMs`, capped at `backoffMaxMs`, and floored by
   * `cooldownMs` — the floor is not redundant: a product that restarts every five seconds because
   * the backoff starts at five seconds is a product that has not backed off at all.
   */
  function backoffFor() {
    const { backoffMs, backoffMaxMs, cooldownMs } = config.budget
    const raw = backoffMs * Math.pow(2, Math.max(0, consecutiveFailures))
    const capped = Math.min(raw, backoffMaxMs)
    return Math.max(capped, cooldownMs)
  }

  /** The instant the next restart is allowed, or `null` when nothing is holding it back. */
  function nextAllowedAt(atMs = now()) {
    if (lastRestartAt === null) return null
    return lastRestartAt + backoffFor()
  }

  /**
   * May a restart happen now?
   *
   * The order is the contract, and it is the order the requirement names: validate, then budget, then
   * cooldown. Validation first because a malformed request should not consume a budget slot, and
   * budget before cooldown because "you have used them all" is a more useful answer than "wait a
   * bit" when both are true.
   *
   * @returns {{ok:boolean, code?:string, reason?:string, ...}}
   */
  function evaluate(request = {}, atMs = now()) {
    if (!config.enabled) return fault(REFUSAL_CODES.DISABLED, 'the restart supervisor is disabled')
    if (safeMode) {
      return fault(REFUSAL_CODES.SAFE_MODE, `safe mode is in force (${safeMode.reason}); a restart has to be requested by a person`, { safeMode })
    }
    const mode = String(request.mode || RESTART_MODES.APPLICATION)
    if (!REQUESTABLE_MODES.includes(mode)) {
      return fault(
        REFUSAL_CODES.MODE_NOT_REQUESTABLE,
        `"${mode}" is not a requestable restart mode; one of ${REQUESTABLE_MODES.join(', ')} is required`,
        { mode }
      )
    }
    if (pending) {
      return fault(REFUSAL_CODES.ALREADY_PENDING, `a restart is already pending (${pending.id}, requested ${atMs - pending.requestedAt}ms ago)`, { pending })
    }

    const used = withinWindow(atMs)
    if (used.length >= config.budget.maxRestarts) {
      return fault(
        REFUSAL_CODES.BUDGET_EXHAUSTED,
        `${used.length} restarts inside the ${Math.round(config.budget.windowMs / 1000)}s window, which is the budget of ${config.budget.maxRestarts}`,
        { used: used.length, maxRestarts: config.budget.maxRestarts, windowMs: config.budget.windowMs }
      )
    }

    const allowedAt = nextAllowedAt(atMs)
    if (allowedAt !== null && atMs < allowedAt) {
      return fault(
        REFUSAL_CODES.COOLDOWN,
        `the last restart was ${atMs - lastRestartAt}ms ago, inside the ${backoffFor()}ms backoff`,
        { retryAfterMs: allowedAt - atMs }
      )
    }

    return {
      ok: true,
      mode,
      used: used.length,
      remaining: Math.max(0, config.budget.maxRestarts - used.length),
      backoffMs: backoffFor(),
      health: healthOf(atMs)
    }
  }

  /** Record a request as accepted, so the cooldown and the budget move. */
  function accept(request = {}, atMs = now()) {
    const id = `restart-${atMs}-${history.length + 1}`
    pending = { id, requestedAt: atMs, mode: String(request.mode || RESTART_MODES.APPLICATION), reasonCode: String(request.reasonCode || 'UNKNOWN'), attempts: 0 }
    return pending
  }

  /**
   * Record the outcome of an attempt.
   *
   * `counted: false` exists for one specific case: a restart that never reached execution because the
   * *executor* was unavailable. Counting it would spend the budget on a restart that did not happen,
   * and a machine whose companion failed to spawn would then run out of budget without ever having
   * restarted. The entry is still written, so the history keeps the fact.
   */
  function record(entry = {}) {
    const at = Number.isFinite(entry.at) ? entry.at : now()
    const ok = entry.ok === true
    const counted = entry.counted !== false
    const record_ = {
      id: entry.id || (pending ? pending.id : `restart-${at}`),
      at,
      ok,
      counted,
      mode: String(entry.mode || (pending ? pending.mode : RESTART_MODES.APPLICATION)),
      reasonCode: String(entry.reasonCode || (pending ? pending.reasonCode : 'UNKNOWN')),
      reasonSummary: entry.reasonSummary ? String(entry.reasonSummary) : null,
      code: entry.code ? String(entry.code) : null,
      detail: entry.detail ? String(entry.detail) : null,
      durationMs: Number.isFinite(entry.durationMs) ? entry.durationMs : null,
      readiness: entry.readiness || null
    }
    history.push(record_)
    capHistory()
    if (counted) lastRestartAt = at
    if (ok) {
      pending = null
      if (config.budget.resetOnSuccess) {
        consecutiveFailures = 0
        degraded = false
      }
    } else {
      consecutiveFailures += 1
      pending = null
      // The ladder is re-derived from the failures inside the window and the streak together: a slow
      // drip of failures across an hour is not the same event as four in a minute, and the streak
      // alone would call them the same.
      refreshLadder()
    }
    return record_
  }

  /** Re-derive `degraded`/`safeMode` from the window and the streak. */
  function refreshLadder(atMs = now()) {
    const failures = withinWindow(atMs).filter((entry) => entry.ok !== true).length
    const signal = Math.max(failures, consecutiveFailures)
    if (signal >= config.crashLoop.safeModeAt && config.crashLoop.safeModeOnLoop) {
      if (!safeMode) {
        safeMode = {
          at: atMs,
          reason: `${signal} failed restarts, at or above the safe-mode threshold of ${config.crashLoop.safeModeAt}`,
          failures: signal
        }
      }
      degraded = true
    } else if (signal >= config.crashLoop.degradedAt) {
      degraded = true
    } else {
      degraded = false
    }
    return healthOf(atMs)
  }

  /** The tier the supervisor is in, with the numbers that put it there. */
  function healthOf(atMs = now()) {
    if (safeMode) {
      return { tier: SUPERVISOR_HEALTH.SAFE_MODE, degraded: true, safeMode: true, reason: safeMode.reason, failures: safeMode.failures }
    }
    if (degraded) {
      const failures = Math.max(withinWindow(atMs).filter((entry) => entry.ok !== true).length, consecutiveFailures)
      return { tier: SUPERVISOR_HEALTH.DEGRADED, degraded: true, safeMode: false, reason: `${failures} failed restarts; restarts are being reported rather than treated as routine`, failures }
    }
    return { tier: SUPERVISOR_HEALTH.NORMAL, degraded: false, safeMode: false, reason: null, failures: 0 }
  }

  function cancelPending(reason = 'cancelled') {
    if (!pending) return fault(REFUSAL_CODES.ALREADY_PENDING, 'there is no pending restart to cancel')
    const cancelled = { ...pending, cancelledAt: now(), reason: String(reason) }
    pending = null
    return { ok: true, cancelled }
  }

  /**
   * Reset the budget: the human escape hatch from safe mode.
   *
   * It clears the *window* rather than the history — the history is the audit trail and deleting it
   * would destroy the evidence somebody is trying to act on. `safeMode` is cleared, the streak is
   * cleared, and the entries stay with a marker saying they were reset, so "who reset the budget and
   * when" is answerable afterwards.
   */
  function reset(atMs = now(), by = 'manual') {
    const cleared = history.length
    if (cleared) history.push({ id: `reset-${atMs}`, at: atMs, ok: true, counted: false, mode: 'n/a', reasonCode: 'BUDGET_RESET', reasonSummary: `the budget was reset by ${by}`, reset: { cleared } })
    capHistory()
    consecutiveFailures = 0
    degraded = false
    safeMode = null
    lastRestartAt = null
    pending = null
    capHistory()
    return { ok: true, cleared, by, at: atMs, health: healthOf(atMs) }
  }

  function report(atMs = now()) {
    const used = withinWindow(atMs)
    const allowedAt = nextAllowedAt(atMs)
    return {
      config: {
        maxRestarts: config.budget.maxRestarts,
        windowMs: config.budget.windowMs,
        cooldownMs: config.budget.cooldownMs,
        backoffMs: config.budget.backoffMs,
        backoffMaxMs: config.budget.backoffMaxMs
      },
      used: used.length,
      remaining: Math.max(0, config.budget.maxRestarts - used.length),
      /** The window is rolling, so "used" is a function of *when* it is asked. */
      windowMs: config.budget.windowMs,
      lastRestartAt,
      nextAllowedAt: allowedAt,
      retryInMs: allowedAt === null ? 0 : Math.max(0, allowedAt - atMs),
      backoffMs: backoffFor(),
      consecutiveFailures,
      health: healthOf(atMs),
      safeMode,
      pending
    }
  }

  return {
    config,
    evaluate,
    accept,
    record,
    cancelPending,
    reset,
    report,
    health: healthOf,
    refreshLadder,
    history: () => history.map((entry) => ({ ...entry })),
    backoffFor,
    nextAllowedAt,
    /** Whether a restart of this mode is the escalation tier rather than a normal one. */
    isSystemEscalation: (mode) => String(mode) === RESTART_MODES.SYSTEM
  }
}

module.exports = { createRestartBudget, mergeConfig, DEFAULT_RESTART_CONFIG }
