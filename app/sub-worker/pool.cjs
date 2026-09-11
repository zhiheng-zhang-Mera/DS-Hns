'use strict'

/**
 * Worker Pool (plan §13, §14, §32, §33, §34, §35).
 *
 * A persistent pool of executor processes instead of spawn-per-task:
 *   - workers stay alive and return to idle after each task;
 *   - a worker is only restarted on crash, heartbeat timeout, a detected hang,
 *     environment corruption, a timeout or a version mismatch (§13);
 *   - every failure is contained: the pool reports it and the supervisor
 *     survives (§34).
 *
 * The pool owns processes and liveness only. It never decides what to run —
 * that is the Dispatch Scheduler's job — and it never talks to the Harness.
 */

const fs = require('node:fs')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')

const protocol = require('./protocol.cjs')
const { redactSecrets } = require('./event-bus.cjs')

const DEFAULT_HEARTBEAT_GRACE = 3
const MIN_RESPAWN_INTERVAL_MS = 1000

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function nowMs() {
  return Date.now()
}

/**
 * One worker process plus everything the supervisor knows about it.
 */
class WorkerSlot {
  constructor({ workerId, role, profile, log = () => {} }) {
    this.worker_id = workerId
    this.role = role || 'generic'
    this.profile = profile || null
    this.child = null
    this.decoder = null
    this.state = 'OFF'
    this.task_id = null
    this.node_id = null
    this.started_at = null
    this.task_started_at = null
    this.busy_since = null
    this.idle_since = null
    this.last_heartbeat_at = null
    this.last_message_at = null
    this.last_output_at = null
    this.last_file_change_at = null
    this.last_progress_at = null
    this.cpu_ms = 0
    this.last_cpu_ms = 0
    this.last_cpu_sample_at = null
    this.rss_mb = null
    this.peak_rss_mb = null
    this.active_child = null
    this.output_seq = 0
    this.file_change_seq = 0
    this.spawned_at = null
    this.restarts = 0
    this.tasks_completed = 0
    this.tasks_failed = 0
    this.hang_reports = 0
    this.expected_exit = false
    this.info = null
    this.log = log
  }

  get alive() {
    return Boolean(this.child && this.child.exitCode === null && !this.child.killed)
  }

  /**
   * Busy means "this worker is holding a task".
   *
   * It is deliberately NOT derived from the worker's lifecycle state: BLOCKED,
   * FAILED and READY_FOR_REVIEW are *task* outcomes, and a worker that reported
   * one of them is alive and available for the next task.
   */
  get busy() {
    return Boolean(this.task_id)
  }

  get pid() {
    return this.child?.pid || null
  }

  describe() {
    return {
      worker_id: this.worker_id,
      role: this.role,
      profile: this.profile,
      pid: this.pid,
      state: this.state,
      alive: this.alive,
      busy: this.busy,
      task_id: this.task_id,
      node_id: this.node_id,
      spawned_at: this.spawned_at,
      task_started_at: this.task_started_at,
      idle_since: this.idle_since,
      last_heartbeat_at: this.last_heartbeat_at,
      last_output_at: this.last_output_at,
      last_file_change_at: this.last_file_change_at,
      cpu_ms: this.cpu_ms,
      rss_mb: this.rss_mb,
      peak_rss_mb: this.peak_rss_mb,
      active_child: this.active_child,
      restarts: this.restarts,
      tasks_completed: this.tasks_completed,
      tasks_failed: this.tasks_failed,
      hang_reports: this.hang_reports,
      capabilities: this.info?.capabilities || null,
      protocol: this.info?.protocol || null
    }
  }
}

class WorkerPool {
  constructor({
    root,
    nodeExe = process.execPath,
    runtimeEntry,
    runtimeProcess = null,
    config = {},
    log = () => {},
    onWorkerMessage = () => {},
    onWorkerExit = () => {},
    onWorkerSpawn = () => {},
    maxWorkers = 16
  } = {}) {
    this.root = path.resolve(root || process.cwd())
    this.nodeExe = nodeExe
    this.runtimeEntry = runtimeEntry || path.join(__dirname, 'runtime.cjs')
    this.runtimeProcess = runtimeProcess
    this.config = config
    this.log = log
    this.onWorkerMessage = onWorkerMessage
    this.onWorkerExit = onWorkerExit
    this.onWorkerSpawn = onWorkerSpawn
    this.maxWorkers = Math.max(1, Math.min(64, Number(maxWorkers) || 16))
    this.slots = new Map()
    this.nextIndex = 1
    this.lastSpawnAt = 0
    this.stopping = false
  }

  // ------------------------------------------------------------------ queries

  get size() {
    return this.slots.size
  }

  get workers() {
    return [...this.slots.values()]
  }

  get running() {
    return this.workers.filter((slot) => slot.alive)
  }

  get idle() {
    return this.workers.filter((slot) => slot.alive && !slot.busy)
  }

  get busy() {
    return this.workers.filter((slot) => slot.alive && slot.busy)
  }

  get(workerId) {
    return this.slots.get(String(workerId)) || null
  }

  /** The long-lived primary worker, kept for the single-worker compatibility API. */
  get primary() {
    return this.get('sub-1') || this.workers[0] || null
  }

  /** An idle worker able to take the requested role, if any. */
  findIdle({ role = null, capability = null } = {}) {
    const candidates = this.idle
    if (!candidates.length) return null
    const roleMatch = role && candidates.find((slot) => slot.role === role)
    if (roleMatch) return roleMatch
    if (capability) {
      const capable = candidates.find((slot) => slot.info?.capabilities?.[capability] === true)
      if (capable) return capable
    }
    return candidates[0]
  }

  // ----------------------------------------------------------------- spawning

  /**
   * §13: a worker is spawned once and then reused; only failures respawn it.
   *
   * `force` marks an explicit Controller action (Enable, Restart), which must
   * never be blocked by the anti-crash-loop throttle that protects *automatic*
   * scale-up and restart.
   */
  spawn({ role = 'generic', profile = null, reason = 'scale-up', force = false } = {}) {
    if (this.stopping) return { ok: false, reason: 'the pool is stopping' }
    if (this.slots.size >= this.maxWorkers) return { ok: false, reason: `the pool already holds ${this.slots.size} of ${this.maxWorkers} workers` }
    const sinceSpawn = nowMs() - this.lastSpawnAt
    if (!force && this.lastSpawnAt && sinceSpawn < MIN_RESPAWN_INTERVAL_MS) {
      return { ok: false, reason: `respawn throttle: ${MIN_RESPAWN_INTERVAL_MS - sinceSpawn} ms remaining` }
    }

    const workerId = this.nextWorkerId()
    const slot = new WorkerSlot({ workerId, role, profile, log: this.log })
    const args = [this.runtimeEntry, '--root', this.root, '--worker-id', workerId, '--role', String(role)]
    let child
    try {
      child = spawn(this.nodeExe, args, {
        cwd: this.root,
        env: {
          ...process.env,
          DSH_ROOT: this.root,
          DSH_SUB_WORKER: '1',
          DSH_SUB_WORKER_ID: workerId,
          DSH_SUB_WORKER_ROLE: String(role),
          DSH_NODE: this.nodeExe
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      })
    } catch (error) {
      return { ok: false, reason: `could not spawn ${workerId}: ${error?.message || error}` }
    }

    slot.child = child
    slot.decoder = new protocol.LineDecoder()
    slot.state = 'STARTING'
    slot.spawned_at = new Date().toISOString()
    slot.idle_since = null
    this.lastSpawnAt = nowMs()
    this.slots.set(workerId, slot)

    child.stdout.on('data', (chunk) => this.consume(workerId, chunk))
    child.stderr.on('data', (chunk) => this.log(`[pool:${workerId}] stderr: ${redactSecrets(chunk.toString()).trim()}`))
    // A worker dying mid-write raises EPIPE asynchronously; without these
    // listeners it would become an unhandled error in the supervisor.
    child.stdin.on('error', (error) => this.log(`[pool:${workerId}] stdin closed: ${error?.message || error}`))
    child.stdout.on('error', (error) => this.log(`[pool:${workerId}] stdout error: ${error?.message || error}`))
    child.stderr.on('error', (error) => this.log(`[pool:${workerId}] stderr error: ${error?.message || error}`))
    child.once('error', (error) => {
      this.log(`[pool:${workerId}] process error: ${error?.message || error}`)
      this.handleExit(workerId, -1, null, { error: String(error?.message || error) })
    })
    child.once('exit', (code, signal) => this.handleExit(workerId, code, signal))

    this.log(`[pool] worker ${workerId} spawned (role ${role}, reason ${reason}) pid=${child.pid}`)
    this.send(workerId, 'hello', { root: this.root, controller: 'ds-hns', role })
    try {
      this.onWorkerSpawn(slot)
    } catch (error) {
      this.log(`[pool] onWorkerSpawn failed: ${error?.message || error}`)
    }
    return { ok: true, workerId, pid: child.pid, slot }
  }

  nextWorkerId() {
    // Worker ids are never reused while a slot exists, and never hardcoded to
    // "worker-1": the id is just an identity the supervisor assigns.
    let id = `sub-${this.nextIndex}`
    while (this.slots.has(id)) {
      this.nextIndex += 1
      id = `sub-${this.nextIndex}`
    }
    this.nextIndex += 1
    return id
  }

  /**
   * Grow or shrink towards `desired`, one step at a time (§11, §35).
   * A busy worker is never retired.
   */
  ensureSize(desired, { role = 'generic', profile = null, reason = 'scheduler' } = {}) {
    const target = Math.max(0, Math.min(this.maxWorkers, Math.floor(Number(desired) || 0)))
    const actions = []
    if (target > this.slots.size) {
      const result = this.spawn({ role, profile, reason })
      actions.push({ action: 'spawn', ok: result.ok, worker_id: result.workerId || null, reason: result.reason || reason })
      return { size: this.slots.size, actions }
    }
    if (target < this.slots.size) {
      // Retire the longest-idle worker first; never a busy one.
      const candidates = this.idle.sort((left, right) => String(left.idle_since || '').localeCompare(String(right.idle_since || '')))
      const victim = candidates[0]
      if (!victim) {
        actions.push({ action: 'retire', ok: false, reason: 'every worker is busy' })
        return { size: this.slots.size, actions }
      }
      const result = this.retire(victim.worker_id, { reason })
      actions.push({ action: 'retire', ok: result.ok, worker_id: victim.worker_id, reason: `${reason}: ${result.reason || 'retired'}` })
    }
    return { size: this.slots.size, actions }
  }

  /**
   * Retire one worker. Graceful first (shutdown message), then the process tree.
   */
  retire(workerId, { reason = 'scale-down', timeoutMs = 3000 } = {}) {
    const slot = this.get(workerId)
    if (!slot) return { ok: false, reason: 'unknown worker' }
    if (slot.busy) return { ok: false, reason: `worker ${workerId} is busy with ${slot.task_id}` }
    slot.expected_exit = true
    this.send(workerId, 'shutdown', { reason })
    const child = slot.child
    this.slots.delete(workerId)
    if (child && child.exitCode === null) {
      const timer = setTimeout(() => this.killTree(child.pid), Math.max(250, Number(timeoutMs) || 3000))
      if (typeof timer.unref === 'function') timer.unref()
      child.once('exit', () => clearTimeout(timer))
      this.killTree(child.pid)
    }
    this.log(`[pool] worker ${workerId} retired (${reason})`)
    return { ok: true, worker_id: workerId, reason }
  }

  /** Kill and replace a worker, keeping its id and role (§32, §33, §34). */
  restart(workerId, { reason = 'restart' } = {}) {
    const slot = this.get(workerId)
    if (!slot) return { ok: false, reason: 'unknown worker' }
    const role = slot.role
    const profile = slot.profile
    const restarts = slot.restarts + 1
    const taskId = slot.task_id
    slot.expected_exit = true
    this.slots.delete(workerId)
    this.killTree(slot.pid)
    const spawned = this.spawn({ role, profile, reason })
    if (spawned.ok && spawned.slot) {
      spawned.slot.restarts = restarts
      spawned.slot.worker_id = workerId
      this.slots.delete(spawned.workerId)
      this.slots.set(workerId, spawned.slot)
      spawned.slot.log = this.log
    }
    this.log(`[pool] worker ${workerId} restarted (${reason}); interrupted task ${taskId || 'none'}`)
    return { ok: spawned.ok, worker_id: workerId, reason, previous_task: taskId, restarts, spawn: spawned.reason || null }
  }

  // ------------------------------------------------------------------ messaging

  send(workerId, type, payload = {}, extra = {}) {
    const slot = this.get(workerId)
    if (!slot?.child || slot.child.exitCode !== null) return false
    const validation = protocol.validateMessage({ v: protocol.PROTOCOL_VERSION, type, payload }, 'controller-to-worker')
    if (!validation.ok) {
      this.log(`[pool] refusing to send invalid message to ${workerId}: ${validation.error}`)
      return false
    }
    try {
      slot.child.stdin.write(protocol.encode(protocol.envelope(type, payload, extra)))
      return true
    } catch (error) {
      this.log(`[pool] failed to write ${type} to ${workerId}: ${error?.message || error}`)
      return false
    }
  }

  /** Send to every live worker (or a filtered subset). */
  broadcast(type, payload = {}, { filter = null } = {}) {
    const delivered = []
    for (const slot of this.workers) {
      if (!slot.alive) continue
      if (filter && !filter(slot)) continue
      if (this.send(slot.worker_id, type, payload)) delivered.push(slot.worker_id)
    }
    return delivered
  }

  /** Give one node's task to one worker. */
  assign(workerId, task, taskPackage = null) {
    const slot = this.get(workerId)
    if (!slot || !slot.alive) return { ok: false, reason: 'worker is not running' }
    if (slot.busy) return { ok: false, reason: `worker ${workerId} is busy with ${slot.task_id}` }
    const sent = this.send(workerId, 'assign_task', { task, package: taskPackage }, { task_id: task.task_id })
    if (!sent) return { ok: false, reason: 'the worker pipe rejected the task' }
    slot.task_id = task.task_id
    slot.node_id = taskPackage?.node_id || null
    slot.task_started_at = new Date().toISOString()
    slot.busy_since = nowMs()
    slot.idle_since = null
    slot.last_output_at = nowMs()
    slot.last_file_change_at = nowMs()
    slot.last_progress_at = nowMs()
    slot.cpu_ms = 0
    slot.last_cpu_ms = 0
    slot.peak_rss_mb = null
    return { ok: true, worker_id: workerId, task_id: task.task_id }
  }

  /** The worker reported a terminal result: it is idle again (§13). */
  release(workerId, { status = null } = {}) {
    const slot = this.get(workerId)
    if (!slot) return null
    if (status === 'completed') slot.tasks_completed += 1
    else if (status) slot.tasks_failed += 1
    slot.task_id = null
    slot.node_id = null
    slot.task_started_at = null
    slot.busy_since = null
    slot.idle_since = nowMs()
    // The task outcome (BLOCKED/FAILED/...) stays visible in `last_task_status`,
    // while the slot itself is available for dispatch again.
    slot.last_task_status = status
    slot.state = 'IDLE'
    return slot
  }

  consume(workerId, chunk) {
    const slot = this.get(workerId)
    if (!slot) return
    if (!slot.decoder) slot.decoder = new protocol.LineDecoder()
    const messages = slot.decoder.push(chunk)
    for (const error of slot.decoder.errors.splice(0)) this.log(`[pool:${workerId}] protocol: ${error}`)
    for (const message of messages) {
      const validation = protocol.validateMessage(message, 'worker-to-controller')
      if (!validation.ok) {
        this.log(`[pool:${workerId}] protocol: ${validation.error}`)
        continue
      }
      slot.last_message_at = nowMs()
      try {
        this.onWorkerMessage(workerId, message, slot)
      } catch (error) {
        this.log(`[pool:${workerId}] message handler failed: ${error?.message || error}`)
      }
    }
  }

  /** Apply a worker's self-reported health/hang signals (§32, §33). */
  noteTelemetry(workerId, telemetry = {}) {
    const slot = this.get(workerId)
    if (!slot) return null
    if (Number.isFinite(Number(telemetry.cpu_ms))) {
      slot.last_cpu_ms = slot.cpu_ms
      slot.cpu_ms = Number(telemetry.cpu_ms)
      slot.last_cpu_sample_at = nowMs()
    }
    if (Number.isFinite(Number(telemetry.rss_mb))) {
      slot.rss_mb = Number(telemetry.rss_mb)
      slot.peak_rss_mb = Math.max(Number(slot.peak_rss_mb) || 0, slot.rss_mb)
    }
    if (telemetry.active_child !== undefined) slot.active_child = telemetry.active_child
    if (Number.isFinite(Number(telemetry.output_seq))) slot.output_seq = Number(telemetry.output_seq)
    if (Number.isFinite(Number(telemetry.file_change_seq))) slot.file_change_seq = Number(telemetry.file_change_seq)
    if (telemetry.last_output_at) slot.last_output_at = Number(telemetry.last_output_at) || slot.last_output_at
    if (telemetry.last_file_change_at) slot.last_file_change_at = Number(telemetry.last_file_change_at) || slot.last_file_change_at
    slot.last_heartbeat_at = nowMs()
    return slot
  }

  markProgress(workerId, kind = 'output') {
    const slot = this.get(workerId)
    if (!slot) return null
    const now = nowMs()
    slot.last_progress_at = now
    if (kind === 'file_change') slot.last_file_change_at = now
    else slot.last_output_at = now
    return slot
  }

  // -------------------------------------------------------------------- health

  handleExit(workerId, code, signal, extra = {}) {
    const slot = this.get(workerId)
    if (!slot) return
    this.slots.delete(workerId)
    const expected = slot.expected_exit || this.stopping
    try {
      this.onWorkerExit(workerId, { code, signal, expected, slot, ...extra })
    } catch (error) {
      this.log(`[pool:${workerId}] exit handler failed: ${error?.message || error}`)
    }
  }

  /**
   * Health verdict per worker (§32, §33).
   *
   * A worker is only declared STALLED when *several* independent signals agree:
   * no output, no file change, no CPU progress, and no subprocess running. One
   * silent-but-busy command is reported as WAITING instead of being killed.
   */
  health({ heartbeatSeconds = 5, hangDetectionSeconds = 120, now = nowMs() } = {}) {
    const heartbeatGraceMs = Math.max(2000, Number(heartbeatSeconds) * 1000 * DEFAULT_HEARTBEAT_GRACE)
    const hangMs = Math.max(5, Number(hangDetectionSeconds)) * 1000
    const verdicts = []
    for (const slot of this.workers) {
      if (!slot.alive) {
        verdicts.push({ worker_id: slot.worker_id, status: 'DEAD', action: 'restart', reason: 'process is not running' })
        continue
      }
      const heartbeatAge = slot.last_heartbeat_at ? now - slot.last_heartbeat_at : null
      if (heartbeatAge !== null && heartbeatAge > heartbeatGraceMs) {
        verdicts.push({
          worker_id: slot.worker_id,
          status: 'UNRESPONSIVE',
          action: 'restart',
          reason: `no heartbeat for ${Math.round(heartbeatAge / 1000)} s (grace ${Math.round(heartbeatGraceMs / 1000)} s)`
        })
        continue
      }
      if (!slot.task_id) {
        verdicts.push({ worker_id: slot.worker_id, status: 'IDLE', action: 'none', reason: null })
        continue
      }
      const outputAge = slot.last_output_at ? now - slot.last_output_at : 0
      const fileAge = slot.last_file_change_at ? now - slot.last_file_change_at : 0
      const cpuDelta = slot.cpu_ms - slot.last_cpu_ms
      const busyWithChild = slot.active_child !== null && slot.active_child !== undefined && slot.active_child !== false
      const silent = outputAge > hangMs
      const noFileChange = fileAge > hangMs
      const noCpu = slot.last_cpu_sample_at !== null && cpuDelta <= 0
      if (busyWithChild) {
        // §33: a long silent command is suspicious, not stalled.
        verdicts.push({
          worker_id: slot.worker_id,
          status: silent ? 'WAITING' : 'WORKING',
          action: 'none',
          reason: silent ? `no output for ${Math.round(outputAge / 1000)} s but a command is still running` : null
        })
        continue
      }
      if (silent && noFileChange && noCpu) {
        slot.hang_reports += 1
        verdicts.push({
          worker_id: slot.worker_id,
          status: 'STALLED',
          action: 'restart',
          reason: `no output for ${Math.round(outputAge / 1000)} s, no file change for ${Math.round(fileAge / 1000)} s and no CPU progress`
        })
        continue
      }
      verdicts.push({ worker_id: slot.worker_id, status: 'WORKING', action: 'none', reason: null })
    }
    return verdicts
  }

  // ------------------------------------------------------------------ teardown

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

  /**
   * Re-arm the pool after a teardown. `killAll` latches `stopping` so a racing
   * scale-up cannot respawn during shutdown; an explicit start clears it.
   */
  reopen() {
    this.stopping = false
    this.lastSpawnAt = 0
    return true
  }

  /**
   * Retire everything, best effort, never blocking the caller.
   *
   * With `expected: false` (a hard teardown, or a simulated supervisor loss)
   * the supervisor is still told about each interrupted worker, so the task it
   * was holding is recorded instead of vanishing.
   */
  killAll({ reason = 'pool teardown', expected = true } = {}) {
    this.stopping = true
    const removed = []
    for (const slot of [...this.slots.values()]) {
      slot.expected_exit = expected
      this.slots.delete(slot.worker_id)
      removed.push(slot.worker_id)
      this.send(slot.worker_id, 'shutdown', { reason })
      this.killTree(slot.pid)
      if (!expected) {
        try {
          this.onWorkerExit(slot.worker_id, { code: null, signal: 'TERMINATED', expected: false, slot, teardown: true })
        } catch (error) {
          this.log(`[pool:${slot.worker_id}] exit handler failed during teardown: ${error?.message || error}`)
        }
      }
    }
    this.log(`[pool] retired ${removed.length} worker(s) (${reason})`)
    return removed
  }

  /** Ownership record so a later supervisor can reclaim orphaned workers (§28). */
  writeOwnership() {
    if (!this.runtimeProcess) return false
    const pids = this.running.map((slot) => slot.pid).filter(Boolean)
    if (!pids.length) return false
    try {
      return Boolean(this.runtimeProcess.writeOwnership({
        root: this.root,
        type: 'sub-worker',
        pid: pids[0],
        parentPid: process.pid,
        entry: this.runtimeEntry,
        workerId: this.primary?.worker_id || null,
        workerPids: pids
      }))
    } catch {
      return false
    }
  }

  clearOwnership() {
    if (!this.runtimeProcess) return false
    try {
      return Boolean(this.runtimeProcess.clearOwnership({ root: this.root, type: 'sub-worker' }))
    } catch {
      return false
    }
  }

  describe() {
    const workers = this.workers.map((slot) => slot.describe())
    return {
      size: workers.length,
      running: workers.filter((worker) => worker.alive).length,
      busy: workers.filter((worker) => worker.busy).length,
      idle: workers.filter((worker) => worker.alive && !worker.busy).length,
      max: this.maxWorkers,
      roles: workers.reduce((acc, worker) => {
        acc[worker.role] = (acc[worker.role] || 0) + 1
        return acc
      }, {}),
      restarts: workers.reduce((sum, worker) => sum + (worker.restarts || 0), 0),
      completed: workers.reduce((sum, worker) => sum + (worker.tasks_completed || 0), 0),
      failed: workers.reduce((sum, worker) => sum + (worker.tasks_failed || 0), 0),
      workers
    }
  }
}

/** Is the process tree still alive? Used by tests and by orphan recovery. */
function processAlive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false
  try {
    process.kill(Number(pid), 0)
    return true
  } catch {
    return false
  }
}

function roleLogPath(root, workerId) {
  return path.join(path.resolve(String(root)), 'logs', 'sub-worker', 'workers', `${String(workerId).replace(/[^A-Za-z0-9._-]+/g, '-')}.log`)
}

function appendRoleLog(root, workerId, line) {
  try {
    const file = roleLogPath(root, workerId)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, `${new Date().toISOString()} ${redactSecrets(line)}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}

module.exports = {
  DEFAULT_HEARTBEAT_GRACE,
  MIN_RESPAWN_INTERVAL_MS,
  WorkerSlot,
  WorkerPool,
  processAlive,
  roleLogPath,
  appendRoleLog,
  isPlainObject
}
