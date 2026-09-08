'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { decideTask } = require('./gate')
const PricingRepository = require('../billing/pricing-repository')
const { statusAt, nextChangeInfo } = require('../billing/peak-engine')
const system = require('./system')
const runner = require('./dsh-runner')
const { appendRecent } = require('../tracker/task-history')
const { ROOT } = require('../utils/paths')
const { getActiveDir } = require('../utils/workspace')

const STATE_DIR = path.join(ROOT, 'data', 'state')
const CONFIG_FILE = path.join(STATE_DIR, 'scheduler-config.json')
const QUEUE_FILE = path.join(STATE_DIR, 'scheduler-queue.json')

const DEFAULTS = {
  defaultAllowPeak: false,
  minConcurrent: 1,
  maxConcurrent: 0,
  interruptRunningAtPeak: false,
  cpuReservePercent: 25,
  memoryReserveGb: 2,
  memoryPerWorkerGb: 2.5,
  tickMs: 10_000
}

function isQueued(t) {
  return t.status === 'PENDING' || t.status === 'SUSPENDED'
}

class SchedulerService extends EventEmitter {
  constructor() {
    super()
    this.pricing = new PricingRepository()
    this.schedule = this.pricing.getSchedule()
    this.config = this.loadConfig()
    this.tasks = this.loadQueue()
    this.running = new Map()
    this.timer = null
    this.startedAt = null
    this.ensureQueueOrders()
    this.lastSystem = system.probe()
    this.concurrency = system.computeMaxConcurrent(this.lastSystem, this.config)
  }

  loadConfig() {
    try {
      return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }
    } catch {
      return { ...DEFAULTS }
    }
  }

  saveConfig() {
    fs.mkdirSync(STATE_DIR, { recursive: true })
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(this.config, null, 2), 'utf8')
  }

  loadQueue() {
    try {
      const list = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'))
      return Array.isArray(list) ? list : []
    } catch {
      return []
    }
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
    fs.mkdirSync(STATE_DIR, { recursive: true })
    const persisted = this.tasks.map((t) => {
      const copy = { ...t }
      delete copy.proc
      delete copy.child
      return copy
    })
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(persisted, null, 2), 'utf8')
  }

  start() {
    if (this.startedAt) return
    this.startedAt = Date.now()
    for (const t of this.tasks) {
      if (t.status === 'RUNNING') {
        t.status = 'INTERRUPTED'
        t.reason = 'app-restart'
        t.endedAt = Date.now()
      }
      delete t.proc
      delete t.child
    }
    this.ensureQueueOrders()
    this.saveQueue()
    this.tick()
    this.timer = setInterval(() => this.tick(), this.config.tickMs || DEFAULTS.tickMs)
    this.emit('started')
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const t of this.tasks) {
      if (t.status === 'RUNNING') this.interruptTask(t.id, 'app-quit')
    }
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

  addTask({ prompt, allowPeak, startAt, taskId, permissionMode, attachments, queuePosition = 'bottom' } = {}) {
    if (!prompt || !String(prompt).trim()) throw new Error('prompt is required')
    const id = (taskId && /^[A-Za-z0-9._-]+$/.test(taskId))
      ? taskId
      : `task-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    if (this.tasks.some((t) => t.id === id)) throw new Error(`duplicate task id: ${id}`)

    const task = {
      id,
      prompt: String(prompt).trim(),
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
      error: null
    }
    if (Number.isNaN(task.startAtMs)) throw new Error('invalid startAt')
    this.tasks.push(task)
    if (queuePosition === 'top') this.reorderTask(id, 'top', { save: false, emit: false })
    else this.ensureQueueOrders()
    this.saveQueue()
    this.emit('queue-changed')
    this.tick()
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
    if (options.emit !== false) this.emit('queue-changed')
    return this.publicTask(t)
  }

  cancelTask(id, { reason = 'user-cancel' } = {}) {
    const t = this.tasks.find((x) => x.id === id)
    if (!t) return null
    if (t.status === 'RUNNING') {
      this.interruptTask(id, reason)
    } else if (isQueued(t)) {
      t.status = 'CANCELED'
      t.reason = reason
      t.endedAt = Date.now()
      this.ensureQueueOrders()
      this.saveQueue()
      this.emit('queue-changed')
    }
    return this.publicTask(t)
  }

  interruptTask(id, reason = 'interrupted') {
    const t = this.tasks.find((x) => x.id === id)
    if (!t) return
    if (t.child) {
      try { t.child.logStream?.end() } catch {}
      runner.killTree(t.pid)
    }
    t.status = 'INTERRUPTED'
    t.reason = reason
    t.endedAt = Date.now()
    this.running.delete(id)
    this.emit('queue-changed')
    this.saveQueue()
    this.emit('task-terminal', { id, status: 'INTERRUPTED', endedAt: t.endedAt, reason })
  }

  clearPending() {
    let cleared = 0
    for (const t of this.tasks) {
      if (isQueued(t)) {
        t.status = 'CANCELED'
        t.reason = 'queue-cleared'
        t.endedAt = Date.now()
        cleared++
      }
    }
    this.ensureQueueOrders()
    this.saveQueue()
    if (cleared) this.emit('queue-changed')
    return cleared
  }

  removeTasks(ids) {
    const set = new Set(ids.map(String))
    let removed = 0
    for (const t of [...this.tasks]) {
      if (!set.has(String(t.id))) continue
      if (t.status === 'RUNNING' || t.status === 'STARTING') {
        t.status = 'CANCELED'
        try { t.child?.logStream?.end() } catch {}
        if (t.child) runner.killTree(t.pid)
        this.running.delete(t.id)
      }
      this.tasks = this.tasks.filter((x) => x.id !== t.id)
      removed++
    }
    if (removed) {
      this.ensureQueueOrders()
      this.saveQueue()
      this.emit('queue-changed')
    }
    return removed
  }

  updateConfig(patch) {
    const next = { ...this.config, ...patch }
    next.minConcurrent = Math.max(1, Number(next.minConcurrent) || 1)
    next.maxConcurrent = Math.max(0, Number(next.maxConcurrent) || 0)
    next.cpuReservePercent = Math.max(5, Math.min(80, Number(next.cpuReservePercent) || DEFAULTS.cpuReservePercent))
    next.memoryReserveGb = Math.max(0.5, Number(next.memoryReserveGb) || DEFAULTS.memoryReserveGb)
    next.memoryPerWorkerGb = Math.max(0.5, Number(next.memoryPerWorkerGb) || DEFAULTS.memoryPerWorkerGb)
    this.config = next
    this.saveConfig()
    this.refreshSystem()
    this.emit('queue-changed')
    return this.config
  }

  refreshSystem() {
    this.lastSystem = system.probe()
    this.concurrency = system.computeMaxConcurrent(this.lastSystem, this.config)
    return { system: this.lastSystem, concurrency: this.concurrency }
  }

  listTasks({ limit = 200 } = {}) {
    const rank = new Map(
      this.tasks.filter(isQueued)
        .sort((a, b) => (a.queueOrder || 0) - (b.queueOrder || 0))
        .map((t, index) => [t.id, index + 1])
    )
    return [...this.tasks]
      .sort((a, b) => {
        const aActive = a.status === 'RUNNING' ? 0 : isQueued(a) ? 1 : 2
        const bActive = b.status === 'RUNNING' ? 0 : isQueued(b) ? 1 : 2
        if (aActive !== bActive) return aActive - bActive
        if (aActive === 1) return (a.queueOrder || 0) - (b.queueOrder || 0)
        return (b.createdAt || 0) - (a.createdAt || 0)
      })
      .slice(0, limit)
      .map((t) => ({ ...this.publicTask(t), queueRank: rank.get(t.id) || null }))
  }

  publicTask(t) {
    const copy = { ...t }
    delete copy.proc
    delete copy.child
    return { ...copy, promptPreview: t.prompt.length > 160 ? t.prompt.slice(0, 160) + '…' : t.prompt }
  }

  tick() {
    try {
      this.refreshSystem()
      const peak = this.nowPeak()
      let changed = false

      for (const t of this.tasks.filter((x) => x.status === 'RUNNING')) {
        if (peak && !t.allowPeak && this.config.interruptRunningAtPeak) {
          changed = true
          const originalId = t.id
          this.interruptTask(originalId, 'peak-pause')
          const n = nextChangeInfo(Date.now(), this.schedule)
          this.tasks.push({
            id: `${originalId}@retry-${Date.now()}`,
            prompt: t.prompt,
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
          this.launch(t)
          changed = true
        }
      }
      if (changed) {
        this.ensureQueueOrders()
        this.saveQueue()
      }
    } catch (err) {
      this.emit('error', err)
    }
  }

  launch(t) {
    t.status = 'RUNNING'
    t.startedAt = Date.now()
    t.attempts += 1
    t.reason = null
    const taskDir = getActiveDir(t.id)
    let promptArg = t.prompt
    if (Array.isArray(t.attachments) && t.attachments.length) {
      const note = '\n\n附件:以下文件已上传到当前任务工作目录的 attachments\\ 子目录,请按需读取/处理:\n' +
        t.attachments.map((a) => `- ${a}`).join('\n')
      promptArg = `${t.prompt}${note}`
    }
    const launched = runner.startJob({
      id: t.id,
      prompt: promptArg,
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
      this.finish(t, 'FAILED')
    })
    proc.on('exit', (code) => {
      try { t.child?.logStream?.end() } catch {}
      if (t.status === 'RUNNING') this.finish(t, code === 0 ? 'COMPLETED' : 'FAILED', code)
    })
    this.ensureQueueOrders()
    this.emit('queue-changed')
  }

  finish(t, status, code = null) {
    t.status = status
    t.exitCode = code
    t.endedAt = Date.now()
    if (status === 'FAILED') t.error = this.extractError(t.logFile, code)
    this.running.delete(t.id)
    appendRecent({
      id: t.id,
      cwd: getActiveDir(t.id),
      status,
      model: null,
      createdAt: t.createdAt,
      endedAt: t.endedAt,
      durationMs: t.startedAt ? t.endedAt - t.startedAt : null,
      error: t.error ? { code: 'EXIT', message: typeof t.error === 'string' ? t.error : JSON.stringify(t.error) } : code ? { code: `EXIT_${code}`, message: `dsh exited ${code}` } : null,
      usage: null,
      costCny: null,
      estimated: false,
      source: 'queue'
    })
    this.ensureQueueOrders()
    this.saveQueue()
    this.emit('queue-changed')
    this.emit('task-terminal', { id: t.id, status, endedAt: t.endedAt, reason: t.reason || null, exitCode: code })
    this.tick()
  }

  describe() {
    return {
      startedAt: this.startedAt,
      config: this.config,
      peak: this.peakInfo(),
      concurrency: this.concurrency,
      system: this.lastSystem,
      hardware: this.lastSystem?.hardware || system.hardwareInventory(),
      counts: this.tasks.reduce((acc, t) => {
        acc[t.status] = (acc[t.status] || 0) + 1
        return acc
      }, {})
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

module.exports = new SchedulerService()
