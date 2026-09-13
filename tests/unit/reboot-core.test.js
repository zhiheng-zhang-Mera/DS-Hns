'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  PLAN_STATES,
  TARGET_KINDS,
  REBOOT_REASONS,
  createPlan,
  updatePlan,
  describePlan,
  clockTimeToMs,
  formatDuration,
  isDue,
  remainingMs
} = require('../../app/reboot/plan.cjs')
const { createRebootStore } = require('../../app/reboot/store.cjs')
const { createRebootPlatform, RUN_KEY, RUN_VALUE, RESUME_FLAG, safeReason } = require('../../app/reboot/platform.cjs')
const { createRebootCoordinator, PARKABLE_PHASES } = require('../../app/reboot/coordinator.cjs')
const { PARKABLE_PHASES: ENGINEERING_PARKABLE } = require('../../app/engineering/episode.cjs')

/**
 * A restart the user scheduled: the model, the disk, the operating system's half, and the sequence.
 *
 * The interesting failures are all about *when* a restart is allowed to happen, so the tests are
 * mostly about restraint: a plan that is not due does nothing; a plan whose task is mid-stage waits
 * and says why; a plan that cannot bring the application back refuses to restart at all; and a park
 * that never settles fails the plan rather than killing the task.
 *
 * Nothing here restarts anything. The platform layer takes an injected runner, and every test
 * injects one — which is also what lets the exact argv be asserted.
 */

const NOW = Date.UTC(2026, 8, 14, 9, 0, 0) // 2026-09-14T09:00:00Z

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshns-reboot-'))
  return { dir, dispose: () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}

function storeIn(dir, now = () => NOW) {
  return createRebootStore({
    file: path.join(dir, 'data', 'state', 'reboot-plans.json'),
    intentFile: path.join(dir, 'data', 'state', 'reboot-resume.json'),
    now,
    log: () => {}
  })
}

/** A platform whose runner records argv and answers with the result a script says. */
function fakePlatform(options = {}) {
  const calls = []
  const answers = options.answers || {}
  const platform = createRebootPlatform({
    platform: options.platform || 'win32',
    execPath: 'C:\\Apps\\DS-Hns\\DS-Hns.exe',
    appArgs: options.appArgs || [],
    log: () => {},
    run: (program, args, runOptions = {}) => {
      calls.push({ program, args, options: runOptions })
      const key = `${program} ${args[0]}`
      const answer = answers[key]
      if (answer) return typeof answer === 'function' ? answer(program, args) : answer
      return { ok: true, code: null, command: [program, ...args], status: 0, stdout: '', stderr: '' }
    }
  })
  return { platform, calls, argv: () => calls.map((call) => [call.program, ...call.args]) }
}

test('a time on the clock is today or tomorrow, and never the past', () => {
  // 09:00 UTC, and the clock is read in local time: the assertion is about the relationship.
  const later = clockTimeToMs('23:59', NOW)
  const earlier = clockTimeToMs('00:01', NOW)
  assert.ok(later > NOW, 'a time later today must be today')
  assert.ok(earlier > NOW, 'a time already past today must mean tomorrow')
  assert.ok(earlier - NOW <= 24 * 60 * 60 * 1000)
  assert.equal(clockTimeToMs('24:00', NOW), null)
  assert.equal(clockTimeToMs('9:60', NOW), null)
  assert.equal(clockTimeToMs('nine', NOW), null)
  assert.equal(clockTimeToMs('09:30:15', NOW) % 1000, 0)

  const iso = createPlan({ mode: 'at', at: '2026-09-15T03:00:00Z' }, { now: NOW })
  assert.equal(iso.ok, true)
  assert.equal(iso.plan.dueAt, Date.parse('2026-09-15T03:00:00Z'))
  const past = createPlan({ mode: 'at', at: '2020-01-01T00:00:00Z' }, { now: NOW })
  assert.equal(past.ok, false)
  assert.equal(past.code, REBOOT_REASONS.BAD_TIME)
})

test('a countdown becomes one absolute moment, bounded to a day', () => {
  const minutes = createPlan({ mode: 'after', afterMinutes: 30 }, { now: NOW })
  assert.equal(minutes.ok, true)
  assert.equal(minutes.plan.dueAt, NOW + 30 * 60_000)
  const seconds = createPlan({ mode: 'after', afterSeconds: 90 }, { now: NOW })
  assert.equal(seconds.plan.dueAt, NOW + 90_000)
  const both = createPlan({ mode: 'after', afterMinutes: 1, afterSeconds: 30 }, { now: NOW })
  assert.equal(both.plan.dueAt, NOW + 90_000)
  for (const bad of [{ afterMinutes: 0 }, { afterSeconds: -5 }, { afterMinutes: 60 * 25 }, { afterMinutes: 'soon' }]) {
    const refused = createPlan({ mode: 'after', ...bad }, { now: NOW })
    assert.equal(refused.ok, false, JSON.stringify(bad))
    assert.equal(refused.code, REBOOT_REASONS.BAD_COUNTDOWN)
  }
})

test('a plan with a task waits for a boundary and continues afterwards, by default', () => {
  const targeted = createPlan({ mode: 'after', afterMinutes: 5, target: { kind: TARGET_KINDS.SUB_WORKER } }, { now: NOW })
  assert.equal(targeted.plan.waitForBoundary, true)
  assert.equal(targeted.plan.resumeAfterRestart, true)
  assert.equal(targeted.plan.graceSeconds, 60)

  const plain = createPlan({ mode: 'after', afterMinutes: 5 }, { now: NOW })
  assert.equal(plain.plan.target.kind, TARGET_KINDS.NONE)
  assert.equal(plain.plan.waitForBoundary, false)
  assert.equal(plain.plan.resumeAfterRestart, false)

  // Explicit settings win over the defaults, in both directions.
  const explicit = createPlan({ mode: 'after', afterMinutes: 5, target: { kind: TARGET_KINDS.ENGINEERING }, waitForBoundary: false, resumeAfterRestart: false, graceSeconds: 5 }, { now: NOW })
  assert.equal(explicit.plan.waitForBoundary, false)
  assert.equal(explicit.plan.resumeAfterRestart, false)
  assert.equal(explicit.plan.graceSeconds, 5)
  // …and a grace period outside the sane range is clamped rather than accepted.
  assert.equal(createPlan({ mode: 'after', afterMinutes: 5, graceSeconds: 99_999 }, { now: NOW }).plan.graceSeconds, 600)

  const unknown = createPlan({ mode: 'after', afterMinutes: 5, target: { kind: 'printer' } }, { now: NOW })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.code, REBOOT_REASONS.BAD_TARGET)

  // Labels and reasons are single-line and bounded, because the dashboard draws them.
  const noisy = createPlan({ mode: 'after', afterMinutes: 5, label: `a\n\nb${'x'.repeat(400)}`, reason: 'y'.repeat(999) }, { now: NOW })
  assert.equal(noisy.plan.label.length <= 120, true)
  assert.equal(/\n/.test(noisy.plan.label), false)
  assert.equal(noisy.plan.reason.length <= 400, true)
})

test('a plan can be edited until it fires, and not after', () => {
  const created = createPlan({ mode: 'after', afterMinutes: 30, label: 'first' }, { now: NOW })
  assert.equal(created.ok, true)
  const plan = created.plan

  const edited = updatePlan(plan, { afterMinutes: 10, label: 'second' }, { now: NOW })
  assert.equal(edited.ok, true, edited.reason)
  assert.equal(edited.plan.dueAt, NOW + 10 * 60_000)
  assert.equal(edited.plan.label, 'second')
  assert.equal(edited.plan.createdAt, plan.createdAt, 'an edit must not rewrite when the plan was made')
  assert.equal(edited.plan.updatedAt, NOW)
  assert.deepEqual(edited.changed.sort(), ['dueAt', 'label'])

  // Switching to a wall-clock time is an edit like any other.
  const timed = updatePlan(edited.plan, { mode: 'at', at: '2026-09-15T03:00:00Z' }, { now: NOW })
  assert.equal(timed.ok, true)
  assert.equal(timed.plan.mode, 'at')
  assert.equal(timed.plan.dueAt, Date.parse('2026-09-15T03:00:00Z'))

  // An invalid edit is refused and changes nothing.
  const refused = updatePlan(timed.plan, { at: '25:00' }, { now: NOW })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, REBOOT_REASONS.BAD_TIME)

  // Once it is executing, or finished, it is history.
  for (const state of [PLAN_STATES.EXECUTING, PLAN_STATES.DONE, PLAN_STATES.CANCELLED]) {
    const stuck = updatePlan({ ...timed.plan, state }, { label: 'too late' }, { now: NOW })
    assert.equal(stuck.ok, false, state)
    assert.equal(stuck.code, REBOOT_REASONS.NOT_EDITABLE)
  }
  assert.equal(updatePlan(null, {}, { now: NOW }).code, REBOOT_REASONS.NOT_FOUND)
})

test('what the dashboard is told about a plan', () => {
  const plan = createPlan({ mode: 'after', afterMinutes: 90, target: { kind: TARGET_KINDS.SUB_WORKER } }, { now: NOW }).plan
  const described = describePlan(plan, NOW)
  assert.equal(described.remainingMs, 90 * 60_000)
  assert.equal(described.due, false)
  assert.equal(described.counting, true)
  assert.equal(described.editable, true)
  assert.match(described.summary.cn, /1h 30m 后重启/)
  assert.match(described.summary.cn, /sub-worker/)
  assert.match(described.summary.cn, /等当前阶段完成/)
  assert.match(described.summary.cn, /重启后继续/)
  assert.match(described.summary.en, /restart in 1h 30m/)
  assert.equal(isDue(plan, NOW), false)
  assert.equal(isDue(plan, NOW + 90 * 60_000), true)
  assert.equal(remainingMs(plan, NOW + 60_000), 89 * 60_000)
  assert.equal(describePlan(plan, NOW + 90 * 60_000).summary.cn.includes('即将'), true)
  assert.equal(describePlan(null), null)
  assert.equal(formatDuration(45_000), '45s')
  assert.equal(formatDuration(125_000), '2m 05s')
  assert.equal(formatDuration(3 * 3600_000 + 7 * 60_000), '3h 07m')
})

test('the plan store keeps what is scheduled, and forgets what has run', () => {
  const { dir, dispose } = scratch()
  try {
    const store = storeIn(dir)
    const plan = createPlan({ mode: 'after', afterMinutes: 30, target: { kind: TARGET_KINDS.SUB_WORKER } }, { now: NOW }).plan
    assert.equal(store.add(plan).ok, true)
    assert.equal(store.add(plan).ok, false, 'the same plan must not be scheduled twice')
    assert.equal(store.list().length, 1)
    assert.equal(store.find(plan.id).id, plan.id)

    // An edit is a replacement, and the plan keeps its identity.
    const edited = updatePlan(plan, { afterMinutes: 5 }, { now: NOW }).plan
    assert.equal(store.replace(edited).ok, true)
    assert.equal(store.list()[0].dueAt, NOW + 5 * 60_000)
    assert.equal(store.replace({ ...edited, id: 'nope' }).ok, false)

    // Waiting is a state, not a removal: it stays on the dashboard.
    assert.equal(store.setState(plan.id, PLAN_STATES.WAITING_BOUNDARY, 'the worker is in stage TESTING').ok, true)
    assert.equal(store.list().length, 1)
    assert.equal(store.describe().waiting, 1)
    assert.equal(store.describe().plans[0].detail, 'the worker is in stage TESTING')

    // Firing records when, and the plan is still in the list until the application comes back.
    store.setState(plan.id, PLAN_STATES.EXECUTING, 'restart in 60s')
    assert.equal(store.describe().executing, 1)
    assert.equal(typeof store.find(plan.id).firedAt, 'number')

    // Executed: it leaves the plan list — the dashboard has nothing to draw — and enters the history.
    assert.equal(store.complete(plan.id, { detail: 'the task was continued' }).ok, true)
    assert.equal(store.list().length, 0)
    assert.equal(store.describe().plans.length, 0)
    assert.equal(store.describe().history.length, 1)
    assert.equal(store.history()[0].detail, 'the task was continued')
    assert.equal(store.complete(plan.id).ok, false, 'a plan cannot complete twice')

    // A removal before it fires is also a history entry, with the state that says so.
    const second = createPlan({ mode: 'after', afterMinutes: 15 }, { now: NOW }).plan
    store.add(second)
    assert.equal(store.remove(second.id).ok, true)
    assert.equal(store.list().length, 0)
    assert.equal(store.history().some((entry) => entry.id === second.id && entry.state === PLAN_STATES.CANCELLED), true)

    // The file is real JSON, written through a temporary file that is gone.
    const file = path.join(dir, 'data', 'state', 'reboot-plans.json')
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(parsed.version, 1)
    assert.equal(fs.existsSync(`${file}.tmp`), false)

    // The intent is the thing that spans the restart: written, read by a fresh store, then cleared.
    store.setIntent({ planId: plan.id, target: { kind: TARGET_KINDS.SUB_WORKER }, label: 'continue' })
    const reopened = storeIn(dir)
    assert.equal(reopened.intent().planId, plan.id)
    assert.equal(typeof reopened.intent().writtenAt, 'number')
    assert.equal(reopened.clearIntent(), true)
    assert.equal(reopened.intent(), null)
    assert.equal(storeIn(dir).intent(), null)

    // A corrupt intent file is no intent, not a crash.
    fs.writeFileSync(path.join(dir, 'data', 'state', 'reboot-resume.json'), '{ not json', 'utf8')
    assert.equal(storeIn(dir).intent(), null)
  } finally {
    dispose()
  }
})

test('the operating system half builds exact argv, and never a shell string', () => {
  const { platform, argv } = fakePlatform()
  assert.equal(platform.supported, true)
  assert.equal(platform.describe().registryPath, `${RUN_KEY}\\${RUN_VALUE}`)

  const armed = platform.armRelaunch()
  assert.equal(armed.ok, true)
  const [program, ...args] = argv()[0]
  assert.equal(program, 'reg')
  assert.deepEqual(args.slice(0, 2), ['add', RUN_KEY])
  assert.deepEqual(args.slice(2, 6), ['/v', RUN_VALUE, '/t', 'REG_SZ'])
  assert.equal(args[6], '/d')
  assert.equal(args[8], '/f')
  // The value is a command line that starts the application with the resume flag.
  assert.match(args[7], /^"C:\\Apps\\DS-Hns\\DS-Hns\.exe"/)
  assert.match(args[7], new RegExp(RESUME_FLAG))
  assert.equal(platform.relaunch().command.length >= 2, true)

  platform.disarmRelaunch()
  assert.deepEqual(argv()[1].slice(0, 2), ['reg', 'delete'])
  platform.relaunchArmed()
  assert.deepEqual(argv()[2].slice(0, 2), ['reg', 'query'])

  // "Nothing to delete" is the state the caller wanted.
  const absent = fakePlatform({ answers: { 'reg delete': { ok: false, code: REBOOT_REASONS.COMMAND_FAILED, stderr: 'ERROR: The system was unable to find the specified registry key or value.' } } })
  const disarmed = absent.platform.disarmRelaunch()
  assert.equal(disarmed.ok, true)
  assert.equal(disarmed.alreadyAbsent, true)

  // The restart itself: every field its own argument, the seconds clamped, the reason sanitised.
  const restart = platform.scheduleRestart({ seconds: 45.6, reason: 'reboot "now" & shutdown /a\r\nnext' })
  assert.equal(restart.ok, true)
  const restartArgv = argv().at(-1)
  assert.equal(restartArgv[0], 'shutdown')
  assert.deepEqual(restartArgv.slice(1, 4), ['/r', '/t', '46'])
  assert.equal(restartArgv[4], '/c')
  assert.equal(restartArgv.length, 6, 'the reason must be exactly one argument')
  // A quote or a newline could end the argument; `&` cannot, because there is no shell here — which
  // is also why the assertion is about the argument, not about a list of shell metacharacters.
  assert.equal(/["\r\n]/.test(restartArgv[5]), false, 'a reason must not be able to end its own argument')
  assert.equal(restartArgv[5], 'reboot now & shutdown /a next')
  assert.equal(safeReason('x'.repeat(9999)).length, 400)
  assert.equal(platform.scheduleRestart({ seconds: -5, reason: 'x' }).seconds, 0)
  assert.equal(platform.scheduleRestart({ seconds: 999_999, reason: 'x' }).seconds, 86_400)

  platform.cancelRestart()
  assert.deepEqual(argv().at(-1).slice(1), ['/a'])
})

test('a platform that cannot restart says so instead of pretending', () => {
  const { platform, calls } = fakePlatform({ platform: 'linux' })
  assert.equal(platform.supported, false)
  for (const result of [platform.armRelaunch(), platform.disarmRelaunch(), platform.scheduleRestart({ seconds: 10 }), platform.cancelRestart()]) {
    assert.equal(result.ok, false)
    assert.equal(result.code, REBOOT_REASONS.UNSUPPORTED)
  }
  assert.equal(platform.relaunchArmed().armed, false)
  assert.equal(calls.length, 0, 'an unsupported platform must not call anything')
  assert.match(platform.describe().note, /not implemented for linux/)
})

/** The coordinator with a fake platform and fake targets, so the sequence can be read off. */
function coordinatorHarness(options = {}) {
  const { dir, dispose } = scratch()
  let clock = NOW
  const store = storeIn(dir, () => clock)
  const { platform, calls, argv } = fakePlatform({ answers: options.answers })
  const events = []
  const target = options.target || {
    status: () => ({ running: true, stage: null, state: 'RUNNING' }),
    park: async () => ({ ok: true, detail: 'parked by the test' }),
    resume: async () => ({ ok: true, detail: 'resumed by the test' })
  }
  if (options.status) target.status = options.status
  if (options.park) target.park = options.park
  if (options.resume) target.resume = options.resume
  if (options.parkPolicy) target.parkPolicy = options.parkPolicy
  const targets = {}
  if (options.kind !== TARGET_KINDS.ENGINEERING) targets.subWorker = target
  if (options.kind !== TARGET_KINDS.SUB_WORKER) targets.engineering = target
  const coordinator = createRebootCoordinator({
    store,
    platform,
    targets,
    now: () => clock,
    log: (line) => events.push(line),
    parkTimeoutMs: options.parkTimeoutMs || 120_000
  })
  return {
    store,
    coordinator,
    calls,
    argv,
    events,
    target,
    advance: (ms) => {
      clock += ms
    },
    plan: (input = {}) => {
      const created = createPlan({ mode: 'after', afterMinutes: 1, ...input }, { now: clock })
      assert.equal(created.ok, true, created.reason)
      store.add(created.plan)
      return created.plan
    },
    dispose
  }
}

test('a plan that is not due does nothing at all', async () => {
  const harnessed = coordinatorHarness()
  try {
    const plan = harnessed.plan({ afterMinutes: 30 })
    const reports = await harnessed.coordinator.tick()
    assert.deepEqual(reports, [])
    assert.equal(harnessed.store.find(plan.id).state, PLAN_STATES.PENDING)
    assert.equal(harnessed.calls.length, 0, 'nothing may be asked of the machine before the moment')
  } finally {
    harnessed.dispose()
  }
})

test('a restart with no target is issued, with no intent and no relaunch', async () => {
  const harnessed = coordinatorHarness()
  try {
    const plan = harnessed.plan({ afterMinutes: 1, target: { kind: TARGET_KINDS.NONE }, label: '只重启' })
    harnessed.advance(60_000)
    const reports = await harnessed.coordinator.tick()
    assert.equal(reports.length, 1)
    assert.equal(reports[0].ok, true)
    assert.equal(reports[0].armed.skipped, true)
    assert.deepEqual(harnessed.argv(), [['shutdown', '/r', '/t', '60', '/c', 'scheduled from the Mega dock']])
    assert.equal(harnessed.store.intent(), null, 'there is nothing to continue, so there is no intent to write')
    assert.equal(harnessed.store.find(plan.id).state, PLAN_STATES.EXECUTING)
    assert.equal(harnessed.store.describe().plans[0].state, PLAN_STATES.EXECUTING)
  } finally {
    harnessed.dispose()
  }
})

test('a restart for a task waits for a boundary, and then fires with intent first', async () => {
  let parkCalls = 0
  const harnessed = coordinatorHarness({
    status: () => ({ running: true, stage: 'TESTING', state: 'RUNNING' }),
    park: async () => {
      parkCalls += 1
      return { ok: true, pending: true, detail: 'parking: the worker is finishing its current stage' }
    }
  })
  try {
    const plan = harnessed.plan({ afterMinutes: 0.5, target: { kind: TARGET_KINDS.SUB_WORKER }, label: '继续长期任务' })
    harnessed.advance(30_000)
    const waiting = await harnessed.coordinator.tick()
    assert.equal(waiting[0].waiting, 'parking: the worker is finishing its current stage')
    assert.equal(harnessed.store.find(plan.id).state, PLAN_STATES.WAITING_BOUNDARY, 'a mid-stage task must hold the restart')
    assert.equal(harnessed.calls.length, 0, 'nothing may be asked of the machine while the task is mid-stage')
    assert.equal(parkCalls, 1, 'the worker is asked to stop once, not once per tick')

    // The stage ends and the worker reports it parked: the next tick releases the restart.
    harnessed.target.status = () => ({ running: true, stage: null, state: 'PAUSED' })
    const released = await harnessed.coordinator.tick()
    assert.equal(released[0].ok, true)
    assert.equal(harnessed.store.find(plan.id).state, PLAN_STATES.EXECUTING)
    assert.equal(parkCalls, 1, 'a worker that is already parked must not be asked again')
    // The intent exists, then the relaunch, then the machine: the order is the contract.
    assert.equal(harnessed.store.intent().planId, plan.id)
    assert.match(harnessed.store.intent().parked, /the worker is already parked/)
    assert.deepEqual(harnessed.argv().map((entry) => [entry[0], entry[1]]), [['reg', 'add'], ['shutdown', '/r']])
  } finally {
    harnessed.dispose()
  }
})

test('a stage boundary releases a waiting plan immediately, not on the next tick', async () => {
  const harnessed = coordinatorHarness({
    status: () => ({ running: true, stage: 'IMPLEMENTING', state: 'RUNNING' }),
    park: async () => ({ ok: true, pending: true, detail: 'parking' })
  })
  try {
    const plan = harnessed.plan({ afterMinutes: 0.1, target: { kind: TARGET_KINDS.SUB_WORKER } })
    harnessed.advance(10_000)
    await harnessed.coordinator.tick()
    assert.equal(harnessed.store.find(plan.id).state, PLAN_STATES.WAITING_BOUNDARY)

    // The worker reports the stage is over and it is parked.
    harnessed.target.status = () => ({ running: true, stage: null, state: 'PAUSED' })
    harnessed.target.park = async () => ({ ok: true, detail: 'parked' })
    const boundary = await harnessed.coordinator.handleBoundary({ kind: TARGET_KINDS.SUB_WORKER, stage: 'TESTING' })
    assert.equal(boundary.acted, true)
    assert.equal(boundary.waiting, 1)
    assert.equal(harnessed.store.find(plan.id).state, PLAN_STATES.EXECUTING)
    // A boundary for a target nobody is waiting on is a no-op.
    assert.equal((await harnessed.coordinator.handleBoundary({ kind: 'printer' })).acted, false)
  } finally {
    harnessed.dispose()
  }
})

test('a park that never settles fails the plan instead of killing the task', async () => {
  const harnessed = coordinatorHarness({
    parkTimeoutMs: 1000,
    status: () => ({ running: true, stage: 'IMPLEMENTING', state: 'RUNNING' }),
    park: async () => ({ ok: true, pending: true, detail: 'parking forever' })
  })
  try {
    const plan = harnessed.plan({ afterMinutes: 0.1, target: { kind: TARGET_KINDS.SUB_WORKER } })
    harnessed.advance(10_000)
    await harnessed.coordinator.tick()
    assert.equal(harnessed.store.find(plan.id).state, PLAN_STATES.WAITING_BOUNDARY)

    // The deadline is measured from the moment the plan started waiting.
    const waiting = harnessed.store.find(plan.id)
    harnessed.advance(2000)
    const reports = await harnessed.coordinator.tick()
    assert.equal(reports[0].ok, false)
    assert.equal(reports[0].code, 'REBOOT_PARK_FAILED')
    assert.match(reports[0].detail, /did not reach a boundary/)
    assert.equal(harnessed.calls.length, 0, 'a task that will not park must never be restarted over')
  } finally {
    harnessed.dispose()
  }
})

test('a restart that cannot bring the application back is refused, and the task is resumed', async () => {
  let resumed = null
  const harnessed = coordinatorHarness({
    answers: { 'reg add': { ok: false, code: REBOOT_REASONS.COMMAND_FAILED, reason: 'access denied' } },
    resume: async (intent) => {
      resumed = intent
      return { ok: true, detail: 'the worker was resumed' }
    }
  })
  try {
    const plan = harnessed.plan({ afterMinutes: 0.5, target: { kind: TARGET_KINDS.SUB_WORKER } })
    harnessed.advance(30_000)
    const reports = await harnessed.coordinator.tick()
    assert.equal(reports[0].ok, false)
    assert.equal(reports[0].code, REBOOT_REASONS.COMMAND_FAILED)
    assert.match(reports[0].detail, /could not be set to come back/)
    assert.equal(harnessed.store.find(plan.id).state, PLAN_STATES.FAILED)
    assert.equal(harnessed.store.intent(), null, 'a refused restart must not leave an intent behind')
    assert.equal(harnessed.argv().some((entry) => entry[0] === 'shutdown'), false, 'no restart may be issued without a relaunch')
    assert.equal(resumed && resumed.planId, plan.id, 'the parked task must be resumed when the restart is refused')
  } finally {
    harnessed.dispose()
  }
})

test('a shutdown that fails leaves no intent and no armed relaunch', async () => {
  const harnessed = coordinatorHarness({
    answers: { 'shutdown /r': { ok: false, code: REBOOT_REASONS.COMMAND_FAILED, reason: 'shutdown refused' } }
  })
  try {
    const plan = harnessed.plan({ afterMinutes: 0.5, target: { kind: TARGET_KINDS.SUB_WORKER } })
    harnessed.advance(30_000)
    const reports = await harnessed.coordinator.tick()
    assert.equal(reports[0].ok, false)
    assert.match(reports[0].detail, /could not be issued/)
    assert.equal(harnessed.store.find(plan.id).state, PLAN_STATES.FAILED)
    assert.equal(harnessed.store.intent(), null)
    assert.equal(harnessed.argv().some((entry) => entry[0] === 'reg' && entry[1] === 'add'), true)
    assert.equal(harnessed.argv().some((entry) => entry[0] === 'reg' && entry[1] === 'delete'), true, 'the armed relaunch must be undone')
  } finally {
    harnessed.dispose()
  }
})

test('after the machine comes back, the intent continues the task and the plan is gone', async () => {
  let resumed = null
  const harnessed = coordinatorHarness({
    resume: async (intent) => {
      resumed = intent
      return { ok: true, detail: 'the worker continued its task' }
    }
  })
  try {
    const plan = harnessed.plan({ afterMinutes: 0.5, target: { kind: TARGET_KINDS.SUB_WORKER } })
    harnessed.advance(30_000)
    await harnessed.coordinator.tick()
    assert.equal(harnessed.store.find(plan.id).state, PLAN_STATES.EXECUTING)

    // A fresh application: a new store and coordinator over the same files, exactly as after a reboot.
    const fresh = createRebootCoordinator({
      store: storeIn(harnessed.store.file ? path.dirname(path.dirname(path.dirname(harnessed.store.file))) : '.', () => NOW + 120_000),
      platform: harnessed.coordinator ? createRebootPlatform({ platform: 'win32', log: () => {}, run: () => ({ ok: true, command: [] }) }) : null,
      targets: { subWorker: harnessed.target },
      now: () => NOW + 120_000,
      log: () => {}
    })
    const outcome = await fresh.resumeOnStartup()
    assert.equal(outcome.resumed, true)
    assert.equal(resumed.planId, plan.id)
    assert.equal(resumed.target.kind, TARGET_KINDS.SUB_WORKER)
    assert.equal(outcome.reports[0].detail, 'the task was continued after the restart (the worker continued its task)')
    assert.equal(fresh.describe().plans.length, 0, 'a plan that has run must be gone from the dashboard')
    assert.equal(fresh.describe().history.length, 1)
  } finally {
    harnessed.dispose()
  }
})

test('a plan can be deleted before it fires, and aborted during its grace period', async () => {
  const harnessed = coordinatorHarness()
  try {
    const plan = harnessed.plan({ afterMinutes: 5 })
    const removed = await harnessed.coordinator.cancel(plan.id)
    assert.equal(removed.ok, true)
    assert.equal(removed.aborted, false, 'a plan that has not fired has nothing to abort')
    assert.equal(harnessed.store.list().length, 0)
    assert.equal((await harnessed.coordinator.cancel(plan.id)).ok, false)

    // A plan already in its grace period: cancelling it must also abort the restart.
    const second = harnessed.plan({ afterMinutes: 0.5, target: { kind: TARGET_KINDS.SUB_WORKER }, graceSeconds: 60 })
    harnessed.advance(30_000)
    await harnessed.coordinator.tick()
    assert.equal(harnessed.store.find(second.id).state, PLAN_STATES.EXECUTING)
    const aborted = await harnessed.coordinator.cancel(second.id)
    assert.equal(aborted.ok, true)
    assert.equal(aborted.aborted, true)
    assert.equal(harnessed.store.intent(), null)
    assert.equal(harnessed.store.list().length, 0)
    const shutdownCalls = harnessed.argv().filter((entry) => entry[0] === 'shutdown')
    assert.deepEqual(shutdownCalls.at(-1).slice(1), ['/a'])
    assert.equal(harnessed.argv().some((entry) => entry[0] === 'reg' && entry[1] === 'delete'), true)
  } finally {
    harnessed.dispose()
  }
})

test('an engineering episode is only restarted in a phase its own state machine allows', async () => {
  // The parkable phases are the runtime's, not a second list kept here.
  assert.deepEqual(PARKABLE_PHASES, ENGINEERING_PARKABLE)
  assert.ok(PARKABLE_PHASES.length >= 1)

  const parkable = PARKABLE_PHASES[0]
  const harnessed = coordinatorHarness({
    kind: TARGET_KINDS.ENGINEERING,
    status: () => ({ running: true, phase: 'EDITING', episode: 'ep-1' }),
    // An episode is only stopped in a phase its state machine allows, so the adapter says so and the
    // coordinator waits instead of asking.
    parkPolicy: 'boundary-first'
  })
  try {
    const plan = harnessed.plan({ afterMinutes: 0.5, target: { kind: TARGET_KINDS.ENGINEERING, id: 'ep-1' } })
    harnessed.advance(30_000)
    await harnessed.coordinator.tick()
    assert.equal(harnessed.store.find(plan.id).state, PLAN_STATES.WAITING_BOUNDARY)
    assert.match(harnessed.store.find(plan.id).detail, /EDITING, which is not a parkable phase/)

    harnessed.target.status = () => ({ running: true, phase: parkable, episode: 'ep-1' })
    const reports = await harnessed.coordinator.tick()
    assert.equal(reports[0].ok, true)
    assert.equal(harnessed.store.intent().targetState.phase, parkable)
    assert.equal(harnessed.store.find(plan.id).state, PLAN_STATES.EXECUTING)
  } finally {
    harnessed.dispose()
  }
})

test('the coordinator describes the mechanism, the plans and the next one to fire', async () => {
  const harnessed = coordinatorHarness({ status: () => ({ running: true, stage: 'TESTING', state: 'RUNNING' }) })
  try {
    const far = harnessed.plan({ afterMinutes: 60, target: { kind: TARGET_KINDS.SUB_WORKER }, label: 'later' })
    const near = harnessed.plan({ afterMinutes: 5, target: { kind: TARGET_KINDS.SUB_WORKER }, label: 'sooner' })
    const described = harnessed.coordinator.describe()
    assert.equal(described.plans.length, 2)
    assert.equal(described.next.id, near.id, 'the dashboard shows the nearest plan')
    assert.equal(described.next.label, 'sooner')
    assert.equal(described.platform.supported, true)
    assert.match(described.platform.restart, /shutdown \/r/)
    assert.equal(described.statuses.subWorker.stage, 'TESTING')
    assert.match(described.boundary.subWorker, /TESTING/)
    assert.equal(described.platform.relaunch.command.includes(RESUME_FLAG), true)

    // Once the nearest one has run, "next" moves to the one after it.
    harnessed.advance(5 * 60_000)
    await harnessed.coordinator.tick()
    assert.equal(harnessed.coordinator.describe().next.id, far.id)
  } finally {
    harnessed.dispose()
  }
})
