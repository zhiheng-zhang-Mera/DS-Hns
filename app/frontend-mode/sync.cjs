'use strict'

/**
 * Daily <-> Work Synchronization (Update-Plan/Dual-UI.md 任务 10 / 任务 11).
 *
 * A mode switch must keep *shared facts* continuous and may only reset *UI-local*
 * state:
 *
 *   must survive    active session, current backend task, conversation history,
 *                   pending/running state, selected project/workspace
 *   may reset       scroll position, panel state, theme state
 *
 * The honest part of this module is what it *cannot* do. Steering the official
 * renderer to a specific session would require either injecting script into it or
 * a deep link the shipped `@deepseek-ai/dsh` Web UI does not expose. Both are
 * forbidden (任务 4 / 任务 8 / Gate I), so `officialNavigation()` reports
 * `supported: false` with that reason and the switch proceeds anyway: the backend
 * session, its history and any running task are untouched, and Work Mode keeps
 * whatever the official UI was showing. Nothing is reset and nothing is
 * duplicated. When a future harness exposes a deep link, `navigateOfficial` can
 * be injected here and the same switch path starts using it.
 */
const { MODE, normalizeMode } = require('./state.cjs')

/** The operations a switch emits, in order. Used by the manager and by tests. */
const SWITCH_STEPS = Object.freeze({
  [MODE.DAILY]: Object.freeze(['record-session', 'sync-native', 'show-native', 'hide-official']),
  [MODE.WORK]: Object.freeze(['record-session', 'sync-official', 'show-official', 'hide-native'])
})

/**
 * @param {object}   options
 * @param {object}   options.state               a `createModeState()` instance
 * @param {object}   [options.adapter]           a `createAdapter()` instance (read-only use)
 * @param {Function} [options.navigateOfficial]  optional (sessionId) => { ok, reason }
 * @param {Function} [options.log]
 */
function createSync({ state = null, adapter = null, navigateOfficial = null, log = () => {} } = {}) {
  /** The session the user last acted on, in either mode. */
  let activeSessionId = null
  /** What the last synchronization actually did. */
  let lastSync = null
  const history = []

  function record(entry) {
    lastSync = { at: new Date().toISOString(), ...entry }
    history.push(lastSync)
    if (history.length > 32) history.splice(0, history.length - 32)
  }

  /**
   * The official renderer's steering capability.
   *
   * Reported rather than assumed: the dock shows the user what is and is not
   * synchronized instead of silently implying Work Mode followed along.
   */
  function officialNavigation() {
    if (typeof navigateOfficial !== 'function') {
      return {
        supported: false,
        reason: 'the shipped official Web UI exposes no session deep link, and DS-Hns never injects script or DOM into the official renderer'
      }
    }
    return { supported: true, reason: 'an official navigation hook was provided' }
  }

  /** Remember the active session for the current mode and as the shared fact. */
  function recordActiveSession(sessionId, { mode = null } = {}) {
    const id = typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : null
    activeSessionId = id
    if (state && id) state.setSession(normalizeMode(mode || state.getMode()), id)
    record({ event: 'record-session', sessionId: id, mode: mode ? normalizeMode(mode) : null })
    return id
  }

  function activeSession() {
    return activeSessionId
  }

  /**
   * Work -> Daily: which session should the native frontend open?
   *
   * Priority: the session the user chose, then the last Work session, then the
   * last Daily session, then the newest session the backend reports. The backend
   * wins over a stale remembered id, because a session can be deleted while
   * Daily (or Work) was hidden.
   */
  function resolveDailySession(sessions = []) {
    const known = new Set((Array.isArray(sessions) ? sessions : []).map((entry) => entry?.id).filter(Boolean))
    const candidates = [
      activeSessionId,
      state ? state.sessionFor(MODE.WORK) : null,
      state ? state.sessionFor(MODE.DAILY) : null,
      Array.isArray(sessions) && sessions.length ? sessions[0].id : null
    ]
    for (const candidate of candidates) {
      if (!candidate) continue
      if (known.size === 0 || known.has(candidate)) return candidate
    }
    return null
  }

  /**
   * Plan one mode switch. Pure with respect to the views: the manager applies it.
   *
   * @param {object}   options
   * @param {string}   options.to
   * @param {string}   [options.from]
   * @param {object[]} [options.sessions] backend session list, newest first
   */
  function planSwitch({ to, from = null, sessions = [] } = {}) {
    const target = normalizeMode(to)
    const source = from ? normalizeMode(from) : null
    const warnings = []
    const sessionId = target === MODE.DAILY
      ? resolveDailySession(sessions)
      : (activeSessionId || (state ? state.sessionFor(MODE.WORK) : null) || (Array.isArray(sessions) && sessions[0]?.id) || null)
    if (!sessionId) warnings.push('no active session to carry across the switch')
    const official = target === MODE.WORK ? officialNavigation() : { supported: true, reason: null }
    if (target === MODE.WORK && !official.supported) warnings.push(`official renderer not steered: ${official.reason}`)
    return {
      ok: true,
      from: source,
      to: target,
      steps: [...SWITCH_STEPS[target]],
      sessionId,
      official,
      warnings
    }
  }

  /**
   * Apply the session half of a switch plan.
   *
   * The view half (bounds/visibility/z-order) belongs to the manager; this only
   * performs the state synchronization the plan describes, so the two concerns
   * cannot drift apart.
   */
  function applySession(plan) {
    if (!plan?.ok) return { ok: false, reason: 'invalid_plan' }
    const sessionId = plan.sessionId || null
    if (sessionId) activeSessionId = sessionId
    if (state && sessionId) state.setSession(plan.to, sessionId)
    let official = { skipped: true, reason: 'official renderer only' }
    if (plan.to === MODE.WORK && sessionId) {
      if (typeof navigateOfficial === 'function') {
        try {
          const result = navigateOfficial(sessionId)
          official = result && typeof result === 'object' ? result : { ok: Boolean(result) }
        } catch (error) {
          official = { ok: false, reason: String(error?.message || error) }
          log(`official navigation failed: ${official.reason}`)
        }
      } else {
        official = { ok: false, skipped: true, reason: officialNavigation().reason }
      }
    }
    record({ event: 'apply-session', to: plan.to, sessionId, official })
    return { ok: true, sessionId, official }
  }

  /** Adopt the newest backend session when nothing has been chosen yet. */
  function adoptNewest(sessions = []) {
    if (activeSessionId) return activeSessionId
    const newest = Array.isArray(sessions) && sessions.length ? sessions[0]?.id || null : null
    if (newest) recordActiveSession(newest, { mode: state ? state.getMode() : null })
    return newest
  }

  /** The synchronization report shown in the dock and in acceptance evidence. */
  function describe() {
    return {
      activeSessionId,
      perMode: state ? { daily: state.sessionFor(MODE.DAILY), work: state.sessionFor(MODE.WORK) } : null,
      officialNavigation: officialNavigation(),
      adapter: Boolean(adapter),
      lastSync,
      history: history.slice(-8)
    }
  }

  return {
    SWITCH_STEPS,
    recordActiveSession,
    activeSession,
    resolveDailySession,
    adoptNewest,
    planSwitch,
    applySession,
    officialNavigation,
    describe
  }
}

module.exports = {
  SWITCH_STEPS,
  createSync
}
