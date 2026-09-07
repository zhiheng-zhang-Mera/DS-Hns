'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { decideTask } = require('./gate')
const PricingRepository = require('../billing/pricing-repository')
const { statusAt, nextChangeInfo } = require('../billing/peak-engine')
const system = require('./system')
const runner = require('./dsh-runner')
const { appendRecent, loadRecent } = require('../tracker/task-history')

/**
 * SchedulerService — bounded task queue with price-window gating.
 *
 * Policies:
 *   allowPeak=false  task stays SUSPENDED during Beijing peak and auto-starts
 *                    as soon as the window turns OFF-PEAK (or after startAt)
 *   interruptRunningAtPeak=true  running off-peak-only jobs are interrupted at
 *                    the next peak boundary and automatically re-queued
 *   concurrency      recomputed from local CPU/RAM each tick, bounded by the
 *                    user-configured min/max from data/state
 */

const { ROOT } = require('../utils/paths')
const { getActiveDir, getWorkspaceRoot } = require('../utils/workspace')
const STATE_DIR = path.join(ROOT, 'data', 'state')
const CONFIG_FILE = path.join(STATE_DIR, 'scheduler-config.json')
const QUEUE_FILE = path.join(STATE_DIR, 'scheduler-queue.json')

const DEFAULTS = {
  defaultAllowPeak: false,
  minConcurrent: 1,
  maxConcurrent: 4,
  interruptRunningAtPeak: false,
  tickMs: 10_000
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
    this.lastSystem = system.probe()
    this.concurrency = system.computeMaxConcurrent(this.lastSystem, this.config)
    this.startedAt = null
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
    // Sessions from a previous process can no longer be running.
    for (const t of this.tasks) {
      if (t.status === 'RUNNING') {
        t.status = 'INTERRUPTED'
        t.reason = 'app-restart'
        t.endedAt = Date.now()
      }
      delete t.proc
      delete t.child
    }
    this.saveQueue()
    this.tick()
    this.timer = setInterval(() => this.tick(), this.config.tickMs || DEFAULTS.tickMs)
    this.emit('started')
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const t of this.tasks) {
      if (t.status === 'RUNNING') {
        this.interruptTask(t.id, 'app-quit')
      }
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

  addTask({ prompt, allowPeak, startAt, taskId, permissionMode, attachments } = {}) {
    if (!prompt || !String(prompt).trim()) throw new Error('prompt is required')
    const id = (taskId && /^[A-Za-z0-9._-]+$/.test(taskId)) ? taskId : `task-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const task = {
      id,
      prompt: String(prompt).trim(),
      allowPeak: allowPeak == null ? Boolean(this.config.defaultAllowPeak) : Boolean(allowPeak),
      startAtMs: startAt ? new Date(startAt).getTime() : null,
      createdAt: Date.now(),
      status: 'PENDING',
      reason: null,
      attempts: 0,
      startedAt: null,
      endedAt: null,
      exitCode: null,
      // 每任务权限模式(为空则用启动时 DSH_PERMISSION_MODE)
      permissionMode:
        permissionMode === 'danger-full-access' || permissionMode === 'workspace-write'
          ? permissionMode
          : null,
      // 附件文件名列表(已由上传接口放入 工作区\active\<id>\attachments\)
      attachments: Array.isArray(attachments)
        ? attachments.map((a) => String(a)).filter(Boolean).slice(0, 20)
        : [],
      logFile: null,
      sessionDir: null,
      error: null
    }
    if (Number.isNaN(task.startAtMs)) throw new Error('invalid startAt')
    this.tasks.push(task)
    this.saveQueue()
    this.emit('queue-changed')
    this.tick()
    return task
  }

  cancelTask(id, { reason = 'user-cancel' } = {}) {
    const t = this.tasks.find((x) => x.id === id)
    if (!t) return null
    if (t.status === 'RUNNING') {
      this.interruptTask(id, reason)
    } else if (t.status === 'PENDING' || t.status === 'SUSPENDED') {
      t.status = 'CANCELED'
      t.reason = reason
      t.endedAt = Date.now()
      this.saveQueue()
      this.emit('queue-changed')
    }
    return t
  }

  interruptTask(id, reason = 'interrupted') {
    const t = this.tasks.find((x) => x.id === id)
    if (!t) return
    if (t.child) {
      try {
        t.child.logStream?.end()
      } catch {
        /* no-op */
      }
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
      if (t.status === 'PENDING' || t.status === 'SUSPENDED') {
        t.status = 'CANCELED'
        t.reason = 'queue-cleared'
        t.endedAt = Date.now()
        cleared++
      }
    }
    this.saveQueue()
    if (cleared) this.emit('queue-changed')
    return cleared
  }

  /** Hard-remove queue rows (cancel running children first, no terminal bell). */
  removeTasks(ids) {
    const set = new Set(ids.map(String))
    let removed = 0
    for (const t of [...this.tasks]) {
      if (!set.has(String(t.id))) continue
      if (t.status === 'RUNNING' || t.status === 'STARTING') {
        t.status = 'CANCELED' // exit handler will then skip finish()
        try {
          t.child?.logStream?.end()
        } catch {
          /* no-op */
        }
        if (t.child) runner.killTree(t.pid)
        this.running.delete(t.id)
      }
      this.tasks = this.tasks.filter((x) => x.id !== t.id)
      removed++
    }
    if (removed) {
      this.saveQueue()
      this.emit('queue-changed')
    }
    return removed
  }

  updateConfig(patch) {
    const next = { ...this.config, ...patch }
    next.minConcurrent = Math.max(1, Number(next.minConcurrent) || 1)
    next.maxConcurrent = Math.max(next.minConcurrent, Number(next.maxConcurrent) || 1)
    this.config = next
    this.saveConfig()
    this.refreshSystem()
    this.emit('queue-changed')
    return this.config
  }

  refreshSystem() {
    this.lastSystem = system.probe()
    this.concurrency = system.computeMaxConcurrent(this.lastSystem, this.config)
    return {
      system: this.lastSystem,
      concurrency: this.concurrency
    }
  }

  listTasks({ limit = 200 } = {}) {
    return [...this.tasks]
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, limit)
      .map((t) => this.publicTask(t))
  }

  publicTask(t) {
    const copy = { ...t }
    delete copy.proc
    delete copy.child
    return { ...copy, promptPreview: t.prompt.length > 160 ? t.prompt.slice(0, 160) + '…' : t.prompt }
  }

  /** Called by server/electron: try to promote ready tasks into running slots. */
  tick() {
    try {
      this.refreshSystem()
      const peak = this.nowPeak()
      let changed = false
      for (const t of this.tasks) {
        if (t.status === 'RUNNING') {
          if (peak && !t.allowPeak && this.config.interruptRunningAtPeak) {
            changed = true
            const originalId = t.id
            this.interruptTask(originalId, 'peak-pause')
            // Auto re-queue for the next OFF-PEAK window.
            const n = nextChangeInfo(Date.now(), this.schedule)
            this.tasks.push({
              id: `${originalId}@retry-${Date.now()}`,
              prompt: t.prompt,
              allowPeak: false,
              startAtMs: n ? Date.parse(n.iso) : Date.now() + 60_000,
              createdAt: Date.now(),
              status: 'PENDING',
              reason: 'peak-retry',
              attempts: t.attempts + 1,
              startedAt: null,
              endedAt: null,
              exitCode: null,
              logFile: null,
              sessionDir: null,
              error: null,
              parentId: originalId
            })
          }
          continue
        }
        const decision = decideTask({ ...t, peak, now: Date.now() })
        if (decision === 'suspend-peak') {
          if (t.status !== 'SUSPENDED') {
            t.status = 'SUSPENDED'
            t.reason = 'peak-window'
            changed = true
          }
          continue
        }
        if (decision === 'suspend-schedule') {
          if (t.status !== 'SUSPENDED') {
            t.status = 'SUSPENDED'
            t.reason = 'waiting-schedule'
            changed = true
          }
          continue
        }
        if (decision === 'ready' && this.running.size < this.concurrency.current) {
          this.launch(t)
          changed = true
        }
      }
      if (changed) this.saveQueue()
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
    // 附件提示词注记(文件已置于 taskDir\attachments\ 下,提示 agent 使用)
    let promptArg = t.prompt
    if (Array.isArray(t.attachments) && t.attachments.length) {
      const note =
        '\n\n附件:以下文件已上传到当前任务工作目录的 attachments\\ 子目录,请按需读取/处理:\n' +
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
      try {
        t.child?.logStream?.end()
      } catch {
        /* no-op */
      }
      if (t.status === 'RUNNING') {
        this.finish(t, code === 0 ? 'COMPLETED' : 'FAILED', code)
      }
    })
    this.emit('queue-changed')
  }

  finish(t, status, code = null) {
    t.status = status
    t.exitCode = code
    t.endedAt = Date.now()
    if (status === 'FAILED') {
      t.error = this.extractError(t.logFile, code)
    }
    this.running.delete(t.id)
    appendRecent({
      id: t.id,
      cwd: getActiveDir(t.id),
      status,
      model: null,
      createdAt: t.createdAt,
      endedAt: t.endedAt,
      durationMs: t.startedAt ? t.endedAt - t.startedAt : null,
      error: t.error ? { code: 'EXIT', message: t.error } : code ? { code: `EXIT_${code}`, message: `dsh exited ${code}` } : null,
      usage: null,
      costCny: null,
      estimated: false,
      source: 'queue'
    })
    this.saveQueue()
    this.emit('queue-changed')
    this.emit('task-terminal', {
      id: t.id,
      status,
      endedAt: t.endedAt,
      reason: t.reason || null,
      exitCode: code
    })
    // Try to fill the freed slot immediately.
    this.tick()
  }

  describe() {
    return {
      startedAt: this.startedAt,
      config: this.config,
      peak: this.peakInfo(),
      concurrency: this.concurrency,
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
    } catch {
      /* no log available */
    }
    return code == null ? null : { code: `EXIT_${code}`, message: `dsh exited with code ${code}` }
  }
}

module.exports = new SchedulerService()
