'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  PERFORMANCE_STATES,
  DEFAULT_CPU_PERCENT_PER_WORKER,
  limitSet,
  ResourceMonitor,
  ResourceScheduler
} = require('../../app/sub-worker/resources.cjs')
const {
  defaultResourceConfig,
  mergeLayer,
  finalizeResourceConfig,
  STORAGE_IO_LIMIT
} = require('../../app/sub-worker/resource-config.cjs')

/**
 * Resource Monitor and Resource Scheduler (plan §3.2, §5, §7, §8, §9, §10, §11,
 * §12, §16, §28, §29, §31, §35, §40, §43, §44).
 *
 * The scheduler is driven ONLY through injected samples
 * (`monitor.setInjection(...)`) and a fake clock, so every decision in this file
 * is deterministic and independent of the machine running the suite.
 */

const CREATED_ROOTS = []

test.after(() => {
  for (const root of CREATED_ROOTS) {
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {}
  }
})

function scratch(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-multi-resources-${name}-`))
  CREATED_ROOTS.push(root)
  return root
}

/** One scratch root for the whole file: the injected tests never touch it. */
const ROOT = scratch('shared')
const ABSENT_ROOT = path.join(os.tmpdir(), `dsh-multi-resources-absent-${process.pid}`)

/** A fake clock, started far away from the epoch so timestamps are readable. */
const CLOCK_ORIGIN = 1_700_000_000_000

/** The hardware ceiling a §26 "High" installation reports for this scenario. */
function hardwareProfile(overrides = {}) {
  return {
    max_recommended_workers: 6,
    physical_cpu_cores: 8,
    usable_ram_gb: 20,
    ceilings: { cpu: 4, ram: 8, io: 6, tier: 6 },
    tier: { name: 'high', label: 'High' },
    ...overrides
  }
}

/** A resolved configuration with the documented defaults plus one override. */
function configWith(layer = {}) {
  return finalizeResourceConfig(mergeLayer(defaultResourceConfig(), layer))
}

/**
 * A healthy machine: 8 physical cores, 32 GB with 24 GB free, a light CPU, a
 * fast NVMe disk and no GPU worker slot.
 */
function healthySample(overrides = {}) {
  return {
    cpu: { available: true, usage_percent: 10, logical_cores: 16, current_frequency_mhz: 3000, max_frequency_mhz: 3600 },
    memory: { available: true, total_gb: 32, available_gb: 24, used_percent: 25 },
    disk: { available: true, free_gb: 500, free_percent: 50, storage_class: 'nvme', latency: { available: true, write_ms: 2 } },
    gpu: { available: false, vram_total_gb: 0, gpus: [] },
    power: { available: false, on_battery: false },
    temperature: { available: false },
    userActivity: { available: true, interactive: false },
    degraded: [],
    ...overrides
  }
}

/** Monitor + scheduler on a fake clock and one injected sample. */
function rig({ sample = healthySample(), config = configWith(), hardware = hardwareProfile(), learnedProfiles = null } = {}) {
  const clock = { now: CLOCK_ORIGIN }
  const injection = { value: sample }
  const monitor = new ResourceMonitor({ root: ROOT, config, now: () => clock.now })
  assert.equal(monitor.setInjection(() => injection.value), true, 'the injection hook must be active')
  const scheduler = new ResourceScheduler({ config, hardwareProfile: hardware, monitor, now: () => clock.now, learnedProfiles })
  return {
    monitor,
    scheduler,
    /** Advance the fake clock, never the real one. */
    advance: (ms) => { clock.now += ms },
    now: () => clock.now,
    setSample: (next) => { injection.value = next }
  }
}

test('the documented performance states are exported unchanged', () => {
  assert.deepEqual([...PERFORMANCE_STATES], ['NORMAL', 'BOOST', 'THROTTLED', 'CRITICAL', 'SAFE_MODE'])
  assert.equal(DEFAULT_CPU_PERCENT_PER_WORKER, 100 / 16, 'the documented per-host placeholder')
})

test('§43/§44: the limit set is min-composed and names its binding dimension', () => {
  const { scheduler } = rig()
  // cpuWeight 1 isolates the min-composition from the §6 role weight, which
  // decide() derives from the roles it is given (item 7).
  const evaluation = scheduler.evaluate({ singleWorkerRoles: ['build'], cpuWeight: 1 })

  assert.deepEqual(evaluation.limits, { cpu: 5, ram: 8, io: 6, thermal: 99, config: 6, effective: 5, binding: ['cpu'] })
  assert.equal(
    evaluation.limits.effective,
    Math.min(evaluation.limits.cpu, evaluation.limits.ram, evaluation.limits.io, evaluation.limits.thermal, evaluation.limits.config)
  )
  assert.equal(evaluation.effectiveLimit, evaluation.limits.effective)
  assert.deepEqual(evaluation.bindingLimit, evaluation.limits.binding)
  assert.deepEqual(scheduler.describe().bindingLimit, ['cpu'])

  // Every dimension that ties for the minimum is named, not just the first one.
  const tied = rig({
    config: configWith({ workers: { softMax: 3 } }),
    sample: healthySample({ disk: { available: true, free_percent: 50, storage_class: 'sata_ssd', latency: { available: true, write_ms: 2 } } })
  })
  const tiedEvaluation = tied.scheduler.evaluate({ singleWorkerRoles: ['build'], cpuWeight: 1 })
  assert.deepEqual(tiedEvaluation.limits, { cpu: 5, ram: 8, io: 3, thermal: 99, config: 3, effective: 3, binding: ['io', 'config'] })
})

test('limitSet itself keeps its arithmetic and never invents a dimension', () => {
  assert.equal(limitSet({ cpu: 4, ram: 8, io: 6 }).effective, 4)
  assert.deepEqual(limitSet({ cpu: 4, ram: 8, io: 6 }).binding, ['cpu'])
  assert.deepEqual(limitSet({ cpu: 4, ram: 4, io: 6, thermal: 4 }).binding, ['cpu', 'ram', 'thermal'])
  // A non-finite dimension cannot become the minimum.
  assert.deepEqual(limitSet({ cpu: 4, ram: 'x', io: 4, thermal: null }).binding, ['cpu', 'io'])
  assert.deepEqual(limitSet({}).binding, [])
  assert.equal(limitSet({}).effective, 0)
  assert.deepEqual(limitSet({ cpu: -1, ram: 2 }).binding, ['cpu'], 'a negative dimension is still arithmetic')
})

test('§5/§44: the RAM limit uses the reserve, and the reserve is honoured', () => {
  const { scheduler } = rig()
  const evaluation = scheduler.evaluate()
  const config = configWith()

  assert.equal(evaluation.ramPerWorkerGb, 2.44, 'the heaviest runnable role is the conservative estimate')
  assert.equal(scheduler.ramPerWorkerGb(['build']), 2.44, '2500 MB / 1024')
  assert.equal(evaluation.usableRamGb, 20, '24 GB available minus the 4 GB reserve')
  assert.equal(evaluation.usableRamGb, 24 - config.resources.ramReserveMinGb)
  assert.equal(evaluation.limits.ram, Math.floor(evaluation.usableRamGb / evaluation.ramPerWorkerGb))
  assert.equal(evaluation.limits.ram, 8)

  // A larger configured reserve removes workers one by one.
  const reserved = rig({ config: configWith({ resources: { ram_reserve_min_gb: 8 } }) }).scheduler.evaluate()
  assert.equal(reserved.usableRamGb, 16)
  assert.equal(reserved.limits.ram, 6)

  // A lighter role allows more of them.
  const light = rig().scheduler.evaluate({ singleWorkerRoles: ['generic'] })
  assert.equal(light.ramPerWorkerGb, 1.17)
  assert.equal(light.limits.ram, 17)

  // A learned profile from plan §40 replaces the seed for the decision itself.
  const learned = rig({ learnedProfiles: { build: { ramEstimateMb: 4000, cpuWeight: 2, samples: 20 } } })
  const learnedEvaluation = learned.scheduler.evaluate()
  assert.equal(learnedEvaluation.ramPerWorkerGb, 3.91)
  assert.equal(learnedEvaluation.limits.ram, 5)
})

test('§4/§6/§44: the CPU limit respects cpuReservePercent and the per-worker CPU share', () => {
  const { scheduler } = rig()
  const evaluation = scheduler.evaluate({ singleWorkerRoles: ['code'], cpuWeight: 1 })

  assert.equal(evaluation.cpuPercentPerWorker, 12.5, '100% / 8 physical cores')
  assert.equal(evaluation.cpuBudgetPercent, 80, '100% minus the 20% CPU reserve')
  assert.equal(evaluation.limits.cpu, Math.floor((evaluation.cpuBudgetPercent - evaluation.sample.cpu.usage_percent) / evaluation.cpuPercentPerWorker))
  assert.equal(evaluation.limits.cpu, 5)

  // A bigger reserve leaves less room for workers.
  const reserved = rig({ config: configWith({ resources: { cpu_reserve_percent: 50 } }) }).scheduler.evaluate({ singleWorkerRoles: ['code'], cpuWeight: 1 })
  assert.equal(reserved.cpuBudgetPercent, 50)
  assert.equal(reserved.limits.cpu, 3)

  // A heavier worker role costs proportionally more CPU (§6).
  const heavy = rig().scheduler.evaluate({ singleWorkerRoles: ['build'], cpuWeight: 3 })
  assert.equal(heavy.cpuPercentPerWorker, 37.5)
  assert.equal(heavy.limits.cpu, 1)

  // §6/item 7: decide() derives the weight from the roles it is given, so the
  // default `build` role (weight 3) is three times as expensive as `code`.
  const weighted = rig()
  assert.equal(weighted.scheduler.cpuWeightFor(['build']), 3)
  assert.equal(weighted.scheduler.cpuWeightFor(['code']), 1)
  assert.equal(weighted.scheduler.cpuWeightFor(['code', 'build']), 3, 'the heaviest role wins')
  assert.equal(weighted.scheduler.cpuWeightFor(['explorer']), 1)
  assert.equal(weighted.scheduler.cpuWeightFor([]), 1, 'no role means the light default')

  const built = weighted.scheduler.decide({ poolSize: 1, busyWorkers: 0, idleWorkers: 1, runnableTasks: 10 })
  assert.equal(built.evaluation.cpuPercentPerWorker, 37.5, 'the default build role is budgeted at weight 3')
  assert.equal(built.evaluation.limits.cpu, 1)
  const coded = weighted.scheduler.decide({ poolSize: 1, busyWorkers: 0, idleWorkers: 1, runnableTasks: 10, roles: ['code'] })
  assert.equal(coded.evaluation.cpuPercentPerWorker, 12.5, 'an explicitly light role stays at weight 1')
  assert.equal(coded.evaluation.limits.cpu, 5)

  // A host that is already busy can never gain a worker.
  const light = { singleWorkerRoles: ['code'], cpuWeight: 1 }
  const busy = rig({ sample: healthySample({ cpu: { available: true, usage_percent: 85 } }) }).scheduler.evaluate(light)
  assert.equal(busy.limits.cpu, 0)
  const saturated = rig({ sample: healthySample({ cpu: { available: true, usage_percent: 120 } }) }).scheduler.evaluate(light)
  assert.equal(saturated.limits.cpu, 0, 'a nonsense utilisation never becomes a negative limit')
})

test('§8: the I/O limit follows the reported storage class', () => {
  const byClass = { nvme: 6, sata_ssd: 3, hdd: 1 }
  for (const [storage, expected] of Object.entries(byClass)) {
    const { scheduler } = rig({
      sample: healthySample({ disk: { available: true, free_percent: 50, storage_class: storage, latency: { available: true, write_ms: 2 } } })
    })
    const evaluation = scheduler.evaluate()
    assert.equal(evaluation.storageClass, storage)
    assert.equal(evaluation.limits.io, expected, `${storage} allows ${expected} parallel I/O workers`)
    assert.equal(evaluation.limits.io, STORAGE_IO_LIMIT[storage])
  }

  // An unknown disk class uses the documented assumption instead of guessing.
  const assumed = rig({
    sample: healthySample({ disk: { available: true, free_percent: 50, storage_class: 'unknown', latency: { available: false } } })
  }).scheduler.evaluate()
  assert.equal(assumed.storageClass, 'sata_ssd')
  assert.equal(assumed.limits.io, STORAGE_IO_LIMIT.sata_ssd)

  const assumedHdd = rig({
    config: configWith({ storage: { assume_when_unknown: 'hdd' } }),
    sample: healthySample({ disk: { available: true, free_percent: 50, storage_class: 'unknown', latency: { available: false } } })
  }).scheduler.evaluate()
  assert.equal(assumedHdd.limits.io, STORAGE_IO_LIMIT.hdd)

  // A saturated disk halves the allowance, and a critical latency pins it to one.
  const slow = rig({
    sample: healthySample({ disk: { available: true, free_percent: 50, storage_class: 'nvme', latency: { available: true, write_ms: 40 } } })
  }).scheduler.evaluate()
  assert.equal(slow.limits.io, 3)
  assert.ok(slow.reasons.some((reason) => /disk latency 40 ms is slow/.test(reason)))
  assert.equal(slow.state, 'BOOST')

  const critical = rig({
    sample: healthySample({ disk: { available: true, free_percent: 50, storage_class: 'nvme', latency: { available: true, write_ms: 70 } } })
  }).scheduler.evaluate()
  assert.equal(critical.limits.io, 1)
  assert.ok(critical.reasons.some((reason) => /disk latency 70 ms is critical/.test(reason)))
  assert.equal(critical.state, 'THROTTLED')

  // Free space below the documented reserve stops parallel I/O entirely, and
  // that is a CRITICAL condition even with an idle CPU (§8, §10).
  const full = rig({
    sample: healthySample({ disk: { available: true, free_percent: 4, storage_class: 'nvme', latency: { available: true, write_ms: 2 } } })
  }).scheduler.evaluate()
  assert.equal(full.limits.io, 0)
  assert.equal(full.state, 'CRITICAL')
  assert.ok(full.criticalConditions.some((condition) => /disk free space below the reserve/.test(condition)))
})

test('§26/§27: the config limit is the resolved soft maximum', () => {
  const auto = rig().scheduler.evaluate()
  assert.equal(auto.limits.config, 6, 'soft_max: auto resolves to the hardware ceiling')
  assert.deepEqual(auto.ceilings, {
    hardwareMax: 6,
    hardMax: 6,
    softMax: 6,
    min: 1,
    batteryApplied: false,
    hardwareCeilings: { cpu: 4, ram: 8, io: 6, tier: 6 },
    tier: { name: 'high', label: 'High' }
  })

  const hard = rig({ config: configWith({ workers: { hardMax: 4 } }) }).scheduler.evaluate()
  assert.equal(hard.ceilings.hardMax, 4)
  assert.equal(hard.limits.config, 4)

  const soft = rig({ config: configWith({ workers: { softMax: 2 } }) }).scheduler.evaluate()
  assert.equal(soft.ceilings.softMax, 2)
  assert.equal(soft.limits.config, 2)
  assert.equal(soft.ceilings.hardMax, 6, 'the hard maximum is untouched by the soft one')

  // A user may not raise the ceiling above what the machine can carry.
  const greedy = rig({ config: configWith({ workers: { softMax: 40, hardMax: 40 } }) }).scheduler.evaluate()
  assert.equal(greedy.ceilings.hardwareMax, 6)
  assert.equal(greedy.ceilings.hardMax, 6)
  assert.equal(greedy.ceilings.softMax, 6)
})

test('§7: the GPU slot is floor(free VRAM / 4 GB) and is not part of the pool', () => {
  const measured = rig({
    sample: healthySample({ gpu: { available: true, vram_total_gb: 16, gpus: [{ name: 'RTX 4070', vram_total_gb: 16, vram_used_gb: 6 }] } })
  })
  const evaluation = measured.scheduler.evaluate()
  assert.equal(measured.scheduler.freeVramGb(evaluation.sample), 8, '10 GB free minus the 20% VRAM reserve')
  assert.equal(evaluation.gpuLimit, 2, 'floor(8 GB / 4 GB per GPU task)')
  assert.equal(Object.prototype.hasOwnProperty.call(evaluation.limits, 'gpu'), false, 'the GPU slot is tracked separately from the worker pool')
  measured.scheduler.gpuWorkers = 1
  assert.equal(measured.scheduler.canStartGpuTask(), true)
  measured.scheduler.gpuWorkers = 2
  assert.equal(measured.scheduler.canStartGpuTask(), false)

  // A declared free-VRAM figure is preferred over the adapter total.
  const declared = rig({ sample: healthySample({ gpu: { available: true, vram_total_gb: 16, vram_free_gb: 10 } }) })
  assert.equal(declared.scheduler.freeVramGb(declared.scheduler.evaluate().sample), 8)

  // The configured VRAM reserve is applied to the free figure too.
  const halfReserve = rig({
    config: configWith({ resources: { gpu_reserve_percent: 50 } }),
    sample: healthySample({ gpu: { available: true, vram_total_gb: 16, vram_free_gb: 12.5 } })
  }).scheduler.evaluate()
  assert.equal(halfReserve.gpuLimit, 1, 'floor(12.5 GB / 2 / 4 GB)')

  // A configured 0 % reserve is a real setting, not "unset" (item 9): all 10 GB count.
  const noReserve = rig({
    config: configWith({ resources: { gpu_reserve_percent: 0 } }),
    sample: healthySample({ gpu: { available: true, vram_total_gb: 16, vram_free_gb: 10 } })
  })
  const noReserveEvaluation = noReserve.scheduler.evaluate()
  assert.equal(noReserve.scheduler.freeVramGb(noReserveEvaluation.sample), 10, 'a 0% reserve keeps the whole 10 GB')
  assert.equal(noReserveEvaluation.gpuLimit, 2, 'floor(10 GB / 4 GB) — not the 20% default')

  // A card too small for one 4 GB task reports why instead of rolling over.
  const small = rig({ sample: healthySample({ gpu: { available: true, vram_total_gb: 4, gpus: [{ vram_total_gb: 4, vram_used_gb: 1 }] } }) }).scheduler.evaluate()
  assert.equal(small.gpuLimit, 0)
  assert.ok(small.reasons.some((reason) => /cannot host a 4 GB GPU task/.test(reason)))

  const none = rig().scheduler.evaluate()
  assert.equal(none.gpuLimit, 0)
  assert.ok(none.reasons.some((reason) => /no measurable VRAM: GPU workers are not scheduled/.test(reason)))
})

test('§10: a healthy machine is NORMAL or BOOST', () => {
  // cpuWeight 1 isolates the state rules from the §6 role weight that decide()
  // derives from the roles (item 7); the default-role consequence is below.
  const light = { singleWorkerRoles: ['build'], cpuWeight: 1 }
  const healthy = rig().scheduler.evaluate(light)
  assert.equal(healthy.state, 'BOOST', 'resources are plentiful and the queue may grow')
  assert.ok(PERFORMANCE_STATES.includes(healthy.state))

  // BOOST requires room for more than one worker; a single-worker machine is NORMAL.
  const single = rig({ sample: healthySample({ memory: { available: true, total_gb: 32, available_gb: 6.44, used_percent: 25 } }) }).scheduler.evaluate(light)
  assert.equal(single.limits.effective, 1)
  assert.equal(single.state, 'NORMAL')

  // With scaling switched off there is nothing to boost.
  const noScaling = rig({ config: configWith({ scaling: { enabled: false } }) }).scheduler.evaluate(light)
  assert.equal(noScaling.state, 'NORMAL')

  // A mid-range machine is NORMAL rather than BOOST.
  const busy = rig({ sample: healthySample({ cpu: { available: true, usage_percent: 75 }, memory: { available: true, total_gb: 32, available_gb: 24, used_percent: 80 } }) }).scheduler.evaluate(light)
  assert.equal(busy.state, 'NORMAL')

  // §6/item 7: the default `build` role costs three times a light worker, so the
  // same healthy host only has room for one worker — which is NORMAL, not BOOST.
  const heavyRole = rig()
  const heavyDecision = heavyRole.scheduler.decide({ poolSize: 1, busyWorkers: 0, idleWorkers: 1, runnableTasks: 10 })
  assert.equal(heavyDecision.evaluation.cpuPercentPerWorker, 37.5)
  assert.equal(heavyDecision.evaluation.limits.effective, 1)
  assert.equal(heavyDecision.state, 'NORMAL')
  assert.equal(heavyDecision.direction, 'hold')
  assert.match(heavyDecision.reason, /at the effective limit/)
})

test('§10: CPU > 85% or RAM > 85% is THROTTLED', () => {
  const cpu = rig({ sample: healthySample({ cpu: { available: true, usage_percent: 88 } }) }).scheduler.evaluate()
  assert.equal(cpu.state, 'THROTTLED')
  assert.equal(cpu.limits.cpu, 0, 'a throttled host may not add a worker')

  const cpuEdge = rig({ sample: healthySample({ cpu: { available: true, usage_percent: 86 } }) }).scheduler.evaluate()
  assert.equal(cpuEdge.state, 'THROTTLED')

  const ram = rig({ sample: healthySample({ memory: { available: true, total_gb: 32, available_gb: 24, used_percent: 88 } }) }).scheduler.evaluate()
  assert.equal(ram.state, 'THROTTLED')

  const ramEdge = rig({ sample: healthySample({ memory: { available: true, total_gb: 32, available_gb: 24, used_percent: 86 } }) }).scheduler.evaluate()
  assert.equal(ramEdge.state, 'THROTTLED')

  // 85% is the documented boundary: just below it the machine stays healthy.
  const below = rig({ sample: healthySample({ cpu: { available: true, usage_percent: 85 }, memory: { available: true, total_gb: 32, available_gb: 24, used_percent: 85 } }) }).scheduler.evaluate()
  assert.equal(below.state, 'NORMAL')
})

test('§10: RAM > 95%, CPU > 96% or a missing sensor is CRITICAL', () => {
  const ram = rig({ sample: healthySample({ memory: { available: true, total_gb: 64, available_gb: 2.56, used_percent: 96 } }) }).scheduler.evaluate()
  assert.equal(ram.state, 'CRITICAL')
  assert.equal(ram.canHostOneWorker, true, 'one worker still fits, so this is not SAFE MODE')
  assert.deepEqual(ram.criticalConditions, ['RAM 96% > 95%'])

  const cpu = rig({ sample: healthySample({ cpu: { available: true, usage_percent: 97 } }) }).scheduler.evaluate()
  assert.equal(cpu.state, 'CRITICAL')
  assert.deepEqual(cpu.criticalConditions, ['CPU 97% > 96%'])

  const hot = rig({ sample: healthySample({ temperature: { available: true, celsius: 91 } }) }).scheduler.evaluate()
  assert.equal(hot.state, 'CRITICAL')
  assert.equal(hot.limits.thermal, 0)
  assert.ok(hot.criticalConditions.some((condition) => /severe thermal throttling/.test(condition)))

  const warm = rig({ sample: healthySample({ temperature: { available: true, celsius: 86 } }) }).scheduler.evaluate()
  assert.equal(warm.limits.thermal, 1)
  assert.equal(warm.state, 'THROTTLED')

  // A warm-but-not-throttling sensor only shrinks the thermal budget.
  const tepid = rig({ sample: healthySample({ temperature: { available: true, celsius: 79 } }) }).scheduler.evaluate()
  assert.equal(tepid.limits.thermal, 2)
  assert.equal(tepid.state, 'BOOST')

  // Without a sensor, only an obvious frequency collapse under load counts (§9).
  const collapsed = rig({
    sample: healthySample({ cpu: { available: true, usage_percent: 90, current_frequency_mhz: 1000, max_frequency_mhz: 3600 } })
  }).scheduler.evaluate()
  assert.equal(collapsed.limits.thermal, 1)
  assert.ok(collapsed.reasons.some((reason) => /suggests thermal throttling/.test(reason)))

  const flat = rig({
    sample: healthySample({ cpu: { available: true, usage_percent: 10, current_frequency_mhz: 1000, max_frequency_mhz: 3600 }, degraded: ['battery state unavailable'] })
  }).scheduler.evaluate()
  assert.equal(flat.limits.thermal, 99, 'a flat frequency signal is not invented into a throttle')
  assert.ok(flat.reasons.some((reason) => /thermal limiting is inactive rather than guessed/.test(reason)))
  assert.deepEqual(flat.degraded, ['battery state unavailable'])
})

test('§10/§35: a breached RAM reserve is THROTTLED with one worker, never SAFE MODE', () => {
  // Available RAM is inside the 4 GB reserve, but one worker still fits.
  const { scheduler } = rig({ sample: healthySample({ memory: { available: true, total_gb: 32, available_gb: 3.5, used_percent: 80 } }) })
  const evaluation = scheduler.evaluate()
  assert.equal(evaluation.canHostOneWorker, true)
  assert.equal(evaluation.reserveBreached, true)
  assert.equal(evaluation.usableRamGb, 0)
  assert.equal(evaluation.limits.ram, 1, 'the reserve is breached: exactly one worker')
  assert.equal(evaluation.limits.effective, 1)
  assert.equal(evaluation.state, 'THROTTLED')
  assert.notEqual(evaluation.state, 'SAFE_MODE')
  assert.notEqual(evaluation.state, 'CRITICAL')
  assert.ok(evaluation.reasons.some((reason) => /inside the 4 GB reserve: one worker only/.test(reason)))

  // The same rule applies when the spare RAM is above the reserve but still
  // below one full build worker.
  const tight = rig({ sample: healthySample({ memory: { available: true, total_gb: 32, available_gb: 6.4, used_percent: 80 } }) }).scheduler.evaluate()
  assert.equal(tight.usableRamGb, 2.4)
  assert.equal(tight.limits.ram, 1)
  assert.equal(tight.state, 'THROTTLED')
  assert.deepEqual(tight.limits.binding, ['ram'])

  // Under pressure the pool holds and then steps down slowly, never to SAFE MODE.
  const first = scheduler.decide({ poolSize: 2, busyWorkers: 0, idleWorkers: 2, runnableTasks: 4 })
  assert.equal(first.direction, 'hold')
  assert.equal(first.desired, 2)
  assert.equal(first.state, 'THROTTLED')
})

test('§35: no room for a single worker is SAFE MODE, and disabling it degrades to CRITICAL', () => {
  const safe = rig({ sample: healthySample({ memory: { available: true, total_gb: 32, available_gb: 1.5, used_percent: 95 } }) })
  const evaluation = safe.scheduler.evaluate()
  assert.equal(evaluation.canHostOneWorker, false)
  assert.equal(evaluation.state, 'SAFE_MODE')
  assert.ok(evaluation.reasons.some((reason) => /SAFE MODE: not enough available RAM for a single worker/.test(reason)))
  assert.ok(evaluation.reasons.some((reason) => /cannot host one 2.44 GB worker/.test(reason)))

  const decision = safe.scheduler.decide({ poolSize: 4, busyWorkers: 2, idleWorkers: 2, runnableTasks: 5 })
  assert.equal(decision.desired, 0, 'SAFE MODE parks the pool and keeps the Supervisor alive')
  assert.equal(decision.direction, 'down')
  assert.equal(decision.step, 4)
  assert.equal(decision.state, 'SAFE_MODE')
  assert.match(decision.reason, /SAFE MODE: waiting for memory to recover/)

  // With the safe mode switch off the machine reports CRITICAL instead, and the
  // emergency scale-down is still immediate.
  const critical = rig({
    config: configWith({ safety: { enable_safe_mode: false } }),
    sample: healthySample({ memory: { available: true, total_gb: 32, available_gb: 1.5, used_percent: 95 } })
  })
  const criticalEvaluation = critical.scheduler.evaluate()
  assert.equal(criticalEvaluation.state, 'CRITICAL')
  assert.equal(criticalEvaluation.hysteresis.emergency, true)
  assert.equal(criticalEvaluation.hysteresis.scaleDownAllowed, true)
  const emergency = critical.scheduler.decide({ poolSize: 4, busyWorkers: 2, idleWorkers: 2, runnableTasks: 5 })
  assert.equal(emergency.direction, 'down')
  assert.equal(emergency.desired, 3, 'one step, immediately, without waiting for the pressure delay')
})

test('§11/§12: scale-up waits for the healthy delay and grows one step at a time', () => {
  const { scheduler, advance } = rig()
  // An explicit light role (item 7): this test is about the hysteresis, not
  // about how expensive the default `build` role is.
  const code = { roles: ['code'] }

  const first = scheduler.decide({ poolSize: 1, busyWorkers: 0, idleWorkers: 1, runnableTasks: 100, ...code })
  assert.equal(first.direction, 'hold')
  assert.equal(first.step, 0)
  assert.equal(first.desired, 1)
  assert.equal(first.state, 'BOOST')
  assert.equal(first.evaluation.hysteresis.scaleUpAllowed, false)
  assert.match(first.reason, /healthy for only 0 s of the required 30 s/)

  advance(20_000)
  const waiting = scheduler.decide({ poolSize: 1, busyWorkers: 0, idleWorkers: 1, runnableTasks: 100, ...code })
  assert.equal(waiting.direction, 'hold')
  assert.match(waiting.reason, /healthy for only 20 s of the required 30 s/)

  advance(10_000)
  const up = scheduler.decide({ poolSize: 1, busyWorkers: 0, idleWorkers: 1, runnableTasks: 100, ...code })
  assert.equal(up.direction, 'up')
  assert.equal(up.step, 1)
  assert.equal(up.desired, 2, 'never a jump to the maximum, even with 100 runnable tasks')
  assert.match(up.reason, /adding 1 worker\(s\) towards 5/)

  // Progressive growth: every decision adds exactly one worker until the
  // effective limit is reached.
  let poolSize = 2
  for (const expected of [3, 4, 5]) {
    const step = scheduler.decide({ poolSize, busyWorkers: 0, idleWorkers: poolSize, runnableTasks: 100, ...code })
    assert.equal(step.direction, 'up')
    assert.equal(step.step, 1)
    assert.equal(step.desired, expected)
    poolSize = step.desired
  }
  const atLimit = scheduler.decide({ poolSize: 5, busyWorkers: 0, idleWorkers: 5, runnableTasks: 100, ...code })
  assert.equal(atLimit.direction, 'hold')
  assert.equal(atLimit.desired, 5)
  assert.match(atLimit.reason, /at the effective limit/)

  // A configured step larger than the per-cycle budget still moves one worker.
  const limited = rig({ config: configWith({ scaling: { scaleUpStep: 4, maxScaleUpPerCycle: 1 } }) })
  limited.scheduler.evaluate()
  limited.advance(30_000)
  const capped = limited.scheduler.decide({ poolSize: 1, busyWorkers: 0, idleWorkers: 1, runnableTasks: 100, ...code })
  assert.equal(capped.step, 1)
  assert.equal(capped.desired, 2)
})

test('§12: scale-down waits for the pressure delay, then retires one idle worker at a time', () => {
  const { scheduler, advance } = rig({ sample: healthySample({ cpu: { available: true, usage_percent: 90 } }) })
  scheduler.evaluate()
  advance(30_000)

  // The host is under resource pressure (CPU 90%), so the documented pressure
  // delay applies — not the shorter idle-surplus grace (item 10).
  const hold = scheduler.decide({ poolSize: 4, busyWorkers: 1, idleWorkers: 3, runnableTasks: 1 })
  assert.equal(hold.direction, 'hold')
  assert.equal(hold.desired, 4)
  assert.equal(hold.state, 'THROTTLED')
  assert.equal(hold.evaluation.hysteresis.scaleDownAllowed, false)
  assert.ok(hold.evaluation.hysteresis.pressureForMs > 0)
  assert.match(hold.reason, /under pressure for only 30 s of the required 60 s/)

  advance(30_000)
  const down = scheduler.decide({ poolSize: 4, busyWorkers: 1, idleWorkers: 3, runnableTasks: 1 })
  assert.equal(down.direction, 'down')
  assert.equal(down.step, 1)
  assert.equal(down.desired, 3)
  assert.equal(down.evaluation.hysteresis.scaleDownAllowed, true)
  assert.match(down.reason, /THROTTLED: resource pressure - retiring 1 idle worker\(s\)/)

  // One step per decision, and never below the busiest count.
  const second = scheduler.decide({ poolSize: 3, busyWorkers: 1, idleWorkers: 2, runnableTasks: 1 })
  assert.equal(second.desired, 2)
  const third = scheduler.decide({ poolSize: 2, busyWorkers: 1, idleWorkers: 1, runnableTasks: 1 })
  assert.equal(third.desired, 1)
  const last = scheduler.decide({ poolSize: 1, busyWorkers: 1, idleWorkers: 0, runnableTasks: 1 })
  assert.equal(last.desired, 1, 'the last worker is the busiest one and stays')
  assert.equal(last.direction, 'hold')
  assert.match(last.reason, /at the effective limit/)
  assert.equal(last.evaluation.ceilings.min, 1, 'the documented Main + 1 worker floor')
  assert.equal(last.desired, Math.max(1, last.evaluation.ceilings.min), 'the pool floor is the busiest worker or the documented minimum')
})

test('§12: a busy worker is never retired, even in an emergency', () => {
  // Pressure from the CPU, pool fully busy.
  const throttled = rig({ sample: healthySample({ cpu: { available: true, usage_percent: 90 } }) })
  throttled.scheduler.evaluate()
  throttled.advance(120_000)
  const busyHold = throttled.scheduler.decide({ poolSize: 3, busyWorkers: 3, idleWorkers: 0, runnableTasks: 0 })
  assert.equal(busyHold.direction, 'hold')
  assert.equal(busyHold.desired, 3)
  assert.match(busyHold.reason, /every worker is busy/)

  // CRITICAL is an emergency, but a running worker is still not retired.
  const critical = rig({ sample: healthySample({ memory: { available: true, total_gb: 64, available_gb: 2.56, used_percent: 96 } }) })
  const evaluation = critical.scheduler.evaluate()
  assert.equal(evaluation.state, 'CRITICAL')
  assert.equal(evaluation.hysteresis.emergency, true)
  const emergencyHold = critical.scheduler.decide({ poolSize: 3, busyWorkers: 3, idleWorkers: 0, runnableTasks: 2 })
  assert.equal(emergencyHold.direction, 'hold')
  assert.equal(emergencyHold.desired, 3)
  assert.match(emergencyHold.reason, /every worker is busy/)
})

test('§12/§35: an emergency scale-down does not wait for the pressure delay', () => {
  const emergency = rig({ sample: healthySample({ memory: { available: true, total_gb: 64, available_gb: 2.56, used_percent: 96 } }) })
  const first = emergency.scheduler.decide({ poolSize: 4, busyWorkers: 1, idleWorkers: 3, runnableTasks: 2 })
  assert.equal(first.state, 'CRITICAL')
  assert.equal(first.direction, 'down')
  assert.equal(first.step, 1)
  assert.equal(first.desired, 3)
  assert.equal(first.evaluation.hysteresis.pressureForMs, 0, 'no delay was accumulated')
  assert.equal(first.evaluation.hysteresis.scaleDownAllowed, true)

  // The disk-free emergency behaves the same way.
  const disk = rig({ sample: healthySample({ disk: { available: true, free_percent: 3, storage_class: 'nvme', latency: { available: true, write_ms: 2 } } }) })
  const diskDown = disk.scheduler.decide({ poolSize: 4, busyWorkers: 1, idleWorkers: 3, runnableTasks: 2 })
  assert.equal(diskDown.state, 'CRITICAL')
  assert.equal(diskDown.direction, 'down')
  assert.equal(diskDown.desired, 3)

  // Turning the immediate emergency scale-down off makes the scheduler wait for
  // the ordinary pressure delay, which is what the switch promises.
  const delayed = rig({
    config: configWith({ safety: { emergency_scale_down_immediate: false } }),
    sample: healthySample({ memory: { available: true, total_gb: 64, available_gb: 2.56, used_percent: 96 } })
  })
  const delayedRig = delayed.scheduler.evaluate()
  assert.equal(delayedRig.state, 'CRITICAL')
  delayed.advance(20_000)
  const held = delayed.scheduler.decide({ poolSize: 4, busyWorkers: 1, idleWorkers: 3, runnableTasks: 2 })
  assert.equal(held.state, 'CRITICAL')
  assert.equal(held.direction, 'hold')
  assert.equal(held.desired, 4)
  assert.equal(held.evaluation.hysteresis.scaleDownAllowed, false)
  assert.match(held.reason, /under pressure for only 20 s of the required 60 s/)
})

test('§16: the desired size never exceeds the runnable work plus the busy workers', () => {
  // The configuration and the hardware both allow ten workers.
  const ten = rig({
    config: configWith({ workers: { softMax: 10, hardMax: 10 } }),
    hardware: hardwareProfile({ max_recommended_workers: 10, physical_cpu_cores: 16, ceilings: { cpu: 9, ram: 18, io: 6, tier: 12 } })
  })
  const evaluation = ten.scheduler.evaluate({ singleWorkerRoles: ['code'], cpuWeight: 1 })
  assert.equal(evaluation.ceilings.hardMax, 10)
  assert.equal(evaluation.limits.config, 10)
  assert.equal(evaluation.ceilings.min, 1)
  // An explicit light role (item 7) keeps this test about the workload cap.
  const code = { roles: ['code'] }

  // Two runnable tasks and no busy worker: the pool may reach two and stop.
  ten.advance(30_000)
  const first = ten.scheduler.decide({ poolSize: 0, busyWorkers: 0, idleWorkers: 0, runnableTasks: 2, ...code })
  assert.equal(first.direction, 'up')
  assert.equal(first.desired, 1, 'growth is still one step per cycle')
  const second = ten.scheduler.decide({ poolSize: 1, busyWorkers: 0, idleWorkers: 1, runnableTasks: 2, ...code })
  assert.equal(second.desired, 2)
  const third = ten.scheduler.decide({ poolSize: 2, busyWorkers: 0, idleWorkers: 2, runnableTasks: 2, ...code })
  assert.equal(third.direction, 'hold')
  assert.equal(third.desired, 2)
  assert.ok(third.desired <= 2, 'two runnable tasks may never grow a pool of two')
  assert.match(third.reason, /at the effective limit/)

  // The bound is `busy + runnable`, so two busy and two queued tasks allow four.
  const withBusy = ten.scheduler.decide({ poolSize: 3, busyWorkers: 2, idleWorkers: 1, runnableTasks: 2, ...code })
  assert.equal(withBusy.direction, 'up')
  assert.equal(withBusy.desired, 4)

  // With no work at all the machine never grows past its documented minimum.
  const idle = ten.scheduler.decide({ poolSize: 0, busyWorkers: 0, idleWorkers: 0, runnableTasks: 0, ...code })
  assert.equal(idle.desired, 1)
  assert.equal(idle.direction, 'up')
  assert.ok(idle.desired <= evaluation.ceilings.min, 'idle hardware is not a reason to start workers')
})

test('§16/§12: an oversized-but-healthy pool shrinks through its own short idle grace', () => {
  const { scheduler, advance } = rig()
  const code = { roles: ['code'] }
  scheduler.evaluate({ singleWorkerRoles: ['code'], cpuWeight: 1 })

  // Five workers for two work items on a perfectly healthy host: this is an idle
  // surplus, not resource pressure, so the short idle grace applies (item 10).
  const first = scheduler.decide({ poolSize: 5, busyWorkers: 0, idleWorkers: 5, runnableTasks: 2, ...code })
  assert.equal(first.state, 'BOOST')
  assert.equal(first.direction, 'hold')
  assert.equal(first.desired, 5)
  assert.equal(first.evaluation.hysteresis.scaleDownAllowed, false, 'no resource pressure is involved')
  assert.equal(first.evaluation.hysteresis.pressureForMs, 0)
  assert.match(first.reason, /oversized for only 0 s of the required 10 s/)

  advance(9_000)
  const early = scheduler.decide({ poolSize: 5, busyWorkers: 0, idleWorkers: 5, runnableTasks: 2, ...code })
  assert.equal(early.direction, 'hold')
  assert.equal(early.desired, 5)
  assert.match(early.reason, /oversized for only 9 s of the required 10 s/)

  advance(1_000)
  const down = scheduler.decide({ poolSize: 5, busyWorkers: 0, idleWorkers: 5, runnableTasks: 2, ...code })
  assert.equal(down.direction, 'down')
  assert.equal(down.step, 1)
  assert.equal(down.desired, 4)
  assert.equal(down.state, 'BOOST')
  // The reason is honest about what is happening: work, not pressure.
  assert.match(down.reason, /idle surplus: 2 work item\(s\) for 5 worker\(s\) - retiring 1 idle worker\(s\)/)

  // One step per decision, down to the target `min(effective, busy + runnable, hardMax)`.
  const second = scheduler.decide({ poolSize: 4, busyWorkers: 0, idleWorkers: 4, runnableTasks: 2, ...code })
  assert.equal(second.direction, 'down')
  assert.equal(second.desired, 3)
  const third = scheduler.decide({ poolSize: 3, busyWorkers: 0, idleWorkers: 3, runnableTasks: 2, ...code })
  assert.equal(third.direction, 'down')
  assert.equal(third.desired, 2)
  assert.equal(third.evaluation.limits.effective, 5, 'the system limit is five here')
  assert.equal(third.desired, 2, 'but only two work items exist')

  const settled = scheduler.decide({ poolSize: 2, busyWorkers: 0, idleWorkers: 2, runnableTasks: 2, ...code })
  assert.equal(settled.direction, 'hold')
  assert.equal(settled.desired, 2)
  assert.match(settled.reason, /at the effective limit/)

  // A surplus that disappears again resets the grace period.
  const recurrence = scheduler.decide({ poolSize: 5, busyWorkers: 0, idleWorkers: 5, runnableTasks: 5, ...code })
  assert.equal(recurrence.direction, 'hold')
  assert.equal(recurrence.desired, 5, 'with work for five workers there is no surplus to retire')
})

test('§35: pressure reduces the pool one step per decision and never below the busiest count', () => {
  const { scheduler, advance } = rig({ sample: healthySample({ cpu: { available: true, usage_percent: 92 } }) })
  scheduler.evaluate()
  advance(60_000)

  let poolSize = 6
  const busyWorkers = 1
  const steps = []
  for (let i = 0; i < 6; i += 1) {
    const decision = scheduler.decide({ poolSize, busyWorkers, idleWorkers: poolSize - busyWorkers, runnableTasks: 1 })
    steps.push(decision)
    assert.ok(decision.desired >= busyWorkers, `the pool may never drop below ${busyWorkers} busy worker(s)`)
    assert.ok(decision.desired <= poolSize, 'the pool never grows while the host is under pressure')
    if (decision.direction === 'down') assert.equal(decision.step, 1)
    poolSize = decision.desired
  }
  assert.deepEqual(steps.filter((decision) => decision.direction === 'down').map((decision) => decision.desired), [5, 4, 3, 2, 1])
  assert.equal(steps.at(-1).desired, 1)
  assert.equal(steps.at(-1).direction, 'hold')
  assert.match(steps.at(-1).reason, /at the effective limit/)

  // §35: SAFE MODE is the only path below one worker.
  const safe = rig({ sample: healthySample({ memory: { available: true, total_gb: 32, available_gb: 1.5, used_percent: 95 } }) })
  const parked = safe.scheduler.decide({ poolSize: 6, busyWorkers: 1, idleWorkers: 5, runnableTasks: 1 })
  assert.equal(parked.desired, 0)
  assert.equal(parked.state, 'SAFE_MODE')
})

test('§35: after the pressure clears the pool grows back one step at a time', () => {
  const { scheduler, advance, setSample } = rig({ sample: healthySample({ cpu: { available: true, usage_percent: 92 } }) })
  // An explicit light role (item 7): the recovery profile is the subject here.
  const code = { roles: ['code'] }
  scheduler.evaluate({ singleWorkerRoles: ['code'], cpuWeight: 1 })
  advance(60_000)
  const shrunk = scheduler.decide({ poolSize: 1, busyWorkers: 1, idleWorkers: 0, runnableTasks: 4, ...code })
  assert.equal(shrunk.state, 'THROTTLED')

  // The pressure disappears: the healthy delay starts again from zero.
  setSample(healthySample())
  const justRecovered = scheduler.decide({ poolSize: 1, busyWorkers: 0, idleWorkers: 1, runnableTasks: 4, ...code })
  assert.equal(justRecovered.state, 'BOOST')
  assert.equal(justRecovered.direction, 'hold')
  assert.match(justRecovered.reason, /healthy for only 0 s of the required 30 s/)

  advance(30_000)
  let poolSize = 1
  for (const expected of [2, 3, 4, 5]) {
    const decision = scheduler.decide({ poolSize, busyWorkers: 0, idleWorkers: poolSize, runnableTasks: 10, ...code })
    assert.equal(decision.direction, 'up')
    assert.equal(decision.step, 1, 'the recovery is progressive, never a jump to the maximum')
    assert.equal(decision.desired, expected)
    poolSize = decision.desired
  }
  const settled = scheduler.decide({ poolSize: 5, busyWorkers: 0, idleWorkers: 5, runnableTasks: 10, ...code })
  assert.equal(settled.direction, 'hold')
  assert.equal(settled.desired, 5)
  assert.match(settled.reason, /at the effective limit/)
})

test('§28: an on-battery sample clamps the soft maximum to the battery budget', () => {
  const battery = rig({ sample: healthySample({ power: { available: true, on_battery: true, percent: 42 } }) })
  const evaluation = battery.scheduler.evaluate()
  assert.equal(evaluation.ceilings.batteryApplied, true)
  assert.equal(evaluation.ceilings.softMax, 2)
  assert.equal(evaluation.limits.config, 2)
  assert.ok(evaluation.reasons.some((reason) => /on battery: soft maximum reduced to 2/.test(reason)))

  // The clamped ceiling really bounds the pool: two workers is the battery
  // maximum, so a pool of two is at its effective limit. The CPU budget is
  // asserted with an explicit light role (item 7), so the battery ceiling is
  // what binds here.
  const code = { roles: ['code'] }
  battery.advance(30_000)
  const atCeiling = battery.scheduler.decide({ poolSize: 2, busyWorkers: 0, idleWorkers: 2, runnableTasks: 10, ...code })
  assert.equal(atCeiling.direction, 'hold')
  assert.equal(atCeiling.desired, 2)
  assert.match(atCeiling.reason, /at the effective limit/)
  assert.equal(atCeiling.evaluation.limits.effective, 2)
  assert.equal(atCeiling.evaluation.limits.config, 2, 'the battery ceiling is the binding config dimension')
  const larger = battery.scheduler.decide({ poolSize: 1, busyWorkers: 0, idleWorkers: 1, runnableTasks: 10, ...code })
  assert.equal(larger.desired, 2, 'the pool never grows past the battery ceiling')

  // A user may configure a different battery budget.
  const configured = rig({
    config: configWith({ battery: { on_battery_soft_max: 4 } }),
    sample: healthySample({ power: { available: true, on_battery: true } })
  }).scheduler.evaluate()
  assert.equal(configured.ceilings.softMax, 4)
  assert.equal(configured.limits.config, 4)

  // Plugged in, the battery clamp is not applied at all.
  const mains = rig({ sample: healthySample({ power: { available: true, on_battery: false } }) }).scheduler.evaluate()
  assert.equal(mains.ceilings.batteryApplied, false)
  assert.equal(mains.ceilings.softMax, 6)
  assert.equal(mains.reasons.some((reason) => /on battery/.test(reason)), false)

  // An unknown battery state is treated as mains power, and a budget that is not
  // stricter than the current ceiling changes nothing.
  const unknown = rig({ sample: healthySample({ power: { available: false } }) }).scheduler.evaluate()
  assert.equal(unknown.ceilings.batteryApplied, false)
  const smallHost = rig({ hardware: hardwareProfile({ max_recommended_workers: 2 }), sample: healthySample({ power: { available: true, on_battery: true } }) }).scheduler.evaluate()
  assert.equal(smallHost.ceilings.softMax, 2)
  assert.equal(smallHost.ceilings.batteryApplied, false, 'the clamp only ever lowers the ceiling')
})

test('§29: foreground user activity reduces the CPU budget', () => {
  const interactive = rig({ sample: healthySample({ userActivity: { available: true, interactive: true } }) })
  const evaluation = interactive.scheduler.evaluate()
  assert.equal(evaluation.cpuBudgetPercent, 50, 'the documented HNS CPU budget while the user is active')
  assert.equal(evaluation.cpuPercentPerWorker, 12.5)
  assert.equal(evaluation.limits.cpu, Math.floor((50 - 10) / 12.5))
  assert.equal(evaluation.limits.cpu, 3)
  assert.ok(evaluation.reasons.some((reason) => /foreground user activity: CPU budget reduced to 50%/.test(reason)))

  // The configured budget is the one that is used.
  const tight = rig({
    config: configWith({ user_activity: { active_cpu_budget_percent: 30 } }),
    sample: healthySample({ userActivity: { available: true, interactive: true } })
  }).scheduler.evaluate()
  assert.equal(tight.cpuBudgetPercent, 30)
  assert.equal(tight.limits.cpu, 1)

  // An idle machine keeps the full documented budget.
  const idle = rig().scheduler.evaluate()
  assert.equal(idle.cpuBudgetPercent, 100 - configWith().resources.cpuReservePercent)
  assert.equal(idle.reasons.some((reason) => /user activity/.test(reason)), false)

  // §29/item 8: the idle budget is a real cap on the non-interactive budget, so
  // lowering it lowers the CPU limit without waiting for the user to be busy.
  const thrifty = rig({ config: configWith({ user_activity: { idle_cpu_budget_percent: 60 } }) }).scheduler.evaluate()
  assert.equal(thrifty.cpuBudgetPercent, 60)
  assert.equal(thrifty.limits.cpu, Math.floor((60 - 10) / 12.5))
  assert.equal(thrifty.limits.cpu, 4)
  assert.ok(thrifty.limits.cpu < idle.limits.cpu, 'a tighter idle budget must mean fewer workers than the default')

  // The budget is min(100 - cpu_reserve_percent, idle_cpu_budget_percent), so a
  // 0 % CPU reserve does not by itself raise the idle budget above the idle cap
  // (item 9: a configured 0 is honoured, the idle budget still caps it).
  const noReserve = rig({ config: configWith({ resources: { cpu_reserve_percent: 0 } }) }).scheduler.evaluate()
  assert.equal(noReserve.cpuBudgetPercent, 80, 'min(100 - 0, 80)')
  assert.equal(noReserve.limits.cpu, idle.limits.cpu)
  const lifted = rig({ config: configWith({ resources: { cpu_reserve_percent: 0 }, user_activity: { idle_cpu_budget_percent: 95 } }) }).scheduler.evaluate()
  assert.equal(lifted.cpuBudgetPercent, 95, 'a 0 % reserve only counts when the idle budget allows it')
  assert.equal(lifted.limits.cpu, Math.floor((95 - 10) / 12.5))

  // A sample that cannot report activity is not treated as an active user.
  const unknown = rig({ sample: healthySample({ userActivity: { available: false, interactive: false } }) }).scheduler.evaluate()
  assert.equal(unknown.cpuBudgetPercent, 80)
})

test('§31: the external service limit bounds online tasks, not local workers', () => {
  const { scheduler } = rig()
  const evaluation = scheduler.evaluate()
  assert.equal(evaluation.externalLimit, 3, 'the documented apiConcurrencyLimit default')
  assert.equal(evaluation.externalLimit, configWith().externalService.apiConcurrencyLimit)

  scheduler.onlineWorkers = 0
  assert.equal(scheduler.canStartOnlineTask(), true)
  scheduler.onlineWorkers = 2
  assert.equal(scheduler.canStartOnlineTask(), true)
  scheduler.onlineWorkers = 3
  assert.equal(scheduler.canStartOnlineTask(), false)
  scheduler.onlineWorkers = 4
  assert.equal(scheduler.canStartOnlineTask(), false)

  // The configured limit is used instead of the default.
  const five = rig({ config: configWith({ external_service: { api_concurrency_limit: 5 } }) })
  assert.equal(five.scheduler.evaluate().externalLimit, 5)
  five.scheduler.onlineWorkers = 4
  assert.equal(five.scheduler.canStartOnlineTask(), true)
  five.scheduler.onlineWorkers = 5
  assert.equal(five.scheduler.canStartOnlineTask(), false)

  // §31: local workers are bounded by the resource limits, not by the API quota,
  // so the API limit is reported separately from the pooled limit set.
  assert.equal(Object.prototype.hasOwnProperty.call(evaluation.limits, 'external'), false)
  assert.equal(evaluation.limits.effective, 5)
  assert.ok(evaluation.limits.effective > evaluation.externalLimit, 'local workers keep working while the API quota is exhausted')
})

test('the monitor records bounded, ordered samples and never invents values', () => {
  const { monitor, advance } = rig()
  for (let i = 0; i < 250; i += 1) {
    advance(1_000)
    monitor.sample()
  }

  assert.equal(monitor.samples.length, monitor.maxSamples)
  assert.equal(monitor.samples.length, 240, 'the history is bounded so a long-lived shell cannot grow it forever')
  assert.equal(monitor.history().length, 60, 'the default history window')
  assert.equal(monitor.history(5).length, 5)
  assert.equal(monitor.history(0).length, 240, 'a non-positive limit means "everything"')
  assert.equal(monitor.history(-1).length, 240)
  assert.equal(monitor.history().length, 60)

  const window = monitor.history(5)
  assert.deepEqual(window.map((sample) => sample.at), [CLOCK_ORIGIN + 246_000, CLOCK_ORIGIN + 247_000, CLOCK_ORIGIN + 248_000, CLOCK_ORIGIN + 249_000, CLOCK_ORIGIN + 250_000])
  assert.equal(monitor.latest().at, CLOCK_ORIGIN + 250_000, 'latest() is the newest sample')
  const all = monitor.history(0)
  assert.equal(all.every((sample, index) => index === 0 || sample.at >= all[index - 1].at), true, 'samples stay ordered')
  assert.equal(monitor.history(5).at(-1), monitor.latest())

  // The injected sample is normalized, so the scheduler never has to guess.
  const latest = monitor.latest()
  assert.equal(latest.memory.total_gb, 32)
  assert.equal(latest.cpu.usage_percent, 10)
  assert.equal(latest.disk.storage_class, 'nvme')
  assert.deepEqual(latest.power, { available: false, on_battery: false, percent: null })
  assert.deepEqual(latest.temperature, { available: false, celsius: null, source: null })

  // A nonsense injection is still normalized into the documented shape.
  const partial = monitor.inject({ cpu: { usagePercent: 55 }, memory: { totalGb: 8, availableGb: 6, usedPercent: 25 } })
  assert.equal(partial.cpu.usage_percent, 55, 'the camelCase alias is accepted')
  assert.equal(partial.memory.total_gb, 8)
  assert.equal(partial.disk.storage_class, 'unknown')
  assert.equal(partial.gpu.available, false)
})

test('the injection hook can be turned off again and start()/stop() are inert', () => {
  const { monitor, scheduler } = rig()
  monitor.sample()
  assert.equal(monitor.samples.length, 1)
  assert.equal(monitor.setInjection(() => healthySample()), true)
  assert.equal(monitor.setInjection(null), false)
  assert.equal(monitor.injection, null)
  // With the hook off the scheduler falls back to the last recorded sample
  // instead of measuring the host again.
  assert.doesNotThrow(() => scheduler.evaluate())
  assert.equal(scheduler.lastEvaluation.state, 'BOOST')
  assert.equal(monitor.samples.length, 1, 'no new sample was taken')

  const injected = rig()
  assert.equal(injected.monitor.start(), true, 'start samples once immediately')
  assert.equal(injected.monitor.started, true)
  assert.equal(injected.monitor.samples.length, 1, 'the forced first sample is recorded')
  assert.equal(injected.monitor.start(), false, 'starting twice is refused')
  assert.equal(injected.monitor.stop(), undefined)
  assert.equal(injected.monitor.started, false)
  assert.equal(injected.monitor.timer, null)
  assert.equal(injected.monitor.stop(), undefined, 'stopping twice is harmless')
})

test('sample() answers instead of throwing when the platform facts are unavailable', () => {
  const monitor = new ResourceMonitor({
    root: ABSENT_ROOT,
    config: configWith(),
    probe: {
      windowsFacts: () => ({ ok: false, error: 'injected probe failure' }),
      storageClass: () => ({ ok: false, error: 'injected: no Storage module' }),
      nvidiaSmi: () => ({ ok: false, error: 'injected: no nvidia-smi' })
    },
    now: () => CLOCK_ORIGIN
  })

  assert.doesNotThrow(() => monitor.sample())
  assert.doesNotThrow(() => monitor.sample({ force: true }))
  const sample = monitor.latest()
  assert.ok(sample.degraded.includes('windows inventory unavailable (injected probe failure)'), 'the failure is reported, not thrown')
  assert.ok(sample.degraded.includes('storage class unavailable'))
  assert.equal(sample.disk.storage_class, 'unknown')
  assert.equal(sample.disk.latency.available, false, 'an absent root has no measurable latency')
  assert.equal(sample.disk.available, false)
  assert.equal(typeof sample.cpu.usage_percent, 'number')
  assert.equal(Number.isFinite(sample.memory.total_gb), true)
  assert.equal(typeof sample.memory.used_percent, 'number')
  assert.equal(sample.power.on_battery, false)
  assert.equal(sample.temperature.available, false)
})

test('the scheduler exposes its decision inputs for the Controller', () => {
  const { scheduler } = rig()
  const evaluation = scheduler.evaluate()
  const described = scheduler.describe()

  assert.equal(described.state, 'BOOST')
  assert.equal(Number.isFinite(Date.parse(described.stateSince)), true)
  assert.deepEqual(described.limits, evaluation.limits)
  assert.equal(described.effectiveLimit, 5)
  assert.deepEqual(described.bindingLimit, ['cpu'])
  assert.equal(described.usableRamGb, 20)
  assert.equal(described.ramPerWorkerGb, 2.44)
  assert.equal(described.cpuBudgetPercent, 80)
  assert.equal(described.storageClass, 'nvme')
  assert.equal(described.gpuLimit, 0)
  assert.equal(described.externalLimit, 3)
  assert.equal(described.onlineWorkers, 0)
  assert.equal(described.gpuWorkers, 0)
  assert.deepEqual(described.reasons, evaluation.reasons)
  assert.deepEqual(described.degraded, [])
  assert.equal(described.sample, evaluation.sample)
  assert.equal(described.hysteresis.scaleUpDelayMs, 30_000)
  assert.equal(described.hysteresis.scaleDownDelayMs, 60_000)

  // A state change is recorded once, in order, with its reasons.
  assert.deepEqual(described.transitions.map((entry) => `${entry.from}->${entry.to}`), ['NORMAL->BOOST'])
  assert.ok(described.transitions[0].reasons.length > 0)

  const pressure = rig()
  pressure.scheduler.evaluate()
  pressure.setSample(healthySample({ cpu: { available: true, usage_percent: 92 } }))
  pressure.advance(60_000)
  pressure.scheduler.decide({ poolSize: 2, busyWorkers: 1, idleWorkers: 1, runnableTasks: 2 })
  assert.deepEqual(pressure.scheduler.describe().transitions.map((entry) => `${entry.from}->${entry.to}`), ['NORMAL->BOOST', 'BOOST->THROTTLED'])
  assert.equal(pressure.scheduler.state, 'THROTTLED')
  assert.equal(new Date(pressure.scheduler.stateSince).getTime(), pressure.now(), 'stateSince tracks the transition')

  // describe() answers before any decision has been made.
  const fresh = rig()
  const undescribed = fresh.scheduler.describe()
  assert.equal(undescribed.state, 'NORMAL')
  assert.equal(undescribed.limits, null)
  assert.equal(undescribed.effectiveLimit, null)
  assert.deepEqual(undescribed.transitions, [])
  assert.deepEqual(undescribed.reasons, [])
})
