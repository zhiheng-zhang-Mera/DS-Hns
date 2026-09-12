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
const { HarnessUpdater } = require('./updater/harness-updater')
const { createThemeEngine } = require('./theme')
const { createSkillService } = require('./skills/skill-service')
const { createDockTarget } = require('./dock/target')

const CHANNELS = [
  'mega:snapshot', 'mega:add-task', 'mega:reorder-task', 'mega:cancel-task', 'mega:clear-pending',
  'mega:remove-tasks', 'mega:update-scheduler', 'mega:refresh-hardware', 'mega:update-settings',
  'mega:balance', 'mega:pick-workspace', 'mega:pick-sound',
  'mega:update-check', 'mega:update-apply',
  'mega:dock-toggle', 'mega:dock-expand',
  // ---- Dual-UI frontend modes (Update-Plan/Dual-UI.md 任务 12 / 任务 13) ----
  'mega:mode-snapshot', 'mega:mode-set', 'mega:mode-toggle', 'mega:mode-degrade', 'mega:mode-compatibility',
  // ---- Native frontend model (the extensions owns the adapter/themes) ----
  'hns:native-snapshot', 'hns:native-create-session', 'hns:native-select-session',
  'hns:native-send', 'hns:native-cancel', 'hns:native-theme',
  // Daily top bar actions (Update-Plan/daily-refactorr.md 任务 3): the same
  // writers the dock uses, reached from the native frontend.
  'hns:native-update-settings', 'hns:native-pick-workspace',
  // ---- HNS unified theme system ----
  'mega:theme-snapshot', 'mega:theme-capabilities', 'mega:theme-create', 'mega:theme-revise',
  'mega:theme-validate', 'mega:theme-approve', 'mega:theme-discard', 'mega:theme-apply',
  'mega:theme-delete', 'mega:theme-duplicate', 'mega:theme-restore', 'mega:theme-import',
  'mega:theme-observe', 'mega:theme-detail', 'mega:theme-paint', 'mega:theme-artifacts',
  'mega:theme-surfaces',
  // ---- HNS skills management ----
  'mega:skills-snapshot', 'mega:skills-search', 'mega:skills-tags', 'mega:skills-detail',
  'mega:skills-install-source', 'mega:skills-install-catalog', 'mega:skills-pick-local',
  'mega:skills-remove', 'mega:skills-remove-many', 'mega:skills-remove-collection',
  'mega:skills-set-invocation'
]

/** Renderer events pushed by the theme engine (never injected into the official UI). */
const THEME_EVENT_CHANNEL = 'mega:theme-changed'

/** Theme IPC channels, cleared and re-registered on every extension start. */
const THEME_CHANNELS = [
  'mega:theme-snapshot', 'mega:theme-capabilities', 'mega:theme-create', 'mega:theme-revise',
  'mega:theme-validate', 'mega:theme-approve', 'mega:theme-discard', 'mega:theme-apply',
  'mega:theme-delete', 'mega:theme-duplicate', 'mega:theme-restore', 'mega:theme-import',
  'mega:theme-observe', 'mega:theme-detail', 'mega:theme-paint', 'mega:theme-artifacts',
  'mega:theme-surfaces'
]

/** Skills IPC channels, owned by the skills service. */
const SKILL_CHANNELS = [
  'mega:skills-snapshot', 'mega:skills-search', 'mega:skills-tags', 'mega:skills-detail',
  'mega:skills-install-source', 'mega:skills-install-catalog', 'mega:skills-pick-local',
  'mega:skills-remove', 'mega:skills-remove-many', 'mega:skills-remove-collection',
  'mega:skills-set-invocation'
]

/** Renderer event pushed when the installed skill set changes. */
const SKILL_EVENT_CHANNEL = 'mega:skills-changed'


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
let updater = null
let restartTimer = null
let started = false
let dockExpanded = false
let dockWidth = DOCK_DEFAULT_WIDTH
let dockUserHidden = false
let themeEngine = null
let skillService = null
let dockReadyHandler = null
let unsubscribeSubWorker = null
// Latest geometry reported by the dock renderer (slot map + protected regions).
let themeRegionCache = {}
let themeTreeCache = null
/** Latest slot geometry reported by the *native* renderer (Daily Mode). */
let nativeRegionCache = {}
/** True while this frontend has a prompt in flight (drives the composer state). */
let nativeSending = false
/** Unsubscribe handle for the shell's native-region relay. */
let unsubscribeNativeRegions = null
/** Last mode status the shell pushed, for the dock snapshot and diagnostics. */
let modeStatusCache = null
const mainWindowBindings = []

/**
 * The only way this extension reaches the dock renderer.
 *
 * The shell hands over a `dockAdapter` for the integrated `WebContentsView`; the
 * legacy companion window below is the fallback backend of the same adapter
 * (`mega/dock/target.js`). No caller after this point reads `dockWindow` to talk
 * to the dock — that path is exactly how "theme apply succeeded, the dock never
 * repainted" used to happen.
 */
const dockTarget = createDockTarget({
  getLegacyWindow: () => dockWindow,
  ctx: () => ctx,
  log: (message) => log(message)
})

/**
 * The two official surfaces (Update-Plan 任务 2 / 任务 3).
 *
 * Same pattern as `dockTarget`, and for a stronger reason: the official renderer is
 * protected, so the extension is handed an adapter that can paint a shell and an
 * overlay and *nothing else*. It never receives the official `webContents`, so
 * there is no reachable path from this file into the official UI.
 *
 * A missing adapter is not an error: the shell simply has no official surfaces to
 * paint, and the HNS theme works exactly as before (任务 18).
 */
const officialSurfaceTarget = {
  available: () => Boolean(ctx?.officialSurfaceAdapter),
  paint: (payload, placement = null) => {
    const adapter = ctx?.officialSurfaceAdapter
    if (!adapter || typeof adapter.paint !== 'function') return { ok: false, reason: 'no_surface_target' }
    return adapter.paint(payload, placement)
  },
  reset: () => {
    const adapter = ctx?.officialSurfaceAdapter
    if (!adapter || typeof adapter.reset !== 'function') return { ok: false, reason: 'no_surface_target' }
    return adapter.reset()
  },
  layout: () => {
    const adapter = ctx?.officialSurfaceAdapter
    if (!adapter || typeof adapter.layout !== 'function') return { ok: false, reason: 'no_surface_target' }
    return adapter.layout()
  },
  bounds: () => {
    const adapter = ctx?.officialSurfaceAdapter
    if (!adapter || typeof adapter.officialBounds !== 'function') return null
    try {
      const bounds = adapter.officialBounds()
      if (!bounds || !Number(bounds.width) || !Number(bounds.height)) return null
      return bounds
    } catch {
      return null
    }
  },
  describe: () => {
    const adapter = ctx?.officialSurfaceAdapter
    if (!adapter || typeof adapter.describe !== 'function') {
      return { available: false, reason: 'the shell did not provide an official surface adapter' }
    }
    try {
      return adapter.describe()
    } catch (error) {
      return { available: false, reason: String(error?.message || error) }
    }
  }
}

/**
 * Dual-UI accessors (Update-Plan/Dual-UI.md 任务 3 / 任务 5 / 任务 14).
 *
 * The shell owns the two renderers and the mode manager; the extension owns the
 * theme engine, the HNS model adapter and the scheduler. These three helpers are
 * the whole interface between them.
 */
function nativeFrontend() {
  return ctx?.nativeFrontend || null
}

function nativeMode() {
  try {
    return nativeFrontend()?.manager?.current() || ctx?.nativeMode?.current?.() || 'daily'
  } catch {
    return 'daily'
  }
}

/** The push target for the native renderer; a no-op when it is not attached. */
function nativeThemeTarget() {
  const target = ctx?.nativeThemeTarget
  return {
    available: () => Boolean(target?.available?.()),
    send: (channel, payload) => {
      if (!target || typeof target.send !== 'function') return false
      try {
        return target.send(channel, payload) !== false
      } catch (error) {
        log(`native renderer push failed on ${channel}: ${error?.message || error}`)
        return false
      }
    }
  }
}

/**
 * Live slot geometry for theme observation (任务 14).
 *
 * Daily Mode observes the native renderer; Work Mode observes the dock. The
 * protected official renderer is never measured either way.
 */
async function observedRegions() {
  if (nativeMode() === 'daily' && nativeThemeTarget().available()) {
    nativeThemeTarget().send('hns:native-probe-regions')
    // Give the renderer a beat to answer before the snapshot reads the cache; a
    // silent renderer still degrades to "structure only" rather than stalling.
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 120)
      timer.unref?.()
    })
    if (nativeRegionCache && Object.keys(nativeRegionCache).length) return nativeRegionCache
  }
  return measureDockRegions()
}

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
      // Dock state comes from the adapter, so it is real in both generations:
      // integrated mode reports its mode and live view geometry instead of the
      // "no dockWindow, therefore no UI" answer the old test produced.
      dock: dockTarget.getState({
        expanded: dockExpanded,
        width: currentDockWidth(),
        expandedWidth: dockWidth,
        collapsedWidth: DOCK_COLLAPSED_WIDTH
      }),
      tray: Boolean(tray)
    },
    /**
     * Dual-UI frontend mode (Update-Plan/Dual-UI.md 任务 12 / 任务 13).
     *
     * The dock is the shared control centre for both frontends: this block is
     * what lets the collapsed rail and the expanded panel show the same, real
     * mode instead of guessing it.
     */
    frontend: (() => {
      try {
        const status = modeStatusCache || ctx?.nativeMode?.describe?.() || null
        return {
          mode: status?.mode || nativeMode(),
          state: status?.state || null,
          degraded: status?.degraded?.active ? status.degraded : null,
          modes: ['daily', 'work'],
          available: Boolean(ctx?.nativeMode),
          sync: status?.sync || null
        }
      } catch (error) {
        log(`frontend mode snapshot failed: ${error?.message || error}`)
        return { mode: 'daily', state: null, degraded: null, modes: ['daily', 'work'], available: false, sync: null }
      }
    })(),
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
    // Official harness alignment (Mega 拓展状态): installed vs official latest.
    update: updater ? updater.describe() : null,
    // Optional Sub-worker: Mega is the only visual surface for it (plan §11).
    // When the shell did not provide a manager the panel reports "unavailable"
    // instead of breaking the dock.
    subWorker: subWorkerSnapshot(),
    // Mega no longer mirrors the official Harness session history: the official
    // UI owns it, and the terminal observer only watches it for alerts.
    terminalAlerts: terminalDispatcher.describe(),
    // Compact theme status. The full theme list/detail lives behind the dedicated
    // theme channels so this snapshot stays small and cheap to poll.
    theme: themeEngine ? (() => {
      try {
        const described = themeEngine.describe()
        return {
          themeApiVersion: described.themeApiVersion,
          active: described.active,
          activeName: described.activeName,
          previewing: described.previewing,
          previewDraftId: described.previewDraftId,
          effectLevel: described.effectLevel,
          effect: described.effect,
          degraded: described.degraded,
          themeCount: described.themes.length,
          userThemeCount: described.themes.filter((theme) => theme.source !== 'system').length,
          recovery: described.recovery.slice(-2)
        }
      } catch (error) {
        log(`theme status unavailable: ${error?.message || error}`)
        return null
      }
    })() : null,
    // Compact skills status. The full list and the search catalog live behind the
    // dedicated skills channels so this snapshot stays small.
    skills: (() => {
      try {
        const snapshot = ensureSkillService().snapshot()
        return {
          root: snapshot.root,
          counts: snapshot.counts,
          collections: snapshot.collections.length,
          catalog: snapshot.catalog
        }
      } catch (error) {
        log(`skills status unavailable: ${error?.message || error}`)
        return null
      }
    })()
  }
}

/** Sub-worker snapshot for the Mega panel and the tray (plan §11, §12, §16). */
function subWorkerSnapshot() {
  try {
    if (!ctx?.subWorker?.describe) {
      return {
        feature: 'optional-sub-worker',
        available: false,
        enabled: false,
        state: 'OFF',
        worker_id: null,
        mode: 'Executor',
        task: null,
        queue: [],
        history: [],
        live: null,
        events: [],
        config: {},
        reason: 'the desktop shell did not provide a Sub-worker manager'
      }
    }
    return ctx.subWorker.describe()
  } catch (error) {
    log(`sub-worker snapshot failed: ${error?.message || error}`)
    return { feature: 'optional-sub-worker', available: false, enabled: false, state: 'OFF', error: String(error?.message || error) }
  }
}

/** True when the shell handed the extension a working worker manager. */
function subWorkerAvailable() {
  return Boolean(ctx?.subWorker?.describe && ctx.subWorker.start && ctx.subWorker.stop)
}

/**
 * Every dock push goes through the adapter. The dock renderer initiates its own
 * IPC calls, but a *push* (a change notification, a theme payload) needs a
 * target, and the integrated dock is the target the product actually ships.
 */
function notifyChanged() {
  dockTarget.send('mega:changed')
  // The native renderer is a second consumer of the same facts; pushing here is
  // what keeps Daily Mode live without a poll it does not need.
  pushNativeSnapshot()
}

/**
 * Theme paint channel. Deliberately separate from `mega:changed`: a theme payload
 * carries tokens, slot styles and inline asset data URIs, and it must reach the
 * renderer even when the ordinary dock snapshot push is coalesced.
 */
function notifyThemeChanged() {
  dockTarget.send(THEME_EVENT_CHANNEL)
}

/**
 * Ask the dock renderer for its live slot geometry. Used by the UI inspector to
 * locate the protected regions. Bounded by a timeout: a renderer that never
 * answers degrades the snapshot to structure-only instead of stalling a design.
 */
function requestThemeRegions(timeoutMs = 1500) {
  const wc = dockTarget.getWebContents()
  if (!wc) {
    log('dock region probe unavailable: no dock target')
    return Promise.resolve(null)
  }
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { ctx?.electron?.ipcMain?.removeListener('mega-theme:regions', onReply) } catch {}
      resolve(value)
    }
    const onReply = (_event, payload) => finish(payload)
    const timer = setTimeout(() => {
      log(`dock region probe timed out after ${timeoutMs} ms`)
      finish(null)
    }, timeoutMs)
    timer.unref?.()
    try {
      ctx.electron.ipcMain.on('mega-theme:regions', onReply)
      wc.send('mega-theme:probe-regions')
    } catch (error) {
      log(`dock region probe failed: ${error?.message || error}`)
      finish(null)
    }
  })
}

/**
 * Live slot geometry, measured now.
 *
 * The dock pushes its geometry whenever it lays out, but an *observation* must
 * not depend on whether such a push happened to land first: without this pull the
 * snapshot's slot map could be empty and the observer would silently design
 * against nothing. The probe re-measures in the renderer and answers with real
 * bounding boxes.
 */
async function measureDockRegions() {
  if (!dockTarget.hasTarget()) {
    log(`dock regions unavailable: ${dockTarget.mode()} dock target missing; slot geometry falls back to the last push`)
    return themeRegionCache
  }
  try {
    const probed = await requestThemeRegions()
    if (probed && typeof probed === 'object') {
      themeRegionCache = probed
      themeTreeCache = probed.componentTree || themeTreeCache
      return probed
    }
  } catch (error) {
    log(`dock region measurement failed: ${error?.message || error}`)
  }
  return themeRegionCache
}

/**
 * Visual observation. Only our own dock webContents is ever captured — the
 * official Harness renderer is never read, styled or screenshotted by us.
 *
 * A missing target is logged once instead of silently producing an empty
 * snapshot: the theme system must be able to tell it is designing blind.
 */
async function captureDockPages(pageIds = []) {
  if (!dockTarget.hasTarget()) {
    log(`dock capture unavailable: ${dockTarget.mode()} dock target missing; snapshot degrades to structure-only`)
    return {}
  }
  const screenshots = {}
  for (const pageId of pageIds) {
    const image = await dockTarget.capturePage()
    if (!image) continue
    try {
      const png = typeof image.toPNG === 'function' ? image.toPNG() : null
      if (png && png.length) screenshots[pageId] = png
      else if (png) log(`dock capture returned an empty image for ${pageId}`)
    } catch (error) {
      log(`dock capture failed for ${pageId}: ${error?.message || error}`)
    }
  }
  return screenshots
}

/** Theme-facing dock state: real in both dock generations, via the adapter. */
function themeDockState() {
  return dockTarget.getState({
    expanded: dockExpanded,
    width: currentDockWidth(),
    expandedWidth: dockWidth,
    collapsedWidth: DOCK_COLLAPSED_WIDTH
  })
}

function ensureThemeEngine() {
  if (themeEngine) return themeEngine
  themeEngine = createThemeEngine({
    log: (message) => log(`theme: ${message}`),
    scheduler,
    applyToRenderer: (payload) => {
      if (!dockTarget.send('mega:theme-apply', payload)) {
        log('theme repaint could not reach the dock: no dock target')
      }
      // The native frontend is the Daily Mode theme surface (任务 14 / 任务 15):
      // the same declarative payload reaches it, so one theme styles the dock,
      // the official frame and (when visible) the native frontend.
      nativeThemeTarget().send('hns:native-theme-apply', payload)
    },
    onChanged: () => notifyThemeChanged(),
    capture: (pageIds) => captureDockPages(pageIds),
    dockRegions: () => observedRegions(),
    componentTree: () => (nativeMode() === 'daily' ? (nativeRegionCache.componentTree || themeTreeCache) : themeTreeCache),
    // Integrated dock geometry comes from the shell's view bounds; a legacy
    // window is read through its content size. Both through one accessor.
    windowSize: () => dockTarget.getSize(),
    dockState: () => themeDockState(),
    // Is a screenshot possible right now? Only the adapter knows, and its answer
    // is what turns "no picture" into a *recorded degradation* instead of a
    // silent one. A hidden or absent dock is a known, allowed reason; a visible
    // dock that yields no image is a capture defect and the snapshot says so.
    visualExpected: () => visualExpectation(),
    // The protected official view's bounds: a rectangle, used by the overlay
    // layout engine to place the frame and the character. Never its contents.
    officialBounds: () => officialSurfaceTarget.bounds(),
    // The official shell + overlay targets. Failure-isolated: a surface problem
    // disables the surfaces and leaves the HNS theme running (任务 18).
    paintSurfaces: (payload, placement) => {
      const result = officialSurfaceTarget.paint(payload, placement)
      if (result && result.ok === false && result.reason && result.reason !== 'no_surface_target') {
        log(`official surfaces not painted (${result.reason}); the official renderer is unaffected`)
      }
      return result
    },
    resetSurfaces: () => officialSurfaceTarget.reset()
  })
  return themeEngine
}

/** The visual-capture expectation handed to the snapshot service. */
function visualExpectation() {
  if (process.env.DSH_THEME_NO_VISUAL === '1') {
    return { expected: false, reason: 'visual capture disabled by DSH_THEME_NO_VISUAL=1' }
  }
  if (!dockTarget.hasTarget()) {
    return { expected: false, reason: 'the dock renderer is not available in this run' }
  }
  if (!dockTarget.getVisible()) {
    return { expected: false, reason: 'the dock renderer is present but not visible' }
  }
  return { expected: true, reason: null }
}

/**
 * Sub-worker events can be frequent (every command output line). The tray menu
 * and the dock refresh are therefore coalesced into one update per window
 * instead of one IPC round-trip per event.
 */
let subWorkerRefreshTimer = null
function scheduleSubWorkerRefresh() {
  if (subWorkerRefreshTimer) return
  subWorkerRefreshTimer = setTimeout(() => {
    subWorkerRefreshTimer = null
    try {
      applyTrayMenu()
    } catch (error) {
      log(`tray refresh failed: ${error?.message || error}`)
    }
    notifyChanged()
  }, 400)
  if (typeof subWorkerRefreshTimer.unref === 'function') subWorkerRefreshTimer.unref()
}

function bindSubWorker() {
  if (typeof ctx?.onSubWorkerChange !== 'function') return
  unsubscribeSubWorker = ctx.onSubWorkerChange(() => scheduleSubWorkerRefresh())
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

/**
 * Tell the shell how the dock should be laid out.
 *
 * The integrated dock is a `WebContentsView` whose geometry the shell owns, so a
 * dock toggle that only flipped a local boolean left the reserved strip at its
 * old width. The shell listens on `mega-shell:dock-state` and re-lays out both
 * views. It is a no-op for the legacy window backend (the shell has no listener
 * there) and harmless if the shell is absent.
 */
function notifyShellDockState() {
  if (!mainAlive()) return false
  try {
    ctx.mainWindow.webContents.send('mega-shell:dock-state', {
      expanded: dockExpanded,
      width: currentDockWidth(),
      expandedWidth: dockWidth
    })
    return true
  } catch (error) {
    log(`dock layout push failed: ${error?.message || error}`)
    return false
  }
}

function setDockExpanded(expanded, { focus = false, persist = true } = {}) {
  dockExpanded = Boolean(expanded)
  dockUserHidden = false
  // `persist: false` is the shell's mode policy (Work Mode collapses the dock so
  // the official UI keeps its width). It must not overwrite the user's own
  // preference, which is what a later Daily switch restores.
  if (persist) saveDockState()
  positionDock()
  // The legacy companion window follows the extension's own visibility rules.
  const win = dockWindow && !dockWindow.isDestroyed() ? dockWindow : null
  if (win) {
    if (dockCanShow()) {
      if (focus && dockExpanded) {
        win.show()
        win.focus()
      } else {
        win.showInactive()
      }
    }
  }
  // The integrated dock is re-laid out by the shell, which owns its bounds.
  notifyShellDockState()
  dockTarget.send('mega:changed')
  return dockTarget.getState({
    expanded: dockExpanded,
    width: currentDockWidth(),
    expandedWidth: dockWidth,
    collapsedWidth: DOCK_COLLAPSED_WIDTH
  })
}

function toggleDock({ focus = true } = {}) {
  if (!dockTarget.hasTarget()) return false
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
 * The tray keeps the two exit actions it always had, and now also carries the
 * Sub-worker controls required by the optional execution layer (plan §16): the
 * worker has no window of its own, so the tray is one of its two entry points.
 * Every worker action is failure isolated - a worker problem can never prevent
 * the user from reaching Exit.
 */
function applyTrayMenu() {
  if (!tray || !ctx?.electron?.Menu) return
  const { Menu } = ctx.electron
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show', click: () => focusMain() },
    { label: 'Mega', click: () => openMegaDock() },
    { type: 'separator' },
    subWorkerTrayItem(),
    { type: 'separator' },
    { label: 'Exit DS-Harness', click: () => requestShutdown('graceful') },
    { label: 'Force Exit DS-Harness', click: () => requestShutdown('force') }
  ]))
}

/** Show the single product window and expand the integrated Mega panel inside it. */
function openMegaDock() {
  focusMain()
  return setDockExpanded(true, { focus: true })
}

function openSubWorkerLiveView() {
  try {
    openMegaDock()
    // The Live View is a dock push like every other one: it goes through the
    // target adapter, so it reaches the integrated dock rather than only the
    // legacy companion window.
    if (!dockTarget.send('mega:sub-worker-live-view')) {
      log('live view could not reach the dock: no dock target')
      return false
    }
    return true
  } catch (error) {
    log(`open live view failed: ${error?.message || error}`)
    return false
  }
}

function safeWorkerCall(label, fn) {
  try {
    const result = fn()
    if (result && typeof result.then === 'function') {
      result.catch((error) => log(`sub-worker ${label} failed: ${error?.message || error}`))
    }
    return result
  } catch (error) {
    log(`sub-worker ${label} failed: ${error?.message || error}`)
    return null
  }
}

/** Busy-aware Sub-worker submenu (§16: "Sub-worker: BUSY / Task: ..."). */
function subWorkerTrayItem() {
  const snapshot = subWorkerSnapshot()
  const state = String(snapshot.state || 'OFF').toUpperCase()
  const busy = ['ASSIGNED', 'RUNNING', 'PAUSING', 'PAUSED', 'BLOCKED', 'STOPPING'].includes(state)
  const running = Boolean(snapshot.enabled)
  const taskId = snapshot.task_id || snapshot.task?.task_id || null
  const header = state === 'OFF'
    ? 'Sub-worker: OFF'
    : (busy ? `Sub-worker: BUSY (${state})` : `Sub-worker: ${state}`)

  const template = [
    { label: header, enabled: false },
    { label: `Task: ${taskId || 'Idle'}`, enabled: false },
    { type: 'separator' },
    {
      label: 'Start',
      enabled: subWorkerAvailable() && !running,
      click: () => safeWorkerCall('start', () => ctx.subWorker.start({ reason: 'tray' }))
    },
    {
      label: 'Stop',
      enabled: subWorkerAvailable() && running,
      click: () => safeWorkerCall('stop', () => ctx.subWorker.stop({ reason: 'tray' }))
    },
    {
      label: 'Restart',
      enabled: subWorkerAvailable() && (running || state !== 'OFF'),
      click: () => safeWorkerCall('restart', () => ctx.subWorker.restart({ reason: 'tray' }))
    },
    { type: 'separator' },
    {
      label: 'Pause',
      enabled: subWorkerAvailable() && running && !['PAUSED', 'PAUSING'].includes(state),
      click: () => safeWorkerCall('pause', () => ctx.subWorker.pause('paused from tray'))
    },
    {
      label: 'Resume',
      enabled: subWorkerAvailable() && running && ['PAUSED', 'PAUSING'].includes(state),
      click: () => safeWorkerCall('resume', () => ctx.subWorker.resume('resumed from tray'))
    },
    {
      label: 'Cancel Current Task',
      enabled: subWorkerAvailable() && running && busy,
      click: () => safeWorkerCall('cancel', () => ctx.subWorker.cancelTask('cancelled from tray'))
    },
    {
      label: 'Open Live View',
      enabled: subWorkerAvailable(),
      click: () => openSubWorkerLiveView()
    },
    {
      label: state === 'CRASHED' ? 'Restart Worker' : 'Take Over Workspace',
      enabled: subWorkerAvailable(),
      click: () => (state === 'CRASHED'
        ? safeWorkerCall('restart', () => ctx.subWorker.restart({ reason: 'crash recovery (tray)' }))
        : safeWorkerCall('take over', () => ctx.subWorker.takeOver({ reason: 'take over from tray' })))
    }
  ]

  return { label: 'Sub-worker', submenu: template }
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

/**
 * Restart after a harness update. The detached update runner waits for this
 * process to disappear before it may touch `app\node_modules`, so the shutdown
 * must be a real exit, never a window close: the normal graceful path stops the
 * scheduler, persists state and terminates the managed Harness child first.
 */
function scheduleRestart(delayMs = 1200) {
  if (restartTimer) return true
  restartTimer = setTimeout(() => {
    restartTimer = null
    log('restarting DS-Harness for the harness update')
    const hook = ctx?.shutdown
    try {
      if (typeof hook?.graceful === 'function') hook.graceful('update')
      else hardExit()
    } catch (error) {
      log(`restart failed, exiting directly: ${error?.message || error}`)
      hardExit()
    }
  }, delayMs)
  restartTimer.unref?.()
  return true
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

/**
 * Region probe listener, kept in a named reference so `stop()` can detach exactly
 * the handler it registered.
 */
function onThemeRegions(_event, payload) {
  themeRegionCache = payload && typeof payload === 'object' ? payload : {}
  themeTreeCache = payload?.componentTree || null
}

/**
 * The native frontend's data plane (Update-Plan/Dual-UI.md 任务 7 / 任务 8).
 *
 * The renderer asks for one snapshot and receives the normalized HNS model: no
 * route names, no journal events, no official selectors. Every read goes through
 * the Compatibility Adapter, and a missing adapter degrades to an explicit
 * "unavailable" answer rather than a blank screen that looks like "no data".
 */
async function nativeSnapshot({ sessionId = null } = {}) {
  const runtime = nativeFrontend()
  if (!runtime?.adapter) {
    return {
      ok: false,
      reason: 'native_frontend_unavailable',
      backend: { state: 'unknown', healthy: false, reason: 'the shell did not provide the Dual-UI runtime' },
      sessions: [],
      sessionsDegraded: true,
      messages: [],
      toolEvents: [],
      tasks: [],
      composer: { ready: false, canSend: false, canStop: false, running: false, placeholder: 'Unavailable', reason: 'no adapter' },
      settings: { available: false, models: [] }
    }
  }
  const sync = runtime.sync
  const requested = sessionId || (sync?.activeSession ? sync.activeSession() : null)
  let snapshot
  try {
    snapshot = await runtime.adapter.snapshot({ sessionId: requested, sending: nativeSending })
    // First contact: adopt the newest backend session so the sidebar and the
    // composer agree about what "current" means (任务 10).
    if (!requested && snapshot?.sessions?.length) {
      sync?.adoptNewest?.(snapshot.sessions)
      if (sync?.activeSession?.() && sync.activeSession() !== snapshot.session?.id) {
        snapshot = await runtime.adapter.snapshot({ sessionId: sync.activeSession(), sending: nativeSending })
      }
    }
  } catch (error) {
    log(`native snapshot failed: ${error?.message || error}`)
    return {
      ok: false,
      reason: 'adapter_failed',
      backend: { state: 'unreachable', healthy: false, reason: String(error?.message || error) },
      sessions: [],
      sessionsDegraded: true,
      messages: [],
      toolEvents: [],
      tasks: [],
      composer: { ready: false, canSend: false, canStop: false, running: false, placeholder: 'Unavailable', reason: String(error?.message || error) },
      settings: { available: false, models: [] }
    }
  }
  const status = nativeFrontend()?.manager?.describe?.() || null
  return {
    ...snapshot,
    mode: status?.mode || nativeMode(),
    modeState: status?.state || null,
    degraded: status?.degraded?.active ? status.degraded : null,
    diagnostics: nativeDiagnostics()
  }
}

/** Diagnostics for the native settings drawer and for acceptance evidence. */
function nativeDiagnostics() {
  const runtime = nativeFrontend()
  let adapter = null
  try {
    adapter = runtime?.adapter?.describe?.() || null
  } catch (error) {
    adapter = { error: String(error?.message || error) }
  }
  return {
    adapter,
    mode: (() => {
      try {
        return runtime?.manager?.describe?.() || null
      } catch {
        return null
      }
    })(),
    theme: (() => {
      try {
        return themeEngine ? { active: themeEngine.describe().active, effectLevel: themeEngine.describe().effectLevel } : null
      } catch {
        return null
      }
    })(),
    compatibility: lastCompatibilityReport
  }
}

/** The last Compatibility Report, produced on demand (任务 16 / 任务 17). */
let lastCompatibilityReport = null

/**
 * The single writer for settings, shared by the dock and the Daily top bar
 * (Update-Plan/daily-refactorr.md 任务 3: Daily may *switch* model/workspace, but
 * there is still exactly one place that persists a setting).
 */
function applySettingsPatch(patch = {}) {
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
}

/** The workspace picker, shared by the dock and the Daily top bar. */
async function pickWorkspaceDirectory(dialog) {
  const result = await dialog.showOpenDialog(ctx.mainWindow, {
    title: '选择 headless 队列工作区',
    properties: ['openDirectory', 'createDirectory']
  })
  if (result.canceled || !result.filePaths.length) return null
  return workspace.setWorkspaceRoot(result.filePaths[0])
}

async function runCompatibilityProbe({ to = null, surface = 'native' } = {}) {
  const runtime = nativeFrontend()
  if (!runtime?.probe) return null
  try {
    const report = await runtime.probe.run({ to, surface })
    lastCompatibilityReport = report
    return report
  } catch (error) {
    log(`compatibility probe failed: ${error?.message || error}`)
    return null
  }
}

/** Push a fresh snapshot to the native renderer when it is the visible surface. */
let nativeSnapshotTimer = null
function pushNativeSnapshot() {
  if (!nativeThemeTarget().available()) return false
  if (nativeMode() !== 'daily') return false
  // Coalesce: `notifyChanged` fires on every scheduler/terminal event, and a
  // snapshot reads the backend. One push per window keeps that honest without
  // turning a busy queue into a poll storm.
  if (nativeSnapshotTimer) return false
  nativeSnapshotTimer = setTimeout(() => {
    nativeSnapshotTimer = null
    deliverNativeSnapshot()
  }, 250)
  nativeSnapshotTimer.unref?.()
  return true
}

function deliverNativeSnapshot() {
  if (!nativeThemeTarget().available()) return
  if (nativeMode() !== 'daily') return
  nativeSnapshot()
    .then((snapshot) => nativeThemeTarget().send('hns:native-changed', snapshot))
    .catch((error) => log(`native snapshot push failed: ${error?.message || error}`))
}

/**
 * IPC owned by the extension for the native renderer, plus the dock's mode
 * surface (任务 12 / 任务 13). Channel ownership is deliberate: the shell answers
 * "which renderer is visible", the extension answers "what does the model say".
 */
function registerNativeIpc() {
  const { ipcMain } = ctx.electron
  const guard = (handler) => async (...args) => {
    try {
      return await handler(...args)
    } catch (error) {
      log(`native ipc failure: ${error?.stack || error}`)
      return { ok: false, reason: 'native_ipc_failed', message: String(error?.message || error) }
    }
  }

  ipcMain.handle('hns:native-snapshot', guard((_event, payload) => nativeSnapshot(payload || {})))
  ipcMain.handle('hns:native-create-session', guard(async () => {
    const runtime = nativeFrontend()
    if (!runtime?.adapter) return { ok: false, reason: 'native_frontend_unavailable' }
    const created = await runtime.adapter.createSession({})
    if (created?.ok && created.sessionId) {
      runtime.sync?.recordActiveSession?.(created.sessionId, { mode: 'daily' })
    }
    pushNativeSnapshot()
    return created
  }))
  ipcMain.handle('hns:native-select-session', guard((_event, payload) => {
    const sessionId = String(payload?.sessionId || '')
    if (!sessionId) return { ok: false, reason: 'no_session' }
    nativeFrontend()?.sync?.recordActiveSession?.(sessionId, { mode: 'daily' })
    pushNativeSnapshot()
    return { ok: true, sessionId }
  }))
  ipcMain.handle('hns:native-send', guard(async (_event, payload) => {
    const runtime = nativeFrontend()
    if (!runtime?.adapter) return { ok: false, reason: 'native_frontend_unavailable' }
    const sessionId = String(payload?.sessionId || runtime.sync?.activeSession?.() || '')
    const prompt = String(payload?.prompt || '')
    if (!sessionId) return { ok: false, reason: 'no_session', message: 'select or create a session first' }
    nativeSending = true
    try {
      const result = await runtime.adapter.sendPrompt({ sessionId, prompt })
      if (result?.ok) runtime.sync?.recordActiveSession?.(sessionId, { mode: 'daily' })
      return result
    } finally {
      nativeSending = false
      // The durable message arrives from the journal a beat later; this push is
      // what makes it appear without the renderer polling for it.
      const timer = setTimeout(() => pushNativeSnapshot(), 400)
      timer.unref?.()
    }
  }))
  ipcMain.handle('hns:native-cancel', guard(async (_event, payload) => {
    const runtime = nativeFrontend()
    if (!runtime?.adapter) return { ok: false, reason: 'native_frontend_unavailable' }
    const sessionId = String(payload?.sessionId || runtime.sync?.activeSession?.() || '')
    if (!sessionId) return { ok: false, reason: 'no_session' }
    const result = await runtime.adapter.cancelRun(sessionId)
    pushNativeSnapshot()
    return result
  }))
  ipcMain.handle('hns:native-theme', guard(() => {
    if (!themeEngine) return { ok: false, reason: 'theme_engine_unavailable' }
    return { ok: true, payload: themeEngine.paintPayload() }
  }))
  // Daily top bar actions (Update-Plan/daily-refactorr.md 任务 3). They reuse the
  // dock's single writer instead of inventing a second settings path.
  ipcMain.handle('hns:native-update-settings', guard((_event, patch) => ({
    ok: true,
    settings: applySettingsPatch(patch || {})
  })))
  ipcMain.handle('hns:native-pick-workspace', guard(async () => {
    const root = await pickWorkspaceDirectory(ctx.electron.dialog)
    return { ok: Boolean(root), workspace: root || null }
  }))

  // ---- Mega dock mode surface (任务 12 / 任务 13) ----
  ipcMain.handle('mega:mode-snapshot', guard(() => ({
    ok: true,
    mode: nativeMode(),
    status: nativeFrontend()?.manager?.describe?.() || null,
    compatibility: lastCompatibilityReport
  })))
  ipcMain.handle('mega:mode-set', guard(async (_event, payload) => {
    const mode = String(payload?.mode || payload || '')
    if (!ctx.nativeMode?.switchTo) return { ok: false, reason: 'mode_switch_unavailable' }
    const result = await ctx.nativeMode.switchTo(mode)
    notifyChanged()
    return { ok: result?.ok !== false, mode: nativeMode(), result }
  }))
  ipcMain.handle('mega:mode-toggle', guard(async () => {
    if (!ctx.nativeMode?.toggle) return { ok: false, reason: 'mode_switch_unavailable' }
    const result = await ctx.nativeMode.toggle()
    notifyChanged()
    return { ok: result?.ok !== false, mode: nativeMode(), result }
  }))
  ipcMain.handle('mega:mode-degrade', guard((_event, payload) => {
    if (!ctx.nativeMode?.degrade) return { ok: false, reason: 'mode_switch_unavailable' }
    return ctx.nativeMode.degrade(payload?.reason || 'requested from the dock')
  }))
  ipcMain.handle('mega:mode-compatibility', guard(() => runCompatibilityProbe()))
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
  ipcMain.handle('mega:update-settings', (_event, patch = {}) => applySettingsPatch(patch || {}))
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
  ipcMain.handle('mega:pick-workspace', () => pickWorkspaceDirectory(dialog))
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
  ipcMain.handle('mega:update-check', async () => {
    try {
      await updater.check()
    } catch (error) {
      // A registry failure is reported in the status, never thrown at the dock.
      log(`harness update check failed: ${error?.stack || error}`)
    }
    notifyChanged()
    return updater.describe()
  })
  /**
   * Update = hand off to the detached runner and quit. The shell must stop
   * before npm may replace `app\node_modules`, so the response is returned
   * first and the graceful exit is scheduled a beat later, which also lets the
   * dock paint its "restarting" state.
   */
  ipcMain.handle('mega:update-apply', () => {
    const result = updater.apply()
    if (result.started) scheduleRestart()
    notifyChanged()
    return { ...result, update: updater.describe() }
  })
  ipcMain.handle('mega:dock-toggle', () => toggleDock({ focus: true }))
  ipcMain.handle('mega:dock-expand', (_event, expanded) => setDockExpanded(Boolean(expanded), { focus: Boolean(expanded) }))

  // One engine instance for the whole extension. The renderer paint callback closes
  // over the process-wide dock target, so a second instance would look identical
  // from the IPC side while owning a different active theme — which is exactly how
  // "apply succeeds, the dock never repaints" happened.
  const engine = ensureThemeEngine()
  registerThemeIpc(engine)
  registerSkillIpc()
  registerNativeIpc()
}

/**
 * HNS unified theme system IPC.
 *
 * Every handler answers with plain data and never throws at the renderer: a
 * failing theme operation returns `{ ok: false, reason }` so the dock can render
 * the failure, and the worst case is always "the active theme is Dark".
 */
function registerThemeIpc(engine) {
  const { ipcMain } = ctx.electron
  const orchestrator = engine.orchestrator

  for (const channel of THEME_CHANNELS) ipcMain.removeHandler(channel)

  const guard = (handler) => async (...args) => {
    try {
      return await handler(...args)
    } catch (error) {
      log(`theme ipc failure: ${error?.stack || error}`)
      return {
        ok: false,
        reason: 'theme_error',
        message: String(error?.message || error),
        status: safeThemeStatus(engine)
      }
    }
  }

  ipcMain.handle('mega:theme-snapshot', guard(() => ({
    ok: true,
    status: orchestrator.describe(),
    engine: { themeApiVersion: require('./theme/contract').THEME_API_VERSION }
  })))
  ipcMain.handle('mega:theme-capabilities', guard(() => ({ ok: true, capability: orchestrator.capabilities() })))
  ipcMain.handle('mega:theme-paint', guard(() => ({ ok: true, payload: engine.paintPayload() })))
  ipcMain.handle('mega:theme-create', guard(async (_event, payload = {}) => {
    const result = await orchestrator.createTheme(payload || {})
    // A theme designed without seeing the UI is allowed, but it is never
    // silent: the reason is logged here and returned to the renderer.
    if (result?.ok && result.observation?.degraded) {
      log(`theme observation degraded (${result.observation.reason || 'unknown reason'}); the design used structure only`)
    }
    return result
  }))
  ipcMain.handle('mega:theme-revise', guard((_event, payload = {}) => orchestrator.reviseTheme(payload || {})))
  ipcMain.handle('mega:theme-validate', guard((_event, payload = {}) => ({ ok: true, ...orchestrator.validate(payload || {}) })))
  ipcMain.handle('mega:theme-approve', guard((_event, payload = {}) => orchestrator.approve(payload || {})))
  ipcMain.handle('mega:theme-discard', guard((_event, payload = {}) => orchestrator.discard(payload || {})))
  ipcMain.handle('mega:theme-apply', guard((_event, payload = {}) => {
    const id = typeof payload === 'string' ? payload : payload?.id
    return orchestrator.applyTheme(id)
  }))
  ipcMain.handle('mega:theme-delete', guard((_event, payload = {}) => {
    const id = typeof payload === 'string' ? payload : payload?.id
    return orchestrator.deleteTheme(id)
  }))
  ipcMain.handle('mega:theme-duplicate', guard((_event, payload = {}) => {
    const id = typeof payload === 'string' ? payload : payload?.id
    return orchestrator.duplicateTheme(id, payload && typeof payload === 'object' ? { name: payload.name } : undefined)
  }))
  ipcMain.handle('mega:theme-restore', guard((_event, payload = {}) => {
    const id = typeof payload === 'string' ? payload : payload?.id
    return orchestrator.restoreBuiltin(id)
  }))
  ipcMain.handle('mega:theme-import', guard(async () => {
    const result = await ctx.electron.dialog.showOpenDialog(ctx.mainWindow, {
      title: '导入 HNS 主题包目录',
      properties: ['openDirectory']
    })
    if (result.canceled || !result.filePaths.length) return { ok: false, reason: 'cancelled' }
    return orchestrator.importTheme(result.filePaths[0])
  }))
  ipcMain.handle('mega:theme-observe', guard(async (_event, payload = {}) => {
    const observed = await orchestrator.observe({ pages: payload?.pages || null })
    if (observed.degraded) {
      log(`UI observation degraded (${observed.reason || 'unknown reason'})`)
    }
    return {
      ok: true,
      capability: observed.manifest,
      snapshot: observed.snapshot,
      dir: observed.snapshotDir,
      // The renderer must be able to show "structure only" instead of implying a
      // full visual observation.
      visual: observed.visual,
      degraded: observed.degraded,
      reason: observed.reason || null,
      observedSlots: observed.observedSlots
    }
  }))
  ipcMain.handle('mega:theme-artifacts', guard(() => ({
    ok: true,
    artifacts: engine.snapshotArtifacts ? engine.snapshotArtifacts() : null,
    // Optional AI designer: reported so the UI can explain that it is off.
    model: engine.modelAdapter ? engine.modelAdapter.describe() : { enabled: false, available: false }
  })))
  /**
   * The four-surface state (Update-Plan 任务 1 / 任务 2 / 任务 3).
   *
   * Answers the two questions acceptance has to be able to ask with evidence:
   * "which surfaces exist and what may each be written with?" and "is the official
   * overlay actually on screen, and is the protected renderer untouched?" The
   * `protected` block is read from the shell, not computed here.
   */
  ipcMain.handle('mega:theme-surfaces', guard(() => {
    const surfaceModule = require('./theme/surface')
    const surfaces = surfaceModule.describe()
    const overlayState = officialSurfaceTarget.describe()
    const plans = engine.plans ? engine.plans() : null
    return {
      ok: true,
      surfaces,
      protected: overlayState.protected || {
        id: 'official_renderer',
        writable: false,
        painted: false,
        injection_apis_used: []
      },
      overlay: overlayState.available === false
        ? { available: false, reason: overlayState.reason }
        : {
            available: true,
            enabled: plans ? plans.overlay?.enabled !== false : false,
            visual_only: true,
            built: (overlayState.surfaces || []).some((surface) => surface.id === 'official_overlay' && surface.created),
            ready: (overlayState.surfaces || []).some((surface) => surface.id === 'official_overlay' && surface.ready),
            bounds: (overlayState.surfaces || []).find((surface) => surface.id === 'official_overlay')?.bounds || null,
            input: { pointer: 'passthrough', keyboard: 'passthrough', focus: 'none', scroll: 'passthrough' },
            degradation: overlayState.degradation || [],
            safety: plans?.overlay?.safety || null,
            layout: plans?.layout || null
          },
      shell: overlayState.available === false
        ? { available: false, reason: overlayState.reason }
        : {
            available: true,
            built: (overlayState.surfaces || []).some((surface) => surface.id === 'official_shell' && surface.created),
            ready: (overlayState.surfaces || []).some((surface) => surface.id === 'official_shell' && surface.ready),
            bounds: (overlayState.surfaces || []).find((surface) => surface.id === 'official_shell')?.bounds || null
          },
      official_bounds: overlayState.officialBounds || null,
      plans
    }
  }))
  ipcMain.handle('mega:theme-detail', guard((_event, payload = {}) => {
    const id = typeof payload === 'string' ? payload : payload?.id
    const inspected = engine.lifecycle.inspectTheme(id)
    if (!inspected.ok) return inspected
    return {
      ok: true,
      record: inspected.record,
      manifest: inspected.theme.manifest,
      persona: inspected.theme.persona,
      tokens: inspected.theme.declaredTokens,
      slotCount: Object.keys(inspected.theme.components.slots || {}).length,
      slots: inspected.theme.components.slots,
      animation: inspected.theme.components.animation
    }
  }))
}

function safeThemeStatus(engine) {
  try {
    return engine.describe()
  } catch {
    return null
  }
}

/**
 * HNS skills management IPC.
 *
 * The dock never touches the skill directory: every read and every mutation goes
 * through the service, which owns validation, the staging-first install and the
 * confinement of deletion to the skill root. Handlers answer with plain data and
 * never throw at the renderer, because a failed skill operation must leave the
 * dock usable.
 */
function registerSkillIpc() {
  const { ipcMain, dialog } = ctx.electron
  const service = ensureSkillService()

  for (const channel of SKILL_CHANNELS) ipcMain.removeHandler(channel)

  const guard = (handler) => async (...args) => {
    try {
      return await handler(...args)
    } catch (error) {
      log(`skills ipc failure: ${error?.stack || error}`)
      return { ok: false, reason: 'skills_error', message: String(error?.message || error) }
    }
  }

  const notify = () => notifySkillsChanged()

  ipcMain.handle('mega:skills-snapshot', guard(() => ({ ok: true, ...service.snapshot() })))
  ipcMain.handle('mega:skills-tags', guard(() => ({ ok: true, tags: service.tags() })))
  ipcMain.handle('mega:skills-detail', guard((_event, payload = {}) => {
    const name = typeof payload === 'string' ? payload : payload?.name
    return service.detail(String(name || ''))
  }))
  ipcMain.handle('mega:skills-search', guard((_event, payload = {}) => service.search(payload?.query || '', {
    includeLive: Boolean(payload?.includeLive),
    tags: Array.isArray(payload?.tags) ? payload.tags : []
  })))

  /**
   * Install from a pasted source: a GitHub URL, `owner/repo`, a local path, or a
   * bundled catalog id. The service decides which, so the UI has one entry point.
   */
  ipcMain.handle('mega:skills-install-source', guard(async (_event, payload = {}) => {
    const source = String(payload?.source || '').trim()
    if (!source) return { ok: false, reason: 'source_required', installed: [], skipped: [] }
    const conflict = payload?.conflict === 'overwrite' || payload?.conflict === 'skip' ? payload.conflict : 'rename'
    const prefix = typeof payload?.prefix === 'string' ? payload.prefix : undefined

    // An existing local path is unambiguous: installing it needs no network.
    if (looksLikeLocalPath(source)) {
      const result = service.installLocal(source, { conflict, prefix: prefix ?? null })
      notify()
      return result
    }
    const bundled = service.catalog.get(source)
    if (bundled && bundled.origin === 'bundled') {
      const result = service.installBundled(source, { conflict })
      notify()
      return result
    }
    const result = await service.installRemote(source, { conflict, prefix })
    notify()
    return result
  }))

  ipcMain.handle('mega:skills-install-catalog', guard(async (_event, payload = {}) => {
    const id = String(payload?.id || '')
    if (!id) return { ok: false, reason: 'id_required', installed: [], skipped: [] }
    const conflict = payload?.conflict === 'overwrite' || payload?.conflict === 'skip' ? payload.conflict : 'rename'
    const only = typeof payload?.only === 'string' && payload.only ? payload.only : null
    const result = await service.installCatalogEntry(id, { conflict, only })
    notify()
    return result
  }))

  ipcMain.handle('mega:skills-pick-local', guard(async () => {
    const result = await dialog.showOpenDialog(ctx.mainWindow, {
      title: '选择技能目录或 SKILL.md',
      properties: ['openDirectory', 'openFile'],
      filters: [{ name: 'Skill', extensions: ['md'] }]
    })
    if (result.canceled || !result.filePaths.length) return { ok: false, reason: 'cancelled', canceled: true }
    const target = result.filePaths[0]
    const installed = service.installLocal(target, { conflict: 'rename' })
    notify()
    return { ok: installed.ok, canceled: false, path: target, result: installed, reason: installed.reason }
  }))

  ipcMain.handle('mega:skills-remove', guard((_event, payload = {}) => {
    const name = typeof payload === 'string' ? payload : payload?.name
    const result = service.deleteSkill(String(name || ''))
    notify()
    return result
  }))
  ipcMain.handle('mega:skills-remove-many', guard((_event, payload = {}) => {
    const names = Array.isArray(payload) ? payload : Array.isArray(payload?.names) ? payload.names : []
    const result = service.deleteSkills(names)
    notify()
    return result
  }))
  ipcMain.handle('mega:skills-remove-collection', guard((_event, payload = {}) => {
    const collection = typeof payload === 'string' ? payload : payload?.collection
    const result = service.deleteCollection(String(collection || ''))
    notify()
    return result
  }))
  ipcMain.handle('mega:skills-set-invocation', guard((_event, payload = {}) => {
    const name = String(payload?.name || '')
    const result = service.setInvocation(name, {
      modelInvocable: typeof payload?.modelInvocable === 'boolean' ? payload.modelInvocable : undefined,
      userInvocable: typeof payload?.userInvocable === 'boolean' ? payload.userInvocable : undefined
    })
    notify()
    return result
  }))
}

/** Does this source look like a filesystem path rather than a repo reference? */
function looksLikeLocalPath(value) {
  const text = String(value || '')
  if (/^[a-zA-Z]:[\\/]/.test(text)) return true
  if (text.startsWith('\\\\') || text.startsWith('/')) return true
  if (text.startsWith('.\\') || text.startsWith('./') || text.startsWith('..')) return true
  return fs.existsSync(text)
}

function ensureSkillService() {
  if (skillService) return skillService
  skillService = createSkillService({ log: (message) => log(`skills: ${message}`) })
  return skillService
}

function notifySkillsChanged() {
  dockTarget.send(SKILL_EVENT_CHANNEL)
}

async function start(context) {
  if (started) return
  started = true
  ctx = context
  if (ctx.nodeExe) process.env.DSH_NODE = ctx.nodeExe
  updater = new HarnessUpdater({
    root: PATHS.ROOT,
    appDir: PATHS.APP,
    nodeExe: ctx.nodeExe || process.env.DSH_NODE || '',
    stateDir: PATHS.STATE,
    log: (message) => log(`updater: ${message}`)
  })
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
  // Theme system starts last: it must never be able to delay the official UI,
  // the scheduler or the dock. A failure here is logged and the product runs on
  // the Dark recovery theme.
  try {
    const engine = ensureThemeEngine()
    ctx.electron.ipcMain.on('mega-theme:regions', onThemeRegions)
    // Native slot geometry arrives through the shell's relay; the theme engine
    // observes the surface that is actually on screen (任务 14).
    if (typeof ctx.onNativeRegions === 'function') {
      unsubscribeNativeRegions = ctx.onNativeRegions((payload) => {
        nativeRegionCache = payload && typeof payload === 'object' ? payload : {}
      })
    }
    engine.start()
    pushThemePaint(engine)
  } catch (error) {
    log(`theme system unavailable, continuing with the built-in Dark palette: ${error?.stack || error}`)
  }
  // The integrated dock view is created *after* extensions start, so the first
  // paint above has nowhere to go. The shell calls `onDockReady` once its
  // renderer has loaded; that is when the active theme is actually delivered.
  registerDockReadyHook()
  // Mode changes are a first-class event for this extension: the theme engine
  // must repaint the surface that just became visible, and the dock must keep
  // its switch honest.
  try {
    ctx.nativeMode?.onModeChange?.((status) => {
      if (typeof status === 'object' && status) modeStatusCache = status
      try {
        pushThemePaint()
      } catch (error) {
        log(`theme repaint after a mode change failed: ${error?.message || error}`)
      }
      pushNativeSnapshot()
    })
  } catch (error) {
    log(`mode change subscription failed: ${error?.message || error}`)
  }
  // The dock can be asked to start expanded (`--mega-dock`, or the environment
  // form used by tooling that only controls the child's environment).
  if (process.argv.includes('--mega-dock') || process.env.DSH_MEGA_DOCK_EXPANDED === '1') {
    setDockExpanded(true, { focus: false })
  }
  // Optional Sub-worker: bound last, after the official UI, the dock and the
  // theme system are up, so an unavailable or failing worker can never delay
  // them (plan §22 fault isolation).
  bindSubWorker()
  log('ready; single-window Mega dock + ordered queue + hardware-adaptive concurrency + unified theme system enabled')
  if (subWorkerAvailable()) log(`optional Sub-worker available (state ${subWorkerSnapshot().state})`)
}

/**
 * Deliver the active theme to the dock renderer.
 *
 * A missing target is normal during boot (the shell has not created the view
 * yet), so it is not logged as an error; the ready hook below closes that gap.
 */
function pushThemePaint(engine = themeEngine) {
  if (!engine) return false
  let paint = null
  try {
    paint = engine.paintPayload()
  } catch (error) {
    log(`theme payload unavailable: ${error?.message || error}`)
    return false
  }
  if (!dockTarget.hasTarget()) return false
  if (!dockTarget.send('mega:theme-apply', paint)) {
    log('theme repaint could not reach the dock: push failed')
    return false
  }
  return true
}

/**
 * The shell's dock-ready notification (`ctx.onDockReady`). Registering here —
 * and not at module scope — keeps the extension free of start-order side effects
 * and lets `stop()` drop the handler it added.
 */
function registerDockReadyHook() {
  const hook = ctx?.onDockReady
  if (typeof hook !== 'function') return false
  const handler = () => {
    try {
      pushThemePaint()
      notifyChanged()
    } catch (error) {
      log(`dock ready handling failed: ${error?.message || error}`)
    }
  }
  try {
    hook(handler)
    dockReadyHandler = handler
    return true
  } catch (error) {
    log(`dock ready hook unavailable: ${error?.message || error}`)
    dockReadyHandler = null
    return false
  }
}

/**
 * Data the shell's Dual-UI runtime reads back from this extension
 * (Update-Plan/Dual-UI.md 任务 9).
 *
 * The scheduler, the settings service and the updater are owned here, so the
 * adapter asks the extension for them instead of the shell reaching into
 * extension modules. Every read is failure isolated: a broken service yields an
 * empty answer, which the adapter reports as a degraded contract.
 */
function describeNativeData() {
  let tasks = []
  let settings = null
  let harnessVersion = null
  let latestVersion = null
  try {
    tasks = scheduler.listTasks({ limit: 200 })
  } catch (error) {
    log(`native task read failed: ${error?.message || error}`)
  }
  try {
    settings = settingsService.publicSettings()
  } catch (error) {
    log(`native settings read failed: ${error?.message || error}`)
  }
  try {
    harnessVersion = updater?.describe?.().currentVersion || null
    latestVersion = updater?.describe?.().latestVersion || null
  } catch (error) {
    log(`native version read failed: ${error?.message || error}`)
  }
  return { tasks, settings, harnessVersion, latestVersion }
}

function stop() {
  if (!started) return
  started = false
  if (restartTimer) {
    clearTimeout(restartTimer)
    restartTimer = null
  }
  // Stop the theme runtime first: it owns the only timer in this extension and
  // must not repaint a renderer that is about to be destroyed.
  try { themeEngine?.stop?.() } catch {}
  themeEngine = null
  skillService = null
  themeRegionCache = {}
  themeTreeCache = null
  try { ctx?.electron?.ipcMain?.removeListener('mega-theme:regions', onThemeRegions) } catch {}
  try { terminalObserver.stop() } catch {}
  try { scheduler.stop() } catch {}
  try { unsubscribeSubWorker?.() } catch {}
  unsubscribeSubWorker = null
  try { unsubscribeNativeRegions?.() } catch {}
  unsubscribeNativeRegions = null
  if (nativeSnapshotTimer) {
    clearTimeout(nativeSnapshotTimer)
    nativeSnapshotTimer = null
  }
  nativeRegionCache = {}
  modeStatusCache = null
  lastCompatibilityReport = null
  if (subWorkerRefreshTimer) {
    clearTimeout(subWorkerRefreshTimer)
    subWorkerRefreshTimer = null
  }
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
  dockReadyHandler = null
  if (dockWindow && !dockWindow.isDestroyed()) dockWindow.destroy()
  if (playerWindow && !playerWindow.isDestroyed()) playerWindow.destroy()
  tray = null
  dockWindow = null
  playerWindow = null
  shortcutHandler = null
  ctx = null
}

module.exports = { start, stop, toggleDock, setDockExpanded, requestShutdown, openSubWorkerLiveView, describeNativeData }
