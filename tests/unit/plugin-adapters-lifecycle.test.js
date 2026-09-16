'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { createErrorReporter, normalizeHealth, unifyLifecycle, LIFECYCLE_STATES, DEFAULT_ERROR_LIMIT } = require('../../app/core/plugin-adapters/lifecycle.cjs')
const { ADAPTER_API_VERSION, RUNTIME_KINDS } = require('../../app/core/plugin-adapters/contract.cjs')
const { HEALTH_STATUS } = require('../../app/core/contracts/plugin.cjs')

/**
 * The unified lifecycle.
 *
 * An adapted plugin must answer exactly like a hand-written one, whatever the adapter had to do.
 * These tests are about the four guarantees the module makes: a missing hook is a no-op, a throw
 * is a coded value, a health check always answers in the health vocabulary, and an unload always
 * releases.
 */

const ADAPTER = { id: 'test.adapter', version: '1.0.0', api_version: ADAPTER_API_VERSION }

function manifest(overrides = {}) {
  return { api_version: 'dshns.plugin/v1', id: 'test.plugin', name: 'Test', version: '1.0.0', ...overrides }
}

function unify(descriptor = {}, overrides = {}) {
  return unifyLifecycle({
    descriptor: { manifest: manifest(), ...descriptor },
    adapter: ADAPTER,
    runtime: { kind: RUNTIME_KINDS.IN_PROCESS.id, enforcement: 'advisory', isolation: 'none' },
    log: () => {},
    ...overrides
  })
}

test('a plugin with no hooks is a legitimate plugin, not a crash', async () => {
  const plugin = unify()
  assert.equal(plugin.lifecycleState(), LIFECYCLE_STATES.NEW)
  assert.deepEqual(await plugin.install({}), { ok: true, skipped: true })
  assert.equal((await plugin.load({})).ok, true)
  assert.equal(plugin.lifecycleState(), LIFECYCLE_STATES.LOADED)
  assert.equal((await plugin.unload({})).ok, true)
  assert.equal(plugin.lifecycleState(), LIFECYCLE_STATES.UNLOADED)
  // Every hook is present as a function whatever the adapter supplied, which is what lets the
  // manager call them unconditionally.
  for (const hook of ['install', 'load', 'unload', 'healthCheck', 'runtimeInfo', 'errorReport', 'diagnostics']) {
    assert.equal(typeof plugin[hook], 'function', `${hook} must exist`)
  }
})

test('load and unload are idempotent, because a hot reload does both twice', async () => {
  let loads = 0
  let unloads = 0
  const plugin = unify({
    async load() {
      loads += 1
    },
    async unload() {
      unloads += 1
    }
  })
  await plugin.load({})
  const second = await plugin.load({})
  assert.equal(second.already, true, 'a second load must be a no-op, not a second activation')
  assert.equal(loads, 1)

  await plugin.unload({})
  const again = await plugin.unload({})
  assert.equal(again.already, true)
  assert.equal(unloads, 1)
  assert.equal((await plugin.unload({})).ok, true, 'unloading an unloaded plugin is success, not an error')
})

test('a hook that throws becomes a coded error attributed to a phase', async () => {
  const plugin = unify({
    async load() {
      throw new Error('activation exploded')
    }
  })
  await assert.rejects(() => plugin.load({}), (error) => {
    assert.equal(error.message, 'activation exploded')
    assert.equal(error.code, 'ADAPTER_THREW')
    assert.equal(error.phase, 'load')
    assert.equal(error.plugin, 'test.plugin')
    return true
  })
  assert.equal(plugin.lifecycleState(), LIFECYCLE_STATES.FAILED)
  const reported = plugin.errorReport()
  assert.equal(reported.total, 1)
  assert.equal(reported.errors[0].phase, 'load')
  assert.equal(reported.byCode.ADAPTER_THREW, 1)
})

test('an unload that throws is reported, and the plugin is still released', async () => {
  const plugin = unify({
    async unload() {
      throw new Error('teardown exploded')
    }
  })
  await plugin.load({})
  const outcome = await plugin.unload({})
  // The failure is recorded — it is a real fault — but the state machine still advances, because
  // "unloaded" is the fact that matters to everything downstream.
  assert.equal(outcome.ok, true)
  assert.equal(outcome.hookFailed.phase, 'unload')
  assert.equal(plugin.lifecycleState(), LIFECYCLE_STATES.UNLOADED)
  assert.equal(plugin.errorReport().total, 1)
})

test('a health check never throws and always answers in the health vocabulary', async () => {
  const notLoaded = unify()
  assert.equal((await notLoaded.healthCheck()).status, HEALTH_STATUS.UNKNOWN)

  const noHook = unify()
  await noHook.load({})
  const unknown = await noHook.healthCheck()
  assert.equal(unknown.status, HEALTH_STATUS.UNKNOWN)
  assert.match(unknown.reason, /no healthCheck/)

  const throwing = unify({
    async healthCheck() {
      throw new Error('the probe exploded')
    }
  })
  await throwing.load({})
  const unhealthy = await throwing.healthCheck()
  assert.equal(unhealthy.status, HEALTH_STATUS.UNHEALTHY)
  assert.match(unhealthy.reason, /the probe exploded/)
  assert.equal(typeof unhealthy.latency_ms, 'number')
  assert.equal(throwing.errorReport().total, 1)

  // A status outside the vocabulary is not passed through: a caller branching on it would
  // otherwise end up in a state the platform has no policy for.
  const nonsense = unify({ async healthCheck() { return { status: 'fine-thanks' } } })
  await nonsense.load({})
  assert.equal((await nonsense.healthCheck()).status, HEALTH_STATUS.UNKNOWN)

  const healthy = unify({ async healthCheck() { return { status: 'healthy', reason: 'all good', latency_ms: 12 } } })
  await healthy.load({})
  const result = await healthy.healthCheck()
  assert.equal(result.status, HEALTH_STATUS.HEALTHY)
  assert.equal(result.latency_ms, 12)
})

test('health normalisation is total: any input produces a usable answer', () => {
  assert.equal(normalizeHealth(null).status, HEALTH_STATUS.UNKNOWN)
  assert.equal(normalizeHealth('healthy').status, HEALTH_STATUS.UNKNOWN)
  assert.equal(normalizeHealth({ status: 'degraded' }).status, HEALTH_STATUS.DEGRADED)
  assert.equal(normalizeHealth({ status: 'healthy', latency_ms: 'fast' }).latency_ms, null, 'a non-numeric latency is null, not NaN')
  assert.equal(typeof normalizeHealth({ status: 'healthy' }).at, 'number')
})

test('runtime information is a live answer, and it outlives the plugin', async () => {
  const plugin = unify({
    runtimeInfo: () => ({ pid: 4242, child: 'worker.js' })
  })
  const before = plugin.runtimeInfo()
  assert.equal(before.state, LIFECYCLE_STATES.NEW)
  assert.equal(before.kind, RUNTIME_KINDS.IN_PROCESS.id)
  assert.equal(before.enforcement, 'advisory')
  assert.equal(before.adapter.id, 'test.adapter')
  assert.equal(before.pid, null, 'a plugin that is not loaded has no pid')

  await plugin.load({})
  const loaded = plugin.runtimeInfo()
  assert.equal(loaded.state, LIFECYCLE_STATES.LOADED)
  assert.equal(loaded.pid, 4242, 'the adapter\'s own runtime facts are merged in')
  assert.equal(loaded.detail.child, 'worker.js')
  assert.equal(loaded.loads, 1)
  // Uptime is computed per call rather than captured, or a diagnostic surface would show the age
  // of the snapshot instead of the age of the process.
  await new Promise((resolve) => setTimeout(resolve, 25))
  assert.ok(plugin.runtimeInfo().uptimeMs >= 20, 'uptime must be measured when it is asked for')

  await plugin.unload({})
  const after = plugin.runtimeInfo()
  assert.equal(after.state, LIFECYCLE_STATES.UNLOADED)
  assert.equal(after.pid, null)
  assert.equal(after.unloads, 1)
  assert.equal(after.uptimeMs, 0)
  assert.equal(typeof after.loadedAt, 'number', 'what ran and when is kept after it is gone')
})

test('the error report is bounded, counted and clearable', () => {
  const reporter = createErrorReporter({ owner: 'p', adapter: 'a', limit: 5 })
  for (let index = 0; index < 12; index += 1) reporter.report(new Error(`failure ${index}`), 'load', 'CODE_A')
  const report = reporter.summary()
  assert.equal(report.total, 5, 'a plugin failing in a loop must not grow the shell\'s memory')
  assert.equal(report.limit, 5)
  assert.equal(report.byCode.CODE_A, 5)
  assert.match(report.last.reason, /failure 11$/, 'the newest failure is the one kept')

  assert.deepEqual(reporter.last(0), [])
  assert.equal(reporter.last(2).length, 2)
  assert.equal(reporter.clear(), 5)
  assert.equal(reporter.summary().total, 0)
  assert.equal(createErrorReporter({}).limit, DEFAULT_ERROR_LIMIT)

  // Reporting a non-Error is normal: adapters catch throws from third-party code, which may be
  // anything at all.
  assert.equal(reporter.report('a string', 'adapt', 'X').reason, 'a string')
  assert.equal(reporter.report(undefined, 'adapt', 'X').reason, 'undefined')
})

test('a runtimeInfo that throws does not break the diagnostic surface', async () => {
  const plugin = unify({
    runtimeInfo() {
      throw new Error('runtime description exploded')
    }
  })
  await plugin.load({})
  const info = plugin.runtimeInfo()
  assert.equal(info.id, 'test.plugin', 'the standard fields are still answered')
  assert.match(info.detail.runtimeInfoError, /runtime description exploded/)
  assert.equal(plugin.errorReport().total >= 1, true)
})

test('diagnostics combine the runtime, health, errors and declaration in one call', async () => {
  const plugin = unify({
    async healthCheck() {
      return { status: 'degraded', reason: 'under load' }
    }
  })
  await plugin.load({})
  const diagnostics = await plugin.diagnostics()
  assert.equal(diagnostics.runtime.state, LIFECYCLE_STATES.LOADED)
  assert.equal(diagnostics.health.status, HEALTH_STATUS.DEGRADED)
  assert.equal(diagnostics.errors.total, 0)
  // The wrapper reads the *manifest's* adapter section, which the framework writes when it
  // standardises one; a descriptor that was never standardised has none, and that is reported as
  // absence rather than invented.
  assert.equal(diagnostics.declared.adapter, null)
  assert.equal(diagnostics.declared.health, null)
  assert.equal(diagnostics.permissions, null)
})

test('diagnostics report the adapter section when the manifest carries one', async () => {
  const plugin = unifyLifecycle({
    descriptor: {
      manifest: manifest({
        adapter: { id: 'dshns.cordis', version: '1.0.0' },
        health: { contract: 'process-liveness', detail: 'the isolated process' },
        permissions: { declared: ['fs.read'], granted: ['fs.read'] }
      })
    },
    adapter: ADAPTER,
    log: () => {}
  })
  const diagnostics = await plugin.diagnostics()
  assert.equal(diagnostics.declared.adapter.id, 'dshns.cordis')
  assert.equal(diagnostics.declared.health.contract, 'process-liveness')
  assert.deepEqual(diagnostics.permissions.granted, ['fs.read'])
})

test('the wrapper adds the standard interfaces without dropping what the adapter attached', async () => {
  const plugin = unify({
    compatibility: 'compat',
    compatibilityState: () => ({ status: 'running' }),
    directory: '/somewhere'
  })
  assert.equal(plugin.compatibility, 'compat', 'the compat surfaces must survive the wrapper')
  assert.equal(plugin.compatibilityState().status, 'running')
  assert.equal(plugin.directory, '/somewhere')
  // And the standard hook of the same name is not overwritten by the passthrough.
  assert.equal(typeof plugin.load, 'function')
})
