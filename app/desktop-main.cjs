'use strict'
/**
 * DS-Harness desktop shell — Alien-derived canonical core.
 *
 * The main renderer is the official @deepseek-ai/dsh Web UI and intentionally
 * has NO preload script, NO DOM injection and NO dependency on Mega features.
 * Optional extensions start only after the official UI has loaded.
 */
const { app, BrowserWindow, dialog, shell, ipcMain } = require('electron')
const { spawn, spawnSync } = require('node:child_process')
const http = require('node:http')
const path = require('node:path')
const fs = require('node:fs')

const ROOT = path.resolve(__dirname, '..')
const HARNESS_URL = 'http://127.0.0.1:3080/'
const DSH_ENTRY = path.join(__dirname, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const STARTUP_TIMEOUT_MS = 90_000

let mainWindow = null
let harnessProcess = null
let shuttingDown = false
let harnessUrl = null
let resolveHarnessUrl = null
let rejectHarnessUrl = null
let extensionManager = null

process.env.DSH_ROOT = process.env.DSH_ROOT || ROOT
process.env.DSH_HOME = process.env.DSH_HOME || path.join(ROOT, 'data')
app.setName('DS-Harness')
app.setPath('userData', path.join(ROOT, 'data', 'desktop-shell'))

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) app.quit()

function logLine(message) {
  try {
    fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true })
    fs.appendFileSync(path.join(ROOT, 'logs', 'desktop-runtime.log'), `${new Date().toISOString()} ${String(message)}\n`, 'utf8')
  } catch {}
}

function redact(text) {
  return String(text).replace(/(\?token=)[^\s]+/g, '$1[REDACTED]')
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
  for (const dir of ['logs', 'temp', 'cache', 'data', 'workspace']) {
    fs.mkdirSync(path.join(ROOT, dir), { recursive: true })
  }
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

async function waitForHarness() {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (harnessUrl && await requestHarness(harnessUrl)) return harnessUrl
    if (harnessProcess?.exitCode !== null) throw new Error(`Harness 服务提前退出，代码 ${harnessProcess.exitCode}`)
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  throw new Error(`Harness 服务在 ${STARTUP_TIMEOUT_MS / 1000} 秒内未就绪`)
}

function startHarness(nodeExe) {
  const urlPromise = new Promise((resolve, reject) => {
    resolveHarnessUrl = resolve
    rejectHarnessUrl = reject
  })
  ensureRuntimeDirs()
  harnessProcess = spawn(nodeExe, [DSH_ENTRY, 'web', '--no-open'], {
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

  const log = fs.createWriteStream(path.join(ROOT, 'logs', 'desktop-runtime.log'), { flags: 'a' })
  harnessProcess.stdout.on('data', (chunk) => {
    const text = chunk.toString()
    const match = text.match(/http:\/\/127\.0\.0\.1:3080\/\?token=[^\s]+/)
    if (match && !harnessUrl) {
      harnessUrl = match[0]
      resolveHarnessUrl(harnessUrl)
    }
    log.write(redact(text))
  })
  harnessProcess.stderr.on('data', (chunk) => log.write(redact(chunk.toString())))
  harnessProcess.once('error', (error) => {
    log.write(`\n[desktop] ${error.stack || error}\n`)
    rejectHarnessUrl(error)
  })
  harnessProcess.once('exit', (code) => {
    if (!harnessUrl) rejectHarnessUrl(new Error(`Harness 服务提前退出，代码 ${code}`))
  })
  return urlPromise
}

function stopHarness() {
  if (!harnessProcess || harnessProcess.exitCode !== null) return
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/pid', String(harnessProcess.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  } else {
    harnessProcess.kill('SIGTERM')
  }
}

function createWindow() {
  // Keep this BrowserWindow contract aligned with Harness-Alien.
  // In particular: DO NOT add preload here. The official dsh renderer owns itself.
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 640,
    title: 'DS-Harness · DeepSeek Harness',
    backgroundColor: '#0b0f14',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(HARNESS_URL)) return { action: 'allow' }
    shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(HARNESS_URL)) {
      event.preventDefault()
      shell.openExternal(url)
    }
  })
  mainWindow.webContents.on('render-process-gone', (_event, details) => logLine(`official renderer gone: ${JSON.stringify(details)}`))
  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.on('closed', () => { mainWindow = null })
}

async function startExtensions(nodeExe) {
  if (process.env.DSH_DISABLE_MEGA === '1') {
    logLine('Mega extensions disabled by DSH_DISABLE_MEGA=1')
    return
  }
  try {
    extensionManager = require('./extensions/manager.cjs')
    await extensionManager.start({
      root: ROOT,
      nodeExe,
      mainWindow,
      log: logLine,
      electron: { app, BrowserWindow, dialog, shell, ipcMain }
    })
  } catch (error) {
    logLine(`extension manager failed without affecting official UI: ${error?.stack || error}`)
  }
}

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return
  createWindow()
  try {
    if (await requestHarness(HARNESS_URL)) throw new Error('端口 3080 已被其他 Harness 实例占用，请先关闭旧实例')
    const nodeExe = resolveNodeExe()
    await Promise.race([
      startHarness(nodeExe),
      new Promise((_, reject) => setTimeout(() => reject(new Error('未收到 Harness 访问令牌')), STARTUP_TIMEOUT_MS))
    ])
    const readyUrl = await waitForHarness()
    await mainWindow.loadURL(readyUrl)
    // Official renderer is loaded first. Optional feature failures cannot black-screen it.
    await startExtensions(nodeExe)
  } catch (error) {
    await dialog.showMessageBox({
      type: 'error',
      title: 'DS-Harness 启动失败',
      message: '无法启动官方 DeepSeek Harness Web UI',
      detail: String(error.stack || error)
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
  if (shuttingDown) return
  shuttingDown = true
  try { extensionManager?.stop?.() } catch {}
  stopHarness()
})
process.on('exit', stopHarness)
