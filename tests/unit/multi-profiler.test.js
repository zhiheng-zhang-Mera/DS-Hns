'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const profiler = require('../../app/sub-worker/profiler.cjs')
const {
  defaultResourceConfig,
  mergeLayer,
  finalizeResourceConfig,
  INSTALLATION_TIERS,
  STORAGE_IO_LIMIT,
  WORKSTATION_NVME_IO_LIMIT
} = require('../../app/sub-worker/resource-config.cjs')

/**
 * Host Hardware Profiler and Runtime Capability Probe (plan §3, §4, §5, §7, §8,
 * §9, §26, §28, §44).
 *
 * Every platform probe is exercised with INJECTED facts, so the calibration
 * table is verified against the documented numbers instead of against whatever
 * machine happens to run the suite. Only `measureDiskLatency`, `diskSpace` and
 * `createCpuSampler` touch the real host, and only inside a scratch directory.
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-multi-profiler-${name}-`))
  CREATED_ROOTS.push(root)
  return root
}

/** A path that exists on no machine, for the degraded paths. */
function missingDir(name) {
  return path.join(os.tmpdir(), `dsh-multi-profiler-absent-${name}-${process.pid}-${CREATED_ROOTS.length}`)
}

/** The documented Windows inventory, as `probeWindowsFacts` would return it. */
const WMI = {
  cpu: { Name: 'Injected CPU', NumberOfCores: 8, NumberOfLogicalProcessors: 16, MaxClockSpeed: 3600, CurrentClockSpeed: 3200, Architecture: 9 },
  os: { TotalVisibleMemorySize: 16777216, FreePhysicalMemory: 8388608, TotalVirtualMemorySize: 33554432, FreeVirtualMemory: 16777216 },
  diskDrives: [{ Model: 'Samsung SSD 980 PRO 1TB', MediaType: 'Fixed hard disk media', InterfaceType: 'SCSI', Size: 1000204886016 }],
  video: [{ Name: 'NVIDIA GeForce RTX 3070', AdapterRAM: 8589934592, DriverVersion: '1.2.3' }],
  battery: { BatteryStatus: 1, EstimatedChargeRemaining: 87 },
  pageFile: { AllocatedBaseSize: 16384, CurrentUsage: 2048 },
  thermal: { CurrentTemperature: 3332 }
}

const okWindows = (overrides = {}) => ({ ok: true, facts: { ...WMI, ...overrides } })

/** An injected probe triple so no test ever calls PowerShell or nvidia-smi. */
function probeOf({ windows = { ok: false, error: 'injected: no Windows inventory' }, storage = { ok: false, error: 'injected: no Storage module' }, nvidia = { ok: false, error: 'injected: no nvidia-smi' } } = {}) {
  return {
    windowsFacts: () => windows,
    storageClass: () => storage,
    nvidiaSmi: () => nvidia
  }
}

/** Injected facts for `hardwareCeiling`, independent of the host. */
function factsOf({ cores = 8, logicalCores = cores * 2, ramGb = 16, storage = 'sata_ssd', gpus = [], pageFile = null, battery = null, temperature = null } = {}) {
  return {
    cpu: { model: 'Injected CPU', physicalCores: cores, logicalCores, maxClockMhz: 3600 },
    ram_total_gb: ramGb,
    storage_class: storage,
    gpus,
    gpu_vram_gb: gpus.reduce((max, gpu) => Math.max(max, Number(gpu.vram_total_gb) || 0), 0),
    ...(pageFile ? { pageFile } : {}),
    ...(battery ? { battery } : {}),
    ...(temperature ? { temperature_c: temperature, temperature_source: 'injected' } : {})
  }
}

test('the §26 calibration table produces the documented tier and worker ceiling', () => {
  const table = [
    { label: '4 cores + 8 GB + HDD', cores: 4, ramGb: 8, storage: 'hdd', tier: 'low', max: 1, ceilings: { cpu: 2, ram: 1, io: 1, tier: 1 } },
    { label: '8 cores + 16 GB + SATA SSD', cores: 8, ramGb: 16, storage: 'sata_ssd', tier: 'standard', max: 3, ceilings: { cpu: 4, ram: 4, io: 3, tier: 3 } },
    { label: '12 cores + 32 GB + NVMe', cores: 12, ramGb: 32, storage: 'nvme', tier: 'high', max: 6, ceilings: { cpu: 7, ram: 10, io: 6, tier: 6 } },
    { label: '16 cores + 64 GB + NVMe', cores: 16, ramGb: 64, storage: 'nvme', tier: 'workstation', max: 9, ceilings: { cpu: 9, ram: 20, io: 12, tier: 12 } }
  ]
  for (const row of table) {
    const ceiling = profiler.hardwareCeiling(factsOf({ cores: row.cores, ramGb: row.ramGb, storage: row.storage }))
    assert.equal(ceiling.tier.name, row.tier, `${row.label} must be a ${row.tier} installation`)
    assert.equal(ceiling.tier.label, INSTALLATION_TIERS[row.tier].label)
    assert.equal(ceiling.max_recommended_workers, row.max, `${row.label} must recommend ${row.max} workers`)
    assert.deepEqual(ceiling.ceilings, row.ceilings, `${row.label} ceilings`)
    assert.equal(ceiling.storage_type, row.storage)
    assert.equal(ceiling.physical_cpu_cores, row.cores)
    assert.equal(ceiling.ram_total_gb, row.ramGb)
    // §43: the recommendation is the minimum over every dimension, and never a
    // claim about the running host (that is the runtime ceiling).
    assert.equal(ceiling.max_recommended_workers, Math.min(...Object.values(ceiling.ceilings)))
    assert.ok(ceiling.max_recommended_workers >= 1)
  }

  // Item 6: §26/§47 — a workstation-class NVMe host reaches the upper half of the
  // documented "Workstation: 6~12 workers" band thanks to the tier-aware I/O
  // allowance, and is then bound by its CPU ceiling rather than by I/O.
  const workstation = profiler.hardwareCeiling(factsOf({ cores: 16, ramGb: 64, storage: 'nvme' }))
  assert.equal(workstation.ceilings.io, WORKSTATION_NVME_IO_LIMIT)
  assert.equal(workstation.ceilings.io, 12)
  assert.equal(workstation.max_recommended_workers, workstation.ceilings.cpu, 'the CPU ceiling binds the workstation tier')
  assert.equal(workstation.max_recommended_workers, 9)
  assert.ok(workstation.max_recommended_workers >= 6 && workstation.max_recommended_workers <= 12, 'inside the documented 6~12 band')
  assert.ok(workstation.ceilings.tier > workstation.max_recommended_workers, 'the tier is a band, never an automatic default')

  // The raised allowance is for workstation-class NVMe hosts only.
  const highNvme = profiler.hardwareCeiling(factsOf({ cores: 12, ramGb: 32, storage: 'nvme' }))
  assert.equal(highNvme.ceilings.io, STORAGE_IO_LIMIT.nvme, 'a non-workstation host keeps the generic NVMe allowance')
  const workstationHdd = profiler.hardwareCeiling(factsOf({ cores: 16, ramGb: 64, storage: 'hdd' }))
  assert.equal(workstationHdd.tier.name, 'workstation')
  assert.equal(workstationHdd.ceilings.io, STORAGE_IO_LIMIT.hdd, 'a workstation on a slow disk is still bounded by its disk')
  assert.equal(workstationHdd.max_recommended_workers, 1)
})

test('§4: the CPU worker ceiling stays inside the documented 0.5–0.75 band of physical cores', () => {
  assert.ok(profiler.CPU_CORE_FACTOR >= 0.5 && profiler.CPU_CORE_FACTOR <= 0.75, 'the conservative factor of §4')

  // 4 → 2~3, 8 → 4~6, 12 → 6~9, 16 → 8~12 (documented examples).
  const examples = [[4, 2, 3], [8, 4, 6], [12, 6, 9], [16, 8, 12]]
  for (const [cores, low, high] of examples) {
    const { ceilings } = profiler.hardwareCeiling(factsOf({ cores, ramGb: 512, storage: 'nvme' }))
    assert.ok(ceilings.cpu >= low && ceilings.cpu <= high, `${cores} cores must allow ${low}~${high} workers, got ${ceilings.cpu}`)
  }

  for (const cores of [4, 6, 8, 12, 16, 24, 32]) {
    const { ceilings } = profiler.hardwareCeiling(factsOf({ cores, ramGb: 512, storage: 'nvme' }))
    const ratio = ceilings.cpu / cores
    assert.ok(ratio >= 0.5, `${cores} cores must not be under-used below the band (${ceilings.cpu})`)
    assert.ok(ratio <= 0.75, `${cores} cores must not be over-committed above the band (${ceilings.cpu})`)
    assert.equal(ceilings.cpu, Math.floor(cores * profiler.CPU_CORE_FACTOR))
  }

  // A tiny machine still gets a usable ceiling instead of zero workers.
  assert.equal(profiler.hardwareCeiling(factsOf({ cores: 1, logicalCores: 2, ramGb: 4, storage: 'hdd' })).ceilings.cpu, 1)
  assert.equal(profiler.hardwareCeiling(factsOf({ cores: 2, logicalCores: 4, ramGb: 4, storage: 'hdd' })).max_recommended_workers, 1)
})

test('§5: usable_ram_gb keeps max(20% of RAM, 4 GB) and never counts swap', () => {
  assert.equal(profiler.RAM_PER_WORKER_GB_CONSERVATIVE, 2.5)

  const defaultCeiling = profiler.hardwareCeiling(factsOf({ ramGb: 16, storage: 'sata_ssd' }))
  // Item 4: the reserve is max(20%, 4 GB) and is reported for the panel.
  assert.equal(defaultCeiling.reserved_ram_gb, 4, '20% of 16 GB is 3.2 GB, so the 4 GB minimum applies')
  assert.equal(defaultCeiling.usable_ram_gb, 12, '16 GB - 4 GB')
  assert.equal(defaultCeiling.usable_ram_gb, defaultCeiling.ram_total_gb - defaultCeiling.reserved_ram_gb)

  // Item 4: §5 — the reserve is the LARGER of the two, never both at once.
  const documented = [
    [4, 4, 0],
    [8, 4, 4],
    [16, 4, 12],
    [32, 6.4, 25.6],
    [64, 12.8, 51.2],
    [128, 25.6, 102.4]
  ]
  for (const [ramGb, reserveGb, usableGb] of documented) {
    const ceiling = profiler.hardwareCeiling(factsOf({ ramGb, storage: 'nvme' }))
    assert.equal(ceiling.reserved_ram_gb, reserveGb, `${ramGb} GB must reserve max(20%, 4 GB) = ${reserveGb} GB`)
    assert.equal(ceiling.usable_ram_gb, usableGb, `${ramGb} GB must leave ${usableGb} GB usable`)
    // The two reported figures agree with each other (float arithmetic, so a
    // tolerance rather than deep equality on 32 - 25.6).
    assert.ok(Math.abs(ramGb - ceiling.usable_ram_gb - reserveGb) < 1e-9, `${ramGb} GB: usable + reserved must be the total`)
    assert.ok(ceiling.usable_ram_gb >= 0, 'usable RAM is never negative')
    assert.ok(ceiling.usable_ram_gb <= ramGb)
  }

  // A 5% reserve cannot beat the 4 GB minimum on a small machine.
  const tinyReserve = finalizeResourceConfig(mergeLayer(defaultResourceConfig(), { resources: { ram_reserve_percent: 5 } }))
  const small = profiler.hardwareCeiling(factsOf({ ramGb: 16, storage: 'nvme' }), { config: tinyReserve })
  assert.equal(small.reserved_ram_gb, 4, 'max(0.8 GB, 4 GB)')
  assert.equal(small.usable_ram_gb, 12)

  // A large percentage reserve beats the minimum.
  const bigReserve = finalizeResourceConfig(mergeLayer(defaultResourceConfig(), { resources: { ram_reserve_percent: 50, ram_reserve_min_gb: 8 } }))
  const overridden = profiler.hardwareCeiling(factsOf({ ramGb: 32, storage: 'nvme' }), { config: bigReserve })
  assert.equal(overridden.reserved_ram_gb, 16, 'max(16 GB, 8 GB)')
  assert.equal(overridden.usable_ram_gb, 16, '32 GB - 16 GB')
  assert.equal(overridden.ceilings.ram, 6, 'floor(16 GB / 2.5 GB per worker)')

  // Virtual memory is never treated as usable RAM (§5).
  const withSwap = profiler.buildHardwareProfile({
    facts: factsOf({ ramGb: 16, storage: 'nvme', pageFile: { AllocatedBaseSize: 16384, CurrentUsage: 4096 } })
  })
  assert.equal(withSwap.ram_total_gb, 16)
  assert.equal(withSwap.reserved_ram_gb, 4)
  assert.equal(withSwap.usable_ram_gb, 12)
  assert.equal(withSwap.swap.available, true)
  assert.equal(withSwap.swap.total_gb, 16)
  assert.equal(withSwap.swap.used_gb, 4)
  assert.match(withSwap.swap.note, /never counted as usable RAM/)
})

test('§26: classifyTier honours both core counts and the RAM requirement', () => {
  assert.equal(profiler.classifyTier({ physicalCores: 4, logicalCores: 4, ramTotalGb: 8 }).name, 'low')
  assert.equal(profiler.classifyTier({ physicalCores: 8, logicalCores: 16, ramTotalGb: 16 }).name, 'standard')
  assert.equal(profiler.classifyTier({ physicalCores: 12, logicalCores: 24, ramTotalGb: 32 }).name, 'high')
  assert.equal(profiler.classifyTier({ physicalCores: 16, logicalCores: 32, ramTotalGb: 64 }).name, 'workstation')

  // Item 5: a nominal 32 GB machine reports ~31.7 GB to the OS, so the documented
  // tier must stay reachable: a 1 GB shortfall is tolerated, more is not.
  assert.equal(profiler.classifyTier({ physicalCores: 12, logicalCores: 24, ramTotalGb: 31.7 }).name, 'high')
  assert.equal(profiler.classifyTier({ physicalCores: 16, logicalCores: 32, ramTotalGb: 63.2 }).name, 'workstation')
  assert.equal(profiler.classifyTier({ physicalCores: 12, logicalCores: 24, ramTotalGb: 30 }).name, 'standard')
  assert.equal(profiler.classifyTier({ physicalCores: 16, logicalCores: 32, ramTotalGb: 62 }).name, 'high')

  // Cores without RAM, or RAM without cores, is not a higher tier.
  assert.equal(profiler.classifyTier({ physicalCores: 16, logicalCores: 32, ramTotalGb: 8 }).name, 'low')
  assert.equal(profiler.classifyTier({ physicalCores: 4, logicalCores: 8, ramTotalGb: 64 }).name, 'low')
  assert.equal(profiler.classifyTier({ physicalCores: 8, logicalCores: 16, ramTotalGb: 15 }).name, 'standard', '16 GB minus the 1 GB tolerance')
  assert.equal(profiler.classifyTier({ physicalCores: 8, logicalCores: 16, ramTotalGb: 14 }).name, 'low', 'below the tolerance the documented minimum still applies')

  // Without a physical core count the logical threads are halved, never doubled.
  assert.equal(profiler.classifyTier({ physicalCores: 0, logicalCores: 16, ramTotalGb: 16 }).name, 'standard')

  for (const [name, tier] of Object.entries(INSTALLATION_TIERS)) {
    if (tier.minCores === 0) continue
    const reached = profiler.classifyTier({ physicalCores: tier.minCores, logicalCores: tier.minCores * 2, ramTotalGb: tier.minRamGb })
    assert.equal(reached.name, name)
    assert.ok(reached.maxRecommendedWorkers >= 1)
    // The same tier is reached with the tolerated 1 GB shortfall…
    const tolerated = profiler.classifyTier({ physicalCores: tier.minCores, logicalCores: tier.minCores * 2, ramTotalGb: tier.minRamGb - 1 })
    assert.equal(tolerated.name, name, `${name} must tolerate a 1 GB shortfall`)
    // …but 2 GB short falls back to a lower tier.
    const short = profiler.classifyTier({ physicalCores: tier.minCores, logicalCores: tier.minCores * 2, ramTotalGb: tier.minRamGb - 2 })
    assert.notEqual(short.name, name, `${name} must not accept a 2 GB shortfall`)
  }
})

test('§8: classifyStorage never reads "Fixed hard disk media" as a rotating disk', () => {
  // The Windows bug that was fixed: every fixed disk reports this generic
  // MediaType, including SATA SSDs and NVMe devices.
  const generic = profiler.classifyStorage({
    diskDrives: [{ Model: 'WDC WD10EZEX-08WN4A0', MediaType: 'Fixed hard disk media', InterfaceType: 'SCSI', Size: 1e12 }]
  })
  assert.notEqual(generic.storage_class, 'hdd', 'a generic MediaType must never imply a rotating disk')
  assert.equal(generic.storage_class, 'unknown')
  assert.match(generic.reason, /inconclusive|generic/i)

  // ...while a real bus type or a named device is classified.
  assert.equal(profiler.classifyStorage({ physicalDisks: [{ FriendlyName: 'Generic disk', MediaType: 'Fixed hard disk media', BusType: 'NVMe' }] }).storage_class, 'nvme')
  assert.equal(profiler.classifyStorage({ diskDrives: [{ Model: 'Samsung SSD 870 EVO', MediaType: 'Fixed hard disk media', InterfaceType: 'SATA' }] }).storage_class, 'sata_ssd')
  assert.equal(profiler.classifyStorage({ diskDrives: [{ Model: 'X', MediaType: 'External hard disk media' }] }).storage_class, 'hdd')
  assert.equal(profiler.classifyStorage({ physicalDisks: [{ FriendlyName: 'X', MediaType: 'Removable media' }] }).storage_class, 'hdd')
  assert.equal(profiler.classifyStorage({ physicalDisks: [{ FriendlyName: 'rotational device' }] }).storage_class, 'hdd')

  // Both inventories are considered, and NVMe outranks a rotating disk.
  const mixed = profiler.classifyStorage({
    diskDrives: [{ MediaType: 'External hard disk media' }],
    physicalDisks: [{ FriendlyName: 'NVMe SSD', BusType: 'NVMe' }]
  })
  assert.equal(mixed.storage_class, 'nvme')
  assert.match(mixed.reason, /NVMe/)

  const empty = profiler.classifyStorage({})
  assert.equal(empty.storage_class, 'unknown')
  assert.match(empty.reason, /no disk inventory/)
  assert.equal(profiler.classifyStorage({ diskDrives: [], physicalDisks: [] }).storage_class, 'unknown')
})

test('§8/§9: classifyStorageFromLatency is the documented fallback', () => {
  const config = defaultResourceConfig()
  assert.equal(profiler.classifyStorageFromLatency({ available: true, write_ms: 2 }, { io: config.io }).storage_class, 'nvme')
  assert.equal(profiler.classifyStorageFromLatency({ available: true, write_ms: 4 }, { io: config.io }).storage_class, 'nvme')
  assert.equal(profiler.classifyStorageFromLatency({ available: true, write_ms: 5 }, { io: config.io }).storage_class, 'sata_ssd')
  assert.equal(profiler.classifyStorageFromLatency({ available: true, write_ms: 25 }, { io: config.io }).storage_class, 'sata_ssd')
  assert.equal(profiler.classifyStorageFromLatency({ available: true, write_ms: 26 }, { io: config.io }).storage_class, 'hdd')

  // Custom thresholds from the configuration are honoured.
  assert.equal(profiler.classifyStorageFromLatency({ available: true, write_ms: 3 }, { io: { latencyNvmeMs: 1, latencySlowMs: 2 } }).storage_class, 'hdd')

  // Without a measurement nothing is guessed.
  for (const latency of [null, undefined, { available: false, error: 'nope' }, { available: true }, { available: true, write_ms: 'fast' }]) {
    const result = profiler.classifyStorageFromLatency(latency, { io: config.io })
    assert.equal(result.storage_class, 'unknown', `${JSON.stringify(latency)} must stay unknown`)
    assert.match(result.reason, /no latency measurement/)
  }
})

test('collectFacts reads the injected inventory and types every fact', () => {
  const collected = profiler.collectFacts({ probe: probeOf({ windows: okWindows() }) })
  assert.equal(collected.ok, true, collected.degraded.join('; '))
  // Nothing is missing: the only note a complete inventory may still carry is
  // the platform note (a non-Windows host has no WMI at all).
  assert.deepEqual(collected.degraded.filter((entry) => !/non-Windows host/.test(entry)), [])

  const facts = collected.facts
  assert.equal(facts.cpu.model, 'Injected CPU')
  assert.equal(facts.cpu.physicalCores, 8)
  assert.equal(facts.cpu.logicalCores, 16)
  assert.equal(facts.cpu.maxClockMhz, 3600)
  assert.equal(facts.cpu.currentClockMhz, 3200)
  assert.equal(facts.ram_visible_gb, 16, 'TotalVisibleMemorySize is reported in KB')
  assert.equal(facts.storage_class, 'sata_ssd')
  assert.match(facts.storage_reason, /solid state/)
  assert.deepEqual(facts.battery, { available: true, status: 1, on_battery: true, percent: 87 })
  assert.equal(facts.temperature_c, 60.1, 'WMI reports tenths of a Kelvin')
  assert.equal(facts.temperature_source, 'MSAcpi_ThermalZoneTemperature')
  assert.equal(facts.pageFile.AllocatedBaseSize, 16384)
  assert.equal(facts.gpu_vram_gb, 8, 'adapter RAM is the VRAM fallback')
  assert.deepEqual(facts.gpus, [{ name: 'NVIDIA GeForce RTX 3070', vram_total_gb: 8, source: 'win32_video_controller' }])
  assert.deepEqual(facts.disks.map((disk) => disk.Model), ['Samsung SSD 980 PRO 1TB'])

  // Mains power is not battery power.
  const plugged = profiler.collectFacts({ probe: probeOf({ windows: okWindows({ battery: { BatteryStatus: 2, EstimatedChargeRemaining: 100 } }) }) })
  assert.equal(plugged.facts.battery.on_battery, false)

  // A measured GPU outranks the adapter total (§7).
  const withNvidia = profiler.collectFacts({
    probe: probeOf({ windows: okWindows({ video: [] }), nvidia: { ok: true, gpus: [{ name: 'RTX 4090', vram_total_gb: 24, vram_used_gb: 1, source: 'nvidia-smi' }] } })
  })
  assert.equal(withNvidia.facts.gpu_vram_gb, 24)
  assert.equal(withNvidia.facts.gpus[0].source, 'nvidia-smi')
})

test('collectFacts degrades instead of throwing when the inventory is unavailable', () => {
  const collected = profiler.collectFacts({ probe: probeOf({ windows: { ok: false, error: 'injected failure' } }) })
  assert.equal(collected.ok, false)
  assert.ok(collected.degraded.some((entry) => /windows inventory unavailable \(injected failure\)/.test(entry)))
  assert.ok(collected.degraded.some((entry) => /battery state unavailable/.test(entry)))
  assert.ok(collected.degraded.some((entry) => /temperature unavailable/.test(entry)))
  assert.ok(collected.degraded.some((entry) => /storage class unavailable/.test(entry)))
  assert.ok(collected.degraded.some((entry) => /VRAM measurement unavailable/.test(entry)))
  // The CPU and RAM facts from the platform still exist, so the run continues.
  assert.ok(collected.facts.cpu.physicalCores >= 1)
  assert.ok(Number.isFinite(collected.facts.cpu.logicalCores) && collected.facts.cpu.logicalCores >= 1)
  assert.equal(collected.facts.storage_class, 'unknown')
})

test('collectFacts falls back to the Storage module and then to measured latency', () => {
  const generic = { diskDrives: [{ Model: 'WDC WD10EZEX', MediaType: 'Fixed hard disk media' }] }

  const viaStorageModule = profiler.collectFacts({
    probe: probeOf({
      windows: okWindows(generic),
      storage: { ok: true, disks: [{ FriendlyName: 'Samsung SSD 870', MediaType: 'SSD', BusType: 'SATA' }] }
    })
  })
  assert.equal(viaStorageModule.facts.storage_class, 'sata_ssd')
  assert.ok(viaStorageModule.facts.disks.some((disk) => disk.FriendlyName === 'Samsung SSD 870'))

  const viaLatency = profiler.collectFacts({
    probe: probeOf({ windows: okWindows(generic) }),
    io: { available: true, write_ms: 2 }
  })
  assert.equal(viaLatency.facts.storage_class, 'nvme')
  assert.match(viaLatency.facts.storage_reason, /latency fallback/)

  // An inconclusive inventory with no measurement stays unknown and is reported.
  const nothing = profiler.collectFacts({ probe: probeOf({ windows: okWindows(generic) }) })
  assert.equal(nothing.facts.storage_class, 'unknown')
  assert.ok(nothing.degraded.some((entry) => /storage class unavailable/.test(entry)))

  // A known class is never second-guessed by the slower probes.
  const known = profiler.collectFacts({
    probe: probeOf({ windows: okWindows(), nvidia: { ok: true, gpus: [{ vram_total_gb: 8 }] } })
  })
  assert.equal(known.facts.storage_class, 'sata_ssd')
})

test('buildHardwareProfile turns facts into a persisted ceiling', () => {
  const profile = profiler.buildHardwareProfile({
    facts: factsOf({ cores: 12, ramGb: 32, storage: 'nvme', gpus: [{ name: 'RTX', vram_total_gb: 8 }] }),
    probed: { degraded: ['CPU temperature unavailable'] }
  })
  assert.equal(profile.version, 1)
  assert.equal(Number.isFinite(Date.parse(profile.detected_at)), true)
  assert.equal(profile.platform, process.platform)
  assert.equal(typeof profile.hostname, 'string')
  assert.equal(profile.max_recommended_workers, 6)
  assert.equal(profile.tier.name, 'high')
  assert.equal(profile.gpu_vram_gb, 8)
  assert.deepEqual(profile.gpus, [{ name: 'RTX', vram_total_gb: 8 }])
  assert.deepEqual(profile.degraded, ['CPU temperature unavailable'], 'the probe report is carried into the profile')

  const withoutSwap = profiler.buildHardwareProfile({ facts: factsOf({ ramGb: 16 }) })
  assert.equal(withoutSwap.swap.available, false)
  assert.match(withoutSwap.swap.note, /no pagefile inventory/)
  assert.deepEqual(withoutSwap.degraded, [])
})

test('a failing probe still produces a usable, degraded profile (§9, §34)', () => {
  const collected = profiler.collectFacts({ probe: probeOf({ windows: { ok: false, error: 'injected failure' } }) })
  const profile = profiler.buildHardwareProfile({ facts: collected.facts, probed: collected })
  assert.ok(profile.degraded.length > 0, 'the degradation must be visible to the user')
  assert.ok(profile.max_recommended_workers >= 1, 'HNS must keep running on a machine it cannot fully probe')
  assert.ok(profile.usable_ram_gb >= 0)
  assert.ok(profile.ceilings.io >= 1, 'an unknown disk still allows one worker')

  // Even a machine with almost nothing left keeps a worker (plan §35).
  const floorProfile = profiler.buildHardwareProfile({ facts: factsOf({ cores: 2, ramGb: 4, storage: 'hdd' }) })
  assert.equal(floorProfile.max_recommended_workers, 1)
})

test('measureDiskLatency measures and always cleans up its probe file', () => {
  const root = scratch('latency')
  const latency = profiler.measureDiskLatency(root)
  assert.equal(latency.available, true, latency.error || '')
  assert.ok(Number.isFinite(latency.write_ms) && latency.write_ms >= 0)
  assert.ok(Number.isFinite(latency.read_ms) && latency.read_ms >= 0)
  assert.ok(Number.isFinite(latency.total_ms) && latency.total_ms >= 0)
  assert.match(latency.probe, /256 KiB/)
  assert.deepEqual(fs.readdirSync(root).filter((name) => name.includes('hns-io-probe')), [], 'no probe file may survive')

  const missing = profiler.measureDiskLatency(missingDir('latency'))
  assert.equal(missing.available, false)
  assert.match(missing.error, /ENOENT|no such file/i)
})

test('diskSpace reports the free space of the target volume', () => {
  const root = scratch('disk')
  const disk = profiler.diskSpace(root)
  if (!disk.available) {
    assert.match(disk.error, /statfs/, 'the only documented reason to be unavailable')
  } else {
    assert.ok(disk.total_gb > 0)
    assert.ok(disk.free_gb >= 0)
    assert.ok(disk.free_gb <= disk.total_gb)
    assert.ok(disk.free_percent >= 0 && disk.free_percent <= 100)
  }

  const missing = profiler.diskSpace(missingDir('disk'))
  assert.equal(missing.available, false)
  assert.equal(typeof missing.error, 'string')
})

test('createCpuSampler waits for a tick baseline instead of inventing a number', () => {
  const sampler = profiler.createCpuSampler()
  const first = sampler()
  assert.equal(first.available, false, 'the first call has no baseline')
  assert.match(first.reason, /warming up/)
  assert.ok(first.logical_cores >= 1)

  let spin = 0
  for (let i = 0; i < 2e6; i += 1) spin += i
  const second = sampler()
  assert.equal(typeof second.available, 'boolean')
  if (second.available) {
    assert.ok(second.usage_percent >= 0 && second.usage_percent <= 100)
    assert.ok(second.logical_cores >= 1)
    assert.equal(typeof second.current_frequency_mhz, 'number')
  }
  assert.doesNotThrow(() => sampler())
})

test('gb and mb convert bytes without ever returning a fraction of a file', () => {
  assert.equal(profiler.gb(1024 ** 3), 1)
  assert.equal(profiler.gb(1536 * 1024 ** 2), 1.5)
  assert.equal(profiler.gb(32 * 1024 ** 3), 32)
  assert.equal(profiler.gb(1), 0)
  assert.equal(profiler.mb(1024 ** 2), 1)
  assert.equal(profiler.mb(1024 ** 3), 1024)
  assert.equal(Number.isInteger(profiler.mb(1500 * 1024)), true)
})

test('runtimeProbe describes what HNS may use right now (§28)', () => {
  const root = scratch('runtime-probe')
  const probe = profiler.runtimeProbe({ root, probe: probeOf({ windows: okWindows() }) })

  assert.equal(Number.isFinite(Date.parse(probe.at)), true)
  assert.deepEqual(probe.cpu, {
    available: true,
    logical_cores: 16,
    physical_cores: 8,
    model: 'Injected CPU',
    current_frequency_mhz: 3200,
    max_frequency_mhz: 3600
  })
  assert.equal(probe.memory.available, true)
  assert.ok(probe.memory.total_gb > 0)
  assert.ok(probe.memory.available_gb >= 0)
  assert.ok(probe.memory.used_percent >= 0 && probe.memory.used_percent <= 100)
  assert.equal(probe.swap.available, true)
  assert.equal(probe.swap.total_gb, 16)
  assert.equal(probe.disk.available, true, probe.disk.error || '')
  assert.equal(probe.disk.latency.available, true, probe.disk.latency.error || '')
  assert.equal(probe.disk.storage_class, 'sata_ssd')
  assert.equal(probe.gpu.available, true)
  assert.equal(probe.gpu.vram_total_gb, 8)
  assert.deepEqual(probe.power, { available: true, status: 1, on_battery: true, percent: 87 })
  assert.equal(probe.temperature.available, true)
  assert.equal(probe.temperature.celsius, 60.1)
  assert.equal(probe.user_activity.available, false, 'foreground activity is not probed by default')
  assert.ok(Array.isArray(probe.degraded))
  assert.equal(probe.degraded.some((entry) => /windows inventory unavailable/.test(entry)), false)

  // An injected user-activity reading is passed straight through.
  const withActivity = profiler.runtimeProbe({ root, probe: probeOf({ windows: okWindows() }), userActivity: { available: true, interactive: true } })
  assert.deepEqual(withActivity.user_activity, { available: true, interactive: true })

  // No sensor at all: the probe still answers, with the documented assumptions.
  const degraded = profiler.runtimeProbe({
    root: missingDir('runtime-probe'),
    probe: probeOf({ windows: okWindows({ diskDrives: [{ Model: 'WDC WD10EZEX', MediaType: 'Fixed hard disk media' }], video: [], thermal: null, battery: null }) })
  })
  assert.equal(degraded.disk.available, false)
  assert.equal(degraded.disk.latency.available, false)
  assert.equal(degraded.disk.storage_class, 'sata_ssd', 'an unknown disk uses config.storage.assumeWhenUnknown')
  assert.equal(degraded.power.available, false, 'no battery means mains power')
  assert.equal(degraded.gpu.available, false)
  assert.equal(degraded.temperature.available, false)
  assert.ok(degraded.degraded.includes('disk latency unavailable'))
  assert.ok(degraded.degraded.includes('disk space unavailable'))
  assert.ok(degraded.degraded.some((entry) => /storage class unavailable/.test(entry)))
  assert.equal(degraded.cpu.physical_cores, 8, 'the injected CPU facts survive')
})

test('ensureHardwareProfile detects once, persists and then reports "stored"', () => {
  const root = scratch('ensure')
  let probes = 0
  const probe = {
    windowsFacts: () => { probes += 1; return okWindows() },
    storageClass: () => ({ ok: false }),
    nvidiaSmi: () => ({ ok: true, gpus: [{ name: 'RTX', vram_total_gb: 8 }] })
  }

  assert.equal(profiler.hardwareProfilePath(root), path.join(root, 'data', 'sub-worker', 'hardware-profile.json'))
  assert.equal(profiler.readHardwareProfile(root), null, 'nothing is stored before the first detection')

  const first = profiler.ensureHardwareProfile({ root, probe })
  assert.equal(first.ok, true)
  assert.equal(first.source, 'detected')
  assert.equal(probes, 1)
  assert.equal(first.file, profiler.hardwareProfilePath(root))
  assert.equal(fs.existsSync(first.file), true, 'the ceiling is persisted under data/sub-worker')
  assert.ok(first.profile.max_recommended_workers >= 1)
  assert.equal(Number.isFinite(Date.parse(first.profile.detected_at)), true)
  assert.deepEqual(JSON.parse(fs.readFileSync(first.file, 'utf8')), first.profile, 'the stored file is the profile itself')
  assert.deepEqual(profiler.readHardwareProfile(root), first.profile)

  // The second call reuses the stored ceiling: the probe is not called at all.
  const second = profiler.ensureHardwareProfile({ root, probe: { windowsFacts: () => { throw new Error('detection must not run again') } } })
  assert.equal(second.source, 'stored')
  assert.deepEqual(second.profile, first.profile)
  assert.equal(probes, 1)

  // `force` re-detects, which is what an installer or a hardware change needs.
  const forced = profiler.ensureHardwareProfile({ root, force: true, probe })
  assert.equal(forced.source, 'detected')
  assert.equal(probes, 2)

  // A corrupt or useless stored profile is re-detected instead of trusted.
  fs.writeFileSync(profiler.hardwareProfilePath(root), '{not json', 'utf8')
  assert.equal(profiler.readHardwareProfile(root), null)
  const afterCorrupt = profiler.ensureHardwareProfile({ root, probe })
  assert.equal(afterCorrupt.source, 'detected')
  assert.equal(probes, 3)

  fs.writeFileSync(profiler.hardwareProfilePath(root), JSON.stringify({ max_recommended_workers: 0 }), 'utf8')
  assert.equal(profiler.ensureHardwareProfile({ root, probe }).source, 'detected', 'a ceiling of zero workers is not a usable profile')
  assert.equal(probes, 4)
})

test('ensureHardwareProfile survives a host it cannot probe (§9)', () => {
  const root = scratch('ensure-degraded')
  const detected = profiler.ensureHardwareProfile({ root, probe: probeOf({ windows: { ok: false, error: 'injected failure' } }) })
  assert.equal(detected.ok, true)
  assert.equal(detected.source, 'detected')
  assert.ok(detected.profile.degraded.length > 0)
  assert.ok(detected.profile.max_recommended_workers >= 1)
  assert.equal(fs.existsSync(path.join(root, 'data', 'sub-worker', 'hardware-profile.json')), true)
  assert.deepEqual(profiler.ensureHardwareProfile({ root }).source, 'stored')
})
