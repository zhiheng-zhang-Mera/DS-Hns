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
  'mega:balance', 'mega:pick-workspace', 'mega:pick-sound', 'mega:open-main'
]

let ctx = null
let toolsWindow = null
let playerWindow = null
let shortcutHandler = null
let lastBalance = null
let started = false

function log(message) {
  ctx?.log?.(`[mega] ${message}`)
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
    extension: { id: 'mega', mode: 'optional-feature-extension', shellOwner: 'alien' },
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
  if (toolsWindow && !toolsWindow.isDestroyed()) {
    toolsWindow.webContents.send('mega:changed')
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
    parent: ctx.mainWindow,
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
  ipcMain.handle('mega:open-main', () => {
    const win = ctx.mainWindow
    if (!win || win.isDestroyed()) return false
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    return true
  })
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
  if (process.argv.includes('--mega-tools')) openTools()
  log('ready; Ctrl+Shift+M opens the optional tools window')
}

function stop() {
  if (!started) return
  started = false
  try { scheduler.stop() } catch {}
  if (ctx?.mainWindow && shortcutHandler && !ctx.mainWindow.isDestroyed()) {
    ctx.mainWindow.webContents.removeListener('before-input-event', shortcutHandler)
  }
  for (const channel of CHANNELS) {
    try { ctx?.electron?.ipcMain?.removeHandler(channel) } catch {}
  }
  if (toolsWindow && !toolsWindow.isDestroyed()) toolsWindow.destroy()
  if (playerWindow && !playerWindow.isDestroyed()) playerWindow.destroy()
  toolsWindow = null
  playerWindow = null
  shortcutHandler = null
  ctx = null
}

module.exports = { start, stop, openTools }
