'use strict'

/**
 * Dock Target Adapter — the single entry point for reaching the Mega dock UI.
 *
 * The product shipped two dock generations: a legacy companion `BrowserWindow`
 * and the current integrated `WebContentsView` owned by `desktop-main.cjs`. The
 * extension used to reach into `dockWindow` directly in a dozen places, so the
 * theme system kept pushing payloads at a window that no longer exists while the
 * integrated dock went unrepainted. That is what this module removes.
 *
 * Two backends, one interface:
 *
 *   integrated  the shell hands over a `dockAdapter` (or a lazy accessor)
 *   window      the extension's own legacy BrowserWindow
 *
 * Callers never learn which one is in play: they ask the adapter for the target,
 * its geometry, its visibility or a screenshot. Nothing below this module is
 * allowed to read `dockWindow` for theme/dock work.
 *
 * The adapter is deliberately duck-typed and never throws: Electron objects
 * disappear (view destroyed, window closed, app quitting) and every accessor
 * degrades to `null` rather than killing the caller.
 */

const INTEGRATED_MODE = 'integrated'
const WINDOW_MODE = 'window'
const DETACHED_MODE = 'detached'

/** Shape returned when nothing is available, so callers can rely on the keys. */
const NO_STATE = Object.freeze({
  mode: DETACHED_MODE,
  integrated: false,
  visible: false,
  expanded: false,
  width: 0,
  height: 0,
  expandedWidth: 0,
  collapsedWidth: 0
})

function isDestroyed(target) {
  if (!target) return true
  try {
    return typeof target.isDestroyed === 'function' ? Boolean(target.isDestroyed()) : false
  } catch {
    // An object that throws on isDestroyed() is not usable as a target.
    return true
  }
}

/** A usable webContents: it can receive `send` and is not destroyed. */
function isUsableWebContents(value) {
  if (!value || isDestroyed(value)) return false
  return typeof value.send === 'function'
}

function callIfPresent(target, method, fallback = null) {
  try {
    if (!target || typeof target[method] !== 'function') return fallback
    const value = target[method]()
    return value === undefined ? fallback : value
  } catch {
    return fallback
  }
}

/**
 * Resolve the integrated backend from the extension context.
 *
 * Accepted forms, in order: a `dockAdapter` object (preferred), a
 * `dockAdapter` function, and the older `dockWebContents` value/accessor kept
 * for compatibility with shells that only expose the webContents.
 */
function resolveIntegrated(ctx) {
  const adapter = ctx?.dockAdapter
  const resolved = typeof adapter === 'function' ? safeCall(adapter) : adapter
  if (resolved && typeof resolved === 'object') return resolved

  const provided = ctx?.dockWebContents
  const contents = typeof provided === 'function' ? safeCall(provided) : provided
  if (isUsableWebContents(contents)) {
    return {
      webContents: () => contents,
      integrated: true,
      // No geometry source: the shell never told us where the view is.
      bounds: () => null,
      visible: null
    }
  }
  return null
}

function safeCall(fn) {
  try {
    return fn()
  } catch {
    return null
  }
}

/**
 * @param {object} options
 * @param {Function} options.getLegacyWindow  () => BrowserWindow | null
 * @param {object}   [options.ctx]            extension context (read lazily)
 * @param {Function} [options.log]
 */
function createDockTarget({ getLegacyWindow = () => null, ctx = null, log = () => {} } = {}) {
  const context = () => (typeof ctx === 'function' ? safeCall(ctx) : ctx)

  function legacyWindow() {
    const win = safeCall(() => getLegacyWindow())
    return isDestroyed(win) ? null : win
  }

  function integratedAdapter() {
    return resolveIntegrated(context())
  }

  /**
   * The webContents every push, repaint, capture and probe must use.
   * Integrated first (that is the shipped configuration), the legacy companion
   * window second (kept working, single code path above this line).
   */
  function getWebContents() {
    const adapter = integratedAdapter()
    if (adapter) {
      const contents = safeCall(() => (typeof adapter.webContents === 'function' ? adapter.webContents() : adapter.webContents))
      if (isUsableWebContents(contents)) return contents
    }
    const win = legacyWindow()
    if (win) {
      const contents = safeCall(() => win.webContents)
      if (isUsableWebContents(contents)) return contents
    }
    return null
  }

  function hasTarget() {
    return Boolean(getWebContents())
  }

  function isIntegrated() {
    return Boolean(integratedAdapter())
  }

  function mode() {
    if (integratedAdapter()) return INTEGRATED_MODE
    if (legacyWindow()) return WINDOW_MODE
    return DETACHED_MODE
  }

  /**
   * Real geometry of the dock surface.
   *
   * Integrated: the shell's `bounds()` (a WebContentsView has no
   * `getContentSize`), falling back to the view's own `getBounds()`.
   * Legacy: the window's content size, read through the same accessor.
   */
  function getBounds() {
    const adapter = integratedAdapter()
    if (adapter) {
      const provided = safeCall(() => (typeof adapter.bounds === 'function' ? adapter.bounds() : adapter.bounds))
      const normalized = normalizeBounds(provided)
      if (normalized) return normalized
    }
    const win = legacyWindow()
    if (win) {
      const size = normalizeSize(safeCall(() => win.getContentSize?.()))
      if (size) {
        const position = normalizePoint(safeCall(() => win.getBounds?.()))
        return { x: position?.x ?? 0, y: position?.y ?? 0, width: size.width, height: size.height }
      }
    }
    return null
  }

  function getSize() {
    const bounds = getBounds()
    return bounds ? [bounds.width, bounds.height] : null
  }

  /**
   * Dock visibility. The integrated dock is a child view of the main window, so
   * it is visible exactly when the shell says so — the shell owns window
   * visibility/minimised state, and a missing answer is `null` (unknown), never a
   * silent `false` that would make the UI look detached.
   */
  function getVisible() {
    const adapter = integratedAdapter()
    if (adapter) {
      const provided = typeof adapter.visible === 'function' ? safeCall(() => adapter.visible()) : adapter.visible
      if (typeof provided === 'boolean') return provided
      if (provided === null || provided === undefined) {
        // No visibility source: a live, non-destroyed view is the best evidence.
        return hasTarget()
      }
    }
    const win = legacyWindow()
    if (win) return Boolean(safeCall(() => win.isVisible()))
    return false
  }

  /** Screenshot of the dock surface only — never the official renderer. */
  async function capturePage(options) {
    const contents = getWebContents()
    if (!contents || typeof contents.capturePage !== 'function') return null
    try {
      const image = options === undefined ? await contents.capturePage() : await contents.capturePage(options)
      return image || null
    } catch (error) {
      log(`dock capture unavailable: ${error?.message || error}`)
      return null
    }
  }

  function send(channel, ...args) {
    const contents = getWebContents()
    if (!contents) return false
    try {
      contents.send(channel, ...args)
      return true
    } catch (error) {
      log(`dock send failed on ${channel}: ${error?.message || error}`)
      return false
    }
  }

  /**
   * Dock state as the theme system must see it. `mode`/`integrated` replace the
   * old `dockWindow != null` test: the integrated dock is a real container with
   * real geometry, not a missing window.
   */
  function getState({ expanded = false, width = 0, expandedWidth = 0, collapsedWidth = 0 } = {}) {
    if (!hasTarget()) return { ...NO_STATE, expanded: Boolean(expanded), expandedWidth, collapsedWidth }
    const bounds = getBounds()
    return {
      mode: mode(),
      integrated: isIntegrated(),
      visible: getVisible(),
      expanded: Boolean(expanded),
      width: bounds ? bounds.width : Number(width) || 0,
      height: bounds ? bounds.height : 0,
      expandedWidth: Number(expandedWidth) || (bounds ? bounds.width : 0),
      collapsedWidth
    }
  }

  return {
    getWebContents,
    getBounds,
    getSize,
    getVisible,
    capturePage,
    send,
    getState,
    hasTarget,
    isIntegrated,
    mode,
    describe: () => ({ mode: mode(), integrated: isIntegrated(), hasTarget: hasTarget(), bounds: getBounds() })
  }
}

function normalizeBounds(value) {
  if (!value || typeof value !== 'object') return null
  const width = Number(value.width)
  const height = Number(value.height)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
  return {
    x: Number.isFinite(Number(value.x)) ? Number(value.x) : 0,
    y: Number.isFinite(Number(value.y)) ? Number(value.y) : 0,
    width,
    height
  }
}

function normalizeSize(value) {
  if (!Array.isArray(value) || value.length < 2) return null
  const width = Number(value[0])
  const height = Number(value[1])
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
  return { width, height }
}

function normalizePoint(value) {
  if (!value || typeof value !== 'object') return null
  const x = Number(value.x)
  const y = Number(value.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return { x, y }
}

module.exports = {
  createDockTarget,
  isDestroyed,
  isUsableWebContents,
  INTEGRATED_MODE,
  WINDOW_MODE,
  DETACHED_MODE
}
