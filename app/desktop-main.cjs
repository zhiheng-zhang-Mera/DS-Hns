'use strict'
/**
 * DS-Harness — DeepSeek Harness 桌面客户端（Alien 式外壳 + Mega 调度中心合并壳）。
 *
 * 单进程做两件事:
 *   1. 拉起官方 dsh Web UI（headless dsh 引擎,默认 http://127.0.0.1:3080/,引擎 home = <root>\data）
 *   2. 同进程内运行 3300 调度中心监控服务（队列/峰谷/计费/跟踪/铃声事件）
 * 主窗口默认加载 dsh Web;菜单/快捷键可切换到调度中心各视图(聊天/监控/设置)。
 * 铃声事件由 3300 服务推送,经隐藏“音频宿主”窗口播放——无论当前停留在哪个视图都会响。
 *
 * 端口可用环境变量覆盖（测试/端口冲突时）:DSH_UI_PORT, DSH_DSH_WEB_PORT。
 * 关闭窗口即停止 dsh 引擎与监控服务;日志中认证令牌一律脱敏。
 */
const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron')
const { spawn, spawnSync } = require('node:child_process')
const http = require('node:http')
const path = require('node:path')
const fs = require('node:fs')

const paths = require('./monitor/utils/paths')
const { ROOT, PATHS, app: appConfig } = paths
const { loadProjectEnv } = require('./monitor/utils/env')

// Ports: environment wins, then config/app.json.
process.env.DSH_UI_PORT = process.env.DSH_UI_PORT || String(appConfig.ui?.port || 3300)
process.env.DSH_DSH_WEB_HOST = process.env.DSH_DSH_WEB_HOST || appConfig.dshWeb?.host || '127.0.0.1'
process.env.DSH_DSH_WEB_PORT = process.env.DSH_DSH_WEB_PORT || String(appConfig.dshWeb?.port || 3080)

const { startServer, stopServer, setBellHook } = require('./monitor/ui/server')
const soundService = require('./monitor/notifications/sound-service')

// .env secrets (API key etc.) must be in process.env before the engine starts.
loadProjectEnv()

const UI_ORIGIN = `http://127.0.0.1:${process.env.DSH_UI_PORT}`
const DSH_ORIGIN = `http://${process.env.DSH_DSH_WEB_HOST}:${process.env.DSH_DSH_WEB_PORT}`
const DSH_ENTRY = path.join(__dirname, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const PRELOAD = path.join(__dirname, 'electron-assets', 'preload.js')
const STARTUP_TIMEOUT_MS = 90_000
const VIEW_PATHS = { chat: '/chat.html', monitor: '/', settings: '/settings.html' }

const smokeTest = process.argv.includes('--smoke-test')
const noDshWeb = process.env.DSH_NO_DSH_WEB === '1' || smokeTest
const startView = process.env.DSH_START_VIEW || 'dsh'

let mainWindow = null
let engineProcess = null
let lastDshUrl = null
let shuttingDown = false
let playerWindow = null

app.setName('DS-Harness')
app.setPath('userData', path.join(ROOT, 'data', 'desktop-shell'))

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) app.quit()

function logLine(msg) {
  try {
    fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true })
    fs.appendFileSync(path.join(ROOT, 'logs', 'desktop-runtime.log'), `${new Date().toISOString()} ${msg}\n`, 'utf8')
  } catch {
    /* never crash the shell because logging failed */
  }
}

/** Redact any `?token=…` in text before it touches disk. */
function redact(text) {
  return String(text).replace(/(\?token=)[^\s]+/g, '$1[REDACTED]')
}

/* ------------------------------------------------------------------ *
 *  dsh engine (official DeepSeek Harness Web UI) child process
 * ------------------------------------------------------------------ */

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
  return process.env.DSH_NODE || 'node'
}

function requestOk(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 1500 }, (res) => {
      res.resume()
      resolve(res.statusCode >= 200 && res.statusCode < 400)
    })
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve(false))
  })
}

function stopEngine() {
  if (!engineProcess || engineProcess.exitCode !== null) return
  try {
    spawnSync('taskkill.exe', ['/pid', String(engineProcess.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  } catch {
    /* already gone */
  }
}

function startEngine() {
  return new Promise((resolve, reject) => {
    const nodeExe = resolveNodeExe()
    logLine(`starting dsh web engine: ${nodeExe} ${DSH_ENTRY} web --no-open (port ${process.env.DSH_DSH_WEB_PORT})`)
    engineProcess = spawn(
      nodeExe,
      [DSH_ENTRY, 'web', '--host', process.env.DSH_DSH_WEB_HOST, '--port', String(process.env.DSH_DSH_WEB_PORT), '--no-open'],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          DSH_HOME: PATHS.DSH_HOME,
          npm_config_cache: path.join(PATHS.CACHE, 'npm'),
          TEMP: PATHS.TEMP,
          TMP: PATHS.TEMP,
          PATH: `${path.dirname(nodeExe)};${process.env.PATH || ''}`
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      }
    )

    const startedAt = Date.now()
    let engineUrl = null
    engineProcess.stdout.on('data', (chunk) => {
      const text = chunk.toString()
      const match = text.match(/(http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/)
      if (match && !engineUrl) {
        engineUrl = match[1]
        logLine(`engine URL ready: ${redact(engineUrl)}`)
        resolve(engineUrl)
      }
      logLine(redact(text))
    })
    engineProcess.stderr.on('data', (chunk) => logLine(redact(chunk.toString())))
    engineProcess.once('error', (err) => {
      logLine(`engine spawn error: ${err.stack || err}`)
      reject(new Error(`找不到可用的 Node.js/引擎: ${err.message || err}`))
    })
    engineProcess.once('exit', (code) => {
      logLine(`engine exited code=${code}`)
      if (!engineUrl) reject(new Error(`dsh 引擎提前退出，代码 ${code}`))
    })

    // Fallback poll if the URL was not printed but the server is up.
    const deadline = startedAt + STARTUP_TIMEOUT_MS
    const poll = async () => {
      if (engineUrl) return
      if (Date.now() > deadline) {
        reject(new Error(`dsh 引擎在 ${STARTUP_TIMEOUT_MS / 1000} 秒内未就绪`))
        return
      }
      if (engineProcess.exitCode !== null) return
      if (await requestOk(`${DSH_ORIGIN}/`)) {
        engineUrl = `${DSH_ORIGIN}/`
        resolve(engineUrl)
        return
      }
      setTimeout(poll, 400)
    }
    setTimeout(poll, 800)
  })
}

/* ------------------------------------------------------------------ *
 *  audio host (hidden window that actually plays ringtones)
 * ------------------------------------------------------------------ */

function ensurePlayerWindow() {
  if (playerWindow && !playerWindow.isDestroyed()) return Promise.resolve(playerWindow)
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      width: 320,
      height: 120,
      show: false,
      skipTaskbar: true,
      webPreferences: {
        preload: PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })
    playerWindow = win
    win.on('closed', () => {
      playerWindow = null
    })
    win.loadURL(`${UI_ORIGIN}/player.html`).then(() => resolve(win)).catch(reject)
  })
}

function playInHost(url, volume) {
  ensurePlayerWindow()
    .then((win) => {
      if (win.webContents.isLoading()) {
        win.webContents.once('did-finish-load', () => win.webContents.send('ds-player:play-request', { url, volume }))
      } else {
        win.webContents.send('ds-player:play-request', { url, volume })
      }
    })
    .catch((err) => logLine(`audio host unavailable: ${err?.message || err}`))
}

function ringBell(bell) {
  try {
    const audio = soundService.resolveBellAudio(bell.event)
    if (!audio) return // master/per-event switch off or file missing
    logLine(`ringtone ${bell.event} -> ${audio.name}`)
    playInHost(`${UI_ORIGIN}${audio.url}`, audio.volume)
  } catch (err) {
    logLine(`ringtone failed: ${err?.message || err}`)
  }
}

// From the 3300 settings page ("试听") when running under Electron.
ipcMain.on('ds-player:play', (_event, payload) => {
  if (!payload || typeof payload.url !== 'string') return
  playInHost(payload.url, payload.volume)
})

/* ------------------------------------------------------------------ *
 *  main window + view switching
 * ------------------------------------------------------------------ */

function isAllowedOrigin(url) {
  try {
    const u = new URL(url)
    return u.origin === UI_ORIGIN || u.origin === DSH_ORIGIN
  } catch {
    return false
  }
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 640,
    title: 'DS-Harness · DeepSeek Harness',
    backgroundColor: '#0b0f14',
    show: false,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedOrigin(url)) return { action: 'allow' }
    shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isAllowedOrigin(url)) return
    event.preventDefault()
    shell.openExternal(url)
  })
  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  return mainWindow
}

function goDsh() {
  if (!mainWindow) return
  if (lastDshUrl) {
    mainWindow.loadURL(lastDshUrl)
  } else {
    goUi(VIEW_PATHS.chat)
  }
}

function goUi(viewPath) {
  if (!mainWindow) return
  mainWindow.loadURL(`${UI_ORIGIN}${viewPath}`)
}

function buildMenu() {
  const template = [
    {
      label: '文件',
      submenu: [{ label: '退出 DS-Harness', accelerator: 'CmdOrCtrl+Q', role: 'quit' }]
    },
    {
      label: '视图',
      submenu: [
        { label: 'DeepSeek Harness 对话 (dsh Web)', accelerator: 'CmdOrCtrl+1', click: () => goDsh() },
        { label: '调度中心 · 聊天', accelerator: 'CmdOrCtrl+2', click: () => goUi(VIEW_PATHS.chat) },
        { label: '调度中心 · 监控', accelerator: 'CmdOrCtrl+3', click: () => goUi(VIEW_PATHS.monitor) },
        { label: '调度中心 · 设置(铃声/密钥/并发…)', accelerator: 'CmdOrCtrl+4', click: () => goUi(VIEW_PATHS.settings) },
        { type: 'separator' },
        { label: '重新加载', role: 'reload' },
        { label: '开发者工具', role: 'toggleDevTools' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于 DS-Harness',
          click: () => {
            dialog.showMessageBox({
              type: 'info',
              title: 'DS-Harness',
              message: 'DS-Harness · DeepSeek Harness Desktop',
              detail:
                `主界面:官方 dsh Web (${DSH_ORIGIN})\n调度中心: ${UI_ORIGIN}\n` +
                `引擎数据目录: ${PATHS.DSH_HOME}\n` +
                `铃声配置: config\\sound.json(总开关/每事件开关/预设/本地文件)`
            })
          }
        }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/* ------------------------------------------------------------------ *
 *  lifecycle
 * ------------------------------------------------------------------ */

app.whenReady().then(async () => {
  buildMenu()
  try {
    startServer()
  } catch (err) {
    dialog.showErrorBox('DS-Harness 启动失败', `调度中心服务无法启动(端口可能被占用):\n${err?.message || err}`)
    app.quit()
    return
  }
  setBellHook(ringBell)
  logLine(`monitor ${UI_ORIGIN} ready (dsh web ${DSH_ORIGIN})`)

  if (smokeTest) {
    console.log('electron smoke ok')
    setTimeout(() => app.quit(), 1500)
    return
  }

  createMainWindow()
  if (startView === 'dsh' && !noDshWeb) {
    try {
      if (await requestOk(`${DSH_ORIGIN}/`)) {
        throw new Error(`端口 ${process.env.DSH_DSH_WEB_PORT} 已被其他 Harness 实例占用，请先关闭旧实例`)
      }
      const engineUrl = await Promise.race([
        startEngine(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('未在时限内收到引擎访问地址')), STARTUP_TIMEOUT_MS))
      ])
      lastDshUrl = engineUrl
      await mainWindow.loadURL(engineUrl)
    } catch (err) {
      logLine(`dsh web startup failed: ${err?.stack || err}`)
      await dialog.showMessageBox({
        type: 'error',
        title: 'DS-Harness 启动失败',
        message: '无法启动本地 dsh Web 服务',
        detail: String(err?.stack || err)
      })
      // 调度中心仍然可用:降级到监控视图,不退出整个应用。
      if (mainWindow && !mainWindow.isDestroyed()) {
        await mainWindow.loadURL(`${UI_ORIGIN}${VIEW_PATHS.monitor}`)
      } else {
        app.quit()
      }
    }
  } else {
    const view = VIEW_PATHS[startView] || VIEW_PATHS.monitor
    await mainWindow.loadURL(`${UI_ORIGIN}${view}`)
  }
})

app.on('second-instance', () => {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
})

app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => {
  if (shuttingDown) return
  shuttingDown = true
  try {
    stopServer()
  } catch {
    /* no-op */
  }
  stopEngine()
})
process.on('exit', () => {
  try {
    stopServer()
  } catch {
    /* no-op */
  }
  stopEngine()
})

module.exports = { ROOT, UI_ORIGIN, DSH_ORIGIN }
