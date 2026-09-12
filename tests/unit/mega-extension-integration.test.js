'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/**
 * Integration level: start the Mega extension against a stubbed Electron shell
 * and verify the refix收敛 behaviour end to end — single-window product surface,
 * exit-only tray, unified terminal alerts for all three task paths, and full
 * failure isolation.
 */

const SCRATCH = path.join(process.env.TEMP || os.tmpdir(), `dsh-mega-integration-${process.pid}`)
process.env.DSH_ROOT = SCRATCH
process.env.DSH_HOME = path.join(SCRATCH, 'data')
process.env.DSH_MEGA_OBSERVE_MS = '500'
fs.rmSync(SCRATCH, { recursive: true, force: true })
for (const dir of ['config', 'data/state', 'data/task-history', 'data/sessions/group-a', 'assets/sounds', 'logs']) {
  fs.mkdirSync(path.join(SCRATCH, dir), { recursive: true })
}
// A ringtone the sound service can resolve, so the ring path really runs.
fs.writeFileSync(path.join(SCRATCH, 'assets', 'sounds', 'completed.wav'), Buffer.alloc(24))

const notifications = []
let notificationFails = false
function FakeNotification(options) {
  if (notificationFails) throw new Error('notification subsystem offline')
  notifications.push(options)
  return { on() {}, show() {} }
}
FakeNotification.isSupported = () => true

const shell = {
  loadedFiles: [],
  windows: [],
  shutdownCalls: [],
  trayMenus: [],
  trayHandlers: {}
}

function fakeElectron(handlers) {
  class FakeBrowserWindow {
    constructor() {
      this.destroyed = false
      this.focused = false
      this.minimized = false
      shell.windows.push(this)
      this.webContents = {
        send: () => {},
        on: () => {},
        once: () => {},
        removeListener: () => {},
        isLoading: () => false
      }
    }
    isDestroyed() { return this.destroyed }
    isVisible() { return true }
    isMinimized() { return this.minimized }
    getBounds() { return { x: 0, y: 0, width: 1200, height: 900 } }
    getContentBounds() { return { x: 0, y: 0, width: 1200, height: 900 } }
    setBounds() {}
    setMenuBarVisibility() {}
    show() {}
    showInactive() {}
    hide() {}
    focus() { this.focused = true }
    restore() { this.minimized = false }
    destroy() { this.destroyed = true }
    loadFile(file) { shell.loadedFiles.push(String(file)); return Promise.resolve() }
    once() {}
    on() {}
    removeListener() {}
  }
  class FakeTray {
    constructor(image) { this.image = image }
    setToolTip() {}
    setContextMenu(menu) { shell.trayMenus.push(menu) }
    on(event, handler) { shell.trayHandlers[event] = handler }
    destroy() {}
  }
  return {
    app: { quit() {}, exit() {}, getPath: () => SCRATCH },
    BrowserWindow: FakeBrowserWindow,
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    shell: { openExternal() {} },
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler),
      removeHandler: (channel) => handlers.delete(channel),
      on() {},
      removeAllListeners() {}
    },
    Tray: FakeTray,
    Menu: { buildFromTemplate: (template) => template },
    nativeImage: { createFromPath: () => ({ isEmpty: () => false }) },
    screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
    Notification: FakeNotification
  }
}

function sessionFile(id) {
  return path.join(SCRATCH, 'data', 'sessions', 'group-a', id, 'session.jsonl')
}

function writeSession(id, events) {
  const file = sessionFile(id)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const lines = [
    { type: 'session', id, createdAt: Date.now() - 1000, cwd: 'C:\\user-workspace', version: 'test', delegationDepth: 0 },
    ...events
  ]
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n')
}

const USER_TURN = {
  type: 'user/message',
  seq: 1,
  time: Date.now() - 900,
  data: { source: { kind: 'user' }, message: { content: [{ type: 'text', text: 'summarize the repository' }] } }
}

async function waitFor(predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

function startExtension(context = {}) {
  const handlers = new Map()
  const mega = require('../../app/extensions/mega/index.cjs')
  const scheduler = require('../../app/extensions/mega/scheduler/scheduler')
  const electron = fakeElectron(handlers)
  // The shell's main window is the test harness's own; only windows created by
  // the extension during start() are counted as extra product windows.
  const mainWindow = new electron.BrowserWindow()
  shell.windows.length = 0
  shell.loadedFiles.length = 0
  shell.trayMenus.length = 0
  shell.shutdownCalls.length = 0
  return mega.start({
    root: SCRATCH,
    nodeExe: process.execPath,
    mainWindow,
    log: () => {},
    electron,
    shutdown: {
      graceful: (source) => shell.shutdownCalls.push(`graceful:${source}`),
      force: (source) => shell.shutdownCalls.push(`force:${source}`)
    },
    ...context
  }).then(() => ({ mega, scheduler, handlers, mainWindow }))
}

function trayItem(label) {
  return shell.trayMenus[0].find((item) => item && item.label === label)
}

test('the product is one window: the tray keeps its exit actions and adds Sub-worker controls, with no Mega management page', async (t) => {
  const { mega, handlers, mainWindow } = await startExtension()
  t.after(() => mega.stop())

  // Exactly one extension window (the dock); no tools page is loaded anywhere.
  assert.equal(shell.windows.length, 1, 'no secondary Mega window may be created')
  assert.deepEqual(shell.loadedFiles.map((file) => path.basename(file)), ['dock.html'])

  // Tray: double-click restores/focuses, and the menu carries Show/Mega, the
  // Sub-worker submenu (plan §16) and the two original exit actions.
  assert.ok(shell.trayHandlers['double-click'], 'double-click must be wired to focus the main window')
  mainWindow.minimized = true
  mainWindow.focused = false
  shell.trayHandlers['double-click']()
  assert.equal(mainWindow.minimized, false, 'a minimized window is restored')
  assert.equal(mainWindow.focused, true, 'the main window is brought to the front')
  assert.equal(shell.trayMenus.length, 1)
  const labels = shell.trayMenus[0].map((item) => item.label).filter(Boolean)
  assert.deepEqual(labels, ['Show', 'Mega', 'Sub-worker', 'Exit DS-Harness', 'Force Exit DS-Harness'])

  trayItem('Exit DS-Harness').click()
  trayItem('Force Exit DS-Harness').click()
  assert.deepEqual(shell.shutdownCalls, ['graceful:tray', 'force:tray'], 'exit actions route to the shell, which owns the managed harness')

  // The Sub-worker submenu is present and inert without a shell-owned manager:
  // nothing may spawn a worker process while the feature is off (AC-01/AC-02).
  const subWorkerItem = trayItem('Sub-worker')
  assert.ok(Array.isArray(subWorkerItem.submenu), 'the Sub-worker entry is a submenu')
  const subLabels = subWorkerItem.submenu.map((item) => item.label).filter(Boolean)
  assert.deepEqual(subLabels, [
    'Sub-worker: OFF', 'Task: Idle', 'Start', 'Stop', 'Restart', 'Pause', 'Resume',
    'Cancel Current Task', 'Open Live View', 'Take Over Workspace'
  ])
  assert.equal(subWorkerItem.submenu.find((item) => item.label === 'Start').enabled, false)
  assert.equal(subWorkerItem.submenu.find((item) => item.label === 'Stop').enabled, false)
  assert.doesNotThrow(() => subWorkerItem.submenu.find((item) => item.label === 'Start').click())

  // The IPC surface has no dead tools/main-window channels.
  assert.equal(handlers.has('mega:open-tools'), false)
  assert.equal(handlers.has('mega:open-main'), false)
  assert.equal(handlers.has('mega:widget-hide'), false)
  assert.equal(handlers.has('mega:dock-hide'), false)
  for (const channel of ['mega:snapshot', 'mega:update-settings', 'mega:update-scheduler', 'mega:pick-workspace', 'mega:pick-sound', 'mega:update-check', 'mega:update-apply']) {
    assert.equal(handlers.has(channel), true, `${channel} must stay available for the dock settings layer`)
  }

  // The snapshot carries no mirrored session history.
  const snapshot = await handlers.get('mega:snapshot')()
  assert.equal('sessions' in snapshot, false)
  assert.equal('history' in snapshot, true)
  assert.ok(snapshot.settings.models.length > 0, 'settings for the dock layer are exposed')
  assert.ok(Array.isArray(snapshot.soundFiles))
  // The 拓展状态 module reports the harness alignment state, read-only and
  // without ever reaching the network during a snapshot.
  assert.equal(snapshot.update.status, 'idle')
  assert.equal(snapshot.update.updateAvailable, false)
  assert.equal(snapshot.update.latestVersion, null)
})

test('the tray mirrors the shell-owned Sub-worker and routes its controls to it', async (t) => {
  const calls = []
  const manager = {
    describe: () => ({
      feature: 'optional-sub-worker',
      available: true,
      enabled: true,
      state: 'RUNNING',
      stage: 'IMPLEMENTING',
      worker_id: 'sub-1',
      task_id: 'boss-kb-031',
      task: { task_id: 'boss-kb-031', objective: 'Implement SQLite adapter', stage: 'IMPLEMENTING' },
      queue: [],
      history: [],
      events: [],
      live: null,
      config: { autoDelegate: false, workspaceMode: 'isolated_worktree' }
    }),
    start: async () => { calls.push('start'); return { ok: true } },
    stop: async () => { calls.push('stop'); return { ok: true } },
    restart: async () => { calls.push('restart'); return { ok: true } },
    pause: () => { calls.push('pause'); return { ok: true } },
    resume: () => { calls.push('resume'); return { ok: true } },
    cancelTask: () => { calls.push('cancelTask'); return { ok: true } },
    takeOver: async () => { calls.push('takeOver'); return { ok: true } }
  }
  let changeListener = null
  const { handlers, mega } = await startExtension({
    subWorker: manager,
    onSubWorkerChange: (listener) => {
      changeListener = listener
      return () => { changeListener = null }
    }
  })
  t.after(() => mega.stop())

  const item = trayItem('Sub-worker')
  assert.equal(item.submenu[0].label, 'Sub-worker: BUSY (RUNNING)', 'a busy worker is announced in the tray (§16)')
  assert.equal(item.submenu[1].label, 'Task: boss-kb-031')
  assert.equal(item.submenu.find((entry) => entry.label === 'Start').enabled, false, 'Start is unavailable while running')
  assert.equal(item.submenu.find((entry) => entry.label === 'Stop').enabled, true)
  assert.equal(item.submenu.find((entry) => entry.label === 'Pause').enabled, true)
  assert.equal(item.submenu.find((entry) => entry.label === 'Resume').enabled, false, 'Resume only matters while paused')

  item.submenu.find((entry) => entry.label === 'Pause').click()
  item.submenu.find((entry) => entry.label === 'Stop').click()
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.deepEqual(calls, ['pause', 'stop'], 'tray actions are routed to the shell-owned manager')

  // "Open Live View" never opens a window: it reveals the pane inside the dock.
  const before = shell.windows.length
  item.submenu.find((entry) => entry.label === 'Open Live View').click()
  assert.equal(shell.windows.length, before, 'the Live View must not create a window')

  // The snapshot exposes the worker to the dock panel.
  const snapshot = await handlers.get('mega:snapshot')()
  assert.equal(snapshot.subWorker.state, 'RUNNING')
  assert.equal(snapshot.subWorker.task.task_id, 'boss-kb-031')
  assert.equal(typeof changeListener, 'function', 'the shell can push worker changes into the extension')
})

test('an ordinary Harness session, a scheduler task and a headless task each alert once', async (t) => {
  const { mega, scheduler, handlers } = await startExtension()
  t.after(() => mega.stop())
  scheduler.requestTick = () => {}
  scheduler.setOfficialClient({
    async dispatchNewSession() { return { sessionId: 'session-integration-1', accepted: true } },
    async listSessions() { return [] },
    async cancelSession() {}
  })

  // 1. Ordinary official Harness session observed from the session store.
  writeSession('user-session', [USER_TURN])            // still RUNNING (no turn end)
  assert.equal(await waitFor(() => notifications.length === 0, 700), true, 'a running session must stay silent')

  fs.appendFileSync(sessionFile('user-session'), `${JSON.stringify({ type: 'turn/end', seq: 2, time: Date.now(), data: { reason: { kind: 'success' } } })}\n`)
  assert.equal(await waitFor(() => notifications.length === 1), true, 'the observed session must alert')
  assert.match(notifications[0].body, /^Task completed: summarize the repository/)
  assert.match(notifications[0].body, /Status: Completed/)

  // No duplicate alert while the session stays in its terminal state.
  await new Promise((resolve) => setTimeout(resolve, 800))
  assert.equal(notifications.length, 1, 'one terminal state must not alert twice')

  // 2. Scheduler-dispatched official session.
  const scheduled = scheduler.addTask({ prompt: 'integration scheduler task' })
  await scheduler.launchOfficial(scheduler.tasks[0])
  scheduler.finish(scheduler.tasks[0], 'COMPLETED', 0, { source: 'integration' })
  assert.equal(notifications.length, 2)
  assert.match(notifications[1].body, /^Task completed: integration scheduler task/)

  // 3. Headless task (delivery mode headless, scheduler terminal event).
  const headless = scheduler.addTask({ prompt: 'integration headless task', deliveryMode: 'headless' })
  const headlessTask = scheduler.tasks.find((task) => task.id === headless.id)
  headlessTask.status = 'RUNNING'
  headlessTask.startedAt = Date.now()
  scheduler.running.set(headlessTask.id, headlessTask)
  scheduler.finish(headlessTask, 'FAILED', 1, { source: 'headless', preserveError: true })
  assert.equal(notifications.length, 3)
  assert.match(notifications[2].body, /^Task failed: integration headless task/)

  // The scheduler already reported its own sessions, so the observer must not
  // have produced a second alert for them.
  const bodies = notifications.map((n) => n.body)
  assert.equal(bodies.filter((body) => /integration scheduler task/.test(body)).length, 1)
  assert.equal(bodies.filter((body) => /integration headless task/.test(body)).length, 1)

  // Active queue and history stay consistent through all three paths.
  const snapshot = await handlers.get('mega:snapshot')()
  assert.deepEqual(snapshot.tasks, [])
  assert.equal(snapshot.scheduler.activeQueue.total, 0)
  const historyIds = snapshot.history.map((entry) => entry.id)
  for (const id of [scheduled.id, headless.id]) assert.ok(historyIds.includes(id))
})

test('a notification failure never affects task completion, and the ring still fires', async (t) => {
  const { mega, scheduler } = await startExtension()
  t.after(() => mega.stop())
  scheduler.requestTick = () => {}
  scheduler.setOfficialClient({
    async dispatchNewSession() { return { sessionId: 'session-integration-2', accepted: true } },
    async listSessions() { return [] },
    async cancelSession() {}
  })

  notificationFails = true
  t.after(() => { notificationFails = false })

  const before = notifications.length
  const task = scheduler.addTask({ prompt: 'task with a broken notifier' })
  await scheduler.launchOfficial(scheduler.tasks[0])
  assert.doesNotThrow(() => scheduler.finish(scheduler.tasks[0], 'COMPLETED', 0, { source: 'integration' }))

  assert.equal(scheduler.tasks.length, 0, 'the task still left the active queue')
  assert.equal(scheduler.listHistory().some((entry) => entry.id === task.id), true, 'history was still written')
  assert.equal(notifications.length, before, 'no notification was delivered')
  assert.ok(shell.loadedFiles.some((file) => path.basename(file) === 'player.html'), 'the ringtone path still ran')
})
