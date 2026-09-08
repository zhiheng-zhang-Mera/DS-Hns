'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const scheduler = require('./scheduler/scheduler')
const settingsService = require('./settings/settings-service')
const soundService = require('./notifications/sound-service')
const balanceService = require('./deepseek/api')
const sessionReader = require('./tracker/session-reader')
const taskHistory = require('./tracker/task-history')
const workspace = require('./utils/workspace')
const PricingRepository = require('./billing/pricing-repository')
const { calculateTaskCost } = require('./billing/cost-calculator')

const pricing = new PricingRepository()
const CHANNELS = [
  'mega:snapshot', 'mega:add-task', 'mega:cancel-task', 'mega:clear-pending',
  'mega:remove-tasks', 'mega:update-scheduler', 'mega:update-settings',
  'mega:balance', 'mega:pick-workspace', 'mega:pick-sound', 'mega:open-main',
  'mega:open-tools', 'mega:widget-hide'
]

const WIDGET_WIDTH = 238
const WIDGET_HEIGHT = 62
const WIDGET_GAP = 8

let ctx = null
let toolsWindow = null
let widgetWindow = null
let playerWindow = null
let tray = null
let shortcutHandler = null
let lastBalance = null
let started = false
let widgetUserHidden = false
const mainWindowBindings = []

function log(message) {
  ctx?.log?.(`[mega] ${message}`)
}

function mainAlive() {
  return Boolean(ctx?.mainWindow && !ctx.mainWindow.isDestroyed())
}

function costForSession(session) {
  try {
    const model = pricing.getModel(session.model)
    if (!model) return null
    return calculateTaskCost({ model, schedule: pricing.getSchedule(), events: session.usageEvents || [] })
  } catch {
    return null
  }
}

function snapshot() {
  const sessions = sessionReader.listSessions({ limit: 40 }).map((session) => ({
    ...session,
    cost: costForSession(session)
  }))
  return {
    extension: {
      id: 'mega',
      mode: 'optional-feature-extension',
      shellOwner: 'alien',
      companionWidget: Boolean(widgetWindow && !widgetWindow.isDestroyed() && widgetWindow.isVisible()),
      tray: Boolean(tray)
    },
    scheduler: scheduler.describe(),
    tasks: scheduler.listTasks({ limit: 200 }),
    sessions,
    recent: taskHistory.loadRecent(),
    settings: settingsService.publicSettings(),
    workspace: workspace.getWorkspaceRoot(),
    soundFiles: soundService.listSoundFiles(),
    balance: lastBalance
  }
}

function notifyChanged() {
  for (const win of [toolsWindow, widgetWindow]) {
    if (win && !win.isDestroyed()) win.webContents.send('mega:changed')
  }
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

function openTools() {
  if (toolsWindow && !toolsWindow.isDestroyed()) {
    if (toolsWindow.isMinimized()) toolsWindow.restore()
    toolsWindow.show()
    toolsWindow.focus()
    return toolsWindow
  }
  const { BrowserWindow, shell } = ctx.electron
  toolsWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 880,
    minHeight: 620,
    title: 'DS-Harness · Mega Extensions',
    backgroundColor: '#101317',
    autoHideMenuBar: true,
    show: false,
    parent: mainAlive() ? ctx.mainWindow : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'ui', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  toolsWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  toolsWindow.once('ready-to-show', () => toolsWindow.show())
  toolsWindow.on('closed', () => { toolsWindow = null })
  toolsWindow.loadFile(path.join(__dirname, 'ui', 'index.html')).catch((error) => log(`tools load failed: ${error}`))
  return toolsWindow
}

function widgetCanShow() {
  if (process.env.DSH_MEGA_WIDGET === '0') return false
  if (widgetUserHidden || !mainAlive()) return false
  return ctx.mainWindow.isVisible() && !ctx.mainWindow.isMinimized()
}

function positionWidget() {
  if (!widgetWindow || widgetWindow.isDestroyed() || !mainAlive()) return
  const bounds = ctx.mainWindow.getBounds()
  const { screen } = ctx.electron
  const display = screen?.getDisplayMatching ? screen.getDisplayMatching(bounds) : null
  const work = display?.workArea || { x: 0, y: 0, width: 3840, height: 2160 }

  let x = bounds.x + bounds.width + WIDGET_GAP
  const workRight = work.x + work.width
  if (x + WIDGET_WIDTH > workRight) {
    x = Math.max(work.x, bounds.x + bounds.width - WIDGET_WIDTH - 14)
  }
  let y = bounds.y + 78
  const workBottom = work.y + work.height
  y = Math.max(work.y, Math.min(y, workBottom - WIDGET_HEIGHT))
  widgetWindow.setBounds({ x, y, width: WIDGET_WIDTH, height: WIDGET_HEIGHT }, false)
}

function showWidget() {
  if (!widgetWindow || widgetWindow.isDestroyed()) return false
  widgetUserHidden = false
  positionWidget()
  if (widgetCanShow()) widgetWindow.showInactive()
  updateTrayMenu()
  return true
}

function hideWidget({ user = true } = {}) {
  if (user) widgetUserHidden = true
  if (widgetWindow && !widgetWindow.isDestroyed()) widgetWindow.hide()
  updateTrayMenu()
  return true
}

function toggleWidget() {
  if (!widgetWindow || widgetWindow.isDestroyed()) return false
  if (widgetWindow.isVisible() && !widgetUserHidden) hideWidget({ user: true })
  else showWidget()
  return true
}

function createWidget() {
  if (process.env.DSH_MEGA_WIDGET === '0') {
    log('companion widget disabled by DSH_MEGA_WIDGET=0')
    return null
  }
  if (widgetWindow && !widgetWindow.isDestroyed()) return widgetWindow
  if (!mainAlive()) return null

  const { BrowserWindow } = ctx.electron
  widgetWindow = new BrowserWindow({
    width: WIDGET_WIDTH,
    height: WIDGET_HEIGHT,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    parent: ctx.mainWindow,
    title: 'Mega Companion',
    backgroundColor: '#11161d',
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'ui', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  widgetWindow.setMenuBarVisibility(false)
  widgetWindow.on('closed', () => {
    widgetWindow = null
    updateTrayMenu()
  })
  widgetWindow.once('ready-to-show', () => {
    positionWidget()
    if (widgetCanShow()) widgetWindow.showInactive()
  })
  widgetWindow.loadFile(path.join(__dirname, 'ui', 'widget.html')).catch((error) => log(`widget load failed: ${error}`))
  return widgetWindow
}

function focusMain() {
  if (!mainAlive()) return false
  if (ctx.mainWindow.isMinimized()) ctx.mainWindow.restore()
  ctx.mainWindow.show()
  ctx.mainWindow.focus()
  return true
}

function updateTrayMenu() {
  if (!tray || !ctx?.electron?.Menu) return
  const { Menu, app } = ctx.electron
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Official Harness', click: focusMain },
    { label: 'Mega Extensions', click: openTools },
    {
      label: widgetUserHidden || !widgetWindow?.isVisible() ? 'Show Mega Companion' : 'Hide Mega Companion',
      enabled: process.env.DSH_MEGA_WIDGET !== '0',
      click: toggleWidget
    },
    { type: 'separator' },
    { label: 'Exit DS-Harness', click: () => app.quit() }
  ]))
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
    const iconPath = path.join(ctx.root, 'assets', 'icon', 'ds-harness.ico')
    const image = nativeImage.createFromPath(iconPath)
    if (!image || image.isEmpty()) throw new Error(`tray icon unavailable: ${iconPath}`)
    tray = new Tray(image)
    tray.setToolTip('DS-Harness · Mega Companion')
    tray.on('double-click', focusMain)
    updateTrayMenu()
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
  const reposition = () => {
    positionWidget()
    if (widgetCanShow() && widgetWindow && !widgetWindow.isDestroyed()) widgetWindow.showInactive()
  }
  bind('move', reposition)
  bind('resize', reposition)
  bind('maximize', reposition)
  bind('unmaximize', reposition)
  bind('restore', reposition)
  bind('show', reposition)
  bind('minimize', () => hideWidget({ user: false }))
  bind('hide', () => hideWidget({ user: false }))
  bind('closed', () => {
    if (widgetWindow && !widgetWindow.isDestroyed()) widgetWindow.destroy()
    if (toolsWindow && !toolsWindow.isDestroyed()) toolsWindow.destroy()
  })
}

function unbindMainWindow() {
  if (!ctx?.mainWindow || ctx.mainWindow.isDestroyed()) {
    mainWindowBindings.length = 0
    return
  }
  for (const [event, handler] of mainWindowBindings.splice(0)) {
    ctx.mainWindow.removeListener(event, handler)
  }
}

function registerIpc() {
  const { ipcMain, dialog } = ctx.electron
  for (const channel of CHANNELS) ipcMain.removeHandler(channel)

  ipcMain.handle('mega:snapshot', () => snapshot())
  ipcMain.handle('mega:add-task', (_event, payload) => scheduler.addTask(payload || {}))
  ipcMain.handle('mega:cancel-task', (_event, id) => scheduler.cancelTask(String(id || '')))
  ipcMain.handle('mega:clear-pending', () => scheduler.clearPending())
  ipcMain.handle('mega:remove-tasks', (_event, ids) => scheduler.removeTasks(Array.isArray(ids) ? ids : []))
  ipcMain.handle('mega:update-scheduler', (_event, patch) => scheduler.updateConfig(patch || {}))
  ipcMain.handle('mega:update-settings', (_event, patch = {}) => {
    const envPatch = {}
    if (typeof patch.permissionMode === 'string') envPatch.DSH_PERMISSION_MODE = patch.permissionMode
    if (typeof patch.telemetryMode === 'string') envPatch.DSH_TELEMETRY_MODE = patch.telemetryMode
    if (Object.prototype.hasOwnProperty.call(patch, 'apiKey')) envPatch.DEEPSEEK_API_KEY = String(patch.apiKey || '')
    if (Object.keys(envPatch).length) settingsService.writeEnvFile(envPatch)
    settingsService.applyPatch({ model: patch.model, soundEnabled: patch.soundEnabled, sound: patch.sound })
    notifyChanged()
    return settingsService.publicSettings()
  })
  ipcMain.handle('mega:balance', async () => {
    lastBalance = await balanceService.fetchBalance()
    notifyChanged()
    return lastBalance
  })
  ipcMain.handle('mega:pick-workspace', async () => {
    const result = await dialog.showOpenDialog(toolsWindow || ctx.mainWindow, {
      title: '选择 headless 队列工作区',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths.length) return null
    return workspace.setWorkspaceRoot(result.filePaths[0])
  })
  ipcMain.handle('mega:pick-sound', async () => {
    const result = await dialog.showOpenDialog(toolsWindow || ctx.mainWindow, {
      title: '导入任务提示音',
      properties: ['openFile'],
      filters: [{ name: 'Audio', extensions: ['wav', 'mp3'] }]
    })
    if (result.canceled || !result.filePaths.length) return null
    const file = result.filePaths[0]
    return soundService.saveUpload(path.basename(file), fs.readFileSync(file))
  })
  ipcMain.handle('mega:open-main', focusMain)
  ipcMain.handle('mega:open-tools', () => Boolean(openTools()))
  ipcMain.handle('mega:widget-hide', () => hideWidget({ user: true }))
}

async function start(context) {
  if (started) return
  started = true
  ctx = context
  if (ctx.nodeExe) process.env.DSH_NODE = ctx.nodeExe
  registerIpc()
  scheduler.on('queue-changed', notifyChanged)
  scheduler.on('task-terminal', (event) => {
    ring(event.status)
    notifyChanged()
  })
  scheduler.on('error', (error) => log(`scheduler error: ${error?.stack || error}`))
  scheduler.start()

  shortcutHandler = (event, input) => {
    if (input.type !== 'keyDown') return
    const key = String(input.key || '').toLowerCase()
    if (input.control && input.shift && key === 'm') {
      event.preventDefault()
      openTools()
    }
  }
  ctx.mainWindow.webContents.on('before-input-event', shortcutHandler)
  bindMainWindow()
  createWidget()
  createTray()
  if (process.argv.includes('--mega-tools')) openTools()
  log('ready; companion widget + tray restored; Ctrl+Shift+M opens full Mega tools')
}

function stop() {
  if (!started) return
  started = false
  try { scheduler.stop() } catch {}
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
  if (toolsWindow && !toolsWindow.isDestroyed()) toolsWindow.destroy()
  if (widgetWindow && !widgetWindow.isDestroyed()) widgetWindow.destroy()
  if (playerWindow && !playerWindow.isDestroyed()) playerWindow.destroy()
  tray = null
  toolsWindow = null
  widgetWindow = null
  playerWindow = null
  shortcutHandler = null
  ctx = null
}

module.exports = { start, stop, openTools, toggleWidget }
