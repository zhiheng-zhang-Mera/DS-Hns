'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

/**
 * The Mega Core Plugin's browser half (`app/plugins/mega-core/lib/client.js`).
 *
 * Two surfaces, and each draws the half of the view model it is for: the orb opens on the **dashboard** (the
 * price window and its countdown, the account balance, the queue and the parallelism — what the old expanded
 * dock showed) and the official Settings page renders **governance** (§4.4's fields, the module roster, the
 * bundled plugins and their actions). So the properties worth asserting here are the bundle's shape (loaded the
 * way the shell loads it), which slots it claims, that the ball draws the live numbers while the page draws the
 * governance body, and that it stops asking DS-Hns anything while it is hidden.
 *
 * The React stand-in is deliberately tiny: it renders element trees and runs effects, which is as much as
 * these properties need. It is not a substitute for the manual UI review.
 */

const ROOT = path.resolve(__dirname, '..', '..')
const CLIENT = path.join(ROOT, 'app', 'plugins', 'mega-core', 'lib', 'client.js')
const source = fs.readFileSync(CLIENT, 'utf8')

/** A governance view, shaped like `view.js`'s answer — dashboard block and governance fields together. */
function fixtureView() {
  /**
   * The countdown and the moment the snapshot was taken, as one pair.
   *
   * They are relative to each other on purpose: the panel re-bases the countdown against `at` and ticks it, so
   * what a test can assert is the difference, not a wall-clock instant that would rot by tomorrow.
   */
  const at = new Date();
  const nextChange = new Date(at.getTime() + (27 * 60 + 12) * 1000).toISOString();
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
    /**
     * The live half. It is the same rows the Control Center's dashboard carries, countdown included, because
     * that is where they come from: `view.js` copies `controlCenter().dashboard` and turns `nextChangeIso` into
     * the countdown against `at`.
     */
    dashboard: {
      ok: true,
      reason: null,
      lines: [
        {
          id: 'price',
          cn: '价格',
          en: 'Price',
          rows: [
            { id: 'price:window', cn: '电费时段', en: 'Price window', value: 'OFF-PEAK', tone: null },
            { id: 'price:until-off-peak', cn: '距下一次谷价', en: 'Until off-peak', value: '27m 12s', tone: 'ok', nextChangeIso: nextChange }
          ]
        },
        {
          id: 'balance',
          cn: '账户',
          en: 'Account',
          rows: [
            { id: 'balance:total', cn: '总余额', en: 'Total balance', value: '¥ 12.50', tone: 'ok' },
            { id: 'balance:state', cn: '读取状态', en: 'Balance read', value: '正常 · ok', tone: 'ok' }
          ]
        }
      ],
      execution: [
        { id: 'execution:running', cn: '运行中的 worker', en: 'Running workers', value: '2', tone: 'busy' },
        { id: 'execution:queued', cn: '排队任务', en: 'Queued tasks', value: '3', tone: null }
      ],
      parallelism: [
        { id: 'parallelism:current', cn: '当前并行', en: 'Concurrency now', value: '4', tone: null },
        { id: 'parallelism:hardware-cap', cn: '硬件上限', en: 'Hardware cap', value: '6', tone: null }
      ],
      /**
       * The dashboard's own action, as the snapshot offers it: offered while a read could change the account
       * (this fixture has never been read) and withheld while it is current (`control-center.cjs` decides).
       */
      actions: [{ id: 'refresh-balance', cn: '刷新余额', en: 'Refresh balance', reason: 'unread' }]
    },
    modules: [{ id: 'mega:dock', state: 'DEGRADED', retries: 2, lastError: 'the dock did not paint', tone: 'warn', actions: ['check', 'retry'] }],
    plugins: [{ id: 'dsh-wallpaper-engine', state: 'installed', installedVersion: '0.7.1', expected: 'v0.7.1', channel: 'harness-profile', tested: true, tone: 'ok', actions: ['repair'] }],
    at: at.toISOString()
  }
}

/** The React stand-in: `createElement`, the hooks the two surfaces use, and a renderer that walks the tree. */
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
      // A cleaned-up effect is a cleared interval: the countdown's ticker has to be able to stop, or every
      // render of a panel would leave a timer behind it.
      if (changed) {
        if (previous && typeof previous.cleanup === 'function') previous.cleanup()
        pendingEffects.push({ index, fn })
      }
    },
    /**
     * `{ current }`, kept across renders like the real one.
     *
     * `current` stays `null` here, which is what makes the re-measuring path in `useBox` a no-op: there is no
     * layout in this sandbox, and a shim that pretended to measure would be asserting its own arithmetic.
     */
    useRef(initial) {
      const index = current.cursor++
      if (!current.hooks[index]) current.hooks[index] = { value: { current: initial === undefined ? null : initial } }
      return current.hooks[index].value
    },
    /**
     * A stable callback, like the real one: the same function back while its deps are equal.
     *
     * It matters here because the new-task dialog reads the timing surface from an effect whose dependency is this
     * callback — a fresh identity on every render would re-read the surface on every render, which is exactly the
     * kind of loop the real `useCallback` exists to prevent.
     */
    useCallback(fn, deps) {
      const index = current.cursor++
      const previous = current.hooks[index]
      const equal = previous && Array.isArray(deps) && Array.isArray(previous.deps)
        && deps.length === previous.deps.length
        && deps.every((value, position) => value === previous.deps[position])
      if (equal) return previous.fn
      current.hooks[index] = { fn, deps: Array.isArray(deps) ? deps.slice() : null }
      return fn
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
    for (const entry of effects) {
      const cleanup = entry.fn()
      // Kept on the effect's own slot, so the next run of the same effect can call it — the same contract React
      // has, and the one the countdown's interval depends on.
      state.hooks[entry.index] = { ...(state.hooks[entry.index] || {}), cleanup: typeof cleanup === 'function' ? cleanup : null }
    }
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

/**
 * The bundle, loaded the way the shell loads it.
 *
 * `primitives` is the platform table's owner of the official component primitives. This stand-in keeps their
 * *contract* (a `Modal` that is a portal with `role="dialog"`, a `Button` that is a real button and refuses to
 * fire while disabled) without keeping their styling, which is what the tests are about.
 */
function load({ fetchImpl = fakeFetch(), visibility = 'visible', react = true, primitives = true } = {}) {
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
    if (name === '@deepseek-ai/dsh-client-ui-primitives' && primitives) return createPrimitivesShim(shim.React)
    throw new Error(`the bundle required ${name}, which is not in the platform table`)
  })
  return { definition, plugin, required, shim, sandbox, document, intervals, cleared, listeners, fetchImpl }
}

/** The official primitives, in the shapes the plugin uses: `Modal`, `Button`, `IconPlusOutline16`. */
function createPrimitivesShim(React) {
  function Modal(props) {
    return React.createElement('div', {
      'data-primitive': 'modal',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': props.title,
      open: props.open,
      headless: props.headless
    }, props.children)
  }
  function Button(props) {
    const { variant, size, icon, loading, ...rest } = props
    return React.createElement('button', {
      ...rest,
      type: 'button',
      'data-primitive': 'button',
      'data-variant': variant || 'ghost',
      disabled: props.disabled === true || loading === true,
      onClick: (event) => {
        // A real button does not fire while disabled, and a test that allowed it would prove nothing about the
        // "there is nothing to send yet" state.
        if (props.disabled === true || loading === true) return
        if (typeof props.onClick === 'function') props.onClick(event)
      }
    }, [ icon || null, props.children ].filter(Boolean))
  }
  function IconPlusOutline16() {
    return React.createElement('span', { 'data-primitive': 'icon' }, '+')
  }
  return { Modal, Button, IconPlusOutline16 }
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

/**
 * Let the dialog's own promises settle.
 *
 * Opening it starts a `fetch` for the timing surface; the answer arrives on a later microtask, and a test that
 * rendered once would be reading the dialog *before* DS-Hns answered it — which is a state worth testing, but not
 * the one these tests are about. Rendering inside the loop is what lets the shim's effects run (the shim does not
 * re-render on its own), so "the answer arrived and the dialog used it" is observable.
 */
async function settle(render, times = 6) {
  for (let index = 0; index < times; index += 1) {
    if (render) render()
    await tick()
  }
}

const plain = (value) => JSON.parse(JSON.stringify(value ?? null))

/** Apply the plugin and hand back the store both surfaces use (taken from their own props). */
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
    newTaskRegistration: injected.find((entry) => entry.name === 'conversation.session.header.actions').callback(),
    // The registered components are `(props) => React.createElement(MegaOrb, { store })` and the same for the
    // page, so the store comes out of the element they return.
    orbComponent: orbRegistration.Component({}).type,
    pageComponent: pageRegistration.Component({}).type,
    newTaskComponent: injected.find((entry) => entry.name === 'conversation.session.header.actions').callback().Component({}).type,
    orbState: { hooks: [], children: new Map() },
    newTaskState: { hooks: [], children: new Map() },
    store: pageRegistration.Component({}).props.store
  }
}

test('the bundle requires only what the platform table seeds', () => {
  const loaded = load()
  assert.equal(loaded.definition.id, 'dsh-plugin-mega-core')
  assert.equal(typeof loaded.definition.factory, 'function')
  /**
   * The client bundle used to require React and nothing else. It now also uses the official component primitives
   * — the centred `Modal` and `Button` the new-task dialog is built from — and that name is in the platform table
   * the frontend builds (`{react, "react/jsx-runtime", "react-dom", …dsh-client-ui-slots, …primitives,
   * …dockkit}`), which is why requiring it is legal rather than a second dependency to install.
   */
  assert.deepEqual(loaded.required, ['react', '@deepseek-ai/dsh-client-ui-primitives'], 'the browser half may only require what the platform table seeds')
  assert.equal(typeof loaded.plugin.apply, 'function')
  assert.deepEqual(plain(loaded.plugin.inject), ['slots'])
  assert.equal(/^\s*import\s/m.test(source), false, 'the client half must not use ESM imports')
  assert.equal(/require\((['"])(?!react|@deepseek-ai\/dsh-client-ui-primitives)/.test(source), false, 'the client half required something the platform table does not seed')
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

test('apply claims three official slots: the ball, the page, and the conversation header', async () => {
  const mounted = await mount()
  assert.deepEqual(mounted.injected.map((entry) => entry.name), [
    'shell.overlay',
    'settings.section',
    'conversation.session.header.actions'
  ])
  assert.deepEqual(plain(mounted.orbRegistration.descriptor), { name: 'shell.overlay', id: 'mega-orb', order: 100, label: 'Mega' })
  assert.deepEqual(plain(mounted.pageRegistration.descriptor), { name: 'settings.section', id: 'mega', order: 500, label: 'Mega' })
  // The new-task entry sits with the official header actions (the jobs list is 20, the schedule clock is in the
  // lower twenties): a place you go to start something, not one more button inside the composer.
  assert.deepEqual(plain(mounted.newTaskRegistration.descriptor), { name: 'conversation.session.header.actions', id: 'mega-new-task', order: 30, label: '新建任务 · New task' })
  // The ball is draggable, so its position is read from and written to the host's own file; the *page* has no
  // business with it at all, which is the part that would be a bug if it drifted.
  assert.match(source, /const ORB_URL = '\/mega-core\/orb'/)
  assert.equal(/MegaPage[\s\S]{0,400}ORB_URL/.test(source), false, 'the settings page reached for the ball position')
  // One poller, at the interval §4.3's "low resource use" asks for, with a disposer that really stops it.
  assert.equal(mounted.intervals.length, 1)
  assert.equal(mounted.intervals[0].ms, 15000)
  assert.equal(typeof mounted.effects[0], 'function')
  mounted.effects[0]()
  assert.deepEqual(mounted.cleared, [1])
  assert.equal(mounted.listeners.has('visibilitychange'), false, 'the visibility listener outlived the plugin')
})

test('the ball opens on every category, all shut, each with its own headline', async () => {
  const mounted = await mount()
  const orb = mounted.shim.render(mounted.orbComponent, { store: mounted.store }, mounted.orbState)
  const ball = find(orb.tree, (element) => element.type === 'button' && element.props['data-hns-mega-orb'] === 'on')[0]
  assert.ok(ball, 'the orb drew no ball to click')

  // A press that does not move is a click: that is what opens the panel, so this is the real route in.
  ball.props.onPointerDown({ button: 0, preventDefault() {}, currentTarget: { getBoundingClientRect: () => ({ left: 0, top: 0 }) } })
  ball.props.onPointerUp()
  const opened = mounted.shim.render(mounted.orbComponent, { store: mounted.store }, mounted.orbState)
  const said = strings(opened.tree).join(' | ')

  // Every category is there, and **nothing is open**: the panel's first state is four headings and their headlines.
  for (const label of ['价格 · Price', '账户 · Account', '任务 · Tasks', '并行 · Parallelism']) {
    assert.match(said, new RegExp(label), `the ball lost the ${label} category`)
  }
  // Each heading carries its category's headline, which is what makes a shut panel readable at a glance.
  assert.match(said, /OFF-PEAK/, 'the price fold lost its window headline')
  assert.match(said, /正常 · ok/, 'the account fold lost its headline')
  // ...and no detail is drawn while everything is shut.
  assert.doesNotMatch(said, /电费时段/, 'a shut fold drew its detail anyway')
  assert.doesNotMatch(said, /27m 12s/, 'a shut fold drew its countdown anyway')
  // The recovery actions stay on the ball: a degraded module with no way to act on it is a status light.
  const labels = find(opened.tree, (element) => element.type === 'button').map((element) => strings(element).join(''))
  assert.ok(labels.includes('retry'), `the ball lost its actions: ${labels.join(', ')}`)
  // The rosters are the page's: a settings page behind a 40px dot is what this split exists to avoid.
  assert.doesNotMatch(said, /Bundled plugins/)
})

test('the ball folds its information into cards, all shut at first, one open at a time', async () => {
  const mounted = await mount()
  const orb = mounted.shim.render(mounted.orbComponent, { store: mounted.store }, mounted.orbState)
  const ball = find(orb.tree, (element) => element.type === 'button' && element.props['data-hns-mega-orb'] === 'on')[0]
  ball.props.onPointerDown({ button: 0, preventDefault() {}, currentTarget: { getBoundingClientRect: () => ({ left: 0, top: 0 }) } })
  ball.props.onPointerUp()

  /** The folds, in the order they are drawn, each with the value its heading carries while it is shut. */
  const folds = (rendered) => find(rendered.tree, (element) => element.props['data-hns-mega-category'])
    .map((element) => ({
      id: element.props['data-hns-mega-category'],
      open: element.props['data-open'] === 'on',
      expanded: element.props['aria-expanded'],
      says: strings(element).join(' · ')
    }));
  const openIds = (rendered) => folds(rendered).filter((fold) => fold.open).map((fold) => fold.id);
  /** The cards that are on screen: one per open fold, by id (`data-hns-mega-card` is the card itself). */
  const cards = (rendered) => find(rendered.tree, (element) => element.props['data-hns-mega-card'])
    .map((element) => ({ id: element.props['data-hns-mega-card'], background: element.props.style.background, radius: element.props.style.borderRadius }));

  const first = mounted.shim.render(mounted.orbComponent, { store: mounted.store }, mounted.orbState)
  const categories = folds(first)
  assert.deepEqual(categories.map((fold) => fold.id), ['price', 'balance', 'execution', 'parallelism'], 'the ball lost a category')
  // The rule, on the first frame: **all shut**, every heading carrying its headline.
  assert.deepEqual(openIds(first), [], 'a category opened itself')
  assert.deepEqual(cards(first), [], 'a shut panel drew a card')
  assert.equal(categories[0].expanded, false)
  assert.equal(categories[0].says, '▸ · 价格 · Price · OFF-PEAK')
  assert.equal(categories[1].says, '▸ · 账户 · Account · 正常 · ok')

  /** Clicking a heading opens it — and shuts whatever was open, which is the whole of "only one at a time". */
  const click = (rendered, id) => {
    const heading = find(rendered.tree, (element) => element.props['data-hns-mega-category'] === id)[0]
    assert.ok(heading, `no heading for ${id}`)
    heading.props.onClick()
    return mounted.shim.render(mounted.orbComponent, { store: mounted.store }, mounted.orbState)
  }

  const priceOpen = click(first, 'price')
  assert.deepEqual(openIds(priceOpen), ['price'])
  assert.deepEqual(cards(priceOpen).map((card) => card.id), ['price'], 'the open category is not a card of its own')
  // The card is visibly its own surface: lighter than the panel behind it and rounded, so the eye lands on it
  // without reading the caret.
  assert.equal(cards(priceOpen)[0].background, 'rgba(255,255,255,.055)')
  assert.equal(cards(priceOpen)[0].radius, '8px')
  assert.match(strings(priceOpen.tree).join(' | '), /27m 12s/, 'the open fold drew no detail')

  const balanceOpen = click(priceOpen, 'balance')
  assert.deepEqual(openIds(balanceOpen), ['balance'], 'opening the account left the price fold open too')
  assert.deepEqual(cards(balanceOpen).map((card) => card.id), ['balance'], 'two cards are on screen at once')
  const balanceSaid = strings(balanceOpen.tree).join(' | ')
  assert.match(balanceSaid, /¥ 12\.50/, 'the account fold opened without its detail')
  assert.doesNotMatch(balanceSaid, /27m 12s/, 'the price fold stayed open with the account')

  const tasksOpen = click(balanceOpen, 'execution')
  assert.deepEqual(openIds(tasksOpen), ['execution'])
  assert.match(strings(tasksOpen.tree).join(' | '), /排队任务/)

  // Clicking the open heading shuts it: all folds shut is a state the panel is allowed to be in.
  const allShut = click(tasksOpen, 'execution')
  assert.deepEqual(openIds(allShut), [])
  // Everything is still *there* — the headings and their headlines — it is the detail that is folded away.
  assert.match(strings(allShut.tree).join(' | '), /OFF-PEAK/)
  assert.match(strings(allShut.tree).join(' | '), /¥ 12\.50|正常 · ok/)
})

test('the panel offers the balance refresh, and clicking it posts the dashboard action with no id', async () => {
  const mounted = await mount()
  const orb = mounted.shim.render(mounted.orbComponent, { store: mounted.store }, mounted.orbState)
  const ball = find(orb.tree, (element) => element.type === 'button' && element.props['data-hns-mega-orb'] === 'on')[0]
  ball.props.onPointerDown({ button: 0, preventDefault() {}, currentTarget: { getBoundingClientRect: () => ({ left: 0, top: 0 }) } })
  ball.props.onPointerUp()
  const opened = mounted.shim.render(mounted.orbComponent, { store: mounted.store }, mounted.orbState)

  /**
   * The button exists because the account is the one number a *read* makes newer, and it is the snapshot's own
   * (`dashboard.actions`) — so a surface cannot offer a read the Control Center withheld, and cannot hide one it
   * offers.
   */
  const buttons = find(opened.tree, (element) => element.type === 'button')
  const refresh = buttons.find((element) => strings(element).join('') === '刷新余额 · Refresh balance')
  assert.ok(refresh, `the ball has no balance refresh: ${buttons.map((element) => strings(element).join('')).join(', ')}`)
  // The state that earned the button is on its hover text, so "why is this here" is answerable without a trip to
  // the logs.
  assert.match(refresh.props.title, /unread/)

  refresh.props.onClick()
  await tick()
  const action = mounted.fetchImpl.calls.find((call) => call.url === '/mega-core/action')
  assert.ok(action, 'the dashboard action never left the panel')
  // `id: null`: reading the account again is about the account, not about a module (`controlAction` answers this
  // one before its own id check, and the bridge's closed set is not widened by a read).
  assert.deepEqual(JSON.parse(action.init.body), { action: 'refresh-balance', id: null })
})

test('the countdown ticks on its own, once a second — not in fifteen-second jumps', async () => {
  const mounted = await mount()
  const orb = mounted.shim.render(mounted.orbComponent, { store: mounted.store }, mounted.orbState)
  const ball = find(orb.tree, (element) => element.type === 'button' && element.props['data-hns-mega-orb'] === 'on')[0]
  ball.props.onPointerDown({ button: 0, preventDefault() {}, currentTarget: { getBoundingClientRect: () => ({ left: 0, top: 0 }) } })
  ball.props.onPointerUp()
  const opened = mounted.shim.render(mounted.orbComponent, { store: mounted.store }, mounted.orbState)
  // The countdown is a detail row, so it is drawn once its category is open (the panel starts with everything shut).
  find(opened.tree, (element) => element.props['data-hns-mega-category'] === 'price')[0].props.onClick()
  mounted.shim.render(mounted.orbComponent, { store: mounted.store }, mounted.orbState)

  /**
   * The view arrives every 15 s, so a countdown drawn straight from it would move in 15-second jumps. The panel
   * re-bases it against `view.at` and ticks it: the assertion is that one tick of the 1 s timer is one second
   * off the number, computed from the pair the snapshot published rather than from this machine's clock.
   */
  const ticker = mounted.intervals.find((interval) => interval.ms === 1000)
  assert.ok(ticker, `the dashboard did not start a countdown ticker: ${mounted.intervals.map((i) => i.ms).join(', ')}`)
  ticker.fn()
  const ticked = mounted.shim.render(mounted.orbComponent, { store: mounted.store }, mounted.orbState)
  assert.match(strings(ticked.tree).join(' | '), /27m 11s/, 'the countdown did not move')
  assert.doesNotMatch(strings(ticked.tree).join(' | '), /27m 12s/)
})

test('the page renders §4.4 governance on its own card, and its actions go through the governance route', async () => {
  const mounted = await mount()
  const rendered = mounted.shim.render(mounted.pageComponent, { store: mounted.store, close: () => {} })
  const said = strings(rendered.tree).join(' | ')

  assert.match(said, /插件健康/, 'the page must show §4.4\'s fields')
  assert.match(said, /Plugin health/)
  assert.match(said, /版本钉/)
  assert.match(said, /dsh-wallpaper-engine @ v0\.7\.1/)
  assert.match(said, /mega:dock degraded/)
  assert.match(said, /5\/7/)
  // Governance is what the page is for: the live dashboard belongs to the ball, so the page does not repeat it.
  assert.doesNotMatch(said, /价格 · Price/)
  assert.doesNotMatch(said, /27m 12s/)
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

/** The timing surface as DS-Hns answers it, shaped like `scheduledTaskSurface()`. */
function fixtureTiming(overrides = {}) {
  return {
    ok: true,
    kind: 'scheduled-task',
    defaults: {
      startAt: new Date(Date.now() + 3 * 60_000).toISOString(),
      allowPeak: false,
      deliveryMode: 'official-session'
    },
    schedule: {
      timeZone: 'Asia/Shanghai',
      weekdays: [1, 2, 3, 4, 5],
      peakPeriods: [{ start: '09:00', end: '12:00' }, { start: '14:00', end: '18:00' }]
    },
    peak: { peak: false, nextChange: null },
    interruptRunningAtPeak: false,
    limits: { minStartOffsetSeconds: 0, maxStartAheadDays: 365 },
    deliveryModes: [
      { id: 'official-session', cn: '官方对话', en: 'Official conversation', default: true },
      { id: 'headless', cn: 'Headless 后台', en: 'Headless background', default: false }
    ],
    ...overrides
  }
}

/** A `fetch` that also answers the timing surface and the task route. */
function fakeNewTaskFetch({ timing = fixtureTiming(), task = { ok: true, task: { id: 'task-1', status: 'PENDING' } } } = {}) {
  const calls = []
  const impl = async (url, init = {}) => {
    calls.push({ url, init });
    if (url === '/mega-core/view') return { ok: true, status: 200, json: async () => fixtureView() };
    if (url === '/mega-core/action') return { ok: true, status: 200, json: async () => ({ ok: true }) };
    if (url === '/mega-core/timing') return { ok: timing.ok !== false, status: timing.ok === false ? 503 : 200, json: async () => timing };
    if (url === '/mega-core/task') return { ok: task.ok !== false, status: task.ok === false ? 400 : 200, json: async () => task };
    throw new Error(`no route for ${url}`);
  };
  impl.calls = calls;
  return impl;
}

/** Open the header action's dialog and hand back what it drew, with DS-Hns' answer already in it. */
async function openNewTask(options = {}) {
  const fetchImpl = options.fetchImpl || fakeNewTaskFetch(options.routes || {});
  const mounted = await mount({ fetchImpl });
  const draw = () => mounted.shim.render(mounted.newTaskComponent, {}, mounted.newTaskState);
  const trigger = find(draw().tree, (element) => element.type === 'button')[0];
  assert.ok(trigger, 'the header action drew no entry point');
  trigger.props.onClick();
  await settle(draw);
  return { ...mounted, rendered: draw(), draw, fetchImpl };
}

test('the header action opens a centred sub-page whose composer is the input and whose schedule is under it', async () => {
  const task = await openNewTask();
  const said = strings(task.rendered.tree).join(' | ');

  // The entry point is a real button in the conversation header, and what it opens is the official Modal — a
  // portal with `role="dialog"`, i.e. the centred sub-page rather than a card we positioned ourselves.
  const modal = find(task.rendered.tree, (element) => element.props['data-primitive'] === 'modal')[0];
  assert.ok(modal, 'the entry point opened no modal');
  assert.equal(modal.props['aria-modal'], 'true');
  assert.equal(modal.props.headless, true, 'the official chrome would put our footer in the wrong place');
  assert.match(said, /新建定时任务/);
  assert.match(said, /New scheduled task/);

  // The conversation input: a prompt box with the chat placeholder and the chat grammar.
  const prompt = find(task.rendered.tree, (element) => element.props['data-hns-mega-task-prompt'] === 'on')[0];
  assert.ok(prompt, 'the dialog has no prompt input');
  assert.equal(prompt.type, 'textarea');
  assert.match(prompt.props.placeholder, /和平时对话一样/);

  // The schedule sits **below** the input, and it is the DS-Hns answer that fills it in: the time field, the
  // presets, the peak switch, and the zone the windows belong to.
  const schedule = find(task.rendered.tree, (element) => element.props['data-hns-mega-task-schedule'] === 'on')[0];
  assert.ok(schedule, 'the dialog has no schedule section');
  assert.match(said, /定时设置/);
  assert.match(said, /发送时间/);
  assert.match(said, /时区 Asia\/Shanghai/);
  assert.match(said, /峰价时段 09:00-12:00, 14:00-18:00/);
  assert.match(said, /3 分钟后/);
  const timeField = find(task.rendered.tree, (element) => element.props['data-hns-mega-task-time'] === 'on')[0];
  assert.ok(timeField, 'the schedule has no time field');
  assert.match(timeField.props.value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'the default time is not in the field\'s own shape');
  // The spoken summary: when it will be sent, and how — the sentence the user commits to.
  assert.match(said, /作为官方新会话发出/);
})

test('Enter schedules the task, Shift+Enter is a newline, and an IME composition is neither', async () => {
  const task = await openNewTask();
  const postCount = () => task.fetchImpl.calls.filter((call) => call.url === '/mega-core/task').length;
  const promptField = (rendered) => find(rendered.tree, (element) => element.props['data-hns-mega-task-prompt'] === 'on')[0];

  // The button is disabled until there is something to send: no prompt, no task — and the dialog says so by
  // refusing rather than by posting an empty one.
  assert.equal(createButton(task.rendered).props.disabled, true, 'the dialog would schedule an empty task');

  // Typing goes through the ordinary onChange, and Enter during an IME composition must not send: a Chinese user
  // pressing Enter to commit a candidate would otherwise fire an unfinished prompt.
  promptField(task.rendered).props.onChange({ target: { value: '总结今天的构建日志' } });
  const typed = promptField(task.draw());
  const prevented = [];
  typed.props.onKeyDown({ key: 'Enter', shiftKey: false, nativeEvent: { isComposing: true }, preventDefault: () => prevented.push('composing') });
  assert.equal(postCount(), 0, 'an IME composition scheduled a task');
  // A newline never posts either.
  typed.props.onKeyDown({ key: 'Enter', shiftKey: true, nativeEvent: { isComposing: false }, preventDefault: () => prevented.push('shift') });
  assert.equal(postCount(), 0, 'Shift+Enter posted a task');
  assert.deepEqual(prevented, [], 'a newline or a composition was prevented');

  // And a real Enter does, with the prompt, the instant the field says, and the peak decision.
  const armed = promptField(task.draw());
  armed.props.onKeyDown({ key: 'Enter', shiftKey: false, nativeEvent: { isComposing: false }, preventDefault: () => prevented.push('send') });
  assert.deepEqual(prevented, ['send'], 'Enter did not take the keystroke');
  await settle(task.draw);
  const posted = task.fetchImpl.calls.filter((call) => call.url === '/mega-core/task');
  assert.equal(posted.length, 1, 'Enter did not schedule anything');
  const payload = JSON.parse(posted[0].init.body);
  assert.equal(payload.prompt, '总结今天的构建日志');
  assert.equal(payload.deliveryMode, 'official-session', 'a scheduled conversation must be delivered as a conversation');
  assert.equal(payload.allowPeak, false);
  // The instant is what the field meant: the same wall clock, as an ISO instant. (The default is three minutes
  // out, which is why this is not merely "some time in the future".)
  const typedInstant = new Date(payload.startAt);
  assert.equal(Number.isFinite(typedInstant.getTime()), true, `startAt is not an instant: ${payload.startAt}`);
  assert.ok(typedInstant.getTime() > Date.now() && typedInstant.getTime() <= Date.now() + 4 * 60_000, `the default time is not the field's own: ${payload.startAt}`);
})

test('a refusal is shown in DS-Hns words, and a task that exists is confirmed with its own id', async () => {
  const refused = await openNewTask({ routes: { task: { ok: false, reason: 'a task needs a prompt' } } });
  const promptField = (rendered) => find(rendered.tree, (element) => element.props['data-hns-mega-task-prompt'] === 'on')[0];
  promptField(refused.rendered).props.onChange({ target: { value: 'x' } });
  createButton(refused.draw()).props.onClick();
  await settle(refused.draw);
  assert.match(strings(refused.draw().tree).join(' | '), /a task needs a prompt/, 'a refusal was swallowed');

  const accepted = await openNewTask({ routes: { task: { ok: true, task: { id: 'task-abc123', status: 'PENDING', startAtMs: Date.now() + 120_000 } } } });
  promptField(accepted.rendered).props.onChange({ target: { value: '把报告发到工作区' } });
  createButton(accepted.draw()).props.onClick();
  await settle(accepted.draw);
  const said = strings(accepted.draw().tree).join(' | ');
  assert.match(said, /已加入队列 #task-abc123/, 'the dialog did not confirm the task it actually made');
  assert.match(said, /PENDING/);
  // A made task clears the box, so a second Enter cannot silently schedule the same prompt again.
  assert.equal(promptField(accepted.draw()).props.value, '');
})

/** The dialog's own submit button, by the words on it. */
function createButton(rendered) {
  return find(rendered.tree, (element) => element.props['data-primitive'] === 'button' && strings(element).join('') === '创建定时任务 · Schedule')[0];
}

test('a host without the official primitives draws no entry point rather than a broken box', () => {
  const loaded = load({ primitives: false })
  const { ctx, injected } = fakeSlots()
  loaded.plugin.apply(ctx)
  const registration = injected.find((entry) => entry.name === 'conversation.session.header.actions').callback()
  const rendered = loaded.shim.render(registration.Component({}).type, {}, { hooks: [], children: new Map() })
  assert.equal(rendered.tree, null, 'the entry point appeared on a host that cannot render its dialog')
  // ...and the plugin still registered the slot: an empty occupant is harmless, a missing one would mean a
  // different code path for a host that merely lacks a module.
  assert.deepEqual(injected.map((entry) => entry.name), ['shell.overlay', 'settings.section', 'conversation.session.header.actions'])
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
