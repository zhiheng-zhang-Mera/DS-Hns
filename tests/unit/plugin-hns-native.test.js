'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..', '..')
const { createNativeHnsAdapter } = require('../../app/core/plugin-adapters/adapters/native-hns.cjs')
const { createAdapterFramework } = require('../../app/core/plugin-adapters/index.cjs')
const { createPluginManager } = require('../../app/core/plugin-manager/index.cjs')
const { createPluginHost } = require('../../app/plugin-host.cjs')
const { CAPABILITIES, isKnownCapability, fallbackFor } = require('../../app/core/contracts/capability.cjs')
const { createHealthEngine, DEFAULT_CONFIG, scoreDimension, inWindow, ACTIONS } = require('../../app/plugins/health-scheduler/health.cjs')
const { createHealthSchedulerPlugin, PROVIDES, OPTIONAL_CAPABILITIES } = require('../../app/plugins/health-scheduler/index.cjs')

/**
 * The native path, the long-term-hosting vocabulary, and the first complete native plugin.
 *
 * Three claims are pinned here:
 *
 *   * **one load path** — the product's own `dshns.plugin/v1` plugins go through
 *     `NativeHnsAdapter` like everything else, and they carry the standard sections that prove it;
 *   * **the vocabulary is closed and documented** — the five long-term-hosting capabilities are
 *     names with a meaning and a stated fallback, not strings two plugins happened to agree on;
 *   * **the monitor cannot restart anything** — asserted by scanning its source, and by showing
 *     that everything except the restart keeps working when no authority is present.
 */

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshns-hns-'))
  return {
    dir,
    path: (relative) => path.join(dir, relative),
    dispose: () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 })
  }
}

/** Readings a test controls completely, so the engine can be driven to any pressure. */
function scriptedReadings(plan) {
  let index = 0
  return () => {
    const step = plan[Math.min(index, plan.length - 1)]
    index += 1
    return {
      memory: { value: step.memory, warn: 70, critical: 92 },
      cpu: { value: step.cpu, warn: 75, critical: 95 },
      runtime: { value: step.runtime === undefined ? 0 : step.runtime, warn: 60, critical: 90 }
    }
  }
}

test('the shipped plugin set goes through NativeHnsAdapter, with the standard sections', async () => {
  const area = scratch()
  const root = path.join(area.dir, 'root')
  fs.mkdirSync(path.join(root, 'data', 'plugins'), { recursive: true })
  const host = createPluginHost({ root, log: () => {} })
  try {
    const built = await host.ensure()
    assert.equal(built.ok, true, built.error)
    const plugins = host.list().plugins
    assert.ok(plugins.length > 0)

    // Every shipped plugin was adapted, by name, through the framework -- not installed as a
    // ready-made object the way the old second loader did it.
    for (const plugin of plugins) {
      assert.equal(plugin.adapter && plugin.adapter.id, 'dshns.native', `${plugin.id} has no adapter record`)
      assert.equal(plugin.adaptation.detected_type, 'dshns.module', `${plugin.id} was not adapted from a module`)
      assert.ok(plugin.runtime && plugin.runtime.kind, `${plugin.id} has no runtime block`)
      assert.ok(plugin.permissions && Array.isArray(plugin.permissions.granted), `${plugin.id} has no permission block`)
      assert.ok(plugin.lifecycle, `${plugin.id} has no lifecycle state`)
    }

    const health = plugins.find((plugin) => plugin.id === 'dshns.health-scheduler')
    assert.ok(health, 'the health scheduler must be part of the shipped set')
    assert.equal(health.enabled, false, 'sampling the machine is opt-in')
    assert.deepEqual(health.provides.slice().sort(), [...PROVIDES].sort())
  } finally {
    await host.dispose('test teardown')
    area.dispose()
  }
})

test('the host has exactly one adaptation pass for shipped and installed plugins alike', () => {
  const host = fs.readFileSync(path.join(ROOT, 'app', 'plugin-host.cjs'), 'utf8')
  // The second loader is gone: no function hands ready-made plugin objects to the manager.
  assert.equal(/function shippedPlugins\s*\(/.test(host), false, 'the old shipped-plugin loader is still present')
  assert.match(host, /function shippedArtifacts\s*\(/)
  assert.match(host, /async function installedArtifacts\s*\(/)
  assert.match(host, /\[\.\.\.shippedArtifacts\(\), \.\.\.\(await installedArtifacts\(\)\)\]/)
  // And exactly one place adapts.
  const adaptations = host.match(/adapters\.adaptMany\(/g) || []
  assert.equal(adaptations.length, 1, `expected one adaptation pass, found ${adaptations.length}`)
  // The manager is still the only thing that installs.
  assert.match(host, /next\.install\(plugin\)/)
})

test('the long-term-hosting capabilities are documented vocabulary, not strings', () => {
  const expected = ['hardware-health', 'runtime-health', 'health-pressure', 'maintenance-scheduling', 'restart-control']
  for (const name of expected) {
    assert.equal(isKnownCapability(name), true, `${name} is not in the vocabulary`)
    const entry = CAPABILITIES[name]
    assert.ok(entry.description && entry.description.length > 10, `${name} has no description`)
    assert.ok(Array.isArray(entry.providers) && entry.providers.length > 0, `${name} names no expected provider`)
    // The fallback is the line that matters: a capability whose absence is undefined is a
    // capability nobody can depend on.
    assert.ok(entry.fallback && entry.fallback.length > 10, `${name} has no stated fallback`)
    assert.equal(fallbackFor(name), entry.fallback)
  }
  // The restart authority is deliberately not part of the health vocabulary: a monitor may request
  // a restart, and the capability that performs one is a different thing with a different provider.
  assert.deepEqual(CAPABILITIES['restart-control'].providers, ['dshns.process'])
  assert.match(CAPABILITIES['restart-control'].fallback, /unavailable/)
  assert.notEqual(CAPABILITIES['health-pressure'].providers[0], CAPABILITIES['restart-control'].providers[0])
})

test('a dimension with no telemetry is unknown, and its weight is redistributed', () => {
  // A value at the warn line is 40; at the critical line it is 100.
  assert.equal(scoreDimension('memory', { value: 70, warn: 70, critical: 92 }), 40)
  assert.equal(scoreDimension('memory', { value: 92, warn: 70, critical: 92 }), 100)
  assert.equal(scoreDimension('memory', { value: 200, warn: 70, critical: 92 }), 100)
  assert.equal(scoreDimension('memory', null), null)
  assert.equal(scoreDimension('memory', { value: Number.NaN }), null)

  const readings = scriptedReadings([{ memory: 92, cpu: 95, runtime: 0 }])
  const engine = createHealthEngine({ readings, config: { sampling: { intervalMs: 1000 } } })
  const full = engine.sample(1000)
  assert.equal(full.coverage, 100)
  assert.ok(full.pressure > 60, `expected real pressure, got ${full.pressure}`)
  assert.deepEqual(full.unknown, [])
})

test('missing telemetry lowers coverage instead of reading as calm', () => {
  // A collector that returns nothing for memory and cpu. Responsiveness is still measured -- it is
  // the sampler's own observation about the loop it runs in -- so three of four dimensions are
  // unknown and the coverage says how much of the intended weight actually reported.
  const engine = createHealthEngine({
    readings: () => ({ runtime: { value: 90, warn: 60, critical: 90 } }),
    config: { sampling: { intervalMs: 1000 } }
  })
  const sample = engine.sample(1000)
  assert.deepEqual(sample.unknown.sort(), ['cpu', 'memory'])
  assert.equal(sample.scores.runtime, 100)
  // runtime's weight (0.20) plus responsiveness' (0.15): 35% of the intended weight reported.
  assert.equal(sample.coverage, 35)
  // The score is over what reported: runtime at critical is 100, and the escalation term carries it.
  assert.equal(sample.mean, 57, 'the mean is over the dimensions that reported, not over all four')
  assert.equal(sample.worst, 100)
  assert.ok(sample.pressure >= 70, `a critical dimension must escalate: ${sample.pressure}`)
})

test('a collector that throws leaves a dimension unknown rather than taking the monitor down', () => {
  const engine = createHealthEngine({
    readings: () => {
      throw new Error('the sensor is broken')
    },
    config: { sampling: { intervalMs: 1000 } }
  })
  const sample = engine.sample(1000)
  assert.equal(sample.pressure, 0)
  // Everything the *collector* supplies is unknown. Responsiveness is not: the sampler measures
  // its own event-loop drift, so it is the one dimension that cannot be taken away by a sensor.
  assert.deepEqual(sample.unknown.sort(), ['cpu', 'memory', 'runtime'])
  assert.match(sample.failure, /the sensor is broken/)
})

test('the maintenance window wraps midnight, and a misconfigured one is never open', () => {
  assert.equal(inWindow(120, '01:00', '03:00'), true)
  assert.equal(inWindow(30, '01:00', '03:00'), false)
  // 23:00-01:00 is an ordinary nightly window: it wraps, it is not misconfigured.
  assert.equal(inWindow(23 * 60 + 30, '23:00', '01:00'), true)
  assert.equal(inWindow(30, '23:00', '01:00'), true)
  assert.equal(inWindow(12 * 60, '23:00', '01:00'), false)
  // An empty or unparseable window is never open, rather than always open.
  assert.equal(inWindow(600, '03:00', '03:00'), false)
  assert.equal(inWindow(600, 'nonsense', '05:00'), false)
})

test('the action ladder escalates and de-escalates with hysteresis', () => {
  const engine = createHealthEngine({
    readings: scriptedReadings([
      { memory: 10, cpu: 10, runtime: 0 },
      { memory: 80, cpu: 80, runtime: 70 },
      { memory: 95, cpu: 95, runtime: 0 },
      { memory: 10, cpu: 10, runtime: 0 }
    ]),
    config: { sampling: { intervalMs: 1000 }, restartRequiresSustainedMs: 0, maintenance: { enabled: false } }
  })

  // No samples yet: a decision is reported as exactly that, and takes no sample of its own.
  const empty = engine.decide(1000)
  assert.equal(empty.action, ACTIONS.NO_ACTION)
  assert.deepEqual(empty.reasons, ['no samples have been taken yet'])

  // Samples are taken on the configured interval, so the sampler's own drift measurement is not
  // reporting the test's timing back as pressure.
  engine.sample(1000)
  assert.equal(engine.decide(1000).action, ACTIONS.NO_ACTION)

  // Moderate load across memory, cpu and age: above `throttle.enter` (55), below `pause.enter` (70).
  engine.sample(2000)
  const throttled = engine.decide(2000)
  assert.equal(throttled.action, ACTIONS.THROTTLE, `pressure ${throttled.pressure}`)

  // Memory and CPU pinned at critical. This is the case the escalation term exists for: the mean
  // alone would sit below the pause threshold on a machine that is on fire.
  engine.sample(3000)
  const escalated = engine.decide(3000)
  assert.equal(escalated.action, ACTIONS.REQUEST_RESTART, `pressure ${escalated.pressure} (mean ${escalated.mean})`)
  assert.ok(escalated.request, 'an escalated decision carries a request')
  assert.equal(escalated.request.reasonCode, 'RUNTIME_PRESSURE')
  assert.equal(escalated.request.mode, 'application')
  assert.equal(escalated.request.checkpointRequired, true)

  // Back to calm: it must come all the way down, not sit at the top.
  engine.sample(4000)
  const released = engine.decide(4000)
  assert.equal(released.action, ACTIONS.NO_ACTION, `pressure ${released.pressure} sat at ${released.action}`)
})

test('a restart needs sustained pressure, then respects a cooldown', () => {
  const hot = scriptedReadings([{ memory: 95, cpu: 95 }, { memory: 95, cpu: 95 }, { memory: 95, cpu: 95 }, { memory: 95, cpu: 95 }])
  const engine = createHealthEngine({
    readings: hot,
    // A long sustained gate: one hot sample must not be enough.
    config: { sampling: { intervalMs: 1000 }, restartRequiresSustainedMs: 10_000, cooldowns: { restartMs: 60_000, actionMs: 0 } }
  })

  engine.sample(1000)
  const first = engine.decide(2000)
  assert.equal(first.action, ACTIONS.PAUSE_NEW_WORK, 'a brief spike must not request a restart')
  assert.equal(first.request, null)
  assert.match(first.held, /short of the 10000ms/)

  engine.sample(20_000)
  const sustained = engine.decide(20_500)
  assert.equal(sustained.action, ACTIONS.REQUEST_RESTART)
  assert.ok(sustained.request)
  assert.ok(sustained.sustainedMs >= 10_000, `sustained ${sustained.sustainedMs}ms`)

  // A second request inside the cooldown is held, not repeated.
  engine.sample(21_000)
  const held = engine.decide(21_500)
  assert.equal(held.action, ACTIONS.PAUSE_NEW_WORK)
  assert.match(held.held, /cooldown/)
})

test('the plugin declares the vocabulary, consumes restart-control optionally, and cannot restart', () => {
  const plugin = createHealthSchedulerPlugin()
  assert.deepEqual(plugin.manifest.provides.slice().sort(), [...PROVIDES].sort())
  assert.deepEqual(plugin.manifest.optional_capabilities, [...OPTIONAL_CAPABILITIES])
  assert.deepEqual(plugin.manifest.requires_capabilities, [], 'nothing may be required: a monitor that will not start is a monitor that is not watching')
  assert.equal(plugin.manifest.default_enabled, false)

  // The claim that matters, asserted rather than promised: nothing in the plugin can stop the
  // machine or the process. Comments are scanned too, which is why the source does not contain the
  // words either -- a guarantee that needs a parser to check is a weaker guarantee.
  const source = [
    fs.readFileSync(path.join(ROOT, 'app', 'plugins', 'health-scheduler', 'index.cjs'), 'utf8'),
    fs.readFileSync(path.join(ROOT, 'app', 'plugins', 'health-scheduler', 'health.cjs'), 'utf8')
  ].join('\n')
  for (const word of ['shutdown', 'reboot', 'taskkill', 'execFile', 'execSync', 'spawnSync', 'spawn(', 'process.kill', 'node:child_process', 'SIGTERM', 'SIGKILL']) {
    assert.equal(source.includes(word), false, `the health plugin must not contain "${word}"`)
  }
  // It reaches the authority only through the capability registry.
  assert.match(source, /context\.require\('restart-control', \{ optional: true \}\)/)
})

test('the plugin starts and stops independently, and monitors without a restart authority', async () => {
  const manager = createPluginManager({ log: () => {} })
  const plugin = createHealthSchedulerPlugin({
    readings: scriptedReadings([{ memory: 20, cpu: 20 }]),
    config: { sampling: { intervalMs: 60_000 } }
  })
  try {
    assert.equal(manager.install(plugin).ok, true)
    const id = plugin.manifest.id
    assert.equal(manager.entry(id).enabled, false)

    manager.enable(id)
    assert.equal((await manager.load(id)).ok, true)
    // Sampling, and every capability published.
    for (const capability of PROVIDES) assert.equal(manager.registry.has(capability), true, `${capability} was not provided`)

    const health = await manager.checkHealth(id)
    // Degraded, not unhealthy: the monitor is working and cannot restart things. Those are two
    // different facts and collapsing them is what the health vocabulary exists to prevent.
    assert.equal(health.status, 'degraded')
    assert.match(health.reason, /restart unavailable/)
    assert.equal(health.detail.restart.available, false)
    assert.match(health.detail.restart.reason, /no plugin provides restart-control/)

    // The monitoring capabilities answer normally while the restart is unavailable.
    const pressure = manager.registry.resolve('health-pressure')
    const report = pressure.report()
    assert.equal(report.samples >= 1, true)
    assert.equal(report.latest.coverage, 100)
    const maintenance = manager.registry.resolve('maintenance-scheduling')
    assert.equal(typeof maintenance.inWindow(Date.now()), 'boolean')

    // Disable: everything it provided goes away, and enabling again is a fresh start.
    await manager.disable(id)
    for (const capability of PROVIDES) assert.equal(manager.registry.has(capability), false, `${capability} survived unload`)
    manager.enable(id)
    assert.equal((await manager.load(id)).ok, true)
    assert.equal(manager.registry.has('health-pressure'), true)
  } finally {
    await manager.unloadAll()
  }
})

test('with a restart authority present the request goes through it and nothing else happens', async () => {
  const manager = createPluginManager({ log: () => {} })
  const calls = []
  // A stand-in authority: it records what it was asked and never acts, which is exactly what the
  // plugin must depend on -- it hands over a request and finds out what happened.
  const authority = {
    manifest: {
      api_version: 'dshns.plugin/v1',
      id: 'test.restart-authority',
      name: 'Restart authority',
      version: '1.0.0',
      provides: ['restart-control'],
      default_enabled: true
    },
    load(context) {
      context.provide('restart-control', {
        request: (payload) => {
          calls.push(payload)
          return { accepted: true, detail: 'the authority took it' }
        }
      })
      return { ok: true }
    }
  }

  const plugin = createHealthSchedulerPlugin({
    readings: scriptedReadings([{ memory: 96, cpu: 96 }, { memory: 96, cpu: 96 }, { memory: 96, cpu: 96 }]),
    config: { sampling: { intervalMs: 60_000 }, restartRequiresSustainedMs: 0, cooldowns: { restartMs: 0, actionMs: 0 } }
  })

  try {
    assert.equal(manager.install(authority).ok, true)
    assert.equal(manager.install(plugin).ok, true)
    // The authority first, so the capability is resolvable when the monitor needs it.
    assert.equal((await manager.load(authority.manifest.id)).ok, true)
    manager.enable(plugin.manifest.id)
    assert.equal((await manager.load(plugin.manifest.id)).ok, true)

    const health = await manager.checkHealth(plugin.manifest.id)
    assert.equal(health.detail.restart.available, true, health.reason)

    // Drive it hot and let it request.
    plugin.engine.sample(Date.now())
    plugin.engine.sample(Date.now() + 1)
    await plugin.tick()

    assert.equal(calls.length >= 1, true, 'the authority was never asked')
    assert.equal(calls[0].reasonCode, 'RUNTIME_PRESSURE')
    assert.equal(calls[0].mode, 'application')
    // The plugin did not restart anything: it called the authority and recorded the answer.
    const diagnostics = plugin.diagnostics()
    assert.equal(diagnostics.lastOutcome.ok, true)
    assert.equal(diagnostics.lastOutcome.answer.detail, 'the authority took it')
  } finally {
    await manager.unloadAll()
  }
})

test('the adapter declines a module that is not a native plugin', async () => {
  const framework = createAdapterFramework({ log: () => {} })
  framework.register(createNativeHnsAdapter())
  const adapted = await framework.adapt({ module: { notAPlugin: true } })
  assert.equal(adapted.ok, false)
  assert.equal(adapted.code, 'ADAPTER_UNDETECTED')
})
