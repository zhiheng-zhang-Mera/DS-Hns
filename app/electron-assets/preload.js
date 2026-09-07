'use strict'
const { contextBridge } = require('electron')

contextBridge.exposeInMainWorld('dsDesktop', {
  isElectron: true,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  }
})
