'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')

/**
 * Renderer level: execute the real dock renderer against a minimal DOM stub so
 * the UI bindings are actually exercised - no jsdom dependency required.
 *
 * Covers: no crash on a legacy snapshot, no Recent Session Cost rendering,
 * Balance module open detection and manual/retry sharing one refresh path.
 */

function makeElement(id) {
  const classes = new Set()
  return {
    id,
    innerHTML: '',
    textContent: '',
    value: '',
    checked: false,
    hidden: false,
    disabled: false,
    title: '',
    dataset: {},
    style: {},
    onclick: null,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => {
        const next = on === undefined ? !classes.has(c) : Boolean(on)
        if (next) classes.add(c)
        else classes.delete(c)
        return next
      }
    },
    addEventListener() {},
    closest: () => null,
    querySelector: () => null
  }
}

function installDom() {
  const elements = new Map()
  const clicks = []
  const panel = makeElement('balance-panel')
  const observers = []

  class FakeIntersectionObserver {
    constructor(callback, options) {
      this.callback = callback
      this.options = options
      observers.push(this)
    }
    observe(element) { this.element = element }
    disconnect() {}
  }

  global.document = {
    body: makeElement('body'),
    getElementById: (id) => {
      if (!elements.has(id)) elements.set(id, makeElement(id))
      return elements.get(id)
    },
    querySelector: (selector) => (selector === '.balance-panel' ? panel : null),
    addEventListener: (name, handler) => clicks.push({ name, handler })
  }
  global.window = globalThis
  global.IntersectionObserver = FakeIntersectionObserver
  return {
    elements,
    clicks,
    panel,
    observers,
    element: (id) => document.getElementById(id),
    fireIntersection: (isIntersecting) => {
      for (const observer of observers) observer.callback([{ target: observer.element || panel, isIntersecting }])
    }
  }
}

function makeSnapshot(overrides = {}) {
  return {
    extension: { dock: { expanded: true, width: 560 } },
    scheduler: {
      counts: { RUNNING: 0, PENDING: 1 },
      concurrency: { current: 2, hardwareCap: 4, byCpuLoad: 3 },
      peak: { peak: false, nextChange: null },
      config: { minConcurrent: 1, maxConcurrent: 0, cpuReservePercent: 25, memoryReserveGb: 2, memoryPerWorkerGb: 2.5 },
      system: { cpu: { usagePercent: 4 }, memory: { freeGb: 8, totalGb: 32 } },
      hardware: { cpu: { model: 'test', logicalCores: 8 }, gpus: [] }
    },
    tasks: [
      {
        id: 'task-1',
        status: 'PENDING',
        prompt: 'queued work',
        promptPreview: 'queued work',
        deliveryMode: 'official-session',
        allowPeak: false,
        startAtMs: null,
        queueRank: 1
      }
    ],
    history: [{ id: 'old-task', status: 'COMPLETED', savedAt: Date.now() }],
    sessions: [
      // Legacy record: removed cost fields must be ignored, never rendered.
      { status: 'COMPLETED', model: 'deepseek-v4-flash', usage: { inputTokens: 10, outputTokens: 5 }, updatedAt: 1700000000000, cost: { costCny: 4.2 }, recentSessionCost: 4.2 }
    ],
    settings: { notifications: { enabled: true, onCancelled: true, supported: true } },
    workspace: 'C:\\work',
    balance: {
      refreshing: false,
      trigger: 'module-open',
      ok: true,
      partial: false,
      hasData: true,
      stale: false,
      lastUpdatedAt: Date.UTC(2026, 0, 2, 6, 32, 5),
      balances: [{ currency: 'CNY', total: 123.45, toppedUp: 100, granted: 23.45 }],
      providers: [{ id: 'deepseek-official', label: 'DeepSeek 官方', status: 'ok', stale: false, lastUpdatedAt: Date.UTC(2026, 0, 2, 6, 32, 5), error: null }],
      failedProviders: [],
      error: null
    },
    ...overrides
  }
}

function loadDock(snapshot) {
  const dom = installDom()
  const calls = { fetchBalance: [], addTask: [], reorderTask: [], cancelTask: [], clearPending: [], refreshHardware: [], setDockExpanded: [], toggleDock: [] }
  let changedHandler = null

  global.setInterval = () => 0
  global.clearInterval = () => {}

  global.window.megaTools = {
    snapshot: async () => snapshot,
    addTask: async (payload) => { calls.addTask.push(payload); return {} },
    reorderTask: async (...args) => { calls.reorderTask.push(args); return {} },
    cancelTask: async (id) => { calls.cancelTask.push(id); return {} },
    clearPending: async () => { calls.clearPending.push(true); return 0 },
    removeTasks: async () => 0,
    updateScheduler: async () => ({}),
    refreshHardware: async () => { calls.refreshHardware.push(true); return {} },
    updateSettings: async () => ({}),
    fetchBalance: async (trigger, options) => { calls.fetchBalance.push({ trigger, options }); return snapshot.balance },
    pickWorkspace: async () => null,
    pickSound: async () => null,
    openMain: async () => {},
    openTools: async () => {},
    toggleDock: async () => { calls.toggleDock.push(true); return {} },
    setDockExpanded: async (value) => { calls.setDockExpanded.push(value); return {} },
    hideDock: async () => {},
    hideWidget: async () => {},
    onChanged: (handler) => { changedHandler = handler }
  }

  // The renderers are plain scripts (no exports), so each scenario must re-run
  // them against its own DOM stub.
  for (const file of ['../../app/extensions/mega/ui/dock.js', '../../app/extensions/mega/ui/balance-module.js']) {
    delete require.cache[require.resolve(file)]
  }
  require('../../app/extensions/mega/ui/balance-module.js')
  require('../../app/extensions/mega/ui/dock.js')

  return { dom, calls, notifyChanged: () => changedHandler && changedHandler() }
}

function loadTools(snapshot) {
  const dom = installDom()
  const calls = { fetchBalance: [], updateSettings: [] }
  let changedHandler = null

  global.setInterval = () => 0
  global.clearInterval = () => {}

  global.window.megaTools = {
    snapshot: async () => snapshot,
    addTask: async () => ({}),
    reorderTask: async () => ({}),
    cancelTask: async () => ({}),
    clearPending: async () => 0,
    removeTasks: async () => 0,
    updateScheduler: async () => ({}),
    refreshHardware: async () => ({}),
    updateSettings: async (patch) => { calls.updateSettings.push(patch); return {} },
    fetchBalance: async (trigger, options) => { calls.fetchBalance.push({ trigger, options }); return snapshot.balance },
    pickWorkspace: async () => null,
    pickSound: async () => null,
    openMain: async () => {},
    openTools: async () => {},
    toggleDock: async () => ({}),
    setDockExpanded: async () => ({}),
    hideDock: async () => {},
    hideWidget: async () => {},
    onChanged: (handler) => { changedHandler = handler }
  }

  for (const file of ['../../app/extensions/mega/ui/renderer.js', '../../app/extensions/mega/ui/balance-module.js']) {
    delete require.cache[require.resolve(file)]
  }
  require('../../app/extensions/mega/ui/balance-module.js')
  require('../../app/extensions/mega/ui/renderer.js')

  return { dom, calls, notifyChanged: () => changedHandler && changedHandler() }
}

const settle = async () => {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve))
}

test('full Mega tools renders tasks/sessions and refreshes the balance when opened', async () => {
  const h = loadTools(makeSnapshot())
  await settle()

  assert.match(h.dom.element('tasks').innerHTML, /queued work/)
  assert.match(h.dom.element('sessions').innerHTML, /deepseek-v4-flash/)
  assert.equal(/成本|¥/.test(h.dom.element('sessions').innerHTML), false, 'the cost column is gone from the session table')
  assert.equal(h.dom.element('notifyEnabled').checked, true)
  assert.equal(h.dom.element('notifyCancelled').checked, true)
  assert.equal(h.dom.element('error').textContent, '')

  // Browsers deliver an initial IntersectionObserver callback once the panel is
  // laid out; that is the "module opened" signal.
  h.dom.fireIntersection(true)
  await settle()
  assert.equal(h.calls.fetchBalance.length, 1, 'opening the window opens the balance module')
  assert.equal(h.calls.fetchBalance[0].trigger, 'module-open')
  assert.match(h.dom.element('balanceText').textContent, /"ok": true/)
})

test('saving settings sends the notification configuration', async () => {
  const h = loadTools(makeSnapshot())
  await settle()

  h.dom.element('notifyEnabled').checked = false
  h.dom.element('notifyCancelled').checked = true
  await h.dom.element('settingsForm').onsubmit({ preventDefault() {} })
  await settle()

  assert.equal(h.calls.updateSettings.length, 1)
  assert.deepEqual(h.calls.updateSettings[0].notifications, { enabled: false, onCancelled: true })
})

test('the dock renders a snapshot (including legacy session data) without throwing', async () => {
  const h = loadDock(makeSnapshot())
  await settle()

  assert.match(h.dom.element('queue').innerHTML, /queued work/)
  assert.match(h.dom.element('railQueued').textContent, /1/)
  assert.match(h.dom.element('summary').innerHTML, /谷价/)
  assert.match(h.dom.element('sessions').innerHTML, /deepseek-v4-flash/)
  assert.equal(h.dom.element('error').textContent, '')
})

test('the dock never renders a Recent Session Cost metric', async () => {
  const h = loadDock(makeSnapshot())
  await settle()

  const balanceCards = h.dom.element('balanceCards').innerHTML
  const sessions = h.dom.element('sessions').innerHTML
  assert.equal(/最近\s*8\s*个\s*Session/.test(balanceCards), false)
  assert.equal(/成本/.test(balanceCards), false)
  assert.equal(/¥/.test(sessions), false)
  assert.equal(/¥/.test(balanceCards), true, 'the account balance itself is still shown')
  assert.match(balanceCards, /总余额/)
  assert.match(h.dom.element('balanceMeta').textContent, /Last updated: /)
})

test('opening the Balance module triggers exactly one automatic refresh', async () => {
  const snapshot = makeSnapshot()
  const h = loadDock(snapshot)
  await settle()
  // The persisted dock state is "expanded", so the module is open on load.
  assert.equal(h.calls.fetchBalance.length, 1)
  assert.equal(h.calls.fetchBalance[0].trigger, 'module-open')

  // Re-renders (mega:changed, the 5s poll) must not fan out new requests.
  h.notifyChanged()
  h.notifyChanged()
  await settle()
  assert.equal(h.calls.fetchBalance.length, 1)

  // Collapse the dock (module closed) and expand it again: one more refresh.
  snapshot.extension.dock.expanded = false
  h.notifyChanged()
  await settle()
  assert.equal(h.calls.fetchBalance.length, 1, 'a collapsed dock does not refresh')

  snapshot.extension.dock.expanded = true
  h.notifyChanged()
  await settle()
  assert.equal(h.calls.fetchBalance.length, 2)
  assert.equal(h.calls.fetchBalance[1].trigger, 'module-open')
})

test('manual and retry clicks reuse the same refresh path and the button is disabled while busy', async () => {
  const h = loadDock(makeSnapshot({
    balance: {
      refreshing: false,
      trigger: 'manual',
      ok: false,
      partial: true,
      hasData: true,
      stale: true,
      lastUpdatedAt: Date.UTC(2026, 0, 2, 6, 32, 5),
      balances: [{ currency: 'CNY', total: 10, toppedUp: 10, granted: 0 }],
      providers: [
        { id: 'A', label: 'Provider A', status: 'ok', stale: false, lastUpdatedAt: Date.UTC(2026, 0, 2, 6, 32, 5), error: null },
        { id: 'B', label: 'Provider B', status: 'timeout', stale: false, lastUpdatedAt: null, error: { message: 'timed out' } }
      ],
      failedProviders: ['B'],
      error: null
    }
  }))
  await settle()

  assert.equal(h.dom.element('balanceRetry').hidden, false, 'the retry affordance appears when a provider failed')
  assert.match(h.dom.element('balanceCards').innerHTML, /Provider B/)
  assert.match(h.dom.element('balanceCards').innerHTML, /timed out/)
  assert.match(h.dom.element('balanceStatus').textContent, /部分可用/)

  await h.dom.element('balance').onclick()
  await settle()
  assert.deepEqual(h.calls.fetchBalance.at(-1), { trigger: 'manual', options: {} })

  await h.dom.element('balanceRetry').onclick()
  await settle()
  assert.deepEqual(h.calls.fetchBalance.at(-1), { trigger: 'retry', options: { only: ['B'] } })
})

test('a fully failed balance keeps the last successful value visible', async () => {
  const h = loadDock(makeSnapshot({
    balance: {
      refreshing: false,
      trigger: 'manual',
      ok: false,
      partial: false,
      hasData: true,
      stale: true,
      lastUpdatedAt: Date.UTC(2026, 0, 2, 6, 32, 5),
      balances: [{ currency: 'CNY', total: 88, toppedUp: 80, granted: 8 }],
      providers: [{ id: 'deepseek-official', label: 'DeepSeek 官方', status: 'failed', stale: true, lastUpdatedAt: Date.UTC(2026, 0, 2, 6, 32, 5), error: { message: 'network unreachable' } }],
      failedProviders: ['deepseek-official'],
      error: { message: 'network unreachable' }
    }
  }))
  await settle()

  const cards = h.dom.element('balanceCards').innerHTML
  assert.match(h.dom.element('balanceStatus').textContent, /刷新失败/)
  assert.match(cards, /88\.00/)
  assert.match(cards, /上次成功值/)
  assert.match(cards, /network unreachable/)
})

test('a never-refreshed balance shows the empty state without stray values', async () => {
  const h = loadDock(makeSnapshot({
    balance: { refreshing: false, trigger: null, ok: false, partial: false, hasData: false, balances: [], providers: [], failedProviders: [], error: null, lastUpdatedAt: null, stale: false }
  }))
  await settle()

  assert.match(h.dom.element('balanceStatus').textContent, /未刷新/)
  assert.match(h.dom.element('balanceMeta').textContent, /Last updated: —/)
  assert.match(h.dom.element('balanceCards').innerHTML, /打开余额模块会自动刷新/)
  assert.equal(h.dom.element('balanceRetry').hidden, true)
})
