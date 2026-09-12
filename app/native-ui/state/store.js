'use strict'

/**
 * Native frontend state store (Update-Plan/Dual-UI.md 任务 6).
 *
 * A deliberately tiny observable store: the renderer keeps *UI-local* state here
 * (selection, draft, panel visibility, pending prompt echo) and receives every
 * shared fact from the main process as a whole-snapshot patch. Nothing in this
 * file knows how a session is fetched or what a backend route is.
 */
;(function attachStore(global) {
  function createStore(initialState = {}) {
    let state = initialState
    const listeners = new Set()
    let scheduled = false

    function emit() {
      for (const listener of [...listeners]) {
        try {
          listener(state)
        } catch (error) {
          console.error('[hns-native] store listener failed', error)
        }
      }
    }

    /** Coalesce multiple synchronous patches into one render pass. */
    function schedule() {
      if (scheduled) return
      scheduled = true
      const flush = () => {
        scheduled = false
        emit()
      }
      if (typeof global.requestAnimationFrame === 'function') global.requestAnimationFrame(flush)
      else global.setTimeout(flush, 0)
    }

    return {
      get: () => state,
      /** Shallow merge, or a reducer when handed a function. */
      set(patch) {
        state = typeof patch === 'function' ? patch(state) : { ...state, ...patch }
        schedule()
        return state
      },
      subscribe(listener) {
        if (typeof listener !== 'function') return () => {}
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      select(selector) {
        try {
          return selector(state)
        } catch (error) {
          console.error('[hns-native] selector failed', error)
          return null
        }
      }
    }
  }

  /** The initial UI state. Every shared fact is filled by the first snapshot. */
  function initialState() {
    return {
      mode: 'daily',
      modeState: 'DAILY_ACTIVE',
      degraded: null,
      backend: { state: 'unknown', healthy: false, reason: null, version: null, origin: null },
      capability: null,
      sessions: [],
      sessionsDegraded: false,
      activeSessionId: null,
      session: null,
      messages: [],
      toolEvents: [],
      conversation: null,
      tasks: [],
      composer: { ready: false, canSend: false, canStop: false, running: false, placeholder: 'Loading…', reason: null },
      settings: { available: false, models: [] },
      // ---- UI-local state (never authoritative, never synchronized) ----
      draft: '',
      sending: false,
      pendingEcho: null,
      settingsOpen: false,
      error: null,
      notice: null,
      dirty: false
    }
  }

  function formatClock(value) {
    const ms = Number(value)
    if (!Number.isFinite(ms)) return ''
    try {
      return new Date(ms).toLocaleTimeString()
    } catch {
      return ''
    }
  }

  function formatDay(value) {
    const ms = Number(value)
    if (!Number.isFinite(ms)) return ''
    try {
      return new Date(ms).toLocaleDateString()
    } catch {
      return ''
    }
  }

  global.hnsStore = { createStore, initialState, formatClock, formatDay }
})(window)
