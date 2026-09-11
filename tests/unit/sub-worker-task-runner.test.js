'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const protocol = require('../../app/sub-worker/protocol.cjs')
const { EventBus } = require('../../app/sub-worker/event-bus.cjs')
const { Reporter } = require('../../app/sub-worker/reporter.cjs')
const { TaskController, TaskRunner, stageForOperation, resolveInsideWorkspace } = require('../../app/sub-worker/task-runner.cjs')
const { revertIfRequired } = require('../../app/sub-worker/runtime.cjs')
const { RESULT_CODES } = protocol

/**
 * The executor contract (plan §4.2, §5, §8, §9, §15, §32 Task Execution).
 * Every test runs the real runner against a real temporary workspace.
 */

const CREATED_ROOTS = []

function scratchRoot(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-sub-runner-${name}-`))
  fs.mkdirSync(path.join(root, 'config'), { recursive: true })
  CREATED_ROOTS.push(root)
  return root
}

test.after(() => {
  for (const root of CREATED_ROOTS) {
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {}
  }
})

async function harness(name, workspaceFiles = {}, taskOverrides = {}, { workspaceDir = null } = {}) {
  const root = scratchRoot(name)
  const workspace = workspaceDir || path.join(root, 'workspace')
  fs.mkdirSync(workspace, { recursive: true })
  for (const [file, content] of Object.entries(workspaceFiles)) {
    const target = path.join(workspace, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content, 'utf8')
  }

  const validated = protocol.validateTask({
    version: 1,
    task_id: 'runner-task',
    objective: 'Implement the adapter',
    target_repo: workspace,
    allowed_paths: ['**'],
    forbidden_paths: [],
    risk_level: 'L2',
    permissions: { read: true, write: true, shell: true, git_commit: false, network: false },
    ...taskOverrides
  })
  assert.equal(validated.ok, true, validated.errors.join('; '))

  const bus = new EventBus({ taskId: validated.task.task_id })
  const reporter = new Reporter({ root, taskId: validated.task.task_id })
  bus.subscribe((event) => reporter.record(event))
  const controller = new TaskController()
  const runner = new TaskRunner({
    root,
    task: validated.task,
    workspace,
    controller,
    reporter,
    bus,
    config: { allowGitCommit: false, commandTimeoutMs: 60_000, keepChangesOnStop: true }
  })
  return { root, workspace, task: validated.task, runner, bus, reporter, controller }
}

test('a read-only task completes and reports what it inspected', async () => {
  const h = await harness('read-only', { 'src/app.ts': 'export const x = 1\n' }, {
    risk_level: 'L0',
    permissions: { read: true },
    operations: [
      { op: 'list_dir', path: '.' },
      { op: 'read_file', path: 'src/app.ts' }
    ]
  })
  const result = await h.runner.run()
  assert.equal(result.status, 'completed')
  assert.equal(result.code, RESULT_CODES.OK)
  assert.deepEqual(result.changed_files, [])
  assert.match(result.summary, /No files were changed/)
  const summary = h.reporter.summaryLines().map((line) => line.text).join('\n')
  assert.match(summary, /Read src\/app\.ts/)
  assert.match(summary, /Listed \./)
  assert.ok(h.reporter.stages.some((entry) => entry.stage === 'INSPECTING'))
  assert.ok(h.reporter.stages.some((entry) => entry.stage === 'REPORTING'))
})

test('a file-edit task creates and patches files inside the workspace only', async () => {
  const h = await harness('edit', { 'src/app.ts': 'const value = 1\n' }, {
    operations: [
      { op: 'list_dir', path: 'src' },
      { op: 'read_file', path: 'src/app.ts' },
      { op: 'git_status' },
      { op: 'write_file', path: 'src/greeting.ts', content: 'export const hello = () => "hi"\n' },
      { op: 'replace_in_file', path: 'src/app.ts', find: 'const value = 1', replace: 'const value = 2' }
    ]
  })
  const result = await h.runner.run()
  assert.equal(result.status, 'completed')
  assert.deepEqual(result.changed_files.sort(), ['src/app.ts', 'src/greeting.ts'])
  assert.equal(fs.readFileSync(path.join(h.workspace, 'src/greeting.ts'), 'utf8'), 'export const hello = () => "hi"\n')
  assert.equal(fs.readFileSync(path.join(h.workspace, 'src/app.ts'), 'utf8'), 'const value = 2\n')
  assert.deepEqual(result.changed_file_details.map((entry) => entry.status).sort(), ['A', 'M'])
  assert.deepEqual(result.stage_log.map((entry) => entry.stage), ['INSPECTING', 'IMPLEMENTING', 'REPORTING'])
})

test('a test task reports exact counts when the runner prints a summary', async () => {
  const h = await harness('tests-pass', {
    'sum.test.js': "const test=require('node:test');const assert=require('node:assert');test('a',()=>assert.equal(1,1));test('b',()=>assert.equal(2,2));\n"
  }, {
    operations: [
      { op: 'run_tests', command: 'node --test --test-reporter=tap sum.test.js', phase: 'TESTING' }
    ]
  })
  const result = await h.runner.run()
  assert.equal(result.status, 'completed', result.reason || '')
  assert.equal(result.tests.parser, 'node-test')
  assert.equal(result.tests.failed, 0)
  assert.ok(result.tests.passed >= 2, `expected at least 2 passing tests, got ${result.tests.passed}`)
  const testEvent = h.reporter.testRuns.at(-1)
  assert.equal(testEvent.failed, 0)
})

test('a failing test run fails the task with real counts, not an invented one', async () => {
  const h = await harness('tests-fail', {
    'bad.test.js': "const test=require('node:test');const assert=require('node:assert');test('bad',()=>assert.equal(1,2));\n"
  }, {
    operations: [
      { op: 'run_tests', command: 'node --test --test-reporter=tap bad.test.js' }
    ]
  })
  const result = await h.runner.run()
  assert.equal(result.status, 'failed')
  assert.equal(result.code, RESULT_CODES.TESTS_FAILED)
  assert.equal(result.tests.failed, 1)
  assert.equal(result.needs_controller_decision, true)
})

test('TESTING -> FIXING -> TESTING can end green', async () => {
  const h = await harness('fixing', {
    'check.js': "const fs=require('fs');process.exit(fs.existsSync('flag.txt')&&fs.readFileSync('flag.txt','utf8').trim()==='ok'?0:1)\n"
  }, {
    operations: [
      { op: 'run_tests', command: 'node check.js' },
      { op: 'write_file', path: 'flag.txt', content: 'ok\n' },
      { op: 'run_tests', command: 'node check.js' }
    ]
  })
  const result = await h.runner.run()
  assert.equal(result.status, 'completed', result.reason || '')
  assert.deepEqual(result.stage_log.map((entry) => entry.stage), ['TESTING', 'FIXING', 'TESTING', 'REPORTING'])
  assert.equal(h.reporter.testRuns.length, 2)
  assert.equal(h.reporter.testRuns[0].failed, 1)
  assert.equal(h.reporter.testRuns[1].failed, 0)
})

test('a task without an executable specification is BLOCKED, never improvised', async () => {
  const h = await harness('no-spec', { 'src/app.ts': 'x\n' }, { operations: [] })
  const result = await h.runner.run()
  assert.equal(result.status, 'blocked')
  assert.equal(result.code, RESULT_CODES.MISSING_SPECIFICATION)
  assert.equal(result.needs_controller_decision, true)
  assert.match(result.reason, /will not invent an implementation plan/)
  assert.equal(h.reporter.changedFiles.size, 0)
})

test('L3 and L4 tasks are rejected with requires_controller', async () => {
  for (const level of ['L3', 'L4']) {
    const h = await harness(`reject-${level}`, {}, {
      risk_level: level,
      operations: [{ op: 'git_status' }]
    })
    const result = await h.runner.run()
    assert.equal(result.status, 'rejected')
    assert.equal(result.code, RESULT_CODES.REQUIRES_CONTROLLER)
    assert.equal(result.requires_controller, true)
  }
})

test('a vision task is refused as an unsupported capability', async () => {
  const h = await harness('vision', {}, { requires_vision: true, operations: [{ op: 'git_status' }] })
  const result = await h.runner.run()
  assert.equal(result.status, 'unsupported_capability')
  assert.equal(result.code, RESULT_CODES.UNSUPPORTED_CAPABILITY)
})

test('writing outside the allowed range blocks the task and changes nothing', async () => {
  const h = await harness('outside', { 'src/other/keep.ts': 'safe\n' }, {
    allowed_paths: ['src/knowledge/**'],
    forbidden_paths: ['src/ipc/**'],
    operations: [
      { op: 'write_file', path: 'src/other/keep.ts', content: 'overwritten\n' }
    ]
  })
  const result = await h.runner.run()
  assert.equal(result.status, 'blocked')
  assert.equal(result.code, RESULT_CODES.PATH_FORBIDDEN)
  assert.equal(fs.readFileSync(path.join(h.workspace, 'src/other/keep.ts'), 'utf8'), 'safe\n')
})

test('a forbidden path is a veto even when the whole tree is allowed', async () => {
  const h = await harness('veto', { 'src/ipc/bridge.ts': 'untouched\n' }, {
    allowed_paths: ['**'],
    forbidden_paths: ['src/ipc/**'],
    operations: [
      { op: 'write_file', path: 'src/ipc/bridge.ts', content: 'changed\n' }
    ]
  })
  const result = await h.runner.run()
  assert.equal(result.status, 'blocked')
  assert.equal(result.code, RESULT_CODES.PATH_FORBIDDEN)
  assert.equal(fs.readFileSync(path.join(h.workspace, 'src/ipc/bridge.ts'), 'utf8'), 'untouched\n')
})

test('high-risk and network commands block the task', async () => {
  const dangerous = await harness('dangerous', {}, {
    operations: [{ op: 'run_command', command: 'git push origin main' }]
  })
  const pushed = await dangerous.runner.run()
  assert.equal(pushed.status, 'blocked')
  assert.equal(pushed.code, RESULT_CODES.COMMAND_DENIED)

  const offline = await harness('offline', {}, {
    permissions: { read: true, write: true, shell: true, network: false },
    operations: [{ op: 'run_command', command: 'npm install' }]
  })
  const installed = await offline.runner.run()
  assert.equal(installed.status, 'blocked')
  assert.equal(installed.code, RESULT_CODES.PERMISSION_DENIED)
})

test('a command that exits non-zero fails the task with the real exit code', async () => {
  const h = await harness('command-fail', {}, {
    operations: [{ op: 'run_command', command: 'node -e "process.exit(3)"' }]
  })
  const result = await h.runner.run()
  assert.equal(result.status, 'failed')
  assert.equal(result.code, RESULT_CODES.OPERATION_FAILED)
  assert.match(result.reason, /exited 3/)
  assert.equal(h.reporter.commands[0].exitCode, 3)
})

test('command output reaches the terminal transcript and the events', async () => {
  const h = await harness('output', {}, {
    operations: [{ op: 'run_command', command: 'node -e "console.log(\'hello from the worker\')"' }]
  })
  const result = await h.runner.run()
  assert.equal(result.status, 'completed')
  const terminal = h.reporter.terminalTail().map((line) => line.text).join('\n')
  assert.match(terminal, /hello from the worker/)
  assert.equal(h.bus.recent().some((event) => event.type === 'command_output'), true)
})

test('a command timeout is reported as a timeout, not as a random failure', async () => {
  const h = await harness('timeout', {}, {
    operations: [{ op: 'run_command', command: 'node -e "setTimeout(()=>{},60000)"', timeoutMs: 700 }]
  })
  const started = Date.now()
  const result = await h.runner.run()
  assert.ok(Date.now() - started < 30_000, 'a timed-out command must be killed, not awaited')
  assert.equal(result.status, 'failed')
  assert.equal(result.code, RESULT_CODES.TIMEOUT)
  assert.match(result.reason, /timed out/)
})

test('cancelling a running task kills its command and reports cancellation', async () => {
  const h = await harness('cancel', {}, {
    operations: [
      { op: 'run_command', command: 'node -e "setTimeout(()=>{},60000)"' },
      { op: 'write_file', path: 'never.txt', content: 'x' }
    ]
  })
  const started = h.runner.run()
  await new Promise((resolve) => setTimeout(resolve, 400))
  h.controller.cancel('user pressed cancel')
  const result = await started
  assert.equal(result.status, 'cancelled')
  assert.equal(result.code, RESULT_CODES.CANCELLED)
  assert.match(result.reason, /user pressed cancel/)
  assert.equal(fs.existsSync(path.join(h.workspace, 'never.txt')), false, 'no further operation may start after a cancel')
  assert.equal(result.needs_controller_review, false)
})

test('pause stops new operations and resume continues the same task', async () => {
  const h = await harness('pause', {}, {
    operations: [
      { op: 'write_file', path: 'first.txt', content: '1' },
      { op: 'write_file', path: 'second.txt', content: '2' },
      { op: 'write_file', path: 'third.txt', content: '3' }
    ]
  })
  h.bus.subscribe((event) => {
    if (event.type === 'file_write' && event.path === 'first.txt') h.controller.pause('user paused')
  })

  const running = h.runner.run()
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(fs.existsSync(path.join(h.workspace, 'first.txt')), true)
  assert.equal(fs.existsSync(path.join(h.workspace, 'second.txt')), false, 'a paused worker starts no new tool action')

  h.controller.resume('user resumed')
  const result = await running
  assert.equal(result.status, 'completed')
  assert.equal(fs.existsSync(path.join(h.workspace, 'second.txt')), true)
  assert.equal(fs.existsSync(path.join(h.workspace, 'third.txt')), true)
})

test('cancelling while paused cannot deadlock', async () => {
  const h = await harness('pause-cancel', {}, {
    operations: [
      { op: 'write_file', path: 'first.txt', content: '1' },
      { op: 'write_file', path: 'second.txt', content: '2' }
    ]
  })
  h.controller.pause('paused')
  const running = h.runner.run()
  await new Promise((resolve) => setTimeout(resolve, 150))
  h.controller.cancel('cancelled while paused')
  const result = await running
  assert.equal(result.status, 'cancelled')
})

test('a Send Note is applied at the next execution boundary', async () => {
  const h = await harness('note', {}, {
    operations: [
      { op: 'write_file', path: 'allowed.txt', content: 'ok' },
      { op: 'write_file', path: 'forbidden.txt', content: 'nope' }
    ]
  })
  h.controller.addNote('Do not modify forbidden.txt. Only fix allowed.txt.')
  const result = await h.runner.run()
  assert.equal(result.status, 'blocked')
  assert.equal(result.code, RESULT_CODES.PATH_FORBIDDEN)
  assert.equal(fs.existsSync(path.join(h.workspace, 'forbidden.txt')), false)
  const applied = h.bus.recent().find((event) => event.type === 'note_applied')
  assert.ok(applied, 'the note application must be auditable')
  assert.match(applied.summary, /forbidden \+= forbidden\.txt/)
})

test('a structured note constrains the task the same way', async () => {
  const h = await harness('note-structured', {}, {
    operations: [{ op: 'write_file', path: 'src/ipc/bridge.ts', content: 'nope' }]
  })
  h.controller.addNote({ note: 'controller constraint', forbid: ['src/ipc/**'] })
  const result = await h.runner.run()
  assert.equal(result.status, 'blocked')
  assert.equal(fs.existsSync(path.join(h.workspace, 'src/ipc/bridge.ts')), false)
})

test('acceptance commands are the Controller verification gate', async () => {
  const passing = await harness('accept-pass', {}, {
    acceptance: ['All existing tests pass'],
    acceptance_commands: ['node -e "process.exit(0)"'],
    operations: [{ op: 'write_file', path: 'a.txt', content: 'a' }]
  })
  const ok = await passing.runner.run()
  assert.equal(ok.status, 'completed')
  assert.deepEqual(ok.acceptance, [{ criterion: 'acceptance command: node -e "process.exit(0)"', status: 'passed', verified: true, exitCode: 0 }])

  const failing = await harness('accept-fail', {}, {
    acceptance: ['All existing tests pass'],
    acceptance_commands: ['node -e "process.exit(1)"'],
    operations: [{ op: 'write_file', path: 'a.txt', content: 'a' }]
  })
  const bad = await failing.runner.run()
  assert.equal(bad.status, 'failed')
  assert.equal(bad.code, RESULT_CODES.ACCEPTANCE_FAILED)
  assert.equal(bad.acceptance[0].status, 'failed')
})

test('a prose-only acceptance criterion is flagged for Controller review', async () => {
  const h = await harness('accept-manual', {}, {
    acceptance: ['No public API breaking changes'],
    operations: [{ op: 'write_file', path: 'a.txt', content: 'a' }]
  })
  const result = await h.runner.run()
  assert.equal(result.status, 'completed')
  assert.deepEqual(result.acceptance, [{ criterion: 'No public API breaking changes', status: 'manual_review', verified: false }])
  assert.equal(result.needs_controller_review, true)
  assert.ok(h.reporter.warnings.some((text) => /acceptance criterion/.test(text)))
})

test('git state is re-read at the end so the Result reflects reality', async () => {
  const { spawnSync } = require('node:child_process')
  const root = scratchRoot('git')
  const workspace = path.join(root, 'repo')
  fs.mkdirSync(workspace, { recursive: true })
  const git = (args) => spawnSync('git', args, { cwd: workspace, encoding: 'utf8', windowsHide: true })
  git(['init', '-q'])
  git(['config', 'user.email', 't@example.com'])
  git(['config', 'user.name', 'test'])
  fs.writeFileSync(path.join(workspace, 'a.txt'), 'one\n')
  git(['add', '-A'])
  git(['commit', '-qm', 'init'])

  const h = await harness('git-task', {}, {
    operations: [{ op: 'write_file', path: 'a.txt', content: 'two\n' }]
  }, { workspaceDir: workspace })
  const result = await h.runner.run()
  assert.equal(result.status, 'completed')
  assert.equal(result.git.dirty, true, 'the workspace really is dirty after the edit')
  assert.ok(result.git.commit)
})

test('git diff and status are available as inspection operations', async () => {
  const { spawnSync } = require('node:child_process')
  const root = scratchRoot('git-ops')
  const workspace = path.join(root, 'repo')
  fs.mkdirSync(workspace, { recursive: true })
  const git = (args) => spawnSync('git', args, { cwd: workspace, encoding: 'utf8', windowsHide: true })
  git(['init', '-q'])
  git(['config', 'user.email', 't@example.com'])
  git(['config', 'user.name', 'test'])
  fs.writeFileSync(path.join(workspace, 'a.txt'), 'one\n')
  git(['add', '-A'])
  git(['commit', '-qm', 'init'])

  const h = await harness('git-ops-task', {}, {
    operations: [{ op: 'git_status' }, { op: 'git_diff' }]
  }, { workspaceDir: workspace })
  const result = await h.runner.run()
  assert.equal(result.status, 'completed')
  assert.equal(result.git.dirty, false)
  assert.equal(h.bus.recent().some((event) => event.type === 'diff_generated'), true)
})

test('a missing file or a bad patch fails the task without touching anything else', async () => {
  const missing = await harness('missing', {}, {
    operations: [{ op: 'read_file', path: 'nope.txt' }]
  })
  const readResult = await missing.runner.run()
  assert.equal(readResult.status, 'failed')

  const badPatch = await harness('bad-patch', { 'a.ts': 'const x = 1\n' }, {
    operations: [{ op: 'replace_in_file', path: 'a.ts', find: 'not present', replace: 'x' }]
  })
  const patchResult = await badPatch.runner.run()
  assert.equal(patchResult.status, 'failed')
  assert.match(patchResult.reason, /find string was not present/)
  assert.equal(fs.readFileSync(path.join(badPatch.workspace, 'a.ts'), 'utf8'), 'const x = 1\n')
})

test('a stranded workspace path is refused before any file access', () => {
  assert.throws(() => resolveInsideWorkspace('/tmp/ws', '../escape.txt'), /escapes the workspace/)
  assert.equal(resolveInsideWorkspace('/tmp/ws', 'inside.txt'), path.resolve('/tmp/ws', 'inside.txt'))
})

test('operation stages map onto the documented execution stages', () => {
  assert.equal(stageForOperation({ op: 'read_file' }), 'INSPECTING')
  assert.equal(stageForOperation({ op: 'git_status' }), 'INSPECTING')
  assert.equal(stageForOperation({ op: 'git_diff' }), 'PLANNING_EXECUTION')
  assert.equal(stageForOperation({ op: 'write_file' }), 'IMPLEMENTING')
  assert.equal(stageForOperation({ op: 'run_command' }), 'IMPLEMENTING')
  assert.equal(stageForOperation({ op: 'run_tests' }), 'TESTING')
  assert.equal(stageForOperation({ op: 'write_file' }, { afterFailedTest: true }), 'FIXING')
  assert.equal(stageForOperation({ op: 'unknown' }), null)
})

test('stopping on request reverts an isolated worktree when configured to', async () => {
  const { spawnSync } = require('node:child_process')
  const root = scratchRoot('revert')
  const workspace = path.join(root, 'worktree')
  fs.mkdirSync(workspace, { recursive: true })
  const git = (args) => spawnSync('git', args, { cwd: workspace, encoding: 'utf8', windowsHide: true })
  git(['init', '-q'])
  git(['config', 'core.autocrlf', 'false'])
  git(['config', 'user.email', 't@example.com'])
  git(['config', 'user.name', 'test'])
  fs.writeFileSync(path.join(workspace, 'a.txt'), 'original\n')
  git(['add', '-A'])
  git(['commit', '-qm', 'init'])
  fs.writeFileSync(path.join(workspace, 'a.txt'), 'modified\n')

  const task = { workspace_mode: 'isolated_worktree' }
  const kept = revertIfRequired(task, workspace, { keepChangesOnStop: true }, 'cancelled')
  assert.equal(kept.reverted, false)
  assert.equal(fs.readFileSync(path.join(workspace, 'a.txt'), 'utf8'), 'modified\n')

  // A completed task is never reverted: its changes are the deliverable the
  // Controller is about to review (plan §15 scopes this setting to Stop).
  const completed = revertIfRequired(task, workspace, { keepChangesOnStop: false }, 'completed')
  assert.equal(completed.reverted, false)
  assert.match(completed.reason, /completed work is kept/)
  assert.equal(fs.readFileSync(path.join(workspace, 'a.txt'), 'utf8'), 'modified\n')

  const reverted = revertIfRequired(task, workspace, { keepChangesOnStop: false }, 'cancelled')
  assert.equal(reverted.reverted, true)
  assert.equal(fs.readFileSync(path.join(workspace, 'a.txt'), 'utf8'), 'original\n')

  // A shared workspace is never touched by the worker.
  const shared = revertIfRequired({ workspace_mode: 'shared' }, workspace, { keepChangesOnStop: false }, 'cancelled')
  assert.equal(shared.reverted, false)
  assert.match(shared.reason, /shared workspace/)
})

test('a read-only task may not run git without shell permission', async () => {
  const h = await harness('no-shell-git', { 'a.txt': 'a\n' }, {
    permissions: { read: true },
    operations: [{ op: 'git_status' }]
  })
  const result = await h.runner.run()
  assert.equal(result.status, 'blocked')
  assert.equal(result.code, RESULT_CODES.PERMISSION_DENIED)
  assert.equal(h.reporter.commands.length, 0, 'no child process may be spawned without shell permission')
})

test('every executed operation produces an auditable event', async () => {
  const h = await harness('events', { 'a.txt': 'a\n' }, {
    operations: [
      { op: 'list_dir', path: '.' },
      { op: 'read_file', path: 'a.txt' },
      { op: 'write_file', path: 'b.txt', content: 'b' },
      { op: 'run_command', command: 'node -e "process.exit(0)"' },
      { op: 'run_tests', command: 'node -e "console.log(\'Tests: 1 passed, 1 total\')"' },
      { op: 'git_diff' }
    ]
  })
  const result = await h.runner.run()
  assert.equal(result.status, 'completed')
  const types = h.bus.recent().map((event) => event.type)
  for (const required of ['task_started', 'inspection_started', 'file_read', 'file_write', 'command_started', 'command_finished', 'test_started', 'test_result', 'diff_generated', 'task_completed']) {
    assert.ok(types.includes(required), `the event stream must contain ${required}`)
  }
})
