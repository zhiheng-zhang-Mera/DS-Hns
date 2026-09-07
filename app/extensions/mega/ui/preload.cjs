'use strict'
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('megaTools', {
  snapshot: () => ipcRenderer.invoke('mega:snapshot'),
  addTask: (payload) => ipcRenderer.invoke('mega:add-task', payload),
  cancelTask: (id) => ipcRenderer.invoke('mega:cancel-task', id),
  clearPending: () => ipcRenderer.invoke('mega:clear-pending'),
  removeTasks: (ids) => ipcRenderer.invoke('mega:remove-tasks', ids),
  updateScheduler: (patch) => ipcRenderer.invoke('mega:update-scheduler', patch),
  updateSettings: (patch) => ipcRenderer.invoke('mega:update-settings', patch),
  fetchBalance: () => ipcRenderer.invoke('mega:balance'),
  pickWorkspace: () => ipcRenderer.invoke('mega:pick-workspace'),
  pickSound: () => ipcRenderer.invoke('mega:pick-sound'),
  openMain: () => ipcRenderer.invoke('mega:open-main'),
  onChanged: (callback) => ipcRenderer.on('mega:changed', () => callback())
})
