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
      /**
       * The array this effect belongs to — the *component's*, not the render's.
       *
       * A tree has many components, each with its own hook slots (`expand` keys them by component type), so the
       * cleanup has to be filed back where the next run of the same effect will look for it. Filing every cleanup
       * on the root's array instead is how a child's `removeEventListener` never ran — which is exactly the kind of
       * leak these tests exist to catch.
       */
      const hooks = current.hooks
      const previous = hooks[index]
      const changed = !previous || !Array.isArray(deps) || !Array.isArray(previous.deps)
        || deps.length !== previous.deps.length
        || deps.some((value, position) => value !== previous.deps[position])
      /**
       * The slot keeps whatever it already held — including the cleanup of a run whose dependencies did not
       * change. React keeps it too, and dropping it here is how a listener that was attached once could never be
       * removed: the next unrelated render would have wiped the only reference to its disposer.
       */
      hooks[index] = { ...(previous || {}), fn, deps: Array.isArray(deps) ? deps.slice() : null }
      // A cleaned-up effect is a cleared interval: the countdown's ticker has to be able to stop, or every
      // render of a panel would leave a timer behind it.
      if (changed) {
        if (previous && typeof previous.cleanup === 'function') previous.cleanup()
        pendingEffects.push({ hooks, index, fn })
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
      entry.hooks[entry.index] = { ...(entry.hooks[entry.index] || {}), cleanup: typeof cleanup === 'function' ? cleanup : null }
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
    if (url === '/mega-core/view') return answer(200, view)
    if (url === '/mega-core/action') return answer(200, action)
    throw new Error(`no route for ${url}`)
  }
  impl.calls = calls
  return impl
}

/**
 * One route answer, in the shape a real `Response` has.
 *
 * `text()` as well as `json()` on purpose: the client reads the body as text so that a route which answers
 * *nothing* (a 404 from a host half that stopped registering it) becomes a sentence about the status instead of
 * `SyntaxError: Unexpected end of JSON input`. A double with only `json()` would make that path untestable.
 */
function answer(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => (payload === undefined ? '' : JSON.stringify(payload))
  }
}

/**
 * The bundle, loaded the way the shell loads it.
 */
function load({ fetchImpl = fakeFetch(), visibility = 'visible', react = true, primitives = true } = {}) {
  const definitions = []
  const required = []
  const intervals = []
  const cleared = []
  const listeners = new Map()
  const styles = []
  const document = {
    visibilityState: visibility,
    addEventListener(type, handler) { listeners.set(type, handler) },
    removeEventListener(type) { listeners.delete(type) },
    /**
     * The dialog's width override is delivered as a `<style>` in the document's head, so a test needs a head to
     * put it in — and the two methods the plugin uses to avoid injecting it twice.
     */
    head: { appendChild(node) { styles.push(node) } },
    createElement(tag) { return { tagName: String(tag).toUpperCase(), textContent: '', dataset: {} } },
    querySelector(selector) { return styles.some((node) => node.dataset.hnsMega && selector.includes(node.dataset.hnsMega)) ? styles[0] : null }
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
  return { definition, plugin, required, shim, sandbox, document, intervals, cleared, listeners, styles, fetchImpl }
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
      headless: props.headless,
      // The width override travels as a class on the dialog box, which is what the official component renders and
      // therefore what the stylesheet has to beat (its own rule is a single class; ours is a doubled one).
      'data-dialog-class': props.className
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
    // The registered components are `(props) => React.createElement(MegaOrb, { store })` and the same for the
    // page, so the store comes out of the element they return.
    orbComponent: orbRegistration.Component({}).type,
    pageComponent: pageRegistration.Component({}).type,
    newTaskRegistration: injected.find((entry) => entry.name === 'conversation.session.header.actions').callback(),
    newTaskComponent: injected.find((entry) => entry.name === 'conversation.session.header.actions').callback().Component({}).type,
    orbState: { hooks: [], children: new Map() },
    // The header seat and the ball's panel both render the same action, and each has its own hooks — a dialog
    // opened from the header must not open the ball's copy of it.
    newTaskState: { hooks: [], children: new Map() },
    store: pageRegistration.Component({}).props.store
  }
}

test('the bundle is the shape the module loader materialises, and it requires only React and the primitives', () => {
  const loaded = load()
  assert.equal(loaded.definition.id, 'dsh-plugin-mega-core')
  assert.equal(typeof loaded.definition.factory, 'function')
  /**
   * React, plus the official component primitives for the centred sub-page.
   *
   * The primitives name is in the platform table the frontend builds (`{react, "react/jsx-runtime", "react-dom",
   * …dsh-client-ui-slots, "@deepseek-ai/dsh-client-ui-primitives", …dockkit}`), which is why requiring it is legal
   * rather than a second dependency to install. Both entry points — the conversation header's and the ball's own —
   * render the one dialog built from it.
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
  // The header seat is back, beside the official schedule clock and jobs list (`order: 30` is after both): a
  // conversation the user has open is one of the two places they look for "start something".
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
  // `queue` is a fold of its own and it is always drawn: its heading carries the two numbers that move when a task
  // is scheduled, and its body is the tasks themselves (see the queue test below).
  assert.deepEqual(categories.map((fold) => fold.id), ['price', 'balance', 'execution', 'queue', 'parallelism'], 'the ball lost a category')
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

test('the ball\'s own panel offers the new-task entry, first, and it opens the ball\'s own form', async () => {
  /**
   * The user's two reports about this entry, in order: "the Electron ball has no new-task entry" (it had none at
   * all, and the entry in the *other* ball sat below the dashboard where it had to be scrolled to), and then "悬浮球
   * 的创建任务入口指向窗口为官方顶部按钮的同一个 … 打开窗口后无法编辑，任意点击直接关闭弹窗".
   *
   * The second one is the shape of this test. The ball used to render the official centred sub-page — the same
   * component the header renders, portalled to `document.body` — and a sub-page portalled to the body is *outside*
   * this panel, while this panel dismisses itself when anything outside it is clicked. So the first click into the
   * form (the one that would have focused the prompt) closed the panel that owned the dialog. The fix is that the
   * ball's entry opens a form **inside the panel**, and that is what is asserted: no modal, the fields are in the
   * panel, and a click outside does not take them away.
   */
  const mounted = await mount({ fetchImpl: fakeNewTaskFetch() });
  const orb = mounted.shim.render(mounted.orbComponent, { store: mounted.store }, mounted.orbState);
  const ball = find(orb.tree, (element) => element.type === 'button' && element.props['data-hns-mega-orb'] === 'on')[0];
  ball.props.onPointerDown({ button: 0, preventDefault() {}, currentTarget: { getBoundingClientRect: () => ({ left: 0, top: 0 }) } });
  ball.props.onPointerUp();
  const opened = mounted.shim.render(mounted.orbComponent, { store: mounted.store }, mounted.orbState);

  const entry = find(opened.tree, (element) => element.props['data-hns-mega-new-task'] === 'ball')[0];
  assert.ok(entry, 'the ball\'s panel has no new-task entry');
  assert.match(strings(entry).join(''), /新建定时任务/);
  // First in the panel: before the dashboard's first category heading and before the balance action.
  const order = [];
  const walk = (element) => {
    if (!element || typeof element !== 'object') return
    if (Array.isArray(element)) { element.forEach(walk); return }
    if (element.$$element) {
      if (element.props['data-hns-mega-new-task'] === 'ball') order.push('new-task');
      if (element.props['data-hns-mega-dashboard']) order.push('dashboard');
      if (element.props['data-hns-mega-category']) order.push('category');
    }
    if (element.$$element) walk(element.props.children);
  };
  walk(opened.tree);
  assert.deepEqual(order.slice(0, 2), ['new-task', 'dashboard'], `the entry is not first: ${order.join(', ')}`);

  // It opens a form **in the panel**: the same draft the header's dialog offers, drawn by this panel.
  const draw = () => mounted.shim.render(mounted.orbComponent, { store: mounted.store }, mounted.orbState);
  find(draw().tree, (element) => element.props['data-hns-mega-new-task'] === 'ball')[0].props.onClick();
  await settle(draw);
  const rendered = draw();
  const said = strings(rendered.tree).join(' | ');
  assert.ok(find(rendered.tree, (element) => element.props['data-hns-mega-task-form'] === 'ball')[0], 'the entry opened no form in the panel');
  assert.equal(find(rendered.tree, (element) => element.props['data-primitive'] === 'modal').length, 0, 'the ball opened the header\'s centred sub-page');
  assert.match(said, /要执行的内容/, 'the ball\'s form has no prompt');
  assert.match(said, /发送时间/, 'the ball\'s form opened without its schedule');
  // The dashboard is not drawn under the form: one column, one surface.
  assert.equal(find(rendered.tree, (element) => element.props['data-hns-mega-category']).length, 0, 'the dashboard is still drawn under the form');

  // ...and the click that focuses the prompt cannot take the form away: while it is open, the panel's own
  // "a click outside me dismisses me" rule is not attached at all (see `MegaOrb`'s effect).
  assert.equal(mounted.listeners.has('pointerdown'), false, 'the dismiss-on-outside-click rule outlived the form opening');
});

test('the queue fold counts what is waiting, and lets a task be moved and edited', async () => {
  /**
   * The report this test is about: "定时任务测试成功，但是页面切换后，悬浮球信息页挂起任务数量没有改变，也不能编辑，也不能
   * 调顺序". Three things had to become true, and each is asserted here as what the user does:
   *
   *   * the **number** is on the shut fold's heading and follows the snapshot (a fold whose headline was "running
   *     workers" hid the count the user was watching);
   *   * opening the panel **asks again** — the poll is fifteen seconds, and a panel opened right after a task was
   *     suspended used to show the queue as it was before it;
   *   * the tasks are **tasks**, with the two operations the scheduler offers on a queued one: move it, or change it.
   */
  const task = queuedTask();
  const fetchImpl = fakeNewTaskFetch({ view: withQueue([task, queuedTask({ id: 'task-b', prompt: '把报告发到工作区', status: 'PENDING', reason: null, rank: 2, startAtIso: null, startAtText: null })]) });
  const mounted = await mount({ fetchImpl });

  // Opening the panel is a question about now: the store is asked again rather than answering from the last poll —
  // which is the "页面切换后 … 挂起任务数量没有改变" half of the report.
  const reads = () => fetchImpl.calls.filter((call) => call.url === '/mega-core/view').length;
  const before = reads();
  const draw = openPanel(mounted);
  draw();
  await settle(draw);
  assert.ok(reads() > before, 'opening the panel did not re-read the view');

  // The count is on the heading, while the fold is shut — that is the number the user watches.
  const shut = draw();
  const queueHeading = find(shut.tree, (element) => element.props['data-hns-mega-category'] === 'queue')[0];
  assert.ok(queueHeading, 'the panel has no queue fold');
  assert.match(strings(queueHeading).join(' · '), /已挂起 1 · 等待 1/, `the queue heading lost its counts: ${strings(queueHeading).join(' · ')}`);

  // Opening it shows the tasks themselves.
  queueHeading.props.onClick();
  const opened = draw();

  // The tasks themselves: each is a row with its own words, its place, and its state.
  const said = strings(opened.tree).join(' | ');
  assert.match(said, /总结今天的构建日志/, 'the queued task was not listed');
  assert.match(said, /把报告发到工作区/)
  assert.match(said, /已挂起 · 等到点/)
  const rows = find(opened.tree, (element) => element.props['data-hns-mega-task-row']);
  assert.deepEqual(rows.map((row) => row.props['data-hns-mega-task-row']), ['task-a', 'task-b']);
  // The first row cannot move up and the last cannot move down: a button that cannot change anything is not offered.
  const rowButtons = (id) => find(rows.find((row) => row.props['data-hns-mega-task-row'] === id), (element) => element.type === 'button');
  assert.equal(rowButtons('task-a')[0].props.disabled, true, 'the first task offered to move up');
  assert.equal(rowButtons('task-a')[1].props.disabled, false);
  assert.equal(rowButtons('task-b')[1].props.disabled, true, 'the last task offered to move down');

  // Moving one posts the scheduler's own move and re-reads the view, so the panel shows the recorded order.
  rowButtons('task-a')[1].props.onClick();
  await tick();
  await tick();
  const moved = fetchImpl.calls.find((call) => call.url === '/mega-core/task-move');
  assert.ok(moved, 'the move never left the panel');
  assert.deepEqual(JSON.parse(moved.init.body), { taskId: 'task-a', move: 'down' });

  // Editing opens the panel's own form on that task: same form as creating, with the task's words already in it.
  rowButtons('task-a')[2].props.onClick();
  await settle(draw);
  const editing = find(draw().tree, (element) => element.props['data-hns-mega-task-form'] === 'ball')[0];
  assert.ok(editing, 'editing a queued task opened no form');
  assert.equal(editing.props['data-hns-mega-task-mode'], 'edit', 'the form did not know it was editing');
  const promptField = find(draw().tree, (element) => element.props['data-hns-mega-task-prompt'] === 'on')[0];
  assert.equal(promptField.props.value, '总结今天的构建日志', 'the form did not start from the task');
  // ...and saving posts the change to the task route, addressed by id.
  promptField.props.onChange({ target: { value: '总结今天和昨天的构建日志' } });
  const save = find(draw().tree, (element) => element.props['data-hns-mega-task-create'] === 'on')[0];
  assert.ok(save, `the edit form has no armed save button: ${strings(draw().tree).join(' | ')}`);
  assert.equal(save.props.disabled, false, 'the form would not save an unchanged-but-valid edit');
  assert.match(strings(save).join(''), /保存修改|Save/, `the edit form's button is not the edit one: ${strings(save).join('')}`);
  save.props.onClick();
  await settle(draw);
  const edited = fetchImpl.calls.find((call) => call.url === '/mega-core/task-edit');
  assert.ok(edited, 'the edit never left the panel');
  const payload = JSON.parse(edited.init.body);
  assert.equal(payload.taskId, 'task-a');
  assert.equal(payload.prompt, '总结今天和昨天的构建日志');
  assert.equal('deliveryMode' in payload, false, 'an edit rewrote the delivery the user chose when they created it');
})

test('deleting a queued task asks first, and only the second click deletes it', async () => {
  /**
   * "队列任务需要允许删除." Delete is the one button on a queue row that cannot be undone from the panel, and a row of
   * small buttons in a 340px panel is where a mis-click happens — so the first click turns the row into its own
   * confirmation and the second one deletes. What is asserted is the two-step shape, the route it posts to, and that
   * the row's own question survives the redraw a poll causes.
   */
  const fetchImpl = fakeNewTaskFetch({ view: withQueue([queuedTask(), queuedTask({ id: 'task-b', prompt: '把报告发到工作区', rank: 2, status: 'PENDING', reason: null })]) });
  const mounted = await mount({ fetchImpl });
  const draw = openPanel(mounted);
  draw();
  find(draw().tree, (element) => element.props['data-hns-mega-category'] === 'queue')[0].props.onClick();

  const rowFor = (id) => find(draw().tree, (element) => element.props['data-hns-mega-task-row'] === id)[0];
  const step = (id, which) => find(rowFor(id), (element) => element.props['data-hns-mega-task-delete'] === which)[0];
  const deletes = () => fetchImpl.calls.filter((call) => call.url === '/mega-core/task-delete');

  // The row offers the delete button, and nothing has been posted yet.
  const ask = step('task-b', 'ask');
  assert.ok(ask, `the queue row has no delete button: ${strings(rowFor('task-b')).join(' | ')}`);
  assert.equal(deletes().length, 0, 'a delete was posted before anyone asked for one');
  ask.props.onClick();

  // The first click asks: the row is now a question, and it still has not deleted anything.
  const asking = rowFor('task-b');
  assert.equal(asking.props['data-hns-mega-task-confirming'], 'on', 'the row did not turn into its own confirmation');
  assert.match(strings(asking).join(' | '), /删除这条？/);
  assert.equal(step('task-b', 'confirm').props.disabled === true, false, 'the confirmation cannot be answered');
  assert.match(strings(step('task-b', 'confirm')).join(''), /删除 · Delete/, 'the confirmation does not say what it does');
  assert.equal(deletes().length, 0, 'asking deleted the task');

  // A redraw (the shell's poll) must not throw the question away — it is the panel's state, not the row's.
  await settle(draw);
  assert.equal(rowFor('task-b').props['data-hns-mega-task-confirming'], 'on', 'a poll dismissed the confirmation');

  // 取消 keeps it, and the row goes back to its buttons.
  const cancel = find(rowFor('task-b'), (element) => element.type === 'button' && /Cancel/.test(strings(element).join('')))[0];
  assert.ok(cancel, 'the confirmation has no way out');
  cancel.props.onClick();
  assert.equal(rowFor('task-b').props['data-hns-mega-task-confirming'], 'off');
  assert.equal(deletes().length, 0);

  // ...and the second click on 删除 is what deletes: the scheduler's `cancelTask`, addressed by id.
  step('task-b', 'ask').props.onClick();
  step('task-b', 'confirm').props.onClick();
  await tick();
  await tick();
  const posted = deletes();
  assert.equal(posted.length, 1, `the delete never left the panel: ${fetchImpl.calls.map((call) => call.url).join(', ')}`);
  assert.deepEqual(JSON.parse(posted[0].init.body), { taskId: 'task-b' });
  // The question is closed and the queue was re-read, so the row is drawn from what the layer holds now.
  assert.equal(rowFor('task-b').props['data-hns-mega-task-confirming'], 'off', 'the confirmation outlived its own answer');
})

test('a snapshot with a different queue is drawn as that queue, not as the last one', async () => {
  // The other half of "挂起任务数量没有改变": the number has to follow the snapshot it is drawn from.
  const fetchImpl = fakeNewTaskFetch({ view: withQueue([queuedTask()]) });
  const mounted = await mount({ fetchImpl });
  const draw = openPanel(mounted);
  const heading = () => strings(find(draw().tree, (element) => element.props['data-hns-mega-category'] === 'queue')[0]).join(' · ');
  assert.match(heading(), /已挂起 1 · 等待 0/);

  // The queue grew while the panel was open: the next read is drawn as it is, with no memory of the old number.
  fetchImpl.setView(withQueue([
    queuedTask(),
    queuedTask({ id: 'task-c', prompt: '再跑一次夜里的构建', rank: 2 })
  ]));
  await mounted.store.refresh();
  await settle(draw);
  assert.match(heading(), /已挂起 2 · 等待 0/, `the count did not follow the snapshot: ${heading()}`);
  // ...and the task that joined the queue is in the list, not just in the count.
  find(draw().tree, (element) => element.props['data-hns-mega-category'] === 'queue')[0].props.onClick();
  assert.match(strings(draw().tree).join(' | '), /再跑一次夜里的构建/);
})

test('the dialog is as wide as a composer, not as wide as the official component\'s default', async () => {
  /**
   * The user's words were "the new-task dialog is not wide enough", and the cause was not our layout: the official
   * `Modal` renders its box at `width: min(380px, 100%)` — sized for a one-field form — and that box is the parent
   * of everything we draw. Our content asked for a minimum width and was crushed by a parent that could not be
   * wider, which is why the time field and the peak switch ended up in a column.
   *
   * So the fix is an override **on the official dialog box**, through `Modal`'s own `className`, and this asserts
   * both halves of it: the class reaches the box, and the stylesheet that carries the width is injected.
   */
  const task = await openNewTask();
  const modal = find(task.rendered.tree, (element) => element.props['data-primitive'] === 'modal')[0];
  assert.ok(modal, 'the entry point opened no modal');
  const dialogClass = modal.props['data-dialog-class'];
  assert.equal(dialogClass, 'hns-mega-dialog', 'the width override never reached the dialog box');

  const style = task.styles.find((node) => node.dataset && node.dataset.hnsMega === dialogClass);
  assert.ok(style, 'no stylesheet was injected for the dialog');
  // The rule has to beat the component's own single-class width rule, so it is doubled on purpose.
  assert.match(style.textContent, new RegExp(`\\.${dialogClass}\\.${dialogClass}`));
  assert.match(style.textContent, /width:\s*min\(720px,\s*92vw\)/, 'the width is not the composer width');
  assert.match(style.textContent, /min-width:/, 'nothing keeps a narrow layer from collapsing the dialog');
  // Injected once, however many times the dialog is opened: a second copy would be a leak with no reader.
  const before = task.styles.length;
  const trigger = find(task.rendered.tree, (element) => element.props['data-hns-mega-new-task-action'] === 'header')[0];
  find(trigger, (element) => element.type === 'button')[0].props.onClick();
  await settle(task.draw);
  assert.equal(task.styles.length, before, 'the dialog stylesheet was injected again');
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

/** A `fetch` that also answers the timing surface, the task route and the queue's two operations. */
function fakeNewTaskFetch({ view = fixtureView(), timing = fixtureTiming(), task = { ok: true, task: { id: 'task-1', status: 'PENDING' } } } = {}) {
  const calls = []
  let current = view
  const impl = async (url, init = {}) => {
    calls.push({ url, init });
    if (url === '/mega-core/view') return answer(200, current);
    if (url === '/mega-core/action') return answer(200, { ok: true });
    if (url === '/mega-core/timing') return answer(timing.ok === false ? 503 : 200, timing);
    if (url === '/mega-core/task') return answer(task.ok === false ? 400 : 200, task);
    if (url === '/mega-core/task-edit') return answer(200, { ok: true, task: { id: 'task-a', status: 'SUSPENDED', reason: 'waiting-schedule' } });
    if (url === '/mega-core/task-move') return answer(200, { ok: true, task: { id: 'task-a', queueRank: 2 } });
    if (url === '/mega-core/task-delete') return answer(200, { ok: true, task: { id: 'task-b', status: 'CANCELED', reason: 'user-cancel' }, deleted: true });
    throw new Error(`no route for ${url}`);
  };
  impl.calls = calls;
  /** Answer the next `/view` with a different snapshot — what the panel does when the queue has moved on. */
  impl.setView = (next) => { current = next };
  return impl;
}

/** The dashboard's queue block, as `control-center.cjs` publishes it: tasks, not just a count. */
function withQueue(tasks, counts = null) {
  const view = fixtureView();
  const suspended = tasks.filter((task) => task.status === 'SUSPENDED').length;
  const pending = tasks.length - suspended;
  view.dashboard.queue = {
    ok: true,
    reason: null,
    headline: `已挂起 ${suspended} · 等待 ${pending}`,
    counts: counts || { pending, suspended, running: 0, total: tasks.length },
    tasks
  };
  return view;
}

/** One queued task, as `control-center.cjs`'s `dashboard.queue` publishes it. */
function queuedTask(overrides = {}) {
  return {
    id: 'task-a',
    prompt: '总结今天的构建日志',
    status: 'SUSPENDED',
    reason: 'waiting-schedule',
    startAtIso: new Date(Date.now() + 3 * 60_000).toISOString(),
    startAtText: '09:41',
    allowPeak: false,
    deliveryMode: 'official-session',
    rank: 1,
    ...overrides
  };
}

/** Open the ball's panel and hand back the render function, so a test can keep drawing it. */
function openPanel(mounted) {
  const draw = () => mounted.shim.render(mounted.orbComponent, { store: mounted.store }, mounted.orbState);
  const ball = find(draw().tree, (element) => element.type === 'button' && element.props['data-hns-mega-orb'] === 'on')[0];
  ball.props.onPointerDown({ button: 0, preventDefault() {}, currentTarget: { getBoundingClientRect: () => ({ left: 0, top: 0 }) } });
  ball.props.onPointerUp();
  return draw;
}

/** Open the header action's dialog and hand back what it drew, with DS-Hns' answer already in it. */
async function openNewTask(options = {}) {
  const fetchImpl = options.fetchImpl || fakeNewTaskFetch(options.routes || {});
  const mounted = await mount({ fetchImpl });
  const draw = () => mounted.shim.render(mounted.newTaskComponent, {}, mounted.newTaskState);
  // The action renders one trigger (the header's own) and the dialog behind it; the trigger is the one with the
  // click that opens it, which is what `data-hns-mega-new-task-action` marks.
  const action = find(draw().tree, (element) => element.props['data-hns-mega-new-task-action'] === 'header')[0];
  assert.ok(action, 'the header action drew no entry point');
  const trigger = find(action, (element) => element.type === 'button' && typeof element.props.onClick === 'function' && element.props.title && /新建定时任务/.test(element.props.title))[0]
    || find(action, (element) => element.type === 'button')[0];
  assert.ok(trigger, 'the header action has no button to click');
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

test('a route that is not there is a sentence about the status, never a parser error', async () => {
  /**
   * This is the bug the host half's own test now guards from the other side, asserted here as the user saw it.
   *
   * `/mega-core/timing` and `/mega-core/task` were once removed from the host half while this half kept calling
   * them. Both answers were empty (404 and 405), so `response.json()` threw and the dialog showed
   * `SyntaxError: Unexpected end of JSON input` — a sentence about a parser, in place of a sentence about the
   * problem. The body is read as text now, and what is left when there is no JSON is the status.
   */
  const noJson = (status) => ({ ok: false, status, json: async () => { throw new SyntaxError('Unexpected end of JSON input') }, text: async () => '' });

  // The read: the form cannot prefill a time, and says which status it got instead of what the parser said.
  const orphan = await openNewTask({ fetchImpl: async (url) => (url === '/mega-core/view' ? answer(200, fixtureView()) : noJson(404)) });
  const said = strings(orphan.rendered.tree).join(' | ');
  assert.match(said, /读不到调度能力/);
  assert.match(said, /404/, `the status did not survive: ${said}`);
  assert.doesNotMatch(said, /SyntaxError|Unexpected end of JSON/, 'the user was shown a parser error instead of the problem');

  // The write: the timing surface answers, the task route does not — and the refusal names its own status.
  const attempt = await openNewTask({
    fetchImpl: async (url) => {
      if (url === '/mega-core/view') return answer(200, fixtureView());
      if (url === '/mega-core/timing') return answer(200, fixtureTiming());
      return noJson(405);
    }
  });
  find(attempt.rendered.tree, (element) => element.props['data-hns-mega-task-prompt'] === 'on')[0].props.onChange({ target: { value: '发不出去' } });
  createButton(attempt.draw()).props.onClick();
  await settle(attempt.draw);
  const refused = strings(attempt.draw().tree).join(' | ');
  assert.match(refused, /405/, `the task route's status did not survive: ${refused}`);
  assert.doesNotMatch(refused, /SyntaxError|Unexpected end of JSON/);
})

test('the form cannot arm submit for a time that has already gone', async () => {
  /**
   * A `datetime-local` field truncates to the minute, so "this minute" is behind us the moment it is picked — and
   * a past instant is `ready` in the gate, which means the task would run at once instead of waiting. The
   * scheduler refuses such a task (`SchedulerService.addTask`); the form has to refuse to arm the button for it,
   * and say which half is missing, rather than posting a request that comes back refused.
   */
  const task = await openNewTask();
  const timeField = (rendered) => find(rendered.tree, (element) => element.props['data-hns-mega-task-time'] === 'on')[0];
  const past = new Date(Date.now() - 5 * 60_000);
  const pad = (value) => String(value).padStart(2, '0');
  const asLocal = `${past.getFullYear()}-${pad(past.getMonth() + 1)}-${pad(past.getDate())}T${pad(past.getHours())}:${pad(past.getMinutes())}`;

  find(task.rendered.tree, (element) => element.props['data-hns-mega-task-prompt'] === 'on')[0].props.onChange({ target: { value: '晚了一步' } });
  timeField(task.draw()).props.onChange({ target: { value: asLocal } });
  const rendered = task.draw();
  assert.match(strings(rendered.tree).join(' | '), /这个时间已经过去/, 'a past time was not called out in the summary');
  const create = createButton(rendered);
  assert.equal(create.props.disabled, true, 'the form would schedule a task for a time that has gone');
  assert.match(create.props.title, /已经过去/, 'the disabled button did not say why');
  // And nothing was posted behind the disabled button.
  create.props.onClick();
  await tick();
  assert.equal(task.fetchImpl.calls.filter((call) => call.url === '/mega-core/task').length, 0, 'a past time was posted anyway')
})

/** The dialog's own submit button, by the words on it. */
function createButton(rendered) {
  const byLabel = find(rendered.tree, (element) => strings(element).join('') === '创建定时任务 · Schedule')[0];
  assert.ok(byLabel, 'the form has no submit button');
  return byLabel;
}

test('a host without the official primitives draws no header entry point rather than a broken box', async () => {
  const loaded = load({ primitives: false })
  const { ctx, injected } = fakeSlots()
  loaded.plugin.apply(ctx)
  const registration = injected.find((entry) => entry.name === 'conversation.session.header.actions').callback()
  const rendered = loaded.shim.render(registration.Component({}).type, {}, { hooks: [], children: new Map() })
  assert.equal(rendered.tree, null, 'the entry point appeared on a host that cannot render its dialog')
  // ...and the plugin still registered the slot: an empty occupant is harmless, a missing one would mean a
  // different code path for a host that merely lacks a module.
  assert.deepEqual(injected.map((entry) => entry.name), ['shell.overlay', 'settings.section', 'conversation.session.header.actions'])

  /**
   * The ball's own form needs none of the platform table: it draws our boxes, so it is still there on that host.
   *
   * That is the second reason the two seats stopped sharing one shape. The header's centred sub-page *is* the
   * official `Modal` and cannot exist without it; the ball's form is ours and can.
   */
  const orbRegistration = injected.find((entry) => entry.name === 'shell.overlay').callback()
  const orbComponent = orbRegistration.Component({}).type
  const orbState = { hooks: [], children: new Map() }
  const draw = () => loaded.shim.render(orbComponent, { store: orbRegistration.Component({}).props.store }, orbState)
  const ball = find(draw().tree, (element) => element.type === 'button' && element.props['data-hns-mega-orb'] === 'on')[0]
  ball.props.onPointerDown({ button: 0, preventDefault() {}, currentTarget: { getBoundingClientRect: () => ({ left: 0, top: 0 }) } })
  ball.props.onPointerUp()
  const entry = find(draw().tree, (element) => element.props['data-hns-mega-new-task'] === 'ball')[0]
  assert.ok(entry, 'the ball lost its entry point on a host with no official primitives')
  entry.props.onClick()
  await settle(draw)
  const said = strings(draw().tree).join(' | ')
  assert.match(said, /要执行的内容/, 'the ball\'s own form needs the official primitives after all')
  assert.match(said, /发送时间/)
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
