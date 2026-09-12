'use strict'

/**
 * Sub-worker structured IPC protocol (v1).
 *
 * Design rule (plan §7): the Controller and the worker never couple through
 * free-form chat. Every exchange is a structured, versioned, validated message
 * so the whole run stays auditable.
 *
 * Framing: newline-delimited JSON over a pipe (worker stdio). A single line is
 * always one complete message; the codec below tolerates arbitrary chunk
 * boundaries in both directions.
 */

const PROTOCOL_VERSION = 1

/** Controller -> worker. */
const CONTROLLER_MESSAGES = Object.freeze([
  'hello',
  'assign_task',
  'pause',
  'resume',
  'stop_task',
  'note',
  'take_over',
  'shutdown',
  'ping'
])

/** Worker -> controller. */
const WORKER_MESSAGES = Object.freeze([
  'ready',
  'state',
  'stage',
  'event',
  'result',
  'log',
  'note_applied',
  'heartbeat',
  'pong',
  'error',
  'bye'
])

/**
 * Worker lifecycle states (plan §5 plus the PAUSING/HANDOFF states required by
 * §15 user intervention).
 */
const WORKER_STATES = Object.freeze([
  'OFF',
  'STARTING',
  'IDLE',
  'ASSIGNED',
  'RUNNING',
  'PAUSING',
  'PAUSED',
  'BLOCKED',
  'READY_FOR_REVIEW',
  'FAILED',
  'STOPPING',
  'CRASHED',
  'HANDOFF'
])

/** Internal execution stages, recorded separately from the lifecycle (plan §5). */
const EXECUTION_STAGES = Object.freeze([
  'INSPECTING',
  'PLANNING_EXECUTION',
  'IMPLEMENTING',
  'TESTING',
  'FIXING',
  'VALIDATING',
  'REPORTING'
])

/** Auditable event vocabulary (plan §13). */
const EVENT_TYPES = Object.freeze([
  'task_received',
  'task_started',
  'inspection_started',
  'file_read',
  'file_write',
  'file_delete',
  'command_started',
  'command_output',
  'command_finished',
  'test_started',
  'test_result',
  'git_status',
  'diff_generated',
  'warning',
  'error',
  'blocked',
  'note_applied',
  'task_completed',
  'task_failed',
  'state_changed',
  'stage_changed'
])

/** Terminal statuses returned by the worker result protocol (plan §8). */
const RESULT_STATUSES = Object.freeze([
  'completed',
  'failed',
  'blocked',
  'cancelled',
  'rejected',
  'unsupported_capability',
  'handoff'
])

/**
 * Machine-checkable result codes. `sent` to the controller alongside the human
 * readable reason so a Controller can branch without parsing prose.
 */
const RESULT_CODES = Object.freeze({
  OK: 'OK',
  TASK_REJECTED: 'TASK_REJECTED',
  REQUIRES_CONTROLLER: 'REQUIRES_CONTROLLER',
  UNSUPPORTED_CAPABILITY: 'UNSUPPORTED_CAPABILITY',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  PATH_FORBIDDEN: 'PATH_FORBIDDEN',
  COMMAND_DENIED: 'COMMAND_DENIED',
  MISSING_SPECIFICATION: 'MISSING_SPECIFICATION',
  NO_EXECUTABLE_OPERATION: 'NO_EXECUTABLE_OPERATION',
  OPERATION_FAILED: 'OPERATION_FAILED',
  TESTS_FAILED: 'TESTS_FAILED',
  ACCEPTANCE_FAILED: 'ACCEPTANCE_FAILED',
  BLOCKED: 'BLOCKED',
  CANCELLED: 'CANCELLED',
  CRASHED: 'CRASHED',
  TIMEOUT: 'TIMEOUT',
  WORKSPACE_LOCKED: 'WORKSPACE_LOCKED',
  INVALID_MESSAGE: 'INVALID_MESSAGE'
})

const RISK_LEVELS = Object.freeze(['L0', 'L1', 'L2', 'L3', 'L4'])
/** Plan §9: the executor may run L0-L2; L3/L4 must be rejected. */
const ALLOWED_RISK_LEVELS = Object.freeze(['L0', 'L1', 'L2'])

const RISK_BY_TIER = Object.freeze({
  L0: 'command',
  L1: 'local_modification',
  L2: 'module_implementation',
  L3: 'architecture_modification',
  L4: 'product_direction'
})

/** Declared runtime capability set (plan §23). */
const CAPABILITIES = Object.freeze({
  code: true,
  shell: true,
  git: true,
  browser: false,
  vision: false,
  // `network` is not part of the original §23 object; it is additive so a task
  // that asks for `permissions.network` can be honoured or refused explicitly
  // instead of silently succeeding through a shell command.
  network: true
})

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function toPositiveInt(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback
}

/** Stable, filesystem-safe task id (never a path fragment). */
function sanitizeTaskId(raw) {
  const text = String(raw == null ? '' : raw).trim()
  if (!text) return ''
  return text
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.-]+/, '')
    .replace(/[.-]+$/, '')
    .slice(0, 120)
}

function normalizePathList(value) {
  if (!Array.isArray(value)) return []
  return value
    .map((entry) => String(entry == null ? '' : entry).trim())
    .filter(Boolean)
    .map((entry) => entry.replaceAll('\\', '/'))
}

function normalizePermissions(value) {
  const source = isPlainObject(value) ? value : {}
  return {
    read: source.read !== false,
    write: Boolean(source.write),
    shell: Boolean(source.shell),
    git_commit: Boolean(source.git_commit),
    // Default is the documented example: no network unless the Controller asks.
    network: Boolean(source.network)
  }
}

/**
 * Validate and normalize a Task Object (plan §7.1). Validation errors are
 * returned, never thrown, so an invalid dispatch can be answered with a
 * structured rejection instead of ending the worker.
 */
function validateTask(raw) {
  const errors = []
  if (!isPlainObject(raw)) return { ok: false, errors: ['task must be an object'], task: null }

  const version = toPositiveInt(raw.version, 0)
  if (version !== PROTOCOL_VERSION) errors.push(`unsupported task version: ${raw.version}`)

  const taskId = sanitizeTaskId(raw.task_id)
  if (!taskId) errors.push('task_id is required')

  const objective = String(raw.objective == null ? '' : raw.objective).trim()
  if (!objective) errors.push('objective is required')

  const targetRepo = String(raw.target_repo == null ? '' : raw.target_repo).trim()
  if (!targetRepo) errors.push('target_repo is required')

  // Risk classification is the Controller's job and the guard's only input, so
  // it is required: an omitted risk_level must never be read as "safe enough"
  // (fail closed, plan §9 / AC-08).
  if (raw.risk_level == null || String(raw.risk_level).trim() === '') {
    errors.push('risk_level is required (L0/L1/L2 are accepted by the executor)')
  }
  const riskLevel = String(raw.risk_level == null ? '' : raw.risk_level).trim().toUpperCase()
  if (riskLevel && !RISK_LEVELS.includes(riskLevel)) errors.push(`unknown risk_level: ${raw.risk_level}`)

  const workspaceMode = String(raw.workspace_mode == null ? '' : raw.workspace_mode).trim()
  if (workspaceMode && !['shared', 'isolated_worktree'].includes(workspaceMode)) {
    errors.push(`unknown workspace_mode: ${workspaceMode}`)
  }

  if (errors.length) return { ok: false, errors, task: null }

  const operations = Array.isArray(raw.operations)
    ? raw.operations.filter(isPlainObject).map((operation) => ({ ...operation }))
    : []

  const task = {
    version,
    task_id: taskId,
    created_at: String(raw.created_at || new Date().toISOString()),
    objective,
    target_repo: targetRepo,
    workspace: raw.workspace == null ? null : String(raw.workspace),
    workspace_mode: workspaceMode || 'isolated_worktree',
    allowed_paths: normalizePathList(raw.allowed_paths),
    forbidden_paths: normalizePathList(raw.forbidden_paths),
    acceptance: Array.isArray(raw.acceptance) ? raw.acceptance.map((item) => String(item)) : [],
    acceptance_commands: Array.isArray(raw.acceptance_commands)
      ? raw.acceptance_commands.map((item) => String(item)).filter((item) => item.trim())
      : [],
    permissions: normalizePermissions(raw.permissions),
    risk_level: riskLevel,
    requires_vision: Boolean(raw.requires_vision),
    operations,
    notes: []
  }
  return { ok: true, errors: [], task }
}

/** A task is spec-complete when it carries at least one executable operation. */
function hasExecutableSpecification(task) {
  return Boolean(task) && Array.isArray(task.operations) && task.operations.length > 0
}

function createEventFactory({ now = () => Date.now() } = {}) {
  return function makeEvent(type, payload = {}) {
    const event = {
      timestamp: new Date(now()).toISOString(),
      type,
      ...payload
    }
    if (event.summary == null) event.summary = ''
    return event
  }
}

function emptyTests() {
  return { passed: 0, failed: 0, skipped: 0 }
}

/**
 * Result Object (plan §8). `ok` is not part of the wire contract; it is derived
 * for the controller's convenience.
 */
function createResult(taskId, overrides = {}) {
  const status = RESULT_STATUSES.includes(overrides.status) ? overrides.status : 'completed'
  const result = {
    task_id: taskId,
    status,
    summary: String(overrides.summary || ''),
    changed_files: Array.isArray(overrides.changed_files) ? [...overrides.changed_files] : [],
    // Additive to the plan's Result Object: the same list with per-file status
    // (A/M/D) so the Live View can render `M src/...` without re-deriving it.
    changed_file_details: Array.isArray(overrides.changed_file_details)
      ? overrides.changed_file_details.map((entry) => ({ path: String(entry?.path ?? ''), status: String(entry?.status ?? 'M') }))
      : [],
    tests: { ...emptyTests(), ...(isPlainObject(overrides.tests) ? overrides.tests : {}) },
    git: {
      dirty: Boolean(overrides.git?.dirty),
      commit: overrides.git?.commit == null ? null : overrides.git.commit,
      branch: overrides.git?.branch == null ? null : overrides.git.branch
    },
    warnings: Array.isArray(overrides.warnings) ? [...overrides.warnings] : [],
    needs_controller_review: overrides.needs_controller_review !== false,
    code: overrides.code || RESULT_CODES.OK,
    reason: overrides.reason == null ? null : String(overrides.reason),
    needs_controller_decision: Boolean(overrides.needs_controller_decision),
    requires_controller: Boolean(overrides.requires_controller),
    acceptance: Array.isArray(overrides.acceptance) ? [...overrides.acceptance] : [],
    stage_log: Array.isArray(overrides.stage_log) ? [...overrides.stage_log] : [],
    started_at: overrides.started_at || null,
    finished_at: overrides.finished_at || new Date().toISOString()
  }
  Object.defineProperty(result, 'ok', {
    value: status === 'completed',
    enumerable: false
  })
  return result
}

/** Blocked / rejected helper so every refusal carries the same shape (§8). */
function blockedResult(taskId, { code = RESULT_CODES.BLOCKED, reason, requires_controller = true, needs_controller_decision = true } = {}) {
  return createResult(taskId, {
    status: code === RESULT_CODES.TASK_REJECTED || code === RESULT_CODES.REQUIRES_CONTROLLER
      ? 'rejected'
      : code === RESULT_CODES.UNSUPPORTED_CAPABILITY ? 'unsupported_capability' : 'blocked',
    summary: String(reason || 'blocked'),
    code,
    reason: String(reason || 'blocked'),
    needs_controller_review: true,
    needs_controller_decision,
    requires_controller
  })
}

function envelope(type, payload = {}, extra = {}) {
  return { v: PROTOCOL_VERSION, type, ...extra, payload }
}

function encode(message) {
  return `${JSON.stringify(message)}\n`
}

/** Incremental newline-JSON decoder: one instance per duplex stream. */
class LineDecoder {
  constructor({ maxLine = 4 * 1024 * 1024 } = {}) {
    this.buffer = ''
    this.maxLine = maxLine
    this.errors = []
  }

  push(chunk) {
    this.buffer += chunk.toString()
    const messages = []
    let index = this.buffer.indexOf('\n')
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (line) {
        try {
          const parsed = JSON.parse(line)
          if (isPlainObject(parsed)) messages.push(parsed)
          else this.errors.push(`dropped non-object message: ${line.slice(0, 120)}`)
        } catch (error) {
          this.errors.push(`dropped malformed message: ${String(error?.message || error)}`)
        }
      }
      index = this.buffer.indexOf('\n')
    }
    if (this.buffer.length > this.maxLine) {
      this.errors.push('dropped oversized partial message')
      this.buffer = ''
    }
    return messages
  }
}

/** Validate one decoded message from either side of the pipe. */
function validateMessage(message, direction = 'controller-to-worker') {
  const allowed = direction === 'controller-to-worker' ? CONTROLLER_MESSAGES : WORKER_MESSAGES
  if (!isPlainObject(message)) return { ok: false, error: 'message must be an object' }
  if (toPositiveInt(message.v, 0) !== PROTOCOL_VERSION) return { ok: false, error: `unsupported protocol version: ${message.v}` }
  const type = String(message.type || '')
  if (!allowed.includes(type)) return { ok: false, error: `unexpected ${direction} message type: ${type}` }
  if (!isPlainObject(message.payload)) return { ok: false, error: 'payload must be an object' }
  return { ok: true, error: null }
}

module.exports = {
  PROTOCOL_VERSION,
  CONTROLLER_MESSAGES,
  WORKER_MESSAGES,
  WORKER_STATES,
  EXECUTION_STAGES,
  EVENT_TYPES,
  RESULT_STATUSES,
  RESULT_CODES,
  RISK_LEVELS,
  ALLOWED_RISK_LEVELS,
  RISK_BY_TIER,
  CAPABILITIES,
  isPlainObject,
  sanitizeTaskId,
  normalizePathList,
  normalizePermissions,
  validateTask,
  hasExecutableSpecification,
  createEventFactory,
  createResult,
  blockedResult,
  emptyTests,
  envelope,
  encode,
  LineDecoder,
  validateMessage
}
