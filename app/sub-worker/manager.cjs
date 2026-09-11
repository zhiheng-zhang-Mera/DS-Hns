'use strict'

/**
 * WorkerManager — the Controller-side owner of the optional Sub-worker
 * (plan §6, §10, §15, §16, §17, §24, §25).
 *
 * Responsibilities:
 *   - own the worker process lifecycle (spawn / stop / restart / crash recovery)
 *   - own every persisted artifact under data/sub-worker + logs
 *   - accept and queue structured tasks, enforcing maxWorkers = 1
 *   - prepare an isolated git worktree per target repository on demand
 *   - hold a single-writer workspace lock per workspace
 *   - expose user intervention: pause / resume / stop / send note / take over
 *   - guarantee failure isolation: this module never throws into the shell
 *
 * The manager has no UI and no Electron dependency, so it is fully testable in
 * plain Node and can never become a second GUI.
 */

const fs = require('node:fs')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')

const protocol = require('./protocol.cjs')
const permissions = require('./permissions.cjs')
const {
  SubWorkerStore,
  canTransition,
  DEFAULT_MAX_QUEUE
} = require('./state.cjs')
const { redactSecrets, redactEvent } = require('./event-bus.cjs')
const { Reporter } = require('./reporter.cjs')

const RUNTIME_ENTRY = path.join(__dirname, 'runtime.cjs')
const MAX_EVENTS_IN_MEMORY = 500

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

/**
 * `git worktree` automation (plan §10). The worker never edits the main working
 * tree by default: it gets its own checkout next to the target repository, at
 * `<parent>/<repo>-worktrees/hns-sub-worker`.
 */
const WorktreeManager = {
  worktreePathFor(targetRepo) {
    const resolved = path.resolve(String(targetRepo))
    const parent = path.dirname(resolved)
    const name = path.basename(resolved)
    return path.join(parent, `${name}-worktrees`, 'hns-sub-worker')
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

  /**
   * Create or reuse the worker worktree. Returns a structured outcome instead
   * of throwing, so the manager decides between isolated and shared mode.
   */
  ensure(targetRepo, log = () => {}) {
    const target = path.resolve(String(targetRepo))
    if (!fs.existsSync(target)) return { ok: false, reason: `target_repo does not exist: ${target}` }
    if (!WorktreeManager.isGitRepository(target)) return { ok: false, reason: `target_repo is not a git repository: ${target}` }

    const worktree = WorktreeManager.worktreePathFor(target)
    if (fs.existsSync(worktree)) return { ok: true, worktree, created: false }

    fs.mkdirSync(path.dirname(worktree), { recursive: true })
    const result = spawnSync('git', ['worktree', 'add', '--detach', worktree], {
      cwd: target,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 120_000
    })
    if (result.status !== 0 || !fs.existsSync(worktree)) {
      const detail = redactSecrets(String(result.stderr || result.stdout || '').trim()).slice(0, 400)
      log(`[sub-worker] worktree creation failed for ${target}: ${detail}`)
      return { ok: false, reason: `git worktree add failed: ${detail || `exit ${result.status}`}` }
    }
    return { ok: true, worktree, created: true }
  },

  /** Best-effort removal; only an explicit controller action calls this. */
  remove(targetRepo) {
    const worktree = WorktreeManager.worktreePathFor(targetRepo)
    if (!fs.existsSync(worktree)) return { ok: true, removed: false }
    const result = spawnSync('git', ['worktree', 'remove', '--force', worktree], {
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
    maxWorkers = 1
  } = {}) {
    this.root = path.resolve(root || process.env.DSH_ROOT || path.join(__dirname, '..', '..'))
    this.nodeExe = nodeExe
    this.runtimeEntry = runtimeEntry
    // Generalized ownership helper owner (app/runtime-process.cjs). Injected so
    // this module never requires the shell.
    this.runtimeProcess = runtimeProcess
    this.log = log
    this.notify = notify
    // Phase 1 is single-worker by contract (plan §6/§31); the API already speaks
    // worker_id so Phase 3 can raise this without a protocol change.
    this.maxWorkers = Math.max(1, Math.min(1, Number(maxWorkers) || 1))
    this.store = new SubWorkerStore({ root: this.root, log })
    this.config = this.store.loadConfig()
    this.state = this.store.loadState()
    this.queue = []
    this.history = []
    this.child = null
    this.decoder = null
    this.events = []
    this.liveReporter = null
    this.liveMeta = null
    this.liveResult = null
    this.liveFinishedAt = null
    this.workerLiveView = null
    this.pendingNotes = []
    this.currentTask = null
    this.workerId = 'sub-1'
    this.workerInfo = null
    this.restartCount = 0
    this.crashTimestamps = []
    this.lastExit = null
    this.lastHeartbeatAt = null
    this.intentionalStop = false
    this.notifications = []
    // `activated` gates every write under data/sub-worker: while the feature was
    // never enabled, the manager is completely inert on disk (AC-01).
    this.activated = false
  }

  // ---------------------------------------------------------------- lifecycle

  /** Load persisted state without spawning anything (startup recovery, AC-11). */
  hydrate() {
    this.config = this.store.loadConfig()
    this.state = this.store.loadState()
    this.queue = this.store.loadQueue()
    this.history = this.store.loadHistory()
    // A state file already on disk means the feature has been used before, so
    // correcting it is legitimate persistence rather than a new trace.
    this.activated = fs.existsSync(this.store.paths.stateFile)
    if (this.state.state !== 'OFF' && this.state.state !== 'HANDOFF' && !this.isRunning) {
      // A previous shell exited while a worker was still recorded as live.
      // Nothing can own it now (single-instance lock + orphan recovery), so the
      // record describes an interrupted run and is reported honestly.
      this.state = {
        ...this.state,
        state: this.state.state === 'STOPPING' ? 'OFF' : 'CRASHED',
        pid: null,
        lastError: this.state.lastError || 'worker was not running when the shell restarted',
        updatedAt: new Date().toISOString()
      }
      this.persistState()
    }
    return this.describe()
  }

  persistState() {
    if (!this.activated) return null
    return this.store.saveState({ ...this.state, updatedAt: new Date().toISOString() })
  }

  /**
   * Flip the manager from inert to persistent. Called when the user enables the
   * worker, and when something genuinely auditable happens (a refused task).
   */
  activate() {
    this.activated = true
    return this.activated
  }

  /** Legal transition only; an illegal attempt is logged and ignored. */
  setState(next, patch = {}) {
    const from = this.state.state
    if (from === next && !Object.keys(patch).length) return next
    if (!canTransition(from, next)) {
      this.log(`[sub-worker] refusing illegal transition ${from} -> ${next}`)
      return from
    }
    return this.applyState(next, patch, from)
  }

  /**
   * Reconciliation transition, used when reality (a dead or reaped process)
   * already decided the outcome and only the recorded state must follow.
   */
  forceState(next, patch = {}) {
    return this.applyState(next, patch, this.state.state)
  }

  applyState(next, patch, from) {
    this.state = { ...this.state, ...patch, state: next, updatedAt: new Date().toISOString() }
    this.persistState()
    this.pushRuntimeEvent({
      type: 'state_changed',
      task_id: this.state.task_id,
      summary: `Worker state ${from} -> ${next}`,
      from,
      to: next
    })
    this.notify()
    return next
  }

  get isRunning() {
    return Boolean(this.child && this.child.exitCode === null && !this.child.killed)
  }

  updateConfig(patch = {}) {
    this.config = this.store.saveConfig({ ...this.config, ...patch })
    this.notify()
    return this.config
  }

  /** Enable = the only path that spawns a worker process (plan §3.2, AC-02). */
  async start({ reason = 'manual' } = {}) {
    if (this.isRunning) return { ok: true, already: true, state: this.state.state }
    // From here on the feature is in use, so persistence is allowed.
    this.activate()
    this.store.ensureDirs()
    this.setState('STARTING', { pid: null, lastError: null })
    this.intentionalStop = false

    const args = [this.runtimeEntry, '--root', this.root, '--worker-id', this.workerId]
    let child
    try {
      child = spawn(this.nodeExe, args, {
        cwd: this.root,
        env: {
          ...process.env,
          DSH_ROOT: this.root,
          DSH_SUB_WORKER: '1',
          DSH_SUB_WORKER_ID: this.workerId,
          DSH_NODE: this.nodeExe
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      })
    } catch (error) {
      const message = `could not spawn the sub-worker runtime: ${error?.message || error}`
      this.log(`[sub-worker] ${message}`)
      this.forceState('FAILED', { lastError: message })
      return { ok: false, error: message }
    }

    this.child = child
    this.decoder = new protocol.LineDecoder()
    this.forceState('IDLE', { pid: child.pid, startedAt: new Date().toISOString() })
    this.log(`[sub-worker] worker ${this.workerId} started pid=${child.pid} reason=${reason}`)
    this.writeOwnership()

    child.stdout.on('data', (chunk) => this.consume(chunk))
    child.stderr.on('data', (chunk) => this.log(`[sub-worker:stderr] ${redactSecrets(chunk.toString()).trim()}`))
    // A worker that dies mid-write surfaces EPIPE asynchronously. Without these
    // listeners that becomes an unhandled stream error in the host process,
    // which is exactly the failure isolation this layer must never break.
    child.stdin.on('error', (error) => this.log(`[sub-worker] worker stdin closed: ${error?.message || error}`))
    child.stdout.on('error', (error) => this.log(`[sub-worker] worker stdout error: ${error?.message || error}`))
    child.stderr.on('error', (error) => this.log(`[sub-worker] worker stderr error: ${error?.message || error}`))
    child.once('error', (error) => {
      this.log(`[sub-worker] worker process error: ${error?.message || error}`)
      this.handleExit(-1, null, { error: String(error?.message || error) })
    })
    child.once('exit', (code, signal) => this.handleExit(code, signal))

    this.sendControllerMessage('hello', { root: this.root, controller: 'ds-hns' })
    this.drainQueue()
    return { ok: true, pid: child.pid, state: this.state.state }
  }

  /** Stop = pause, flush, terminate the process tree, persist history (§25). */
  async stop({ reason = 'user stop', timeoutMs = 5000 } = {}) {
    this.intentionalStop = true
    const child = this.child
    if (!child || child.exitCode !== null) {
      this.finalizeStop(reason)
      return { ok: true, already: true }
    }

    this.setState('STOPPING')
    this.sendControllerMessage('shutdown', { reason })
    if (this.currentTask) this.sendControllerMessage('stop_task', { reason })

    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.killTree(child.pid)
        resolve()
      }, Math.max(250, Number(timeoutMs) || 5000))
      if (typeof timer.unref === 'function') timer.unref()
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    this.killTree(child.pid)
    this.finalizeStop(reason)
    return { ok: true }
  }

  finalizeStop(reason) {
    const pid = this.child?.pid
    this.child = null
    this.decoder = null
    if (pid) this.killTree(pid)
    this.clearOwnership()
    this.releaseWorkspaceLock(reason)
    if (this.currentTask) {
      this.recordTerminal(this.currentTask, protocol.createResult(this.currentTask.task_id, {
        status: 'cancelled',
        summary: `worker stopped by the Controller (${reason})`,
        code: protocol.RESULT_CODES.CANCELLED,
        reason,
        needs_controller_review: false,
        needs_controller_decision: true
      }))
      this.currentTask = null
    }
    this.forceState('OFF', { pid: null, task_id: null, objective: null, stage: null })
    this.log(`[sub-worker] worker stopped (${reason})`)
    this.notify()
  }

  async restart(options = {}) {
    await this.stop({ reason: options.reason || 'restart' })
    this.restartCount += 1
    const result = await this.start({ reason: options.reason || 'restart' })
    return { ...result, restarts: this.restartCount }
  }

  /**
   * Crash detection + isolation (plan §24, AC-09). A worker that dies is
   * recorded as CRASHED; the Harness keeps running and the user is offered a
   * restart, an inspection of the log or a workspace takeover.
   */
  handleExit(code, signal, extra = {}) {
    if (!this.child) return
    this.child = null
    this.decoder = null
    this.lastExit = { code, signal, at: new Date().toISOString(), ...extra }
    this.clearOwnership()
    this.releaseWorkspaceLock('worker exited')
    this.log(`[sub-worker] worker exit code=${code} signal=${signal || ''} intentional=${this.intentionalStop}`)

    const failedTask = this.currentTask
    if (failedTask) {
      this.recordTerminal(failedTask, protocol.createResult(failedTask.task_id, {
        status: 'failed',
        summary: `worker crashed while executing the task (exit ${code}${signal ? `, signal ${signal}` : ''})`,
        code: protocol.RESULT_CODES.CRASHED,
        reason: `worker process exited unexpectedly: code=${code} signal=${signal || 'none'}`,
        needs_controller_review: true,
        needs_controller_decision: true
      }))
      this.currentTask = null
    }

    if (this.intentionalStop || ['STOPPING', 'OFF', 'HANDOFF'].includes(this.state.state)) {
      if (this.state.state !== 'HANDOFF') this.forceState('OFF', { pid: null })
      return
    }

    this.crashTimestamps.push(Date.now())
    this.forceState('CRASHED', {
      pid: null,
      stage: null,
      lastError: `worker process exited unexpectedly (code ${code}${signal ? `, signal ${signal}` : ''})`
    })
    this.pushNotification({
      kind: 'crash',
      title: 'Sub-worker crashed',
      body: `Last task: ${failedTask?.task_id || 'none'}`,
      task_id: failedTask?.task_id || null
    })
  }

  // ------------------------------------------------------------ message layer

  sendControllerMessage(type, payload = {}, extra = {}) {
    if (!this.child || this.child.exitCode !== null) return false
    const validation = protocol.validateMessage({ v: protocol.PROTOCOL_VERSION, type, payload }, 'controller-to-worker')
    if (!validation.ok) {
      this.log(`[sub-worker] refusing to send invalid message: ${validation.error}`)
      return false
    }
    try {
      this.child.stdin.write(protocol.encode(protocol.envelope(type, payload, extra)))
      return true
    } catch (error) {
      this.log(`[sub-worker] failed to write ${type}: ${error?.message || error}`)
      return false
    }
  }

  consume(chunk) {
    if (!this.decoder) this.decoder = new protocol.LineDecoder()
    const messages = this.decoder.push(chunk)
    for (const error of this.decoder.errors.splice(0)) this.log(`[sub-worker] protocol: ${error}`)
    for (const message of messages) {
      const validation = protocol.validateMessage(message, 'worker-to-controller')
      if (!validation.ok) {
        this.log(`[sub-worker] protocol: ${validation.error}`)
        continue
      }
      safeCall('worker message', this.log, () => this.handleWorkerMessage(message))
    }
  }

  handleWorkerMessage(message) {
    const payload = message.payload || {}
    switch (message.type) {
      case 'ready':
        this.workerInfo = {
          worker_id: payload.worker_id || this.workerId,
          pid: payload.pid || this.child?.pid || null,
          capabilities: payload.capabilities || protocol.CAPABILITIES,
          protocol: payload.protocol || protocol.PROTOCOL_VERSION
        }
        this.pushRuntimeEvent({ type: 'state_changed', summary: `Worker ${this.workerInfo.worker_id} ready (pid ${this.workerInfo.pid})` })
        break
      case 'state':
        this.applyWorkerState(payload)
        break
      case 'stage':
        this.state = { ...this.state, stage: payload.stage || null, updatedAt: new Date().toISOString() }
        this.persistState()
        this.notify()
        break
      case 'event': {
        const workerEvent = payload.event || {}
        // The worker's own boundary event is the authoritative confirmation that
        // a Note was actually injected into a running task.
        if (workerEvent.type === 'note_applied') this.markNotesApplied()
        this.pushRuntimeEvent(workerEvent)
        break
      }
      case 'log':
        this.log(`[sub-worker:${payload.level || 'info'}] ${payload.message}`)
        break
      case 'note_applied':
        // `applied: false` is an acknowledgement only (the note is queued for the
        // next task); the note stays pending until the worker reports that it
        // really took effect at an execution boundary.
        if (payload.applied !== false) this.markNotesApplied()
        this.pushRuntimeEvent({
          type: 'note_applied',
          summary: payload.summary || payload.note || 'note queued',
          applied: payload.applied !== false,
          effects: payload.effects
        })
        break
      case 'heartbeat':
        this.lastHeartbeatAt = Date.now()
        break
      case 'pong':
        break
      case 'error':
        this.pushRuntimeEvent({
          type: 'error',
          task_id: payload.task_id || this.state.task_id,
          summary: payload.message || 'worker error',
          code: payload.code || null
        })
        if (payload.code === protocol.RESULT_CODES.CRASHED) {
          this.forceState('CRASHED', { lastError: payload.message || 'worker crashed' })
        }
        break
      case 'result':
        this.handleResult(payload.result, payload.live_view)
        break
      case 'bye':
        this.pushRuntimeEvent({ type: 'state_changed', summary: `Worker said goodbye (${payload.reason || 'shutdown'})` })
        break
      default:
        break
    }
  }

  applyWorkerState(payload) {
    const next = String(payload.state || '').toUpperCase()
    if (!next) return
    // A worker state message is a lifecycle fact, not a task fact: it must never
    // clear the task the Controller just dispatched (the result message is what
    // ends a task).
    const terminalForTask = ['IDLE', 'READY_FOR_REVIEW', 'FAILED', 'BLOCKED'].includes(next)
    if (this.currentTask && terminalForTask) {
      if (payload.stage !== undefined) this.state.stage = payload.stage || null
      return
    }
    if (payload.stage !== undefined) this.state.stage = payload.stage || null
    if (payload.task_id !== undefined && !this.currentTask) this.state.task_id = payload.task_id || null
    const patch = {}
    if (payload.handoff) patch.handoff = payload.handoff
    if (next === this.state.state) {
      this.state = { ...this.state, ...patch }
      this.persistState()
      return
    }
    if (!canTransition(this.state.state, next)) {
      this.log(`[sub-worker] ignoring worker-reported transition ${this.state.state} -> ${next}`)
      return
    }
    this.applyState(next, patch, this.state.state)
  }

  handleResult(result, liveView) {
    if (!result || typeof result !== 'object') return
    // The worker's own final projection is authoritative for the finished task;
    // it also makes `live.result` available to the Result pane (AC-05).
    if (liveView) {
      this.workerLiveView = { ...liveView }
    }
    const task = this.currentTask
    this.recordTerminal(task || { task_id: result.task_id }, result)
    this.currentTask = null
    this.liveResult = result
    this.liveFinishedAt = result.finished_at || new Date().toISOString()
    this.releaseWorkspaceLock('task finished')
    this.markNotesApplied()
    this.state = {
      ...this.state,
      task_id: null,
      objective: null,
      stage: null,
      lastResult: result,
      updatedAt: new Date().toISOString()
    }

    if (['blocked', 'rejected', 'unsupported_capability'].includes(result.status)) {
      if (canTransition(this.state.state, 'BLOCKED')) this.state.state = 'BLOCKED'
    } else if (result.status === 'cancelled' || result.status === 'handoff') {
      if (canTransition(this.state.state, 'IDLE')) this.state.state = 'IDLE'
    } else if (result.status === 'completed') {
      if (canTransition(this.state.state, 'READY_FOR_REVIEW')) this.state.state = 'READY_FOR_REVIEW'
    } else if (canTransition(this.state.state, 'FAILED')) {
      this.state.state = 'FAILED'
    }
    // Safety net: a worker that just returned a result is alive and idle, so a
    // state that cannot accept the next dispatch (a leftover STOPPING/PAUSING
    // from a mid-flight user action) is reconciled instead of stalling the queue.
    if (!['IDLE', 'READY_FOR_REVIEW', 'FAILED', 'BLOCKED'].includes(this.state.state) && this.isRunning) {
      this.state.state = 'IDLE'
    }
    this.persistState()
    this.notify()

    if (this.config.showNotifications) {
      this.pushNotification({
        kind: `task_${result.status}`,
        title: `Sub-worker task ${result.status}`,
        body: `${result.task_id}: ${result.summary || result.reason || ''}`.slice(0, 200),
        task_id: result.task_id
      })
    }
    this.drainQueue()
  }

  pushRuntimeEvent(event) {
    const entry = {
      timestamp: event.timestamp || new Date().toISOString(),
      task_id: event.task_id === undefined ? (this.state.task_id ?? null) : event.task_id,
      ...event
    }
    redactEvent(entry)
    // The Live View is a projection of the same event stream the worker logs,
    // so it is built by the same Reporter implementation instead of a second,
    // drifting one. Without this the panel would only update at task end, which
    // is useless for a live view (plan §12/§13, AC-04/AC-05).
    if (this.liveReporter) {
      try {
        this.liveReporter.record(entry)
      } catch (error) {
        this.log(`[sub-worker] live view projection failed: ${error?.message || error}`)
      }
    }
    this.events.push(entry)
    if (this.events.length > MAX_EVENTS_IN_MEMORY) this.events.splice(0, this.events.length - MAX_EVENTS_IN_MEMORY)
    this.notify(entry)
    return entry
  }

  markNotesApplied() {
    this.pendingNotes = this.pendingNotes.map((note) => (note.applied ? note : { ...note, applied: true, appliedAt: new Date().toISOString() }))
    return this.pendingNotes
  }

  pushNotification(notification) {
    const entry = { ...notification, at: new Date().toISOString() }
    this.notifications.push(entry)
    if (this.notifications.length > 50) this.notifications.splice(0, this.notifications.length - 50)
    this.notify({ type: 'notification', notification: entry })
    return entry
  }

  // -------------------------------------------------------------- task queue

  /**
   * Validate, admit and (when the worker is idle) dispatch one task.
   * Returns the admission outcome; the execution result arrives later through
   * the worker's Result message.
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

    if (this.queue.length >= DEFAULT_MAX_QUEUE) {
      return { ok: false, accepted: false, reason: 'the sub-worker task queue is full', code: protocol.RESULT_CODES.BLOCKED }
    }

    this.queue.push({
      task,
      source,
      accepted_at: new Date().toISOString(),
      status: 'QUEUED'
    })
    this.persistQueue()
    this.pushRuntimeEvent({
      type: 'task_received',
      task_id: task.task_id,
      summary: `Task accepted: ${task.objective}`,
      objective: task.objective,
      risk_level: task.risk_level,
      source
    })
    // Auto-delegated work travels the same path, just without a click.
    this.drainQueue()
    return { ok: true, accepted: true, queued: true, task_id: task.task_id, queue_length: this.queue.length }
  }

  persistQueue() {
    if (!this.activated) return null
    return this.store.saveQueue(this.queue.map((entry) => ({
      task_id: entry.task.task_id,
      objective: entry.task.objective,
      risk_level: entry.task.risk_level,
      target_repo: entry.task.target_repo,
      workspace_mode: entry.task.workspace_mode,
      source: entry.source,
      accepted_at: entry.accepted_at,
      status: entry.status
    })))
  }

  /** Structured refusal: an L3/L4 or capability-mismatched task (§9, §23, AC-08). */
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
    this.recordTerminal({ task_id: task.task_id, task }, result)
    this.pushRuntimeEvent({
      type: 'blocked',
      task_id: task.task_id,
      summary: guard.reason,
      reason: guard.reason,
      code: guard.code
    })
    return result
  }

  /** Dispatch the head of the queue when the worker is idle (maxWorkers = 1). */
  drainQueue() {
    if (!this.isRunning || this.currentTask || !this.queue.length) return null
    if (!['IDLE', 'READY_FOR_REVIEW', 'FAILED', 'BLOCKED'].includes(this.state.state)) return null

    const entry = this.queue.shift()
    const task = entry.task
    this.persistQueue()

    const prepared = this.prepareWorkspace(task)
    if (!prepared.ok) {
      const result = protocol.createResult(task.task_id, {
        status: 'blocked',
        summary: prepared.reason,
        code: prepared.code || protocol.RESULT_CODES.WORKSPACE_LOCKED,
        reason: prepared.reason,
        needs_controller_review: true,
        needs_controller_decision: true
      })
      this.recordTerminal({ task_id: task.task_id, task }, result)
      this.forceState('BLOCKED', { lastError: prepared.reason })
      this.pushRuntimeEvent({ type: 'blocked', task_id: task.task_id, summary: prepared.reason, reason: prepared.reason })
      return null
    }

    const dispatched = { ...task, workspace: prepared.workspace }
    this.currentTask = dispatched
    this.pendingNotes = this.pendingNotes.filter((note) => !note.applied)
    // Live View state for the task that is starting now: a Reporter fed by the
    // event stream, plus the metadata only the Controller knows.
    this.liveReporter = new Reporter({ root: this.root, taskId: dispatched.task_id })
    this.liveResult = null
    this.liveMeta = {
      task_id: dispatched.task_id,
      objective: dispatched.objective,
      workspace: prepared.workspace,
      workspace_mode: prepared.mode,
      started_at: new Date().toISOString()
    }
    // Durable dispatch record: it is what makes crash resume possible (§30).
    this.store.saveTaskRecord(dispatched.task_id, {
      task_id: dispatched.task_id,
      task: dispatched,
      workspace: prepared.workspace,
      workspace_mode: prepared.mode,
      status: 'dispatched',
      dispatched_at: new Date().toISOString(),
      objective: dispatched.objective,
      risk_level: dispatched.risk_level,
      target_repo: dispatched.target_repo
    })

    this.forceState('ASSIGNED', { task_id: dispatched.task_id, objective: dispatched.objective })
    this.pushRuntimeEvent({
      type: 'task_started',
      task_id: dispatched.task_id,
      summary: `Dispatching ${dispatched.task_id} to worker ${this.workerId}`,
      workspace: prepared.workspace
    })
    const sent = this.sendControllerMessage('assign_task', { task: dispatched }, { task_id: dispatched.task_id })
    if (sent) {
      // Notes queued while the worker was idle are injected at the first
      // execution boundary of this task.
      for (const note of this.pendingNotes) {
        const payload = { note: note.note }
        if (note.forbid) payload.forbid = note.forbid
        if (note.allow) payload.allow = note.allow
        note.delivered = this.sendControllerMessage('note', payload)
      }
    } else {
      const result = protocol.createResult(dispatched.task_id, {
        status: 'failed',
        summary: 'the worker runtime is not reachable',
        code: protocol.RESULT_CODES.CRASHED,
        reason: 'worker runtime is not reachable'
      })
      this.recordTerminal({ task_id: dispatched.task_id, task: dispatched }, result)
      this.currentTask = null
      this.forceState('CRASHED', { lastError: result.reason })
    }
    return entry
  }

  /**
   * Resolve the workspace for a task: an isolated worktree when the target repo
   * is a git repository, an explicit `workspace` otherwise (plan §10, AC-12).
   */
  prepareWorkspace(task) {
    const existing = this.store.loadWorkspaceLock()
    if (existing && existing.task_id && existing.task_id !== task.task_id && this.isRunning) {
      return {
        ok: false,
        code: protocol.RESULT_CODES.WORKSPACE_LOCKED,
        reason: `workspace ${existing.workspace} is locked by task ${existing.task_id}`
      }
    }
    if (existing && existing.task_id !== task.task_id) this.store.clearWorkspaceLock()

    const lock = (workspace, mode) => {
      this.store.saveWorkspaceLock({
        task_id: task.task_id,
        workspace,
        mode,
        pid: this.child?.pid || null,
        at: new Date().toISOString()
      })
      return { ok: true, workspace, mode }
    }

    if (task.workspace_mode === 'isolated_worktree' && task.target_repo) {
      const result = WorktreeManager.ensure(task.target_repo, this.log)
      if (result.ok) return { ...lock(result.worktree, 'isolated_worktree'), created: result.created }
      // Falling back to the shared workspace is a Controller decision, not a
      // silent default: without an explicit workspace the task is blocked.
      if (!task.workspace) {
        return { ok: false, code: protocol.RESULT_CODES.BLOCKED, reason: result.reason }
      }
    }

    if (task.workspace) {
      const resolved = path.resolve(String(task.workspace))
      fs.mkdirSync(resolved, { recursive: true })
      return lock(resolved, 'shared')
    }

    const fallback = path.join(this.root, 'workspace', 'sub-worker', task.task_id)
    fs.mkdirSync(fallback, { recursive: true })
    return lock(fallback, 'shared')
  }

  releaseWorkspaceLock(reason = '') {
    const lock = this.store.loadWorkspaceLock()
    this.store.clearWorkspaceLock()
    if (lock) this.pushRuntimeEvent({ type: 'diff_generated', summary: `Workspace lock released (${reason})` })
    return lock
  }

  recordTerminal(taskLike, result) {
    const taskId = result?.task_id || taskLike?.task_id
    // A terminal task outcome is a real audit artifact, so it activates
    // persistence even for a task that never reached the worker (a refusal).
    this.activate()
    const entry = {
      task_id: taskId,
      status: result?.status || 'failed',
      objective: taskLike?.task?.objective || taskLike?.objective || this.state.objective || null,
      risk_level: taskLike?.task?.risk_level || taskLike?.risk_level || null,
      target_repo: taskLike?.task?.target_repo || taskLike?.target_repo || null,
      workspace: result?.workspace || taskLike?.task?.workspace || taskLike?.workspace || null,
      summary: result?.summary || '',
      code: result?.code || null,
      changed_files: Array.isArray(result?.changed_files) ? result.changed_files : [],
      tests: result?.tests || { passed: 0, failed: 0, skipped: 0 },
      finished_at: result?.finished_at || new Date().toISOString(),
      needs_controller_review: result?.needs_controller_review !== false
    }
    this.history = this.store.appendHistory(entry)
    const existing = this.store.loadTaskRecord(taskId) || {}
    this.store.saveTaskRecord(taskId, {
      ...existing,
      ...entry,
      task: existing.task || taskLike?.task || null,
      result,
      // Task-boundary checkpoint (plan §22): the Controller hand-off point. A
      // Controller change (for example an external Codex becoming available
      // again) may only take effect here - never in the middle of a task.
      checkpoint: {
        task_id: taskId,
        status: entry.status,
        code: entry.code,
        workspace: entry.workspace,
        changed_files: entry.changed_files,
        tests: entry.tests,
        worker_id: this.workerId,
        at: entry.finished_at,
        boundary: 'task_end',
        next: entry.needs_controller_review ? 'controller_review' : 'next_task'
      },
      events: this.events.filter((event) => event.task_id === taskId).slice(-300),
      savedAt: Date.now()
    })
    return entry
  }

  // ------------------------------------------------------ user intervention

  pause(reason = 'paused by user') {
    if (!this.isRunning) return { ok: false, reason: 'worker is not running' }
    this.sendControllerMessage('pause', { reason })
    return { ok: true, state: 'PAUSING' }
  }

  resume(reason = 'resumed by user') {
    if (!this.isRunning) return { ok: false, reason: 'worker is not running' }
    this.sendControllerMessage('resume', { reason })
    return { ok: true }
  }

  /**
   * Cancel the current task but keep the worker process alive: "cancel task,
   * terminate child command, persist result, roll back temporary runtime state"
   * (plan §15 Stop). The workspace itself is left as the configuration says.
   */
  cancelTask(reason = 'cancelled by controller') {
    if (!this.isRunning) return { ok: false, reason: 'worker is not running' }
    if (!this.currentTask) return { ok: false, reason: 'no task is running' }
    this.sendControllerMessage('stop_task', { reason })
    this.pushRuntimeEvent({
      type: 'warning',
      task_id: this.currentTask.task_id,
      summary: `Cancellation requested: ${reason}`
    })
    return { ok: true, task_id: this.currentTask.task_id, reason }
  }

  /** Send Note: injected at the worker's next execution boundary (§15, AC-06). */
  sendNote(note) {
    const payload = typeof note === 'string' ? { note } : { ...(note || {}) }
    if (!payload.note && !payload.forbid && !payload.allow) {
      return { ok: false, reason: 'a note must contain text or explicit constraints' }
    }
    const entry = { ...payload, at: new Date().toISOString(), applied: false, delivered: false }
    this.pendingNotes.push(entry)
    if (this.isRunning) entry.delivered = this.sendControllerMessage('note', payload)
    this.pushRuntimeEvent({
      type: 'note_applied',
      task_id: this.state.task_id,
      summary: `Note queued: ${String(payload.note || '').slice(0, 200)}`,
      delivered: entry.delivered
    })
    return { ok: true, queued: true, delivered: entry.delivered, notes: this.pendingNotes.length }
  }

  /**
   * Take Over (plan §15, AC-06): pause, persist, release the workspace lock and
   * end the worker process so nothing else holds the workspace.
   */
  async takeOver({ reason = 'user take over' } = {}) {
    const lock = this.store.loadWorkspaceLock()
    const captured = {
      task_id: this.state.task_id,
      objective: this.state.objective,
      workspace: lock?.workspace || this.currentTask?.workspace || null,
      workspace_lock: lock || null,
      changed_files: (this.liveSnapshot()?.changed_files || []).map((entry) => ({ ...entry })),
      live_view: this.liveSnapshot(),
      events: this.events.slice(-40),
      at: new Date().toISOString(),
      reason
    }
    if (this.isRunning) {
      this.sendControllerMessage('take_over', { reason })
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    this.intentionalStop = true
    if (this.currentTask) {
      this.recordTerminal(this.currentTask, protocol.createResult(this.currentTask.task_id, {
        status: 'handoff',
        summary: `workspace handed to the Controller (${reason})`,
        code: protocol.RESULT_CODES.BLOCKED,
        reason,
        needs_controller_review: false
      }))
      this.currentTask = null
    }
    const child = this.child
    if (child) {
      if (child.exitCode === null) this.killTree(child.pid)
      this.child = null
      this.decoder = null
    }
    this.clearOwnership()
    this.store.clearWorkspaceLock()
    this.forceState('HANDOFF', {
      pid: null,
      task_id: null,
      objective: null,
      stage: null,
      handoff: captured
    })
    this.store.saveTaskRecord('handoff', { kind: 'handoff', ...captured, savedAt: Date.now() })
    this.pushRuntimeEvent({ type: 'diff_generated', summary: `Workspace handed over: ${captured.workspace || 'n/a'}` })
    this.notify()
    return { ok: true, state: 'HANDOFF', handoff: captured }
  }

  /** Release a handoff so the worker may be started again. */
  clearHandoff() {
    if (this.state.state !== 'HANDOFF') return { ok: false, reason: 'no handoff in progress' }
    this.forceState('OFF', { handoff: null })
    this.notify()
    return { ok: true, state: 'OFF' }
  }

  /**
   * Release the isolated worktree of a target repository (plan §10).
   *
   * The worktree is the deliverable a Controller reviews, so it is never removed
   * automatically; this is the explicit Controller action that cleans it up.
   */
  releaseWorktree(targetRepo) {
    const target = String(targetRepo || '').trim()
    if (!target) return { ok: false, reason: 'target_repo is required' }
    if (this.state.task_id) {
      return { ok: false, reason: `cannot release a worktree while task ${this.state.task_id} is running` }
    }
    const result = WorktreeManager.remove(target)
    this.pushRuntimeEvent({
      type: 'diff_generated',
      summary: result.removed
        ? `Worktree released for ${target}${result.ok ? '' : ` (${result.detail || 'failed'})`}`
        : `No worktree to release for ${target}`
    })
    this.notify()
    return { ...result, target_repo: target, worktree: WorktreeManager.worktreePathFor(target) }
  }

  /** Resume the last interrupted task with a fresh worker (crash resume, §30). */
  async resumeLastTask() {
    const record = (this.history || []).find((entry) => ['failed', 'cancelled', 'handoff'].includes(entry.status))
    const stored = record?.task_id ? this.store.loadTaskRecord(record.task_id) : null
    const task = stored?.task || null
    if (!task) return { ok: false, reason: 'no interrupted task with a replayable specification was found' }
    if (!this.isRunning) await this.start({ reason: 'crash resume' })
    return this.assignTask(task, { source: 'crash-resume', explicit: true })
  }

  // ------------------------------------------------------------------ queries

  describe() {
    const running = this.isRunning
    const counts = (this.history || []).reduce((acc, entry) => {
      acc[entry.status] = (acc[entry.status] || 0) + 1
      return acc
    }, {})
    return {
      feature: 'optional-sub-worker',
      available: true,
      enabled: running,
      state: this.state.state,
      stage: this.state.stage || null,
      worker_id: this.workerId,
      pid: this.state.pid || null,
      mode: 'Executor',
      role: 'executor-not-controller',
      task: this.state.task_id
        ? { task_id: this.state.task_id, objective: this.state.objective, stage: this.state.stage || null }
        : null,
      task_id: this.state.task_id || null,
      objective: this.state.objective || null,
      queue: this.queue.map((entry) => ({
        task_id: entry.task.task_id,
        objective: entry.task.objective,
        risk_level: entry.task.risk_level,
        target_repo: entry.task.target_repo,
        source: entry.source,
        accepted_at: entry.accepted_at
      })),
      queue_length: this.queue.length,
      history: (this.history || []).slice(0, 25),
      counts,
      capabilities: this.workerInfo?.capabilities || protocol.CAPABILITIES,
      protocol_version: protocol.PROTOCOL_VERSION,
      max_workers: this.maxWorkers,
      restarts: this.restartCount,
      crashes: this.crashTimestamps.length,
      last_error: this.state.lastError || null,
      last_exit: this.lastExit,
      last_heartbeat_at: this.lastHeartbeatAt,
      handoff: this.state.handoff || null,
      workspace_lock: this.store.loadWorkspaceLock(),
      pending_notes: this.pendingNotes.map((note) => ({ note: note.note || '', at: note.at, applied: Boolean(note.applied) })),
      notifications: this.notifications.slice(-5),
      config: { ...this.config },
      live: this.liveSnapshot(),
      events: this.events.slice(-40),
      paths: {
        state: this.store.paths.stateFile,
        queue: this.store.paths.queueFile,
        history: this.store.paths.historyFile,
        tasks: this.store.paths.tasksDir,
        task_logs: this.store.paths.taskLogsDir,
        runtime_log: this.store.paths.runtimeLog
      }
    }
  }

  /**
   * Live View payload for the current task (plan §12, AC-04, AC-05).
   *
   * It is derived on demand from the event-stream projection, so every field the
   * panel and the Live View show is live rather than a snapshot taken at
   * dispatch time.
   */
  liveSnapshot() {
    if (!this.liveMeta || !this.liveReporter) return null
    const projected = this.liveReporter.describe()
    const worker = this.workerLiveView && this.workerLiveView.task_id === this.liveMeta.task_id ? this.workerLiveView : null
    const live = {
      ...(worker || projected),
      ...this.liveMeta,
      status: this.liveResult ? this.liveResult.status : (this.state.task_id === this.liveMeta.task_id ? this.state.state : 'IDLE'),
      stage: this.state.stage || projected.stage || null,
      finished_at: this.liveFinishedAt,
      // AC-05: the Result section must show the finished task's result object.
      result: this.liveResult || null
    }
    // Prefer whichever projection is richer (a task that ends too fast for a
    // worker-side final view still has all of its events here).
    if (projected.summary.length > (live.summary || []).length) live.summary = projected.summary
    if (!(live.terminal || []).length) live.terminal = projected.terminal
    if (!(live.changed_files || []).length) live.changed_files = projected.changed_files
    if (!live.tests?.parser) live.tests = projected.tests
    return live
  }

  /** Live View payload for one task (plan §12). */
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

  readTaskLog(taskId) {
    const file = path.join(this.store.paths.taskLogsDir, `${protocol.sanitizeTaskId(taskId)}.log`)
    try {
      const text = fs.readFileSync(file, 'utf8')
      return { ok: true, file, text: redactSecrets(text.split(/\r?\n/).slice(-400).join('\n')) }
    } catch (error) {
      return { ok: false, file, reason: String(error?.message || error), text: '' }
    }
  }

  // --------------------------------------------------------------- utilities

  killTree(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return
    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill.exe', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 15000 })
      } else {
        process.kill(pid, 'SIGKILL')
      }
    } catch {
      // An already dead process tree needs no cleanup.
    }
  }

  /** Ownership record so a later shell can reclaim an orphaned worker (§28, AC-10). */
  writeOwnership() {
    if (!this.runtimeProcess || !this.child?.pid) return false
    return safeCall('ownership write', this.log, () => this.runtimeProcess.writeOwnership({
      root: this.root,
      type: 'sub-worker',
      pid: this.child.pid,
      parentPid: process.pid,
      entry: this.runtimeEntry,
      workerId: this.workerId
    }), false)
  }

  clearOwnership() {
    if (!this.runtimeProcess) return false
    return safeCall('ownership clear', this.log, () => this.runtimeProcess.clearOwnership({
      root: this.root,
      type: 'sub-worker'
    }), false)
  }

  /** Idempotent global teardown used by every host exit path (§25, AC-10). */
  forceStop(reason = 'shell exit') {
    this.intentionalStop = true
    const child = this.child
    if (child) {
      if (child.exitCode === null) this.killTree(child.pid)
      this.child = null
      this.decoder = null
    }
    this.clearOwnership()
    safeCall('forceStop', this.log, () => {
      this.releaseWorkspaceLock(reason)
      this.forceState('OFF', { pid: null, task_id: null, objective: null, stage: null })
    })
    return { ok: true }
  }

  /** Pause + flush for the graceful exit sequence (plan §25). */
  async prepareExit() {
    const busy = this.isRunning && Boolean(this.currentTask)
    if (busy) this.sendControllerMessage('pause', { reason: 'shell exit' })
    this.persistState()
    this.persistQueue()
    return { ok: true, busy }
  }
}

module.exports = {
  WorkerManager,
  WorktreeManager,
  RUNTIME_ENTRY
}
