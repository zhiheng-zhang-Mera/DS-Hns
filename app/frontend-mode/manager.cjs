'use strict'

/**
 * Frontend Mode Manager (Update-Plan/Dual-UI.md 任务 3 / 任务 5 / 任务 15 / 任务 20).
 *
 * Owns the mode state machine, the renderer visibility decision and the failure
 * fallback. It never creates or destroys a renderer (任务 15: switching only ever
 * changes bounds, visibility and z-order) and it never touches the backend: the
 * Harness keeps running, keeps its tasks and keeps its sessions.
 *
 * State machine (任务 15):
 *
 *   DAILY_ACTIVE -> SWITCHING_TO_WORK -> WORK_ACTIVE
 *   WORK_ACTIVE  -> SWITCHING_TO_DAILY -> DAILY_ACTIVE
 *   DAILY_ACTIVE -> DAILY_DEGRADED  (native frontend failed; Work Mode is shown)
 *
 * A second switch request during a transition is *queued*, coalesced to the
 * latest target, and applied once the transition settles. That is what rules out
 * the double show/hide race the plan forbids: the "switching" state is the lock.
 */
const { MODE, normalizeMode, otherMode, DEFAULT_MODE } = require('./state.cjs')

const STATE = Object.freeze({
  DAILY_ACTIVE: 'DAILY_ACTIVE',
  SWITCHING_TO_WORK: 'SWITCHING_TO_WORK',
  WORK_ACTIVE: 'WORK_ACTIVE',
  SWITCHING_TO_DAILY: 'SWITCHING_TO_DAILY',
  DAILY_DEGRADED: 'DAILY_DEGRADED'
})

const ACTIVE_STATE = Object.freeze({
  [MODE.DAILY]: STATE.DAILY_ACTIVE,
  [MODE.WORK]: STATE.WORK_ACTIVE
})

/**
 * @param {object}   options
 * @param {object}   options.state            `createModeState()` instance
 * @param {object}   options.sync             `createSync()` instance
 * @param {Function} options.applyVisibility  ({ mode, from }) => void   (shell-owned)
 * @param {string}   [options.initialMode]    startup mode for this run (not persisted)
 * @param {Function} [options.log]
 * @param {Function} [options.onChange]
 */
function createModeManager({
  state = null,
  sync = null,
  applyVisibility = () => {},
  initialMode = null,
  log = () => {},
  onChange = () => {}
} = {}) {
  let mode = normalizeMode(initialMode || (state ? state.getMode() : DEFAULT_MODE))
  let machine = ACTIVE_STATE[mode]
  let degraded = { active: false, reason: null, at: null }
  let pendingTarget = null
  let switching = false
  /** Transitions recorded for acceptance evidence (Gate D). */
  const transitions = []
  const listeners = new Set()

  function record(entry) {
    transitions.push({ at: new Date().toISOString(), ...entry })
    if (transitions.length > 128) transitions.splice(0, transitions.length - 128)
  }

  function emit(payload) {
    for (const listener of [...listeners]) {
      try {
        listener(payload)
      } catch (error) {
        log(`mode listener failed: ${error?.message || error}`)
      }
    }
    try {
      onChange(payload)
    } catch (error) {
      log(`mode change notification failed: ${error?.message || error}`)
    }
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') return () => {}
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  /** Ask the shell to make one renderer visible. A failure is never fatal. */
  function apply(modeToShow, from) {
    try {
      applyVisibility({ mode: modeToShow, from })
      return { ok: true }
    } catch (error) {
      log(`renderer visibility apply failed for ${modeToShow}: ${error?.message || error}`)
      return { ok: false, reason: String(error?.message || error) }
    }
  }

  /**
   * Perform one transition. The `steps` come from the sync plan, so the session
   * half and the view half cannot disagree about what a switch means.
   */
  function transition(to, { reason = 'user', sessions = [], plan = null, persist = true } = {}) {
    const target = normalizeMode(to)
    const from = mode
    switching = true
    machine = target === MODE.WORK ? STATE.SWITCHING_TO_WORK : STATE.SWITCHING_TO_DAILY
    emit({ type: 'switching', from, to: target, state: machine, reason })
    let outcome = { ok: true, from, to: target, sessionId: null, official: null, warnings: [] }
    try {
      const switchPlan = plan || (sync?.planSwitch ? sync.planSwitch({ to: target, from, sessions }) : null) ||
        { ok: true, to: target, steps: [], sessionId: null, official: null, warnings: [] }
      outcome.warnings = switchPlan.warnings || []
      const sessionResult = sync?.applySession ? sync.applySession(switchPlan) : { ok: true, sessionId: null, official: null }
      outcome.sessionId = sessionResult?.sessionId || switchPlan.sessionId || null
      outcome.official = sessionResult?.official || null
      // The mode is committed *before* the visibility request, because the
      // request fans out a mode-change event (the dock and the native renderer
      // both read it). The failure path below rolls it back.
      mode = target
      machine = ACTIVE_STATE[target]
      if (target === MODE.DAILY) degraded = { active: false, reason: null, at: null }
      // A *user* switch is a preference and is persisted. A fallback is a
      // runtime recovery, not a preference: it must not make Work Mode the
      // permanent startup mode just because one launch failed (任务 20).
      if (state && persist) state.setMode(target)
      const applied = apply(target, from)
      if (!applied.ok) outcome.warnings.push(`renderer visibility reported: ${applied.reason}`)
      record({ event: 'switch', from, to: target, reason, sessionId: outcome.sessionId, warnings: outcome.warnings })
      emit({ type: 'switched', from, to: target, state: machine, reason, sessionId: outcome.sessionId })
    } catch (error) {
      // A transition that threw must leave a describable, non-broken machine.
      log(`mode transition to ${target} failed: ${error?.message || error}`)
      mode = from
      machine = degraded.active ? STATE.DAILY_DEGRADED : ACTIVE_STATE[from]
      if (state && persist) state.setMode(from)
      outcome = { ok: false, from, to: target, reason: String(error?.message || error), warnings: [] }
      apply(from, from)
      emit({ type: 'switch-failed', from, to: target, state: machine, reason: outcome.reason })
    } finally {
      switching = false
    }
    return outcome
  }

  /**
   * Switch, or queue the request behind the one in flight.
   *
   * A second click during a transition never starts a parallel show/hide; it
   * replaces the queued target and the queue drains once (任务 15).
   */
  function switchTo(next, options = {}) {
    const target = normalizeMode(next)
    if (switching) {
      pendingTarget = target
      log(`mode switch to ${target} queued behind the transition in flight`)
      return { ok: true, queued: true, to: target, state: machine }
    }
    const result = transition(target, options)
    if (pendingTarget) {
      const queued = pendingTarget
      pendingTarget = null
      if (queued !== mode) {
        const queuedResult = transition(queued, { reason: 'queued', sessions: options.sessions || [] })
        return { ...queuedResult, queued: true, coalescedFrom: target }
      }
    }
    return result
  }

  function toggle(options = {}) {
    return switchTo(otherMode(mode), options)
  }

  /**
   * Failure fallback (任务 20).
   *
   * A native-frontend failure preserves the backend and moves the product to
   * Work Mode. It never restarts the Harness, cancels a task or deletes a
   * session; it only changes which renderer is on screen, and records why.
   */
  function degrade(reason, options = {}) {
    degraded = { active: true, reason: String(reason || 'native frontend failure'), at: new Date().toISOString() }
    machine = STATE.DAILY_DEGRADED
    log(`Daily Mode degraded: ${degraded.reason} - falling back to Work Mode`)
    const result = mode === MODE.WORK
      ? { ok: true, from: MODE.WORK, to: MODE.WORK, alreadyThere: true, warnings: [degraded.reason] }
      : switchTo(MODE.WORK, { reason: `daily-degraded: ${degraded.reason}`, persist: false, ...options })
    // While the degradation is active the machine reports it honestly, even
    // though Work Mode is on screen and fully functional.
    machine = STATE.DAILY_DEGRADED
    record({ event: 'degrade', reason: degraded.reason, to: MODE.WORK })
    emit({ type: 'degraded', reason: degraded.reason, state: machine })
    return { ...result, degraded: { ...degraded } }
  }

  /** Leave the degraded state: the user asked for Daily again. */
  function clearDegradation() {
    degraded = { active: false, reason: null, at: null }
    if (machine === STATE.DAILY_DEGRADED) machine = ACTIVE_STATE[mode]
    return { ...degraded }
  }

  function describe() {
    return {
      mode,
      state: machine,
      switching,
      pendingTarget,
      degraded: { ...degraded },
      transitions: transitions.slice(-16),
      sync: sync ? sync.describe() : null,
      stateFile: state ? state.describe() : null
    }
  }

  return {
    STATE,
    subscribe,
    current: () => mode,
    machineState: () => machine,
    isDegraded: () => degraded.active,
    switchTo,
    toggle,
    degrade,
    clearDegradation,
    describe
  }
}

module.exports = {
  STATE,
  ACTIVE_STATE,
  createModeManager
}
