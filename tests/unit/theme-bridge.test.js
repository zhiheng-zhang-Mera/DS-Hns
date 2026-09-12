'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

/**
 * Theme bridge.
 *
 * The bridge is the one integration point between a dock UI module and the theme
 * system, and its whole reason to exist is bidirectional adaptation:
 *
 *   theme -> module   slot styles become CSS custom properties, so a theme restyles
 *                     a panel (including one written after the theme).
 *   module -> theme   the module's own geometry reaches the engine, so a panel that
 *                     did not exist when the theme was authored is still visible to
 *                     theme validation.
 *
 * Both directions are asserted here, plus the properties that make a late
 * registration safe: payload replay, per-module isolation and single subscription.
 */
const BRIDGE = path.resolve(__dirname, '..', '..', 'app', 'extensions', 'mega', 'ui', 'theme-bridge.js')

function makeElement(id) {
  const classes = new Set()
  return {
    id,
    innerHTML: '',
    textContent: '',
    hidden: false,
    dataset: {},
    style: {
      values: new Map(),
      setProperty(name, value) { this.values.set(name, String(value)) },
      removeProperty(name) { this.values.delete(name) }
    },
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
      toggle: (name, on) => {
        const next = on === undefined ? !classes.has(name) : Boolean(on)
        if (next) classes.add(name)
        else classes.delete(name)
        return next
      }
    },
    getBoundingClientRect: () => ({ left: 4, top: 8, width: 120, height: 40 }),
    querySelector: () => null
  }
}

function installDom(selectors = {}) {
  const html = makeElement('html')
  const body = makeElement('body')
  const bySelector = new Map(Object.entries(selectors))
  global.document = {
    body,
    documentElement: html,
    head: { appendChild: () => {} },
    createElement: (tag) => makeElement(tag),
    getElementById: (id) => (id === 'html' ? html : id === 'body' ? body : makeElement(id)),
    querySelector: (selector) => bySelector.get(selector) || null
  }
  global.window = globalThis
  return { html, body, bySelector }
}

function payload(overrides = {}) {
  return {
    id: 'hns.demo.cyber-hud',
    name: 'Cyber HUD Demo',
    preview: false,
    css: '--hns-color-bg-base: #0b1019;\n--hns-color-label-primary: #eef2f8;',
    tokens: {},
    slots: {
      'hns.window.shell': { background: '#111826', border: '1px solid #252d3d', radius: '8px' },
      'hns.skill.card': { background: '#111826', border: '1px solid #252d3d', radius: '10px', label: '#eef2f8' },
      'hns.skill.tag': { background: '#172134', label: '#a7b1c2', radius: '999px' },
      'hns.skill.danger': { color: '#ef5d5d' },
      'common.button.primary': { background: '#4d93f8', label: '#0d1016' }
    },
    animation: { type: 'fade', intensity: 0.3 },
    persona: {
      enabled: true,
      decorationOpacity: 0.2,
      bannerOpacity: 0.1,
      avatarAsset: 'data:image/png;base64,AAAA',
      bannerAsset: 'none'
    },
    effectLevel: 0,
    effectLabel: 'full',
    ...overrides
  }
}

/** Load the bridge with a fake engine bridge. */
function loadBridge({ selectors = {}, engine = null } = {}) {
  const dom = installDom(selectors)
  const listeners = { apply: null, changed: null, probe: null, reportRegions: [] }
  const fake = engine || {
    paint: async () => ({ ok: true, payload: payload() }),
    reportRegions: (data) => listeners.reportRegions.push(data),
    onApply: (handler) => { listeners.apply = handler },
    onChanged: (handler) => { listeners.changed = handler },
    onProbeRegions: (handler) => { listeners.probe = handler }
  }
  global.window.megaTools = { theme: fake }
  delete require.cache[require.resolve(BRIDGE)]
  require(BRIDGE)
  return { dom, listeners, bridge: window.megaThemeBridge }
}

test('a theme payload becomes generic slot variables and legacy aliases', () => {
  const { dom, bridge } = loadBridge()
  bridge.paint(payload())

  const values = dom.html.style.values
  // Generic, so a panel written later needs no bridge change.
  assert.equal(values.get('--hns-slot-hns-skill-card-background'), '#111826')
  assert.equal(values.get('--hns-slot-hns-skill-card-radius'), '10px')
  assert.equal(values.get('--hns-slot-hns-skill-tag-label'), '#a7b1c2')
  assert.equal(values.get('--hns-slot-hns-skill-danger-color'), '#ef5d5d')
  // Legacy aliases, so the long-standing dock rules keep working.
  assert.equal(values.get('--hns-slot-shell-bg'), '#111826')
  assert.equal(values.get('--hns-slot-button-bg'), '#4d93f8')
  // Personalization layer.
  assert.equal(values.get('--hns-persona-decoration-opacity'), '0.2')
  assert.match(String(values.get('--hns-persona-avatar')), /^url\("data:image\/png;base64,/)
  assert.equal(values.get('--hns-persona-banner-asset'), 'none')
  assert.equal(dom.body.dataset.themeId, 'hns.demo.cyber-hud')
})

test('an unknown slot property is ignored rather than written blindly', () => {
  const { dom, bridge } = loadBridge()
  bridge.paint(payload({ slots: { 'hns.skill.card': { background: '#fff', notAProperty: 'evil' } } }))
  assert.equal(dom.html.style.values.get('--hns-slot-hns-skill-card-background'), '#fff')
  assert.equal(dom.html.style.values.has('--hns-slot-hns-skill-card-notAProperty'), false)
})

test('a module that registers after the theme was applied still receives it', () => {
  const { bridge } = loadBridge()
  bridge.paint(payload())

  const seen = []
  bridge.registerModule({ id: 'late-panel', slots: ['hns.skill.card'], onPaint: (data) => seen.push(data.id) })
  assert.deepEqual(seen, ['hns.demo.cyber-hud'], 'the last payload is replayed to a late registration')
})

test('every registered module is painted, and one failing module does not stop the rest', () => {
  const { bridge } = loadBridge()
  const first = []
  const second = []
  bridge.registerModule({ id: 'appearance', onPaint: (data) => first.push(data.id) })
  bridge.registerModule({
    id: 'skills',
    onPaint: () => {
      throw new Error('this module is broken')
    }
  })
  bridge.registerModule({ id: 'third', onPaint: (data) => second.push(data.id) })

  // The failing module logs; the others still paint.
  const originalError = console.error
  console.error = () => {}
  try {
    bridge.paint(payload())
  } finally {
    console.error = originalError
  }
  assert.deepEqual(first, ['hns.demo.cyber-hud'])
  assert.deepEqual(second, ['hns.demo.cyber-hud'], 'a later module is not skipped')
  assert.deepEqual(bridge.modules, ['appearance', 'skills', 'third'])
})

test('the bridge subscribes to the engine exactly once, however many modules register', () => {
  const { bridge, listeners } = loadBridge()
  let applySubscriptions = 0
  const engine = window.megaTools.theme
  const originalOnApply = engine.onApply
  engine.onApply = (handler) => {
    applySubscriptions += 1
    originalOnApply(handler)
  }
  bridge.registerModule({ id: 'one' })
  bridge.registerModule({ id: 'two' })
  bridge.registerModule({ id: 'three' })
  assert.equal(applySubscriptions, 1, 'one subscription serves every module')
  assert.equal(typeof listeners.apply, 'function')
})

test('geometry from every module is merged and reported to the engine', () => {
  const cardElement = makeElement('skillsList')
  const searchElement = makeElement('skillQuery')
  const { bridge, listeners } = loadBridge({
    selectors: { '#skillsList': cardElement, '#skillQuery': searchElement }
  })
  bridge.registerModule({
    id: 'skills',
    slotSelectors: { 'hns.skill.card': '#skillsList' },
    regionSelectors: { 'skills-search': '#skillQuery' }
  })

  const measured = bridge.reportRegions()
  assert.ok(measured, 'reportRegions returned measurements')
  assert.deepEqual(measured['hns.skill.card'], { x: 4, y: 8, width: 120, height: 40 })
  assert.deepEqual(measured['skills-search'], { x: 4, y: 8, width: 120, height: 40 })
  assert.deepEqual(measured.componentTree.modules, ['skills'])
  assert.ok(listeners.reportRegions.length >= 1, 'the engine received the measurements')

  // The engine probe asks every module for fresh geometry.
  const before = listeners.reportRegions.length
  listeners.probe()
  assert.ok(listeners.reportRegions.length > before)
})

test('a selector that matches nothing is omitted instead of reported as zero', () => {
  const { bridge } = loadBridge({ selectors: {} })
  bridge.registerModule({ id: 'skills', slotSelectors: { 'hns.skill.card': '#skillsList' } })
  const measured = bridge.reportRegions()
  assert.equal(measured['hns.skill.card'], undefined)
})

test('attachModule registers, fetches the active theme and reports geometry in one call', async () => {
  const element = makeElement('skillsList')
  const { bridge } = loadBridge({ selectors: { '#skillsList': element } })
  const painted = []
  const handle = await bridge.attachModule({
    id: 'skills',
    slotSelectors: { 'hns.skill.card': '#skillsList' },
    onPaint: (data) => painted.push(data.id)
  })
  assert.deepEqual(painted, ['hns.demo.cyber-hud'], 'the first paint happened before attach resolved')
  assert.deepEqual(bridge.modules, ['skills'])
  assert.equal(handle.id, 'skills')
  handle.dispose()
  assert.deepEqual(bridge.modules, [])
})

test('the bridge never evaluates theme content and only writes custom properties', () => {
  const source = fs.readFileSync(BRIDGE, 'utf8')
  assert.ok(!/eval\(/.test(source))
  assert.ok(!/new Function/.test(source))
  const { dom, bridge } = loadBridge()
  bridge.paint(payload({ css: '--hns-color-bg-base: #0b1019;' }))
  // The token block lands in a <style> element's text, never in body markup.
  assert.equal(dom.body.innerHTML, '')
})
