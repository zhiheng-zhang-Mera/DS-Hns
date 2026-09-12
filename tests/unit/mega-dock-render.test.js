'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..', '..')

/**
 * Renderer level: execute the real dock renderer against a minimal DOM stub so
 * the UI bindings are actually exercised - no jsdom dependency required.
 *
 * Covers: legacy snapshot tolerance, no Recent Session / cost rendering, the
 * in-dock settings layer (former Full Mega Tools capabilities) and the Balance
 * module open/manual/retry refresh semantics.
 */

function makeElement(id) {
  const classes = new Set()
  const handlers = new Map()
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
    handlers,
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
    addEventListener(name, handler) {
      if (!handlers.has(name)) handlers.set(name, [])
      handlers.get(name).push(handler)
    },
    fire(name, event = {}) {
      for (const handler of handlers.get(name) || []) handler(event)
    },
    closest: () => null,
    querySelector: () => null,
    // A real element carries attributes; the Dock's mode switch sets
    // `aria-selected` on its two selector buttons.
    attributes: {},
    children: [],
    appendChild(child) { this.children.push(child); return child },
    setAttribute(name, value) { this.attributes[name] = String(value) },
    getAttribute(name) { return this.attributes[name] ?? null }
  }
}

function installDom({ panels = [] } = {}) {
  const elements = new Map()
  const documentHandlers = new Map()
  const panel = makeElement('balance-panel')
  const observers = []
  // The stub mirrors markup state that a browser would already have applied.
  elements.set('settingsOverlay', Object.assign(makeElement('settingsOverlay'), { hidden: true }))

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
    // The dock's collapsible-module setup walks the module list, so the stub
    // hands it exactly the fixtures a test seeded. An empty list (the default for
    // every other test) makes that setup a no-op.
    querySelectorAll: (selector) => (selector === '#detail section.panel' ? panels : []),
    createElement: (tag) => makeElement(tag),
    addEventListener: (name, handler) => {
      if (!documentHandlers.has(name)) documentHandlers.set(name, [])
      documentHandlers.get(name).push(handler)
    },
    fire: (name, event = {}) => {
      for (const handler of documentHandlers.get(name) || []) handler(event)
    }
  }
  global.window = globalThis
  global.IntersectionObserver = FakeIntersectionObserver
  return {
    elements,
    panel,
    panels,
    observers,
    element: (id) => document.getElementById(id),
    fireDocument: (name, event) => document.fire(name, event),
    fireIntersection: (isIntersecting) => {
      for (const observer of observers) observer.callback([{ target: observer.element || panel, isIntersecting }])
    }
  }
}

function makeSnapshot(overrides = {}) {
  return {
    extension: { id: 'mega', mode: 'optional-feature-extension', shellOwner: 'alien', dock: { expanded: true, width: 560 } },
    scheduler: {
      counts: { RUNNING: 0, PENDING: 1 },
      concurrency: { current: 2, hardwareCap: 4, byCpuLoad: 3 },
      peak: { peak: false, nextChange: null },
      config: {
        minConcurrent: 2,
        maxConcurrent: 0,
        cpuReservePercent: 25,
        memoryReserveGb: 2,
        memoryPerWorkerGb: 2.5,
        defaultAllowPeak: true,
        interruptRunningAtPeak: false
      },
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
    // Legacy payload from an older build: the dock must ignore it completely.
    sessions: [{ status: 'COMPLETED', model: 'deepseek-v4-flash', usage: { inputTokens: 10 }, cost: { costCny: 4.2 } }],
    settings: {
      defaultModel: 'deepseek-v4-flash',
      models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
      permissionMode: 'workspace-write',
      telemetryMode: 'DISABLED',
      apiKeyMasked: 'sk-••••1234',
      sound: {
        enabled: true,
        volume: 0.8,
        events: {
          COMPLETED: { enabled: true, file: 'completed.wav', label: '任务完成' },
          FAILED: { enabled: true, file: 'failed.wav', label: '任务失败' },
          INTERRUPTED: { enabled: true, file: 'interrupted.wav', label: '任务中断' }
        }
      },
      notifications: { enabled: true, onCancelled: false, supported: true }
    },
    workspace: 'C:\\work',
    update: {
      status: 'outdated',
      packageName: '@deepseek-ai/dsh',
      tag: 'latest',
      currentVersion: '0.1.2-rc.1',
      pinnedVersion: '0.1.2-rc.1',
      latestVersion: '0.1.5-rc.1',
      updateAvailable: true,
      checkedAt: Date.UTC(2026, 0, 2, 6, 32, 5),
      npmAvailable: true,
      nodeExe: 'C:\\runtime\\node.exe',
      error: null,
      lastUpdate: null
    },
    soundFiles: [
      { name: 'completed.wav', kind: 'preset' },
      { name: 'failed.wav', kind: 'preset' },
      { name: 'interrupted.wav', kind: 'preset' },
      { name: 'custom.mp3', kind: 'user' }
    ],
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

function loadDock(snapshot, options = {}) {
  const dom = installDom(options)
  const calls = {
    fetchBalance: [],
    addTask: [],
    reorderTask: [],
    cancelTask: [],
    clearPending: [],
    refreshHardware: [],
    setDockExpanded: [],
    toggleDock: [],
    updateSettings: [],
    updateScheduler: [],
    pickWorkspace: [],
    pickSound: [],
    checkHarnessUpdate: [],
    applyHarnessUpdate: []
  }
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
    updateScheduler: async (patch) => { calls.updateScheduler.push(patch); return patch },
    refreshHardware: async () => { calls.refreshHardware.push(true); return {} },
    updateSettings: async (patch) => { calls.updateSettings.push(patch); return {} },
    fetchBalance: async (trigger, options) => { calls.fetchBalance.push({ trigger, options }); return snapshot.balance },
    pickWorkspace: async () => { calls.pickWorkspace.push(true); return 'C:\\other' },
    pickSound: async () => { calls.pickSound.push(true); return { name: 'custom.mp3', kind: 'user' } },
    checkHarnessUpdate: async () => { calls.checkHarnessUpdate.push(true); return snapshot.update },
    applyHarnessUpdate: async () => {
      calls.applyHarnessUpdate.push(true)
      return { started: true, from: snapshot.update?.currentVersion, to: snapshot.update?.latestVersion }
    },
    openMain: async () => {},
    toggleDock: async () => { calls.toggleDock.push(true); return {} },
    setDockExpanded: async (value) => { calls.setDockExpanded.push(value); return {} },
    hideDock: async () => {},
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

const settle = async () => {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve))
}

/** One fake `#detail section.panel` with a header, for the collapse tests. */
function makePanel(id) {
  const head = makeElement(`${id}-head`)
  const panel = makeElement(id)
  panel.querySelector = (selector) => (selector === '.panel-head' ? head : null)
  panel.head = head
  return panel
}

test('every dock module is collapsible and remembers its state', async () => {
  const panels = [makePanel('modePanel'), makePanel('queuePanel')]
  const h = loadDock(makeSnapshot(), { panels })
  await settle()

  // A chevron is installed into each module header, expanded by default.
  for (const panel of panels) {
    assert.equal(panel.head.children.length, 1, `${panel.id} got a collapse control`)
    const toggle = panel.head.children[0]
    assert.equal(toggle.className, 'panel-collapse')
    assert.equal(toggle.dataset.panel, panel.id)
    assert.equal(toggle.getAttribute('aria-expanded'), 'true')
    assert.equal(toggle.textContent, '▾')
  }

  // Clicking the header collapses that module and only that module.
  panels[0].head.fire('click', { target: panels[0].head })
  assert.equal(panels[0].dataset.collapsed, '1')
  assert.equal(panels[0].head.children[0].textContent, '▸')
  assert.equal(panels[0].head.children[0].getAttribute('aria-expanded'), 'false')
  assert.equal(panels[1].dataset.collapsed, '', 'the other module is untouched')

  // A click aimed at one of the module's own controls must not collapse it.
  panels[1].head.fire('click', { target: { closest: (selector) => (selector.includes('button') ? {} : null) } })
  assert.equal(panels[1].dataset.collapsed, '', 'a control click does not toggle the module')

  // The chevron toggles it back.
  panels[0].head.children[0].fire('click', { stopPropagation() {} })
  assert.equal(panels[0].dataset.collapsed, '')
  assert.equal(panels[0].head.children[0].textContent, '▾')
})

test('the dock collapses when Work Mode needs the width, and comes back after', async () => {
  const main = fs.readFileSync(path.join(ROOT, 'app', 'desktop-main.cjs'), 'utf8')
  // The policy lives in the shell (it owns the mode) and is applied through the
  // extension that owns the dock state, without overwriting the user preference.
  assert.match(main, /function applyDockPolicyForMode/)
  assert.match(main, /extensionManager\.setDockExpanded\(false, \{ persist: false, focus: false \}\)/)
  assert.match(main, /extensionManager\.setDockExpanded\(true, \{ persist: false, focus: false \}\)/)
  assert.match(main, /applyDockPolicyForMode\(daily \? 'daily' : 'work'\)/)
  const mega = fs.readFileSync(path.join(ROOT, 'app', 'extensions', 'mega', 'index.cjs'), 'utf8')
  assert.match(mega, /function setDockExpanded\(expanded, \{ focus = false, persist = true \} = \{\}\)/)
  assert.match(mega, /if \(persist\) saveDockState\(\)/)
})

test('the dock renders a snapshot (including legacy session data) without throwing', async () => {
  const h = loadDock(makeSnapshot())
  await settle()

  assert.match(h.dom.element('queue').innerHTML, /queued work/)
  assert.match(h.dom.element('railQueued').textContent, /1/)
  assert.match(h.dom.element('summary').innerHTML, /谷价/)
  assert.equal(h.dom.element('error').textContent, '')
  assert.equal(h.dom.element('settingsOverlay').hidden, true, 'settings start closed')
})

test('the dock renders neither a session list nor a cost metric', async () => {
  const h = loadDock(makeSnapshot())
  await settle()

  const balanceCards = h.dom.element('balanceCards').innerHTML
  assert.equal(/最近\s*8\s*个\s*Session/.test(balanceCards), false)
  assert.equal(/成本/.test(balanceCards), false)
  assert.equal(/¥/.test(balanceCards), true, 'the account balance itself is still shown')
  assert.match(balanceCards, /总余额/)
  assert.equal(h.dom.elements.has('sessions') && h.dom.element('sessions').innerHTML !== '', false, 'no session list is rendered')
})

test('opening the Balance module triggers exactly one automatic refresh', async () => {
  const snapshot = makeSnapshot()
  const h = loadDock(snapshot)
  await settle()
  // The persisted dock state is "expanded", so the module is open on load.
  assert.equal(h.calls.fetchBalance.length, 1)
  assert.equal(h.calls.fetchBalance[0].trigger, 'module-open')

  h.notifyChanged()
  h.notifyChanged()
  await settle()
  assert.equal(h.calls.fetchBalance.length, 1)

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

test('manual and retry clicks reuse the same refresh path', async () => {
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

test('the settings layer opens inside the dock and mirrors every migrated setting', async () => {
  const h = loadDock(makeSnapshot())
  await settle()

  assert.equal(h.dom.element('settingsOverlay').hidden, true)
  h.dom.element('openSettings').onclick({ stopPropagation() {} })
  assert.equal(h.dom.element('settingsOverlay').hidden, false)
  assert.equal(h.dom.element('apiKey').value, '')

  // General
  assert.match(h.dom.element('model').innerHTML, /deepseek-v4-pro/)
  assert.equal(h.dom.element('globalPermission').value, 'workspace-write')
  assert.equal(h.dom.element('telemetry').value, 'DISABLED')
  // Notifications
  assert.equal(h.dom.element('soundEnabled').checked, true)
  assert.equal(h.dom.element('volume').value, 0.8)
  assert.match(h.dom.element('soundCompleted').innerHTML, /completed\.wav/)
  assert.match(h.dom.element('soundCompleted').innerHTML, /custom\.mp3/, 'imported ringtones are selectable')
  assert.match(h.dom.element('soundFailed').innerHTML, /failed\.wav/)
  assert.match(h.dom.element('soundInterrupted').innerHTML, /interrupted\.wav/)
  assert.equal(h.dom.element('notifyEnabled').checked, true)
  assert.equal(h.dom.element('notifyCancelled').checked, false)
  // Workspace
  assert.match(h.dom.element('workspaceText').textContent, /C:\\work/)
  // Scheduler
  assert.equal(h.dom.element('minConcurrent').value, 2)
  assert.equal(h.dom.element('memoryPerWorkerGb').value, 2.5)
  assert.equal(h.dom.element('defaultAllowPeak').checked, true)
  assert.equal(h.dom.element('interruptRunningAtPeak').checked, false)

  h.dom.element('closeSettings').onclick()
  assert.equal(h.dom.element('settingsOverlay').hidden, true)
})

test('the settings layer closes on Escape and on a backdrop click', async () => {
  const snapshotForCollapse = makeSnapshot()
  const h = loadDock(snapshotForCollapse)
  await settle()

  h.dom.element('openSettings').onclick({ stopPropagation() {} })
  assert.equal(h.dom.element('settingsOverlay').hidden, false)
  h.dom.fireDocument('keydown', { key: 'Escape' })
  assert.equal(h.dom.element('settingsOverlay').hidden, true)

  h.dom.element('openSettings').onclick({ stopPropagation() {} })
  h.dom.element('settingsOverlay').fire('click', { target: h.dom.element('settingsOverlay') })
  assert.equal(h.dom.element('settingsOverlay').hidden, true)

  // A collapsed dock cannot leave a floating settings layer behind.
  h.dom.element('openSettings').onclick({ stopPropagation() {} })
  snapshotForCollapse.extension.dock.expanded = false
  h.dom.element('collapse').onclick()
  await settle()
  assert.equal(h.dom.element('settingsOverlay').hidden, true)
})

test('saving settings uses the existing backend IPC with the expected patches', async () => {
  const h = loadDock(makeSnapshot())
  await settle()

  h.dom.element('model').value = 'deepseek-v4-pro'
  h.dom.element('globalPermission').value = 'read-only'
  h.dom.element('telemetry').value = 'ENABLED'
  h.dom.element('apiKey').value = 'sk-new-key'
  await h.dom.element('generalForm').onsubmit({ preventDefault() {} })
  await settle()
  assert.deepEqual(h.calls.updateSettings[0], {
    model: 'deepseek-v4-pro',
    permissionMode: 'read-only',
    telemetryMode: 'ENABLED',
    apiKey: 'sk-new-key'
  })
  assert.equal(h.dom.element('apiKey').value, '', 'the key field is cleared after saving')

  // A browser reflects the rendered <option selected> into .value.
  h.dom.element('soundCompleted').value = 'custom.mp3'
  h.dom.element('soundFailed').value = 'failed.wav'
  h.dom.element('soundInterrupted').value = 'interrupted.wav'
  h.dom.element('notifyEnabled').checked = false
  h.dom.element('notifyCancelled').checked = true
  h.dom.element('volume').value = '0.35'
  await h.dom.element('notificationForm').onsubmit({ preventDefault() {} })
  await settle()
  const notificationPatch = h.calls.updateSettings[1]
  assert.equal(notificationPatch.soundEnabled, true)
  assert.equal(notificationPatch.sound.volume, 0.35)
  assert.deepEqual(notificationPatch.sound.events, {
    COMPLETED: { file: 'custom.mp3' },
    FAILED: { file: 'failed.wav' },
    INTERRUPTED: { file: 'interrupted.wav' }
  })
  assert.deepEqual(notificationPatch.notifications, { enabled: false, onCancelled: true })

  // With no ringtone available the event entry is omitted, so the configured
  // file is preserved instead of being rejected by the settings backend.
  h.dom.element('soundFailed').value = ''
  await h.dom.element('notificationForm').onsubmit({ preventDefault() {} })
  await settle()
  assert.deepEqual(h.calls.updateSettings[2].sound.events, {
    COMPLETED: { file: 'custom.mp3' },
    INTERRUPTED: { file: 'interrupted.wav' }
  })

  h.dom.element('maxConcurrent').value = '3'
  await h.dom.element('schedulerForm').onsubmit({ preventDefault() {} })
  await settle()
  assert.equal(h.calls.updateScheduler[0].maxConcurrent, 3)
  assert.equal(h.calls.updateScheduler[0].minConcurrent, 2)
  assert.equal(h.calls.updateScheduler[0].defaultAllowPeak, true)

  await h.dom.element('workspace').onclick()
  await settle()
  assert.deepEqual(h.calls.pickWorkspace, [true])
  assert.match(h.dom.element('settingsStatus').textContent, /C:\\other/)

  await h.dom.element('soundFile').onclick()
  await settle()
  assert.deepEqual(h.calls.pickSound, [true])
  assert.match(h.dom.element('settingsStatus').textContent, /custom\.mp3/)
})

test('a settings save failure is reported without breaking the dock', async () => {
  const h = loadDock(makeSnapshot())
  await settle()
  global.window.megaTools.updateSettings = async () => { throw new Error('settings backend refused') }

  await h.dom.element('generalForm').onsubmit({ preventDefault() {} })
  await settle()
  assert.match(h.dom.element('settingsStatus').textContent, /保存失败/)
  assert.match(h.dom.element('error').textContent, /settings backend refused/)
})

test('拓展状态 renders the Mega extension and both harness versions and offers the update', async () => {
  const h = loadDock(makeSnapshot())
  await settle()

  const grid = h.dom.element('updateGrid').innerHTML
  assert.match(grid, /Mega 扩展/)
  assert.match(grid, /已加载 · mega/)
  assert.match(grid, /0\.1\.2-rc\.1/)
  assert.match(grid, /0\.1\.5-rc\.1/)
  assert.match(grid, /data-state="outdated"/, 'an available update is visibly flagged')
  assert.match(h.dom.element('updateMeta').textContent, /Last checked:/)

  assert.equal(h.dom.element('updateStatus').textContent, '可更新')
  assert.equal(h.dom.element('updateCheck').disabled, false)
  assert.equal(h.dom.element('updateApply').disabled, false, 'the button is live when an update exists')
})

test('the update button stays disabled when the harness is already current or npm is missing', async () => {
  const current = loadDock(makeSnapshot({
    update: { ...makeSnapshot().update, status: 'current', latestVersion: '0.1.2-rc.1', updateAvailable: false }
  }))
  await settle()
  assert.equal(current.dom.element('updateStatus').textContent, '已是最新')
  assert.equal(current.dom.element('updateApply').disabled, true)

  const noNpm = loadDock(makeSnapshot({
    update: { ...makeSnapshot().update, npmAvailable: false, status: 'idle' }
  }))
  await settle()
  assert.equal(noNpm.dom.element('updateApply').disabled, true)
  assert.match(noNpm.dom.element('updateNote').textContent, /未找到 npm CLI/)
})

test('checking and applying the update go through the dedicated IPC channels', async () => {
  const h = loadDock(makeSnapshot())
  await settle()

  await h.dom.element('updateCheck').onclick()
  await settle()
  assert.deepEqual(h.calls.checkHarnessUpdate, [true])

  // Without a confirm() implementation the click proceeds; the restart itself
  // belongs to the shell, so the dock only reports that it was handed off.
  delete global.window.confirm
  await h.dom.element('updateApply').onclick()
  await settle()
  assert.deepEqual(h.calls.applyHarnessUpdate, [true])
  assert.match(h.dom.element('updateNote').textContent, /即将自动重启/)
  assert.equal(h.dom.element('updateApply').disabled, true)
})

test('declining the restart confirmation never starts an update', async () => {
  const h = loadDock(makeSnapshot())
  await settle()

  global.window.confirm = () => false
  try {
    await h.dom.element('updateApply').onclick()
    await settle()
    assert.deepEqual(h.calls.applyHarnessUpdate, [])
  } finally {
    delete global.window.confirm
  }
})

test('a refused update start is reported instead of pretending to restart', async () => {
  const h = loadDock(makeSnapshot())
  await settle()
  global.window.megaTools.applyHarnessUpdate = async () => ({ started: false, reason: 'NPM_UNAVAILABLE', message: '未找到 npm CLI，无法更新主 harness。' })

  await h.dom.element('updateApply').onclick()
  await settle()
  assert.match(h.dom.element('updateNote').textContent, /更新未启动/)
  assert.match(h.dom.element('updateNote').textContent, /npm CLI/)
  assert.equal(h.dom.element('updateNote').dataset.state, 'failed')
})

test('the last update outcome survives the restart and is reported in the dock', async () => {
  const h = loadDock(makeSnapshot({
    update: {
      ...makeSnapshot().update,
      status: 'current',
      currentVersion: '0.1.5-rc.1',
      latestVersion: '0.1.5-rc.1',
      updateAvailable: false,
      lastUpdate: { status: 'succeeded', from: '0.1.2-rc.1', to: '0.1.5-rc.1', finishedAt: Date.UTC(2026, 0, 2, 7, 0, 0) }
    }
  }))
  await settle()
  const note = h.dom.element('updateNote').textContent
  assert.match(note, /上次更新成功/)
  assert.match(note, /0\.1\.2-rc\.1 → 0\.1\.5-rc\.1/)

  const failed = loadDock(makeSnapshot({
    update: {
      ...makeSnapshot().update,
      status: 'failed',
      error: { message: 'registry unavailable' },
      lastUpdate: { status: 'failed', from: '0.1.2-rc.1', to: '0.1.5-rc.1', error: { message: 'npm install exited with code 1' }, finishedAt: Date.UTC(2026, 0, 2, 7, 0, 0) }
    }
  }))
  await settle()
  assert.equal(failed.dom.element('updateStatus').textContent, '检查失败')
  assert.equal(failed.dom.element('updateNote').dataset.state, 'failed')
  assert.match(failed.dom.element('updateNote').textContent, /npm install exited with code 1/)
})

test('a failed update says whether the previous version came back, and a broken rollback shouts', async () => {
  const rolledBack = loadDock(makeSnapshot({
    update: {
      ...makeSnapshot().update,
      status: 'failed',
      lastUpdate: {
        status: 'failed_rolled_back',
        rolledBack: true,
        rollbackFailed: false,
        from: '0.1.2-rc.1',
        to: '0.1.5-rc.1',
        error: { message: 'npm install exited with code 1' },
        rollback: { ok: true, restoredVersion: '0.1.2-rc.1' },
        finishedAt: Date.UTC(2026, 0, 2, 7, 0, 0)
      }
    }
  }))
  await settle()
  const rolledText = rolledBack.dom.element('updateNote').textContent
  assert.match(rolledText, /已回滚到原版本/)
  assert.equal(rolledBack.dom.element('updateNote').dataset.state, 'failed')

  const brokenRollback = loadDock(makeSnapshot({
    update: {
      ...makeSnapshot().update,
      status: 'failed',
      lastUpdate: {
        status: 'failed_rollback_failed',
        rolledBack: false,
        rollbackFailed: true,
        from: '0.1.2-rc.1',
        to: '0.1.5-rc.1',
        error: {
          code: 'INSTALL_FAILED_ROLLBACK_FAILED',
          message: 'npm install exited with code 1',
          rollback: { code: 'ROLLBACK_RESTORE_INCOMPLETE', message: 'npm ci exited with code 1' }
        },
        rollback: { ok: false, code: 'ROLLBACK_RESTORE_INCOMPLETE', message: 'npm ci exited with code 1' },
        finishedAt: Date.UTC(2026, 0, 2, 7, 0, 0)
      }
    }
  }))
  await settle()
  const brokenText = brokenRollback.dom.element('updateNote').textContent
  assert.match(brokenText, /回滚未完成/)
  assert.match(brokenText, /可能已损坏/, 'the user must be told the installation may be broken')
  assert.match(brokenText, /ROLLBACK_RESTORE_INCOMPLETE/, 'the machine-readable reason is surfaced, not hidden')
  assert.equal(
    brokenRollback.dom.element('updateNote').dataset.state,
    'rollback-failed',
    'a broken rollback gets its own state so "更新失败" can not mask it'
  )
})
