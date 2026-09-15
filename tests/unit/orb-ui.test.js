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
function makeElement(tag, id, dom) {
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
    /** What a field needs to be a field: the caret the renderer restores after a redraw (`orb.js`). */
    selectionStart: 0,
    selectionEnd: 0,
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
    /**
     * A real hit test over the stub's own tree.
     *
     * `orb.js` asks "is this click inside me" to decide whether to dismiss the panel, so a stub that always said
     * `false` could not tell a click *in* the panel from a click outside it — which is the distinction two of these
     * tests are about.
     */
    contains(candidate) {
      for (const child of this.children || []) {
        if (child === candidate || (child && typeof child.contains === 'function' && child.contains(candidate))) return true
      }
      return false
    },
    focus() { if (dom) dom.activeElement = node },
    blur() { if (dom && dom.activeElement === node) dom.activeElement = null },
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end },
    setAttribute(name, value) { this.attributes[name] = String(value) },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null },
    addEventListener(name, handler) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(handler)
    },
    fire(name, payload) {
      for (const handler of listeners.get(name) || []) handler(payload)
    },
    /** Only the one selector `orb.js` asks for: a field or a part of the form, by the name it was given. */
    querySelector(selector) {
      const match = /^\[data-(orb-field|orb-part)="([^"]+)"\]$/.exec(String(selector))
      if (!match) return null
      const key = match[1] === 'orb-field' ? 'orbField' : 'orbPart'
      let found = null
      const visit = (current) => {
        if (!current || typeof current !== 'object' || found) return
        if (current.dataset && current.dataset[key] === match[2]) { found = current; return }
        for (const child of current.children || []) visit(child)
      }
      for (const child of this.children || []) visit(child)
      return found
    }
  }
  return node
}

/** Load the renderer in a sandbox whose document has exactly the elements `orb.html` declares. */
function loadOrb({ snapshot = null } = {}) {
  /** The focus the stub's fields share, so `doc.activeElement` means what it means in a browser. */
  const dom = { activeElement: null }
  const elements = new Map()
  for (const id of ['ball', 'ballGlyph', 'panel', 'panelHead', 'panelTitle', 'panelState', 'panelBody', 'panelClose']) {
    elements.set(id, makeElement(id === 'ball' ? 'button' : 'div', id, dom))
  }
  dom.body = makeElement('body', '', dom)
  dom.activeElement = dom.body
  /**
   * The document's tree, as `orb.html` declares it.
   *
   * It matters for the two rules that ask "is this click inside me": `panel.contains(target)` decides whether the
   * panel is dismissed, and `panel.contains(activeElement)` decides whether a redraw has to put the cursor back. A
   * flat bag of elements could answer neither.
   */
  elements.get('ball').appendChild(elements.get('ballGlyph'))
  const panel = elements.get('panel')
  panel.appendChild(elements.get('panelHead'))
  elements.get('panelHead').appendChild(elements.get('panelTitle'))
  elements.get('panelHead').appendChild(elements.get('panelState'))
  elements.get('panelHead').appendChild(elements.get('panelClose'))
  panel.appendChild(elements.get('panelBody'))
  dom.body.appendChild(elements.get('ball'))
  dom.body.appendChild(panel)
  const calls = []
  let timingAnswer = null
  let taskAnswer = null
  const listeners = new Map()
  const document = {
    getElementById: (id) => elements.get(id) || null,
    createElement: (tag) => makeElement(tag, '', dom),
    /** The document's own listeners, which is where the ball's "click outside me" rule lives. */
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, [])
      listeners.get(type).push(handler)
    },
    removeEventListener(type, handler) {
      if (listeners.has(type)) listeners.set(type, listeners.get(type).filter((entry) => entry !== handler))
    },
    fire(type, payload) {
      for (const handler of listeners.get(type) || []) handler(payload)
    },
    get activeElement() { return dom.activeElement },
    body: dom.body
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
    measure: async (size) => {
      calls.push(`measure:${size ? `${size.width}x${size.height}` : 'none'}`)
      return { ok: true }
    },
    action: async (action, id) => {
      calls.push(`action:${action}:${id}`)
      return { ok: true }
    },
    /** The timing surface, as DS-Hns answers it (see `scheduledTaskSurface`). */
    timing: async () => {
      calls.push('timing')
      return timingAnswer || { ok: false, reason: 'timingAnswer is not set' }
    },
    createTask: async (input) => {
      calls.push(`createTask:${JSON.stringify(input)}`)
      return taskAnswer || { ok: true, task: { id: 'task-1', status: 'PENDING' } }
    },
    /** The three operations on a queued task (`scheduler.editTask` / `reorderTask` / `cancelTask`). */
    editTask: async (input) => {
      calls.push(`editTask:${JSON.stringify(input)}`)
      return { ok: true, task: { id: input.taskId, status: 'SUSPENDED', reason: 'waiting-schedule' } }
    },
    moveTask: async (input) => {
      calls.push(`moveTask:${JSON.stringify(input)}`)
      return { ok: true, task: { id: input.taskId } }
    },
    deleteTask: async (input) => {
      calls.push(`deleteTask:${JSON.stringify(input)}`)
      return { ok: true, task: { id: input.taskId, status: 'CANCELED' }, deleted: true }
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
  return {
    sandbox, elements, calls, apply, api,
    /** A node in no tree at all: what "the user clicked somewhere else on the screen" looks like. */
    outside: makeElement('div', 'outside', dom),
    setTiming: (answer) => { timingAnswer = answer },
    setTask: (answer) => { taskAnswer = answer }
  }
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

/** The timing surface, shaped like `scheduledTaskSurface()` in the extension. */
function fixtureTiming(overrides = {}) {
  return {
    ok: true,
    kind: 'scheduled-task',
    fields: { prompt: { required: true }, startAt: { required: false, format: 'iso-8601' } },
    defaults: {
      startAt: new Date(Date.now() + 5 * 60_000).toISOString(),
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
    deliveryModes: [{ id: 'official-session', cn: '官方对话', en: 'Official conversation', default: true }],
    ...overrides
  }
}

/** The queue, shaped like `control-center.cjs`'s `dashboard.queue`. */
function fixtureQueue(tasks = null) {
  const list = tasks || [
    {
      id: 'task-a',
      prompt: '总结今天的构建日志',
      status: 'SUSPENDED',
      reason: 'waiting-schedule',
      startAtIso: new Date(Date.now() + 3 * 60_000).toISOString(),
      allowPeak: false,
      deliveryMode: 'official-session',
      rank: 1
    },
    {
      id: 'task-b',
      prompt: '把报告发到工作区',
      status: 'PENDING',
      reason: null,
      startAtIso: null,
      allowPeak: true,
      deliveryMode: 'official-session',
      rank: 2
    }
  ]
  const suspended = list.filter((task) => task.status === 'SUSPENDED').length
  return {
    ok: true,
    counts: { pending: list.length - suspended, suspended, running: 0, total: list.length },
    headline: `已挂起 ${suspended} · 等待 ${list.length - suspended}`,
    tasks: list
  }
}

/** Click the ball's own new-task entry and let the timing read settle. */
async function openTaskForm(orb) {
  const said = strings(orb.elements.get('panelBody')).join(' | ')
  assert.match(said, /新建定时任务 · New task/, 'the ball has no new-task entry')
  const entry = findNode(orb.elements.get('panelBody'), (node) => node.dataset.orbAction === 'new-task')
  assert.ok(entry, 'the new-task entry is not a node with the action on it')
  entry.fire('click')
  await tick()
  await tick()
  await tick()
  return orb.elements.get('panelBody')
}

/** The first node under `root` the predicate accepts, depth first. */
function findNode(root, predicate) {
  let found = null
  const visit = (node) => {
    if (!node || typeof node !== 'object' || found) return
    if (predicate(node)) { found = node; return }
    for (const child of node.children || []) visit(child)
  }
  visit(root)
  return found
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

test('the ball draws every category shut, each with its own headline', () => {
  const orb = loadOrb({ snapshot: fixtureView() })
  const view = fixtureView()
  orb.apply(payload(view))
  const said = strings(orb.elements.get('panelBody')).join(' | ')

  // The four categories the old expanded dock drew, each from the view's own dashboard block — and each carrying
  // its own headline while it is shut, so the fold hides detail rather than the numbers a glance is for.
  assert.match(said, /价格 · Price/)
  assert.match(said, /PEAK/)
  assert.match(said, /账户 · Account/)
  assert.match(said, /¥ 12\.50/, 'the shut account fold lost its headline')
  assert.match(said, /任务 · Tasks/)
  assert.match(said, /并行 · Parallelism/)
  // Nothing is open, so no detail is drawn: the panel's first state is four headings and their headlines.
  assert.doesNotMatch(said, /Price window/, 'a shut fold drew its detail anyway')
  assert.doesNotMatch(said, /12m 30s/, 'a shut fold drew its countdown anyway')

  // Governance still follows the numbers: what is degraded, what wants attention, and what can be done.
  assert.match(said, /mega:dock degraded/)
  assert.match(said, /待人工 · pending/)
  assert.match(said, /Settings › Mega/)
})

test('the system ball folds the same categories, all shut at first, one open at a time — as a card', () => {
  const orb = loadOrb({ snapshot: fixtureView() })
  orb.apply(payload(fixtureView()))
  const body = orb.elements.get('panelBody')

  /** The folds as the document carries them: id, open state, and the headings' own words. */
  const folds = () => {
    const found = []
    const walk = (node) => {
      if (!node || typeof node !== 'object') return
      if (node.dataset && node.dataset.category) {
        found.push({ id: node.dataset.category, open: node.dataset.open === 'on', expanded: node.attributes['aria-expanded'], says: node.children.map((child) => child.textContent).join(' · ') })
      }
      for (const child of node.children || []) walk(child)
    }
    walk(body)
    return found
  }
  const openIds = () => folds().filter((fold) => fold.open).map((fold) => fold.id)

  /** The cards that are on screen — one per open fold, by id (`data-card` is the card element itself). */
  const cards = () => {
    const found = []
    const walk = (node) => {
      if (!node || typeof node !== 'object') return
      if (node.dataset && node.dataset.card) found.push(node.dataset.card)
      for (const child of node.children || []) walk(child)
    }
    walk(body)
    return found
  }

  // `queue` is a fold of its own and always drawn: its heading carries the counts that move when a task is
  // scheduled, and its body is the tasks themselves (see the queue test below).
  assert.deepEqual(folds().map((fold) => fold.id), ['price', 'balance', 'execution', 'queue', 'parallelism'])
  // The rule on the first frame: **all shut**, and no card anywhere.
  assert.deepEqual(openIds(), [], 'a category opened itself')
  assert.deepEqual(cards(), [], 'a shut panel drew a card')
  assert.equal(folds()[0].expanded, 'false')
  assert.equal(folds()[0].says, '▸ · 价格 · Price · PEAK')
  assert.equal(folds()[1].says, '▸ · 账户 · Account · ¥ 12.50')

  /**
   * Click a heading, the way a pointer does: find it fresh in the document (a redraw replaces the nodes, so a
   * reference taken before one is stale) and fire.
   *
   * What it opened is read from the *document*, not from the renderer's own state, because "only one at a time" and
   * "it became a card" are claims about what is on screen.
   */
  const click = (id) => {
    let node = null
    const seek = (current) => {
      if (!current || typeof current !== 'object' || node) return
      if (current.dataset && current.dataset.category === id && current.tagName === 'BUTTON') node = current
      for (const child of current.children || []) seek(child)
    }
    seek(body)
    assert.ok(node, `no heading for ${id}`)
    node.fire('click')
  }

  // Opening the account shuts everything else and makes it a card of its own.
  click('balance')
  assert.deepEqual(openIds(), ['balance'], 'opening the account left another fold open too')
  assert.deepEqual(cards(), ['balance'], 'the open category is not the one card on screen')
  const balanceSaid = strings(body).join(' | ')
  assert.match(balanceSaid, /¥ 12\.50/)
  assert.doesNotMatch(balanceSaid, /12m 30s/, 'a shut fold is still drawing its detail')

  click('execution')
  assert.deepEqual(openIds(), ['execution'])
  assert.deepEqual(cards(), ['execution'], 'two cards are on screen at once')
  assert.match(strings(body).join(' | '), /排队任务/)

  // Clicking the open heading shuts it: all folds shut is a state the panel is allowed to be in, and the headlines
  // are still there when it is.
  click('execution')
  assert.deepEqual(openIds(), [])
  assert.deepEqual(cards(), [])
  assert.match(strings(body).join(' | '), /PEAK/)
  assert.match(strings(body).join(' | '), /¥ 12\.50/)
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

test('the ball itself starts a task: the form opens in this window, above the schedule', async () => {
  /**
   * The new-task entry lives here, not in the official UI's header: this ball is the surface that is on screen over
   * every application, so starting a task from wherever the user is happens here. The form is the same
   * conversation-first shape — the prompt, then the schedule under it — and what it may offer comes from DS-Hns.
   */
  const orb = loadOrb({ snapshot: fixtureView() })
  orb.setTiming(fixtureTiming())
  orb.apply(payload(fixtureView()))

  const body = await openTaskForm(orb)
  const said = strings(body).join(' | ')
  assert.ok(orb.calls.includes('timing'), 'the form did not ask DS-Hns what a task may be')
  assert.match(said, /要执行的内容/)
  assert.match(said, /Enter 发送/)
  // The prompt box is a chat-shaped box: the placeholder says so (it is an attribute, not text).
  assert.match(findNode(body, (node) => node.dataset.orbField === 'prompt').placeholder, /和平时对话一样输入/)
  // The schedule is under the input, and it says which zone the windows belong to.
  assert.match(said, /定时设置/)
  assert.match(said, /发送时间/)
  assert.match(said, /时区 Asia\/Shanghai/)
  assert.match(said, /峰价 09:00-12:00, 14:00-18:00/)
  // The one sentence the user commits to, and the default time the surface published (five minutes out).
  assert.match(said, /将在 .* 作为官方新会话发出 · sends as a new official conversation in /)

  // The prompt box is the first control and the schedule comes after it: "the settings are under the input".
  const order = []
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (node.dataset && node.dataset.orbField) order.push(node.dataset.orbField)
    for (const child of node.children || []) walk(child)
  }
  walk(body)
  assert.deepEqual(order, ['prompt', 'startAt', 'allowPeak'])
})

test('Enter schedules it, Shift+Enter is a newline, and an IME composition is neither', async () => {
  const orb = loadOrb({ snapshot: fixtureView() })
  orb.setTiming(fixtureTiming())
  orb.setTask({ ok: true, task: { id: 'task-abc123', status: 'PENDING' } })
  orb.apply(payload(fixtureView()))
  const body = await openTaskForm(orb)

  const prompt = findNode(body, (node) => node.dataset.orbField === 'prompt')
  prompt.value = '总结今天的构建日志'
  prompt.fire('input')
  const prevented = []
  // An IME composition: Enter is how a Chinese user commits a candidate, so it must not send.
  prompt.fire('keydown', { key: 'Enter', shiftKey: false, isComposing: true, preventDefault: () => prevented.push('composing') })
  assert.equal(orb.calls.filter((call) => call.startsWith('createTask:')).length, 0, 'a composition scheduled a task')
  prompt.fire('keydown', { key: 'Enter', shiftKey: true, isComposing: false, preventDefault: () => prevented.push('shift') })
  assert.equal(orb.calls.filter((call) => call.startsWith('createTask:')).length, 0, 'Shift+Enter scheduled a task')
  assert.deepEqual(prevented, [], 'a newline or a composition was prevented')

  prompt.fire('keydown', { key: 'Enter', shiftKey: false, isComposing: false, preventDefault: () => prevented.push('send') })
  assert.deepEqual(prevented, ['send'], 'Enter did not take the keystroke')
  await tick()
  await tick()
  await tick()

  const posted = orb.calls.filter((call) => call.startsWith('createTask:'))
  assert.equal(posted.length, 1, 'Enter did not schedule anything')
  const input = JSON.parse(posted[0].slice('createTask:'.length))
  assert.equal(input.prompt, '总结今天的构建日志')
  assert.equal(input.deliveryMode, 'official-session', 'a scheduled task must be delivered as a conversation')
  assert.equal(input.allowPeak, false)
  assert.ok(Date.parse(input.startAt) > Date.now(), 'the task was scheduled in the past')
  // The receipt names the task DS-Hns actually made, and the box is cleared so a second Enter cannot repeat it.
  const after = strings(orb.elements.get('panelBody')).join(' | ')
  assert.match(after, /已加入队列 #task-abc123/)
  assert.equal(findNode(orb.elements.get('panelBody'), (node) => node.dataset.orbField === 'prompt').value, '')
})

test('a refusal is repeated in DS-Hns words, and the window can go back to the dashboard', async () => {
  const orb = loadOrb({ snapshot: fixtureView() })
  orb.setTiming(fixtureTiming())
  orb.setTask({ ok: false, reason: 'a task needs a prompt', field: 'prompt' })
  orb.apply(payload(fixtureView()))
  const body = await openTaskForm(orb)

  const prompt = findNode(body, (node) => node.dataset.orbField === 'prompt')
  prompt.value = 'x'
  prompt.fire('input')
  findNode(body, (node) => node.dataset.orbAction === 'create-task').fire('click')
  await tick()
  await tick()
  await tick()
  assert.match(strings(orb.elements.get('panelBody')).join(' | '), /a task needs a prompt/, 'the refusal was swallowed')

  // Back to the dashboard: the ball is a glance first, and the form is a place you visit.
  findNode(orb.elements.get('panelBody'), (node) => node.textContent === '返回 · Back').fire('click')
  const dashboard = strings(orb.elements.get('panelBody')).join(' | ')
  assert.match(dashboard, /价格 · Price/)
  assert.doesNotMatch(dashboard, /要执行的内容/)
})

test('the form survives a poll, and a snapshot with no timing surface says so instead of guessing', async () => {
  const orb = loadOrb({ snapshot: fixtureView() })
  orb.setTiming(fixtureTiming())
  orb.apply(payload(fixtureView()))
  await openTaskForm(orb)
  const prompt = findNode(orb.elements.get('panelBody'), (node) => node.dataset.orbField === 'prompt')
  prompt.value = '半句话'
  prompt.fire('input')

  // The shell pushes a new view every 15 seconds. Being thrown back to the dashboard mid-sentence would lose the
  // text, so the form stays and keeps what was typed.
  orb.apply(payload(fixtureView()))
  const afterPoll = strings(orb.elements.get('panelBody')).join(' | ')
  assert.match(afterPoll, /要执行的内容/, 'a poll closed the form')
  assert.equal(findNode(orb.elements.get('panelBody'), (node) => node.dataset.orbField === 'prompt').value, '半句话')

  // A DS-Hns that cannot answer the timing question is reported, not papered over with invented defaults.
  const withoutTiming = loadOrb({ snapshot: fixtureView() })
  withoutTiming.setTiming({ ok: false, reason: 'this build does not answer timing questions' })
  withoutTiming.apply(payload(fixtureView()))
  const said = strings(await openTaskForm(withoutTiming)).join(' | ')
  assert.match(said, /读不到调度能力：this build does not answer timing questions/)
})

test('the form refuses a time that has already gone, on the button and on Enter', async () => {
  /**
   * A `datetime-local` field truncates to the minute, so "this minute" is behind us the moment it is picked — and
   * the scheduler refuses a *new* task whose instant is in the past, precisely because a past instant is `ready`
   * in the gate and would run at once instead of waiting (the "定时任务挂起失败" report). The form therefore has to
   * refuse it too, in the two ways it can be sent: the button, and Enter inside the prompt.
   */
  const orb = loadOrb({ snapshot: fixtureView() })
  orb.setTiming(fixtureTiming())
  orb.apply(payload(fixtureView()))
  const body = await openTaskForm(orb)

  const pad = (value) => String(value).padStart(2, '0')
  const past = new Date(Date.now() - 5 * 60_000)
  const time = findNode(body, (node) => node.dataset.orbField === 'startAt')
  time.value = `${past.getFullYear()}-${pad(past.getMonth() + 1)}-${pad(past.getDate())}T${pad(past.getHours())}:${pad(past.minutes ?? past.getMinutes())}`
  time.fire('input')

  const prompt = findNode(orb.elements.get('panelBody'), (node) => node.dataset.orbField === 'prompt')
  prompt.value = '晚了一步'
  prompt.fire('input')

  const create = findNode(orb.elements.get('panelBody'), (node) => node.dataset.orbAction === 'create-task')
  assert.equal(create.disabled, true, 'the button would schedule a task for a time that has gone')
  assert.match(create.title, /已经过去/, 'the disabled button did not say why')

  // Enter reaches the submit path without the button, so it has to refuse too — and say so in the panel.
  prompt.fire('keydown', { key: 'Enter', shiftKey: false, isComposing: false, preventDefault: () => {} })
  await tick()
  await tick()
  assert.equal(orb.calls.filter((call) => call.startsWith('createTask:')).length, 0, 'a past time was posted anyway')
  assert.match(strings(orb.elements.get('panelBody')).join(' | '), /这个时间已经过去/)
})

test('the form is not dismissed by a click elsewhere, and puts the cursor in the composer', async () => {
  /**
   * The user's report: "悬浮球的入口打开窗口后无法编辑，任意点击直接关闭弹窗". Both halves are asserted here, because
   * they are two different mechanisms: the click that focuses a field must not dismiss the surface holding it, and
   * the window must be able to take the keyboard at all (`syncFocusable` in `system-orb.cjs` grants exactly that,
   * for exactly as long as the panel is open — see `system-orb.test.js`).
   */
  const orb = loadOrb({ snapshot: fixtureView() })
  orb.setTiming(fixtureTiming())
  orb.apply(payload(fixtureView()))
  const body = await openTaskForm(orb)

  // The cursor is in the composer the user just opened, not on the ball.
  const prompt = findNode(body, (node) => node.dataset.orbField === 'prompt')
  assert.equal(orb.sandbox.document.activeElement, prompt, 'the form opened without a cursor in it')

  // A click somewhere else on the screen — another application, the desktop, the official page — is not a decision
  // to throw half-typed text away. It must reach the shell as *nothing*: the panel stays.
  orb.calls.length = 0
  orb.sandbox.document.fire('pointerdown', { target: orb.outside })
  await tick()
  assert.equal(orb.calls.includes('open:false'), false, `a click outside the panel dismissed the form: ${orb.calls.join(', ')}`)
  assert.match(strings(orb.elements.get('panelBody')).join(' | '), /要执行的内容/, 'the form closed on a click outside it')

  // The dashboard is the other way round: a click outside it closes it, which is the rule the form is exempt from
  // only because it holds text.
  findNode(orb.elements.get('panelBody'), (node) => node.textContent === '返回 · Back').fire('click')
  orb.calls.length = 0
  orb.sandbox.document.fire('pointerdown', { target: orb.outside })
  await tick()
  assert.ok(orb.calls.includes('open:false'), `the dashboard no longer closes on a click outside it: ${orb.calls.join(', ')}`)
})

test('a poll redraw keeps the cursor in the field being typed in, at the offset it was at', async () => {
  const orb = loadOrb({ snapshot: fixtureView() })
  orb.setTiming(fixtureTiming())
  orb.apply(payload(fixtureView()))
  await openTaskForm(orb)

  const prompt = findNode(orb.elements.get('panelBody'), (node) => node.dataset.orbField === 'prompt')
  prompt.value = '半句话'
  prompt.fire('input')
  prompt.setSelectionRange(2, 2)

  // The shell pushes a new view every 15 seconds, and drawing it replaces the panel's nodes. A redraw that dropped
  // the cursor would interrupt the user mid-word — so the field, and the caret inside it, come back.
  orb.apply(payload(fixtureView()))
  const redrawn = findNode(orb.elements.get('panelBody'), (node) => node.dataset.orbField === 'prompt')
  assert.equal(orb.sandbox.document.activeElement, redrawn, 'the redraw took the cursor out of the composer')
  assert.equal(redrawn.selectionStart, 2, 'the redraw moved the caret')
  assert.equal(redrawn.value, '半句话')
})

test('the queue fold counts what waits, and lets a task be moved and edited in this window', async () => {
  /**
   * The user's report, for the system ball: "定时任务测试成功，但是页面切换后，悬浮球信息页挂起任务数量没有改变，也不能编辑，
   * 也不能调顺序". The count is on the shut fold's heading (it used to hide behind three rows inside the fold), the tasks
   * are rows with the two operations the scheduler offers, and both go through this window's own channels — the same
   * `reorderTask`/`editTask` the official UI reaches over HTTP.
   */
  const orb = loadOrb({ snapshot: fixtureView() })
  orb.setTiming(fixtureTiming())
  // The queue arrives inside the view the shell pushes — there is no separate read for it (see the host half's note).
  const view = fixtureView()
  view.dashboard.queue = fixtureQueue()
  orb.apply(payload(view))

  // The number the user watches is on the heading, while the fold is shut.
  const heading = () => findNode(orb.elements.get('panelBody'), (node) => node.dataset.category === 'queue')
  assert.match(heading().children.map((child) => child.textContent).join(' · '), /已挂起 1 · 等待 1/)

  heading().fire('click')
  const body = orb.elements.get('panelBody')
  const said = strings(body).join(' | ')
  assert.match(said, /总结今天的构建日志/)
  assert.match(said, /把报告发到工作区/)
  assert.match(said, /已挂起 · 等到点/)

  /** One task's buttons, found fresh because a redraw replaces the nodes. */
  const buttons = (taskId) => {
    const row = findNode(body, (node) => node.dataset.task === taskId)
    assert.ok(row, `no row for ${taskId}`)
    const found = []
    const walk = (node) => {
      if (!node || typeof node !== 'object') return
      if (node.tagName === 'BUTTON') found.push(node)
      for (const child of node.children || []) walk(child)
    }
    walk(row)
    return found
  }
  // The first task cannot move up and the last cannot move down: a button that cannot change anything is not offered.
  assert.equal(buttons('task-a')[0].disabled, true, 'the first task offered to move up')
  assert.equal(buttons('task-b')[1].disabled, true, 'the last task offered to move down')

  // Moving posts the scheduler's own move, addressed by id.
  buttons('task-a')[1].fire('click')
  await tick()
  const moved = orb.calls.find((call) => call.startsWith('moveTask:'))
  assert.ok(moved, `the move never left this window: ${orb.calls.join(', ')}`)
  assert.deepEqual(JSON.parse(moved.slice('moveTask:'.length)), { taskId: 'task-a', move: 'down' })

  // Editing opens this window's form on that task, with the task's own words in it.
  buttons('task-a')[2].fire('click')
  await tick()
  await tick()
  const form = findNode(orb.elements.get('panelBody'), (node) => node.dataset.orbEditing === 'task-a')
  assert.ok(form, 'editing a queued task opened no form')
  const prompt = findNode(orb.elements.get('panelBody'), (node) => node.dataset.orbField === 'prompt')
  assert.equal(prompt.value, '总结今天的构建日志', 'the form did not start from the task')
  assert.match(strings(orb.elements.get('panelBody')).join(' | '), /编辑队列 #1/)

  // ...and saving posts the change to the edit channel, addressed by id.
  prompt.value = '总结今天和昨天的构建日志'
  prompt.fire('input')
  findNode(orb.elements.get('panelBody'), (node) => node.dataset.orbAction === 'create-task').fire('click')
  await tick()
  await tick()
  await tick()
  const edited = orb.calls.filter((call) => call.startsWith('editTask:')).pop()
  assert.ok(edited, `the edit never left this window: ${orb.calls.join(', ')}`)
  const changes = JSON.parse(edited.slice('editTask:'.length))
  assert.equal(changes.taskId, 'task-a')
  assert.equal(changes.prompt, '总结今天和昨天的构建日志')
  assert.equal('deliveryMode' in changes, false, 'an edit rewrote the delivery the user chose when they created it')
  assert.match(strings(orb.elements.get('panelBody')).join(' | '), /已更新/)
})

test('deleting a queued task asks first, and only the second click deletes it', async () => {
  /**
   * "队列任务需要允许删除." The deletion is the scheduler's own `cancelTask` (the task leaves the queue and stays in
   * history as CANCELED), and it asks first: it is the one button on a queue row that cannot be undone from this
   * window. `pendingDelete` is module state, so the shell's fifteen-second poll cannot throw the question away.
   */
  const orb = loadOrb({ snapshot: fixtureView() })
  orb.setTiming(fixtureTiming())
  const view = fixtureView()
  view.dashboard.queue = fixtureQueue()
  orb.apply(payload(view))
  findNode(orb.elements.get('panelBody'), (node) => node.dataset.category === 'queue').fire('click')

  const body = orb.elements.get('panelBody')
  const rowFor = (id) => findNode(body, (node) => node.dataset.task === id)
  const byAction = (id, action) => {
    const row = rowFor(id)
    let found = null
    const walk = (node) => {
      if (!node || typeof node !== 'object' || found) return
      if (node.tagName === 'BUTTON' && node.dataset.orbAction === action) { found = node; return }
      for (const child of node.children || []) walk(child)
    }
    walk(row)
    return found
  }
  const deletes = () => orb.calls.filter((call) => call.startsWith('deleteTask:'))

  const ask = byAction('task-b', 'ask-delete-task')
  assert.ok(ask, `the queue row has no delete button: ${strings(rowFor('task-b')).join(' | ')}`)
  assert.equal(deletes().length, 0, 'a delete was posted before anyone asked for one')
  ask.fire('click')

  // The first click asks: the row is a question, and the shell's next push does not dismiss it.
  assert.equal(rowFor('task-b').dataset.confirming, 'on', 'the row did not turn into its own confirmation')
  assert.match(strings(body).join(' | '), /删除这条？/)
  assert.equal(deletes().length, 0, 'asking deleted the task')
  orb.apply(payload(view))
  assert.equal(rowFor('task-b').dataset.confirming, 'on', 'a redraw dismissed the confirmation')
  assert.ok(byAction('task-b', 'delete-task'), 'the confirmation has nothing to confirm with')

  // 取消 keeps it; the second click on 删除 deletes it, addressed by id.
  findNode(rowFor('task-b'), (node) => node.tagName === 'BUTTON' && node.textContent === '取消 · Cancel').fire('click')
  assert.equal(rowFor('task-b').dataset.confirming, undefined)
  assert.equal(deletes().length, 0)
  byAction('task-b', 'ask-delete-task').fire('click')
  byAction('task-b', 'delete-task').fire('click')
  await tick()
  await tick()
  assert.deepEqual(JSON.parse(deletes()[0].slice('deleteTask:'.length)), { taskId: 'task-b' })
  assert.match(strings(orb.elements.get('panelBody')).join(' | '), /已删除/)
})

test('the window is asked for the whole panel: the head plus the body, never the height it was given', () => {
  /**
   * This is the "only half of it is shown" bug, asserted where it happened.
   *
   * The panel is a flex column whose body scrolls, so `panel.scrollHeight` is the height the panel *currently has*
   * — the number the shell just gave it. Measuring that and asking for it back is a closed loop: the window is
   * sized to what already fits, the overflow stays inside the body, and the panel looks cropped. The measurement
   * has to be the head plus the body's own content height.
   */
  const orb = loadOrb({ snapshot: fixtureView() })
  orb.apply(payload(fixtureView()))
  orb.calls.length = 0
  // What a browser would report: the panel is capped at 300px, its body scrolls, and the content needs 900.
  orb.elements.get('panel').offsetWidth = 340
  orb.elements.get('panel').scrollHeight = 300
  orb.elements.get('panelHead').offsetHeight = 33
  orb.elements.get('panelBody').scrollHeight = 900
  // A new content height has to be measured even though the panel's own height did not change: this is what a fold
  // opening, or the form appearing, looks like.
  orb.sandbox.hnsOrbView.measure()
  const measured = orb.calls.filter((call) => call.startsWith('measure:'))
  assert.deepEqual(measured, ['measure:340x933'], `the panel's own height leaked into the measurement: ${measured.join(', ')}`)
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
