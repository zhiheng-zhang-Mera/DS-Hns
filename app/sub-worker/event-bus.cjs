'use strict'

/**
 * Sub-worker observability bus (plan §13, §14).
 *
 * Every action the worker performs becomes an event. The bus is the single
 * source for the Live View, the task log and the result summary, so what the
 * user sees is exactly what happened - and nothing else: no hidden reasoning,
 * no chain-of-thought, only auditable execution facts.
 */

const { EVENT_TYPES, isPlainObject } = require('./protocol.cjs')

const DEFAULT_RING = 400

/** Secrets must never reach a log, an event or the Live View (plan §26). */
function redactSecrets(text) {
  return String(text == null ? '' : text)
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-[REDACTED]')
    // Both `?token=...` and a bare `token=...` / `token: ...` form.
    .replace(/(^|[?&\s,;"'(])token\s*[:=]\s*[^\s&,;)"'\]]+/gi, '$1token=[REDACTED]')
    .replace(
      // `Bearer <token>` is handled by its own rule below, so the generic
      // key/value rule must not swallow the scheme word first.
      /\b(api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|authorization|password|passwd|secret)\b\s*[:=]\s*(?!Bearer\b)("[^"]*"|'[^']*'|[^\s,;)"']+)/gi,
      (_match, name) => `${name}=[REDACTED]`
    )
    .replace(/\bBearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer [REDACTED]')
}

/** Event fields that are never secret material and must stay readable. */
const NON_SECRET_EVENT_FIELDS = new Set(['timestamp', 'type', 'task_id', 'stream', 'stage', 'state'])

/**
 * Redact every string field of an event. A Note carries user text and a command
 * output line carries stdout, so a hand-picked key list is not a guarantee.
 */
function redactEvent(event) {
  if (!event || typeof event !== 'object') return event
  for (const [key, value] of Object.entries(event)) {
    if (typeof value !== 'string' || NON_SECRET_EVENT_FIELDS.has(key)) continue
    event[key] = redactSecrets(value)
  }
  return event
}

function truncate(text, max = 2000) {
  const value = String(text == null ? '' : text)
  return value.length > max ? `${value.slice(0, max)}…[truncated ${value.length - max} chars]` : value
}

class EventBus {
  constructor({ taskId = null, ringSize = DEFAULT_RING, now = () => Date.now(), onEvent = null } = {}) {
    this.taskId = taskId
    this.ringSize = ringSize
    this.now = now
    this.onEvent = typeof onEvent === 'function' ? onEvent : null
    this.events = []
    this.listeners = new Set()
    this.counts = {}
  }

  subscribe(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Emit one auditable event. Never throws: observability must not break work. */
  emit(type, payload = {}) {
    const eventType = EVENT_TYPES.includes(type) ? type : 'warning'
    const event = {
      timestamp: new Date(this.now()).toISOString(),
      task_id: payload.task_id === undefined ? this.taskId : payload.task_id,
      type: eventType,
      ...payload
    }
    if (eventType === 'warning' && event.summary != null) event.summary = redactSecrets(event.summary)
    if (event.detail != null) event.detail = truncate(event.detail, 4000)
    // Every string field of the event is redacted, not a hand-picked list: a
    // Note, an output line or a blocked reason can all carry a token.
    redactEvent(event)
    if (event.path != null) event.path = String(event.path)
    this.events.push(event)
    if (this.events.length > this.ringSize) this.events.splice(0, this.events.length - this.ringSize)
    this.counts[eventType] = (this.counts[eventType] || 0) + 1
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch {
        // A broken observer is not allowed to interrupt execution.
      }
    }
    if (this.onEvent) {
      try {
        this.onEvent(event)
      } catch {
        // Same rule for the transport callback.
      }
    }
    return event
  }

  recent(limit = 50) {
    const value = Number(limit)
    if (!Number.isFinite(value) || value <= 0) return [...this.events]
    return this.events.slice(-Math.floor(value))
  }

  reset(taskId = null) {
    this.events = []
    this.counts = {}
    this.taskId = taskId
  }
}

module.exports = {
  DEFAULT_RING,
  NON_SECRET_EVENT_FIELDS,
  redactSecrets,
  redactEvent,
  truncate,
  EventBus,
  isPlainObject
}
