'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  createSystemOrb,
  createOrbState,
  layoutOrbWindow,
  snapBallPosition,
  normalizeStoredPosition,
  defaultBallPosition,
  BALL_SIZE,
  MARGIN,
  GAP
} = require('../../app/extensions/mega/system-orb.cjs')

/**
 * The system floating orb (`app/extensions/mega/system-orb.cjs`).
 *
 * The user asked for a ball that floats over every application, and the properties that make that safe are
 * geometry and window state rather than looks: the window is never bigger than what it draws, it ignores the
 * mouse until the cursor is on the ball or its panel, it never takes focus, and the panel grows toward the
 * middle of the screen from wherever the ball was left. Every one of those is a rule in `layoutOrbWindow` or a
 * call the window manager makes — so every one of them is asserted here, against a stubbed Electron.
 */

const SCREEN = { x: 0, y: 0, width: 1920, height: 1080 }

/** An Electron stand-in with just the window surface this module uses. */
function stubElectron({ workArea = SCREEN } = {}) {
  const instances = []
  class FakeWindow {
    constructor(options = {}) {
      this.options = options
      this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height }
      this.listeners = new Map()
      this.sent = []
      this.ignored = null
      /** Every native ignore-mouse write, so a test can prove it is not re-written for nothing. */
      this.ignoreWrites = 0
      this.focusable = null
      /** Every native focusability write, so a test can prove the keyboard is borrowed once per panel. */
      this.focusableWrites = 0
      this.focused = false
      this.alwaysOnTop = null
      this.visibleOnAllWorkspaces = null
      this.visible = false
      this.destroyed = false
      this.loaded = null
      /** Every bounds write, so a test can prove the window is not reshaped for nothing. */
      this.resizes = 0
      this.webContents = {
        on: (name, handler) => this.listeners.set(`wc:${name}`, handler),
        send: (channel, payload) => { this.sent.push({ channel, payload }) }
      }
      instances.push(this)
    }
    on(name, handler) { this.listeners.set(name, handler) }
    isDestroyed() { return this.destroyed }
    isVisible() { return this.visible }
    getBounds() { return { ...this.bounds } }
    setBounds(next) { this.bounds = { ...next }; this.resizes += 1 }
    setIgnoreMouseEvents(value, options) { this.ignored = { value, options }; this.ignoreWrites += 1 }
    setFocusable(value) { this.focusable = value; this.focusableWrites += 1 }
    isFocused() { return this.focused }
    focus() { this.focused = true }
    blur() { this.focused = false }
    setAlwaysOnTop(value) { this.alwaysOnTop = value }
    setVisibleOnAllWorkspaces(value, options) { this.visibleOnAllWorkspaces = { value, options } }
    setMenuBarVisibility() {}
    showInactive() { this.visible = true }
    loadFile(file) { this.loaded = file; return Promise.resolve() }
    destroy() { this.destroyed = true }
    /** Fire one of the events the module subscribed to. */
    fire(name, ...args) { this.listeners.get(name)?.(...args) }
  }
  return {
    BrowserWindow: FakeWindow,
    screen: {
      getPrimaryDisplay: () => ({ workArea }),
      getDisplayMatching: () => ({ workArea })
    },
    instances,
    last: () => instances[instances.length - 1]
  }
}

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshns-orb-'))
  return { dir, file: path.join(dir, 'state', 'system-orb.json'), dispose: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

test('a closed ball is a window the size of the ball, and nothing else', () => {
  const layout = layoutOrbWindow({ ball: { x: 1500, y: 800 }, workArea: SCREEN })
  assert.deepEqual(layout.bounds, { x: 1500 - MARGIN, y: 800 - MARGIN, width: BALL_SIZE + MARGIN * 2, height: BALL_SIZE + MARGIN * 2 })
  assert.deepEqual(layout.ballOffset, { x: MARGIN, y: MARGIN })
  assert.equal(layout.panelOffset, null)
  assert.deepEqual(layout.ball, { x: 1500, y: 800 })
})

test('the panel opens toward the middle of the screen, from wherever the ball is', () => {
  // Bottom-right: the middle is up and to the left, so the panel takes that side and the ball stays put.
  const bottomRight = layoutOrbWindow({ ball: { x: 1500, y: 800 }, workArea: SCREEN, panel: { width: 340, height: 400 } })
  assert.equal(bottomRight.panel.side, 'above')
  assert.equal(bottomRight.panel.across, 'left')
  assert.deepEqual(bottomRight.ballOffset, { x: MARGIN + 340 + GAP, y: MARGIN + 400 + GAP })
  assert.deepEqual(bottomRight.panelOffset, { x: MARGIN, y: MARGIN })
  assert.deepEqual(bottomRight.ball, { x: 1500, y: 800 }, 'opening the panel must not move the ball')
  assert.equal(bottomRight.bounds.width, BALL_SIZE + GAP + 340 + MARGIN * 2)
  assert.equal(bottomRight.bounds.height, BALL_SIZE + GAP + 400 + MARGIN * 2)

  // Top-left: the middle is down and to the right, so the panel takes *that* side instead.
  const topLeft = layoutOrbWindow({ ball: { x: 40, y: 40 }, workArea: SCREEN, panel: { width: 340, height: 400 } })
  assert.equal(topLeft.panel.side, 'below')
  assert.equal(topLeft.panel.across, 'right')
  assert.deepEqual(topLeft.ballOffset, { x: MARGIN, y: MARGIN })
  assert.deepEqual(topLeft.ball, { x: 40, y: 40 })
})

test('the panel is clamped to the room there is, and the window stays inside the work area', () => {
  const small = { x: 0, y: 0, width: 800, height: 600 }
  const layout = layoutOrbWindow({ ball: { x: 700, y: 500 }, workArea: small, panel: { width: 340, height: 900 } })
  // Above the ball there is the ball's own top edge (500) minus the gap and the margin, so 482 — not 900.
  assert.equal(layout.panel.height, 482)
  assert.equal(layout.panel.width, 340)
  // The ball stays inside the work area, and the far side of the panel does too.
  assert.ok(layout.ball.x >= 0 && layout.ball.y >= 0)
  assert.ok(layout.ball.x + BALL_SIZE <= small.width)
  assert.ok(layout.bounds.y + layout.bounds.height <= small.height)

  // Pushed against the left edge, the ball sits exactly on it and only the window's *transparent* margin hangs
  // off the screen — nothing is drawn there, so nothing is lost.
  const atEdge = layoutOrbWindow({ ball: { x: 0, y: 500 }, workArea: small, panel: { width: 340, height: 300 } })
  assert.equal(atEdge.ball.x, 0)
  assert.equal(atEdge.panel.across, 'right', 'the middle is to the right of a ball on the left edge')
  assert.equal(atEdge.bounds.x, -MARGIN)
})

test('a second display is a work area with an origin, and the ball is measured in it', () => {
  const second = { x: 1920, y: 0, width: 1280, height: 1024 }
  const home = defaultBallPosition(second)
  assert.deepEqual(home, { x: 1920 + 1280 - BALL_SIZE - 16, y: 1024 - BALL_SIZE - 16, edge: 'right' })
  const snapped = snapBallPosition({ x: 1930, y: 900 }, second)
  assert.equal(snapped.edge, 'left', 'near the left edge of the second display, not of the desktop')
  assert.equal(snapped.x, 1920)
  // A position that is nowhere near any display is pulled back into this one rather than lost.
  const pulled = snapBallPosition({ x: 5000, y: 5000 }, second)
  assert.equal(pulled.edge, 'right')
  assert.equal(pulled.x, 1920 + 1280 - BALL_SIZE)
  assert.equal(pulled.y, 1024 - BALL_SIZE)
})

test('the ball\'s position on disk is screen coordinates, and a broken file is no position', () => {
  const { dir, file, dispose } = scratch()
  try {
    const state = createOrbState(file)
    assert.equal(state.read(), null, 'nothing stored yet')
    assert.equal(state.write({ x: 1200.4, y: 300.6, edge: 'right' }).ok, true)
    assert.deepEqual(state.read(), { x: 1200, y: 301, edge: 'right' })
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(stored.version, 1)

    assert.equal(state.write({ x: 'left-ish', y: 12 }).ok, false, 'an unusable position is refused, not stored')
    assert.deepEqual(state.read(), { x: 1200, y: 301, edge: 'right' }, 'and it did not clobber the good one')

    fs.writeFileSync(file, '{ this is not json', 'utf8')
    assert.equal(state.read(), null)
    assert.equal(normalizeStoredPosition({ x: 5, y: 5, edge: 'middle' }).edge, null)
  } finally {
    dispose()
    assert.equal(fs.existsSync(dir), false)
  }
})

test('the window is created always-on-top, never focusable, and ignoring the mouse by default', () => {
  const electron = stubElectron()
  const { file, dispose } = scratch()
  try {
    const orb = createSystemOrb({ electron, log: () => {}, state: createOrbState(file), workAreaOf: () => SCREEN })
    const created = orb.create()
    assert.equal(created.ok, true)
    const win = electron.last()
    assert.equal(win.options.alwaysOnTop, true)
    assert.equal(win.options.focusable, false, 'the ball must never take the keyboard')
    assert.equal(win.options.skipTaskbar, true)
    assert.equal(win.options.frame, false)
    assert.equal(win.options.transparent, true)
    assert.equal(win.options.resizable, false)
    /**
     * **No parent.** The first version parented the ball to the product window, and on Windows an owned
     * window's z-order belongs to its owner — so `alwaysOnTop` was not honoured and the ball could never cover
     * another application, which is exactly what the review reported ("悬浮球没有盖在其它应用上").
     */
    assert.equal(win.options.parent, undefined, 'an owned window cannot be topmost on Windows')
    assert.equal(win.visible, true)
    assert.equal(win.ignored.value, true, 'a floating ball that takes clicks is not a ball, it is an obstacle')
    assert.deepEqual(win.ignored.options, { forward: true }, 'the renderer still has to see the pointer move')
    assert.equal(/(orb|Orb)/.test(String(win.loaded)), true)

    // Only while the cursor is over the ball or its panel is the window interactive.
    orb.setInteractive(true)
    assert.equal(win.ignored.value, false)
    orb.setInteractive(false)
    assert.equal(win.ignored.value, true)
    // …and the native style is written only when the answer changes: a transparent topmost window that
    // re-writes its style on every pointer move is a window that flickers.
    const writes = win.ignoreWrites
    orb.setInteractive(false)
    assert.equal(win.ignoreWrites, writes, 'a repeated answer must not be a repeated native call')
    orb.setInteractive(true)
    assert.equal(win.ignoreWrites, writes + 1)
  } finally {
    dispose()
  }
})

test('a stationary native cursor survives false leave, but real exits restore click-through', () => {
  const electron = stubElectron({ workArea: { x: 0, y: 0, width: 1000, height: 800 } })
  let cursor = { x: 962, y: 762 }
  electron.screen.getCursorScreenPoint = () => cursor
  const orb = createSystemOrb({ electron })
  assert.equal(orb.create().ok, true)
  orb.setInteractive(true)
  const writes = electron.last().ignoreWrites
  orb.setInteractive(false)
  assert.equal(orb.describe().interactive, true, 'native style changes can report leave without a cursor exit')
  assert.equal(electron.last().ignoreWrites, writes)
  cursor = { x: 940, y: 740 } // transparent corner outside the circular ball
  orb.setInteractive(false)
  assert.equal(orb.describe().interactive, false)
  orb.setInteractive(true)
  cursor = { x: 100, y: 100 }
  orb.setInteractive(false)
  assert.equal(orb.describe().interactive, false)
})

test('unavailable or invalid native cursor cannot latch closed-orb input', () => {
  for (const read of [undefined, () => { throw new Error('unavailable') }, () => null, () => ({ x: NaN, y: 762 })]) {
    const electron = stubElectron()
    electron.screen.getCursorScreenPoint = read
    const orb = createSystemOrb({ electron })
    orb.create()
    orb.setInteractive(true)
    assert.doesNotThrow(() => orb.setInteractive(false))
    assert.equal(orb.describe().interactive, false)
  }
})

test('only the open panel can be typed into: the ball never takes the keyboard, the form needs it', () => {
  /**
   * The user's report — "悬浮球的入口打开窗口后无法编辑" — stated as a property of the window rather than of the form:
   * the form was fine, but a `focusable: false` window cannot take a keystroke, so nothing typed into it ever
   * arrived. An open panel is the one state that needs the keyboard, and it is exactly the state that borrows it.
   */
  const electron = stubElectron()
  const { file, dispose } = scratch()
  try {
    const orb = createSystemOrb({ electron, log: () => {}, state: createOrbState(file), workAreaOf: () => SCREEN })
    orb.create()
    const win = electron.last()
    // A ball, closed: no keyboard at all.
    assert.equal(orb.describe().focusable, false)
    assert.equal(win.focusable, false)

    // The panel opens: focusable, and focused, so the prompt the renderer focuses can actually receive keys.
    orb.setOpen(true)
    assert.equal(orb.describe().open, true)
    assert.equal(orb.describe().focusable, true, 'the panel holds a form and cannot be typed into')
    assert.equal(win.focusable, true)
    assert.equal(win.focused, true, 'a focusable panel that is never focused still receives no keystrokes')

    // Closing hands the keyboard back — and drops focus *before* the style does. Windows does not deactivate a
    // window that stops accepting keys, so a window left focused and unfocusable is where keystrokes disappear.
    orb.setOpen(false)
    assert.equal(orb.describe().focusable, false)
    assert.equal(win.focusable, false)
    assert.equal(win.focused, false, 'the window kept focus while it stopped accepting keys')

    // Native writes only when the answer changes, the same rule the mouse style follows.
    const writes = win.focusableWrites
    orb.setOpen(false)
    assert.equal(win.focusableWrites, writes, 'a repeated answer must not be a repeated native call')
    orb.setOpen(true)
    assert.equal(win.focusableWrites, writes + 1)
  } finally {
    dispose()
  }
})

test('a drag moves the window, snaps at the edge, and stores exactly once', async () => {
  const electron = stubElectron()
  const { file, dispose } = scratch()
  try {
    const state = createOrbState(file)
    const orb = createSystemOrb({ electron, log: () => {}, state, workAreaOf: () => SCREEN })
    orb.create()
    const win = electron.last()
    win.fire('wc:did-finish-load')
    assert.deepEqual(orb.describe().position, { x: 1860, y: 1020, edge: 'right' })

    // Press on the ball, move up-left: the window follows, so the ball does.
    orb.dragStart({ x: 1882, y: 1042 })
    orb.dragTo({ x: 1382, y: 642 })
    assert.deepEqual(orb.describe().position, { x: 1360, y: 620, edge: null })
    assert.equal(win.bounds.x, 1360 - MARGIN)
    assert.equal(win.bounds.y, 620 - MARGIN)
    assert.equal(state.read(), null, 'a drag in progress is not a stored position per pixel')

    orb.dragEnd()
    assert.deepEqual(state.read(), { x: 1360, y: 620, edge: null })

    // Drag to the left edge: it snaps, and the stored edge says so.
    orb.dragStart({ x: 1382, y: 642 })
    orb.dragTo({ x: 12, y: 642 })
    orb.dragEnd()
    assert.deepEqual(state.read(), { x: 0, y: 620, edge: 'left' })
    assert.equal(win.bounds.x, -MARGIN, 'the window keeps the ball\'s margin off-screen, not the ball')
  } finally {
    dispose()
  }
})

test('opening the panel grows the window toward the middle and tells the renderer where everything is', () => {
  const electron = stubElectron()
  const { file, dispose } = scratch()
  try {
    const orb = createSystemOrb({ electron, log: () => {}, state: createOrbState(file), workAreaOf: () => SCREEN })
    orb.create()
    const win = electron.last()
    win.fire('wc:did-finish-load')
    win.sent.length = 0

    const before = orb.describe().position
    const opened = orb.setOpen(true, { view: { status: { tone: 'ok' } } })
    assert.equal(opened.ok, true)
    const grown = orb.setPanelSize({ width: 340, height: 400 }, { view: { status: { tone: 'ok' } } })
    assert.equal(grown.panel.side, 'above')
    assert.equal(grown.panel.across, 'left')
    assert.deepEqual(orb.describe().position, before, 'the ball must not move when the panel opens')
    const pushed = win.sent[win.sent.length - 1]
    assert.equal(pushed.channel, 'mega:orb-state')
    assert.equal(pushed.payload.open, true)
    assert.deepEqual(pushed.payload.ball, { x: MARGIN + 340 + GAP, y: MARGIN + 400 + GAP })
    assert.deepEqual(pushed.payload.panel.offset, { x: MARGIN, y: MARGIN })
    assert.equal(pushed.payload.panel.height, 400)
    assert.equal(pushed.payload.view.status.tone, 'ok')

    // Closing shrinks back to the ball: the window is never kept at the big size "just in case".
    orb.setOpen(false)
    assert.deepEqual(win.bounds, { x: before.x - MARGIN, y: before.y - MARGIN, width: BALL_SIZE + MARGIN * 2, height: BALL_SIZE + MARGIN * 2 })
    assert.equal(orb.describe().panel, null)
  } finally {
    dispose()
  }
})

test('an open panel keeps the window interactive, so opening it cannot make the pointer chase itself', () => {
  const electron = stubElectron()
  const { file, dispose } = scratch()
  try {
    const orb = createSystemOrb({ electron, log: () => {}, state: createOrbState(file), workAreaOf: () => SCREEN })
    orb.create()
    const win = electron.last()
    win.fire('wc:did-finish-load')

    /**
     * The flicker the review caught: opening the panel resizes and re-places the window, so for a frame the
     * cursor is over the transparent margin instead of the ball. Hover therefore says "not over anything" —
     * and with hover as the only input to `setIgnoreMouseEvents`, the window became click-through, the
     * forwarded move found the cursor on the ball again, and the two states chased each other.
     */
    orb.setInteractive(true)
    orb.setOpen(true)
    orb.setPanelSize({ width: 340, height: 300 })
    orb.setInteractive(false)
    assert.equal(win.ignored.value, false, 'an open panel is an unambiguous "the user is using this"')
    // A drag is the third unambiguous one: releasing the pointer must not make the window click-through
    // halfway through a gesture either.
    orb.setOpen(false)
    assert.equal(win.ignored.value, true, 'a closed panel with the cursor elsewhere goes back to click-through')
    orb.dragStart({ x: 100, y: 100 })
    assert.equal(win.ignored.value, false)
    orb.dragEnd()
    assert.equal(win.ignored.value, true)
  } finally {
    dispose()
  }
})

test('the window is reshaped only when its bounds actually change', () => {
  const electron = stubElectron()
  const { file, dispose } = scratch()
  try {
    const orb = createSystemOrb({ electron, log: () => {}, state: createOrbState(file), workAreaOf: () => SCREEN })
    orb.create()
    const win = electron.last()
    win.fire('wc:did-finish-load')
    const settled = win.resizes
    // The same state pushed again (the poller does this every 15 s) must not reshape the window: a native
    // reshape of a transparent, always-on-top window is a visible flicker.
    orb.render({ status: { tone: 'ok' } })
    orb.render({ status: { tone: 'warn' } })
    orb.apply?.()
    assert.equal(win.resizes, settled, 'the window was reshaped for a state that did not move it')
    orb.setOpen(true)
    orb.setPanelSize({ width: 340, height: 300 })
    assert.ok(win.resizes > settled, 'opening the panel must reshape the window')
  } finally {
    dispose()
  }
})

test('a build without BrowserWindow, or with the orb switched off, costs nothing', () => {
  const { file, dispose } = scratch()
  try {
    const noWindow = createSystemOrb({ electron: {}, log: () => {}, state: createOrbState(file), workAreaOf: () => SCREEN })
    const result = noWindow.create()
    assert.equal(result.ok, false)
    assert.match(result.reason, /BrowserWindow/)
    assert.equal(noWindow.describe().visible, false)
    // Every other call answers too: a ball that cannot exist must not throw at whoever asked for it.
    assert.equal(noWindow.setOpen(true).ok, false)
    assert.equal(noWindow.dragTo({ x: 1, y: 1 }).ok, false)
    assert.equal(noWindow.stop().ok, true)

    const disabled = createSystemOrb({ electron: stubElectron(), enabled: false, log: () => {}, state: createOrbState(file), workAreaOf: () => SCREEN })
    assert.deepEqual(disabled.create(), { ok: false, reason: 'disabled' })
  } finally {
    dispose()
  }
})

test('stopping the orb destroys the window and leaves nothing behind', () => {
  const electron = stubElectron()
  const { file, dispose } = scratch()
  try {
    const orb = createSystemOrb({ electron, log: () => {}, state: createOrbState(file), workAreaOf: () => SCREEN })
    orb.create()
    const win = electron.last()
    assert.equal(orb.stop().stopped, true)
    assert.equal(win.destroyed, true)
    assert.equal(orb.describe().visible, false)
    win.fire('closed')
    assert.equal(orb.describe().visible, false)
  } finally {
    dispose()
  }
})

test('the extension wires the orb to the same view model and the same actions as the rest of Mega', () => {
  const index = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'extensions', 'mega', 'index.cjs'), 'utf8')
  const preload = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'extensions', 'mega', 'ui', 'orb-preload.cjs'), 'utf8')
  // One view model for the official orb, the official page and the system ball — the plugin's own module.
  assert.match(index, /plugins', 'mega-core', 'lib', 'view\.js'/)
  assert.match(index, /buildMegaView\(\{/)
  assert.match(index, /governance: \(\(\) => \{[\s\S]{0,200}controlCenter\(\)/)
  // The action channel is the Control Center's own path, not a second implementation of the closed set.
  assert.match(index, /ipcMain\.handle\('mega:orb-action'[\s\S]{0,200}controlAction\(payload \|\| \{\}\)/)
  // The channels are declared for cleanup, and the preload is the whole reachable surface of that window.
  for (const channel of ['mega:orb-snapshot', 'mega:orb-open', 'mega:orb-measure', 'mega:orb-drag', 'mega:orb-hover', 'mega:orb-action', 'mega:orb-timing', 'mega:orb-task']) {
    assert.match(index, new RegExp(`'${channel.replace(/[:]/g, ':')}'`), `${channel} is not declared`)
    assert.match(preload, new RegExp(`'${channel.replace(/[:]/g, ':')}'`), `${channel} is not exposed by the preload`)
  }
  assert.equal(/ipcRenderer\.invoke\(\s*`/.test(preload), false, 'a dynamic channel name cannot be audited')
  /**
   * The timing pair is the ball's new-task form, and it answers with the **same two functions** the governance
   * bridge exposes to the official plugin: one implementation of "what a task may be" and one of "make a task",
   * shared by every surface that can schedule one.
   */
  assert.match(index, /ipcMain\.handle\('mega:orb-timing'[\s\S]{0,200}scheduledTaskSurface\(\)/)
  assert.match(index, /ipcMain\.handle\('mega:orb-task'[\s\S]{0,200}scheduleTask\(input \|\| \{\}\)/)
  assert.match(index, /timing: \(\) => scheduledTaskSurface\(\)/)
  assert.match(index, /createTask: \(input\) => scheduleTask\(input\)/)
  // The ball is not on the boot path: it is created with the other windows, after the tray.
  assert.match(index, /createTray\(\)[\s\S]{0,900}?if \(process\.env\.DSH_SYSTEM_ORB === '1'\) createSystemOrbWindow\(\)/)
  assert.match(index, /if \(systemOrb\) systemOrb\.stop\(\)/)
})
