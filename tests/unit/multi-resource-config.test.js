'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
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
  normalizeBoolean
} = require('../../app/sub-worker/resource-config.cjs')

/**
 * Resource configuration layers (plan §26, §27, §44, §45).
 *
 * Precedence: defaults < config/app.json#subWorker.resources <
 * config/hns-resource.yaml < data/sub-worker/config.json, and the safety limits
 * of plan §27 ("HNS 仍保留系统安全限制") survive every user override.
 */

const CREATED_ROOTS = []

test.after(() => {
  for (const root of CREATED_ROOTS) {
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {}
  }
})

/** A scratch HNS root with a `config` directory, as the installer creates it. */
function scratch(name, yamlText = null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-multi-rc-${name}-`))
  CREATED_ROOTS.push(root)
  fs.mkdirSync(path.join(root, 'config'), { recursive: true })
  if (yamlText !== null) fs.writeFileSync(path.join(root, 'config', 'hns-resource.yaml'), yamlText, 'utf8')
  return root
}

/** Everything the module documents as a default, in one place. */
const CANONICAL = {
  workers: { min: 3, softMax: 4, hardMax: 6 },
  resources: { cpuReservePercent: 25, ramReservePercent: 30, gpuReservePercent: 15, ramReserveMinGb: 6, diskFreeReservePercent: 20 },
  scaling: { enabled: false, scaleUpStep: 2, scaleDownStep: 3, scaleUpDelaySeconds: 45, scaleDownDelaySeconds: 120, idleDownGraceSeconds: 15, maxScaleUpPerCycle: 2 },
  thermal: { enabled: false },
  speculativeExecution: { enabled: false, maxDuplicates: 3 },
  runtime: { heartbeatSeconds: 10, workerTimeoutSeconds: 600, sampleIntervalSeconds: 15, hangDetectionSeconds: 300 },
  safety: { enableSafeMode: false, keepSupervisorAlive: false, emergencyScaleDownImmediate: false },
  externalService: { apiConcurrencyLimit: 5, offlineFallsBackToLocalWorkers: false },
  storage: { assumeWhenUnknown: 'nvme' },
  io: { latencyNvmeMs: 3, latencySlowMs: 20, latencyCriticalMs: 50, queueSlow: 7 },
  battery: { pluggedInSoftMax: 8, onBatterySoftMax: 4 },
  userActivity: { enabled: false, activeCpuBudgetPercent: 40, idleCpuBudgetPercent: 70, idleAfterSeconds: 60 }
}

/** The same configuration written the documented snake_case way. */
function toSnakeCase(layer) {
  const out = {}
  for (const [section, values] of Object.entries(layer)) {
    out[section] = {}
    for (const [key, value] of Object.entries(values)) {
      out[section][key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)] = value
    }
  }
  return out
}

test('the documented defaults of plan §44/§45 are shipped', () => {
  const config = defaultResourceConfig()
  assert.deepEqual(config.workers, { min: 1, softMax: 'auto', hardMax: 'auto' })
  assert.deepEqual(config.resources, {
    cpuReservePercent: 20,
    ramReservePercent: 20,
    gpuReservePercent: 20,
    ramReserveMinGb: 4,
    diskFreeReservePercent: 10
  })
  assert.deepEqual(config.scaling, {
    enabled: true,
    scaleUpStep: 1,
    scaleDownStep: 1,
    scaleUpDelaySeconds: 30,
    scaleDownDelaySeconds: 60,
    // Item 3: the idle-surplus grace documented for §16.
    idleDownGraceSeconds: 10,
    maxScaleUpPerCycle: 1
  })
  assert.equal(config.thermal.enabled, true)
  assert.deepEqual(config.speculativeExecution, { enabled: true, maxDuplicates: 2 })
  assert.deepEqual(config.runtime, {
    heartbeatSeconds: 5,
    workerTimeoutSeconds: 1800,
    sampleIntervalSeconds: 5,
    hangDetectionSeconds: 120
  })
  assert.deepEqual(config.safety, { enableSafeMode: true, keepSupervisorAlive: true, emergencyScaleDownImmediate: true })
  assert.deepEqual(config.externalService, { apiConcurrencyLimit: 3, offlineFallsBackToLocalWorkers: true })
  assert.equal(config.storage.assumeWhenUnknown, 'sata_ssd')
  assert.deepEqual(config.battery, { pluggedInSoftMax: 'auto', onBatterySoftMax: 2 })
  assert.deepEqual(config.userActivity, { enabled: true, activeCpuBudgetPercent: 50, idleCpuBudgetPercent: 80, idleAfterSeconds: 120 })
})

test('the exported vocabularies match plan §6, §8 and §26', () => {
  assert.deepEqual([...WORKER_ROLES], ['generic', 'code', 'test', 'build', 'explorer', 'review', 'integration'])
  assert.deepEqual(Object.keys(STORAGE_IO_LIMIT).sort(), ['hdd', 'nvme', 'sata_ssd', 'unknown'])
  assert.equal(STORAGE_IO_LIMIT.hdd, 1)
  assert.equal(STORAGE_IO_LIMIT.sata_ssd, 3)
  assert.equal(STORAGE_IO_LIMIT.nvme, 6)
  assert.equal(STORAGE_IO_LIMIT.unknown, 3, 'an unknown disk may not be treated as faster than a SATA SSD')
  // Item 6: §26/§47 — a workstation-class NVMe host reaches the upper half of
  // the documented "Workstation: 6~12 workers" band.
  assert.equal(WORKSTATION_NVME_IO_LIMIT, 12)
  assert.ok(WORKSTATION_NVME_IO_LIMIT > STORAGE_IO_LIMIT.nvme, 'the workstation allowance must exceed the generic NVMe one')

  assert.deepEqual(Object.keys(INSTALLATION_TIERS), ['low', 'standard', 'high', 'workstation'])
  assert.equal(INSTALLATION_TIERS.low.maxRecommendedWorkers, 1, 'low resource keeps the current Main + 1 worker behaviour')
  assert.equal(INSTALLATION_TIERS.standard.maxRecommendedWorkers, 3)
  assert.equal(INSTALLATION_TIERS.high.maxRecommendedWorkers, 6)
  assert.equal(INSTALLATION_TIERS.workstation.maxRecommendedWorkers, 12)
  for (const tier of Object.values(INSTALLATION_TIERS)) {
    assert.equal(typeof tier.label, 'string')
    assert.equal(typeof tier.minCores, 'number')
    assert.equal(typeof tier.minRamGb, 'number')
  }

  // Every role a worker may take has a resource profile, so the scheduler can
  // never fall back to an invented number (plan §6).
  for (const role of WORKER_ROLES) {
    const profile = DEFAULT_ROLE_PROFILES[role]
    assert.ok(profile, `${role} must have a memory profile`)
    assert.ok(profile.ram_estimate_mb > 0, `${role} must estimate RAM`)
    assert.ok(profile.cpu_weight > 0, `${role} must estimate CPU weight`)
  }
})

test('`auto` survives as "auto" while a number becomes an explicit value', () => {
  assert.equal(normalizeMax(undefined), 'auto')
  assert.equal(normalizeMax(null), 'auto')
  assert.equal(normalizeMax('auto'), 'auto')
  assert.equal(normalizeMax(' AUTO '), 'auto')
  assert.equal(normalizeMax('4'), 4)
  assert.equal(normalizeMax(4.9), 4, 'a fraction of a worker is floored')
  assert.equal(normalizeMax(0), 1, 'a user may not ask for zero workers')
  assert.equal(normalizeMax(-3), 1)
  assert.equal(normalizeMax('nonsense', 5), 5, 'an unreadable value keeps the previous layer')

  const merged = mergeLayer(defaultResourceConfig(), { workers: { softMax: 'auto', hardMax: 3 } })
  assert.equal(merged.workers.softMax, 'auto')
  assert.equal(merged.workers.hardMax, 3)

  const resolved = resolveResourceConfig({ root: scratch('auto') })
  assert.equal(resolved.config.workers.softMax, 'auto')
  assert.equal(resolved.config.workers.hardMax, 'auto')
  assert.equal(resolved.config.battery.pluggedInSoftMax, 'auto')
})

test('both the camelCase and the snake_case spelling of every documented key is accepted', () => {
  const camel = mergeLayer(defaultResourceConfig(), CANONICAL)
  const snake = mergeLayer(defaultResourceConfig(), toSnakeCase(CANONICAL))

  for (const [section, values] of Object.entries(CANONICAL)) {
    assert.deepEqual(camel[section], values, `camelCase ${section} must be accepted`)
    assert.deepEqual(snake[section], values, `snake_case ${section} must be accepted`)
  }
  assert.deepEqual(camel, snake, 'the two spellings describe the same configuration')
})

test('the §27/§45 alias spellings are accepted as well', () => {
  const merged = mergeLayer(defaultResourceConfig(), {
    resources: { reserve_cpu_percent: 35, reserve_ram_percent: 40, reserve_gpu_percent: 25, reserve_min_gb: 8 }
  })
  assert.equal(merged.resources.cpuReservePercent, 35)
  assert.equal(merged.resources.ramReservePercent, 40)
  assert.equal(merged.resources.gpuReservePercent, 25)
  assert.equal(merged.resources.ramReserveMinGb, 8)
  // Item 3: the new scaling key in both spellings.
  const grace = mergeLayer(defaultResourceConfig(), { scaling: { idle_down_grace_seconds: 25 } })
  assert.equal(grace.scaling.idleDownGraceSeconds, 25)
  assert.equal(mergeLayer(defaultResourceConfig(), { scaling: { idleDownGraceSeconds: 25 } }).scaling.idleDownGraceSeconds, 25)

  // An unknown key is ignored rather than folded into the configuration.
  const unknown = mergeLayer(defaultResourceConfig(), { nonsense: { whatever: 5 }, workers: { nonsense: 5 } })
  assert.equal(unknown.nonsense, undefined)
  assert.deepEqual(unknown.workers, defaultResourceConfig().workers)
})

test('the flat §45 sections are aliases of the nested ones', () => {
  const flat = {
    worker: { min: 2, soft_max: 'auto', hard_max: 6 },
    resource: { cpu_reserve_percent: 25, ram_reserve_percent: 30, reserve_min_gb: 6 },
    adaptive_scaling: { enabled: false, scale_up_step: 2, scale_down_delay_seconds: 120, idle_down_grace_seconds: 20 },
    speculative_execution: { enabled: false, max_duplicates: 3 },
    runtime: { heartbeat_seconds: 10 },
    safety: { enable_safe_mode: false },
    external_service: { api_concurrency_limit: 5 },
    user_activity: { active_cpu_budget_percent: 40 }
  }
  const merged = mergeLayer(defaultResourceConfig(), flat)
  assert.deepEqual(merged.workers, { min: 2, softMax: 'auto', hardMax: 6 })
  assert.equal(merged.resources.cpuReservePercent, 25)
  assert.equal(merged.resources.ramReservePercent, 30)
  assert.equal(merged.resources.ramReserveMinGb, 6)
  assert.equal(merged.scaling.enabled, false)
  assert.equal(merged.scaling.scaleUpStep, 2)
  assert.equal(merged.scaling.scaleDownDelaySeconds, 120)
  assert.equal(merged.scaling.idleDownGraceSeconds, 20)
  assert.deepEqual(merged.speculativeExecution, { enabled: false, maxDuplicates: 3 })
  assert.equal(merged.runtime.heartbeatSeconds, 10)
  assert.equal(merged.safety.enableSafeMode, false)
  assert.equal(merged.externalService.apiConcurrencyLimit, 5)
  assert.equal(merged.userActivity.activeCpuBudgetPercent, 40)

  // When both spellings of one section are present the later one wins, so the
  // result is deterministic instead of a mixture.
  const both = mergeLayer(defaultResourceConfig(), { workers: { softMax: 4 }, worker: { soft_max: 6 } })
  assert.equal(both.workers.softMax, 6)
})

test('the four documented layers are applied in order, key by key', () => {
  const root = scratch('precedence', [
    'resources:',
    '  ram_reserve_percent: 35',
    'scaling:',
    '  scale_down_delay_seconds: 90',
    ''
  ].join('\n'))
  const declared = {
    workers: { softMax: 4 },
    resources: { cpuReservePercent: 30 },
    scaling: { scaleUpDelaySeconds: 40 }
  }
  const persisted = { workers: { softMax: 2 } }
  const { config, source } = resolveResourceConfig({ root, declared, persisted })

  // persisted > file > declared > defaults, per key.
  assert.equal(config.workers.softMax, 2, 'the persisted layer wins')
  assert.equal(config.resources.ramReservePercent, 35, 'the user file wins over the declaration')
  assert.equal(config.scaling.scaleDownDelaySeconds, 90)
  assert.equal(config.resources.cpuReservePercent, 30, 'a key only the declaration sets is kept')
  assert.equal(config.scaling.scaleUpDelaySeconds, 40)
  assert.equal(config.runtime.heartbeatSeconds, 5, 'untouched keys stay at the default')
  assert.equal(config.workers.min, 1)

  assert.equal(source.file, path.join(root, 'config', 'hns-resource.yaml'))
  assert.equal(source.fileFormat, 'yaml')
  assert.equal(source.fileUsed, true)
  assert.equal(source.fileMissing, false)
  assert.deepEqual(source.fileErrors, [])
})

test('a declared layer alone and a persisted layer alone both resolve', () => {
  const root = scratch('layers')
  const declaredOnly = resolveResourceConfig({ root, declared: { workers: { hardMax: 4 }, thermal: { enabled: false } } })
  assert.equal(declaredOnly.config.workers.hardMax, 4)
  assert.equal(declaredOnly.config.thermal.enabled, false)
  assert.equal(declaredOnly.config.workers.softMax, 'auto')

  const persistedOnly = resolveResourceConfig({ root, persisted: { resources: { ram_reserve_percent: 45 } } })
  assert.equal(persistedOnly.config.resources.ramReservePercent, 45)
  assert.equal(persistedOnly.config.thermal.enabled, true)

  // Without any user layer the resolved configuration is the documented default.
  const bare = resolveResourceConfig({ root })
  assert.deepEqual(bare.config.workers, defaultResourceConfig().workers)
  assert.equal(bare.config.resources.ramReserveMinGb, 4)
})

test('the safety clamps survive a user override (plan §27, §44)', () => {
  const clamps = [
    // §5: the RAM reserve may be lowered to 2 GB but never below it.
    [{ resources: { ram_reserve_min_gb: 0 } }, 'resources', 'ramReserveMinGb', 2],
    [{ resources: { ram_reserve_min_gb: 0.5 } }, 'resources', 'ramReserveMinGb', 2],
    [{ resources: { ram_reserve_min_gb: -5 } }, 'resources', 'ramReserveMinGb', 2],
    [{ resources: { ram_reserve_min_gb: 500 } }, 'resources', 'ramReserveMinGb', 64],
    // A heartbeat faster than one second would be a busy loop, not a health check.
    [{ runtime: { heartbeat_seconds: 0 } }, 'runtime', 'heartbeatSeconds', 1],
    [{ runtime: { heartbeat_seconds: -10 } }, 'runtime', 'heartbeatSeconds', 1],
    [{ runtime: { heartbeat_seconds: 100000 } }, 'runtime', 'heartbeatSeconds', 300],
    [{ runtime: { worker_timeout_seconds: 1 } }, 'runtime', 'workerTimeoutSeconds', 30],
    [{ runtime: { hang_detection_seconds: 0 } }, 'runtime', 'hangDetectionSeconds', 10],
    // Reserves stay percentages, never absolute nonsense.
    [{ resources: { cpu_reserve_percent: 100 } }, 'resources', 'cpuReservePercent', 80],
    [{ resources: { ram_reserve_percent: 0 } }, 'resources', 'ramReservePercent', 5],
    [{ resources: { disk_free_reserve_percent: 1 } }, 'resources', 'diskFreeReservePercent', 5],
    [{ resources: { disk_free_reserve_percent: 90 } }, 'resources', 'diskFreeReservePercent', 50],
    // Scaling steps and delays stay inside the documented band.
    [{ scaling: { scale_up_step: 0 } }, 'scaling', 'scaleUpStep', 1],
    [{ scaling: { scale_down_step: 99 } }, 'scaling', 'scaleDownStep', 8],
    // Item 1: the anti-flap floor for both scaling delays is one second, so a
    // user who wants fast scaling (or a test) is not silently pushed to 5 s.
    [{ scaling: { scale_up_delay_seconds: 0 } }, 'scaling', 'scaleUpDelaySeconds', 1],
    [{ scaling: { scale_up_delay_seconds: 1 } }, 'scaling', 'scaleUpDelaySeconds', 1],
    [{ scaling: { scale_down_delay_seconds: 0 } }, 'scaling', 'scaleDownDelaySeconds', 1],
    [{ scaling: { scale_down_delay_seconds: 1 } }, 'scaling', 'scaleDownDelaySeconds', 1],
    [{ scaling: { scale_up_delay_seconds: 999999 } }, 'scaling', 'scaleUpDelaySeconds', 3600],
    [{ scaling: { scale_down_delay_seconds: 999999 } }, 'scaling', 'scaleDownDelaySeconds', 3600],
    // Item 3: the idle-surplus grace never becomes zero (that would flap) or absurd.
    [{ scaling: { idle_down_grace_seconds: 0 } }, 'scaling', 'idleDownGraceSeconds', 1],
    [{ scaling: { idle_down_grace_seconds: -30 } }, 'scaling', 'idleDownGraceSeconds', 1],
    [{ scaling: { idle_down_grace_seconds: 999999 } }, 'scaling', 'idleDownGraceSeconds', 3600],
    [{ external_service: { api_concurrency_limit: 0 } }, 'externalService', 'apiConcurrencyLimit', 1],
    [{ external_service: { api_concurrency_limit: 1000 } }, 'externalService', 'apiConcurrencyLimit', 64],
    [{ speculative_execution: { max_duplicates: 1 } }, 'speculativeExecution', 'maxDuplicates', 2],
    [{ speculative_execution: { max_duplicates: 9 } }, 'speculativeExecution', 'maxDuplicates', 4],
    [{ battery: { on_battery_soft_max: 0 } }, 'battery', 'onBatterySoftMax', 1],
    [{ battery: { on_battery_soft_max: 50 } }, 'battery', 'onBatterySoftMax', 8]
  ]
  for (const [layer, section, key, expected] of clamps) {
    const config = finalizeResourceConfig(mergeLayer(defaultResourceConfig(), layer))
    assert.equal(config[section][key], expected, `${section}.${key} for ${JSON.stringify(layer)} must be clamped to ${expected}`)
  }
})

test('a worker maximum can never exceed the hard maximum or the sanity ceiling', () => {
  const above = finalizeResourceConfig(mergeLayer(defaultResourceConfig(), { workers: { hard_max: 4, soft_max: 9 } }))
  assert.equal(above.workers.hardMax, 4)
  assert.equal(above.workers.softMax, 4, 'softMax <= hardMax')

  const huge = finalizeResourceConfig(mergeLayer(defaultResourceConfig(), { workers: { hard_max: 999 } }))
  assert.equal(huge.workers.hardMax, 64, 'hardMax <= 64')

  const bothAuto = finalizeResourceConfig(mergeLayer(defaultResourceConfig(), { workers: { soft_max: 'auto', hard_max: 3 } }))
  assert.equal(bothAuto.workers.softMax, 'auto', '`auto` is left for the hardware ceiling to resolve')
  assert.equal(bothAuto.workers.hardMax, 3)

  const zero = finalizeResourceConfig(mergeLayer(defaultResourceConfig(), { workers: { min: 0 } }))
  assert.equal(zero.workers.min, 1)
  const absurd = finalizeResourceConfig(mergeLayer(defaultResourceConfig(), { workers: { min: 999 } }))
  assert.equal(absurd.workers.min, 64)
})

test('a boolean switch only accepts a boolean-shaped value', () => {
  assert.equal(normalizeBoolean(undefined, true), true, 'an absent key keeps the previous layer')
  assert.equal(normalizeBoolean(null, false), false)
  assert.equal(normalizeBoolean(true, false), true)
  assert.equal(normalizeBoolean(false, true), false)
  assert.equal(normalizeBoolean('yes', false), true)
  assert.equal(normalizeBoolean('off', true), false)
  assert.equal(normalizeBoolean('maybe', true), true, 'an unreadable value never flips the switch')
  assert.equal(normalizeBoolean([], false), false)
  // A quoted YAML string is coerced like its bare equivalent, so a user file
  // may write either `enabled: true` or `enabled: "true"`.
  assert.equal(normalizeBoolean('true', false), true)
  assert.equal(mergeLayer(defaultResourceConfig(), { scaling: { enabled: 'true' } }).scaling.enabled, true)

  const merged = mergeLayer(defaultResourceConfig(), { scaling: { enabled: 'no' }, thermal: { enabled: 0 }, safety: { enable_safe_mode: 1 } })
  assert.equal(merged.scaling.enabled, false)
  assert.equal(merged.thermal.enabled, false)
  assert.equal(merged.safety.enableSafeMode, true)

  const nonsense = mergeLayer(defaultResourceConfig(), { scaling: { enabled: 'perhaps' } })
  assert.equal(nonsense.scaling.enabled, true, 'a nonsense switch keeps the safe default')
})

test('an unknown storage class is replaced by the documented assumption', () => {
  const unknown = finalizeResourceConfig(mergeLayer(defaultResourceConfig(), { storage: { assume_when_unknown: 'floppy' } }))
  assert.equal(unknown.storage.assumeWhenUnknown, 'sata_ssd')
  const chosen = finalizeResourceConfig(mergeLayer(defaultResourceConfig(), { storage: { assume_when_unknown: 'hdd' } }))
  assert.equal(chosen.storage.assumeWhenUnknown, 'hdd')
})

test('a malformed config/hns-resource.yaml degrades to the previous layer', () => {
  const declared = { workers: { hardMax: 5 }, resources: { cpuReservePercent: 30 } }
  const logged = []

  const yamlBroken = scratch('broken-yaml', '---\nworkers:\n  soft_max: 3\n')
  const broken = resolveResourceConfig({ root: yamlBroken, declared, log: (line) => logged.push(String(line)) })
  assert.equal(broken.source.fileUsed, false, 'a rejected file is never used')
  assert.equal(broken.source.file, path.join(yamlBroken, 'config', 'hns-resource.yaml'))
  assert.equal(broken.source.fileFormat, 'yaml')
  assert.ok(broken.source.fileErrors.length > 0, 'the reason must be reported to the user')
  assert.match(broken.source.fileErrors.join('; '), /multi-document streams are not supported/)
  assert.equal(broken.source.fileMissing, false, 'item 2: the file exists, it is simply unusable')
  assert.equal(broken.config.workers.softMax, 'auto', 'the declaration/default layer survives')
  assert.equal(broken.config.workers.hardMax, 5)
  assert.equal(broken.config.resources.cpuReservePercent, 30)
  assert.ok(logged.some((line) => /hns-resource\.yaml could not be used/.test(line)), 'the degradation is logged')

  const jsonBroken = scratch('broken-json', '{"workers": }')
  const brokenJson = resolveResourceConfig({ root: jsonBroken })
  assert.equal(brokenJson.source.fileUsed, false)
  assert.equal(brokenJson.source.fileFormat, 'json')
  assert.equal(brokenJson.source.fileMissing, false)
  assert.match(brokenJson.source.fileErrors.join('; '), /invalid JSON/)
  assert.equal(brokenJson.config.workers.softMax, 'auto')

  // A file with an unsupported tag is refused the same way, with no throw.
  const tagged = scratch('tagged', 'value: !!str 3\n')
  let taggedResult = null
  assert.doesNotThrow(() => { taggedResult = resolveResourceConfig({ root: tagged }) })
  assert.equal(taggedResult.source.fileUsed, false)
  assert.equal(taggedResult.source.fileMissing, false)
  assert.match(taggedResult.source.fileErrors.join('; '), /explicit tags are not supported/)
})

test('a missing config/hns-resource.yaml is not an error condition', () => {
  const root = scratch('absent')
  const { config, source } = resolveResourceConfig({ root })
  assert.equal(source.file, null, 'no file is claimed when there is none')
  assert.equal(source.fileUsed, false)
  assert.equal(source.fileFormat, null)
  assert.equal(source.fileMissing, true, 'the default installation is reported as "no file yet"')
  assert.deepEqual(source.fileErrors, [], 'item 2: an absent optional file must not be reported as an error')
  assert.deepEqual(config.workers, defaultResourceConfig().workers)
  assert.equal(config.scaling.idleDownGraceSeconds, 10)
})

test('the documented override snippet from §27 is honoured end to end', () => {
  const root = scratch('override', [
    'workers:',
    '  min: 1',
    '  soft_max: auto',
    '  hard_max: 6',
    '',
    'resources:',
    '  reserve_ram_percent: 20',
    '  reserve_cpu_percent: 20',
    '',
    'thermal:',
    '  enabled: true',
    '',
    'adaptive_scaling:',
    '  enabled: true',
    '',
    'speculative_execution:',
    '  enabled: true',
    ''
  ].join('\n'))
  const { config, source } = resolveResourceConfig({ root, persisted: { workers: { min: 2 } } })
  assert.equal(source.fileUsed, true)
  assert.equal(config.workers.min, 2, 'the persisted layer still wins over the file')
  assert.equal(config.workers.hardMax, 6, '§27: a user may raise hard_max')
  assert.equal(config.workers.softMax, 'auto')
  assert.equal(config.thermal.enabled, true)
  assert.equal(config.scaling.enabled, true)
  assert.equal(config.speculativeExecution.enabled, true)
})

test('a hostile user file is clamped instead of trusted', () => {
  const root = scratch('hostile', [
    'workers:',
    '  min: 0',
    '  soft_max: 900',
    '  hard_max: 999',
    'resources:',
    '  reserve_ram_percent: 0',
    '  reserve_cpu_percent: 100',
    '  ram_reserve_min_gb: 0',
    'runtime:',
    '  heartbeat_seconds: 0',
    '  worker_timeout_seconds: 0',
    'speculative_execution:',
    '  max_duplicates: 99',
    'scaling:',
    '  idle_down_grace_seconds: 0',
    ''
  ].join('\n'))
  const { config, source } = resolveResourceConfig({ root })
  assert.equal(source.fileUsed, true)

  assert.equal(config.workers.min, 1)
  assert.equal(config.workers.hardMax, 64, 'hardMax is capped at the sanity ceiling')
  assert.equal(config.workers.softMax, 64, 'and softMax may not exceed hardMax')
  assert.equal(config.resources.ramReserveMinGb, 2, 'the RAM reserve never drops below 2 GB')
  assert.equal(config.resources.ramReservePercent, 5)
  assert.equal(config.resources.cpuReservePercent, 80)
  assert.equal(config.runtime.heartbeatSeconds, 1, 'heartbeatSeconds is at least one second')
  assert.equal(config.runtime.workerTimeoutSeconds, 30)
  assert.equal(config.speculativeExecution.maxDuplicates, 4)
  assert.equal(config.scaling.idleDownGraceSeconds, 1, 'the idle grace never becomes zero')
})

test('roleProfile prefers a learned profile and falls back to the seed', () => {
  // Item 2: learning is a refinement of the documented seed, never a replacement.
  assert.equal(LEARNED_MIN_SAMPLES, 3)
  assert.deepEqual(LEARNED_RAM_BAND, { min: 0.5, max: 4 })
  assert.deepEqual(LEARNED_CPU_BAND, { min: 0.5, max: 3 })

  const codeSeed = DEFAULT_ROLE_PROFILES.code
  const buildSeed = DEFAULT_ROLE_PROFILES.build

  const seed = roleProfile('build')
  assert.equal(seed.role, 'build')
  assert.equal(seed.source, 'seed')
  assert.equal(seed.samples, 0)
  assert.equal(seed.ram_estimate_mb, buildSeed.ram_estimate_mb)
  assert.equal(seed.cpu_weight, buildSeed.cpu_weight)

  // (a) Below LEARNED_MIN_SAMPLES the seed is authoritative, whatever the
  // worker reported about itself (its own RSS is not the task's footprint).
  for (const samples of [0, 1, 2]) {
    const early = roleProfile('code', { code: { ramEstimateMb: 200, cpuWeight: 0.2, samples } })
    assert.equal(early.source, 'seed', `${samples} sample(s) must not change the profile`)
    assert.equal(early.role, 'code')
    assert.equal(early.samples, samples)
    assert.equal(early.ram_estimate_mb, codeSeed.ram_estimate_mb, `${samples} sample(s) must keep the seed RAM`)
    assert.equal(early.cpu_weight, codeSeed.cpu_weight, `${samples} sample(s) must keep the seed CPU weight`)
  }
  // A missing or unreadable sample count is never "enough".
  assert.equal(roleProfile('code', { code: { ramEstimateMb: 200, cpuWeight: 0.2 } }).source, 'seed')
  assert.equal(roleProfile('code', { code: { ramEstimateMb: 200, cpuWeight: 0.2, samples: 'many' } }).source, 'seed')
  assert.equal(roleProfile('code', { code: { ramEstimateMb: 200, cpuWeight: 0.2, samples: 'many' } }).samples, 0)

  // (b) From LEARNED_MIN_SAMPLES on, the learned value applies — but only inside
  // the documented band around the seed.
  const inside = roleProfile('code', { code: { ramEstimateMb: 1500, cpuWeight: 2, samples: 4 } })
  assert.deepEqual(inside, { role: 'code', source: 'learned', samples: 4, ram_estimate_mb: 1500, cpu_weight: 2 })
  assert.ok(inside.ram_estimate_mb >= codeSeed.ram_estimate_mb * LEARNED_RAM_BAND.min)
  assert.ok(inside.ram_estimate_mb <= codeSeed.ram_estimate_mb * LEARNED_RAM_BAND.max)
  assert.ok(inside.cpu_weight >= codeSeed.cpu_weight * LEARNED_CPU_BAND.min)
  assert.ok(inside.cpu_weight <= codeSeed.cpu_weight * LEARNED_CPU_BAND.max)

  // A value below the band is lifted to seed × min …
  const low = roleProfile('code', { code: { ramEstimateMb: 200, cpuWeight: 0.2, samples: 5 } })
  assert.equal(low.source, 'learned')
  assert.equal(low.ram_estimate_mb, codeSeed.ram_estimate_mb * LEARNED_RAM_BAND.min)
  assert.equal(low.ram_estimate_mb, 500, 'the memory guard can never be talked down to nothing')
  assert.equal(low.cpu_weight, codeSeed.cpu_weight * LEARNED_CPU_BAND.min)
  assert.equal(low.cpu_weight, 0.5)

  // … and a value above it is capped at seed × max.
  const high = roleProfile('code', { code: { ramEstimateMb: 99999, cpuWeight: 40, samples: 5 } })
  assert.equal(high.ram_estimate_mb, codeSeed.ram_estimate_mb * LEARNED_RAM_BAND.max)
  assert.equal(high.ram_estimate_mb, 4000)
  assert.equal(high.cpu_weight, codeSeed.cpu_weight * LEARNED_CPU_BAND.max)
  assert.equal(high.cpu_weight, 3)

  // The bands are relative to each role's own seed, not absolute numbers.
  const heavySeedLow = roleProfile('build', { build: { ramEstimateMb: 1, cpuWeight: 0.01, samples: 3 } })
  assert.equal(heavySeedLow.ram_estimate_mb, buildSeed.ram_estimate_mb * LEARNED_RAM_BAND.min)
  assert.equal(heavySeedLow.ram_estimate_mb, 1250)
  assert.equal(heavySeedLow.cpu_weight, buildSeed.cpu_weight * LEARNED_CPU_BAND.min)
  assert.equal(heavySeedLow.cpu_weight, 1.5)
  const heavySeedHigh = roleProfile('build', { build: { ramEstimateMb: 99999, cpuWeight: 99, samples: 3 } })
  assert.equal(heavySeedHigh.ram_estimate_mb, buildSeed.ram_estimate_mb * LEARNED_RAM_BAND.max)
  assert.equal(heavySeedHigh.ram_estimate_mb, 10000)
  assert.equal(heavySeedHigh.cpu_weight, buildSeed.cpu_weight * LEARNED_CPU_BAND.max)
  assert.equal(heavySeedHigh.cpu_weight, 9)

  // An unreadable value keeps the seed for that dimension only.
  const nonsense = roleProfile('code', { code: { ramEstimateMb: 'lots', cpuWeight: undefined, samples: 4 } })
  assert.equal(nonsense.source, 'learned')
  assert.equal(nonsense.ram_estimate_mb, codeSeed.ram_estimate_mb)
  assert.equal(nonsense.cpu_weight, codeSeed.cpu_weight)

  // A profile learned for another role must not leak into this one.
  const other = roleProfile('code', { build: { ramEstimateMb: 3000, cpuWeight: 4, samples: 9 } })
  assert.equal(other.source, 'seed')
  assert.equal(other.ram_estimate_mb, DEFAULT_ROLE_PROFILES.code.ram_estimate_mb)

  // An unknown role keeps its name but uses the fallback seed.
  const unknown = roleProfile('nope')
  assert.equal(unknown.role, 'nope')
  assert.equal(unknown.source, 'seed')
  assert.equal(unknown.ram_estimate_mb, DEFAULT_ROLE_PROFILES.generic.ram_estimate_mb)
  const empty = roleProfile(undefined)
  assert.equal(empty.role, 'generic')
  assert.equal(roleProfile('nope', null, 'test').ram_estimate_mb, DEFAULT_ROLE_PROFILES.test.ram_estimate_mb)

  for (const role of WORKER_ROLES) {
    const profile = roleProfile(role)
    assert.ok(profile.ram_estimate_mb >= 200, `${role} must estimate a realistic RAM footprint`)
    assert.ok(profile.cpu_weight >= 0.25)
  }
})
