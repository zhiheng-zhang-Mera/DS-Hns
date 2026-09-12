'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { parseTestOutput, resolveTestResult, Reporter, createTaskLogger } = require('../../app/sub-worker/reporter.cjs')

/**
 * Reporting layer (plan §8, §12, §13, §14, §26): what the user and the
 * Controller are allowed to see, and what they are not.
 */

function scratchRoot(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-sub-report-${name}-`))
  fs.mkdirSync(path.join(root, 'config'), { recursive: true })
  return root
}

test('node:test TAP summaries are parsed exactly', () => {
  const output = [
    'TAP version 13',
    '# Subtest: adds numbers',
    'ok 1 - adds numbers',
    '# Subtest: handles zero',
    'ok 2 - handles zero',
    'not ok 3 - handles negatives',
    '# tests 3',
    '# pass 2',
    '# fail 1',
    '# skipped 1'
  ].join('\n')
  const parsed = parseTestOutput(output)
  assert.equal(parsed.parser, 'node-test')
  assert.equal(parsed.passed, 2)
  assert.equal(parsed.failed, 1)
  assert.equal(parsed.skipped, 1)
  assert.equal(parsed.total, 4)
})

test('jest and vitest style summaries are parsed exactly', () => {
  const parsed = parseTestOutput('Tests:       2 failed, 40 passed, 42 total\nTest Suites: 1 failed, 3 passed, 4 total')
  assert.equal(parsed.parser, 'jest-style')
  assert.equal(parsed.passed, 40)
  assert.equal(parsed.failed, 2)
  assert.equal(parsed.total, 42)
})

test('mocha style summaries are parsed exactly', () => {
  const parsed = parseTestOutput('  41 passing (2s)\n  2 failing\n  1 pending')
  assert.equal(parsed.parser, 'mocha-style')
  assert.equal(parsed.passed, 41)
  assert.equal(parsed.failed, 2)
  assert.equal(parsed.skipped, 1)
  assert.equal(parsed.total, 44)
})

test('an unparsable transcript is reported as inferred, never invented', () => {
  const ok = resolveTestResult(parseTestOutput('all good, trust me'), 0)
  assert.equal(ok.parser, 'exit-code')
  assert.equal(ok.inferred, true)
  assert.equal(ok.passed, 1)
  assert.equal(ok.failed, 0)

  const bad = resolveTestResult(parseTestOutput('boom'), 1)
  assert.equal(bad.failed, 1)
  assert.equal(bad.inferred, true)

  // A parsed summary keeps its exact numbers.
  const parsed = resolveTestResult(parseTestOutput('# pass 7\n# fail 0'), 0)
  assert.equal(parsed.passed, 7)
  assert.equal(parsed.inferred, undefined)
  assert.equal(parsed.parser, 'node-test')
})

test('the execution summary is built from events only', () => {
  const root = scratchRoot('summary')
  const reporter = new Reporter({ root, taskId: 'boss-kb-031' })
  const events = [
    { type: 'task_received', summary: 'Task received: Implement adapter' },
    { type: 'inspection_started', summary: 'Inspected existing store API' },
    { type: 'file_read', path: 'src/knowledge/index.ts' },
    { type: 'file_write', path: 'src/knowledge/sqlite.ts', op: 'create' },
    { type: 'command_started', command: 'npm test -- sqlite' },
    { type: 'command_output', text: 'running tests\n41 passed\n2 failed\n' },
    { type: 'command_finished', command: 'npm test -- sqlite', exitCode: 1 },
    { type: 'test_result', command: 'npm test -- sqlite', passed: 41, failed: 2, skipped: 0, parser: 'jest-style' },
    { type: 'warning', summary: 'Detected a failing rollback test' },
    { type: 'git_status', branch: 'hns-sub-worker', dirty: true },
    { type: 'task_failed', summary: 'two tests still fail' }
  ]
  for (const event of events) reporter.record({ timestamp: new Date().toISOString(), task_id: 'boss-kb-031', ...event })

  const lines = reporter.summaryLines()
  const text = lines.map((line) => line.text).join('\n')
  assert.match(text, /Inspected existing store API/)
  assert.match(text, /Created src\/knowledge\/sqlite\.ts/)
  assert.match(text, /Running npm test -- sqlite/)
  assert.match(text, /41 passed \/ 2 failed/)
  assert.match(text, /Git status: hns-sub-worker \(dirty\)/)
  assert.match(text, /Detected a failing rollback test/)
  // Nothing that looks like hidden reasoning or a scratchpad may appear.
  for (const forbidden of ['chain-of-thought', 'thinking', 'scratchpad', 'reasoning']) {
    assert.equal(new RegExp(forbidden, 'i').test(text), false, `the summary must not expose ${forbidden}`)
  }
  fs.rmSync(root, { recursive: true, force: true })
})

test('changed files, tests, git state and the terminal transcript are tracked', () => {
  const root = scratchRoot('tracking')
  const reporter = new Reporter({ root, taskId: 't-1' })
  const at = new Date().toISOString()
  reporter.record({ timestamp: at, type: 'file_write', path: 'src/knowledge/sqlite.ts', op: 'update' })
  reporter.record({ timestamp: at, type: 'file_write', path: 'tests/knowledge/sqlite.test.ts', op: 'create' })
  reporter.record({ timestamp: at, type: 'file_delete', path: 'src/knowledge/legacy.ts' })
  reporter.record({ timestamp: at, type: 'command_started', command: 'npm test -- sqlite' })
  reporter.record({ timestamp: at, type: 'command_output', text: 'line one\nline two\n' })
  reporter.record({ timestamp: at, type: 'command_finished', command: 'npm test -- sqlite', exitCode: 1, timedOut: false })
  reporter.record({ timestamp: at, type: 'test_result', command: 'npm test -- sqlite', passed: 41, failed: 2, skipped: 1, parser: 'jest-style' })
  reporter.record({ timestamp: at, type: 'git_status', branch: 'hns-sub-worker', commit: 'abc', dirty: true })

  const details = reporter.changedFileList()
  assert.deepEqual(details, [
    { path: 'src/knowledge/sqlite.ts', status: 'M' },
    { path: 'tests/knowledge/sqlite.test.ts', status: 'A' },
    { path: 'src/knowledge/legacy.ts', status: 'D' }
  ])
  assert.deepEqual(reporter.tests, { passed: 41, failed: 2, skipped: 1, parser: 'jest-style' })
  assert.deepEqual(reporter.git, { dirty: true, commit: 'abc', branch: 'hns-sub-worker' })

  const terminal = reporter.terminalTail().map((line) => line.text)
  assert.deepEqual(terminal, ['> npm test -- sqlite', 'line one', 'line two', 'npm test -- sqlite -> exit 1'])

  const result = reporter.buildResult('t-1', { status: 'failed' })
  assert.deepEqual(result.changed_files, ['src/knowledge/sqlite.ts', 'tests/knowledge/sqlite.test.ts', 'src/knowledge/legacy.ts'])
  assert.deepEqual(result.changed_file_details[1], { path: 'tests/knowledge/sqlite.test.ts', status: 'A' })
  assert.deepEqual(result.tests, { passed: 41, failed: 2, skipped: 1, parser: 'jest-style' })
  assert.equal(result.git.dirty, true)
  fs.rmSync(root, { recursive: true, force: true })
})

test('the per-task log records tools, commands, results and errors', () => {
  const root = scratchRoot('log')
  const reporter = new Reporter({ root, taskId: 'boss-kb-031' })
  const at = new Date().toISOString()
  reporter.record({ timestamp: at, type: 'command_started', command: 'npm test' })
  reporter.record({ timestamp: at, type: 'command_finished', command: 'npm test', exitCode: 1 })
  reporter.record({ timestamp: at, type: 'error', summary: 'assertion failed' })
  reporter.record({ timestamp: at, type: 'file_write', path: 'src/a.ts', op: 'create' })

  const file = path.join(root, 'logs', 'sub-worker', 'boss-kb-031.log')
  assert.equal(fs.existsSync(file), true)
  const text = fs.readFileSync(file, 'utf8')
  assert.match(text, /\[command_started\] cmd=npm test/)
  assert.match(text, /\[command_finished\] cmd=npm test \| exit=1/)
  assert.match(text, /\[error\] assertion failed/)
  assert.match(text, /\[file_write\] path=src\/a\.ts/)
  assert.equal(reporter.describe().log_file, file)
  fs.rmSync(root, { recursive: true, force: true })
})

test('secrets never reach a task log', () => {
  const root = scratchRoot('log-redaction')
  const reporter = new Reporter({ root, taskId: 't-secret' })
  reporter.record({ timestamp: new Date().toISOString(), type: 'command_started', command: 'curl "http://x/?token=abcdef123456"' })
  reporter.record({ timestamp: new Date().toISOString(), type: 'error', summary: 'bad key sk-abcdefghijklmnop' })
  const text = fs.readFileSync(path.join(root, 'logs', 'sub-worker', 't-secret.log'), 'utf8')
  assert.equal(/abcdef123456/.test(text), false)
  assert.equal(/sk-abcdefghijklmnop/.test(text), false)
  assert.match(text, /token=\[REDACTED\]/)
  fs.rmSync(root, { recursive: true, force: true })
})

test('the task log file name is sanitized', () => {
  const root = scratchRoot('log-name')
  const logger = createTaskLogger(root, '../../evil name')
  assert.ok(logger.file.startsWith(path.join(root, 'logs', 'sub-worker')))
  assert.equal(path.basename(logger.file).includes('..'), false)
  fs.rmSync(root, { recursive: true, force: true })
})

test('the worker-side Live View payload carries every section it owns', () => {
  const root = scratchRoot('live')
  const reporter = new Reporter({ root, taskId: 't-live' })
  const at = new Date().toISOString()
  reporter.record({ timestamp: at, type: 'file_write', path: 'src/a.ts', op: 'create' })
  reporter.record({ timestamp: at, type: 'test_result', command: 'npm test', passed: 1, failed: 0, skipped: 0, parser: 'node-test' })
  reporter.record({ timestamp: at, type: 'warning', summary: 'slow command' })
  reporter.record({ timestamp: at, type: 'command_started', command: 'npm test' })
  reporter.record({ timestamp: at, type: 'command_finished', command: 'npm test', exitCode: 0 })
  reporter.record({ timestamp: at, type: 'git_status', branch: 'hns-sub-worker', dirty: false })
  reporter.recordAcceptance([{ criterion: 'All existing tests pass', status: 'passed', verified: true }])

  const live = reporter.describe()
  // `result` is deliberately absent here: the Result Object is produced at task
  // end and merged into the Live View by the WorkerManager, which is what the
  // dock renders. See the manager's "Live View streams the run" test.
  for (const key of ['task_id', 'summary', 'changed_files', 'terminal', 'tests', 'commands', 'warnings', 'errors', 'git', 'acceptance', 'log_file']) {
    assert.ok(key in live, `the Live View payload must expose ${key}`)
  }
  assert.equal('result' in live, false, 'the in-worker projection does not own the Result Object')
  assert.equal(live.changed_files[0].path, 'src/a.ts')
  assert.equal(live.tests.parser, 'node-test')
  assert.equal(live.warnings.length, 1)
  assert.equal(live.acceptance[0].status, 'passed')
  assert.equal(live.commands[0].command, 'npm test')
  assert.equal(live.commands[0].exitCode, 0)
  fs.rmSync(root, { recursive: true, force: true })
})

test('a reporter can be reset for the next task without leaking state', () => {
  const root = scratchRoot('reset')
  const reporter = new Reporter({ root, taskId: 't-1' })
  reporter.record({ timestamp: new Date().toISOString(), type: 'file_write', path: 'src/a.ts', op: 'create' })
  reporter.reset('t-2')
  const live = reporter.describe()
  assert.equal(live.task_id, 't-2')
  assert.deepEqual(live.changed_files, [])
  assert.deepEqual(live.summary, [])
  fs.rmSync(root, { recursive: true, force: true })
})

test('test runs are summarised per command for the Controller', () => {
  const root = scratchRoot('test-runs')
  const reporter = new Reporter({ root, taskId: 't-1' })
  const at = new Date().toISOString()
  reporter.record({ timestamp: at, type: 'test_result', command: 'npm test -- a', passed: 1, failed: 1, skipped: 0, parser: 'jest-style' })
  reporter.record({ timestamp: at, type: 'test_result', command: 'npm test -- a', passed: 2, failed: 0, skipped: 0, parser: 'jest-style' })
  const runs = reporter.describe().test_runs
  assert.equal(runs.length, 2)
  assert.equal(runs[0].failed, 1)
  assert.equal(runs[1].failed, 0)
  assert.equal(reporter.testRuns.at(-1).passed, 2)
  fs.rmSync(root, { recursive: true, force: true })
})
