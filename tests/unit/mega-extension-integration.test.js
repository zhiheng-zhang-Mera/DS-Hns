'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/**
 * Integration level (cleaning.md §11): start the Mega extension against a
 * stubbed Electron shell, run a full task lifecycle through the real scheduler,
 * and check the observable outcomes - active queue, history, notification and
 * IPC snapshot - including failure isolation.
 */

const SCRATCH = path.join(process.env.TEMP || os.tmpdir(), `dsh-mega-integration-${process.pid}`)
process.env.DSH_ROOT = SCRATCH
process.env.DSH_HOME = path.join(SCRATCH, 'data')
fs.rmSync(SCRATCH, { recursive: true, force: true })
for (const dir of ['config', 'data/state', 'data/task-history', 'assets/sounds', 'logs']) {
  fs.mkdirSync(path.join(SCRATCH, dir), { recursive: true })
}

const notifications = []
let notificationFails = false
function FakeNotification(options) {
  if (notificationFails) throw new Error('notification subsystem offline')
  notifications.push(options)
  return { on() {}, show() {} }
}
FakeNotification.isSupported = () => true

function fakeElectron(handlers) {
  class FakeBrowserWindow {
    constructor() {
      this.destroyed = false
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
    isMinimized() { return false }
    getBounds() { return { x: 0, y: 0, width: 1200, height: 900 } }
    getContentBounds() { return { x: 0, y: 0, width: 1200, height: 900 } }
    setBounds() {}
    setMenuBarVisibility() {}
    show() {}
    showInactive() {}
    hide() {}
    focus() {}
    restore() {}
    destroy() { this.destroyed = true }
    loadFile() { return Promise.resolve() }
    once() {}
    on() {}
    removeListener() {}
  }
  return {
    app: { quit() {}, getPath: () => SCRATCH },
    BrowserWindow: FakeBrowserWindow,
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    shell: { openExternal() {} },
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler),
      removeHandler: (channel) => handlers.delete(channel),
      on() {},
      removeAllListeners() {}
    },
    Tray: null,
    Menu: { buildFromTemplate: () => [] },
    nativeImage: { createFromPath: () => ({ isEmpty: () => false }) },
    screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
    Notification: FakeNotification
  }
}

test('the Mega extension starts, notifies once per terminal state and keeps history queryable', async (t) => {
  const handlers = new Map()
  const mega = require('../../app/extensions/mega/index.cjs')
  const scheduler = require('../../app/extensions/mega/scheduler/scheduler')
  const lifecycle = require('../../app/extensions/mega/scheduler/lifecycle')

  const logs = []
  const mainWindow = new (fakeElectron(handlers).BrowserWindow)()
  await mega.start({
    root: SCRATCH,
    nodeExe: process.execPath,
    mainWindow,
    log: (message) => logs.push(String(message)),
    electron: fakeElectron(handlers)
  })
  t.after(() => mega.stop())

  // Deterministic lifecycle driving: no background tick, no real DSH session.
  scheduler.requestTick = () => {}
  scheduler.setOfficialClient({
    async dispatchNewSession() { return { sessionId: 'session-integration-1', accepted: true } },
    async listSessions() { return [] },
    async cancelSession() {}
  })

  const started = Date.now()

  // 1. queued -> running -> completed
  const completed = scheduler.addTask({ prompt: 'integration completed task' })
  await scheduler.launchOfficial(scheduler.tasks[0])
  scheduler.finish(scheduler.tasks[0], 'COMPLETED', 0, { source: 'integration' })

  // 2. queued -> running -> failed-final
  const failed = scheduler.addTask({ prompt: 'integration failing task' })
  await scheduler.launchOfficial(scheduler.tasks[0])
  scheduler.tasks[0].error = 'EXIT_1: simulated failure'
  scheduler.finish(scheduler.tasks[0], 'FAILED', 1, { source: 'integration', preserveError: true })

  // 3. queued -> suspended -> running -> cancelled
  const cancelled = scheduler.addTask({ prompt: 'integration cancelled task', allowPeak: false })
  scheduler.nowPeak = () => true
  await scheduler.tick()
  const suspended = scheduler.tasks.find((task) => task.id === cancelled.id)
  assert.equal(suspended.status, 'SUSPENDED')
  scheduler.cancelTask(cancelled.id)

  assert.ok(Date.now() - started < 60_000)

  // Active queue is empty: nothing remains dispatchable.
  assert.deepEqual(scheduler.listTasks(), [])
  assert.equal(scheduler.running.size, 0)

  // History is complete and queryable through the IPC snapshot.
  const snapshot = await handlers.get('mega:snapshot')()
  const historyIds = snapshot.history.map((entry) => entry.id)
  for (const id of [completed.id, failed.id, cancelled.id]) {
    assert.ok(historyIds.includes(id), `${id} must stay queryable in history`)
  }
  assert.deepEqual(snapshot.tasks, [], 'the UI receives no terminal task in the active queue')
  assert.equal(snapshot.scheduler.activeQueue.total, 0)
  assert.equal(snapshot.scheduler.activeQueue.workerSlotsInUse, 0)
  for (const session of snapshot.sessions) {
    assert.equal('cost' in session, false, 'session payload carries no removed cost field')
  }

  // One terminal state, one desktop notification.
  assert.equal(notifications.length, 3, 'each of the three terminal transitions notified exactly once')
  const bodies = notifications.map((n) => n.body)
  assert.ok(bodies.some((body) => /^Task completed: integration completed task/.test(body)))
  assert.ok(bodies.some((body) => /^Task failed: integration failing task/.test(body)))
  assert.ok(bodies.some((body) => /^Task cancelled: integration cancelled task/.test(body)))
  assert.ok(notifications.every((n) => n.title === 'DS-Hns'))
})

test('a notification failure never affects task completion', async (t) => {
  const handlers = new Map()
  const mega = require('../../app/extensions/mega/index.cjs')
  const scheduler = require('../../app/extensions/mega/scheduler/scheduler')

  if (!scheduler.startedAt) {
    await mega.start({
      root: SCRATCH,
      nodeExe: process.execPath,
      mainWindow: new (fakeElectron(handlers).BrowserWindow)(),
      log: () => {},
      electron: fakeElectron(handlers)
    })
    t.after(() => mega.stop())
  }
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
  assert.equal(scheduler.running.size, 0)
})
