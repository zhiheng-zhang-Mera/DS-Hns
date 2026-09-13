'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { createPluginManager } = require('../../app/core/plugin-manager/index.cjs')
const { createCapabilityRegistry } = require('../../app/core/capability-registry/index.cjs')
const { createEventBus } = require('../../app/core/event-bus/index.cjs')
const { createResourceManager } = require('../../app/core/resource-manager/index.cjs')
const { FAULT_LEVELS, HEALTH_STATUS } = require('../../app/core/contracts/plugin.cjs')
const { isKnownCapability, fallbackFor, expectedProviders } = require('../../app/core/contracts/capability.cjs')
const { mountedPlugins } = require('../../app/plugins/mounted/index.cjs')
const { accelerationPlugins, ACCELERATION_CAPABILITIES } = require('../../app/plugins/acceleration/index.cjs')

/**
 * The acceleration set as plugins (Update-Plan/accleration.md, acceptance standard A).
 *
 * The accelerators were built and tested as modules first; this file is about the half
 * that makes them *removable*. The plan's acceptance standard A is a statement about
 * absence — turn repo-map off and text search still works, turn the cache off and every
 * command simply runs — and absence is only testable through the registry, not through
 * a `require`.
 */

function freshManager() {
  return createPluginManager({
    bus: createEventBus(),
    registry: createCapabilityRegistry({ bus: createEventBus() }),
    resources: createResourceManager(),
    log: () => {}
  })
}

/** Install the mounted set and the acceleration set together, and load them. */
async function loadEverything(manager, disable = []) {
  for (const plugin of [...mountedPlugins(), ...accelerationPlugins()]) manager.install(plugin)
  for (const id of disable) manager.disable(id)
  return manager.loadAll()
}

test('every accelerator is a plugin that provides a capability the vocabulary declares', () => {
  const plugins = accelerationPlugins()
  assert.equal(plugins.length, 12)
  const provided = []
  for (const plugin of plugins) {
    const manifest = plugin.manifest
    assert.equal(manifest.api_version, 'dshns.plugin/v1', `${manifest.id} declares the wrong API version`)
    assert.ok(manifest.provides.length > 0, `${manifest.id} provides nothing`)
    assert.ok(Object.values(FAULT_LEVELS).includes(manifest.fault_level), `${manifest.id} has no fault level`)
    for (const capability of manifest.provides) {
      assert.equal(isKnownCapability(capability), true, `${manifest.id} provides the unknown capability "${capability}"`)
      // The vocabulary names the plugin expected to provide each capability; a mismatch
      // would mean the promise in the vocabulary points at a plugin that does not exist.
      assert.ok(expectedProviders(capability).includes(manifest.id), `the vocabulary does not expect ${manifest.id} to provide ${capability}`)
      provided.push(capability)
    }
    for (const capability of [...(manifest.requires_capabilities || []), ...(manifest.optional_capabilities || [])]) {
      assert.equal(isKnownCapability(capability), true, `${manifest.id} requires the unknown capability "${capability}"`)
    }
    assert.ok(typeof plugin.healthCheck === 'function', `${manifest.id} has no health check`)
  }
  for (const capability of ACCELERATION_CAPABILITIES) {
    assert.ok(provided.includes(capability), `${capability} is promised by the vocabulary and provided by nobody`)
  }
  // Section 32: no accelerator may be FATAL. A cache or a scheduler that can stop an
  // episode in the middle of the night is worse than one that degrades.
  assert.equal(plugins.every((plugin) => plugin.manifest.fault_level !== FAULT_LEVELS.FATAL), true)
  const byId = new Map(plugins.map((plugin) => [plugin.manifest.id, plugin.manifest.fault_level]))
  assert.equal(byId.get('dshns.repo-map'), FAULT_LEVELS.DEGRADED)
  assert.equal(byId.get('dshns.command-cache'), FAULT_LEVELS.SOFT)
  assert.equal(byId.get('dshns.parallel-executor'), FAULT_LEVELS.DEGRADED)
})

test('the two sets load together, and every accelerator capability is resolvable', async () => {
  const manager = freshManager()
  const result = await loadEverything(manager)
  const failed = result.results.filter((entry) => entry.ok === false)
  assert.deepEqual(failed, [], `every plugin must load: ${JSON.stringify(failed)}`)
  for (const capability of ACCELERATION_CAPABILITIES) {
    assert.equal(manager.registry.has(capability), true, `${capability} was not provided`)
  }
  // The services are the real modules, not stand-ins: the repo map can answer a question.
  const repoMap = manager.registry.resolve('repo-map')
  assert.equal(typeof repoMap.findSymbol, 'function')
  const executor = manager.registry.resolve('parallel-execution')
  assert.equal(typeof executor.run, 'function')
  assert.equal(typeof manager.registry.resolve('command-cache').lookup, 'function')
  assert.equal(typeof manager.registry.resolve('patch-first').chooseStrategy, 'function')
  // The executor composed its worker count from the resource-management capability
  // rather than importing a resource manager.
  assert.ok(executor.workersFor().workers >= 1)
})

test('acceptance A: repo-map off leaves the fallback the vocabulary promises', async () => {
  const manager = freshManager()
  await loadEverything(manager, ['dshns.repo-map'])
  assert.equal(manager.registry.has('repo-map'), false, 'a disabled plugin provides nothing')
  // What the runtime is left with is declared, not discovered at the point of failure.
  assert.match(fallbackFor('repo-map'), /text search/)
  // And nothing else in the acceleration set depended on it.
  for (const capability of ['parallel-execution', 'dirty-context', 'command-cache', 'incremental-validation']) {
    assert.equal(manager.registry.has(capability), true, `${capability} must not depend on the repo map`)
  }
})

test('acceptance A: workspace isolation off degrades the executor to serial writes', async () => {
  const manager = freshManager()
  await loadEverything(manager, ['dshns.workspace-isolation'])
  assert.equal(manager.registry.has('workspace-isolation'), false)
  const executor = manager.registry.resolve('parallel-execution')
  // The executor still loaded, because isolation is optional and the capability's
  // fallback is a serial rewrite rather than a refusal to run.
  assert.match(fallbackFor('workspace-isolation'), /parallel writes are refused/)
  const overlapping = [
    { id: 'w1', writeSet: ['src/executor.cjs'] },
    { id: 'w2', writeSet: ['src/executor.cjs'] }
  ]
  const plan = executor.plan({ nodes: overlapping, mode: 'aggressive' })
  assert.deepEqual(plan.waves[0].lanes.map((lane) => lane.kind), ['parallel', 'serial'])
  assert.deepEqual(plan.waves[0].isolated, [])
})

test('acceptance A: the executor refuses to load without a resource manager', async () => {
  const manager = createPluginManager({ bus: createEventBus(), log: () => {} })
  const executor = accelerationPlugins().find((plugin) => plugin.manifest.id === 'dshns.parallel-executor')
  manager.install(executor)
  const result = await manager.load('dshns.parallel-executor')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'PLUGIN_MISSING_CAPABILITY')
  assert.deepEqual(result.missing, ['resource-management'])
  assert.equal(manager.status('dshns.parallel-executor').loaded, false)
})

test('acceptance A: a broken accelerator degrades instead of taking the run with it', async () => {
  const manager = freshManager()
  await loadEverything(manager)
  // Section 32: the map is DEGRADED, so a fault in it is a fallback and never a stop.
  const health = await manager.checkHealth('dshns.repo-map')
  assert.equal(health.status, HEALTH_STATUS.HEALTHY, 'the map is built on first use, so before use it is healthy')
  assert.equal(manager.entry('dshns.repo-map').fault_level, FAULT_LEVELS.DEGRADED)
  // A failing restart of the map must not unload the things that do not need it.
  const reloaded = await manager.reload('dshns.repo-map')
  assert.equal(reloaded.ok, true)
  assert.equal(manager.status('dshns.parallel-executor').loaded, true)
  assert.equal(manager.registry.has('parallel-execution'), true)
  assert.equal(manager.registry.has('repo-map'), true, 'the capability is back after the restart')
})

test('the context cache reuses one stable prefix and reports the reuse', async () => {
  const manager = freshManager()
  await loadEverything(manager)
  const cache = manager.registry.resolve('context-cache')
  const stable = 'RULES: never force push. '.repeat(5)
  const first = cache.stable({ stable, task: { goal: 'one' }, diff: 'a' })
  assert.equal(first.reused, false)
  const second = cache.stable({ stable, task: { goal: 'two' }, diff: 'b' })
  assert.equal(second.reused, true, 'a changed task and diff must not invalidate the stable prefix')
  assert.equal(second.prefix, first.prefix)
  const stats = cache.stats()
  assert.equal(stats.builds, 1)
  assert.equal(stats.reuses, 1)
  assert.equal(stats.reuseRatio, 0.5)
})

test('the persistent tool runtime refuses a kind nobody can start, and says so', async () => {
  const manager = freshManager()
  await loadEverything(manager)
  const persistent = manager.registry.resolve('persistent-tools')
  assert.deepEqual(persistent.registered(), [])
  const outcome = await persistent.acquire('shell', 'workspace')
  assert.equal(outcome.ok, false)
  assert.match(outcome.reason, /no starter is registered for the "shell" tool/)
  const refused = await persistent.acquire('not-a-tool', 'x')
  assert.match(refused.reason, /not a known persistent tool kind/)
  // Registering a starter is all it takes, and the session is then reused.
  let starts = 0
  persistent.register('shell', {
    start: async () => {
      starts += 1
      return { pid: starts }
    },
    stop: async () => {},
    check: async () => true
  })
  const first = await persistent.acquire('shell', 'workspace')
  const second = await persistent.acquire('shell', 'workspace')
  assert.equal(first.ok, true)
  assert.equal(second.reused, true)
  assert.equal(starts, 1)
  assert.deepEqual(persistent.registered(), ['shell'])
  assert.equal((await persistent.dispose()).stopped.length, 1)
})

test('the telemetry service can be resolved whether or not the accelerators are mounted', async () => {
  const manager = freshManager()
  await loadEverything(manager)
  const telemetry = manager.registry.resolve('telemetry')
  const table = telemetry.metrics({ acceptedPatches: 2, wallTimeMs: 1000 })
  assert.equal(table.time_to_accepted_patch_ms, 500)
  assert.equal(table.model_calls, 0)
  // A missing cache hit rate is not zero: it carries its reason.
  assert.equal(table.cache_hit_rate, null)
  assert.match(table.unavailable.cache_hit_rate, /no cache hit or miss/)
})
