'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

/**
 * The Mega Core Plugin's browser half (`app/plugins/mega-core/lib/client.js`, `updateplan/pluginize.md` §4).
 *
 * This is the half that no Node test can *see*, so it is loaded the way the shell loads it — through
 * `window.__ModuleLoader__`, with `require('react')` answered from a platform table — and then driven: the
 * bundle's shape, the two slots it registers into, what the orb draws for a given snapshot, that a drag ends
 * in one stored position, that a click cannot pull focus out of the composer, and that a hidden document
 * stops asking DS-Hns anything.
 *
 * The React stand-in below is deliberately tiny and deliberately not a React implementation: it renders the
 * same element trees (§4's output is what is asserted) and runs effects, which is exactly as much as these
 * properties need. It is *not* a substitute for the real UI review — the manual checkpoint is where "the orb
 * looks right in the actual window" gets answered.
 */

const ROOT = path.resolve(__dirname, '..', '..')
const CLIENT = path.join(ROOT, 'app', 'plugins', 'mega-core', 'lib', 'client.js')
const source = fs.readFileSync(CLIENT, 'utf8')

/** A governance view, shaped like `view.js`'s answer with two things wanting attention. */
function fixtureView(overrides = {}) {
  return {
    ok: true,
    available: true,
    reason: null,
    status: { tone: 'warn', label: 'Degraded', attention: 2, active: 5, total: 7, pending: 1, failing: 0 },
    hover: ['DS-Hns', 'Degraded', '5 of 7 plugin(s) active', '1 pending'],
    lines: [
      { tone: 'warn', text: '⚠ mega:dock degraded — the dock did not paint' },
      { tone: 'warn', text: '⏸ 1 task(s) waiting for human' },
      { tone: 'ok', text: '✓ 2 of 2 bundled plugin(s) installed' }
    ],
    actions: ['check', 'retry'],
    fields: [
      { id: 'health', cn: '插件健康', en: 'Plugin health', value: '5/7', tone: 'warn' },
      { id: 'pin', cn: '版本钉', en: 'Update pin', value: 'dsh-wallpaper-engine @ v0.7.1', tone: null }
    ],
    modules: [{ id: 'mega:dock', state: 'DEGRADED', retries: 2, lastError: 'the dock did not paint', tone: 'warn', actions: ['check', 'retry'] }],
    plugins: [{ id: 'dsh-wallpaper-engine', state: 'installed', installedVersion: '0.7.1', expected: 'v0.7.1', channel: 'harness-profile', tested: true, tone: 'ok', actions: ['repair'] }],
    capabilities: ['check', 'retry', 'reset-fallback', 'repair', 'disable', 'enable'],
    at: '2026-09-15T00:00:00.000Z',
    ...overrides
  }
}

/**
 * The React stand-in: `createElement`, the four hooks the bundle uses, and a renderer that walks the tree so
 * only host elements are left. Hook state is per component instance and survives a re-render (`hooks`).
 *
 * Host elements also get a `node` with the two DOM affordances this UI actually uses — `getBoundingClientRect`
 * (measured against the box the test configures) and `parentElement` — plus ref attachment, because the orb
 * measures the layer it is mounted in and drags itself relative to the pointer. That is the difference between
 * testing the geometry rules and testing a mock of them.
 */
function createReactShim(initialBox = { width: 1440, height: 900 }) {
  let current = null
  let pendingEffects = []
  let box = { ...initialBox }

  function makeNode(parentNode) {
    return {
      getBoundingClientRect: () => ({ width: box.width, height: box.height, left: 0, top: 0 }),
      parentElement: parentNode,
      setPointerCapture() {},
      releasePointerCapture() {}
    }
  }

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
    },
    useRef(initial) {
      const index = current.cursor++
      if (current.hooks.length <= index) current.hooks[index] = { current: initial }
      return current.hooks[index]
    },
    useCallback(fn) { return fn },
    useMemo(fn) { return fn() }
  }

  function invoke(Component, props, hooks) {
    const previous = current
    current = { hooks, cursor: 0 }
    const element = Component(props)
    current = previous
    return element
  }

  /** Replace every function component with what it renders, so assertions read the real element tree. */
  function expand(element, children, parentNode = null) {
    if (!element || typeof element !== 'object' || element.$$element !== true) return element
    if (typeof element.type === 'function') {
      const hooks = children.get(element.type) || []
      const rendered = invoke(element.type, element.props, hooks)
      children.set(element.type, hooks)
      return expand(rendered, children, parentNode)
    }
    const node = makeNode(parentNode)
    if (element.props.ref && typeof element.props.ref === 'object') element.props.ref.current = node
    const kids = element.props.children
    const next = Array.isArray(kids)
      ? kids.map((child) => expand(child, children, node))
      : (kids === undefined ? undefined : expand(kids, children, node))
    return { ...element, props: { ...element.props, children: next }, node }
  }

  /**
   * Render one component. `state` is what a caller passes back on a re-render: `{ hooks, children }`.
   */
  function render(Component, props, state = { hooks: [], children: new Map() }) {
    pendingEffects = []
    const element = invoke(Component, props, state.hooks)
    const tree = expand(element, state.children)
    const effects = pendingEffects.slice()
    pendingEffects = []
    for (const effect of effects) effect()
    return { tree, state, effects: effects.length }
  }

  return {
    React,
    render,
    /** Resize the box the host elements report, the way a window or panel resize would. */
    resize(next) { box = { ...box, ...next } },
    box: () => ({ ...box })
  }
}

/** A `fetch` that answers the plugin's three routes and records every call. */
function fakeFetch({ view = fixtureView(), position = null, action = { ok: true } } = {}) {
  const calls = []
  const impl = async (url, init = {}) => {
    calls.push({ url, init })
    const method = String(init.method || 'GET').toUpperCase()
    if (url === '/mega-core/view') return { json: async () => view }
    if (url === '/mega-core/orb') {
      if (method === 'GET') return { json: async () => ({ ok: true, position }) }
      const body = JSON.parse(String(init.body || '{}'))
      return { json: async () => ({ ok: true, position: body.position }) }
    }
    if (url === '/mega-core/action') return { json: async () => action }
    throw new Error(`no route for ${url}`)
  }
  impl.calls = calls
  return impl
}

/** The bundle, loaded the way the shell loads it. */
function load({ fetchImpl = fakeFetch(), visibility = 'visible' } = {}) {
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
      innerWidth: 1440,
      innerHeight: 900,
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

/** Every element in a tree that matches, so a test can find the panel or a button by what it is. */
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

/**
 * A value from inside the `vm` realm, as this realm's own object.
 *
 * `deepStrictEqual` compares prototypes, and an array built inside a `vm` context has that context's `Array`:
 * the values below are identical in every way that matters to a plugin, so the comparison is made after the
 * crossing rather than by identity of prototypes.
 */
const plain = (value) => JSON.parse(JSON.stringify(value ?? null))

/** Apply the plugin and hand back the store the two surfaces share (taken from the orb's own props). */
async function mount(options = {}) {
  const loaded = load(options)
  const { ctx, injected, effects } = fakeSlots()
  loaded.plugin.apply(ctx)
  await tick()
  const orb = injected.find((entry) => entry.name === 'shell.overlay')
  const page = injected.find((entry) => entry.name === 'settings.section')
  const orbRegistration = orb.callback()
  const pageRegistration = page.callback()
  return {
    ...loaded,
    ctx,
    injected,
    effects,
    orbRegistration,
    pageRegistration,
    // The registered component is `() => React.createElement(MegaOrb, { store })`, so its props are the store.
    store: orbRegistration.Component().props.store
  }
}

test('the bundle is the shape the module loader materialises, and it requires only React', () => {
  const loaded = load()
  assert.equal(loaded.definition.id, 'dsh-plugin-mega-core')
  assert.equal(typeof loaded.definition.factory, 'function')
  assert.deepEqual(loaded.required, ['react'], 'the browser half may only require what the platform table seeds')
  assert.equal(typeof loaded.plugin.apply, 'function')
  assert.deepEqual(plain(loaded.plugin.inject), ['slots'])
  // And it is a bundle for the loader, not a module for Node: no `import`, no `require` of our own files.
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

test('apply registers the orb in the official overlay slot and the page in the settings slot', async () => {
  const mounted = await mount()
  assert.deepEqual(mounted.injected.map((entry) => entry.name), ['shell.overlay', 'settings.section'])
  // `shell.overlay` is a list slot: a fresh id is added beside the shipped entries, and `order` only orders
  // occupants among themselves. `settings.section` is where §28 puts every entry that is not the orb.
  assert.deepEqual(plain(mounted.orbRegistration.descriptor), { name: 'shell.overlay', id: 'mega-orb', order: 100, label: 'Mega' })
  assert.deepEqual(plain(mounted.pageRegistration.descriptor), { name: 'settings.section', id: 'mega', order: 500, label: 'Mega' })
  // One poller for both surfaces, at the interval §4.3's "low resource use" asks for, and a disposer that
  // really stops it: a disabled plugin that kept its timer would be a leak with a UI attached.
  assert.equal(mounted.intervals.length, 1)
  assert.equal(mounted.intervals[0].ms, 15000)
  assert.equal(typeof mounted.effects[0], 'function')
  mounted.effects[0]()
  assert.deepEqual(mounted.cleared, [1])
  assert.equal(mounted.listeners.has('visibilitychange'), false, 'the visibility listener outlived the plugin')
})

/**
 * The orb, mounted and drivable.
 *
 * The first render measures the layer (an effect) and the second renders with the answer, which is exactly
 * what React does; `open()` then presses and releases without moving, which is a click. Hook state is carried
 * between renders, so `open` and the measured box survive.
 */
function mountOrb(mounted, box = { width: 1440, height: 900 }) {
  mounted.shim.resize(box)
  const MegaOrb = mounted.orbRegistration.Component().type
  let rendered = mounted.shim.render(MegaOrb, { store: mounted.store })
  rendered = mounted.shim.render(MegaOrb, { store: mounted.store }, rendered.state)
  const rerender = () => { rendered = mounted.shim.render(MegaOrb, { store: mounted.store }, rendered.state) }
  return {
    get tree() { return rendered.tree },
    get layer() { return rendered.tree },
    get orb() { return rendered.tree.props.children[0] },
    get panel() { return rendered.tree.props.children[1] || null },
    panelStyle: () => (rendered.tree.props.children[1] || { props: { style: {} } }).props.style,
    rerender,
    /** Press and release without moving: a click that must neither drag nor steal focus. */
    press({ move = null, event = {} } = {}) {
      const orb = rendered.tree.props.children[0]
      const base = { button: 0, clientX: 0, clientY: 0, pointerId: 1, preventDefault: () => {}, currentTarget: orb.node }
      orb.props.onPointerDown({ ...base, ...event })
      if (move) orb.props.onPointerMove({ ...base, ...move })
      orb.props.onPointerUp()
      rerender()
      return orb
    }
  }
}

test('the orb draws §4.2: its four hover lines, the attention count and the tone', async () => {
  const mounted = await mount()
  const driver = mountOrb(mounted)
  const { orb, layer } = driver
  assert.equal(orb.type, 'button', 'the orb must be a real button, so the keyboard can reach it')
  assert.equal(orb.props['data-hns-mega-orb'], 'on')
  assert.equal(orb.props['data-tone'], 'warn')
  assert.deepEqual(strings(orb), ['● 2'], 'the badge is the number of things that want attention')
  assert.equal(orb.props.title, 'DS-Hns\nDegraded\n5 of 7 plugin(s) active\n1 pending')
  assert.equal(orb.props['aria-label'], 'DS-Hns · Degraded · 5 of 7 plugin(s) active · 1 pending')
  assert.equal(orb.props.style.pointerEvents, 'auto', 'the click-through layer needs the orb to opt back in')
  assert.equal(orb.props.style.all, 'initial', 'the orb must not inherit official styles into its subtree')

  /**
   * Positioning, which the first UI review changed: the orb is placed **inside the layer's own box**, not
   * against the window. The wrapper is `fixed; inset: 0` (so it covers whatever box the slot gave us, even
   * inside a transformed ancestor) and the orb is `absolute` in it, anchored by `right`/`bottom`.
   */
  assert.equal(layer.props['data-hns-mega-layer'], 'on')
  assert.equal(layer.props.style.position, 'fixed')
  assert.equal(layer.props.style.inset, '0')
  assert.equal(orb.props.style.position, 'absolute')
  assert.equal(orb.props.style.bottom, '14px', 'the orb is anchored from the layer corner, not the window')
  assert.equal(orb.props.style.right, '14px')
  assert.equal('left' in orb.props.style, false, 'a window-coordinate position would use left/top')
  assert.equal('top' in orb.props.style, false)
})

test('a click opens the panel without taking focus, and the panel carries the lines and the fields', async () => {
  const mounted = await mount()
  const driver = mountOrb(mounted)
  const orb = driver.orb

  const prevented = []
  const event = { button: 0, clientX: 1400, clientY: 860, pointerId: 7, preventDefault: () => prevented.push('pointerdown'), currentTarget: orb.node }
  orb.props.onPointerDown(event)
  // §4.3: a click on the orb must not pull focus out of the composer mid-sentence. `preventDefault` on
  // pointerdown is what makes that true while the button stays in the tab order.
  assert.deepEqual(prevented, ['pointerdown'])
  orb.props.onPointerUp(event)
  await tick()

  driver.rerender()
  const panel = driver.panel
  assert.ok(panel, 'the click did not open the panel')
  const said = strings(panel).join(' | ')
  assert.match(said, /mega:dock degraded/)
  assert.match(said, /1 task\(s\) waiting for human/)
  assert.match(said, /5\/7/)
  // §4.4's page is reachable from the orb too, and the panel says where the official copy lives rather than
  // offering a button that could not work (the settings modal's open state is component-local in the shell).
  assert.match(said, /Settings › Mega/)
  // The panel is our own box, so it does opt back into pointer events: the overlay layer around it does not.
  assert.equal(panel.props.style.pointerEvents, 'auto')
  assert.equal(panel.props.role, 'dialog')
})

test('the panel grows up and left out of the corner it is anchored to, not in a fixed scrolling box', async () => {
  const mounted = await mount()
  const driver = mountOrb(mounted, { width: 1440, height: 900 })
  driver.press()

  // The default corner: bottom-right. There is room above, so the panel opens *upward*, its right edge
  // aligned with the orb's, and its height is the room that is actually there — not a `70vh` box.
  assert.equal(driver.panel.props['data-hns-mega-panel-side'], 'above')
  // ...and it extends toward the middle horizontally as well: the orb is in the right half, so the panel's
  // left edge is where its growth happens.
  assert.equal(driver.panel.props['data-hns-mega-panel-across'], 'left')
  const opened = driver.panelStyle()
  assert.equal(opened.bottom, '64px', 'the panel sits above the orb, so its bottom is the orb\'s top + gap')
  assert.equal(opened.right, '14px', 'its right edge is the orb\'s, so it grows leftward')
  assert.equal('left' in opened, false)
  assert.equal('top' in opened, false)
  // 900 (layer) - 14 (orb bottom) - 40 (orb) = 846 above the orb, minus the gap and the margin.
  assert.equal(opened.maxHeight, '822px')
  assert.equal(/vh$/.test(String(opened.maxHeight)), false, 'a viewport-relative cap ignores the layer box')
  assert.equal('height' in opened, false, 'the panel is as tall as its content, not a fixed box')

  // An orb near the top of the layer has the room below it instead, and the panel uses that side: the rule is
  // "grow away from the corner", and which corner that is depends on where the user left the orb.
  mounted.store.setPosition({ right: 14, bottom: 780, edge: 'right' })
  await tick()
  driver.rerender()
  assert.equal(driver.panel.props['data-hns-mega-panel-side'], 'below')
  assert.equal(driver.panel.props['data-hns-mega-panel-across'], 'left')
  const flipped = driver.panelStyle()
  assert.equal(flipped.top, '130px', 'below the orb: its top is the orb\'s bottom + gap')
  assert.equal(flipped.maxHeight, '756px')

  // An orb dragged to the left edge keeps its panel on that side, growing rightward: the panel never hangs
  // off the edge it is anchored to.
  mounted.store.setPosition({ right: 1200, bottom: 14, edge: 'left' })
  await tick()
  driver.rerender()
  assert.equal(driver.orb.props.style.left, '14px', 'an edge-snapped orb asks for that edge')
  assert.equal('right' in driver.orb.props.style, false)
  const left = driver.panelStyle()
  assert.equal(left.left, '14px', 'the panel follows the orb to the left edge')
  assert.equal('right' in left, false)
  // Left half → the panel extends rightward, which is the other half of "toward the middle".
  assert.equal(driver.panel.props['data-hns-mega-panel-across'], 'right')

  // And the two axes are decided independently, by the half the orb is in rather than by the room: an orb in
  // the middle of the left edge opens its panel to the right *and* downward, because the middle of the screen
  // is to its right and below it.
  mounted.store.setPosition({ right: 1200, bottom: 500, edge: 'left' })
  await tick()
  driver.rerender()
  assert.equal(driver.panel.props['data-hns-mega-panel-side'], 'below')
  assert.equal(driver.panel.props['data-hns-mega-panel-across'], 'right')
  assert.equal(driver.panelStyle().top, '410px', 'below an orb whose top is 360 px down: 360 + 40 + 10')

  // The readability fix from the same review: both surfaces sit on an opaque card of their own, because the
  // page is drawn on the official frosted panel and our text has its own palette.
  assert.equal(left.background, 'rgba(14,16,20,.97)')
  assert.equal(left.color, '#ededed')
})

test('a drag moves the orb, snaps it to the nearer edge and stores it exactly once', async () => {
  const mounted = await mount({ fetchImpl: fakeFetch({ position: null }) })
  const driver = mountOrb(mounted)
  const before = mounted.fetchImpl.calls.filter((call) => call.url === '/mega-core/orb' && String(call.init.method || 'GET') === 'POST').length

  /**
   * The drag is **relative**: it adds the pointer's movement to the distances from the layer's corner, which
   * is why the same gesture works whether the orb is at the window's bottom-right or inside a box that does
   * not fill it. Left and up both increase those distances.
   */
  const box = { width: 1440, height: 900 }
  // Where the orb actually is: its default corner, so its rectangle starts 1386/846 in from the corner.
  const grabbed = {
    getBoundingClientRect: () => ({ left: 1386, top: 846, width: 40, height: 40 }),
    parentElement: { getBoundingClientRect: () => ({ ...box, left: 0, top: 0 }) },
    setPointerCapture() {}
  }
  const orb = driver.orb
  orb.props.onPointerDown({ button: 0, clientX: 1406, clientY: 866, pointerId: 4, preventDefault: () => {}, currentTarget: grabbed })
  // 680 px left and 140 px up from the grab point: 14 + 680 from the right, 14 + 140 from the bottom.
  orb.props.onPointerMove({ clientX: 706, clientY: 706 })
  assert.deepEqual(plain(mounted.store.snapshot().position), { right: 694, bottom: 154, edge: null }, 'the drag did not move the orb')
  orb.props.onPointerMove({ clientX: 34, clientY: 866 })
  assert.equal(mounted.store.snapshot().position.edge, null, 'a drag in progress is not snapped yet')
  orb.props.onPointerUp()
  await tick()

  const posts = mounted.fetchImpl.calls.filter((call) => call.url === '/mega-core/orb' && String(call.init.method || 'GET') === 'POST')
  assert.equal(posts.length, before + 1, 'a drag must end in exactly one stored position, not one per pixel')
  const stored = JSON.parse(posts[posts.length - 1].init.body)
  // Released 34 px from the layer's left edge: close enough to snap, and the orb follows that edge from now on.
  assert.deepEqual(stored.position, { right: 1366, bottom: 14, edge: 'left' })
  assert.equal(mounted.store.snapshot().position.edge, 'left')

  // And a keyboard nudge moves it the same way, so the orb is not pointer-only. (The store told the component
  // to re-render, which is what React does through `useStore`; the shim re-renders when it is asked to.)
  driver.rerender()
  const arrows = []
  driver.orb.props.onKeyDown({ key: 'ArrowUp', preventDefault: () => arrows.push('up') })
  await tick()
  assert.deepEqual(arrows, ['up'])
  // Up by one step: 14 px from the bottom becomes 26.
  assert.equal(mounted.store.snapshot().position.bottom, 26)
  assert.equal(mounted.store.snapshot().position.edge, 'left')
})

test('the orb comes back where it was left, from the host — not from localStorage', async () => {
  const mounted = await mount({ fetchImpl: fakeFetch({ position: { right: 300, bottom: 250, edge: 'left' } }) })
  assert.deepEqual(mounted.store.snapshot().position, { right: 300, bottom: 250, edge: 'left' })
  // The reason is the loopback port: an origin-scoped store is a position that resets on every restart, and
  // the host half exists precisely to be the place that does not.
  // The comment above explains why; the assertion is that nothing in the bundle ever *touches* it.
  assert.equal(/localStorage\s*[.[]/.test(source), false, 'the orb position must not be kept in the page origin')
  assert.equal(mounted.fetchImpl.calls.some((call) => call.url === '/mega-core/orb'), true)
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

test('the settings page renders §4.4 and its actions go through the governance action route', async () => {
  const mounted = await mount()
  const MegaPage = mounted.pageRegistration.Component().type
  const rendered = mounted.shim.render(MegaPage, { store: mounted.store, close: () => {} })
  const said = strings(rendered.tree).join(' | ')
  assert.match(said, /插件健康/, 'the page must show §4.4\'s fields')
  assert.match(said, /Plugin health/)
  assert.match(said, /版本钉/)
  assert.match(said, /dsh-wallpaper-engine @ v0\.7\.1/)
  // The first UI review found this page as white text on the official frosted panel. Our text has its own
  // palette, so the page brings its own opaque card instead of assuming a background.
  assert.equal(rendered.tree.props.style.background, 'rgba(14,16,20,.97)', 'the page must bring its own card')
  assert.equal(rendered.tree.props.style.color, '#ededed')
  // Every action the page offers is one governance accepts, and asking is a POST of `{ action, id }`.
  const buttons = find(rendered.tree, (element) => element.type === 'button')
  const labels = buttons.map((element) => strings(element).join(''))
  assert.ok(labels.includes('retry'), `no action button reached the page: ${labels.join(', ')}`)
  const retry = buttons.find((element) => strings(element).join('') === 'retry')
  retry.props.onClick()
  await tick()
  const action = mounted.fetchImpl.calls.find((call) => call.url === '/mega-core/action')
  assert.ok(action, 'the action never left the page')
  assert.deepEqual(JSON.parse(action.init.body), { action: 'retry', id: null })
})

test('a plugin without React draws nothing instead of breaking the page it was invited into', () => {
  const definitions = []
  const sandbox = {
    console,
    document: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} },
    window: { __ModuleLoader__: { load(definition) { definitions.push(definition) } }, innerWidth: 800, innerHeight: 600 },
    setInterval, clearInterval, setTimeout, clearTimeout
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'mega-core-client.js' })
  const plugin = definitions[0].factory(() => { throw new Error('no react here') })
  const { ctx, injected, effects } = fakeSlots()
  const dispose = plugin.apply(ctx)
  assert.equal(typeof dispose, 'function')
  assert.deepEqual(injected, [], 'a plugin with no renderer registered a surface anyway')
  assert.deepEqual(effects, [], 'a plugin with no renderer started polling')
})
