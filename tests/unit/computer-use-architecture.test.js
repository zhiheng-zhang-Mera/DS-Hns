'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { createComputerUseRuntime } = require('../../app/computer-use/index.cjs')
const { CODES, ComputerUseError } = require('../../app/computer-use/errors.cjs')

/**
 * Architecture and API boundaries (Update-Plan/cleaning-refactor.md phases R, S,
 * T, W and the error taxonomy).
 *
 * The runtime is meant to be host-agnostic and migratable, which is a property of
 * its *shape*: what depends on what, what the public surface exposes, and whether
 * any module keeps state across runs. Those are exactly the properties that decay
 * silently, so they are asserted rather than described.
 */
const ROOT = path.resolve(__dirname, '..', '..')
const CU = path.join(ROOT, 'app', 'computer-use')
const read = (relative) => fs.readFileSync(path.join(CU, relative), 'utf8')

const CORE_MODULES = fs.readdirSync(CU)
  .filter((name) => name.endsWith('.cjs'))
  .sort()

const CONTROLLERS = fs.readdirSync(path.join(CU, 'controllers'))
  .filter((name) => name.endsWith('.cjs'))
  .sort()

test('the dependency direction only points upward (phase T)', () => {
  // constants/errors -> pure policies -> controllers/observer -> executor ->
  // runtime index -> host/UI. A lower layer may not import a higher one, and no
  // core module may reach into the Electron host or the UI.
  const forbidden = {
    'focus.cjs': [/require\('\.\/executor/, /require\('\.\/index/],
    'modal.cjs': [/require\('\.\/executor/, /require\('electron'\)/, /require\('\.\.\/extensions/],
    'workspace.cjs': [/require\('\.\/executor/, /require\('\.\/index/, /require\('electron'\)/],
    'command.cjs': [/require\('\.\/executor/, /require\('electron'\)/],
    'processes.cjs': [/require\('\.\/executor/, /require\('electron'\)/],
    'resources.cjs': [/require\('\.\/executor/, /require\('electron'\)/],
    'reconnect.cjs': [/require\('\.\/executor/, /require\('electron'\)/],
    'mutation.cjs': [/require\('\.\/executor/, /require\('electron'\)/],
    'progress.cjs': [/require\('\.\/executor/, /require\('electron'\)/],
    'health.cjs': [/require\('\.\/executor/, /require\('electron'\)/],
    'evidence.cjs': [/require\('\.\/executor/, /require\('electron'\)/],
    'stall.cjs': [/require\('\.\/executor/, /require\('electron'\)/],
    'stabilization.cjs': [/require\('\.\/executor/, /require\('electron'\)/],
    'constants.cjs': [/require\('\.\/executor/, /require\('\.\.\/extensions/],
    'errors.cjs': [/require\('\.\/executor/, /require\('\.\.\/extensions/]
  }
  for (const [file, patterns] of Object.entries(forbidden)) {
    const source = read(file)
    for (const pattern of patterns) {
      assert.equal(pattern.test(source), false, `${file} must not import upward (${pattern})`)
    }
  }
  // No controller knows about another controller, and none of them owns fallback
  // policy: fallback order belongs to routing and the executor.
  for (const file of CONTROLLERS) {
    const source = read(path.join('controllers', file))
    assert.equal(/require\('\.\/\w+\.cjs'\)/.test(source), false, `${file} must not import a sibling controller`)
    assert.equal(/require\('\.\.\/index\.cjs'\)/.test(source), false, `${file} must not import the runtime index`)
    assert.equal(/require\('electron'\)/.test(source), false, `${file} must not require electron`)
  }
  // The runtime core never names the host product's own directories.
  for (const file of [...CORE_MODULES, ...CONTROLLERS.map((name) => path.join('controllers', name))]) {
    const source = read(file)
    assert.equal(/desktop-main/.test(source), false, `${file} must not reference the shell entry point`)
  }
})

test('the runtime exposes the generic surface and keeps its internals private (phase R)', () => {
  const runtime = createComputerUseRuntime({ host: {}, log: false })
  // The public surface the plan names.
  for (const name of ['run', 'cancel', 'dispose', 'health', 'capabilities', 'canExecute', 'snapshot']) {
    assert.equal(typeof runtime[name], 'function', `the runtime must expose ${name}()`)
  }
  // The debug readers are read-only snapshots: no registry, no budget, no
  // controller mutation, no state machine handle.
  const processes = runtime.processes()
  for (const mutator of ['register', 'settle', 'kill', 'dispose', 'release']) {
    assert.equal(processes[mutator], undefined, `processes() must not expose ${mutator}`)
  }
  const resources = runtime.resources()
  for (const mutator of ['registerScreenshot', 'enforce', 'ring']) {
    assert.equal(resources[mutator], undefined, `resources() must not expose ${mutator}`)
  }
  // The health snapshot is a report: calling it twice changes nothing, and it
  // never throws even when the runtime has no controllers at all.
  const first = runtime.health()
  const second = runtime.health()
  assert.equal(first.status, second.status)
  assert.equal(typeof first.status, 'string')
  assert.ok(Array.isArray(first.blockReasons))
  assert.ok(Array.isArray(first.degradedCapabilities))
  // "Stop one process I own" is a real operation and therefore a separate call,
  // never a property of the report.
  assert.equal(typeof runtime.killOwned, 'function')
  runtime.dispose('test teardown')
})

test('the health API answers only healthy, degraded or blocked (phase Q)', () => {
  const runtime = createComputerUseRuntime({ host: {}, log: false })
  const health = runtime.health()
  assert.ok(['healthy', 'degraded', 'blocked'].includes(health.status))
  for (const field of ['capabilities', 'workspace', 'resourcePressure', 'activeOwnedProcesses', 'lastProgressAt', 'stallLevel', 'currentStep', 'faults', 'blockReasons']) {
    assert.ok(field in health, `the health snapshot must carry ${field}`)
  }
  runtime.dispose('test teardown')
})

test('the error taxonomy is a closed, machine-readable vocabulary', () => {
  const documented = [
    'ACTION_INVALID',
    'ACTION_TIMEOUT',
    'TARGET_NOT_FOUND',
    'TARGET_STALE',
    'FOCUS_MISMATCH',
    'MODAL_REQUIRES_USER',
    'CAPABILITY_UNAVAILABLE',
    'WORKSPACE_UNAVAILABLE',
    'WORKSPACE_MISMATCH',
    'RESOURCE_LIMIT',
    'PROCESS_INVALID',
    'TRANSPORT_LOST',
    'RECONNECT_EXHAUSTED',
    'VERIFICATION_FAILED',
    'VERIFICATION_UNKNOWN',
    'RUN_CANCELLED',
    'RUN_TIMEOUT'
  ]
  for (const name of documented) {
    assert.equal(typeof CODES[name], 'string', `the taxonomy must name ${name}`)
    assert.ok(CODES[name].length > 0)
  }
  // A transport failure and a modal that needs a user are the same code whichever
  // synonym a caller uses.
  assert.equal(CODES.TRANSPORT_LOST, CODES.CONTROLLER_UNAVAILABLE)
  assert.equal(CODES.MODAL_REQUIRES_USER, CODES.MODAL_BLOCKING)
  // Recovery decisions are made from the code, never by parsing a message.
  const error = new ComputerUseError(CODES.WORKSPACE_UNAVAILABLE, 'irgendeine Meldung')
  assert.equal(error.code, CODES.WORKSPACE_UNAVAILABLE)
  assert.equal(error.retryable, false)
  assert.equal(new ComputerUseError(CODES.TARGET_STALE, 'x').retryable, true)
  // Every code in the object is an uppercase token: no prose leaks into the
  // vocabulary a caller switches on.
  for (const [name, value] of Object.entries(CODES)) {
    assert.match(value, /^[A-Z][A-Z0-9_]*$/, `${name} must be a machine token`)
  }
})

test('no module keeps state across runs (phase W)', () => {
  // A fresh runtime must start from a clean slate, and a module-level mutable
  // singleton would show up as state surviving a second construction. The proxies
  // here are the structures a hidden cache would live in.
  const first = createComputerUseRuntime({ host: {}, log: false })
  const firstHealth = first.health()
  first.dispose('test teardown')
  const second = createComputerUseRuntime({ host: {}, log: false })
  const secondHealth = second.health()
  assert.equal(secondHealth.activeOwnedProcesses, 0, 'a new runtime must own nothing')
  assert.equal(secondHealth.stallLevel, 0, 'a new runtime must not inherit a stall level')
  assert.equal(secondHealth.lastProgressAt, null, 'a new runtime must not inherit progress')
  assert.deepEqual(secondHealth.faults, [], 'a new runtime must not inherit faults')
  second.dispose('test teardown')

  // And the source carries no module-level mutable history: every "let … = null"
  // that would act as a cache lives inside a factory, not at module scope.
  for (const file of CORE_MODULES) {
    const source = read(file)
    const moduleLevel = source.split('\n').filter((line) => /^(let|var)\s+\w+\s*=/.test(line))
    assert.deepEqual(moduleLevel, [], `${file} must not hold module-level mutable state`)
  }
})

test('the runtime reads filesystem state through the host ports, not through the host itself (phase Y)', () => {
  // Migratability: the core is driven entirely by the ports the host injects. A
  // runtime constructed with no host at all must still assemble, report health and
  // dispose — anything else would mean it depends on a specific Electron host.
  const runtime = createComputerUseRuntime({ host: {}, log: false })
  assert.equal(typeof runtime.run, 'function')
  const health = runtime.health()
  assert.ok(health.status)
  const capability = runtime.canExecute('DOM_CLICK')
  assert.equal(typeof capability.ok, 'boolean')
  assert.ok(typeof capability.reason === 'string' && capability.reason.length > 0)
  runtime.dispose('test teardown')
  // The host bridge is the only file that knows about Electron.
  for (const file of CORE_MODULES) {
    if (file === 'host-electron.cjs') continue
    assert.equal(/require\('electron'\)/.test(read(file)), false, `${file} must not require electron`)
  }
})
