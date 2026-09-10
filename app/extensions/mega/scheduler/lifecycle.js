'use strict'

/**
 * Canonical task lifecycle vocabulary shared by the scheduler, the history
 * layer and the notification layer.
 *
 *   QUEUED -> RUNNING -> SUSPENDED -> RUNNING -> TERMINAL
 *
 *   TERMINAL = COMPLETED | FAILED_FINAL | CANCELLED
 *
 * The persisted `task.status` values stay backward compatible with the
 * existing queue files (PENDING, SUSPENDED, DISPATCHING, RUNNING, COMPLETED,
 * FAILED, CANCELED, INTERRUPTED) while every terminal transition is classified
 * into the canonical vocabulary used by TASK_TERMINATED events, desktop
 * notifications and the acceptance matrix.
 *
 * This module is intentionally dependency-free so both the scheduler and the
 * unit tests can consume it without Electron or the filesystem.
 */

const TERMINAL_EVENT = 'TASK_TERMINATED'

const CANONICAL_TERMINAL = Object.freeze({
  COMPLETED: 'COMPLETED',
  FAILED_FINAL: 'FAILED_FINAL',
  CANCELLED: 'CANCELLED'
})

/** Persisted statuses that mean "this task will never run again". */
const TERMINAL_STATUSES = Object.freeze(['COMPLETED', 'FAILED', 'FAILED_FINAL', 'CANCELED', 'CANCELLED', 'INTERRUPTED'])
const ACTIVE_STATUSES = Object.freeze(['DISPATCHING', 'RUNNING'])
const QUEUED_STATUSES = Object.freeze(['PENDING', 'SUSPENDED'])

const REASONS = Object.freeze({
  USER_CANCEL: 'user-cancel',
  QUEUE_CLEARED: 'queue-cleared',
  REMOVED: 'removed',
  APP_QUIT: 'app-quit',
  APP_RESTART: 'app-restart',
  PEAK_PAUSE: 'peak-pause',
  STALL_RETRY: 'stall-retry'
})

function normalizeStatus(status) {
  return String(status ?? '').trim().toUpperCase()
}

function isActiveStatus(status) {
  return ACTIVE_STATUSES.includes(normalizeStatus(status))
}

function isQueuedStatus(status) {
  return QUEUED_STATUSES.includes(normalizeStatus(status))
}

function isTerminalStatus(status) {
  return TERMINAL_STATUSES.includes(normalizeStatus(status))
}

/**
 * Maps any accepted status (persisted or canonical) onto the canonical terminal
 * vocabulary. Returns null for non-terminal statuses.
 */
function terminalState(status) {
  const s = normalizeStatus(status)
  if (s === CANONICAL_TERMINAL.COMPLETED) return CANONICAL_TERMINAL.COMPLETED
  if (s === CANONICAL_TERMINAL.FAILED_FINAL || s === 'FAILED') return CANONICAL_TERMINAL.FAILED_FINAL
  if (s === CANONICAL_TERMINAL.CANCELLED || s === 'CANCELED' || s === 'INTERRUPTED') return CANONICAL_TERMINAL.CANCELLED
  return null
}

/** The persisted status a canonical terminal state should be stored as. */
function persistedStatusFor(state, fallback = 'CANCELED') {
  if (state === CANONICAL_TERMINAL.COMPLETED) return 'COMPLETED'
  if (state === CANONICAL_TERMINAL.FAILED_FINAL) return 'FAILED'
  if (state === CANONICAL_TERMINAL.CANCELLED) return normalizeStatus(fallback) === 'INTERRUPTED' ? 'INTERRUPTED' : 'CANCELED'
  return normalizeStatus(fallback)
}

/** Human readable status label used in notification bodies. */
function statusLabel(state) {
  if (state === CANONICAL_TERMINAL.COMPLETED) return 'Completed'
  if (state === CANONICAL_TERMINAL.FAILED_FINAL) return 'Failed'
  if (state === CANONICAL_TERMINAL.CANCELLED) return 'Cancelled'
  return 'Terminated'
}

function firstLine(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || ''
}

function truncate(text, max = 72) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (value.length <= max) return value
  return `${value.slice(0, Math.max(1, max - 1))}…`
}

/** Short, notification-safe task name derived from a task record or event. */
function taskDisplayName(task) {
  if (!task || typeof task !== 'object') return 'task'
  for (const candidate of [task.name, task.taskName, task.displayName]) {
    if (typeof candidate === 'string' && candidate.trim()) return truncate(candidate, 72)
  }
  const line = firstLine(task.prompt)
  if (line) return truncate(line, 72)
  return String(task.id || task.taskId || 'task')
}

/** Short error summary for the terminal event payload (never throws). */
function errorSummary(error, max = 160) {
  if (error == null) return null
  if (typeof error === 'string') return truncate(error, max) || null
  if (typeof error === 'object') {
    const code = error.code ? String(error.code) : ''
    const message = error.message ? String(error.message) : ''
    const joined = [code, message].filter(Boolean).join(': ')
    if (joined) return truncate(joined, max)
    try {
      return truncate(JSON.stringify(error), max)
    } catch {
      return null
    }
  }
  return truncate(String(error), max) || null
}

/** Short positive result summary (duration + delivery target). */
function shortResult(task, { endedAt } = {}) {
  if (!task || typeof task !== 'object') return null
  const end = Number(endedAt ?? task.endedAt) || null
  const start = Number(task.startedAt ?? task.createdAt) || null
  if (!end || !start || end < start) return null
  const seconds = Math.max(0, Math.round((end - start) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  if (minutes < 60) return `${minutes}m ${rest}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

/**
 * Idempotency epoch for one terminal transition of one task. Together with the
 * task id and the canonical final status it forms the notification dedup key.
 */
function terminalEpoch(task) {
  if (!task || typeof task !== 'object') return 0
  const candidate = Number(task.endedAt ?? task.terminalEpoch)
  return Number.isFinite(candidate) && candidate > 0 ? Math.trunc(candidate) : 0
}

function terminalKey(task, finalStatus) {
  const id = String(task?.id ?? task?.taskId ?? 'task')
  const state = terminalState(finalStatus) || normalizeStatus(finalStatus) || 'TERMINAL'
  const epoch = terminalEpoch(task) || Number(task?.terminalEpoch) || 0
  return `${id}#${state}#${epoch}`
}

/**
 * Builds the single terminal event payload (TASK_TERMINATED) shared by the
 * scheduler, the notifier and the UI.
 */
function buildTerminalEvent(task, { finalStatus, status, reason = null, source = null, exitCode = null } = {}) {
  const id = String(task?.id ?? task?.taskId ?? 'task')
  const state = terminalState(finalStatus || status) || CANONICAL_TERMINAL.CANCELLED
  const completedAt = Number(task?.endedAt) || Date.now()
  const taskName = taskDisplayName(task)
  const summary = errorSummary(task?.error)
  return {
    type: TERMINAL_EVENT,
    taskId: id,
    id,
    taskName,
    displayName: taskName,
    finalStatus: state,
    status: normalizeStatus(status || finalStatus),
    statusLabel: statusLabel(state),
    terminalEpoch: terminalEpoch(task),
    terminalKey: terminalKey(task, state),
    completedAt,
    endedAt: completedAt,
    shortResult: state === CANONICAL_TERMINAL.COMPLETED ? shortResult(task, { endedAt: completedAt }) : null,
    errorSummary: summary,
    reason: reason == null ? null : String(reason),
    source: source || (task?.deliveryMode === 'official-session' ? 'official-session' : 'queue'),
    exitCode: exitCode == null ? null : Number(exitCode),
    deliveryMode: task?.deliveryMode || null,
    officialSessionId: task?.officialSessionId || null,
    attempts: Number(task?.attempts || 0),
    createdAt: Number(task?.createdAt) || null,
    startedAt: Number(task?.startedAt) || null,
    promptPreview: typeof task?.prompt === 'string' ? truncate(task.prompt, 160) : null
  }
}

module.exports = {
  TERMINAL_EVENT,
  CANONICAL_TERMINAL,
  TERMINAL_STATUSES,
  REASONS,
  normalizeStatus,
  isActiveStatus,
  isQueuedStatus,
  isTerminalStatus,
  terminalState,
  persistedStatusFor,
  statusLabel,
  taskDisplayName,
  errorSummary,
  terminalEpoch,
  terminalKey,
  buildTerminalEvent
}
