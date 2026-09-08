'use strict'
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('megaTools', {
  snapshot: () => ipcRenderer.invoke('mega:snapshot'),
  addTask: (payload) => ipcRenderer.invoke('mega:add-task', payload),
  reorderTask: (id, move) => ipcRenderer.invoke('mega:reorder-task', id, move),
  cancelTask: (id) => ipcRenderer.invoke('mega:cancel-task', id),
  clearPending: () => ipcRenderer.invoke('mega:clear-pending'),
  removeTasks: (ids) => ipcRenderer.invoke('mega:remove-tasks', ids),
  updateScheduler: (patch) => ipcRenderer.invoke('mega:update-scheduler', patch),
  refreshHardware: () => ipcRenderer.invoke('mega:refresh-hardware'),
  updateSettings: (patch) => ipcRenderer.invoke('mega:update-settings', patch),
  fetchBalance: () => ipcRenderer.invoke('mega:balance'),
  pickWorkspace: () => ipcRenderer.invoke('mega:pick-workspace'),
  pickSound: () => ipcRenderer.invoke('mega:pick-sound'),
  openMain: () => ipcRenderer.invoke('mega:open-main'),
  openTools: () => ipcRenderer.invoke('mega:open-tools'),
  toggleDock: () => ipcRenderer.invoke('mega:dock-toggle'),
  setDockExpanded: (expanded) => ipcRenderer.invoke('mega:dock-expand', Boolean(expanded)),
  hideDock: () => ipcRenderer.invoke('mega:dock-hide'),
  // Compatibility alias for the retired small companion widget.
  hideWidget: () => ipcRenderer.invoke('mega:dock-hide'),
  onChanged: (callback) => ipcRenderer.on('mega:changed', () => callback())
})
