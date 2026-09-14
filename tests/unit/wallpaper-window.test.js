'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { createWallpaperWindow, WALLPAPER_DOCUMENT, NO_NOTCH, notchCss } = require('../../app/wallpaper-window.cjs')

const ROOT = path.resolve(__dirname, '..', '..')

/**
 * The wallpaper window.
 *
 * It exists because the picture has to be *over* the official page to be seen, and a
 * `WebContentsView` over that page is a real hit target in this Electron build: a view exposes no
 * input API at all (`View` has 9 methods and `setIgnoreMouseEvents` is not one of them; a
 * `BrowserWindow` has it). That is the defect these tests pin down — the layer used to be drawn
 * correctly and swallow every click on the official UI.
 *
 * So what is asserted here is not "a window exists" but the three properties that make a window
 * acceptable as a background: it is mouse-transparent (and never shown when the build refuses), it
 * never takes focus, and it is only ever created when there is something to draw.
 */

/** A BrowserWindow stand-in: it records what it was asked to be, and nothing else. */
function fakeElectron({ failMouseTransparency = false } = {}) {
  const created = []
  const errors = []

  class FakeWebContents {
    constructor() {
      this.destroyed = false
      this.inserted = []
      this.removed = []
      this.handlers = new Map()
      this.nextKey = 1
    }

    isDestroyed() { return this.destroyed }
    setWindowOpenHandler() {}
    on(event, handler) {
      const list = this.handlers.get(event) || []
      list.push(handler)
      this.handlers.set(event, list)
      return this
    }
    emit(event, ...args) {
      for (const handler of this.handlers.get(event) || []) handler(...args)
    }
    async insertCSS(css) {
      const key = `css-${this.nextKey++}`
      this.inserted.push({ key, css })
      return key
    }
    async removeInsertedCSS(key) { this.removed.push(key) }
    close() { this.destroyed = true }
  }

  class FakeWindow {
    constructor(options) {
      this.options = options
      this.webContents = new FakeWebContents()
      this.visible = false
      this.destroyed = false
      this.bounds = null
      this.handlers = new Map()
      this.errors = errors
      if (failMouseTransparency && options.show === undefined) throw new Error('not a wallpaper window')
      created.push(this)
    }

    isDestroyed() { return this.destroyed }
    on(event, handler) {
      const list = this.handlers.get(event) || []
      list.push(handler)
      this.handlers.set(event, list)
      return this
    }
    emit(event, ...args) {
      for (const handler of this.handlers.get(event) || []) handler(...args)
    }
    setIgnoreMouseEvents(value) {
      if (failMouseTransparency) throw new Error('this build refuses')
      this.ignoreMouse = value
    }
    setFocusable(value) { this.focusable = value }
    setMenuBarVisibility(value) { this.menuBar = value }
    loadFile(file) {
      this.loaded = file
      return Promise.resolve()
    }
    isVisible() { return this.visible }
    showInactive() { this.visible = true; this.emit('show') }
    hide() { this.visible = false; this.emit('hide') }
    setBounds(bounds) { this.bounds = bounds }
    getBounds() { return this.bounds }
    destroy() { this.destroyed = true; this.webContents.destroyed = true; this.emit('closed') }
  }

  return {
    electron: { BrowserWindow: FakeWindow },
    created,
    errors,
    latest: () => created[created.length - 1] || null
  }
}

/** The main window the layer is parented to, plus the content box it is placed against. */
function fakeMainWindow() {
  return {
    destroyed: false,
    isDestroyed() { return this.destroyed }
  }
}

function build(options = {}) {
  const electron = fakeElectron(options)
  const parent = fakeMainWindow()
  const content = { x: 120, y: 80, width: 1474, height: 900 }
  const manager = createWallpaperWindow({
    getParentWindow: () => parent,
    getContentBounds: () => ({ ...content }),
    electron: electron.electron,
    log: (message) => electron.errors.push(message)
  })
  return { manager, electron, parent, content }
}

const PICTURE = ':root { --wp-image: url("data:image/png;base64,AAAA"); --wp-opacity: 0.55; }'

test('a picture over the official page is a mouse-transparent window, never a view', () => {
  const { manager, electron } = build()
  const result = manager.paint(PICTURE, { drawable: true })

  assert.equal(result.ok, true, 'the layer refused to paint')
  assert.equal(electron.created.length, 1, 'the layer did not create exactly one window')
  const window_ = electron.latest()
  assert.equal(window_.options.frame, false, 'the layer has a frame')
  assert.equal(window_.options.transparent, true, 'the layer is not transparent')
  assert.equal(window_.options.focusable, false, 'the layer can take focus')
  assert.equal(window_.options.skipTaskbar, true, 'the layer is a taskbar entry')
  assert.equal(window_.options.hasShadow, false)
  assert.equal(window_.ignoreMouse, true, 'the layer can take a click')
  assert.equal(window_.focusable, false)
  // It is placed *at creation* — a window has a default size, and a layer that waited for the next
  // resize would put a wrongly-sized rectangle over the interface until then.
  assert.deepEqual(manager.describe().bounds, { x: 120, y: 80, width: 1474, height: 900 })
  manager.layout({ bounds: { x: 10, y: 20, width: 800, height: 600 } })
  assert.deepEqual(window_.bounds, { x: 10, y: 20, width: 800, height: 600 })
  assert.equal(window_.isVisible(), true, 'the layer is not on screen')
  assert.equal(manager.describe().input, 'passthrough')
  assert.equal(window_.loaded, WALLPAPER_DOCUMENT)
})

test('the window document is the one on disk, and it is script-free and click-through', () => {
  assert.equal(fs.existsSync(WALLPAPER_DOCUMENT), true, 'the wallpaper window document is missing')
  const html = fs.readFileSync(WALLPAPER_DOCUMENT, 'utf8')
  assert.equal(/<script/.test(html), false, 'the wallpaper window document carries a script')
  assert.match(html, /script-src 'none'/)
  assert.match(html, /img-src data:/, 'the document is allowed an asset it must not have')
  assert.match(html, /pointer-events: none/)
  assert.match(html, /--wp-notch-x/, 'the document has no cut for the dock')
  assert.match(html, /clip-path: var\(--wp-shape\)/, 'the cut is not applied to the picture')
  // The vertex order is the difference between "everything except the dock" and its complement, and
  // the complement is a layer that covers the dock and leaves the interface alone. The region drawn
  // is traced clockwise: along the top, down the right edge to the cut, left to the dock's x, down to
  // the bottom, and back.
  const shape = html.slice(html.indexOf('--wp-shape: polygon('), html.indexOf(';', html.indexOf('--wp-shape: polygon(')))
  const vertices = [...shape.matchAll(/\b(0|100%|var\(--wp-notch-[xy]\))\s+(0|100%|var\(--wp-notch-[xy]\))/g)]
    .map((match) => `${match[1]} ${match[2]}`)
  assert.deepEqual(
    vertices,
    ['0 0', '100% 0', '100% var(--wp-notch-y)', 'var(--wp-notch-x) var(--wp-notch-y)', 'var(--wp-notch-x) 100%', '0 100%'],
    'the cut polygon draws the wrong side of the dock'
  )
  // The notch the shell writes has to be a clean L: a rectangle from (x, y) to the window's
  // bottom-right corner, which is where the dock's own view is.
  assert.equal(notchCss(null), NO_NOTCH)
  assert.equal(notchCss({ x: 0, y: 76 }), NO_NOTCH, 'a zero-width dock cut the whole picture away')
  assert.match(notchCss({ x: 914.4, y: 75.6 }), /^:root:root \{ --wp-notch-x: 914px; --wp-notch-y: 76px; \}$/)
  // The measured reason for the doubled selector: insertCSS sits before the document's own sheet, so
  // `:root` would lose to the document's defaults and the cut would never be applied.
  assert.match(NO_NOTCH, /^:root:root \{/)
})

test('a build that cannot make the layer mouse-transparent never shows it', () => {
  const { manager, electron } = build({ failMouseTransparency: true })
  const result = manager.paint(PICTURE, { drawable: true })

  assert.equal(electron.created.length, 1)
  const window_ = electron.latest()
  assert.equal(window_.isVisible(), false, 'a layer that can take a click was left on screen')
  assert.equal(manager.describe().visible, false)
  assert.equal(manager.describe().input, 'unavailable')
  assert.ok(electron.errors.some((message) => /mouse-transparent|ignore-mouse/.test(String(message))), 'the refusal was silent')
  assert.notEqual(result.ok, undefined)
})

test('nothing to draw is no window at all, and clearing the wallpaper takes the layer down', () => {
  const { manager, electron } = build()
  // Nothing chosen yet: the module must not build a window for an empty layer.
  manager.paint('', { drawable: false })
  assert.equal(electron.created.length, 0, 'an empty wallpaper created a window over the official UI')
  assert.equal(manager.describe().created, false)

  manager.paint(PICTURE, { drawable: true })
  assert.equal(electron.created.length, 1)
  const window_ = electron.latest()
  window_.webContents.emit('did-finish-load')
  assert.equal(window_.isVisible(), true)

  manager.paint('', { drawable: false })
  assert.equal(window_.isVisible(), false, 'the layer stayed on screen after the wallpaper was cleared')
  assert.equal(window_.isDestroyed(), false, 'clearing the wallpaper destroyed the window instead of hiding it')

  manager.destroy()
  assert.equal(window_.isDestroyed(), true, 'the layer outlived the shell')
})

test('one stylesheet per slot: a repaint replaces the previous rule instead of leaking it', () => {
  const { manager, electron } = build()
  manager.paint(PICTURE, { drawable: true })
  const window_ = electron.latest()
  window_.webContents.emit('did-finish-load')
  return manager.settle().then(async () => {
    const pictures = () => window_.webContents.inserted.filter((entry) => /--wp-image/.test(entry.css))
    assert.equal(pictures().length, 1, 'the picture was not applied')
    // The notch has its own slot: a default one goes in with the picture, and the shell's own answer
    // replaces it later without touching the picture.
    assert.equal(window_.webContents.inserted.filter((entry) => /--wp-notch-x/.test(entry.css)).length, 1)
    manager.setNotch({ x: 914, y: 76 })
    await manager.settle()
    const notches = window_.webContents.inserted.filter((entry) => /--wp-notch-x/.test(entry.css))
    assert.match(notches[notches.length - 1].css, /--wp-notch-x: 914px/, 'the dock cut was never written')
    assert.equal(pictures().length, 1, 'cutting the dock repainted the picture')
    manager.paint(':root { --wp-image: none; }', { drawable: true })
    await manager.settle()
    // The picture's own key was removed before the replacement went in.
    const pictureKeys = pictures().map((entry) => entry.key)
    assert.ok(pictureKeys.length >= 2)
    assert.ok(window_.webContents.removed.includes(pictureKeys[0]), 'the previous picture rule was left behind')
  })
})

test('the layer follows the main window: hidden with it, placed with it, gone with the shell', () => {
  const { manager, electron } = build()
  manager.paint(PICTURE, { drawable: true })
  const window_ = electron.latest()
  window_.webContents.emit('did-finish-load')

  manager.setVisible(false)
  assert.equal(window_.isVisible(), false, 'the layer stayed up over a hidden window')
  manager.setVisible(true)
  assert.equal(window_.isVisible(), true)

  // An unreadable content box is refused rather than turned into a window at the desktop's origin.
  const bad = manager.setBounds(null)
  assert.equal(bad.ok, false)
  assert.deepEqual(window_.bounds, null)

  assert.equal(manager.setEnabled(false), false)
  assert.equal(window_.isVisible(), false, 'the layer stayed up after it was switched off')
})
