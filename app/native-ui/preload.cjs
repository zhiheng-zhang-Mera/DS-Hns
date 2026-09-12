'use strict'

/**
 * HNS Native Frontend preload (Update-Plan/Dual-UI.md 任务 6 / 任务 8).
 *
 * The native renderer runs sandboxed with context isolation and gets exactly one
 * capability: this bridge. It cannot require(), cannot touch the filesystem and
 * has no reference to the official renderer - the main process only ever hands it
 * normalized HNS model data (任务 9) and a declarative theme payload.
 *
 * Every channel is a fixed string used in one direction; there is no generic
 * "invoke anything" surface, so the renderer cannot reach a route the main
 * process did not intend to expose.
 */
const { contextBridge, ipcRenderer } = require('electron')

function on(channel, callback) {
  if (typeof callback !== 'function') return () => {}
  const handler = (_event, payload) => {
    try {
      callback(payload)
    } catch (error) {
      // A renderer callback that throws must not take the IPC listener with it.
      console.error('[hns-native] event handler failed', channel, error)
    }
  }
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

contextBridge.exposeInMainWorld('hnsNative', {
  /** Frontend mode (Daily / Work) — read, switch, and observe. */
  mode: {
    get: () => ipcRenderer.invoke('hns:native-mode'),
    set: (mode) => ipcRenderer.invoke('hns:native-set-mode', String(mode || '')),
    toggle: () => ipcRenderer.invoke('hns:native-toggle-mode'),
    onChange: (callback) => on('hns:native-mode-changed', callback)
  },
  /** The normalized conversation model. Never a backend route or a DOM read. */
  session: {
    snapshot: (sessionId) => ipcRenderer.invoke('hns:native-snapshot', sessionId ? { sessionId } : {}),
    create: () => ipcRenderer.invoke('hns:native-create-session'),
    select: (sessionId) => ipcRenderer.invoke('hns:native-select-session', { sessionId: String(sessionId || '') }),
    send: (sessionId, prompt) => ipcRenderer.invoke('hns:native-send', { sessionId: String(sessionId || ''), prompt: String(prompt || '') }),
    cancel: (sessionId) => ipcRenderer.invoke('hns:native-cancel', { sessionId: String(sessionId || '') }),
    /** The main process pushes a fresh snapshot whenever the backend advanced. */
    onChange: (callback) => on('hns:native-changed', callback),
    /** A native-side failure is reported so the shell can fall back to Work Mode. */
    reportFailure: (reason) => ipcRenderer.invoke('hns:native-failure', { reason: String(reason || 'unknown') })
  },
  /** Theme: the same declarative payload the Mega dock consumes. */
  theme: {
    paint: () => ipcRenderer.invoke('hns:native-theme'),
    onApply: (callback) => on('hns:native-theme-apply', callback),
    /** Live geometry for theme validation; measured by this renderer, never read from it. */
    reportRegions: (payload) => ipcRenderer.send('hns:native-regions', payload || {}),
    onProbeRegions: (callback) => on('hns:native-probe-regions', callback)
  },
  /** Capability + compatibility state, for the diagnostics strip. */
  diagnostics: {
    describe: () => ipcRenderer.invoke('hns:native-diagnostics')
  }
})
