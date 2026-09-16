'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

/**
 * The Mega Core Plugin's browser half (`app/plugins/mega-core/lib/client.js`).
 *
 * One surface now — the Mega page in the official Settings — because the review of the two balls was "只要系统
 * 最外层那个" and the survivor is the system ball (`app/extensions/mega/system-orb.cjs`), which does not need
 * this window to be in front. So the properties worth asserting here are the bundle's shape (loaded the way
 * the shell loads it), that it registers **only** the settings section, that the page renders §4.4 from the
 * shell's view model with its own opaque card, and that it stops asking DS-Hns anything while it is hidden.
 *
 * The React stand-in is deliberately tiny: it renders element trees and runs effects, which is as much as
 * these properties need. It is not a substitute for the manual UI review.
 */

const ROOT = path.resolve(__dirname, '..', '..')
const CLIENT = path.join(ROOT, 'app', 'plugins', 'mega-core', 'lib', 'client.js')
const source = fs.readFileSync(CLIENT, 'utf8')

/** A governance view, shaped like `view.js`'s answer. */
function fixtureView() {
  return {
    ok: true,
    available: true,
    reason: null,
    status: { tone: 'warn', label: 'Degraded', attention: 2, active: 5, total: 7, pending: 1, failing: 0 },
    hover: ['DS-Hns', 'Degraded', '5 of 7 plugin(s) active', '1 pending'],
    lines: [
      { tone: 'warn', text: '⚠ mega:dock degraded — the dock did not paint' },
      { tone: 'ok', text: '✓ 2 of 2 bundled plugin(s) installed' }
    ],
    actions: ['check', 'retry'],
    fields: [
      { id: 'health', cn: '插件健康', en: 'Plugin health', value: '5/7', tone: 'warn' },
      { id: 'pin', cn: '版本钉', en: 'Update pin', value: 'dsh-wallpaper-engine @ v0.7.1', tone: null }
    ],
    modules: [{ id: 'mega:dock', state: 'DEGRADED', retries: 2, lastError: 'the dock did not paint', tone: 'warn', actions: ['check', 'retry'] }],
    plugins: [{ id: 'dsh-wallpaper-engine', state: 'installed', installedVersion: '0.7.1', expected: 'v0.7.1', channel: 'harness-profile', tested: true, tone: 'ok', actions: ['repair'] }],
    at: '2026-09-15T00:00:00.000Z'
  }
}

/** The React stand-in: `createElement`, the hooks the page uses, and a renderer that walks the tree. */
function createReactShim() {
  let current = null
  let pendingEffects = []

  const React = {
    createElement(type, props, ...children) {
      const kids = children.length === 0 ? undefined : children.length === 1 ? children[0] : children
      return { $$element: true, type, props: { ...(props || {}), children: kids } }
    },
    useState(initial) {
      const index = current.cursor++
      if (current.hooks.length <= index) current.hooks[index] = { value: typeof initial === 'function' ? initial() : initial }
      const slot = current.hooks[index]
      return [slot.value, (next) => { slot.value = typeof next === 'function' ? next(slot.value) : next }]
    },
    useEffect(fn, deps) {
      const index = current.cursor++
      const previous = current.hooks[index]
      current.hooks[index] = { fn, deps: Array.isArray(deps) ? deps.slice() : null }
      const changed = !previous || !Array.isArray(deps) || !Array.isArray(previous.deps)
        || deps.length !== previous.deps.length
        || deps.some((value, position) => value !== previous.deps[position])
      if (changed) pendingEffects.push(fn)
    }
  }

  function invoke(Component, props, hooks) {
    const previous = current
    current = { hooks, cursor: 0 }
    const element = Component(props)
    current = previous
    return element
  }

  function expand(element, children) {
    if (!element || typeof element !== 'object' || element.$$element !== true) return element
    if (typeof element.type === 'function') {
      const hooks = children.get(element.type) || []
      const rendered = invoke(element.type, element.props, hooks)
      children.set(element.type, hooks)
      return expand(rendered, children)
    }
    const kids = element.props.children
    const next = Array.isArray(kids)
      ? kids.map((child) => expand(child, children))
      : (kids === undefined ? undefined : expand(kids, children))
    return { ...element, props: { ...element.props, children: next } }
  }

  function render(Component, props, state = { hooks: [], children: new Map() }) {
    pendingEffects = []
    const element = invoke(Component, props, state.hooks)
    const tree = expand(element, state.children)
    const effects = pendingEffects.slice()
    pendingEffects = []
    for (const effect of effects) effect()
    return { tree, state }
  }

  return { React, render }
}

/** A `fetch` that answers the plugin's two routes and records every call. */
function fakeFetch({ view = fixtureView(), action = { ok: true } } = {}) {
  const calls = []
  const impl = async (url, init = {}) => {
    calls.push({ url, init })
    if (url === '/mega-core/view') return { json: async () => view }
    if (url === '/mega-core/action') return { json: async () => action }
    throw new Error(`no route for ${url}`)
  }
  impl.calls = calls
  return impl
}

/** The bundle, loaded the way the shell loads it. */
function load({ fetchImpl = fakeFetch(), visibility = 'visible', react = true } = {}) {
  const definitions = []
  const required = []
  const intervals = []
  const cleared = []
  const listeners = new Map()
  const document = {
    visibilityState: visibility,
    addEventListener(type, handler) { listeners.set(type, handler) },
    removeEventListener(type) { listeners.delete(type) }
  }
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval(fn, ms) { intervals.push({ fn, ms }); return intervals.length },
    clearInterval(id) { cleared.push(id) },
    document,
    window: {
      __ModuleLoader__: { load(definition) { definitions.push(definition) } },
      fetch: fetchImpl,
      addEventListener() {},
      removeEventListener() {}
    }
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'mega-core-client.js' })

  const shim = createReactShim()
  const definition = definitions[0]
  assert.ok(definition, 'the bundle did not call window.__ModuleLoader__.load')
  const plugin = definition.factory((name) => {
    required.push(name)
    if (!react) throw new Error('no react here')
    if (name === 'react') return shim.React
    throw new Error(`the bundle required ${name}, which is not in the platform table`)
  })
  return { definition, plugin, required, shim, sandbox, document, intervals, cleared, listeners, fetchImpl }
}

/** A slot service that records what a plugin injects, like the official one. */
function fakeSlots() {
  const injected = []
  const effects = []
  const ctx = {
    slots: {
      inject(name, callback) { injected.push({ name, callback }) },
      register(descriptor, Component) { return { descriptor, Component } }
    },
    effect(fn) { effects.push(fn()) }
  }
  return { ctx, injected, effects }
}

/** Every string in a rendered tree, in order — the cheapest honest way to ask "what does it say". */
function strings(element, out = []) {
  if (element === null || element === undefined || typeof element === 'boolean') return out
  if (typeof element === 'string' || typeof element === 'number') {
    out.push(String(element))
    return out
  }
  if (Array.isArray(element)) {
    for (const child of element) strings(child, out)
    return out
  }
  if (typeof element === 'object' && element.props) strings(element.props.children, out)
  return out
}

/** Every element in a tree that matches, so a test can find a button by what it is. */
function find(element, predicate, out = []) {
  if (!element || typeof element !== 'object') return out
  if (Array.isArray(element)) {
    for (const child of element) find(child, predicate, out)
    return out
  }
  if (element.$$element === true) {
    if (predicate(element)) out.push(element)
    find(element.props.children, predicate, out)
  }
  return out
}

const tick = () => new Promise((resolve) => setImmediate(resolve))
const plain = (value) => JSON.parse(JSON.stringify(value ?? null))

/** Apply the plugin and hand back the store the page uses (taken from the page's own props). */
async function mount(options = {}) {
  const loaded = load(options)
  const { ctx, injected, effects } = fakeSlots()
  loaded.plugin.apply(ctx)
  await tick()
  const page = injected.find((entry) => entry.name === 'settings.section')
  const pageRegistration = page.callback()
  return {
    ...loaded,
    ctx,
    injected,
    effects,
    pageRegistration,
    // The registered component is `(props) => React.createElement(MegaPage, { store, close })`.
    store: pageRegistration.Component({}).props.store
  }
}

test('the bundle is the shape the module loader materialises, and it requires only React', () => {
  const loaded = load()
  assert.equal(loaded.definition.id, 'dsh-plugin-mega-core')
  assert.equal(typeof loaded.definition.factory, 'function')
  assert.deepEqual(loaded.required, ['react'], 'the browser half may only require what the platform table seeds')
  assert.equal(typeof loaded.plugin.apply, 'function')
  assert.deepEqual(plain(loaded.plugin.inject), ['slots'])
  assert.equal(/^\s*import\s/m.test(source), false, 'the client half must not use ESM imports')
  assert.equal(/require\((['"])(?!react)/.test(source), false, 'the client half must not require anything but react')
})

test('the bundle parses as a classic script, the way a combo is delivered', () => {
  /**
   * The loader serves application bundles as one concatenated, classic script: our file is parsed by the
   * browser alongside every other plugin's, so a parse error here does not fail this plugin — it fails the
   * app's boot. Compiling it as a classic script (no module syntax) is the cheapest way to keep that true.
   */
  assert.doesNotThrow(() => new vm.Script(source, { filename: 'mega-core-client.js' }))
  assert.equal(/(^|\n)\s*(export|import)\s/.test(source), false, 'module syntax would not parse in a classic script')
})

test('apply registers the Mega page — and no orb, because the only ball is the system one', async () => {
  const mounted = await mount()
  assert.deepEqual(mounted.injected.map((entry) => entry.name), ['settings.section'])
  assert.deepEqual(plain(mounted.pageRegistration.descriptor), { name: 'settings.section', id: 'mega', order: 500, label: 'Mega' })
  // The one ball lives in its own window (`system-orb.cjs`), so nothing here may claim the overlay slot: the
  // review that found two balls is the reason this assertion exists at all. (The code, not the prose: the
  // comment above the registration explains why the slot is gone, and it has to be able to name it.)
  assert.equal(/inject\(\s*['"]shell\.overlay['"]/.test(source), false, 'the in-UI orb is back')
  assert.equal(/mega-core\/orb/.test(source), false, 'the page has no business asking for a ball position')
  // One poller, at the interval §4.3's "low resource use" asks for, with a disposer that really stops it.
  assert.equal(mounted.intervals.length, 1)
  assert.equal(mounted.intervals[0].ms, 15000)
  assert.equal(typeof mounted.effects[0], 'function')
  mounted.effects[0]()
  assert.deepEqual(mounted.cleared, [1])
  assert.equal(mounted.listeners.has('visibilitychange'), false, 'the visibility listener outlived the plugin')
})

test('the page renders §4.4 on its own card, and its actions go through the governance route', async () => {
  const mounted = await mount()
  const MegaPage = mounted.pageRegistration.Component().type
  const rendered = mounted.shim.render(MegaPage, { store: mounted.store, close: () => {} })
  const said = strings(rendered.tree).join(' | ')

  assert.match(said, /插件健康/, 'the page must show §4.4\'s fields')
  assert.match(said, /Plugin health/)
  assert.match(said, /版本钉/)
  assert.match(said, /dsh-wallpaper-engine @ v0\.7\.1/)
  assert.match(said, /mega:dock degraded/)
  assert.match(said, /5\/7/)
  // The page is drawn on the official frosted column, and our text has its own palette: it brings its own
  // opaque card rather than assuming a background.
  assert.equal(rendered.tree.props.style.background, 'rgba(14,16,20,.97)')
  assert.equal(rendered.tree.props.style.color, '#ededed')

  // Every action the page offers is one governance accepts, and asking is a POST of `{ action, id }`.
  const buttons = find(rendered.tree, (element) => element.type === 'button')
  const labels = buttons.map((element) => strings(element).join(''))
  assert.ok(labels.includes('retry'), `no action button reached the page: ${labels.join(', ')}`)
  buttons.find((element) => strings(element).join('') === 'retry').props.onClick()
  await tick()
  const action = mounted.fetchImpl.calls.find((call) => call.url === '/mega-core/action')
  assert.ok(action, 'the action never left the page')
  assert.deepEqual(JSON.parse(action.init.body), { action: 'retry', id: null })
})

test('a hidden document is not polled, and becoming visible again polls immediately', async () => {
  const mounted = await mount()
  const polls = () => mounted.fetchImpl.calls.filter((call) => call.url === '/mega-core/view').length
  const before = polls()
  mounted.document.visibilityState = 'hidden'
  mounted.intervals[0].fn()
  assert.equal(polls(), before, 'a background tab asked DS-Hns for a snapshot nobody is looking at')
  mounted.document.visibilityState = 'visible'
  mounted.listeners.get('visibilitychange')()
  await tick()
  assert.equal(polls(), before + 1)
})

test('DS-Hns not answering is drawn as the reason, not as an empty page', async () => {
  const mounted = await mount({ fetchImpl: fakeFetch({ view: { ok: false, reason: 'DS-Hns is not running' } }) })
  const MegaPage = mounted.pageRegistration.Component().type
  const rendered = mounted.shim.render(MegaPage, { store: mounted.store, close: () => {} })
  const said = strings(rendered.tree).join(' | ')
  assert.match(said, /DS-Hns is not running/)
})

test('a plugin without React draws nothing instead of breaking the page it was invited into', () => {
  const loaded = load({ react: false })
  const { ctx, injected, effects } = fakeSlots()
  const dispose = loaded.plugin.apply(ctx)
  assert.equal(typeof dispose, 'function')
  assert.deepEqual(injected, [], 'a plugin with no renderer registered a section anyway')
  assert.deepEqual(effects, [], 'a plugin with no renderer started polling')
})
