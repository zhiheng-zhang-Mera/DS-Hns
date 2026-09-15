'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

/**
 * The system orb's renderer (`app/extensions/mega/ui/orb.js`), against a minimal DOM stub.
 *
 * The geometry has its own tests (`system-orb.test.js`) and the numbers have theirs (`mega-core-view.test.js`);
 * what is left, and what this file is for, is the drawing: **the ball opens on the dashboard** — the price
 * window and its countdown, the account, the queue, the parallelism — and what governance says about itself
 * follows it. That is a contract about a surface, and a surface is exactly the thing a "does it still say the
 * right thing" test has to pin down.
 *
 * No jsdom: the renderer only ever calls `createElement`, sets `textContent`/`className`/`style`/`dataset`, and
 * appends children, so a stub of those is enough to read back what a user would see.
 */

const ROOT = path.resolve(__dirname, '..', '..')
const ORB = path.join(ROOT, 'app', 'extensions', 'mega', 'ui', 'orb.js')
const source = fs.readFileSync(ORB, 'utf8')

/** One element: the handful of properties the renderer writes, plus what a test needs to read back. */
function makeElement(tag, id) {
  const classes = new Set()
  const listeners = new Map()
  const node = {
    tagName: String(tag || 'div').toUpperCase(),
    id: id || '',
    hidden: false,
    title: '',
    type: '',
    style: {},
    dataset: {},
    attributes: {},
    children: [],
    textContent: '',
    get className() { return [...classes].join(' ') },
    set className(value) {
      classes.clear()
      for (const name of String(value || '').split(/\s+/).filter(Boolean)) classes.add(name)
    },
    classList: {
      contains: (name) => classes.has(name),
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name)
    },
    appendChild(child) { this.children.push(child); return child },
    replaceChildren(...nodes) {
      this.children = nodes
      if (nodes.length) this.textContent = nodes.map((entry) => entry.textContent || '').join('')
    },
    removeChild(child) {
      this.children = this.children.filter((entry) => entry !== child)
      return child
    },
    contains: () => false,
    setAttribute(name, value) { this.attributes[name] = String(value) },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null },
    addEventListener(name, handler) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(handler)
    },
    fire(name, payload) {
      for (const handler of listeners.get(name) || []) handler(payload)
    },
    querySelector: () => null
  }
  return node
}

/** Load the renderer in a sandbox whose document has exactly the elements `orb.html` declares. */
function loadOrb({ snapshot = null } = {}) {
  const elements = new Map()
  for (const id of ['ball', 'ballGlyph', 'panel', 'panelState', 'panelBody', 'panelClose']) {
    elements.set(id, makeElement(id === 'ball' ? 'button' : 'div', id))
  }
  const calls = []
  const document = {
    getElementById: (id) => elements.get(id) || null,
    createElement: (tag) => makeElement(tag),
    addEventListener() {},
    removeEventListener() {}
  }
  const api = {
    /**
     * The renderer's first paint asks for a snapshot. In this harness the answer is deliberately **never
     * delivered**: the promise it returns is pending forever, so a late resolution cannot overwrite the state a
     * test applied, and every test drives `hnsOrbView.apply` itself.
     */
    snapshot: () => {
      calls.push('snapshot')
      return { then() {}, catch() {} }
    },
    open: async (value) => {
      calls.push(`open:${value}`)
      return { ok: true, open: value === true, view: snapshot }
    },
    measure: async () => ({ ok: true }),
    action: async (action, id) => {
      calls.push(`action:${action}:${id}`)
      return { ok: true }
    },
    hover: async () => ({ ok: true }),
    drag: async () => ({ ok: true }),
    onState() {}
  }
  const sandbox = { console, Promise, setTimeout, clearTimeout, document }
  sandbox.window = sandbox
  sandbox.hnsOrb = api
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'orb.js' })
  const apply = (state) => sandbox.hnsOrbView.apply(state)
  return { sandbox, elements, calls, apply, api }
}

/** Every string in a rendered tree, depth first. */
function strings(node, out = []) {
  if (!node || typeof node !== 'object') return out
  if (node.textContent) out.push(String(node.textContent))
  for (const child of node.children || []) strings(child, out)
  return out
}

const PANEL_STATE = {
  ok: true,
  open: true,
  ball: { x: 8, y: 8 },
  ballSize: 44,
  panel: { offset: { x: 8, y: 8 }, width: 340, height: 420, side: 'above', across: 'left' }
}/** The view model's answer, both halves: the dashboard the ball draws and the governance it also reports. */
function fixtureView() {
  return {
    ok: true,
    available: true,
    status: { tone: 'warn', label: 'Degraded', attention: 1, active: 5, total: 7, pending: 0, failing: 0 },
    hover: ['DS-Hns', 'Degraded', '5 of 7 plugin(s) active', '0 pending'],
    lines: [{ tone: 'warn', text: '⚠ mega:dock degraded — the dock did not paint' }],
    actions: ['check', 'retry'],
    dashboard: {
      ok: true,
      reason: null,
      lines: [
        {
          id: 'price',
          cn: '价格',
          en: 'Price',
          rows: [
            { id: 'price:window', cn: '电费时段', en: 'Price window', value: 'PEAK', tone: 'warn' },
            { id: 'price:until-off-peak', cn: '距下一次谷价', en: 'Until off-peak', value: '12m 30s', tone: 'ok' }
          ]
        },
        {
          id: 'balance',
          cn: '账户',
          en: 'Account',
          rows: [{ id: 'balance:total', cn: '总余额', en: 'Total balance', value: '¥ 12.50', tone: 'ok' }]
        }
      ],
      execution: [
        { id: 'execution:running', cn: '运行中的 worker', en: 'Running workers', value: '2', tone: 'busy' },
        { id: 'execution:queued', cn: '排队任务', en: 'Queued tasks', value: '3', tone: null }
      ],
      parallelism: [{ id: 'parallelism:current', cn: '当前并行', en: 'Concurrency now', value: '4', tone: null }],
      // The dashboard's own action, offered while a read could change the account (`control-center.cjs` decides).
      actions: [{ id: 'refresh-balance', cn: '刷新余额', en: 'Refresh balance', reason: 'unread' }]
    },
    fields: [{ id: 'health', cn: '插件健康', en: 'Plugin health', value: '5/7', tone: 'warn' }],
    modules: [],
    plugins: [],
    at: '2026-09-15T05:45:00.000Z'
  }
}

/**
 * What the shell pushes to the document: the geometry, the open state, and the view model inside it — the same
 * payload `systemOrb.cjs`'s `payload()` builds and `orb-preload.cjs` forwards.
 */
function payload(view, overrides = {}) {
  return { ...PANEL_STATE, view, ...overrides }
}

test('the ball draws the live dashboard: price, countdown, balance, queue and parallelism', () => {
  const orb = loadOrb({ snapshot: fixtureView() })
  const view = fixtureView()
  orb.apply(payload(view))
  const said = strings(orb.elements.get('panelBody')).join(' | ')

  // The four cards the old expanded dock drew, each from the view's own dashboard block.
  assert.match(said, /价格 · Price/)
  assert.match(said, /Price window/)
  assert.match(said, /PEAK/)
  assert.match(said, /距下一次谷价/)
  assert.match(said, /12m 30s/)
  assert.match(said, /账户 · Account/)
  assert.match(said, /¥ 12\.50/)
  assert.match(said, /任务 · Tasks/)
  assert.match(said, /排队任务/)
  assert.match(said, /并行 · Parallelism/)
  assert.match(said, /Concurrency now/)

  // The tones reach the DOM: a peak window is the warn colour, a running worker is the busy one, and a
  // healthy balance is green. A dashboard whose numbers were all one colour would say nothing.
  const classes = []
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    for (const name of String(node.className || '').split(/\s+/).filter(Boolean)) classes.push(name)
    for (const child of node.children || []) walk(child)
  }
  walk(orb.elements.get('panelBody'))
  assert.ok(classes.includes('tone-warn'), `the peak window lost its tone: ${classes.join(', ')}`)
  assert.ok(classes.includes('tone-busy'), 'a running worker lost its tone')
  assert.ok(classes.includes('tone-ok'), 'a healthy balance lost its tone')

  // Governance still follows the numbers: what is degraded, what wants attention, and what can be done.
  assert.match(said, /mega:dock degraded/)
  assert.match(said, /待人工 · pending/)
  assert.match(said, /Settings › Mega/)
})

test('the panel opens on the dashboard, and the governance facts follow it', () => {
  const orb = loadOrb({ snapshot: fixtureView() })
  orb.apply(payload(fixtureView()))
  const body = orb.elements.get('panelBody')
  const first = strings(body).join(' | ')
  const dashboardAt = first.indexOf('价格 · Price')
  const governanceAt = first.indexOf('mega:dock degraded')
  assert.ok(dashboardAt >= 0 && governanceAt > dashboardAt, `the dashboard must come first: ${first}`)

  // The recovery actions are still the closed set governance accepts, and clicking one asks the shell.
  const buttons = []
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (node.tagName === 'BUTTON') buttons.push(node)
    for (const child of node.children || []) walk(child)
  }
  walk(body)
  const labels = buttons.map((button) => button.textContent)
  assert.ok(labels.includes('retry'), `the ball lost its actions: ${labels.join(', ')}`)
  assert.ok(labels.includes('刷新余额 · Refresh balance'), `the ball lost its balance refresh: ${labels.join(', ')}`)
  buttons.find((button) => button.textContent === 'retry').fire('click')
  assert.ok(orb.calls.includes('action:retry:null'), `the click never reached the shell: ${orb.calls.join(', ')}`)
  buttons.find((button) => button.textContent === '刷新余额 · Refresh balance').fire('click')
  assert.ok(orb.calls.includes('action:refresh-balance:null'), `the balance refresh never reached the shell: ${orb.calls.join(', ')}`)
})

test('an account that is already current is offered no refresh, because no read could change it', () => {
  const orb = loadOrb({ snapshot: fixtureView() })
  const view = fixtureView()
  // The same dashboard with the button withheld — that is the snapshot's decision, not the renderer's, and the
  // renderer must not invent one (`control-center.cjs` explains when it withholds it).
  view.dashboard.actions = []
  orb.apply(payload(view))
  const said = strings(orb.elements.get('panelBody')).join(' | ')
  assert.doesNotMatch(said, /刷新余额/)
  // The account itself is still drawn.
  assert.match(said, /¥ 12\.50/)
})

test('a dashboard DS-Hns did not publish is a reason, not a wall of dashes', () => {
  const view = fixtureView()
  // A snapshot that answered, with governance in it and no live numbers: the ball says which half is missing
  // rather than drawing a queue of zero, and the governance it *did* publish is still there underneath.
  view.dashboard = { ok: false, reason: 'DS-Hns did not publish a dashboard block in its snapshot', lines: [], execution: [], parallelism: [] }
  const orb = loadOrb({ snapshot: view })
  orb.apply(payload(view))
  const said = strings(orb.elements.get('panelBody')).join(' | ')
  assert.match(said, /did not publish a dashboard block/)
  assert.match(said, /mega:dock degraded/)
})

test('a closed panel draws nothing, and no snapshot is a sentence rather than an empty ball', () => {
  const orb = loadOrb({ snapshot: fixtureView() })
  orb.apply(payload(fixtureView(), { open: false }))
  assert.equal(orb.elements.get('panel').hidden, true)
  assert.deepEqual(orb.elements.get('panelBody').children, [])

  const empty = loadOrb({ snapshot: null })
  empty.apply(payload(null))
  assert.match(strings(empty.elements.get('panelBody')).join(' | '), /no answer from DS-Hns/)
})

test('the ball keeps its tone and its glyph from the view, not from the dashboard', () => {
  const orb = loadOrb({ snapshot: fixtureView() })
  orb.apply(payload(fixtureView()))
  const ball = orb.elements.get('ball')
  // Attention is the badge: how many things want looking at, which is the governance count and never a price.
  assert.equal(ball.dataset.tone, 'warn')
  assert.equal(orb.elements.get('ballGlyph').textContent, '● 1')
  assert.match(ball.attributes['aria-label'], /DS-Hns · Degraded/)
})
