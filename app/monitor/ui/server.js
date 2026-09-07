'use strict'
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { PATHS, app } = require('../utils/paths')
const { loadProjectEnv } = require('../utils/env')
const { fetchBalance } = require('../deepseek/api')
const PricingRepository = require('../billing/pricing-repository')
const {
  statusAt,
  nextChangeInfo,
  buildTimeline,
  formatInZone
} = require('../billing/peak-engine')
const { calculateTaskCost } = require('../billing/cost-calculator')
const { listSessions } = require('../tracker/session-reader')
const { appendRecent, loadRecent } = require('../tracker/task-history')
const soundService = require('../notifications/sound-service')
const scheduler = require('../scheduler/scheduler')
const systemProbe = require('../scheduler/system')
const settingsService = require('../settings/settings-service')

loadProjectEnv()

const HOST = process.env.DSH_UI_HOST || app.ui?.host || '127.0.0.1'
// Requested port; if it is already taken the monitor automatically staggers
// upward (also covers headless `node app/monitor/ui/server.js` runs).
const PORT_REQUESTED = Number(process.env.DSH_UI_PORT) || app.ui?.port || 3300
let port = PORT_REQUESTED
let boundPort = null
const PUBLIC_DIR = path.join(__dirname, 'public')
const BALANCE_REFRESH_MS = app.ui?.balanceRefreshMs || 60000

const pricing = new PricingRepository()
const schedule = pricing.getSchedule()
let balanceCache = { fetchedAt: 0, value: null }
let dshProbe = { at: 0, alive: false }
let knownTasks = new Map()
let baselineReady = false
let bellSeq = 0
const bells = []
let started = false
let monitorTimer = null
let bellHook = null

function nowIso() {
  return new Date().toISOString()
}

function log(msg) {
  const ts = new Date().toISOString()
  const stamp = ts.slice(0, 10)
  try {
    fs.mkdirSync(path.join(PATHS.LOGS, 'app'), { recursive: true })
    fs.appendFileSync(path.join(PATHS.LOGS, 'app', `monitor-${stamp}.log`), `${ts} ${msg}\n`, 'utf8')
  } catch {
    /* log failure must never break the monitor */
  }
}

async function cachedBalance() {
  if (balanceCache.value && Date.now() - balanceCache.fetchedAt < BALANCE_REFRESH_MS) {
    return balanceCache.value
  }
  const value = await fetchBalance()
  balanceCache = { fetchedAt: Date.now(), value }
  if (!value.ok) log(`balance fetch failed: ${value.error?.code} ${value.error?.message}`)
  return value
}

async function probeDshWeb() {
  const dshHost = process.env.DSH_DSH_WEB_HOST || app.dshWeb?.host || '127.0.0.1'
  const dshPort = Number(process.env.DSH_DSH_WEB_PORT) || app.dshWeb?.port || 3080
  if (Date.now() - dshProbe.at < 5000) return dshProbe.alive
  dshProbe.at = Date.now()
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 1200)
    const res = await fetch(`http://${dshHost}:${dshPort}/`, { signal: controller.signal })
    clearTimeout(timer)
    dshProbe.alive = res.ok || res.status < 500
  } catch {
    dshProbe.alive = false
  }
  return dshProbe.alive
}

function describeTasks(limit = 12) {
  const sessions = listSessions({ limit: 200 })
  const out = []
  for (const s of sessions) {
    const cost =
      s.usage && (s.usage.inputTokens || s.usage.outputTokens || s.usage.cacheReadTokens)
        ? calculateTaskCost({
            events: s.usageEvents.map((u) => ({ time: u.time, ...u })),
            model: pricing.getModel(s.model),
            schedule
          })
        : null
    out.push({
      id: s.id,
      cwd: s.cwd,
      group: s.group,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      fileMtimeMs: s.fileMtimeMs,
      status: s.status,
      model: s.model,
      error: s.error,
      usage: s.usage,
      cost,
      durationMs: s.createdAt && s.updatedAt ? s.updatedAt - s.createdAt : null
    })
    if (out.length >= limit) break
  }
  return out
}

const TERMINAL = new Set(['COMPLETED', 'FAILED', 'INTERRUPTED'])

/**
 * Bell detection.
 *
 * Sources:
 *  1. terminal dsh sessions (foreground Web UI runs AND queue runs — both live
 *     under the same DSH_HOME\sessions because the queue shares the engine home)
 *  2. scheduler terminal events, as a fallback for queue tasks that end without
 *     producing a session file (dedup via the queue task id ack below)
 */
const QUEUE_ACTIVE_RE = /[\\/]active[\\/]([^\\/]+?)[\\/]?$/

function queueIdOf(cwd) {
  if (!cwd) return null
  const m = String(cwd).match(QUEUE_ACTIVE_RE)
  return m ? m[1] : null
}

// queueId -> { status, at } : terminal events the scheduler reported.
const queueEnded = new Map()
// queueId -> { status, at } : queue runs whose terminal state was already
// covered by a session-derived bell (matched through the per-task cwd).
const queueAck = new Map()

function noteQueueTerminal(info) {
  if (info && TERMINAL.has(info.status)) {
    queueEnded.set(info.id, { status: info.status, at: info.endedAt || Date.now() })
  }
}

/** Returns the bell events newly detected for terminal task states. */
function reconcileBells(tasks) {
  const now = Date.now()
  const seen = new Set()
  const produced = []
  for (const t of tasks) {
    seen.add(t.id)
    const prev = knownTasks.get(t.id)
    const fresh = t.updatedAt && now - t.updatedAt < 60_000
    knownTasks.set(t.id, { status: t.status, updatedAt: t.updatedAt, terminal: TERMINAL.has(t.status) })
    if (!TERMINAL.has(t.status)) continue
    if (!baselineReady) continue
    if (!prev && fresh) {
      produced.push(pushBell(t.status, t.id, t.updatedAt))
    } else if (prev && !TERMINAL.has(prev.status)) {
      produced.push(pushBell(t.status, t.id, t.updatedAt))
    }
  }
  for (const id of knownTasks.keys()) {
    if (!seen.has(id)) knownTasks.delete(id)
  }
  baselineReady = true
  return produced
}

function pushBell(event, taskId, at, extra = {}) {
  const id = ++bellSeq
  const item = { id, seq: id, event, taskId, at: at || Date.now(), ...extra }
  bells.push(item)
  if (bells.length > 200) bells.shift()
  log(`bell ${event} task=${taskId}`)
  try {
    if (bellHook) bellHook(item)
  } catch {
    /* a failing hook must never break the monitor */
  }
  return item
}

function setBellHook(fn) {
  bellHook = fn
}

function enrichTask(task) {
  const stale =
    task.status === 'RUNNING' && task.fileMtimeMs && Date.now() - task.fileMtimeMs > 90_000
  return {
    ...task,
    durationSeconds: task.durationMs != null ? task.durationMs / 1000 : null,
    estimated: task.cost?.estimated ?? false,
    costCny: task.cost?.costCny ?? 0,
    costLines: task.cost?.lines ?? [],
    current: false,
    stale
  }
}

function buildStatus(nowMs) {
  const tasks = describeTasks(12).map(enrichTask)
  const running = tasks.filter((t) => t.status === 'RUNNING' || t.status === 'STARTING')
  const activeTask = running[0] || (tasks.length ? tasks[0] : null)
  if (activeTask) activeTask.current = true
  const next = nextChangeInfo(nowMs, schedule)
  const nextTimeLabel = next ? formatInZone(Date.parse(next.iso), 'Asia/Shanghai', true) : null
  const nowBeijing = formatInZone(nowMs, 'Asia/Shanghai', true)
  return {
    generatedAt: nowMs,
    nowIso: nowIso(),
    local: {
      label: app.timezones?.localLabel || 'LOCAL',
      time: new Date(nowMs).toLocaleString('en-AU'),
      browserZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown'
    },
    billing: {
      label: app.timezones?.billingLabel || 'BILLING (Beijing)',
      timeZone: 'Asia/Shanghai',
      time: nowBeijing,
      status: statusAt(nowMs, schedule),
      nextChangeIso: next?.iso ?? null,
      nextChangeTime: nextTimeLabel,
      secondsLeft: next?.secondsLeft ?? null,
      statusAfter: next?.statusAfter ?? null
    },
    model: activeTask?.model || app.harness?.defaultModel || 'deepseek-v4-flash',
    balance: balanceCache.value,
    activeTask,
    taskCount: tasks.length,
    dshWebAlive: null, // resolved below with async probe
    pricesSource: pricing.describe()
  }
}

function buildPricingView() {
  const models = pricing.getModels()
  const now = Date.now()
  return {
    currency: 'CNY',
    models,
    schedule: {
      timeZone: 'Asia/Shanghai',
      peak: 'Mon-Fri 09:00-12:00 / 14:00-18:00 Beijing',
      weekend: 'all day OFF-PEAK'
    },
    source: pricing.describe()
  }
}

let timelineCache = { dayKey: null, value: null }
function buildTimelineView(nowMs) {
  const key = formatInZone(nowMs, 'Asia/Shanghai', true).slice(0, 5)
  if (timelineCache.dayKey !== key || !timelineCache.value) {
    const raw = buildTimeline(nowMs, schedule)
    const segments = raw.segments.map((s) => ({
      status: s.status,
      fromMs: s.fromMs,
      untilMs: s.untilMs,
      fromBeijing: formatInZone(s.fromMs, 'Asia/Shanghai', true).slice(0, 5),
      untilBeijing: formatInZone(s.untilMs, 'Asia/Shanghai', true).slice(0, 5)
    }))
    timelineCache = {
      dayKey: key,
      value: {
        timeZone: 'Asia/Shanghai',
        dateLabel: new Date(raw.dayStartMs).toISOString(),
        segments
      }
    }
  }
  return timelineCache.value
}

async function handleApi(req, res, url) {
  const now = Date.now()
  if (url.pathname === '/api/health') {
    return json(res, { ok: true, time: nowIso() })
  }
  if (url.pathname === '/api/status') {
    const status = buildStatus(now)
    status.dshWebAlive = await probeDshWeb()
    status.balance = await cachedBalance()
    return json(res, status)
  }
  if (url.pathname === '/api/tasks') {
    const sessionTasks = describeTasks(100).map(enrichTask)
    const history = loadRecent()
    const seen = new Set()
    const merged = []
    for (const item of history) {
      seen.add(item.id)
      merged.push(item)
    }
    for (const item of sessionTasks) {
      if (!seen.has(item.id)) merged.push(item)
    }
    merged.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    return json(res, { tasks: merged.slice(0, 50) })
  }
  if (url.pathname === '/api/pricing') {
    return json(res, buildPricingView())
  }
  if (url.pathname === '/api/timeline') {
    return json(res, buildTimelineView(now))
  }
  if (url.pathname === '/api/bells') {
    const after = Number(url.searchParams.get('after') || 0)
    const fresh = bells.filter((b) => b.seq > after)
    return json(res, { bells: fresh, latest: bells.length ? bells[bells.length - 1].seq : 0 })
  }
  if (url.pathname === '/api/sounds') {
    if (req.method === 'POST') {
      const body = await readBody(req)
      try {
        const rec = soundService.saveUpload(String(body.name || 'ringtone.wav'), Buffer.from(String(body.data || ''), 'base64'))
        return json(res, { ok: true, file: rec }, 201)
      } catch (err) {
        return json(res, { ok: false, error: String(err?.message || err) }, 400)
      }
    }
    return json(res, { ok: true, sounds: soundService.describeSounds(), files: soundService.listSoundFiles() })
  }
  if (url.pathname === '/api/settings') {
    if (req.method === 'POST') {
      const body = await readBody(req)
      try {
        const envPatch = {}
        if (body.clearKey) envPatch.DEEPSEEK_API_KEY = ''
        else if (typeof body.apiKey === 'string' && body.apiKey.trim()) envPatch.DEEPSEEK_API_KEY = body.apiKey.trim()
        if (body.telemetryMode) envPatch.DSH_TELEMETRY_MODE = body.telemetryMode
        if (body.permissionMode) envPatch.DSH_PERMISSION_MODE = body.permissionMode
        if (Object.keys(envPatch).length) settingsService.writeEnvFile(envPatch)
        settingsService.applyPatch({
          model: typeof body.defaultModel === 'string' && body.defaultModel ? body.defaultModel : undefined,
          soundEnabled: typeof body.soundEnabled === 'boolean' ? body.soundEnabled : undefined,
          sound: body.sound && typeof body.sound === 'object' ? body.sound : undefined
        })
        return json(res, { ok: true, settings: settingsService.publicSettings() })
      } catch (err) {
        return json(res, { ok: false, error: String(err?.message || err) }, 400)
      }
    }
    return json(res, { ok: true, settings: settingsService.publicSettings(), schedulerConfig: scheduler.config })
  }
  if (url.pathname === '/api/system') {
    return json(res, scheduler.refreshSystem())
  }
  if (url.pathname === '/api/queue') {
    if (req.method === 'POST') {
      const body = await readBody(req)
      try {
        const task = scheduler.addTask({
          prompt: body.prompt,
          allowPeak: body.allowPeak,
          startAt: body.startAt || null,
          taskId: body.taskId || null
        })
        return json(res, { ok: true, task: scheduler.publicTask(task) }, 201)
      } catch (err) {
        return json(res, { ok: false, error: String(err?.message || err) }, 400)
      }
    }
    const sessions = listSessions({ limit: 500 })
    const tasks = scheduler.listTasks().map((t) => {
      const needle = String(t.id).toLowerCase()
      const match = sessions.find((s) => s.group && s.group.toLowerCase().includes(needle) && s.assistantText)
      return match ? { ...t, assistantText: match.assistantText, sessionStatus: match.status } : t
    })
    return json(res, { tasks, scheduler: scheduler.describe() })
  }
  if (url.pathname === '/api/queue/clear' && req.method === 'POST') {
    const cleared = scheduler.clearPending()
    return json(res, { ok: true, cleared })
  }
  if (url.pathname.startsWith('/api/queue/') && url.pathname.endsWith('/cancel') && req.method === 'POST') {
    const id = decodeURIComponent(url.pathname.slice('/api/queue/'.length, -'/cancel'.length))
    const task = scheduler.cancelTask(id)
    return task ? json(res, { ok: true, task: scheduler.publicTask(task) }) : json(res, { ok: false, error: 'task not found' }, 404)
  }
  if (url.pathname === '/api/queue/config' && req.method === 'POST') {
    const body = await readBody(req)
    const config = scheduler.updateConfig(body)
    return json(res, { ok: true, config })
  }
  if (url.pathname === '/api/queue/config') {
    return json(res, { config: scheduler.config })
  }
  return notFound(res)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > 14 * 1024 * 1024) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve(text ? JSON.parse(text) : {})
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

function serveStatic(res, urlPath) {
  let rel = decodeURIComponent(urlPath)
  if (rel === '/') rel = '/index.html'
  const target = path.resolve(PUBLIC_DIR, '.' + rel)
  if (!target.startsWith(PUBLIC_DIR + path.sep) && target !== PUBLIC_DIR) {
    return notFound(res)
  }
  fs.readFile(target, (err, data) => {
    if (err) return notFound(res)
    res.writeHead(200, {
      'Content-Type': contentType(target),
      'Cache-Control': 'no-cache'
    })
    res.end(data)
  })
}

function serveSound(res, urlPath) {
  let name
  try {
    name = decodeURIComponent(path.basename(urlPath))
  } catch {
    return notFound(res)
  }
  const known = new Set(soundService.listSoundFiles().map((f) => f.name))
  if (!soundService.validFileName(name) || !known.has(name)) return notFound(res)
  const presetsDir = path.join(PATHS.SOUNDS, name)
  const file = fs.existsSync(presetsDir) ? presetsDir : path.join(PATHS.USER_SOUNDS, name)
  fs.readFile(file, (err, data) => {
    if (err) return notFound(res)
    res.writeHead(200, { 'Content-Type': soundContentType(file), 'Cache-Control': 'no-store' })
    res.end(data)
  })
}

function soundContentType(file) {
  return path.extname(file).toLowerCase() === '.mp3' ? 'audio/mpeg' : 'audio/wav'
}

function contentType(file) {
  const ext = path.extname(file).toLowerCase()
  return {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg'
  }[ext] || 'application/octet-stream'
}

function json(res, value, status = 200) {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(body)
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end('not found')
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url)
      return
    }
    if (url.pathname.startsWith('/sounds/')) {
      serveSound(res, url.pathname)
      return
    }
    serveStatic(res, url.pathname)
  } catch (err) {
    log(`request error: ${err?.stack || err}`)
    try {
      res.writeHead(500, { 'Content-Type': 'text/plain' })
      res.end('internal error')
    } catch {
      /* no-op */
    }
  }
})

function attemptListen() {
  server.once('error', function onListenError(err) {
    if (err && err.code === 'EADDRINUSE' && port < PORT_REQUESTED + 25) {
      port += 1
      log(`端口 ${port - 1} 被占用,自动错开到 ${port}`)
      console.log(`Monitor 端口 ${port - 1} 被占用,自动错开到 ${port}`)
      attemptListen()
      return
    }
    log(`monitor listen failed: ${err?.stack || err}`)
    console.error(`Monitor 端口 ${port} 监听失败: ${err?.message || err}`)
    throw err
  })
  server.listen(port, HOST, () => {
    boundPort = port
    log(`monitor listening on http://${HOST}:${boundPort}`)
    console.log(`DeepSeek Harness Monitor: http://${HOST}:${boundPort}`)
  })
}

function getBoundPort() {
  return boundPort
}

function startServer() {
  if (started) return server
  started = true
  scheduler.start()
  scheduler.on('task-terminal', noteQueueTerminal)
  monitorTimer = setInterval(() => {
    try {
      const tasks = describeTasks(100).map(enrichTask)
      const produced = reconcileBells(tasks)
      const ackNow = Date.now()
      for (const t of tasks) {
        if (t.status === 'COMPLETED' || t.status === 'FAILED' || t.status === 'INTERRUPTED') {
          const bell = produced.find((b) => b.taskId === t.id)
          if (bell) {
            appendRecent(
              {
                id: t.id,
                cwd: t.cwd,
                status: t.status,
                model: t.model,
                createdAt: t.createdAt,
                endedAt: t.updatedAt,
                durationMs: t.durationMs,
                error: t.error,
                usage: t.usage,
                costCny: t.costCny,
                estimated: t.estimated
              },
              app.taskHistory?.maxEntries || 50
            )
            const qid = queueIdOf(t.cwd)
            if (qid) queueAck.set(qid, { status: bell.event, at: ackNow })
          }
        }
      }
      // Queue-task fallback: ring queue terminal events whose run produced no
      // session file (after a settle window), unless already acked above.
      for (const [qid, info] of queueEnded) {
        if (ackNow - info.at < 8000) continue
        queueEnded.delete(qid)
        if (!queueAck.has(qid)) pushBell(info.status, qid, info.at)
      }
      for (const [qid, rec] of queueAck) {
        if (ackNow - rec.at > 120_000) queueAck.delete(qid)
      }
    } catch (err) {
      log(`task reconciliation error: ${err?.stack || err}`)
    }
  }, 3000)
  attemptListen()
  return server
}

function stopServer() {
  if (!started) return
  started = false
  if (monitorTimer) clearInterval(monitorTimer)
  monitorTimer = null
  scheduler.off('task-terminal', noteQueueTerminal)
  scheduler.stop()
  server.close()
}

if (require.main === module) {
  startServer()
}

module.exports = { server, startServer, stopServer, scheduler, setBellHook, pushBell, queueIdOf, getBoundPort }
