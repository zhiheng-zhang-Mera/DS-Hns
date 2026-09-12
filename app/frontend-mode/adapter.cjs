'use strict'

/**
 * Compatibility Adapter (Update-Plan/Dual-UI.md 任务 8 / 任务 9 / 任务 16).
 *
 *   Harness Backend  ->  Compatibility Adapter  ->  HNS Domain Model  ->  Native UI
 *
 * This is the only translation layer between the two. The native renderer never
 * sees a backend route, a journal event or an official CSS class: it receives the
 * `model.js` vocabulary and nothing else (Gate I).
 *
 * Two properties matter more than completeness here:
 *
 *   totality      every method answers, with `ok: false` and a reason when the
 *                 backend cannot serve it. A future Harness that renamed a route
 *                 degrades the native frontend instead of breaking it (任务 20).
 *   observability the adapter reports *what it actually measured* - which routes
 *                 answered, which events it could not classify, and what version
 *                 it is talking to - because that is the input to the
 *                 Compatibility Report (任务 17).
 */
const model = require('./model.cjs')

const CONTRACT_VERSION = 1

function nowIso() {
  return new Date().toISOString()
}

/**
 * @param {object}   options
 * @param {object}   options.bridge          a `createBackendBridge()` instance
 * @param {string}   [options.harnessVersion] installed DSH version, for the report
 * @param {Function} [options.tasks]          () => raw scheduler tasks
 * @param {Function} [options.settings]       () => raw settings snapshot
 * @param {Function} [options.log]
 */
function createAdapter({ bridge = null, harnessVersion = null, tasks = () => [], settings = () => null, log = () => {} } = {}) {
  let lastCapability = null
  let lastError = null

  function unavailable(operation, reason, extra = {}) {
    lastError = { at: nowIso(), operation, reason: String(reason) }
    return { ok: false, reason: 'adapter_unavailable', operation, message: String(reason), ...extra }
  }

  function safeTasks() {
    try {
      const raw = tasks()
      return Array.isArray(raw) ? raw.map(model.task) : []
    } catch (error) {
      log(`adapter task read failed: ${error?.message || error}`)
      return []
    }
  }

  function safeSettings() {
    try {
      return model.settingsState(settings())
    } catch (error) {
      log(`adapter settings read failed: ${error?.message || error}`)
      return model.settingsState(null)
    }
  }

  /**
   * Probe the backend and report what the native frontend can rely on.
   * Never throws; a probe failure is a `degraded`/`unreachable` answer.
   */
  async function probe() {
    if (!bridge || typeof bridge.capabilities !== 'function') {
      lastCapability = {
        ok: false,
        backend: model.backendState({ state: model.BACKEND_STATE.UNREACHABLE, reason: 'no backend bridge' }),
        routes: [],
        model: model.MODEL_VERSION,
        contract: CONTRACT_VERSION,
        at: nowIso()
      }
      return lastCapability
    }
    let raw
    try {
      raw = await bridge.capabilities()
    } catch (error) {
      raw = { ok: false, error: String(error?.message || error) }
    }
    const state = raw?.ok
      ? model.BACKEND_STATE.READY
      : (raw?.reachable ? model.BACKEND_STATE.DEGRADED : model.BACKEND_STATE.UNREACHABLE)
    lastCapability = {
      ok: Boolean(raw?.ok),
      backend: model.backendState({
        state,
        origin: raw?.sessionsRoot ? String(raw.sessionsRoot) : null,
        version: harnessVersion,
        reason: raw?.error || null,
        latencyMs: raw?.latencyMs ?? null
      }),
      routes: {
        required: raw?.required || [],
        optional: raw?.optional || [],
        missing: raw?.missing || []
      },
      journal: Boolean(raw?.journal),
      model: model.MODEL_VERSION,
      contract: CONTRACT_VERSION,
      at: nowIso()
    }
    return lastCapability
  }

  /** HNS Session rows, newest first. */
  async function listSessions() {
    if (!bridge || typeof bridge.listSessions !== 'function') {
      return unavailable('session/list', 'no backend bridge', { sessions: [] })
    }
    let raw
    try {
      raw = await bridge.listSessions()
    } catch (error) {
      return unavailable('session/list', error, { sessions: [] })
    }
    const items = Array.isArray(raw?.items) ? raw.items : []
    // The RPC list is authoritative about *existence*; the journal summary is
    // authoritative about *content* (title, model, error). Merge by id.
    const summaries = new Map()
    try {
      for (const summary of bridge.journalSessions?.() || []) {
        if (summary?.id) summaries.set(String(summary.id), summary)
      }
    } catch (error) {
      log(`adapter journal merge failed: ${error?.message || error}`)
    }
    const sessions = items.map((item) => {
      const id = String(item.sessionId || item.id || '')
      const summary = summaries.get(id) || {}
      return model.session({ ...summary, ...item, id, sessionId: id })
    })
    // Sessions only present in the journal (created outside this frontend, or
    // while the RPC list failed) are still real work and must not be hidden.
    for (const [id, summary] of summaries) {
      if (sessions.some((entry) => entry.id === id)) continue
      sessions.push(model.session(summary))
    }
    sessions.sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0))
    return {
      ok: Boolean(raw?.ok),
      degraded: Boolean(raw?.degraded),
      reason: raw?.reason || null,
      source: raw?.source || null,
      sessions
    }
  }

  /** The full conversation of one session, normalized. */
  function openSession(sessionId) {
    if (!bridge || typeof bridge.readJournal !== 'function') {
      return unavailable('session/journal', 'no backend bridge', { messages: [], toolEvents: [] })
    }
    const id = String(sessionId || '')
    if (!id) return { ok: false, reason: 'no_session', message: 'openSession needs a session id', messages: [], toolEvents: [] }
    let journal
    try {
      journal = bridge.readJournal(id, { tailBytes: 0 })
    } catch (error) {
      return unavailable('session/journal', error, { messages: [], toolEvents: [] })
    }
    if (!journal?.ok) {
      return {
        ok: false,
        reason: journal?.reason || 'journal_missing',
        message: `no durable journal for session ${id}`,
        messages: [],
        toolEvents: [],
        journal: false
      }
    }
    const timeline = model.timelineFromJournal(journal.events, { sessionId: id })
    return {
      ok: true,
      sessionId: id,
      journal: true,
      messages: timeline.messages,
      toolEvents: timeline.toolEvents,
      unclassified: timeline.unknown,
      turnEnd: timeline.turnEnd ? { reason: timeline.turnEnd.reason, error: timeline.turnEnd.error } : null,
      events: journal.events.length
    }
  }

  /**
   * The single snapshot the native renderer paints.
   *
   * @param {object} [options]
   * @param {string} [options.sessionId]  the session to open; defaults to the newest
   * @param {string} [options.reason]     why a send is disabled, when it is
   * @param {boolean}[options.sending]    a prompt is in flight from this frontend
   */
  async function snapshot({ sessionId = null, sending = false, reason = null } = {}) {
    const capability = await probe()
    const listed = await listSessions()
    const sessions = listed.sessions || []
    const activeId = sessionId || sessions[0]?.id || null
    const active = sessions.find((entry) => entry.id === activeId) || null
    const conversation = activeId ? openSession(activeId) : { ok: false, reason: 'no_session', messages: [], toolEvents: [] }
    const tasks = safeTasks()
    // The renderer receives the *model*, not the transport: route names are
    // diagnostics for the probe and the dock's compatibility panel, never data
    // the native frontend could bind to (任务 8 / Gate I).
    const rendererCapability = {
      ok: capability.ok,
      backend: capability.backend,
      journal: capability.journal,
      model: capability.model,
      contract: capability.contract,
      at: capability.at
    }
    return {
      ok: Boolean(capability.ok),
      version: CONTRACT_VERSION,
      modelVersion: model.MODEL_VERSION,
      at: nowIso(),
      capability: rendererCapability,
      backend: capability.backend,
      sessions,
      sessionsDegraded: Boolean(listed.degraded) || !listed.ok,
      session: active,
      messages: conversation.messages || [],
      toolEvents: conversation.toolEvents || [],
      conversation: {
        ok: Boolean(conversation.ok),
        reason: conversation.reason || null,
        journal: Boolean(conversation.journal),
        events: conversation.events || 0,
        unclassified: (conversation.unclassified || []).length,
        turnEnd: conversation.turnEnd || null
      },
      tasks,
      composer: model.composerState({
        session: active,
        ready: Boolean(capability.ok),
        sending,
        reason: reason || (capability.ok ? null : capability.backend.reason)
      }),
      settings: safeSettings()
    }
  }

  return {
    CONTRACT_VERSION,
    probe,
    listSessions,
    openSession,
    snapshot,
    /** Create a session through the backend, normalized. */
    async createSession(options = {}) {
      if (!bridge || typeof bridge.createSession !== 'function') return unavailable('session/create', 'no backend bridge')
      const result = await bridge.createSession(options).catch((error) => unavailable('session/create', error))
      if (!result?.ok) return { ok: false, reason: result?.reason || 'create_failed', message: result?.message || null }
      return { ok: true, sessionId: result.sessionId }
    },
    /** Send one prompt through the backend, normalized. */
    async sendPrompt({ sessionId, prompt, mode = 'queue' } = {}) {
      if (typeof prompt !== 'string' || !prompt.trim()) {
        return { ok: false, reason: 'empty_prompt', message: 'a prompt needs text' }
      }
      if (!bridge || typeof bridge.promptSession !== 'function') return unavailable('session/prompt', 'no backend bridge')
      const result = await bridge.promptSession({ sessionId, prompt, mode }).catch((error) => unavailable('session/prompt', error))
      if (!result?.ok) return { ok: false, reason: result?.reason || 'prompt_failed', message: result?.message || null }
      return { ok: true, accepted: result.accepted !== false, sessionId }
    },
    /** Cancel the active turn through the backend, normalized. */
    async cancelRun(sessionId) {
      if (!bridge || typeof bridge.cancelSession !== 'function') return unavailable('session/cancel', 'no backend bridge')
      const result = await bridge.cancelSession(sessionId).catch((error) => unavailable('session/cancel', error))
      if (!result?.ok) return { ok: false, reason: result?.reason || 'cancel_failed', message: result?.message || null }
      return { ok: true }
    },
    /** Rename a session through the backend (sidebar rename). */
    async renameSession(sessionId, title) {
      const name = String(title || '').trim()
      if (!sessionId || !name) return { ok: false, reason: 'invalid_rename', message: 'a rename needs a session and a title' }
      if (!bridge || typeof bridge.renameSession !== 'function') return unavailable('session/rename', 'no backend bridge')
      const result = await bridge.renameSession(sessionId, name).catch((error) => unavailable('session/rename', error))
      if (!result?.ok) return { ok: false, reason: result?.reason || 'rename_failed', message: result?.message || null }
      return { ok: true, sessionId, title: name }
    },
    describe() {
      return {
        contract: CONTRACT_VERSION,
        model: model.MODEL_VERSION,
        entities: model.describeModel().entities,
        harnessVersion,
        capability: lastCapability,
        lastError
      }
    }
  }
}

module.exports = {
  CONTRACT_VERSION,
  createAdapter
}
