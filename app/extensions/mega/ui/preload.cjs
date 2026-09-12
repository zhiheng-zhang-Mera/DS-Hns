'use strict'
const { contextBridge, ipcRenderer } = require('electron')

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
  addTask: (payload) => ipcRenderer.invoke('mega:add-task', payload),
  reorderTask: (id, move) => ipcRenderer.invoke('mega:reorder-task', id, move),
  cancelTask: (id) => ipcRenderer.invoke('mega:cancel-task', id),
  clearPending: () => ipcRenderer.invoke('mega:clear-pending'),
  removeTasks: (ids) => ipcRenderer.invoke('mega:remove-tasks', ids),
  updateScheduler: (patch) => ipcRenderer.invoke('mega:update-scheduler', patch),
  refreshHardware: () => ipcRenderer.invoke('mega:refresh-hardware'),
  updateSettings: (patch) => ipcRenderer.invoke('mega:update-settings', patch),
  fetchBalance: (trigger = 'manual', options = {}) => ipcRenderer.invoke('mega:balance', trigger, options),
  pickWorkspace: () => ipcRenderer.invoke('mega:pick-workspace'),
  pickSound: () => ipcRenderer.invoke('mega:pick-sound'),
  // 拓展状态 module: align the main harness with the official latest version.
  checkHarnessUpdate: () => ipcRenderer.invoke('mega:update-check'),
  applyHarnessUpdate: () => ipcRenderer.invoke('mega:update-apply'),
  toggleDock,
  setDockExpanded,
  // In integrated mode the rail should always remain reachable, so "hide"
  // degrades to collapse instead of removing the whole in-window view.
  hideDock: () => setDockExpanded(false),
  onChanged: (callback) => ipcRenderer.on('mega:changed', () => callback()),
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
 * Optional Sub-worker control surface. The worker has no window of its own
 * (plan §3.2), so the Mega dock is its primary visual surface: these channels
 * drive the shell-owned WorkerManager and are the only way the panel talks to
 * the executor. Every handler is failure isolated in the shell.
 */
contextBridge.exposeInMainWorld('megaSubWorker', {
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
})
