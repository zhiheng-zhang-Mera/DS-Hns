'use strict'

/**
 * Computer Use Runtime: the Electron host bridge.
 *
 * The runtime core (`index.cjs`) is Electron-free on purpose: it takes ports.
 * This module is the only place that knows how to build those ports inside the
 * shell — the shell's own `WebContentsView` becomes the browser page (over CDP
 * through `webContents.debugger`), and the Win32/UIA/GDI drivers become the
 * desktop, accessibility and screenshot ports.
 *
 * Every port is built lazily and behind a try/catch: on a machine without
 * koffi, without PowerShell UI Automation, or without an interactive desktop,
 * the runtime still starts and simply reports which controllers are degraded
 * (plan §37/§38).
 */

const path = require('node:path')

const { createCdpPage, createElectronDebuggerTransport } = require('./drivers/cdp-page.cjs')

/**
 * Wraps a `WebContentsView`/`BrowserWindow` webContents as a page adapter.
 * Returns null when the object cannot be driven, so the caller can fall back.
 */
function pageFromWebContents(webContents, options = {}) {
  if (!webContents || typeof webContents.debugger?.sendCommand !== 'function') return null
  const transport = createElectronDebuggerTransport(webContents)
  const page = createCdpPage({ transport, id: options.id || 'shell-page', clock: options.clock })
  if (typeof transport.onEvent === 'function') {
    transport.onEvent((method, params) => page.handleEvent(method, params))
  }
  page.transport = transport
  return page
}

/**
 * Builds the host object `createComputerUseRuntime` expects.
 *
 * @param {object} options
 * @param {function} [options.getWebContents] () => webContents of the surface the
 *   agent may drive (the visible official/native view)
 * @param {object} [options.clock]
 * @param {function} [options.confirm] destructive-action confirmation
 * @param {object} [options.log] logging options
 */
function createElectronHost(options = {}) {
  const notes = []

  function attempt(label, factory, fallback = null) {
    try {
      return factory()
    } catch (error) {
      notes.push(`${label}: ${error && error.message ? error.message : String(error)}`)
      return fallback
    }
  }

  const win32 = attempt('win32 driver', () => {
    const { createWin32Driver } = require('./drivers/win32.cjs')
    return createWin32Driver({})
  })
  const uia = attempt('uia driver', () => {
    const { createUiaDriver } = require('./drivers/uia.cjs')
    return createUiaDriver({})
  })
  const screenshot = attempt('screenshot driver', () => {
    const { createScreenshotDriver } = require('./drivers/screenshot.cjs')
    return createScreenshotDriver({})
  })

  function currentPage() {
    if (typeof options.getWebContents !== 'function') return null
    try {
      const webContents = options.getWebContents()
      if (!webContents || webContents.isDestroyed?.()) return null
      if (options.page && options.page.webContents === webContents) return options.page
      return pageFromWebContents(webContents, { clock: options.clock })
    } catch (error) {
      notes.push(`page attach: ${error && error.message ? error.message : String(error)}`)
      return null
    }
  }

  return {
    /** The ports the runtime consumes; a null port simply degrades its controller. */
    host: {
      // The visible surface can change (Daily view vs Work view), so the page is
      // re-attached per run instead of being frozen at construction time.
      getPage: currentPage,
      desktop: win32,
      accessibility: uia,
      screenshot,
      confirm: options.confirm,
      workspace: options.workspace || null,
      planner: options.planner,
      cwd: options.cwd
    },
    notes,
    drivers: { win32, uia, screenshot },
    refreshPage: currentPage
  }
}

module.exports = { createElectronHost, pageFromWebContents, path }
