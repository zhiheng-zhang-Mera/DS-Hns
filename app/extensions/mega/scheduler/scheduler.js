'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { decideTask } = require('./gate')
const PricingRepository = require('../billing/pricing-repository')
const { statusAt, nextChangeInfo } = require('../billing/peak-engine')
const system = require('./system')
const runner = require('./dsh-runner')
const { OfficialSessionClient } = require('../deepseek/official-session-client')
const { appendRecent, removeEntries, loadRecent } = require('../tracker/task-history')
const { StallDetector } = require('../autonomy/stall-detector')
const { decideContinuation } = require('../autonomy/continuation-controller')
const { DecisionLedger } = require('../autonomy/decision-ledger')
const { ROOT } = require('../utils/paths')
const { getActiveDir } = require('../utils/workspace')
const {
  TERMINAL_EVENT,
  CANONICAL_TERMINAL,
  REASONS,
  isActiveStatus,
  isQueuedStatus,
  isTerminalStatus,
  terminalState,
  persistedStatusFor,
  buildTerminalEvent
} = require('./lifecycle')

const CONFIG_FILE_NAME = 'scheduler-config.json'
const QUEUE_FILE_NAME = 'scheduler-queue.json'
const LEDGER_FILE_NAME = 'decision-ledger.json'

const DEFAULT_STATE_DIR = path.join(ROOT, 'data', 'state')

/** Reasons that are internal continuations rather than user-visible outcomes. */
const CONTINUATION_REASONS = new Set([REASONS.PEAK_PAUSE, REASONS.STALL_RETRY])

const DEFAULTS = {
  defaultAllowPeak: false,
  minConcurrent: 1,
  maxConcurrent: 0,
  interruptRunningAtPeak: false,
  cpuReservePercent: 25,
  memoryReserveGb: 2,
  memoryPerWorkerGb: 2.5,
  tickMs: 10_000,
  // Rev.2 autonomy (§15): opt-in per config; default OFF keeps current behavior
  // until an operator enables it. Guards headless stalls only — official-session
  // episodes keep the existing RPC monitor (§16: never inject into the renderer).
  autonomyEnabled: false,
  autonomyQuietMs: 20_000,
  autonomyHardStallMs: 120_000,
  autonomyFailMs: 15 * 60_000,
  autonomyMaxAttempts: 3
}

function isQueued(t) {
  return isQueuedStatus(t.status)
}

function isActive(t) {
  return isActiveStatus(t.status)
}

function deliveryMode(value) {
  return value === 'headless' ? 'headless' : 'official-session'
}

class SchedulerService extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {string} [options.stateDir]         directory for queue/config/ledger state
   * @param {Function} [options.systemProbe]    hardware probe (injectable for tests)
   * @param {object} [options.officialClient]
   * @param {Function} [options.historySink]    appendRecent-compatible writer
   * @param {Function} [options.historyRemover] removeEntries-compatible remover
   * @param {Function} [options.historyLoader]  loadRecent-compatible reader
   * @param {Function} [options.log]
   */
  constructor(options = {}) {
    super()
    this.stateDir = options.stateDir || DEFAULT_STATE_DIR
    this.configFile = path.join(this.stateDir, CONFIG_FILE_NAME)
    this.queueFile = path.join(this.stateDir, QUEUE_FILE_NAME)
    this.ledgerFile = path.join(this.stateDir, LEDGER_FILE_NAME)
    this.systemProbe = typeof options.systemProbe === 'function' ? options.systemProbe : () => system.probe()
    this.historySink = typeof options.historySink === 'function' ? options.historySink : appendRecent
    this.historyRemover = typeof options.historyRemover === 'function' ? options.historyRemover : removeEntries
    this.historyLoader = typeof options.historyLoader === 'function' ? options.historyLoader : loadRecent
    this.log = typeof options.log === 'function' ? options.log : null
    this.pricing = new PricingRepository()
    this.schedule = this.pricing.getSchedule()
    this.config = this.loadConfig()
    this.tasks = this.loadQueue()
    this.running = new Map()
    this.timer = null
    this.startedAt = null
    this.officialClient = options.officialClient || new OfficialSessionClient()
    this.tickInFlight = false
    this.tickPending = false
    this.ensureQueueOrders()
    this.lastSystem = this.systemProbe()
    this.concurrency = system.computeMaxConcurrent(this.lastSystem, this.config)
    // Rev.2 autonomy supervisor (opt-in). Ledger is created lazily so the
    // default-off path never touches disk for autonomy state.
    this.autonomyEnabled = Boolean(this.config.autonomyEnabled)
    this.autonomy = null
    this.autonomyLedger = null
    this.headlessHearts = new Map()
    if (this.autonomyEnabled) this.enableAutonomy()
  }

  enableAutonomy() {
    this.autonomyEnabled = true
    this.config.autonomyEnabled = true
    const bounds = {
      quietAfterMs: Math.max(1_000, Number(this.config.autonomyQuietMs) || 20_000),
      hardStallAfterMs: Math.max(5_000, Number(this.config.autonomyHardStallMs) || 120_000),
      failAfterMs: Math.max(60_000, Number(this.config.autonomyFailMs) || 15 * 60_000)
    }
    this.autonomy = new StallDetector({ bounds })
    this.autonomyLedger = this.autonomyLedger || new DecisionLedger(this.ledgerFile)
    this.emitSafe('autonomy-enabled', { bounds })
    return { enabled: true, bounds }
  }

  disableAutonomy() {
    this.autonomyEnabled = false
    this.config.autonomyEnabled = false
    this.autonomy = null
    this.headlessHearts.clear()
    return { enabled: false }
  }

  setOfficialClient(client) {
    this.officialClient = client || new OfficialSessionClient()
  }

  loadConfig() {
    try {
      return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(this.configFile, 'utf8')) }
    } catch {
      return { ...DEFAULTS }
    }
  }

  saveConfig() {
    fs.mkdirSync(this.stateDir, { recursive: true })
    fs.writeFileSync(this.configFile, JSON.stringify(this.config, null, 2), 'utf8')
  }

  /**
   * Loads only the active queue. A persisted task that is already terminal can
   * never run again, so it is moved to the history layer instead of being
   * reloaded as a queue entry (MEGA-01 restart recovery).
   */
  loadQueue() {
    let list
    try {
      list = JSON.parse(fs.readFileSync(this.queueFile, 'utf8'))
    } catch {
      return []
    }
    if (!Array.isArray(list)) return []
    const active = []
    const legacyTerminal = []
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') continue
      const task = { ...raw, deliveryMode: deliveryMode(raw.deliveryMode) }
      if (isTerminalStatus(task.status)) legacyTerminal.push(task)
      else active.push(task)
    }
    if (legacyTerminal.length) this.absorbLegacyTerminalTasks(legacyTerminal)
    return active
  }

  /**
   * Legacy queue files may still hold terminal tasks (ghost entries). They are
   * preserved in the history layer before being dropped from the active queue,
   * so no history is lost and nothing resurrects after a restart.
   */
  absorbLegacyTerminalTasks(list) {
    let migrated = 0
    for (const task of list) {
      const entry = this.historyEntry(task, {
        source: 'queue-cleanup',
        reason: task.reason || 'terminal-queue-cleanup'
      })
      try {
        this.historySink(entry)
        migrated += 1
      } catch (error) {
        this.emitSafe('error', new Error(`history write failed for terminal task ${task.id}: ${error?.message || error}`))
      }
    }
    this.log?.(`moved ${migrated}/${list.length} terminal task(s) from the active queue to history`)
    this.emitSafe('terminal-queue-migrated', { migrated, total: list.length })
    return migrated
  }

  ensureQueueOrders() {
    const queued = this.tasks.filter(isQueued).sort((a, b) => {
      const ao = Number.isFinite(Number(a.queueOrder)) ? Number(a.queueOrder) : Number.MAX_SAFE_INTEGER
      const bo = Number.isFinite(Number(b.queueOrder)) ? Number(b.queueOrder) : Number.MAX_SAFE_INTEGER
      if (ao !== bo) return ao - bo
      return (a.createdAt || 0) - (b.createdAt || 0)
    })
    queued.forEach((t, index) => { t.queueOrder = index + 1 })
  }

  nextQueueOrder() {
    const queued = this.tasks.filter(isQueued)
    return queued.length ? Math.max(...queued.map((t) => Number(t.queueOrder || 0))) + 1 : 1
  }

  saveQueue() {
    fs.mkdirSync(this.stateDir, { recursive: true })
    const persisted = this.tasks.map((t) => {
      const copy = { ...t }
      delete copy.proc
      delete copy.child
      return copy
    })
    fs.writeFileSync(this.queueFile, JSON.stringify(persisted, null, 2), 'utf8')
  }

  start() {
    if (this.startedAt) return
    this.startedAt = Date.now()
    // Restart recovery: a task persisted as ACTIVE cannot continue after a
    // restart. It is finalized (into history) here instead of being reloaded as
    // a live queue entry, so it can never resurrect as a worker slot occupant.
    for (const t of this.tasks.filter(isActive)) {
      this.terminate(t, { status: 'INTERRUPTED', reason: REASONS.APP_RESTART, source: 'startup-recovery' })
    }
    for (const t of this.tasks) {
      delete t.proc
      delete t.child
    }
    this.ensureQueueOrders()
    this.saveQueue()
    this.requestTick()
    this.timer = setInterval(() => this.requestTick(), this.config.tickMs || DEFAULTS.tickMs)
    this.emitSafe('started')
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const id of this.tasks.filter(isActive).map((t) => t.id)) this.interruptTask(id, REASONS.APP_QUIT)
  }

  requestTick() {
    if (this.tickInFlight) {
      this.tickPending = true
      return
    }
    void this.tick()
  }

  nowPeak() {
    return statusAt(Date.now(), this.schedule) === 'PEAK'
  }

  peakInfo() {
    const now = Date.now()
    const n = nextChangeInfo(now, this.schedule)
    return {
      peak: statusAt(now, this.schedule) === 'PEAK',
      nextChange: n ? { iso: n.iso, statusAfter: n.statusAfter, secondsLeft: n.secondsLeft } : null
    }
  }

  addTask({
    prompt,
    allowPeak,
    startAt,
    taskId,
    permissionMode,
    attachments,
    queuePosition = 'bottom',
    deliveryMode: requestedDeliveryMode = 'official-session'
  } = {}) {
    if (!prompt || !String(prompt).trim()) throw new Error('prompt is required')
    const id = (taskId && /^[A-Za-z0-9._-]+$/.test(taskId))
      ? taskId
      : `task-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    if (this.tasks.some((t) => t.id === id)) throw new Error(`duplicate task id: ${id}`)

    const task = {
      id,
      prompt: String(prompt).trim(),
      deliveryMode: deliveryMode(requestedDeliveryMode),
      allowPeak: allowPeak == null ? Boolean(this.config.defaultAllowPeak) : Boolean(allowPeak),
      startAtMs: startAt ? new Date(startAt).getTime() : null,
      createdAt: Date.now(),
      queueOrder: this.nextQueueOrder(),
      status: 'PENDING',
      reason: null,
      attempts: 0,
      startedAt: null,
      endedAt: null,
      exitCode: null,
      permissionMode:
        permissionMode === 'danger-full-access' ||
        permissionMode === 'workspace-write' ||
        permissionMode === 'read-only'
          ? permissionMode
          : null,
      attachments: Array.isArray(attachments)
        ? attachments.map((a) => String(a)).filter(Boolean).slice(0, 20)
        : [],
      logFile: null,
      sessionDir: null,
      officialSessionId: null,
      officialAcceptedAt: null,
      officialSeenRunning: false,
      officialLastSeenAt: null,
      error: null
    }
    if (Number.isNaN(task.startAtMs)) throw new Error('invalid startAt')
    this.tasks.push(task)
    if (queuePosition === 'top') this.reorderTask(id, 'top', { save: false, emit: false })
    else this.ensureQueueOrders()
    this.saveQueue()
    this.emitSafe('queue-changed')
    this.requestTick()
    return this.publicTask(task)
  }

  reorderTask(id, move, options = {}) {
    const t = this.tasks.find((x) => x.id === id)
    if (!t) throw new Error(`task not found: ${id}`)
    if (!isQueued(t)) throw new Error('only pending/suspended tasks can be reordered')

    const queued = this.tasks.filter(isQueued).sort((a, b) => (a.queueOrder || 0) - (b.queueOrder || 0))
    const from = queued.findIndex((x) => x.id === id)
    if (from < 0) return this.publicTask(t)
    let to = from
    if (move === 'top') to = 0
    else if (move === 'up') to = Math.max(0, from - 1)
    else if (move === 'down') to = Math.min(queued.length - 1, from + 1)
    else if (move === 'bottom') to = queued.length - 1
    else if (Number.isInteger(Number(move))) to = Math.max(0, Math.min(queued.length - 1, Number(move)))
    else throw new Error(`invalid queue move: ${move}`)

    if (to !== from) {
      queued.splice(from, 1)
      queued.splice(to, 0, t)
    }
    queued.forEach((item, index) => { item.queueOrder = index + 1 })
    if (options.save !== false) this.saveQueue()
    if (options.emit !== false) this.emitSafe('queue-changed')
    return this.publicTask(t)
  }

  cancelTask(id, { reason = REASONS.USER_CANCEL } = {}) {
    const t = this.tasks.find((x) => x.id === id)
    if (!t) return null
    if (isActive(t)) {
      this.interruptTask(id, reason)
    } else if (isQueued(t)) {
      this.terminate(t, { status: 'CANCELED', reason, source: 'user-cancel' })
    }
    return this.publicTask(t)
  }

  /**
   * Interrupts a task through the single terminal path. Automatic
   * continuations (peak pause / stall retry) are finalized silently because the
   * follow-up attempt represents the same logical unit of work.
   */
  interruptTask(id, reason = 'interrupted') {
    const t = this.tasks.find((x) => x.id === id)
    if (!t) return false
    if (isTerminalStatus(t.status)) return false

    if (t.deliveryMode === 'official-session' && t.officialSessionId && this.officialClient) {
      void this.officialClient.cancelSession(t.officialSessionId).catch((error) => {
        this.emitSafe('error', new Error(`official session cancel failed for ${t.id}: ${error?.message || error}`))
      })
    }
    if (t.child) {
      try { t.child.logStream?.end() } catch {}
      runner.killTree(t.pid)
    }

    const status = reason === REASONS.USER_CANCEL || reason === REASONS.REMOVED ? 'CANCELED' : 'INTERRUPTED'
    return this.terminate(t, {
      status,
      reason,
      source: 'interrupt',
      silent: CONTINUATION_REASONS.has(reason)
    })
  }

  clearPending() {
    const targets = this.tasks.filter(isQueued)
    for (const t of targets) {
      this.terminate(t, {
        status: 'CANCELED',
        reason: REASONS.QUEUE_CLEARED,
        source: 'clear-pending',
        bulk: targets.length > 1
      })
    }
    return targets.length
  }

  removeTasks(ids) {
    const requested = (Array.isArray(ids) ? ids : []).map(String)
    const set = new Set(requested)
    const targets = [...this.tasks].filter((t) => set.has(String(t.id)))
    let removed = 0
    for (const t of targets) {
      if (isActive(t)) this.interruptTask(t.id, REASONS.REMOVED)
      else if (isQueued(t)) this.terminate(t, { status: 'CANCELED', reason: REASONS.REMOVED, source: 'remove-tasks' })
      this.removeFromActiveQueue(t.id)
      removed += 1
    }
    // An explicit removal also drops the history record for those ids, whether
    // the task was still queued or had already reached a terminal state.
    if (requested.length) {
      try {
        this.historyRemover(requested)
      } catch (error) {
        this.emitSafe('error', new Error(`history removal failed: ${error?.message || error}`))
      }
    }
    if (removed) {
      this.ensureQueueOrders()
      this.saveQueue()
      this.emitSafe('queue-changed')
      this.requestTick()
    }
    return removed
  }

  /**
   * Removes a task from every collection that means "may still execute": the
   * queue array, the running/worker-slot map and per-task supervision state.
   * Idempotent by design — `removeIfPresent(taskId)`, never
   * `removeOrThrow(taskId)`.
   */
  removeFromActiveQueue(taskId) {
    const id = String(taskId)
    let removed = false
    this.tasks = this.tasks.filter((t) => {
      if (String(t.id) !== id) return true
      removed = true
      return false
    })
    if (this.running.delete(id)) removed = true
    this.headlessHearts.delete(id)
    return removed
  }

  historyEntry(t, { source = null, reason = null } = {}) {
    return {
      id: t.id,
      cwd: getActiveDir(t.id),
      status: t.status,
      model: null,
      createdAt: t.createdAt,
      endedAt: t.endedAt,
      durationMs: t.startedAt && t.endedAt ? t.endedAt - t.startedAt : null,
      error: t.error
        ? typeof t.error === 'string'
          ? { code: 'EXIT', message: t.error }
          : t.error
        : null,
      usage: null,
      costCny: null,
      estimated: false,
      source: source || (t.deliveryMode === 'official-session' ? 'official-session' : 'queue'),
      deliveryMode: t.deliveryMode,
      officialSessionId: t.officialSessionId || null,
      reason
    }
  }

  /**
   * The single terminal transition shared by completion, failure and
   * cancellation (MEGA-01) and the single source of the TASK_TERMINATED event
   * consumed by the notification layer (MEGA-03).
   *
   * Order: finalize result -> persist history -> leave the active queue ->
   * emit terminal event -> update UI. Every auxiliary step is failure isolated:
   * a history or listener failure cannot change the final state and cannot
   * resurrect the task.
   */
  terminate(t, { status, code = null, reason, source = null, preserveError = false, bulk = false, silent = false } = {}) {
    if (!t || typeof t !== 'object') return false
    // Idempotent: an already terminal task is never re-finalized, re-persisted
    // or re-announced, no matter which callback arrives second.
    if (isTerminalStatus(t.status)) return false
    const state = terminalState(status)
    if (!state) throw new Error(`terminate() requires a terminal status, received: ${status}`)

    // ---- 1. finalize result -------------------------------------------------
    t.status = persistedStatusFor(state, status)
    if (reason != null) t.reason = reason
    t.endedAt = Date.now()
    t.exitCode = code == null ? t.exitCode ?? null : code
    if (state === CANONICAL_TERMINAL.FAILED_FINAL && !preserveError && t.deliveryMode === 'headless' && !t.error) {
      t.error = this.extractError(t.logFile, code)
    }

    // ---- 2. persist history (failure isolated) ------------------------------
    try {
      this.historySink(this.historyEntry(t, { source, reason: t.reason || reason || null }))
    } catch (error) {
      this.emitSafe('error', new Error(`history write failed for ${t.id}: ${error?.message || error}`))
    }

    // ---- 3. leave every active collection ----------------------------------
    // Queue array + running/worker-slot map + supervision state, all at once.
    this.removeFromActiveQueue(t.id)
    try {
      this.ensureQueueOrders()
      this.saveQueue()
    } catch (error) {
      this.emitSafe('error', new Error(`queue persist failed for ${t.id}: ${error?.message || error}`))
    }

    // ---- 4. emit the terminal event, then update the UI --------------------
    const event = buildTerminalEvent(t, {
      finalStatus: state,
      status: t.status,
      reason: t.reason || reason || null,
      source,
      exitCode: code
    })
    if (bulk) event.bulk = true
    if (silent) event.silent = true
    this.emitSafe(TERMINAL_EVENT, event)
    this.emitSafe('queue-changed')
    this.log?.(`task ${t.id} reached terminal state ${event.finalStatus} (${t.status})`)
    this.requestTick()
    return true
  }

  /** Back-compat wrapper for the existing launch/sync call sites. */
  finish(t, status, code = null, options = {}) {
    return this.terminate(t, {
      status,
      code,
      source: options.source || null,
      reason: options.reason,
      preserveError: Boolean(options.preserveError),
      bulk: Boolean(options.bulk),
      silent: Boolean(options.silent)
    })
  }

  emitSafe(name, payload) {
    try {
      if (name === 'error' && this.listenerCount('error') === 0) {
        this.log?.(`scheduler error (no listener): ${payload?.stack || payload}`)
        return false
      }
      this.emit(name, payload)
      return true
    } catch (error) {
      this.log?.(`listener for ${name} threw: ${error?.stack || error}`)
      return false
    }
  }

  updateConfig(patch) {
    const next = { ...this.config, ...patch }
    next.minConcurrent = Math.max(1, Number(next.minConcurrent) || 1)
    next.maxConcurrent = Math.max(0, Number(next.maxConcurrent) || 0)
    next.cpuReservePercent = Math.max(5, Math.min(80, Number(next.cpuReservePercent) || DEFAULTS.cpuReservePercent))
    next.memoryReserveGb = Math.max(0.5, Number(next.memoryReserveGb) || DEFAULTS.memoryReserveGb)
    next.memoryPerWorkerGb = Math.max(0.5, Number(next.memoryPerWorkerGb) || DEFAULTS.memoryPerWorkerGb)
    this.config = next
    // Autonomy toggle: enable/disable the supervisor when the patch flips it.
    const wantsAutonomy = Boolean(next.autonomyEnabled)
    if (wantsAutonomy !== this.autonomyEnabled) {
      if (wantsAutonomy) this.enableAutonomy()
      else this.disableAutonomy()
    }
    this.saveConfig()
    this.refreshSystem()
    this.emitSafe('queue-changed')
    return this.config
  }

  refreshSystem() {
    this.lastSystem = this.systemProbe()
    this.concurrency = system.computeMaxConcurrent(this.lastSystem, this.config)
    return { system: this.lastSystem, concurrency: this.concurrency }
  }

  /**
   * The active queue: only tasks that may still be executed. Terminal tasks
   * live in the history layer and are never returned here.
   */
  listTasks({ limit = 200 } = {}) {
    const rank = new Map(
      this.tasks.filter(isQueued)
        .sort((a, b) => (a.queueOrder || 0) - (b.queueOrder || 0))
        .map((t, index) => [t.id, index + 1])
    )
    return [...this.tasks]
      .sort((a, b) => {
        const aActive = isActive(a) ? 0 : isQueued(a) ? 1 : 2
        const bActive = isActive(b) ? 0 : isQueued(b) ? 1 : 2
        if (aActive !== bActive) return aActive - bActive
        if (aActive === 1) return (a.queueOrder || 0) - (b.queueOrder || 0)
        return (b.createdAt || 0) - (a.createdAt || 0)
      })
      .slice(0, limit)
      .map((t) => ({ ...this.publicTask(t), queueRank: rank.get(t.id) || null }))
  }

  /** Terminal task history (queryable, independent of the active queue). */
  listHistory({ limit = 50 } = {}) {
    try {
      const list = this.historyLoader()
      if (!Array.isArray(list)) return []
      return limit ? list.slice(0, limit) : list
    } catch {
      return []
    }
  }

  publicTask(t) {
    const copy = { ...t }
    delete copy.proc
    delete copy.child
    return { ...copy, promptPreview: t.prompt.length > 160 ? t.prompt.slice(0, 160) + '…' : t.prompt }
  }

  async tick() {
    if (this.tickInFlight) {
      this.tickPending = true
      return
    }
    this.tickInFlight = true
    try {
      this.refreshSystem()
      await this.syncOfficialRuns()
      if (this.autonomyEnabled) this.autonomyTick()
      const peak = this.nowPeak()
      let changed = false

      for (const t of this.tasks.filter(isActive)) {
        if (t.status !== 'RUNNING') continue
        if (peak && !t.allowPeak && this.config.interruptRunningAtPeak) {
          changed = true
          const originalId = t.id
          this.interruptTask(originalId, REASONS.PEAK_PAUSE)
          const n = nextChangeInfo(Date.now(), this.schedule)
          this.tasks.push({
            id: `${originalId}@retry-${Date.now()}`,
            prompt: t.prompt,
            deliveryMode: t.deliveryMode,
            allowPeak: false,
            startAtMs: n ? Date.parse(n.iso) : Date.now() + 60_000,
            createdAt: Date.now(),
            queueOrder: this.nextQueueOrder(),
            status: 'PENDING',
            reason: 'peak-retry',
            attempts: t.attempts + 1,
            startedAt: null,
            endedAt: null,
            exitCode: null,
            permissionMode: t.permissionMode || null,
            attachments: Array.isArray(t.attachments) ? [...t.attachments] : [],
            logFile: null,
            sessionDir: null,
            officialSessionId: null,
            officialAcceptedAt: null,
            officialSeenRunning: false,
            officialLastSeenAt: null,
            error: null,
            parentId: originalId
          })
        }
      }

      const queued = this.tasks.filter(isQueued).sort((a, b) => (a.queueOrder || 0) - (b.queueOrder || 0))
      for (const t of queued) {
        const decision = decideTask({ ...t, peak, now: Date.now() })
        if (decision === 'suspend-peak') {
          if (t.status !== 'SUSPENDED' || t.reason !== 'peak-window') {
            t.status = 'SUSPENDED'
            t.reason = 'peak-window'
            changed = true
          }
          continue
        }
        if (decision === 'suspend-schedule') {
          if (t.status !== 'SUSPENDED' || t.reason !== 'waiting-schedule') {
            t.status = 'SUSPENDED'
            t.reason = 'waiting-schedule'
            changed = true
          }
          continue
        }
        if (decision === 'ready') {
          if (this.running.size >= this.concurrency.current) break
          await this.launch(t)
          changed = true
        }
      }
      if (changed) {
        this.ensureQueueOrders()
        this.saveQueue()
      }
    } catch (err) {
      this.emitSafe('error', err)
    } finally {
      this.tickInFlight = false
      if (this.tickPending) {
        this.tickPending = false
        queueMicrotask(() => this.requestTick())
      }
    }
  }

  async syncOfficialRuns() {
    const active = [...this.running.values()].filter((t) =>
      t.deliveryMode === 'official-session' && t.status === 'RUNNING' && t.officialSessionId)
    if (!active.length || !this.officialClient) return

    let items
    try {
      items = await this.officialClient.listSessions()
    } catch (error) {
      this.emitSafe('error', new Error(`official session status sync failed: ${error?.message || error}`))
      return
    }

    const byId = new Map(items.map((item) => [String(item.sessionId), item]))
    const now = Date.now()
    for (const t of active) {
      const summary = byId.get(String(t.officialSessionId))
      if (!summary) {
        if (t.officialAcceptedAt && now - t.officialAcceptedAt > 60_000) {
          t.error = 'official session did not appear in session/list within 60 seconds'
          this.finish(t, 'FAILED', null, { source: 'official-session', preserveError: true })
        }
        continue
      }

      t.officialLastSeenAt = now
      if (summary.running) {
        t.officialSeenRunning = true
        continue
      }

      const acceptedAge = t.officialAcceptedAt ? now - t.officialAcceptedAt : 0
      if (summary.blank === false && (t.officialSeenRunning || acceptedAge >= 3_000)) {
        this.finish(t, 'COMPLETED', null, { source: 'official-session' })
      }
    }
  }

  buildPrompt(t) {
    let promptArg = t.prompt
    if (Array.isArray(t.attachments) && t.attachments.length) {
      const note = '\n\n附件:以下文件已上传到当前任务工作目录的 attachments\\ 子目录,请按需读取/处理:\n' +
        t.attachments.map((a) => `- ${a}`).join('\n')
      promptArg = `${t.prompt}${note}`
    }
    return promptArg
  }

  async launch(t) {
    if (t.deliveryMode === 'headless') {
      this.launchHeadless(t)
      return
    }
    await this.launchOfficial(t)
  }

  launchHeadless(t) {
    t.status = 'RUNNING'
    t.startedAt = Date.now()
    t.attempts += 1
    t.reason = 'headless'
    const taskDir = getActiveDir(t.id)
    const launched = runner.startJob({
      id: t.id,
      prompt: this.buildPrompt(t),
      taskDir,
      logFile: t.logFile || undefined,
      permissionMode: t.permissionMode || process.env.DSH_PERMISSION_MODE
    })
    t.logFile = launched.logFile
    t.child = launched.child
    t.pid = launched.pid
    this.running.set(t.id, t)
    const proc = launched.child
    proc.on('error', (err) => {
      t.error = String(err?.message || err)
      this.finish(t, 'FAILED', null, { preserveError: true })
    })
    proc.on('exit', (code) => {
      try { t.child?.logStream?.end() } catch {}
      this.headlessHearts.delete(t.id)
      if (t.status === 'RUNNING') this.finish(t, code === 0 ? 'COMPLETED' : 'FAILED', code)
    })
    this.ensureQueueOrders()
    this.saveQueue()
    this.emitSafe('queue-changed')
  }

  /**
   * Rev.2 §15/§16 headless progress supervision (runs inside the scheduler tick,
   * never blocking it). Watches log growth per RUNNING headless task and consults
   * the stall detector + continuation controller. A hard stall triggers a bounded
   * auto-retry (backoff, attempts-capped, parent-linked); beyond the cap the
   * episode FAILS with a recorded reason. The waiting slot is released instantly
   * (§17) so sibling tasks keep running. Default OFF (autonomyEnabled=false).
   */
  autonomyTick() {
    if (!this.autonomy || !this.autonomyLedger) return
    const now = Date.now()
    for (const t of [...this.running.values()]) {
      if (t.status !== 'RUNNING' || t.deliveryMode !== 'headless') continue
      const heart = this.headlessHearts.get(t.id) || { logBytes: 0, mtimeMs: 0 }
      let size = null
      let mtimeMs = null
      if (t.logFile) {
        try {
          const st = fs.statSync(t.logFile)
          size = st.size
          mtimeMs = st.mtimeMs
        } catch {}
      }
      const grew = size !== null && size > heart.logBytes
      const update = { busy: true }
      if (grew) update.lastResponseDeltaAt = now
      if (mtimeMs !== null && mtimeMs >= heart.mtimeMs) update.lastPageStateAt = mtimeMs
      heart.logBytes = size ?? heart.logBytes
      heart.mtimeMs = mtimeMs ?? heart.mtimeMs
      this.headlessHearts.set(t.id, heart)

      const observation = this.autonomy.observe(t.id, update, now)
      const decision = decideContinuation({
        verdict: observation.verdict,
        attempts: t.attempts || 0,
        startedAt: t.startedAt || t.createdAt || 0,
        now,
        retryable: true,
        maxAttempts: Math.max(1, Number(this.config.autonomyMaxAttempts) || 3)
      })
      const ledgerReason = decision.reason
      if (decision.action === 'FAIL') {
        t.error = ledgerReason
        this.autonomyLedger.append({
          id: `autonomy-${t.id}-${now}`,
          episodeId: t.id,
          createdAt: new Date(now).toISOString(),
          question: 'headless episode stalled / hard deadline',
          candidates: [],
          chosen: 'FAIL',
          evidence: [ledgerReason],
          outcome: 'DEFERRED',
          source: 'continuation-controller'
        })
        this.finish(t, 'FAILED', null, { source: 'autonomy-stall', preserveError: true })
        this.emitSafe('autonomy-decision', { id: t.id, action: 'FAIL', reason: ledgerReason })
        continue
      }
      if (decision.action === 'PARK_AWAITING_RETRY') {
        const originalId = t.id
        const retryAt = decision.retryAtMs || now + 60_000
        this.interruptTask(originalId, REASONS.STALL_RETRY)
        this.tasks.push({
          id: `${originalId}@retry-${now}`,
          prompt: t.prompt,
          deliveryMode: t.deliveryMode,
          allowPeak: t.allowPeak,
          startAtMs: retryAt,
          createdAt: now,
          queueOrder: this.nextQueueOrder(),
          status: 'PENDING',
          reason: 'stall-retry',
          attempts: t.attempts || 0,
          startedAt: null,
          endedAt: null,
          exitCode: null,
          permissionMode: t.permissionMode || null,
          attachments: Array.isArray(t.attachments) ? [...t.attachments] : [],
          logFile: null,
          sessionDir: null,
          officialSessionId: null,
          officialAcceptedAt: null,
          officialSeenRunning: false,
          officialLastSeenAt: null,
          error: null,
          parentId: originalId
        })
        this.autonomyLedger.append({
          id: `autonomy-${originalId}-${now}`,
          episodeId: originalId,
          createdAt: new Date(now).toISOString(),
          question: 'headless episode stalled',
          candidates: [],
          chosen: `bounded retry at +${retryAt - now}ms`,
          evidence: [ledgerReason],
          outcome: 'APPLIED',
          source: 'continuation-controller'
        })
        this.emitSafe('autonomy-decision', { id: originalId, action: 'PARK_AWAITING_RETRY', retryAtMs: retryAt, reason: ledgerReason })
        this.ensureQueueOrders()
        this.saveQueue()
        this.emitSafe('queue-changed')
      }
    }
  }

  async launchOfficial(t) {
    t.status = 'DISPATCHING'
    t.startedAt = Date.now()
    t.attempts += 1
    t.reason = 'official-session-dispatch'
    this.running.set(t.id, t)
    this.ensureQueueOrders()
    this.saveQueue()
    this.emitSafe('queue-changed')

    if (!this.officialClient) {
      t.error = 'official DSH session client is unavailable'
      this.finish(t, 'FAILED', null, { source: 'official-session', preserveError: true })
      return
    }

    const taskDir = getActiveDir(t.id)
    fs.mkdirSync(taskDir, { recursive: true })
    try {
      const result = await this.officialClient.dispatchNewSession({
        prompt: this.buildPrompt(t),
        cwd: taskDir
      })
      t.officialSessionId = result.sessionId
      t.officialAcceptedAt = Date.now()
      t.officialSeenRunning = false
      t.officialLastSeenAt = null
      t.status = 'RUNNING'
      t.reason = 'official-session'
      t.error = null
      this.saveQueue()
      this.emitSafe('queue-changed')
    } catch (error) {
      t.error = String(error?.message || error)
      this.finish(t, 'FAILED', null, { source: 'official-session', preserveError: true })
    }
  }

  describe() {
    return {
      startedAt: this.startedAt,
      config: this.config,
      autonomy: { enabled: this.autonomyEnabled, bounds: this.autonomy ? { quietAfterMs: this.autonomy.bounds.quietAfterMs, hardStallAfterMs: this.autonomy.bounds.hardStallAfterMs, failAfterMs: this.autonomy.bounds.failAfterMs } : null },
      peak: this.peakInfo(),
      concurrency: this.concurrency,
      system: this.lastSystem,
      hardware: this.lastSystem?.hardware || system.hardwareInventory(),
      officialDeliveryReady: Boolean(this.officialClient),
      counts: this.tasks.reduce((acc, t) => {
        acc[t.status] = (acc[t.status] || 0) + 1
        return acc
      }, {}),
      activeQueue: {
        total: this.tasks.length,
        running: this.tasks.filter(isActive).length,
        queued: this.tasks.filter(isQueued).length,
        suspended: this.tasks.filter((t) => t.status === 'SUSPENDED').length,
        workerSlotsInUse: this.running.size
      }
    }
  }

  extractError(logFile, code) {
    try {
      const text = fs.readFileSync(logFile, 'utf8')
      const lines = text.split(/\r?\n/).filter(Boolean)
      for (let i = Math.max(0, lines.length - 20); i < lines.length; i++) {
        const m = lines[i].match(/\b([A-Z][A-Z0-9_]{2,40})\s*:\s*(.{1,300})/)
        if (m) return { code: m[1], message: m[2].slice(0, 300) }
      }
    } catch {}
    return code == null ? null : { code: `EXIT_${code}`, message: `dsh exited with code ${code}` }
  }
}

const service = new SchedulerService()
module.exports = service
// Exposed for unit/integration tests that need an isolated instance (the
// default export stays the shared singleton used by the extension entry point).
module.exports.SchedulerService = SchedulerService
module.exports.TERMINAL_EVENT = TERMINAL_EVENT
module.exports.TERMINAL = CANONICAL_TERMINAL
module.exports.REASONS = REASONS
