'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { SchedulerService } = require('../../app/extensions/mega/scheduler/scheduler')
const { TERMINAL_EVENT, CANONICAL_TERMINAL } = require('../../app/extensions/mega/scheduler/lifecycle')

/**
 * MEGA-01: every terminal transition must leave the active queue and stay
 * queryable through the history layer - including the suspended/resumed and
 * restart-recovery paths.
 */

const FAKE_SYSTEM = {
  hardware: { cpu: { model: 'test', logicalCores: 4, physicalCores: 2 }, memory: { totalGb: 16 }, gpus: [] },
  cpu: { cores: 4, logicalCores: 4, physicalCores: 2, model: 'test', usagePercent: 5 },
  memory: { totalGb: 16, freeGb: 8, usedPercent: 50 },
  uptimeSeconds: 1
}

function fakeOfficialClient() {
  return {
    dispatched: [],
    cancelled: [],
    async dispatchNewSession({ prompt, cwd }) {
      this.dispatched.push({ prompt, cwd })
      return { sessionId: `session-test-${this.dispatched.length}`, accepted: true }
    },
    async listSessions() {
      return []
    },
    async cancelSession(sessionId) {
      this.cancelled.push(sessionId)
    }
  }
}

function makeHarness({ queue = [], history = [], config = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-scheduler-'))
  const historyFile = path.join(dir, 'recent.json')
  fs.writeFileSync(path.join(dir, 'scheduler-queue.json'), JSON.stringify(queue, null, 2))
  fs.writeFileSync(path.join(dir, 'scheduler-config.json'), JSON.stringify(config, null, 2))
  fs.writeFileSync(historyFile, JSON.stringify(history, null, 2))

  const readHistory = () => JSON.parse(fs.readFileSync(historyFile, 'utf8'))
  const client = fakeOfficialClient()
  const service = new SchedulerService({
    stateDir: dir,
    systemProbe: () => FAKE_SYSTEM,
    officialClient: client,
    log: () => {},
    historySink: (entry) => {
      const list = readHistory().filter((e) => e?.id !== entry?.id)
      list.unshift({ savedAt: Date.now(), ...entry })
      fs.writeFileSync(historyFile, JSON.stringify(list, null, 2))
      return list
    },
    historyRemover: (ids) => {
      const set = new Set(ids.map(String))
      const list = readHistory().filter((e) => !set.has(String(e?.id)))
      fs.writeFileSync(historyFile, JSON.stringify(list, null, 2))
      return list.length
    },
    historyLoader: readHistory
  })
  // Tick scheduling is deliberately disabled for deterministic tests; the
  // individual lifecycle steps are driven directly.
  service.requestTick = () => {}
  const events = []
  service.on(TERMINAL_EVENT, (event) => events.push(event))
  service.on('error', () => {})

  return {
    service,
    client,
    events,
    dir,
    readQueue: () => JSON.parse(fs.readFileSync(path.join(dir, 'scheduler-queue.json'), 'utf8')),
    history: () => readHistory().filter(Boolean),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true })
  }
}

function queueEntry(overrides = {}) {
  return {
    id: 'seeded-task',
    prompt: 'seeded prompt',
    deliveryMode: 'headless',
    allowPeak: true,
    startAtMs: null,
    createdAt: Date.now() - 1000,
    queueOrder: 1,
    status: 'PENDING',
    reason: null,
    attempts: 0,
    startedAt: null,
    endedAt: null,
    exitCode: null,
    permissionMode: null,
    attachments: [],
    logFile: null,
    sessionDir: null,
    officialSessionId: null,
    officialAcceptedAt: null,
    officialSeenRunning: false,
    officialLastSeenAt: null,
    error: null,
    ...overrides
  }
}

test('queued -> running -> completed leaves the active queue and lands in history', async (t) => {
  const h = makeHarness()
  t.after(h.cleanup)

  const created = h.service.addTask({ prompt: 'write the report' })
  assert.equal(h.service.tasks.length, 1)
  await h.service.launchOfficial(h.service.tasks[0])
  assert.equal(h.service.tasks[0].status, 'RUNNING')
  assert.equal(h.service.running.size, 1)

  h.service.finish(h.service.tasks[0], 'COMPLETED', 0, { source: 'test' })

  assert.equal(h.service.tasks.length, 0, 'active queue must not keep the terminal task')
  assert.equal(h.service.running.size, 0, 'worker slot must be released')
  assert.equal(h.readQueue().length, 0, 'persisted queue must not keep the terminal task')
  assert.equal(h.events.length, 1)
  assert.equal(h.events[0].finalStatus, CANONICAL_TERMINAL.COMPLETED)
  assert.equal(h.events[0].taskId, created.id)
  assert.ok(h.events[0].taskName.includes('write the report'))

  const history = h.history()
  assert.equal(history.length, 1)
  assert.equal(history[0].id, created.id)
  assert.equal(history[0].status, 'COMPLETED')
  assert.ok(h.service.listHistory().some((entry) => entry.id === created.id), 'history stays queryable')
  assert.equal(h.service.listTasks().length, 0)
})

test('queued -> running -> suspended -> running -> completed cleans up once', async (t) => {
  const h = makeHarness()
  t.after(h.cleanup)

  h.service.nowPeak = () => true
  h.service.addTask({ prompt: 'off-peak only job', allowPeak: false })
  await h.service.tick()
  const task = h.service.tasks[0]
  assert.equal(task.status, 'SUSPENDED')
  assert.equal(task.reason, 'peak-window')

  // Suspended tasks are recoverable, not terminal: they keep their queue slot.
  assert.equal(h.events.length, 0)

  h.service.nowPeak = () => false
  await h.service.tick()
  assert.equal(task.status, 'RUNNING', 'suspended task resumes when the window opens')
  assert.equal(h.service.running.size, 1)

  h.service.finish(task, 'COMPLETED', 0, { source: 'test' })
  assert.equal(h.service.tasks.length, 0)
  assert.equal(h.events.length, 1)
  assert.equal(h.history().length, 1)
  assert.equal(h.history()[0].status, 'COMPLETED')
})

test('queued -> suspended -> cancelled leaves the suspended queue', async (t) => {
  const h = makeHarness()
  t.after(h.cleanup)

  h.service.nowPeak = () => true
  h.service.addTask({ prompt: 'cancel me', allowPeak: false })
  await h.service.tick()
  const task = h.service.tasks[0]
  assert.equal(task.status, 'SUSPENDED')

  h.service.cancelTask(task.id)

  assert.equal(h.service.tasks.length, 0, 'cancelled task must not stay in the suspended queue')
  assert.equal(h.events.length, 1)
  assert.equal(h.events[0].finalStatus, CANONICAL_TERMINAL.CANCELLED)
  assert.equal(h.events[0].status, 'CANCELED')
  assert.equal(h.history()[0].status, 'CANCELED')
})

test('running -> failed-final reports FAILED_FINAL once', async (t) => {
  const h = makeHarness()
  t.after(h.cleanup)

  h.service.addTask({ prompt: 'this one breaks' })
  const task = h.service.tasks[0]
  await h.service.launchOfficial(task)
  task.error = 'boom: provider refused the request'
  h.service.finish(task, 'FAILED', 3, { source: 'test', preserveError: true })

  assert.equal(h.service.tasks.length, 0)
  assert.equal(h.events.length, 1)
  assert.equal(h.events[0].finalStatus, CANONICAL_TERMINAL.FAILED_FINAL)
  assert.equal(h.events[0].exitCode, 3)
  assert.match(h.events[0].errorSummary, /boom/)
  assert.equal(h.history()[0].status, 'FAILED')
})

test('suspended -> running -> failed-final cleans up once', async (t) => {
  const h = makeHarness()
  t.after(h.cleanup)

  h.service.nowPeak = () => true
  h.service.addTask({ prompt: 'later and then fail', allowPeak: false })
  await h.service.tick()
  const task = h.service.tasks[0]
  assert.equal(task.status, 'SUSPENDED')
  h.service.nowPeak = () => false
  await h.service.tick()
  assert.equal(task.status, 'RUNNING')

  h.service.finish(task, 'FAILED', 1, { source: 'test' })
  assert.equal(h.service.tasks.length, 0)
  assert.equal(h.events.length, 1)
  assert.equal(h.events[0].finalStatus, CANONICAL_TERMINAL.FAILED_FINAL)
  assert.equal(h.history().length, 1)
})

test('terminal cleanup is idempotent across duplicate callbacks', async (t) => {
  const h = makeHarness()
  t.after(h.cleanup)

  h.service.addTask({ prompt: 'duplicate callbacks' })
  const task = h.service.tasks[0]
  await h.service.launchOfficial(task)

  const first = h.service.terminate(task, { status: 'COMPLETED', source: 'first' })
  const second = h.service.terminate(task, { status: 'FAILED', source: 'second' })
  const third = h.service.cancelTask(task.id)
  h.service.interruptTask(task.id, 'user-cancel')
  h.service.removeFromActiveQueue(task.id)

  assert.equal(first, true)
  assert.equal(second, false, 'second terminal transition is a no-op')
  assert.equal(h.events.length, 1, 'one terminal event per lifecycle')
  assert.equal(h.history().length, 1, 'one history record per lifecycle')
  assert.equal(h.history()[0].status, 'COMPLETED')
  assert.equal(third, null, 'a terminal task is no longer addressable as active work (removeIfPresent semantics)')
  assert.equal(h.service.interruptTask(task.id, 'user-cancel'), false)
})

test('restart recovery never reloads a terminal task and never resurrects it', async (t) => {
  const terminal = queueEntry({ id: 'ghost-completed', status: 'COMPLETED', endedAt: Date.now() - 5000, reason: 'legacy' })
  const suspended = queueEntry({ id: 'recoverable', status: 'SUSPENDED', reason: 'peak-window', queueOrder: 2 })
  const running = queueEntry({ id: 'was-running', status: 'RUNNING', startedAt: Date.now() - 60000, queueOrder: 3 })

  const h = makeHarness({ queue: [terminal, suspended, running] })
  t.after(h.cleanup)

  // The terminal ghost is moved to history during queue load, before startup.
  assert.deepEqual(h.service.tasks.map((x) => x.id).sort(), ['recoverable', 'was-running'])
  assert.ok(h.history().some((entry) => entry.id === 'ghost-completed'), 'legacy terminal task is preserved in history')

  h.service.start()
  h.service.stop()

  assert.deepEqual(h.service.tasks.map((x) => x.id), ['recoverable'], 'only the recoverable task stays queued')
  assert.equal(h.service.tasks[0].status, 'SUSPENDED', 'suspended tasks keep their existing recovery rule')
  assert.equal(h.service.running.size, 0, 'no worker slot is occupied after restart')

  const ids = h.history().map((entry) => entry.id)
  assert.ok(ids.includes('ghost-completed'))
  assert.ok(ids.includes('was-running'))
  assert.equal(h.events.filter((e) => e.taskId === 'was-running').length, 1)
  assert.equal(h.events[0].reason, 'app-restart')

  const persisted = h.readQueue().map((task) => task.id)
  assert.deepEqual(persisted, ['recoverable'], 'persisted queue keeps only recoverable work')

  // A second restart must not produce a second terminal transition.
  const eventsBefore = h.events.length
  const restarted = new SchedulerService({
    stateDir: h.dir,
    systemProbe: () => FAKE_SYSTEM,
    officialClient: fakeOfficialClient(),
    log: () => {},
    historySink: () => {},
    historyRemover: () => {},
    historyLoader: h.history
  })
  restarted.requestTick = () => {}
  restarted.start()
  restarted.stop()
  assert.deepEqual(restarted.tasks.map((x) => x.id), ['recoverable'])
  assert.equal(h.events.length, eventsBefore, 'restarting again emits no new terminal event')
})

test('Mega-dispatched official sessions are registered as managed', async (t) => {
  const h = makeHarness()
  t.after(h.cleanup)

  h.service.addTask({ prompt: 'scheduler dispatched session' })
  const task = h.service.tasks[0]
  await h.service.launchOfficial(task)
  assert.equal(h.service.isManagedOfficialSession(task.officialSessionId), true, 'active task session is managed')
  assert.equal(h.service.isManagedOfficialSession('someone-elses-session'), false)

  h.service.finish(task, 'COMPLETED', 0, { source: 'test' })
  assert.equal(
    h.service.isManagedOfficialSession(task.officialSessionId),
    true,
    'the history layer keeps the session managed so the observer cannot double-alert it'
  )
  assert.deepEqual([...h.service.managedOfficialSessionIds()], [task.officialSessionId])
  assert.equal(h.service.isManagedOfficialSession(''), false)
})

test('bulk clear moves every queued task to history and cancels active work', async (t) => {
  const h = makeHarness()
  t.after(h.cleanup)

  h.service.addTask({ prompt: 'first' })
  h.service.addTask({ prompt: 'second' })
  await h.service.launchOfficial(h.service.tasks[0])
  const activeId = h.service.tasks[0].id

  const cleared = h.service.clearPending()

  assert.equal(cleared, 1, 'only the queued task is cleared')
  assert.deepEqual(h.service.tasks.map((task) => task.id), [activeId])
  const clearedEvent = h.events.find((event) => event.taskId !== activeId)
  assert.ok(clearedEvent, 'the cleared task emits a terminal event')
  assert.equal(clearedEvent.finalStatus, CANONICAL_TERMINAL.CANCELLED)

  h.service.removeTasks([activeId])
  assert.equal(h.service.tasks.length, 0)
  const historyIds = h.history().map((entry) => entry.id)
  assert.equal(historyIds.includes(activeId), false, 'an explicit removal drops that task history record')
  assert.ok(historyIds.includes(clearedEvent.taskId), 'other terminal history is untouched')
  assert.ok(h.client.cancelled.length >= 1, 'active official session is cancelled')
})

test('a history write failure cannot resurrect the task or change its final state', async (t) => {
  const h = makeHarness()
  t.after(h.cleanup)
  h.service.historySink = () => { throw new Error('disk full') }
  const errors = []
  h.service.on('error', (error) => errors.push(error))

  h.service.addTask({ prompt: 'history write fails' })
  const task = h.service.tasks[0]
  await h.service.launchOfficial(task)
  h.service.finish(task, 'COMPLETED', 0, { source: 'test' })

  assert.equal(task.status, 'COMPLETED', 'final state survives a history failure')
  assert.equal(h.service.tasks.length, 0, 'task must still leave the active queue')
  assert.equal(h.events.length, 1)
  assert.ok(errors.some((error) => /history write failed/.test(error.message)))
})
