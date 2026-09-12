'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

/**
 * Renderer level: execute the real native frontend against a minimal DOM stub so
 * the bindings are actually exercised.
 *
 * The stub is deliberately small, which is the point: everything the native
 * renderer touches is its own document. There is no official renderer in this
 * test at all, because in the product there is no path from one to the other.
 */
const NATIVE = path.resolve(__dirname, '..', '..', 'app', 'native-ui')

function makeElement(id) {
  const classes = new Set()
  const handlers = new Map()
  const attributes = {}
  const element = {
    id,
    innerHTML: '',
    textContent: '',
    value: '',
    checked: false,
    hidden: false,
    disabled: false,
    title: '',
    scrollTop: 0,
    scrollHeight: 1000,
    clientHeight: 400,
    dataset: {},
    attributes,
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
    setAttribute(name, value) { attributes[name] = String(value) },
    getAttribute(name) { return attributes[name] ?? null },
    addEventListener(name, handler) {
      if (!handlers.has(name)) handlers.set(name, [])
      handlers.get(name).push(handler)
    },
    removeEventListener(name, handler) {
      const list = handlers.get(name) || []
      const index = list.indexOf(handler)
      if (index >= 0) list.splice(index, 1)
    },
    fire(name, event = {}) {
      for (const handler of handlers.get(name) || []) handler(event)
    },
    closest: (selector) => (selector === '[data-session]' && element.dataset.session ? element : null),
    querySelector: () => null,
    getBoundingClientRect: () => ({ left: 4, top: 8, width: 120, height: 40 }),
    focus() { this.focused = true }
  }
  return element
}

function installDom() {
  const elements = new Map()
  const documentHandlers = new Map()
  // The Context Panel wires its tab bar through document.querySelectorAll.
  const contextTabs = ['files', 'changes', 'git', 'tasks', 'terminal', 'context'].map((name) => {
    const button = makeElement(`tab-${name}`)
    button.dataset.contextTab = name
    return button
  })
  global.document = {
    readyState: 'complete',
    body: makeElement('body'),
    documentElement: makeElement('html'),
    head: { appendChild: () => {} },
    createElement: (tag) => makeElement(tag),
    getElementById: (id) => {
      if (!elements.has(id)) elements.set(id, makeElement(id))
      return elements.get(id)
    },
    querySelector: (selector) => elements.get(selector) || makeElement(selector),
    querySelectorAll: (selector) => (selector === '[data-context-tab]' ? contextTabs : []),
    addEventListener: (name, handler) => {
      if (!documentHandlers.has(name)) documentHandlers.set(name, [])
      documentHandlers.get(name).push(handler)
    },
    fire: (name, event = {}) => {
      for (const handler of documentHandlers.get(name) || []) handler(event)
    }
  }
  global.window = globalThis
  global.requestAnimationFrame = (callback) => callback()
  global.setInterval = () => 0
  global.clearInterval = () => {}
  return {
    elements,
    element: (id) => document.getElementById(id),
    documentElement: global.document.documentElement,
    body: global.document.body,
    contextTabs
  }
}

/** One HNS snapshot as the compatibility adapter produces it. */
function makeSnapshot(overrides = {}) {
  return {
    ok: true,
    mode: 'daily',
    modeState: 'DAILY_ACTIVE',
    degraded: null,
    backend: { state: 'ready', healthy: true, reason: null, version: '0.1.5-rc.1', origin: 'http://127.0.0.1:3080' },
    capability: { ok: true, backend: { state: 'ready' }, journal: true, model: 1, contract: 1 },
    sessions: [
      { id: 'sess-a', title: 'Fix the parser', status: 'RUNNING', running: true, updatedAt: Date.UTC(2026, 8, 12, 1) },
      { id: 'sess-b', title: 'Older work', status: 'COMPLETED', running: false, updatedAt: Date.UTC(2026, 8, 11, 1) }
    ],
    sessionsDegraded: false,
    session: { id: 'sess-a', title: 'Fix the parser', model: 'deepseek-v4-flash', cwd: 'D:\\work', status: 'RUNNING', running: true },
    messages: [
      { id: 'm1', role: 'user', content: 'hello', status: 'complete', toolCalls: [], timestamp: Date.UTC(2026, 8, 12, 1, 0, 10) },
      { id: 'm2', role: 'assistant', content: 'done', status: 'complete', toolCalls: [{ id: 'c1', name: 'read_file', input: { path: 'a.txt' } }], timestamp: Date.UTC(2026, 8, 12, 1, 0, 40) }
    ],
    toolEvents: [
      { id: 'c1', name: 'read_file', status: 'ok', input: { path: 'a.txt' }, output: 'file body', error: null, startedAt: 1, finishedAt: 2 }
    ],
    conversation: { ok: true, reason: null, journal: true, events: 6, unclassified: 0, turnEnd: { reason: 'success', error: null } },
    tasks: [{ id: 't1', title: 'queued task', status: 'PENDING' }],
    composer: { ready: true, sessionId: 'sess-a', canSend: true, canCreateSession: true, canStop: true, running: true, placeholder: 'Message the Harness...', reason: null },
    settings: { available: true, model: 'deepseek-v4-flash', models: ['deepseek-v4-flash'], permissionMode: 'workspace-write', workspace: 'D:\\work', reason: null },
    diagnostics: { adapter: { contract: 1, model: 1 }, mode: { mode: 'daily', state: 'DAILY_ACTIVE' }, compatibility: null },
    ...overrides
  }
}

function loadNativeUi(snapshot = makeSnapshot(), { theme = null } = {}) {
  const dom = installDom()
  const calls = {
    snapshot: [],
    create: 0,
    select: [],
    send: [],
    cancel: [],
    modeSet: [],
    modeGet: 0,
    modeToggle: 0,
    themePaint: 0,
    reportFailure: [],
    reportRegions: [],
    settingsUpdate: [],
    pickWorkspace: 0
  }
  const listeners = { mode: null, session: null, theme: null, probe: null }
  const errors = []
  const originalError = console.error
  console.error = (...args) => errors.push(args.map((arg) => String(arg?.message || arg)).join(' '))

  global.window.hnsNative = {
    mode: {
      get: async () => { calls.modeGet += 1; return { mode: 'daily', state: 'DAILY_ACTIVE', degraded: { active: false, reason: null, at: null } } },
      set: async (mode) => { calls.modeSet.push(mode); return { ok: true, mode } },
      toggle: async () => { calls.modeToggle += 1; return { ok: true, mode: 'work' } },
      onChange: (callback) => { listeners.mode = callback }
    },
    session: {
      snapshot: async (sessionId) => { calls.snapshot.push(sessionId || null); return snapshot },
      create: async () => { calls.create += 1; return { ok: true, sessionId: 'created' } },
      select: async (sessionId) => { calls.select.push(sessionId); return { ok: true } },
      send: async (sessionId, prompt) => { calls.send.push({ sessionId, prompt }); return { ok: true, accepted: true } },
      cancel: async (sessionId) => { calls.cancel.push(sessionId); return { ok: true } },
      onChange: (callback) => { listeners.session = callback },
      reportFailure: (reason) => { calls.reportFailure.push(reason); return { ok: true } }
    },
    theme: {
      paint: async () => { calls.themePaint += 1; return theme ? { ok: true, payload: theme } : { ok: false, reason: 'no theme' } },
      onApply: (callback) => { listeners.theme = callback },
      reportRegions: (payload) => { calls.reportRegions.push(payload) },
      onProbeRegions: (callback) => { listeners.probe = callback }
    },
    diagnostics: { describe: async () => ({ adapter: { model: 1, contract: 1 }, compatibility: null }) },
    settings: {
      update: async (patch) => { calls.settingsUpdate.push(patch); return { ok: true } },
      pickWorkspace: async () => { calls.pickWorkspace += 1; return { ok: true, workspace: 'D:\\picked' } }
    }
  }

  for (const file of [
    'state/store.js',
    'components/dom.js',
    'components/topbar.js',
    'components/session-list.js',
    'components/conversation.js',
    'components/tool-activity.js',
    'components/context-panel.js',
    'components/composer.js',
    'components/settings.js',
    'app.js'
  ]) {
    const target = path.join(NATIVE, file)
    delete require.cache[require.resolve(target)]
    require(target)
  }
  console.error = originalError
  return { dom, calls, listeners, errors }
}

const settle = async () => {
  for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setImmediate(resolve))
}

test('the native frontend renders a full snapshot without reporting a failure', async () => {
  const { dom, calls, errors } = loadNativeUi()
  await settle()

  assert.deepEqual(errors, [], `the renderer must not throw: ${errors.join(' | ')}`)
  assert.deepEqual(calls.reportFailure, [], 'a healthy render must never report a native failure')
  assert.ok(calls.snapshot.length >= 1, 'the renderer asked for a snapshot')

  const list = dom.element('sessionList').innerHTML
  assert.match(list, /Fix the parser/)
  assert.match(list, /Older work/)
  assert.match(list, /data-session="sess-a"/)
  assert.match(list, /class="session-row active"/, 'the active session is marked')

  const timeline = dom.element('timeline').innerHTML
  assert.match(timeline, /hello/)
  assert.match(timeline, /done/)
  assert.match(timeline, /read_file/, 'the tool call attached to the message is rendered')

  const activity = dom.element('toolActivity').innerHTML
  assert.match(activity, /file body/)
  assert.match(activity, /queued task/)

  // Top bar (Daily refactor 任务 3): the working context, and nothing from Mega.
  assert.match(dom.element('workspaceChip').textContent, /workspace: work$/)
  assert.equal(dom.element('modelSelect').value, 'deepseek-v4-flash')
  assert.equal(dom.element('permissionChip').textContent, 'permission: workspace-write')
  assert.match(dom.element('taskChip').textContent, /tasks: \d+ running/)
  assert.match(dom.element('backendChip').textContent, /backend: ready/)

  assert.equal(dom.element('composerInput').disabled, false)
  assert.equal(dom.element('composerSend').disabled, true, 'an empty composer cannot be sent')
  dom.element('composerInput').value = 'a message'
  dom.element('composerInput').fire('input')
  assert.equal(dom.element('composerSend').disabled, false, 'send becomes available once there is text')
  assert.equal(dom.element('composerStop').hidden, false, 'stop appears while the harness is running')
  assert.match(dom.element('sessionTitle').textContent, /Fix the parser/)
  assert.equal(dom.element('modeChip').textContent, 'Daily')
  assert.equal(dom.element('banner').hidden, true, 'an inactive degradation is not a degradation')
  assert.equal(dom.element('settingsPage').hidden, true, 'Daily opens on the workspace, not on Settings')
})

test('an unready backend disables the composer and explains why', async () => {
  const { dom, calls } = loadNativeUi(makeSnapshot({
    ok: false,
    backend: { state: 'unreachable', healthy: false, reason: 'connection refused', version: null, origin: null },
    composer: { ready: false, sessionId: null, canSend: false, canCreateSession: false, canStop: false, running: false, placeholder: 'Message the Harness...', reason: 'connection refused' }
  }))
  await settle()
  assert.equal(dom.element('composerInput').disabled, true)
  assert.equal(dom.element('composerSend').disabled, true)
  assert.equal(dom.element('composerStop').hidden, true)
  assert.match(dom.element('composerHint').textContent, /connection refused/)
  assert.match(dom.element('banner').textContent, /connection refused/)
  assert.deepEqual(calls.reportFailure, [], 'a degraded backend is data, not a renderer failure')
})

test('selecting a session, sending and stopping go through the bridge', async () => {
  const { dom, calls } = loadNativeUi()
  await settle()

  const row = dom.element('sessionList')
  row.dataset.session = 'sess-b'
  dom.element('sessionList').fire('click', { target: row })
  await settle()
  assert.deepEqual(calls.select, ['sess-b'])

  dom.element('composerInput').value = '  do the thing  '
  dom.element('composerInput').fire('input')
  await settle()
  dom.element('composer').fire('submit', { preventDefault() {} })
  await settle()
  assert.deepEqual(calls.send, [{ sessionId: 'sess-a', prompt: 'do the thing' }])
  assert.equal(dom.element('composerInput').value, '', 'the composer clears after sending')

  dom.element('composerStop').fire('click')
  await settle()
  assert.deepEqual(calls.cancel, ['sess-a'])
})

test('the native mode toggle and the settings page are wired to the shell', async () => {
  const { dom, calls } = loadNativeUi()
  await settle()
  dom.element('toggleMode').fire('click')
  await settle()
  assert.equal(calls.modeToggle, 1)

  dom.element('openSettings').fire('click')
  await settle()
  assert.equal(dom.element('settingsPage').hidden, false)
  assert.equal(dom.body.dataset.view, 'settings')
  assert.match(dom.element('settingsBody').innerHTML, /deepseek-v4-flash/)
  assert.match(dom.element('settingsBody').innerHTML, /workspace-write/)
  dom.element('closeSettings').fire('click')
  await settle()
  assert.equal(dom.element('settingsPage').hidden, true)
  assert.equal(dom.body.dataset.view, 'workspace')
})

test('the Context Panel switches tabs and keeps the workspace intact', async () => {
  const { dom } = loadNativeUi()
  await settle()
  // Tasks is the live tab: it renders the same activity the dock used to own.
  assert.match(dom.element('toolActivity').innerHTML, /read_file/)
  assert.equal(dom.element('contextHint').textContent, 'Tasks')

  const gitTab = dom.contextTabs.find((tab) => tab.dataset.contextTab === 'git')
  gitTab.fire('click')
  await settle()
  assert.equal(dom.element('contextHint').textContent, 'Git')
  assert.match(dom.element('contextBody').innerHTML, /Git/)
  assert.match(dom.element('contextBody').innerHTML, /Daily 重构 §7 任务 13/, 'an unimplemented tab says which stage fills it')
  assert.equal(gitTab.classList.contains('active'), true)
  assert.equal(dom.contextTabs.find((tab) => tab.dataset.contextTab === 'tasks').classList.contains('active'), false)

  const contextTab = dom.contextTabs.find((tab) => tab.dataset.contextTab === 'context')
  contextTab.fire('click')
  await settle()
  assert.match(dom.element('contextBody').innerHTML, /deepseek-v4-flash/)
  assert.match(dom.element('contextBody').innerHTML, /ready/)
})

test('the top bar changes the model and the workspace through the bridge', async () => {
  const { dom, calls } = loadNativeUi()
  await settle()
  dom.element('modelSelect').value = 'deepseek-v4-pro'
  dom.element('modelSelect').fire('change', { target: { value: 'deepseek-v4-pro' } })
  await settle()
  assert.deepEqual(calls.settingsUpdate, [{ model: 'deepseek-v4-pro' }])

  dom.element('workspaceChip').fire('click')
  await settle()
  assert.equal(calls.pickWorkspace, 1)

  // The task chip jumps to the tab that shows them rather than opening a dialog.
  dom.element('taskChip').fire('click')
  await settle()
  assert.equal(dom.element('contextHint').textContent, 'Tasks')
})

test('a theme payload lands as CSS variables and asset layers, never as markup', async () => {
  const theme = {
    id: 'hns.demo.anime-persona',
    css: '--hns-color-bg-base: #101724;\n--hns-color-label-primary: #eef2f8;',
    slots: {
      'hns.window.background': { asset: 'data:image/png;base64,AAAA', opacity: 0.6 },
      'hns.character.primary': { asset: 'data:image/png;base64,BBBB', opacity: 0.85 },
      'hns.persona.decoration': { asset: 'none', opacity: 0 },
      'common.button.primary': { background: '#4d93f8', label: '#0d1016' }
    },
    persona: { enabled: true, avatarAsset: 'data:image/png;base64,CCCC' },
    effectLevel: 0
  }
  const { dom, listeners } = loadNativeUi(makeSnapshot(), { theme })
  await settle()
  listeners.theme(theme)

  const html = dom.documentElement.style.values
  assert.equal(html.get('--hns-slot-common-button-primary-background'), '#4d93f8')
  assert.equal(html.get('--hns-native-character'), 'url("data:image/png;base64,BBBB")')
  assert.equal(html.get('--hns-native-background'), 'url("data:image/png;base64,AAAA")')
  assert.equal(html.get('--hns-native-character-opacity'), '0.85')
  // No asset on the slot: the property is *removed* so the stylesheet's
  // `var(--hns-asset-decoration, none)` fallback can supply the theme token.
  assert.equal(html.has('--hns-native-decoration'), false)
  assert.equal(dom.body.dataset.themeId, 'hns.demo.anime-persona')
  assert.equal(dom.body.classList.contains('theme-persona'), true)
  assert.equal(dom.element('timeline').innerHTML.includes('data:image/png'), false, 'a theme never becomes markup')
})

test('a pushed snapshot is adopted in place, without waiting for a poll', async () => {
  const { dom, listeners } = loadNativeUi()
  await settle()
  // The store's render pass is scheduled, so the stub's synchronous
  // requestAnimationFrame makes adoption observable immediately.
  listeners.session(makeSnapshot({
    session: { id: 'sess-a', title: 'Pushed session', status: 'IDLE', running: false },
    composer: { ready: true, sessionId: 'sess-a', canSend: true, canCreateSession: true, canStop: false, running: false, placeholder: 'Message the Harness...', reason: null }
  }))
  assert.match(dom.element('sessionTitle').textContent, /Pushed session/)
  assert.equal(dom.element('composerStop').hidden, true, 'a non-running pushed session hides Stop')
})

test('a mode change carries the degradation, and an inactive one never does', async () => {
  const { dom, listeners } = loadNativeUi()
  await settle()
  assert.equal(dom.element('banner').hidden, true, 'a healthy start shows no banner')

  listeners.mode({ mode: 'work', state: 'DAILY_DEGRADED', degraded: { active: true, reason: 'renderer crashed', at: 'now' } })
  assert.match(dom.element('banner').textContent, /renderer crashed/)
  assert.equal(dom.element('modeChip').textContent, 'Work')
  assert.equal(dom.body.dataset.mode, 'work')

  listeners.mode({ mode: 'daily', state: 'DAILY_ACTIVE', degraded: { active: false, reason: null, at: null } })
  assert.equal(dom.element('banner').hidden, true, 'recovering clears the banner')
  assert.equal(dom.element('modeChip').textContent, 'Daily')
})

test('both side modules collapse and remember the choice', async () => {
  const { dom } = loadNativeUi()
  await settle()
  assert.equal(dom.element('sidebar').dataset.collapsed, '')
  assert.equal(dom.element('contextPanel').dataset.collapsed, '')

  dom.element('collapseSessions').fire('click', { stopPropagation() {} })
  assert.equal(dom.element('sidebar').dataset.collapsed, '1')
  assert.equal(dom.element('collapseSessions').textContent, '▸')
  assert.equal(dom.element('collapseSessions').getAttribute('aria-expanded'), 'false')
  assert.equal(dom.element('contextPanel').dataset.collapsed, '', 'the other module is untouched')

  dom.element('collapseContext').fire('click', { stopPropagation() {} })
  assert.equal(dom.element('contextPanel').dataset.collapsed, '1')

  dom.element('collapseSessions').fire('click', { stopPropagation() {} })
  assert.equal(dom.element('sidebar').dataset.collapsed, '', 'clicking again expands it')
  assert.equal(dom.element('collapseSessions').textContent, '▾')
})
