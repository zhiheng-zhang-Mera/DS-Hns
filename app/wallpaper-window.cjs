'use strict'

/**
 * The wallpaper window — the user's picture over the whole application interface, and the one
 * shape in this Electron build that can carry it without taking anything away.
 *
 * A background has to be drawn *over* the official page to be seen at all: every other surface
 * DS-Hns owns is behind that page (the shell) or beside it (the dock). The previous round drew it
 * in a `WebContentsView` stacked above the page, and that shape cannot be made harmless here —
 * `View` has no input API at all (`WebContentsView` neither), so a view above the page is a real
 * hit target wherever it covers. The layer that was meant to be a background swallowed every click
 * on the official UI, which is exactly the defect this module removes. Evidence, from this build:
 *
 *   electron 43.4.0
 *   WebContentsView.setIgnoreMouseEvents: undefined
 *   View methods: addChildView children getBounds getVisible removeChildView
 *                 setBackgroundBlur setBackgroundColor setBorderRadius setBounds setLayout setVisible
 *   BrowserWindow.setIgnoreMouseEvents: function
 *
 * So the layer is a window, not a view. A window is the one surface this build can make
 * input-transparent, and everything about the way it is created is there to keep it from becoming
 * a second application window:
 *
 *   * **it takes nothing.** `setIgnoreMouseEvents(true)` routes every pointer event to the window
 *     below it, `focusable: false` keeps it out of the keyboard chain, no frame, no shadow, no
 *     taskbar entry, and `showInactive()` means it never activates. The document it loads has no
 *     script at all and `pointer-events: none` on top of that.
 *   * **it cannot block the interface by accident.** If this build ever fails to make the window
 *     mouse-transparent, the window is *not shown* — the interlock is in `syncVisibility()`, not
 *     in a comment — because a layer that can take a click is worse than no layer.
 *   * **it is the whole interface, minus the dock.** The dock is a view *inside* the main window,
 *     so it would sit under this window; its rectangle is cut out of the picture instead
 *     (`setNotch`) and the dock draws the same picture itself, aligned to the same window box
 *     (`dock.css`). Covering the dock would hide it; not cutting it would paint it twice.
 *   * **it is bound to the main window.** Parented, repositioned with the content box, hidden with
 *     it, destroyed with the shell, and created only when there is something to draw.
 *
 * Failure is always a missing background and never a broken product: an unreadable document, a
 * refused stylesheet or a build without `BrowserWindow` all end in "nothing is drawn here", with
 * the reason recorded for the log rather than thrown at the caller.
 */
const path = require('node:path')

/** The document this window loads. No script, no network, `img-src data:` only. */
const WALLPAPER_DOCUMENT = path.join(__dirname, 'extensions', 'mega', 'ui', 'wallpaper-window.html')

/**
 * The dock's own strip is not cut when there is no dock to protect: the picture covers everything.
 *
 * `:root:root` rather than `:root` for the same reason the picture's stylesheet uses it: the document
 * declares its own defaults, and `insertCSS` loses to them at equal specificity (the inserted sheet
 * sits before the document's own). This is the measured reason a layer can be handed a stylesheet and
 * still draw nothing.
 */
const NO_NOTCH = ':root:root { --wp-notch-x: 100%; --wp-notch-y: 0px; }'

/** One CSS length per number, so a geometry that arrived as a float cannot become a broken polygon. */
function pixels(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 0
  return Math.max(0, Math.round(numeric))
}

function normalizeBounds(value) {
  if (!value || typeof value !== 'object') return null
  const width = Math.round(Number(value.width))
  const height = Math.round(Number(value.height))
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
  return {
    x: Math.round(Number(value.x) || 0),
    y: Math.round(Number(value.y) || 0),
    width,
    height
  }
}

/**
 * The stylesheet one notch rectangle means: an L-shaped cut of everything from `(x, y)` to the
 * window's bottom-right corner, which is exactly the dock's rectangle — it touches both of those
 * edges by construction (`dock/geometry.cjs`). The polygon lives in the document; this writes the
 * two numbers it is made of.
 */
function notchCss(rect) {
  if (!rect || typeof rect !== 'object') return NO_NOTCH
  const x = Number(rect.x)
  const y = Number(rect.y)
  if (!Number.isFinite(x) || !Number.isFinite(y) || x <= 0) return NO_NOTCH
  return `:root:root { --wp-notch-x: ${pixels(x)}px; --wp-notch-y: ${pixels(y)}px; }`
}

/**
 * Create the wallpaper window manager.
 *
 * @param {object}   options
 * @param {Function} options.getParentWindow  () => BrowserWindow|null — the main window
 * @param {Function} options.getContentBounds () => {x,y,width,height}|null — its content box, on screen
 * @param {Function} [options.log]
 * @param {object}   [options.electron]       { BrowserWindow }
 * @param {boolean}  [options.enabled]        the `DSH_OFFICIAL_OVERLAY=0` opt-out
 * @param {string}   [options.documentPath]   test seam
 */
function createWallpaperWindow({
  getParentWindow,
  getContentBounds,
  log = () => {},
  electron = null,
  enabled = true,
  documentPath = WALLPAPER_DOCUMENT
} = {}) {
  const BrowserWindow = electron?.BrowserWindow || null

  let window_ = null
  let ready = false
  /** The one property that decides whether this window may be on screen at all. */
  let mouseTransparent = false
  /** Whether the shell told us there is a picture; `null` until it does. */
  let drawable = null
  let visible = false
  let cssText = null
  let cssKey = null
  let cssPending = null
  let notchText = NO_NOTCH
  let notchKey = null
  let notchPending = null
  let lastBounds = null
  let lastNotch = null
  const problems = []
  const events = []

  function record(entry) {
    events.push({ at: new Date().toISOString(), ...entry })
    if (events.length > 64) events.splice(0, events.length - 64)
  }

  function note(reason) {
    const text = String(reason)
    problems.push({ at: new Date().toISOString(), reason: text })
    if (problems.length > 16) problems.splice(0, problems.length - 16)
    log(`wallpaper layer: ${text}`)
    record({ event: 'problem', reason: text })
  }

  function live() {
    try {
      return Boolean(window_ && !window_.isDestroyed())
    } catch {
      return false
    }
  }

  function contents() {
    if (!live()) return null
    try {
      const value = window_.webContents
      return value && !value.isDestroyed() ? value : null
    } catch {
      return null
    }
  }

  /** The window's own screen rectangle: the main window's content box, to the pixel. */
  function resolveBounds() {
    let value = null
    try {
      value = typeof getContentBounds === 'function' ? getContentBounds() : null
    } catch (error) {
      note(`the main window's content box could not be read: ${error?.message || error}`)
      return null
    }
    return normalizeBounds(value)
  }

  function create() {
    if (!enabled) return null
    if (live()) return window_
    if (!BrowserWindow) {
      note('this build exposes no BrowserWindow; the wallpaper cannot be drawn over the official UI')
      return null
    }
    let parent = null
    try {
      parent = typeof getParentWindow === 'function' ? getParentWindow() : null
    } catch {
      parent = null
    }
    if (!parent || (typeof parent.isDestroyed === 'function' && parent.isDestroyed())) {
      note('the main window is not available; the wallpaper layer was not created')
      return null
    }
    // Placed at creation, not on the first layout event after it: a window is created with a default
    // size, so a layer that waited for the next resize would put a wrongly-sized rectangle over the
    // interface for as long as that took.
    const initial = resolveBounds()
    try {
      window_ = new BrowserWindow({
        parent,
        show: false,
        ...(initial || {}),
        frame: false,
        transparent: true,
        hasShadow: false,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        focusable: false,
        autoHideMenuBar: true,
        backgroundColor: '#00000000',
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          // A picture that nobody is looking at does not need frames either; the layer is hidden
          // when it is not wanted, and this keeps a minimised window from spending on it.
          backgroundThrottling: true
        }
      })
      if (initial) lastBounds = initial
    } catch (error) {
      note(`the wallpaper window could not be created: ${error?.message || error}`)
      window_ = null
      return null
    }

    // The whole point of the module. A window that cannot be made mouse-transparent is never
    // shown: it would stand between the user and the official interface.
    mouseTransparent = setMouseTransparent(true)
    if (!mouseTransparent) {
      note('this build refused setIgnoreMouseEvents; the wallpaper is not drawn rather than covering the interface')
    }
    try {
      if (typeof window_.setFocusable === 'function') window_.setFocusable(false)
    } catch {}
    try {
      if (typeof window_.setMenuBarVisibility === 'function') window_.setMenuBarVisibility(false)
    } catch {}

    // A document of ours that somehow asked to navigate or to open a window is a defect, and the
    // answer is no in both directions.
    try {
      window_.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    } catch {}
    try {
      window_.webContents.on('will-navigate', (event) => event.preventDefault())
    } catch {}
    window_.webContents.on('render-process-gone', (_event, details) => {
      ready = false
      note(`renderer gone: ${JSON.stringify(details)}`)
    })
    window_.webContents.on('did-finish-load', () => {
      ready = true
      applyCss()
      applyNotch()
      syncVisibility()
    })
    // Showing a window is when a build is most likely to have reset the extended style that makes
    // it transparent to input, so the claim is re-made and the answer decides whether it stays up.
    window_.on('show', () => {
      mouseTransparent = setMouseTransparent(true)
      if (!mouseTransparent) {
        note('the wallpaper window lost mouse transparency when it was shown; it was hidden again')
        hideWindow()
      }
    })
    window_.on('closed', () => {
      window_ = null
      ready = false
      mouseTransparent = false
    })
    record({ event: 'created' })
    window_.loadFile(documentPath).catch((error) => {
      note(`the wallpaper document could not be loaded: ${error?.message || error}`)
    })
    return window_
  }

  function setMouseTransparent(value) {
    if (!live()) return false
    try {
      if (typeof window_.setIgnoreMouseEvents !== 'function') return false
      window_.setIgnoreMouseEvents(value, { forward: false })
      return value
    } catch (error) {
      note(`could not set ignore-mouse-events: ${error?.message || error}`)
      return false
    }
  }

  /** Queue one stylesheet write per key, replacing the previous one instead of leaking it. */
  function writeStylesheet(slot, text) {
    const target = contents()
    if (!target || !ready) return false
    const pending = slot === 'css' ? cssPending : notchPending
    const next = Promise.resolve(pending)
      .catch(() => {})
      .then(async () => {
        const stale = slot === 'css' ? cssKey : notchKey
        if (stale) {
          try {
            await target.removeInsertedCSS(stale)
          } catch {}
          if (slot === 'css') cssKey = null
          else notchKey = null
        }
        if (!text) return null
        const key = await target.insertCSS(text)
        if (slot === 'css') cssKey = key
        else notchKey = key
        return key
      })
      .catch((error) => {
        note(`a wallpaper stylesheet could not be applied: ${error?.message || error}`)
        return null
      })
    if (slot === 'css') cssPending = next
    else notchPending = next
    return true
  }

  function applyCss() {
    return writeStylesheet('css', cssText)
  }

  function applyNotch() {
    return writeStylesheet('notch', notchText)
  }

  function hideWindow() {
    if (!live()) return false
    try {
      if (window_.isVisible()) window_.hide()
      return true
    } catch (error) {
      note(`could not hide the wallpaper window: ${error?.message || error}`)
      return false
    }
  }

  /**
   * Show or hide, never weakening the interlock: the window goes up only when there is a picture,
   * the build made it mouse-transparent, and the layer is switched on.
   */
  function syncVisibility() {
    if (!live()) return false
    const wanted = Boolean(cssText && drawable !== false && mouseTransparent && enabled)
    visible = wanted
    if (!wanted) return hideWindow()
    try {
      if (!window_.isVisible()) window_.showInactive()
      return true
    } catch (error) {
      note(`could not show the wallpaper window: ${error?.message || error}`)
      visible = false
      return false
    }
  }

  /**
   * The picture, as the stylesheet the wallpaper module built for the layer over the official page.
   *
   * `drawable: false` is a complete answer — the window is hidden and, if it never had anything to
   * draw, never created at all. The caller owns that decision (the module that owns the file and
   * the preference answers it), so this side stays a renderer.
   *
   * @param {string} css
   * @param {object} [options]
   * @param {boolean} [options.drawable]
   */
  function paint(css, { drawable: nextDrawable = true } = {}) {
    cssText = typeof css === 'string' && css ? css : null
    drawable = nextDrawable !== false && Boolean(cssText)
    if (!drawable) {
      visible = false
      hideWindow()
      return { ok: true, visible: false }
    }
    const created = create()
    if (!created) {
      visible = false
      return { ok: false, reason: 'wallpaper_window_unavailable' }
    }
    applyCss()
    applyNotch()
    syncVisibility()
    record({ event: 'paint', drawable })
    return { ok: true, visible }
  }

  /**
   * Where the layer's own rectangle is: the main window's content box, on screen.
   *
   * A window is positioned in screen coordinates, so this is where the "content box" of the main
   * window has to be asked for in that space. An unknown box is not fatal — the layer keeps the
   * placement it had and the next layout call repairs it.
   */
  function setBounds(next) {
    const bounds = normalizeBounds(next)
    if (!bounds) return { ok: false, reason: 'no_bounds' }
    lastBounds = bounds
    if (!live()) return { ok: true, bounds, applied: false }
    if (window_.getBounds && JSON.stringify(window_.getBounds()) === JSON.stringify(bounds)) {
      return { ok: true, bounds, applied: false }
    }
    try {
      window_.setBounds(bounds)
      return { ok: true, bounds, applied: true }
    } catch (error) {
      note(`the wallpaper window could not be placed: ${error?.message || error}`)
      return { ok: false, reason: 'set_bounds_failed' }
    }
  }

  /**
   * Cut the dock's own rectangle out of the picture.
   *
   * The dock is a view inside the main window and therefore *under* this window: without the cut
   * the picture would hide the dock, and the dock draws the same picture itself where the cut is.
   * `{ x, y }` is the dock's top-left corner in the window's own coordinates, so the cut always
   * reaches the window's right and bottom edges — the shape the polygon in the document is for.
   *
   * @param {{x: number, y: number}|null} rect
   */
  function setNotch(rect) {
    const next = notchCss(rect)
    const changed = next !== notchText
    notchText = next
    lastNotch = rect && typeof rect === 'object'
      ? { x: pixels(rect.x), y: pixels(rect.y) }
      : null
    if (!changed) return { ok: true, changed: false }
    applyNotch()
    record({ event: 'notch', notch: lastNotch })
    return { ok: true, changed: true }
  }

  /** One call for a layout pass: place the layer and cut the dock out of it. */
  function layout({ bounds = null, notch = null } = {}) {
    const placed = bounds ? setBounds(bounds) : { ok: false, reason: 'no_bounds' }
    const cut = setNotch(notch)
    return { ok: placed.ok || !live(), bounds: placed, notch: cut }
  }

  /** Show or hide without changing the picture: the main window's own visibility drives this. */
  function setVisible(value) {
    if (value === false) {
      visible = false
      return hideWindow()
    }
    return syncVisibility()
  }

  /** Wait for every queued stylesheet write: the honest answer to "is it on screen yet?". */
  async function settle() {
    await Promise.allSettled([cssPending, notchPending].filter(Boolean))
    return { cssKey, notchKey }
  }

  function destroy() {
    if (live()) {
      try {
        if (typeof window_.destroy === 'function') window_.destroy()
        else window_.close()
      } catch {}
    }
    window_ = null
    ready = false
    mouseTransparent = false
    visible = false
    cssKey = null
    notchKey = null
    record({ event: 'destroyed' })
  }

  return {
    create,
    paint,
    setBounds,
    setNotch,
    layout,
    setVisible,
    settle,
    destroy,
    /** Diagnostics: what this layer is, and the two facts that make it safe. */
    describe: () => ({
      enabled,
      created: live(),
      ready,
      visible: live() && visible,
      /** The evidence acceptance looks for: the layer cannot take a pointer event. */
      input: mouseTransparent ? 'passthrough' : 'unavailable',
      focusable: false,
      bounds: lastBounds,
      notch: lastNotch,
      document: documentPath,
      problems: problems.slice(),
      events: events.slice(-16)
    }),
    setEnabled: (value) => {
      enabled = value !== false
      if (!enabled) {
        visible = false
        hideWindow()
      } else {
        syncVisibility()
      }
      return enabled
    },
    isEnabled: () => enabled,
    /** The window itself, for the shell's own lifecycle calls. Not for painting. */
    window: () => (live() ? window_ : null),
    /** Whether the build actually made the layer mouse-transparent. */
    isMouseTransparent: () => mouseTransparent,
    NO_NOTCH
  }
}

module.exports = {
  createWallpaperWindow,
  WALLPAPER_DOCUMENT,
  NO_NOTCH,
  notchCss
}
