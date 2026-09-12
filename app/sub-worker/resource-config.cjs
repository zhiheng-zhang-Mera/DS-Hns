'use strict'

/**
 * Resource configuration for the adaptive multi-worker framework
 * (plan §27, §44, §45).
 *
 * Precedence, lowest to highest:
 *   defaultResourceConfig()
 *   config/app.json#subWorker.resources        (shipped declaration)
 *   config/hns-resource.yaml                   (the documented user file)
 *   data/sub-worker/config.json                (persisted / panel)
 *
 * `auto` means "let the profiler and the runtime monitor decide". A number is
 * read as an explicit user override, which is still clamped by the safety
 * limits that plan §27 requires HNS to keep ("HNS 仍保留系统安全限制").
 */

const path = require('node:path')
const fsMod = require('node:fs')
const { readResourceFile } = require('./yaml.cjs')

/** Roles a worker may take (plan §14, §22, §23). */
const WORKER_ROLES = Object.freeze([
  'generic',
  'code',
  'test',
  'build',
  'explorer',
  'review',
  'integration'
])

/** Role resource profiles (plan §6). Learned values replace the seeds (§40). */
const DEFAULT_ROLE_PROFILES = Object.freeze({
  light_code_worker: { ram_estimate_mb: 1000, cpu_weight: 1 },
  generic: { ram_estimate_mb: 1200, cpu_weight: 1 },
  code: { ram_estimate_mb: 1000, cpu_weight: 1 },
  browser_worker: { ram_estimate_mb: 2500, cpu_weight: 1.5 },
  explorer: { ram_estimate_mb: 900, cpu_weight: 1 },
  review: { ram_estimate_mb: 900, cpu_weight: 1 },
  test_worker: { ram_estimate_mb: 1800, cpu_weight: 2 },
  test: { ram_estimate_mb: 1800, cpu_weight: 2 },
  build_worker: { ram_estimate_mb: 2500, cpu_weight: 3 },
  build: { ram_estimate_mb: 2500, cpu_weight: 3 },
  integration: { ram_estimate_mb: 3000, cpu_weight: 3 }
})

/** Installation tiers (plan §26). */
const INSTALLATION_TIERS = Object.freeze({
  low: { label: 'Low Resource', maxRecommendedWorkers: 1, minCores: 0, minRamGb: 0 },
  standard: { label: 'Standard', maxRecommendedWorkers: 3, minCores: 8, minRamGb: 16 },
  high: { label: 'High', maxRecommendedWorkers: 6, minCores: 12, minRamGb: 32 },
  workstation: { label: 'Workstation', maxRecommendedWorkers: 12, minCores: 16, minRamGb: 64 }
})

function defaultResourceConfig() {
  return {
    workers: {
      min: 1,
      softMax: 'auto',
      hardMax: 'auto'
    },
    resources: {
      cpuReservePercent: 20,
      ramReservePercent: 20,
      gpuReservePercent: 20,
      ramReserveMinGb: 4,
      diskFreeReservePercent: 10
    },
    scaling: {
      enabled: true,
      scaleUpStep: 1,
      scaleDownStep: 1,
      scaleUpDelaySeconds: 30,
      scaleDownDelaySeconds: 60,
      // An idle surplus is not resource pressure, so it retires sooner (§16).
      idleDownGraceSeconds: 10,
      maxScaleUpPerCycle: 1
    },
    thermal: {
      enabled: true
    },
    speculativeExecution: {
      enabled: true,
      maxDuplicates: 2
    },
    runtime: {
      heartbeatSeconds: 5,
      workerTimeoutSeconds: 1800,
      sampleIntervalSeconds: 5,
      hangDetectionSeconds: 120
    },
    safety: {
      enableSafeMode: true,
      keepSupervisorAlive: true,
      emergencyScaleDownImmediate: true
    },
    externalService: {
      apiConcurrencyLimit: 3,
      offlineFallsBackToLocalWorkers: true
    },
    storage: {
      assumeWhenUnknown: 'sata_ssd'
    },
    io: {
      latencyNvmeMs: 4,
      latencySlowMs: 25,
      latencyCriticalMs: 60,
      queueSlow: 4
    },
    battery: {
      // §28: a laptop on battery gets a much smaller soft maximum.
      pluggedInSoftMax: 'auto',
      onBatterySoftMax: 2
    },
    userActivity: {
      enabled: true,
      activeCpuBudgetPercent: 50,
      idleCpuBudgetPercent: 80,
      idleAfterSeconds: 120
    }
  }
}

/** Storage classes and their parallel I/O allowance (plan §8). */
const STORAGE_IO_LIMIT = Object.freeze({
  hdd: 1,
  sata_ssd: 3,
  nvme: 6,
  unknown: 3
})

/**
 * A workstation-class host on NVMe may use the upper half of the documented
 * "Workstation: 6~12 workers" band (plan §26): the I/O allowance itself is not
 * the binding constraint there.
 */
const WORKSTATION_NVME_IO_LIMIT = 12

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, number))
}

/** `auto` stays `auto`; a number becomes an explicit override (>= 1). */
function normalizeMax(value, fallback = 'auto') {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'string' && value.trim().toLowerCase() === 'auto') return 'auto'
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(1, Math.floor(number))
}

function normalizeBoolean(value, fallback) {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'boolean') return value
  const text = String(value).trim().toLowerCase()
  if (['true', 'yes', 'on', '1'].includes(text)) return true
  if (['false', 'no', 'off', '0'].includes(text)) return false
  return fallback
}

/** Merge one user layer into a base resource configuration. */
function mergeLayer(base, layer) {
  if (!isPlainObject(layer)) return base
  const out = { ...base }
  const scalarKeys = {
    workers: { min: 'number', softMax: 'max', hardMax: 'max' },
    resources: { cpuReservePercent: 'number', ramReservePercent: 'number', gpuReservePercent: 'number', ramReserveMinGb: 'number', diskFreeReservePercent: 'number' },
    scaling: { enabled: 'boolean', scaleUpStep: 'number', scaleDownStep: 'number', scaleUpDelaySeconds: 'number', scaleDownDelaySeconds: 'number', idleDownGraceSeconds: 'number', maxScaleUpPerCycle: 'number' },
    thermal: { enabled: 'boolean' },
    speculativeExecution: { enabled: 'boolean', maxDuplicates: 'number' },
    runtime: { heartbeatSeconds: 'number', workerTimeoutSeconds: 'number', sampleIntervalSeconds: 'number', hangDetectionSeconds: 'number' },
    safety: { enableSafeMode: 'boolean', keepSupervisorAlive: 'boolean', emergencyScaleDownImmediate: 'boolean' },
    externalService: { apiConcurrencyLimit: 'number', offlineFallsBackToLocalWorkers: 'boolean' },
    storage: { assumeWhenUnknown: 'storage' },
    io: { latencyNvmeMs: 'number', latencySlowMs: 'number', latencyCriticalMs: 'number', queueSlow: 'number' },
    battery: { pluggedInSoftMax: 'max', onBatterySoftMax: 'number' },
    userActivity: { enabled: 'boolean', activeCpuBudgetPercent: 'number', idleCpuBudgetPercent: 'number', idleAfterSeconds: 'number' }
  }

  // Accept both the camelCase internal spelling and the snake_case spelling of
  // the documented hns-resource.yaml.
  const aliases = {
    workers: { min: ['min'], softMax: ['soft_max', 'softMax'], hardMax: ['hard_max', 'hardMax'] },
    resources: {
      cpuReservePercent: ['cpu_reserve_percent', 'reserve_cpu_percent', 'cpuReservePercent'],
      ramReservePercent: ['ram_reserve_percent', 'reserve_ram_percent', 'ramReservePercent'],
      gpuReservePercent: ['gpu_reserve_percent', 'reserve_gpu_percent', 'gpuReservePercent'],
      ramReserveMinGb: ['ram_reserve_min_gb', 'reserve_min_gb', 'ramReserveMinGb'],
      diskFreeReservePercent: ['disk_free_reserve_percent', 'diskFreeReservePercent']
    },
    scaling: {
      enabled: ['enabled'],
      scaleUpStep: ['scale_up_step', 'scaleUpStep'],
      scaleDownStep: ['scale_down_step', 'scaleDownStep'],
      scaleUpDelaySeconds: ['scale_up_delay_seconds', 'scaleUpDelaySeconds'],
      scaleDownDelaySeconds: ['scale_down_delay_seconds', 'scaleDownDelaySeconds'],
      idleDownGraceSeconds: ['idle_down_grace_seconds', 'idleDownGraceSeconds'],
      maxScaleUpPerCycle: ['max_scale_up_per_cycle', 'maxScaleUpPerCycle']
    },
    thermal: { enabled: ['enabled'] },
    speculativeExecution: {
      enabled: ['enabled'],
      maxDuplicates: ['max_duplicates', 'maxDuplicates']
    },
    runtime: {
      heartbeatSeconds: ['heartbeat_seconds', 'heartbeatSeconds'],
      workerTimeoutSeconds: ['worker_timeout_seconds', 'workerTimeoutSeconds'],
      sampleIntervalSeconds: ['sample_interval_seconds', 'sampleIntervalSeconds'],
      hangDetectionSeconds: ['hang_detection_seconds', 'hangDetectionSeconds']
    },
    safety: {
      enableSafeMode: ['enable_safe_mode', 'enableSafeMode'],
      keepSupervisorAlive: ['keep_supervisor_alive', 'keepSupervisorAlive'],
      emergencyScaleDownImmediate: ['emergency_scale_down_immediate', 'emergencyScaleDownImmediate']
    },
    externalService: {
      apiConcurrencyLimit: ['api_concurrency_limit', 'apiConcurrencyLimit'],
      offlineFallsBackToLocalWorkers: ['offline_falls_back_to_local_workers', 'offlineFallsBackToLocalWorkers']
    },
    storage: { assumeWhenUnknown: ['assume_when_unknown', 'assumeWhenUnknown'] },
    io: {
      latencyNvmeMs: ['latency_nvme_ms', 'latencyNvmeMs'],
      latencySlowMs: ['latency_slow_ms', 'latencySlowMs'],
      latencyCriticalMs: ['latency_critical_ms', 'latencyCriticalMs'],
      queueSlow: ['queue_slow', 'queueSlow']
    },
    battery: {
      pluggedInSoftMax: ['plugged_in_soft_max', 'pluggedInSoftMax'],
      onBatterySoftMax: ['on_battery_soft_max', 'onBatterySoftMax']
    },
    userActivity: {
      enabled: ['enabled'],
      activeCpuBudgetPercent: ['active_cpu_budget_percent', 'activeCpuBudgetPercent'],
      idleCpuBudgetPercent: ['idle_cpu_budget_percent', 'idleCpuBudgetPercent'],
      idleAfterSeconds: ['idle_after_seconds', 'idleAfterSeconds']
    }
  }

  // The documented file may also use the flat §45 layout:
  //   worker:   {min, soft_max, hard_max}
  //   resource: {cpu_reserve_percent, ...}
  //   scaling / runtime / safety / thermal / adaptive_scaling / speculative_execution
  const sectionSources = {
    workers: [layer.workers, layer.worker],
    resources: [layer.resources, layer.resource],
    scaling: [layer.scaling, layer.adaptive_scaling],
    thermal: [layer.thermal],
    speculativeExecution: [layer.speculativeExecution, layer.speculative_execution],
    runtime: [layer.runtime],
    safety: [layer.safety],
    externalService: [layer.externalService, layer.external_service],
    storage: [layer.storage],
    io: [layer.io],
    battery: [layer.battery],
    userActivity: [layer.userActivity, layer.user_activity]
  }

  for (const [section, kinds] of Object.entries(scalarKeys)) {
    const out2 = { ...out[section] }
    const sources = sectionSources[section].filter(isPlainObject)
    if (!sources.length) continue
    for (const [key, kind] of Object.entries(kinds)) {
      for (const source of sources) {
        const names = aliases[section]?.[key] || [key]
        const found = names.find((name) => Object.prototype.hasOwnProperty.call(source, name))
        if (found === undefined) continue
        const raw = source[found]
        if (kind === 'number') out2[key] = clampNumber(raw, 0, 100000, out2[key])
        else if (kind === 'boolean') out2[key] = normalizeBoolean(raw, out2[key])
        else if (kind === 'max') out2[key] = normalizeMax(raw, out2[key])
        else if (kind === 'storage') out2[key] = Object.prototype.hasOwnProperty.call(STORAGE_IO_LIMIT, String(raw)) ? String(raw) : out2[key]
      }
    }
    out[section] = out2
  }

  // §45 uses `worker.min`; a value below 1 is meaningless.
  out.workers.min = clampNumber(out.workers.min, 1, 64, base.workers.min)
  return out
}

/**
 * Final normalization plus the safety clamps HNS keeps even when the user
 * overrides a value (plan §27, §44).
 */
function finalizeResourceConfig(config) {
  const out = {
    workers: { ...config.workers },
    resources: { ...config.resources },
    scaling: { ...config.scaling },
    thermal: { ...config.thermal },
    speculativeExecution: { ...config.speculativeExecution },
    runtime: { ...config.runtime },
    safety: { ...config.safety },
    externalService: { ...config.externalService },
    storage: { ...config.storage },
    io: { ...config.io },
    battery: { ...config.battery },
    userActivity: { ...config.userActivity }
  }

  out.workers.min = Math.max(1, Math.min(64, Math.floor(out.workers.min || 1)))
  // A hard maximum can never exceed the physical sanity ceiling, and the soft
  // maximum can never exceed the hard maximum.
  if (out.workers.hardMax !== 'auto') out.workers.hardMax = Math.min(64, out.workers.hardMax)
  if (out.workers.softMax !== 'auto' && out.workers.hardMax !== 'auto') {
    out.workers.softMax = Math.min(out.workers.softMax, out.workers.hardMax)
  }
  out.resources.cpuReservePercent = clampNumber(out.resources.cpuReservePercent, 0, 80, 20)
  out.resources.ramReservePercent = clampNumber(out.resources.ramReservePercent, 5, 80, 20)
  out.resources.gpuReservePercent = clampNumber(out.resources.gpuReservePercent, 0, 80, 20)
  // §5: reserve is max(20%, 4 GB); a user may only lower it to 2 GB.
  out.resources.ramReserveMinGb = clampNumber(out.resources.ramReserveMinGb, 2, 64, 4)
  out.resources.diskFreeReservePercent = clampNumber(out.resources.diskFreeReservePercent, 5, 50, 10)
  out.scaling.scaleUpStep = clampNumber(out.scaling.scaleUpStep, 1, 8, 1)
  out.scaling.scaleDownStep = clampNumber(out.scaling.scaleDownStep, 1, 8, 1)
  // A user may legitimately want fast scaling (the documented default is 30/60);
  // one second is the floor that still prevents flapping.
  out.scaling.scaleUpDelaySeconds = clampNumber(out.scaling.scaleUpDelaySeconds, 1, 3600, 30)
  out.scaling.scaleDownDelaySeconds = clampNumber(out.scaling.scaleDownDelaySeconds, 1, 3600, 60)
  out.scaling.idleDownGraceSeconds = clampNumber(out.scaling.idleDownGraceSeconds, 1, 3600, 10)
  out.runtime.heartbeatSeconds = clampNumber(out.runtime.heartbeatSeconds, 1, 300, 5)
  out.runtime.workerTimeoutSeconds = clampNumber(out.runtime.workerTimeoutSeconds, 30, 86400, 1800)
  out.runtime.sampleIntervalSeconds = clampNumber(out.runtime.sampleIntervalSeconds, 1, 300, 5)
  out.runtime.hangDetectionSeconds = clampNumber(out.runtime.hangDetectionSeconds, 10, 3600, 120)
  out.externalService.apiConcurrencyLimit = clampNumber(out.externalService.apiConcurrencyLimit, 1, 64, 3)
  out.speculativeExecution.maxDuplicates = clampNumber(out.speculativeExecution.maxDuplicates, 2, 4, 2)
  out.battery.onBatterySoftMax = clampNumber(out.battery.onBatterySoftMax, 1, 8, 2)
  if (!Object.prototype.hasOwnProperty.call(STORAGE_IO_LIMIT, out.storage.assumeWhenUnknown)) {
    out.storage.assumeWhenUnknown = 'sata_ssd'
  }
  return out
}

/** Resolve the whole configuration from its four layers. */
function resolveResourceConfig({ root, declared = null, persisted = null, log = () => {} } = {}) {
  const defaults = defaultResourceConfig()
  const withDeclared = mergeLayer(defaults, declared)
  const file = path.join(path.resolve(root || '.'), 'config', 'hns-resource.yaml')
  const fromFile = readResourceFile(fsMod, file)
  if (!fromFile.missing && !fromFile.ok) {
    log(`[resources] config/hns-resource.yaml could not be used: ${fromFile.errors.join('; ')}`)
  }
  const withFile = fromFile.ok && fromFile.value ? mergeLayer(withDeclared, fromFile.value) : withDeclared
  const withPersisted = mergeLayer(withFile, persisted)
  const resolved = finalizeResourceConfig(withPersisted)
  return {
    config: resolved,
    source: {
      file: fromFile.missing ? null : file,
      fileFormat: fromFile.format || null,
      // A file that simply does not exist is not an error: it is the default
      // installation, and the panel must not warn about it.
      fileErrors: fromFile.missing ? [] : fromFile.errors,
      fileMissing: Boolean(fromFile.missing),
      fileUsed: Boolean(fromFile.ok && fromFile.value)
    }
  }
}

/**
 * Role profile lookup, preferring learned values when present (plan §40).
 *
 * Learning is a *refinement*, never a replacement: what a worker reports about
 * itself (its own resident memory) is not the memory a task needs — a test or
 * build command spawns children that dominate the footprint. The learned value
 * is therefore only trusted after a few samples and is clamped to a band around
 * the documented seed, so the memory guard can never be talked down to
 * nothing.
 */
const LEARNED_MIN_SAMPLES = 3
const LEARNED_RAM_BAND = { min: 0.5, max: 4 }
const LEARNED_CPU_BAND = { min: 0.5, max: 3 }

function roleProfile(role, learned = null, fallbackRole = 'generic') {
  const name = String(role || fallbackRole)
  const seed = DEFAULT_ROLE_PROFILES[name] || DEFAULT_ROLE_PROFILES[fallbackRole] || DEFAULT_ROLE_PROFILES.generic
  const observed = learned && isPlainObject(learned[name]) ? learned[name] : null
  const samples = Number(observed?.samples) || 0
  if (!observed || samples < LEARNED_MIN_SAMPLES) {
    return { role: name, source: 'seed', samples, ...seed }
  }
  const observedRam = Number(observed.ramEstimateMb)
  const observedWeight = Number(observed.cpuWeight)
  const ram = Number.isFinite(observedRam)
    ? Math.round(clampNumber(observedRam, seed.ram_estimate_mb * LEARNED_RAM_BAND.min, seed.ram_estimate_mb * LEARNED_RAM_BAND.max, seed.ram_estimate_mb))
    : seed.ram_estimate_mb
  const weight = Number.isFinite(observedWeight)
    ? clampNumber(observedWeight, seed.cpu_weight * LEARNED_CPU_BAND.min, seed.cpu_weight * LEARNED_CPU_BAND.max, seed.cpu_weight)
    : seed.cpu_weight
  return {
    role: name,
    source: 'learned',
    samples,
    ram_estimate_mb: Math.max(seed.ram_estimate_mb * LEARNED_RAM_BAND.min, ram),
    cpu_weight: Math.max(seed.cpu_weight * LEARNED_CPU_BAND.min, weight)
  }
}

module.exports = {
  WORKER_ROLES,
  DEFAULT_ROLE_PROFILES,
  INSTALLATION_TIERS,
  STORAGE_IO_LIMIT,
  WORKSTATION_NVME_IO_LIMIT,
  LEARNED_MIN_SAMPLES,
  LEARNED_RAM_BAND,
  LEARNED_CPU_BAND,
  defaultResourceConfig,
  mergeLayer,
  finalizeResourceConfig,
  resolveResourceConfig,
  roleProfile,
  normalizeMax,
  normalizeBoolean,
  isPlainObject
}
