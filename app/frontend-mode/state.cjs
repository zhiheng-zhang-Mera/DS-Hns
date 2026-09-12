'use strict'

/**
 * Frontend Mode State (Update-Plan/Dual-UI.md 任务 2).
 *
 * DS-Hns ships two frontends that share one Harness backend:
 *
 *   daily   the HNS native frontend (default)
 *   work    the official @deepseek-ai/dsh Web UI
 *
 * This module owns the durable half of that decision and nothing else: which
 * mode the product is in, and which session each side was last showing. It is
 * deliberately free of Electron, of the backend and of any view, so it can be
 * unit-tested directly and so a broken state file can only ever degrade to
 * "daily with no remembered session" instead of blocking startup.
 *
 * On-disk shape (data/state/frontend-mode.json):
 *
 *   {
 *     "version": 1,
 *     "frontendMode": "daily",
 *     "sessions": { "daily": "<id>", "work": "<id>" },
 *     "updatedAt": 1730000000000
 *   }
 *
 * `sessions` is a *mapping*, not a single pointer, because 任务 11 requires the
 * two frontends to keep their own UI state (scroll position, panel state) while
 * the shared facts (active session, task) stay continuous. Keeping the last
 * session per mode is what lets "Work -> Daily" reopen what Daily was showing
 * while the switch still honours the authoritative backend session.
 */
const fs = require('node:fs')
const path = require('node:path')

/** Canonical mode ids. Order is stable and used by the UI. */
const MODE = Object.freeze({ DAILY: 'daily', WORK: 'work' })
const MODES = Object.freeze([MODE.DAILY, MODE.WORK])
const DEFAULT_MODE = MODE.DAILY
const STATE_VERSION = 1

/** Accept only a real mode; anything else silently keeps the fallback. */
function normalizeMode(value, fallback = DEFAULT_MODE) {
  const text = String(value ?? '').trim().toLowerCase()
  return MODES.includes(text) ? text : fallback
}

/** Is this one of the two canonical frontend modes? */
function isMode(value) {
  return MODES.includes(String(value ?? '').trim().toLowerCase())
}

/** The other mode: `daily <-> work`. */
function otherMode(mode) {
  return normalizeMode(mode) === MODE.DAILY ? MODE.WORK : MODE.DAILY
}

function normalizeSessionId(value) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text ? text : null
}

/**
 * Create the persistent frontend-mode store.
 *
 * @param {object}   options
 * @param {string}   [options.file]  absolute path of the state file (null = memory only)
 * @param {Function} [options.log]
 */
function createModeState({ file = null, log = () => {} } = {}) {
  let loaded = false
  let state = emptyState()
  /** Why the last load fell back, surfaced through `describe()`. */
  let lastIssue = null

  function emptyState() {
    return { version: STATE_VERSION, frontendMode: DEFAULT_MODE, sessions: {}, updatedAt: null }
  }

  function normalize(raw) {
    const sessions = {}
    const rawSessions = raw && typeof raw.sessions === 'object' && raw.sessions ? raw.sessions : {}
    for (const mode of MODES) {
      const id = normalizeSessionId(rawSessions[mode])
      if (id) sessions[mode] = id
    }
    const rawMode = raw?.frontendMode
    const mode = normalizeMode(rawMode)
    if (rawMode !== undefined && mode !== String(rawMode).trim().toLowerCase()) {
      lastIssue = `unknown frontendMode "${rawMode}" ignored; using ${DEFAULT_MODE}`
    }
    return {
      version: STATE_VERSION,
      frontendMode: mode,
      sessions,
      updatedAt: Number.isFinite(Number(raw?.updatedAt)) ? Number(raw.updatedAt) : null
    }
  }

  function read() {
    lastIssue = null
    if (!file) {
      loaded = true
      return describe()
    }
    try {
      state = normalize(JSON.parse(fs.readFileSync(file, 'utf8')))
    } catch (error) {
      // A missing file is the normal first run; a broken one is a reported
      // degradation. Neither may stop the product from starting in Daily.
      if (error?.code !== 'ENOENT') lastIssue = `frontend mode state unreadable: ${error?.message || error}`
      state = emptyState()
    }
    loaded = true
    return describe()
  }

  function ensure() {
    if (!loaded) read()
    return state
  }

  function persist() {
    if (!file) return false
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf8')
      return true
    } catch (error) {
      log(`frontend mode state save failed: ${error?.message || error}`)
      return false
    }
  }

  function getMode() {
    return ensure().frontendMode
  }

  /**
   * Persist the active mode. Returns the mode actually stored, so a caller that
   * passed junk can see the fallback instead of assuming it won.
   */
  function setMode(mode) {
    ensure()
    state.frontendMode = normalizeMode(mode)
    state.updatedAt = Date.now()
    persist()
    return state.frontendMode
  }

  /** Remember the session one mode is showing. */
  function setSession(mode, sessionId) {
    ensure()
    const key = normalizeMode(mode)
    const id = normalizeSessionId(sessionId)
    if (id) state.sessions[key] = id
    else delete state.sessions[key]
    state.updatedAt = Date.now()
    persist()
    return state.sessions[key] || null
  }

  function sessionFor(mode) {
    return ensure().sessions[normalizeMode(mode)] || null
  }

  function describe() {
    return {
      version: state.version,
      frontendMode: state.frontendMode,
      defaultMode: DEFAULT_MODE,
      sessions: { ...state.sessions },
      updatedAt: state.updatedAt,
      file: file || null,
      loaded,
      issue: lastIssue
    }
  }

  return {
    MODE,
    MODES,
    getMode,
    setMode,
    setSession,
    sessionFor,
    read,
    describe,
    file
  }
}

module.exports = {
  MODE,
  MODES,
  DEFAULT_MODE,
  STATE_VERSION,
  normalizeMode,
  normalizeSessionId,
  isMode,
  otherMode,
  createModeState
}
