'use strict'

/**
 * The system floating orb: a small always-on-top window of ours that shows Mega's health over **every**
 * application, not only over DS-Hns's own window.
 *
 * The user asked for exactly this ("可以做成系统悬浮球吗？"), and it is the one shape this product can offer
 * without touching anything it does not own: a `BrowserWindow` with our own document, drawn above whatever the
 * user is working in. Nothing is injected into the official renderer and nothing in it is styled — the same
 * rule the wallpaper layer follows, for the same reason.
 *
 * Three properties make an always-on-top window a ball rather than an interruption, and all three are
 * structural rather than configurable:
 *
 *   1. **It takes nothing it is not offered.** `setIgnoreMouseEvents(true, { forward: true })` is the default
 *      state: every click, wheel and drag goes to the window below, while the renderer still sees the pointer
 *      move so it can tell us when the cursor is over the ball or its panel. Only then is the window made
 *      interactive, and only while the cursor stays there. The window is created `focusable: false` and stays
 *      that way while it is a ball — clicking it cannot take the keyboard from what the user is typing in — with
 *      **one** exception, and it is a deliberate one: an **open panel** is focusable, because it contains the
 *      new-task form and a window that cannot be focused cannot be typed into at all (see `syncFocusable`).
 *   2. **It is never bigger than what it draws.** The window is the ball plus, while the panel is open, the
 *      panel — plus a few transparent pixels of margin for the shadow. That is what lets it be transparent and
 *      always on top without becoming a pane of glass over the desktop: there is nothing in it to block.
 *   3. **It grows toward the middle of the screen.** The panel's side is decided by which half the ball is in,
 *      the same rule the in-UI orb follows (`app/plugins/mega-core/lib/client.js`), and the window is then
 *      re-placed so the ball does not move on screen and the panel takes the room between the ball and the
 *      middle. Dragging moves the window, so the ball is exactly where the pointer left it.
 *
 * The part with rules in it — `layoutOrbWindow` — is pure: screen geometry in, window bounds and offsets out.
 * Everything else is that geometry with a `BrowserWindow` attached, and every method answers instead of
 * throwing: a ball that cannot be drawn must cost the product nothing (§29).
 */

const fs = require('node:fs')
const path = require('node:path')

/** The ball's size, in px. Larger than the in-UI orb: this one is aimed at with a mouse from across a desk. */
const BALL_SIZE = 44

/** Transparent breathing room inside the window, so the ball's shadow is not clipped. */
const MARGIN = 8

/** The gap between the ball and the panel. */
const GAP = 10

/** How close to an edge a dragged ball has to be released to snap there. */
const EDGE_SNAP = 48

/** Where the ball sits when nothing has been stored: this far in from the work area's corner. */
const DEFAULT_INSET = 16

/** A panel smaller than this is not a panel any more. */
const PANEL_MIN_WIDTH = 200
const PANEL_MIN_HEIGHT = 120

/** The state file's schema. */
const ORB_FILE_VERSION = 1

function clamp(value, low, high) {
  if (high < low) return low
  return Math.min(high, Math.max(low, value))
}

/** Whether two rectangles are the same one, so a window is never reshaped for nothing. */
function sameBounds(a, b) {
  if (!a || !b) return false
  return round(a.x) === round(b.x) && round(a.y) === round(b.y)
    && round(a.width) === round(b.width) && round(a.height) === round(b.height)
}

function round(value) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.round(number) : 0
}

/**
 * Where the window goes, and where the ball and the panel go inside it.
 *
 * Pure on purpose: this is the part with rules in it (which side the panel opens on, how much room it gets,
 * what happens at the edge of the work area), and rules belong where a test can reach them.
 *
 * @param {object} input
 * @param {{x:number,y:number}} input.ball   the ball's **screen** position — the durable truth
 * @param {object} input.workArea            the display's work area (no taskbar)
 * @param {object|null} [input.panel]        the measured panel, or null while the panel is closed
 * @returns {{bounds:object, ballOffset:object, panelOffset:object|null, ball:object, panel:object|null}}
 *          `ball` is where the ball ends up once the window has been clamped into the work area; the caller
 *          stores that, so the two can never disagree about where it is.
 */
function layoutOrbWindow({ ball = { x: 0, y: 0 }, workArea = { x: 0, y: 0, width: 0, height: 0 }, panel = null, ballSize = BALL_SIZE, margin = MARGIN, gap = GAP } = {}) {
  const area = {
    x: round(workArea.x),
    y: round(workArea.y),
    width: Math.max(ballSize + margin * 2, round(workArea.width)),
    height: Math.max(ballSize + margin * 2, round(workArea.height))
  }
  const open = Boolean(panel && Number(panel.width) > 0 && Number(panel.height) > 0)
  // The ball is what is kept inside the work area. The window's transparent margin may hang off the edge of
  // the display, because nothing is drawn in it — which is what lets an edge-snapped ball sit exactly *on*
  // the edge instead of eight invisible pixels inside it.
  const ballX = clamp(round(ball.x), area.x, area.x + area.width - ballSize)
  const ballY = clamp(round(ball.y), area.y, area.y + area.height - ballSize)

  if (!open) {
    const size = ballSize + margin * 2
    const bounds = {
      x: ballX - margin,
      y: ballY - margin,
      width: size,
      height: size
    }
    const ballOffset = { x: margin, y: margin }
    return { bounds, ballOffset, panelOffset: null, ball: { x: ballX, y: ballY }, panel: null }
  }

  // Which side of the ball faces the middle of the work area — the same rule the in-UI orb uses, and for the
  // same reason: the side facing the middle is by construction the roomier one, so "toward the centre" and
  // "into the room" are one instruction rather than two that can disagree.
  const ballCentre = { x: ballX + ballSize / 2, y: ballY + ballSize / 2 }
  const areaCentre = { x: area.x + area.width / 2, y: area.y + area.height / 2 }
  const above = ballCentre.y > areaCentre.y
  const toTheRight = ballCentre.x < areaCentre.x

  // The room the panel may take on the side it chose, measured to the edges of the work area.
  const roomAcross = toTheRight
    ? (area.x + area.width) - (ballX + ballSize) - gap - margin
    : ballX - area.x - gap - margin
  const roomDown = above
    ? ballY - area.y - gap - margin
    : (area.y + area.height) - (ballY + ballSize) - gap - margin
  const panelWidth = clamp(round(panel.width), Math.min(PANEL_MIN_WIDTH, Math.max(PANEL_MIN_WIDTH, roomAcross)), Math.max(PANEL_MIN_WIDTH, roomAcross))
  const panelHeight = clamp(round(panel.height), PANEL_MIN_HEIGHT, Math.max(PANEL_MIN_HEIGHT, roomDown))

  const width = ballSize + gap + panelWidth + margin * 2
  const height = ballSize + gap + panelHeight + margin * 2
  // The ball sits on the side *away* from the middle, so the panel occupies the middle-facing side.
  const ballOffset = {
    x: toTheRight ? margin : margin + panelWidth + gap,
    y: above ? margin + panelHeight + gap : margin
  }
  const panelOffset = {
    x: toTheRight ? ballOffset.x + ballSize + gap : margin,
    y: above ? margin : ballOffset.y + ballSize + gap
  }
  const bounds = {
    x: ballX - ballOffset.x,
    y: ballY - ballOffset.y,
    width,
    height
  }
  return {
    bounds,
    ballOffset,
    panelOffset,
    ball: { x: ballX, y: ballY },
    panel: { width: panelWidth, height: panelHeight, side: above ? 'above' : 'below', across: toTheRight ? 'right' : 'left' }
  }
}

/** Snap a ball's screen position to an edge of the work area, and say which edge it ended up on. */
function snapBallPosition(ball, workArea, { ballSize = BALL_SIZE, edgeSnap = EDGE_SNAP, inset = 0 } = {}) {
  const area = { x: round(workArea.x), y: round(workArea.y), width: round(workArea.width), height: round(workArea.height) }
  const maxX = area.x + area.width - ballSize - inset
  const maxY = area.y + area.height - ballSize - inset
  const x = clamp(round(ball.x), area.x + inset, maxX)
  const y = clamp(round(ball.y), area.y + inset, maxY)
  let edge = null
  if (x - (area.x + inset) <= edgeSnap) edge = 'left'
  else if (maxX - x <= edgeSnap) edge = 'right'
  return { x: edge === 'left' ? area.x + inset : edge === 'right' ? maxX : x, y, edge }
}

/** One stored position, normalised — or null when there is nothing usable in it. */
function normalizeStoredPosition(raw) {
  if (!raw || typeof raw !== 'object') return null
  const x = Number(raw.x)
  const y = Number(raw.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  const edge = raw.edge === 'left' || raw.edge === 'right' ? raw.edge : null
  return { x: Math.round(x), y: Math.round(y), edge }
}

/** Where the ball goes when nobody has moved it: the bottom-right corner of the work area. */
function defaultBallPosition(workArea, { ballSize = BALL_SIZE, inset = DEFAULT_INSET } = {}) {
  return {
    x: round(workArea.x) + Math.max(0, round(workArea.width) - ballSize - inset),
    y: round(workArea.y) + Math.max(0, round(workArea.height) - ballSize - inset),
    edge: 'right'
  }
}

/**
 * The ball's position on disk.
 *
 * Screen coordinates, unlike the in-UI orb (which stores distances from the corner of the layer it lives in):
 * this ball's layer *is* the desktop, and the desktop's origin does not move. A file is still the right place
 * for it rather than `localStorage`, because the window outlives any page.
 *
 * @param {string} file
 */
function createOrbState(file) {
  return {
    file,
    read() {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
        return normalizeStoredPosition(parsed?.position)
      } catch {
        return null
      }
    },
    write(position) {
      const normalized = normalizeStoredPosition(position)
      if (!normalized) return { ok: false, reason: 'the orb position needs a finite x and y' }
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, `${JSON.stringify({ version: ORB_FILE_VERSION, position: normalized }, null, 2)}\n`, 'utf8')
        return { ok: true, position: normalized }
      } catch (error) {
        return { ok: false, reason: `the orb position could not be written: ${error?.message || error}` }
      }
    }
  }
}

/**
 * The window itself.
 *
 * @param {object}   options
 * @param {object}   options.electron           `{ BrowserWindow, screen }` — the shell's own modules
 * @param {Function} [options.log]
 * @param {string}   [options.documentPath]
 * @param {string}   [options.preloadPath]
 * @param {object}   [options.state]            `createOrbState(...)`
 * @param {boolean}  [options.enabled]
 * @param {Function} [options.workAreaOf]       test seam: (point) => work area
 */
function createSystemOrb({
  electron = null,
  log = () => {},
  documentPath = path.join(__dirname, 'ui', 'orb.html'),
  preloadPath = path.join(__dirname, 'ui', 'orb-preload.cjs'),
  state = null,
  enabled = true,
  ballSize = BALL_SIZE,
  workAreaOf = null
} = {}) {
  const BrowserWindow = electron?.BrowserWindow || null
  const screen = electron?.screen || null

  let window_ = null
  let ready = false
  /**
   * `null` until the window's mouse style has been written at least once.
   *
   * A new window is *interactive* by default, so "the answer is false" and "the window is already not
   * interactive" are different states — and skipping the first write because the target value happens to be
   * `false` is exactly how a ball ends up swallowing clicks it was never meant to take.
   */
  let interactive = null
  /** Whether the cursor is on something of ours, and whether a drag is in progress (see `syncInteractive`). */
  let hovering = false
  let dragging = false
  /**
   * `null` until the window's focusability has been written at least once.
   *
   * The same rule `interactive` follows: a new `BrowserWindow` is focusable by default, so "the answer is false"
   * and "the window is already not focusable" are different states.
   */
  let focusable = null
  let position = null
  let open = false
  let panel = null
  let layout = null
  let drag = null
  let lastError = null

  /** The work area the ball is in: the display it sits on, or the primary one when it is nowhere yet. */
  function workAreaOfPoint(point) {
    if (typeof workAreaOf === 'function') return workAreaOf(point)
    if (!screen) return { x: 0, y: 0, width: 1920, height: 1080 }
    try {
      const display = point && Number.isFinite(point.x) && Number.isFinite(point.y)
        ? screen.getDisplayMatching({ x: round(point.x), y: round(point.y), width: ballSize, height: ballSize })
        : screen.getPrimaryDisplay()
      return display?.workArea || { x: 0, y: 0, width: 1920, height: 1080 }
    } catch (error) {
      lastError = String(error?.message || error)
      return { x: 0, y: 0, width: 1920, height: 1080 }
    }
  }

  function live() {
    return Boolean(window_ && typeof window_.isDestroyed === 'function' && !window_.isDestroyed())
  }

  function contents() {
    if (!live()) return null
    try {
      const target = window_.webContents
      return target && typeof target.send === 'function' ? target : null
    } catch {
      return null
    }
  }

  /** What the document is told on every change. One payload, one shape. */
  function payload(view) {
    return {
      ok: true,
      open,
      ball: layout?.ballOffset || { x: MARGIN, y: MARGIN },
      ballSize,
      panel: layout?.panelOffset
        ? {
          offset: layout.panelOffset,
          width: layout.panel?.width,
          height: layout.panel?.height,
          side: layout.panel?.side,
          across: layout.panel?.across
        }
        : null,
      view: view || null
    }
  }

  /** Tell the document what to draw. A window that is not up yet simply misses a frame. */
  function push(payloadValue) {
    const target = contents()
    if (!target || !ready) return false
    try {
      target.send('mega:orb-state', payloadValue)
      return true
    } catch (error) {
      lastError = String(error?.message || error)
      return false
    }
  }

  /**
   * The one thing that makes an always-on-top window safe: everything goes through unless we opt in.
   *
   * `syncInteractive` decides, and it decides from **three** facts rather than one: the cursor being on
   * something of ours, a drag being in progress, and the panel being open. The first version only looked at
   * the cursor, and that is what made clicking flicker: opening the panel resizes and re-places the window, so
   * for a frame or two the cursor is over the *margin* instead of the ball — hover went false, the window
   * became click-through, the forwarded pointer move found the cursor over the ball again, and the two states
   * chased each other. An open panel or an active drag is an unambiguous "the user is using this", so neither
   * depends on a hit test that can change under it.
   *
   * The native call is made only when the answer changes: `setIgnoreMouseEvents` is a window-style write, and
   * a transparent topmost window that re-writes its style every frame is a window that flickers.
   */
  function syncInteractive() {
    const next = Boolean(hovering || dragging || open)
    if (next === interactive) return interactive
    interactive = next
    if (!live()) return interactive
    try {
      if (typeof window_.setIgnoreMouseEvents !== 'function') return interactive
      window_.setIgnoreMouseEvents(!next, { forward: true })
    } catch (error) {
      lastError = String(error?.message || error)
    }
    return interactive
  }

  /** The renderer says whether the cursor is on the ball or the panel. */
  function setInteractive(value) {
    // A Windows ignore-mouse style change can emit mouseleave while the cursor
    // remains on the ball. Do not remove its native hit target in that case.
    // Verify the drawn circle, not the transparent window margin; unavailable
    // cursor evidence keeps the original fail-open-to-the-desktop behavior.
    if (value !== true && hovering && live() && position) {
      try {
        const cursor = screen?.getCursorScreenPoint?.()
        const radius = ballSize / 2
        if (Number.isFinite(cursor?.x) && Number.isFinite(cursor?.y) &&
            Math.hypot(cursor.x - position.x - radius, cursor.y - position.y - radius) < radius) {
          return syncInteractive()
        }
      } catch { /* do not latch input when the native cursor cannot be read */ }
    }
    hovering = value === true
    return syncInteractive()
  }

  /**
   * The one thing that makes this window *typable*: it is focusable exactly while the panel is open.
   *
   * The ball is `focusable: false` for a good reason — a status light must not be able to take the keyboard away
   * from whatever the user is typing in. An **open panel** is a different thing: it holds the new-task form, and a
   * window that cannot be focused cannot be typed into at all. That is the user's report ("悬浮球的入口打开窗口后
   * 无法编辑") stated as a property of the window rather than of the form: the form was fine, the window could not
   * take a keystroke. So the panel borrows focusability for its own duration and hands it back when it closes —
   * which keeps the ball's rule intact for the state the ball is actually in, and is why this is checked on every
   * open and close rather than configured once.
   *
   * Order matters when it is taken away: Windows does **not** deactivate an already-active window when the
   * no-activate style is added, so a window that keeps focus while it stops accepting keys is how the user's next
   * few keystrokes disappear. Focus is dropped first, then the style.
   *
   * The native call is made only when the answer changes, for the reason `syncInteractive` gives.
   */
  function syncFocusable() {
    const next = Boolean(open)
    if (next === focusable) return focusable
    focusable = next
    if (!live()) return focusable
    try {
      if (!next && typeof window_.isFocused === 'function' && window_.isFocused() && typeof window_.blur === 'function') window_.blur()
      if (typeof window_.setFocusable === 'function') window_.setFocusable(next)
      if (next && typeof window_.focus === 'function') window_.focus()
    } catch (error) {
      lastError = String(error?.message || error)
    }
    return focusable
  }

  /** Recompute the window from the ball's position and the panel (when open), then draw it. */
  function apply({ view = null } = {}) {
    if (!live() || !position) return { ok: false, reason: 'no_ball' }
    const workArea = workAreaOfPoint(position)
    layout = layoutOrbWindow({ ball: position, workArea, panel: open ? panel : null, ballSize })
    // The clamped layout is the truth: keeping the ball's *pre-clamp* position would leave the stored value
    // and the drawn ball disagreeing the moment it is pushed against an edge of the work area.
    position = { ...layout.ball, edge: position.edge }
    try {
      // Only when it actually changed. A `setBounds` on a transparent, always-on-top window is a native
      // reshape, and doing it on every state push (or worse, on every pointer move of a drag) is a visible
      // flicker for no reason at all.
      if (!sameBounds(window_.getBounds?.(), layout.bounds)) window_.setBounds(layout.bounds)
    } catch (error) {
      lastError = String(error?.message || error)
      return { ok: false, reason: lastError }
    }
    push(payload(view))
    return { ok: true, bounds: layout.bounds }
  }

  function persist() {
    if (!state || !position) return { ok: false, reason: 'nothing to store' }
    try {
      return state.write(position)
    } catch (error) {
      lastError = String(error?.message || error)
      return { ok: false, reason: lastError }
    }
  }

  function create() {
    if (!enabled) return { ok: false, reason: 'disabled' }
    if (live()) return { ok: true, existing: true }
    if (!BrowserWindow) return { ok: false, reason: 'no BrowserWindow in this build' }
    const stored = (() => {
      try {
        return typeof state?.read === 'function' ? normalizeStoredPosition(state.read()) : null
      } catch (error) {
        lastError = String(error?.message || error)
        return null
      }
    })()
    const workArea = workAreaOfPoint(stored)
    position = stored ? snapBallPosition(stored, workArea, { ballSize }) : defaultBallPosition(workArea, { ballSize })
    const closed = layoutOrbWindow({ ball: position, workArea, ballSize })
    try {
      window_ = new BrowserWindow({
        ...closed.bounds,
        show: false,
        frame: false,
        transparent: true,
        hasShadow: false,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        // The whole point: it never participates in focus, so a click on the ball cannot take the keyboard
        // away from whatever the user is typing in.
        focusable: false,
        alwaysOnTop: true,
        autoHideMenuBar: true,
        backgroundColor: '#00000000',
        /**
         * **Deliberately not `parent: mainWindow`.**
         *
         * The first version parented the ball to the product window, which is exactly wrong for a *system*
         * ball: on Windows an owned window's z-order belongs to its owner, so `alwaysOnTop` is not honoured
         * and the ball can never cover another application — which is what the user reported ("悬浮球没有盖在
         * 其它应用上"). The ball is a top-level window; it is destroyed with the extension, which is what the
         * parent relationship was buying.
         */
        webPreferences: {
          preload: preloadPath,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          backgroundThrottling: true
        }
      })
    } catch (error) {
      window_ = null
      lastError = String(error?.message || error)
      log(`the system orb could not be created: ${lastError}`)
      return { ok: false, reason: lastError }
    }
    try {
      if (typeof window_.setFocusable === 'function') window_.setFocusable(false)
      if (typeof window_.setAlwaysOnTop === 'function') {
        // The level is a hint some platforms ignore; Windows maps it to the window's own topmost style.
        try {
          window_.setAlwaysOnTop(true, 'screen-saver')
        } catch {
          window_.setAlwaysOnTop(true)
        }
      }
      if (typeof window_.setVisibleOnAllWorkspaces === 'function') window_.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
      if (typeof window_.setMenuBarVisibility === 'function') window_.setMenuBarVisibility(false)
    } catch { /* each of these is a nicety; the mechanism is alwaysOnTop + ignore-mouse-events */ }
    // Out of the way to begin with, and *staying* out of the way is the default state. Both answers are written
    // once here rather than left as "whatever a new window happens to be".
    hovering = false
    focusable = null
    syncInteractive()
    syncFocusable()
    window_.webContents.on('did-finish-load', () => {
      ready = true
      apply()
    })
    window_.webContents.on('render-process-gone', (_event, details) => {
      ready = false
      lastError = `renderer gone: ${JSON.stringify(details)}`
      log(`the system orb renderer stopped: ${lastError}`)
    })
    window_.on('closed', () => {
      window_ = null
      ready = false
      // Unknown again: the next window's style has never been written either.
      interactive = null
      focusable = null
    })
    window_.loadFile(documentPath).catch((error) => {
      lastError = String(error?.message || error)
      log(`the system orb document could not be loaded: ${lastError}`)
    })
    try {
      if (!window_.isVisible()) window_.showInactive()
    } catch { /* a window that cannot be shown is reported by describe() */ }
    apply()
    return { ok: true, bounds: closed.bounds }
  }

  return {
    BALL_SIZE: ballSize,
    create,
    /**
     * Open or close the panel.
     *
     * Opening is what makes the window grow: `layoutOrbWindow` places the ball on the side away from the
     * middle and the panel toward it, so the growth is in the direction the user asked for and the ball does
     * not move on screen.
     */
    setOpen(value, { view = null } = {}) {
      open = value === true
      if (!open) panel = null
      const result = apply({ view })
      // An open panel is an unambiguous "the user is using this", so the window stays interactive for as long
      // as it is open (see `syncInteractive`) — and, for the same reason, keyboard-capable while it is open
      // (see `syncFocusable`: the panel holds a form).
      syncInteractive()
      syncFocusable()
      return result
    },
    /** The renderer's measured panel. A request, answered with the size it actually got. */
    setPanelSize(measured, { view = null } = {}) {
      panel = measured && Number(measured.width) > 0 && Number(measured.height) > 0
        ? { width: round(measured.width), height: round(measured.height) }
        : null
      const result = apply({ view })
      return { ...result, panel: layout?.panel || null }
    },
    /** Draw a new snapshot without touching the geometry. */
    render(view) {
      return push(payload(view))
    },
    /** The same payload the renderer gets, for a caller that is answering a request instead of pushing. */
    snapshot(view) {
      return payload(view)
    },
    /**
     * Drag: press, move, release.
     *
     * The window follows the pointer, so the ball does — and the ball's new position is taken from the
     * window's bounds plus its offset inside them rather than from the pointer directly. That is what keeps
     * "where the ball is" one number instead of two that can drift apart.
     */
    dragStart(point) {
      if (!position) return { ok: false, reason: 'no_ball' }
      dragging = true
      syncInteractive()
      drag = { startX: round(point?.x), startY: round(point?.y), ball: { ...position } }
      return { ok: true }
    },
    dragTo(point) {
      if (!drag || !live()) return { ok: false, reason: 'not_dragging' }
      const offsetX = round(point?.x) - drag.startX
      const offsetY = round(point?.y) - drag.startY
      const workArea = workAreaOfPoint(drag.ball)
      position = {
        x: clamp(drag.ball.x + offsetX, workArea.x, workArea.x + workArea.width - ballSize),
        y: clamp(drag.ball.y + offsetY, workArea.y, workArea.y + workArea.height - ballSize),
        edge: null
      }
      const applied = apply()
      return { ok: applied.ok !== false, position: { ...position } }
    },
    /** Release: snap to an edge when it is close enough, store the result, and redraw. */
    dragEnd() {
      drag = null
      dragging = false
      if (!position) return { ok: false, reason: 'no_ball' }
      position = snapBallPosition(position, workAreaOfPoint(position), { ballSize })
      // Applied *before* storing, because the layout clamps the ball and that clamp is part of where it is:
      // storing the pre-clamp number would leave the file and the drawn ball disagreeing by a few pixels.
      apply()
      const stored = persist()
      syncInteractive()
      return { ok: true, position: { ...position }, stored: stored.ok !== false }
    },
    setInteractive,
    describe() {
      return {
        ok: true,
        enabled,
        visible: live(),
        ready,
        interactive,
        // Whether the window can take the keyboard: true exactly while the panel is open (`syncFocusable`).
        focusable: focusable === true,
        open,
        panel: layout?.panel || null,
        position: position ? { ...position } : null,
        bounds: layout?.bounds || null,
        lastError
      }
    },
    stop() {
      if (!live()) return { ok: true, stopped: false }
      const closing = window_
      window_ = null
      ready = false
      try {
        closing.destroy()
      } catch (error) {
        lastError = String(error?.message || error)
        return { ok: false, reason: lastError }
      }
      return { ok: true, stopped: true }
    },
    // A seam for the tests: the geometry as computed, without reaching into the window.
    layout: () => layout
  }
}

module.exports = {
  createSystemOrb,
  createOrbState,
  layoutOrbWindow,
  snapBallPosition,
  normalizeStoredPosition,
  defaultBallPosition,
  BALL_SIZE,
  MARGIN,
  GAP,
  EDGE_SNAP,
  DEFAULT_INSET,
  ORB_FILE_VERSION
}
