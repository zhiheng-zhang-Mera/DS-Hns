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
// The dock's rectangle, including the band it yields to the official UI. Shared with the shell so
// the legacy window and the integrated view cannot disagree about where the dock starts.
const { dockBounds, dockTopInset } = require('./dock/geometry.cjs')
const { createBundledPlugins } = require('./plugins/index.cjs')
const { createMegaItems } = require('./mega-items.cjs')
// The two backdrop surfaces a wallpaper can be set for (`main` = the main screen, `dock` = Mega).
// The module itself is built lazily; this list is needed by the file chooser's scope.
const { WALLPAPER_SURFACES } = require('./wallpaper.cjs')
// The store's GitHub settings are validated by the same helpers the channel builds its requests
// with, so a value the shell accepts is a value the store can use.
const {
  resolveGithubSettings,
  checkTopic,
  checkBase,
  PLUGIN_TOPIC,
  DEFAULT_API_BASE,
  DEFAULT_RAW_BASE,
  DEFAULT_CLONE_BASE,
  SETTING_LIMITS
} = require('./store/github-store.cjs')
const { MEGA_FEATURES, FEATURE_GROUPS, featureFor, featureForChannel, createFeatureState } = require('./features.cjs')

/**
 * A bilingual title for an OS window or file dialog.
 *
 * The rendered surfaces get `bilingual.js`, which draws the Chinese large and the English
 * small in one colour. A window manager owns the font of a window or dialog title, so the
 * only part of that rule which can be honoured here is "both languages, Chinese first".
 */
function bilingualTitle(cn, en) {
  const left = String(cn === undefined || cn === null ? '' : cn).trim()
  const right = String(en === undefined || en === null ? '' : en).trim()
  if (!left) return right
  if (!right) return left
  return `${left} · ${right}`
}

const CHANNELS = [
  'mega:snapshot', 'mega:add-task', 'mega:reorder-task', 'mega:cancel-task', 'mega:clear-pending',
  'mega:remove-tasks', 'mega:update-scheduler', 'mega:refresh-hardware', 'mega:update-settings',
  'mega:balance', 'mega:pick-workspace', 'mega:pick-sound',
  'mega:update-check', 'mega:update-apply',
  'mega:dock-toggle', 'mega:dock-expand',
  // The compatibility report the dock's status panel shows. It used to be answered
  // through the mode surface, because the answer depended on which frontend was active.
  'mega:compatibility',
  // The plugin store channel: search GitHub, and ask whether a result is a plugin.
  'mega:store-describe', 'mega:store-search', 'mega:store-inspect',
  // The two-stage install: stage (code on disk, verified) and enable (the host may run it),
  // plus the installed list, the history and the one-by-one queue.
  'mega:store-installed', 'mega:store-stage', 'mega:store-enable', 'mega:store-disable',
  'mega:store-remove', 'mega:store-reinstall', 'mega:store-queue',
  // Compatibility mode: whether a repository without a native manifest may be adopted.
  'mega:store-compat', 'mega:store-compat-set',
  // The GitHub settings the store talks through: the token, the plugin topic and the three
  // addresses a mirror or an enterprise install replaces.
  'mega:store-github', 'mega:store-github-set',
  // The feature manager: which of the dock's features are switched on.
  'mega:features-snapshot', 'mega:features-set',
  // The frosted-glass layer: the switch that makes every DS-Hns surface translucent, and the
  // numbers that describe how strong it is (the official UI has no part in it).
  'mega:ui-glass', 'mega:ui-glass-set',
  // The wallpaper layer: what the dock and (later) the official surfaces draw behind everything.
  'mega:wallpaper', 'mega:wallpaper-set', 'mega:wallpaper-pick', 'mega:wallpaper-layer',
  // The bundled community plugins: what the release pinned, what is installed, and repair.
  'mega:bundled-plugins', 'mega:bundled-plugins-repair',
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
  /**
   * The user's wallpaper, on the two surfaces the adapter owns.
   *
   * It travels through the same adapter as the theme and for the same reason: this extension never
   * holds the official `webContents`, so there is no path from here into the official UI. The
   * adapter writes it as its own stylesheet, so a theme repaint cannot take it away.
   */
  wallpaper: (css) => {
    const adapter = ctx?.officialSurfaceAdapter
    if (!adapter || typeof adapter.wallpaper !== 'function') return { ok: false, reason: 'no_surface_target' }
    return adapter.wallpaper(css)
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
 * The official frontend runtime the shell hands over.
 *
 * The shell owns the renderer and the Harness bridge; the extension owns the theme engine,
 * the domain model adapter and the scheduler. This is the whole interface between them —
 * there used to be three accessors here, and the other two existed only to ask the native
 * renderer which mode it was in and to push a theme payload at it. Daily is gone.
 */
function officialFrontend() {
  return ctx?.officialFrontend || null
}

/**
 * Live slot geometry for theme observation.
 *
 * There is none, and that is the point: the dock was the surface the engine measured, and the
 * dock is not a theme surface any more — it is frosted glass, and the Appearance panel drives the
 * glass layer rather than a theme. The engine is told so with an empty answer instead of being
 * left to probe a renderer that no longer listens (the probe used to time out after 1.5 s on
 * every observation, which cost a design real time to learn nothing). The observation records the
 * absence, so a plan built without measured regions still says it was built without them.
 */
async function observedRegions() {
  return {}
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
  const payload = {
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
     * The frontend the dock is drawn beside.
     *
     * This used to report a *mode* — which of two renderers was on screen, whether it had
     * degraded, and which session each side remembered. There is one frontend now, so the
     * honest report is one line, and the dock has no switch to keep honest.
     */
    frontend: (() => {
      try {
        return { kind: 'official', available: Boolean(officialFrontend()), modes: [] }
      } catch (error) {
        log(`frontend snapshot failed: ${error?.message || error}`)
        return { kind: 'official', available: false, modes: [] }
      }
    })(),
    /**
     * Which features are switched on.
     *
     * The dock hides a disabled feature's panels and marked controls from this map, and the
     * preload refuses its channels — so "off" is one fact with two consequences rather than
     * a hidden div.
     */
    features: (() => {
      try {
        return features().enabledMap()
      } catch (error) {
        log(`feature snapshot failed: ${error?.message || error}`)
        return {}
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
  /**
   * The collapsed rail, derived from everything above (`updateplan/startup2.md` §41-§44).
   *
   * It is computed here, from the same payload the dock is about to receive, so the rail cannot
   * disagree with the panels: whatever a module registered is asked for its current answer, the zeros
   * stay out (§36/§43) and the budget decides what fits (§44).
   */
  payload.megaItems = megaItems().render(payload)
  return payload
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
 * IPC calls, but a *push* (a change notification) needs a target, and the
 * integrated dock is the target the product actually ships.
 */
function notifyChanged() {
  dockTarget.send('mega:changed')
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
    /**
     * The dock is not a theme surface any more.
     *
     * It used to be the engine's `hns_native` target: the active theme's tokens, slot styles and
     * persona layers were pushed here on every repaint, and a skin laid over a translucent pane
     * is precisely what made the frosted glass read as an ordinary coloured panel. The dock is
     * glass and only glass now — `dock.css` is its palette and the Appearance panel drives the
     * glass layer — so the payload is *not* sent, and the engine is told so rather than being
     * left to push at a window that no longer listens.
     */
    applyToRenderer: () => false,
    // Nothing in the dock renders a theme any more, so a change to the theme list has no
    // surface to refresh. The engine is told so rather than pushing at a window that would
    // ignore it.
    onChanged: () => {},
    capture: (pageIds) => captureDockPages(pageIds),
    // The dock reports no slot geometry, because nothing themes it any more. The observation
    // records the absence rather than silently planning against regions it never measured.
    dockRegions: () => observedRegions(),
    componentTree: () => null,
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
  // The top band belongs to the official UI here too (see `dock/geometry.cjs`): the rail and the
  // panel are one window, so they move together.
  const bounds = dockBounds({ x, width, height, inset: dockTopInset() })
  dockWindow.setBounds({ ...bounds, y: y + bounds.y, height: Math.max(160, bounds.height) }, false)
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

/**
 * What makes the dock window a pane rather than a box.
 *
 * Three facts decide this, and each is deliberate:
 *
 *   * **`transparent`** — the document's own base is translucent (see the glass block in
 *     `dock.css`), so the window has to be too. Without it the pane composites over the window's
 *     flat background and the glass is invisible, which is exactly the defect this fixes.
 *   * **`backgroundColor: '#00000000'`** — a fully transparent window still paints its own
 *     background colour, and `#11161d` was opaque.
 *   * **`backgroundMaterial: 'acrylic'`** — the OS frost: the compositor blurs whatever is behind
 *     the window, which is the only blur that can reach the desktop. It is Windows 11 only, so it
 *     is applied where `process.platform` says it might exist and Electron ignores it elsewhere;
 *     the stylesheet's `@supports not (backdrop-filter)` fallback covers a platform without it.
 *
 * It is a function so the options are one testable object rather than three literals inside a
 * constructor call, and so nothing else in this file has to know the dock is glass.
 */
function dockGlassBackground() {
  const options = { transparent: true, backgroundColor: '#00000000' }
  if (process.platform === 'win32') options.backgroundMaterial = 'acrylic'
  return options
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
    title: bilingualTitle('Mega 控制台', 'Mega Dock'),
    // The dock is a pane of frosted glass, and a pane needs something behind it. An opaque
    // window background is what kept the layer invisible: every translucent panel was composited
    // over this one flat colour, so the blur had nothing to bite on and the dock read as an
    // ordinary dark panel. A transparent window lets the desktop through, and `acrylic` (Windows
    // 11) is the compositor's own frost over it. Where the material is unsupported the window is
    // simply transparent, and the stylesheet's higher-alpha fallback keeps the text legible.
    ...dockGlassBackground(),
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
    { label: bilingualTitle('显示主窗口', 'Show'), click: () => focusMain() },
    { label: bilingualTitle('Mega 控制台', 'Mega'), click: () => openMegaDock() },
    // The tray is the second entry point to the one manager, as the product rule requires:
    // it reveals the same float the dock's own button opens, inside the same window.
    { label: bilingualTitle('插件管理', 'Plugin manager'), click: () => openPluginManager() },
    { type: 'separator' },
    subWorkerTrayItem(),
    { type: 'separator' },
    { label: bilingualTitle('退出 DS-Harness', 'Exit DS-Harness'), click: () => requestShutdown('graceful') },
    { label: bilingualTitle('强制退出 DS-Harness', 'Force Exit DS-Harness'), click: () => requestShutdown('force') }
  ]))
}

/**
 * Open the plugin manager float.
 *
 * It is not a window: the tray shows the product window, expands the dock and asks the dock
 * renderer to reveal its overlay. A failure to reach the dock is reported rather than
 * silently doing nothing, because the user asked for something.
 */
function openPluginManager() {
  try {
    openMegaDock()
    if (!dockTarget.send('mega:open-plugin-manager')) {
      log('the plugin manager could not reach the dock: no dock target')
      return { ok: false, reason: 'no dock target' }
    }
    return { ok: true }
  } catch (error) {
    log(`open plugin manager failed: ${error?.message || error}`)
    return { ok: false, reason: String(error?.message || error) }
  }
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

/**
 * The compatibility report, on demand.
 *
 * The dock's status panel asks whether this DSH build is the one the product knows how to
 * drive. The question used to be asked per frontend, through the mode surface; with one
 * frontend there is one answer, and asking is all the panel has to do.
 */
function registerCompatibilityIpc() {
  const { ipcMain } = ctx.electron
  try {
    ipcMain.removeHandler('mega:compatibility')
  } catch {}
  ipcMain.handle('mega:compatibility', async () => {
    try {
      return await runCompatibilityProbe()
    } catch (error) {
      log(`compatibility probe failed: ${error?.stack || error}`)
      return { ok: false, reason: String(error?.message || error) }
    }
  })
  log('mega compatibility IPC registered (1 channel)')
}

/** The workspace picker, shared by the dock and the Daily top bar. */
async function pickWorkspaceDirectory(dialog) {
  const result = await dialog.showOpenDialog(ctx.mainWindow, {
    title: bilingualTitle('选择 headless 队列工作区', 'Choose the headless queue workspace'),
    properties: ['openDirectory', 'createDirectory']
  })
  if (result.canceled || !result.filePaths.length) return null
  return workspace.setWorkspaceRoot(result.filePaths[0])
}

/**
 * Run the DSH compatibility probe.
 *
 * `surface` is fixed at the official renderer: it used to name which of the two frontends
 * the question was about, and there is only one now.
 */
async function runCompatibilityProbe({ to = null } = {}) {
  const runtime = officialFrontend()
  if (!runtime?.probe) return null
  try {
    const report = await runtime.probe.run({ to, surface: 'official' })
    lastCompatibilityReport = report
    return report
  } catch (error) {
    log(`compatibility probe failed: ${error?.message || error}`)
    return null
  }
}

/**
 * The feature registry's durable state.
 *
 * Created lazily so a unit test can require this file without touching `data/`, and so the
 * first read happens when a channel or the snapshot actually needs it.
 */
let featureState = null
function features() {
  if (featureState) return featureState
  featureState = createFeatureState({
    file: path.join(PATHS.ROOT, 'data', 'state', 'mega-features.json'),
    defaults: (ctx.config && ctx.config.mega && ctx.config.mega.features) || {},
    log: (message) => log(`features: ${message}`)
  })
  return featureState
}

/** Is the feature that owns this channel switched on? */
function featureAllows(channel) {
  const feature = featureForChannel(channel)
  if (!feature) return { ok: true, feature: null }
  if (features().isEnabled(feature.id)) return { ok: true, feature }
  return { ok: false, feature, reason: `the ${feature.id} feature is switched off`, code: 'FEATURE_DISABLED' }
}

/**
 * Wrap `ipcMain.handle` so every channel registered after this point is gated.
 *
 * The gate is installed once, at extension start, and it is deliberately at this level
 * rather than inside each handler: a feature's `channels` declaration is the single source of
 * truth for what it answers, and a registration that forgot to check would be a switch that
 * changes a panel but not the behaviour behind it.
 */
function installFeatureGate() {
  const { ipcMain } = ctx.electron
  if (ipcMain.__megaFeatureGate) return ipcMain.__megaFeatureGate
  const original = ipcMain.handle.bind(ipcMain)
  const gate = (channel, handler) => original(channel, async (...args) => {
    const allowed = featureAllows(channel)
    if (!allowed.ok) return { ok: false, reason: allowed.reason, code: allowed.code, feature: allowed.feature.id }
    return handler(...args)
  })
  ipcMain.handle = gate
  ipcMain.__megaFeatureGate = gate
  return gate
}

/** Push the feature map to the dock: the preload gates on it, the panel draws it. */
function pushFeatureState() {
  const map = features().enabledMap()
  try {
    dockTarget.send('mega:features', { ok: true, features: map, described: features().describe() })
  } catch (error) {
    log(`feature state push failed: ${error?.message || error}`)
  }
  notifyChanged()
}

/** The feature manager's own channels. Not gated: switching features off is how you fix one. */
function registerFeatureIpc() {
  const { ipcMain } = ctx.electron
  const guard = (handler) => async (...args) => {
    try {
      return await handler(...args)
    } catch (error) {
      log(`feature ipc failure: ${error?.stack || error}`)
      return { ok: false, reason: 'feature_ipc_failed', message: String(error?.message || error) }
    }
  }
  ipcMain.handle('mega:features-snapshot', guard(() => ({
    ok: true,
    features: features().describe(),
    groups: FEATURE_GROUPS,
    issues: features().issues()
  })))
  ipcMain.handle('mega:features-set', guard((_event, payload = {}) => {
    const result = features().setEnabled(payload.id, payload.enabled !== false)
    if (result.ok) {
      applyFeatureVisibility(result.id)
      pushFeatureState()
    }
    return result
  }))
}

/**
 * Act on a feature being switched off.
 *
 * Hiding the panel is the dock's job; this is the part the extension owns: a feature that
 * does periodic work must stop doing it, not merely stop showing it.
 */
function applyFeatureVisibility(id) {
  const feature = featureFor(id)
  if (!feature) return { ok: false, reason: `no feature ${id}` }
  const enabled = features().isEnabled(id)
  if (enabled) return { ok: true, id, enabled }
  if (id === 'mega.computer-use') {
    // The runtime belongs to the shell; the dock asks it to stop through the same channel
    // the panel's cancel button uses, and a refusal is reported rather than hidden.
    try {
      ctx.electron.ipcMain.emit('mega:feature-stopped', { id })
    } catch {}
  }
  return { ok: true, id, enabled }
}

/**
 * The store's own state: the compatibility decision, and the GitHub settings it talks through.
 *
 * It lives beside the other user state (`data/state/plugin-store.json`) for the same reason the
 * glass preference does — these are choices, not deployment configuration. The file is read on
 * every use rather than cached, which is what makes a saved setting take effect on the next
 * request instead of on the next restart.
 */
function storeStateFile() {
  return path.join(PATHS.ROOT, 'data', 'state', 'plugin-store.json')
}

/** The file as it is on disk. A malformed file is a preference that failed to persist, not a crash. */
function readStoreState() {
  try {
    const raw = JSON.parse(fs.readFileSync(storeStateFile(), 'utf8'))
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

function writeStoreState(next, label) {
  const file = storeStateFile()
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: `${label} could not be written: ${error?.message || error}` }
  }
}

/**
 * The store's own preference: may a repository without a native manifest be adopted?
 *
 * It defaults to on, because the alternative is a store that silently offers less than it can do.
 * Turning it off is a real choice too: with it off, only repositories that declare
 * `dshns.plugin/v1` are staged.
 */
function storePreference() {
  const raw = readStoreState()
  if (typeof raw.compat === 'boolean') return { compat: raw.compat, source: 'user' }
  return { compat: true, source: 'default' }
}

function setStorePreference(patch = {}) {
  const stored = readStoreState()
  const compat = typeof patch.compat === 'boolean' ? patch.compat : storePreference().compat
  const written = writeStoreState({ ...stored, compat }, 'the store preference')
  if (!written.ok) return written
  log(`store compatibility mode ${compat ? 'on' : 'off'}`)
  return { ok: true, compat, source: 'user' }
}

/**
 * The GitHub settings in force.
 *
 * The store is not created with a snapshot of these: it is handed `config`, which calls this on
 * every request. That is the whole point — a token typed into the panel, a topic a company uses
 * instead of the default, or an enterprise API base all take effect on the next search.
 */
function storeGithubSettings() {
  const raw = readStoreState().github
  return resolveGithubSettings(raw && typeof raw === 'object' ? raw : {})
}

/**
 * What the panel is allowed to know about them.
 *
 * The token is never returned, in any form: the panel gets its tail and where it came from, which
 * is enough to answer "is my token being used?" — the only question this surface has to answer.
 */
function describeStoreGithub() {
  const state = storeGithubSettings()
  return {
    ok: true,
    topic: state.topic,
    authenticated: Boolean(state.token),
    tokenSource: state.tokenSource,
    tokenMask: state.tokenMask,
    apiBase: state.apiBase,
    rawBase: state.rawBase,
    cloneBase: state.cloneBase,
    refused: state.refused,
    defaults: {
      topic: PLUGIN_TOPIC,
      apiBase: DEFAULT_API_BASE,
      rawBase: DEFAULT_RAW_BASE,
      cloneBase: DEFAULT_CLONE_BASE
    }
  }
}

/**
 * Save them.
 *
 * Every value is checked here rather than at the point of use, because a store that accepts a
 * setting it will ignore is worse than one that refuses it: the user would believe a token was in
 * force while the rate limit kept refusing searches. A refused value is not stored and is
 * reported, so the panel can say which field was wrong and why.
 */
function setStoreGithub(patch = {}) {
  const state = readStoreState()
  const stored = { ...(state.github && typeof state.github === 'object' ? state.github : {}) }
  const refused = []
  if (patch.token !== undefined) {
    const token = String(patch.token === null || patch.token === undefined ? '' : patch.token).trim()
    if (token.length > SETTING_LIMITS.token.max) refused.push(`a token is at most ${SETTING_LIMITS.token.max} characters`)
    else stored.token = token
  }
  if (patch.topic !== undefined) {
    const checked = checkTopic(patch.topic)
    if (checked.ok) stored.topic = String(patch.topic === null || patch.topic === undefined ? '' : patch.topic).trim()
    else refused.push(checked.reason)
  }
  for (const [key, label] of [['apiBase', 'the API base URL'], ['rawBase', 'the raw content base URL'], ['cloneBase', 'the clone base URL']]) {
    if (patch[key] === undefined) continue
    const checked = checkBase(patch[key], label)
    if (checked.ok) stored[key] = String(patch[key] === null || patch[key] === undefined ? '' : patch[key]).trim()
    else refused.push(checked.reason)
  }
  if (refused.length) {
    log(`store GitHub settings refused: ${refused.join('; ')}`)
    return { ...describeStoreGithub(), ok: false, refused }
  }
  const written = writeStoreState({ ...state, github: stored }, 'the store settings')
  if (!written.ok) return written
  // A resolved default branch belongs to the host that answered it, and a saved setting can move
  // which host that is (a token does not, a base URL does). Dropping the cache costs one request
  // on the next probe; keeping it would address the new host with a fact learned from the old one.
  if (pluginStore) pluginStore.forget()
  const described = describeStoreGithub()
  log(`store GitHub settings saved (topic ${described.topic}, token ${described.tokenSource}, api ${described.apiBase})`)
  return { ...described, saved: true }
}

/** The store channel: a search, and an honest answer about whether a result is a plugin. */
let pluginStore = null
function store() {
  if (pluginStore) return pluginStore
  const { createPluginStore } = require('./store/github-store.cjs')
  pluginStore = createPluginStore({
    log: (message) => log(`store: ${message}`),
    // The settings are a function, not a snapshot: the store asks for them on every request, so a
    // token or an enterprise base saved in the panel is in force immediately.
    config: () => {
      const raw = readStoreState().github
      return raw && typeof raw === 'object' ? raw : {}
    }
  })
  return pluginStore
}

/**
 * The installer: the two-stage half of the store.
 *
 * Staging clones a repository into `data/plugins/store/` and verifies its manifest; enabling
 * records it as enabled, which is what lets the plugin host import it. The queue exists for
 * the store's one-by-one install flow.
 */
let storeInstaller = null
function installer() {
  if (storeInstaller) return storeInstaller
  const { createStoreInstaller } = require('./store/installer.cjs')
  storeInstaller = createStoreInstaller({
    root: PATHS.ROOT,
    log: (message) => log(`store: ${message}`),
    // The pre-flight is the store's own manifest check, so a repository that is not a plugin is
    // refused in one request instead of one clone — the store already knows how to ask GitHub.
    // It is told the package path and whether compatibility mode is on, because both change the
    // verdict: a package inside a monorepo and an adoptable package are different answers.
    probe: (input) => store().inspect({ id: input.repo, branch: input.branch, path: input.path, compat: input.compat }),
    // Installation has to come from the same host the search found the plugin on, or a store
    // pointed at a mirror would list plugins it cannot fetch.
    cloneBase: () => storeGithubSettings().cloneBase
  })
  return storeInstaller
}

/**
 * The bundled community plugins, as a manager over the store (`./plugins/index.cjs`).
 *
 * It reads the *store's own* record of what is installed and what the user decided, and it is the only
 * thing that decides whether a bundled plugin should be installed, left alone, reported or repaired
 * (§19-§23). Two deliberate gaps, both honest rather than convenient:
 *
 *   * **`install` is not wired yet.** The shipped manifest marks both plugins `tested: false`, so the
 *     manager installs nothing — and a reference nobody has run is exactly what must not be installed.
 *     The call lands with the release that marks the first pin tested, together with its verified call
 *     shape; guessing the installer's argument names would be untested code on the install path of an
 *     optional plugin.
 *   * **`userEnabled` reads an explicit disable.** The store records `enabled`/`enabledAt`, where
 *     "staged but never enabled" is the normal first state rather than a decision; only an entry the
 *     store marked disabled counts as the user's answer here.
 */
let bundledPlugins = null

/**
 * The collapsed rail, as data (`./mega-items.cjs`, `updateplan/startup2.md` §36-§44).
 *
 * The plan's dedup rules, expressed as the items themselves rather than as a list somebody maintains:
 *
 *   * **RUN** means *DS-Hns worker slots in use* (§37) — `activeQueue.workerSlotsInUse`, not an agent
 *     count. The Harness shows agents and tasks; this is the number of our own execution slots, which
 *     it does not.
 *   * **WKR** is the same idea as the old `HW` box, renamed to what it actually is (§39): concurrency in
 *     use against the hardware cap. `HW` as a health light is not resident — a healthy machine is not
 *     news.
 *   * **AUTO** replaces `SUB` (§40): the sub-worker's *auto-delegation* switch, which is a control the
 *     user has, rather than the agent state the Harness already draws.
 *   * **Q** and **ERR** appear only when they are non-zero (§38, §36, §43) — an empty queue and a fault
 *     count of zero are the normal state and do not get permanent attention.
 *   * **PEAK is gone from the rail** (§41): it was the electricity-price window, which is a billing fact
 *     and not a power policy. It stays in the expanded summary's own cards, where it belongs.
 */
let megaItemRegistry = null
function megaItems() {
  if (megaItemRegistry) return megaItemRegistry
  megaItemRegistry = createMegaItems()
  // §44's budget is the registry's, and the ordering below is each item's own claim about how much of
  // the rail it deserves.
  registerMegaItems()
  return megaItemRegistry
}

/** Build the rail items. Kept apart from the IPC layer so a test can ask what the rail would show. */
function registerMegaItems() {
  const registry = megaItemRegistry
  if (!registry) return []
  const items = [
    // §37: our own worker slots in use — a DS-Hns number the official UI does not show.
    { id: 'workers', priority: 10, hint: 'DS-Hns worker slots in use', section: 'execution', current: (snapshot) => {
      const inUse = snapshot?.scheduler?.activeQueue?.workerSlotsInUse ?? 0
      const running = Number(snapshot?.scheduler?.counts?.RUNNING || 0) + Number(snapshot?.scheduler?.counts?.DISPATCHING || 0)
      return { label: 'RUN', value: Math.max(Number(inUse) || 0, running) }
    } },
    // §39: concurrency against the hardware cap, named for what it is.
    { id: 'slots', priority: 20, hint: 'concurrency in use against the hardware cap', section: 'resources', current: (snapshot) => {
      const concurrency = snapshot?.scheduler?.concurrency || {}
      const current = concurrency.current
      const cap = concurrency.hardwareCap
      if (current === undefined || current === null) return null
      return { label: 'WKR', value: `${current}/${cap ?? '—'}`, detail: 'in use / hardware cap' }
    } },
    // §40: the control the user has, instead of a second copy of the agent state.
    { id: 'automation', priority: 30, hint: 'auto delegation', section: 'automation', current: (snapshot) => {
      const sub = snapshot?.subWorker
      if (!sub || sub.available === false) return null
      const auto = Boolean(sub.config?.autoDelegate)
      return { label: 'AUTO', value: auto ? 'ON' : 'OFF', tone: auto ? 'ok' : 'quiet', action: 'automation' }
    } },
    // §38: a queue that is empty is not news.
    { id: 'queue', priority: 40, hint: 'queued tasks', section: 'execution', current: (snapshot) => {
      const queued = Number(snapshot?.scheduler?.activeQueue?.queued ?? 0)
      return queued > 0 ? { label: 'Q', value: queued, tone: 'busy', action: 'queue' } : null
    } },
    // §36/§43: neither is a fault count of zero.
    { id: 'errors', priority: 50, hint: 'blocked, retrying or failed tasks', section: 'health', current: (snapshot) => {
      const counts = snapshot?.scheduler?.counts || {}
      const failing = Number(counts.BLOCKED || 0) + Number(counts.RETRYING || 0) + Number(counts.FAILED || 0)
      return failing > 0 ? { label: 'ERR', value: failing, tone: 'bad', action: 'health' } : null
    } },
    // The enhancement layer's own health, from the protection control plane (§42).
    { id: 'protection', priority: 60, hint: 'degraded enhancement modules', section: 'health', current: () => {
      const degraded = ctx?.protection?.describe?.()?.degraded || []
      return degraded.length > 0 ? { label: 'EXT', value: degraded.length, tone: 'warn', action: 'protection', detail: degraded.join(', ') } : null
    } }
  ]
  const registered = []
  for (const item of items) {
    const outcome = registry.register(item)
    if (outcome.ok) registered.push(item.id)
  }
  return registered
}
function bundled() {
  if (bundledPlugins) return bundledPlugins
  const list = () => {
    try {
      return typeof installer().list === 'function' ? installer().list() : []
    } catch (error) {
      log(`bundled: the store's installed list is unavailable (${error?.message || error})`)
      return []
    }
  }
  bundledPlugins = createBundledPlugins({
    installed: () => list().map((entry) => ({ id: entry.id, version: entry.version || entry.commit || null, dir: entry.dir, enabled: entry.state === 'enabled' })),
    userEnabled: (id) => {
      const entry = list().find((candidate) => candidate.id === id)
      if (!entry) return null
      return entry.disabled === true || entry.state === 'disabled' ? false : null
    },
    protection: ctx?.protection || null,
    log: (message) => log(message)
  })
  return bundledPlugins
}

/**
 * The bundled plugins' own channels.
 *
 * The panel shows what the release decided and what the machine has — whether each plugin exists,
 * whether its version is the bundled one, and whether the user disabled it. `repair` is the one action
 * that replaces an installed plugin: never automatic, and refused while the pin is untested.
 */
function registerBundledPluginIpc() {
  const { ipcMain } = ctx.electron
  const guard = (handler) => async (...args) => {
    try {
      return await handler(...args)
    } catch (error) {
      log(`bundled plugin ipc failure: ${error?.stack || error}`)
      return { ok: false, reason: String(error?.message || error) }
    }
  }
  ipcMain.handle('mega:bundled-plugins', guard(async () => {
    const report = bundled().describe()
    // The policy pass is part of the read on purpose: a release that pins a *tested* version converges
    // on the next look instead of making a boot wait on the network.
    const applied = await bundled().ensure()
    return { ok: true, ...report, applied }
  }))
  ipcMain.handle('mega:bundled-plugins-repair', guard(async (_event, payload = {}) => bundled().repair(String(payload?.id || ''))))
}

/**
 * Tell the plugin host that the installed set changed, and wait for it to finish.
 *
 * The host keeps a built world; this is the shell's chance to drop it so an enable takes effect
 * without a restart. The shell hands the extension a hook, so the store's IPC answer is sent
 * only after the rebuild: otherwise the panel would refresh its list while the plugin was still
 * being mounted and show the set from before the button. When the hook is absent (a build wired
 * differently) the fallback is the event, which is a no-op rather than a failure when nothing
 * listens.
 */
async function notifyPluginHostReload() {
  const hook = ctx && typeof ctx.reloadInstalledPlugins === 'function' ? ctx.reloadInstalledPlugins : null
  if (hook) {
    try {
      return await hook('the plugin store changed the installed set')
    } catch (error) {
      log(`could not reload the plugin host: ${error?.message || error}`)
      return null
    }
  }
  try {
    ctx.electron.ipcMain.emit('mega:installed-plugins-changed')
  } catch (error) {
    log(`could not notify the plugin host: ${error?.message || error}`)
  }
  return null
}

function registerStoreIpc() {
  const { ipcMain } = ctx.electron
  const guard = (handler) => async (...args) => {
    try {
      return await handler(...args)
    } catch (error) {
      log(`store ipc failure: ${error?.stack || error}`)
      return { ok: false, reason: 'store_ipc_failed', message: String(error?.message || error) }
    }
  }
  ipcMain.handle('mega:store-describe', guard(() => ({ ok: true, ...store().describe() })))
  ipcMain.handle('mega:store-search', guard((_event, payload = {}) => store().search(payload || {})))
  ipcMain.handle('mega:store-inspect', guard((_event, payload = {}) => store().inspect({ ...(payload || {}), compat: payload.compat === true || storePreference().compat })))
  // The installed side: what is staged, what is enabled, and where each came from.
  ipcMain.handle('mega:store-installed', guard(() => ({
    ok: true,
    describe: installer().describe(),
    preference: storePreference(),
    plugins: installer().list(),
    history: installer().history(),
    queue: installer().queue()
  })))
  // Compatibility mode is a choice the user makes once, not a flag on every row.
  ipcMain.handle('mega:store-compat', guard(() => ({ ok: true, ...storePreference() })))
  ipcMain.handle('mega:store-compat-set', guard((_event, payload = {}) => setStorePreference(payload || {})))
  // The GitHub settings: what the channel is using, and where a deployment sets its own.
  ipcMain.handle('mega:store-github', guard(() => describeStoreGithub()))
  ipcMain.handle('mega:store-github-set', guard((_event, payload = {}) => setStoreGithub(payload || {})))
  ipcMain.handle('mega:store-stage', guard(async (_event, payload = {}) => {
    // The manifest is checked before the download, not after it: a repository that is not a
    // DS-Hns plugin is answered in one request rather than one clone. An inconclusive check
    // (no network, an unresolved default branch) falls through to the clone, which decides.
    const compat = typeof payload.compat === 'boolean' ? payload.compat : storePreference().compat
    const checked = await installer().preflight({ source: payload.source || payload.repo, branch: payload.branch, compat })
    const result = checked.ok === false
      ? checked
      : installer().stage({
          source: payload.source || payload.repo,
          branch: payload.branch,
          replace: payload.replace === true,
          compat,
          verdict: checked.verdict
        })
    notifyChanged()
    return result
  }))
  ipcMain.handle('mega:store-enable', guard(async (_event, payload = {}) => {
    const result = installer().enable({ id: payload.id })
    if (result.ok) await notifyPluginHostReload()
    notifyChanged()
    return result
  }))
  ipcMain.handle('mega:store-disable', guard(async (_event, payload = {}) => {
    const result = installer().disable({ id: payload.id })
    if (result.ok) await notifyPluginHostReload()
    notifyChanged()
    return result
  }))
  ipcMain.handle('mega:store-remove', guard(async (_event, payload = {}) => {
    const result = installer().remove({ id: payload.id })
    if (result.ok) await notifyPluginHostReload()
    notifyChanged()
    return result
  }))
  ipcMain.handle('mega:store-reinstall', guard(async (_event, payload = {}) => {
    const result = installer().reinstall({
      id: payload.id,
      source: payload.source,
      repo: payload.repo,
      branch: payload.branch,
      // A reinstall keeps the mode the plugin was installed with (the installer decides from the
      // history); the preference only covers the case where there is no history to consult.
      compat: typeof payload.compat === 'boolean' ? payload.compat : undefined
    })
    // A reinstall of a plugin that is switched off changes the files but not the running set,
    // so it only reloads the world when the plugin came back enabled.
    if (result.ok && result.enabled) await notifyPluginHostReload()
    notifyChanged()
    return result
  }))
  // The one-by-one install flow: candidates first, then one sequential run.
  ipcMain.handle('mega:store-queue', guard(async (_event, payload = {}) => {
    const action = String(payload.action || 'list')
    if (action === 'list') return { ok: true, queue: installer().queue() }
    // A queued candidate may name a package inside a repository, and compatibility mode applies to
    // the whole run: both are part of what each item is, so both are stored with it.
    if (action === 'add') return installer().enqueue({ source: payload.source || payload.repo, branch: payload.branch })
    if (action === 'clear') return installer().clearQueue()
    if (action === 'run') {
      const compat = typeof payload.compat === 'boolean' ? payload.compat : storePreference().compat
      const result = await installer().runQueue({ replace: payload.replace === true, compat })
      notifyChanged()
      return result
    }
    return { ok: false, reason: `unknown queue action "${action}"` }
  }))
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
      title: bilingualTitle('导入任务提示音', 'Import a task notification sound'),
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
  registerCompatibilityIpc()
  // The store is a channel, not a feature: searching GitHub is part of managing plugins, and
  // a store you can switch off is a store whose results you cannot trust to be complete.
  registerStoreIpc()
  // The bundled set is MEGA's own responsibility (§19): it is registered here rather than in Core, and
  // the shell's protection layer — when there is one — is what keeps a failure inside the panel.
  registerBundledPluginIpc()
  // The feature manager's own channels, registered last and never gated: switching a feature
  // off is how a user fixes one, so the switch itself may not be behind a feature.
  registerFeatureIpc()
  // The glass layer is chrome, not a feature: it styles the shell the other features live in,
  // so it is never gated — a user who switched a feature off must still be able to read the
  // panel that says so.
  registerGlassIpc()
  // The wallpaper is chrome for the same reason, and it is also what the dock's first paint asks
  // for, so it is registered with the glass rather than behind a switch.
  registerWallpaperIpc()
}

/**
 * The frosted-glass layer's channels.
 *
 * The dock asks what the layer is made of and may change it; the shell owns the file and
 * validates every value, so the toggle and the stylesheet cannot disagree about what is in
 * force. The state is pushed to the dock on every change, because the Appearance panel and any
 * other surface that shows a switch have to move together.
 */
function registerGlassIpc() {
  const { ipcMain } = ctx.electron
  const guard = (handler) => async (...args) => {
    try {
      return await handler(...args)
    } catch (error) {
      log(`glass ipc failure: ${error?.stack || error}`)
      return { ok: false, reason: String(error?.message || error), code: 'GLASS_IPC_FAILED' }
    }
  }
  ipcMain.handle('mega:ui-glass', guard(() => glass().describe()))
  ipcMain.handle('mega:ui-glass-set', guard((_event, payload = {}) => {
    const result = glass().set(payload || {})
    if (result.ok) {
      try {
        dockTarget.send('mega:ui-glass-changed', result)
      } catch (error) {
        log(`could not push the glass state: ${error?.message || error}`)
      }
    }
    return result
  }))
}

/**
 * The wallpaper state, created lazily like the glass layer.
 *
 * The file is the user's choice (`data/state/wallpaper.json`) and this module validates every
 * patch, so no surface can disagree with another about what is in force.
 */
let wallpaperState = null
function wallpaper() {
  if (wallpaperState) return wallpaperState
  const { createWallpaper } = require('./wallpaper.cjs')
  wallpaperState = createWallpaper({
    root: PATHS.ROOT,
    log: (message) => log(`wallpaper: ${message}`)
  })
  return wallpaperState
}

/**
 * What the dock draws, plus where the dock is.
 *
 * The same picture on both surfaces covers the whole window, and the dock's own rectangle is cut out
 * of the layer that covers the official page (the dock's view is *under* that layer, so it has to
 * draw the picture itself or it would be covered by it). For the two to read as *one* picture, the
 * dock's copy has to be placed against the same window box, which means knowing where the dock sits
 * in the window — and that is the shell's geometry, handed to this extension through the dock adapter.
 *
 * **Different pictures means no frame.** If Mega has a wallpaper of its own, the dock must fit it to
 * the dock, not show the slice of it that the window box would give — aligning two *different* images
 * to one box is how a strip of interface ends up displaying a fragment of its own photograph.
 *
 * An unknown rectangle is not an error: the document falls back to its own box, which is what a
 * dock that is not part of the main window (the legacy companion window) has always done.
 */
function dockWallpaperFrame() {
  const bounds = dockTarget.getBounds()
  if (!bounds) return null
  return { x: Math.round(Number(bounds.x) || 0), y: Math.round(Number(bounds.y) || 0) }
}

/** Everything the dock's own layer needs in one push. */
function wallpaperLayerPayload() {
  const layer = wallpaper().dockLayer()
  const frame = wallpaper().sharesPicture() ? dockWallpaperFrame() : null
  return frame ? { ...layer, frame } : layer
}

/** Push the wallpaper to the dock: it is a real element there, not a stylesheet. */
function pushWallpaper() {
  try {
    dockTarget.send('mega:wallpaper-changed', wallpaperLayerPayload())
  } catch (error) {
    log(`could not push the wallpaper: ${error?.message || error}`)
  }
  // The layer over the official page takes the image and nothing else — a script-free document
  // whose policy allows an inline image — so what it is handed is the stylesheet the module builds
  // for it, and a video (or no wallpaper at all) is answered with the same "draw nothing". That
  // answer travels with the stylesheet, because the layer is a window: an empty one has to be
  // taken off the screen rather than left there.
  try {
    if (typeof officialSurfaceTarget.wallpaper === 'function') {
      const layer = wallpaper().windowLayer()
      officialSurfaceTarget.wallpaper(layer.css, { drawable: layer.drawable })
    }
  } catch (error) {
    log(`the wallpaper could not reach the layer over the official UI: ${error?.message || error}`)
  }
}

function registerWallpaperIpc() {
  const { ipcMain, dialog } = ctx.electron
  const guard = (handler) => async (...args) => {
    try {
      return await handler(...args)
    } catch (error) {
      log(`wallpaper ipc failure: ${error?.stack || error}`)
      return { ok: false, reason: `wallpaper_ipc_failed: ${error?.message || error}` }
    }
  }
  ipcMain.handle('mega:wallpaper', guard(() => wallpaper().describe()))
  // What the dock itself draws: a `data:` URL for an image, a `file:` URL for a video, and the
  // attributes a real element needs. It is a separate answer from `describe()` because the panel's
  // view carries limits and vocabulary the document has no use for.
  ipcMain.handle('mega:wallpaper-layer', guard(() => wallpaperLayerPayload()))
  ipcMain.handle('mega:wallpaper-set', guard((_event, payload = {}) => {
    const result = wallpaper().set(payload || {})
    if (result.ok !== false) pushWallpaper()
    return result
  }))
  /**
   * The file chooser, for one surface or for both.
   *
   * The dialog is the shell's, so the renderer never handles a path it could act on. Which surface the
   * chosen file lands on is the panel's scope — "两处一起 / both" writes the flat shape, which the
   * module reads as both surfaces, and a scope of `main` or `dock` writes just that one. Choosing a
   * file also switches the picture on: a file that is picked and then not drawn would be a control
   * that did nothing.
   */
  ipcMain.handle('mega:wallpaper-pick', guard(async (_event, payload = {}) => {
    const scope = payload && typeof payload === 'object' && payload.scope ? String(payload.scope) : 'both'
    const target = scope === 'both' || WALLPAPER_SURFACES.includes(scope) ? scope : 'both'
    const picked = await dialog.showOpenDialog(ctx.mainWindow, {
      title: bilingualTitle('选择壁纸（图片或视频）', 'Choose a wallpaper (image or video)'),
      properties: ['openFile'],
      filters: [
        { name: bilingualTitle('图片与视频', 'Images and videos'), extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'mp4', 'webm', 'm4v'] },
        { name: bilingualTitle('图片', 'Images'), extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif'] },
        { name: bilingualTitle('视频', 'Videos'), extensions: ['mp4', 'webm', 'm4v'] }
      ]
    })
    if (picked.canceled || !picked.filePaths.length) return { ok: false, canceled: true }
    const chosen = picked.filePaths[0]
    const result = target === 'both'
      ? wallpaper().set({ enabled: true, file: chosen, main: { enabled: true }, dock: { enabled: true } })
      : wallpaper().set({ enabled: true, [target]: { file: chosen, enabled: true } })
    if (result.ok !== false) pushWallpaper()
    return result
  }))
}

/**
 * The glass state, created lazily like the feature registry.
 *
 * Deployment defaults may come from `config.mega.glass`; the user's own choice is stored in
 * `data/state/ui-glass.json` and wins over them.
 */
let glassState = null
function glass() {
  if (glassState) return glassState
  const { createUiGlass } = require('./ui-glass.cjs')
  glassState = createUiGlass({
    root: PATHS.ROOT,
    defaults: (ctx.config && ctx.config.mega && ctx.config.mega.glass) || {},
    log: (message) => log(`glass: ${message}`)
  })
  return glassState
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
      title: bilingualTitle('导入 HNS 主题包目录', 'Import an HNS theme package'),
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
      /**
       * The layer the user's wallpaper is drawn in — a click-through *window* over the official page.
       *
       * It is reported here, beside the two theme surfaces, because it is the third thing that can be
       * over the official UI and the only one acceptance has to be able to ask about directly: a view
       * up there takes every click, and this one must not. `input` is the shell's own answer, and
       * `available: false` (no wallpaper set, or the layer switched off) is a complete answer.
       */
      wallpaper: overlayState.wallpaper || {
        available: false,
        created: false,
        input: 'unavailable',
        reason: 'wallpaper_layer_unavailable'
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
      title: bilingualTitle('选择技能目录或 SKILL.md', 'Choose a skill directory or SKILL.md'),
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
  // Every channel registered from here on is gated by the feature that declares it.
  installFeatureGate()
  registerIpc()
  // Tell the dock (and its preload) which features are on, before the first paint: a
  // disabled feature's panels have to be absent from the very first snapshot.
  pushFeatureState()
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
  // the Dark recovery theme. It paints the official shell and overlay only — the dock is
  // frosted glass and takes no theme payload.
  try {
    const engine = ensureThemeEngine()
    engine.start()
  } catch (error) {
    log(`theme system unavailable, continuing with the built-in Dark palette: ${error?.stack || error}`)
  }
  // The integrated dock view is created *after* extensions start, so the shell calls
  // `onDockReady` once its renderer has loaded; that is when the dock is told to render.
  registerDockReadyHook()
  // The dock can be asked to start expanded (`--mega-dock`, or the environment
  // form used by tooling that only controls the child's environment).
  if (process.argv.includes('--mega-dock') || process.env.DSH_MEGA_DOCK_EXPANDED === '1') {
    setDockExpanded(true, { focus: false })
  }
  // Optional Sub-worker: bound last, after the official UI, the dock and the
  // theme system are up, so an unavailable or failing worker can never delay
  // them (plan §22 fault isolation).
  bindSubWorker()
  /**
   * The bundled community plugins, last and in the background.
   *
   * Registering them as protected modules happens now (it is synchronous bookkeeping); the policy pass
   * that would install a pinned *tested* version does not, because a boot may never wait on a network.
   * Today the manifest marks both references untested, so this pass installs nothing and says so.
   */
  try {
    const registered = bundled().registerProtected()
    if (registered.length) log(`bundled community plugins registered for protection: ${registered.join(', ')}`)
    Promise.resolve()
      .then(() => bundled().ensure())
      .then((applied) => {
        const report = bundled().describe()
        log(`bundled plugins: ${JSON.stringify(report.states)}`)
        for (const entry of applied) {
          if (entry.action !== 'none') log(`bundled plugin ${entry.id}: ${entry.action} → ${entry.state}${entry.reason ? ` (${entry.reason})` : ''}`)
        }
      })
      .catch((error) => log(`the bundled plugin pass failed without affecting anything else: ${error?.message || error}`))
  } catch (error) {
    log(`bundled plugin registration failed (the rest of Mega is unaffected): ${error?.message || error}`)
  }
  log('ready; single-window Mega dock + ordered queue + hardware-adaptive concurrency + unified theme system enabled')
  if (subWorkerAvailable()) log(`optional Sub-worker available (state ${subWorkerSnapshot().state})`)
}

/**
 * The shell's dock-ready notification (`ctx.onDockReady`). Registering here —
 * and not at module scope — keeps the extension free of start-order side effects
 * and lets `stop()` drop the handler it added.
 *
 * There is no theme payload to deliver any more: the dock is glass and reads its own palette,
 * so a dock that becomes ready only has to be told the state it renders.
 */
function registerDockReadyHook() {
  const hook = ctx?.onDockReady
  if (typeof hook !== 'function') return false
  const handler = () => {
    try {
      notifyChanged()
      // The official surfaces are created after this extension starts, so the wallpaper is painted
      // here rather than at startup: this is the first moment there is anything to paint it on.
      pushWallpaper()
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
  try { terminalObserver.stop() } catch {}
  try { scheduler.stop() } catch {}
  try { unsubscribeSubWorker?.() } catch {}
  unsubscribeSubWorker = null
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
