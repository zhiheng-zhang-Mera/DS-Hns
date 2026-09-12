'use strict'

/**
 * WorkerManager — the HNS Supervisor (plan multi-sub.md §2, §16, §24, §34, §36,
 * §42, §46).
 *
 *   Hardware Profiler ─┐
 *   Runtime Monitor ───┼─ Resource Scheduler ─ Worker Pool ─ Validation / Merge
 *   Task Planner ──────┘
 *
 * Responsibilities:
 *   - own the worker pool lifecycle (spawn / retire / restart / crash recovery)
 *   - own every persisted artifact under data/sub-worker + logs
 *   - admit tasks and plans, build the DAG, dispatch by priority
 *   - enforce the file-conflict ceiling and the file ownership registry
 *   - integrate the per-node worktrees and validate the merged result
 *   - guarantee failure isolation: a worker fault never reaches the shell
 *
 * Compatibility (§36): with `adaptiveWorkers: false` the pool is capped at one
 * worker, which is the previous two-process behaviour on exactly the same code
 * path. The compatibility mode is "dynamic multi-process with N = 1", never a
 * second architecture.
 *
 * The manager has no UI and no Electron dependency, so it is fully testable in
 * plain Node and can never become a second GUI.
 */

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const protocol = require('./protocol.cjs')
const permissions = require('./permissions.cjs')
const {
  SubWorkerStore,
  canTransition,
  DEFAULT_MAX_QUEUE
} = require('./state.cjs')
const { redactSecrets, redactEvent } = require('./event-bus.cjs')
const { Reporter } = require('./reporter.cjs')
const { WorkerPool } = require('./pool.cjs')
const { TaskGraph, NODE_STATUS, priorityOf } = require('./dag.cjs')
const { DispatchScheduler, workerRoleFor } = require('./scheduler.cjs')
const { FileOwnershipRegistry } = require('./ownership.cjs')
const profiler = require('./profiler.cjs')
const { ResourceMonitor, ResourceScheduler } = require('./resources.cjs')
const { resolveResourceConfig, roleProfile } = require('./resource-config.cjs')
const snapshotService = require('./snapshot.cjs')
const { MetricsCollector } = require('./metrics.cjs')
const integration = require('./integration.cjs')

const RUNTIME_ENTRY = path.join(__dirname, 'runtime.cjs')
const MAX_EVENTS_IN_MEMORY = 500
const DEFAULT_TICK_MS = 2000
const COMPAT_WORKTREE = 'hns-sub-worker'

function safeCall(scope, log, fn, fallback = null) {
  try {
    return fn()
  } catch (error) {
    try {
      log(`[sub-worker] ${scope} failed: ${error?.stack || error}`)
    } catch {}
    return fallback
  }
}

function isPlainObjectLocal(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

const NON_SECRET_EVENT_FIELDS = new Set(['timestamp', 'type', 'task_id', 'stream', 'stage', 'state'])

/** Redact every string field of an event (plan §26). */
function redactEventFields(event) {
  for (const [key, value] of Object.entries(event)) {
    if (typeof value !== 'string' || NON_SECRET_EVENT_FIELDS.has(key)) continue
    event[key] = redactSecrets(value)
  }
  return event
}

/**
 * `git worktree` automation (plan §10, §18).
 *
 * Compatibility mode keeps the single documented worktree
 * (`<repo>-worktrees/hns-sub-worker`); a real plan gives every node its own
 * worktree so two workers never share a working tree.
 */
const WorktreeManager = {
  worktreePathFor(targetRepo, { planId = null, nodeId = null, compat = true } = {}) {
    const resolved = path.resolve(String(targetRepo))
    const parent = path.dirname(resolved)
    const name = path.basename(resolved)
    const leaf = compat || !planId || !nodeId
      ? COMPAT_WORKTREE
      : `hns-${String(planId)}-${String(nodeId)}`
    return path.join(parent, `${name}-worktrees`, leaf)
  },

  isGitRepository(targetRepo) {
    try {
      const result = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
        cwd: targetRepo,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 30_000
      })
      return result.status === 0 && String(result.stdout || '').trim() === 'true'
    } catch {
      return false
    }
  },

  ensure(targetRepo, { worktree = null, log = () => {} } = {}) {
    const target = path.resolve(String(targetRepo))
    if (!fs.existsSync(target)) return { ok: false, reason: `target_repo does not exist: ${target}` }
    if (!WorktreeManager.isGitRepository(target)) return { ok: false, reason: `target_repo is not a git repository: ${target}` }

    const resolvedWorktree = worktree || WorktreeManager.worktreePathFor(target)
    if (fs.existsSync(resolvedWorktree)) return { ok: true, worktree: resolvedWorktree, created: false }

    fs.mkdirSync(path.dirname(resolvedWorktree), { recursive: true })
    const result = spawnSync('git', ['worktree', 'add', '--detach', resolvedWorktree], {
      cwd: target,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 120_000
    })
    if (result.status !== 0 || !fs.existsSync(resolvedWorktree)) {
      const detail = redactSecrets(String(result.stderr || result.stdout || '').trim()).slice(0, 400)
      log(`[sub-worker] worktree creation failed for ${target}: ${detail}`)
      return { ok: false, reason: `git worktree add failed: ${detail || `exit ${result.status}`}` }
    }
    return { ok: true, worktree: resolvedWorktree, created: true }
  },

  /** Best-effort removal; only an explicit controller action calls this. */
  remove(targetRepo, { worktree = null } = {}) {
    const resolved = worktree || WorktreeManager.worktreePathFor(targetRepo)
    if (!fs.existsSync(resolved)) return { ok: true, removed: false }
    const result = spawnSync('git', ['worktree', 'remove', '--force', resolved], {
      cwd: path.resolve(String(targetRepo)),
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60_000
    })
    return { ok: result.status === 0, removed: true, detail: String(result.stderr || '').trim() }
  }
}

class WorkerManager {
  constructor({
    root,
    nodeExe = process.execPath,
    runtimeEntry = RUNTIME_ENTRY,
    runtimeProcess = null,
    log = () => {},
    notify = () => {},
    // Host sanity cap, not the effective ceiling: the effective one comes from
    // the resource configuration (see poolCeiling).
    maxWorkers = 64
  } = {}) {
    this.root = path.resolve(root || process.env.DSH_ROOT || path.join(__dirname, '..', '..'))
    this.nodeExe = nodeExe
    this.runtimeEntry = runtimeEntry
    this.runtimeProcess = runtimeProcess
    this.log = log
    this.notify = notify
    /**
     * Host-side sanity cap for the pool (Phase 3 §31 explicitly allows more
     * workers later). The *effective* ceiling comes from the resource
     * configuration; compatibility mode ignores both and stays at 1.
     */
    this.maxHostWorkers = Math.max(1, Math.min(64, Number(maxWorkers) || 64))
    this.maxWorkers = this.maxHostWorkers
    this.store = new SubWorkerStore({ root: this.root, log })
    this.config = this.store.loadConfig()
    this.state = this.store.loadState()
    this.queue = []
    this.history = []
    this.plans = []
    this.events = []
    this.pendingNotes = []
    this.workerId = 'sub-1'
    this.restartCount = 0
    this.crashTimestamps = []
    this.lastExit = null
    this.intentionalStop = false
    this.notifications = []
    this.activated = false
    this.tickTimer = null
    this.tickCount = 0
    this.lastTick = null
    this.lastIntegration = null
    this.liveReporter = null
    this.liveMeta = null
    this.liveResult = null
    this.liveFinishedAt = null
    this.workerLiveViews = new Map()
    this.nodeChanges = new Map()
    this.journal = []
    this.safeValveUsed = false

    this.applyResourceConfig()
    this.registry = new FileOwnershipRegistry({ log })
    this.registry.load(this.store.loadFileOwnership())
    this.metrics = new MetricsCollector({ log })
    this.metrics.load(this.store.loadMetrics())
    this.dispatchScheduler = new DispatchScheduler({ config: this.resourceConfig, log })
    this.hardwareProfile = profiler.readHardwareProfile(this.root)
    this.resourceMonitor = new ResourceMonitor({
      root: this.root,
      config: this.resourceConfig,
      log,
      sampleIntervalMs: (this.resourceConfig.runtime.sampleIntervalSeconds || 5) * 1000
    })
    this.resourceScheduler = new ResourceScheduler({
      config: this.resourceConfig,
      hardwareProfile: this.hardwareProfile || profiler.buildHardwareProfile({ config: this.resourceConfig }),
      monitor: this.resourceMonitor,
      log,
      learnedProfiles: this.metrics.roleProfiles
    })
    this.pool = new WorkerPool({
      root: this.root,
      nodeExe: this.nodeExe,
      runtimeEntry: this.runtimeEntry,
      runtimeProcess: this.runtimeProcess,
      config: this.config,
      log: (message) => this.journalLine(message),
      maxWorkers: this.maxWorkers,
      onWorkerMessage: (workerId, message, slot) => this.handleWorkerMessage(workerId, message, slot),
      onWorkerExit: (workerId, info) => this.handleExit(workerId, info),
      onWorkerSpawn: (slot) => this.handleWorkerSpawn(slot)
    })
  }

  // ------------------------------------------------------------------ helpers

  get primary() {
    return this.pool.primary
  }

  /** Compatibility accessor: the primary worker's child process. */
  get child() {
    return this.primary?.child || null
  }

  /** Compatibility accessor: the primary worker's self-description. */
  get workerInfo() {
    return this.primary?.info || null
  }

  get isRunning() {
    return this.pool.running.length > 0
  }

  /** The task the supervisor is currently driving (oldest running node). */
  get currentTask() {
    const entry = this.runningEntries()[0]
    if (entry) return entry.task
    return this.currentTaskOverride || null
  }

  set currentTask(value) {
    this.currentTaskOverride = value
  }

  get adaptive() {
    return this.config.adaptiveWorkers === true
  }

  /**
   * Pool ceiling.
   *
   * Compatibility mode is one worker on the same code path (§36). Adaptive mode
   * takes the ceiling from the resource configuration (§27/§45 `workers`:
   * `soft_max` bounds normal scaling and `hard_max` is the absolute limit),
   * still bounded by the hardware ceiling and the host cap.
   */
  get poolCeiling() {
    if (!this.adaptive) return 1
    const hardwareMax = Math.max(1, Number(this.hardwareProfile?.max_recommended_workers) || this.maxHostWorkers)
    const configured = this.resourceConfig?.workers?.hardMax
    const hardMax = configured === 'auto' || configured === null || configured === undefined
      ? hardwareMax
      : Math.max(1, Math.min(Number(configured) || hardwareMax, hardwareMax))
    return Math.max(1, Math.min(this.maxHostWorkers, hardMax))
  }

  applyResourceConfig() {
    const resolved = resolveResourceConfig({
      root: this.root,
      declared: this.config.resources,
      persisted: this.store.loadConfig().resources,
      log: this.log
    })
    this.resourceConfig = resolved.config
    this.resourceConfigSource = resolved.source
    return this.resourceConfig
  }

  journalLine(message) {
    const line = redactSecrets(String(message))
    this.journal.push({ at: new Date().toISOString(), message: line })
    if (this.journal.length > 400) this.journal.shift()
    this.log(line)
    return line
  }

  appendLog(name, message) {
    const file = path.join(this.store.paths.logsDir, 'sub-worker', `${name}.log`)
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.appendFileSync(file, `${new Date().toISOString()} ${redactSecrets(String(message))}\n`, 'utf8')
      return true
    } catch {
      return false
    }
  }

  runningEntries() {
    const entries = []
    for (const plan of this.plans) {
      for (const node of plan.graph.running()) {
        entries.push({
          plan,
          node,
          task: plan.tasks.get(node.node_id) || this.currentTaskOverride || null,
          worker_id: node.worker_id
        })
      }
    }
    return entries
  }

  /** Every node that is admitted but not terminal (the documented queue). */
  queueEntries() {
    const entries = []
    for (const plan of this.plans) {
      for (const node of plan.graph.nodes) {
        if (node.status === NODE_STATUS.RUNNING) continue
        if ([NODE_STATUS.COMPLETED, NODE_STATUS.FAILED, NODE_STATUS.BLOCKED, NODE_STATUS.CANCELLED, NODE_STATUS.SKIPPED].includes(node.status)) continue
        entries.push({ plan, node })
      }
    }
    return entries
  }

  syncQueue() {
    this.queue = this.queueEntries().map(({ plan, node }) => ({
      plan_id: plan.plan_id,
      task_id: `${plan.plan_id}-${node.node_id}`,
      node_id: node.node_id,
      objective: node.objective,
      risk_level: plan.tasks.get(node.node_id)?.risk_level || null,
      target_repo: plan.target_repo,
      source: plan.source,
      accepted_at: plan.accepted_at
    }))
    return this.queue
  }

  // ---------------------------------------------------------------- lifecycle

  hydrate() {
    this.config = this.store.loadConfig()
    this.applyResourceConfig()
    this.state = this.store.loadState()
    this.history = this.store.loadHistory()
    this.activated = fs.existsSync(this.store.paths.stateFile)
    this.metrics.load(this.store.loadMetrics())
    this.registry.load(this.store.loadFileOwnership())
    this.hardwareProfile = profiler.readHardwareProfile(this.root)
    if (this.hardwareProfile) this.resourceScheduler.hardware = this.hardwareProfile
    this.resourceScheduler.learnedProfiles = this.metrics.roleProfiles

    // Restore serialized plans so a restarted supervisor still knows what was
    // interrupted (AC-11 of the previous phase; multi-sub.md §34 "task state saved").
    for (const entry of Array.isArray(this.state.active_plans) ? this.state.active_plans : []) {
      const restored = TaskGraph.restore(entry)
      if (restored.ok) {
        const tasks = new Map()
        const planTarget = entry.plan?.target_repo || null
        const planMode = entry.plan?.workspace_mode || null
        /**
         * A restored node task must be rehydrated the same way `submitPlan`
         * builds one: the plan owns `target_repo`/`workspace_mode`, and a
         * hand-written or older record may not repeat them on every node.
         */
        const rehydrate = (candidate, nodeId) => {
          if (!isPlainObjectLocal(candidate)) return null
          const validated = protocol.validateTask({
            version: 1,
            ...candidate,
            task_id: candidate.task_id || `${entry.plan?.plan_id || 'plan'}-${nodeId}`,
            target_repo: candidate.target_repo || planTarget || undefined,
            workspace_mode: candidate.workspace_mode || planMode || undefined,
            allowed_paths: Array.isArray(candidate.allowed_paths) && candidate.allowed_paths.length
              ? candidate.allowed_paths
              : (restored.graph.byId.get(nodeId)?.write_scope || undefined)
          })
          return validated.ok ? validated.task : null
        }
        for (const saved of Array.isArray(entry.node_tasks) ? entry.node_tasks : []) {
          const nodeId = String(saved?.node_id || '')
          if (!nodeId) continue
          const task = rehydrate(saved?.task, nodeId)
          if (task) tasks.set(nodeId, task)
        }
        for (const node of restored.graph.nodes) {
          if (tasks.has(node.node_id)) continue
          const task = rehydrate(node.task, node.node_id)
          if (task) tasks.set(node.node_id, task)
        }
        this.plans.push({
          plan_id: entry.plan?.plan_id || entry.plan_id,
          graph: restored.graph,
          snapshot: null,
          source: entry.source || 'recovered',
          accepted_at: entry.accepted_at || new Date().toISOString(),
          target_repo: entry.plan?.target_repo || null,
          workspace_mode: entry.plan?.workspace_mode || null,
          tasks,
          integration: null,
          state: 'recovered'
        })
      }
    }

    if (this.state.state !== 'OFF' && this.state.state !== 'HANDOFF' && !this.isRunning) {
      this.state = {
        ...this.state,
        state: ['STOPPING', 'SAFE_MODE'].includes(this.state.state) ? 'OFF' : 'CRASHED',
        pid: null,
        lastError: this.state.lastError || 'the supervisor was not running when the shell restarted',
        updatedAt: new Date().toISOString()
      }
      this.persistState()
    }
    this.syncQueue()
    return this.describe()
  }

  persistState() {
    if (!this.activated) return null
    const activePlans = this.plans
      .filter((plan) => !['completed', 'failed', 'finished'].includes(plan.graph.status))
      .map((plan) => ({
        ...plan.graph.toJSON(),
        source: plan.source,
        accepted_at: plan.accepted_at,
        // The node tasks are what make a restored plan dispatchable: without them
        // a recovery would know the shape of the plan but not what to run (§34).
        node_tasks: [...plan.tasks].map(([nodeId, task]) => ({ node_id: nodeId, task }))
      }))
    return this.store.saveState({ ...this.state, active_plans: activePlans, updatedAt: new Date().toISOString() })
  }

  activate() {
    this.activated = true
    return this.activated
  }

  setState(next, patch = {}) {
    const from = this.state.state
    if (from === next && !Object.keys(patch).length) return next
    if (!canTransition(from, next)) {
      this.journalLine(`[supervisor] refusing illegal transition ${from} -> ${next}`)
      return from
    }
    return this.applyState(next, patch, from)
  }

  forceState(next, patch = {}) {
    return this.applyState(next, patch, this.state.state)
  }

  applyState(next, patch, from) {
    this.state = { ...this.state, ...patch, state: next, updatedAt: new Date().toISOString() }
    this.persistState()
    this.pushRuntimeEvent({
      type: 'state_changed',
      task_id: this.state.task_id,
      summary: `Supervisor state ${from} -> ${next}`,
      from,
      to: next
    })
    this.notify()
    return next
  }

  updateConfig(patch = {}) {
    this.config = this.store.saveConfig({ ...this.config, ...patch })
    this.applyResourceConfig()
    this.resourceScheduler.config = this.resourceConfig
    this.resourceMonitor.config = this.resourceConfig
    this.dispatchScheduler.config = this.resourceConfig
    this.pool.maxWorkers = this.poolCeiling
    // A configuration change is what turns the compatibility pool into a real
    // adaptive pool, so the ceiling follows immediately.
    if (this.pool.size > this.pool.maxWorkers) {
      while (this.pool.size > this.pool.maxWorkers && this.pool.idle.length) {
        this.pool.retire(this.pool.idle[this.pool.idle.length - 1].worker_id, { reason: 'configuration change' })
      }
    }
    this.notify()
    return this.config
  }

  /** Enable = the only path that spawns a worker process (§3.2, AC-02). */
  async start({ reason = 'manual' } = {}) {
    if (this.isRunning) return { ok: true, already: true, state: this.state.state }
    this.activate()
    this.store.ensureDirs()
    this.setState('STARTING', { pid: null, lastError: null })
    this.intentionalStop = false

    // Hardware ceiling (install-time, persisted) → runtime probe → pool.
    const ensured = profiler.ensureHardwareProfile({ root: this.root, config: this.resourceConfig, log: (message) => this.journalLine(message) })
    this.hardwareProfile = ensured.profile
    this.resourceScheduler.hardware = this.hardwareProfile
    const probe = profiler.runtimeProbe({ root: this.root, config: this.resourceConfig, log: (message) => this.appendLog('resources', message) })
    this.appendLog('supervisor', `start (reason ${reason}); hardware max ${this.hardwareProfile.max_recommended_workers}, adaptive ${this.adaptive}`)
    this.appendLog('resources', `runtime probe: ${JSON.stringify({ cpu: probe.cpu.logical_cores, ram_available: probe.memory.available_gb, storage: probe.disk.storage_class, degraded: probe.degraded })}`)

    this.pool.maxWorkers = this.poolCeiling
    this.pool.reopen()
    const desired = Math.max(1, Math.min(this.poolCeiling, Math.max(1, Number(this.resourceConfig.workers.min) || 1)))
    const spawned = this.pool.spawn({ role: 'generic', reason: `start:${reason}`, force: true })
    if (!spawned.ok) {
      const message = `could not spawn the sub-worker runtime: ${spawned.reason}`
      this.journalLine(`[supervisor] ${message}`)
      this.forceState('FAILED', { lastError: message })
      return { ok: false, error: message }
    }
    this.pool.writeOwnership()
    this.setState('IDLE', { pid: spawned.pid, startedAt: new Date().toISOString() })
    this.resourceMonitor.start((sample) => {
      this.appendLog('resources', `sample cpu=${sample.cpu.usage_percent}% ram_used=${sample.memory.used_percent}% avail=${sample.memory.available_gb}GB`)
    })
    this.startTicking()
    this.tick({ force: true })
    void desired
    return { ok: true, pid: spawned.pid, state: this.state.state }
  }

  startTicking() {
    if (this.tickTimer) return false
    const intervalMs = Math.max(500, Number(this.resourceConfig.runtime.sampleIntervalSeconds || 5) * 400)
    this.tickTimer = setInterval(() => {
      safeCall('tick', this.log, () => this.tick())
    }, intervalMs)
    if (typeof this.tickTimer.unref === 'function') this.tickTimer.unref()
    return true
  }

  stopTicking() {
    if (this.tickTimer) clearInterval(this.tickTimer)
    this.tickTimer = null
    this.resourceMonitor.stop()
  }

  async stop({ reason = 'user stop', timeoutMs = 5000 } = {}) {
    this.intentionalStop = true
    this.stopTicking()
    const workers = this.pool.running
    if (!workers.length) {
      this.finalizeStop(reason)
      return { ok: true, already: true }
    }
    this.setState('STOPPING')
    // Latch the pool as stopping *before* waiting: a supervisor tick that lands
    // during the drain would otherwise resurrect a worker and the drain would
    // never complete (the teardown would sit until its timeout every time).
    this.pool.stopping = true
    const interrupted = this.abandonRunningNodes(reason)
    void interrupted
    this.pool.broadcast('shutdown', { reason })
    const drained = await this.pool.waitForExit({ timeoutMs })
    if (!drained.drained) {
      this.journalLine(`[supervisor] ${drained.running} worker(s) did not exit within ${timeoutMs} ms; killing the process tree`)
    }
    this.pool.killAll({ reason })
    this.finalizeStop(reason)
    return { ok: true, drained: drained.drained }
  }

  finalizeStop(reason) {
    this.stopTicking()
    this.pool.killAll({ reason })
    this.pool.clearOwnership()
    this.releaseWorkspaceLock(reason)
    for (const entry of this.runningEntries()) {
      this.recordCancelled(entry, `supervisor stopped (${reason})`)
    }
    this.currentTaskOverride = null
    this.forceState('OFF', { pid: null, task_id: null, objective: null, stage: null })
    this.journalLine(`[supervisor] stopped (${reason})`)
    this.notify()
  }

  async restart(options = {}) {
    await this.stop({ reason: options.reason || 'restart' })
    this.restartCount += 1
    const result = await this.start({ reason: options.reason || 'restart' })
    return { ...result, restarts: this.restartCount }
  }

  /** Abandon the nodes that were running when the pool stopped. */
  abandonRunningNodes(reason) {
    const abandoned = []
    for (const plan of this.plans) {
      for (const node of plan.graph.running()) {
        abandoned.push(node.node_id)
        plan.graph.markTerminal(node.node_id, NODE_STATUS.BLOCKED, {
          status: 'blocked',
          code: protocol.RESULT_CODES.BLOCKED,
          summary: `worker pool stopped: ${reason}`
        })
      }
    }
    for (const workerId of this.pool.workers.map((slot) => slot.worker_id)) this.registry.release(workerId)
    this.persistRegistry()
    return abandoned
  }

  // ------------------------------------------------------------- pool callbacks

  handleWorkerSpawn(slot) {
    this.metrics.recordWorkerEvent(slot.worker_id, 'spawn')
    this.pushRuntimeEvent({
      type: 'state_changed',
      summary: `worker ${slot.worker_id} spawned (role ${slot.role}, pid ${slot.pid})`
    })
    this.notify()
  }

  handleWorkerMessage(workerId, message, slot) {
    const payload = message.payload || {}
    switch (message.type) {
      case 'ready':
        slot.info = {
          worker_id: payload.worker_id || workerId,
          role: payload.role || slot.role,
          pid: payload.pid || slot.pid,
          capabilities: payload.capabilities || protocol.CAPABILITIES,
          protocol: payload.protocol || protocol.PROTOCOL_VERSION
        }
        if (!slot.task_id) slot.state = 'IDLE'
        this.pushRuntimeEvent({ type: 'state_changed', summary: `worker ${workerId} ready (pid ${slot.pid})` })
        break
      case 'state':
        this.applyWorkerState(workerId, slot, payload)
        break
      case 'stage':
        slot.stage = payload.stage || null
        if (this.primary?.worker_id === workerId) {
          this.state = { ...this.state, stage: slot.stage, updatedAt: new Date().toISOString() }
          this.persistState()
          this.notify()
        }
        break
      case 'event': {
        const workerEvent = payload.event || {}
        if (workerEvent.type === 'note_applied') this.markNotesApplied()
        // Per-worker liveness signals the pool uses for hang detection (§33).
        if (workerEvent.type === 'command_output' || workerEvent.type === 'command_finished') this.pool.markProgress(workerId, 'output')
        if (workerEvent.type === 'file_write' || workerEvent.type === 'file_delete') {
          this.pool.markProgress(workerId, 'file_change')
          this.noteNodeChange(workerId, workerEvent)
        }
        this.pushRuntimeEvent({ ...workerEvent, worker_id: workerId })
        break
      }
      case 'log':
        this.appendLog('workers', `[${workerId}] ${payload.level || 'info'}: ${payload.message}`)
        break
      case 'note_applied':
        if (payload.applied !== false) this.markNotesApplied()
        this.pushRuntimeEvent({
          type: 'note_applied',
          summary: payload.summary || payload.note || 'note queued',
          applied: payload.applied !== false,
          effects: payload.effects,
          worker_id: workerId
        })
        break
      case 'heartbeat':
        this.pool.noteTelemetry(workerId, payload)
        break
      case 'pong':
        break
      case 'error':
        this.pushRuntimeEvent({
          type: 'error',
          task_id: payload.task_id || slot.task_id,
          summary: payload.message || 'worker error',
          code: payload.code || null,
          worker_id: workerId
        })
        if (payload.code === protocol.RESULT_CODES.CRASHED) this.handleCrash(workerId, 'worker reported a crash')
        break
      case 'result':
        this.handleResult(workerId, slot, payload.result, payload.live_view)
        break
      case 'bye':
        this.pushRuntimeEvent({ type: 'state_changed', summary: `worker ${workerId} said goodbye (${payload.reason || 'shutdown'})` })
        break
      default:
        break
    }
  }

  applyWorkerState(workerId, slot, payload) {
    const next = String(payload.state || '').toUpperCase()
    if (!next) return
    // A task outcome (BLOCKED/FAILED/READY_FOR_REVIEW) does not make the worker
    // unavailable: the pool decides availability from the assignment, so the
    // reported state is kept for display only.
    slot.state = next
    if (slot.task_id) slot.state = next
    else if (['BLOCKED', 'FAILED', 'READY_FOR_REVIEW'].includes(next)) slot.last_task_status = next
    if (payload.stage !== undefined) slot.stage = payload.stage || null
    if (payload.task_id !== undefined) slot.reported_task_id = payload.task_id || null
    if (payload.handoff) this.state.handoff = payload.handoff

    // The supervisor's own state mirrors the pool: any busy worker means the
    // supervisor is RUNNING/ASSIGNED, otherwise it is IDLE.
    if (this.primary?.worker_id !== workerId) return
    const terminalForTask = ['IDLE', 'READY_FOR_REVIEW', 'FAILED', 'BLOCKED'].includes(next)
    if (slot.task_id && terminalForTask) return
    if (next === this.state.state) return
    if (!canTransition(this.state.state, next)) {
      this.journalLine(`[supervisor] ignoring worker-reported transition ${this.state.state} -> ${next}`)
      return
    }
    this.applyState(next, {}, this.state.state)
  }

  handleExit(workerId, info = {}) {
    const slot = info.slot
    const node = this.nodeForWorker(workerId)
    this.metrics.recordWorkerEvent(workerId, info.expected ? 'retire' : 'crash')
    this.registry.release(workerId)
    this.persistRegistry()
    this.pool.clearOwnership()
    this.lastExit = { worker_id: workerId, code: info.code, signal: info.signal, at: new Date().toISOString() }

    if (node) {
      const plan = this.planForNode(node)
      const result = protocol.createResult(`${plan?.plan_id || 'plan'}-${node.node_id}`, {
        status: 'failed',
        summary: `worker ${workerId} exited while executing this node (code ${info.code}${info.signal ? `, signal ${info.signal}` : ''})`,
        code: protocol.RESULT_CODES.CRASHED,
        reason: `worker process exited unexpectedly: code=${info.code} signal=${info.signal || 'none'}`,
        needs_controller_review: true,
        needs_controller_decision: true
      })
      this.finishNode(plan, node, result, { workerId, crashed: true })
    }

    if (info.expected || this.intentionalStop || ['STOPPING', 'OFF', 'HANDOFF'].includes(this.state.state)) {
      if (this.state.state === 'HANDOFF') return
      if (this.intentionalStop || this.state.state === 'STOPPING') {
        this.forceState('OFF', { pid: null })
        return
      }
      // A scale-down retirement is not a stop: the supervisor is still enabled,
      // so it stays IDLE and recovers its minimum pool once resources allow
      // (§35 Graceful Degradation, §11 progressive scaling).
      this.forceState('IDLE', { pid: null, task_id: null, objective: null, stage: null })
      return
    }

    this.handleCrash(workerId, `worker exited unexpectedly (code ${info.code}${info.signal ? `, signal ${info.signal}` : ''})`)
  }

  handleCrash(workerId, reason) {
    this.crashTimestamps.push(Date.now())
    this.metrics.recordWorkerEvent(workerId, 'crash')
    this.journalLine(`[supervisor] worker ${workerId} crashed: ${reason}`)
    this.forceState('CRASHED', { pid: this.primary?.pid || null, lastError: `${workerId}: ${reason}`, stage: null })
    this.pushNotification({ kind: 'crash', title: 'Sub-worker crashed', body: `${workerId}: ${reason}` })
    this.abandonRunningNodes(reason)
    if (this.activated) this.persistState()
    this.notify()
  }

  // ------------------------------------------------------------- plan intake

  /**
   * Admit a plan (plan §15, §21): validate the DAG, snapshot the repository and
   * make the nodes dispatchable.
   */
  submitPlan(rawPlan, { source = 'controller', explicit = true } = {}) {
    const created = TaskGraph.from(rawPlan, {})
    if (!created.ok) {
      return { ok: false, accepted: false, errors: created.errors, code: protocol.RESULT_CODES.TASK_REJECTED }
    }
    const graph = created.graph
    const plan = graph.plan
    const tasks = new Map()
    const guardErrors = []

    for (const node of graph.nodes) {
      const base = node.task || {}
      const task = protocol.validateTask({
        version: 1,
        // A single-node plan keeps the Controller's own task id verbatim; a real
        // plan names each node "<plan>-<node>" so results stay addressable.
        task_id: base.task_id || `${plan.plan_id}-${node.node_id}`,
        objective: node.objective,
        target_repo: plan.target_repo || base.target_repo,
        workspace_mode: plan.workspace_mode || base.workspace_mode,
        risk_level: base.risk_level,
        permissions: base.permissions,
        allowed_paths: node.write_scope || node.file_scope || base.allowed_paths,
        forbidden_paths: [...(base.forbidden_paths || []), ...(node.read_only_files || [])],
        acceptance: [...(base.acceptance || []), ...(node.acceptance_tests || [])],
        acceptance_commands: base.acceptance_commands,
        operations: base.operations,
        workspace: base.workspace,
        requires_vision: base.requires_vision,
        created_at: plan.created_at
      })
      if (!task.ok) {
        guardErrors.push(`node ${node.node_id}: ${task.errors.join('; ')}`)
        continue
      }
      const guard = permissions.guardTask(task.task)
      if (!guard.ok) {
        guardErrors.push(`node ${node.node_id}: ${guard.reason}`)
        continue
      }
      if (!explicit) {
        const gate = permissions.canAutoDelegate(task.task, this.config)
        if (!gate.eligible) {
          guardErrors.push(`node ${node.node_id}: ${gate.reason}`)
          continue
        }
      }
      tasks.set(node.node_id, task.task)
    }

    if (guardErrors.length) {
      const rejectedPlan = {
        plan_id: plan.plan_id,
        graph,
        snapshot: null,
        source,
        accepted_at: new Date().toISOString(),
        target_repo: plan.target_repo,
        workspace_mode: plan.workspace_mode,
        tasks,
        integration: null,
        state: 'rejected'
      }
      for (const node of graph.nodes) {
        if (tasks.has(node.node_id)) continue
        const reason = guardErrors.find((entry) => entry.startsWith(`node ${node.node_id}:`)) || 'the node was rejected'
        const result = protocol.createResult(`${plan.plan_id}-${node.node_id}`, {
          status: 'rejected',
          summary: reason,
          code: protocol.RESULT_CODES.REQUIRES_CONTROLLER,
          reason,
          requires_controller: true
        })
        graph.markTerminal(node.node_id, NODE_STATUS.BLOCKED, result)
        this.recordTerminal({ task_id: result.task_id, task: null, plan_id: plan.plan_id, node_id: node.node_id }, result)
      }
      this.pushRuntimeEvent({ type: 'blocked', summary: `plan ${plan.plan_id} rejected: ${guardErrors.join('; ')}` })
      return { ok: false, accepted: false, rejected: true, errors: guardErrors, code: protocol.RESULT_CODES.REQUIRES_CONTROLLER, plan_id: plan.plan_id }
    }

    const snapshot = safeCall('snapshot', this.log, () => {
      if (!plan.target_repo || !fs.existsSync(plan.target_repo)) return null
      const built = snapshotService.buildSnapshot(plan.target_repo, { planId: plan.plan_id, log: (message) => this.appendLog('scheduler', message) })
      snapshotService.writeSnapshot(this.root, built)
      return built
    })

    const entry = {
      plan_id: plan.plan_id,
      graph,
      snapshot,
      source,
      accepted_at: new Date().toISOString(),
      target_repo: plan.target_repo,
      workspace_mode: plan.workspace_mode,
      tasks,
      integration: null,
      state: 'active'
    }
    this.plans.push(entry)
    this.store.savePlan(plan.plan_id, { ...graph.toJSON(), source, accepted_at: entry.accepted_at, node_tasks: [...tasks].map(([nodeId, task]) => ({ node_id: nodeId, task })) })
    this.syncQueue()
    this.persistState()
    this.pushRuntimeEvent({
      type: 'task_received',
      task_id: plan.plan_id,
      summary: `plan ${plan.plan_id} accepted (${graph.nodes.length} node(s))`,
      nodes: graph.nodes.length,
      source
    })
    this.appendLog('scheduler', `plan ${plan.plan_id} accepted with ${graph.nodes.length} node(s): ${graph.nodes.map((node) => node.node_id).join(', ')}`)
    this.abandonRunningNodesIfNeeded()
    void this.tick()
    return { ok: true, accepted: true, queued: true, plan_id: plan.plan_id, task_id: `${plan.plan_id}-${graph.nodes[0].node_id}`, node_count: graph.nodes.length, queue_length: this.syncQueue().length }
  }

  abandonRunningNodesIfNeeded() {}

  /**
   * Legacy single-task admission (previous phase API). It builds a one-node plan
   * so everything runs through the same scheduler code path (§36).
   */
  assignTask(rawTask, { source = 'controller', explicit = true } = {}) {
    const validation = protocol.validateTask(rawTask)
    if (!validation.ok) {
      return { ok: false, accepted: false, errors: validation.errors, code: protocol.RESULT_CODES.TASK_REJECTED }
    }
    const task = validation.task
    const guard = permissions.guardTask(task)
    if (!guard.ok) {
      const entry = this.rejectTask(task, guard)
      return { ok: false, accepted: false, rejected: true, reason: guard.reason, code: guard.code, entry }
    }
    if (!explicit) {
      const autoGate = permissions.canAutoDelegate(task, this.config)
      if (!autoGate.eligible) {
        return { ok: false, accepted: false, reason: autoGate.reason, code: protocol.RESULT_CODES.REQUIRES_CONTROLLER }
      }
    }
    if (this.queueEntries().length >= DEFAULT_MAX_QUEUE) {
      return { ok: false, accepted: false, reason: 'the sub-worker task queue is full', code: protocol.RESULT_CODES.BLOCKED }
    }

    const planId = task.task_id
    const result = this.submitPlan({
      plan_id: planId,
      objective: task.objective,
      target_repo: task.target_repo,
      workspace_mode: task.workspace_mode,
      acceptance: task.acceptance,
      acceptance_commands: task.acceptance_commands,
      nodes: [{
        node_id: 'task',
        objective: task.objective,
        role: 'generic',
        task,
        write_scope: task.allowed_paths,
        read_only_files: task.forbidden_paths,
        timeout: task.operations?.length ? null : null
      }]
    }, { source, explicit })
    if (!result.ok) {
      return { ok: false, accepted: false, rejected: result.rejected === true, reason: (result.errors || []).join('; '), code: result.code, errors: result.errors }
    }
    return { ok: true, accepted: true, queued: true, task_id: result.task_id, plan_id: result.plan_id, queue_length: result.queue_length }
  }

  /** Structured refusal: an L3/L4 or capability-mismatched task (§9, §23). */
  rejectTask(task, guard) {
    const result = protocol.createResult(task.task_id, {
      status: guard.code === protocol.RESULT_CODES.UNSUPPORTED_CAPABILITY ? 'unsupported_capability' : 'rejected',
      summary: guard.reason,
      code: guard.code,
      reason: guard.reason,
      needs_controller_review: true,
      needs_controller_decision: true,
      requires_controller: true
    })
    this.recordTerminal({ task_id: task.task_id, task, node_id: null, plan_id: null }, result)
    this.pushRuntimeEvent({ type: 'blocked', task_id: task.task_id, summary: guard.reason, reason: guard.reason, code: guard.code })
    return result
  }

  planForNode(node) {
    return this.plans.find((plan) => plan.graph.byId.get(node.node_id) === node) || null
  }

  nodeForWorker(workerId) {
    for (const plan of this.plans) {
      for (const node of plan.graph.running()) {
        if (node.worker_id === workerId) return node
      }
    }
    return null
  }

  // --------------------------------------------------------------- main loop

  /**
   * The documented scheduler loop (§42).
   */
  tick({ force = false } = {}) {
    this.tickCount += 1
    const now = Date.now()
    const minimumInterval = force ? 0 : 250
    if (this.lastTick && now - this.lastTick < minimumInterval && this.lastDecision) return this.lastDecision
    this.lastTick = now
    // A tick must never act while a teardown is draining the pool: scale-up,
    // restart and replacement would all resurrect a worker the stop is waiting
    // for (or has already killed).
    if (this.pool.stopping || this.intentionalStop) {
      return this.lastDecision || null
    }

    const active = this.plans.filter((plan) => ['active', 'recovered'].includes(plan.state))
    const busyWorkers = this.pool.busy.length
    const idleWorkers = this.pool.idle
    const runnable = active.reduce((sum, plan) => sum + plan.graph.runnable().length, 0)
    // §25: a speculative node deliberately wants a second worker for the SAME
    // node, so the demand calculation must count that intent.
    const speculativeDemand = active.reduce(
      (sum, plan) => sum + plan.graph.running().filter((node) => node.speculative && !this.dispatchScheduler.speculationFor(node.node_id)).length,
      0
    )
    const roles = active.flatMap((plan) => plan.graph.runnable().map((node) => workerRoleFor(node)))
    const decision = this.resourceScheduler.decide({
      poolSize: this.pool.size,
      busyWorkers,
      idleWorkers: idleWorkers.length,
      runnableTasks: runnable + speculativeDemand,
      roles: roles.length ? roles : (active.flatMap((plan) => plan.graph.running().map((node) => workerRoleFor(node))) || ['generic'])
    })
    this.lastDecision = decision
    this.lastTick = now

    // Recover the minimum pool whenever the supervisor should be up, the pool is
    // empty and the machine is healthy again (§35): a SAFE MODE park is not an
    // intentional stop.
    const poolRecoverable = !this.isRunning && !this.intentionalStop && this.activated
      && this.state.state !== 'OFF' && this.state.state !== 'HANDOFF'
      && !['CRITICAL', 'SAFE_MODE'].includes(decision.state)
    if (poolRecoverable) {
      safeCall('pool recovery', this.log, () => {
        this.journalLine(`[supervisor] recovering the pool after ${this.state.state} (${decision.state})`)
        this.start({ reason: 'pool recovery' }).catch((error) => this.journalLine(`[supervisor] pool recovery failed: ${error?.message || error}`))
      })
      return decision
    }

    if (!this.isRunning && !this.intentionalStop && active.length) {
      // A supervisor that lost its pool while work is pending must recover on
      // its own instead of stalling the queue (§34).
      safeCall('autostart', this.log, () => {
        if (!this.isRunning) this.start({ reason: 'pool recovery' }).catch(() => {})
      })
      return decision
    }

    // --- scale -------------------------------------------------------------
    if (this.isRunning) {
      const desired = Math.max(0, decision.desired)
      const scaled = this.pool.ensureSize(desired, { role: roles[0] || 'generic', reason: `scheduler:${decision.state}` })
      if (scaled.actions.length) {
        const action = scaled.actions[0]
        this.metrics.recordScaleEvent({ from: this.pool.size, to: desired, direction: decision.direction, reason: action.reason })
        this.appendLog('supervisor', `scale ${decision.direction}: ${action.action} ${action.worker_id || ''} (${action.reason})`)
      }
    }

    // --- safety valve (§10 CRITICAL / §35 SAFE MODE) -------------------------
    // "Stop starting new tasks, pause low-priority workers, terminate resumable
    // workers if necessary, and keep the Supervisor alive." A pool that cannot
    // park because its workers are busy is exactly the case where the machine
    // needs the memory back, so the lowest-priority running node is cancelled
    // (resumably - the Controller can replay it) after the state has persisted
    // for a few cycles.
    if (decision.state === 'SAFE_MODE' && this.resourceScheduler.criticalSamples >= 3 && !this.safeValveUsed) {
      const candidates = this.runningEntries()
        .sort((left, right) => priorityOf(left.node) - priorityOf(right.node))
      const victim = candidates[0]
      if (victim) {
        const taskId = `${victim.plan.plan_id}-${victim.node.node_id}`
        this.safeValveUsed = true
        this.journalLine(`[supervisor] SAFE MODE: cancelling ${taskId} to free the machine (resumable)`)
        this.pool.send(victim.worker_id, 'stop_task', { reason: 'SAFE MODE: resource pressure, the task is resumable' })
        this.pushRuntimeEvent({
          type: 'warning',
          task_id: taskId,
          summary: `SAFE MODE cancelled ${taskId} to protect the host; replay it once memory recovers`
        })
      }
    }
    if (decision.state !== 'SAFE_MODE' && decision.state !== 'CRITICAL') this.safeValveUsed = false

    // --- health (§32, §33) --------------------------------------------------
    const verdicts = this.pool.health({
      heartbeatSeconds: Math.max(1, Math.round((this.config.heartbeatMs || 2000) / 1000)),
      hangDetectionSeconds: this.resourceConfig.runtime.hangDetectionSeconds
    })
    this.healthVerdicts = verdicts
    for (const verdict of verdicts) {
      if (verdict.status === 'WAITING') {
        this.pushRuntimeEvent({ type: 'warning', summary: `worker ${verdict.worker_id}: ${verdict.reason}`, worker_id: verdict.worker_id })
        continue
      }
      if (verdict.action !== 'restart') continue
      const node = this.nodeForWorker(verdict.worker_id)
      this.appendLog('workers', `worker ${verdict.worker_id} ${verdict.status}: ${verdict.reason}`)
      this.pushRuntimeEvent({ type: 'warning', summary: `worker ${verdict.worker_id} ${verdict.status}: ${verdict.reason}`, worker_id: verdict.worker_id })
      if (node) {
        const plan = this.planForNode(node)
        const result = protocol.createResult(`${plan?.plan_id || 'plan'}-${node.node_id}`, {
          status: 'failed',
          summary: `worker ${verdict.worker_id} was ${verdict.status}: ${verdict.reason}`,
          code: verdict.status === 'STALLED' ? protocol.RESULT_CODES.TIMEOUT : protocol.RESULT_CODES.CRASHED,
          reason: verdict.reason,
          needs_controller_decision: true
        })
        this.finishNode(plan, node, result, { workerId: verdict.worker_id, crashed: true })
      }
      this.pool.restart(verdict.worker_id, { reason: `${verdict.status}: ${verdict.reason}` })
      this.metrics.recordWorkerEvent(verdict.worker_id, 'restart')
    }

    // --- dispatch ----------------------------------------------------------
    if (active.length && !['CRITICAL', 'SAFE_MODE', 'THROTTLED'].includes(decision.state)) {
      this.dispatchRound(active, decision)
    }

    // --- completion --------------------------------------------------------
    for (const plan of active) this.maybeCompletePlan(plan)

    this.syncQueue()
    this.notify()
    return decision
  }

  dispatchRound(active, decision) {
    let idleWorkers = this.pool.idle.map((slot) => ({ worker_id: slot.worker_id, role: slot.role, slot }))
    const onlineInUse = this.pool.busy.filter((slot) => this.nodeForWorker(slot.worker_id)?.requires_network).length
    const gpuInUse = this.pool.busy.filter((slot) => this.nodeForWorker(slot.worker_id)?.requires_gpu).length

    for (const plan of active) {
      if (!idleWorkers.length) break
      const selection = this.dispatchScheduler.selectDispatch({
        graph: plan.graph,
        idleWorkers,
        registry: this.registry,
        performanceState: decision.state,
        onlineSlots: this.resourceScheduler.lastEvaluation?.externalLimit ?? this.resourceConfig.externalService.apiConcurrencyLimit,
        gpuSlots: this.resourceScheduler.lastEvaluation?.gpuLimit ?? 0,
        onlineInUse,
        gpuInUse
      })
      for (const item of selection.dispatch) {
        const dispatched = this.dispatchNode(plan, item.node, item.worker)
        if (!dispatched.ok) {
          this.pushRuntimeEvent({ type: 'warning', summary: `could not dispatch ${item.node.node_id}: ${dispatched.reason}` })
          continue
        }
        idleWorkers = idleWorkers.filter((worker) => worker.worker_id !== item.workerId)
      }
      if (selection.reasons.length) {
        for (const reason of selection.reasons) this.appendLog('scheduler', `${plan.plan_id}: ${reason}`)
      }

      // §25: speculative duplicates, only while resources are healthy.
      const speculation = this.dispatchScheduler.selectSpeculative({
        graph: plan.graph,
        idleWorkers,
        performanceState: decision.state,
        onlineSlots: this.resourceScheduler.lastEvaluation?.externalLimit ?? 0,
        onlineInUse
      })
      for (const item of speculation) {
        const dispatched = this.dispatchNode(plan, item.node, item.worker, { duplicate: true })
        if (dispatched.ok) idleWorkers = idleWorkers.filter((worker) => worker.worker_id !== item.workerId)
      }
    }
  }

  /** Prepare the workspace, build the package and hand the node to a worker. */
  dispatchNode(plan, node, worker, { duplicate = false } = {}) {
    const task = plan.tasks.get(node.node_id)
    if (!task) return { ok: false, reason: 'the node has no validated task' }

    const compat = this.poolCeiling === 1
    const prepared = this.prepareWorkspace({ ...task, plan_id: plan.plan_id, node_id: node.node_id }, plan, node, { compat, duplicate })
    if (!prepared.ok) {
      const result = protocol.createResult(`${plan.plan_id}-${node.node_id}`, {
        status: 'blocked',
        summary: prepared.reason,
        code: prepared.code || protocol.RESULT_CODES.WORKSPACE_LOCKED,
        reason: prepared.reason,
        needs_controller_decision: true
      })
      this.finishNode(plan, node, result, { workerId: worker.worker_id })
      return { ok: false, reason: prepared.reason }
    }

    const built = snapshotService.buildTaskPackage({
      node,
      plan: plan.graph.plan,
      snapshot: plan.snapshot,
      workspace: prepared.workspace,
      workerId: worker.worker_id,
      writeScope: prepared.writeScope,
      readOnlyFiles: prepared.readOnlyFiles,
      timeoutSeconds: this.resourceConfig.runtime.workerTimeoutSeconds,
      context: prepared.context
    })
    if (!built.ok) return { ok: false, reason: built.errors.join('; ') }

    const dispatchedTask = snapshotService.taskFromPackage(built.package, {
      baseTask: { ...task, workspace: prepared.workspace, workspace_mode: prepared.mode }
    })

    // The file ownership registry turns the package's scope into an exclusive
    // claim, so two workers can never write the same file (§19).
    const claimed = this.registry.claim(worker.worker_id, node.node_id, prepared.writeScope)
    this.persistRegistry()
    this.metrics.recordWorkerEvent(worker.worker_id, 'task')

    const assigned = this.pool.assign(worker.worker_id, dispatchedTask, built.package)
    if (!assigned.ok) {
      this.registry.release(worker.worker_id)
      return { ok: false, reason: assigned.reason }
    }
    // Notes that arrived while the worker was idle are re-sent so they are
    // injected at this task's first execution boundary (plan §15, Send Note).
    for (const note of this.pendingNotes.filter((entry) => !entry.applied)) {
      const payload = { note: note.note }
      if (note.forbid) payload.forbid = note.forbid
      if (note.allow) payload.allow = note.allow
      note.delivered = this.pool.send(worker.worker_id, 'note', payload) || note.delivered === true
    }
    plan.graph.markRunning(node.node_id, worker.worker_id)
    plan.workspaceByNode = plan.workspaceByNode || new Map()
    plan.workspaceByNode.set(node.node_id, prepared.workspace)
    this.nodeChanges.set(`${plan.plan_id}-${node.node_id}`, { base: prepared.baseCommit, workspace: prepared.workspace, files: {} })
    if (!duplicate) {
      this.liveMeta = {
        task_id: dispatchedTask.task_id,
        node_id: node.node_id,
        plan_id: plan.plan_id,
        objective: node.objective,
        workspace: prepared.workspace,
        workspace_mode: prepared.mode,
        worker_id: worker.worker_id,
        started_at: new Date().toISOString()
      }
      this.liveReporter = new Reporter({ root: this.root, taskId: dispatchedTask.task_id })
      this.workerLiveViews.set(worker.worker_id, this.liveMeta)
      this.liveResult = null
      this.liveFinishedAt = null
      this.currentTaskOverride = dispatchedTask
      this.forceState('ASSIGNED', { task_id: dispatchedTask.task_id, objective: node.objective })
    }
    this.pushRuntimeEvent({
      type: 'task_started',
      task_id: dispatchedTask.task_id,
      summary: `${duplicate ? 'speculative ' : ''}dispatching ${node.node_id} to ${worker.worker_id}`,
      workspace: prepared.workspace,
      worker_id: worker.worker_id
    })
    this.appendLog('scheduler', `dispatch ${node.node_id} → ${worker.worker_id} (priority ${priorityOf(node)}, workspace ${prepared.workspace})`)
    return { ok: true, worker_id: worker.worker_id, task_id: dispatchedTask.task_id, workspace: prepared.workspace }
  }

  /**
   * Workspace for a node: an isolated worktree in real plans, the documented
   * single worktree in compatibility mode, or an explicit shared path.
   */
  prepareWorkspace(task, plan, node, { compat = true, duplicate = false } = {}) {
    const existingLock = this.store.loadWorkspaceLock()
    const sharedRequested = task.workspace_mode === 'shared'

    if (task.workspace_mode === 'isolated_worktree' && task.target_repo) {
      const worktree = WorktreeManager.worktreePathFor(task.target_repo, {
        planId: plan?.plan_id,
        nodeId: node?.node_id,
        compat: compat || duplicate
      })
      const ensured = WorktreeManager.ensure(task.target_repo, { worktree, log: (message) => this.journalLine(message) })
      if (ensured.ok) {
        const baseCommit = integration.headCommit(ensured.worktree)
        return {
          ok: true,
          workspace: ensured.worktree,
          mode: 'isolated_worktree',
          created: ensured.created,
          baseCommit,
          writeScope: node?.write_scope || node?.file_scope || task.allowed_paths || ['**'],
          readOnlyFiles: node?.read_only_files || [],
          context: { snapshot: plan?.snapshot?.project_structure?.top_level || null, relevant_files: node?.relevant_files || [] }
        }
      }
      if (!task.workspace) return { ok: false, code: protocol.RESULT_CODES.BLOCKED, reason: ensured.reason }
    }

    if (sharedRequested || task.workspace) {
      const resolved = task.workspace ? path.resolve(String(task.workspace)) : path.join(this.root, 'workspace', 'sub-worker', task.task_id)
      fs.mkdirSync(resolved, { recursive: true })
      // A shared working tree is exactly what §17/§34 forbid two workers from
      // touching at once, so the single-writer lock still applies here.
      if (existingLock && existingLock.workspace === resolved && existingLock.task_id && existingLock.task_id !== task.task_id
        && existingLock.node_id !== node?.node_id && this.nodeRunningLock(existingLock)) {
        return {
          ok: false,
          code: protocol.RESULT_CODES.WORKSPACE_LOCKED,
          reason: `workspace ${resolved} is locked by ${existingLock.task_id}`
        }
      }
      this.store.saveWorkspaceLock({
        task_id: task.task_id,
        node_id: node?.node_id || null,
        workspace: resolved,
        mode: 'shared',
        pid: this.primary?.pid || null,
        at: new Date().toISOString()
      })
      return {
        ok: true,
        workspace: resolved,
        mode: 'shared',
        created: false,
        baseCommit: integration.headCommit(resolved),
        writeScope: node?.write_scope || node?.file_scope || task.allowed_paths || ['**'],
        readOnlyFiles: node?.read_only_files || [],
        context: null
      }
    }

    const fallback = path.join(this.root, 'workspace', 'sub-worker', `${plan?.plan_id || 'task'}-${node?.node_id || 'node'}`)
    fs.mkdirSync(fallback, { recursive: true })
    return {
      ok: true,
      workspace: fallback,
      mode: 'shared',
      created: false,
      baseCommit: null,
      writeScope: node?.write_scope || node?.file_scope || task.allowed_paths || ['**'],
      readOnlyFiles: node?.read_only_files || [],
      context: null
    }
  }

  nodeRunningLock(lock) {
    if (!lock) return false
    for (const plan of this.plans) {
      for (const node of plan.graph.running()) {
        if (node.node_id === lock.node_id) return true
      }
    }
    return false
  }

  releaseWorkspaceLock(reason = '') {
    const lock = this.store.loadWorkspaceLock()
    this.store.clearWorkspaceLock()
    if (lock) this.pushRuntimeEvent({ type: 'diff_generated', summary: `Workspace lock released (${reason})` })
    return lock
  }

  // ------------------------------------------------------------------ results

  handleResult(workerId, slot, result, liveView) {
    if (!result || typeof result !== 'object') return
    const node = this.nodeForWorker(workerId)
    const plan = node ? this.planForNode(node) : null
    if (liveView) {
      this.pool.get(workerId).workerLiveView = { ...liveView, task_id: result.task_id }
      if (this.liveMeta?.worker_id === workerId) this.workerLiveViews.set(workerId, { ...this.liveMeta })
    }
    if (this.liveMeta?.worker_id === workerId || !this.liveMeta) {
      this.liveResult = result
      this.liveFinishedAt = result.finished_at || new Date().toISOString()
    }
    const usage = result.resource_usage || null
    const taskStartedAt = slot.task_started_at ? Date.parse(slot.task_started_at) : null
    this.metrics.recordTask({
      task_id: result.task_id,
      node_id: node?.node_id || null,
      plan_id: plan?.plan_id || null,
      worker_id: workerId,
      role: slot.role,
      status: result.status,
      code: result.code,
      started_at: slot.task_started_at,
      finished_at: result.finished_at,
      duration_ms: taskStartedAt ? Math.max(0, Date.now() - taskStartedAt) : null,
      tests: result.tests,
      resource_usage: usage,
      retried: (node?.attempts || 0) > 1,
      speculative: Boolean(this.dispatchScheduler.speculationFor(node?.node_id))
    })
    this.store.saveMetrics(this.metrics.serialize())

    this.pool.release(workerId, { status: result.status })
    const released = this.registry.release(workerId)
    if (released.length) this.persistRegistry()
    if (!node || !plan) {
      this.recordTerminal({ task_id: result.task_id, task: null, plan_id: null, node_id: null }, result)
      this.drainNotifications(result)
      return
    }

    // A speculative duplicate that lost the race is cancelled, not reported.
    const speculation = this.dispatchScheduler.speculationFor(node.node_id)
    if (speculation && speculation.duplicates.length && result.status === 'completed') {
      for (const duplicateId of speculation.duplicates) {
        if (duplicateId === workerId) continue
        this.pool.send(duplicateId, 'stop_task', { reason: `speculative race won by ${workerId}` })
        this.pushRuntimeEvent({ type: 'warning', summary: `cancelled speculative duplicate on ${duplicateId}`, worker_id: duplicateId })
      }
      this.dispatchScheduler.clearSpeculation(node.node_id)
    }

    this.finishNode(plan, node, result, { workerId })
    this.drainNotifications(result)
    this.tick({ force: true })
  }

  drainNotifications(result) {
    if (!this.config.showNotifications) return
    this.pushNotification({
      kind: `task_${result.status}`,
      title: `Sub-worker task ${result.status}`,
      body: `${result.task_id}: ${result.summary || result.reason || ''}`.slice(0, 200),
      task_id: result.task_id
    })
  }

  /**
   * A node reached a terminal state: record it, decide about a retry, and let
   * dependent nodes become runnable (§15, §34).
   */
  finishNode(plan, node, result, { workerId = null, crashed = false } = {}) {
    if (!node || !plan) return null
    const nodeTask = plan.tasks.get(node.node_id) || null
    if (node.status === NODE_STATUS.RUNNING) node.worker_id = workerId || node.worker_id
    const terminal = result.status === 'completed'
      ? NODE_STATUS.COMPLETED
      : (result.status === 'blocked' || result.status === 'rejected' || result.status === 'unsupported_capability'
        ? NODE_STATUS.BLOCKED
        : (result.status === 'cancelled' ? NODE_STATUS.CANCELLED : NODE_STATUS.FAILED))

    const retry = crashed || terminal === NODE_STATUS.FAILED
      ? plan.graph.retryable(node.node_id, result)
      : { retry: false, reason: 'not retryable' }

    plan.graph.markTerminal(node.node_id, terminal, result)
    this.currentTaskOverride = null
    this.recordTerminal({ task_id: result.task_id, task: nodeTask, plan_id: plan.plan_id, node_id: node.node_id }, result)
    this.appendLog('scheduler', `node ${node.node_id} → ${result.status} (${result.code || 'no code'})${retry.retry ? `; ${retry.reason}` : ''}`)
    this.forceState(
      result.status === 'completed' ? 'READY_FOR_REVIEW'
        : (['blocked', 'rejected', 'unsupported_capability'].includes(result.status) ? 'BLOCKED'
          : (result.status === 'cancelled' ? 'IDLE' : 'FAILED')),
      { task_id: null, objective: null, stage: null, pid: this.primary?.pid || null }
    )

    if (retry.retry) {
      plan.graph.byId.get(node.node_id).status = NODE_STATUS.PENDING
      plan.graph.byId.get(node.node_id).worker_id = null
      this.pushRuntimeEvent({ type: 'warning', summary: `retrying node ${node.node_id}: ${retry.reason}` })
      this.appendLog('scheduler', `retry ${node.node_id} (attempt ${node.attempts}/${node.max_attempts})`)
    } else if (terminal !== NODE_STATUS.COMPLETED) {
      // Dependents of a failed node can never run; mark them blocked so the plan
      // can finish instead of hanging forever.
      for (const entry of plan.graph.blockedByDependency()) {
        plan.graph.markTerminal(entry.node.node_id, NODE_STATUS.BLOCKED, {
          status: 'blocked',
          code: protocol.RESULT_CODES.BLOCKED,
          summary: `dependency ${entry.failed_dependency} did not complete`
        })
      }
    }
    // The evidence a node produced is kept for the integration merge (§18).
    const key = `${plan.plan_id}-${node.node_id}`
    const change = this.nodeChanges.get(key)
    if (change?.workspace && result.status === 'completed') {
      const collected = safeCall('collect changes', this.log, () => integration.collectChanges(change.workspace, change.base))
      if (collected?.ok) {
        change.files = collected.files
        this.nodeChanges.set(key, change)
      }
    }
    this.persistState()
    void nodeTask
    return terminal
  }

  /**
   * When the DAG drains, run the integration/validation phase (§18, §22, §42).
   */
  maybeCompletePlan(plan) {
    if (!['active', 'recovered'].includes(plan.state)) return null
    const pending = plan.graph.nodes.filter((node) => ![NODE_STATUS.COMPLETED, NODE_STATUS.FAILED, NODE_STATUS.BLOCKED, NODE_STATUS.CANCELLED, NODE_STATUS.SKIPPED].includes(node.status))
    if (pending.length) return null
    const nodes = plan.graph.nodes
    const failed = nodes.filter((node) => [NODE_STATUS.FAILED, NODE_STATUS.BLOCKED].includes(node.status))
    const changed = []
    for (const node of nodes) {
      const change = this.nodeChanges.get(`${plan.plan_id}-${node.node_id}`)
      if (change) changed.push({ node_id: node.node_id, worker_id: node.worker_id, files: change.files })
    }

    // §18/§42: merge the per-node worktrees into one integration worktree.
    const merged = safeCall('integration', this.log, () => integration.integrate({
      targetRepo: plan.target_repo,
      planId: plan.plan_id,
      nodeChanges: changed,
      log: (message) => this.appendLog('supervisor', message)
    }), { ok: false, conflicts: [], reason: 'integration failed' })
    this.metrics.recordMerge({ conflicts: merged.conflicts?.length || 0, files: merged.written || 0, plan_id: plan.plan_id })
    this.store.saveMetrics(this.metrics.serialize())
    this.lastIntegration = { plan_id: plan.plan_id, ...merged }
    this.pushRuntimeEvent({
      type: merged.conflicts?.length ? 'warning' : 'diff_generated',
      summary: `integration ${plan.plan_id}: ${merged.summary}`,
      conflicts: merged.conflicts?.length || 0,
      worktree: merged.worktree || null
    })

    plan.integration = merged
    plan.state = failed.length ? 'failed' : 'completed'
    plan.completed_at = new Date().toISOString()
    this.persistState()

    // Release the per-node worktrees? No: they hold the evidence. Only the
    // integration worktree is kept as the reviewable deliverable.
    this.pushRuntimeEvent({
      type: failed.length ? 'task_failed' : 'task_completed',
      task_id: plan.plan_id,
      summary: `plan ${plan.plan_id} ${failed.length ? 'finished with failures' : 'completed'}`
    })
    if (merged.conflicts?.length) {
      this.pushNotification({
        kind: 'merge_conflict',
        title: 'Sub-worker merge conflict',
        body: `${plan.plan_id}: ${merged.conflicts.map((conflict) => conflict.path).join(', ')}`.slice(0, 200)
      })
    }
    void this.tick
    return plan.state
  }

  // --------------------------------------------------------------- accounting

  recordTerminal(taskLike, result) {
    const taskId = result?.task_id || taskLike?.task_id
    const plan = taskLike?.plan_id ? this.plans.find((entry) => entry.plan_id === taskLike.plan_id) : null
    const node = plan && taskLike?.node_id ? plan.graph.byId.get(taskLike.node_id) : null
    this.activate()
    const entry = {
      task_id: taskId,
      status: result?.status || 'failed',
      objective: node?.objective || taskLike?.task?.objective || this.state.objective || null,
      risk_level: taskLike?.task?.risk_level || null,
      target_repo: taskLike?.task?.target_repo || plan?.target_repo || null,
      workspace: result?.workspace || taskLike?.task?.workspace || null,
      summary: result?.summary || '',
      code: result?.code || null,
      changed_files: Array.isArray(result?.changed_files) ? result.changed_files : [],
      tests: result?.tests || { passed: 0, failed: 0, skipped: 0 },
      finished_at: result?.finished_at || new Date().toISOString(),
      needs_controller_review: result?.needs_controller_review !== false,
      plan_id: taskLike?.plan_id || null,
      node_id: taskLike?.node_id || null,
      worker_id: result?.worker_id || null,
      worker_role: result?.worker_role || null
    }
    this.history = this.store.appendHistory(entry)
    const existing = this.store.loadTaskRecord(taskId) || {}
    this.store.saveTaskRecord(taskId, {
      ...existing,
      ...entry,
      task: existing.task || taskLike?.task || null,
      result,
      checkpoint: {
        task_id: taskId,
        status: entry.status,
        code: entry.code,
        workspace: entry.workspace,
        changed_files: entry.changed_files,
        tests: entry.tests,
        worker_id: entry.worker_id,
        plan_id: entry.plan_id,
        node_id: entry.node_id,
        at: entry.finished_at,
        boundary: 'task_end',
        next: entry.needs_controller_review ? 'controller_review' : 'next_task'
      },
      events: this.events.filter((event) => event.task_id === taskId).slice(-300),
      savedAt: Date.now()
    })
    return entry
  }

  recordCancelled(entry, reason) {
    const result = protocol.createResult(`${entry.plan?.plan_id || 'plan'}-${entry.node.node_id}`, {
      status: 'cancelled',
      summary: reason,
      code: protocol.RESULT_CODES.CANCELLED,
      reason,
      needs_controller_review: false,
      needs_controller_decision: true
    })
    entry.plan.graph.markTerminal(entry.node.node_id, NODE_STATUS.CANCELLED, result)
    this.recordTerminal({ task_id: result.task_id, task: entry.task, plan_id: entry.plan.plan_id, node_id: entry.node.node_id }, result)
    return result
  }

  noteNodeChange(workerId, event) {
    const node = this.nodeForWorker(workerId)
    if (!node) return
    const plan = this.planForNode(node)
    const key = `${plan.plan_id}-${node.node_id}`
    const change = this.nodeChanges.get(key)
    if (change) {
      change.files[event.path] = { content: null, base: null, pending: true }
      this.nodeChanges.set(key, change)
    }
  }

  pushRuntimeEvent(event) {
    const entry = {
      timestamp: event.timestamp || new Date().toISOString(),
      task_id: event.task_id === undefined ? (this.state.task_id ?? null) : event.task_id,
      ...event
    }
    redactEventFields(entry)
    if (this.liveReporter) {
      try {
        this.liveReporter.record(entry)
      } catch (error) {
        this.journalLine(`[supervisor] live view projection failed: ${error?.message || error}`)
      }
    }
    this.events.push(entry)
    if (this.events.length > MAX_EVENTS_IN_MEMORY) this.events.splice(0, this.events.length - MAX_EVENTS_IN_MEMORY)
    this.notify(entry)
    return entry
  }

  pushNotification(notification) {
    const entry = { ...notification, at: new Date().toISOString() }
    this.notifications.push(entry)
    if (this.notifications.length > 50) this.notifications.splice(0, this.notifications.length - 50)
    this.notify({ type: 'notification', notification: entry })
    return entry
  }

  persistRegistry() {
    this.store.saveFileOwnership(this.registry.serialize())
    return this.registry.list()
  }

  // ------------------------------------------------------ user intervention

  pause(reason = 'paused by user') {
    if (!this.isRunning) return { ok: false, reason: 'worker is not running' }
    const delivered = this.pool.broadcast('pause', { reason })
    if (!delivered.length) {
      // An idle pool parks immediately: Pause is meaningful even with no task.
      this.setState('PAUSED', { lastError: null })
    }
    this.pushRuntimeEvent({ type: 'state_changed', summary: `paused by ${reason}` })
    return { ok: true, state: 'PAUSING', workers: delivered }
  }

  resume(reason = 'resumed by user') {
    if (!this.isRunning) return { ok: false, reason: 'worker is not running' }
    const delivered = this.pool.broadcast('resume', { reason })
    if (!delivered.length && this.state.state === 'PAUSED') this.setState('IDLE')
    this.pushRuntimeEvent({ type: 'state_changed', summary: `resumed by ${reason}` })
    return { ok: true, workers: delivered }
  }

  cancelTask(reason = 'cancelled by controller') {
    if (!this.isRunning) return { ok: false, reason: 'worker is not running' }
    const running = this.runningEntries()
    if (!running.length) return { ok: false, reason: 'no task is running' }
    const cancelled = []
    for (const entry of running) {
      this.pool.send(entry.worker_id, 'stop_task', { reason })
      cancelled.push(`${entry.plan.plan_id}-${entry.node.node_id}`)
    }
    this.pushRuntimeEvent({ type: 'warning', summary: `Cancellation requested: ${reason}`, tasks: cancelled })
    return { ok: true, tasks: cancelled, reason }
  }

  sendNote(note) {
    const payload = typeof note === 'string' ? { note } : { ...(note || {}) }
    if (!payload.note && !payload.forbid && !payload.allow) {
      return { ok: false, reason: 'a note must contain text or explicit constraints' }
    }
    const entry = { ...payload, at: new Date().toISOString(), applied: false, delivered: false }
    this.pendingNotes.push(entry)
    const delivered = this.pool.broadcast('note', payload)
    entry.delivered = delivered.length > 0
    this.pushRuntimeEvent({
      type: 'note_applied',
      task_id: this.state.task_id,
      summary: `Note queued: ${String(payload.note || '').slice(0, 200)}`,
      delivered: entry.delivered,
      workers: delivered
    })
    return { ok: true, queued: true, delivered: entry.delivered, workers: delivered, notes: this.pendingNotes.length }
  }

  markNotesApplied() {
    this.pendingNotes = this.pendingNotes.map((note) => (note.applied ? note : { ...note, applied: true, appliedAt: new Date().toISOString() }))
    return this.pendingNotes
  }

  async takeOver({ reason = 'user take over' } = {}) {
    const lock = this.store.loadWorkspaceLock()
    const running = this.runningEntries()
    const captured = {
      task_id: this.state.task_id,
      objective: this.state.objective,
      workspace: lock?.workspace || running[0]?.plan?.workspaceByNode?.get(running[0].node.node_id) || null,
      workspace_lock: lock || null,
      tasks: running.map((entry) => ({
        plan_id: entry.plan.plan_id,
        node_id: entry.node.node_id,
        workspace: entry.plan.workspaceByNode?.get(entry.node.node_id) || null
      })),
      live_view: this.liveSnapshot(),
      events: this.events.slice(-40),
      at: new Date().toISOString(),
      reason
    }
    if (this.isRunning) {
      this.pool.broadcast('take_over', { reason })
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    this.intentionalStop = true
    this.stopTicking()
    for (const entry of running) {
      const result = protocol.createResult(`${entry.plan.plan_id}-${entry.node.node_id}`, {
        status: 'handoff',
        summary: `workspace handed to the Controller (${reason})`,
        code: protocol.RESULT_CODES.BLOCKED,
        reason,
        needs_controller_review: false
      })
      entry.plan.graph.markTerminal(entry.node.node_id, NODE_STATUS.BLOCKED, result)
      this.recordTerminal({ task_id: result.task_id, task: entry.task, plan_id: entry.plan.plan_id, node_id: entry.node.node_id }, result)
    }
    this.pool.killAll({ reason })
    this.pool.clearOwnership()
    this.store.clearWorkspaceLock()
    this.forceState('HANDOFF', { pid: null, task_id: null, objective: null, stage: null, handoff: captured })
    this.store.saveTaskRecord('handoff', { kind: 'handoff', ...captured, savedAt: Date.now() })
    this.pushRuntimeEvent({ type: 'diff_generated', summary: `Workspace handed over: ${captured.workspace || 'n/a'}` })
    this.notify()
    return { ok: true, state: 'HANDOFF', handoff: captured }
  }

  clearHandoff() {
    if (this.state.state !== 'HANDOFF') return { ok: false, reason: 'no handoff in progress' }
    this.forceState('OFF', { handoff: null })
    this.notify()
    return { ok: true, state: 'OFF' }
  }

  async resumeLastTask() {
    const record = (this.history || []).find((entry) => ['failed', 'cancelled', 'handoff'].includes(entry.status))
    const stored = record?.task_id ? this.store.loadTaskRecord(record.task_id) : null
    const planId = stored?.plan_id || null
    const savedPlan = planId ? this.store.loadPlan(planId) : null
    if (stored?.task) {
      if (!this.isRunning) await this.start({ reason: 'crash resume' })
      return this.assignTask(stored.task, { source: 'crash-resume', explicit: true })
    }
    if (savedPlan?.nodes?.length) {
      if (!this.isRunning) await this.start({ reason: 'crash resume' })
      const nodes = savedPlan.nodes.map((node) => ({
        ...node,
        status: undefined,
        attempts: 0,
        worker_id: null,
        result: null,
        task: (savedPlan.node_tasks || []).find((entry) => entry.node_id === node.node_id)?.task || node.task || null,
        depends_on: node.depends_on || [],
        write_scope: node.write_scope || node.file_scope || null
      }))
      return this.submitPlan({ ...savedPlan.plan, nodes }, { source: 'crash-resume' })
    }
    return { ok: false, reason: 'no interrupted task with a replayable specification was found' }
  }

  releaseWorktree(targetRepo, { planId = null, nodeId = null } = {}) {
    const target = String(targetRepo || '').trim()
    if (!target) return { ok: false, reason: 'target_repo is required' }
    if (this.runningEntries().length) {
      return { ok: false, reason: `cannot release a worktree while ${this.runningEntries()[0].node.node_id} is running` }
    }
    const worktree = WorktreeManager.worktreePathFor(target, { planId, nodeId, compat: !planId || !nodeId })
    const result = WorktreeManager.remove(target, { worktree })
    this.pushRuntimeEvent({
      type: 'diff_generated',
      summary: result.removed ? `Worktree released: ${worktree}` : `No worktree to release for ${target}`
    })
    this.notify()
    return { ...result, target_repo: target, worktree }
  }

  // ---------------------------------------------------------------- queries

  readTaskLog(taskId) {
    const file = path.join(this.store.paths.taskLogsDir, `${protocol.sanitizeTaskId(taskId)}.log`)
    try {
      const text = fs.readFileSync(file, 'utf8')
      return { ok: true, file, text: redactSecrets(text.split(/\r?\n/).slice(-400).join('\n')) }
    } catch (error) {
      return { ok: false, file, reason: String(error?.message || error), text: '' }
    }
  }

  liveSnapshot() {
    if (!this.liveMeta || !this.liveReporter) return null
    const projected = this.liveReporter.describe()
    const primaryWorker = this.liveMeta.worker_id ? this.pool.get(this.liveMeta.worker_id) : null
    const worker = primaryWorker?.workerLiveView && primaryWorker.workerLiveView.task_id === this.liveMeta.task_id ? primaryWorker.workerLiveView : null
    const live = {
      ...(worker || projected),
      ...this.liveMeta,
      status: this.liveResult ? this.liveResult.status : (this.state.task_id === this.liveMeta.task_id ? this.state.state : 'IDLE'),
      stage: this.state.stage || primaryWorker?.stage || null,
      finished_at: this.liveFinishedAt,
      result: this.liveResult || null
    }
    if (projected.summary.length > (live.summary || []).length) live.summary = projected.summary
    if (!(live.terminal || []).length) live.terminal = projected.terminal
    if (!(live.changed_files || []).length) live.changed_files = projected.changed_files
    if (!live.tests?.parser) live.tests = projected.tests
    return live
  }

  liveViewFor(taskId = null) {
    const current = this.liveSnapshot()
    if (!taskId || (current && current.task_id === taskId)) return current
    const record = this.store.loadTaskRecord(taskId)
    if (!record) return null
    return {
      task_id: taskId,
      objective: record.objective,
      status: record.status,
      stage: null,
      started_at: record.result?.started_at || null,
      finished_at: record.finished_at,
      summary: record.result?.summary
        ? [{ icon: 'ok', text: record.result.summary, type: 'task_completed', at: record.finished_at }]
        : [],
      changed_files: (record.changed_files || []).map((file) => ({ path: file, status: 'M' })),
      terminal: [],
      tests: record.tests || { passed: 0, failed: 0, skipped: 0 },
      warnings: record.result?.warnings || [],
      errors: record.result?.reason ? [record.result.reason] : [],
      result: record.result
    }
  }

  /** Live Views of every busy worker (the multi-worker panel needs them all). */
  liveViews() {
    return this.pool.workers.map((slot) => ({
      worker_id: slot.worker_id,
      role: slot.role,
      state: slot.state,
      busy: slot.busy,
      task_id: slot.task_id,
      node_id: slot.node_id,
      stage: slot.stage || null,
      live: this.liveMeta?.worker_id === slot.worker_id ? this.liveSnapshot() : null
    }))
  }

  describe() {
    const running = this.isRunning
    const counts = (this.history || []).reduce((acc, entry) => {
      acc[entry.status] = (acc[entry.status] || 0) + 1
      return acc
    }, {})
    const decision = this.lastDecision || null
    const planSummaries = this.plans.map((plan) => ({
      plan_id: plan.plan_id,
      source: plan.source,
      state: plan.state,
      accepted_at: plan.accepted_at,
      target_repo: plan.target_repo,
      integration: plan.integration
        ? { ok: plan.integration.ok, conflicts: plan.integration.conflicts?.length || 0, worktree: plan.integration.worktree, summary: plan.integration.summary }
        : null,
      ...plan.graph.describe()
    }))
    return {
      feature: 'optional-sub-worker',
      available: true,
      enabled: running,
      state: this.state.state,
      stage: this.state.stage || null,
      worker_id: this.primary?.worker_id || this.workerId,
      pid: this.primary?.pid || this.state.pid || null,
      mode: 'Executor',
      role: 'executor-not-controller',
      task: this.state.task_id
        ? { task_id: this.state.task_id, objective: this.state.objective, stage: this.state.stage || null }
        : null,
      task_id: this.state.task_id || null,
      objective: this.state.objective || null,
      queue: this.syncQueue(),
      queue_length: this.queue.length,
      history: (this.history || []).slice(0, 25),
      counts,
      capabilities: this.primary?.info?.capabilities || protocol.CAPABILITIES,
      protocol_version: protocol.PROTOCOL_VERSION,
      max_workers: this.poolCeiling,
      adaptive_workers: this.adaptive,
      restarts: this.restartCount,
      crashes: this.crashTimestamps.length,
      last_error: this.state.lastError || null,
      last_exit: this.lastExit,
      last_heartbeat_at: this.primary?.last_heartbeat_at || null,
      handoff: this.state.handoff || null,
      workspace_lock: this.store.loadWorkspaceLock(),
      pending_notes: this.pendingNotes.map((note) => ({ note: note.note || '', at: note.at, applied: Boolean(note.applied), delivered: Boolean(note.delivered) })),
      notifications: this.notifications.slice(-5),
      config: { ...this.config },
      live: this.liveSnapshot(),
      lives: this.liveViews(),
      events: this.events.slice(-40),
      // --- multi-worker surface (multi-sub.md) ---
      pool: this.pool.describe(),
      resources: this.resourceScheduler.describe(),
      resource_state: this.resourceScheduler.state,
      decision: decision
        ? { desired: decision.desired, direction: decision.direction, reason: decision.reason, state: decision.state }
        : null,
      limits: decision?.evaluation?.limits || null,
      hardware: this.hardwareProfile
        ? {
          tier: this.hardwareProfile.tier,
          max_recommended_workers: this.hardwareProfile.max_recommended_workers,
          physical_cpu_cores: this.hardwareProfile.physical_cpu_cores,
          logical_cpu_threads: this.hardwareProfile.logical_cpu_threads,
          ram_total_gb: this.hardwareProfile.ram_total_gb,
          storage_type: this.hardwareProfile.storage_type,
          gpu_vram_gb: this.hardwareProfile.gpu_vram_gb
        }
        : null,
      resource_config: this.resourceConfig,
      resource_config_source: this.resourceConfigSource,
      plans: planSummaries,
      dag: planSummaries[0] || null,
      integration: this.lastIntegration
        ? {
          plan_id: this.lastIntegration.plan_id,
          ok: this.lastIntegration.ok,
          conflicts: this.lastIntegration.conflicts?.length || 0,
          worktree: this.lastIntegration.worktree || null,
          summary: this.lastIntegration.summary
        }
        : null,
      file_ownership: this.registry.list(),
      metrics: this.metrics.summary(),
      scheduler: this.dispatchScheduler.describe(),
      health: this.healthVerdicts || [],
      paths: {
        state: this.store.paths.stateFile,
        queue: this.store.paths.queueFile,
        history: this.store.paths.historyFile,
        tasks: this.store.paths.tasksDir,
        task_logs: this.store.paths.taskLogsDir,
        runtime_log: this.store.paths.runtimeLog,
        hardware_profile: this.store.paths.hardwareProfileFile,
        metrics: this.store.paths.metricsFile,
        file_ownership: this.store.paths.fileOwnershipFile,
        plans: this.store.paths.plansDir,
        snapshots: this.store.paths.snapshotsDir,
        supervisor_log: this.store.paths.supervisorLog,
        scheduler_log: this.store.paths.schedulerLog,
        resource_log: this.store.paths.resourceLog,
        worker_logs: this.store.paths.workerLogsDir
      }
    }
  }

  // --------------------------------------------------------------- utilities

  killTree(pid) {
    this.pool.killTree(pid)
  }

  writeOwnership() {
    return this.pool.writeOwnership()
  }

  clearOwnership() {
    return this.pool.clearOwnership()
  }

  /** Test hook: drive the resource monitor with synthetic samples (§46). */
  setResourceInjection(fn) {
    return this.resourceMonitor.setInjection(fn)
  }

  forceStop(reason = 'shell exit') {
    this.intentionalStop = true
    this.stopTicking()
    this.pool.killAll({ reason })
    this.pool.clearOwnership()
    safeCall('forceStop', this.log, () => {
      this.releaseWorkspaceLock(reason)
      this.forceState('OFF', { pid: null, task_id: null, objective: null, stage: null })
    })
    return { ok: true }
  }

  async prepareExit() {
    const busy = this.pool.busy.length > 0
    if (busy && this.isRunning) this.pool.broadcast('pause', { reason: 'shell exit' })
    this.persistState()
    this.persistRegistry()
    this.store.saveMetrics(this.metrics.serialize())
    return { ok: true, busy }
  }
}

module.exports = {
  WorkerManager,
  WorktreeManager,
  RUNTIME_ENTRY,
  COMPAT_WORKTREE,
  NODE_STATUS,
  workerRoleFor,
  roleProfile
}
