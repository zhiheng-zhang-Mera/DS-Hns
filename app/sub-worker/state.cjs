'use strict'

/**
 * Sub-worker lifecycle state machine + persistent store (plan §5, §17).
 *
 * The state machine is shared by the controller-side worker manager and the
 * worker runtime, so both sides agree on what a legal transition is instead of
 * trusting each other's bookkeeping.
 *
 * Persistence layout (all under the DS-Harness root, none of it committed):
 *   data/sub-worker/config.json          controller-owned configuration
 *   data/sub-worker/state.json           last known worker state + handoff info
 *   data/sub-worker/queue.json           accepted-but-not-yet-dispatched tasks
 *   data/sub-worker/history.json         terminal task records (bounded)
 *   data/sub-worker/tasks/<task_id>.json full per-task audit record
 *   data/sub-worker/workspace-lock.json  single-writer lock on a workspace
 *   runtime/sub-worker-process.json      orphan-recovery ownership record
 *   logs/sub-worker.log                  worker runtime log
 *   logs/sub-worker/<task_id>.log        per-task log
 */

const fs = require('node:fs')
const path = require('node:path')
const {
  WORKER_STATES,
  EXECUTION_STAGES,
  sanitizeTaskId,
  isPlainObject
} = require('./protocol.cjs')

const DEFAULT_MAX_HISTORY = 200
const DEFAULT_MAX_QUEUE = 100

/**
 * Legal transitions. `OFF` is the only state reachable from nothing, and every
 * operational state can be stopped or crash.
 */
const TRANSITIONS = Object.freeze({
  OFF: ['STARTING'],
  STARTING: ['IDLE', 'FAILED', 'CRASHED', 'STOPPING'],
  IDLE: ['ASSIGNED', 'STOPPING', 'CRASHED', 'FAILED', 'HANDOFF', 'PAUSED'],
  ASSIGNED: ['RUNNING', 'IDLE', 'STOPPING', 'FAILED', 'BLOCKED', 'PAUSING', 'CRASHED', 'HANDOFF'],
  RUNNING: ['PAUSING', 'PAUSED', 'READY_FOR_REVIEW', 'BLOCKED', 'FAILED', 'STOPPING', 'CRASHED', 'IDLE', 'HANDOFF'],
  PAUSING: ['PAUSED', 'RUNNING', 'STOPPING', 'CRASHED', 'FAILED', 'HANDOFF'],
  PAUSED: ['RUNNING', 'STOPPING', 'IDLE', 'HANDOFF', 'CRASHED', 'FAILED', 'BLOCKED'],
  BLOCKED: ['IDLE', 'STOPPING', 'RUNNING', 'HANDOFF', 'CRASHED', 'FAILED'],
  READY_FOR_REVIEW: ['IDLE', 'STOPPING', 'ASSIGNED', 'HANDOFF', 'CRASHED', 'FAILED'],
  FAILED: ['IDLE', 'STARTING', 'STOPPING', 'HANDOFF', 'CRASHED'],
  STOPPING: ['OFF', 'CRASHED', 'HANDOFF'],
  CRASHED: ['STARTING', 'OFF', 'STOPPING', 'HANDOFF'],
  HANDOFF: ['STARTING', 'OFF', 'STOPPING']
})

function isWorkerState(value) {
  return WORKER_STATES.includes(String(value || '').toUpperCase())
}

function isExecutionStage(value) {
  return EXECUTION_STAGES.includes(String(value || '').toUpperCase())
}

function canTransition(from, to) {
  const source = String(from || '').toUpperCase()
  const target = String(to || '').toUpperCase()
  if (!isWorkerState(source) || !isWorkerState(target)) return false
  if (source === target) return true
  return (TRANSITIONS[source] || []).includes(target)
}

function assertTransition(from, to) {
  if (canTransition(from, to)) return true
  const error = new Error(`illegal sub-worker state transition: ${from} -> ${to}`)
  error.code = 'ILLEGAL_TRANSITION'
  throw error
}

/** States in which the worker is busy with a task. */
function isBusyState(state) {
  return ['ASSIGNED', 'RUNNING', 'PAUSING', 'PAUSED', 'BLOCKED'].includes(String(state || '').toUpperCase())
}

function isTerminalTaskStatus(status) {
  return ['completed', 'failed', 'blocked', 'cancelled', 'rejected', 'unsupported_capability', 'handoff']
    .includes(String(status || ''))
}

function defaultConfig() {
  return {
    enabledOnStartup: false,
    maxWorkers: 1,
    autoDelegate: false,
    workspaceMode: 'isolated_worktree',
    keepChangesOnStop: true,
    allowGitCommit: false,
    showNotifications: true,
    // Additive, documented in docs/sub-worker.md: how long a single worker
    // command may run before it is treated as a timeout and killed.
    commandTimeoutMs: 30 * 60 * 1000,
    // Worker heartbeats are the supervisor's liveness signal (multi-sub.md §32).
    heartbeatMs: 2000,
    /**
     * Multi-worker execution (multi-sub.md). `adaptiveWorkers: false` keeps the
     * documented compatibility mode: exactly one worker on one code path.
     */
    adaptiveWorkers: false,
    // The resolved resource configuration lives in resource-config.cjs; a
    // persisted copy may override individual keys.
    resources: null
  }
}

function publicConfig(raw) {
  const defaults = defaultConfig()
  const source = isPlainObject(raw) ? raw : {}
  const maxWorkers = Number(source.maxWorkers)
  return {
    enabledOnStartup: source.enabledOnStartup === true,
    // Compatibility mode is the default: one worker unless the user opts into
    // the adaptive scheduler (multi-sub.md §36).
    maxWorkers: Number.isFinite(maxWorkers) && maxWorkers >= 1 ? Math.floor(maxWorkers) : defaults.maxWorkers,
    autoDelegate: source.autoDelegate === true,
    workspaceMode: ['shared', 'isolated_worktree'].includes(source.workspaceMode)
      ? source.workspaceMode
      : defaults.workspaceMode,
    keepChangesOnStop: source.keepChangesOnStop !== false,
    allowGitCommit: source.allowGitCommit === true,
    showNotifications: source.showNotifications !== false,
    commandTimeoutMs: Number.isFinite(Number(source.commandTimeoutMs)) && Number(source.commandTimeoutMs) > 0
      ? Math.floor(Number(source.commandTimeoutMs))
      : defaults.commandTimeoutMs,
    heartbeatMs: Number.isFinite(Number(source.heartbeatMs)) && Number(source.heartbeatMs) > 0
      ? Math.floor(Number(source.heartbeatMs))
      : defaults.heartbeatMs,
    adaptiveWorkers: source.adaptiveWorkers === true,
    resources: isPlainObject(source.resources) ? { ...source.resources } : null
  }
}

function emptyState() {
  return {
    version: 1,
    state: 'OFF',
    stage: null,
    worker_id: null,
    pid: null,
    task_id: null,
    objective: null,
    startedAt: null,
    updatedAt: null,
    lastError: null,
    lastResult: null,
    restarts: 0
  }
}

function readJsonFile(file, fallback) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return parsed == null ? fallback : parsed
  } catch {
    return fallback
  }
}

/** Write-then-rename so a crash can never leave a half-written state file. */
function writeJsonFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  fs.renameSync(temp, file)
}

function resolveRoot(root) {
  return path.resolve(root || process.env.DSH_ROOT || path.join(__dirname, '..', '..'))
}

/**
 * Shipped defaults may be declared in `config/app.json` under `subWorker`
 * (plan §18). The persisted `data/sub-worker/config.json` then overrides them
 * key by key, so a user choice always wins over the shipped declaration and a
 * missing declaration can never enable the feature by accident.
 */
function declaredConfig(root) {
  const file = path.join(resolveRoot(root), 'config', 'app.json')
  const app = readJsonFile(file, null)
  return isPlainObject(app) && isPlainObject(app.subWorker) ? app.subWorker : {}
}

/**
 * Persistence paths for one root. Nothing outside this object is ever written by
 * the sub-worker layer, which keeps the "default mode is unchanged" promise easy
 * to audit.
 */
function paths(root) {
  const base = resolveRoot(root)
  return {
    root: base,
    dataDir: path.join(base, 'data', 'sub-worker'),
    tasksDir: path.join(base, 'data', 'sub-worker', 'tasks'),
    configFile: path.join(base, 'data', 'sub-worker', 'config.json'),
    stateFile: path.join(base, 'data', 'sub-worker', 'state.json'),
    queueFile: path.join(base, 'data', 'sub-worker', 'queue.json'),
    historyFile: path.join(base, 'data', 'sub-worker', 'history.json'),
    workspaceLockFile: path.join(base, 'data', 'sub-worker', 'workspace-lock.json'),
    // Multi-worker artifacts (multi-sub.md §17, §18, §20, §37, §38).
    hardwareProfileFile: path.join(base, 'data', 'sub-worker', 'hardware-profile.json'),
    poolFile: path.join(base, 'data', 'sub-worker', 'pool.json'),
    plansDir: path.join(base, 'data', 'sub-worker', 'plans'),
    snapshotsDir: path.join(base, 'data', 'sub-worker', 'snapshots'),
    fileOwnershipFile: path.join(base, 'data', 'sub-worker', 'file-ownership.json'),
    metricsFile: path.join(base, 'data', 'sub-worker', 'metrics.json'),
    resourceConfigFile: path.join(base, 'config', 'hns-resource.yaml'),
    runtimeDir: path.join(base, 'runtime'),
    logsDir: path.join(base, 'logs'),
    runtimeLog: path.join(base, 'logs', 'sub-worker.log'),
    taskLogsDir: path.join(base, 'logs', 'sub-worker'),
    // The documented log split of multi-sub.md §37.
    supervisorLog: path.join(base, 'logs', 'sub-worker', 'supervisor.log'),
    schedulerLog: path.join(base, 'logs', 'sub-worker', 'scheduler.log'),
    resourceLog: path.join(base, 'logs', 'sub-worker', 'resources.log'),
    workerLogsDir: path.join(base, 'logs', 'sub-worker', 'workers')
  }
}

/**
 * Controller-side and worker-side persistence. Every method is failure
 * tolerant: a broken state directory must never take the Harness down (plan
 * §24 extension failure isolation).
 */
class SubWorkerStore {
  constructor({ root, maxHistory = DEFAULT_MAX_HISTORY, maxQueue = DEFAULT_MAX_QUEUE, log = () => {} } = {}) {
    this.paths = paths(root)
    this.root = this.paths.root
    this.maxHistory = maxHistory
    this.maxQueue = maxQueue
    this.log = log
  }

  ensureDirs() {
    for (const dir of [
      this.paths.dataDir,
      this.paths.tasksDir,
      this.paths.plansDir,
      this.paths.snapshotsDir,
      this.paths.logsDir,
      this.paths.taskLogsDir,
      this.paths.workerLogsDir,
      this.paths.runtimeDir
    ]) {
      try {
        fs.mkdirSync(dir, { recursive: true })
      } catch (error) {
        this.log(`sub-worker dir create failed (${dir}): ${error?.message || error}`)
      }
    }
  }

  /** Persist one serialized plan under data/sub-worker/plans (multi-sub.md §15). */
  savePlan(planId, serialized) {
    const file = path.join(this.paths.plansDir, `${sanitizeTaskId(planId)}.json`)
    try {
      writeJsonFile(file, serialized)
      return file
    } catch (error) {
      this.log(`sub-worker plan save failed: ${error?.message || error}`)
      return null
    }
  }

  loadPlan(planId) {
    return readJsonFile(path.join(this.paths.plansDir, `${sanitizeTaskId(planId)}.json`), null)
  }

  loadMetrics() {
    return readJsonFile(this.paths.metricsFile, null)
  }

  saveMetrics(serialized) {
    try {
      writeJsonFile(this.paths.metricsFile, serialized)
      return this.paths.metricsFile
    } catch (error) {
      this.log(`sub-worker metrics save failed: ${error?.message || error}`)
      return null
    }
  }

  loadFileOwnership() {
    return readJsonFile(this.paths.fileOwnershipFile, null)
  }

  saveFileOwnership(serialized) {
    try {
      writeJsonFile(this.paths.fileOwnershipFile, serialized)
      return this.paths.fileOwnershipFile
    } catch (error) {
      this.log(`sub-worker file ownership save failed: ${error?.message || error}`)
      return null
    }
  }

  loadPool() {
    return readJsonFile(this.paths.poolFile, null)
  }

  savePool(serialized) {
    try {
      writeJsonFile(this.paths.poolFile, serialized)
      return this.paths.poolFile
    } catch (error) {
      this.log(`sub-worker pool save failed: ${error?.message || error}`)
      return null
    }
  }

  loadConfig() {
    // defaultConfig() <- config/app.json#subWorker <- data/sub-worker/config.json
    const persisted = readJsonFile(this.paths.configFile, null)
    return publicConfig({ ...declaredConfig(this.root), ...(isPlainObject(persisted) ? persisted : {}) })
  }

  saveConfig(config) {
    const value = publicConfig(config)
    try {
      writeJsonFile(this.paths.configFile, value)
    } catch (error) {
      this.log(`sub-worker config save failed: ${error?.message || error}`)
    }
    return value
  }

  loadState() {
    const raw = readJsonFile(this.paths.stateFile, null)
    if (!isPlainObject(raw)) return emptyState()
    const state = { ...emptyState(), ...raw }
    if (!isWorkerState(state.state)) state.state = 'OFF'
    if (state.stage && !isExecutionStage(state.stage)) state.stage = null
    return state
  }

  saveState(state) {
    try {
      writeJsonFile(this.paths.stateFile, { ...emptyState(), ...state })
    } catch (error) {
      this.log(`sub-worker state save failed: ${error?.message || error}`)
    }
  }

  loadQueue() {
    const raw = readJsonFile(this.paths.queueFile, [])
    return Array.isArray(raw) ? raw.slice(0, this.maxQueue) : []
  }

  saveQueue(queue) {
    const value = Array.isArray(queue) ? queue.slice(0, this.maxQueue) : []
    try {
      writeJsonFile(this.paths.queueFile, value)
    } catch (error) {
      this.log(`sub-worker queue save failed: ${error?.message || error}`)
    }
    return value
  }

  loadHistory() {
    const raw = readJsonFile(this.paths.historyFile, [])
    return Array.isArray(raw) ? raw : []
  }

  appendHistory(entry) {
    const history = [entry, ...this.loadHistory()].slice(0, this.maxHistory)
    try {
      writeJsonFile(this.paths.historyFile, history)
    } catch (error) {
      this.log(`sub-worker history save failed: ${error?.message || error}`)
    }
    return history
  }

  taskFile(taskId) {
    const safe = sanitizeTaskId(taskId)
    return safe ? path.join(this.paths.tasksDir, `${safe}.json`) : null
  }

  saveTaskRecord(taskId, record) {
    const file = this.taskFile(taskId)
    if (!file) return null
    try {
      writeJsonFile(file, record)
      return file
    } catch (error) {
      this.log(`sub-worker task record save failed: ${error?.message || error}`)
      return null
    }
  }

  loadTaskRecord(taskId) {
    const file = this.taskFile(taskId)
    return file ? readJsonFile(file, null) : null
  }

  loadWorkspaceLock() {
    const raw = readJsonFile(this.paths.workspaceLockFile, null)
    return isPlainObject(raw) ? raw : null
  }

  saveWorkspaceLock(lock) {
    try {
      writeJsonFile(this.paths.workspaceLockFile, lock)
    } catch (error) {
      this.log(`sub-worker workspace lock save failed: ${error?.message || error}`)
    }
    return lock
  }

  clearWorkspaceLock() {
    try {
      fs.rmSync(this.paths.workspaceLockFile, { force: true })
    } catch (error) {
      this.log(`sub-worker workspace lock clear failed: ${error?.message || error}`)
    }
  }
}

module.exports = {
  TRANSITIONS,
  DEFAULT_MAX_HISTORY,
  DEFAULT_MAX_QUEUE,
  isWorkerState,
  isExecutionStage,
  canTransition,
  assertTransition,
  isBusyState,
  isTerminalTaskStatus,
  defaultConfig,
  declaredConfig,
  publicConfig,
  emptyState,
  paths,
  resolveRoot,
  readJsonFile,
  writeJsonFile,
  SubWorkerStore
}
