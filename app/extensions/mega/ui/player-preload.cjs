'use strict'
const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('megaPlayer', {
  onPlay: (callback) => ipcRenderer.on('mega:play', (_event, payload) => callback(payload))
})
