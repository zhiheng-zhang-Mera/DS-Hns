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
  toggleDock,
  setDockExpanded,
  // In integrated mode the rail should always remain reachable, so "hide"
  // degrades to collapse instead of removing the whole in-window view.
  hideDock: () => setDockExpanded(false),
  onChanged: (callback) => ipcRenderer.on('mega:changed', () => callback())
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
