'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { PLUGIN_API_VERSION, PLUGIN_STATES, FAULT_LEVELS, HEALTH_STATUS, LOAD_REASONS, validateManifest, validatePlugin } = require('../../app/core/contracts/plugin.cjs')
const { createEventBus, CORE_EVENTS } = require('../../app/core/event-bus/index.cjs')
const { createCapabilityRegistry } = require('../../app/core/capability-registry/index.cjs')
const { createPluginManager, orderPlugins } = require('../../app/core/plugin-manager/index.cjs')
const { createConfigManager } = require('../../app/core/config-manager/index.cjs')
const { createResourceManager, PRESSURE } = require('../../app/core/resource-manager/index.cjs')
const { createHealthSupervisor } = require('../../app/core/health-supervisor/index.cjs')

/**
 * Plugin runtime core (Update-Plan/accleration.md phases 0-2, §5, §6, §22-§24,
 * §32-§34).
 *
 * The platform claims three things and this file is where they are tested rather
 * than asserted: a plugin's four states are separate, a failure stays inside the
 * plugin, and capabilities — never plugin ids — are how plugins depend on each
 * other.
 */

const API = PLUGIN_API_VERSION
const manifest = (overrides = {}) => ({
  api_version: API,
  id: 'dshns.test',
  name: 'Test',
  version: '1.0.0',
  ...overrides
})

/** A manager with a few plugins installed, for the tests that need a world. */
function withManager(plugins = []) {
  const manager = createPluginManager({ log: () => {} })
  for (const plugin of plugins) manager.install(plugin)
  return manager
}

test('a manifest is validated before any plugin code runs', () => {
  assert.equal(validateManifest(manifest()).ok, true)
  const cases = [
    [{ ...manifest(), api_version: 'dshns.plugin/v2' }, /api_version/],
    [{ ...manifest(), id: 'Bad Id' }, /valid plugin id/],
    [{ ...manifest(), version: 'v1' }, /semantic version/],
    [{ ...manifest(), provides: 'alpha' }, /array of non-empty capability names/],
    [{ ...manifest(), requires_capabilities: [''] }, /array of non-empty capability names/],
    [{ ...manifest(), default_enabled: 'yes' }, /must be a boolean/],
    [{ ...manifest(), fault_level: 'critical' }, /fault_level must be one of/]
  ]
  for (const [candidate, pattern] of cases) {
    const result = validateManifest(candidate)
    assert.equal(result.ok, false, JSON.stringify(candidate))
    assert.match(result.errors.join('; '), pattern)
  }
  // A plugin is a manifest plus optional hooks; a hook that is not a function is
  // refused, because the manager would otherwise call it and throw at load time.
  assert.equal(validatePlugin({ manifest: manifest(), load: 'yes' }).ok, false)
  assert.equal(validatePlugin({ manifest: manifest() }).ok, true)
  assert.equal(validatePlugin({ manifest: manifest(), healthCheck: () => ({ status: 'healthy' }) }).ok, true)
})

test('the four plugin states stay separate', async () => {
  const manager = withManager([{ manifest: manifest({ id: 'dshns.a', default_enabled: false }) }])
  // Installed but not enabled.
  let status = manager.status('dshns.a')
  assert.equal(status.installed, true)
  assert.equal(status.enabled, false)
  assert.equal(status.loaded, false)
  assert.equal(status.state, 'disabled')
  // Enabled but not loaded.
  manager.enable('dshns.a')
  status = manager.status('dshns.a')
  assert.equal(status.enabled, true)
  assert.equal(status.loaded, false)
  assert.equal(status.state, 'enabled')
  // Loaded, with no health opinion yet: `loaded` is not `healthy`.
  await manager.load('dshns.a')
  status = manager.status('dshns.a')
  assert.equal(status.loaded, true)
  assert.equal(status.healthy, null)
  assert.equal(status.state, 'loaded')
  // And a plugin that reports healthy is a fourth, separate fact.
  const manager2 = withManager([{
    manifest: manifest({ id: 'dshns.b' }),
    healthCheck: async () => ({ status: HEALTH_STATUS.HEALTHY, latency_ms: 3 })
  }])
  await manager2.load('dshns.b')
  await manager2.checkHealth('dshns.b')
  status = manager2.status('dshns.b')
  assert.equal(status.healthy, true)
  assert.equal(status.state, 'healthy')
  assert.equal(status.health.latency_ms, 3)
})

test('a plugin failure stays inside the plugin, at its own fault level', async () => {
  const bus = createEventBus()
  const manager = createPluginManager({ bus, log: () => {} })
  manager.install({ manifest: manifest({ id: 'dshns.soft', fault_level: FAULT_LEVELS.SOFT }), load: async () => { throw new Error('telemetry is down') } })
  manager.install({ manifest: manifest({ id: 'dshns.degraded', fault_level: FAULT_LEVELS.DEGRADED }), load: async () => { throw new Error('repo map is down') } })
  manager.install({ manifest: manifest({ id: 'dshns.worker' }), load: async (ctx) => { ctx.provide('work', { ok: true }) } })
  for (const id of ['dshns.soft', 'dshns.degraded', 'dshns.worker']) manager.enable(id)

  const result = await manager.loadAll()
  const byId = Object.fromEntries(result.results.map((entry) => [entry.plugin, entry]))
  // The two that fail are reported, not fatal, and the third still loads: one
  // plugin must never take the runtime down with it.
  assert.equal(byId['dshns.soft'].ok, false)
  assert.equal(byId['dshns.soft'].level, FAULT_LEVELS.SOFT)
  assert.equal(byId['dshns.degraded'].ok, false)
  assert.equal(byId['dshns.degraded'].level, FAULT_LEVELS.DEGRADED)
  assert.equal(byId['dshns.worker'].ok, true)
  assert.deepEqual(result.loaded, ['dshns.worker'])
  // The refusal names the plugin and carries its level, so the UI can say why.
  const fault = manager.status('dshns.degraded')
  assert.equal(fault.fault.code, LOAD_REASONS.LOAD_FAILED)
  assert.equal(fault.fault.level, FAULT_LEVELS.DEGRADED)
  assert.match(fault.fault.reason, /repo map is down/)
  // And the bus saw it.
  assert.ok(bus.history().some((event) => event.type === CORE_EVENTS.PLUGIN_FAULT && event.payload.plugin === 'dshns.degraded'))
})

test('dependencies are capabilities, and a missing one is a load-time refusal', async () => {
  const manager = createPluginManager({ log: () => {} })
  manager.install({
    manifest: manifest({ id: 'dshns.pytest', provides: ['validation'] }),
    load: async (ctx) => { ctx.provide('validation', { framework: 'pytest' }) }
  })
  manager.install({
    manifest: manifest({ id: 'dshns.worker', provides: ['work'], requires_capabilities: ['validation'] }),
    load: async (ctx) => {
      const validator = ctx.require('validation')
      ctx.provide('work', { validator: validator ? validator.framework : null })
    }
  })
  manager.install({
    manifest: manifest({ id: 'dshns.needy', requires_capabilities: ['nonexistent'] })
  })
  for (const id of ['dshns.pytest', 'dshns.worker', 'dshns.needy']) manager.enable(id)

  const result = await manager.loadAll()
  // The provider loads before its consumer, because the order is computed from
  // capabilities rather than from registration order.
  assert.deepEqual(result.loaded, ['dshns.pytest', 'dshns.worker'])
  assert.deepEqual(manager.registry.resolve('work'), { validator: 'pytest' })
  // A capability nothing provides is refused with the capability named.
  const needy = manager.status('dshns.needy')
  assert.equal(needy.loaded, false)
  assert.equal(needy.fault.code, LOAD_REASONS.MISSING_CAPABILITY)
  assert.deepEqual(needy.dependencies.missing, ['nonexistent'])
  // And the registry recorded the miss, which is how a fallback is explained.
  assert.ok(manager.registry.misses().some((entry) => entry.capability === 'nonexistent'))
})

test('one capability can have several providers, ordered by priority', () => {
  const registry = createCapabilityRegistry()
  assert.equal(registry.register({ capability: 'validation', owner: 'generic', implementation: { kind: 'generic' }, priority: 10 }).ok, true)
  assert.equal(registry.register({ capability: 'validation', owner: 'project', implementation: { kind: 'project' }, priority: 80 }).ok, true)
  // The higher priority wins without either provider knowing the other exists.
  assert.deepEqual(registry.resolve('validation'), { kind: 'project' })
  assert.equal(registry.describe('validation').length, 2)
  // Two providers at the *same* priority are a conflict, not a coin toss.
  const clash = registry.register({ capability: 'validation', owner: 'third', implementation: { kind: 'third' }, priority: 80 })
  assert.equal(clash.ok, false)
  assert.match(clash.reason, /same capability/i)
  // Unloading a provider revokes exactly its own advertisement.
  assert.deepEqual(registry.revokeOwner('project'), ['validation'])
  assert.deepEqual(registry.resolve('validation'), { kind: 'generic' })
  registry.revokeOwner('generic')
  assert.equal(registry.has('validation'), false)
})

test('unloading releases capabilities and bus subscriptions', async () => {
  const bus = createEventBus()
  const manager = createPluginManager({ bus, log: () => {} })
  manager.install({
    manifest: manifest({ id: 'dshns.watcher', provides: ['watch'] }),
    load: async (ctx) => {
      ctx.provide('watch', { on: true })
      ctx.on(CORE_EVENTS.TASK_STARTED, () => {})
      ctx.onAny(() => {})
    },
    unload: async () => {}
  })
  manager.enable('dshns.watcher')
  await manager.load('dshns.watcher')
  assert.equal(manager.registry.has('watch'), true)
  assert.equal(bus.subscriptionCount('dshns.watcher'), 2, 'the plugin holds two subscriptions while loaded')

  const unloaded = await manager.unload('dshns.watcher')
  assert.deepEqual(unloaded.revoked, ['watch'])
  assert.equal(manager.registry.has('watch'), false, 'a capability must not outlive its provider')
  assert.equal(bus.subscriptionCount('dshns.watcher'), 0, 'a subscription must not outlive its plugin')
  assert.equal(manager.status('dshns.watcher').loaded, false)
})

test('a requirement cycle is reported rather than resolved by guessing', () => {
  const entries = [
    { id: 'a', capabilities: ['ca'], requires: ['cb'] },
    { id: 'b', capabilities: ['cb'], requires: ['ca'] }
  ]
  const { ordered, cycles } = orderPlugins(entries)
  assert.equal(cycles.length >= 1, true, `a cycle must be reported (${JSON.stringify(cycles)})`)
  assert.equal(ordered.length + cycles.length >= 2, true)
})

test('a listener that throws does not stop the emitter or the other listeners', () => {
  const errors = []
  const bus = createEventBus({ onListenerError: (error) => errors.push(error.message) })
  const seen = []
  bus.on(CORE_EVENTS.TASK_STARTED, () => { throw new Error('observer is broken') })
  bus.on(CORE_EVENTS.TASK_STARTED, () => seen.push('second'))
  const result = bus.emit(CORE_EVENTS.TASK_STARTED, { task: 't1' })
  assert.equal(result.delivered, 2)
  assert.equal(result.failed, 1)
  assert.deepEqual(seen, ['second'], 'the healthy listener still received the event')
  assert.deepEqual(errors, ['observer is broken'])
  // A bounded subscription stops after its limit, so a high-frequency observer
  // cannot become an unbounded leak.
  let count = 0
  bus.on(CORE_EVENTS.METRIC_RECORDED, () => { count += 1 }, { limit: 2 })
  for (let index = 0; index < 5; index += 1) bus.emit(CORE_EVENTS.METRIC_RECORDED, { index })
  assert.equal(count, 2)
  // The history ring is bounded too.
  assert.ok(bus.history().length <= 200)
})

test('config layers resolve in one direction and a bad value is reported, not accepted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshns-config-'))
  try {
    fs.writeFileSync(path.join(dir, 'dshns.a.json'), JSON.stringify({ workers: 9, mode: 'safe', extra: 'kept' }), 'utf8')
    const config = createConfigManager({
      dir,
      defaults: { plugins: { 'dshns.a': { workers: 2, mode: 'off', timeoutMs: 1000 } } },
      profile: { plugins: { 'dshns.a': { workers: 4, mode: 'adaptive' } } },
      overrides: { plugins: { 'dshns.a': { workers: 16 } } },
      log: () => {}
    })
    const resolved = config.forPlugin('dshns.a', {
      workers: { type: 'number', min: 1, max: 8, default: 2 },
      mode: { type: 'string', enum: ['off', 'safe', 'adaptive'], default: 'off' },
      timeoutMs: { type: 'number', min: 0, default: 1000 }
    })
    // The override wins for `workers`, but it is out of range, so the default is
    // used and the rejection is on the record.
    assert.equal(resolved.resolved.workers, 2)
    assert.equal(resolved.rejected.length, 1)
    assert.match(resolved.rejected[0].reason, /above the maximum 8/)
    assert.equal(resolved.sources.workers, 'override')
    // The file wins over the profile for `mode`, and it is a legal value.
    assert.equal(resolved.resolved.mode, 'safe')
    assert.equal(resolved.sources.mode, 'plugin-config')
    // A key no schema mentions is carried through rather than dropped.
    assert.equal(resolved.resolved.extra, 'kept')
    // A corrupt file is reported and does not take the manager down.
    fs.writeFileSync(path.join(dir, 'dshns.b.json'), '{ not json', 'utf8')
    const broken = config.forPlugin('dshns.b')
    assert.deepEqual(broken.resolved, {})
    assert.equal(config.issues().length >= 1, true)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the resource manager derives the worker count instead of equalling the core count', () => {
  const manager = createResourceManager({
    limits: { maxWorkers: 4, minWorkers: 2, coresPerWorker: 2, workerRamMb: 1024, cpuPercent: 75, ramPercent: 70 },
    probeCpu: () => ({ usedPercent: 5 }),
    probeGpu: () => ({ available: false }),
    modelConcurrency: 4,
    now: () => 1000
  })
  const workers = manager.effectiveWorkers()
  assert.ok(workers.workers <= 4, `the profile cap must hold (${workers.workers})`)
  assert.equal(workers.requested, 4)
  assert.equal(typeof workers.bound, 'string')
  // The machine's core count does not become the worker count.
  const cores = os.cpus().length
  assert.notEqual(workers.workers, cores, 'CPU threads must not become the worker count')
  assert.ok(workers.bounds.some((bound) => bound.name === 'cores'))
  assert.ok(workers.bounds.some((bound) => bound.name === 'model'))

  // At a ceiling the manager allocates nothing new, and says so.
  const busy = createResourceManager({
    limits: { cpuPercent: 75, ramPercent: 1 },
    probeCpu: () => ({ usedPercent: 99 }),
    now: () => 1000
  })
  const snapshot = busy.snapshot()
  assert.equal(snapshot.pressure, PRESSURE.CEILING)
  assert.equal(busy.effectiveWorkers({ snapshot }).workers, 0)
  assert.equal(snapshot.ceilings.ram, true)
  // Registered load is accounted for, so a plugin cannot hide its concurrency.
  busy.register('tests', { active: 2, weight: 1 })
  const loaded = busy.snapshot()
  assert.equal(loaded.weightedLoad, 2)
  assert.ok(loaded.loads.some((entry) => entry.name === 'tests'))
  busy.release('tests')
  assert.equal(busy.snapshot().weightedLoad, 0)
})

test('the health supervisor restarts one plugin, bounded, instead of the runtime', async () => {
  let healthy = false
  let loads = 0
  const manager = createPluginManager({ log: () => {} })
  manager.install({
    manifest: manifest({ id: 'dshns.flaky', fault_level: FAULT_LEVELS.DEGRADED }),
    load: async () => { loads += 1 },
    healthCheck: async () => (healthy ? { status: HEALTH_STATUS.HEALTHY } : { status: HEALTH_STATUS.DEGRADED, reason: 'browser_session_missing' })
  })
  manager.enable('dshns.flaky')
  await manager.load('dshns.flaky')

  const supervisor = createHealthSupervisor({ manager, maxRestarts: 2, log: () => {} })
  const first = await supervisor.check('dshns.flaky')
  assert.equal(first.reaction.action, 'restart')
  assert.equal(first.restarted, true)
  assert.equal(loads, 2, 'a restart really reloads the plugin')
  // Still unhealthy after the restart: the next check restarts again, then stops.
  const second = await supervisor.check('dshns.flaky')
  assert.equal(second.reaction.action, 'restart')
  const third = await supervisor.check('dshns.flaky')
  assert.equal(third.reaction.action, 'degrade', 'the restart budget is bounded')
  assert.match(third.reaction.reason, /after 2 restart/)
  assert.equal(supervisor.restartCount('dshns.flaky'), 2)

  // A soft fault is recorded and ignored: a cache failing must not restart anything.
  const soft = withManager([{ manifest: manifest({ id: 'dshns.cache', fault_level: FAULT_LEVELS.SOFT }), healthCheck: async () => ({ status: HEALTH_STATUS.UNHEALTHY, reason: 'cache miss storm' }) }])
  await soft.load('dshns.cache')
  const softSupervisor = createHealthSupervisor({ manager: soft, log: () => {} })
  const ignored = await softSupervisor.check('dshns.cache')
  assert.equal(ignored.reaction.action, 'ignore')
  assert.equal(ignored.restarted, false)

  // A fatal fault stops the task instead of pretending a fallback exists.
  const fatal = withManager([{ manifest: manifest({ id: 'dshns.workspace', fault_level: FAULT_LEVELS.FATAL }), healthCheck: async () => ({ status: HEALTH_STATUS.UNHEALTHY, reason: 'workspace corrupted' }) }])
  await fatal.load('dshns.workspace')
  const fatalSupervisor = createHealthSupervisor({ manager: fatal, log: () => {} })
  const stopped = await fatalSupervisor.check('dshns.workspace')
  assert.equal(stopped.reaction.action, 'stop')
  assert.equal(fatalSupervisor.status().status, 'blocked')
})

test('disabling a plugin unloads it and revokes what it provided', async () => {
  const manager = withManager([{
    manifest: manifest({ id: 'dshns.a', provides: ['alpha'] }),
    load: async (ctx) => { ctx.provide('alpha', { v: 1 }) }
  }])
  await manager.load('dshns.a')
  assert.equal(manager.registry.has('alpha'), true)
  const disabled = await manager.disable('dshns.a')
  assert.equal(disabled.ok, true)
  assert.equal(manager.status('dshns.a').enabled, false)
  assert.equal(manager.status('dshns.a').loaded, false)
  assert.equal(manager.registry.has('alpha'), false)
})
