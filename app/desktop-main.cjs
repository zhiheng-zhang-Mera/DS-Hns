'use strict'
/**
 * DS-Harness desktop shell — Alien-derived canonical core.
 *
 * The official @deepseek-ai/dsh Web UI and optional Mega dock are rendered as
 * sibling WebContentsViews inside one native BrowserWindow when the integrated
 * dock is enabled. This keeps the official renderer untouched while reserving
 * real layout width for Mega instead of overlaying it.
 */
const { app, BrowserWindow, WebContentsView, dialog, shell, ipcMain, Tray, Menu, nativeImage, screen, Notification } = require('electron')
const { spawn, spawnSync } = require('node:child_process')
const http = require('node:http')
const net = require('node:net')
const path = require('node:path')
const fs = require('node:fs')
const runtimeProcess = require('./runtime-process.cjs')
const { WorkerManager } = require('./sub-worker/manager.cjs')
const { createOfficialSurfaceViews, SURFACE, PAINTABLE } = require('./official-surface-views.cjs')
const frontendMode = require('./frontend-mode/index.cjs')

const ROOT = path.resolve(__dirname, '..')
const HARNESS_HOST = '127.0.0.1'
/**
 * Canonical Harness port. `DSH_HARNESS_PORT` is an additive opt-in for isolated
 * runs: it lets a second DS-Harness instance (a scratch checkout, an acceptance
 * run) start beside the normal one instead of colliding on 3080. Unset, nothing
 * changes — the default launch line, the port and the startup check are identical.
 */
/** Raw opt-in value, read once. */
const HARNESS_PORT_RAW = Number(process.env.DSH_HARNESS_PORT)
const HARNESS_PORT = normalizeHarnessPort(HARNESS_PORT_RAW)
/** Only an explicit, usable port counts as an override. */
const HARNESS_PORT_OVERRIDE = Number.isInteger(HARNESS_PORT_RAW) && HARNESS_PORT_RAW === HARNESS_PORT
const HARNESS_URL = `http://${HARNESS_HOST}:${HARNESS_PORT}/`
/**
 * Arguments for the managed Harness child. The fixed prefix is the canonical
 * launch line; `--port` is appended only when the port was explicitly overridden,
 * so the default line stays byte-identical.
 */
const DSH_LAUNCH_ARGS = ['web', '--no-open', ...(HARNESS_PORT_OVERRIDE ? ['--port', String(HARNESS_PORT)] : [])]
const DSH_ENTRY = path.join(__dirname, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const STARTUP_TIMEOUT_MS = Number(process.env.DSH_STARTUP_TIMEOUT_MS || 120_000)
const STARTUP_BUFFER_LIMIT = 64 * 1024
const INTEGRATED_MEGA_DOCK = process.env.DSH_MEGA_INTEGRATED_DOCK !== '0'
const MEGA_DOCK_COLLAPSED_WIDTH = 48
const MEGA_DOCK_DEFAULT_WIDTH = 560
const MEGA_DOCK_MIN_WIDTH = 440
const MEGA_DOCK_MAX_WIDTH = 720
const OFFICIAL_VIEW_MIN_WIDTH = 360
/**
 * The official Overlay (Update-Plan/Dual-UI.md 任务 1).
 *
 * DEPRECATED and DISABLED by default. The overlay was the previous official
 * theming architecture; Dual-UI replaces it with the native frontend, so the
 * product no longer stacks a transparent view above the official renderer. The
 * code is kept (and the module still supports it) behind an explicit opt-in so
 * an old theme package can still be inspected, but nothing creates it unless
 * DSH_OFFICIAL_OVERLAY=1 is set on purpose.
 */
const OFFICIAL_OVERLAY_ENABLED = process.env.DSH_OFFICIAL_OVERLAY === '1'
/** The native frontend is the Daily Mode surface; a window narrower than this
 * would clip its sidebar, so Daily falls back to Work Mode instead of squeezing. */
const NATIVE_VIEW_MIN_WIDTH = 720

/** Accept only a real usable port; anything else silently keeps the default. */
function normalizeHarnessPort(value) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) return 3080
  return parsed
}

let mainWindow = null
let officialView = null
let nativeView = null
let megaDockView = null
let officialSurfaces = null
/** The assembled Dual-UI runtime (state + adapter + sync + manager + probe). */
let frontendModes = null
let megaDockExpanded = false
/**
 * Whether the Mega dock was expanded when Work Mode was entered.
 *
 * Work Mode must show the official UI at the width it was designed for; the dock
 * reserves 560px of the window, which is enough to make the official UI drop its
 * own session sidebar. Entering Work therefore collapses the dock to its rail and
 * remembers what the user had, so returning to Daily restores it. Expanding the
 * dock manually while in Work Mode is the user's explicit choice and is honoured
 * until the next mode switch.
 */
let megaDockExpandedBeforeWork = null
let megaDockWidth = MEGA_DOCK_DEFAULT_WIDTH
let harnessProcess = null
let shuttingDown = false
let harnessUrl = null
let resolveHarnessUrl = null
let rejectHarnessUrl = null
let extensionManager = null
let startupOutput = ''
/** Extension callbacks registered through `ctx.onDockReady` (see the adapter). */
const dockReadyCallbacks = []
/**
 * Optional Sub-worker execution layer. The manager object is created during
 * startup, but NOTHING is spawned until the user enables the worker (or the
 * persisted config asks for it): the default DS-Harness experience stays
 * unchanged, with no extra process, no extra port and no extra data directory.
 */
let workerManager = null
const subWorkerListeners = new Set()

/** IPC surface of the Sub-worker panel/Live View (plan §11, §12, §28). */
const SUB_WORKER_CHANNELS = [
  'sub-worker:snapshot',
  'sub-worker:start',
  'sub-worker:stop',
  'sub-worker:restart',
  'sub-worker:pause',
  'sub-worker:resume',
  'sub-worker:cancel-task',
  'sub-worker:assign-task',
  'sub-worker:send-note',
  'sub-worker:take-over',
  'sub-worker:clear-handoff',
  'sub-worker:resume-last',
  'sub-worker:update-config',
  'sub-worker:live-view',
  'sub-worker:read-log',
  'sub-worker:pick-target-repo',
  'sub-worker:release-worktree',
  // Adaptive multi-worker surface (Update-Plan/multi-sub.md).
  'sub-worker:submit-plan',
  'sub-worker:resource-config',
  'sub-worker:tick',
  'sub-worker:plans'
]

/**
 * Compatibility alias for machines that already store the DeepSeek API key as
 * DeepSeek_API. The official DSH process receives the canonical
 * DEEPSEEK_API_KEY name, while the user's system environment is left untouched.
 */
function normalizeApiKeyEnv() {
  if (process.env.DEEPSEEK_API_KEY) return
  const aliasName = Object.keys(process.env).find((key) => key.toUpperCase() === 'DEEPSEEK_API')
  if (!aliasName) return
  const value = String(process.env[aliasName] || '').trim()
  if (value) process.env.DEEPSEEK_API_KEY = value
}

/**
 * Load project-local config without ever overriding an existing process/system
 * environment variable. This keeps system DEEPSEEK_API_KEY (or DeepSeek_API
 * after alias normalization) highest priority while making config/.env work
 * even when Electron is launched directly from a shortcut.
 */
function loadProjectEnv() {
  const file = path.join(ROOT, 'config', '.env')
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch { return }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (!value || value === 'sk-...' || value === 'YOUR_API_KEY' || value === 'YOUR_DEEPSEEK_API_KEY') continue
    if (!process.env[key]) process.env[key] = value
  }
}

normalizeApiKeyEnv()
loadProjectEnv()
process.env.DSH_ROOT = process.env.DSH_ROOT || ROOT
process.env.DSH_HOME = process.env.DSH_HOME || path.join(ROOT, 'data')
// Mega is rendered inside the native main window. Disable the legacy companion
// BrowserWindow so there is only one top-level DS-Harness window.
if (INTEGRATED_MEGA_DOCK) process.env.DSH_MEGA_DOCK = '0'
/**
 * Instance identity. Electron's single-instance lock lives in the userData
 * directory, so a second, isolated instance needs its own: `DSH_USER_DATA_DIR`
 * names it outright, and a `DSH_ROOT` pointing at another checkout (or a run
 * named through `DSH_APP_NAME`) derives one under that root. Unset, the shell is
 * "DS-Harness" under `<root>/data/desktop-shell` and behaves exactly as before.
 */
const APP_NAME_OVERRIDE = String(process.env.DSH_APP_NAME || '').trim()
const ISOLATED_ROOT = Boolean(process.env.DSH_ROOT) && path.resolve(process.env.DSH_ROOT) !== ROOT
const APP_NAME = APP_NAME_OVERRIDE || (ISOLATED_ROOT ? `DS-Harness (${path.basename(process.env.DSH_ROOT) || 'isolated'})` : 'DS-Harness')
const ISOLATED_INSTANCE = Boolean(APP_NAME_OVERRIDE) || ISOLATED_ROOT
/** A filesystem-safe profile name so several isolated runs cannot share a lock. */
const PROFILE_SLUG = (APP_NAME_OVERRIDE || path.basename(process.env.DSH_ROOT) || 'isolated').replace(/[^\w.-]+/g, '-')
app.setName(APP_NAME)
app.setPath(
  'userData',
  process.env.DSH_USER_DATA_DIR
    ? path.resolve(process.env.DSH_USER_DATA_DIR)
    : path.join(process.env.DSH_ROOT, 'data', ISOLATED_INSTANCE ? `desktop-shell-${PROFILE_SLUG}` : 'desktop-shell')
)
// Windows needs an explicit AppUserModelID so terminal task notifications and
// taskbar grouping carry the DS-Harness identity instead of Electron's.
try {
  if (typeof app.setAppUserModelId === 'function') app.setAppUserModelId('com.dsharness.desktop')
} catch {}

/**
 * Launcher icon resolution. `assets\icon\ds-harness.ico` is generated from the
 * repository-root icon.jpg (scripts\ensure-icon.ps1); a missing or broken icon
 * may only degrade to the platform default icon - it must never stop the shell
 * from starting.
 */
function resolveAppIcon() {
  try {
    const ico = path.join(ROOT, 'assets', 'icon', 'ds-harness.ico')
    return fs.existsSync(ico) ? ico : undefined
  } catch {
    return undefined
  }
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) app.quit()

function logPath() {
  return path.join(ROOT, 'logs', 'desktop-runtime.log')
}

function logLine(message) {
  try {
    fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true })
    fs.appendFileSync(logPath(), `${new Date().toISOString()} ${String(message)}\n`, 'utf8')
  } catch {}
}

function redact(text) {
  return String(text).replace(/(\?token=)[^\s)\]]+/gi, '$1[REDACTED]')
}

function stripAnsi(text) {
  return String(text).replace(/\x1B(?:[@-_][0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g, '')
}

function readLogTail(maxLines = 50) {
  try {
    const text = fs.readFileSync(logPath(), 'utf8')
    return text.split(/\r?\n/).slice(-maxLines).join('\n').trim()
  } catch {
    return ''
  }
}

function startupError(message) {
  const tail = readLogTail()
  const suffix = tail ? `\n\n--- desktop-runtime.log (tail) ---\n${tail}` : ''
  return new Error(`${message}${suffix}`)
}

function resolveNodeExe() {
  if (process.env.DSH_NODE_EXE && fs.existsSync(process.env.DSH_NODE_EXE)) return process.env.DSH_NODE_EXE
  const runtimeDir = path.join(ROOT, 'runtime')
  const candidates = []
  if (fs.existsSync(runtimeDir)) {
    for (const entry of fs.readdirSync(runtimeDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const exe = path.join(runtimeDir, entry.name, 'node.exe')
      if (fs.existsSync(exe)) candidates.push(exe)
    }
  }
  if (candidates.length) {
    candidates.sort()
    return candidates[candidates.length - 1]
  }
  return 'node'
}

function ensureRuntimeDirs() {
  for (const dir of ['logs', 'temp', 'cache', 'data', 'workspace', 'runtime']) {
    fs.mkdirSync(path.join(ROOT, dir), { recursive: true })
  }
}

/**
 * Detect ANY listener on the canonical Harness TCP port. This intentionally
 * does not use HTTP status because DSH 0.1.2+ returns 401 at bare `/` until
 * the launch token/cookie exchange has completed.
 */
function isHarnessPortListening() {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: HARNESS_HOST, port: HARNESS_PORT })
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(1200)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

function requestHarness(url) {
  return new Promise((resolve) => {
    const request = http.get(url, { timeout: 1500 }, (response) => {
      response.resume()
      resolve(response.statusCode >= 200 && response.statusCode < 400)
    })
    request.on('timeout', () => request.destroy())
    request.on('error', () => resolve(false))
  })
}

function allowedHarnessNavigation(rawUrl) {
  try {
    const parsed = new URL(rawUrl)
    const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost'
    return loopback && Number(parsed.port || 80) === HARNESS_PORT && parsed.protocol === 'http:'
  } catch {
    return false
  }
}

function observeStartupOutput(source, chunk, log) {
  const raw = chunk.toString()
  log.write(`[${source}] ${redact(raw)}`)

  const clean = stripAnsi(raw)
  startupOutput = `${startupOutput}${clean}`.slice(-STARTUP_BUFFER_LIMIT)

  const match = startupOutput.match(/https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/\?token=[^\s)\]"']+/i)
  if (match && !harnessUrl) {
    harnessUrl = match[0]
    log.write(`\n[desktop] captured authenticated Harness URL on ${source}\n`)
    resolveHarnessUrl(harnessUrl)
  }
}

async function waitForHarness() {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (harnessUrl && await requestHarness(harnessUrl)) return harnessUrl
    if (harnessProcess?.exitCode !== null) {
      throw startupError(`Harness service exited early with code ${harnessProcess.exitCode}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  throw startupError(`Harness service did not become ready within ${STARTUP_TIMEOUT_MS / 1000} seconds`)
}

function startHarness(nodeExe) {
  const urlPromise = new Promise((resolve, reject) => {
    resolveHarnessUrl = resolve
    rejectHarnessUrl = reject
  })
  ensureRuntimeDirs()
  startupOutput = ''
  harnessUrl = null

  logLine('--- DSH launch begin ---')
  logLine(`node=${nodeExe}`)
  logLine(`entry=${DSH_ENTRY}`)
  logLine(`cwd=${ROOT}`)
  logLine(`DSH_HOME=${path.join(ROOT, 'data')}`)
  logLine(`apiKeyConfigured=${Boolean(process.env.DEEPSEEK_API_KEY)}`)

  // The fixed prefix is the canonical launch line; `--port` is appended only when
  // the port was explicitly overridden, so the default line stays byte-identical.
  harnessProcess = spawn(nodeExe, [DSH_ENTRY, ...DSH_LAUNCH_ARGS], {
    cwd: ROOT,
    env: {
      ...process.env,
      DSH_ROOT: ROOT,
      DSH_HOME: path.join(ROOT, 'data'),
      DSH_NODE: nodeExe,
      npm_config_cache: path.join(ROOT, 'cache', 'npm'),
      TEMP: path.join(ROOT, 'temp'),
      TMP: path.join(ROOT, 'temp'),
      PATH: `${path.dirname(nodeExe)};${process.env.PATH || ''}`
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })

  const childPid = harnessProcess.pid
  runtimeProcess.writeOwnership({ root: ROOT, dshEntry: DSH_ENTRY, childPid, parentPid: process.pid })
  logLine(`ownership childPid=${childPid} parentPid=${process.pid}`)

  const log = fs.createWriteStream(logPath(), { flags: 'a' })
  harnessProcess.stdout.on('data', (chunk) => observeStartupOutput('stdout', chunk, log))
  harnessProcess.stderr.on('data', (chunk) => observeStartupOutput('stderr', chunk, log))
  harnessProcess.once('error', (error) => {
    runtimeProcess.clearOwnership({ root: ROOT, childPid })
    log.write(`\n[desktop] ${error.stack || error}\n`)
    rejectHarnessUrl(startupError(`Could not spawn Harness process: ${error.message || error}`))
  })
  harnessProcess.once('exit', (code, signal) => {
    runtimeProcess.clearOwnership({ root: ROOT, childPid })
    log.write(`\n[desktop] Harness process exit code=${code} signal=${signal || ''}\n`)
    if (!harnessUrl) rejectHarnessUrl(startupError(`Harness service exited before announcing its access URL (code ${code})`))
  })
  return urlPromise
}

function stopHarness() {
  const childPid = harnessProcess?.pid
  if (harnessProcess && harnessProcess.exitCode === null) {
    if (process.platform === 'win32') {
      spawnSync('taskkill.exe', ['/pid', String(childPid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } else {
      harnessProcess.kill('SIGTERM')
    }
  }
  if (childPid) runtimeProcess.clearOwnership({ root: ROOT, childPid })
}

/**
 * Sub-worker status fan-out. The Mega extension subscribes here so the dock and
 * the tray always reflect the worker's real state instead of polling it.
 */
function subscribeSubWorker(listener) {
  if (typeof listener !== 'function') return () => {}
  subWorkerListeners.add(listener)
  return () => subWorkerListeners.delete(listener)
}

function notifySubWorkerChange(event) {
  for (const listener of [...subWorkerListeners]) {
    try {
      listener(event)
    } catch (error) {
      logLine(`sub-worker listener failed: ${error?.message || error}`)
    }
  }
  maybeNotifySubWorker(event)
}

/** Desktop notification for a finished/crashed worker task. */
function maybeNotifySubWorker(event) {
  if (!workerManager || !event || event.type !== 'notification') return
  const config = workerManager.describe().config || {}
  if (config.showNotifications === false) return
  try {
    if (typeof Notification?.isSupported === 'function' && !Notification.isSupported()) return
    const notification = new Notification({
      title: String(event.notification?.title || 'Sub-worker'),
      body: String(event.notification?.body || ''),
      silent: false
    })
    notification.on('click', () => {
      try {
        if (mainWindow && !mainWindow.isDestroyed()) {
          if (mainWindow.isMinimized()) mainWindow.restore()
          mainWindow.show()
          mainWindow.focus()
        }
      } catch {}
    })
    notification.show()
  } catch (error) {
    logLine(`sub-worker notification failed: ${error?.message || error}`)
  }
}

/**
 * Create the Sub-worker manager and reclaim any worker orphaned by a previous
 * shell that was killed outright. Creating the manager is inert: no process is
 * spawned here.
 */
async function createWorkerManager(nodeExe) {
  workerManager = new WorkerManager({
    root: ROOT,
    nodeExe,
    runtimeProcess,
    log: logLine,
    notify: notifySubWorkerChange
  })
  workerManager.hydrate()
  const recovery = await runtimeProcess.recoverStaleWorker({
    root: ROOT,
    entry: path.join(__dirname, 'sub-worker', 'runtime.cjs'),
    log: logLine
  })
  if (recovery.killed) logLine(`reclaimed an orphaned sub-worker process (pid ${recovery.childPid})`)
  logLine(`sub-worker manager ready; state=${workerManager.describe().state} enabledOnStartup=${workerManager.describe().config.enabledOnStartup}`)
  registerSubWorkerIpc()
  return workerManager
}

/**
 * Pause -> flush -> terminate the worker process tree -> persist history. Used
 * by both exit paths, and it must never be able to block the exit.
 */
function stopSubWorkerOnExit(source = 'shell') {
  if (!workerManager) return null
  try {
    // `prepareExit` pauses a busy worker and flushes state/queue synchronously;
    // awaiting it here could stall app.exit(), which is never acceptable.
    workerManager.prepareExit()
  } catch (error) {
    logLine(`sub-worker flush before exit failed: ${error?.message || error}`)
  }
  try {
    const result = workerManager.forceStop(source)
    logLine(`sub-worker terminated for exit (${source})`)
    return result
  } catch (error) {
    logLine(`sub-worker stop failed during exit: ${error?.message || error}`)
    return null
  }
}

/**
 * Every Sub-worker IPC handler is failure isolated: a worker problem is
 * reported as data, never as a rejected main-process promise.
 */
function registerSubWorkerIpc() {
  for (const channel of SUB_WORKER_CHANNELS) {
    try {
      ipcMain.removeHandler(channel)
    } catch {}
  }
  const guard = (handler) => async (event, ...args) => {
    try {
      return await handler(event, ...args)
    } catch (error) {
      logLine(`sub-worker ipc failed: ${error?.stack || error}`)
      return { ok: false, error: String(error?.message || error) }
    }
  }

  ipcMain.handle('sub-worker:snapshot', guard(() => workerManager.describe()))
  ipcMain.handle('sub-worker:start', guard(() => workerManager.start({ reason: 'panel' })))
  ipcMain.handle('sub-worker:stop', guard(async () => {
    const result = await workerManager.stop({ reason: 'panel' })
    notifySubWorkerChange({ type: 'state_changed', summary: 'Sub-worker stopped from the panel' })
    return result
  }))
  ipcMain.handle('sub-worker:restart', guard(async () => {
    const result = await workerManager.restart({ reason: 'panel' })
    notifySubWorkerChange({ type: 'state_changed', summary: 'Sub-worker restarted from the panel' })
    return result
  }))
  ipcMain.handle('sub-worker:pause', guard((_event, reason) => workerManager.pause(reason || 'paused from Mega')))
  ipcMain.handle('sub-worker:resume', guard((_event, reason) => workerManager.resume(reason || 'resumed from Mega')))
  ipcMain.handle('sub-worker:cancel-task', guard((_event, reason) => workerManager.cancelTask(reason || 'cancelled from Mega')))
  ipcMain.handle('sub-worker:assign-task', guard((_event, task) => workerManager.assignTask(task || {})))
  ipcMain.handle('sub-worker:send-note', guard((_event, note) => workerManager.sendNote(note)))
  ipcMain.handle('sub-worker:take-over', guard(async (_event, reason) => {
    const result = await workerManager.takeOver({ reason: reason || 'user take over' })
    notifySubWorkerChange({ type: 'state_changed', summary: 'Workspace handed over to the Controller' })
    return result
  }))
  ipcMain.handle('sub-worker:clear-handoff', guard(() => workerManager.clearHandoff()))
  ipcMain.handle('sub-worker:resume-last', guard(() => workerManager.resumeLastTask()))
  ipcMain.handle('sub-worker:update-config', guard((_event, patch) => {
    const next = workerManager.updateConfig(patch || {})
    notifySubWorkerChange({ type: 'state_changed', summary: 'Sub-worker configuration updated' })
    return next
  }))
  ipcMain.handle('sub-worker:live-view', guard((_event, taskId) => workerManager.liveViewFor(taskId || null)))
  ipcMain.handle('sub-worker:read-log', guard((_event, taskId) => workerManager.readTaskLog(taskId)))
  ipcMain.handle('sub-worker:pick-target-repo', guard(async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择 Sub-worker 目标仓库',
      properties: ['openDirectory']
    })
    if (result.canceled || !result.filePaths.length) return null
    return result.filePaths[0]
  }))
  // Releasing the isolated worktree is an explicit Controller action: the
  // worktree normally holds the deliverable that is being reviewed.
  ipcMain.handle('sub-worker:release-worktree', guard((_event, targetRepo, options) => {
    const result = workerManager.releaseWorktree(targetRepo, options || {})
    notifySubWorkerChange({ type: 'state_changed', summary: 'Sub-worker worktree release requested' })
    return result
  }))
  // Adaptive multi-worker surface: a plan is a DAG the scheduler parallelises.
  ipcMain.handle('sub-worker:submit-plan', guard((_event, plan, options) => workerManager.submitPlan(plan || {}, options || {})))
  ipcMain.handle('sub-worker:plans', guard(() => workerManager.describe().plans))
  ipcMain.handle('sub-worker:resource-config', guard((_event, patch) => {
    // Resource keys live beside the subWorker keys in the persisted config and
    // are resolved by resource-config.cjs, so one update path covers both.
    const next = workerManager.updateConfig({ ...(patch || {}) })
    notifySubWorkerChange({ type: 'state_changed', summary: 'Sub-worker resource configuration updated' })
    return { config: next, resources: workerManager.resourceConfig, source: workerManager.resourceConfigSource }
  }))
  // One scheduler loop on demand: sample → scale → dispatch (multi-sub.md §42).
  ipcMain.handle('sub-worker:tick', guard(() => {
    const decision = workerManager.tick({ force: true })
    notifySubWorkerChange({ type: 'state_changed', summary: 'Sub-worker scheduler ticked' })
    return {
      state: decision?.state || null,
      desired: decision?.desired ?? null,
      direction: decision?.direction || null,
      reason: decision?.reason || null
    }
  }))
  logLine(`sub-worker IPC registered (${SUB_WORKER_CHANNELS.length} channels)`)
}

/**
 * Shared teardown for every exit path: stop the extension (which stops the
 * scheduler and persists the queue/history), pause+flush+terminate the optional
 * Sub-worker, drop the integrated views, and terminate the managed Harness
 * child tree.
 *
 * Order matters (plan §25): state is persisted by the extension stop, then the
 * worker is paused/flushed and its process tree is terminated, and only then is
 * the managed Harness stopped.
 */
function teardownManagedResources({ destroyWindows = false } = {}) {
  try {
    ipcMain.removeAllListeners('mega-shell:dock-state')
  } catch {}
  try {
    extensionManager?.stop?.()
  } catch (error) {
    logLine(`extension stop failed during exit: ${error?.message || error}`)
  }
  stopSubWorkerOnExit('shell teardown')
  try {
    destroyIntegratedViews()
  } catch {}
  if (destroyWindows) {
    try {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy()
    } catch {}
  }
  try {
    stopHarness()
  } catch {}
}

/**
 * Normal exit (tray "Exit DS-Harness"):
 *   stop scheduler -> stop extensions -> flush/persist state -> stop the
 *   managed Harness -> destroy windows/tray -> app.quit()
 * The extension stop is what persists the scheduler queue and history, so it
 * runs before the managed Harness child is terminated.
 */
function gracefulExit(source = 'shell') {
  if (shuttingDown) return
  shuttingDown = true
  logLine(`graceful exit requested (${source})`)
  teardownManagedResources({ destroyWindows: true })
  app.quit()
}

/**
 * Force exit (tray "Force Exit DS-Harness"):
 *   mark shutting down -> best-effort flush -> kill the managed child process
 *   tree -> destroy extension/runtime resources -> destroy windows/tray ->
 *   app.exit()
 * No cleanup step is allowed to prevent the final exit.
 */
function forceExit(source = 'shell') {
  logLine(`force exit requested (${source})`)
  shuttingDown = true
  teardownManagedResources({ destroyWindows: true })
  app.exit(0)
}

function integratedDockWidth() {
  return megaDockExpanded ? megaDockWidth : MEGA_DOCK_COLLAPSED_WIDTH
}

function layoutIntegratedViews() {
  if (!INTEGRATED_MEGA_DOCK || !mainWindow || mainWindow.isDestroyed()) return
  const [contentWidth, contentHeight] = mainWindow.getContentSize()
  const maxDockWidth = Math.max(
    MEGA_DOCK_COLLAPSED_WIDTH,
    Math.min(MEGA_DOCK_MAX_WIDTH, Math.max(MEGA_DOCK_COLLAPSED_WIDTH, contentWidth - OFFICIAL_VIEW_MIN_WIDTH))
  )
  const desiredDockWidth = megaDockExpanded ? megaDockWidth : MEGA_DOCK_COLLAPSED_WIDTH
  const dockWidth = Math.max(MEGA_DOCK_COLLAPSED_WIDTH, Math.min(desiredDockWidth, maxDockWidth))
  const officialWidth = Math.max(0, contentWidth - dockWidth)
  const height = Math.max(1, contentHeight)

  if (officialView) {
    officialView.setBounds({ x: 0, y: 0, width: officialWidth, height })
  }
  // Log only when the decision actually changes: this is the line that makes a
  // "the official UI is narrow in Work Mode" report answerable from the log.
  if (layoutIntegratedViews.lastKey !== `${officialWidth}x${height}|dock=${dockWidth}|expanded=${megaDockExpanded}`) {
    layoutIntegratedViews.lastKey = `${officialWidth}x${height}|dock=${dockWidth}|expanded=${megaDockExpanded}`
    logLine(`layout: content=${contentWidth}px official=${officialWidth}px dock=${dockWidth}px expanded=${megaDockExpanded}`)
  }
  // The native frontend occupies exactly the same rectangle as the official
  // renderer: switching modes changes which one is visible, never their bounds,
  // so neither renderer is re-created and neither loses its scroll position
  // (Update-Plan/Dual-UI.md 任务 15 / 任务 17).
  if (nativeView) {
    nativeView.setBounds({ x: 0, y: 0, width: officialWidth, height })
  }
  if (megaDockView) {
    megaDockView.setBounds({ x: officialWidth, y: 0, width: dockWidth, height })
  }
  // The official surfaces follow the official view bounds (Update-Plan 任务 3):
  // the overlay tracks it exactly, the shell spans the window so its frame band
  // is drawn on all four sides. Called on resize/maximize/restore/dock-toggle, and
  // its failure can only degrade the surfaces, never the window.
  if (officialSurfaces) {
    try {
      officialSurfaces.applyLayout()
    } catch (error) {
      logLine(`official surface layout failed: ${error?.message || error}`)
    }
  }
}

function applyIntegratedDockState(payload = {}) {
  if (!INTEGRATED_MEGA_DOCK) return
  if (typeof payload.expanded === 'boolean') megaDockExpanded = payload.expanded
  const candidate = Number(payload.expandedWidth ?? payload.width)
  if (Number.isFinite(candidate) && candidate >= MEGA_DOCK_MIN_WIDTH) {
    megaDockWidth = Math.max(MEGA_DOCK_MIN_WIDTH, Math.min(MEGA_DOCK_MAX_WIDTH, candidate))
  }
  layoutIntegratedViews()
}

function registerIntegratedDockIpc() {
  if (!INTEGRATED_MEGA_DOCK) return
  ipcMain.removeAllListeners('mega-shell:dock-state')
  // The dock renderer's preload reports its own state through the extension's
  // main process, and the extension relays the *layout* decision here: the shell
  // owns the view bounds, so a failed relay would leave the reserved strip at the
  // wrong width. Both senders are accepted; the payload shape is identical.
  ipcMain.on('mega-shell:dock-state', (_event, payload) => applyIntegratedDockState(payload || {}))
}

function configureOfficialWebContents(contents) {
  contents.setWindowOpenHandler(({ url }) => {
    if (allowedHarnessNavigation(url)) return { action: 'allow' }
    shell.openExternal(url)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, url) => {
    if (!allowedHarnessNavigation(url)) {
      event.preventDefault()
      shell.openExternal(url)
    }
  })
  contents.on('render-process-gone', (_event, details) => logLine(`official renderer gone: ${JSON.stringify(details)}`))
}

async function createOfficialHarnessView(readyUrl) {
  if (!INTEGRATED_MEGA_DOCK || !mainWindow || mainWindow.isDestroyed()) return false
  if (!WebContentsView || !mainWindow.contentView?.addChildView) {
    throw new Error('Integrated layout unavailable: WebContentsView/contentView not supported by this Electron build')
  }
  if (!officialView) {
    officialView = new WebContentsView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true
      }
    })
    configureOfficialWebContents(officialView.webContents)
    mainWindow.contentView.addChildView(officialView)
  }
  layoutIntegratedViews()
  await officialView.webContents.loadURL(readyUrl)
  return true
}

/* ---------------------------------------------------------------------------
 * Dual-UI runtime: Frontend Modes, the native renderer and the mode manager
 * (Update-Plan/Dual-UI.md 任务 2 / 任务 3 / 任务 5 / 任务 6 / 任务 15 / 任务 20).
 *
 * The shell owns the two renderers, so it owns the switch. Both views are
 * created once and kept alive for the whole session: a mode change only sets
 * visibility, bounds and z-order (任务 15 / 任务 17). Nothing here restarts the
 * Harness, resets a session or touches the official DOM (任务 5).
 * ------------------------------------------------------------------------- */

function frontendModeStatePath() {
  return path.join(ROOT, 'data', 'state', 'frontend-mode.json')
}

/**
 * Show or hide one renderer without destroying it.
 *
 * `setVisible` is the modern View API; the offscreen fallback exists only so an
 * Electron build without it degrades to "not painted" instead of throwing.
 */
function setViewVisibility(view, visible) {
  if (!view) return false
  try {
    if (typeof view.setVisible === 'function') {
      view.setVisible(Boolean(visible))
      return true
    }
  } catch (error) {
    logLine(`view visibility failed: ${error?.message || error}`)
  }
  try {
    // No `setVisible`: a zero-area view paints nothing and takes no input while
    // the renderer process and its state stay alive.
    const bounds = typeof view.getBounds === 'function' ? view.getBounds() : null
    if (!visible && bounds) view.setBounds({ x: -4096, y: -4096, width: 1, height: 1 })
    return true
  } catch {
    return false
  }
}

/**
 * The manager's view hook (任务 5 / 任务 10).
 *
 * Daily:  native visible, official hidden.
 * Work:   official visible, native hidden - and the official UI is exactly what
 *         the harness rendered, because nothing is stacked above it.
 */
function applyFrontendVisibility({ mode }) {
  const daily = mode === frontendModes?.MODE?.DAILY || mode === 'daily'
  setViewVisibility(nativeView, daily)
  setViewVisibility(officialView, !daily)
  // Work Mode is the official UI, and the official UI needs the whole window:
  // with the dock expanded it is 560px narrower and silently drops its own
  // sidebar. Collapse the dock to its rail for the duration of Work Mode and put
  // it back the way the user had it when Daily returns.
  applyDockPolicyForMode(daily ? 'daily' : 'work')
  // Re-apply the layout *after* the visibility change. Chromium can keep the
  // previous viewport for a view that was resized while hidden, which left the
  // official UI rendering at the width it had before Work Mode widened it.
  layoutIntegratedViews()
  // A view that changed visibility in this tick can swallow the bounds change
  // made in the same tick, leaving the official UI at its old width. Re-applying
  // the layout once the visibility flip has settled is what actually resizes it.
  setImmediate(() => {
    try {
      layoutIntegratedViews()
    } catch (error) {
      logLine(`deferred layout failed: ${error?.message || error}`)
    }
  })
  // A too-narrow window cannot show the native sidebar legibly; the manager is
  // told so it can decide, but the switch itself never fails because of it.
  if (daily) {
    const [width] = mainWindow && !mainWindow.isDestroyed() ? mainWindow.getContentSize() : [0, 0]
    if (width && width < NATIVE_VIEW_MIN_WIDTH) {
      logLine(`native frontend is narrow (${width}px < ${NATIVE_VIEW_MIN_WIDTH}px); the layout degrades to a single column`)
    }
  }
  broadcastModeChange()
  return true
}

/** Keep the dock's width out of the official UI's way while Work Mode is active. */
function applyDockPolicyForMode(mode) {
  if (!INTEGRATED_MEGA_DOCK || !extensionManager?.setDockExpanded) return
  try {
    if (mode === 'work') {
      if (megaDockExpandedBeforeWork === null) megaDockExpandedBeforeWork = megaDockExpanded
      if (megaDockExpanded) {
        // The shell owns the view bounds, so it applies the layout itself instead
        // of waiting for the dock renderer to push its state back: the official UI
        // must be wide the moment Work Mode appears.
        megaDockExpanded = false
        layoutIntegratedViews()
        extensionManager.setDockExpanded(false, { persist: false, focus: false })
      }
    } else if (megaDockExpandedBeforeWork) {
      megaDockExpandedBeforeWork = null
      if (!megaDockExpanded) {
        megaDockExpanded = true
        layoutIntegratedViews()
        extensionManager.setDockExpanded(true, { persist: false, focus: false })
      }
    } else {
      megaDockExpandedBeforeWork = null
    }
  } catch (error) {
    // A dock that refuses to move must never break the mode switch: the official
    // UI would be narrower than ideal, and that is all.
    logLine(`dock policy for ${mode} failed: ${error?.message || error}`)
  }
}

/** Build the Dual-UI runtime. Safe to call once, before the views exist. */
function createFrontendModes() {
  if (frontendModes) return frontendModes
  frontendModes = frontendMode.createFrontendModeRuntime({
    stateFile: frontendModeStatePath(),
    // A configurable startup mode (任务 2). Unset, the saved preference wins.
    startupMode: process.env.DSH_FRONTEND_MODE || null,
    applyVisibility: (payload) => applyFrontendVisibility(payload),
    tasks: () => (extensionManager?.describeNativeData?.()?.tasks) || [],
    settings: () => (extensionManager?.describeNativeData?.()?.settings) || null,
    installedVersion: () => (extensionManager?.describeNativeData?.()?.harnessVersion) || null,
    latestVersion: async () => (extensionManager?.describeNativeData?.()?.latestVersion) || null,
    log: (message) => logLine(`[frontend-mode] ${message}`)
  })
  return frontendModes
}

/**
 * Create the native frontend view (任务 6).
 *
 * It is a sibling WebContentsView with its own preload and its own sandbox, and
 * it is created exactly once. Daily is the default mode, so it is shown first.
 */
async function createNativeFrontendView() {
  if (!INTEGRATED_MEGA_DOCK || !mainWindow || mainWindow.isDestroyed()) return false
  if (!WebContentsView || !mainWindow.contentView?.addChildView) {
    logLine('native frontend unavailable: WebContentsView/contentView not supported by this Electron build')
    return false
  }
  if (nativeView) {
    layoutIntegratedViews()
    return true
  }
  nativeView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'native-ui', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  nativeView.surface = SURFACE.HNS_NATIVE
  try {
    nativeView.setBackgroundColor('#0b0e14')
  } catch {}
  nativeView.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  nativeView.webContents.on('render-process-gone', (_event, details) => {
    logLine(`native frontend renderer gone: ${JSON.stringify(details)}`)
    // 任务 20: the backend is preserved and the product falls back to Work Mode.
    try {
      frontendModes?.manager?.degrade(`native renderer gone: ${details?.reason || 'unknown'}`)
    } catch (error) {
      logLine(`native degradation handling failed: ${error?.message || error}`)
    }
  })
  mainWindow.contentView.addChildView(nativeView)
  layoutIntegratedViews()
  await nativeView.webContents.loadFile(path.join(__dirname, 'native-ui', 'index.html'))
  logLine('native frontend attached as a sibling WebContentsView (Daily Mode); Work Mode keeps the official renderer')
  return true
}

/**
 * The adapter the Mega extension uses to reach the native renderer.
 *
 * Same shape as `createDockAdapter()`: the extension never learns how the view
 * is stored, and it can only push a theme payload or a change notification.
 */
function createNativeThemeAdapter() {
  const webContents = () => (nativeView && !nativeView.webContents.isDestroyed() ? nativeView.webContents : null)
  return {
    integrated: true,
    available: () => Boolean(webContents()),
    webContents,
    /** Push a channel to the native renderer; never throws, never queues. */
    send: (channel, payload) => {
      const target = webContents()
      if (!target) return false
      try {
        if (payload === undefined) target.send(channel)
        else target.send(channel, payload)
        return true
      } catch (error) {
        logLine(`native renderer send failed on ${channel}: ${error?.message || error}`)
        return false
      }
    },
    bounds: () => {
      if (!nativeView) return null
      try {
        return nativeView.getBounds()
      } catch {
        return null
      }
    },
    visible: () => Boolean(nativeView && frontendModes?.manager?.current() === 'daily'),
    describe: () => ({
      available: Boolean(webContents()),
      bounds: (() => {
        try {
          return nativeView ? nativeView.getBounds() : null
        } catch {
          return null
        }
      })(),
      mode: frontendModes?.manager?.current() || null
    })
  }
}

/** The mode adapter the Mega extension uses: read and switch, never own. */
function createNativeModeAdapter() {
  return {
    describe: () => (frontendModes ? frontendModes.manager.describe() : { mode: 'daily', state: 'DAILY_ACTIVE', available: false }),
    current: () => frontendModes?.manager?.current() || 'daily',
    /**
     * Switch the frontend mode.
     *
     * The session list is read first so "Work -> Daily" reopens the session the
     * backend actually has (任务 10), not a stale remembered id.
     */
    switchTo: async (mode) => {
      if (!frontendModes) return { ok: false, reason: 'frontend mode runtime unavailable' }
      let sessions = []
      try {
        const listed = await frontendModes.adapter.listSessions()
        sessions = listed?.sessions || []
      } catch (error) {
        logLine(`mode switch could not read sessions: ${error?.message || error}`)
      }
      return frontendModes.manager.switchTo(mode, { sessions, reason: 'dock' })
    },
    toggle: async () => {
      if (!frontendModes) return { ok: false, reason: 'frontend mode runtime unavailable' }
      let sessions = []
      try {
        const listed = await frontendModes.adapter.listSessions()
        sessions = listed?.sessions || []
      } catch (error) {
        logLine(`mode toggle could not read sessions: ${error?.message || error}`)
      }
      return frontendModes.manager.toggle({ sessions, reason: 'dock' })
    },
    /** 任务 20: a native failure moves the product to Work Mode. */
    degrade: (reason) => (frontendModes ? frontendModes.manager.degrade(reason) : { ok: false, reason: 'frontend mode runtime unavailable' }),
    onModeChange: (callback) => (typeof callback === 'function' ? frontendModeSubscribe(callback) : () => {})
  }
}

/** Mode-change fan-out to the dock renderer and to the extension. */
const frontendModeListeners = new Set()
function frontendModeSubscribe(listener) {
  if (typeof listener !== 'function') return () => {}
  frontendModeListeners.add(listener)
  return () => frontendModeListeners.delete(listener)
}

function broadcastModeChange(payload = null) {
  const status = payload || (frontendModes ? frontendModes.manager.describe() : null)
  if (!status) return
  for (const listener of [...frontendModeListeners]) {
    try {
      listener(status)
    } catch (error) {
      logLine(`frontend mode listener failed: ${error?.message || error}`)
    }
  }
  // The native renderer and the dock both need to know: the first to stop doing
  // hidden work, the second to keep its switch honest.
  try {
    if (nativeView && !nativeView.webContents.isDestroyed()) {
      nativeView.webContents.send('hns:native-mode-changed', status)
    }
  } catch {}
  try {
    if (megaDockView && !megaDockView.webContents.isDestroyed()) {
      megaDockView.webContents.send('mega:mode-changed', status)
    }
  } catch {}
}

/**
 * Shell-owned mode IPC.
 *
 * Channel ownership is deliberate: the shell answers mode questions (it owns the
 * views and the state machine) while the Mega extension answers model questions
 * (it owns the adapter, the scheduler and the theme engine).
 */
function registerNativeModeIpc() {
  if (!INTEGRATED_MEGA_DOCK) return
  for (const channel of ['hns:native-mode', 'hns:native-set-mode', 'hns:native-toggle-mode', 'hns:native-failure', 'hns:native-regions', 'hns:native-diagnostics']) {
    try {
      ipcMain.removeHandler(channel)
    } catch {}
  }
  const guard = (handler) => async (_event, ...args) => {
    try {
      return await handler(...args)
    } catch (error) {
      logLine(`frontend mode ipc failed: ${error?.message || error}`)
      return { ok: false, reason: 'mode_ipc_failed', message: String(error?.message || error) }
    }
  }
  ipcMain.handle('hns:native-mode', guard(() => (frontendModes ? frontendModes.manager.describe() : { mode: 'daily', state: 'DAILY_ACTIVE', available: false })))
  ipcMain.handle('hns:native-set-mode', guard((mode) => createNativeModeAdapter().switchTo(String(mode || ''))))
  ipcMain.handle('hns:native-toggle-mode', guard(() => createNativeModeAdapter().toggle()))
  ipcMain.handle('hns:native-failure', guard((payload) => {
    const reason = payload?.reason || 'native frontend failure'
    logLine(`native frontend reported a failure: ${reason}`)
    return frontendModes ? frontendModes.manager.degrade(reason) : { ok: false, reason: 'frontend mode runtime unavailable' }
  }))
  ipcMain.removeAllListeners('hns:native-regions')
  ipcMain.on('hns:native-regions', (_event, payload) => {
    try {
      if (nativeView && !nativeView.webContents.isDestroyed()) {
        broadcastNativeRegions(payload || {})
      }
    } catch (error) {
      logLine(`native region relay failed: ${error?.message || error}`)
    }
  })
  ipcMain.handle('hns:native-diagnostics', guard(() => ({
    ok: true,
    frontend: frontendModes ? frontendModes.describe() : null,
    surfaces: createOfficialSurfaceAdapter().describe(),
    // The real view geometry, straight from the shell. This is the measurement a
    // check should use for "did the official UI get the full width": a renderer's
    // own `innerWidth` can lag while its view is not being composited.
    views: {
      content: (() => {
        try {
          return mainWindow && !mainWindow.isDestroyed() ? mainWindow.getContentSize() : null
        } catch {
          return null
        }
      })(),
      official: (() => {
        try {
          return officialView ? officialView.getBounds() : null
        } catch {
          return null
        }
      })(),
      native: (() => {
        try {
          return nativeView ? nativeView.getBounds() : null
        } catch {
          return null
        }
      })(),
      dock: (() => {
        try {
          return megaDockView ? megaDockView.getBounds() : null
        } catch {
          return null
        }
      })(),
      dockExpanded: megaDockExpanded
    }
  })))
}

/** Region reports are relayed to whoever asked for them (the theme engine). */
const nativeRegionListeners = new Set()
function broadcastNativeRegions(payload) {
  for (const listener of [...nativeRegionListeners]) {
    try {
      listener(payload)
    } catch (error) {
      logLine(`native region listener failed: ${error?.message || error}`)
    }
  }
}

/**
 * The Official Shell + Official Overlay views (Update-Plan 任务 2 / 任务 3).
 *
 * Ordering is the whole trick, and it is why this is one function rather than two:
 * the shell must be added *before* the official view (so it paints behind it, and
 * only its outer band is visible) and the overlay *after* it (so it stacks above).
 * Both are input-transparent; neither has a preload, a script, or any reference to
 * the official renderer.
 *
 * A failure here disables the two official surfaces and nothing else: the official
 * renderer and the HNS dock are already live by this point (任务 18).
 */
async function createOfficialSurfaces() {
  if (!INTEGRATED_MEGA_DOCK || !mainWindow || mainWindow.isDestroyed()) return false
  if (officialSurfaces) return true
  officialSurfaces = createOfficialSurfaceViews({
    getWindow: () => mainWindow,
    getOfficialView: () => officialView,
    getWindowSize: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow.getContentSize() : null),
    getDockWidth: () => integratedDockWidth(),
    log: (message) => logLine(`[surface] ${message}`),
    electron: { WebContentsView }
  })
  try {
    officialSurfaces.createShell()
    // 任务 1: the official Overlay is DEPRECATED and is not created by default.
    // Work Mode must be untouched official UI, so nothing is stacked above it
    // unless an operator explicitly asks for the legacy architecture.
    if (OFFICIAL_OVERLAY_ENABLED) {
      officialSurfaces.createOverlay()
      logLine('DEPRECATED: official_overlay created because DSH_OFFICIAL_OVERLAY=1; the overlay architecture is retired')
    } else {
      logLine('official_overlay disabled by default (Update-Plan/Dual-UI.md P0 task 1); only the official_shell frame is attached')
    }
    officialSurfaces.applyLayout()
    logLine(`official_shell view attached (visual-only, input passthrough); overlay=${OFFICIAL_OVERLAY_ENABLED ? 'legacy-opt-in' : 'disabled'}`)
    return true
  } catch (error) {
    logLine(`official surfaces failed to attach; the official renderer keeps running unthemed: ${error?.stack || error}`)
    try { officialSurfaces.destroy() } catch {}
    officialSurfaces = null
    return false
  }
}

async function createIntegratedMegaDock() {
  if (!INTEGRATED_MEGA_DOCK || !mainWindow || mainWindow.isDestroyed()) return false
  if (!WebContentsView || !mainWindow.contentView?.addChildView) {
    logLine('Integrated Mega dock unavailable: WebContentsView/contentView not supported by this Electron build')
    return false
  }
  if (megaDockView) {
    layoutIntegratedViews()
    return true
  }

  megaDockView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'extensions', 'mega', 'ui', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  mainWindow.contentView.addChildView(megaDockView)
  megaDockView.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  megaDockView.webContents.on('render-process-gone', (_event, details) => {
    logLine(`integrated Mega renderer gone: ${JSON.stringify(details)}`)
  })
  layoutIntegratedViews()
  await megaDockView.webContents.loadFile(path.join(__dirname, 'extensions', 'mega', 'ui', 'dock.html'))
  logLine('Mega dock attached as a reserved right-side WebContentsView; official UI no longer sits underneath it')
  // The view exists now, so every push the extension made during boot (or will
  // make after a reload) has a real target: hand over the ready notification.
  notifyDockReady()
  return true
}

function destroyIntegratedViews() {
  try {
    officialSurfaces?.destroy?.()
  } catch (error) {
    logLine(`official surface teardown failed: ${error?.message || error}`)
  }
  officialSurfaces = null
  for (const view of [megaDockView, nativeView, officialView]) {
    if (!view) continue
    try { mainWindow?.contentView?.removeChildView?.(view) } catch {}
    try {
      if (!view.webContents.isDestroyed()) view.webContents.close()
    } catch {}
  }
  megaDockView = null
  nativeView = null
  officialView = null
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: INTEGRATED_MEGA_DOCK ? 1488 : 1440,
    height: 920,
    minWidth: 980,
    minHeight: 640,
    title: 'DS-Harness · DeepSeek Harness',
    icon: resolveAppIcon(),
    backgroundColor: '#f7f8fa',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  })

  if (!INTEGRATED_MEGA_DOCK) configureOfficialWebContents(mainWindow.webContents)

  mainWindow.on('resize', layoutIntegratedViews)
  mainWindow.on('maximize', layoutIntegratedViews)
  mainWindow.on('unmaximize', layoutIntegratedViews)
  mainWindow.on('restore', layoutIntegratedViews)
  mainWindow.on('closed', () => {
    megaDockView = null
    nativeView = null
    officialView = null
    mainWindow = null
  })
}

/**
 * The dock target the extension talks to.
 *
 * The extension must not care whether the dock is a `WebContentsView` (current)
 * or a legacy `BrowserWindow` (older builds), so the shell hands it a small
 * adapter instead of a webContents: the webContents itself, the view's real
 * bounds (a `WebContentsView` has no `getContentSize`), its visibility, and
 * whether this is the integrated generation. `dockWebContents` is kept as the
 * legacy single-value form for compatibility.
 */
function createDockAdapter() {
  const webContents = () => (megaDockView && !megaDockView.webContents.isDestroyed() ? megaDockView.webContents : null)
  return {
    integrated: true,
    webContents,
    bounds: () => {
      if (!megaDockView || !mainWindow || mainWindow.isDestroyed()) return null
      try {
        return megaDockView.getBounds()
      } catch {
        return null
      }
    },
    // The dock is a child view of the main window, so "visible" is a property of
    // the window: this is the shell's own answer, not a guess.
    visible: () => Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized()),
    expanded: () => megaDockExpanded,
    // The extension registers here to receive the dock-ready notification, which
    // is what closes the boot gap: the view is created after extensions start, so
    // the first paint push has no target yet.
    onReady: (callback) => {
      if (typeof callback !== 'function' || dockReadyCallbacks.includes(callback)) return false
      dockReadyCallbacks.push(callback)
      // A dock that is already loaded missed the notification by definition.
      if (megaDockView && !megaDockView.webContents.isDestroyed()) {
        setImmediate(() => notifyDockReady())
      }
      return true
    }
  }
}

/**
 * The official-surface target the extension talks to (Update-Plan 任务 2 / 任务 3).
 *
 * Same shape as `createDockAdapter()` and for the same reason: the extension must
 * not learn how the shell stores its views, and it must have exactly one way to
 * paint a surface. `official_renderer` is deliberately absent from every method —
 * there is no argument the extension can pass that would reach it.
 */
function createOfficialSurfaceAdapter() {
  return {
    integrated: true,
    /** Paint both official surfaces with a theme payload. Never throws. */
    paint: (payload, placement = null) => {
      if (!officialSurfaces) return { ok: false, reason: 'surfaces_unavailable' }
      try {
        return officialSurfaces.paintTheme(payload, placement)
      } catch (error) {
        logLine(`official surface paint failed (surface disabled, theme kept): ${error?.stack || error}`)
        try { officialSurfaces.setEnabled(false) } catch {}
        return { ok: false, reason: 'paint_failed', error: String(error?.message || error) }
      }
    },
    /** Reset both surfaces to the default frame (theme deleted / fallback). */
    reset: () => {
      if (!officialSurfaces) return { ok: false, reason: 'surfaces_unavailable' }
      try {
        return officialSurfaces.reset()
      } catch (error) {
        logLine(`official surface reset failed: ${error?.message || error}`)
        return { ok: false, reason: 'reset_failed' }
      }
    },
    /** Re-layout after a resize/maximise/restore/dock change. */
    layout: (next = null) => {
      if (!officialSurfaces) return { ok: false, reason: 'surfaces_unavailable' }
      try {
        return officialSurfaces.applyLayout(next)
      } catch (error) {
        return { ok: false, reason: 'layout_failed', error: String(error?.message || error) }
      }
    },
    /** Real bounds of the protected official view, for the layout engine. */
    officialBounds: () => {
      if (!officialView) return null
      try {
        return officialView.getBounds()
      } catch {
        return null
      }
    },
    /** Honest diagnostics: what each surface is, and that none was injected into. */
    describe: () => {
      if (!officialSurfaces) {
        return {
          available: false,
          surfaces: PAINTABLE.map((id) => ({ id, created: false, ready: false, bounds: null })),
          protected: { id: SURFACE.OFFICIAL_RENDERER, writable: false, painted: false, injection_apis_used: [] }
        }
      }
      return { available: true, ...officialSurfaces.describe(), officialBounds: (() => {
        try { return officialView ? officialView.getBounds() : null } catch { return null }
      })() }
    },
    /** Drain the surface's own degradation log so the extension can report it. */
    degradation: () => {
      if (!officialSurfaces) return []
      try {
        return officialSurfaces.describe().degradation
      } catch {
        return []
      }
    }
  }
}

/**
 * Called once the integrated dock renderer has loaded.
 *
 * Callbacks stay registered: the dock renderer can reload (a crash recovery, a
 * dev reload) and every reload must be repainted with the active theme, exactly
 * like the first one.
 */
function notifyDockReady() {
  for (const callback of [...dockReadyCallbacks]) {
    try {
      callback()
    } catch (error) {
      logLine(`dock ready callback failed: ${error?.stack || error}`)
    }
  }
}

async function startExtensions(nodeExe) {
  if (process.env.DSH_DISABLE_MEGA === '1') {
    logLine('Mega extensions disabled by DSH_DISABLE_MEGA=1')
    return false
  }
  try {
    const dockAdapter = createDockAdapter()
    const officialSurfaceAdapter = createOfficialSurfaceAdapter()
    extensionManager = require('./extensions/manager.cjs')
    await extensionManager.start({
      root: ROOT,
      nodeExe,
      mainWindow,
      officialWebContents: officialView?.webContents || mainWindow?.webContents || null,
      dockAdapter,
      // The two official surfaces. The extension paints them with the same theme
      // payload it paints the dock with; it never receives the official webContents,
      // so there is nothing it could inject into it.
      officialSurfaceAdapter,
      officialSurfaces: officialSurfaceAdapter,
      // Legacy single-value form: the extension's adapter accepts either.
      dockWebContents: dockAdapter.webContents,
      // ---- Dual-UI (Update-Plan/Dual-UI.md) --------------------------------
      // The native frontend. The extension owns the theme engine and the HNS
      // model, so it is handed the *target* (to push a theme payload) and the
      // mode adapter (to read/switch), never the view itself.
      nativeThemeTarget: createNativeThemeAdapter(),
      nativeMode: createNativeModeAdapter(),
      // The assembled Dual-UI runtime: adapter (HNS model), sync, probe and the
      // manager's status. The extension reads it; the shell owns it.
      nativeFrontend: frontendModes,
      // Native slot geometry is measured by the native renderer and relayed
      // here; the extension subscribes to feed the theme validator.
      onNativeRegions: (listener) => {
        if (typeof listener !== 'function') return () => {}
        nativeRegionListeners.add(listener)
        return () => nativeRegionListeners.delete(listener)
      },
      // The dock view is created *after* extensions start (it loads the
      // extension's preload), so an eager value would always be null and every
      // push — a theme payload, a change notification — would go nowhere.
      onDockReady: dockAdapter.onReady,
      log: logLine,
      // The shell owns process lifecycle, so the tray's exit actions are routed
      // back here instead of the extension reaching into the managed child.
      shutdown: {
        graceful: (source) => gracefulExit(source || 'tray'),
        force: (source) => forceExit(source || 'tray')
      },
      // The optional Sub-worker is shell-owned too: Mega renders and controls
      // it, but the WorkerManager (and therefore the worker process) belongs to
      // the desktop shell. `subWorker: null` means the feature is unavailable,
      // and the dock must degrade gracefully.
      subWorker: workerManager,
      onSubWorkerChange: subscribeSubWorker,
      // `Notification` is handed to the extension so terminal task notifications
      // are a first-class lifecycle capability rather than a renderer concern.
      electron: { app, BrowserWindow, dialog, shell, ipcMain, Tray, Menu, nativeImage, screen, Notification }
    })
    return true
  } catch (error) {
    logLine(`extension manager failed without affecting official UI: ${error?.stack || error}`)
    return false
  }
}

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return
  registerIntegratedDockIpc()
  createWindow()
  try {
    await runtimeProcess.recoverOwnedStale({ root: ROOT, dshEntry: DSH_ENTRY, log: logLine })
    if (await isHarnessPortListening()) {
      throw startupError(`Port ${HARNESS_PORT} is already in use by another process. Close it before starting DS-Harness.`)
    }
    const nodeExe = resolveNodeExe()
    await Promise.race([
      startHarness(nodeExe),
      new Promise((_, reject) => setTimeout(() => reject(startupError(`No Harness access token was announced within ${STARTUP_TIMEOUT_MS / 1000} seconds`)), STARTUP_TIMEOUT_MS))
    ])
    const readyUrl = await waitForHarness()
    // The Dual-UI backend client talks to the same authenticated Harness the
    // official renderer uses; publishing the origin is what lets the native
    // frontend read `session/list` without ever touching the official renderer.
    try {
      process.env.DSH_OFFICIAL_ORIGIN = new URL(readyUrl).origin
    } catch {}
    createFrontendModes()
    registerNativeModeIpc()
    if (INTEGRATED_MEGA_DOCK) await createOfficialHarnessView(readyUrl)
    else await mainWindow.loadURL(readyUrl)
    // The two official surfaces are attached after the official renderer exists
    // (they need its bounds) and before the dock, so the dock is added last and
    // stays on top of its own strip.
    await createOfficialSurfaces()

    // The Sub-worker layer is created here, after the official UI is ready and
    // before any extension can ask for it. Creation is inert (no process), so
    // the default startup path is unchanged.
    await createWorkerManager(nodeExe)

    const extensionsReady = await startExtensions(nodeExe)
    // The native renderer is created after the extension so its preload's IPC
    // handlers (model + theme) already exist when it boots, and before the dock
    // so the dock stays the topmost strip.
    if (INTEGRATED_MEGA_DOCK && extensionsReady) {
      try {
        await createNativeFrontendView()
        // Daily is the default mode: apply the persisted mode once both
        // renderers exist. Nothing is re-created here, only made visible.
        applyFrontendVisibility({ mode: frontendModes?.manager?.current() || 'daily' })
      } catch (error) {
        logLine(`native frontend failed to attach; Work Mode remains the live surface: ${error?.stack || error}`)
        frontendModes?.manager?.degrade(`native frontend attach failed: ${error?.message || error}`)
      }
    } else if (INTEGRATED_MEGA_DOCK) {
      // The Mega extension serves the HNS model and the theme payload for Daily
      // Mode. Without it, showing an empty native surface would be worse than the
      // honest answer: stay on the official UI and say why.
      logLine('Dual-UI: the Mega extension did not start, so Daily Mode cannot be served; staying in Work Mode')
      frontendModes?.manager?.degrade('the native frontend data plane is unavailable (Mega extension not loaded)')
    }
    if (extensionsReady && INTEGRATED_MEGA_DOCK) await createIntegratedMegaDock()
    layoutIntegratedViews()
    mainWindow.show()

    // Only an explicit persisted opt-in starts a worker process at boot.
    if (workerManager?.describe?.().config?.enabledOnStartup) {
      const started = await workerManager.start({ reason: 'enabledOnStartup' })
      logLine(`sub-worker auto-start (enabledOnStartup): ${JSON.stringify(started)}`)
    }
  } catch (error) {
    await dialog.showMessageBox({
      type: 'error',
      title: 'DS-Harness 启动失败',
      message: '无法启动官方 DeepSeek Harness Web UI',
      detail: `${String(error.stack || error)}\n\nLog: ${logPath()}`
    })
    app.quit()
  }
})

app.on('second-instance', () => {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
})
app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => {
  // Closing the main window (or a system shutdown) is the implicit normal exit.
  if (shuttingDown) return
  shuttingDown = true
  logLine('before-quit: reconciling managed resources')
  teardownManagedResources()
})
process.on('exit', stopHarness)
