'use strict'
/**
 * DS-Harness — DeepSeek Harness 桌面客户端（Alien 式外壳 + Mega 调度中心合并壳）。
 *
 * 单进程做两件事:
 *   1. 拉起官方 dsh Web UI（headless dsh 引擎,引擎 home = <root>\data）
 *   2. 同进程内运行 3300 调度中心监控服务（队列/峰谷/计费/跟踪/铃声事件）
 * 主窗口默认加载 dsh Web;菜单/快捷键可切换到调度中心各视图(聊天/监控/设置)。
 * 铃声事件由 3300 服务推送,经隐藏“音频宿主”窗口播放——无论当前停留在哪个视图都会响。
 *
 * 端口自动错开:默认 dsh Web=3080、调度中心=3300;若被其他实例占用,启动时
 * 自动向后寻找空闲端口(最多 +30),并把实际端口写入 data\state\ports.json。
 * 也可用 DSH_UI_PORT / DSH_DSH_WEB_PORT 显式指定起点。
 */
const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron')
const { spawn, spawnSync } = require('node:child_process')
const http = require('node:http')
const path = require('node:path')
const fs = require('node:fs')

const paths = require('./monitor/utils/paths')
const { ROOT, PATHS, app: appConfig } = paths
const { findFreePort } = require('./monitor/utils/ports')

const DSH_ENTRY = path.join(__dirname, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const PRELOAD = path.join(__dirname, 'electron-assets', 'preload.js')
const STARTUP_TIMEOUT_MS = 90_000
const VIEW_PATHS = { chat: '/chat.html', monitor: '/', settings: '/settings.html' }

const smokeTest = process.argv.includes('--smoke-test')
const shotFlagIdx = process.argv.indexOf('--screenshot-test')
const shotOut = shotFlagIdx >= 0 && process.argv[shotFlagIdx + 1] ? process.argv[shotFlagIdx + 1] : null
const noDshWeb = process.env.DSH_NO_DSH_WEB === '1' || smokeTest || Boolean(shotOut)
// 默认主界面 = 集成对话(ChatGPT/Codex 式);官方 dsh Web 是可选“官方视图”,按需启动引擎。
const startView = process.env.DSH_START_VIEW || 'chat'
const uiBase = Number(process.env.DSH_UI_PORT) || appConfig.ui?.port || 3300
const dshBase = Number(process.env.DSH_DSH_WEB_PORT) || appConfig.dshWeb?.port || 3080
const dshHost = process.env.DSH_DSH_WEB_HOST || appConfig.dshWeb?.host || '127.0.0.1'

const VIEW_DOM_IDS = {
  chat: ['chatForm', 'chatComposer', 'threadList', 'newChatBtn', 'chatMessages', 'sendBtn', 'usageStrip'],
  monitor: ['queueForm', 'queueTable', 'soundToggle', 'sysCores', 'taskTable', 'timeline'],
  settings: ['settingsSave', 'setApiKey', 'setModel', 'setPermission', 'setSound', 'soundEvents'],
  dsh: []
}

let mainWindow = null
let engineProcess = null
let lastDshUrl = null
let shuttingDown = false
let playerWindow = null
let uiPort = null
let dshPort = null
let monitor = null // ./monitor/ui/server (required after port selection)
let soundService = null // ./monitor/notifications/sound-service

app.setName('DS-Harness')
app.setPath('userData', path.join(ROOT, 'data', 'desktop-shell'))

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) app.quit()

function uiOrigin() {
  return `http://127.0.0.1:${uiPort}`
}

function dshOrigin() {
  return `http://${dshHost}:${dshPort}`
}

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

function writePortsState() {
  try {
    const dir = PATHS.STATE
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'ports.json'),
      JSON.stringify({ ui: uiPort, dsh: dshPort, uiBase, dshBase, writtenAt: Date.now() }, null, 2),
      'utf8'
    )
  } catch (err) {
    logLine(`write ports.json failed: ${err?.message || err}`)
  }
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
      resolve(res.statusCode >= 200 && res.statusCode < 500)
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
    logLine(`starting dsh web engine: ${nodeExe} ${DSH_ENTRY} web --no-open (port ${dshPort})`)
    engineProcess = spawn(
      nodeExe,
      [DSH_ENTRY, 'web', '--host', dshHost, '--port', String(dshPort), '--no-open'],
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
      if (await requestOk(`${dshOrigin()}/`)) {
        engineUrl = `${dshOrigin()}/`
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
    win.loadURL(`${uiOrigin()}/player.html`).then(() => resolve(win)).catch(reject)
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
  if (!soundService) return
  try {
    const audio = soundService.resolveBellAudio(bell.event)
    if (!audio) return // master/per-event switch off or file missing
    logLine(`ringtone ${bell.event} -> ${audio.name}`)
    playInHost(`${uiOrigin()}${audio.url}`, audio.volume)
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
    return u.origin === uiOrigin() || u.origin === dshOrigin()
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
  attachScreenshot(mainWindow, startView === 'dsh' ? 'dsh' : startView)
  return mainWindow
}

/** --screenshot-test <path>: capture the page + DOM self-check, then quit. */
function attachScreenshot(win, viewKey) {
  if (!shotOut) return
  const issues = []
  win.webContents.on('console-message', (event) => {
    const level = event.level
    if (level === 'error' || level === 'warning' || level === 2 || level === 3) {
      issues.push({ level, message: event.message })
    }
  })
  win.webContents.once('did-finish-load', async () => {
    await new Promise((resolve) => setTimeout(resolve, 3000))
    try {
      const out = shotOut.replace(/\.png$/i, '')
      fs.mkdirSync(path.dirname(out + '.png'), { recursive: true })
      const image = await win.webContents.capturePage()
      fs.writeFileSync(out + '.png', image.toPNG())
      const dom = await win.webContents.executeJavaScript(`(() => {
        const ids = ${JSON.stringify(VIEW_DOM_IDS[viewKey] || [])}
        return {
          url: location.href,
          title: document.title,
          missing: ids.filter((id) => !document.getElementById(id)),
          usageStripText: (document.getElementById('usageStrip') || {}).innerText || '',
          bodyTextLength: document.body.innerText.length
        }
      })()`)
      fs.writeFileSync(out + '.json', JSON.stringify({ dom, consoleIssues: issues }, null, 2), 'utf8')
      console.log('screenshot saved: ' + out + '.png')
    } catch (err) {
      console.error('screenshot failed: ' + (err && err.stack ? err.stack : err))
    }
    app.quit()
  })
}

let officialLoading = null

function goDsh() {
  if (!mainWindow) return
  if (noDshWeb) {
    dialog
      .showMessageBox({
        type: 'info',
        title: 'DS-Harness',
        message: '官方 dsh Web 视图未启用',
        detail: '当前以 DSH_NO_DSH_WEB=1 运行(或处于自检模式)。主界面对话/队列功能不受影响。'
      })
      .catch(() => {})
    return
  }
  if (lastDshUrl) {
    mainWindow.loadURL(lastDshUrl)
    return
  }
  if (!officialLoading) {
    officialLoading = Promise.race([
      startEngine(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('未在时限内收到引擎访问地址')), STARTUP_TIMEOUT_MS))
    ])
      .catch(async (err) => {
        logLine(`official dsh web failed: ${err?.stack || err}`)
        await dialog.showMessageBox({
          type: 'error',
          title: 'DS-Harness',
          message: '无法启动官方 dsh Web 引擎',
          detail: String(err?.stack || err)
        })
        return null
      })
  }
  officialLoading.then(async (url) => {
    if (!url) return
    lastDshUrl = url
    if (mainWindow && !mainWindow.isDestroyed()) await mainWindow.loadURL(url)
  })
}

function goUi(viewPath) {
  if (!mainWindow) return
  mainWindow.loadURL(`${uiOrigin()}${viewPath}`)
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
        { label: '主界面 · 对话', accelerator: 'CmdOrCtrl+1', click: () => goUi(VIEW_PATHS.chat) },
        { label: '监控(队列/峰谷/成本)', accelerator: 'CmdOrCtrl+2', click: () => goUi(VIEW_PATHS.monitor) },
        { label: '设置(铃声/密钥/并发…)', accelerator: 'CmdOrCtrl+3', click: () => goUi(VIEW_PATHS.settings) },
        { type: 'separator' },
        { label: '官方 dsh Web 视图(按需启动引擎)', accelerator: 'CmdOrCtrl+4', click: () => goDsh() },
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
                `主界面:集成对话(ChatGPT/Codex 式),调度中心服务 ${uiOrigin()}\n` +
                `官方 dsh Web 视图(按需启动): ${dshOrigin()}\n` +
                `引擎数据目录: ${PATHS.DSH_HOME}\n` +
                `铃声配置: config\\sound.json(总开关/每事件开关/预设/本地文件)\n` +
                `(端口被占用时已自动错开,实际端口见 data\\state\\ports.json)`
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
  // Second instance: the primary's 'second-instance' handler focuses its
  // window; this extra process must exit without starting any service.
  if (!gotSingleInstanceLock) return
  try {
    // 1) 自动错开端口:默认 3300/3080,被占用则向后找空闲端口。
    uiPort = await findFreePort(uiBase, { maxTries: 30 })
    dshPort = noDshWeb ? dshBase : await findFreePort(dshBase, { maxTries: 30 })
    process.env.DSH_UI_PORT = String(uiPort)
    process.env.DSH_DSH_WEB_PORT = String(dshPort)
    logLine(`ports: ui=${uiBase}->${uiPort}${uiPort !== uiBase ? ' (自动错开)' : ''}, dsh=${dshBase}->${dshPort}${dshPort !== dshBase ? ' (自动错开)' : ''}`)
    console.log(`DS-Harness ports: 调度中心=${uiPort}${uiPort !== uiBase ? ` (${uiBase} 被占用,已自动错开)` : ''} dshWeb=${dshPort}${dshPort !== dshBase ? ` (${dshBase} 被占用,已自动错开)` : ''}`)

    // 2) 加载 .env 与监控服务(server 模块读取上面的 DSH_UI_PORT)。
    require('./monitor/utils/env').loadProjectEnv()
    monitor = require('./monitor/ui/server')
    soundService = require('./monitor/notifications/sound-service')
    monitor.startServer()
    monitor.setBellHook(ringBell)
    writePortsState()

    // 服务内部若仍遇端口竞争而再次错开,采纳其实际绑定端口。
    setTimeout(() => {
      const actual = monitor.getBoundPort && monitor.getBoundPort()
      if (actual && actual !== uiPort) {
        uiPort = actual
        process.env.DSH_UI_PORT = String(uiPort)
        logLine(`monitor actually bound on ${uiPort}, adopting it`)
        writePortsState()
      }
    }, 1200)

    buildMenu()
    logLine(`monitor ${uiOrigin()} ready (dsh web ${dshOrigin()})`)

    if (smokeTest) {
      console.log('electron smoke ok')
      setTimeout(() => app.quit(), 1500)
      return
    }

    createMainWindow()
    if (startView === 'dsh' && !noDshWeb) {
      try {
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
          await mainWindow.loadURL(`${uiOrigin()}${VIEW_PATHS.monitor}`)
        } else {
          app.quit()
        }
      }
    } else {
      const view = VIEW_PATHS[startView] || VIEW_PATHS.monitor
      await mainWindow.loadURL(`${uiOrigin()}${view}`)
    }
  } catch (err) {
    logLine(`startup failed: ${err?.stack || err}`)
    dialog.showErrorBox('DS-Harness 启动失败', `初始化失败:\n${err?.message || err}`)
    app.quit()
  }
})

app.on('second-instance', () => {
  // Launcher asked to focus the running app: restore/show/focus its window.
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  if (!mainWindow.isVisible()) mainWindow.show()
  mainWindow.focus()
})

app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => {
  if (shuttingDown) return
  shuttingDown = true
  try {
    monitor?.stopServer()
  } catch {
    /* no-op */
  }
  stopEngine()
})
process.on('exit', () => {
  try {
    monitor?.stopServer()
  } catch {
    /* no-op */
  }
  stopEngine()
})

module.exports = { ROOT, uiOrigin, dshOrigin }
