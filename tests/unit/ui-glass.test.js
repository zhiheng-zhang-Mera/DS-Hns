'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createUiGlass, GLASS_DEFAULT, GLASS_LIMITS } = require('../../app/extensions/mega/ui-glass.cjs')

/**
 * The frosted-glass layer.
 *
 * The requirement is that every DS-Hns surface is translucent frosted glass, that the official UI
 * is not one of those surfaces, and that the layer composes with whatever desktop skin is
 * installed rather than replacing it. Those three claims are all checkable without a renderer:
 *
 *  * **Coverage** is a property of *which tokens are redirected*. Every surface in the dock
 *    paints with the palette, so the layer redirects the palette on `body[data-glass="on"]` and
 *    a panel added later is frosted by using the tokens rather than by being listed in a
 *    stylesheet. The test asserts the redirections and, just as importantly, that the surfaces
 *    really do paint with those tokens.
 *  * **Composition with a skin** means the glass has no colours of its own: every tint is a
 *    `color-mix()` of a theme token, and the filter adds the theme's own effect blur. A literal
 *    colour in the glass block would be a palette beside the skin instead of an effect over it,
 *    so the test forbids one.
 *  * **The official UI is untouched** structurally: its documents are separate files with their
 *    own inline styles and never load the dock stylesheet, so nothing here can reach them.
 *
 * The state module is exercised for real, because "the switch does nothing" is exactly the kind
 * of defect a stylesheet assertion cannot see.
 */
const ROOT = path.resolve(__dirname, '..', '..')
const UI = path.join(ROOT, 'app', 'extensions', 'mega', 'ui')
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8')

/**
 * The glass layer's own rules: the token block it captures the skin into, and the body rule that
 * redirects them. Prose is excluded on purpose — the rationale above the rules names things (a
 * selector, an example colour) that must not satisfy an assertion about the code.
 */
function glassBlock() {
  const css = read('app/extensions/mega/ui/dock.css')
  const match = /\nbody\[data-glass="on"\]\{/.exec(css)
  assert.ok(match, 'the dock stylesheet has no glass layer')
  const start = match.index
  const rootStart = css.lastIndexOf(':root{', start)
  assert.notEqual(rootStart, -1, 'the glass layer captures no skin tokens before redirecting them')
  return { css, tokens: css.slice(rootStart, start), block: css.slice(start) }
}

test('the layer is on in the markup, before any script runs', () => {
  const html = read('app/extensions/mega/ui/dock.html')
  assert.match(html, /<body[^>]*data-glass="on"/, 'the dock does not ship the layer on, so the first paint is unglazed')
  assert.match(html, /<script src="glass-layer\.js"><\/script>/, 'the dock never loads the glass layer')
  // The layer's numbers must be in place before the panels paint.
  const order = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((match) => match[1])
  assert.equal(order.indexOf('glass-layer.js') < order.indexOf('appearance-panel.js'), true, 'the glass layer must load before the panel that drives it')
  assert.equal(order.indexOf('glass-layer.js') < order.indexOf('dock.js'), true)
})

test('the official UI cannot be frosted: it is a different document that never loads the dock', () => {
  for (const file of ['hns-shell.html', 'official-overlay.html']) {
    const html = read(`app/extensions/mega/ui/${file}`)
    assert.equal(/dock\.css|glass-layer\.js|data-glass/.test(html), false, `${file} takes part in the glass layer; the official UI must not`)
    // It styles itself, which is exactly why the layer cannot reach it.
    assert.match(html, /<style>/, `${file} does not carry its own styles`)
  }
  // And the shell never injects the layer into the official renderer.
  const surfaces = read('app/official-surface-views.cjs')
  assert.equal(/glassLayer|glass-layer|data-glass/.test(surfaces), false, 'the official surface view references the glass layer')
})

test('coverage is by token, and the surfaces really do paint with those tokens', () => {
  const { tokens, block } = glassBlock()
  // The palette the surfaces use, and the palette the layer redirects. `bg-base` is deliberately
  // NOT in this list: it is set to `transparent` rather than mixed, because the chassis must paint
  // no colour at all — the dock covers the official UI, and any tint of ours would be a colour
  // taken from somebody else's interface.
  const redirected = [
    '--hns-color-bg-layer1', '--hns-color-bg-layer2', '--hns-color-bg-raised', '--hns-color-bg-overlay',
    '--hns-color-border-l1', '--hns-color-border-l2',
    '--hns-slot-shell-bg', '--hns-slot-panel-bg', '--hns-slot-card-bg', '--hns-slot-queue-bg',
    '--hns-slot-badge-bg', '--hns-slot-input-bg', '--hns-slot-header-bg'
  ]
  for (const token of redirected) {
    assert.match(block, new RegExp(`${token}:color-mix\\(`), `${token} is not redirected, so its surfaces stay opaque`)
  }
  // The chassis: colourless, absolutely transparent.
  assert.match(block, /--hns-color-bg-base:transparent;/, 'the chassis paints a colour, which would clash with the UI it covers')
  // The capture of the dock's own values, which is what keeps the redirection free of a cycle.
  for (const token of redirected) {
    assert.match(tokens, new RegExp(`--hns-glass-src-[\\w-]+:var\\(${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`), `${token} has no captured source, so the redirection would refer to itself`)
  }
  // The chassis colour still has to exist *somewhere*: without blur there is no frost, and a
  // colourless pane that cannot blur is a hole in the window rather than a dock.
  assert.match(tokens, /--hns-glass-src-base:var\(--hns-color-bg-base\)/, 'the chassis colour is not captured for the no-blur fallback')
  // The surfaces must actually be painted with those tokens, or the layer covers nothing.
  const css = read('app/extensions/mega/ui/dock.css')
  assert.match(css, /\.panel\{[^}]*background:var\(--hns-slot-panel-bg\)/, 'panels no longer paint with the slot palette')
  assert.match(css, /button,input,select,textarea\{[^}]*background:var\(--hns-color-bg-layer1\)/, 'buttons and inputs no longer paint with the palette')
  assert.match(css, /\.pm-sheet\{[^}]*background:var\(--hns-color-bg-layer1\)/, 'the plugin manager sheet no longer paints with the palette')
  // And the canvas: `:root` must not paint a background of its own, or the colourless chassis would
  // never become the canvas and the pane would stop at the document's edge.
  assert.equal(/^\s*background:/m.test(tokens.slice(tokens.lastIndexOf(':root{'))), false, ':root paints an opaque background over the pane')
})

test('the glass has no colours of its own: every tint is mixed out of the dock palette', () => {
  const { tokens, block } = glassBlock()
  const rules = `${tokens}${block}`
  assert.equal(/#[0-9a-f]{3,8}\b/i.test(rules), false, 'the glass block hard-codes a hex colour instead of mixing the palette')
  assert.equal(/\brgba?\(/i.test(rules), false, 'the glass block hard-codes an rgb colour instead of mixing the palette')
  assert.equal(/\bhsla?\(/i.test(rules), false, 'the glass block hard-codes an hsl colour instead of mixing the palette')
  // The tint is the *modules'*, and it starts at the faintest value that still reads as a pane:
  // the chassis has no colour of its own to be more opaque than.
  assert.match(rules, /--hns-glass-alpha:18%/, 'the baseline tint is missing')
  assert.match(rules, /--hns-glass-blur:18px/, 'the baseline blur is missing')
  // The skin's own effect blur is gone with the skin: the filter is the product's blur alone.
  assert.match(rules, /--hns-glass-filter:blur\(var\(--hns-glass-blur\)\) saturate\(var\(--hns-glass-saturate\)\)/, 'the filter is not built from the user\'s blur')
})

test('the frosted layers are the ones content passes under, and the fallback keeps contrast', () => {
  const { block } = glassBlock()
  for (const selector of ['#rail', '#detail', '.dock-header', '.panel-head']) {
    const rule = new RegExp(`${selector.replace('.', '\\.')}[^{]*\\{[^}]*backdrop-filter:var\\(--hns-glass-filter\\)`)
    assert.match(block, rule, `${selector} does not frost anything behind it`)
  }
  // The scrims behind a float: the dock's own content is what they frost, and their hard-coded
  // black is replaced by the palette's overlay colour like everything else here.
  assert.match(block, /:is\(\.pm-backdrop,\.settings-overlay,\.live-view-overlay\)\{[^}]*backdrop-filter:var\(--hns-glass-filter\)/, 'the float scrims do not frost the dock behind them')
  assert.match(block, /\.pm-backdrop[\s\S]{0,200}background:color-mix\(in srgb,var\(--hns-color-bg-overlay\)/, 'the plugin manager scrim still paints a literal black')
  // A renderer without backdrop blur gets the chassis colour back and a nearly solid tint: there is
  // no frost to carry the contrast, and a colourless pane with no frost is a hole in the window.
  assert.match(block, /@supports not \(\(backdrop-filter:blur\(1px\)\) or \(-webkit-backdrop-filter:blur\(1px\)\)\)\{[\s\S]{0,160}--hns-color-bg-base:var\(--hns-glass-src-base\)[\s\S]{0,80}--hns-glass-alpha:92%/, 'the no-blur fallback leaves the pane colourless and unreadable')
})

test('a second-layer sheet frosts harder than the pane behind it', () => {
  const css = read('app/extensions/mega/ui/dock.css')
  const { tokens, block } = glassBlock()
  // A sheet is read *over* the dock's own text: a pane you can read the dock through is two texts
  // on top of each other. The float therefore takes more ink and a stronger blur than a pane.
  assert.match(tokens, /--hns-glass-float-alpha:calc\(var\(--hns-glass-alpha\) \+ 55%\)/, 'a sheet is as thin as the pane behind it')
  assert.match(tokens, /--hns-glass-float-blur:calc\(var\(--hns-glass-blur\) \+ 14px\)/, 'a sheet has no extra blur')
  assert.match(block, /:is\(\.pm-sheet,\.settings-sheet,\.live-view-sheet\)\{[\s\S]{0,120}background-color:color-mix\(in srgb,var\(--hns-glass-src-layer2\) var\(--hns-glass-float-alpha\),transparent\)/, 'the sheets do not use the float tint')
  assert.match(block, /:is\(\.pm-sheet,\.settings-sheet,\.live-view-sheet\)\{[\s\S]{0,220}backdrop-filter:var\(--hns-glass-float-filter\)/, 'the sheets do not use the float blur')
  // And the scrim under a sheet is dark enough that the dock behind reads as background.
  assert.match(tokens, /--hns-glass-scrim-alpha:calc\(var\(--hns-glass-alpha\) \+ 52%\)/, 'the scrim is as thin as the pane the dock already is')
  assert.match(block, /:is\(\.pm-backdrop,\.settings-overlay,\.live-view-overlay\)\{[\s\S]{0,160}var\(--hns-glass-scrim-alpha\)/, 'the scrims do not use the stronger tint')
  // Three controls, not five: the float is derived from the user's numbers rather than being a
  // second set of them.
  assert.equal(/hns-glass-float/.test(read('app/extensions/mega/ui/appearance-panel.js')), false, 'the panel grew controls for the float')
  assert.equal(/hns-glass-float/.test(read('app/extensions/mega/ui/glass-layer.js')), false, 'the layer writes float numbers the stylesheet derives')
})

test('the dock\'s type is white on black, and larger than it was', () => {
  const css = read('app/extensions/mega/ui/dock.css')
  // The pane is translucent, so a word can end up over anything at all. Legibility is carried by
  // the glyphs: a solid white fill with a thin black edge drawn *under* the fill, so the stroke
  // widens the letter instead of eating into it.
  assert.match(css, /--hns-text-fill:#ffffff/, 'the text fill is not white')
  assert.match(css, /--hns-text-stroke:#000000/, 'the stroke is not black')
  assert.match(css, /-webkit-text-stroke:var\(--hns-text-stroke-width\) var\(--hns-text-stroke\)/, 'the dock\'s text is not stroked')
  assert.match(css, /paint-order:stroke fill/, 'the stroke would eat into the glyphs')
  assert.match(css, /--hns-color-label-primary:#ffffff/, 'the primary label is not white')
  // The sizes moved up with it: the palette tokens, and the small hard-coded declarations that
  // make up almost all of the dock's type.
  assert.match(css, /--hns-font-size-body:14px/)
  assert.match(css, /--hns-font-size-caption:12px/)
  assert.match(css, /--hns-font-size-title:17px/)
  assert.equal(/font-size:([1-9])px/.test(css), false, 'the dock still has single-digit type')
})

test('the switch persists, and refuses values it cannot honour', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshns-glass-'))
  try {
    const file = path.join(dir, 'data', 'state', 'ui-glass.json')
    const glass = createUiGlass({ root: dir, log: () => {} })
    // The shipped state: on, and described with the limits the panel's controls use.
    const initial = glass.describe()
    assert.equal(initial.ok, true)
    assert.equal(initial.enabled, true)
    assert.equal(initial.blur, GLASS_DEFAULT.blur)
    assert.equal(initial.opacity, GLASS_DEFAULT.opacity)
    assert.equal(initial.source, 'default')
    assert.equal(initial.file, file)
    assert.deepEqual(initial.limits.blur, { ...GLASS_LIMITS.blur })
    // The floor is a requirement, not a taste: the dock sits over the official UI, and 5% is what
    // lets the blur alone do the work when the user asks for it. Anything above this is ink the
    // official interface no longer owns.
    assert.equal(GLASS_LIMITS.opacity.min, 5, 'the glass floor moved away from nearly invisible')
    assert.equal(initial.limits.opacity.min, 5, 'the panel would clamp higher than the state file allows')

    // A change is written, and a second reader sees it.
    const changed = glass.set({ enabled: false, blur: 26, opacity: 71 })
    assert.equal(changed.ok, true)
    assert.equal(changed.enabled, false)
    assert.equal(changed.blur, 26)
    assert.equal(changed.source, 'user')
    const reread = createUiGlass({ root: dir }).describe()
    assert.equal(reread.enabled, false)
    assert.equal(reread.blur, 26)
    assert.equal(reread.opacity, 71)

    // Out-of-range and unknown values: clamped, ignored, never stored.
    const clamped = glass.set({ blur: 999, opacity: 1, nonsense: 'yes' })
    assert.equal(clamped.blur, GLASS_LIMITS.blur.max)
    assert.equal(clamped.opacity, GLASS_LIMITS.opacity.min)
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.deepEqual(Object.keys(stored).sort(), ['blur', 'enabled', 'opacity'], 'an unknown key was written to the state file')
    assert.equal(stored.nonsense, undefined)

    // A malformed file is a preference that failed to persist, not a crash.
    fs.writeFileSync(file, '{ not json', 'utf8')
    const broken = createUiGlass({ root: dir }).describe()
    assert.equal(broken.enabled, GLASS_DEFAULT.enabled)
    assert.equal(broken.blur, GLASS_DEFAULT.blur)

    // Deployment defaults are honoured when the user has not chosen.
    const configured = createUiGlass({ root: dir, defaults: { enabled: false, blur: 30 } }).describe()
    assert.equal(configured.enabled, false)
    assert.equal(configured.blur, 30)
    assert.equal(configured.source, 'default')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the dock script moves the document, not just the file', async () => {
  const source = fs.readFileSync(path.join(UI, 'glass-layer.js'), 'utf8')
  const set = new Map()
  const document = {
    body: { dataset: {} },
    documentElement: { style: { setProperty: (name, value) => set.set(name, value) } },
    getElementById: () => null
  }
  const calls = []
  const window = {
    document,
    megaTools: {
      glass: {
        describe: async () => ({ ok: true, enabled: false, blur: 24, opacity: 70 }),
        set: async (patch) => {
          calls.push(patch)
          return { ok: true, enabled: true, blur: 24, opacity: 70, ...patch }
        },
        onChanged: () => {}
      }
    }
  }
  window.window = window
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', source)(window, document)
  assert.equal(typeof window.hnsGlass, 'object', 'the glass layer published no global')

  await window.hnsGlass.refresh()
  assert.equal(document.body.dataset.glass, 'off', 'the state from the shell was not applied to the document')
  assert.equal(set.get('--hns-glass-blur'), '24px', 'the blur was not written as a custom property')
  assert.equal(set.get('--hns-glass-alpha'), '70%', 'the translucency was not written as a custom property')

  // The layer is the model: a patch goes through the shell and the *answer* is applied. The
  // controls that call it are the Appearance panel's, and they are covered by
  // `appearance-panel.test.js` — which is where the live-preview behaviour belongs.
  const applied = await window.hnsGlass.set({ enabled: true })
  assert.deepEqual(calls[0], { enabled: true })
  assert.equal(applied.enabled, true)
  assert.equal(document.body.dataset.glass, 'on', 'the answer from the shell was not applied')
  assert.deepEqual(window.hnsGlass.state(), { enabled: true, blur: 24, opacity: 70 })

  // A second patch goes through the shell too, and the answer is what lands.
  const local = await window.hnsGlass.set({ blur: 6 })
  assert.deepEqual(calls[1], { blur: 6 })
  assert.equal(local.blur, 6)

  // A page opened outside the shell still has a working layer: with no bridge the patch is
  // applied locally rather than dropped.
  delete window.megaTools
  const offline = await window.hnsGlass.set({ blur: 13 })
  assert.equal(offline.blur, 13)
  assert.equal(set.get('--hns-glass-blur'), '13px')
  assert.equal(calls.length, 2, 'a patch with no bridge tried to call one')

  // Followers see every change, which is how the panel keeps its readouts in step.
  const seen = []
  window.hnsGlass.onChange((next) => seen.push(next.blur))
  window.hnsGlass.apply({ blur: 11 })
  assert.deepEqual(seen, [11])
})

test('the layer is wired end to end: shell file, channels, bridge and panel controls', () => {
  const index = read('app/extensions/mega/index.cjs')
  const preload = read('app/extensions/mega/ui/preload.cjs')
  const html = read('app/extensions/mega/ui/dock.html')
  const features = read('app/extensions/mega/features.cjs')

  assert.match(index, /'mega:ui-glass', 'mega:ui-glass-set'/, 'the glass channels are not declared for cleanup')
  assert.match(index, /ipcMain\.handle\('mega:ui-glass'[\s\S]{0,120}glass\(\)\.describe\(\)/)
  assert.match(index, /ipcMain\.handle\('mega:ui-glass-set'[\s\S]{0,200}glass\(\)\.set\(/, 'the shell does not own the setter')
  assert.match(index, /require\('\.\/ui-glass\.cjs'\)/, 'the extension does not own a glass state module')
  assert.match(read('app/extensions/mega/ui-glass.cjs'), /path\.join\(root, 'data', 'state', 'ui-glass\.json'\)/, 'the glass state is not stored beside the other user state')
  assert.match(index, /dockTarget\.send\('mega:ui-glass-changed'/, 'a second surface would never see the change')
  assert.match(preload, /glass: \{[\s\S]{0,300}describe: \(\) => ipcRenderer\.invoke\('mega:ui-glass'\)/)
  assert.match(preload, /onChanged: \(callback\) => ipcRenderer\.on\('mega:ui-glass-changed'/)
  // The switch is chrome, not a feature: it must not be gated, or a user who switched something
  // off could not read the panel that says so.
  assert.equal(/ui-glass/.test(features), false, 'the glass layer was made a feature, which would let it hide itself')
  for (const id of ['glassEnabled', 'glassBlur', 'glassOpacity']) {
    assert.match(html, new RegExp(`id="${id}"`), `the Appearance panel has no ${id} control`)
  }
  // And the panel is where a visual property belongs — the whole of it, since the panel is now
  // the glass's control surface and nothing else.
  const panel = html.slice(html.indexOf('id="appearancePanel"'))
  const section = panel.slice(0, panel.indexOf('</section>'))
  for (const id of ['glassEnabled', 'glassBlur', 'glassOpacity', 'glassRow']) {
    assert.ok(section.includes(`id="${id}"`), `#${id} is outside the Appearance panel`)
  }
})
