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
  openMain: () => ipcRenderer.invoke('mega:open-main'),
  openTools: () => ipcRenderer.invoke('mega:open-tools'),
  toggleDock,
  setDockExpanded,
  // In integrated mode the rail should always remain reachable, so "hide"
  // degrades to collapse instead of removing the whole in-window view.
  hideDock: () => setDockExpanded(false),
  hideWidget: () => setDockExpanded(false),
  onChanged: (callback) => ipcRenderer.on('mega:changed', () => callback())
})
