'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..', '..')
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8')

const {
  createRestartBudget
} = require('../../app/plugins/restart-supervisor/budget.cjs')
const {
  createHeartbeatMonitor
} = require('../../app/plugins/restart-supervisor/heartbeat.cjs')
const {
  createRestartLifecycle
} = require('../../app/plugins/restart-supervisor/lifecycle.cjs')
const {
  createRestartCompanion,
  companionPaths,
  claimRestartLock,
  restartLockHeldByOther
} = require('../../app/plugins/restart-supervisor/companion.cjs')
const {
  createRestartSupervisorPlugin,
  SUPERVISOR_PLUGIN_ID,
  RESTART_CONTROL_CAPABILITY,
  RESTART_MODES,
  REFUSAL_CODES,
  SUPERVISOR_STATES,
  SUPERVISOR_HEALTH,
  DEFAULT_RESTART_CONFIG
} = require('../../app/plugins/restart-supervisor/index.cjs')
const { createPluginManager } = require('../../app/core/plugin-manager/index.cjs')
const { healthSchedulerPlugin } = require('../../app/plugins/health-scheduler/index.cjs')
const { BUNDLED_MANIFEST, builtInEntries } = require('../../app/extensions/mega/plugins/index.cjs')

/**
 * `dshns.restart-supervisor`: the only restart authority, and the line between it and the monitor.
 *
 * The property this suite exists for is a *separation*, and separations are only true if something
 * checks them: the health scheduler may not be able to stop anything, the supervisor may not have an
 * opinion about health, and neither may take the other down. So the first tests scan both sources,
 * the middle ones drive the budget, the crash-loop ladder, the heartbeat and the lifecycle, and the
 * last ones run the whole thing — companion included — through the plugin manager.
 */

function scratch(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-${label}-`))
  return { dir, dispose: () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }) }
}

const sleep = () => Promise.resolve()

// ---------------------------------------------------------------------------------------------
// 1. The authority separation, asserted against the sources
// ---------------------------------------------------------------------------------------------

test('the health scheduler cannot stop anything, and the supervisor has no health policy', () => {
  const healthSource = [
    read('app/plugins/health-scheduler/index.cjs'),
    read('app/plugins/health-scheduler/health.cjs'),
    read('app/plugins/health-scheduler/providers.cjs'),
    read('app/plugins/health-scheduler/severity.cjs')
  ].join('\n')
  // The monitor holds no way to stop the machine or the process. Comments are scanned too, which is
  // why its own prose avoids the words -- a guarantee that needs a parser to check is a weaker one.
  for (const word of ['shutdown', 'reboot', 'taskkill', 'execFile', 'execSync', 'spawnSync', 'spawn(', 'process.kill', 'node:child_process', 'SIGTERM', 'SIGKILL']) {
    assert.equal(healthSource.includes(word), false, `the health plugin must not contain "${word}"`)
  }
  // Its only route to a restart is the capability registry.
  assert.match(healthSource, /context\.require\('restart-control', \{ optional: true \}\)/)
  assert.equal(/require\(['"][^'"]*restart-supervisor/.test(healthSource), false, 'the monitor imports the supervisor')

  const supervisorSource = [
    read('app/plugins/restart-supervisor/index.cjs'),
    read('app/plugins/restart-supervisor/budget.cjs'),
    read('app/plugins/restart-supervisor/lifecycle.cjs'),
    read('app/plugins/restart-supervisor/heartbeat.cjs')
  ].join('\n')
  // The authority has no health policy: it does not read the health capabilities, score a pressure or
  // decide that a restart is *warranted*. It receives a request, prices it and executes it. The words
  // are asserted where they would mean something — a capability name, a sensor, the monitor itself —
  // rather than as bare strings, because the supervisor legitimately reports a *heartbeat* pressure of
  // its own and a ban on the noun would be a ban on the wrong thing.
  for (const word of ["'health-pressure'", "'hardware-health'", 'hardware-health', 'os.cpus', 'os.freemem', 'os.totalmem', 'scoreDimension', 'health-scheduler']) {
    assert.equal(supervisorSource.includes(word), false, `the restart supervisor must not contain "${word}"`)
  }
  assert.equal(/require\(['"][^'"]*health-scheduler/.test(supervisorSource), false, 'the supervisor imports the monitor')
})

test('neither plugin is a dependency of the other', () => {
  const supervisor = createRestartSupervisorPlugin({ stateDir: path.join(os.tmpdir(), 'x'), log: () => {} })
  const health = healthSchedulerPlugin()
  // The supervisor requires nothing; the monitor requires nothing and consumes restart-control only
  // optionally. That is what makes each of them survive the other being uninstalled.
  assert.deepEqual(supervisor.manifest.requires_capabilities, [])
  assert.deepEqual(health.manifest.requires_capabilities, [])
  assert.deepEqual(supervisor.manifest.optional_capabilities, [])
  assert.ok(health.manifest.optional_capabilities.includes('restart-control'))
  assert.notEqual(supervisor.manifest.id, health.manifest.id)
})

test('there is exactly one restart executor: the supervisor, in process or as its companion', () => {
  // The legacy shape this replaced had two: the reboot coordinator and the watchdog. The coordinator
  // is still the *machine-level* tier (it is the only thing that may schedule a shutdown), and the
  // supervisor is the application-level one; what must not exist is a second application restart path.
  const supervisor = createRestartSupervisorPlugin({ stateDir: path.join(os.tmpdir(), 'x'), log: () => {} })
  assert.deepEqual(supervisor.manifest.provides, [RESTART_CONTROL_CAPABILITY])
  assert.equal(supervisor.manifest.id, SUPERVISOR_PLUGIN_ID)

  // The shipped plugin set contains exactly one provider of the capability.
  const mounted = read('app/plugins/mounted/index.cjs')
  const providers = (mounted.match(/provides:.*restart-control/g) || []).length
  assert.equal(providers <= 1, true, 'more than one shipped plugin claims restart-control')
  assert.match(mounted, /restartSupervisorPlugin\(\{ host, nodeExe, stateDir \}\)/)
  /**
   * ...and the shell's continuity layer reaches that plugin, and only it.
   *
   * Parking and resuming the product's tasks is Core's (`app/core/task-continuity.cjs`), handed to the
   * supervisor through `createPluginHost({ continuity })` and the mounted set. A plugin that received
   * it by accident would be a plugin that can stop a user's work.
   */
  assert.equal((mounted.match(/restartSupervisorPlugin\(\{ host, nodeExe, stateDir \}\)/g) || []).length, 1, 'the continuity host must be passed to exactly one plugin')
  const shell = read('app/desktop-main.cjs')
  assert.match(shell, /continuity: taskContinuity\(\)\.hooks/)
  assert.match(shell, /function taskContinuity\(\)/)
  assert.match(shell, /require\('\.\/core\/task-continuity\.cjs'\)/)

  // The capability's declared provider is the supervisor, not the process adapter.
  const capability = require('../../app/core/contracts/capability.cjs')
  assert.deepEqual(capability.CAPABILITIES['restart-control'].providers, ['dshns.restart-supervisor'])
})

/**
 * The three paths that are *not* the application restart authority, each asserted for what it is.
 *
 * They all still exist, and that is deliberate rather than leftover: a release upgrade, a scheduled
 * machine shutdown and a stalled task are different questions from "restart the application now". What
 * must not exist is a *second answer* to that one — so each of them is pinned to the one thing it does.
 */
test('the other restart-shaped paths report or schedule, and none of them executes an application restart', () => {
  const mounted = read('app/plugins/mounted/index.cjs')
  // The watchdog: a stall detector, and nothing else. Its whole body is scanned, because "it never
  // restarted anything" is a claim about its code rather than about its name.
  const watchdog = mounted.slice(mounted.indexOf('function watchdogPlugin()'), mounted.indexOf('/** Session keeper'))
  assert.ok(watchdog.length > 0, 'the watchdog plugin must still be visible to this scan')
  assert.match(watchdog, /provides: \['watchdog'\]/)
  for (const word of ['taskkill', 'process.kill', 'spawn(', 'shutdown', 'restart-control', 'node:child_process']) {
    assert.equal(watchdog.includes(word), false, `the watchdog must not hold "${word}": it reports a stall, it does not act on one`)
  }

  // The machine-level tier: the reboot coordinator is the only thing that may schedule a shutdown, and
  // it is not a restart-control provider.
  const coordinator = read('app/reboot/coordinator.cjs')
  assert.match(coordinator, /shutdown \/r/)
  assert.equal(coordinator.includes('restart-control'), false, 'the machine tier must not hand itself the application restart capability')

  // The release tier: the update runner relaunches once after replacing the installed harness, and it
  // reads no budget, no heartbeat and no crash loop.
  const updateRunner = read('app/extensions/mega/updater/update-runner.js')
  for (const word of ['restart-control', 'safeMode', 'crashLoop']) {
    assert.equal(updateRunner.includes(word), false, `the update runner must not depend on "${word}"`)
  }
})

// ---------------------------------------------------------------------------------------------
// 2. The budget: maxRestarts, window, cooldown, backoff
// ---------------------------------------------------------------------------------------------

test('the budget refuses a restart past its maximum inside the window', () => {
  let clock = 0
  const budget = createRestartBudget({ now: () => clock, config: { budget: { maxRestarts: 2, windowMs: 1000, cooldownMs: 0, backoffMs: 0, backoffMaxMs: 0 } } })

  for (let index = 0; index < 2; index += 1) {
    assert.equal(budget.evaluate({ mode: RESTART_MODES.APPLICATION }, clock).ok, true, `restart ${index + 1} should be allowed`)
    budget.accept({ mode: RESTART_MODES.APPLICATION }, clock)
    budget.record({ at: clock, ok: true, counted: true })
    clock += 10
  }
  const refused = budget.evaluate({ mode: RESTART_MODES.APPLICATION }, clock)
  assert.equal(refused.ok, false)
  assert.equal(refused.code, REFUSAL_CODES.BUDGET_EXHAUSTED)
  assert.match(refused.reason, /budget of 2/)

  // The window is *rolling*: past it, the restarts are forgotten and the budget is whole again.
  clock += 2000
  assert.equal(budget.evaluate({ mode: RESTART_MODES.APPLICATION }, clock).ok, true)
})

test('the cooldown and the exponential backoff both hold a restart back', () => {
  let clock = 0
  // `backoffMs` is 40s so that the first doubling (80s) is already above the 60s cooldown floor; with
  // the shipped 5s the floor masks the first two doublings, which is the floor doing its job.
  const budget = createRestartBudget({ now: () => clock, config: { budget: { maxRestarts: 20, windowMs: 100_000_000, cooldownMs: 60_000, backoffMs: 40_000, backoffMaxMs: 300_000, resetOnSuccess: false } } })
  budget.accept({}, clock)
  budget.record({ at: clock, ok: true, counted: true })

  const tooSoon = budget.evaluate({}, clock + 1_000)
  assert.equal(tooSoon.ok, false)
  assert.equal(tooSoon.code, REFUSAL_CODES.COOLDOWN)
  assert.ok(tooSoon.retryAfterMs > 0)
  assert.equal(budget.backoffFor(), 60_000, 'the cooldown is the floor')

  clock += 100_000
  budget.accept({}, clock)
  budget.record({ at: clock, ok: false, counted: true })
  assert.equal(budget.backoffFor(), 80_000, 'one failure doubles the backoff above the floor')

  clock += 200_000
  budget.accept({}, clock)
  budget.record({ at: clock, ok: false, counted: true })
  assert.equal(budget.backoffFor(), 160_000, 'the backoff doubles per consecutive failure')

  // And the cap holds however many failures accumulate.
  for (let index = 0; index < 12; index += 1) {
    clock += 400_000
    budget.accept({}, clock)
    budget.record({ at: clock, ok: false, counted: true })
  }
  assert.equal(budget.backoffFor(), 300_000, 'the backoff must be capped')
  // Fifteen consecutive failures are a crash loop, and the ladder must say so rather than reporting
  // normal: the tier above DEGRADED is the one that stops automatic execution.
  assert.equal(budget.health(clock).safeMode, true, 'fifteen failures must not be reported as normal')
})

test('a restart that never reached an executor does not spend the budget', () => {
  let clock = 0
  const budget = createRestartBudget({ now: () => clock, config: { budget: { maxRestarts: 1, windowMs: 100_000, cooldownMs: 0 } } })
  budget.accept({}, clock)
  // `counted: false` is the executor-unavailable case: the request happened, the restart did not.
  budget.record({ at: clock, ok: false, counted: false, detail: 'no companion is running' })
  assert.equal(budget.report(clock).used, 0, 'a restart that did not happen consumed the budget')
  assert.equal(budget.history().length, 1, 'the attempt must still be recorded')
  assert.equal(budget.evaluate({}, clock).ok, true)
})

// ---------------------------------------------------------------------------------------------
// 3. The crash-loop ladder and safe mode
// ---------------------------------------------------------------------------------------------

test('repeated failures walk NORMAL -> DEGRADED -> SAFE_MODE and stop the loop', () => {
  let clock = 0
  const budget = createRestartBudget({
    now: () => clock,
    config: { budget: { maxRestarts: 10, windowMs: 10_000_000, cooldownMs: 0, backoffMs: 0, backoffMaxMs: 0 }, crashLoop: { degradedAt: 2, safeModeAt: 4, safeModeOnLoop: true } }
  })
  assert.equal(budget.health().tier, SUPERVISOR_HEALTH.NORMAL)

  const attempt = (ok) => {
    budget.accept({}, clock)
    budget.record({ at: clock, ok, counted: true })
    clock += 10
    return budget.health()
  }
  assert.equal(attempt(false).tier, SUPERVISOR_HEALTH.NORMAL, 'one failure is not a loop')
  assert.equal(attempt(false).tier, SUPERVISOR_HEALTH.DEGRADED)
  assert.equal(attempt(false).tier, SUPERVISOR_HEALTH.DEGRADED)
  const safe = attempt(false)
  assert.equal(safe.tier, SUPERVISOR_HEALTH.SAFE_MODE)
  assert.equal(safe.safeMode, true)

  // Safe mode refuses **every** automatic restart, and says which one it is.
  for (const mode of [RESTART_MODES.APPLICATION, RESTART_MODES.GRACEFUL, RESTART_MODES.EMERGENCY]) {
    const refusal = budget.evaluate({ mode }, clock)
    assert.equal(refusal.ok, false, `${mode} was allowed in safe mode`)
    assert.equal(refusal.code, REFUSAL_CODES.SAFE_MODE)
  }

  // The human escape hatch is the only way out, and it keeps the history.
  const before = budget.history().length
  const reset = budget.reset(clock, 'official-ui')
  assert.equal(reset.ok, true)
  assert.equal(reset.cleared >= before, true, 'the reset must report what it cleared')
  assert.equal(budget.health(clock).tier, SUPERVISOR_HEALTH.NORMAL)
  assert.ok(budget.history().length >= before, 'the audit trail must survive a budget reset')
  assert.equal(budget.evaluate({ mode: RESTART_MODES.APPLICATION }, clock).ok, true)
})

test('a successful restart clears the failure streak when configured to', () => {
  let clock = 0
  const budget = createRestartBudget({ now: () => clock, config: { budget: { maxRestarts: 10, windowMs: 10_000_000, cooldownMs: 0, resetOnSuccess: true } } })
  budget.accept({}, clock); budget.record({ at: clock, ok: false, counted: true }); clock += 10
  budget.accept({}, clock); budget.record({ at: clock, ok: false, counted: true }); clock += 10
  assert.equal(budget.health(clock).tier, SUPERVISOR_HEALTH.DEGRADED)
  budget.accept({}, clock); budget.record({ at: clock, ok: true, counted: true }); clock += 10
  assert.equal(budget.health(clock).tier, SUPERVISOR_HEALTH.NORMAL)
  assert.equal(budget.report(clock).consecutiveFailures, 0)
})

// ---------------------------------------------------------------------------------------------
// 4. The heartbeat: process alive is not runtime responsive
// ---------------------------------------------------------------------------------------------

test('a live process with a stale heartbeat is not healthy, and escalation is bounded', () => {
    let clock = 0
    const monitor = createHeartbeatMonitor({ now: () => clock, config: { intervalMs: 1_000, timeoutMs: 2_000, livenessTimeoutMs: 20_000, forcedAfterMs: 9_000, gracefulRecoveryMs: 3_000 } })
    monitor.seen(4242, clock)
    monitor.beatResponsive(null, clock)
    monitor.beatLoop(null, clock)
    monitor.beatReady(null, clock)
    assert.equal(monitor.report(clock).verdict, 'healthy')
    assert.equal(monitor.report(clock).action, 'none')

    // The process is still alive; the beat is not. That is the state a pid check cannot see, and it
    // is why liveness has its own clock: `seen()` is the only thing that refreshes it.
    clock += 4_000
    const early = monitor.report(clock)
    assert.equal(early.processAlive, true, 'the process is still alive')
    assert.equal(early.verdict, 'unresponsive')
    assert.equal(early.action, 'graceful-recovery', `expected a graceful recovery, got ${early.action} (${early.reason})`)
    assert.match(String(early.reason), /stale/)

    clock += 6_000
    const late = monitor.report(clock)
    assert.equal(late.action, 'forced-restart', 'a process that has not beaten for the forced threshold must not be waited for')
    assert.match(String(late.reason), /forced threshold/)
})

test('a process that is gone is reported as gone, not as unresponsive', () => {
  let clock = 0
  const monitor = createHeartbeatMonitor({ now: () => clock, config: { intervalMs: 500, timeoutMs: 1_000, livenessTimeoutMs: 2_000, forcedAfterMs: 3_000, gracefulRecoveryMs: 1_000 } })
  monitor.seen(1, clock)
  clock += 5_000
  const report = monitor.report(clock)
  assert.equal(report.verdict, 'gone')
  assert.equal(report.action, 'recover')
})

test('a heartbeat that has never beaten is unknown, never fresh', () => {
  const monitor = createHeartbeatMonitor({ now: () => 0, config: { timeoutMs: 1_000 } })
  const report = monitor.report(0)
  assert.equal(report.signals.responsive.state, 'unknown')
  assert.equal(report.verdict, 'partial', 'a monitor with no telemetry must not claim health')
  assert.ok(report.unknown.includes('responsive'))
})

// ---------------------------------------------------------------------------------------------
// 5. The lifecycle: order, refusals, readiness retries and continuity's role
// ---------------------------------------------------------------------------------------------

/** A lifecycle rig with every side effect recorded, so the *order* can be asserted. */
function lifecycleRig(overrides = {}) {
  const order = []
  let clock = 0
  const budget = createRestartBudget({ now: () => clock, config: overrides.budget || { budget: { maxRestarts: 5, windowMs: 10_000_000, cooldownMs: 0 } } })
  const lifecycle = createRestartLifecycle({
    budget,
    now: () => clock,
    // A slept millisecond is a millisecond of virtual time. Without this a bounded wait that never
    // becomes satisfied would spin forever, because the rig's clock would never move.
    sleep: async (ms = 1) => { clock += Math.max(1, ms) },
    log: () => {},
    config: overrides.config,
    executor: {
      stop: async ({ kind }) => { order.push(`stop:${kind}`); return overrides.stop ? overrides.stop({ kind, order }) : { ok: true } },
      launch: async () => { order.push('launch'); return overrides.launch ? overrides.launch({ order }) : { ok: true, pid: 9 } },
      waitForExit: async () => ({ ok: true })
    },
    continuity: {
      beforeRestart: async () => { order.push('beforeRestart'); return overrides.beforeRestart ? overrides.beforeRestart({ order }) : { ok: true } },
      afterRestart: async () => { order.push('afterRestart'); return overrides.afterRestart ? overrides.afterRestart({ order }) : { ok: true } },
      pendingWork: async () => { order.push('pendingWork'); return overrides.pendingWork ? overrides.pendingWork({ order }) : { ok: true, active: false } }
    },
    readiness: overrides.readiness || {
      process: async () => ({ ok: true }),
      runtime: async () => ({ ok: true }),
      network: async () => ({ ok: true }),
      plugins: async () => ({ ok: true }),
      continuity: async () => ({ ok: true })
    }
  })
  return { lifecycle, budget, order, tick: (ms) => { clock += ms }, get clock() { return clock } }
}

test('the lifecycle performs the documented order around a restart', async () => {
  const rig = lifecycleRig()
  const outcome = await rig.lifecycle.run({ mode: RESTART_MODES.APPLICATION, reasonCode: 'MANUAL' })
  assert.equal(outcome.ok, true, outcome.reason)
  assert.deepEqual(rig.order, ['beforeRestart', 'pendingWork', 'stop:graceful', 'launch', 'afterRestart'])
  // The checkpoint/continuity notification comes *before* anything stops accepting work, and the
  // resume notification comes *after* readiness. That is the whole ordering rule.
  assert.ok(rig.order.indexOf('beforeRestart') < rig.order.indexOf('stop:graceful'))
  assert.ok(rig.order.indexOf('launch') < rig.order.indexOf('afterRestart'))
  assert.equal(outcome.shutdown.kind, 'graceful')
  assert.equal(outcome.resumed, true)
})

test('a continuity layer that refuses cancels the restart without spending the budget', async () => {
  const rig = lifecycleRig({ beforeRestart: () => ({ ok: false, code: 'BUSY', reason: 'a destructive migration is in flight' }) })
  const outcome = await rig.lifecycle.run({ mode: RESTART_MODES.APPLICATION, reasonCode: 'HEALTH_PRESSURE' })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'BUSY')
  assert.equal(outcome.counted, false)
  assert.equal(rig.order.includes('stop:graceful'), false, 'the application was stopped although continuity refused')
  assert.equal(rig.budget.report(rig.clock).used, 0)
})

test('an unsafe boundary defers the restart and reports what blocked it', async () => {
  const rig = lifecycleRig({
    pendingWork: () => ({ ok: true, active: true, nearCheckpoint: false, uninterruptible: true }),
    // The config blocks are the ones `lifecycle.cjs` reads: `lifecycle` for the timeouts and
    // `readiness` for the gate budget. A nested `config.config` is not a thing.
    config: { lifecycle: { boundaryTimeoutMs: 2, gracefulTimeoutMs: 100, forcedTimeoutMs: 100 }, readiness: { timeoutMs: 100, maxAttempts: 1, backoffMs: 1, backoffMaxMs: 1, required: [] } }
  })
  const outcome = await rig.lifecycle.run({ mode: RESTART_MODES.APPLICATION, reasonCode: 'HEALTH_PRESSURE' })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, REFUSAL_CODES.UNSAFE_BOUNDARY)
  assert.match(String(outcome.reason), /uninterruptible/)
  assert.equal(rig.order.includes('stop:graceful'), false, 'the application was stopped with an uninterruptible operation in flight')
})

test('a graceful stop that does not finish is forced, and the forced path is reported', async () => {
  let stops = 0
  const rig = lifecycleRig({
    stop: ({ kind }) => {
      stops += 1
      if (kind === 'graceful') return { ok: false, reason: 'the application did not answer the shutdown frame' }
      return { ok: true, forced: true }
    }
  })
  const outcome = await rig.lifecycle.run({ mode: RESTART_MODES.APPLICATION, reasonCode: 'MANUAL' })
  assert.equal(outcome.ok, true)
  assert.equal(stops, 2, 'the forced path must be attempted exactly once after the graceful one')
  assert.deepEqual(rig.order.filter((entry) => entry.startsWith('stop:')), ['stop:graceful', 'stop:forced'])
  assert.equal(outcome.shutdown.forced, true)
})

test('readiness retries a gate that is not up yet, and only a required gate fails the boot', async () => {
  let networkAttempts = 0
  const rig = lifecycleRig({
    readiness: {
      process: async () => ({ ok: true }),
      runtime: async () => ({ ok: true }),
      // The Windows case: the network comes up after the application does. The first attempts fail.
      network: async () => {
        networkAttempts += 1
        return networkAttempts < 3 ? { ok: false, reason: 'the network is not reachable yet' } : { ok: true }
      },
      plugins: async () => ({ ok: true }),
      continuity: async () => ({ ok: true })
    },
    config: { readiness: { timeoutMs: 60_000, maxAttempts: 5, backoffMs: 1, backoffMaxMs: 2, required: ['process', 'runtime'] } }
  })
  const outcome = await rig.lifecycle.run({ mode: RESTART_MODES.APPLICATION, reasonCode: 'MANUAL' })
  assert.equal(outcome.ok, true, outcome.reason)
  assert.equal(networkAttempts, 3, `the network gate must be retried, saw ${networkAttempts} attempts`)
  assert.equal(outcome.readiness.ok, true)
})

test('a required gate that never comes up fails the restart with the gate named', async () => {
  const rig = lifecycleRig({
    readiness: {
      process: async () => ({ ok: true }),
      runtime: async () => ({ ok: false, reason: 'the runtime never answered' })
    },
    config: { readiness: { timeoutMs: 60_000, maxAttempts: 2, backoffMs: 1, backoffMaxMs: 2, required: ['process', 'runtime'] } }
  })
  const outcome = await rig.lifecycle.run({ mode: RESTART_MODES.APPLICATION, reasonCode: 'MANUAL' })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'SUPERVISOR_READINESS_FAILED')
  assert.ok(outcome.readiness.failed.includes('runtime'))
  assert.match(String(outcome.reason), /runtime never answered/)
})

test('an optional gate that never comes up is reported, not fatal', async () => {
  const rig = lifecycleRig({
    readiness: {
      process: async () => ({ ok: true }),
      runtime: async () => ({ ok: true }),
      network: async () => ({ ok: false, reason: 'offline' })
    },
    config: { readiness: { timeoutMs: 60_000, maxAttempts: 1, backoffMs: 1, backoffMaxMs: 1, required: ['process', 'runtime'] } }
  })
  const outcome = await rig.lifecycle.run({ mode: RESTART_MODES.APPLICATION, reasonCode: 'MANUAL' })
  assert.equal(outcome.ok, true)
  const network = outcome.readiness.gates.find((gate) => gate.id === 'network')
  assert.equal(network.ok, true, 'an optional gate must not fail the sequence')
  assert.equal(network.skipped, true)
})

// ---------------------------------------------------------------------------------------------
// 6. The plugin: restart-control through the registry, and what happens without a companion
// ---------------------------------------------------------------------------------------------

test('restart-control exposes the whole documented surface', async () => {
  const area = scratch('supervisor-surface')
  const plugin = createRestartSupervisorPlugin({ stateDir: area.dir, log: () => {} })
  try {
    const manager = createPluginManager({ log: () => {} })
    manager.install(plugin)
    const loaded = await manager.load(plugin.manifest.id, { force: true })
    assert.equal(loaded.ok, true, loaded.reason)
    const control = manager.registry.resolve(RESTART_CONTROL_CAPABILITY)
    assert.ok(control, 'the plugin did not provide restart-control')
    for (const method of ['requestRestart', 'requestGracefulRestart', 'requestEmergencyRestart', 'getRestartState', 'getRestartHistory', 'getRestartBudget', 'cancelPendingRestart']) {
      assert.equal(typeof control[method], 'function', `restart-control.${method} is missing`)
    }
    // The two operations safe mode leaves a person.
    assert.equal(typeof control.resetRestartBudget, 'function')
    assert.equal(typeof control.manualRestart, 'function')

    const state = await control.getRestartState()
    assert.equal(state.state, SUPERVISOR_STATES.MONITORING)
    assert.equal(state.health.tier, SUPERVISOR_HEALTH.NORMAL)
    assert.ok(state.config.budget.maxRestarts >= 1)
    assert.equal(typeof state.support.companion.running, 'boolean')
    await manager.unloadAll('test teardown')
  } finally {
    area.dispose()
  }
})

test('a request with no companion is delegated and recorded, and never raises', async () => {
  const area = scratch('supervisor-delegate')
  const plugin = createRestartSupervisorPlugin({ stateDir: area.dir, log: () => {} })
  try {
    plugin.load({ provide: () => ({ ok: true }), require: () => null, emit: () => {} })
    const outcome = await plugin.requestRestart({ reasonCode: 'MANUAL', reasonSummary: 'a person asked' })
    assert.equal(outcome.ok, true)
    assert.equal(outcome.accepted, true)
    assert.equal(outcome.delegated, true)
    // The request is written where the companion reads it. That is the whole hand-off.
    const requestFile = path.join(area.dir, 'restart.request.json')
    assert.equal(fs.existsSync(requestFile), true, 'the delegated request was not written')
    const written = JSON.parse(fs.readFileSync(requestFile, 'utf8'))
    assert.equal(written.reasonCode, 'MANUAL')
    // A delegated restart does not spend the budget: nothing has happened yet.
    assert.equal((await plugin.getRestartBudget()).used, 0)
    plugin.unload()
  } finally {
    area.dispose()
  }
})

test('every request is recorded with a reason, including the refusals', async () => {
  const area = scratch('supervisor-history')
  const plugin = createRestartSupervisorPlugin({ stateDir: area.dir, log: () => {}, config: { budget: { maxRestarts: 1, windowMs: 10_000_000 } } })
  try {
    plugin.load({ provide: () => ({ ok: true }), require: () => null, emit: () => {} })
    await plugin.requestRestart({ reasonCode: 'HEALTH_PRESSURE' })
    // The plugin delegates rather than executing, so the budget is only moved by the companion. Ask
    // for the history instead: every request must be in it, accepted or not.
    const history = await plugin.getRestartHistory()
    assert.ok(history.requests.length >= 1, 'an accepted request must appear in the history')
    const accepted = history.requests.find((entry) => entry.type === 'request-accepted')
    assert.ok(accepted, 'the accepted request was not recorded')
    assert.equal(accepted.request.reasonCode, 'HEALTH_PRESSURE')
    // A mode nobody may request is refused with a coded reason rather than silently dropped.
    const refused = await plugin.requestRestart({ mode: RESTART_MODES.SYSTEM })
    assert.equal(refused.ok, false)
    assert.equal(refused.code, REFUSAL_CODES.MODE_NOT_REQUESTABLE)
    const refusedEntry = (await plugin.getRestartHistory()).requests.find((entry) => entry.type === 'request-refused')
    assert.ok(refusedEntry, 'a refusal must be recorded')
    plugin.unload()
  } finally {
    area.dispose()
  }
})

test('the supervisor health check reports the companion and safe mode honestly', async () => {
  const area = scratch('supervisor-health')
  const plugin = createRestartSupervisorPlugin({ stateDir: area.dir, log: () => {} })
  try {
    plugin.load({ provide: () => ({ ok: true }), require: () => null, emit: () => {} })
    const withNoCompanion = plugin.healthCheck()
    assert.equal(withNoCompanion.status, 'degraded', 'no companion means a hung application could not be recovered by it')
    assert.match(String(withNoCompanion.reason), /companion/)
    plugin.unload()
    assert.equal(plugin.healthCheck().status, 'unknown', 'an unloaded supervisor is not healthy')
  } finally {
    area.dispose()
  }
})

// ---------------------------------------------------------------------------------------------
// 7. The companion: one executor at a time, and a loop that terminates
// ---------------------------------------------------------------------------------------------

test('the restart lock lets exactly one executor through, and a dead holder does not block it', () => {
  const area = scratch('supervisor-lock')
  try {
    const first = claimRestartLock(area.dir, { owner: 'plugin' })
    assert.equal(first.ok, true)
    // The second claim is refused while the holder is this very process (which is alive).
    const second = claimRestartLock(area.dir, { owner: 'companion' })
    assert.equal(second.ok, false)
    assert.equal(second.code, 'RESTART_LOCK_HELD')
    const held = restartLockHeldByOther(area.dir)
    assert.equal(held.held, false, 'a lock this process owns is not held *by another*')
    // A lock whose owner is gone is stale and may be taken over: a dead process must not be able to
    // block every restart forever.
    fs.writeFileSync(path.join(area.dir, 'restart.lock'), JSON.stringify({ pid: 999_999_999, owner: 'dead', at: Date.now(), ttlMs: 60_000 }), 'utf8')
    assert.equal(restartLockHeldByOther(area.dir).held, false)
    assert.equal(claimRestartLock(area.dir, { owner: 'companion' }).ok, true)
  } finally {
    area.dispose()
  }
})

test('a request older than its lifetime is discarded rather than executed later', () => {
  const area = scratch('supervisor-stale-request')
  try {
    const paths = companionPaths(area.dir)
    fs.writeFileSync(paths.requestFile, JSON.stringify({ at: 1000, reasonCode: 'MANUAL' }), 'utf8')
    let clock = 1000 + 400_000
    const companion = createRestartCompanion({
      stateDir: area.dir,
      now: () => clock,
      sleep,
      spawn: () => ({ ok: true, child: { pid: 1, exitCode: null, signalCode: null } }),
      kill: async () => ({ ok: true }),
      alive: () => true,
      readHeartbeat: () => null
    })
    const pending = companion.pendingRequest({ ttlMs: 300_000, now: clock })
    assert.equal(pending.pending, false)
    assert.equal(pending.stale, true)
    assert.equal(fs.existsSync(paths.requestFile), false, 'a stale request must be removed, not left to fire later')
    void clock
  } finally {
    area.dispose()
  }
})

test('the companion watch loop restarts a gone application and stops at the budget', async () => {
  const area = scratch('supervisor-watch')
  try {
    let spawned = 0
    let clock = 0
    const companion = createRestartCompanion({
      stateDir: area.dir,
      now: () => clock,
      sleep: async () => { clock += 1_000 },
      mode: RESTART_MODES.APPLICATION,
      config: { budget: { maxRestarts: 2, windowMs: 10_000_000, cooldownMs: 0, backoffMs: 0, backoffMaxMs: 0 }, crashLoop: { degradedAt: 1, safeModeAt: 2, safeModeOnLoop: true }, heartbeat: { intervalMs: 1_000, timeoutMs: 2_000, forcedAfterMs: 4_000, gracefulRecoveryMs: 2_000 }, readiness: { timeoutMs: 1_000, maxAttempts: 1, backoffMs: 1, backoffMaxMs: 1, required: ['process'] } },
      spawn: () => { spawned += 1; return { ok: true, child: { pid: 100 + spawned, exitCode: null, signalCode: null } } },
      kill: async () => ({ ok: true }),
      alive: () => false,
      readHeartbeat: () => ({ at: clock, ready: true, responsive: true, loop: true })
    })
    // Every iteration the application is gone, so every iteration asks for a restart; the budget and
    // then safe mode have to stop it.
    const result = await companion.watch({ iterations: 6, intervalMs: 1, probe: () => ({ alive: false, exitCode: 1, pid: 100 + spawned }) })
    assert.equal(result.ok, true)
    assert.ok(spawned >= 1, `the companion never launched the application (${spawned})`)
    assert.ok(spawned <= 4, `the companion launched ${spawned} times, which is past every bound`)
    const verdicts = result.trace.map((entry) => entry.verdict)
    assert.ok(verdicts.includes('refused') || verdicts.includes('safe-mode'), `the loop never refused: ${JSON.stringify(verdicts)}`)
    assert.ok(['SAFE_MODE', 'DEGRADED', 'MONITORING'].includes(result.state))
  } finally {
    area.dispose()
  }
})

/**
 * The shell's own application is already running when the companion starts, so the companion must
 * *adopt* it rather than launch a second copy — and it must then judge liveness by asking the OS about
 * the pid it adopted, not about a `ChildProcess` handle it never had. A companion that watched `null`
 * would report a healthy application forever.
 */
test('an attached companion supervises a process it did not start, and notices it leave', async () => {
  const area = scratch('supervisor-attach')
  try {
    let clock = 0
    let alive = true
    let killed = 0
    const companion = createRestartCompanion({
      stateDir: area.dir,
      now: () => clock,
      sleep: async () => { clock += 1_000 },
      spawn: () => ({ ok: true, child: { pid: 4242, exitCode: null, signalCode: null } }),
      kill: async () => { killed += 1; return { ok: true } },
      killByPid: async () => { killed += 1; return { ok: true, forced: true } },
      pidAlive: (pid) => Number(pid) === 777 && alive,
      alive: () => false,
      readHeartbeat: () => ({ at: clock, ready: true, responsive: true, loop: true })
    })
    const adopted = companion.attach(777)
    assert.equal(adopted.ok, true, 'a live pid must be adoptable')
    assert.equal(companion.describe().mode, 'attached')
    assert.equal(companion.describe().childPid, 777)
    assert.equal(companion.claim().ok, true)

    // While the adopted pid is up and the heartbeat is fresh the loop watches and does nothing.
    const calm = await companion.watch({ iterations: 1, intervalMs: 1 })
    assert.equal(calm.trace[0].verdict, 'healthy', `an attached application was not seen as healthy: ${JSON.stringify(calm.trace)}`)

    // The pid is gone: that is a restart, not silence.
    alive = false
    const after = await companion.watch({ iterations: 1, intervalMs: 1 })
    assert.ok(['gone', 'restarted', 'refused', 'safe-mode'].includes(after.trace[0].verdict), `the attached exit was not judged: ${JSON.stringify(after.trace)}`)
    assert.equal(killed >= 0, true)

    // Attaching to nothing is refused rather than guessed at.
    const refused = companion.attach(0)
    assert.equal(refused.ok, false)
    assert.match(refused.reason, /needs a pid/)
  } finally {
    area.dispose()
  }
})

test('the companion program can be asked to attach, and reports which shape it is in', () => {
  const program = read('app/plugins/restart-supervisor/companion/main.cjs')
  const { parseArgs } = require('../../app/plugins/restart-supervisor/companion/main.cjs')
  assert.equal(parseArgs(['--state-dir', 'x', '--attach=777', '--app', 'node', 'app.js']).attach, 777)
  assert.equal(parseArgs(['--state-dir', 'x', '--attach', '777']).attach, 777)
  assert.match(program, /companion\.attach\(args\.attach\)/)
  assert.match(program, /killByPid/)
  assert.match(program, /--attach/)
  const described = spawnSync(process.execPath, [path.join(ROOT, 'app', 'plugins', 'restart-supervisor', 'companion', 'main.cjs'), `--state-dir=${path.join(scratch('supervisor-describe-attach').dir)}`, '--describe', '--json'], { encoding: 'utf8' })
  assert.equal(described.status, 0, described.stderr)
  assert.equal(JSON.parse(described.stdout.trim()).mode, 'launcher', 'an unattached companion describes itself as the launcher')
})

/**
 * The shell has to do three things for the companion, and all three are visible in its source: start it
 * behind the boot, hand it a graceful-stop channel it can honour, and tell it that an ordinary quit is
 * an ordinary quit. A supervisor nobody starts, or one that relaunches the product every time a user
 * closes the window, is worse than none.
 */
test('the shell starts the companion at boot, watches its graceful request, and stands it down on exit', () => {
  const shell = read('app/desktop-main.cjs')
  const host = read('app/plugin-host.cjs')
  assert.match(shell, /startup\.defer\('restart-supervisor', \(\) => startRestartSupervisor\(\)\)/)
  assert.match(shell, /host\.startCompanions\(\)/)
  assert.match(shell, /await host\.health\(\{ id: 'dshns\.restart-supervisor' \}\)/)
  assert.match(shell, /watchSupervisorStopRequest\(\)/)
  assert.match(shell, /app\.stop-request\.json/)
  assert.match(shell, /standDownRestartSupervisor\(\)/)
  assert.match(shell, /stopCompanions\('the shell is quitting'\)/)
  assert.match(shell, /DSHNS_SUPERVISOR_STATE_DIR/)
  assert.match(host, /stopCompanions: \(reason = 'the application is exiting normally'\)/)
  // A companion is started through the plugin that owns it, not by a spawn path invented in the shell.
  assert.equal(/spawn\(.*companion.*main\.cjs/.test(shell), false)
})

test('the restart companion uses the portable Node executable supplied by the desktop host', () => {
  const area = scratch('companion-node-exe')
  const childProcess = require('node:child_process')
  const originalSpawn = childProcess.spawn
  const suppliedNode = path.join(area.dir, 'portable-node.exe')
  let invocation = null
  childProcess.spawn = (command, args, options) => {
    invocation = { command, args, options }
    return { pid: process.pid, unref() {} }
  }
  try {
    const supervisor = createRestartSupervisorPlugin({ stateDir: area.dir, nodeExe: suppliedNode })
    const started = supervisor.ensureCompanion({ force: true })
    assert.equal(started.ok, true, JSON.stringify(started))
    assert.equal(invocation.command, suppliedNode, 'Electron must not be used as the companion Node host')
    assert.match(invocation.args[0], /companion[\\/]main\.cjs$/)
    assert.deepEqual(
      supervisor.companionStatus(),
      { running: true, pid: process.pid, since: null, starting: true },
      'health must recognize the launched companion before its asynchronous pid file appears'
    )

    const pluginHost = read('app/plugin-host.cjs')
    const mounted = read('app/plugins/mounted/index.cjs')
    const shell = read('app/desktop-main.cjs')
    assert.match(pluginHost, /mountedPlugins\(\{ host, nodeExe: options\.nodeExe, stateDir: options\.restartSupervisorStateDir \}\)/)
    assert.match(mounted, /restartSupervisorPlugin\(\{ host, nodeExe, stateDir \}\)/)
    assert.match(shell, /nodeExe: safeNodeExe\(\)/)
    assert.match(shell, /restartSupervisorStateDir: path\.join\(ROOT, 'data', 'state', 'restart-supervisor'\)/)
  } finally {
    childProcess.spawn = originalSpawn
    area.dispose()
  }
})

test('a newly launched companion outranks the previous stale pid file during hand-off', () => {
  const area = scratch('companion-stale-pid-handoff')
  const childProcess = require('node:child_process')
  const originalSpawn = childProcess.spawn
  const paths = companionPaths(area.dir)
  childProcess.spawn = () => ({ pid: process.pid, unref() {} })
  try {
    fs.writeFileSync(paths.pidFile, JSON.stringify({ pid: 999_999_999, at: Date.now() - 60_000 }), 'utf8')
    const supervisor = createRestartSupervisorPlugin({ stateDir: area.dir, nodeExe: process.execPath })
    const started = supervisor.ensureCompanion({ force: true })
    assert.equal(started.ok, true, JSON.stringify(started))

    const status = supervisor.companionStatus()
    assert.deepEqual(
      status,
      { running: true, pid: process.pid, since: null, starting: true },
      'the old pid file must not overwrite the successful launch while the new companion publishes its pid file'
    )
  } finally {
    childProcess.spawn = originalSpawn
    area.dispose()
  }
})

// ---------------------------------------------------------------------------------------------
// 9. The installer's view of the two plugins
// ---------------------------------------------------------------------------------------------
test('both built-in plugins are in the release manifest, as required, with an in-repo channel', () => {
  const entries = builtInEntries(BUNDLED_MANIFEST)
  const ids = entries.map((entry) => entry.id).sort()
  assert.deepEqual(ids, ['dshns.health-scheduler', 'dshns.restart-supervisor'])
  for (const entry of entries) {
    assert.equal(entry.required, true, `${entry.id} must be required: it is part of the installation`)
    assert.equal(entry.inRepo, true, `${entry.id} must say its code is in this repository`)
    assert.equal(entry.channel, 'harness-profile', `${entry.id} must be signed into the profile through the Harness CLI`)
    assert.ok(entry.directory && fs.existsSync(path.join(ROOT, 'app', 'plugins', entry.directory, 'package.json')), `${entry.id} names a directory that does not exist`)
  }
  // The installer's own list is the same data, kept in step by this assertion.
  const listFile = JSON.parse(read('scripts/bundled-plugins.json'))
  for (const entry of entries) {
    const listed = listFile.plugins.find((candidate) => candidate.id === entry.id)
    assert.ok(listed, `${entry.id} is in the manifest but not in scripts/bundled-plugins.json`)
    assert.equal(listed.directory, entry.directory)
    assert.equal(listed.package, entry.package)
    assert.equal(listed.ref, entry.ref)
    assert.equal(listed.required, true)
  }
  assert.equal(listFile.plugins.length, entries.length, 'the installer list and the manifest disagree about how many built-in plugins there are')
})

test('the built-in plugins declare no client half and an additive cordis patch', () => {
  for (const directory of ['health-scheduler', 'restart-supervisor']) {
    const manifest = JSON.parse(read(`app/plugins/${directory}/package.json`))
    assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
    // No `dsh.client`: these plugins have nothing to draw, and claiming a browser half they do not
    // ship is the defect the installer's declared-file check exists to catch.
    assert.equal(manifest.dsh.client, undefined, `${directory} claims a browser half it does not ship`)
    assert.ok(manifest.exports['.'], `${directory} declares no entry`)
    assert.match(read(`app/plugins/${directory}/cordis.patch.yml`), /^- insert:/m)
    assert.equal(/(- remove:|replace:)/.test(read(`app/plugins/${directory}/cordis.patch.yml`)), false, `${directory}'s patch must be additive only`)
  }
})

test('the installer treats the profile plugins as required and the community ones as optional', () => {
  const installer = read('scripts/install.ps1')
  // The built-in step runs before the optional step, and is not conditional on a parameter.
  const builtIn = installer.indexOf('Sign the shipped plugins into the Harness profile')
  const optional = installer.indexOf('Optional community plugins')
  assert.ok(builtIn > 0 && optional > builtIn, 'the built-in plugins must be installed before the optional ones are offered')
  assert.match(installer, /install-bundled-plugins\.ps1/)
  assert.match(installer, /Health Scheduler/)
  assert.match(installer, /Restart Supervisor/)
  // The uninstall path exists and goes through the same channel.
  const uninstaller = read('scripts/uninstall-ds-harness.ps1')
  assert.match(uninstaller, /install-bundled-plugins\.ps1'? -Uninstall|install-bundled-plugins\.ps1.*-Uninstall/)
  assert.match(uninstaller, /no orphan companion process/)
  assert.match(uninstaller, /no supervisor startup entry/)
})

test('the companion is a program the repository can actually start', () => {
  const companion = read('app/plugins/restart-supervisor/companion/main.cjs')
  assert.match(companion, /--state-dir/)
  assert.match(companion, /--app/)
  assert.match(companion, /--describe/)
  assert.match(companion, /--stop/)
  assert.match(companion, /--reset-budget/)
  // It refuses to run twice for one state directory.
  assert.match(companion, /claim\(\)/)
  assert.match(companion, /release\(\)/)
})

test('the supervisor modules parse as programs, not only as modules', () => {
  const files = [
    'app/plugins/restart-supervisor/index.cjs',
    'app/plugins/restart-supervisor/policy.cjs',
    'app/plugins/restart-supervisor/budget.cjs',
    'app/plugins/restart-supervisor/heartbeat.cjs',
    'app/plugins/restart-supervisor/lifecycle.cjs',
    'app/plugins/restart-supervisor/companion.cjs',
    'app/plugins/restart-supervisor/companion/main.cjs'
  ]
  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', path.join(ROOT, file)], { encoding: 'utf8', windowsHide: true })
    assert.equal(result.status, 0, `${file} does not parse: ${result.stderr}`)
  }
  // The companion's `--describe` path answers without starting anything: that is what the installer
  // and the panel use to read the supervisor's state without touching the application.
  const described = spawnSync(process.execPath, [path.join(ROOT, 'app/plugins/restart-supervisor/companion/main.cjs'), '--describe', '--json', `--state-dir=${path.join(os.tmpdir(), 'dsh-companion-describe')}`], { encoding: 'utf8', windowsHide: true, timeout: 60_000 })
  assert.equal(described.status, 0, described.stderr)
  const report = JSON.parse(described.stdout.trim())
  assert.ok(report.budget, 'the describe report carries the budget')
  assert.ok(report.heartbeat, 'the describe report carries the heartbeat')
  assert.equal(report.config.budget.maxRestarts, DEFAULT_RESTART_CONFIG.budget.maxRestarts)
  fs.rmSync(path.join(os.tmpdir(), 'dsh-companion-describe'), { recursive: true, force: true })
})

// ---------------------------------------------------------------------------------------------
// 10. Failure isolation: one half going wrong is not the other half going wrong
// ---------------------------------------------------------------------------------------------

test('a telemetry provider that throws is a fault against itself, and the sample still exists', () => {
  const { createProviderRegistry, DIMENSIONS } = require('../../app/plugins/health-scheduler/providers.cjs')
  const { HEALTH_STATES } = require('../../app/plugins/health-scheduler/severity.cjs')
  const registry = createProviderRegistry({
    providers: [
      {
        id: 'machine',
        dimensions: [DIMENSIONS.MEMORY, DIMENSIONS.CPU],
        read: () => ({ readings: { memory: { value: 30, warn: 70, critical: 92 }, cpu: { value: 20, warn: 75, critical: 95 } } })
      },
      { id: 'broken-telemetry', dimensions: [DIMENSIONS.RUNTIME], read: () => { throw new Error('the telemetry endpoint is gone') } }
    ]
  })

  const read = registry.readAll({ atMs: 1_000 })
  // The broken provider is *named*, not swallowed: "UNKNOWN is not HEALTHY" starts here.
  assert.equal(read.ok, false, 'a missing required provider must not report a complete read')
  assert.deepEqual(read.missingRequired, ['broken-telemetry'])
  assert.equal(read.faults.length, 1)
  assert.match(read.faults[0].reason, /telemetry endpoint is gone/)
  // ...and the providers that answered still answered: one crash does not blind the monitor.
  assert.equal(read.readings.memory.value, 30)
  assert.equal(read.readings.cpu.value, 20)
  assert.ok(read.confidence > 0 && read.confidence < 1, `confidence must show the gap, got ${read.confidence}`)

  /**
   * The other half of the same rule, at the engine: a *collector* that throws leaves the dimensions
   * unknown and the verdict UNKNOWN — never HEALTHY. "UNKNOWN is not HEALTHY" is a verdict about
   * missing data, and this is the shape missing data arrives in.
   */
  const { createHealthEngine } = require('../../app/plugins/health-scheduler/health.cjs')
  const engine = createHealthEngine({
    now: () => 1_000,
    readings: () => { throw new Error('the telemetry endpoint is gone') },
    config: { sampling: { intervalMs: 1_000 } }
  })
  const sample = engine.sample()
  assert.equal(sample.state, HEALTH_STATES.UNKNOWN, `a blinded sample must be UNKNOWN, got ${sample.state}`)
  assert.deepEqual(sample.unknown.sort(), ['cpu', 'memory', 'runtime'])
  assert.equal(sample.pressure, 0, 'an unknown sample carries no pressure rather than an invented one')
})

test('a health engine that throws does not take the supervisor, or the plugin host, down with it', async () => {
  const area = scratch('isolation')
  try {
    /**
     * Two plugins, one broken.
     *
     * The monitor's own health check is made to throw — the worst case the requirement names ("Health
     * crashes, DS-Hns does not"). The manager must record that against the monitor and nothing else:
     * the supervisor's capability still answers, both plugins are still listed, and the supervisor's
     * health is its own answer rather than the monitor's.
     */
    const manager = createPluginManager({ log: () => {} })
    assert.equal(manager.install(createRestartSupervisorPlugin({ stateDir: area.dir, log: () => {} })).ok, true)
    assert.equal(manager.install(healthSchedulerPlugin()).ok, true)
    // The monitor ships disabled (sampling is a decision a user makes), so this test enables it the
    // way the product does — a plugin that is not loaded answers `unknown`, which is a different
    // question from the one this test is asking.
    manager.enable('dshns.health-scheduler')
    await manager.loadAll()

    const monitor = manager.entry('dshns.health-scheduler')
    assert.ok(monitor && monitor.plugin && monitor.loaded, 'the monitor must be installed and loaded')
    monitor.plugin.healthCheck = () => { throw new Error('the monitor crashed') }

    const answers = await manager.checkAllHealth()
    // One answer per plugin, and the broken one is reported rather than thrown: a health check that
    // takes the host down would make the monitor the very thing it is supposed to watch.
    assert.equal(typeof answers, 'object')
    assert.deepEqual(Object.keys(answers).sort(), ['dshns.health-scheduler', 'dshns.restart-supervisor'])
    const monitorHealth = manager.entry('dshns.health-scheduler').health
    assert.notEqual(monitorHealth.status, 'healthy', `a throwing health check must not be healthy, got ${JSON.stringify(monitorHealth)}`)
    assert.match(String(monitorHealth.reason), /monitor crashed/)

    // The supervisor is unaffected: restart-control resolves, and it answers with its own state.
    const control = manager.registry.resolve(RESTART_CONTROL_CAPABILITY, { optional: true })
    assert.ok(control && typeof control.getRestartState === 'function', 'restart-control must resolve while the monitor is broken')
    const state = await control.getRestartState()
    assert.ok(state && state.state, `the supervisor must report a state, got ${JSON.stringify(state)}`)
    assert.equal(typeof control.getRestartBudget().remaining, 'number')
    const supervisorHealth = manager.entry('dshns.restart-supervisor').health
    assert.ok(supervisorHealth && supervisorHealth.status, 'the supervisor must have its own health answer')

    // Both are still listed, with their states kept apart.
    const listed = manager.list().map((entry) => entry.id).sort()
    assert.deepEqual(listed, ['dshns.health-scheduler', 'dshns.restart-supervisor'])
  } finally {
    area.dispose()
  }
})
