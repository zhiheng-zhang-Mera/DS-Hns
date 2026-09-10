'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const scheduler = require('./scheduler/scheduler')
const { TERMINAL_EVENT, CANONICAL_TERMINAL } = require('./scheduler/lifecycle')
const settingsService = require('./settings/settings-service')
const soundService = require('./notifications/sound-service')
const notificationService = require('./notifications/notification-service')
const { createTerminalDispatcher } = require('./notifications/terminal-dispatch')
const { BalanceService } = require('./billing/balance-service')
const sessionReader = require('./tracker/session-reader')
const { TerminalObserver } = require('./tracker/terminal-observer')
const taskHistory = require('./tracker/task-history')
const workspace = require('./utils/workspace')
const { PATHS } = require('./utils/paths')

const CHANNELS = [
  'mega:snapshot', 'mega:add-task', 'mega:reorder-task', 'mega:cancel-task', 'mega:clear-pending',
  'mega:remove-tasks', 'mega:update-scheduler', 'mega:refresh-hardware', 'mega:update-settings',
  'mega:balance', 'mega:pick-workspace', 'mega:pick-sound',
  'mega:dock-toggle', 'mega:dock-expand'
]

/** Canonical terminal state -> existing ringtone event. */
const SOUND_EVENT_BY_TERMINAL = Object.freeze({
  [CANONICAL_TERMINAL.COMPLETED]: 'COMPLETED',
  [CANONICAL_TERMINAL.FAILED_FINAL]: 'FAILED',
  [CANONICAL_TERMINAL.CANCELLED]: 'INTERRUPTED'
})

const DOCK_COLLAPSED_WIDTH = 48
const DOCK_DEFAULT_WIDTH = 560
const DOCK_MIN_WIDTH = 440
const DOCK_MAX_WIDTH = 720

let ctx = null
let dockWindow = null
let playerWindow = null
let tray = null
let shortcutHandler = null
let started = false
let dockExpanded = false
let dockWidth = DOCK_DEFAULT_WIDTH
let dockUserHidden = false
const mainWindowBindings = []

const balanceService = new BalanceService({ log: (message) => log(message) })

/**
 * Terminal alerts are one pipeline for every task path (official user session,
 * scheduler official session, headless task): whichever observer reports the
 * terminal state first, the dispatcher guarantees a single ringtone and a single
 * desktop notification.
 */
const terminalDispatcher = createTerminalDispatcher({
  ring: (event) => ring(SOUND_EVENT_BY_TERMINAL[event.finalStatus] || event.status),
  notify: (event) => notificationService.notifyTerminal(event),
  log: (message) => log(message)
})

const terminalObserver = new TerminalObserver({
  listSessions: () => sessionReader.listSessions({ limit: 60 }),
  isManagedSession: (sessionId) => scheduler.isManagedOfficialSession(sessionId),
  // Tunable polling window (used by tests and for slower machines).
  intervalMs: Number(process.env.DSH_MEGA_OBSERVE_MS) || undefined,
  log: (message) => log(message)
})

function log(message) {
  ctx?.log?.(`[mega] ${message}`)
}

function mainAlive() {
  return Boolean(ctx?.mainWindow && !ctx.mainWindow.isDestroyed())
}

function dockStatePath() {
  return path.join(ctx?.root || process.cwd(), 'data', 'state', 'mega-dock.json')
}

function loadDockState() {
  try {
    const saved = JSON.parse(fs.readFileSync(dockStatePath(), 'utf8'))
    dockExpanded = Boolean(saved.expanded)
    const width = Number(saved.width)
    if (Number.isFinite(width)) dockWidth = Math.max(DOCK_MIN_WIDTH, Math.min(DOCK_MAX_WIDTH, width))
  } catch {
    dockExpanded = false
    dockWidth = DOCK_DEFAULT_WIDTH
  }
}

function saveDockState() {
  try {
    const file = dockStatePath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ expanded: dockExpanded, width: dockWidth }, null, 2), 'utf8')
  } catch (error) {
    log(`dock state save failed: ${error?.message || error}`)
  }
}

function snapshot() {
  const recent = taskHistory.loadRecent()
  return {
    extension: {
      id: 'mega',
      mode: 'optional-feature-extension',
      shellOwner: 'alien',
      dock: {
        visible: Boolean(dockWindow && !dockWindow.isDestroyed() && dockWindow.isVisible()),
        expanded: dockExpanded,
        width: dockExpanded ? dockWidth : DOCK_COLLAPSED_WIDTH,
        expandedWidth: dockWidth,
        collapsedWidth: DOCK_COLLAPSED_WIDTH
      },
      tray: Boolean(tray)
    },
    scheduler: scheduler.describe(),
    // Active queue only: tasks that may still be executed (MEGA-01).
    tasks: scheduler.listTasks({ limit: 200 }),
    // Terminal tasks stay queryable through the history layer.
    history: recent,
    recent,
    settings: settingsService.publicSettings(),
    workspace: workspace.getWorkspaceRoot(),
    soundFiles: soundService.listSoundFiles(),
    balance: balanceService.describe(),
    // Mega no longer mirrors the official Harness session history: the official
    // UI owns it, and the terminal observer only watches it for alerts.
    terminalAlerts: terminalDispatcher.describe()
  }
}

function notifyChanged() {
  if (dockWindow && !dockWindow.isDestroyed()) dockWindow.webContents.send('mega:changed')
}

function ensurePlayerWindow() {
  if (playerWindow && !playerWindow.isDestroyed()) return playerWindow
  const { BrowserWindow } = ctx.electron
  playerWindow = new BrowserWindow({
    width: 240,
    height: 100,
    show: false,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'ui', 'player-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  playerWindow.on('closed', () => { playerWindow = null })
  playerWindow.loadFile(path.join(__dirname, 'ui', 'player.html')).catch((error) => log(`player load failed: ${error}`))
  return playerWindow
}

function ring(eventName) {
  try {
    const audio = soundService.resolveBellAudio(eventName)
    if (!audio) return
    const win = ensurePlayerWindow()
    const send = () => win.webContents.send('mega:play', {
      src: pathToFileURL(audio.file).href,
      volume: audio.volume
    })
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send)
    else send()
  } catch (error) {
    log(`ring failed: ${error?.message || error}`)
  }
}

function dockEnabled() {
  return process.env.DSH_MEGA_DOCK !== '0' && process.env.DSH_MEGA_WIDGET !== '0'
}

function dockCanShow() {
  if (!dockEnabled() || dockUserHidden || !mainAlive()) return false
  return ctx.mainWindow.isVisible() && !ctx.mainWindow.isMinimized()
}

function currentDockWidth() {
  return dockExpanded ? dockWidth : DOCK_COLLAPSED_WIDTH
}

function positionDock() {
  if (!dockWindow || dockWindow.isDestroyed() || !mainAlive()) return
  const outer = ctx.mainWindow.getBounds()
  const content = typeof ctx.mainWindow.getContentBounds === 'function'
    ? ctx.mainWindow.getContentBounds()
    : outer
  const width = currentDockWidth()
  const { screen } = ctx.electron
  const display = screen?.getDisplayMatching ? screen.getDisplayMatching(outer) : null
  const work = display?.workArea || { x: 0, y: 0, width: 3840, height: 2160 }
  const workRight = work.x + work.width
  const workBottom = work.y + work.height

  let x = outer.x + outer.width
  if (x + width > workRight) {
    // Overlay only when the screen has no room. Keep the official renderer's
    // viewport untouched while matching Mega to its visible content height.
    x = Math.max(work.x, outer.x + outer.width - width)
  }
  const desiredY = content.y
  const desiredHeight = content.height
  const y = Math.max(work.y, Math.min(desiredY, workBottom - Math.min(desiredHeight, work.height)))
  const height = Math.max(160, Math.min(desiredHeight, workBottom - y))
  dockWindow.setBounds({ x, y, width, height }, false)
}

function syncDockVisibility() {
  if (!dockWindow || dockWindow.isDestroyed()) return
  positionDock()
  if (dockCanShow()) dockWindow.showInactive()
  else dockWindow.hide()
}

function setDockExpanded(expanded, { focus = false } = {}) {
  dockExpanded = Boolean(expanded)
  dockUserHidden = false
  saveDockState()
  positionDock()
  if (dockWindow && !dockWindow.isDestroyed()) {
    if (dockCanShow()) {
      if (focus && dockExpanded) {
        dockWindow.show()
        dockWindow.focus()
      } else {
        dockWindow.showInactive()
      }
    }
    dockWindow.webContents.send('mega:changed')
  }
  return { expanded: dockExpanded, width: currentDockWidth() }
}

function toggleDock({ focus = true } = {}) {
  if (!dockWindow || dockWindow.isDestroyed()) return false
  if (dockUserHidden) {
    dockUserHidden = false
    return setDockExpanded(true, { focus })
  }
  return setDockExpanded(!dockExpanded, { focus: focus && !dockExpanded })
}

function hideDock({ user = true } = {}) {
  if (user) dockUserHidden = true
  if (dockWindow && !dockWindow.isDestroyed()) dockWindow.hide()
  return true
}

function createDock() {
  if (!dockEnabled()) {
    log('Mega dock disabled by DSH_MEGA_DOCK=0 / DSH_MEGA_WIDGET=0')
    return null
  }
  if (dockWindow && !dockWindow.isDestroyed()) return dockWindow
  if (!mainAlive()) return null

  const { BrowserWindow } = ctx.electron
  const content = typeof ctx.mainWindow.getContentBounds === 'function'
    ? ctx.mainWindow.getContentBounds()
    : ctx.mainWindow.getBounds()
  dockWindow = new BrowserWindow({
    width: currentDockWidth(),
    height: Math.max(300, content.height),
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    parent: ctx.mainWindow,
    title: 'Mega Dock',
    backgroundColor: '#11161d',
    webPreferences: {
      preload: path.join(__dirname, 'ui', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  dockWindow.setMenuBarVisibility(false)
  dockWindow.on('closed', () => { dockWindow = null })
  dockWindow.once('ready-to-show', () => syncDockVisibility())
  dockWindow.loadFile(path.join(__dirname, 'ui', 'dock.html')).catch((error) => log(`dock load failed: ${error}`))
  return dockWindow
}

function focusMain() {
  if (!mainAlive()) return false
  if (ctx.mainWindow.isMinimized()) ctx.mainWindow.restore()
  ctx.mainWindow.show()
  ctx.mainWindow.focus()
  return true
}

/**
 * The tray menu is intentionally exit-only: the main window (with the Mega dock
 * inside it) is the single product surface, so there is no second Mega window to
 * navigate to and no dock toggling from the tray.
 */
function applyTrayMenu() {
  if (!tray || !ctx?.electron?.Menu) return
  const { Menu } = ctx.electron
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Exit DS-Harness', click: () => requestShutdown('graceful') },
    { label: 'Force Exit DS-Harness', click: () => requestShutdown('force') }
  ]))
}

/**
 * Exit routing. The shell owns the managed Harness child, so both actions are
 * delegated to the shell hook when available:
 *   graceful -> stop scheduler/extensions, persist state, stop the managed
 *               Harness, destroy windows/tray, app.quit()
 *   force    -> best-effort flush, kill the managed child process tree,
 *               destroy extension/runtime resources, app.exit()
 * A failure in any step must never leave the user without a working exit.
 */
function requestShutdown(mode = 'graceful') {
  const hook = ctx?.shutdown
  try {
    if (mode === 'force') {
      if (typeof hook?.force === 'function') {
        hook.force('tray')
        return true
      }
      log('force exit requested without a shell hook; exiting directly')
      return hardExit()
    }
    if (typeof hook?.graceful === 'function') {
      hook.graceful('tray')
      return true
    }
    log('graceful exit requested without a shell hook; stopping the extension first')
    try { stop() } catch {}
    return hardExit()
  } catch (error) {
    log(`exit request failed: ${error?.message || error}`)
    return hardExit()
  }
}

function hardExit(code = 0) {
  try {
    ctx?.electron?.app?.exit?.(code)
    return true
  } catch (error) {
    log(`hard exit failed: ${error?.message || error}`)
    return false
  }
}

function createTray() {
  if (process.env.DSH_MEGA_TRAY === '0') {
    log('Mega tray disabled by DSH_MEGA_TRAY=0')
    return null
  }
  if (tray) return tray
  const { Tray, nativeImage } = ctx.electron
  if (!Tray || !nativeImage) return null
  try {
    const iconPath = path.join(PATHS.ICON, 'ds-harness.ico')
    const image = nativeImage.createFromPath(iconPath)
    if (!image || image.isEmpty()) throw new Error(`tray icon unavailable: ${iconPath}`)
    tray = new Tray(image)
    tray.setToolTip('DS-Harness · DeepSeek Harness')
    // Double click always brings the single product window back.
    tray.on('double-click', focusMain)
    applyTrayMenu()
    return tray
  } catch (error) {
    log(`tray init failed: ${error?.message || error}`)
    return null
  }
}

function bindMainWindow() {
  if (!mainAlive()) return
  const bind = (event, handler) => {
    ctx.mainWindow.on(event, handler)
    mainWindowBindings.push([event, handler])
  }
  const reposition = () => syncDockVisibility()
  bind('move', reposition)
  bind('resize', reposition)
  bind('maximize', reposition)
  bind('unmaximize', reposition)
  bind('restore', reposition)
  bind('show', reposition)
  bind('minimize', () => hideDock({ user: false }))
  bind('hide', () => hideDock({ user: false }))
  bind('closed', () => {
    if (dockWindow && !dockWindow.isDestroyed()) dockWindow.destroy()
  })
}

function unbindMainWindow() {
  if (!ctx?.mainWindow || ctx.mainWindow.isDestroyed()) {
    mainWindowBindings.length = 0
    return
  }
  for (const [event, handler] of mainWindowBindings.splice(0)) ctx.mainWindow.removeListener(event, handler)
}

/** One entry point for every terminal alert source. */
function dispatchTerminal(event) {
  const outcome = terminalDispatcher.dispatch(event)
  if (outcome.reason && outcome.reason.startsWith('error:')) {
    log(`terminal alert failed for ${event?.taskId}: ${outcome.reason}`)
  }
  notifyChanged()
  return outcome
}

function registerIpc() {
  const { ipcMain, dialog } = ctx.electron
  for (const channel of CHANNELS) ipcMain.removeHandler(channel)
  ipcMain.handle('mega:snapshot', () => snapshot())
  ipcMain.handle('mega:add-task', (_event, payload) => scheduler.addTask(payload || {}))
  ipcMain.handle('mega:reorder-task', (_event, id, move) => scheduler.reorderTask(String(id || ''), move))
  ipcMain.handle('mega:cancel-task', (_event, id) => scheduler.cancelTask(String(id || '')))
  ipcMain.handle('mega:clear-pending', () => scheduler.clearPending())
  ipcMain.handle('mega:remove-tasks', (_event, ids) => scheduler.removeTasks(Array.isArray(ids) ? ids : []))
  ipcMain.handle('mega:update-scheduler', (_event, patch) => scheduler.updateConfig(patch || {}))
  ipcMain.handle('mega:refresh-hardware', () => {
    const value = scheduler.refreshSystem()
    notifyChanged()
    return value
  })
  ipcMain.handle('mega:update-settings', (_event, patch = {}) => {
    const envPatch = {}
    if (typeof patch.permissionMode === 'string') envPatch.DSH_PERMISSION_MODE = patch.permissionMode
    if (typeof patch.telemetryMode === 'string') envPatch.DSH_TELEMETRY_MODE = patch.telemetryMode
    if (Object.prototype.hasOwnProperty.call(patch, 'apiKey')) envPatch.DEEPSEEK_API_KEY = String(patch.apiKey || '')
    if (Object.keys(envPatch).length) settingsService.writeEnvFile(envPatch)
    settingsService.applyPatch({
      model: patch.model,
      soundEnabled: patch.soundEnabled,
      sound: patch.sound,
      notifications: patch.notifications
    })
    notifyChanged()
    return settingsService.publicSettings()
  })
  // Single balance refresh entry point: the renderer only supplies which trigger
  // fired (module-open / manual / retry); the service owns the implementation.
  ipcMain.handle('mega:balance', async (_event, trigger = 'manual', options = {}) => {
    try {
      const only = Array.isArray(options?.only) && options.only.length ? options.only : null
      const result = await balanceService.refreshBalances(typeof trigger === 'string' ? trigger : 'manual', { only })
      notifyChanged()
      return result
    } catch (error) {
      // A balance failure is an outer-service failure: report, never throw.
      log(`balance refresh failed: ${error?.stack || error}`)
      notifyChanged()
      return { ...balanceService.describe(), error: { code: 'REFRESH_FAILED', message: String(error?.message || error) } }
    }
  })
  ipcMain.handle('mega:pick-workspace', async () => {
    const result = await dialog.showOpenDialog(ctx.mainWindow, {
      title: '选择 headless 队列工作区',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths.length) return null
    return workspace.setWorkspaceRoot(result.filePaths[0])
  })
  ipcMain.handle('mega:pick-sound', async () => {
    const result = await dialog.showOpenDialog(ctx.mainWindow, {
      title: '导入任务提示音',
      properties: ['openFile'],
      filters: [{ name: 'Audio', extensions: ['wav', 'mp3'] }]
    })
    if (result.canceled || !result.filePaths.length) return null
    const file = result.filePaths[0]
    return soundService.saveUpload(path.basename(file), fs.readFileSync(file))
  })
  ipcMain.handle('mega:dock-toggle', () => toggleDock({ focus: true }))
  ipcMain.handle('mega:dock-expand', (_event, expanded) => setDockExpanded(Boolean(expanded), { focus: Boolean(expanded) }))
}

async function start(context) {
  if (started) return
  started = true
  ctx = context
  if (ctx.nodeExe) process.env.DSH_NODE = ctx.nodeExe
  loadDockState()
  registerIpc()
  // Desktop notifications are a unified lifecycle capability: bind the Electron
  // notification factory once, before any task can reach a terminal state.
  notificationService.setCreateNotification(ctx.electron?.Notification || null)
  notificationService.setOnClick(() => focusMain())
  scheduler.on('queue-changed', notifyChanged)
  scheduler.on(TERMINAL_EVENT, dispatchTerminal)
  scheduler.on('terminal-queue-migrated', ({ migrated, total }) => {
    log(`startup recovery moved ${migrated}/${total} terminal task(s) out of the active queue into history`)
  })
  scheduler.on('error', (error) => log(`scheduler error: ${error?.stack || error}`))
  scheduler.start()
  // Ordinary official Harness sessions are announced by the session observer;
  // scheduler-dispatched and headless tasks are already covered by the
  // scheduler's own terminal event, and are filtered out of the observer.
  terminalObserver.on(TERMINAL_EVENT, dispatchTerminal)
  terminalObserver.start()
  shortcutHandler = (event, input) => {
    if (input.type !== 'keyDown') return
    const key = String(input.key || '').toLowerCase()
    if (input.control && input.shift && key === 'm') {
      event.preventDefault()
      toggleDock({ focus: true })
    }
  }
  ctx.mainWindow.webContents.on('before-input-event', shortcutHandler)
  bindMainWindow()
  createDock()
  createTray()
  if (process.argv.includes('--mega-dock')) setDockExpanded(true, { focus: true })
  log('ready; single-window Mega dock + ordered queue + hardware-adaptive concurrency enabled')
}

function stop() {
  if (!started) return
  started = false
  try { terminalObserver.stop() } catch {}
  try { scheduler.stop() } catch {}
  notificationService.setCreateNotification(null)
  notificationService.setOnClick(null)
  if (ctx?.mainWindow && shortcutHandler && !ctx.mainWindow.isDestroyed()) {
    ctx.mainWindow.webContents.removeListener('before-input-event', shortcutHandler)
  }
  unbindMainWindow()
  for (const channel of CHANNELS) {
    try { ctx?.electron?.ipcMain?.removeHandler(channel) } catch {}
  }
  if (tray) {
    try { tray.destroy() } catch {}
  }
  if (dockWindow && !dockWindow.isDestroyed()) dockWindow.destroy()
  if (playerWindow && !playerWindow.isDestroyed()) playerWindow.destroy()
  tray = null
  dockWindow = null
  playerWindow = null
  shortcutHandler = null
  ctx = null
}

module.exports = { start, stop, toggleDock, setDockExpanded, requestShutdown }
