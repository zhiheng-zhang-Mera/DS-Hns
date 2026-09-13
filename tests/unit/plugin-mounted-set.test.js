'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { createPluginManager } = require('../../app/core/plugin-manager/index.cjs')
const { createCapabilityRegistry } = require('../../app/core/capability-registry/index.cjs')
const { createEventBus } = require('../../app/core/event-bus/index.cjs')
const { FAULT_LEVELS, HEALTH_STATUS } = require('../../app/core/contracts/plugin.cjs')
const { CAPABILITIES, isKnownCapability, fallbackFor } = require('../../app/core/contracts/capability.cjs')
const { mountedPlugins } = require('../../app/plugins/mounted/index.cjs')

/**
 * The mounted feature set (Update-Plan/accleration.md §8, §9, §50).
 *
 * The migration rule is "move, do not optimise", so what this file checks is not
 * that the features work — their own suites do that — but that they are *mounted*:
 * each one declares a manifest, provides the capabilities the vocabulary names,
 * composes its collaborators through the registry instead of importing them, and
 * can be switched off without taking the runtime with it. That last property is
 * acceptance standard A.
 */

function freshManager() {
  return createPluginManager({ bus: createEventBus(), log: () => {} })
}

test('every mounted plugin has a valid manifest and a known capability set', () => {
  const plugins = mountedPlugins()
  assert.ok(plugins.length >= 11, `the plan lists eleven mounted features (${plugins.length})`)
  const seen = new Set()
  for (const plugin of plugins) {
    const manifest = plugin.manifest
    assert.equal(manifest.api_version, 'dshns.plugin/v1', `${manifest.id} declares the wrong API version`)
    assert.equal(seen.has(manifest.id), false, `${manifest.id} is mounted twice`)
    seen.add(manifest.id)
    assert.ok(Array.isArray(manifest.provides) && manifest.provides.length > 0, `${manifest.id} provides nothing`)
    assert.ok(Object.values(FAULT_LEVELS).includes(manifest.fault_level), `${manifest.id} has no fault level`)
    for (const capability of manifest.provides) {
      // A provided capability the vocabulary does not know cannot be required by
      // anyone, so it would be a capability in name only.
      assert.equal(isKnownCapability(capability), true, `${manifest.id} provides the unknown capability "${capability}"`)
    }
    for (const capability of [...(manifest.requires_capabilities || []), ...(manifest.optional_capabilities || [])]) {
      assert.equal(isKnownCapability(capability), true, `${manifest.id} requires the unknown capability "${capability}"`)
    }
  }
  // The plan's list, by id.
  for (const id of [
    'dshns.computer-use', 'dshns.ui-stability', 'dshns.long-term-worker', 'dshns.task-supervisor',
    'dshns.failure-recovery', 'dshns.checkpoint', 'dshns.watchdog', 'dshns.acceptance-gate',
    'dshns.session-keeper', 'dshns.git-operator', 'dshns.shell-runtime'
  ]) {
    assert.equal(seen.has(id), true, `${id} is not mounted`)
  }
})

test('the mounted set loads, in capability order, and provides its capabilities', async () => {
  const manager = freshManager()
  for (const plugin of mountedPlugins()) {
    const installed = manager.install(plugin)
    assert.equal(installed.ok, true, `${plugin.manifest.id}: ${installed.reason}`)
  }
  const result = await manager.loadAll()
  const failed = result.results.filter((entry) => entry.ok === false)
  assert.deepEqual(failed, [], `every mounted plugin must load: ${JSON.stringify(failed)}`)
  // Requirements were satisfied by capabilities, not by import order.
  for (const capability of ['shell-runtime', 'process-supervision', 'filesystem', 'git-operation', 'task-supervision', 'checkpoint', 'failure-recovery', 'acceptance-gate', 'watchdog', 'session-keeper', 'telemetry', 'resource-management', 'model-access', 'computer-use', 'ui-stability', 'long-term-worker']) {
    assert.equal(manager.registry.has(capability), true, `${capability} was not provided`)
  }
  // The long-term worker composed its collaborators through the registry.
  const worker = manager.registry.resolve('long-term-worker')
  const engine = worker.start({ workspace: require('node:path').resolve(__dirname, '..', '..'), goal: 'noop' })
  assert.ok(engine && typeof engine.run === 'function', 'the worker starts a real engineering supervisor')
  assert.equal(typeof engine.state, 'function')
  // Health: the mounted set reports, and the GUI channel honestly says it has no
  // host attached in this process.
  const health = await manager.checkAllHealth()
  assert.equal(health['dshns.model-runtime'].status, HEALTH_STATUS.HEALTHY)
  assert.equal(health['dshns.computer-use'].status, HEALTH_STATUS.DEGRADED)
  assert.match(health['dshns.computer-use'].reason, /not attached|no host runtime/)
  // The provider knowledge lives in exactly one place.
  const model = manager.registry.resolve('model-access')
  assert.equal(model.descriptor().provider, 'deepseek')
  assert.equal(model.descriptor().can('vision'), false)
  assert.equal(model.policy().validation.afterTask, 'tier2')
})

test('acceptance A: switching a plugin off leaves the others working', async () => {
  // computer-use off -> shell coding still works
  const manager = freshManager()
  for (const plugin of mountedPlugins()) manager.install(plugin)
  manager.disable('dshns.computer-use')
  manager.disable('dshns.ui-stability')
  const loaded = await manager.loadAll()
  assert.equal(loaded.results.every((entry) => entry.ok), true, JSON.stringify(loaded.results.filter((entry) => !entry.ok)))
  assert.equal(manager.registry.has('computer-use'), false, 'a disabled plugin provides nothing')
  assert.equal(manager.registry.has('shell-runtime'), true, 'shell coding is unaffected')
  assert.equal(manager.registry.has('filesystem'), true)

  // telemetry off -> the main task continues (it is a SOFT fault by declaration)
  const second = freshManager()
  for (const plugin of mountedPlugins()) second.install(plugin)
  second.disable('dshns.telemetry')
  await second.loadAll()
  assert.equal(second.registry.has('telemetry'), false)
  assert.equal(second.registry.has('long-term-worker'), true, 'the worker does not need telemetry')
  // telemetry is soft: nothing about it can stop a task
  const telemetryManifest = mountedPlugins().find((plugin) => plugin.manifest.id === 'dshns.telemetry').manifest
  assert.equal(telemetryManifest.fault_level, FAULT_LEVELS.SOFT)

  // recovery restarted -> the worker does not crash (the manager reloads it)
  const third = freshManager()
  for (const plugin of mountedPlugins()) third.install(plugin)
  await third.loadAll()
  const reloaded = await third.reload('dshns.failure-recovery')
  assert.equal(reloaded.ok, true)
  assert.equal(third.registry.has('failure-recovery'), true, 'the capability is back after a restart')
  assert.equal(third.status('dshns.long-term-worker').loaded, true, 'the worker stays loaded across a collaborator restart')
})

test('a capability names its expected provider and its fallback', () => {
  assert.equal(isKnownCapability('repo-map'), true)
  assert.equal(isKnownCapability('invented-capability'), false)
  // Every capability in the vocabulary promises what happens without it, because
  // "the runtime degrades" is only honest if it says how.
  for (const [name, entry] of Object.entries(CAPABILITIES)) {
    assert.ok(typeof entry.description === 'string' && entry.description.length > 0, `${name} has no description`)
    assert.ok(typeof entry.fallback === 'string' && entry.fallback.length > 0, `${name} promises no fallback`)
    assert.ok(Array.isArray(entry.providers), `${name} names no provider`)
  }
  assert.match(fallbackFor('repo-map'), /text search/)
  assert.match(fallbackFor('telemetry'), /no performance claim/)
})

test('an absent optional capability degrades instead of failing the plugin', async () => {
  const manager = freshManager()
  for (const plugin of mountedPlugins()) manager.install(plugin)
  // The worker declares computer-use as optional: with it disabled the worker must
  // still load, because a long coding task does not need a GUI.
  manager.disable('dshns.computer-use')
  const result = await manager.loadAll()
  const worker = result.results.find((entry) => entry.plugin === 'dshns.long-term-worker')
  assert.equal(worker.ok, true, JSON.stringify(worker))
  assert.equal(manager.registry.has('long-term-worker'), true)
  assert.equal(manager.registry.has('computer-use'), false, 'the optional capability really is absent')
})

/**
 * A required capability that nobody provides is a load-time refusal naming the
 * capability — never a crash in the middle of a task, and never a silent partial
 * load.
 */
test('a required capability with no provider refuses the plugin and names it', async () => {
  const manager = freshManager()
  const worker = mountedPlugins().find((plugin) => plugin.manifest.id === 'dshns.long-term-worker')
  manager.install(worker)
  const result = await manager.load('dshns.long-term-worker')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'PLUGIN_MISSING_CAPABILITY')
  assert.deepEqual(result.missing.sort(), ['checkpoint', 'failure-recovery', 'filesystem', 'shell-runtime'].sort())
  assert.equal(manager.status('dshns.long-term-worker').loaded, false)
})
