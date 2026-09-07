'use strict'
const { contextBridge, ipcRenderer } = require('electron')

/**
 * Minimal, sandbox-safe bridge shared by every window of the DS-Harness shell
 * (the dsh Web view, the 调度中心 views, and the hidden audio host).
 *
 * window.dsDesktop = {
 *   isElectron, versions,
 *   player: {
 *     play(payload)          // renderer -> main: ask main to play a URL (settings preview)
 *     onPlayRequest(cb)      // main -> renderer (audio-host window): actually play
 *   }
 * }
 */
contextBridge.exposeInMainWorld('dsDesktop', {
  isElectron: true,
  versions: {
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome
  },
  platform: process.platform,
  nav: {
    // 页内导航 → 主进程(替代被移除的系统菜单栏)
    open(kind) {
      ipcRenderer.send('ds-nav', kind)
    }
  },
  workspace: {
    // 项目工作区:选择目录(系统对话框)与用资源管理器打开
    pickDir() {
      return ipcRenderer.invoke('ds-pick-dir')
    },
    openDir(p) {
      if (typeof p === 'string' && p) ipcRenderer.send('ds-open-path', p)
    }
  },
  player: {
    play(payload) {
      ipcRenderer.send('ds-player:play', payload)
    },
    onPlayRequest(callback) {
      ipcRenderer.on('ds-player:play-request', (_event, payload) => {
        try {
          callback(payload)
        } catch {
          /* never break the host */
        }
      })
    }
  }
})
