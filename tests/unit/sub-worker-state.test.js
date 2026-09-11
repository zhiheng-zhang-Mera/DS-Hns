'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  TRANSITIONS,
  isWorkerState,
  isExecutionStage,
  canTransition,
  assertTransition,
  isBusyState,
  isTerminalTaskStatus,
  defaultConfig,
  publicConfig,
  emptyState,
  paths,
  SubWorkerStore
} = require('../../app/sub-worker/state.cjs')

/**
 * Lifecycle state machine and persistence (plan §5, §17, §18, AC-11).
 */

function scratchRoot(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-sub-worker-${name}-`))
  fs.mkdirSync(path.join(root, 'config'), { recursive: true })
  return root
}

test('the documented lifecycle chains are legal', () => {
  // OFF -> STARTING -> IDLE
  assert.equal(canTransition('OFF', 'STARTING'), true)
  assert.equal(canTransition('STARTING', 'IDLE'), true)
  // IDLE -> STOPPING -> OFF
  assert.equal(canTransition('IDLE', 'STOPPING'), true)
  assert.equal(canTransition('STOPPING', 'OFF'), true)
  // CRASHED -> RESTART -> IDLE
  assert.equal(canTransition('CRASHED', 'STARTING'), true)
  assert.equal(canTransition('STARTING', 'IDLE'), true)
  // IDLE -> ASSIGNED -> RUNNING -> READY_FOR_REVIEW -> IDLE
  assert.equal(canTransition('IDLE', 'ASSIGNED'), true)
  assert.equal(canTransition('ASSIGNED', 'RUNNING'), true)
  assert.equal(canTransition('RUNNING', 'READY_FOR_REVIEW'), true)
  assert.equal(canTransition('READY_FOR_REVIEW', 'IDLE'), true)
  // PAUSE and TAKE OVER sequences from §15
  assert.equal(canTransition('RUNNING', 'PAUSING'), true)
  assert.equal(canTransition('PAUSING', 'PAUSED'), true)
  assert.equal(canTransition('PAUSED', 'RUNNING'), true)
  assert.equal(canTransition('PAUSED', 'HANDOFF'), true)
  // Failure containment
  assert.equal(canTransition('RUNNING', 'CRASHED'), true)
  assert.equal(canTransition('RUNNING', 'BLOCKED'), true)
  assert.equal(canTransition('BLOCKED', 'IDLE'), true)
  assert.equal(canTransition('FAILED', 'IDLE'), true)
})

test('nonsense transitions are refused', () => {
  assert.equal(canTransition('OFF', 'RUNNING'), false)
  assert.equal(canTransition('OFF', 'IDLE'), false)
  assert.equal(canTransition('OFF', 'PAUSED'), false)
  assert.equal(canTransition('HANDOFF', 'RUNNING'), false)
  assert.equal(canTransition('OFF', 'NOT_A_STATE'), false)
  assert.equal(canTransition('IDLE', 'IDLE'), true, 'a no-op transition is allowed')
  assert.equal(canTransition(undefined, 'IDLE'), false)
  assert.throws(() => assertTransition('OFF', 'RUNNING'), /illegal sub-worker state transition/)
  assert.equal(assertTransition('OFF', 'STARTING'), true)
})

test('states and stages are validated against the documented vocabularies', () => {
  assert.equal(isWorkerState('runNing'), true)
  assert.equal(isWorkerState('SLEEPING'), false)
  assert.equal(isExecutionStage('implementing'), true)
  assert.equal(isExecutionStage('THINKING'), false, 'internal reasoning is not an execution stage')
})

test('busy and terminal classification matches the state machine', () => {
  for (const state of ['ASSIGNED', 'RUNNING', 'PAUSING', 'PAUSED', 'BLOCKED']) {
    assert.equal(isBusyState(state), true, `${state} is busy`)
  }
  for (const state of ['OFF', 'IDLE', 'CRASHED', 'FAILED', 'HANDOFF', 'READY_FOR_REVIEW', 'STOPPING']) {
    assert.equal(isBusyState(state), false, `${state} is not busy`)
  }
  assert.equal(isTerminalTaskStatus('completed'), true)
  assert.equal(isTerminalTaskStatus('blocked'), true)
  assert.equal(isTerminalTaskStatus('cancelled'), true)
  assert.equal(isTerminalTaskStatus('running'), false)
})

test('every state has a transition entry so the table can never go stale', () => {
  const { WORKER_STATES } = require('../../app/sub-worker/protocol.cjs')
  for (const state of WORKER_STATES) {
    assert.ok(Array.isArray(TRANSITIONS[state]), `${state} must declare its legal successors`)
    for (const next of TRANSITIONS[state]) {
      assert.ok(WORKER_STATES.includes(next), `${state} -> ${next} names an unknown state`)
    }
  }
})

test('the documented configuration defaults keep the feature off', () => {
  const defaults = defaultConfig()
  assert.equal(defaults.enabledOnStartup, false, 'AC-01: default startup must not change')
  assert.equal(defaults.maxWorkers, 1, 'Phase 1 is single-worker')
  assert.equal(defaults.autoDelegate, false)
  assert.equal(defaults.workspaceMode, 'isolated_worktree')
  assert.equal(defaults.keepChangesOnStop, true)
  assert.equal(defaults.allowGitCommit, false)
  assert.equal(defaults.showNotifications, true)
})

test('a persisted configuration can never turn the feature on implicitly', () => {
  const coerced = publicConfig({ enabledOnStartup: 'yes', maxWorkers: 0, workspaceMode: 'nowhere' })
  assert.equal(coerced.enabledOnStartup, false, 'only an explicit true enables startup launch')
  assert.equal(coerced.maxWorkers, 1)
  assert.equal(coerced.workspaceMode, 'isolated_worktree')
  assert.equal(publicConfig({ enabledOnStartup: true }).enabledOnStartup, true)
  assert.equal(publicConfig({ maxWorkers: 4 }).maxWorkers, 4, 'the API accepts N for Phase 3 without changing Phase 1 behaviour')
  assert.equal(publicConfig({ keepChangesOnStop: false }).keepChangesOnStop, false)
})

test('the initial state is OFF with no worker and no task', () => {
  const state = emptyState()
  assert.equal(state.state, 'OFF')
  assert.equal(state.pid, null)
  assert.equal(state.task_id, null)
  assert.equal(state.stage, null)
})

test('persistence paths are exactly the documented ones', () => {
  const root = scratchRoot('paths')
  const p = paths(root)
  assert.equal(p.configFile, path.join(root, 'data', 'sub-worker', 'config.json'))
  assert.equal(p.stateFile, path.join(root, 'data', 'sub-worker', 'state.json'))
  assert.equal(p.queueFile, path.join(root, 'data', 'sub-worker', 'queue.json'))
  assert.equal(p.historyFile, path.join(root, 'data', 'sub-worker', 'history.json'))
  assert.equal(p.tasksDir, path.join(root, 'data', 'sub-worker', 'tasks'))
  assert.equal(p.workspaceLockFile, path.join(root, 'data', 'sub-worker', 'workspace-lock.json'))
  assert.equal(p.runtimeLog, path.join(root, 'logs', 'sub-worker.log'))
  assert.equal(p.taskLogsDir, path.join(root, 'logs', 'sub-worker'))
  fs.rmSync(root, { recursive: true, force: true })
})

test('nothing is written to disk before the worker is enabled', () => {
  const root = scratchRoot('inert')
  const store = new SubWorkerStore({ root })
  store.loadConfig()
  store.loadState()
  store.loadQueue()
  store.loadHistory()
  assert.equal(fs.existsSync(path.join(root, 'data')), false, 'reading state must not create the data tree')
  assert.equal(fs.existsSync(path.join(root, 'logs')), false)
  fs.rmSync(root, { recursive: true, force: true })
})

test('config, state, queue, history and task records round-trip', () => {
  const root = scratchRoot('roundtrip')
  const store = new SubWorkerStore({ root })
  store.ensureDirs()

  const config = store.saveConfig({ enabledOnStartup: true, autoDelegate: true, allowGitCommit: true })
  assert.equal(config.enabledOnStartup, true)
  assert.equal(store.loadConfig().autoDelegate, true)

  store.saveState({ state: 'RUNNING', stage: 'IMPLEMENTING', task_id: 't-1', pid: 4242 })
  const state = store.loadState()
  assert.equal(state.state, 'RUNNING')
  assert.equal(state.stage, 'IMPLEMENTING')
  assert.equal(state.pid, 4242)

  store.saveQueue([{ task_id: 't-1', objective: 'x' }])
  assert.deepEqual(store.loadQueue(), [{ task_id: 't-1', objective: 'x' }])

  store.appendHistory({ task_id: 't-1', status: 'completed' })
  store.appendHistory({ task_id: 't-2', status: 'failed' })
  assert.deepEqual(store.loadHistory().map((entry) => entry.task_id), ['t-2', 't-1'], 'newest history entry first')

  const file = store.saveTaskRecord('t-1', { task_id: 't-1', status: 'completed', events: [] })
  assert.ok(file.endsWith(path.join('tasks', 't-1.json')))
  assert.equal(store.loadTaskRecord('t-1').status, 'completed')

  store.saveWorkspaceLock({ task_id: 't-1', workspace: 'C:\\ws' })
  assert.equal(store.loadWorkspaceLock().workspace, 'C:\\ws')
  store.clearWorkspaceLock()
  assert.equal(store.loadWorkspaceLock(), null, 'the lock is gone after being released')

  fs.rmSync(root, { recursive: true, force: true })
})

test('a corrupt state file degrades to OFF instead of throwing', () => {
  const root = scratchRoot('corrupt')
  const store = new SubWorkerStore({ root })
  store.ensureDirs()
  fs.writeFileSync(store.paths.stateFile, '{not json', 'utf8')
  assert.equal(store.loadState().state, 'OFF')
  fs.writeFileSync(store.paths.queueFile, 'null', 'utf8')
  assert.deepEqual(store.loadQueue(), [])
  fs.writeFileSync(store.paths.historyFile, '"nope"', 'utf8')
  assert.deepEqual(store.loadHistory(), [])
  assert.equal(store.loadConfig().enabledOnStartup, false)
  fs.rmSync(root, { recursive: true, force: true })
})

test('an unknown persisted state is normalized back to OFF', () => {
  const root = scratchRoot('unknown-state')
  const store = new SubWorkerStore({ root })
  store.ensureDirs()
  fs.writeFileSync(store.paths.stateFile, JSON.stringify({ state: 'SLEEPING', stage: 'THINKING' }), 'utf8')
  const state = store.loadState()
  assert.equal(state.state, 'OFF')
  assert.equal(state.stage, null, 'an unknown stage is dropped rather than shown to the user')
  fs.rmSync(root, { recursive: true, force: true })
})

test('task identifiers never escape the tasks directory', () => {
  const root = scratchRoot('traversal')
  const store = new SubWorkerStore({ root })
  store.ensureDirs()
  const file = store.saveTaskRecord('../../escape', { ok: true })
  assert.ok(file.startsWith(store.paths.tasksDir), `${file} must stay inside ${store.paths.tasksDir}`)
  assert.equal(fs.existsSync(path.join(root, 'data', 'escape.json')), false)
  fs.rmSync(root, { recursive: true, force: true })
})

test('history is bounded so a long-lived shell cannot grow it forever', () => {
  const root = scratchRoot('bounded')
  const store = new SubWorkerStore({ root, maxHistory: 3 })
  store.ensureDirs()
  for (let i = 0; i < 6; i += 1) store.appendHistory({ task_id: `t-${i}`, status: 'completed' })
  const history = store.loadHistory()
  assert.equal(history.length, 3)
  assert.deepEqual(history.map((entry) => entry.task_id), ['t-5', 't-4', 't-3'])
  fs.rmSync(root, { recursive: true, force: true })
})

test('state writes are atomic: no temporary file survives a save', () => {
  const root = scratchRoot('atomic')
  const store = new SubWorkerStore({ root })
  store.ensureDirs()
  store.saveState({ state: 'IDLE' })
  const entries = fs.readdirSync(path.join(root, 'data', 'sub-worker'))
  assert.deepEqual(entries.filter((name) => name.endsWith('.tmp')), [])
  fs.rmSync(root, { recursive: true, force: true })
})
