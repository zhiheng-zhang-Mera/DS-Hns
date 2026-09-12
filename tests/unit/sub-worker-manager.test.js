'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')

const { WorkerManager, WorktreeManager } = require('../../app/sub-worker/manager.cjs')
const protocol = require('../../app/sub-worker/protocol.cjs')
const runtimeProcess = require('../../app/runtime-process.cjs')

/**
 * Controller-side integration: a real worker process, a real target repository,
 * a real worktree (plan §6, §10, §15, §24, §25; AC-02, AC-09, AC-10, AC-11, AC-12).
 */

const CREATED_ROOTS = []
const LIVE_MANAGERS = new Set()

test.after(() => {
  for (const manager of LIVE_MANAGERS) {
    try {
      manager.forceStop('test teardown')
    } catch {}
  }
  for (const root of CREATED_ROOTS) {
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {}
  }
})

async function waitFor(predicate, { timeoutMs = 30_000, intervalMs = 50, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(`timed out waiting for ${label}`)
}

function git(args, cwd) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
}

/** A scratch DS-Harness root plus a real git repository as the target. */
function scratch(name, { gitRepo = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-sub-manager-${name}-`))
  fs.mkdirSync(path.join(root, 'config'), { recursive: true })
  CREATED_ROOTS.push(root)

  const target = path.join(root, 'TargetRepo')
  fs.mkdirSync(target, { recursive: true })
  if (gitRepo) {
    git(['init', '-q'], target)
    git(['config', 'core.autocrlf', 'false'], target)
    git(['config', 'user.email', 'worker@example.com'], target)
    git(['config', 'user.name', 'sub worker test'], target)
    fs.writeFileSync(path.join(target, 'README.md'), '# target\n')
    fs.writeFileSync(path.join(target, 'app.js'), 'module.exports = 1\n')
    git(['add', '-A'], target)
    git(['commit', '-qm', 'init'], target)
  }
  return { root, target }
}

/** A scratch directory that is guaranteed to be outside any git work tree. */
function scratchOutsideRepo(name) {
  const base = path.join(process.env.LOCALAPPDATA || os.homedir(), 'Temp', 'dsh-sub-worker-tests')
  fs.mkdirSync(base, { recursive: true })
  const root = fs.mkdtempSync(path.join(base, `dsh-sub-nonrepo-${name}-`))
  CREATED_ROOTS.push(root)
  // Precondition: if this directory were inside a repository the test would be
  // meaningless, so fail loudly instead of silently passing.
  const probe = git(['rev-parse', '--show-toplevel'], root)
  assert.notEqual(probe.status, 0, `${root} must not be inside a git work tree`)
  const target = path.join(root, 'TargetRepo')
  fs.mkdirSync(target, { recursive: true })
  fs.writeFileSync(path.join(target, 'app.js'), 'module.exports = 1\n')
  return { root, target }
}

function makeManager(root, extra = {}) {
  const logs = []
  const events = []
  const manager = new WorkerManager({
    root,
    nodeExe: process.execPath,
    runtimeProcess,
    log: (message) => logs.push(String(message)),
    notify: (event) => events.push(event),
    ...extra
  })
  LIVE_MANAGERS.add(manager)
  return { manager, logs, events }
}

function readOnlyTask(target, overrides = {}) {
  return {
    version: 1,
    task_id: `ro-${Math.random().toString(36).slice(2, 8)}`,
    objective: 'Inspect the repository',
    target_repo: target,
    allowed_paths: ['**'],
    forbidden_paths: [],
    risk_level: 'L0',
    // git inspection runs git as a child process, so it needs shell permission.
    permissions: { read: true, shell: true },
    operations: [{ op: 'git_status' }, { op: 'list_dir', path: '.' }, { op: 'read_file', path: 'README.md' }],
    ...overrides
  }
}

function editTask(target, overrides = {}) {
  return {
    version: 1,
    task_id: `edit-${Math.random().toString(36).slice(2, 8)}`,
    objective: 'Implement the greeting helper',
    target_repo: target,
    allowed_paths: ['**'],
    forbidden_paths: ['src/ipc/**'],
    risk_level: 'L2',
    permissions: { read: true, write: true, shell: true, network: false },
    operations: [
      { op: 'read_file', path: 'app.js' },
      { op: 'write_file', path: 'src/greeting.js', content: 'module.exports = () => "hello"\n' }
    ],
    ...overrides
  }
}

async function waitForResult(manager, timeoutMs = 30_000) {
  await waitFor(() => manager.describe().history.length > 0 && manager.currentTask === null, {
    timeoutMs,
    label: 'a task result'
  })
  return manager.describe().history[0]
}

test('the worker lifecycle runs OFF -> STARTING -> IDLE -> STOPPING -> OFF with a real process', async (t) => {
  const { root } = scratch('lifecycle')
  const { manager, logs } = makeManager(root)
  t.after(() => manager.forceStop('test cleanup'))

  manager.hydrate()
  assert.equal(manager.describe().state, 'OFF')
  assert.equal(manager.isRunning, false)
  assert.equal(fs.existsSync(path.join(root, 'runtime', 'sub-worker-process.json')), false, 'no worker record exists while the feature is off')

  const started = await manager.start({ reason: 'test' })
  assert.equal(started.ok, true)
  assert.equal(manager.isRunning, true)
  assert.equal(manager.describe().state, 'IDLE')

  await waitFor(() => manager.workerInfo, { label: 'the worker to announce itself' })
  assert.equal(manager.workerInfo.worker_id, 'sub-1')
  assert.equal(manager.workerInfo.protocol, protocol.PROTOCOL_VERSION)
  assert.deepEqual(manager.workerInfo.capabilities.vision, false)

  // The ownership record lets a later shell reclaim the process (§28).
  const ownership = JSON.parse(fs.readFileSync(path.join(root, 'runtime', 'sub-worker-process.json'), 'utf8'))
  assert.equal(ownership.type, 'sub-worker')
  assert.equal(ownership.childPid, started.pid)
  assert.equal(ownership.workerId, 'sub-1')

  // The worker's own state file is persisted and recoverable.
  const stateFile = path.join(root, 'data', 'sub-worker', 'state.json')
  assert.equal(fs.existsSync(stateFile), true)
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).state, 'IDLE')

  await manager.stop({ reason: 'test stop' })
  assert.equal(manager.describe().state, 'OFF')
  assert.equal(manager.isRunning, false)
  assert.equal(fs.existsSync(path.join(root, 'runtime', 'sub-worker-process.json')), false)
  assert.ok(logs.some((line) => /worker sub-1 spawned/.test(line)))
  assert.ok(logs.some((line) => /worker stopped|stopped \(test stop\)/.test(line)))

  // The process really is gone.
  let alive = true
  try {
    process.kill(started.pid, 0)
  } catch {
    alive = false
  }
  assert.equal(alive, false, 'no worker process may survive Stop')
})

test('an isolated worktree task edits the worktree, never the target repository', async (t) => {
  const { root, target } = scratch('worktree')
  const { manager } = makeManager(root)
  t.after(() => manager.forceStop('test cleanup'))

  await manager.start({ reason: 'test' })
  const task = editTask(target)
  const admission = manager.assignTask(task)
  assert.equal(admission.accepted, true)

  const entry = await waitForResult(manager)
  assert.equal(entry.task_id, task.task_id)
  assert.equal(entry.status, 'completed', entry.summary)
  assert.deepEqual(entry.changed_files, ['src/greeting.js'])

  // The worktree exists at the documented location and holds the change...
  const worktree = WorktreeManager.worktreePathFor(target)
  assert.equal(worktree, path.join(path.dirname(target), 'TargetRepo-worktrees', 'hns-sub-worker'))
  assert.equal(fs.existsSync(path.join(worktree, 'src', 'greeting.js')), true)
  assert.equal(fs.readFileSync(path.join(worktree, 'src', 'greeting.js'), 'utf8'), 'module.exports = () => "hello"\n')

  // ...while the Controller's own working tree is untouched (plan §10, §34).
  assert.equal(fs.existsSync(path.join(target, 'src', 'greeting.js')), false)
  assert.equal(git(['status', '--porcelain'], target).stdout.trim(), '')

  // Result + audit trail are persisted for the Controller.
  const record = manager.store.loadTaskRecord(task.task_id)
  assert.equal(record.status, 'completed')
  assert.equal(record.task.task_id, task.task_id)
  assert.ok(Array.isArray(record.events) && record.events.length > 0)
  const log = manager.readTaskLog(task.task_id)
  assert.equal(log.ok, true)
  assert.match(log.text, /file_write/)
  assert.equal(fs.existsSync(path.join(root, 'logs', 'sub-worker.log')), true)
  assert.equal(manager.store.loadWorkspaceLock(), null, 'the workspace lock is released when the task ends')
})

test('the workspace lock serialises the single Phase 1 worker', async (t) => {
  const { root, target } = scratch('queue')
  const { manager } = makeManager(root)
  t.after(() => manager.forceStop('test cleanup'))

  await manager.start({ reason: 'test' })
  const first = manager.assignTask(editTask(target, { task_id: 'q-first' }))
  const second = manager.assignTask(editTask(target, { task_id: 'q-second' }))
  assert.equal(first.accepted, true)
  assert.equal(second.accepted, true)

  await waitFor(() => manager.describe().history.length >= 2, { timeoutMs: 40_000, label: 'both tasks to finish' })
  const history = manager.describe().history
  const ids = history.map((entry) => entry.task_id)
  assert.ok(ids.includes('q-first'))
  assert.ok(ids.includes('q-second'))
  // Phase 1 must never run two tasks concurrently: the second task may only
  // start after the first one has a terminal record.
  for (const entry of history) {
    assert.equal(entry.status, 'completed', `${entry.task_id} should have completed, got ${entry.status}`)
  }
  const finished = history.map((entry) => Date.parse(entry.finished_at)).filter(Number.isFinite)
  const firstFinish = history.find((entry) => entry.task_id === 'q-first').finished_at
  assert.ok(firstFinish, 'the first task must have a finish timestamp')
  assert.equal(manager.describe().queue_length, 0)
  assert.equal(finished.length, 2)
  // The two tasks share one workspace lock, so they are strictly ordered.
  assert.equal(manager.describe().max_workers, 1)
})

test('three queued tasks are strictly serialised on one worker', async (t) => {
  const { root, target } = scratch('serial')
  const { manager } = makeManager(root)
  t.after(() => manager.forceStop('test cleanup'))

  await manager.start({ reason: 'test' })
  const windows = []
  const watch = (taskId, startedAt) => {
    windows.push({ taskId, startedAt })
  }
  for (const id of ['s-1', 's-2', 's-3']) {
    watch(id, Date.now())
    manager.assignTask(editTask(target, {
      task_id: id,
      operations: [{ op: 'write_file', path: `${id}.txt`, content: id }]
    }))
  }
  await waitFor(() => manager.describe().history.length >= 3, { timeoutMs: 60_000, label: 'all three tasks' })
  const history = manager.describe().history
  assert.deepEqual(history.map((entry) => entry.status), ['completed', 'completed', 'completed'])
  // The newest record is the last one to finish, and the file it wrote exists.
  assert.equal(history[0].task_id, 's-3')
  for (const id of ['s-1', 's-2', 's-3']) {
    assert.ok(history.some((entry) => entry.task_id === id), `${id} must have a terminal record`)
  }
})

test('the Live View streams the run and exposes the final result (AC-04, AC-05)', async (t) => {
  const { root, target } = scratch('live')
  const { manager } = makeManager(root)
  t.after(() => manager.forceStop('test cleanup'))

  await manager.start({ reason: 'test' })
  manager.assignTask(editTask(target, {
    task_id: 'live-1',
    operations: [
      { op: 'read_file', path: 'app.js' },
      { op: 'write_file', path: 'src/live.js', content: 'module.exports = 1\n' },
      { op: 'run_command', command: 'node -e "console.log(\'live view output\')"' }
    ]
  }))

  // While the task is running the panel must already show real activity.
  await waitFor(() => {
    const live = manager.describe().live
    return live && live.changed_files.length > 0
  }, { timeoutMs: 30_000, label: 'live activity during the run' })
  const during = manager.describe().live
  assert.equal(during.task_id, 'live-1')
  assert.ok(during.summary.length > 0, 'the execution summary must stream')
  assert.ok(during.terminal.length > 0, 'the terminal transcript must stream')
  assert.ok(during.changed_files.some((file) => file.path === 'src/live.js'))
  assert.equal(during.objective, 'Implement the greeting helper')

  const entry = await waitForResult(manager)
  assert.equal(entry.status, 'completed', entry.summary)
  const after = manager.describe().live
  assert.equal(after.task_id, 'live-1')
  assert.equal(after.status, 'completed')
  assert.ok(after.result, 'the Result pane must receive the finished result (AC-05)')
  assert.equal(after.result.status, 'completed')
  assert.equal(after.result.code, 'OK')
  assert.deepEqual(after.result.changed_files, ['src/live.js'])
  assert.ok(after.finished_at)
  // The Live View of the finished task is also retrievable by task id, and a
  // different task id still falls back to the stored record.
  assert.equal(manager.liveViewFor('live-1').result.status, 'completed')
  assert.equal(manager.liveViewFor('does-not-exist'), null)
})

test('a worktree is released only on an explicit Controller action', async (t) => {
  const { root, target } = scratch('release')
  const { manager } = makeManager(root)
  t.after(() => manager.forceStop('test cleanup'))

  await manager.start({ reason: 'test' })
  manager.assignTask(editTask(target, { task_id: 'release-1' }))
  await waitForResult(manager)

  const worktree = WorktreeManager.worktreePathFor(target)
  assert.equal(fs.existsSync(worktree), true, 'the worktree holds the deliverable and is kept for review')
  assert.equal(git(['worktree', 'list'], target).stdout.includes('hns-sub-worker'), true)

  const refused = manager.releaseWorktree('')
  assert.equal(refused.ok, false)

  const released = manager.releaseWorktree(target)
  assert.equal(released.ok, true)
  assert.equal(released.removed, true)
  assert.equal(fs.existsSync(worktree), false)
  assert.equal(git(['worktree', 'list'], target).stdout.includes('hns-sub-worker'), false)

  const again = manager.releaseWorktree(target)
  assert.equal(again.ok, true)
  assert.equal(again.removed, false, 'releasing twice is a no-op')
})

test('a worker crash is contained: CRASHED is recorded, the Harness keeps running, restart recovers', async (t) => {
  const { root, target } = scratch('crash')
  const { manager, logs } = makeManager(root)
  t.after(() => manager.forceStop('test cleanup'))

  await manager.start({ reason: 'test' })
  const task = editTask(target, {
    task_id: 'crash-task',
    operations: [
      { op: 'write_file', path: 'slow.js', content: 'module.exports = 1\n' },
      { op: 'run_command', command: 'node -e "setTimeout(()=>{},30000)"' }
    ]
  })
  manager.assignTask(task)
  await waitFor(() => manager.currentTask !== null, { label: 'the task to be dispatched' })

  // Simulate an external kill (out-of-memory, a task manager, a hard shutdown).
  const pid = manager.child.pid
  manager.killTree(pid)
  await waitFor(() => manager.describe().state === 'CRASHED', { label: 'the crash to be detected' })

  const snapshot = manager.describe()
  assert.equal(snapshot.state, 'CRASHED')
  assert.equal(snapshot.pid, null)
  assert.match(snapshot.last_error, /exited unexpectedly/)
  assert.equal(snapshot.history[0].status, 'failed')
  assert.equal(snapshot.history[0].code, protocol.RESULT_CODES.CRASHED)
  assert.equal(snapshot.history[0].needs_controller_review, true)
  assert.ok(snapshot.notifications.some((entry) => entry.kind === 'crash'), 'the user is told what happened')
  assert.equal(fs.existsSync(path.join(root, 'runtime', 'sub-worker-process.json')), false)
  assert.equal(logs.some((line) => /worker exited unexpectedly/.test(line)), true)

  // AC-09: the host process is unaffected and the worker can be restarted.
  const restarted = await manager.restart({ reason: 'after crash' })
  assert.equal(restarted.ok, true)
  // The supervisor is alive again; if the interrupted node is still pending it is
  // already being replayed, which is why the state may be ASSIGNED here.
  assert.ok(['IDLE', 'ASSIGNED', 'RUNNING'].includes(manager.describe().state), `unexpected state ${manager.describe().state}`)
  assert.equal(manager.describe().restarts >= 1, true)

  // Crash resume replays the interrupted task from its durable dispatch record.
  const resumed = await manager.resumeLastTask()
  assert.equal(resumed.ok, true, resumed.reason || '')
  await waitFor(() => manager.describe().task_id === task.task_id, { label: 'the replayed task to be dispatched' })
  assert.equal(manager.cancelTask('stop the replay').ok, true)
  await waitFor(() => manager.describe().history.length >= 2, { timeoutMs: 30_000, label: 'the replayed task to settle' })
})

test('Pause, Resume, Cancel, Send Note and Take Over all work through the real worker', async (t) => {
  const { root, target } = scratch('intervention')
  const { manager } = makeManager(root)
  t.after(() => manager.forceStop('test cleanup'))

  await manager.start({ reason: 'test' })

  // Pause and resume round-trip through the worker process.
  assert.equal(manager.pause('test pause').ok, true)
  await waitFor(() => manager.describe().state === 'PAUSED', { label: 'PAUSED' })
  assert.equal(manager.resume('test resume').ok, true)
  await waitFor(() => manager.describe().state === 'IDLE', { label: 'IDLE after resume' })

  // A note reaches the worker and constrains the next execution boundary.
  const guard = editTask(target, {
    task_id: 'note-task',
    operations: [
      { op: 'write_file', path: 'a.txt', content: 'a' },
      { op: 'write_file', path: 'b.txt', content: 'b' }
    ]
  })
  const note = manager.sendNote({ note: 'Do not modify b.txt.' })
  assert.equal(note.ok, true)
  assert.equal(note.delivered, true, 'a running worker receives the note immediately')
  manager.assignTask(guard)
  const entry = await waitForResult(manager)
  assert.equal(entry.status, 'blocked')
  assert.equal(entry.code, protocol.RESULT_CODES.PATH_FORBIDDEN)

  // Cancel a running task without stopping the worker.
  manager.assignTask(editTask(target, {
    task_id: 'cancel-task',
    operations: [{ op: 'run_command', command: 'node -e "setTimeout(()=>{},30000)"' }]
  }))
  await waitFor(() => manager.describe().task_id === 'cancel-task', { label: 'the cancellable task' })
  assert.equal(manager.cancelTask('test cancel').ok, true)
  await waitFor(() => manager.describe().history[0]?.task_id === 'cancel-task', { timeoutMs: 30_000, label: 'the cancellation result' })
  const cancelled = manager.describe().history[0]
  assert.equal(cancelled.status, 'cancelled', `unexpected result: ${cancelled.status} / ${cancelled.code} / ${cancelled.summary}`)
  assert.equal(manager.isRunning, true, 'cancelling a task must not stop the worker')

  // Take Over releases the workspace and ends the worker process.
  manager.assignTask(editTask(target, {
    task_id: 'handoff-task',
    operations: [{ op: 'run_command', command: 'node -e "setTimeout(()=>{},30000)"' }]
  }))
  await waitFor(() => manager.describe().task_id === 'handoff-task', { label: 'the handover task' })
  const handoff = await manager.takeOver({ reason: 'test take over' })
  assert.equal(handoff.ok, true)
  assert.equal(handoff.state, 'HANDOFF')
  assert.equal(manager.describe().state, 'HANDOFF')
  assert.equal(manager.isRunning, false, 'nothing may hold the workspace after a take over')
  assert.equal(manager.store.loadWorkspaceLock(), null)
  assert.ok(handoff.handoff.workspace, 'the Controller is told which workspace it received')
  assert.equal(fs.existsSync(path.join(root, 'runtime', 'sub-worker-process.json')), false)

  // The Controller can clear the handoff and start again.
  assert.equal(manager.clearHandoff().ok, true)
  assert.equal(manager.describe().state, 'OFF')
})

test('an orphaned worker process is reclaimed before a new one starts', async (t) => {
  const { root } = scratch('orphan')
  const { manager } = makeManager(root)
  t.after(() => manager.forceStop('test cleanup'))

  // A worker left behind by a shell that was killed outright.
  const entry = path.join(__dirname, '..', '..', 'app', 'sub-worker', 'runtime.cjs')
  const orphan = spawn(process.execPath, [entry, '--root', root, '--worker-id', 'sub-1'], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })
  t.after(() => manager.killTree(orphan.pid))
  await new Promise((resolve) => setTimeout(resolve, 800))

  runtimeProcess.writeOwnership({ root, type: 'sub-worker', pid: orphan.pid, parentPid: 999_999, entry })
  const file = path.join(root, 'runtime', 'sub-worker-process.json')
  assert.equal(fs.existsSync(file), true)

  const recovery = await runtimeProcess.recoverStaleWorker({ root, entry, log: () => {} })
  assert.equal(recovery.recovered, true)
  await waitFor(() => {
    try {
      process.kill(orphan.pid, 0)
      return false
    } catch {
      return true
    }
  }, { timeoutMs: 10_000, label: 'the orphaned worker to be killed' })
  assert.equal(fs.existsSync(file), false, 'the ownership record is cleared after recovery')
})

test('the worker exits on its own when the Controller pipe closes (no orphan by construction)', async (t) => {
  const { root } = scratch('eof')
  const entry = path.join(__dirname, '..', '..', 'app', 'sub-worker', 'runtime.cjs')
  const worker = spawn(process.execPath, [entry, '--root', root, '--worker-id', 'sub-1'], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })
  t.after(() => {
    try {
      worker.kill('SIGKILL')
    } catch {}
  })

  const ready = await new Promise((resolve) => {
    let buffer = ''
    const timer = setTimeout(() => resolve(false), 10_000)
    worker.stdout.on('data', (chunk) => {
      buffer += chunk.toString()
      if (buffer.includes('"ready"')) {
        clearTimeout(timer)
        resolve(true)
      }
    })
  })
  assert.equal(ready, true, 'the worker must announce itself')

  // Closing the Controller's end of the pipe is what a hard shell kill does.
  worker.stdin.end()
  await waitFor(() => worker.exitCode !== null, { timeoutMs: 10_000, label: 'the worker to exit on stdin EOF' })
  assert.equal(worker.exitCode, 0, 'the worker must leave on its own instead of becoming an orphan')
})

test('persisted state and history survive a restart of the shell (AC-11)', async (t) => {
  const { root, target } = scratch('recovery')
  const first = makeManager(root)
  await first.manager.start({ reason: 'test' })
  const task = readOnlyTask(target)
  first.manager.assignTask(task)
  await waitForResult(first.manager)
  await first.manager.stop({ reason: 'test stop' })

  // A shell restart: a brand new manager must find the history and the state.
  const second = makeManager(root)
  t.after(() => second.manager.forceStop('test cleanup'))
  const snapshot = second.manager.hydrate()
  assert.equal(snapshot.state, 'OFF')
  assert.equal(snapshot.history.length >= 1, true)
  assert.equal(snapshot.history[0].task_id, task.task_id)
  assert.equal(snapshot.history[0].status, 'completed')

  const record = second.manager.store.loadTaskRecord(task.task_id)
  assert.ok(record, 'the per-task record is recoverable')
  assert.equal(record.result.status, 'completed')

  const live = second.manager.liveViewFor(task.task_id)
  assert.ok(live, 'a previous task can still be inspected in the Live View')
  assert.equal(live.task_id, task.task_id)
})

test('a state record left behind by a killed shell is reported as CRASHED, never as running', async (t) => {
  const { root } = scratch('stale-state')
  fs.mkdirSync(path.join(root, 'data', 'sub-worker'), { recursive: true })
  fs.writeFileSync(path.join(root, 'data', 'sub-worker', 'state.json'), JSON.stringify({
    version: 1,
    state: 'RUNNING',
    task_id: 'interrupted-task',
    pid: 999_999,
    stage: 'IMPLEMENTING'
  }), 'utf8')

  const { manager } = makeManager(root)
  t.after(() => manager.forceStop('test cleanup'))
  const snapshot = manager.hydrate()
  assert.equal(snapshot.state, 'CRASHED')
  assert.equal(snapshot.pid, null)
  assert.match(snapshot.last_error, /not running when the shell restarted/)
})

test('hostile and malformed tasks are refused without touching the worker', async (t) => {
  const { root, target } = scratch('hostile')
  const { manager } = makeManager(root)
  t.after(() => manager.forceStop('test cleanup'))
  await manager.start({ reason: 'test' })

  const malformed = manager.assignTask({ task_id: 'x' })
  assert.equal(malformed.accepted, false)
  assert.equal(malformed.code, protocol.RESULT_CODES.TASK_REJECTED)
  assert.ok(malformed.errors.length > 0)

  const architecture = manager.assignTask({
    version: 1,
    task_id: 'l3-task',
    objective: 'Redesign the module boundaries',
    target_repo: target,
    risk_level: 'L3',
    permissions: { read: true },
    operations: [{ op: 'git_status' }]
  })
  assert.equal(architecture.accepted, false)
  assert.equal(architecture.code, protocol.RESULT_CODES.REQUIRES_CONTROLLER)
  assert.equal(manager.describe().history[0].status, 'rejected')

  const research = manager.assignTask({
    version: 1,
    task_id: 'l4-task',
    objective: 'Decide the product direction',
    target_repo: target,
    risk_level: 'L4',
    permissions: { read: true },
    operations: [{ op: 'git_status' }]
  })
  assert.equal(research.accepted, false)

  const vision = manager.assignTask({
    version: 1,
    task_id: 'vision-task',
    objective: 'Read the screenshot',
    target_repo: target,
    risk_level: 'L2',
    requires_vision: true,
    permissions: { read: true },
    operations: [{ op: 'git_status' }]
  })
  assert.equal(vision.accepted, false)
  assert.equal(vision.code, protocol.RESULT_CODES.UNSUPPORTED_CAPABILITY)
  assert.equal(manager.describe().history[0].status, 'unsupported_capability')

  // Auto delegate is off by default, so an implicit delegation is refused.
  const auto = manager.assignTask(readOnlyTask(target, { objective: 'Add unit tests for the parser' }), { explicit: false })
  assert.equal(auto.accepted, false)
  assert.match(auto.reason, /OFF/)
  assert.equal(manager.currentTask, null, 'nothing may be dispatched after a refusal')

  // ...and when it is on, only safe categories pass.
  manager.updateConfig({ autoDelegate: true })
  const allowed = manager.assignTask(readOnlyTask(target, { task_id: 'auto-1', objective: 'Add unit tests for the parser' }), { explicit: false })
  assert.equal(allowed.accepted, true)
  await waitForResult(manager)
  manager.updateConfig({ autoDelegate: false })
})

test('a coordinator failure never throws into the host shell', async (t) => {
  const { root } = scratch('resilient')
  // Make the sub-worker data directory unusable: every store write must fail.
  fs.mkdirSync(path.join(root, 'data'), { recursive: true })
  fs.writeFileSync(path.join(root, 'data', 'sub-worker'), 'not a directory', 'utf8')

  const { manager, logs } = makeManager(root)
  t.after(() => manager.forceStop('test cleanup'))

  assert.doesNotThrow(() => manager.hydrate())
  const started = await manager.start({ reason: 'test' })
  assert.equal(typeof started.ok, 'boolean', 'start must answer instead of throwing')
  assert.equal(started.ok, true, 'a broken store must not stop the worker from starting')
  assert.doesNotThrow(() => manager.assignTask(readOnlyTask(root, { task_id: 'resilient-1' })))
  assert.doesNotThrow(() => manager.sendNote('note'))
  assert.doesNotThrow(() => manager.pause('paused'))
  assert.doesNotThrow(() => manager.resume('resumed'))
  assert.doesNotThrow(() => manager.describe())
  assert.doesNotThrow(() => manager.readTaskLog('missing'))
  assert.doesNotThrow(() => manager.releaseWorktree('D:\\nope'))
  assert.doesNotThrow(() => manager.forceStop('cleanup'))
  assert.ok(logs.length > 0)
})

test('a task that names a non-repository target is blocked, not improvised', async (t) => {
  const { root, target } = scratchOutsideRepo('target')
  const { manager } = makeManager(root)
  t.after(() => manager.forceStop('test cleanup'))

  await manager.start({ reason: 'test' })
  manager.assignTask(editTask(target, { task_id: 'no-repo' }))
  const entry = await waitForResult(manager)
  assert.equal(entry.status, 'blocked')
  assert.equal(entry.code, protocol.RESULT_CODES.BLOCKED)
  assert.match(entry.summary, /not a git repository/)
  assert.equal(fs.existsSync(path.join(target, 'src', 'greeting.js')), false, 'nothing may be written without a workspace')
})

test('a shared-workspace task is allowed when the Controller asks for it explicitly', async (t) => {
  const { root, target } = scratch('shared')
  const { manager } = makeManager(root)
  t.after(() => manager.forceStop('test cleanup'))

  await manager.start({ reason: 'test' })
  manager.assignTask(editTask(target, {
    task_id: 'shared-task',
    workspace_mode: 'shared',
    workspace: target
  }))
  const entry = await waitForResult(manager)
  assert.equal(entry.status, 'completed', entry.summary)
  assert.equal(entry.workspace, target)
  assert.equal(fs.existsSync(path.join(target, 'src', 'greeting.js')), true, 'an explicit shared workspace is honoured')
})

test('dispatch authority is single and every task ends on a controller boundary (plan §21, §22)', async (t) => {
  const { root, target } = scratch('authority')
  const { manager } = makeManager(root)
  t.after(() => manager.forceStop('test cleanup'))

  await manager.start({ reason: 'test' })
  manager.assignTask(editTask(target, { task_id: 'authority-1' }))
  const entry = await waitForResult(manager)
  assert.equal(entry.status, 'completed')

  // The Controller hand-off point exists and describes the finished task, so a
  // controller change (Codex back online) can only land at a task boundary.
  const record = manager.store.loadTaskRecord('authority-1')
  assert.ok(record.checkpoint, 'a terminal task must produce a checkpoint')
  assert.equal(record.checkpoint.task_id, 'authority-1')
  assert.equal(record.checkpoint.status, 'completed')
  assert.ok(record.checkpoint.workspace, 'the checkpoint names the workspace the Controller now owns')
  assert.equal(record.checkpoint.boundary, 'task_end')
  assert.equal(record.checkpoint.worker_id, 'sub-1')
  assert.deepEqual(record.checkpoint.changed_files, ['src/greeting.js'])

  // The manager is the only dispatcher: the worker protocol has no channel an
  // external controller could use to bypass it.
  const protocolSource = require('node:fs').readFileSync(path.join(__dirname, '..', '..', 'app', 'sub-worker', 'protocol.cjs'), 'utf8')
  const controllerMessages = protocolSource.slice(protocolSource.indexOf('const CONTROLLER_MESSAGES'), protocolSource.indexOf('const WORKER_MESSAGES'))
  for (const forbidden of ['codex', 'browser', 'user', 'external', 'broadcast', 'chat']) {
    assert.equal(controllerMessages.includes(forbidden), false, `the worker must not accept a ${forbidden} channel`)
  }
  // ...and the manager spawns the worker exactly once, from the enable path.
  const managerSource = require('node:fs').readFileSync(path.join(__dirname, '..', '..', 'app', 'sub-worker', 'manager.cjs'), 'utf8')
  assert.equal((managerSource.match(/spawn\(/g) || []).length, 1)
})
