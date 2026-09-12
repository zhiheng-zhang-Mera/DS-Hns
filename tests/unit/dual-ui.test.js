'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/**
 * Dual-UI (Update-Plan/Dual-UI.md).
 *
 * The two frontends share one Harness backend, and these are the properties that
 * make that safe to ship:
 *
 *   state      the mode is durable, defaults to Daily, and junk never wins
 *   model      the native frontend reads a documented HNS vocabulary only
 *   backend    the Harness is reached through RPC + its own durable journal
 *   adapter    a backend that changed shape degrades, it never throws
 *   sync       a switch carries the session across and says what it could not do
 *   manager    one switch at a time, a queue instead of a race, a fallback
 *   probe      eight contracts, a report, and "blocked" really means "hold"
 */
const ROOT = path.resolve(__dirname, '..', '..')
// Read with LF endings: several assertions below match multi-line source
// patterns, and a checkout that rewrote line endings used to turn them into
// line-ending assertions (invisible on Linux, red on a Windows runner).
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8').replace(/\r\n/g, '\n')

const stateModule = require('../../app/frontend-mode/state.cjs')
const model = require('../../app/frontend-mode/model.cjs')
const { createBackendBridge } = require('../../app/frontend-mode/backend.cjs')
const { createAdapter } = require('../../app/frontend-mode/adapter.cjs')
const { createSync } = require('../../app/frontend-mode/sync.cjs')
const { createModeManager, STATE } = require('../../app/frontend-mode/manager.cjs')
const { createCompatibilityProbe, VERDICT } = require('../../app/frontend-mode/probe.cjs')
const { createFrontendModeRuntime, DEFAULT_STARTUP_MODE } = require('../../app/frontend-mode/index.cjs')

/* ------------------------------- fixtures -------------------------------- */

function tempDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dsh-dual-${tag}-`))
}

/** A realistic journal: two messages, a tool call/result pair, an unknown event. */
function writeJournal(root, sessionId, { group = 'g1', withUnknown = true } = {}) {
  const dir = path.join(root, group, sessionId)
  fs.mkdirSync(dir, { recursive: true })
  const t0 = Date.UTC(2026, 8, 12, 1, 0, 0)
  const lines = [
    { type: 'session', id: sessionId, createdAt: t0, cwd: 'D:\\work', version: 1 },
    { type: 'user/message', seq: 1, time: t0 + 10, data: { source: { kind: 'user' }, message: { content: [{ type: 'text', text: 'hello harness' }] } } },
    { type: 'tool/call', seq: 2, time: t0 + 20, data: { callId: 'call-1', name: 'read_file', input: { path: 'a.txt' } } },
    { type: 'tool/result', seq: 3, time: t0 + 30, data: { callId: 'call-1', result: 'file body' } },
    { type: 'assistant/message', seq: 4, time: t0 + 40, data: { message: { content: [{ type: 'text', text: 'done' }] } } },
    ...(withUnknown ? [{ type: 'some/new-event', seq: 5, time: t0 + 50, data: {} }] : []),
    { type: 'turn/end', seq: withUnknown ? 6 : 5, time: t0 + 60, data: { reason: { kind: 'success' } } }
  ]
  fs.writeFileSync(path.join(dir, 'session.jsonl'), lines.map((line) => JSON.stringify(line)).join('\n') + '\n')
  return { dir, file: path.join(dir, 'session.jsonl'), t0 }
}

/** A fake OfficialSessionClient: unary RPC only, recorded. */
function fakeClient({ sessions = [], fail = null } = {}) {
  const calls = []
  return {
    calls,
    async call(endpoint) {
      calls.push({ endpoint })
      if (fail) throw new Error(fail)
      if (endpoint === 'session/list') return { items: sessions }
      return { ok: true }
    },
    async createSession() {
      calls.push({ endpoint: 'session/create' })
      return { sessionId: 'created-1' }
    },
    async promptSession({ sessionId }) {
      calls.push({ endpoint: 'session/prompt', sessionId })
      return { accepted: true }
    },
    async cancelSession(sessionId) {
      calls.push({ endpoint: 'session/cancel', sessionId })
      return { accepted: true }
    }
  }
}

/* -------------------------------- state ---------------------------------- */

test('mode state defaults to Daily and round-trips through disk', () => {
  const dir = tempDir('state')
  const file = path.join(dir, 'frontend-mode.json')
  const state = stateModule.createModeState({ file })
  assert.equal(state.getMode(), 'daily', 'the default frontend mode is daily')
  assert.equal(state.sessionFor('daily'), null)

  state.setMode('work')
  state.setSession('work', 'sess-work')
  state.setSession('daily', 'sess-daily')

  const reloaded = stateModule.createModeState({ file })
  assert.equal(reloaded.getMode(), 'work')
  assert.equal(reloaded.sessionFor('work'), 'sess-work')
  assert.equal(reloaded.sessionFor('daily'), 'sess-daily', 'each mode keeps its own remembered session')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('junk in the mode state file degrades to Daily instead of propagating', () => {
  const dir = tempDir('state-junk')
  const file = path.join(dir, 'frontend-mode.json')
  fs.writeFileSync(file, JSON.stringify({ frontendMode: 'hologram', sessions: { daily: 42, work: 'ok' } }))
  const state = stateModule.createModeState({ file })
  assert.equal(state.getMode(), 'daily')
  assert.equal(state.sessionFor('work'), 'ok')
  assert.equal(state.sessionFor('daily'), null, 'a non-string session id is not remembered')
  assert.match(state.describe().issue || '', /unknown frontendMode/)

  fs.writeFileSync(file, '{ this is not json')
  const broken = stateModule.createModeState({ file })
  assert.equal(broken.getMode(), 'daily')
  assert.match(broken.describe().issue || '', /unreadable/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('normalizeMode accepts only the two canonical modes', () => {
  assert.equal(stateModule.normalizeMode('WORK'), 'work')
  assert.equal(stateModule.normalizeMode(' daily '), 'daily')
  assert.equal(stateModule.normalizeMode(''), 'daily')
  assert.equal(stateModule.normalizeMode('official'), 'daily')
  assert.equal(stateModule.otherMode('daily'), 'work')
  assert.equal(stateModule.otherMode('work'), 'daily')
})

test('the product opens on Daily unless a run overrides it (Daily-UX 任务 1)', () => {
  assert.equal(DEFAULT_STARTUP_MODE, 'daily', 'Daily is the product default')
  const runtime = createFrontendModeRuntime({ stateFile: null, applyVisibility: () => {} })
  assert.equal(runtime.manager.current(), 'daily')
  assert.equal(runtime.manager.machineState(), 'DAILY_ACTIVE')

  const overridden = createFrontendModeRuntime({ stateFile: null, startupMode: 'work', applyVisibility: () => {} })
  assert.equal(overridden.manager.current(), 'work', 'DSH_FRONTEND_MODE=work wins for one run')

  // The mode a user last chose is remembered for session memory but does not
  // decide which frontend the next launch mounts.
  const dir = tempDir('startup-mode')
  const file = path.join(dir, 'mode.json')
  const state = stateModule.createModeState({ file })
  state.setMode('work')
  const resumed = createFrontendModeRuntime({ stateFile: file, applyVisibility: () => {} })
  assert.equal(resumed.manager.current(), 'daily')
  assert.equal(resumed.state.describe().frontendMode, 'work', 'the preference is preserved, not overwritten')
  fs.rmSync(dir, { recursive: true, force: true })
})

/* -------------------------------- model ---------------------------------- */

test('the HNS model defines every entity the plan names (任务 9)', () => {
  const described = model.describeModel()
  for (const entity of ['Session', 'Message', 'ToolEvent', 'Task', 'ComposerState', 'BackendState', 'SettingsState']) {
    assert.ok(described.entities.includes(entity), `${entity} is part of the model`)
  }
})

test('normalizers are total: a backend shape change yields a value, never a throw', () => {
  assert.equal(model.session({}).id, null)
  assert.equal(model.session({}).status, 'IDLE')
  assert.equal(model.message({}).role, 'system')
  assert.equal(model.message({ content: [{ type: 'text', text: 'a' }, { type: 'tool_call', name: 't' }] }).content, 'a')
  assert.deepEqual(model.message({ content: [{ type: 'tool_call', name: 't', input: { x: 1 } }] }).toolCalls, [{ id: null, name: 't', input: { x: 1 } }])
  assert.equal(model.toolEvent({}).status, 'running')
  assert.equal(model.task({}).status, 'PENDING')
  assert.equal(model.settingsState(null).available, false)
  assert.equal(model.backendState({ state: 'nonsense' }).state, 'unknown')
  assert.equal(model.session({ error: 'boom' }).error.message, 'boom')
  assert.equal(model.session({ firstUserText: 'first prompt' }).title, 'first prompt')
})

test('a durable journal folds into messages, tool events and a turn verdict', () => {
  const dir = tempDir('model-journal')
  const { file } = writeJournal(dir, 'sess-1')
  const events = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
  const timeline = model.timelineFromJournal(events, { sessionId: 'sess-1' })
  assert.deepEqual(timeline.messages.map((entry) => entry.role), ['user', 'assistant'])
  assert.equal(timeline.messages[0].content, 'hello harness')
  assert.equal(timeline.messages[1].content, 'done')
  assert.equal(timeline.toolEvents.length, 1, 'the call and its result are one tool event')
  assert.equal(timeline.toolEvents[0].name, 'read_file')
  assert.equal(timeline.toolEvents[0].status, 'ok')
  assert.equal(timeline.toolEvents[0].output, 'file body')
  assert.equal(timeline.turnEnd.reason, 'success')
  assert.equal(timeline.unknown.length, 1, 'an unrecognised event is counted, not dropped silently')
  assert.equal(timeline.unknown[0].type, 'some/new-event')
  assert.equal(timeline.messages.length, 2, 'the session header is not a message and not a drift')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('the session header line is classified, not reported as schema drift', () => {
  assert.equal(model.classifyEvent({ type: 'session', id: 's', createdAt: 5 }).kind, 'header')
  assert.equal(model.classifyEvent({ type: 'session', id: 's' }).id, 's')
})

test('a tool call without a result stays running', () => {
  const timeline = model.timelineFromJournal([
    { type: 'tool/call', seq: 1, time: 1, data: { callId: 'c', name: 'bash', input: { cmd: 'ls' } } }
  ])
  assert.equal(timeline.toolEvents.length, 1)
  assert.equal(timeline.toolEvents[0].status, 'running')
  assert.equal(timeline.toolEvents[0].finishedAt, null)
})

test('a failing tool result becomes an errored tool event', () => {
  const timeline = model.timelineFromJournal([
    { type: 'tool/call', seq: 1, time: 1, data: { callId: 'c', name: 'bash' } },
    { type: 'tool/result', seq: 2, time: 2, data: { callId: 'c', isError: true, error: { code: 'E_BASH', message: 'exit 1' } } }
  ])
  assert.equal(timeline.toolEvents[0].status, 'error')
  assert.equal(timeline.toolEvents[0].error.code, 'E_BASH')
  assert.equal(timeline.toolEvents[0].error.message, 'exit 1')
})

test('the composer state is derived from the real session, not guessed', () => {
  const idle = model.composerState({ session: { id: 's', running: false }, ready: true })
  assert.equal(idle.canSend, true)
  assert.equal(idle.canStop, false)
  const running = model.composerState({ session: { id: 's', running: true }, ready: true })
  assert.equal(running.canSend, true)
  assert.equal(running.canStop, true)
  assert.equal(running.running, true)
  const noSession = model.composerState({ session: null, ready: true })
  assert.equal(noSession.canSend, false)
  assert.equal(noSession.canCreateSession, true)
  const offline = model.composerState({ session: { id: 's' }, ready: false, reason: 'backend down' })
  assert.equal(offline.canSend, false)
  assert.equal(offline.reason, 'backend down')
})

/* ------------------------------- backend --------------------------------- */

test('the backend bridge lists sessions and reads the durable journal', async () => {
  const dir = tempDir('backend')
  const { file } = writeJournal(dir, 'sess-1')
  const client = fakeClient({ sessions: [{ sessionId: 'sess-1', running: true, updatedAt: 5 }] })
  const bridge = createBackendBridge({ client, sessionsRoot: dir })

  const listed = await bridge.listSessions()
  assert.equal(listed.ok, true)
  assert.equal(listed.source, 'rpc')
  assert.equal(listed.items.length, 1)

  const journal = bridge.readJournal('sess-1')
  assert.equal(journal.ok, true)
  assert.equal(journal.file, file)
  assert.equal(journal.events.length, 7)

  const missing = bridge.readJournal('no-such-session')
  assert.equal(missing.ok, false)
  assert.equal(missing.reason, 'journal_missing')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a failing RPC is reported as data and the journal list still answers', async () => {
  const dir = tempDir('backend-fail')
  writeJournal(dir, 'sess-9')
  const bridge = createBackendBridge({ client: fakeClient({ fail: 'transport exploded' }), sessionsRoot: dir })
  const listed = await bridge.listSessions()
  assert.equal(listed.ok, false)
  assert.equal(listed.reason, 'backend_unavailable')
  assert.match(listed.message, /transport exploded/)
  assert.deepEqual(listed.items, [])

  const degraded = createBackendBridge({ client: null, sessionsRoot: dir })
  const fallback = await degraded.listSessions()
  assert.equal(fallback.source, 'journal')
  assert.equal(fallback.degraded, true)
  assert.equal(fallback.items.length, 1)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('capabilities probe the required routes and never throw', async () => {
  const dir = tempDir('capability')
  const bridge = createBackendBridge({ client: fakeClient(), sessionsRoot: dir })
  const capability = await bridge.capabilities()
  assert.equal(capability.ok, true)
  assert.equal(capability.reachable, true)
  assert.deepEqual(capability.required, ['session/list', 'session/create', 'session/prompt', 'session/cancel'])
  assert.equal(typeof capability.latencyMs, 'number')

  const broken = createBackendBridge({ client: fakeClient({ fail: 'nope' }), sessionsRoot: dir })
  const failed = await broken.capabilities()
  assert.equal(failed.ok, false)
  assert.equal(failed.reachable, false)
  assert.equal(failed.missing.length, 0, 'a transport failure is unreachable, not "route missing"')
  fs.rmSync(dir, { recursive: true, force: true })
})

/* ------------------------------- adapter --------------------------------- */

test('the adapter snapshot is the whole native model and never a backend route', async () => {
  const dir = tempDir('adapter')
  const { t0 } = writeJournal(dir, 'sess-a')
  const client = fakeClient({ sessions: [{ sessionId: 'sess-a', running: false, updatedAt: t0 + 60 }] })
  const bridge = createBackendBridge({ client, sessionsRoot: dir })
  const adapter = createAdapter({
    bridge,
    harnessVersion: '0.1.5-rc.1',
    tasks: () => [{ id: 't1', status: 'RUNNING', prompt: 'do work' }],
    settings: () => ({ model: 'deepseek-v4-flash', models: ['deepseek-v4-flash'], permissionMode: 'workspace-write' })
  })
  const snapshot = await adapter.snapshot()
  assert.equal(snapshot.ok, true)
  assert.equal(snapshot.sessions.length, 1)
  assert.equal(snapshot.session.id, 'sess-a')
  assert.equal(snapshot.messages.length, 2)
  assert.equal(snapshot.toolEvents.length, 1)
  assert.equal(snapshot.tasks.length, 1)
  assert.equal(snapshot.composer.canSend, true)
  assert.equal(snapshot.settings.model, 'deepseek-v4-flash')
  assert.equal(snapshot.backend.state, 'ready')
  assert.equal(snapshot.backend.version, '0.1.5-rc.1')
  assert.equal(JSON.stringify(snapshot).includes('session/prompt'), false, 'no route name reaches the renderer')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('the adapter degrades when there is no bridge at all', async () => {
  const adapter = createAdapter({ bridge: null })
  const snapshot = await adapter.snapshot()
  assert.equal(snapshot.ok, false)
  assert.equal(snapshot.sessions.length, 0)
  assert.equal(snapshot.composer.canSend, false)
  assert.equal(snapshot.backend.state, 'unreachable')
  assert.equal(adapter.describe().model, model.MODEL_VERSION)
})

test('the adapter answers a missing session with structured data, not a throw', () => {
  const dir = tempDir('adapter-missing')
  const bridge = createBackendBridge({ client: fakeClient(), sessionsRoot: dir })
  const adapter = createAdapter({ bridge })
  const result = adapter.openSession('does-not-exist')
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'journal_missing')
  assert.deepEqual(result.messages, [])
  fs.rmSync(dir, { recursive: true, force: true })
})

test('create / prompt / cancel are normalized and never claim success on failure', async () => {
  const dir = tempDir('adapter-actions')
  const bridge = createBackendBridge({ client: fakeClient(), sessionsRoot: dir })
  const adapter = createAdapter({ bridge })
  assert.deepEqual(await adapter.createSession(), { ok: true, sessionId: 'created-1' })
  assert.deepEqual(await adapter.sendPrompt({ sessionId: 's', prompt: '  ' }), { ok: false, reason: 'empty_prompt', message: 'a prompt needs text' })
  assert.equal((await adapter.sendPrompt({ sessionId: 's', prompt: 'go' })).ok, true)
  assert.equal((await adapter.cancelRun('s')).ok, true)
  const offline = createAdapter({ bridge: null })
  assert.equal((await offline.cancelRun('s')).ok, false)
  fs.rmSync(dir, { recursive: true, force: true })
})

/* --------------------------------- sync ---------------------------------- */

test('Daily -> Work records the session; Work -> Daily reopens a session that still exists', () => {
  const dir = tempDir('sync')
  const state = stateModule.createModeState({ file: path.join(dir, 'mode.json') })
  const sync = createSync({ state })
  sync.recordActiveSession('sess-a', { mode: 'daily' })
  assert.deepEqual(sync.planSwitch({ to: 'work', from: 'daily' }).steps, ['record-session', 'sync-official', 'show-official', 'hide-native'])
  const toDaily = sync.planSwitch({ to: 'daily', from: 'work', sessions: [{ id: 'sess-a' }, { id: 'sess-b' }] })
  assert.equal(toDaily.sessionId, 'sess-a')
  assert.deepEqual(toDaily.steps, ['record-session', 'sync-native', 'show-native', 'hide-official'])

  // A session deleted while Work was visible must not be reopened.
  const deleted = sync.planSwitch({ to: 'daily', from: 'work', sessions: [{ id: 'sess-b' }] })
  assert.equal(deleted.sessionId, 'sess-b', 'the newest surviving session wins over a stale id')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('the sync states plainly that it cannot steer the official renderer', () => {
  const dir = tempDir('sync-nav')
  const state = stateModule.createModeState({ file: path.join(dir, 'mode.json') })
  const sync = createSync({ state })
  const navigation = sync.officialNavigation()
  assert.equal(navigation.supported, false)
  assert.match(navigation.reason, /deep link/)
  const plan = sync.planSwitch({ to: 'work', from: 'daily' })
  assert.equal(plan.official.supported, false)
  assert.equal(plan.warnings.length >= 1, true, 'the limitation is reported, not hidden')

  // With a hook, the same switch path starts using it.
  const hooked = createSync({ state, navigateOfficial: () => ({ ok: true }) })
  hooked.recordActiveSession('sess-hooked', { mode: 'daily' })
  assert.equal(hooked.officialNavigation().supported, true)
  assert.deepEqual(hooked.applySession(hooked.planSwitch({ to: 'work', from: 'daily' })).official, { ok: true })
  fs.rmSync(dir, { recursive: true, force: true })
})

test('adopting the newest backend session happens only when nothing was chosen', () => {
  const dir = tempDir('sync-adopt')
  const state = stateModule.createModeState({ file: path.join(dir, 'mode.json') })
  const sync = createSync({ state })
  assert.equal(sync.adoptNewest([{ id: 'newest' }, { id: 'older' }]), 'newest')
  assert.equal(sync.adoptNewest([{ id: 'other' }]), 'newest', 'an explicit choice is never replaced')
  fs.rmSync(dir, { recursive: true, force: true })
})

/* ------------------------------- manager --------------------------------- */

test('the manager runs the documented state machine and applies visibility', () => {
  const dir = tempDir('manager')
  const state = stateModule.createModeState({ file: path.join(dir, 'mode.json') })
  const sync = createSync({ state })
  const applied = []
  const manager = createModeManager({ state, sync, applyVisibility: (payload) => applied.push(payload.mode) })
  assert.equal(manager.current(), 'daily')
  assert.equal(manager.machineState(), STATE.DAILY_ACTIVE)

  assert.equal(manager.switchTo('work').ok, true)
  assert.equal(manager.machineState(), STATE.WORK_ACTIVE)
  assert.equal(manager.switchTo('daily').ok, true)
  assert.equal(manager.machineState(), STATE.DAILY_ACTIVE)
  assert.deepEqual(applied, ['work', 'daily'])
  assert.equal(state.getMode(), 'daily', 'the mode is persisted on every switch')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a switch during a switch is queued and coalesced, never run in parallel', () => {
  const dir = tempDir('manager-race')
  const state = stateModule.createModeState({ file: path.join(dir, 'mode.json') })
  const sync = createSync({ state })
  const applied = []
  let manager = null
  // Re-entrant apply: the second request arrives while the first is in flight.
  manager = createModeManager({
    state,
    sync,
    applyVisibility: (payload) => {
      applied.push(payload.mode)
      if (applied.length === 1) manager.switchTo('daily')
    }
  })
  const result = manager.switchTo('work')
  assert.equal(result.queued, true, 'the queued request is reported')
  assert.deepEqual(applied, ['work', 'daily'], 'exactly two transitions, in order')
  assert.equal(manager.describe().switching, false, 'the lock is released')
  assert.equal(manager.current(), 'daily')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a native failure degrades to Work Mode and keeps everything else alive (任务 20)', () => {
  const dir = tempDir('manager-degrade')
  const state = stateModule.createModeState({ file: path.join(dir, 'mode.json') })
  const sync = createSync({ state })
  sync.recordActiveSession('sess-x', { mode: 'daily' })
  const applied = []
  const manager = createModeManager({ state, sync, applyVisibility: (payload) => applied.push(payload.mode) })
  const result = manager.degrade('renderer crashed')
  assert.equal(result.degraded.reason, 'renderer crashed')
  assert.equal(manager.current(), 'work', 'the product falls back to the official UI')
  assert.equal(manager.isDegraded(), true)
  assert.deepEqual(applied, ['work'])
  assert.equal(state.getMode(), 'daily', 'a fallback must not turn Work Mode into the persisted startup preference')
  assert.equal(sync.activeSession(), 'sess-x', 'the backend session is preserved, not reset')
  const again = manager.degrade('still broken')
  assert.equal(again.alreadyThere, true, 'a degrade while already in Work Mode is not a second switch')
  assert.deepEqual(applied, ['work'])
  manager.switchTo('daily')
  assert.equal(manager.isDegraded(), false)
  fs.rmSync(dir, { recursive: true, force: true })
})

/* -------------------------------- probe ---------------------------------- */

test('the compatibility probe measures all eight contracts and reports them', async () => {
  const dir = tempDir('probe')
  // A clean journal: this fixture measures the compatible path, and the probe's
  // own handling of an unrecognised event is covered by the model tests.
  writeJournal(dir, 'sess-p', { withUnknown: false })
  const bridge = createBackendBridge({ client: fakeClient({ sessions: [{ sessionId: 'sess-p' }] }), sessionsRoot: dir })
  const adapter = createAdapter({ bridge, tasks: () => [], settings: () => ({ model: 'm' }) })
  const probe = createCompatibilityProbe({
    adapter,
    tasks: () => [],
    settings: () => ({ model: 'm' }),
    installedVersion: () => '0.1.5-rc.1',
    latestVersion: async () => '0.1.6-rc.1'
  })
  const report = await probe.run()
  assert.equal(report.from, '0.1.5-rc.1')
  assert.equal(report.to, '0.1.6-rc.1')
  for (const key of ['session', 'messages', 'tasks', 'events', 'settings', 'routes', 'tool_events', 'error_behavior']) {
    assert.ok(report[key], `${key} is part of the report`)
  }
  assert.equal(report.nativeFrontend, VERDICT.COMPATIBLE)
  assert.equal(report.upgrade, 'allowed')
  const verdict = probe.verdict(report)
  assert.equal(verdict.canUpgrade, true)
  assert.equal(verdict.repairTask, null)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a blocked native frontend holds the installed Harness and produces a repair task', async () => {
  const probe = createCompatibilityProbe({
    adapter: null,
    tasks: null,
    settings: null,
    installedVersion: () => '0.1.5-rc.1',
    latestVersion: async () => '0.2.0'
  })
  const report = await probe.run()
  assert.equal(report.nativeFrontend, VERDICT.BLOCKED)
  assert.equal(report.upgrade, 'blocked')
  assert.ok(report.repair.length >= 1, 'the report names what has to be repaired')
  const verdict = probe.verdict(report)
  assert.equal(verdict.canUpgrade, false)
  assert.equal(verdict.hold.keepVersion, '0.1.5-rc.1')
  assert.equal(verdict.hold.workMode, 'continues')
  assert.equal(verdict.hold.restart, false)
  assert.equal(verdict.repairTask.priority, 'P0')

  const unknown = probe.verdict(null)
  assert.equal(unknown.known, false)
  assert.equal(unknown.canUpgrade, false, 'no report is never a green light')
})

/* ------------------------- source-level contracts ------------------------ */

test('the native frontend never reads or styles the official renderer (Gate I)', () => {
  for (const file of ['app/native-ui/app.js', 'app/native-ui/preload.cjs', 'app/native-ui/state/store.js']) {
    const source = read(file)
    assert.equal(/executeJavaScript/.test(source), false, `${file} must not execute script anywhere`)
    for (const forbidden of ['official-renderer', 'official_renderer', 'harness-webview']) {
      assert.equal(source.includes(forbidden), false, `${file} must not reference ${forbidden}`)
    }
  }
  for (const file of ['app/native-ui/components/session-list.js', 'app/native-ui/components/conversation.js', 'app/native-ui/components/tool-activity.js']) {
    const source = read(file)
    // The components only ever query their own ids, never an official selector.
    const selectors = source.match(/querySelector(?:All)?\(([^)]*)\)/g) || []
    for (const selector of selectors) {
      assert.equal(selector.includes('#'), false, `${file} must not query the DOM by selector: ${selector}`)
    }
  }
  const html = read('app/native-ui/index.html')
  // Semantic surfaces (Daily-UX 任务 14): the theme targets these names, not CSS
  // class names of the moment.
  for (const surface of ['root', 'sidebar', 'conversation', 'composer', 'utility']) {
    assert.ok(html.includes(`data-hns-surface="${surface}"`), `the Daily document declares the ${surface} surface`)
  }
  assert.match(html, /script-src 'self'/)
  assert.match(html, /style-src 'self' 'nonce-hns-native-tokens'/)
  const markup = html.replace(/<!--[\s\S]*?-->/g, '')
  assert.equal(/<script(?![^>]*\ssrc=)/i.test(markup), false, 'the native document has no inline script')
  assert.equal(/\son[a-z]+\s*=/i.test(markup), false, 'the native document has no inline handler')
})

test('the native renderer is wired by the shell once, and the overlay is opt-in (任务 1 / 任务 15)', () => {
  const main = read('app/desktop-main.cjs')
  assert.match(main, /DSH_OFFICIAL_OVERLAY/)
  assert.match(main, /official_overlay disabled by default/)
  assert.match(main, /DEPRECATED: official_overlay created because DSH_OFFICIAL_OVERLAY=1/)
  assert.equal(fs.existsSync(path.join(ROOT, 'app', 'extensions', 'mega', 'ui', 'official-overlay.html')), true)
  // The official renderer is only ever resized and navigated, never styled.
  const officialConfig = main.slice(main.indexOf('function configureOfficialWebContents'), main.indexOf('async function createOfficialHarnessView'))
  assert.equal(/insertCSS|executeJavaScript/.test(officialConfig), false)
})

test('the native frontend is covered by the syntax gate and the CI surface check', () => {
  const check = read('scripts/check-syntax.cjs')
  for (const dir of ['frontend-mode', 'native-ui', 'native-ui/components', 'native-ui/state']) {
    assert.ok(check.includes(dir), `check-syntax.cjs must cover ${dir}`)
  }
  const workflow = read('.github/workflows/verify.yml')
  for (const file of ['app/native-ui/index.html', 'app/frontend-mode/manager.cjs', 'app/frontend-mode/probe.cjs']) {
    assert.ok(workflow.includes(file), `the CI surface gate must require ${file}`)
  }
})
