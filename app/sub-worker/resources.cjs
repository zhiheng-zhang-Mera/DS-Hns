'use strict'

/**
 * Resource Monitor and Resource Scheduler (plan §3.2, §5, §8, §9, §10, §11,
 * §12, §16, §28, §29, §30, §31, §43, §44).
 *
 * Two responsibilities, deliberately separate:
 *   ResourceMonitor   — samples what the machine is doing right now, and
 *                       degrades gracefully when a sensor does not exist.
 *   ResourceScheduler — turns samples + the hardware ceiling + the
 *                       configuration into (a) a per-dimension limit set, (b) a
 *                       performance state, and (c) a scaling decision under
 *                       hysteresis.
 *
 * Nothing here ever starts a process: the scheduler only decides, the Worker
 * Pool executes.
 */

const os = require('node:os')

const profiler = require('./profiler.cjs')
const {
  STORAGE_IO_LIMIT,
  defaultResourceConfig,
  roleProfile
} = require('./resource-config.cjs')

/** The four documented performance states, plus the safety fallback (§10, §35). */
const PERFORMANCE_STATES = Object.freeze(['NORMAL', 'BOOST', 'THROTTLED', 'CRITICAL', 'SAFE_MODE'])

const DEFAULT_CPU_PERCENT_PER_WORKER = 100 / 16 // replaced per host, see cpuLimitFor

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function round(value, digits = 2) {
  const factor = 10 ** digits
  return Math.round(Number(value) * factor) / factor
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

/** Only a non-finite value falls back: a configured 0 is a real setting (§44). */
function numberOrDefault(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

/**
 * The documented `effective_worker_limit = min(...)` (§43) as a reusable value
 * object, so a caller can always explain *why* a number came out.
 */
function limitSet(values) {
  const entries = Object.entries(values).filter(([, value]) => Number.isFinite(value))
  const effective = entries.length ? Math.min(...entries.map(([, value]) => value)) : 0
  const binding = entries
    .filter(([, value]) => value === effective)
    .map(([name]) => name)
  return { ...values, effective, binding }
}

class ResourceMonitor {
  constructor({
    root,
    config = defaultResourceConfig(),
    log = () => {},
    probe = {},
    now = () => Date.now(),
    sampleIntervalMs = null
  } = {}) {
    this.root = root
    this.config = config
    this.log = log
    this.probe = probe
    this.now = now
    this.sampleIntervalMs = Number(sampleIntervalMs) || (config.runtime.sampleIntervalSeconds || 5) * 1000
    this.cpuSampler = profiler.createCpuSampler()
    this.samples = []
    this.maxSamples = 240
    this.facts = null
    this.latency = null
    this.latencyAt = 0
    this.latencyIntervalMs = 30_000
    this.timer = null
    this.injection = null
    this.started = false
  }

  /** Verification hook: force the next samples instead of measuring them (§46). */
  setInjection(fn) {
    this.injection = typeof fn === 'function' ? fn : null
    return this.injection !== null
  }

  inject(sample, { record = true } = {}) {
    const normalized = this.normalize(sample)
    if (record) this.push(normalized)
    return normalized
  }

  /** Take one sample; never throws and never blocks on a missing sensor. */
  sample({ force = false } = {}) {
    if (this.injection) {
      const injected = this.injection({ now: this.now(), previous: this.samples.at(-1) || null })
      if (injected) return this.inject(injected)
    }
    const at = this.now()
    if (!this.facts) {
      this.facts = profiler.collectFacts({ probe: this.probe, log: this.log, force, config: this.config })
    }
    // Disk latency is an expensive probe, so it runs on its own slower cadence.
    if (force || !this.latency || at - this.latencyAt > this.latencyIntervalMs) {
      this.latency = profiler.measureDiskLatency(this.root)
      this.latencyAt = at
    }

    const cpu = this.cpuSampler()
    const totalRamGb = profiler.gb(os.totalmem())
    const availableRamGb = profiler.gb(os.freemem())
    const disk = profiler.diskSpace(this.root)
    const facts = this.facts.facts || {}
    const sample = this.normalize({
      at,
      cpu,
      memory: {
        available: true,
        total_gb: totalRamGb,
        available_gb: availableRamGb,
        used_percent: totalRamGb > 0 ? round((1 - availableRamGb / totalRamGb) * 100, 1) : null
      },
      swap: facts.pageFile
        ? { available: true, used_gb: round(Number(facts.pageFile.CurrentUsage) / 1024, 2), total_gb: round(Number(facts.pageFile.AllocatedBaseSize) / 1024, 2) }
        : { available: false },
      disk: {
        ...disk,
        latency: this.latency,
        storage_class: facts.storage_class || 'unknown'
      },
      gpu: {
        available: Boolean(facts.gpus?.length),
        vram_total_gb: facts.gpu_vram_gb || 0,
        gpus: facts.gpus || []
      },
      power: facts.battery
        ? { available: true, ...facts.battery }
        : { available: false, note: 'no battery reported: treated as mains powered' },
      temperature: facts.temperature_c !== undefined
        ? { available: true, celsius: facts.temperature_c, source: facts.temperature_source }
        : { available: false, note: 'no temperature sensor; utilization and frequency are used instead' },
      degraded: this.facts.degraded || []
    })
    return this.push(sample)
  }

  /** Fill in the shape, so the scheduler never has to guard for missing keys. */
  normalize(sample) {
    const source = isPlainObject(sample) ? sample : {}
    const cpu = isPlainObject(source.cpu) ? source.cpu : { available: false }
    const memory = isPlainObject(source.memory) ? source.memory : { available: false }
    const disk = isPlainObject(source.disk) ? source.disk : { available: false }
    const gpu = isPlainObject(source.gpu) ? source.gpu : { available: false }
    const power = isPlainObject(source.power) ? source.power : { available: false }
    const temperature = isPlainObject(source.temperature) ? source.temperature : { available: false }
    return {
      at: Number(source.at) || this.now(),
      cpu: {
        available: cpu.available !== false && Number.isFinite(Number(cpu.usage_percent ?? cpu.usagePercent)),
        usage_percent: Number(cpu.usage_percent ?? cpu.usagePercent) || 0,
        logical_cores: Number(cpu.logical_cores ?? cpu.logicalCores) || os.cpus().length || 1,
        current_frequency_mhz: Number(cpu.current_frequency_mhz ?? cpu.currentFrequencyMhz) || null,
        max_frequency_mhz: Number(cpu.max_frequency_mhz ?? cpu.maxFrequencyMhz) || null
      },
      memory: {
        available: memory.available !== false && Number.isFinite(Number(memory.total_gb ?? memory.totalGb)),
        total_gb: Number(memory.total_gb ?? memory.totalGb) || 0,
        available_gb: Number(memory.available_gb ?? memory.availableGb) || 0,
        used_percent: Number(memory.used_percent ?? memory.usedPercent) || 0
      },
      swap: isPlainObject(source.swap) ? source.swap : { available: false },
      disk: {
        available: disk.available !== false,
        free_gb: Number(disk.free_gb ?? disk.freeGb) || 0,
        free_percent: Number(disk.free_percent ?? disk.freePercent) || 0,
        storage_class: String(disk.storage_class || disk.storageClass || 'unknown'),
        latency: isPlainObject(disk.latency) ? disk.latency : { available: false }
      },
      gpu: {
        available: gpu.available === true,
        vram_total_gb: Number(gpu.vram_total_gb ?? gpu.vramTotalGb) || 0,
        vram_free_gb: Number(gpu.vram_free_gb ?? gpu.vramFreeGb) || null,
        gpus: Array.isArray(gpu.gpus) ? gpu.gpus : []
      },
      power: { available: power.available === true, on_battery: power.on_battery === true, percent: power.percent ?? null },
      temperature: { available: temperature.available === true, celsius: Number(temperature.celsius) || null, source: temperature.source || null },
      userActivity: isPlainObject(source.userActivity) ? source.userActivity : { available: false, interactive: false },
      degraded: Array.isArray(source.degraded) ? source.degraded : []
    }
  }

  push(sample) {
    this.samples.push(sample)
    if (this.samples.length > this.maxSamples) this.samples.splice(0, this.samples.length - this.maxSamples)
    return sample
  }

  latest() {
    return this.samples.at(-1) || null
  }

  history(limit = 60) {
    const value = Number(limit)
    if (!Number.isFinite(value) || value <= 0) return [...this.samples]
    return this.samples.slice(-Math.floor(value))
  }

  start(onSample = null) {
    if (this.timer || this.started) return false
    this.started = true
    // No `force`: the platform facts are cached, and startup must not pay for a
    // second inventory shell.
    this.sample()
    this.timer = setInterval(() => {
      try {
        const sample = this.sample()
        if (onSample) onSample(sample)
      } catch (error) {
        this.log(`[resources] sampling failed: ${error?.message || error}`)
      }
    }, this.sampleIntervalMs)
    if (typeof this.timer.unref === 'function') this.timer.unref()
    return true
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.started = false
  }
}

/**
 * Turns samples into limits, a state, and a scaling decision.
 *
 * The scheduler is intentionally stateless about processes: it never spawns or
 * kills anything, it only answers "how many workers should exist right now".
 */
class ResourceScheduler {
  constructor({
    config = defaultResourceConfig(),
    hardwareProfile = null,
    monitor,
    log = () => {},
    now = () => Date.now(),
    learnedProfiles = null
  } = {}) {
    this.config = config
    this.hardware = hardwareProfile
    this.monitor = monitor
    this.log = log
    this.now = now
    this.learnedProfiles = learnedProfiles
    this.state = 'NORMAL'
    this.stateSince = this.now()
    this.healthySince = null
    this.pressureSince = null
    // A pool that is larger than the work needs is not "under pressure": it is
    // simply oversized, and that has its own (shorter) grace period (§16, §13).
    this.idleSurplusSince = null
    this.criticalSamples = 0
    this.onlineWorkers = 0
    this.gpuWorkers = 0
    this.lastEvaluation = null
    this.transitions = []
  }

  /** Resolved worker ceilings: hardware ceiling, hard max and soft max (§26, §27). */
  ceilings() {
    const config = this.config
    const hardwareMax = Math.max(1, Number(this.hardware?.max_recommended_workers) || 1)
    const hardMax = config.workers.hardMax === 'auto'
      ? hardwareMax
      : Math.max(1, Math.min(Number(config.workers.hardMax) || hardwareMax, hardwareMax))
    let softMax = config.workers.softMax === 'auto'
      ? hardMax
      : Math.max(1, Math.min(Number(config.workers.softMax) || hardMax, hardMax))
    const sample = this.monitor?.latest?.() || null
    let batteryApplied = false
    if (sample?.power?.available && sample.power.on_battery) {
      const onBattery = Math.max(1, Number(config.battery.onBatterySoftMax) || 1)
      if (onBattery < softMax) {
        softMax = onBattery
        batteryApplied = true
      }
    }
    return {
      hardwareMax,
      hardMax,
      softMax,
      min: Math.max(1, Number(config.workers.min) || 1),
      batteryApplied,
      hardwareCeilings: this.hardware?.ceilings || null,
      tier: this.hardware?.tier || null
    }
  }

  /** Heaviest memory footprint among the roles that may run (conservative). */
  ramPerWorkerGb(roles = ['build']) {
    let worst = 0
    for (const role of roles) {
      const profile = roleProfile(role, this.learnedProfiles)
      worst = Math.max(worst, Number(profile.ram_estimate_mb) || 1200)
    }
    return Math.max(0.4, round(worst / 1024, 2))
  }

  /**
   * The sample the decision is based on.
   *
   * Normally this is the newest recorded sample (the monitor samples on its own
   * cadence). When an injection hook is active — the documented verification
   * hook for plan §46 "运行验收" — the injected sample is pulled immediately, so a
   * test can drive pressure deterministically instead of waiting for a timer.
   */
  currentSample() {
    const monitor = this.monitor
    if (!monitor) return null
    if (typeof monitor.sample !== 'function') return monitor.latest?.() || null
    if (monitor.injection) return monitor.sample()
    return monitor.latest() || monitor.sample({ force: true })
  }

  /** Free VRAM, preferring per-GPU measurements over the adapter total (§7). */
  freeVramGb(sample) {
    const reserveRatio = numberOrDefault(this.config.resources.gpuReservePercent, 20) / 100
    const gpus = Array.isArray(sample?.gpu?.gpus) ? sample.gpu.gpus : []
    let measured = 0
    let measuredAny = false
    for (const gpu of gpus) {
      const total = Number(gpu?.vram_total_gb)
      const used = Number(gpu?.vram_used_gb)
      if (!Number.isFinite(total) || total <= 0) continue
      if (Number.isFinite(used)) {
        measured += Math.max(0, total - used)
        measuredAny = true
      } else {
        measured += total
      }
    }
    const declaredFree = sample?.gpu?.vram_free_gb
    if (declaredFree !== null && declaredFree !== undefined && Number.isFinite(Number(declaredFree))) {
      measured = Number(declaredFree)
      measuredAny = true
    }
    if (!measuredAny && measured <= 0) {
      const total = Number(sample?.gpu?.vram_total_gb)
      if (!Number.isFinite(total) || total <= 0) return 0
      measured = total
    }
    return Math.max(0, round(measured * (1 - reserveRatio), 2))
  }

  /** CPU percentage one worker of the given weight occupies on this host. */
  cpuPercentPerWorker(cpuWeight = 1) {
    const cores = Math.max(1, Number(this.hardware?.physical_cpu_cores) || (os.cpus().length || 1) / 2)
    return round((100 / cores) * Math.max(0.25, Number(cpuWeight) || 1), 2)
  }

  /**
   * The heaviest CPU weight among the roles that may run, so a `build` worker
   * (weight 3) is budgeted as three light workers instead of one (§6, §40).
   */
  cpuWeightFor(roles = ['generic']) {
    let worst = 1
    for (const role of roles) {
      const profile = roleProfile(role, this.learnedProfiles)
      worst = Math.max(worst, Number(profile.cpu_weight) || 1)
    }
    return worst
  }

  /**
   * Evaluate every dimension and the resulting state (§10, §43, §44).
   */
  /**
   * Evaluate every dimension and the resulting state (§10, §43, §44).
   *
   * With no arguments this describes the limit set for ONE unit-weight worker
   * using the conservative `build` footprint for RAM; the CPU dimension is
   * expressed per unit weight (`cpuPercentPerWorker`), so a caller that knows the
   * roles it is about to run must pass both `singleWorkerRoles` and `cpuWeight`
   * (or use `decide()`, which does it from the runnable DAG nodes).
   */
  evaluate({ singleWorkerRoles = ['build'], cpuWeight = null, now = this.now() } = {}) {
    const sample = this.currentSample()
    const config = this.config
    const ceilings = this.ceilings()
    const effectiveCpuWeight = cpuWeight === null ? 1 : cpuWeight
    const reasons = []
    const degraded = sample?.degraded || []

    // ---- RAM (§5, §44) ----------------------------------------------------
    const reserveMinGb = Number(config.resources.ramReserveMinGb) || 4
    const ramUsedPercent = Number(sample?.memory?.used_percent) || 0
    const availableGb = Number(sample?.memory?.available_gb) || 0
    const usableRamGb = Math.max(0, round(availableGb - reserveMinGb, 2))
    const ramPerWorkerGb = this.ramPerWorkerGb(singleWorkerRoles)
    let ramLimit = Math.max(0, Math.floor(usableRamGb / ramPerWorkerGb))
    // A breached reserve is pressure, not a reason to stop: the machine can
    // still host one worker, so it runs one and reports THROTTLED (§10), while
    // only a genuine inability to host a worker reaches SAFE MODE (§35).
    const canHostOneWorker = availableGb >= ramPerWorkerGb
    const reserveBreached = canHostOneWorker && ramLimit === 0
    if (reserveBreached) ramLimit = 1
    if (!canHostOneWorker) reasons.push(`available RAM ${availableGb} GB cannot host one ${ramPerWorkerGb} GB worker`)
    else if (reserveBreached) reasons.push(`available RAM ${availableGb} GB is inside the ${reserveMinGb} GB reserve: one worker only`)

    // ---- CPU (§4, §29, §44) -----------------------------------------------
    const cpuUsage = Number(sample?.cpu?.usage_percent) || 0
    const interactive = sample?.userActivity?.interactive === true
    const idleBudget = numberOrDefault(config.userActivity?.idleCpuBudgetPercent, 80)
    const reserveBudget = 100 - numberOrDefault(config.resources.cpuReservePercent, 20)
    // §29: a foreground user halves the budget; an idle machine may use the
    // documented idle budget, which also bounds an explicitly lowered reserve.
    const cpuBudgetPercent = interactive
      ? numberOrDefault(config.userActivity?.activeCpuBudgetPercent, 50)
      : Math.min(reserveBudget, idleBudget)
    const cpuHeadroom = Math.max(0, cpuBudgetPercent - cpuUsage)
    const cpuLimit = Math.max(0, Math.floor(cpuHeadroom / this.cpuPercentPerWorker(effectiveCpuWeight)))
    if (interactive) reasons.push(`foreground user activity: CPU budget reduced to ${cpuBudgetPercent}%`)

    // ---- I/O (§8) ---------------------------------------------------------
    const storageClass = sample?.disk?.storage_class && sample.disk.storage_class !== 'unknown'
      ? sample.disk.storage_class
      : config.storage.assumeWhenUnknown
    const baseIo = STORAGE_IO_LIMIT[storageClass] || STORAGE_IO_LIMIT.unknown
    const latency = sample?.disk?.latency
    const writeMs = latency?.available ? Number(latency.write_ms) : null
    let ioLimit = baseIo
    if (writeMs !== null) {
      if (writeMs > Number(config.io.latencyCriticalMs)) {
        ioLimit = 1
        reasons.push(`disk latency ${writeMs} ms is critical`)
      } else if (writeMs > Number(config.io.latencySlowMs)) {
        ioLimit = Math.max(1, Math.floor(baseIo / 2))
        reasons.push(`disk latency ${writeMs} ms is slow`)
      }
    }
    const diskFreePercent = Number(sample?.disk?.free_percent)
    const diskFreeLimitOk = !Number.isFinite(diskFreePercent) || diskFreePercent >= Number(config.resources.diskFreeReservePercent)
    if (!diskFreeLimitOk) {
      ioLimit = 0
      reasons.push(`disk free space ${diskFreePercent}% is below the ${config.resources.diskFreeReservePercent}% reserve`)
    }

    // ---- Thermal (§9, §10) -------------------------------------------------
    let thermalLimit = 99
    const temperature = sample?.temperature
    if (config.thermal.enabled && temperature?.available && Number.isFinite(temperature.celsius)) {
      if (temperature.celsius >= 90) {
        thermalLimit = 0
        reasons.push(`CPU temperature ${temperature.celsius} °C is critical`)
      } else if (temperature.celsius >= 85) {
        thermalLimit = 1
        reasons.push(`CPU temperature ${temperature.celsius} °C is high`)
      } else if (temperature.celsius >= 78) {
        thermalLimit = 2
        reasons.push(`CPU temperature ${temperature.celsius} °C is warm`)
      }
    } else if (config.thermal.enabled) {
      // Graceful degradation: without a sensor, only an obvious frequency
      // collapse under load is treated as throttling — a flat, unreadable
      // frequency signal must not be invented into a throttle (§9).
      const current = Number(sample?.cpu?.current_frequency_mhz)
      const max = Number(sample?.cpu?.max_frequency_mhz)
      if (Number.isFinite(current) && Number.isFinite(max) && max > 0 && current > 0 && current / max < 0.6 && cpuUsage > 85) {
        thermalLimit = 1
        reasons.push(`frequency ${current}/${max} MHz under ${cpuUsage}% load suggests thermal throttling`)
      } else if (degraded.length) {
        reasons.push('no temperature sensor: thermal limiting is inactive rather than guessed')
      }
    }

    // ---- GPU slot (§7) ----------------------------------------------------
    let gpuLimit = 99
    const gpu = sample?.gpu
    if (gpu?.available && Number(gpu.vram_total_gb) > 0) {
      const freeVram = this.freeVramGb(sample)
      const perTaskGb = 4
      gpuLimit = Math.max(0, Math.floor(freeVram / perTaskGb))
      if (gpuLimit === 0) reasons.push(`free VRAM ${freeVram} GB cannot host a ${perTaskGb} GB GPU task`)
    } else {
      gpuLimit = 0
      reasons.push('no measurable VRAM: GPU workers are not scheduled')
    }

    // ---- External services (§30, §31) -------------------------------------
    const externalLimit = Math.max(1, Number(config.externalService.apiConcurrencyLimit) || 3)

    // ---- Config ceiling (§26, §27) ----------------------------------------
    const configLimit = ceilings.softMax
    if (ceilings.batteryApplied) reasons.push(`on battery: soft maximum reduced to ${ceilings.softMax}`)

    const limits = limitSet({
      cpu: cpuLimit,
      ram: ramLimit,
      io: ioLimit,
      thermal: thermalLimit,
      config: configLimit
    })

    // ---- State (§10) ------------------------------------------------------
    const previousState = this.state
    let state = 'NORMAL'
    const criticalRam = ramUsedPercent > 95
    const criticalThermal = config.thermal.enabled && thermalLimit === 0
    const criticalCpu = cpuUsage > 96
    const criticalConditions = []
    if (criticalRam) criticalConditions.push(`RAM ${ramUsedPercent}% > 95%`)
    if (criticalThermal) criticalConditions.push('severe thermal throttling')
    if (criticalCpu) criticalConditions.push(`CPU ${cpuUsage}% > 96%`)
    if (limits.io <= 0) criticalConditions.push('disk free space below the reserve')
    if (!canHostOneWorker) criticalConditions.push('not enough available RAM for one worker')

    if (!canHostOneWorker && config.safety.enableSafeMode) {
      state = 'SAFE_MODE'
      reasons.push('SAFE MODE: not enough available RAM for a single worker')
    } else if (!canHostOneWorker || criticalConditions.length) {
      state = 'CRITICAL'
    } else if (reserveBreached) {
      state = 'THROTTLED'
    } else if (ramUsedPercent > 85 || cpuUsage > 85 || thermalLimit === 1 || (writeMs !== null && writeMs > Number(config.io.latencyCriticalMs))) {
      state = 'THROTTLED'
    } else if (cpuUsage < 70 && ramUsedPercent < 75) {
      state = limits.effective > 1 && config.scaling.enabled ? 'BOOST' : 'NORMAL'
    } else {
      state = 'NORMAL'
    }
    if (state === 'BOOST' && limits.effective <= 1) state = 'NORMAL'

    if (state !== previousState) {
      this.state = state
      this.stateSince = now
      this.transitions.push({ from: previousState, to: state, at: new Date(now).toISOString(), reasons: [...reasons] })
      if (this.transitions.length > 100) this.transitions.shift()
      this.log(`[resources] state ${previousState} -> ${state}${reasons.length ? ` (${reasons.join('; ')})` : ''}`)
    }

    // ---- Hysteresis (§12) --------------------------------------------------
    const healthy = state === 'NORMAL' || state === 'BOOST'
    const underPressure = state === 'THROTTLED' || state === 'CRITICAL' || state === 'SAFE_MODE'
    if (healthy) {
      this.healthySince = this.healthySince ?? now
      this.pressureSince = null
    } else if (underPressure) {
      this.pressureSince = this.pressureSince ?? now
      this.healthySince = null
    }
    this.criticalSamples = state === 'CRITICAL' || state === 'SAFE_MODE' ? this.criticalSamples + 1 : 0

    const emergency = state === 'CRITICAL' || state === 'SAFE_MODE'
    const healthyForMs = this.healthySince === null ? 0 : now - this.healthySince
    const pressureForMs = this.pressureSince === null ? 0 : now - this.pressureSince
    const scaleUpAllowed = config.scaling.enabled && healthyForMs >= Number(config.scaling.scaleUpDelaySeconds) * 1000
    const scaleDownAllowed = emergency
      ? Boolean(config.safety.emergencyScaleDownImmediate)
      : pressureForMs >= Number(config.scaling.scaleDownDelaySeconds) * 1000
    const evaluation = {
      at: new Date(now).toISOString(),
      state,
      previousState,
      stateSince: new Date(this.stateSince).toISOString(),
      limits,
      effectiveLimit: limits.effective,
      bindingLimit: limits.binding,
      ceilings,
      usableRamGb,
      ramPerWorkerGb,
      canHostOneWorker,
      reserveBreached,
      criticalConditions,
      cpuBudgetPercent,
      cpuPercentPerWorker: this.cpuPercentPerWorker(effectiveCpuWeight),
      cpuWeight: effectiveCpuWeight,
      storageClass,
      gpuLimit,
      externalLimit,
      reasons,
      degraded,
      hysteresis: {
        healthyForMs,
        pressureForMs,
        scaleUpAllowed,
        scaleDownAllowed,
        scaleUpDelayMs: Number(config.scaling.scaleUpDelaySeconds) * 1000,
        scaleDownDelayMs: Number(config.scaling.scaleDownDelaySeconds) * 1000,
        emergency
      },      sample
    }
    this.lastEvaluation = evaluation
    return evaluation
  }

  onlineSlotsLeft() {
    return Math.max(0, this.externalLimitCurrent - this.onlineWorkers)
  }

  /**
   * The scaling decision (plan §11, §12, §16, §35, §42).
   *
   * @returns {{desired:number, direction:'up'|'down'|'hold', step:number,
   *            reason:string, state:string, evaluation:object}}
   */
  decide({ poolSize = 0, busyWorkers = 0, idleWorkers = 0, runnableTasks = 0, now = this.now(), roles = ['build'] } = {}) {
    const evaluation = this.evaluate({ now, singleWorkerRoles: roles, cpuWeight: this.cpuWeightFor(roles) })
    const config = this.config
    this.externalLimitCurrent = evaluation.externalLimit
    const ceilings = evaluation.ceilings
    const minWorkers = ceilings.min

    // §35: SAFE MODE parks the pool completely; the supervisor keeps running.
    if (evaluation.state === 'SAFE_MODE' && config.safety.enableSafeMode) {
      return {
        desired: 0,
        direction: poolSize > 0 ? 'down' : 'hold',
        step: poolSize,
        reason: 'SAFE MODE: waiting for memory to recover',
        state: evaluation.state,
        evaluation
      }
    }

    // §16: never more workers than there is runnable work for.
    const workBounded = busyWorkers + runnableTasks
    const target = clamp(
      Math.min(evaluation.effectiveLimit, workBounded === 0 ? minWorkers : workBounded),
      minWorkers,
      ceilings.hardMax
    )

    // An oversized pool is a separate condition from resource pressure: the
    // work simply does not justify the workers (§16, §13). It is tracked with
    // its own, shorter grace period so the pool follows the workload instead of
    // waiting a full pressure delay.
    if (target < poolSize) {
      this.idleSurplusSince = this.idleSurplusSince ?? now
    } else {
      this.idleSurplusSince = null
    }
    const idleSurplusForMs = this.idleSurplusSince === null ? 0 : now - this.idleSurplusSince
    const idleGraceMs = Math.max(1, Number(config.scaling.idleDownGraceSeconds) || 10) * 1000

    if (target > poolSize) {
      // §10 CRITICAL / §12: never add a worker while throttled or critical.
      if (evaluation.state === 'THROTTLED' || evaluation.state === 'CRITICAL') {
        return { desired: poolSize, direction: 'hold', step: 0, reason: `${evaluation.state}: no new workers`, state: evaluation.state, evaluation }
      }
      if (!evaluation.hysteresis.scaleUpAllowed) {
        return {
          desired: poolSize,
          direction: 'hold',
          step: 0,
          reason: `healthy for only ${Math.round(evaluation.hysteresis.healthyForMs / 1000)} s of the required ${config.scaling.scaleUpDelaySeconds} s`,
          state: evaluation.state,
          evaluation
        }
      }
      // §11: progressive growth, never a jump to the maximum.
      const step = Math.min(
        Number(config.scaling.scaleUpStep) || 1,
        Number(config.scaling.maxScaleUpPerCycle) || 1,
        target - poolSize
      )
      return { desired: poolSize + step, direction: 'up', step, reason: `adding ${step} worker(s) towards ${target}`, state: evaluation.state, evaluation }
    }

    if (target < poolSize) {
      // A busy worker is never retired, and the configured minimum is honoured
      // unless the machine is in an emergency.
      const floor = evaluation.hysteresis.emergency ? 0 : Math.max(minWorkers, busyWorkers)
      const ceilingForDown = Math.max(floor, busyWorkers)
      if (ceilingForDown >= poolSize) {
        return { desired: poolSize, direction: 'hold', step: 0, reason: 'every worker is busy', state: evaluation.state, evaluation }
      }
      // Pressure needs the long documented delay; an oversized-but-healthy pool
      // only needs the short idle grace period.
      const pressureAllows = evaluation.hysteresis.scaleDownAllowed
      const surplusAllows = idleSurplusForMs >= idleGraceMs
      if (!pressureAllows && !surplusAllows) {
        return {
          desired: poolSize,
          direction: 'hold',
          step: 0,
          reason: evaluation.hysteresis.pressureForMs > 0 || evaluation.state === 'THROTTLED'
            ? `under pressure for only ${Math.round(evaluation.hysteresis.pressureForMs / 1000)} s of the required ${config.scaling.scaleDownDelaySeconds} s`
            : `oversized for only ${Math.round(idleSurplusForMs / 1000)} s of the required ${Math.round(idleGraceMs / 1000)} s`,
          state: evaluation.state,
          evaluation
        }
      }
      const step = Math.min(
        Number(config.scaling.scaleDownStep) || 1,
        poolSize - Math.max(ceilingForDown, target)
      )
      const desired = Math.max(ceilingForDown, poolSize - Math.max(1, step))
      const surplusReason = evaluation.hysteresis.emergency
        ? `${evaluation.state}: emergency scale down`
        : (evaluation.hysteresis.scaleDownAllowed
          ? `${evaluation.state}: resource pressure`
          : `idle surplus: ${busyWorkers + runnableTasks} work item(s) for ${poolSize} worker(s)`)
      return {
        desired: Math.max(busyWorkers, Math.min(desired, idleWorkers > 0 ? desired : poolSize)),
        direction: 'down',
        step,
        reason: `${surplusReason} - retiring ${step} idle worker(s)`,
        state: evaluation.state,
        evaluation
      }
    }

    return { desired: poolSize, direction: 'hold', step: 0, reason: 'at the effective limit', state: evaluation.state, evaluation }
  }

  /** Room for one more online (external-service) task (§31). */
  canStartOnlineTask() {
    const limit = Number(this.lastEvaluation?.externalLimit) || Number(this.config.externalService.apiConcurrencyLimit) || 3
    return this.onlineWorkers < limit
  }

  /** Room for one more GPU task (§7). */
  canStartGpuTask() {
    const limit = Number(this.lastEvaluation?.gpuLimit)
    if (!Number.isFinite(limit)) return false
    return this.gpuWorkers < limit
  }

  describe() {
    const evaluation = this.lastEvaluation
    return {
      state: this.state,
      stateSince: new Date(this.stateSince).toISOString(),
      limits: evaluation?.limits || null,
      effectiveLimit: evaluation?.effectiveLimit ?? null,
      bindingLimit: evaluation?.bindingLimit || null,
      ceilings: this.ceilings(),
      usableRamGb: evaluation?.usableRamGb ?? null,
      ramPerWorkerGb: evaluation?.ramPerWorkerGb ?? null,
      cpuBudgetPercent: evaluation?.cpuBudgetPercent ?? null,
      storageClass: evaluation?.storageClass || null,
      gpuLimit: evaluation?.gpuLimit ?? null,
      externalLimit: evaluation?.externalLimit ?? null,
      onlineWorkers: this.onlineWorkers,
      gpuWorkers: this.gpuWorkers,
      reasons: evaluation?.reasons || [],
      degraded: evaluation?.degraded || [],
      hysteresis: evaluation?.hysteresis || null,
      transitions: this.transitions.slice(-10),
      sample: evaluation?.sample || null
    }
  }
}

module.exports = {
  PERFORMANCE_STATES,
  DEFAULT_CPU_PERCENT_PER_WORKER,
  limitSet,
  ResourceMonitor,
  ResourceScheduler
}
