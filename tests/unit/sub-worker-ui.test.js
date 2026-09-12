'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

/**
 * Mega UI contract for the optional Sub-worker (plan §11, §12, §14; AC-03, AC-04,
 * AC-05, AC-06).
 *
 * The renderer is executed against a DOM stub so the real bindings are
 * exercised, exactly like the existing Mega dock render tests.
 */

const ROOT = path.resolve(__dirname, '..', '..')
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8')
const dockHtml = read('app/extensions/mega/ui/dock.html')
const dockJs = read('app/extensions/mega/ui/dock.js')
const dockCss = read('app/extensions/mega/ui/dock.css')
const preload = read('app/extensions/mega/ui/preload.cjs')

function makeElement(id) {
  const classes = new Set()
  const handlers = new Map()
  const attributes = new Map()
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
    addEventListener(name, handler) {
      if (!handlers.has(name)) handlers.set(name, [])
      handlers.get(name).push(handler)
    },
    fire(name, event = {}) {
      for (const handler of handlers.get(name) || []) handler(event)
    },
    setAttribute: (name, value) => attributes.set(name, value),
    getAttribute: (name) => attributes.get(name),
    closest: () => null,
    querySelector: () => null
  }
}

function installDom() {
  const elements = new Map()
  const documentHandlers = new Map()
  elements.set('settingsOverlay', Object.assign(makeElement('settingsOverlay'), { hidden: true }))
  elements.set('liveView', Object.assign(makeElement('liveView'), { hidden: true }))

  class FakeIntersectionObserver {
    constructor(callback) { this.callback = callback }
    observe() {}
    disconnect() {}
  }

  global.document = {
    body: makeElement('body'),
    getElementById: (id) => {
      if (!elements.has(id)) elements.set(id, makeElement(id))
      return elements.get(id)
    },
    querySelector: () => null,
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
    element: (id) => document.getElementById(id),
    fireDocument: (name, event) => document.fire(name, event)
  }
}

function subWorkerSnapshot(overrides = {}) {
  return {
    feature: 'optional-sub-worker',
    available: true,
    enabled: true,
    state: 'RUNNING',
    stage: 'IMPLEMENTING',
    worker_id: 'sub-1',
    pid: 4242,
    mode: 'Executor',
    role: 'executor-not-controller',
    task: { task_id: 'boss-kb-031', objective: 'Implement SQLite adapter', stage: 'IMPLEMENTING' },
    task_id: 'boss-kb-031',
    objective: 'Implement SQLite adapter',
    queue: [{ task_id: 'boss-kb-032', objective: 'Add tests', risk_level: 'L2', target_repo: 'D:\\Boss' }],
    queue_length: 1,
    history: [{ task_id: 'boss-kb-030', status: 'completed', summary: 'done', code: 'OK' }],
    counts: { completed: 1 },
    capabilities: { code: true, shell: true, git: true, browser: false, vision: false },
    max_workers: 1,
    restarts: 0,
    crashes: 0,
    last_heartbeat_at: Date.now(),
    workspace_lock: { workspace: 'D:\\Boss-worktrees\\hns-sub-worker' },
    pending_notes: [],
    notifications: [],
    config: {
      enabledOnStartup: false,
      autoDelegate: false,
      workspaceMode: 'isolated_worktree',
      maxWorkers: 1,
      keepChangesOnStop: true,
      allowGitCommit: false,
      showNotifications: true
    },
    live: {
      task_id: 'boss-kb-031',
      objective: 'Implement SQLite adapter',
      status: 'RUNNING',
      stage: 'IMPLEMENTING',
      started_at: new Date().toISOString(),
      workspace: 'D:\\Boss-worktrees\\hns-sub-worker',
      summary: [
        { icon: '✓', text: 'Inspected existing store API', type: 'inspection_started', at: new Date().toISOString() },
        { icon: '✓', text: 'Created src/knowledge/sqlite.ts', type: 'file_write', at: new Date().toISOString() },
        { icon: '→', text: 'Running npm test -- sqlite', type: 'command_started', at: new Date().toISOString() }
      ],
      changed_files: [
        { path: 'src/knowledge/sqlite.ts', status: 'M' },
        { path: 'tests/knowledge/sqlite.test.ts', status: 'A' }
      ],
      terminal: [
        { kind: 'command', text: 'npm test -- sqlite' },
        { kind: 'output', text: '41 passed / 2 failed' },
        { kind: 'exit', text: 'npm test -- sqlite -> exit 1' }
      ],
      tests: { passed: 41, failed: 2, skipped: 1, parser: 'jest-style' },
      test_runs: [{ command: 'npm test -- sqlite', passed: 41, failed: 2 }],
      commands: [{ command: 'npm test -- sqlite', exitCode: 1 }],
      warnings: ['Detected a failing rollback test'],
      errors: [],
      git: { dirty: true, branch: 'hns-sub-worker', commit: 'abc' },
      acceptance: [{ criterion: 'acceptance command: npm test', status: 'failed', verified: true }],
      result: {
        task_id: 'boss-kb-031',
        status: 'completed',
        code: 'OK',
        summary: 'SQLite adapter implemented and validated.',
        changed_files: ['src/knowledge/sqlite.ts'],
        tests: { passed: 43, failed: 0, skipped: 1 },
        needs_controller_review: true,
        acceptance: [{ criterion: 'acceptance command: npm test', status: 'passed', verified: true }]
      },
      log_file: 'D:\\DS-Hns\\logs\\sub-worker\\boss-kb-031.log'
    },
    events: [
      { type: 'task_received', summary: 'Task received: Implement SQLite adapter', timestamp: new Date().toISOString() },
      { type: 'file_write', summary: 'Created src/knowledge/sqlite.ts', timestamp: new Date().toISOString() },
      { type: 'command_finished', summary: 'npm test -- sqlite exited 1', timestamp: new Date().toISOString() }
    ],
    paths: { tasks: 'data/sub-worker/tasks', task_logs: 'logs/sub-worker' },
    ...overrides
  }
}

function megaSnapshot(subWorker) {
  return {
    extension: { dock: { expanded: true, width: 560 } },
    scheduler: {
      counts: { RUNNING: 0, PENDING: 0 },
      concurrency: { current: 0, hardwareCap: 4, byCpuLoad: 4 },
      peak: { peak: false, nextChange: null },
      config: {},
      system: {},
      hardware: {}
    },
    tasks: [],
    history: [],
    settings: {
      defaultModel: 'deepseek-v4-flash',
      models: ['deepseek-v4-flash'],
      permissionMode: 'workspace-write',
      telemetryMode: 'DISABLED',
      sound: { enabled: true, volume: 0.8, events: {} },
      notifications: { enabled: true, onCancelled: false, supported: true }
    },
    workspace: 'C:\\work',
    soundFiles: [],
    balance: { refreshing: false, ok: true, hasData: false, providers: [], failedProviders: [] },
    ...(subWorker ? { subWorker } : {})
  }
}

function loadDock(snapshot) {
  const dom = installDom()
  const calls = {
    start: 0, stop: 0, restart: 0, pause: 0, resume: 0, cancelTask: 0,
    takeOver: 0, sendNote: [], assignTask: [], liveView: [], readLog: [], updateConfig: []
  }
  let openLiveViewHandler = null
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
    updateSettings: async () => ({}),
    fetchBalance: async () => snapshot.balance,
    pickWorkspace: async () => null,
    pickSound: async () => null,
    toggleDock: async () => ({}),
    setDockExpanded: async () => ({}),
    hideDock: async () => {},
    onChanged: (handler) => { changedHandler = handler }
  }
  global.window.megaSubWorker = {
    snapshot: async () => snapshot.subWorker || null,
    start: async () => { calls.start += 1; return { ok: true } },
    stop: async () => { calls.stop += 1; return { ok: true } },
    restart: async () => { calls.restart += 1; return { ok: true } },
    pause: async () => { calls.pause += 1; return { ok: true } },
    resume: async () => { calls.resume += 1; return { ok: true } },
    cancelTask: async () => { calls.cancelTask += 1; return { ok: true } },
    takeOver: async () => { calls.takeOver += 1; return { ok: true, state: 'HANDOFF' } },
    sendNote: async (note) => { calls.sendNote.push(note); return { ok: true, delivered: true } },
    assignTask: async (task) => { calls.assignTask.push(task); return { ok: true, accepted: true, task_id: task.task_id, queue_length: 0 } },
    liveView: async (taskId) => { calls.liveView.push(taskId); return snapshot.subWorker?.live || null },
    readLog: async (taskId) => { calls.readLog.push(taskId); return { ok: true, file: `logs/sub-worker/${taskId}.log` } },
    updateConfig: async (patch) => { calls.updateConfig.push(patch); return patch },
    clearHandoff: async () => ({ ok: true }),
    resumeLast: async () => ({ ok: true }),
    pickTargetRepo: async () => 'D:\\Picked',
    onOpenLiveView: (handler) => { openLiveViewHandler = handler }
  }

  for (const file of ['../../app/extensions/mega/ui/dock.js', '../../app/extensions/mega/ui/balance-module.js']) {
    delete require.cache[require.resolve(file)]
  }
  require('../../app/extensions/mega/ui/balance-module.js')
  require('../../app/extensions/mega/ui/dock.js')

  return {
    dom,
    calls,
    notifyChanged: () => changedHandler && changedHandler(),
    fireOpenLiveView: () => openLiveViewHandler && openLiveViewHandler()
  }
}

const settle = async () => {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

test('the Sub-worker panel exists in the dock with every documented control', () => {
  for (const id of [
    'swState', 'swSummary', 'swEnable', 'swStart', 'swStop', 'swRestart', 'swPause', 'swResume',
    'swCancel', 'swTakeOver', 'swLive', 'swQueue', 'swHistory', 'swDispatchBox', 'swTaskForm',
    'swObjective', 'swTargetRepo', 'swRisk', 'swWorkspaceMode', 'swOperations', 'swResumeLast'
  ]) {
    assert.match(dockHtml, new RegExp(`id="${id}"`), `${id} must be part of the Sub-worker panel`)
  }
  // The rail shows the worker at a glance without opening the panel.
  assert.match(dockHtml, /id="railSubWorker"/)
  // Settings for the optional layer live in the settings overlay.
  assert.match(dockHtml, /id="subWorkerForm"/)
  for (const id of ['swEnabledOnStartup', 'swAutoDelegate', 'swCfgWorkspaceMode', 'swKeepChanges', 'swAllowCommit', 'swShowNotifications']) {
    assert.match(dockHtml, new RegExp(`id="${id}"`))
  }
})

test('the Live View has every documented section and no reasoning panel', () => {
  for (const id of ['liveView', 'lvState', 'lvTask', 'lvStatus', 'lvSummary', 'lvFiles', 'lvTests', 'lvTerminal', 'lvIssues', 'lvResult', 'lvEvents', 'lvHistory', 'lvNote', 'lvPause', 'lvResume', 'lvCancel', 'lvStop', 'lvRestart', 'lvTakeOver', 'lvLog']) {
    assert.match(dockHtml, new RegExp(`id="${id}"`), `${id} must exist in the Live View`)
  }
  for (const heading of ['Task', 'Status', 'Execution Summary', 'Changed Files', 'Tests', 'Terminal', 'Warnings / Errors', 'Result', 'Events', 'Task History']) {
    assert.ok(dockHtml.includes(heading), `the Live View must label its ${heading} section`)
  }
  // §14: the Live View shows an auditable summary, never hidden reasoning.
  assert.match(dockHtml, /不显示模型隐藏推理/)
  for (const forbidden of ['chain-of-thought', 'scratchpad', 'hidden reasoning', '内部推理']) {
    assert.equal(dockHtml.toLowerCase().includes(forbidden.toLowerCase()), false, `the UI must not offer ${forbidden}`)
  }
  // The Live View is an in-dock overlay: no second window may be created.
  assert.equal(/new BrowserWindow/.test(dockJs), false)
  assert.match(dockCss, /\.live-view-overlay/)
})

test('the preload bridge exposes exactly the Sub-worker channels the shell registers', () => {
  const channels = [
    'sub-worker:snapshot', 'sub-worker:start', 'sub-worker:stop', 'sub-worker:restart', 'sub-worker:pause',
    'sub-worker:resume', 'sub-worker:cancel-task', 'sub-worker:assign-task', 'sub-worker:send-note',
    'sub-worker:take-over', 'sub-worker:clear-handoff', 'sub-worker:resume-last', 'sub-worker:update-config',
    'sub-worker:live-view', 'sub-worker:read-log', 'sub-worker:pick-target-repo', 'sub-worker:release-worktree',
    // Adaptive multi-worker surface (Update-Plan/multi-sub.md).
    'sub-worker:submit-plan', 'sub-worker:resource-config', 'sub-worker:tick', 'sub-worker:plans'
  ]
  for (const channel of channels) {
    assert.ok(preload.includes(`'${channel}'`), `the preload must expose ${channel}`)
  }
  assert.match(preload, /exposeInMainWorld\('megaSubWorker'/)
  assert.match(preload, /onOpenLiveView/)
  assert.match(preload, /releaseWorktree/)
  // The shell side registers the same set, exactly.
  const main = read('app/desktop-main.cjs')
  for (const channel of channels) {
    assert.ok(main.includes(`'${channel}'`), `the shell must register ${channel}`)
  }
  const registered = main.slice(main.indexOf('const SUB_WORKER_CHANNELS'), main.indexOf('/**', main.indexOf('const SUB_WORKER_CHANNELS')))
  const found = [...registered.matchAll(/'([^']+)'/g)].map((match) => match[1])
  assert.equal(found.length, channels.length, `the shell must register exactly ${channels.length} channels, found ${found.length}`)
})

test('the panel renders live worker state, queue and history', async () => {
  const h = loadDock(megaSnapshot(subWorkerSnapshot()))
  await settle()

  assert.equal(h.dom.element('swState').textContent, 'RUNNING')
  assert.equal(h.dom.element('railSubWorker').textContent, 'BUSY')
  assert.match(h.dom.element('swSummary').innerHTML, /sub-1/)
  assert.match(h.dom.element('swSummary').innerHTML, /Executor/)
  assert.match(h.dom.element('swSummary').innerHTML, /boss-kb-031/)
  assert.match(h.dom.element('swQueue').innerHTML, /Add tests/)
  assert.match(h.dom.element('swHistory').innerHTML, /boss-kb-030/)
  assert.equal(h.dom.element('swEnable').hidden, true, 'Enable is replaced by Stop/Restart once running')
  assert.equal(h.dom.element('swStop').disabled, false)
  assert.equal(h.dom.element('swPause').disabled, false)
  assert.equal(h.dom.element('swResume').disabled, true, 'Resume only applies while paused')
  assert.equal(h.dom.element('swCancel').disabled, false)
  assert.equal(h.dom.element('error').textContent, '')
})

test('an unavailable or disabled worker degrades gracefully', async () => {
  const unavailable = loadDock(megaSnapshot({ feature: 'optional-sub-worker', available: false, enabled: false, state: 'OFF', reason: 'no manager' }))
  await settle()
  assert.equal(unavailable.dom.element('swState').textContent, 'UNAVAILABLE')
  assert.equal(unavailable.dom.element('swEnable').disabled, true)
  assert.equal(unavailable.dom.element('error').textContent, '')
  assert.match(unavailable.dom.element('swSummary').innerHTML, /no manager/)

  const off = loadDock(megaSnapshot({ feature: 'optional-sub-worker', available: true, enabled: false, state: 'OFF', queue: [], history: [], events: [], live: null }))
  await settle()
  assert.equal(off.dom.element('swState').textContent, 'OFF')
  assert.equal(off.dom.element('railSubWorker').textContent, 'OFF')
  assert.equal(off.dom.element('swEnable').hidden, false)
  assert.match(off.dom.element('swEnable').textContent, /Enable Sub-worker/)
  assert.equal(off.dom.element('swStop').disabled, true)

  // A backend that predates the feature must not break the dock at all.
  const legacy = loadDock(megaSnapshot(null))
  await settle()
  assert.equal(legacy.dom.element('error').textContent, '')
})

test('every control routes to the shell-owned worker manager', async () => {
  const h = loadDock(megaSnapshot(subWorkerSnapshot()))
  await settle()

  await h.dom.element('swStop').onclick()
  await h.dom.element('swRestart').onclick()
  await h.dom.element('swPause').onclick()
  await h.dom.element('swTakeOver').onclick()
  await h.dom.element('swCancel').onclick()
  await settle()
  assert.equal(h.calls.stop, 1)
  assert.equal(h.calls.restart, 1)
  assert.equal(h.calls.pause, 1)
  assert.equal(h.calls.takeOver, 1)
  assert.equal(h.calls.cancelTask, 1)

  // Enable starts the worker when it is off.
  const off = loadDock(megaSnapshot({ feature: 'optional-sub-worker', available: true, enabled: false, state: 'OFF', queue: [], history: [], events: [], live: null }))
  await settle()
  await off.dom.element('swEnable').onclick()
  await settle()
  assert.equal(off.calls.start, 1)
})

test('the Live View opens inside the dock from the panel and from the tray event', async () => {
  const h = loadDock(megaSnapshot(subWorkerSnapshot()))
  await settle()
  assert.equal(h.dom.element('liveView').hidden, true, 'the Live View starts closed')

  await h.dom.element('swLive').onclick()
  await settle()
  assert.equal(h.dom.element('liveView').hidden, false)
  assert.equal(h.calls.liveView.length >= 1, true)

  // A tray "Open Live View" reaches the same pane - never a new window.
  h.dom.element('lvClose').onclick()
  assert.equal(h.dom.element('liveView').hidden, true)
  h.fireOpenLiveView()
  await settle()
  assert.equal(h.dom.element('liveView').hidden, false)
})

test('the Live View renders task, status, summary, files, tests, terminal, result and events', async () => {
  const h = loadDock(megaSnapshot(subWorkerSnapshot()))
  await settle()
  await h.dom.element('swLive').onclick()
  await settle()

  assert.match(h.dom.element('lvTask').innerHTML, /boss-kb-031/)
  assert.match(h.dom.element('lvTask').innerHTML, /Implement SQLite adapter/)
  assert.match(h.dom.element('lvStatus').innerHTML, /IMPLEMENTING/)
  assert.match(h.dom.element('lvSummary').innerHTML, /Inspected existing store API/)
  assert.match(h.dom.element('lvSummary').innerHTML, /Created src\/knowledge\/sqlite\.ts/)
  assert.match(h.dom.element('lvFiles').innerHTML, /src\/knowledge\/sqlite\.ts/)
  assert.match(h.dom.element('lvTests').innerHTML, /41/)
  assert.match(h.dom.element('lvTests').innerHTML, /jest-style/)
  assert.match(h.dom.element('lvTerminal').textContent, /41 passed \/ 2 failed/)
  assert.match(h.dom.element('lvIssues').innerHTML, /Detected a failing rollback test/)
  assert.match(h.dom.element('lvEvents').innerHTML, /task_received/)
  assert.match(h.dom.element('lvHistory').innerHTML, /boss-kb-030/)
  // The Result section renders the finished Result Object (AC-05).
  assert.match(h.dom.element('lvResult').innerHTML, /completed/)
  assert.match(h.dom.element('lvResult').innerHTML, /SQLite adapter implemented and validated\./)
  assert.match(h.dom.element('lvResult').innerHTML, /acceptance command: npm test/)
  // §14 again: nothing resembling raw model reasoning may be rendered.
  const rendered = [
    h.dom.element('lvSummary').innerHTML,
    h.dom.element('lvEvents').innerHTML,
    h.dom.element('lvTask').innerHTML,
    h.dom.element('lvResult').innerHTML
  ].join(' ')
  for (const forbidden of ['chain-of-thought', 'scratchpad', 'hidden reasoning', 'thought:']) {
    assert.equal(rendered.toLowerCase().includes(forbidden), false)
  }
})

test('a finished task without a result yet still renders the pane honestly', async () => {
  const live = subWorkerSnapshot().live
  delete live.result
  const h = loadDock(megaSnapshot(subWorkerSnapshot({ live })))
  await settle()
  await h.dom.element('swLive').onclick()
  await settle()
  assert.match(h.dom.element('lvResult').innerHTML, /尚未结束/)
})

test('Send Note from the Live View goes through the controller_note_queue', async () => {
  const h = loadDock(megaSnapshot(subWorkerSnapshot()))
  await settle()
  await h.dom.element('swLive').onclick()
  await settle()

  h.dom.element('lvNote').value = 'Do not modify IPC. Only fix storage implementation.'
  await h.dom.element('lvNoteForm').onsubmit({ preventDefault() {} })
  await settle()
  assert.deepEqual(h.calls.sendNote, [{ note: 'Do not modify IPC. Only fix storage implementation.' }])
  assert.equal(h.dom.element('lvNote').value, '', 'the note field is cleared')
  assert.match(h.dom.element('lvNotice').textContent, /controller_note_queue|已送达/)

  h.dom.element('lvNote').value = ''
  await h.dom.element('lvNoteForm').onsubmit({ preventDefault() {} })
  await settle()
  assert.equal(h.calls.sendNote.length, 1, 'an empty note is not sent')
})

test('dispatching from the panel requires an executable specification', async () => {
  const h = loadDock(megaSnapshot(subWorkerSnapshot()))
  await settle()

  h.dom.element('swObjective').value = 'Implement the adapter'
  h.dom.element('swTargetRepo').value = 'D:\\Boss'
  h.dom.element('swOperations').value = ''
  await h.dom.element('swTaskForm').onsubmit({ preventDefault() {} })
  await settle()
  assert.equal(h.calls.assignTask.length, 0, 'a task without operations is never dispatched')
  assert.match(h.dom.element('swDispatchStatus').textContent, /operations/)

  h.dom.element('swOperations').value = 'not json'
  await h.dom.element('swTaskForm').onsubmit({ preventDefault() {} })
  await settle()
  assert.equal(h.calls.assignTask.length, 0)
  assert.match(h.dom.element('swDispatchStatus').textContent, /JSON/)

  h.dom.element('swOperations').value = JSON.stringify([{ op: 'run_tests', command: 'npm test' }])
  h.dom.element('swAllowed').value = 'src/**\ntests/**'
  h.dom.element('swForbidden').value = 'src/ipc/**'
  h.dom.element('swAcceptance').value = 'All existing tests pass'
  // A browser reflects the rendered <option selected> / checked attributes into
  // .value / .checked.
  h.dom.element('swRisk').value = 'L2'
  h.dom.element('swWorkspaceMode').value = 'isolated_worktree'
  h.dom.element('swPermWrite').checked = true
  h.dom.element('swPermShell').checked = true
  await h.dom.element('swTaskForm').onsubmit({ preventDefault() {} })
  await settle()
  assert.equal(h.calls.assignTask.length, 1)
  const task = h.calls.assignTask[0]
  assert.equal(task.objective, 'Implement the adapter')
  assert.equal(task.target_repo, 'D:\\Boss')
  assert.equal(task.risk_level, 'L2')
  assert.deepEqual(task.allowed_paths, ['src/**', 'tests/**'])
  assert.deepEqual(task.forbidden_paths, ['src/ipc/**'])
  assert.deepEqual(task.acceptance, ['All existing tests pass'])
  assert.deepEqual(task.operations, [{ op: 'run_tests', command: 'npm test' }])
  assert.equal(task.permissions.write, true)
  assert.equal(task.version, 1)
  assert.match(h.dom.element('swDispatchStatus').textContent, /已受理/)
})

test('the settings layer saves the documented Sub-worker configuration', async () => {
  const h = loadDock(megaSnapshot(subWorkerSnapshot()))
  await settle()
  h.dom.element('swEnabledOnStartup').checked = true
  h.dom.element('swAutoDelegate').checked = true
  h.dom.element('swCfgWorkspaceMode').value = 'shared'
  h.dom.element('swKeepChanges').checked = false
  h.dom.element('swAllowCommit').checked = true
  h.dom.element('swShowNotifications').checked = false

  await h.dom.element('subWorkerForm').onsubmit({ preventDefault() {} })
  await settle()
  assert.deepEqual(h.calls.updateConfig[0], {
    enabledOnStartup: true,
    autoDelegate: true,
    workspaceMode: 'shared',
    maxWorkers: 1,
    keepChangesOnStop: false,
    allowGitCommit: true,
    showNotifications: false
  })
  assert.match(h.dom.element('settingsStatus').textContent, /Sub-worker 已保存/)
})

test('a crash is surfaced with its last task and escape closes the Live View first', async () => {
  const crashed = subWorkerSnapshot({
    state: 'CRASHED',
    enabled: false,
    task: null,
    task_id: null,
    live: null,
    last_error: 'worker process exited unexpectedly (code 1)',
    history: [{ task_id: 'boss-kb-031', status: 'failed', summary: 'crashed', code: 'CRASHED' }]
  })
  const h = loadDock(megaSnapshot(crashed))
  await settle()
  assert.equal(h.dom.element('swCrash').hidden, false)
  assert.match(h.dom.element('swCrash').textContent, /Sub-worker crashed/)
  assert.match(h.dom.element('swCrash').textContent, /boss-kb-031/)

  await h.dom.element('swLive').onclick()
  await settle()
  assert.equal(h.dom.element('liveView').hidden, false)
  h.dom.fireDocument('keydown', { key: 'Escape' })
  assert.equal(h.dom.element('liveView').hidden, true)
  assert.equal(h.dom.element('settingsOverlay').hidden, true)
})

test('a HANDOFF state tells the Controller which workspace it received', async () => {
  const handoff = subWorkerSnapshot({
    state: 'HANDOFF',
    enabled: false,
    task: null,
    task_id: null,
    handoff: { workspace: 'D:\\Boss-worktrees\\hns-sub-worker', task_id: 'boss-kb-031' }
  })
  const h = loadDock(megaSnapshot(handoff))
  await settle()
  assert.equal(h.dom.element('swCrash').hidden, false)
  assert.match(h.dom.element('swCrash').textContent, /handed over/)
  assert.match(h.dom.element('swCrash').textContent, /Boss-worktrees/)
})
