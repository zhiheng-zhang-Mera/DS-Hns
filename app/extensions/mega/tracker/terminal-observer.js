'use strict'
const { EventEmitter } = require('node:events')
const { TERMINAL_EVENT, CANONICAL_TERMINAL, buildTerminalEvent } = require('../scheduler/lifecycle')

/**
 * Unified terminal observer (refix.md §8).
 *
 * The scheduler knows when the tasks *it* launched finish. The ordinary official
 * Harness session — the user typing a prompt in the official UI — is not a
 * scheduler task, so it needs its own observer. This module watches the DSH
 * session store (the tracker's session reader) and reports the same
 * TASK_TERMINATED payload, so all three task paths converge on one alert
 * pipeline:
 *
 *   ordinary official Harness session  -> this observer
 *   scheduler official session         -> scheduler event (observer filters them out)
 *   headless task                      -> scheduler event (observer filters them out)
 *
 * Rules that keep it quiet and safe:
 *   - the first observation is a baseline: pre-existing history never alerts;
 *   - only sessions with a real user message alert (agent/automation sessions
 *     and delegated sub-sessions are ignored);
 *   - Mega-launched sessions (scheduler dispatch, headless workspace) are
 *     filtered out because the scheduler already reports them;
 *   - every poll is failure isolated.
 */

const DEFAULT_INTERVAL_MS = 4000

const TERMINAL_BY_SESSION_STATUS = Object.freeze({
  COMPLETED: CANONICAL_TERMINAL.COMPLETED,
  FAILED: CANONICAL_TERMINAL.FAILED_FINAL,
  INTERRUPTED: CANONICAL_TERMINAL.CANCELLED
})

/** `<workspace>\active\<taskId>` is the headless task directory layout. */
const ACTIVE_TASK_DIR = /(?:[\\/])active[\\/][^\\/]+[\\/]?$/

function isMegaLaunchedCwd(cwd) {
  return ACTIVE_TASK_DIR.test(String(cwd || ''))
}

function sessionDisplayName(session) {
  const text = String(session?.firstUserText || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean)
  if (text) return text.slice(0, 72)
  const cwd = String(session?.cwd || '').replace(/[\\/]+$/, '')
  const base = cwd.split(/[\\/]/).pop()
  if (base) return base.slice(0, 72)
  return `session ${String(session?.id || '').slice(0, 8)}`
}

class TerminalObserver extends EventEmitter {
  /**
   * @param {object} options
   * @param {Function} options.listSessions session summaries (tracker)
   * @param {Function} [options.isManagedSession] true for Mega-dispatched sessions
   * @param {number} [options.intervalMs]
   * @param {Function} [options.now]
   * @param {Function} [options.log]
   */
  constructor({ listSessions, isManagedSession = () => false, intervalMs = DEFAULT_INTERVAL_MS, now = () => Date.now(), log = null } = {}) {
    super()
    if (typeof listSessions !== 'function') throw new Error('TerminalObserver requires a listSessions function')
    this.listSessions = listSessions
    this.isManagedSession = typeof isManagedSession === 'function' ? isManagedSession : () => false
    this.intervalMs = Math.max(500, Number(intervalMs) || DEFAULT_INTERVAL_MS)
    this.now = now
    this.log = log
    this.timer = null
    this.primed = false
    this.seen = new Map()
  }

  safeList() {
    try {
      const list = this.listSessions()
      return Array.isArray(list) ? list.filter((item) => item && typeof item === 'object') : []
    } catch (error) {
      this.log?.(`session observation failed: ${error?.message || error}`)
      return []
    }
  }

  stateOf(session) {
    return { status: String(session?.status || ''), seq: Number(session?.lastSeq ?? -1) }
  }

  remember(session) {
    const id = String(session?.id || '')
    if (!id) return
    this.seen.set(id, this.stateOf(session))
  }

  /** Records the current session store without emitting (no boot alert storm). */
  prime() {
    let count = 0
    for (const session of this.safeList()) {
      this.remember(session)
      count += 1
    }
    this.primed = true
    this.log?.(`terminal observer primed with ${count} existing session(s)`)
    return count
  }

  start() {
    if (this.timer) return false
    if (!this.primed) this.prime()
    this.timer = setInterval(() => { try { this.poll() } catch (error) { this.log?.(`observer poll failed: ${error?.message || error}`) } }, this.intervalMs)
    if (typeof this.timer.unref === 'function') this.timer.unref()
    return true
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    return true
  }

  shouldReport(session, finalStatus) {
    if (!finalStatus) return false
    if (!session.sawUserMessage) return false
    if (Number(session.delegationDepth) > 0) return false
    if (isMegaLaunchedCwd(session.cwd)) return false
    try {
      if (this.isManagedSession(session.id)) return false
    } catch (error) {
      this.log?.(`managed-session check failed: ${error?.message || error}`)
    }
    return true
  }

  /**
   * Diffs the session store against the previous observation and emits one
   * TASK_TERMINATED per newly reached terminal turn.
   */
  poll() {
    if (!this.primed) return this.prime()
    const emitted = []
    for (const session of this.safeList()) {
      const id = String(session?.id || '')
      if (!id) continue
      const next = this.stateOf(session)
      const previous = this.seen.get(id)
      this.seen.set(id, next)
      // A brand new session also counts as an observed transition, but only when
      // it belongs to this process run (the baseline covered older sessions).
      const changed = !previous || previous.status !== next.status || previous.seq !== next.seq
      if (!changed) continue
      const finalStatus = TERMINAL_BY_SESSION_STATUS[next.status]
      if (!finalStatus) continue
      if (!this.shouldReport(session, finalStatus)) continue
      emitted.push(this.report(session, finalStatus))
    }
    return emitted
  }

  report(session, finalStatus) {
    const endedAt = Number(session.endedAt) || Number(session.updatedAt) || this.now()
    const event = buildTerminalEvent({
      id: `session:${session.id}`,
      name: sessionDisplayName(session),
      prompt: session.firstUserText || '',
      status: finalStatus,
      createdAt: Number(session.createdAt) || null,
      startedAt: Number(session.createdAt) || null,
      endedAt,
      error: session.error || null,
      deliveryMode: 'official-session',
      officialSessionId: session.id,
      model: session.model || null
    }, {
      finalStatus,
      status: finalStatus,
      reason: 'session-turn-end',
      source: 'session-observer',
      exitCode: null
    })
    event.sessionId = session.id
    event.model = session.model || null
    this.emit(TERMINAL_EVENT, event)
    return event
  }
}

module.exports = {
  TerminalObserver,
  TERMINAL_BY_SESSION_STATUS,
  isMegaLaunchedCwd,
  sessionDisplayName,
  DEFAULT_INTERVAL_MS
}
