'use strict'

/**
 * HNS Domain Model (Update-Plan/Dual-UI.md 任务 9).
 *
 * The native frontend is never allowed to read the official DOM, an official CSS
 * class or an official selector (任务 8 / Gate I). It reads *this* vocabulary and
 * nothing else:
 *
 *   Session        what the sidebar lists
 *   Message        one user/assistant entry in the conversation timeline
 *   ToolEvent      one tool call or tool result inside a turn
 *   Task           the runnable/queued work the backend is executing
 *   ComposerState  what the composer may do right now (send / stop / disabled)
 *   BackendState   whether the Harness backend is reachable, and how it answered
 *   SettingsState  the settings the native UI is allowed to show
 *
 * Every normalizer is total: it accepts whatever the backend produced, fills the
 * documented fields, and never throws. A shape the backend changed is therefore a
 * *visible* degraded value (a missing title, an `unknown` role) rather than a
 * crash inside the renderer - which is exactly the property the Compatibility
 * Probe (任务 16) then measures.
 */

const MODEL_VERSION = 1

/** Conversation roles the native timeline understands. */
const ROLE = Object.freeze({
  USER: 'user',
  ASSISTANT: 'assistant',
  SYSTEM: 'system',
  TOOL: 'tool'
})

/** Message lifecycle states. */
const MESSAGE_STATUS = Object.freeze({
  PENDING: 'pending',
  STREAMING: 'streaming',
  COMPLETE: 'complete',
  FAILED: 'failed',
  INTERRUPTED: 'interrupted'
})

/** Tool lifecycle states. */
const TOOL_STATUS = Object.freeze({
  RUNNING: 'running',
  OK: 'ok',
  ERROR: 'error'
})

/** Backend reachability. */
const BACKEND_STATE = Object.freeze({
  READY: 'ready',
  DEGRADED: 'degraded',
  UNREACHABLE: 'unreachable',
  UNKNOWN: 'unknown'
})

/** Session status vocabulary, shared with the Harness journal reader. */
const SESSION_STATUS = Object.freeze({
  RUNNING: 'RUNNING',
  IDLE: 'IDLE',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  INTERRUPTED: 'INTERRUPTED'
})

function text(value, fallback = '') {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return fallback
  return String(value)
}

function nullableText(value) {
  const result = text(value, '').trim()
  return result ? result : null
}

function finiteNumber(value) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

/** Flatten the backend's content-block array into display text. */
function contentToText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/** Content blocks that describe a tool call, in the shape the timeline renders. */
function toolCallsOf(content) {
  if (!Array.isArray(content)) return []
  const calls = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type !== 'tool_call' && block.type !== 'tool-call' && block.type !== 'tool_use') continue
    calls.push(toolCall({
      id: block.id || block.callId || block.toolCallId,
      name: block.name || block.toolName,
      input: block.input ?? block.arguments ?? null
    }))
  }
  return calls
}

function normalizeError(value) {
  if (!value) return null
  if (typeof value === 'string') return { code: 'ERROR', message: value }
  return { code: text(value.code, 'ERROR'), message: text(value.message || value.error, '') }
}

/**
 * One Session row.
 *
 * @param {object} raw  a `session/list` item, a session-reader summary, or both
 */
function session(raw = {}) {
  const id = nullableText(raw.sessionId || raw.id)
  const running = Boolean(raw.running)
  return {
    id,
    title: nullableText(raw.title || raw.firstUserText) || (id ? `Session ${String(id).slice(0, 8)}` : 'Session'),
    status: text(raw.status, running ? SESSION_STATUS.RUNNING : SESSION_STATUS.IDLE),
    running,
    blank: Boolean(raw.blank),
    createdAt: finiteNumber(raw.createdAt),
    updatedAt: finiteNumber(raw.updatedAt),
    cwd: nullableText(raw.cwd),
    model: nullableText(raw.model),
    provider: nullableText(raw.provider),
    parentSessionId: nullableText(raw.parentSessionId),
    error: normalizeError(raw.error)
  }
}

function toolCall(raw = {}) {
  return {
    id: nullableText(raw.id || raw.callId),
    name: nullableText(raw.name) || 'tool',
    input: raw.input ?? null
  }
}

/**
 * One Message in the conversation timeline.
 *
 * @param {object} raw
 */
function message(raw = {}) {
  const content = raw.content
  return {
    id: nullableText(raw.id),
    sessionId: nullableText(raw.sessionId),
    role: Object.values(ROLE).includes(raw.role) ? raw.role : ROLE.SYSTEM,
    content: typeof content === 'string' ? content : contentToText(content),
    contentBlocks: Array.isArray(raw.contentBlocks) ? raw.contentBlocks : (Array.isArray(content) ? content : []),
    status: Object.values(MESSAGE_STATUS).includes(raw.status) ? raw.status : MESSAGE_STATUS.COMPLETE,
    toolCalls: Array.isArray(raw.toolCalls) ? raw.toolCalls.map(toolCall) : toolCallsOf(content),
    timestamp: finiteNumber(raw.timestamp ?? raw.time),
    seq: finiteNumber(raw.seq)
  }
}

/** One ToolEvent: a call, its result, or a running call without a result yet. */
function toolEvent(raw = {}) {
  return {
    id: nullableText(raw.id || raw.callId),
    sessionId: nullableText(raw.sessionId),
    name: nullableText(raw.name) || 'tool',
    status: Object.values(TOOL_STATUS).includes(raw.status) ? raw.status : TOOL_STATUS.RUNNING,
    input: raw.input ?? null,
    output: raw.output ?? null,
    error: normalizeError(raw.error),
    startedAt: finiteNumber(raw.startedAt),
    finishedAt: finiteNumber(raw.finishedAt),
    seq: finiteNumber(raw.seq)
  }
}

/** One runnable/queued Task (the Mega scheduler's own unit, normalized). */
function task(raw = {}) {
  return {
    id: nullableText(raw.id || raw.taskId),
    sessionId: nullableText(raw.sessionId),
    title: nullableText(raw.title || raw.promptPreview || raw.prompt) || 'Task',
    status: text(raw.status, 'PENDING').toUpperCase(),
    prompt: text(raw.prompt, ''),
    queueRank: finiteNumber(raw.queueRank),
    startAtMs: finiteNumber(raw.startAtMs),
    updatedAt: finiteNumber(raw.updatedAt || raw.savedAt)
  }
}

/** What the composer may do, derived from the active session's real state. */
function composerState({ session: activeSession = null, ready = false, sending = false, reason = null } = {}) {
  const running = Boolean(activeSession?.running) || activeSession?.status === SESSION_STATUS.RUNNING
  const hasSession = Boolean(activeSession?.id)
  return {
    ready: Boolean(ready),
    sessionId: activeSession?.id || null,
    canSend: Boolean(ready) && hasSession && !sending,
    canCreateSession: Boolean(ready),
    canStop: Boolean(ready) && hasSession && running,
    running,
    placeholder: hasSession ? 'Message the Harness...' : 'Select or create a session to start',
    reason: reason ? String(reason) : null
  }
}

/** Backend reachability plus the honest reason when it is not ready. */
function backendState({ state = BACKEND_STATE.UNKNOWN, origin = null, version = null, reason = null, latencyMs = null } = {}) {
  return {
    state: Object.values(BACKEND_STATE).includes(state) ? state : BACKEND_STATE.UNKNOWN,
    origin: nullableText(origin),
    version: nullableText(version),
    reason: reason ? String(reason) : null,
    latencyMs: finiteNumber(latencyMs),
    healthy: state === BACKEND_STATE.READY
  }
}

/** The settings the native frontend is allowed to show. */
function settingsState(raw = null) {
  if (!raw || typeof raw !== 'object') {
    return { available: false, model: null, models: [], permissionMode: null, telemetryMode: null, workspace: null, reason: 'settings backend unavailable' }
  }
  return {
    available: true,
    model: nullableText(raw.model || raw.defaultModel),
    models: Array.isArray(raw.models) ? raw.models.map((entry) => text(entry, '')).filter(Boolean) : [],
    permissionMode: nullableText(raw.permissionMode),
    telemetryMode: nullableText(raw.telemetryMode),
    workspace: nullableText(raw.workspace),
    reason: null
  }
}

/**
 * Classify one durable Session journal event into the HNS timeline vocabulary.
 *
 * The journal format is the harness's own documented persistence format
 * (`dsh-session-format`); reading it is the Compatibility Adapter's job, and it
 * is not a DOM. Unknown event types are reported as `{ kind: 'unknown' }` so the
 * probe can count them instead of silently dropping data.
 */
function classifyEvent(event = {}) {
  const type = text(event.type, '')
  const data = event.data && typeof event.data === 'object' ? event.data : {}
  // The session header line is part of the documented format, not an event and
  // not an unknown shape: folding a journal must never count it as a drift.
  if (type === 'session' || event.type === undefined && event.id !== undefined) {
    return { kind: 'header', id: nullableText(data.id || event.id), createdAt: finiteNumber(data.createdAt || event.createdAt) }
  }
  if (type === 'user/message') {
    const source = data.source && typeof data.source === 'object' ? data.source : {}
    return {
      kind: 'user_message',
      role: ROLE.USER,
      id: nullableText(data.message?.id || data.id || source.rpcId),
      content: data.message?.content ?? data.content ?? data.text ?? '',
      timestamp: finiteNumber(event.time),
      seq: finiteNumber(event.seq)
    }
  }
  if (type === 'assistant/message') {
    return {
      kind: 'assistant_message',
      role: ROLE.ASSISTANT,
      id: nullableText(data.message?.id || data.id),
      content: data.message?.content ?? data.content ?? '',
      interrupted: Boolean(data.interrupted),
      timestamp: finiteNumber(event.time),
      seq: finiteNumber(event.seq)
    }
  }
  if (type === 'tool/call') {
    return {
      kind: 'tool_call',
      id: nullableText(data.callId || data.id || data.toolCallId),
      name: nullableText(data.name || data.toolName) || 'tool',
      input: data.input ?? data.arguments ?? null,
      timestamp: finiteNumber(event.time),
      seq: finiteNumber(event.seq)
    }
  }
  if (type === 'tool/result') {
    return {
      kind: 'tool_result',
      id: nullableText(data.callId || data.id || data.toolCallId),
      name: nullableText(data.name || data.toolName),
      output: data.result ?? data.output ?? data.content ?? null,
      error: data.isError || data.error ? normalizeError(data.error || 'tool failed') : null,
      timestamp: finiteNumber(event.time),
      seq: finiteNumber(event.seq)
    }
  }
  if (type === 'turn/start') {
    return { kind: 'turn_start', seq: finiteNumber(event.seq), timestamp: finiteNumber(event.time) }
  }
  if (type === 'turn/end') {
    const reason = data.reason && typeof data.reason === 'object' ? data.reason : {}
    return {
      kind: 'turn_end',
      reason: text(reason.kind, 'unknown'),
      error: normalizeError(reason.error || reason.failure),
      seq: finiteNumber(event.seq),
      timestamp: finiteNumber(event.time)
    }
  }
  if (type === 'session/title') {
    return { kind: 'title', title: nullableText(data.title), seq: finiteNumber(event.seq) }
  }
  return { kind: 'unknown', type, seq: finiteNumber(event.seq), timestamp: finiteNumber(event.time) }
}

/**
 * Fold a raw journal into the HNS timeline.
 *
 * @param {object[]} events  raw `session.jsonl` events (header line optional)
 * @param {object}   [options]
 * @param {string}   [options.sessionId]
 * @returns {{messages: object[], toolEvents: object[], unknown: object[], turnEnd: object|null}}
 */
function timelineFromJournal(events = [], { sessionId = null } = {}) {
  const messages = []
  const toolEvents = []
  const unknown = []
  let turnEnd = null
  for (const event of Array.isArray(events) ? events : []) {
    const classified = classifyEvent(event)
    if (classified.kind === 'user_message' || classified.kind === 'assistant_message') {
      messages.push(message({
        id: classified.id || `seq-${classified.seq ?? messages.length}`,
        sessionId,
        role: classified.role,
        content: classified.content,
        status: classified.interrupted ? MESSAGE_STATUS.INTERRUPTED : MESSAGE_STATUS.COMPLETE,
        timestamp: classified.timestamp,
        seq: classified.seq
      }))
      continue
    }
    if (classified.kind === 'tool_call') {
      if (classified.id && toolEvents.some((entry) => entry.id === classified.id)) continue
      toolEvents.push(toolEvent({
        id: classified.id,
        sessionId,
        name: classified.name,
        status: TOOL_STATUS.RUNNING,
        input: classified.input,
        startedAt: classified.timestamp,
        seq: classified.seq
      }))
      continue
    }
    if (classified.kind === 'tool_result') {
      const existing = classified.id ? toolEvents.find((entry) => entry.id === classified.id) : null
      const patch = {
        id: classified.id || existing?.id || null,
        sessionId,
        name: classified.name || existing?.name || 'tool',
        status: classified.error ? TOOL_STATUS.ERROR : TOOL_STATUS.OK,
        output: classified.output,
        error: classified.error,
        finishedAt: classified.timestamp,
        seq: classified.seq
      }
      if (existing) {
        Object.assign(existing, patch, { input: existing.input, startedAt: existing.startedAt })
      } else {
        toolEvents.push(toolEvent({ ...patch, input: null }))
      }
      continue
    }
    if (classified.kind === 'turn_end') turnEnd = classified
    if (classified.kind === 'unknown') unknown.push(classified)
  }
  return { messages, toolEvents, unknown, turnEnd }
}

/** The entity list the model guarantees, for the capability/acceptance report. */
function describeModel() {
  return {
    version: MODEL_VERSION,
    entities: ['Session', 'Message', 'ToolEvent', 'Task', 'ComposerState', 'BackendState', 'SettingsState'],
    roles: Object.values(ROLE),
    messageStatus: Object.values(MESSAGE_STATUS),
    toolStatus: Object.values(TOOL_STATUS),
    backendState: Object.values(BACKEND_STATE)
  }
}

module.exports = {
  MODEL_VERSION,
  ROLE,
  MESSAGE_STATUS,
  TOOL_STATUS,
  BACKEND_STATE,
  SESSION_STATUS,
  contentToText,
  toolCallsOf,
  session,
  message,
  toolCall,
  toolEvent,
  task,
  composerState,
  backendState,
  settingsState,
  classifyEvent,
  timelineFromJournal,
  describeModel,
  normalizeError
}
