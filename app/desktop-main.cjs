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
const runtimeInstance = require('./runtime/instance.cjs')
const { createRuntimeClient } = require('./runtime/client.cjs')
const { WorkerManager } = require('./sub-worker/manager.cjs')
const { createOfficialSurfaceViews, SURFACE, PAINTABLE } = require('./official-surface-views.cjs')
const { createStartupManager } = require('./startup.cjs')
const { createProtectionLayer } = require('./extensions/mega/protection/index.cjs')
const frontendMode = require('./frontend-mode/index.cjs')
const { syncShippedPackage } = require('./harness-profile.cjs')
// The dock's rectangle, including the band it yields to the official UI. Shared with the extension
// so the integrated view and the legacy window cannot disagree about where the dock starts.
const { dockBounds, dockTopInset } = require('./extensions/mega/dock/geometry.cjs')

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
 * A bilingual title for an OS window or dialog.
 *
 * Rendered surfaces get `bilingual.js`, which draws the Chinese large and the English
 * small in one colour. An OS title cannot be styled at all — the window manager owns the
 * font — so the only thing that can be honoured there is "both languages, Chinese first",
 * and that is what this produces.
 *
 * @param {string} cn
 * @param {string} en
 */
function bilingualTitle(cn, en) {
  const left = String(cn === undefined || cn === null ? '' : cn).trim()
  const right = String(en === undefined || en === null ? '' : en).trim()
  if (!left) return right
  if (!right) return left
  return `${left} · ${right}`
}
/**
 * The layer above the official page (Update-Plan/Dual-UI.md 任务 1).
 *
 * The official Overlay was the previous official *theming* architecture, and as a theme surface it
 * is still retired: nothing hands it a theme payload's effects, and the Appearance panel has no
 * control that reaches it.
 *
 * What is still needed above the official page is the user's wallpaper — a background is the one
 * thing that cannot be drawn anywhere else, because every other surface DS-Hns owns is either
 * behind the official page or a strip beside it, and a background has to be over the page to be
 * seen at all. It used to be that overlay view. It is not a view any more: this Electron build
 * exposes no input API on a view at all, so a `WebContentsView` above the page takes every click
 * that lands on it. The wallpaper is drawn by a click-through *window* instead
 * (`app/wallpaper-window.cjs`, which records the measurements), and `DSH_OFFICIAL_OVERLAY=0` still
 * means "nothing above the official renderer" for a run that would rather not have the layer.
 */
const OFFICIAL_OVERLAY_ENABLED = process.env.DSH_OFFICIAL_OVERLAY !== '0'

/** Accept only a real usable port; anything else silently keeps the default. */
function normalizeHarnessPort(value) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) return 3080
  return parsed
}

let mainWindow = null
let officialView = null
let megaDockView = null
let officialSurfaces = null
/** The wallpaper over the official page: a click-through window, never a view (see its module). */
let wallpaperLayer = null
/**
 * The boot's own state machine (`app/startup.cjs`): BOOTING → CORE_READY → INTERACTIVE → ENHANCED.
 *
 * It exists so that "the application is usable" cannot become a function of "every enhancement has
 * finished". The window is on screen with a skeleton as soon as this process can paint one, the
 * official UI replaces it when the Harness answers, and everything optional runs behind INTERACTIVE
 * with its own failure and its own line in the boot log.
 */
let startup = null
/**
 * The enhancement layer's control plane (`app/extensions/mega/protection/index.cjs`).
 *
 * Every optional module below is registered here and started through it, so its failure is a
 * degradation the MEGA panel can show rather than something the boot has to survive by luck.
 */
let protection = null
/**
 * The official frontend runtime: the backend bridge, the domain adapter and the
 * compatibility probe. It is the only frontend runtime there is — the mode state machine
 * that used to sit here went with Daily.
 */
let frontendRuntime = null
let megaDockExpanded = false
/**
 * Whether the old Mega dock is on screen at all.
 *
 * **It starts hidden, and that is the point of this round.** The user asked for the residual Mega sidebar to
 * be dealt with ("Mega侧栏一直残留没有处理"), and the two surfaces that replace it are already live: the orb
 * inside the official UI (`dsh-plugin-mega-core`) and the system ball that floats over every application
 * (`app/extensions/mega/system-orb.cjs`). A strip that is given a whole column of the window and a rail whose
 * only job is to be expanded is not a thing to keep by default.
 *
 * It is **on demand**, not unreachable: the tray's "Mega 控制台", the plugin-manager entry and `Ctrl+Shift+M`
 * all ask for it and it appears (this flag turns true, the view is created if it does not exist yet, and the
 * layout gives it its strip back). `DSH_MEGA_DOCK=1` brings it up with the app, which is how the pre-retirement
 * behaviour can be restored in one environment variable.
 */
let megaDockShown = process.env.DSH_MEGA_DOCK === '1' || process.env.DSH_MEGA_INTEGRATED_DOCK === '1'
let megaDockWidth = MEGA_DOCK_DEFAULT_WIDTH
/**
 * The dock-collapse watch (see `watchOfficialUseToCollapseDock`): a focus event before this
 * moment is the window being shown rather than the user turning to the official UI, and the
 * in-flight flag stops our own collapse from being read as a new user action.
 */
let officialFocusArmedAt = Number.POSITIVE_INFINITY
let megaDockCollapseInFlight = false
let harnessProcess = null
/**
 * The connection to the DS-Hns Runtime.
 *
 * The Harness child is **not** owned by this process any more: it belongs to the
 * Runtime Host, which is a separate long-lived process that outlives this window.
 * `harnessProcess` therefore remains only as the in-process fallback described in
 * `stopHarnessInProcess`, and the UI's real relationship with the engine is this
 * client object.
 */
let runtimeClient = null
/**
 * The fully resolved instance: identity, endpoint, and the port this instance
 * actually owns. `SHELL_INSTANCE` is the pre-Electron-ready subset (names only);
 * this is the same instance after the port has been chosen and persisted.
 */
let RUNTIME_INSTANCE = null
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

/**
 * Computer Use Runtime.
 *
 * The shell owns the runtime exactly like it owns the Sub-worker manager: the
 * Mega dock is only a control surface. The runtime is created lazily on first
 * use so the default startup path stays as cheap as it is today, and every
 * controller inside it runs behind its own fault boundary.
 */
let computerUseRuntime = null
let computerUseHost = null

/**
 * Engineering Runtime.
 *
 * The shell owns one engineering supervisor and at most one *active episode*: an
 * episode mutates a repository, so two of them in the same workspace would be two
 * writers racing over the same files. The dock is the control surface — it names a
 * repository and a goal and reads the episode's own report — and no command, path
 * or git policy is decided in the renderer.
 */
let engineeringHost = null

/**
 * The plugin host: the manager, the registry, the bus, the configuration and both
 * plugin sets. Created on the first plugin-panel call, never at boot.
 */
let pluginHost = null
/** Whether the shell already listens for the store's "installed set changed" event. */
let installedPluginWatch = false

/** IPC surface of the Engineering panel. */
const ENGINEERING_CHANNELS = [
  // Read-only: what the runtime is doing, what it last reported, which project it
  // would detect in a directory, and which checkpoints an episode kept.
  'engineering:status',
  'engineering:describe',
  'engineering:checkpoints',
  // The episode itself: one at a time, cancellable at every step boundary.
  'engineering:run',
  'engineering:cancel'
]

/** IPC surface of the Plugin panel (Update-Plan/accleration.md sections 45, 46). */
const PLUGIN_CHANNELS = [
  // The set: what is installed, what each plugin is, and the capability vocabulary.
  'plugins:status',
  'plugins:list',
  'plugins:describe',
  'plugins:capabilities',
  // Acting on one plugin: enable/disable, restart, re-probe health.
  'plugins:enable',
  'plugins:reload',
  'plugins:health',
  // Re-read the store's installed set and rebuild the world in place, so an enable,
  // a disable or a removal never needs a restart.
  'plugins:refresh',
  // Compatibility mode: what an adopted plugin needs, and running it once the user confirms.
  'plugins:compat-setup',
  'plugins:compat-apply',
  // The execution settings and the lockfile.
  'plugins:execution',
  'plugins:configure',
  'plugins:lock'
]

/** IPC surface of the Computer Use panel. */
const COMPUTER_USE_CHANNELS = [
  'computer-use:snapshot',
  'computer-use:health',
  'computer-use:actions',
  'computer-use:capabilities',
  // The long-running state readers: owned
  // processes and the resource budget, both read-only snapshots. They answer
  // "can this executor keep working?" without starting a run.
  'computer-use:processes',
  'computer-use:resources',
  // Stopping a process the runtime owns. Reading what it owns is a
  // snapshot; stopping one it started (a dev server, a watcher) is the
  // supervised operation, and it refuses anything the runtime does not own.
  'computer-use:kill-owned',
  'computer-use:run',
  'computer-use:cancel',
  'computer-use:step',
  'computer-use:execute',
  'computer-use:log',
  'computer-use:screenshots',
  'computer-use:page'
]

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
 * named through `DSH_APP_NAME`) derives one under that root.
 *
 * The derivation itself now lives in `app/runtime/instance.cjs`, because the
 * Runtime Host needs the *same* answer: the instance id names the IPC endpoint,
 * keys the browser profile, and is what proves a record on disk belongs to this
 * instance. Two processes deriving their own notion of "which instance am I"
 * would be two chances to disagree.
 */
const APP_NAME_OVERRIDE = String(process.env.DSH_APP_NAME || '').trim()
const ISOLATED_ROOT = Boolean(process.env.DSH_ROOT) && path.resolve(process.env.DSH_ROOT) !== ROOT
const ISOLATED_INSTANCE = Boolean(APP_NAME_OVERRIDE) || ISOLATED_ROOT
const APP_NAME = APP_NAME_OVERRIDE || (ISOLATED_ROOT ? `DS-Harness (${path.basename(process.env.DSH_ROOT) || 'isolated'})` : 'DS-Harness')
/** A filesystem-safe profile name so several isolated runs cannot share a lock. */
const PROFILE_SLUG = (APP_NAME_OVERRIDE || path.basename(process.env.DSH_ROOT) || 'isolated').replace(/[^\w.-]+/g, '-')
/**
 * The shell's own instance record. `describeInstance` is pure, so this is safe
 * to compute before Electron is ready — and it must be, because `setPath` has to
 * happen before the single-instance lock is taken.
 */
const SHELL_INSTANCE = runtimeInstance.describeInstance({
  root: process.env.DSH_ROOT || ROOT,
  dshHome: process.env.DSH_HOME || path.join(ROOT, 'data'),
  appName: ISOLATED_INSTANCE ? APP_NAME : undefined,
  isolated: ISOLATED_INSTANCE,
  userDataDir: process.env.DSH_USER_DATA_DIR || undefined,
  requestedPort: Number(process.env.DSH_HARNESS_PORT) || undefined
})
app.setName(APP_NAME)
app.setPath('userData', SHELL_INSTANCE.paths.userData)
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
  const harness = harnessOutputTail()
  const tail = readLogTail()
  const suffix = [
    harness ? `\n\n--- Harness output (tail) ---\n${harness}` : '',
    tail ? `\n\n--- desktop-runtime.log (tail) ---\n${tail}` : ''
  ].join('')
  return new Error(`${message}${suffix}`)
}

/**
 * The managed Harness' own last words, redacted.
 *
 * When the child dies before it announces its access URL, its output is the only place the reason
 * exists — a plugin tree that failed to compose, a directory it could not read — and the log tail
 * below cannot be trusted to hold it yet: `observeStartupOutput` writes to the log through a stream,
 * and the exit event can beat that write to the disk. The buffer in memory never misses it.
 */
function harnessOutputTail(maxLines = 24) {
  const text = redact(startupOutput).trim()
  if (!text) return ''
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .slice(-maxLines)
    .join('\n')
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

/**
 * Refresh the profile's copy of the plugin DS-Hns ships, before the Harness is asked to boot it.
 *
 * `app/harness-profile.cjs` holds the whole reason: the copy is a plain copy that only a hand has
 * kept in step, and one leftover file in it — the package manifest carried into `lib/` together with
 * the two halves — is enough to stop the Harness from composing the plugin's browser bundle at all,
 * which ends the launch before the official UI exists. The profile is the Harness' own install and
 * the shell does not otherwise write into it; this is DS-Hns' own plugin's own files, brought back to
 * what the product ships. A failure here is reported and the launch goes ahead, because the Harness'
 * own account of a stale copy is worth more than refusing to start over one.
 */
function syncHarnessProfilePlugin() {
  const profile = process.env.DSH_PROFILE || 'web'
  try {
    const changed = syncShippedPackage({
      sourceDir: path.join(__dirname, 'plugins', 'mega-core'),
      modulesDir: path.join(ROOT, 'data', 'profiles', profile, 'node_modules'),
      log: logLine
    })
    if (changed.length) logLine(`[profile] the profile's copy of the shipped plugin was refreshed: ${changed.join(', ')}`)
  } catch (error) {
    logLine(`[profile] the profile's copy of the shipped plugin could not be refreshed: ${error?.message || error}`)
  }
}

function startHarness(nodeExe) {
  const urlPromise = new Promise((resolve, reject) => {
    resolveHarnessUrl = resolve
    rejectHarnessUrl = reject
  })
  ensureRuntimeDirs()
  syncHarnessProfilePlugin()
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

/** Legacy in-process stop, kept for the compatibility paths that still call it. */
function stopHarnessInProcess() {
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
 * The Harness is owned by the Runtime Host, not by this process.
 *
 * Everything that used to be inline here — spawning the child, writing its
 * ownership record, scraping the access URL out of its output — now happens one
 * process over, in `app/runtime/host.cjs`. The shell keeps this function because
 * every caller still asks the same question ("start the Harness"); the answer is
 * simply no longer produced by code that lives inside the UI.
 *
 * `runtimeClient` is created and attached before this is reached, so the command
 * is a request to an already-running owner. A failure here is reported, never
 * fatal: the Runtime Host outlives this call, and the UI attaching to a Runtime
 * that later recovers is the whole point of the split.
 *
 * The **credential** is the one thing that has to cross the boundary. The Harness
 * announces an authenticated `?token=...` URL on its own stdout; the Host captures
 * it and hands it back over the instance's own named pipe, which only a process
 * running as the same user in the same instance can open. It is never logged here
 * (`redact` still guards the log lines) and never placed in an IPC payload.
 */
async function startHarnessViaRuntime() {
  if (!runtimeClient) {
    harnessProcess = null
    throw startupError('The DS-Hns Runtime is not attached; the Harness cannot be started.')
  }
  // The profile's copy of the shipped plugin is refreshed from the *checkout*, and
  // the checkout is the UI's own directory, so this stays on this side of the
  // boundary — and it runs before the start command so the Host boots the fresh copy.
  syncHarnessProfilePlugin()
  const status = await runtimeClient.command('harness.start')
  logLine(`runtime harness.start: ${JSON.stringify({ started: status?.started, alreadyRunning: status?.alreadyRunning, ready: status?.ready, port: status?.port, blocked: status?.blocked, error: status?.error })}`)
  if (status?.blocked) throw startupError(`Port ${status.port} is already in use by another process. Close it before starting DS-Harness.`)
  if (status?.error) throw startupError(`The Runtime could not start the Harness: ${status.error}`)
  return waitForHarnessUrl()
}

/**
 * Attach to this instance's Runtime, starting one only when there is none.
 *
 * The probe-then-attach-then-start order is what stops two Desktops from racing
 * into two Runtimes: the second one to arrive finds the first one's endpoint
 * already bound and attaches instead.
 */
async function connectRuntime() {
  /**
   * Resolve the instance *now*, not at module evaluation.
   *
   * `describeInstance` (used above, before Electron was ready) deliberately does
   * not touch the filesystem or the network: it only derives names, because it has
   * to run before `app.setPath('userData')` and the single-instance lock. Choosing
   * a **port** is a different job — it probes the machine and persists the answer —
   * so it happens here, and the resolved instance is what the client and the Host
   * both use.
   *
   * This is also the fix for the collision the first version had: without it the
   * shell asked for the canonical 3080 regardless of `DSH_HARNESS_PORT`, and the
   * second instance was told its port was taken by the first one's Harness.
   */
  const resolved = await runtimeInstance.resolveInstance({
    root: process.env.DSH_ROOT || ROOT,
    dshHome: process.env.DSH_HOME || path.join(ROOT, 'data'),
    appName: ISOLATED_INSTANCE ? APP_NAME : undefined,
    isolated: ISOLATED_INSTANCE,
    userDataDir: process.env.DSH_USER_DATA_DIR || undefined,
    requestedPort: SHELL_INSTANCE.requestedPort
  })
  RUNTIME_INSTANCE = resolved
  // The identity must not move between module evaluation and this point: the
  // single-instance lock was already taken in `SHELL_INSTANCE.paths.userData`, and
  // a different answer here would put the lock and the cache in two places.
  if (resolved.paths.userData !== SHELL_INSTANCE.paths.userData) {
    logLine(`WARNING: resolved userData ${resolved.paths.userData} differs from the applied ${SHELL_INSTANCE.paths.userData}`)
  }
  logLine(
    `instance ${resolved.instanceId}: root=${resolved.root} home=${resolved.dshHome} ` +
      `port=${resolved.harnessPort} (${resolved.portAllocation?.reused ? 'requested port free' : `allocated, requested ${resolved.portAllocation?.requested}`}) ` +
      `ipc=${resolved.ipcEndpoint}`
  )
  runtimeClient = createRuntimeClient({
    instance: RUNTIME_INSTANCE,
    log: logLine,
    autoStartRuntime: true,
    nodeExe: resolveNodeExe()
  })
  runtimeClient.events.on('state', ({ state, detail }) => {
    logLine(`runtime connection: ${state}${detail ? ` (${detail})` : ''}`)
    // A Runtime that goes away is a *degraded* UI, never a dead one. Nothing here
    // touches the window, the tray or any managed resource: the client keeps
    // retrying on its own, and the next successful attach restores the view.
    if (state === 'disconnected') {
      reportRuntimeDisconnected(detail)
    }
  })
  runtimeClient.events.on('attached', (welcome) => {
    logLine(`runtime attached: hostPid=${welcome?.hostPid} instance=${welcome?.instanceId} port=${welcome?.harnessPort}`)
    runtimeUsable = true
  })
  const result = await runtimeClient.attach()
  runtimeUsable = true
  return result
}

/** A single, bounded line to the log; the UI's own degraded state is the renderer's. */
function reportRuntimeDisconnected(detail) {
  runtimeUsable = false
  logLine(`runtime disconnected; the UI stays alive and will reattach (${detail || 'no detail'})`)
}

/**
 * Whether the Runtime is currently reachable. Every caller that used to assume
 * "the Harness is up because I started it" asks this instead.
 */
let runtimeUsable = false

/**
 * Wait for the Host to report the authenticated URL, with the *host's* budget
 * rather than a number written into the UI. A slow machine gets its own measured
 * allowance; see `app/runtime/host-capability.cjs`.
 */
async function waitForHarnessUrl() {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  let lastReason = ''
  while (Date.now() < deadline) {
    try {
      const answer = await runtimeClient.command('harness.url')
      if (answer?.available && answer.url) {
        harnessUrl = answer.url
        logLine('captured the Harness access URL from the Runtime')
        return harnessUrl
      }
      lastReason = answer?.reason || ''
    } catch (error) {
      lastReason = error?.message || String(error)
    }
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  throw startupError(`Harness service did not become ready within ${STARTUP_TIMEOUT_MS / 1000} seconds${lastReason ? ` (${lastReason})` : ''}`)
}

/**
 * Stop the Harness **through its owner**.
 *
 * Kept as a named capability rather than an exit hook, because it is exactly the
 * thing every exit path must *not* do. It exists for the compatibility surface
 * that asks for a Harness stop without a full Runtime stop, and it is reached only
 * from `stopRuntimeCompletely()`.
 */
function stopHarness() {
  if (runtimeClient) {
    return runtimeClient
      .command('harness.stop')
      .then((result) => {
        logLine(`runtime harness.stop: ${JSON.stringify(result)}`)
        return result
      })
      .catch((error) => {
        logLine(`runtime harness.stop failed: ${error?.message || error}`)
        return null
      })
  }
  // No Runtime is attached. The in-process path is retained only so a shell that
  // somehow never attached cannot leak a child it started itself.
  stopHarnessInProcess()
  return null
}

/**
 * The UI's view of the Runtime connection, for a renderer that wants to show
 * "disconnected" rather than an empty window.
 *
 * Registered in the same main process as everything else, so it costs nothing and
 * cannot fail a boot. It is intentionally *read-only*: it reports, and it offers
 * the one explicit full stop; it never lets a renderer stop the Runtime by
 * accident through a generic command channel.
 */
function registerRuntimeIpc() {
  try {
    ipcMain.removeHandler('runtime:status')
  } catch {}
  try {
    ipcMain.removeHandler('runtime:stop-completely')
  } catch {}
  ipcMain.handle('runtime:status', async () => {
    const identity = RUNTIME_INSTANCE || SHELL_INSTANCE
    if (!runtimeClient) {
      return { ok: true, attached: false, state: 'idle', instanceId: identity.instanceId, reason: 'the shell has not attached yet' }
    }
    const described = runtimeClient.describe()
    if (!runtimeClient.attached) return { ok: true, ...described }
    try {
      const status = await runtimeClient.status()
      return { ok: true, ...described, runtime: status }
    } catch (error) {
      // A Runtime that cannot answer is reported as data, never as a rejected
      // renderer promise: the panel must be able to say "disconnected".
      return { ok: true, ...described, error: String(error?.message || error) }
    }
  })
  ipcMain.handle('runtime:stop-completely', async () => {
    const result = await stopRuntimeCompletely('renderer request')
    return { ok: result?.stopped !== false, result }
  })
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
      title: String(event.notification?.title || bilingualTitle('子任务工作器', 'Sub-worker')),
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
      title: bilingualTitle('选择 Sub-worker 目标仓库', 'Choose the sub-worker target repository'),
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
 * The surface the agent is allowed to drive: the official renderer, or the window
 * itself when the integrated view does not exist.
 */
function activeAgentSurface() {
  try {
    if (officialView && officialView.webContents) return officialView.webContents
    if (mainWindow && !mainWindow.isDestroyed()) return mainWindow.webContents
  } catch {
    /* a destroyed view is simply not an agent surface */
  }
  return null
}

/**
 * A destructive action with `destructive_actions: "confirm"` reaches
 * this dialog. It is a real modal on purpose — the runtime never assumes
 * consent it was not given.
 */
async function requestDestructiveConfirmation(request = {}) {
  try {
    const kinds = Array.isArray(request.kinds) ? request.kinds.join(', ') : String(request.kinds || 'destructive')
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['允许', '拒绝'],
      defaultId: 1,
      cancelId: 1,
      title: bilingualTitle('Computer Use 需要确认', 'Computer Use needs confirmation'),
      message: `任务请求执行危险操作：${kinds}`,
      detail: `目标：${request.target || '(未指定)'}\n动作：${request.description || request.action || '(未知)'}\n任务：${request.goal || '(未知)'}\n\n这是 Execution Contract 中的 "destructive_actions: confirm" 门控。`
    })
    return result.response === 0
  } catch (error) {
    logLine(`computer use confirmation failed: ${error?.message || error}`)
    return false
  }
}

/**
 * `config/app.json` may switch the Computer Use runtime off entirely (the same
 * way the Mega extension has a kill switch). A missing or damaged config file
 * means "enabled": the runtime is inert until something asks for it.
 */
function computerUseEnabled() {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'app.json'), 'utf8'))
    return config?.computerUse?.enabled !== false
  } catch {
    return true
  }
}

/** Creates the Computer Use runtime on first use (idempotent). */
function ensureComputerUseRuntime() {
  if (!computerUseEnabled()) {
    throw new Error('the Computer Use runtime is disabled by config/app.json (computerUse.enabled = false)')
  }
  if (computerUseRuntime) return computerUseRuntime
  const { createComputerUseRuntime } = require('./computer-use/index.cjs')
  const { createElectronHost } = require('./computer-use/host-electron.cjs')
  computerUseHost = createElectronHost({
    getWebContents: activeAgentSurface,
    confirm: requestDestructiveConfirmation,
    workspace: ROOT,
    cwd: ROOT
  })
  computerUseRuntime = createComputerUseRuntime({
    host: computerUseHost.host,
    log: { mode: 'normal' }
  })
  for (const note of computerUseHost.notes) logLine(`computer use host note: ${note}`)
  registerComputerUseIpc()
  const degraded = computerUseRuntime.health().controllers.filter((controller) => !controller.available)
  logLine(`computer use runtime ready (${COMPUTER_USE_CHANNELS.length} channels${degraded.length ? `; degraded: ${degraded.map((entry) => entry.controller).join(', ')}` : ''})`)
  return computerUseRuntime
}

/**
 * Every handler is failure isolated: a runtime problem is reported as data, so
 * the panel never has to defend itself against a rejected main-process promise.
 */
function registerComputerUseIpc() {
  for (const channel of COMPUTER_USE_CHANNELS) {
    try {
      ipcMain.removeHandler(channel)
    } catch {}
  }
  const guard = (handler) => async (event, ...args) => {
    try {
      return await handler(event, ...args)
    } catch (error) {
      logLine(`computer use ipc failed: ${error?.stack || error}`)
      return { ok: false, error: String(error?.message || error), code: error?.code || null }
    }
  }
  const runtime = () => ensureComputerUseRuntime()

  ipcMain.handle('computer-use:snapshot', guard(() => runtime().snapshot()))
  ipcMain.handle('computer-use:health', guard(() => runtime().health()))
  ipcMain.handle('computer-use:actions', guard(() => runtime().actionTypes))
  ipcMain.handle('computer-use:capabilities', guard(() => ({
    capabilities: ['browser', 'desktop', 'shell', 'filesystem', 'vision'],
    options: runtime().options,
    hostNotes: computerUseHost ? computerUseHost.notes : [],
    // The on-demand capability report: the same table the
    // runtime consults before acting, with the reason a capability is unusable.
    report: runtime().capabilities()
  })))
  // The long-running state readers. They go through the same lazy runtime
  // creation as every other handler, so a disabled or unavailable runtime is a
  // report (`{ ok: false, error, code }` from `guard`) instead of a rejected
  // renderer promise.
  ipcMain.handle('computer-use:processes', guard(() => runtime().processes()))
  ipcMain.handle('computer-use:resources', guard(() => runtime().resources()))
  // Stop one process the runtime owns. The registry refuses a handle it
  // does not own, so this surface can never be turned into a general process
  // killer, and a missing handle is a reported refusal rather than an exception.
  ipcMain.handle('computer-use:kill-owned', guard(async (_event, processId, reason) => {
    if (typeof processId !== 'string' || !processId) {
      return { ok: false, id: processId === undefined ? null : String(processId), reason: 'a process handle is required' }
    }
    return runtime().killOwned(processId, reason || 'stopped from the Mega panel')
  }))
  // The renderer hands over an execution contract; the runtime decides
  // whether it is runnable and reports the criteria it verified.
  ipcMain.handle('computer-use:run', guard(async (_event, contract, runOptions) => runtime().run(contract || {}, runOptions || {})))
  ipcMain.handle('computer-use:step', guard(async (_event, contract) => runtime().executor.stepOnce(contract || {})))
  ipcMain.handle('computer-use:execute', guard(async (_event, action) => runtime().executeAction(action || {})))
  ipcMain.handle('computer-use:cancel', guard((_event, reason) => runtime().cancel(reason || 'cancelled from the Mega panel')))
  ipcMain.handle('computer-use:log', guard((_event, count) => (runtime().log ? runtime().log.tail(Number.isInteger(count) ? count : 40) : [])))
  ipcMain.handle('computer-use:screenshots', guard(() => (runtime().log ? runtime().log.screenshots() : [])))
  ipcMain.handle('computer-use:page', guard(async () => {
    const page = computerUseHost ? computerUseHost.refreshPage() : null
    if (!page) return { attached: false, reason: 'no agent surface is available' }
    const snapshot = await page.snapshot()
    return { attached: true, url: snapshot.url, title: snapshot.title, readyState: snapshot.readyState, controls: snapshot.controls.length }
  }))
}

/**
 * Creates the engineering host on first use (idempotent).
 *
 * Unlike the Computer Use runtime this one has no hardware dependency: it is a
 * repository supervisor, so the host is created without probing anything and the
 * per-run verification happens inside the episode.
 */
function ensureEngineeringHost() {
  if (engineeringHost) return engineeringHost
  const { createEngineeringHost } = require('./engineering-host.cjs')
  engineeringHost = createEngineeringHost({
    log: (line) => logLine(line),
    checkpointRoot: path.join(ROOT, 'runtime', 'engineering', 'checkpoints'),
    available: () => engineeringEnabled(),
    reason: () => 'the engineering runtime is disabled by config/app.json (engineering.enabled = false)',
    // The shipped limits and the closed git policy, so the panel inherits the
    // deployment's decisions rather than choosing them per run.
    defaults: engineeringDefaults()
  })
  logLine(`engineering runtime ready (${ENGINEERING_CHANNELS.length} channels; commit=${engineeringDefaults().git?.allowCommit === true})`)
  return engineeringHost
}

/** The `engineering` block of config/app.json, or an empty object. */
function engineeringDefaults() {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'app.json'), 'utf8'))
    return config && typeof config.engineering === 'object' && config.engineering !== null ? config.engineering : {}
  } catch {
    return {}
  }
}

/** Is the engineering runtime enabled in config? Defaults to on. */
function engineeringEnabled() {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'app.json'), 'utf8'))
    return config?.engineering?.enabled !== false
  } catch {
    return true
  }
}

/**
 * Every handler is failure isolated exactly like the Computer Use surface: a
 * runtime problem is reported as data, so the panel never has to defend itself
 * against a rejected main-process promise.
 */
function registerEngineeringIpc() {
  for (const channel of ENGINEERING_CHANNELS) {
    try {
      ipcMain.removeHandler(channel)
    } catch {}
  }
  const guard = (handler) => async (event, ...args) => {
    try {
      return await handler(event, ...args)
    } catch (error) {
      logLine(`engineering ipc failed: ${error?.stack || error}`)
      return { ok: false, error: String(error?.message || error), code: error?.code || null }
    }
  }
  const host = () => ensureEngineeringHost()

  ipcMain.handle('engineering:status', guard(() => host().status()))
  ipcMain.handle('engineering:describe', guard((_event, input) => host().describe(input || {})))
  ipcMain.handle('engineering:checkpoints', guard((_event, input) => host().checkpoints(input || {})))
  // Starting an episode returns as soon as it is accepted: the renderer follows it
  // through `engineering:status`, and the shell stays free to process the cancel
  // that stops it.
  ipcMain.handle('engineering:run', guard((_event, input) => host().run(input || {})))
  ipcMain.handle('engineering:cancel', guard((_event, input) => host().cancel(input || {})))
}

/** Releases the engineering host on exit, cancelling any active episode first. */
function disposeEngineeringOnExit(source = 'shell') {
  if (!engineeringHost) return null
  try {
    engineeringHost.dispose(`shell teardown (${source})`)
    logLine(`engineering runtime disposed (${source})`)
  } catch (error) {
    logLine(`engineering dispose failed: ${error?.message || error}`)
  }
  return true
}

/**
 * Creates the plugin host on first use (idempotent).
 *
 * The host owns the plugin manager, the capability registry, the bus, the configuration
 * and both plugin sets. It is built on the first UI call rather than at boot, because a
 * workbench that never opens the plugin panel should not pay for loading twenty-five
 * plugins — and because a plugin fault must not be able to stop the shell from starting.
 */
/**
 * The node binary a compatibility-mode plugin's isolated process runs with.
 *
 * `resolveNodeExe` may answer `node` — a PATH lookup — which is right for the harness and wrong for
 * a spawn that must not fail for a reason the user cannot see. When there is no real binary on
 * disk, the Electron process itself is used with `ELECTRON_RUN_AS_NODE`, which a packaged
 * application always has.
 */
function safeNodeExe() {
  try {
    const resolved = resolveNodeExe()
    if (resolved && resolved !== 'node' && fs.existsSync(resolved)) return resolved
  } catch {}
  return process.execPath
}

function ensurePluginHost() {
  if (pluginHost) return pluginHost
  const { createPluginHost } = require('./plugin-host.cjs')
  const block = pluginDefaults()
  pluginHost = createPluginHost({
    log: (line) => logLine(line),
    root: ROOT,
    configDir: path.join(ROOT, 'config', 'plugins'),
    available: () => pluginsEnabled(),
    reason: () => 'the plugin runtime is disabled by config/app.json (plugins.enabled = false)',
    defaults: block,
    enforceLock: block.enforceLock === true,
    // A compatibility-mode plugin is activated in a separate process. It has to be *this*
    // deployment's node: a packaged application has no other one on the machine.
    nodeExe: safeNodeExe()
  })
  logLine(`plugin runtime ready (${PLUGIN_CHANNELS.length} channels; lock enforcement ${block.enforceLock === true ? 'on' : 'off'})`)
  return pluginHost
}

/** The `plugins` block of config/app.json, in the shape the host expects. */
function pluginDefaults() {
  const { executionDefaults } = require('./plugin-host.cjs')
  let block = {}
  try {
    const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'app.json'), 'utf8'))
    if (config && typeof config.plugins === 'object' && config.plugins !== null) block = config.plugins
  } catch {
    block = {}
  }
  return executionDefaults(block)
}

/** Is the plugin runtime enabled in config? Defaults to on. */
function pluginsEnabled() {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'app.json'), 'utf8'))
    return config?.plugins?.enabled !== false
  } catch {
    return true
  }
}

/**
 * The plugin surface, failure isolated like the others: a plugin problem is data, not a
 * rejected main-process promise. Every handler builds the world first, so the panel's
 * first paint shows the real set rather than an empty one.
 */
function registerPluginIpc() {
  for (const channel of PLUGIN_CHANNELS) {
    try {
      ipcMain.removeHandler(channel)
    } catch {}
  }
  const guard = (handler) => async (event, ...args) => {
    try {
      return await handler(event, ...args)
    } catch (error) {
      logLine(`plugin ipc failed: ${error?.stack || error}`)
      return { ok: false, error: String(error?.message || error), code: error?.code || null }
    }
  }
  const host = () => ensurePluginHost()
  const ready = async () => {
    const outcome = await host().ensure()
    return outcome.ok === false ? outcome : null
  }

  ipcMain.handle('plugins:status', guard(async () => {
    const failed = await ready()
    const status = host().status()
    return failed ? { ...status, ok: false, error: failed.error, code: failed.code } : status
  }))
  ipcMain.handle('plugins:list', guard(async () => {
    const failed = await ready()
    const listed = host().list()
    return failed ? { ...listed, ok: false, error: failed.error, code: failed.code } : listed
  }))
  ipcMain.handle('plugins:describe', guard(async (_event, input) => {
    await ready()
    return host().describe(input || {})
  }))
  ipcMain.handle('plugins:capabilities', guard(async () => {
    await ready()
    return host().capabilities()
  }))
  ipcMain.handle('plugins:enable', guard(async (_event, input) => {
    await ready()
    return host().setEnabled(input || {})
  }))
  ipcMain.handle('plugins:reload', guard(async (_event, input) => {
    await ready()
    return host().reload(input || {})
  }))
  ipcMain.handle('plugins:refresh', guard(async () => {
    await ready()
    return host().refreshInstalled('the panel asked for a rescan')
  }))
  ipcMain.handle('plugins:compat-setup', guard(async (_event, input) => {
    await ready()
    return host().compatSetup(input || {})
  }))
  /**
   * Install and build what a compatibility-mode plugin needs — after asking.
   *
   * This is the only path in the product that runs a third-party package manager on the user's
   * machine, so the confirmation is not a UI formality: **the shell** shows the dialog, with the
   * exact commands and their directories, and only a `yes` reaches `compatApplySetups`. A renderer
   * cannot install anything by asking twice; it can only ask the user.
   */
  ipcMain.handle('plugins:compat-apply', guard(async (_event, input = {}) => {
    await ready()
    const id = String((input || {}).id || '')
    const described = host().compatSetup({ id })
    if (described.ok !== true) return described
    if (!described.plans.length) {
      return { ok: false, code: 'COMPAT_NOTHING_TO_RUN', error: 'this plugin needs no install or build', state: described.state }
    }
    const detail = described.plans
      .map((plan) => `${plan.display}\n    ${plan.cwd}\n    ${plan.note}`)
      .join('\n\n')
    let answer = { response: 0 }
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        answer = await dialog.showMessageBox(mainWindow, {
          type: 'warning',
          buttons: [bilingualTitle('取消', 'Cancel'), bilingualTitle('运行这些命令', 'Run these commands')],
          defaultId: 1,
          cancelId: 0,
          noLink: true,
          title: bilingualTitle('兼容插件需要额外步骤', 'A compatibility-mode plugin needs a step'),
          message: bilingualTitle(`为 ${id} 安装依赖或构建？`, `Install dependencies or build ${id}?`),
          detail: `${detail}\n\n${bilingualTitle('这些命令会在这台机器上执行第三方代码。', 'These commands run third-party code on this machine.')}`
        })
      }
    } catch (error) {
      logLine(`the compatibility confirmation could not be shown: ${error?.message || error}`)
      return { ok: false, code: 'COMPAT_NO_CONFIRMATION', error: 'the confirmation dialog could not be shown, so nothing was run' }
    }
    if (answer.response !== 1) {
      return { ok: false, code: 'COMPAT_DECLINED', error: 'the user declined, so nothing was run', canceled: true, plans: described.plans }
    }
    const result = host().compatApplySetups({ id, confirm: true })
    // Installed dependencies and built entries change what the host can do, so the world is
    // rebuilt before the answer goes back: the panel's next read shows the plugin running.
    const refreshed = result.ok === true ? await reloadInstalledPlugins('a compatibility setup finished') : null
    return {
      ...result,
      refreshed: refreshed ? { rebuilt: refreshed.rebuilt === true, mounted: refreshed.mounted || [], removed: refreshed.removed || [] } : null
    }
  }))
  ipcMain.handle('plugins:health', guard(async (_event, input) => {
    await ready()
    return host().health(input || {})
  }))
  ipcMain.handle('plugins:execution', guard(async () => {
    await ready()
    return host().execution()
  }))
  ipcMain.handle('plugins:configure', guard(async (_event, input) => {
    await ready()
    return host().configure(input || {})
  }))
  ipcMain.handle('plugins:lock', guard(async (_event, input) => {
    await ready()
    return host().lockfile(input || {})
  }))
  // The store is an extension and the world is built here, so the two are joined by an
  // event rather than by a call: installing something must reach a *running* world.
  watchInstalledPluginChanges()
}

/**
 * Rebuild the plugin world after the store changed the installed set.
 *
 * This is what makes "enable it and it runs" true instead of "enable it and restart": the
 * world is built once and cached, so a new entry in `data/plugins/installed.json` would
 * otherwise only be honoured on the next start. A world that was never built has nothing to
 * reload — its first build reads the same file — and a rebuild that fails is reported rather
 * than thrown, because a third-party plugin that will not load must not take the shell down.
 */
async function reloadInstalledPlugins(why = 'the installed plugin set changed') {
  if (!pluginHost) {
    logLine(`installed plugins changed (${why}); the plugin runtime is not built yet, so its first build reads the new set`)
    return { ok: true, rebuilt: false, built: false, why }
  }
  try {
    const outcome = await pluginHost.refreshInstalled(why)
    const mounted = Array.isArray(outcome.mounted) ? outcome.mounted : []
    const removed = Array.isArray(outcome.removed) ? outcome.removed : []
    const failures = Array.isArray(outcome.failures) ? outcome.failures : []
    logLine(`plugin world reloaded (${why}): mounted ${mounted.join(', ') || 'nothing'}; removed ${removed.join(', ') || 'nothing'}; failed ${failures.length}`)
    // The dock's plugin list is a view of this world, so it is told the world moved instead
    // of being left to show the set from before the user pressed the button.
    try {
      const view = megaDockView
      if (view && !view.webContents.isDestroyed()) view.webContents.send('plugins:changed', { why, mounted, removed, failures })
    } catch (error) {
      logLine(`could not tell the dock about the reload: ${error?.message || error}`)
    }
    return outcome
  } catch (error) {
    logLine(`plugin world reload failed (${why}): ${error?.stack || error}`)
    return { ok: false, rebuilt: false, why, error: String(error?.message || error) }
  }
}

/**
 * Listen for the store's "the installed set changed" event, once.
 *
 * A listener that is not attached (a build without the store) leaves the emit a no-op
 * rather than an error, which is why this is an event at all.
 */
function watchInstalledPluginChanges() {
  if (installedPluginWatch) return false
  installedPluginWatch = true
  ipcMain.on('mega:installed-plugins-changed', () => {
    reloadInstalledPlugins().catch((error) => logLine(`plugin world reload failed: ${error?.message || error}`))
  })
  return true
}

/**
 * The scheduled restart: the plans, the operating system's half, and the task that survives it.
 *
 * It lives in the shell because that is what owns process lifecycle, and because a scheduled restart
 * has to work whether or not the dock was ever opened. The three pieces are deliberately separate:
 * `store.cjs` owns what the user scheduled, `platform.cjs` owns the five OS commands, and
 * `coordinator.cjs` owns the order they happen in — suspend, intent, relaunch, then the machine.
 *
 * The targets are adapters over what already exists: the sub-worker's own `pause`/`resumeLastTask`
 * (which suspend at the worker's checkpoint) and the engineering runtime, which can only be stopped in a
 * phase its state machine calls parkable — so its adapter says `boundary-first` and the coordinator
 * waits instead of asking.
 */
let rebootCoordinator = null
let rebootStoreRef = null
let rebootTicker = null

function ensureReboot() {
  if (rebootCoordinator) return rebootCoordinator
  const { createRebootStore } = require('./reboot/store.cjs')
  const { createRebootPlatform } = require('./reboot/platform.cjs')
  const { createRebootCoordinator } = require('./reboot/coordinator.cjs')
  rebootStoreRef = createRebootStore({ root: ROOT, log: (line) => logLine(line) })
  const platform = createRebootPlatform({
    // A packaged build starts itself; in development it is the Electron binary plus this checkout,
    // and the one-shot entry has to reproduce exactly that.
    execPath: app.isPackaged ? app.getPath('exe') : process.execPath,
    appArgs: app.isPackaged ? [] : [app.getAppPath()],
    log: (line) => logLine(line)
  })
  rebootCoordinator = createRebootCoordinator({
    store: rebootStoreRef,
    platform,
    log: (line) => logLine(line),
    targets: {
      subWorker: {
        status: () => {
          if (!workerManager) return null
          const state = workerManager.state || {}
          return { running: Boolean(workerManager.isRunning), state: state.state || null, stage: state.stage || null, task_id: state.task_id || null }
        },
        suspend: async ({ plan }) => {
          if (!workerManager) return { ok: false, reason: 'the sub-worker is not available in this build' }
          const result = workerManager.pause(`scheduled restart ${plan.id}`)
          if (!result || result.ok === false) return result || { ok: false, reason: 'the worker refused to pause' }
          const delivered = Array.isArray(result.workers) ? result.workers.length : 0
          return {
            ok: true,
            // A running worker answers `pause` and suspends at its own next checkpoint: that is a request
            // in flight, and the coordinator waits for it rather than restarting over it.
            pending: result.state === 'PAUSING' || delivered > 0,
            state: result.state || null,
            detail: delivered || result.state === 'PAUSING'
              ? 'the worker was asked to stop at its next checkpoint'
              : 'the worker is suspended'
          }
        },
        resume: async () => {
          if (!workerManager) return { ok: false, reason: 'the sub-worker is not available in this build' }
          const result = typeof workerManager.resumeLastTask === 'function'
            ? await workerManager.resumeLastTask()
            : workerManager.resume('continuing after a scheduled restart')
          return { ok: Boolean(result && result.ok !== false), detail: (result && (result.reason || result.detail)) || 'the sub-worker was resumed' }
        }
      },
      engineering: {
        parkPolicy: 'boundary-first',
        status: () => {
          if (!engineeringHost) return null
          const state = engineeringHost.status()
          if (!state || state.ok === false) return null
          return { running: state.running === true, phase: state.phase || null, episode: state.episode || null, request: state.request || null }
        },
        suspend: async () => {
          if (!engineeringHost) return { ok: false, reason: 'the engineering runtime is not available in this build' }
          const cancelled = engineeringHost.cancel({ reason: 'a scheduled restart is waiting for a parkable phase' })
          if (cancelled && cancelled.ok === false) return { ok: false, reason: cancelled.error || 'the episode refused to stop' }
          return { ok: true, detail: 'the episode stopped at a step boundary and checkpointed' }
        },
        resume: async (intent) => {
          const request = intent && intent.targetState && intent.targetState.request
          if (!engineeringHost) return { ok: false, reason: 'the engineering runtime is not available in this build' }
          if (!request || !request.workspace || !request.goal) {
            return { ok: false, reason: 'the episode was not recorded with a repository and a goal, so it cannot be resumed automatically' }
          }
          const started = engineeringHost.run({ workspace: request.workspace, goal: request.goal, reason: 'continuing after a scheduled restart' })
          if (started && started.ok === false) return { ok: false, reason: started.error || 'the episode could not be restarted' }
          return { ok: true, detail: 'the episode resumed from its last checkpoint' }
        }
      }
    }
  })
  logLine(`reboot scheduler ready (${platform.supported ? 'restart supported' : `restart not supported on ${platform.platform}`})`)
  return rebootCoordinator
}

/** The store the IPC handlers write to: the same instance the coordinator reads. */
function rebootStore() {
  ensureReboot()
  return rebootStoreRef
}

/** A due plan fires within a few seconds, and the countdown the panel draws stays true. */
function startRebootTicker() {
  if (rebootTicker) return false
  const tick = () => {
    ensureReboot().tick().catch((error) => logLine(`reboot tick failed: ${error?.stack || error}`))
  }
  rebootTicker = setInterval(tick, 5000)
  if (typeof rebootTicker.unref === 'function') rebootTicker.unref()
  tick()
  return true
}

function stopRebootTicker() {
  if (!rebootTicker) return false
  clearInterval(rebootTicker)
  rebootTicker = null
  return true
}

/**
 * The scheduled-restart surface.
 *
 * Adding, editing and removing are the three things a user may do to a plan before it fires;
 * `reboot:cancel` is the removal for a plan whose restart is already in its grace period, and it
 * aborts the shutdown as well.
 */
const REBOOT_CHANNELS = ['reboot:state', 'reboot:describe', 'reboot:add', 'reboot:update', 'reboot:remove', 'reboot:cancel']

function registerRebootIpc() {
  for (const channel of REBOOT_CHANNELS) {
    try {
      ipcMain.removeHandler(channel)
    } catch {}
  }
  const guard = (handler) => async (event, ...args) => {
    try {
      return await handler(event, ...args)
    } catch (error) {
      logLine(`reboot ipc failed: ${error?.stack || error}`)
      return { ok: false, error: String(error?.message || error), code: error?.code || null }
    }
  }
  const coordinator = () => ensureReboot()

  ipcMain.handle('reboot:state', guard(async () => ({ ok: true, ...coordinator().describe() })))
  ipcMain.handle('reboot:describe', guard(async () => coordinator().describe().platform))
  ipcMain.handle('reboot:add', guard(async (_event, input = {}) => {
    const { createPlan } = require('./reboot/plan.cjs')
    const created = createPlan(input || {})
    if (!created.ok) return created
    const added = rebootStore().add(created.plan)
    return added.ok ? { ok: true, plan: created.plan } : { ok: false, code: 'REBOOT_PLAN_DUPLICATE', reason: added.reason }
  }))
  ipcMain.handle('reboot:update', guard(async (_event, input = {}) => {
    const { updatePlan } = require('./reboot/plan.cjs')
    const store = rebootStore()
    const current = store.find(input.id)
    if (!current) return { ok: false, code: 'REBOOT_PLAN_NOT_FOUND', reason: `${input.id || ''} is not scheduled` }
    // Only the plan's own fields may be patched; `updatePlan` ignores anything else by construction.
    const updated = updatePlan(current, input.patch && typeof input.patch === 'object' ? input.patch : input, {})
    if (!updated.ok) return updated
    const replaced = store.replace(updated.plan)
    return replaced.ok ? { ok: true, plan: updated.plan, changed: updated.changed } : { ok: false, code: 'REBOOT_PLAN_NOT_FOUND', reason: replaced.reason }
  }))
  ipcMain.handle('reboot:remove', guard(async (_event, input = {}) => {
    const result = rebootStore().remove(input.id)
    return result.ok ? { ok: true, planId: input.id, removed: true } : { ok: false, code: 'REBOOT_PLAN_NOT_FOUND', reason: result.reason }
  }))
  ipcMain.handle('reboot:cancel', guard(async (_event, input = {}) => coordinator().cancel(input.id)))
}

/** Releases the restart scheduler: the ticker stops and the plans stay on disk for the next start. */
async function disposeRebootOnExit() {
  stopRebootTicker()
  return true
}

/** Releases the plugin host on exit: every plugin unloads, every subscription goes. */
async function disposePluginsOnExit(source = 'shell') {
  // The store watch is removed even when no world was ever built: a listener left behind
  // would keep trying to reload a runtime that is gone.
  try {
    ipcMain.removeAllListeners('mega:installed-plugins-changed')
    installedPluginWatch = false
  } catch {}
  if (!pluginHost) return null
  try {
    await pluginHost.dispose(`shell teardown (${source})`)
    logLine(`plugin runtime disposed (${source})`)
  } catch (error) {
    logLine(`plugin dispose failed: ${error?.message || error}`)
  }
  return true
}

/** Releases the runtime on exit: watchers closed, debugger detached, log flushed. */
function disposeComputerUseOnExit(source = 'shell') {
  if (!computerUseRuntime) return null
  try {
    computerUseRuntime.cancel(`shell teardown (${source})`)
  } catch {}
  try {
    const page = computerUseRuntime.controllers?.browser?.page
    page?.transport?.detach?.()
  } catch {}
  try {
    computerUseRuntime.dispose()
    logLine(`computer use runtime disposed (${source})`)
  } catch (error) {
    logLine(`computer use dispose failed: ${error?.message || error}`)
  }
  return true
}

/**
 * Shared teardown for the UI's own exit.
 *
 *   closing the GUI  !=  stopping the Runtime
 *
 * This function releases everything the **UI** holds: the extension host (which
 * persists the scheduler queue and history), the optional Sub-worker that this
 * process created, the engineering and plugin hosts, the computer-use runtime and
 * the integrated views. It does **not** stop the Harness, and it does not ask the
 * Runtime to shut down.
 *
 * That is the requirement's central sentence, made operational. The Harness is
 * owned by the Runtime Host — a separate, detached process — so a window closing
 * cannot take the engine with it, and a task that was running keeps running.
 * Stopping everything is an explicit, separate act: `stopRuntimeCompletely()`,
 * reached only from "Stop DS-Hns Completely" and from `runtime.cjs stop`.
 *
 * The connection is *detached* rather than dropped: the client stops reconnecting
 * and the socket is closed, so the Runtime sees a client leave rather than a
 * process die.
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
  disposeEngineeringOnExit('shell teardown')
  // The ticker stops with the shell; the *plans* stay on disk, because a restart scheduled for
  // tomorrow is not cancelled by quitting the application today.
  stopRebootTicker()
  // The plugin unload hooks are async and teardown is not allowed to wait on a plugin
  // (the plan's exit rule: no cleanup step may prevent the exit). The dispose therefore
  // runs to its first await synchronously — which stops the health timer — and the rest
  // finishes alongside the exit; every context's subscriptions and capabilities go with
  // the process either way.
  Promise.resolve(disposePluginsOnExit('shell teardown')).catch((error) => logLine(`plugin dispose failed: ${error?.message || error}`))
  disposeComputerUseOnExit('shell teardown')
  try {
    destroyIntegratedViews()
  } catch {}
  if (destroyWindows) {
    try {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy()
    } catch {}
  }
  // Detach, never stop. The Runtime outlives this process by design.
  try {
    if (runtimeClient) {
      runtimeClient.detach()
      logLine('detached from the Runtime; it keeps running')
    } else {
      // Only reachable if the shell never attached and started a child itself.
      stopHarnessInProcess()
    }
  } catch {}
}

/**
 * The explicit full stop: "Stop DS-Hns Completely".
 *
 * This is the only UI path that ends the Runtime, and it does it the civil way —
 * it *asks* the Runtime to drain, checkpoint and terminate its own children, and
 * then waits for it to go. Nothing here kills a process by PID, because the
 * Runtime owns its children and knows the order they must stop in.
 */
async function stopRuntimeCompletely(source = 'shell') {
  logLine(`complete stop requested from the UI (${source})`)
  if (!runtimeClient) {
    stopHarnessInProcess()
    return { stopped: false, reason: 'no runtime client' }
  }
  try {
    const result = await runtimeClient.shutdownRuntime({ reason: `desktop complete stop (${source})` })
    logLine(`complete stop result: ${JSON.stringify(result)}`)
    return result
  } catch (error) {
    logLine(`complete stop failed: ${error?.message || error}`)
    return { stopped: false, error: String(error?.message || error) }
  }
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
  // A hidden dock takes no width at all: the official page (which is the window's own document) keeps the
  // whole content box, and the wallpaper has no strip to cut out (`wallpaperNotch`).
  const desiredDockWidth = megaDockExpanded ? megaDockWidth : MEGA_DOCK_COLLAPSED_WIDTH
  const dockWidth = megaDockShown
    ? Math.max(MEGA_DOCK_COLLAPSED_WIDTH, Math.min(desiredDockWidth, maxDockWidth))
    : 0
  const officialWidth = Math.max(0, contentWidth - dockWidth)
  const height = Math.max(1, contentHeight)

  /**
   * The official renderer and the dock share the window, and each has its own rectangle:
   * the dock keeps a reserved strip on the right, and the official view fills the rest.
   *
   * A second frontend used to compete for that rectangle, moved outside the content area
   * when it was inactive. It is gone: there is one frontend, so it sits where it belongs,
   * and no layout decision can hide it.
   */
  const rect = { x: 0, y: 0, width: officialWidth, height }
  if (officialView) {
    officialView.setBounds(rect)
  }
  if (layoutIntegratedViews.lastKey !== `${officialWidth}x${height}|dock=${dockWidth}|expanded=${megaDockExpanded}`) {
    layoutIntegratedViews.lastKey = `${officialWidth}x${height}|dock=${dockWidth}|expanded=${megaDockExpanded}`
    logLine(`layout: content=${contentWidth}px official=${officialWidth}px dock=${dockWidth}px expanded=${megaDockExpanded}`)
  }
  if (megaDockView) {
    try {
      megaDockView.setVisible(megaDockShown)
    } catch (error) {
      logLine(`the dock view could not be ${megaDockShown ? 'shown' : 'hidden'}: ${error?.message || error}`)
    }
    // The dock yields the top band to the official UI (see `dock/geometry.cjs`): in this build the
    // official page *is* the window's document, laid out against the full width, so it cannot know
    // that a strip of its right edge is covered — and the conversation header's controls live in
    // exactly that strip's top. Both the rail and the panel move together, because they are one
    // view.
    if (megaDockShown) megaDockView.setBounds(dockBounds({ x: officialWidth, width: dockWidth, height, inset: dockTopInset() }))
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
  // The wallpaper covers the whole window, minus the dock's own rectangle: the dock is a view
  // inside this window and would sit *under* the wallpaper window, so the strip it occupies is cut
  // out of the picture and the dock draws the same picture itself (see `dock.css`). Only the strip
  // the dock actually has is cut — a build whose dock never attached keeps its whole picture.
  if (wallpaperLayer) {
    try {
      wallpaperLayer.layout({ bounds: contentBounds(), notch: wallpaperNotch() })
    } catch (error) {
      logLine(`wallpaper layer layout failed: ${error?.message || error}`)
    }
  }
}

/**
 * The main window's content box, on screen, where a child window has to be placed.
 *
 * A `WebContentsView` is positioned in the window's own coordinates; a `BrowserWindow` is placed in
 * screen coordinates, so the wallpaper layer — which is a window, deliberately — asks for this
 * instead of the content size. Unknown is `null`, never `{0,0,0,0}`: a layer placed at the top-left
 * of the desktop would be a wallpaper over somebody else's application.
 */
function contentBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return null
  try {
    const bounds = mainWindow.getContentBounds()
    if (!bounds || !(Number(bounds.width) > 0) || !(Number(bounds.height) > 0)) return null
    return bounds
  } catch (error) {
    logLine(`the window's content box could not be read: ${error?.message || error}`)
    return null
  }
}

function applyIntegratedDockState(payload = {}) {
  if (!INTEGRATED_MEGA_DOCK) return
  if (typeof payload.expanded === 'boolean') megaDockExpanded = payload.expanded
  /**
   * The extension's own state is the user's intent, so this is where a hidden dock comes back: an `expanded:
   * true` means somebody asked for the console (the tray, the plugin manager, the shortcut, or the dock's own
   * rail toggle if it is already up), and a dock that does not exist yet is created first. `expanded: false`
   * hides it again — the strip is only on screen while the dock is being used.
   */
  if (payload.expanded === true && !megaDockShown) showIntegratedMegaDock().catch((error) => logLine(`the dock could not be shown: ${error?.message || error}`))
  // Collapsing hides the strip: with the dock retired there is no persistent rail to keep, and a collapsed
  // dock is exactly the "residual sidebar" this round removed. The next request brings it back.
  if (payload.expanded === false && megaDockShown) hideIntegratedMegaDock()
  const candidate = Number(payload.expandedWidth ?? payload.width)
  if (Number.isFinite(candidate) && candidate >= MEGA_DOCK_MIN_WIDTH) {
    megaDockWidth = Math.max(MEGA_DOCK_MIN_WIDTH, Math.min(MEGA_DOCK_MAX_WIDTH, candidate))
  }
  layoutIntegratedViews()
}

/**
 * Put the dock on screen, creating it if this session never did.
 *
 * "Hidden by default" and "unreachable" are different things, and the difference matters most on the day the
 * ball is what broke: every entry point the product already has (tray, plugin manager, Ctrl+Shift+M) goes
 * through here.
 */
async function showIntegratedMegaDock() {
  if (!INTEGRATED_MEGA_DOCK) return false
  megaDockShown = true
  if (!megaDockView) await createIntegratedMegaDock()
  if (megaDockView) {
    try {
      megaDockView.setVisible(true)
    } catch (error) {
      logLine(`the dock view could not be shown: ${error?.message || error}`)
    }
  }
  layoutIntegratedViews()
  logLine('Mega dock shown on request')
  return Boolean(megaDockView)
}

function hideIntegratedMegaDock() {
  if (!INTEGRATED_MEGA_DOCK) return false
  megaDockShown = false
  if (megaDockView) {
    try {
      megaDockView.setVisible(false)
    } catch (error) {
      logLine(`the dock view could not be hidden: ${error?.message || error}`)
    }
  }
  layoutIntegratedViews()
  return true
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

/**
 * The skeleton, on screen, before anything is asked of the Harness.
 *
 * `updateplan/startup.md` §13/§14: the first thing the user sees must be a readable shape of the
 * interface, never an unreported void. The window used to be created hidden and shown at the very end
 * of the boot — after the Harness, the extension host and the dock's renderer — so any slow optional
 * module produced a product that looked like it had not started at all.
 *
 * The page is ours and it is inert (no script, no network, no controls), and it is only ever loaded
 * into this window before the official UI owns it. A failure to load it is a log line: the boot
 * continues to the official page, which is the only thing that actually has to arrive.
 */
async function showStartupSkeleton() {
  if (!mainWindow || mainWindow.isDestroyed()) return false
  try {
    await mainWindow.loadFile(path.join(__dirname, 'splash.html'))
  } catch (error) {
    logLine(`the startup skeleton could not be loaded (the official UI is unaffected): ${error?.message || error}`)
    return false
  }
  try {
    if (!mainWindow.isVisible()) mainWindow.show()
  } catch (error) {
    logLine(`the window could not be shown with the skeleton: ${error?.message || error}`)
  }
  startup?.mark('shell-ready')
  return true
}

async function createOfficialHarnessView(readyUrl) {
  if (!INTEGRATED_MEGA_DOCK || !mainWindow || mainWindow.isDestroyed()) return false
  /**
   * The official Harness UI is the *window's own page*.
   *
   * It used to be a sibling `WebContentsView` next to the Daily view, toggled with
   * `setVisible`. That does not hold up: the sibling is still drawn when it is
   * meant to be hidden (so Work Mode showed the Daily interface), and a sibling
   * that was hidden or moved out of the window comes back without a compositor
   * surface (so Work Mode showed a blank page). The official UI is the one surface
   * that must never be in doubt, so it uses the plain renderer a BrowserWindow
   * gives us - the same path this product used before the integrated dock existed.
   *
   * Daily then floats *above* it as a child view, and switching is adding or
   * removing that one view. The official page stays loaded throughout, so nothing
   * about the Harness session is reset by a mode switch.
   */
  configureOfficialWebContents(mainWindow.webContents)
  await mainWindow.loadURL(readyUrl)
  return true
}

/** Is the official UI the window's own page (always, in the integrated build)? */
function officialLivesInWindow() {
  return INTEGRATED_MEGA_DOCK
}

/**
 * Legacy official-view path: only used when the integrated dock is disabled and
 * the window has its own content for something else.
 */
async function createOfficialHarnessChildView(readyUrl) {
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
 * The official frontend.
 *
 * There used to be two renderers here and a mode manager between them; Daily is gone,
 * so what remains is the official renderer plus the dock's reserved strip. Nothing in
 * this section can hide the frontend, because there is nothing to hide it for.
 * ------------------------------------------------------------------------- */

/**
 * Show the official frontend.
 *
 * Called once the window's page has loaded: the official UI is the window's own page in
 * the integrated build, so showing it is about the dock's width rather than about a view's
 * visibility. It is idempotent, and it re-applies the layout for the reason the old switch
 * did — Chromium can keep a stale viewport for a view resized while unloaded.
 */
function showOfficialFrontend() {
  if (!INTEGRATED_MEGA_DOCK || !mainWindow || mainWindow.isDestroyed()) return false
  layoutIntegratedViews()
  setImmediate(() => {
    try {
      layoutIntegratedViews()
      repaintFrontends()
    } catch (error) {
      logLine(`deferred layout failed: ${error?.message || error}`)
    }
  })
  return true
}

/**
 * Schedule a full repaint of the frontend.
 *
 * A `WebContentsView` that was hidden (or moved out of the window) loses its compositor
 * surface. When it comes back the page is static, so no new frame is produced and the view
 * stays blank. `webContents.invalidate()` schedules exactly that repaint.
 */
function repaintFrontends() {
  for (const view of [officialView]) {
    try {
      const contents = view?.webContents
      if (contents && !contents.isDestroyed() && typeof contents.invalidate === 'function') contents.invalidate()
    } catch (error) {
      logLine(`frontend repaint failed: ${error?.message || error}`)
    }
  }
}

/** Build the frontend runtime. Safe to call once, before the views exist. */
function createFrontendRuntimeOnce() {
  if (frontendRuntime) return frontendRuntime
  frontendRuntime = frontendMode.createFrontendRuntime({
    tasks: () => (extensionManager?.describeNativeData?.()?.tasks) || [],
    settings: () => (extensionManager?.describeNativeData?.()?.settings) || null,
    installedVersion: () => (extensionManager?.describeNativeData?.()?.harnessVersion) || null,
    latestVersion: async () => (extensionManager?.describeNativeData?.()?.latestVersion) || null,
    log: (message) => logLine(`[frontend] ${message}`)
  })
  return frontendRuntime
}

/**
 * The compatibility report the dock's status panel reads.
 *
 * It used to be asked through the mode surface, because the answer depended on which
 * frontend was active. With one frontend there is nothing to switch between, so the
 * question is simply "is this DSH build the one we know how to drive?".
 */
function registerFrontendIpc() {
  if (!INTEGRATED_MEGA_DOCK) return
  try {
    ipcMain.removeHandler('frontend:compatibility')
  } catch {}
  ipcMain.handle('frontend:compatibility', async () => {
    try {
      return await createFrontendRuntimeOnce().compatibility()
    } catch (error) {
      logLine(`compatibility probe failed: ${error?.message || error}`)
      return { ok: false, reason: String(error?.message || error) }
    }
  })
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
  if (!officialView) {
    // The official UI is the window's own page, so there is no protected sibling to draw a frame
    // around and no theme surface to paint: the shell and the theme's own overlay stay unbuilt.
    //
    // What is still created here is the **wallpaper** — and it is a click-through *window* rather
    // than the view this used to be, because a view above the page cannot be made input-transparent
    // in this Electron build and would eat every click on the official UI.
    return createWallpaperLayer()
  }
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
      logLine('official_overlay attached for the user wallpaper (input-transparent, script-free); it takes no theme effect')
    } else {
      logLine('official_overlay turned off for this run (DSH_OFFICIAL_OVERLAY=0); the wallpaper cannot be drawn over the official UI')
    }
    officialSurfaces.applyLayout()
    logLine(`official_shell view attached (visual-only, input passthrough); overlay=${OFFICIAL_OVERLAY_ENABLED ? 'wallpaper' : 'disabled'}`)
    return true
  } catch (error) {
    logLine(`official surfaces failed to attach; the official renderer keeps running unthemed: ${error?.stack || error}`)
    try { officialSurfaces.destroy() } catch {}
    officialSurfaces = null
    return false
  }
}

/**
 * The wallpaper layer: the user's picture over the whole window.
 *
 * It is a **window**, and that is the whole design. The picture has to be over the official page to
 * be seen; a `WebContentsView` stacked there is a real hit target in this Electron build (a view has
 * no input API at all), which is what made the official UI unclickable while a wallpaper was set.
 * A window can be made mouse-transparent, so the layer is a frameless, transparent, never-focused,
 * click-through child of the main window — see `app/wallpaper-window.cjs` for the measurements and
 * for the interlock that keeps it off the screen when the build refuses.
 *
 * Three things this function owns, and nothing else owns them:
 *
 *   * **creation**, lazily: the module does not build a window until there is a picture to draw;
 *   * **placement**, from the main window's content box, on every move/resize/maximise/restore —
 *     plus the dock's rectangle, cut out of the picture so the dock's own view stays visible and
 *     clickable (the dock draws the same picture itself);
 *   * **visibility**, which follows the main window's: a layer over a minimised window is a stray
 *     window on the desktop.
 *
 * A failure here is a missing background and nothing else: the official renderer and the dock are
 * already live by this point.
 */
function createWallpaperLayer() {
  if (!OFFICIAL_OVERLAY_ENABLED) {
    logLine('the wallpaper layer is off for this run (DSH_OFFICIAL_OVERLAY=0): nothing is drawn over the official UI')
    return false
  }
  if (wallpaperLayer) return true
  try {
    const { createWallpaperWindow } = require('./wallpaper-window.cjs')
    wallpaperLayer = createWallpaperWindow({
      getParentWindow: () => mainWindow,
      getContentBounds: () => contentBounds(),
      log: (message) => logLine(`[wallpaper] ${message}`),
      electron: { BrowserWindow },
      enabled: true
    })
  } catch (error) {
    logLine(`the wallpaper layer could not be created; the official renderer is unaffected: ${error?.stack || error}`)
    wallpaperLayer = null
    return false
  }
  // Moving and resizing are two different events because they are two different problems: a resize
  // re-reads the content box, a move re-places the layer against it. Both are cheap, and a wallpaper
  // that lags a dragged window is a wallpaper stuck in the wrong place.
  for (const event of ['move', 'moved', 'resize', 'maximize', 'unmaximize', 'restore', 'enter-full-screen', 'leave-full-screen']) {
    mainWindow.on(event, () => {
      try {
        wallpaperLayer?.layout({ bounds: contentBounds(), notch: wallpaperNotch() })
      } catch (error) {
        logLine(`wallpaper layer placement failed: ${error?.message || error}`)
      }
    })
  }
  for (const event of ['minimize', 'hide']) {
    mainWindow.on(event, () => {
      try {
        wallpaperLayer?.setVisible(false)
      } catch {}
    })
  }
  for (const event of ['restore', 'show']) {
    mainWindow.on(event, () => {
      try {
        wallpaperLayer?.setVisible(true)
      } catch {}
    })
  }
  logLine('the wallpaper layer is a click-through window over the official page (a view above the page cannot be made input-transparent in this build)')
  return true
}

/**
 * The rectangle the picture must not be drawn in: the dock's own view.
 *
 * The dock is a child view of the same window, so it is *under* the wallpaper window, and the
 * wallpaper window is transparent where it draws nothing. Cutting exactly the dock's rectangle is
 * therefore what keeps the dock visible, clickable and frosted over the same picture; without a
 * dock there is nothing to cut.
 */
function wallpaperNotch() {
  // No dock on screen, no strip to cut: the picture covers the whole window (and only the strip the dock
  // actually occupies is ever cut, which is the rule this function has always followed).
  if (!megaDockShown || !megaDockView || !mainWindow || mainWindow.isDestroyed()) return null
  const [contentWidth] = mainWindow.getContentSize()
  const width = Math.max(1, Number(contentWidth) || 0)
  const dockWidth = Math.max(1, Math.min(integratedDockWidth(), width))
  return { x: Math.max(0, width - dockWidth), y: dockTopInset() }
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
  // The dock is frosted glass, and a pane has to be able to see through: the view's own
  // background is cleared so the document's translucent base composites over what is behind the
  // view rather than over an opaque rectangle. This is the same call the official shell and
  // overlay use for their transparency.
  megaDockView.setBackgroundColor('#00000000')
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
  // The dock gets out of the way the moment the user turns to the official UI.
  watchOfficialUseToCollapseDock()
  // The view exists now, so every push the extension made during boot (or will
  // make after a reload) has a real target: hand over the ready notification.
  notifyDockReady()
  return true
}

/**
 * Collapse the dock when the user turns to the official UI.
 *
 * The two surfaces are sibling views, so a click on the official side is *observable* only
 * as focus arriving there — and the product forbids the other route (injecting a listener
 * into the official renderer), so this is the honest signal, plus the first keystroke for
 * the one case focus cannot see:
 *
 *   * **focus moves to the official page while the dock is expanded** — the user was in the
 *     dock and clicked into the official UI. The click already left the caret where they put
 *     it, which is why the collapse is applied with `focus: false`: taking the focus back
 *     would undo the very thing they asked for.
 *   * **the first key pressed into the official page while expanded** — when the official page
 *     already had focus, a click inside it emits nothing at all, and the first keystroke is
 *     the earliest unambiguous sign that the user is typing there rather than reading.
 *
 * A click that lands in an already-focused official page and types nothing is deliberately
 * *not* guessed at: collapsing on hover would take the dock away while the user is still
 * pointing at it, which is worse than waiting for the keystroke.
 */
function watchOfficialUseToCollapseDock() {
  if (!INTEGRATED_MEGA_DOCK || !mainWindow || mainWindow.isDestroyed()) return false
  const contents = mainWindow.webContents
  if (!contents || contents.hnsDockCollapseWatch === true) return false
  contents.hnsDockCollapseWatch = true

  /** Collapse once, without stealing the focus the click just established. */
  const collapse = (because) => {
    if (!megaDockExpanded) return false
    if (megaDockCollapseInFlight) return false
    megaDockCollapseInFlight = true
    try {
      logLine(`dock collapsed because the official UI was used (${because})`)
      extensionManager?.setDockExpanded?.(false, { persist: true, focus: false })
      applyIntegratedDockState({ expanded: false })
    } catch (error) {
      logLine(`dock collapse on official use failed: ${error?.message || error}`)
    } finally {
      megaDockCollapseInFlight = false
    }
    return true
  }

  contents.on('focus', () => {
    // A focus event during boot is the window being shown, not the user turning away.
    if (Date.now() < officialFocusArmedAt) return
    collapse('the official page took focus')
  })

  contents.on('before-input-event', (_event, input) => {
    if (!input || input.type !== 'keyDown') return
    // A modifier alone is not an intent to type; a shortcut like Ctrl+C is not either.
    if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(input.key)) return
    if (input.control || input.meta || input.alt) return
    collapse('a key was pressed into the official page')
  })
  return true
}

function destroyIntegratedViews() {
  try {
    officialSurfaces?.destroy?.()
  } catch (error) {
    logLine(`official surface teardown failed: ${error?.message || error}`)
  }
  officialSurfaces = null
  try {
    wallpaperLayer?.destroy?.()
  } catch (error) {
    logLine(`wallpaper layer teardown failed: ${error?.message || error}`)
  }
  wallpaperLayer = null
  for (const view of [megaDockView, officialView]) {
    if (!view) continue
    try { mainWindow?.contentView?.removeChildView?.(view) } catch {}
    try {
      if (!view.webContents.isDestroyed()) view.webContents.close()
    } catch {}
  }
  megaDockView = null
  officialView = null
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: INTEGRATED_MEGA_DOCK ? 1488 : 1440,
    height: 920,
    minWidth: 980,
    minHeight: 640,
    title: bilingualTitle('DS-Harness 工作台', 'DS-Harness Workbench'),
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
    /**
     * The user's wallpaper, on its own stylesheet.
     *
     * Separate from `paint` because the two have different owners: a theme repaint must not take
     * the wallpaper away, and clearing the wallpaper must not take the theme away. An empty string
     * is how "no wallpaper" is said, and it is a complete answer.
     *
     * `drawable: false` is the second half of that answer, and it is what keeps an empty
     * click-through window off the screen: a layer nobody asked for should cost nobody anything.
     *
     * @param {string} css
     * @param {{drawable?: boolean}} [options]
     */
    wallpaper: (css, options = {}) => {
      if (!wallpaperLayer) return { ok: false, reason: 'wallpaper_layer_unavailable' }
      try {
        const drawable = options?.drawable !== false
        const painted = wallpaperLayer.paint(typeof css === 'string' ? css : '', { drawable })
        // The wallpaper is the last thing anyone should be waiting for, so it is a boot phase of its
        // own: "nothing to draw" is a finished phase too, and both are background work.
        startup?.mark('wallpaper-ready', drawable ? null : 'nothing to draw')
        return painted
      } catch (error) {
        logLine(`the wallpaper could not be painted over the official UI: ${error?.message || error}`)
        return { ok: false, reason: 'wallpaper_failed', error: String(error?.message || error) }
      }
    },
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
      // The protected renderer's evidence is always reported, whether or not any surface exists:
      // "nothing was injected" is a property of this whole adapter, not of a view being present.
      const protectedSurface = { id: SURFACE.OFFICIAL_RENDERER, writable: false, painted: false, injection_apis_used: [] }
      const wallpaper = wallpaperLayer
        ? { available: true, ...wallpaperLayer.describe() }
        : { available: false, created: false, input: 'unavailable', reason: 'wallpaper_layer_unavailable' }
      if (!officialSurfaces) {
        return {
          available: false,
          surfaces: PAINTABLE.map((id) => ({ id, created: false, ready: false, bounds: null })),
          protected: protectedSurface,
          wallpaper
        }
      }
      return {
        available: true,
        ...officialSurfaces.describe(),
        protected: protectedSurface,
        wallpaper,
        officialBounds: (() => {
          try { return officialView ? officialView.getBounds() : null } catch { return null }
        })()
      }
    },
    /** Drain the surface's own degradation log so the extension can report it. */
    degradation: () => {
      const entries = []
      try {
        entries.push(...(officialSurfaces ? officialSurfaces.describe().degradation : []))
      } catch {}
      try {
        for (const problem of wallpaperLayer?.describe?.().problems || []) entries.push({ surface: SURFACE.OFFICIAL_OVERLAY, reason: problem.reason, at: problem.at })
      } catch {}
      return entries
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
      // The enhancement layer's control plane. The extension registers its bundled community plugins
      // through it (startup2.md §19), so their failure is a degradation in the MEGA panel rather than
      // something the boot has to survive.
      protection,
      // The boot report, so MEGA's diagnostics can show what the startup actually cost (§45, §57).
      startup: () => (startup ? startup.summary() : null),
      // Legacy single-value form: the extension's adapter accepts either.
      dockWebContents: dockAdapter.webContents,
      // The official frontend runtime: the backend bridge, the domain adapter the dock
      // renders sessions and tasks from, and the compatibility probe. The extension reads
      // it; the shell owns it. There is no mode surface beside it any more — the native
      // renderer it used to talk to was removed with Daily.
      officialFrontend: createFrontendRuntimeOnce(),
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
      // The store changes the installed set while the plugin host's world is already built.
      // This hook lets the store *await* the rebuild, so the panel's next read cannot show
      // "enabled" for a plugin the runtime has not mounted yet.
      reloadInstalledPlugins,
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
  startup = createStartupManager({ log: logLine })
  protection = createProtectionLayer({ log: logLine })
  // The optional layers this shell owns, registered before anything starts. Ids are what the MEGA
  // panel shows; `optional: true` is what makes a failure DEGRADED instead of FAILED — the difference
  // between "a backdrop is missing" and "the product is broken".
  protection.register({ id: 'wallpaper-layer', optional: true, start: () => createOfficialSurfaces(), fallback: [{ id: 'official-ui', run: () => 'the official UI is the background' }] })
  protection.register({ id: 'mega-extension-host', optional: true, start: () => startExtensions(resolveNodeExe()), fallback: [{ id: 'core-ipc-only', run: () => 'the shell IPC surface still answers' }] })
  // The dock starts hidden (see `megaDockShown`): it is created on request, so the boot path neither waits
  // for its renderer nor reserves a strip for a console nobody has opened.
  protection.register({
    id: 'mega-dock',
    optional: true,
    start: () => (megaDockShown ? createIntegratedMegaDock() : 'hidden until it is asked for'),
    fallback: [{ id: 'dock-hidden', run: () => 'the strip stays empty' }]
  })
  createWindow()
  startup.mark('window-created')
  try {
    // The skeleton goes up before anything is asked of the Harness.
    //
    // This is the plan's §13/§14 in one line: the window used to stay hidden until the Harness, the
    // extension host and the dock's renderer were all up, so a slow optional module looked exactly
    // like a product that had not started. The page below is ours — a script-free skeleton of the
    // shape that is coming — and the official UI replaces it when it answers.
    await showStartupSkeleton()
    /**
     * Attach to this instance's Runtime — or start one — before asking it for the Harness.
     *
     * This is the inversion, in the one place where it is visible: the UI no
     * longer spawns the engine. It asks the Runtime to, and the Runtime keeps
     * owning it after this window is gone. The stale-runtime sweep and the
     * "port already in use" check that used to sit here now belong to the owner
     * too (`recoverOwnedStale` and the `blocked` answer inside `harness.start`),
     * because a second process doing its own sweep is exactly how one instance
     * kills another's Harness.
     */
    await connectRuntime()
    // The Runtime's own IPC surface: what the UI's connection looks like, and the
    // one explicit full stop. Registered here so a panel can report
    // "disconnected" for the rest of the session even if the Runtime later goes.
    registerRuntimeIpc()
    startup.mark('runtime-attached')
    const nodeExe = resolveNodeExe()
    const readyUrl = await Promise.race([
      startHarnessViaRuntime(),
      new Promise((_, reject) => setTimeout(() => reject(startupError(`No Harness access token was announced within ${STARTUP_TIMEOUT_MS / 1000} seconds`)), STARTUP_TIMEOUT_MS))
    ])
    startup.mark('harness-ready')
    // The Dual-UI backend client talks to the same authenticated Harness the
    // official renderer uses; publishing the origin is what lets the native
    // frontend read `session/list` without ever touching the official renderer.
    try {
      process.env.DSH_OFFICIAL_ORIGIN = new URL(readyUrl).origin
    } catch {}
    createFrontendRuntimeOnce()
    registerFrontendIpc()
    if (INTEGRATED_MEGA_DOCK) await createOfficialHarnessView(readyUrl)
    else await mainWindow.loadURL(readyUrl)
    // CORE_READY: the official UI is the window's page, so this is the moment the base frame exists.
    // INTERACTIVE follows immediately: what the user needs to type and work is the official UI, and
    // nothing of ours may stand between the two. Probing its DOM to be more certain is the one thing
    // this product never does, so "it finished loading and it is on screen" is the honest definition.
    startup.mark('core-ready')
    showOfficialFrontend()
    layoutIntegratedViews()
    if (!mainWindow.isVisible()) mainWindow.show()
    officialFocusArmedAt = Date.now() + 1200
    startup.mark('interactive')

    // --- everything below here is deferred work (§17, §18, §42, §49) --------------------------
    //
    // None of it can delay the user, none of it can fail the boot, and each piece reports its own
    // failure. The wallpaper and the dock are enhancements: a workstation that cannot show them is
    // still a workstation.
    startup.defer('official-surfaces-ready', () => protection.start('wallpaper-layer'))

    // The Sub-worker layer is created here, after the official UI is ready and
    // before any extension can ask for it. Creation is inert (no process), so
    // the default startup path is unchanged.
    await createWorkerManager(nodeExe)

    // Computer Use is created only when the user first asks for it (opening the
    // panel or running a contract): no driver is probed during a normal boot.
    // The IPC surface is registered now so the panel can reach it, and every
    // handler builds the runtime lazily on first call.
    if (computerUseEnabled()) {
      registerComputerUseIpc()
      logLine('computer use: runtime available on demand (computer-use:* IPC)')
    } else {
      logLine('computer use: disabled by config/app.json')
    }

    // The engineering runtime is repository supervision rather than hardware, so it
    // is registered the same way: the IPC surface exists from boot and the host is
    // created on the first call, with no probe in the normal startup path.
    if (engineeringEnabled()) {
      registerEngineeringIpc()
      logLine('engineering: runtime available on demand (engineering:* IPC)')
    } else {
      logLine('engineering: disabled by config/app.json')
    }

    // The plugin platform is the layer everything else is mounted through, so its IPC
    // surface exists from boot — but the host itself, and therefore the twenty-five
    // plugin contexts behind it, is built on the first call rather than in the startup
    // path. A plugin fault must not be able to stop the shell from opening.
    if (pluginsEnabled()) {
      registerPluginIpc()
      logLine('plugins: runtime available on demand (plugins:* IPC)')
    } else {
      logLine('plugins: disabled by config/app.json')
    }

    const extensionsReady = await startup.defer('extensions-ready', () => protection.start('mega-extension-host'))
    // The scheduled restart exists from boot, not from the first look at the dock: a plan set
    // yesterday must still fire on a shell whose panels nobody opened, and the ticker is what makes
    // its countdown true. `resumeOnStartup` is the other side of the boundary — if this start is the
    // one that followed a planned restart, the suspended task continues here.
    registerRebootIpc()
    startRebootTicker()
    startup.defer('workspace-restored', () => ensureReboot().resumeOnStartup())
      .then((outcome) => {
        if (outcome?.value?.resumed || outcome?.value?.reports?.length) logLine(`reboot resume on startup: ${JSON.stringify(outcome.value.reports)}`)
      })
      // No `.catch`: `defer` answers, it does not reject — a failed resume is already reported as its
      // own phase, and a second error path here would be a second story about one event.
    // The official renderer is the product's frontend, so the dock is the only view left
    // to attach: it reserves its strip on the right and the official UI keeps the rest.
    if (extensionsReady.value?.ok && INTEGRATED_MEGA_DOCK) {
      /**
       * The dock is started only when it is meant to be on screen. `showOfficialFrontend` and the layout pass
       * are *not* about the dock — they are how the official UI gets its bounds re-applied after the page
       * loads — so they still run with the dock hidden, with no strip reserved.
       */
      if (megaDockShown) await startup.defer('dock-ready', () => protection.start('mega-dock'))
      showOfficialFrontend()
      layoutIntegratedViews()
    }

    // Only an explicit persisted opt-in starts a worker process at boot.
    if (workerManager?.describe?.().config?.enabledOnStartup) {
      await startup.defer('sub-worker', async () => {
        const started = await workerManager.start({ reason: 'enabledOnStartup' })
        logLine(`sub-worker auto-start (enabledOnStartup): ${JSON.stringify(started)}`)
      })
    }
    // ENHANCED: every deferred layer has settled, and the boot report says what each of them cost.
    await startup.complete()
    logLine(`[BOOT] boot report ${JSON.stringify(startup.summary())}`)
    // The enhancement layer's own report: what is healthy, what degraded, and what is carrying it.
    logLine(`[protection] ${JSON.stringify(protection.describe())}`)
  } catch (error) {
    await dialog.showMessageBox({
      type: 'error',
      title: bilingualTitle('DS-Harness 启动失败', 'DS-Harness failed to start'),
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
/**
 * Closing the last window quits the *Desktop*, and only the Desktop.
 *
 * `before-quit` releases the UI's own resources (see `teardownManagedResources`)
 * and detaches from the Runtime. Nothing on this path stops the Harness, because
 * the Harness does not belong to this process: it belongs to the Runtime Host,
 * which was started detached and which keeps serving after this window is gone.
 *
 * The `exit` handler is deliberately *not* `stopHarness` any more. A synchronous
 * "kill the child on the way out" is exactly the coupling this change removes,
 * and it would have silently undone the split on the one path that runs no matter
 * how the process ends. It now only cleans up a child this process started
 * itself, which the attached path never does.
 */
app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => {
  // Closing the main window (or a system shutdown) is the implicit normal exit.
  if (shuttingDown) return
  shuttingDown = true
  logLine('before-quit: releasing the UI; the Runtime is left running')
  teardownManagedResources()
})
process.on('exit', () => {
  try {
    stopHarnessInProcess()
  } catch {}
})
