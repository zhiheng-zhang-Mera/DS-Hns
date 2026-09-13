'use strict'
const { contextBridge, ipcRenderer } = require('electron')

/**
 * The feature map, kept in the preload because this file is the choke point.
 *
 * The main process refuses a disabled feature's *own* channels, but the shell owns several
 * of the features the registry names (Computer Use, the engineering runtime, the plugins,
 * the sub-worker). Gating them here is what makes one switch mean one thing everywhere: a
 * renderer cannot reach a disabled feature through `window.megaTools` at all, whatever the
 * shell would have answered.
 */
let featureMap = {}
ipcRenderer.on('mega:features', (_event, payload) => {
  featureMap = payload && typeof payload.features === 'object' && payload.features ? payload.features : {}
})

/** The refusal a disabled feature's bridge returns, shaped like the shell's own errors. */
function featureOff(feature) {
  return { ok: false, code: 'FEATURE_DISABLED', feature, reason: `the ${feature} feature is switched off in the plugin manager` }
}

/**
 * Wrap one bridge: the call goes through unless its feature is switched off.
 *
 * @param {string} feature the registry id
 * @param {Function} invoke what to do when the feature is on
 */
function gated(feature, invoke) {
  return (...args) => {
    if (featureMap[feature] === false) return Promise.resolve(featureOff(feature))
    return invoke(...args)
  }
}

/**
 * Gate a whole bridge on one feature.
 *
 * Subscriptions (`onSomething`) are left alone: a gated subscription would return a refusal
 * object where the caller expects an unsubscribe handle, and the events it delivers are the
 * shell's own pushes rather than renderer actions. The *management* surfaces — `megaPlugins`
 * and `megaTools.features` — are deliberately not gated at all: switching a feature off is
 * how a user fixes one, so the switch may not be behind a feature.
 */
function gatedBridge(feature, bridge) {
  const out = {}
  for (const [name, value] of Object.entries(bridge)) {
    out[name] = typeof value === 'function' && !/^on[A-Z]/.test(name) ? gated(feature, value) : value
  }
  return out
}

function featuresSnapshot() {
  return ipcRenderer.invoke('mega:features-snapshot')
}

function setFeature(id, enabled) {
  return ipcRenderer.invoke('mega:features-set', { id: String(id || ''), enabled: enabled !== false })
}

function syncShellDock(snapshotOrState) {
  const state = snapshotOrState?.extension?.dock || snapshotOrState || {}
  ipcRenderer.send('mega-shell:dock-state', {
    expanded: Boolean(state.expanded),
    width: Number(state.width) || undefined,
    expandedWidth: Number(state.expandedWidth) || undefined
  })
}

async function snapshot() {
  const value = await ipcRenderer.invoke('mega:snapshot')
  syncShellDock(value)
  return value
}

async function setDockExpanded(expanded) {
  const value = await ipcRenderer.invoke('mega:dock-expand', Boolean(expanded))
  syncShellDock(value)
  return value
}

async function toggleDock() {
  const current = await ipcRenderer.invoke('mega:snapshot')
  const value = await ipcRenderer.invoke('mega:dock-expand', !Boolean(current?.extension?.dock?.expanded))
  syncShellDock(value)
  return value
}

contextBridge.exposeInMainWorld('megaTools', {
  snapshot,
  addTask: gated('mega.queue', (payload) => ipcRenderer.invoke('mega:add-task', payload)),
  reorderTask: gated('mega.queue', (id, move) => ipcRenderer.invoke('mega:reorder-task', id, move)),
  cancelTask: gated('mega.queue', (id) => ipcRenderer.invoke('mega:cancel-task', id)),
  clearPending: gated('mega.queue', () => ipcRenderer.invoke('mega:clear-pending')),
  removeTasks: gated('mega.queue', (ids) => ipcRenderer.invoke('mega:remove-tasks', ids)),
  updateScheduler: gated('mega.queue', (patch) => ipcRenderer.invoke('mega:update-scheduler', patch)),
  refreshHardware: gated('mega.hardware', () => ipcRenderer.invoke('mega:refresh-hardware')),
  updateSettings: (patch) => ipcRenderer.invoke('mega:update-settings', patch),
  fetchBalance: gated('mega.balance', (trigger = 'manual', options = {}) => ipcRenderer.invoke('mega:balance', trigger, options)),
  pickWorkspace: () => ipcRenderer.invoke('mega:pick-workspace'),
  pickSound: () => ipcRenderer.invoke('mega:pick-sound'),
  /**
   * The plugin store channel.
   *
   * Search GitHub for repositories that carry the plugin topic, ask whether one of them is
   * actually a plugin (its manifest has to pass the platform's own validator), and install it
   * in two separate steps: `stage` puts the code on disk and verifies it, `enable` is the step
   * that lets the host import it. A one-click install would be a remote-code-execution surface
   * wearing a search box, which is why the two steps are two calls.
   */
  store: {
    describe: () => ipcRenderer.invoke('mega:store-describe'),
    search: (input) => ipcRenderer.invoke('mega:store-search', input),
    inspect: (input) => ipcRenderer.invoke('mega:store-inspect', input),
    installed: () => ipcRenderer.invoke('mega:store-installed'),
    stage: (input) => ipcRenderer.invoke('mega:store-stage', input),
    enable: (input) => ipcRenderer.invoke('mega:store-enable', input),
    disable: (input) => ipcRenderer.invoke('mega:store-disable', input),
    remove: (input) => ipcRenderer.invoke('mega:store-remove', input),
    reinstall: (input) => ipcRenderer.invoke('mega:store-reinstall', input),
    // The one-by-one install flow: add candidates, then run the queue sequentially.
    queue: (input) => ipcRenderer.invoke('mega:store-queue', input)
  },
  /**
   * The feature manager.
   *
   * Deliberately *not* gated: `setFeature` is how a switched-off feature is switched back
   * on, and the map itself has to be readable while features are off.
   */
  features: {
    snapshot: featuresSnapshot,
    set: setFeature,
    map: () => ({ ...featureMap }),
    onChanged: (callback) => ipcRenderer.on('mega:features', (_event, payload) => callback(payload))
  },
  /**
   * The frosted-glass layer.
   *
   * It styles every DS-Hns surface — the dock, its panels, its floats — and the official UI is
   * deliberately not one of them: the layer lives in this document, so it cannot reach the
   * official renderer even in principle. The values are numbers because the *colours* keep
   * coming from the active skin; the shell validates every patch.
   */
  glass: {
    describe: () => ipcRenderer.invoke('mega:ui-glass'),
    set: (patch) => ipcRenderer.invoke('mega:ui-glass-set', patch),
    onChanged: (callback) => ipcRenderer.on('mega:ui-glass-changed', (_event, payload) => callback(payload))
  },
  // 拓展状态 module: align the main harness with the official latest version.
  checkHarnessUpdate: () => ipcRenderer.invoke('mega:update-check'),
  applyHarnessUpdate: () => ipcRenderer.invoke('mega:update-apply'),
  toggleDock,
  setDockExpanded,
  /**
   * The DSH compatibility report.
   *
   * This replaced the mode bridge entirely: reading, setting and toggling a frontend mode
   * no longer exists, and the only question the status panel still asks is whether this
   * Harness build is the one the product knows how to drive.
   */
  compatibility: () => ipcRenderer.invoke('mega:compatibility'),
  // In integrated mode the rail should always remain reachable, so "hide"
  // degrades to collapse instead of removing the whole in-window view.
  hideDock: () => setDockExpanded(false),
  onChanged: (callback) => ipcRenderer.on('mega:changed', () => callback()),
  /**
   * "Open the plugin manager."
   *
   * The tray asks the dock to reveal the float; the dock never opens a second window, so
   * this is an event rather than a new surface.
   */
  onOpenPluginManager: (callback) => ipcRenderer.on('mega:open-plugin-manager', () => callback()),
  /**
   * "Show the store, and start an install."
   *
   * The tray can ask for the manager; this is the same idea for the store's install flow, so
   * the queue the user built is reachable without hunting for the right tab.
   */
  onOpenStore: (callback) => ipcRenderer.on('mega:open-store', (_event, payload) => callback(payload)),
  /**
   * HNS unified theme system.
   *
   * The renderer never receives a theme file path and never reads the theme
   * directory: the engine hands it a small declarative payload (tokens as CSS
   * custom properties + slot styles) which is data, not code.
   */
  theme: {
    snapshot: () => ipcRenderer.invoke('mega:theme-snapshot'),
    capabilities: () => ipcRenderer.invoke('mega:theme-capabilities'),
    // Paint payload for the currently active theme (used on first paint).
    paint: () => ipcRenderer.invoke('mega:theme-paint'),
    create: (payload) => ipcRenderer.invoke('mega:theme-create', payload),
    revise: (payload) => ipcRenderer.invoke('mega:theme-revise', payload),
    validate: (payload) => ipcRenderer.invoke('mega:theme-validate', payload),
    approve: (payload) => ipcRenderer.invoke('mega:theme-approve', payload),
    discard: (payload) => ipcRenderer.invoke('mega:theme-discard', payload),
    apply: (id) => ipcRenderer.invoke('mega:theme-apply', { id }),
    remove: (id) => ipcRenderer.invoke('mega:theme-delete', { id }),
    duplicate: (id, name) => ipcRenderer.invoke('mega:theme-duplicate', { id, name }),
    restore: (id) => ipcRenderer.invoke('mega:theme-restore', { id }),
    importPackage: () => ipcRenderer.invoke('mega:theme-import'),
    observe: (pages) => ipcRenderer.invoke('mega:theme-observe', { pages }),
    /**
     * On-disk truth for the latest snapshot (the package plus a verdict per PNG)
     * and the optional AI designer's state. Used by the appearance panel and by
     * acceptance, which must judge the artifact rather than a boolean.
     */
    artifacts: () => ipcRenderer.invoke('mega:theme-artifacts'),
    /**
     * The four Theme Surfaces (Update-Plan 任务 1 / 任务 2 / 任务 3).
     *
     * Reports each surface's permission, whether the official shell/overlay views
     * are actually on screen with real bounds, whether the official overlay is
     * enabled, and — for the protected official renderer — that nothing was painted
     * into it. Read-only data; the renderer cannot address a surface from here.
     */
    surfaces: () => ipcRenderer.invoke('mega:theme-surfaces'),
    detail: (id) => ipcRenderer.invoke('mega:theme-detail', { id }),
    // Engine -> renderer paint pushes and change notifications.
    onApply: (callback) => ipcRenderer.on('mega:theme-apply', (_event, payload) => callback(payload)),
    onChanged: (callback) => ipcRenderer.on('mega:theme-changed', () => callback()),
    /**
     * UI observation support: the engine asks for live slot geometry, the dock
     * answers with bounding boxes so the preview validator can verify that
     * critical controls stay visible and unoccluded.
     */
    reportRegions: (payload) => ipcRenderer.send('mega-theme:regions', payload),
    // The main process asks for a geometry probe on this exact channel; a mismatch
    // here silently disabled live measurement of critical regions. The engine's
    // `requestThemeRegions()` is the pull side of this push.
    onProbeRegions: (callback) => ipcRenderer.on('mega-theme:probe-regions', () => callback())
  },
  /**
   * HNS skills management.
   *
   * The renderer never receives a skill path: it sends an intent (search, install
   * this source, remove these names) and receives plain data. All validation and all
   * filesystem work stay in the main process.
   */
  skills: {
    snapshot: () => ipcRenderer.invoke('mega:skills-snapshot'),
    tags: () => ipcRenderer.invoke('mega:skills-tags'),
    detail: (name) => ipcRenderer.invoke('mega:skills-detail', { name }),
    search: (payload = {}) => ipcRenderer.invoke('mega:skills-search', payload),
    installSource: (payload = {}) => ipcRenderer.invoke('mega:skills-install-source', payload),
    installCatalog: (payload = {}) => ipcRenderer.invoke('mega:skills-install-catalog', payload),
    pickLocal: () => ipcRenderer.invoke('mega:skills-pick-local'),
    remove: (name) => ipcRenderer.invoke('mega:skills-remove', { name }),
    removeMany: (names) => ipcRenderer.invoke('mega:skills-remove-many', { names }),
    removeCollection: (collection) => ipcRenderer.invoke('mega:skills-remove-collection', { collection }),
    setInvocation: (payload = {}) => ipcRenderer.invoke('mega:skills-set-invocation', payload),
    onChanged: (callback) => ipcRenderer.on('mega:skills-changed', () => callback())
  }
})

/**
 * Computer Use control surface (Update-Plan/computer-use.md).
 *
 * The dock edits an execution contract and reads the runtime's own reports; the
 * runtime itself lives in the shell (main process) exactly like the Sub-worker
 * manager, because it drives windows, real input and the browser. No execution
 * logic and no filesystem path is exposed to the renderer.
 */
contextBridge.exposeInMainWorld('megaComputerUse', gatedBridge('mega.computer-use', {
  snapshot: () => ipcRenderer.invoke('computer-use:snapshot'),
  health: () => ipcRenderer.invoke('computer-use:health'),
  actions: () => ipcRenderer.invoke('computer-use:actions'),
  capabilities: () => ipcRenderer.invoke('computer-use:capabilities'),
  // The long-running state readers (Update-Plan/24h.md Task 19): read-only
  // snapshots of what the runtime owns and what it is holding in memory.
  processes: () => ipcRenderer.invoke('computer-use:processes'),
  resources: () => ipcRenderer.invoke('computer-use:resources'),
  run: (contract, options) => ipcRenderer.invoke('computer-use:run', contract, options),
  step: (contract) => ipcRenderer.invoke('computer-use:step', contract),
  execute: (action) => ipcRenderer.invoke('computer-use:execute', action),
  cancel: (reason) => ipcRenderer.invoke('computer-use:cancel', reason),
  log: (count) => ipcRenderer.invoke('computer-use:log', count),
  screenshots: () => ipcRenderer.invoke('computer-use:screenshots'),
  page: () => ipcRenderer.invoke('computer-use:page')
}))

/**
 * Engineering runtime control surface (Update-Plan/24h-1.md).
 *
 * The dock names a repository and a goal and reads the episode's own report; the
 * runtime lives in the shell exactly like the Computer Use runtime, because an
 * episode executes real commands and mutates real files. Starting an episode
 * returns as soon as it is accepted — the panel follows it through `status()` —
 * so the renderer stays responsive and can cancel.
 */
contextBridge.exposeInMainWorld('megaEngineering', gatedBridge('mega.engineering', {
  status: () => ipcRenderer.invoke('engineering:status'),
  describe: (input) => ipcRenderer.invoke('engineering:describe', input),
  checkpoints: (input) => ipcRenderer.invoke('engineering:checkpoints', input),
  run: (input) => ipcRenderer.invoke('engineering:run', input),
  cancel: (input) => ipcRenderer.invoke('engineering:cancel', input)
}))

/**
 * Plugin platform control surface (Update-Plan/accleration.md sections 45, 46).
 *
 * The panel reads the plugin set, the capability vocabulary and the execution
 * settings, and it may enable, disable, restart or reconfigure a plugin. Every one of
 * those is a *host* operation by id: the renderer cannot name a plugin object, a code
 * path or a capability to provide, so a settings panel cannot become an installation
 * surface. The heavy lifting — validating settings, writing configuration and
 * rebuilding the plugin world — happens in the shell.
 */
contextBridge.exposeInMainWorld('megaPlugins', {
  status: () => ipcRenderer.invoke('plugins:status'),
  list: () => ipcRenderer.invoke('plugins:list'),
  describe: (input) => ipcRenderer.invoke('plugins:describe', input),
  capabilities: () => ipcRenderer.invoke('plugins:capabilities'),
  enable: (input) => ipcRenderer.invoke('plugins:enable', input),
  reload: (input) => ipcRenderer.invoke('plugins:reload', input),
  health: (input) => ipcRenderer.invoke('plugins:health', input),
  execution: () => ipcRenderer.invoke('plugins:execution'),
  configure: (input) => ipcRenderer.invoke('plugins:configure', input),
  lock: (input) => ipcRenderer.invoke('plugins:lock', input),
  // Enabling, disabling or removing an installed plugin rebuilds the world in place, so the
  // panel can ask for a rescan and can be told when the world moved underneath it.
  refresh: () => ipcRenderer.invoke('plugins:refresh'),
  onChanged: (callback) => ipcRenderer.on('plugins:changed', (_event, payload) => callback(payload))
})

/**
 * Optional Sub-worker control surface. The worker has no window of its own
 * (plan §3.2), so the Mega dock is its primary visual surface: these channels
 * drive the shell-owned WorkerManager and are the only way the panel talks to
 * the executor. Every handler is failure isolated in the shell.
 */
contextBridge.exposeInMainWorld('megaSubWorker', gatedBridge('mega.sub-worker', {
  snapshot: () => ipcRenderer.invoke('sub-worker:snapshot'),
  start: () => ipcRenderer.invoke('sub-worker:start'),
  stop: () => ipcRenderer.invoke('sub-worker:stop'),
  restart: () => ipcRenderer.invoke('sub-worker:restart'),
  pause: (reason) => ipcRenderer.invoke('sub-worker:pause', reason),
  resume: (reason) => ipcRenderer.invoke('sub-worker:resume', reason),
  cancelTask: (reason) => ipcRenderer.invoke('sub-worker:cancel-task', reason),
  assignTask: (task) => ipcRenderer.invoke('sub-worker:assign-task', task),
  sendNote: (note) => ipcRenderer.invoke('sub-worker:send-note', note),
  takeOver: (reason) => ipcRenderer.invoke('sub-worker:take-over', reason),
  clearHandoff: () => ipcRenderer.invoke('sub-worker:clear-handoff'),
  resumeLast: () => ipcRenderer.invoke('sub-worker:resume-last'),
  updateConfig: (patch) => ipcRenderer.invoke('sub-worker:update-config', patch),
  liveView: (taskId) => ipcRenderer.invoke('sub-worker:live-view', taskId),
  readLog: (taskId) => ipcRenderer.invoke('sub-worker:read-log', taskId),
  pickTargetRepo: () => ipcRenderer.invoke('sub-worker:pick-target-repo'),
  releaseWorktree: (targetRepo, options) => ipcRenderer.invoke('sub-worker:release-worktree', targetRepo, options),
  // Adaptive multi-worker surface (Update-Plan/multi-sub.md).
  submitPlan: (plan, options) => ipcRenderer.invoke('sub-worker:submit-plan', plan, options),
  plans: () => ipcRenderer.invoke('sub-worker:plans'),
  resourceConfig: (patch) => ipcRenderer.invoke('sub-worker:resource-config', patch),
  tick: () => ipcRenderer.invoke('sub-worker:tick'),
  // The tray's "Open Live View" (and anything else outside the dock) asks the
  // dock to reveal the Live View pane; the dock never opens a second window.
  onOpenLiveView: (callback) => ipcRenderer.on('mega:sub-worker-live-view', () => callback())
}))
