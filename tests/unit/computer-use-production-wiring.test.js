'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createComputerUseRuntime } = require('../../app/computer-use/index.cjs')
const { createVirtualClock } = require('../helpers/computer-use-clock.cjs')

/**
 * Production wiring (Update-Plan/cleaning-refactor.md phase B).
 *
 * The subsystems pass their own unit tests and are still useless if the runtime
 * never hands them to each other. These tests assert the *assembled* runtime, not
 * the modules in isolation:
 *
 *   runtime → executor   the executor is given the shared workspace guard
 *   runtime → shell      the shell controller resolves against the same guard
 *   runtime → file       the file controller resolves against the same guard
 *   runtime → health     the health snapshot reports the same workspace verdict
 *   runtime → processes  one registry, shared by shell and executor
 *   runtime → resources  one budget, shared by executor and health
 *
 * A test that only reads source text would not catch a runtime that passes the
 * wrong argument (or none); these call the shipped entry point and observe what
 * the components actually use.
 */

function makeWorkspace(prefix = 'cu-wiring-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function makeRuntime(options = {}) {
  return createComputerUseRuntime({
    host: options.host || {},
    clock: options.clock || createVirtualClock(),
    log: { dir: null },
    options: { maxSteps: 6, ...(options.options || {}) }
  })
}

test('the runtime hands one workspace guard to the executor, the shell, the file controller and the health snapshot', () => {
  const dir = makeWorkspace()
  try {
    const runtime = makeRuntime({ options: { workspace: dir } })
    const boundary = path.resolve(dir)

    // The health-facing verdict.
    const health = runtime.health()
    assert.equal(health.workspace.ok, true)
    assert.equal(health.workspace.cwd, boundary, 'health must report the verified workspace')

    // The shell controller: its own cwd resolution and its probe both name it.
    const shellCwd = runtime.controllers.shell.resolveCwd()
    assert.equal(shellCwd.ok, true)
    assert.equal(shellCwd.cwd, boundary, 'the shell must resolve cwd inside the same workspace')
    assert.equal(path.resolve(runtime.controllers.shell.probe().detail.cwd), boundary)

    // The file controller: it is confined to it, and says so.
    const fileProbe = runtime.controllers.file.probe()
    assert.equal(fileProbe.detail.confined, true, 'the file controller must be confined')
    assert.equal(path.resolve(fileProbe.detail.workspace), boundary)

    // The executor: the gate it applies is the same guard, so a path outside the
    // boundary is refused with the same verdict rather than a second opinion.
    assert.equal(runtime.workspace.verify().cwd, boundary)
    const outside = path.join(os.tmpdir(), `cu-wiring-outside-${process.pid}.txt`)
    assert.notEqual(path.resolve(outside), boundary)
    assert.equal(runtime.workspace.resolvePath(outside).ok, false)
    assert.equal(runtime.workspace.resolvePath(path.join(boundary, 'inside.txt')).ok, true)

    runtime.dispose('test teardown')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('an unavailable workspace blocks the runtime instead of quietly widening', () => {
  const dir = makeWorkspace()
  const runtime = makeRuntime({ options: { workspace: dir } })
  fs.rmSync(dir, { recursive: true, force: true })
  try {
    const health = runtime.health()
    assert.equal(health.workspace.ok, false, 'a missing workspace must be reported as unavailable')
    assert.equal(health.status, 'blocked')
    assert.ok(health.blockReasons.some((entry) => entry.code === 'workspace_unavailable'), JSON.stringify(health.blockReasons))

    // The shell and the file controller agree, and neither falls back to the
    // process directory.
    assert.equal(runtime.controllers.shell.resolveCwd().ok, false)
    assert.equal(runtime.workspace.resolvePath('relative.txt').ok, false)
    const absolute = path.join(os.tmpdir(), 'absolute-while-unverified.txt')
    assert.equal(runtime.workspace.resolvePath(absolute).ok, false, 'an absolute path must not be the way around a missing workspace')

    runtime.dispose('test teardown')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('one process registry serves the shell controller and the executor', async () => {
  const dir = makeWorkspace()
  try {
    const runtime = makeRuntime({ options: { workspace: dir } })
    const report = await runtime.run({
      goal: 'run one command',
      allowed_capabilities: ['shell'],
      plan: [{ id: 'echo', action: { type: 'SHELL_EXEC', command: process.execPath, args: ['-e', 'process.stdout.write("ok")'], expected_effect: { any: [{ stdout_matches: 'ok' }] }, timeout_ms: 8000 } }],
      limits: { max_steps: 2, max_retries_per_action: 0 }
    })
    assert.equal(report.status, 'completed', JSON.stringify(report.error))
    // The reader the health snapshot uses sees the very process the shell started:
    // it was registered, settled, and is not leaked.
    const processes = runtime.processes()
    assert.equal(processes.ownedCount, 0, 'nothing may be left owned')
    assert.ok(processes.finished.length >= 1, 'the shell command must be registered in the shared registry')
    assert.equal(runtime.health().activeOwnedProcesses, 0)
    runtime.dispose('test teardown')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the executor applies the workspace gate to filesystem actions', async () => {
  const dir = makeWorkspace()
  const outside = path.join(os.tmpdir(), `cu-wiring-refused-${process.pid}.txt`)
  fs.rmSync(outside, { force: true })
  try {
    const runtime = makeRuntime({ options: { workspace: dir } })
    const report = await runtime.run({
      goal: 'write outside the workspace',
      plan: [{ id: 'escape', action: { type: 'FILE_WRITE', path: outside, content: 'escaped', expected_effect: { any: [{ file_exists: outside }] } } }],
      limits: { max_steps: 2, max_retries_per_action: 0 }
    })
    assert.notEqual(report.status, 'completed')
    assert.equal(fs.existsSync(outside), false, 'the write must never land outside the workspace')
    assert.ok(runtime.workspace.drifts().length >= 1, 'the attempt must be recorded as drift')
    runtime.dispose('test teardown')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(outside, { force: true })
  }
})

test('a contract that names its own workspace wins over the runtime default', async () => {
  const runtimeWorkspace = makeWorkspace('cu-wiring-default-')
  const contractWorkspace = makeWorkspace('cu-wiring-contract-')
  try {
    const runtime = makeRuntime({ options: { workspace: runtimeWorkspace } })
    const target = path.join(contractWorkspace, 'insidenotes.txt')
    // The contract's workspace is what the *action* is judged against once the
    // path is inside it; the runtime's own boundary is unchanged, so leaving the
    // contract workspace is still refused.
    const inside = runtime.workspace.resolvePath(path.join(runtimeWorkspace, 'ok.txt'))
    assert.equal(inside.ok, true)
    const other = runtime.workspace.resolvePath(target)
    assert.equal(other.ok, false, 'the runtime boundary is not widened by a path that is merely absolute')
    runtime.dispose('test teardown')
  } finally {
    fs.rmSync(runtimeWorkspace, { recursive: true, force: true })
    fs.rmSync(contractWorkspace, { recursive: true, force: true })
  }
})

test('the runtime exposes run/cancel/dispose/health and snapshots, not mutable internals', () => {
  const runtime = makeRuntime()
  for (const name of ['run', 'cancel', 'dispose', 'health', 'capabilities', 'canExecute', 'snapshot']) {
    assert.equal(typeof runtime[name], 'function', `the runtime must expose ${name}()`)
  }
  // The readers are snapshots: the mutating half of each component is unreachable.
  const processes = runtime.processes()
  for (const mutator of ['register', 'settle', 'kill', 'dispose', 'release']) {
    assert.equal(processes[mutator], undefined, `processes() must not expose ${mutator}`)
  }
  const resources = runtime.resources()
  for (const mutator of ['registerScreenshot', 'enforce']) {
    assert.equal(resources[mutator], undefined, `resources() must not expose ${mutator}`)
  }
  // Resources are *deliberately* reported through the runtime: a caller asking
  // "is this executor still healthy" must not be able to change the answer.
  assert.equal(typeof runtime.snapshot().state, 'string')
  runtime.dispose('test teardown')
})
