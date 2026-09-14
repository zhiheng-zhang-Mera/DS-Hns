'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

/**
 * The Appearance panel: the frosted-glass layer's controls, and the end of the dock's skin.
 *
 * This module used to be the theme panel. The requirement that changed it is a behaviour, not a
 * refactor, so the tests are about behaviour:
 *
 *  * **Live.** Dragging a slider changes the document on the frame it moves, without writing the
 *    state file; releasing it writes once. "The effect renders in real time" is exactly this, and
 *    it is the property a static assertion cannot see.
 *  * **A control, not an owner.** The panel renders the state the *layer* reports — including a
 *    change made somewhere else — so the controls can never disagree with the pane.
 *  * **The dock takes no theme.** There is no bridge left to install a skin: the scripts the dock
 *    loads contain no writer of theme slot values, the markup has no theme surface, and the layer
 *    is the only thing that decides how the dock looks.
 */

const ROOT = path.resolve(__dirname, '..', '..')
const UI = path.join(ROOT, 'app', 'extensions', 'mega', 'ui')
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8')

/** The elements the panel and the layer look up, created on demand like a real document. */
function stubDom() {
  const nodes = new Map()
  const properties = new Map()
  const element = (id) => {
    if (!nodes.has(id)) {
      nodes.set(id, {
        id,
        value: '',
        checked: true,
        textContent: '',
        className: '',
        dataset: {},
        children: [],
        listeners: new Map(),
        appendChild(child) {
          this.children.push(child)
          return child
        },
        addEventListener(event, handler) {
          this.listeners.set(event, handler)
        },
        fire(event) {
          const handler = this.listeners.get(event)
          return handler ? handler() : undefined
        }
      })
    }
    return nodes.get(id)
  }
  const document = {
    // A real document has all of these, and the panel uses all of them: the wallpaper's name line
    // is built as text plus a `<small>` note rather than as one interpolated string, and both
    // layers write custom properties on the body as well as on the root.
    body: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
    documentElement: { style: { setProperty: (name, value) => properties.set(name, value) } },
    createElement: (tag) => ({ tagName: String(tag).toUpperCase(), className: '', textContent: '', style: {}, children: [], appendChild(child) { this.children.push(child); return child } }),
    getElementById: element
  }
  return { document, element, properties }
}

/**
 * Load the two real scripts into one shared window, in the dock's own order.
 *
 * They are evaluated as classic scripts rather than imported, because that is what they are in
 * the renderer, and because the load order is itself part of the contract: the layer publishes
 * `hnsGlass` before the panel looks for it.
 */
function loadPanel(options = {}) {
  const { document, element, properties } = stubDom()
  // The panel needs its markup to exist, or `attach()` correctly refuses to attach.
  if (options.withMarkup !== false) {
    for (const id of ['appearancePanel', 'glassRow', 'glassEnabled', 'glassBlur', 'glassOpacity', 'glassBlurValue', 'glassOpacityValue', 'glassStatus', 'glassMessage']) element(id)
    // The wallpaper card, which is a second set of controls in the same panel.
    for (const id of ['wallpaperRow', 'wallpaperEnabled', 'wallpaperName', 'wallpaperScope', 'wallpaperFit', 'wallpaperOpacity', 'wallpaperBlur', 'wallpaperScrim', 'wallpaperOpacityValue', 'wallpaperBlurValue', 'wallpaperScrimValue', 'wallpaperPick', 'wallpaperClear']) element(id)
  }
  const calls = []
  const window = { document }
  window.window = window
  if (options.bridge !== false) {
    window.megaTools = {
      glass: {
        describe: async () => ({ ok: true, ...(options.initial || { enabled: true, blur: 18, opacity: 62 }) }),
        set: async (patch) => {
          calls.push(patch)
          const base = options.initial || { enabled: true, blur: 18, opacity: 62 }
          return { ok: true, ...base, ...patch }
        },
        onChanged: () => {}
      }
    }
    if (options.wallpaper) {
      window.megaTools.wallpaper = {
        describe: async () => options.wallpaper,
        layer: async () => options.wallpaper,
        set: async (patch) => {
          calls.push(patch)
          return options.wallpaper
        },
        pick: async () => ({ ok: false, canceled: true }),
        onChanged: () => {}
      }
    }
  }
  const run = (file) => {
    // eslint-disable-next-line no-new-func
    new Function('window', 'document', read(`app/extensions/mega/ui/${file}`))(window, document)
  }
  run('glass-layer.js')
  run('appearance-panel.js')
  return { window, document, element, properties, calls, panel: window.megaAppearancePanel, layer: window.hnsGlass }
}

test('the panel is the layer\'s controls: it attaches, and it renders the state in force', async () => {
  const { panel, element, layer } = loadPanel({ initial: { enabled: true, blur: 26, opacity: 71 } })
  assert.equal(typeof panel, 'object', 'the appearance panel published no global')
  const attached = panel.attach()
  assert.ok(attached, 'the panel refused to attach to its own markup')

  // Before the shell answers, the controls show the shipped defaults — the same numbers the
  // markup ships, so there is no flash of an unglazed panel while the round-trip is in flight.
  assert.equal(element('glassBlur').value, '18')
  assert.equal(layer.state().blur, 18)

  // Then the persisted state arrives and every control follows it, because the panel renders the
  // layer rather than the markup.
  await attached.refresh()
  assert.equal(element('glassEnabled').checked, true)
  assert.equal(element('glassBlur').value, '26')
  assert.equal(element('glassOpacity').value, '71')
  assert.equal(element('glassBlurValue').textContent, '26')
  assert.equal(element('glassOpacityValue').textContent, '71')
  assert.equal(element('glassRow').dataset.enabled, '1')
  assert.match(element('glassStatus').textContent, /26px/)
  assert.deepEqual(attached.state(), { enabled: true, blur: 26, opacity: 71 })
})

test('dragging a slider changes the pane on the frame it moves, and writes once on release', async () => {
  const { panel, element, properties, calls, layer } = loadPanel()
  panel.attach()
  const before = calls.length

  // The drag: no write, but the document already carries the new number.
  element('glassBlur').value = '32'
  element('glassBlur').fire('input')
  assert.equal(properties.get('--hns-glass-blur'), '32px', 'the slider did not reach the stylesheet while dragging')
  assert.equal(element('glassBlurValue').textContent, '32', 'the readout did not follow the drag')
  assert.equal(calls.length, before, 'dragging wrote the state file on every step')
  assert.equal(layer.state().blur, 32)

  // The release: one write, and the answer is what is applied.
  await element('glassBlur').fire('change')
  assert.deepEqual(calls[before], { blur: 32 }, 'releasing the slider did not persist the value')

  // The same for the translucency, which is the number the pane is actually made of.
  element('glassOpacity').value = '40'
  element('glassOpacity').fire('input')
  assert.equal(properties.get('--hns-glass-alpha'), '40%')
  await element('glassOpacity').fire('change')
  assert.deepEqual(calls[before + 1], { opacity: 40 })
})

test('the switch goes through the shell and re-renders from its answer', async () => {
  const { panel, element, document, calls } = loadPanel({ initial: { enabled: true, blur: 18, opacity: 62 } })
  panel.attach()
  element('glassEnabled').checked = false
  await element('glassEnabled').fire('change')
  assert.deepEqual(calls[0], { enabled: false })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(document.body.dataset.glass, 'off', 'the switch did not turn the layer off')
  assert.equal(element('glassRow').dataset.enabled, '0')
  assert.match(element('glassStatus').textContent, /已关闭|off/)
})

test('a change made anywhere else lands on these controls too', async () => {
  const { panel, element, layer } = loadPanel({ initial: { enabled: true, blur: 18, opacity: 62 } })
  panel.attach()
  // Another surface changed the layer: the panel is a view of it, so it follows.
  layer.apply({ blur: 9, opacity: 88 })
  assert.equal(element('glassBlur').value, '9')
  assert.equal(element('glassOpacity').value, '88')
  assert.equal(element('glassOpacityValue').textContent, '88')
})

test('the wallpaper card edits the backdrop its scope names, and only that one', async () => {
  const state = {
    ok: true,
    enabled: true,
    main: { enabled: true, file: 'C:/pictures/main.png', name: 'main.png', kind: 'image', present: true, fit: 'cover', opacity: 55, blur: 0, scrim: 35 },
    dock: { enabled: true, file: null, name: null, kind: null, present: true, fit: 'contain', opacity: 80, blur: 4, scrim: 10 }
  }
  const { panel, element, calls } = loadPanel({ wallpaper: state })
  const attached = panel.attach()
  await attached.refresh()

  // With the scope on "both" the card shows the main screen (what one picture meant), and a write is
  // the flat shape — which the shell reads as "both".
  assert.equal(element('wallpaperScope').value, 'both')
  assert.equal(element('wallpaperName').textContent, 'main.png · image')
  assert.equal(element('wallpaperOpacity').value, '55')
  element('wallpaperOpacity').value = '70'
  await element('wallpaperOpacity').fire('change')
  assert.deepEqual(calls[calls.length - 1], { opacity: 70 })

  // Switching the scope to Mega re-renders from Mega's own block: no file, its own numbers.
  element('wallpaperScope').value = 'dock'
  element('wallpaperScope').fire('change')
  assert.equal(element('wallpaperName').textContent, '未选择 · none chosen')
  assert.equal(element('wallpaperOpacity').value, '80')
  assert.equal(element('wallpaperFit').value, 'contain')
  assert.equal(element('wallpaperClear').disabled, true, 'clearing is offered for a backdrop with no picture')

  // And a write then lands on Mega alone.
  element('wallpaperOpacity').value = '30'
  await element('wallpaperOpacity').fire('change')
  assert.deepEqual(calls[calls.length - 1], { dock: { opacity: 30 } })
  element('wallpaperFit').value = 'tile'
  await element('wallpaperFit').fire('change')
  assert.deepEqual(calls[calls.length - 1], { dock: { fit: 'tile' } })

  // Clearing clears the backdrop the scope names, not the other one.
  element('wallpaperClear').fire('click')
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(calls[calls.length - 1], { dock: { file: '' } })
})

test('a page without the glass layer gets a message, not a broken panel', () => {
  const { document, element } = stubDom()
  const window = { document }
  window.window = window
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', read('app/extensions/mega/ui/appearance-panel.js'))(window, document)
  const attached = window.megaAppearancePanel.attach()
  assert.equal(attached, null, 'the panel claimed to attach without the layer it drives')
  assert.match(element('glassMessage').textContent, /磨砂玻璃层不可用/)
})

/**
 * The dock is not skinned.
 *
 * These are the structural assertions that keep it that way: a theme bridge re-added to the
 * markup, a themed panel rebuilt in the dock, or a script that installs slot values would each
 * put a skin back on top of the glass, which is the defect the whole change removes.
 */
test('the dock loads no theme bridge and writes no theme values', () => {
  const html = read('app/extensions/mega/ui/dock.html')
  assert.equal(/theme-bridge\.js|theme-panel\.js/.test(html), false, 'the dock still loads the theme bridge or the theme panel')
  assert.match(html, /<script src="appearance-panel\.js"><\/script>/, 'the dock does not load the glass panel')
  // The persona / decoration layers are theme features and their markup is gone.
  assert.equal(/hnsDecoration|hnsPersona/.test(html), false, 'the persona layer is still in the dock markup')
  // And so is the theme panel's whole control surface.
  for (const id of ['themePrompt', 'themePreview', 'themeList', 'themeCreate', 'themeActive', 'themeCapability', 'themeDetail', 'themeImport', 'themeObserve']) {
    assert.equal(html.includes(`id="${id}"`), false, `the dock still carries the theme control #${id}`)
  }
  for (const file of ['theme-bridge.js', 'theme-panel.js']) {
    assert.equal(fs.existsSync(path.join(UI, file)), false, `${file} still exists`)
  }
  // The CSP no longer needs a nonce for a runtime stylesheet, because nothing installs one.
  assert.match(html, /style-src 'self';/, 'the style policy still carries the theme sheet nonce')
})

test('no dock script installs a theme payload any more', () => {
  const scripts = fs.readdirSync(UI).filter((file) => file.endsWith('.js'))
  for (const file of scripts) {
    const source = fs.readFileSync(path.join(UI, file), 'utf8')
    // The bridge's signature: writing slot values as custom properties on the root element and
    // injecting the theme's token sheet. Either one is a skin.
    assert.equal(/--hns-slot-/.test(source), false, `${file} writes theme slot variables`)
    assert.equal(/hnsThemeSheet/.test(source), false, `${file} injects the theme token sheet`)
    assert.equal(/megaTools\.theme|megaTools\?\.theme/.test(source), false, `${file} still calls the theme bridge`)
  }
  // The panel is called "appearance" and drives the glass, and only the glass.
  const panel = read('app/extensions/mega/ui/appearance-panel.js')
  assert.match(panel, /hnsGlass/, 'the panel does not drive the glass layer')
  assert.equal(/themeGlass|themePreview|themeList/.test(panel), false, 'the panel still addresses the old theme controls')
})

test('the window is a pane: the dock asks for a transparent, frosted window', () => {
  const index = read('app/extensions/mega/index.cjs')
  const main = read('app/desktop-main.cjs')
  assert.match(index, /function dockGlassBackground\(\)/, 'the dock window options are not in one testable place')
  assert.match(index, /transparent: true, backgroundColor: '#00000000'/, 'the dock window is opaque, so the pane can never reach the screen')
  assert.match(index, /backgroundMaterial = 'acrylic'/, 'no OS frost is requested, so the desktop behind the window cannot blur')
  assert.match(index, /\.\.\.dockGlassBackground\(\)/, 'the dock window does not use those options')
  // The integrated view is the shipped backend, and it has to be transparent for the same reason.
  assert.match(main, /megaDockView\.setBackgroundColor\('#00000000'\)/, 'the integrated dock view paints an opaque background')
})

test('every class the glass controls use is styled: markup and stylesheet agree', () => {
  const html = read('app/extensions/mega/ui/dock.html')
  const css = read('app/extensions/mega/ui/dock.css')
  const panel = html.slice(html.indexOf('id="appearancePanel"'))
  const section = panel.slice(0, panel.indexOf('</section>'))
  const classes = new Set()
  for (const match of section.matchAll(/class="([^"]+)"/g)) {
    for (const name of match[1].split(/\s+/)) if (name) classes.add(name)
  }
  // The control block is the one place a rename on one side only is invisible: the markup would
  // render unstyled and every behavioural test would still pass.
  for (const name of ['glass', 'glass-note', 'glass-range']) {
    assert.ok(classes.has(name), `the Appearance panel no longer uses .${name}`)
    assert.ok(css.includes(`.${name}{`) || css.includes(`.${name}[`), `.${name} is used in the markup and styled nowhere`)
  }
  // The row is part of the frosted set, so the controls themselves are glass.
  assert.match(css, /:is\([^)]*\.glass\)\{/, 'the glass control block is not frosted with the rest of the dock')
})

test('the chassis is colourless: the layer paints no colour over the official UI', () => {
  const css = read('app/extensions/mega/ui/dock.css')
  const block = css.slice(css.indexOf('body[data-glass="on"]{'))
  assert.match(block, /--hns-color-bg-base:transparent;/, 'the chassis paints a colour, which clashes with the components it covers')
  // The colourless chassis must still be recoverable: without blur there is no frost, and a
  // colourless pane that cannot blur is a hole in the window rather than a dock.
  assert.match(css, /--hns-glass-src-base:var\(--hns-color-bg-base\)/, 'the chassis colour is not captured for the fallback')
  assert.match(block, /@supports not \(\(backdrop-filter:blur\(1px\)\)[\s\S]{0,160}--hns-color-bg-base:var\(--hns-glass-src-base\)/, 'the no-blur fallback leaves a hole in the window')
  // `:root` must not paint the canvas, or the colourless chassis never becomes the canvas and the
  // pane would stop at the document's edge.
  const root = css.slice(0, css.indexOf('*{box-sizing'))
  assert.equal(/^\s*background:/m.test(root), false, ':root still paints an opaque background over the pane')
  assert.match(css, /body\{display:flex;background:var\(--hns-color-bg-base\)/, 'the body no longer carries the base the layer owns')
  // And the floor the user asked for, on the shipped control as well as in the state module: a
  // slider whose minimum is higher than the file allows would make the setting unreachable.
  const html = read('app/extensions/mega/ui/dock.html')
  assert.match(html, /id="glassOpacity" min="5"/, 'the panel\'s slider cannot reach the 5% floor')
})

test('the dock starts below the official header, and the whole dock moves together', () => {
  const index = read('app/extensions/mega/index.cjs')
  const main = read('app/desktop-main.cjs')
  const geometry = require(path.join(ROOT, 'app', 'extensions', 'mega', 'dock', 'geometry.cjs'))

  // The default is the official conversation header's own `min-height`: the band that carries the
  // controls the dock used to cover.
  assert.equal(geometry.OFFICIAL_HEADER_MIN_HEIGHT, 76)
  assert.equal(geometry.dockTopInset({}), 76, 'the dock no longer yields the official header band')
  assert.equal(geometry.dockTopInset({ DSH_MEGA_DOCK_TOP_INSET: '0' }), 0, 'a build without a header above the dock cannot say so')
  assert.equal(geometry.dockTopInset({ DSH_MEGA_DOCK_TOP_INSET: '120' }), 120)
  assert.equal(geometry.dockTopInset({ DSH_MEGA_DOCK_TOP_INSET: 'nonsense' }), 76, 'an unreadable override must not silently cover the controls again')
  assert.equal(geometry.dockTopInset({ DSH_MEGA_DOCK_TOP_INSET: '9999' }), geometry.MAX_TOP_INSET, 'a typo must not park the dock off the bottom')

  // The rectangle: the dock keeps its column, loses the band, and never shrinks to nothing.
  assert.deepEqual(geometry.dockBounds({ x: 900, width: 560, height: 800, inset: 76 }), { x: 900, y: 76, width: 560, height: 724 })
  assert.deepEqual(geometry.dockBounds({ x: 0, width: 48, height: 800, inset: 0 }), { x: 0, y: 0, width: 48, height: 800 })
  const tiny = geometry.dockBounds({ x: 0, width: 48, height: 40, inset: 76 })
  assert.ok(tiny.height >= 1, 'a window shorter than the band must still have a dock')

  // Both backends use it, which is the point of a shared function: the rail and the panel are one
  // view, and a second opinion about the top would break the seam between them.
  assert.match(main, /megaDockView\.setBounds\(dockBounds\(\{ x: officialWidth, width: dockWidth, height, inset: dockTopInset\(\) \}\)\)/, 'the integrated dock still starts at the top of the window')
  assert.match(index, /const bounds = dockBounds\(\{ x, width, height, inset: dockTopInset\(\) \}\)/, 'the legacy dock still starts at the top of the window')
})
