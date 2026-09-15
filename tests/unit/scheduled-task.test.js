'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { SchedulerService } = require('../../app/extensions/mega/scheduler/scheduler')

/**
 * The scheduled task, from the dialog to the conversation (`updateplan/pluginize.md` Phase 2).
 *
 * The requirement is that a scheduled task is **the same as a normal conversation in every respect except the
 * timing**: it is not a second kind of work, it is the same work done later, and when its moment comes it must
 * arrive as a new official session — the same `session/create` + `session/prompt` a person pressing send produces —
 * with the prompt they typed and nothing wrapped around it.
 *
 * So this file drives the real `SchedulerService` (not a stub) with an official client in the place of the network,
 * and asserts the two halves of that promise: the task *waits* until its instant and does not run early, and when it
 * runs it is handed to the official session path verbatim, once.
 */

const FAKE_SYSTEM = {
  hardware: { cpu: { model: 'test', logicalCores: 4, physicalCores: 2 }, memory: { totalGb: 16 }, gpus: [] },
  cpu: { cores: 4, logicalCores: 4, physicalCores: 2, model: 'test', usagePercent: 5 },
  memory: { totalGb: 16, freeGb: 8, usedPercent: 50 },
  uptimeSeconds: 1
}

/** The official session client, with the network taken out and the calls recorded. */
function fakeOfficialClient() {
  return {
    dispatched: [],
    async dispatchNewSession({ prompt, cwd }) {
      this.dispatched.push({ prompt, cwd })
      return { sessionId: `session-${this.dispatched.length}`, accepted: true }
    },
    async listSessions() {
      return []
    },
    async cancelSession() {}
  }
}

function makeScheduler({ queue = [], config = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-scheduled-'))
  fs.writeFileSync(path.join(dir, 'scheduler-queue.json'), JSON.stringify(queue, null, 2))
  fs.writeFileSync(path.join(dir, 'scheduler-config.json'), JSON.stringify(config, null, 2))
  const client = fakeOfficialClient()
  const service = new SchedulerService({
    stateDir: dir,
    systemProbe: () => FAKE_SYSTEM,
    officialClient: client,
    log: () => {},
    historySink: () => {},
    historyRemover: () => 0,
    historyLoader: () => []
  })
  // The tick is driven by hand: a test that waited for the interval would be a test about the interval.
  service.requestTick = () => {}
  service.on('error', () => {})
  return { service, client, dir }
}

test('a scheduled task waits for its instant, then runs — and it is a new official conversation', async () => {
  const { service, client, dir } = makeScheduler()
  try {
    const startAt = new Date(Date.now() + 60 * 60_000).toISOString()
    const task = service.addTask({
      prompt: '总结今天的构建日志',
      startAt,
      allowPeak: true,
      deliveryMode: 'official-session'
    })

    // The dialog's task is a normal queue entry: pending, with the instant it was given, and the same delivery a
    // typed message has.
    assert.equal(task.status, 'PENDING')
    assert.equal(task.deliveryMode, 'official-session')
    assert.equal(task.startAtMs, Date.parse(startAt))
    assert.equal(task.prompt, '总结今天的构建日志')

    // An hour early: the tick suspends it and **nothing is dispatched**. This is the whole of "scheduled".
    await service.tick()
    assert.equal(client.dispatched.length, 0, 'a task ran before its time')
    const suspended = service.listTasks({ limit: 5 })[0]
    assert.equal(suspended.status, 'SUSPENDED')
    assert.equal(suspended.reason, 'waiting-schedule', 'the queue has to say *why* a task is sitting there')

    // Its moment arrives: the same tick launches it as an official session, with the prompt exactly as typed.
    service.tasks[0].startAtMs = Date.now() - 1000
    await service.tick()

    assert.equal(client.dispatched.length, 1, 'the task did not run when its time came')
    assert.equal(client.dispatched[0].prompt, '总结今天的构建日志', 'the prompt was wrapped in something the user did not type')
    assert.equal(service.tasks[0].status, 'RUNNING')
    assert.equal(service.tasks[0].officialSessionId, 'session-1', 'the task did not become an official session')
    assert.equal(service.tasks[0].startedAt !== null, true)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a peak window suspends a scheduled task that did not allow peak — and says why', async () => {
  /**
   * This is the sentence the dialog has to be able to give the user *before* they pick a time: with peak off, a task
   * whose instant lands inside a peak window waits for the valley rather than being refused. The scheduler owns
   * that answer (`decideTask`), and the dialog reads `peak` from the timing surface to repeat it.
   */
  const { service, client, dir } = makeScheduler()
  try {
    const task = service.addTask({ prompt: '在谷价时段跑', startAt: new Date(Date.now() + 1000).toISOString(), allowPeak: false, deliveryMode: 'official-session' })
    // Force the peak reading rather than the machine's clock: the point is the gate, not today's calendar.
    service.nowPeak = () => true
    service.tasks[0].startAtMs = Date.now() - 1000
    await service.tick()

    assert.equal(client.dispatched.length, 0, 'a task ran inside a peak window it did not allow')
    const suspended = service.listTasks({ limit: 5 })[0]
    assert.equal(suspended.status, 'SUSPENDED')
    assert.equal(suspended.reason, 'peak-window', 'the reason a user would need to understand why nothing ran')
    // The other reading: allow peak, and the same instant runs.
    service.tasks[0].allowPeak = true
    service.tasks[0].startAtMs = Date.now() - 1000
    await service.tick()
    assert.equal(client.dispatched.length, 1, 'a task that allows peak still waited for the valley')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a time that has already passed is refused — because a past instant runs at once instead of waiting', async () => {
  /**
   * The "定时任务挂起失败" report, stated as a rule.
   *
   * The gate reads `now >= startAtMs` as *ready* — right for a queue entry whose moment has come — so a task
   * created with an instant a few seconds behind it runs immediately rather than being suspended. That is easy to
   * do by accident, because a `datetime-local` field truncates to the minute: picking "this minute" is already in
   * the past. The user asked for a *scheduled* task and got an immediate one, with nothing on screen saying why.
   */
  const { service, client, dir } = makeScheduler()
  try {
    const past = new Date(Date.now() - 1000).toISOString()
    assert.throws(() => service.addTask({ prompt: '晚了', startAt: past }), /already passed/)
    assert.equal(service.tasks.length, 0, 'a refused task was queued anyway')

    // The field travels with the refusal, so a form can point at the time input rather than at the whole form.
    try {
      service.addTask({ prompt: '晚了', startAt: past })
      assert.fail('a past instant was accepted')
    } catch (error) {
      assert.equal(error.field, 'startAt')
    }

    // One second ahead is in the future: accepted, and it *suspends* rather than running.
    const soon = service.addTask({ prompt: '马上就发', startAt: new Date(Date.now() + 1000).toISOString() })
    assert.equal(soon.status, 'PENDING')
    await service.tick()
    assert.equal(client.dispatched.length, 0, 'a task one second out ran immediately')
    assert.equal(service.listTasks({ limit: 5 })[0].status, 'SUSPENDED')
    assert.equal(service.listTasks({ limit: 5 })[0].reason, 'waiting-schedule')

    // ...and no time at all is the deliberate "run it now", which stays allowed: the rule is about a time that was
    // given and has gone, not about scheduling in general.
    assert.equal(service.addTask({ prompt: '现在跑' }).startAtMs, null)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the task a scheduled run produces carries no second prompt, no header and no rewrite', async () => {
  /**
   * "Same as a normal conversation" has one failure mode worth a test of its own: the dispatch path quietly
   * adding something. `buildPrompt` is where that would happen, so it is asserted directly as well as through the
   * dispatch above — attachments are the one case it may add to, and only then.
   */
  const { service, dir } = makeScheduler()
  try {
    const plain = service.addTask({ prompt: '只发这句话', deliveryMode: 'official-session' })
    assert.equal(service.buildPrompt(plain), '只发这句话', 'the dispatcher rewrote what the user typed')

    const withAttachment = service.addTask({ prompt: '看这个文件', attachments: ['notes.md'], deliveryMode: 'official-session' })
    const built = service.buildPrompt(withAttachment)
    assert.match(built, /^看这个文件/)
    assert.match(built, /notes\.md/, 'an attachment the user added was dropped')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
