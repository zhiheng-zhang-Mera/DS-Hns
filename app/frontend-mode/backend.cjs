'use strict'

/**
 * Harness Backend Bridge (Update-Plan/Dual-UI.md 任务 8, boundary half).
 *
 * This is the only module allowed to know *how* the official Harness is reached.
 * It produces raw backend facts and nothing else:
 *
 *   unary RPC      `session/list`, `session/create`, `session/prompt`,
 *                  `session/cancel`, `session/rename` through the same
 *                  authenticated `/api/<namespace>/<method>` transport the
 *                  Harness serves its own Web UI, exactly as the existing
 *                  `OfficialSessionClient` already does for Mega tasks.
 *   durable journal the per-session `session.jsonl` event log, which is the
 *                  harness's documented persistence format
 *                  (`dsh-session-format`). Reading it is a backend data read,
 *                  never a DOM read.
 *
 * Everything here is failure-isolated and returns `{ ok: false, reason }` rather
 * than throwing: a backend that is still booting, or a route a future version
 * renamed, must degrade the native frontend (任务 20) instead of crashing it.
 */
const fs = require('node:fs')
const path = require('node:path')

const { PATHS } = require('../extensions/mega/utils/paths')
const sessionReader = require('../extensions/mega/tracker/session-reader')

/** The routes the native frontend depends on. Probed by `capabilities()`. */
const REQUIRED_ROUTES = Object.freeze([
  'session/list',
  'session/create',
  'session/prompt',
  'session/cancel'
])

/** Routes that are nice to have; a missing one only removes an affordance. */
const OPTIONAL_ROUTES = Object.freeze([
  'session/rename',
  'session/page',
  'session/follow',
  'session/open',
  'session/update'
])

function readJsonLines(file, { tailBytes = 0 } = {}) {
  let text = ''
  try {
    if (tailBytes > 0) {
      const stat = fs.statSync(file)
      const start = Math.max(0, stat.size - tailBytes)
      const handle = fs.openSync(file, 'r')
      try {
        const length = stat.size - start
        const buffer = Buffer.alloc(length)
        fs.readSync(handle, buffer, 0, length, start)
        text = buffer.toString('utf8')
        // A tail window may start mid-line; drop the partial first line.
        if (start > 0) {
          const firstBreak = text.indexOf('\n')
          text = firstBreak >= 0 ? text.slice(firstBreak + 1) : ''
        }
      } finally {
        fs.closeSync(handle)
      }
    } else {
      text = fs.readFileSync(file, 'utf8')
    }
  } catch {
    return []
  }
  const events = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      events.push(JSON.parse(trimmed))
    } catch {
      // A partially written final line is normal while the backend appends.
    }
  }
  return events
}

/**
 * Create the backend bridge.
 *
 * @param {object}   options
 * @param {object|Function} options.client   an `OfficialSessionClient`-shaped object,
 *                                           or a lazy getter for one (so startup never
 *                                           depends on the client being constructible)
 * @param {string}   [options.sessionsRoot] journal root (defaults to PATHS.SESSIONS)
 * @param {Function} [options.log]
 */
function createBackendBridge({ client = null, sessionsRoot = PATHS.SESSIONS, log = () => {} } = {}) {
  /** session id -> journal path, filled lazily and never treated as permanent. */
  const journalIndex = new Map()
  let lastError = null
  let resolved = null

  /** The real client, resolved at most once per failure (a getter may return null). */
  function resolveClient() {
    if (typeof client !== 'function') return client
    if (resolved) return resolved
    try {
      resolved = client()
    } catch (error) {
      log(`backend client resolution failed: ${error?.message || error}`)
      resolved = null
    }
    return resolved
  }

  function failure(operation, error) {
    lastError = { operation, message: String(error?.message || error) }
    log(`backend ${operation} failed: ${lastError.message}`)
    return { ok: false, reason: 'backend_unavailable', message: lastError.message, operation }
  }

  function rpcAvailable() {
    const active = resolveClient()
    return Boolean(active && typeof active.call === 'function')
  }

  /** Raw durable events for one session, newest-last. */
  function readJournalFor(sessionId, { tailBytes = 0 } = {}) {
    const file = findJournal(sessionId)
    if (!file) return { ok: false, reason: 'journal_missing', events: [], file: null }
    const events = readJsonLines(file, { tailBytes })
    return { ok: true, events, file }
  }

  /** Locate the journal file for a session id (header scan, cached). */
  function findJournal(sessionId) {
    const id = String(sessionId || '')
    if (!id) return null
    const cached = journalIndex.get(id)
    if (cached && fs.existsSync(cached)) return cached
    journalIndex.delete(id)
    let files = []
    try {
      files = sessionReader.walkSessionFiles(sessionsRoot)
    } catch (error) {
      log(`backend journal walk failed: ${error?.message || error}`)
      return null
    }
    // Newest first: a session id is unique, but the newest directory is the one
    // a live session is most likely to be writing.
    for (const entry of files.slice().sort((a, b) => String(b.dir).localeCompare(String(a.dir)))) {
      const info = sessionReader.headerInfo(entry.file)
      if (!info?.id) continue
      journalIndex.set(info.id, entry.file)
      if (info.id === id) return entry.file
    }
    return journalIndex.get(id) || null
  }

  return {
    /** Raw `session/list` items, or the reader's summaries when RPC is missing. */
    async listSessions() {
      if (rpcAvailable()) {
        try {
          const value = await client.call('session/list', { _request: {} })
          const items = Array.isArray(value?.items) ? value.items : []
          return { ok: true, source: 'rpc', items }
        } catch (error) {
          const result = failure('session/list', error)
          return { ...result, items: [] }
        }
      }
      try {
        const items = sessionReader.listSessions({ root: sessionsRoot, limit: 200 })
        return { ok: items.length > 0, source: 'journal', items, degraded: true, reason: 'rpc client unavailable; the journal list is a cached view' }
      } catch (error) {
        return { ...failure('session/list(journal)', error), items: [] }
      }
    },

    async createSession({ cwd, agentPreset } = {}) {
      if (!rpcAvailable() || typeof client.createSession !== 'function') {
        return { ok: false, reason: 'backend_unavailable', message: 'session/create is unavailable' }
      }
      try {
        const created = await client.createSession({ cwd, agentPreset })
        if (!created?.sessionId) return { ok: false, reason: 'backend_contract', message: 'session/create returned no sessionId' }
        return { ok: true, sessionId: created.sessionId }
      } catch (error) {
        return failure('session/create', error)
      }
    },

    async promptSession({ sessionId, prompt, mode = 'queue' } = {}) {
      if (!rpcAvailable() || typeof client.promptSession !== 'function') {
        return { ok: false, reason: 'backend_unavailable', message: 'session/prompt is unavailable' }
      }
      if (!sessionId) return { ok: false, reason: 'no_session', message: 'a prompt needs a session' }
      try {
        const receipt = await client.promptSession({ sessionId, prompt, mode })
        return { ok: true, accepted: Boolean(receipt?.accepted ?? true), sessionId }
      } catch (error) {
        return failure('session/prompt', error)
      }
    },

    async cancelSession(sessionId) {
      if (!rpcAvailable() || typeof client.cancelSession !== 'function') {
        return { ok: false, reason: 'backend_unavailable', message: 'session/cancel is unavailable' }
      }
      if (!sessionId) return { ok: false, reason: 'no_session', message: 'a cancel needs a session' }
      try {
        await client.cancelSession(sessionId)
        return { ok: true, sessionId }
      } catch (error) {
        return failure('session/cancel', error)
      }
    },

    async renameSession(sessionId, title) {
      if (!rpcAvailable()) return { ok: false, reason: 'backend_unavailable' }
      try {
        await client.call('session/rename', { request: { sessionId: String(sessionId), title: String(title) } })
        return { ok: true, sessionId, title }
      } catch (error) {
        return failure('session/rename', error)
      }
    },

    /** Raw durable events for one session, newest-last. */
    readJournal: readJournalFor,

    /** A session id by journal presence (used when RPC list is unavailable). */
    journalSessions() {
      try {
        return sessionReader.listSessions({ root: sessionsRoot, limit: 200 })
      } catch (error) {
        log(`backend journal list failed: ${error?.message || error}`)
        return []
      }
    },

    /**
     * Probe the backend for the routes the native frontend needs.
     *
     * `session/list` is the cheapest authenticated read, so it doubles as the
     * liveness check. Optional routes are reported but never gate readiness.
     */
    async capabilities() {
      const started = Date.now()
      const result = {
        ok: false,
        rpc: rpcAvailable(),
        journal: fs.existsSync(sessionsRoot),
        sessionsRoot,
        required: [...REQUIRED_ROUTES],
        optional: [...OPTIONAL_ROUTES],
        reachable: false,
        missing: [],
        latencyMs: null,
        error: null
      }
      if (!rpcAvailable()) {
        result.error = 'no RPC client'
        result.missing = [...REQUIRED_ROUTES]
        return result
      }
      try {
        await client.call('session/list', { _request: {} })
        result.reachable = true
        result.ok = true
      } catch (error) {
        result.error = String(error?.message || error)
        // A transport failure is not a missing route: it is an unreachable
        // backend. Only a protocol answer claiming "unknown method" would put
        // anything into `missing`, and the transport does not expose one, so the
        // honest report is "unreachable", not "incompatible".
        result.missing = []
      }
      result.latencyMs = Date.now() - started
      return result
    },

    /** Honest diagnostic: how the bridge is configured, and its last failure. */
    describe() {
      return {
        rpc: rpcAvailable(),
        sessionsRoot,
        journalIndexSize: journalIndex.size,
        lastError
      }
    }
  }
}

module.exports = {
  REQUIRED_ROUTES,
  OPTIONAL_ROUTES,
  readJsonLines,
  createBackendBridge
}
