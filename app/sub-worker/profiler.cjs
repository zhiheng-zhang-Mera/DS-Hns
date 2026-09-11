'use strict'

/**
 * Host Hardware Profiler and Runtime Capability Probe (plan §3, §4, §5, §7, §8,
 * §9, §26, §28, §44).
 *
 * Two distinct concepts, never mixed:
 *   Hardware Ceiling  — what this machine could carry (detected at install/first
 *                       run, persisted, essentially static).
 *   Runtime Ceiling   — what HNS may actually use right now (sampled
 *                       continuously by the Resource Monitor, see resources.cjs).
 *
 * Every probe degrades gracefully: an unavailable sensor is reported as
 * `available: false` with the fallback that was used, and can never stop HNS
 * from running (plan §9).
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const { INSTALLATION_TIERS, STORAGE_IO_LIMIT, WORKSTATION_NVME_IO_LIMIT, defaultResourceConfig } = require('./resource-config.cjs')
const { writeJsonFile, readJsonFile } = require('./state.cjs')

const FACTS_TTL_MS = 60_000
// Probes are bounded tightly: the supervisor must never spend seconds in a
// shell at startup, and every signal has a cheaper fallback.
const PROBE_TIMEOUT_MS = 5_000

/** Seeds used only until the first real measurement (plan §45 defaults). */
const RAM_PER_WORKER_GB_CONSERVATIVE = 2.5
const CPU_CORE_FACTOR = 0.6 // inside the documented 0.5–0.75 band (§4)

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function round(value, digits = 2) {
  const factor = 10 ** digits
  return Math.round(Number(value) * factor) / factor
}

function gb(bytes) {
  return round(Number(bytes) / (1024 ** 3), 2)
}

function mb(bytes) {
  return Math.round(Number(bytes) / (1024 ** 2))
}

function powershellExe() {
  return path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/**
 * One batched WMI/CIM inventory round-trip.
 *
 * Batching matters: a single PowerShell process is ~200 ms, and probing seven
 * sensors separately would cost seconds on every start. The slow Storage-module
 * class (`Get-PhysicalDisk`) is deliberately NOT part of this batch — it can
 * block for many seconds on some machines — and is asked for separately by
 * `probeStorageClass` only when the fast inventory did not classify the disks.
 */
function probeWindowsFacts({ timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$out = [ordered]@{}
$out.cpu = Get-CimInstance Win32_Processor | Select-Object -First 1 Name, NumberOfCores, NumberOfLogicalProcessors, MaxClockSpeed, CurrentClockSpeed, Architecture
$out.os = Get-CimInstance Win32_OperatingSystem | Select-Object -First 1 TotalVisibleMemorySize, FreePhysicalMemory, TotalVirtualMemorySize, FreeVirtualMemory
$out.diskDrives = @(Get-CimInstance Win32_DiskDrive | Select-Object Model, MediaType, InterfaceType, Size)
$out.video = @(Get-CimInstance Win32_VideoController | Select-Object Name, AdapterRAM, DriverVersion)
$out.battery = Get-CimInstance Win32_Battery | Select-Object -First 1 BatteryStatus, EstimatedChargeRemaining
$out.pageFile = Get-CimInstance Win32_PageFileUsage | Select-Object -First 1 AllocatedBaseSize, CurrentUsage
$out | ConvertTo-Json -Depth 4 -Compress
`
  return runPowershellJson(script, timeoutMs)
}

/** The slower Storage-module inventory, requested only when it is needed. */
function probeStorageClass({ timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
@(Get-PhysicalDisk | Select-Object FriendlyName, MediaType, BusType, Size) | ConvertTo-Json -Depth 3 -Compress
`
  const result = runPowershellJson(script, timeoutMs)
  if (!result.ok) return result
  const disks = Array.isArray(result.facts) ? result.facts : (result.facts ? [result.facts] : [])
  return { ok: disks.length > 0, disks, error: disks.length ? null : 'the Storage module reported no disk' }
}

function runPowershellJson(script, timeoutMs) {
  const result = spawnSync(powershellExe(), ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024
  })
  if (result.error) return { ok: false, error: String(result.error.message || result.error) }
  const text = String(result.stdout || '').trim()
  if (!text) return { ok: false, error: 'the Windows inventory probe returned no output' }
  try {
    return { ok: true, facts: JSON.parse(text), error: null }
  } catch (error) {
    return { ok: false, error: `the Windows inventory probe returned unparsable output: ${error?.message || error}` }
  }
}

/** NVIDIA VRAM, when the driver tools are present (plan §7). */
function probeNvidiaSmi({ timeoutMs = 4000 } = {}) {
  const result = spawnSync('nvidia-smi', ['--query-gpu=name,memory.total,memory.used', '--format=csv,noheader,nounits'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: timeoutMs
  })
  if (result.error || result.status !== 0) return { ok: false, error: 'nvidia-smi is unavailable' }
  const gpus = []
  for (const line of String(result.stdout || '').split(/\r?\n/)) {
    const parts = line.split(',').map((part) => part.trim())
    if (parts.length < 3 || !parts[0]) continue
    gpus.push({
      name: parts[0],
      vram_total_gb: round(Number(parts[1]) / 1024, 2),
      vram_used_gb: round(Number(parts[2]) / 1024, 2),
      source: 'nvidia-smi'
    })
  }
  return gpus.length ? { ok: true, gpus } : { ok: false, error: 'nvidia-smi reported no GPU' }
}

/**
 * Classify storage into the three classes plan §8 distinguishes.
 *
 * Careful: Windows reports `MediaType = "Fixed hard disk media"` for EVERY fixed
 * disk — including SATA SSDs and NVMe — so that value must never be read as
 * "rotating disk". An inconclusive inventory returns `unknown`, and the caller
 * falls back to the Storage module and then to measured latency.
 */
function classifyStorage(diskFacts) {
  const entries = [
    ...(Array.isArray(diskFacts.physicalDisks) ? diskFacts.physicalDisks : []),
    ...(Array.isArray(diskFacts.diskDrives) ? diskFacts.diskDrives : [])
  ]
  if (!entries.length) return { storage_class: 'unknown', reason: 'no disk inventory was available' }
  const text = entries
    .map((entry) => `${entry.MediaType || ''} ${entry.BusType || ''} ${entry.InterfaceType || ''} ${entry.Model || ''} ${entry.FriendlyName || ''}`)
    .join(' ')
    .toLowerCase()
  if (/nvme|non-volatile memory/.test(text)) return { storage_class: 'nvme', reason: 'an NVMe device was reported' }
  if (/\bssd\b|solid state|solid-state/.test(text)) return { storage_class: 'sata_ssd', reason: 'a solid state device was reported' }
  if (/external hard disk|removable media|\bhdd\b|rotational|spindle/.test(text)) {
    return { storage_class: 'hdd', reason: 'a rotating/external disk was reported' }
  }
  return {
    storage_class: 'unknown',
    reason: `the disk inventory was inconclusive ("fixed hard disk media" is generic and does not imply a rotating disk): ${text.slice(0, 120)}`
  }
}

/** Fallback storage classification from a measured write latency (plan §8, §9). */
function classifyStorageFromLatency(latency, { io = {} } = {}) {
  if (!latency || latency.available !== true || !Number.isFinite(Number(latency.write_ms))) {
    return { storage_class: 'unknown', reason: 'no latency measurement was available' }
  }
  const nvmeMs = Number(io.latencyNvmeMs) || 4
  const slowMs = Number(io.latencySlowMs) || 25
  const writeMs = Number(latency.write_ms)
  if (writeMs <= nvmeMs) return { storage_class: 'nvme', reason: `measured 256 KiB write+fsync latency ${writeMs} ms` }
  if (writeMs <= slowMs) return { storage_class: 'sata_ssd', reason: `measured 256 KiB write+fsync latency ${writeMs} ms` }
  return { storage_class: 'hdd', reason: `measured 256 KiB write+fsync latency ${writeMs} ms` }
}

/** The installation tier a machine falls into (plan §26). */
function classifyTier({ physicalCores, logicalCores, ramTotalGb }) {
  const cores = Math.max(physicalCores || 0, Math.ceil((logicalCores || 0) / 2))
  // A nominal 32 GB machine reports ~31.7 GB to the OS, so a 1 GB tolerance
  // keeps the documented tiers reachable on real hardware.
  const ram = Number(ramTotalGb) || 0
  const ordered = ['workstation', 'high', 'standard', 'low']
  for (const name of ordered) {
    const tier = INSTALLATION_TIERS[name]
    if (cores >= tier.minCores && ram >= tier.minRamGb - 1) return { name, ...tier }
  }
  return { name: 'low', ...INSTALLATION_TIERS.low }
}

/**
 * Derive the Hardware Ceiling from facts (plan §3.1, §4, §5, §8, §26, §44).
 * The result is a *ceiling*: the scheduler never starts from it.
 */
function hardwareCeiling(facts, { config = defaultResourceConfig() } = {}) {
  const cpu = isPlainObject(facts.cpu) ? facts.cpu : {}
  const logicalCores = Number(cpu.logicalCores) || os.cpus().length || 1
  const physicalCores = Number(cpu.physicalCores) || Math.max(1, Math.round(logicalCores / 2))
  const ramTotalGb = Number(facts.ram_total_gb) || gb(os.totalmem())
  const reservePercent = Number(config.resources.ramReservePercent) || 20
  const reserveMinGb = Number(config.resources.ramReserveMinGb) || 4
  // Plan §5: the reserve is max(20% of RAM, 4 GB) — the LARGER of the two, not
  // both at once, and virtual memory is never counted as usable RAM.
  const reserveGb = Math.max(round(ramTotalGb * (reservePercent / 100), 2), reserveMinGb)
  const usableRamGb = Math.max(0, round(ramTotalGb - reserveGb, 2))
  const tier = classifyTier({ physicalCores, logicalCores, ramTotalGb })
  const storageClass = facts.storage_class || 'unknown'

  const cpuCeiling = Math.max(1, Math.floor(physicalCores * CPU_CORE_FACTOR))
  const ramCeiling = Math.max(1, Math.floor(usableRamGb / RAM_PER_WORKER_GB_CONSERVATIVE))
  const ioCeiling = storageClass === 'nvme' && tier.name === 'workstation'
    ? WORKSTATION_NVME_IO_LIMIT
    : (STORAGE_IO_LIMIT[storageClass] || STORAGE_IO_LIMIT.unknown)
  const maxRecommended = Math.max(1, Math.min(cpuCeiling, ramCeiling, ioCeiling, tier.maxRecommendedWorkers))

  return {
    logical_cpu_threads: logicalCores,
    physical_cpu_cores: physicalCores,
    cpu_architecture: process.arch,
    cpu_model: cpu.model || (os.cpus()[0]?.model || 'unknown'),
    cpu_base_frequency_mhz: Number(cpu.maxClockMhz) || null,
    ram_total_gb: ramTotalGb,
    gpu_vram_gb: Number(facts.gpu_vram_gb) || 0,
    storage_type: storageClass,
    reserved_ram_gb: reserveGb,
    usable_ram_gb: usableRamGb,
    ceilings: {
      cpu: cpuCeiling,
      ram: ramCeiling,
      io: ioCeiling,
      tier: tier.maxRecommendedWorkers
    },
    tier: { name: tier.name, label: tier.label },
    max_recommended_workers: maxRecommended
  }
}

/**
 * Build the Hardware Ceiling. `facts` may be injected (tests, or the persisted
 * profile) so the installer and the runtime share one implementation.
 */
function buildHardwareProfile({ facts = null, config = defaultResourceConfig(), log = () => {}, probed = null } = {}) {
  const source = facts || {}
  const ceiling = hardwareCeiling(source, { config })
  const pageFile = isPlainObject(source.pageFile) ? source.pageFile : null
  return {
    version: 1,
    detected_at: new Date().toISOString(),
    hostname: os.hostname(),
    platform: process.platform,
    ...ceiling,
    swap: pageFile
      ? {
        available: true,
        total_gb: round(Number(pageFile.AllocatedBaseSize) / 1024, 2),
        used_gb: round(Number(pageFile.CurrentUsage) / 1024, 2),
        note: 'virtual memory is never counted as usable RAM (plan §5)'
      }
      : { available: false, note: 'no pagefile inventory was available' },
    gpus: Array.isArray(source.gpus) ? source.gpus : [],
    degraded: Array.isArray(probed?.degraded) ? probed.degraded : []
  }
}

function hardwareProfilePath(root) {
  return path.join(path.resolve(root), 'data', 'sub-worker', 'hardware-profile.json')
}

function readHardwareProfile(root) {
  const file = hardwareProfilePath(root)
  const value = readJsonFile(file, null)
  return isPlainObject(value) ? value : null
}

function writeHardwareProfile(root, profile) {
  try {
    writeJsonFile(hardwareProfilePath(root), profile)
    return hardwareProfilePath(root)
  } catch {
    return null
  }
}

/**
 * Install-time detection: probe the host once and persist the ceiling. Later
 * starts reuse the stored profile (it is a property of the machine, not of a
 * session) unless `force` is set.
 */
function ensureHardwareProfile({ root, force = false, config = defaultResourceConfig(), log = () => {}, probe = {} } = {}) {
  const existing = force ? null : readHardwareProfile(root)
  if (existing && Number(existing.max_recommended_workers) >= 1) {
    return { ok: true, profile: existing, source: 'stored', probed: { degraded: [] } }
  }
  const collected = collectFacts({ probe, log })
  const profile = buildHardwareProfile({ facts: collected.facts, config, log, probed: collected })
  const file = writeHardwareProfile(root, profile)
  log(`[profiler] hardware ceiling: ${profile.tier.label} · cpu ${profile.ceilings.cpu} / ram ${profile.ceilings.ram} / io ${profile.ceilings.io} → max ${profile.max_recommended_workers} workers${collected.degraded.length ? ` (degraded: ${collected.degraded.join(', ')})` : ''}`)
  return { ok: true, profile, source: 'detected', probed: collected, file }
}

/**
 * Collect platform facts, degrading instead of throwing (plan §9).
 *
 * Platform probes are cached for `FACTS_TTL_MS`: the Resource Monitor samples
 * every few seconds and must never spawn a shell per sample.
 */
const factsCache = { at: 0, value: null }

function collectFacts({ probe = {}, log = () => {}, force = false, io = null, config = defaultResourceConfig() } = {}) {
  if (!force && !probe.windowsFacts && factsCache.value && Date.now() - factsCache.at < FACTS_TTL_MS) {
    return factsCache.value
  }
  const degraded = []
  const facts = {}
  const cpus = os.cpus()
  const logicalCores = cpus.length || 1
  facts.cpu = {
    model: (cpus[0]?.model || 'unknown').trim(),
    logicalCores,
    physicalCores: Math.max(1, Math.round(logicalCores / 2)),
    maxClockMhz: Number(cpus[0]?.speed) || null
  }
  facts.ram_total_gb = gb(os.totalmem())

  const windowsProbe = probe.windowsFacts ? probe.windowsFacts() : (process.platform === 'win32' ? probeWindowsFacts() : { ok: false, error: 'not Windows' })
  if (windowsProbe.ok && isPlainObject(windowsProbe.facts)) {
    const wmi = windowsProbe.facts
    if (isPlainObject(wmi.cpu)) {
      facts.cpu.model = wmi.cpu.Name || facts.cpu.model
      facts.cpu.physicalCores = Number(wmi.cpu.NumberOfCores) || facts.cpu.physicalCores
      facts.cpu.logicalCores = Number(wmi.cpu.NumberOfLogicalProcessors) || facts.cpu.logicalCores
      facts.cpu.maxClockMhz = Number(wmi.cpu.MaxClockSpeed) || facts.cpu.maxClockMhz
      facts.cpu.currentClockMhz = Number(wmi.cpu.CurrentClockSpeed) || null
      facts.cpu.wmiArchitecture = wmi.cpu.Architecture ?? null
    }
    facts.pageFile = wmi.pageFile || null
    if (isPlainObject(wmi.os)) {
      const visibleKb = Number(wmi.os.TotalVisibleMemorySize)
      if (Number.isFinite(visibleKb) && visibleKb > 0) facts.ram_visible_gb = round(visibleKb / 1024 / 1024, 2)
    }
    const storage = classifyStorage(wmi)
    facts.storage_class = storage.storage_class
    facts.storage_reason = storage.reason
    facts.disks = [...(wmi.physicalDisks || []), ...(wmi.diskDrives || [])].slice(0, 8)
    facts.gpu_vram_gb = 0
    facts.gpus = []
    for (const card of Array.isArray(wmi.video) ? wmi.video : []) {
      const vram = Number(card.AdapterRAM) > 0 ? round(Number(card.AdapterRAM) / (1024 ** 3), 2) : 0
      facts.gpus.push({ name: String(card.Name || 'unknown'), vram_total_gb: vram, source: 'win32_video_controller' })
      facts.gpu_vram_gb = Math.max(facts.gpu_vram_gb, vram)
    }
    const battery = isPlainObject(wmi.battery) ? wmi.battery : null
    if (battery) {
      const status = Number(battery.BatteryStatus)
      facts.battery = {
        available: true,
        status,
        on_battery: status === 1 || status === 4 || status === 5,
        percent: Number(battery.EstimatedChargeRemaining) || null
      }
    }
    const thermal = isPlainObject(wmi.thermal) ? Number(wmi.thermal.CurrentTemperature) : NaN
    if (Number.isFinite(thermal) && thermal > 0) {
      // The WMI class reports tenths of a Kelvin.
      facts.temperature_c = round(thermal / 10 - 273.15, 1)
      facts.temperature_source = 'MSAcpi_ThermalZoneTemperature'
    }
  } else {
    degraded.push(`windows inventory unavailable (${windowsProbe.error || 'unknown'})`)
  }

  // Storage classification, cheapest signal first: the fast inventory almost
  // never says, the measured latency always answers in microseconds, and the
  // slow Storage-module query is a last resort because it can block for seconds
  // on some machines.
  if (facts.storage_class !== 'nvme' && facts.storage_class !== 'hdd' && facts.storage_class !== 'sata_ssd') {
    const fromLatency = classifyStorageFromLatency(io, { io: config.io })
    if (fromLatency.storage_class !== 'unknown') {
      facts.storage_class = fromLatency.storage_class
      facts.storage_reason = `${fromLatency.reason} (latency fallback; the fast inventory was inconclusive)`
    } else {
      const storageProbe = probe.storageClass ? probe.storageClass() : (process.platform === 'win32' ? probeStorageClass() : { ok: false })
      if (storageProbe.ok) {
        const classified = classifyStorage({ physicalDisks: storageProbe.disks })
        if (classified.storage_class !== 'unknown') {
          facts.storage_class = classified.storage_class
          facts.storage_reason = classified.reason
          facts.disks = [...(facts.disks || []), ...storageProbe.disks].slice(0, 12)
        }
      }
      if (facts.storage_class !== 'nvme' && facts.storage_class !== 'hdd' && facts.storage_class !== 'sata_ssd') {
        facts.storage_class = 'unknown'
        facts.storage_reason = facts.storage_reason || fromLatency.reason
      }
    }
  }

  if (process.platform !== 'win32') degraded.push('non-Windows host: only CPU and RAM facts are available')
  if (!facts.battery) degraded.push('battery state unavailable')
  if (facts.temperature_c === undefined) degraded.push('CPU temperature unavailable (falls back to utilization/frequency)')
  if (!facts.storage_class || facts.storage_class === 'unknown') degraded.push('storage class unavailable')

  const nvidia = probe.nvidiaSmi ? probe.nvidiaSmi() : (process.platform === 'win32' ? probeNvidiaSmi() : { ok: false })
  if (nvidia.ok && Array.isArray(nvidia.gpus) && nvidia.gpus.length) {
    facts.gpus = nvidia.gpus
    facts.gpu_vram_gb = nvidia.gpus.reduce((max, gpu) => Math.max(max, Number(gpu.vram_total_gb) || 0), 0)
  } else if (!facts.gpus?.length) {
    facts.gpus = []
    degraded.push('VRAM measurement unavailable (no nvidia-smi and no adapter RAM)')
  }

  const result = { ok: degraded.length === 0, facts, degraded }
  if (!probe.windowsFacts) {
    factsCache.value = result
    factsCache.at = Date.now()
  }
  return result
}

/**
 * Measure disk latency with a small synchronous write/read pair.
 * Platform-independent, and the only I/O signal that is always available
 * (plan §8 asks for latency; the disk queue counter usually is not).
 */
function measureDiskLatency(dir) {
  const startedAt = Date.now()
  const file = path.join(dir, `.hns-io-probe-${process.pid}.tmp`)
  const payload = Buffer.alloc(256 * 1024, 7)
  try {
    const writeStarted = Date.now()
    const fd = fs.openSync(file, 'w')
    fs.writeSync(fd, payload, 0, payload.length, 0)
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    const writeMs = Date.now() - writeStarted
    const readStarted = Date.now()
    fs.readFileSync(file)
    const readMs = Date.now() - readStarted
    return { available: true, write_ms: writeMs, read_ms: readMs, total_ms: Date.now() - startedAt, probe: '256 KiB write+fsync+read' }
  } catch (error) {
    return { available: false, error: String(error?.message || error) }
  } finally {
    try {
      fs.rmSync(file, { force: true })
    } catch {}
  }
}

/** Disk free space, if the platform exposes it. */
function diskSpace(root) {
  try {
    if (typeof fs.statfsSync !== 'function') return { available: false, error: 'fs.statfs is unavailable on this Node build' }
    const stats = fs.statfsSync(root)
    const totalBytes = Number(stats.blocks) * Number(stats.bsize)
    const freeBytes = Number(stats.bavail) * Number(stats.bsize)
    return {
      available: true,
      total_gb: gb(totalBytes),
      free_gb: gb(freeBytes),
      free_percent: totalBytes > 0 ? round((freeBytes / totalBytes) * 100, 1) : 0
    }
  } catch (error) {
    return { available: false, error: String(error?.message || error) }
  }
}

/**
 * CPU utilization from os.cpus() tick deltas — always available, no shell.
 * The first call has no baseline and reports `available: false` so the caller
 * can wait one interval instead of inventing a number.
 */
function createCpuSampler() {
  let previous = null
  return function sample() {
    const cpus = os.cpus()
    if (!cpus.length) return { available: false, error: 'no CPU information' }
    let idle = 0
    let total = 0
    for (const cpu of cpus) {
      for (const [key, value] of Object.entries(cpu.times || {})) {
        total += Number(value) || 0
        if (key === 'idle') idle += Number(value) || 0
      }
    }
    const snapshot = { idle, total }
    const first = previous === null
    const idleDelta = previous ? idle - previous.idle : 0
    const totalDelta = previous ? total - previous.total : 0
    previous = snapshot
    if (first || totalDelta <= 0) {
      return { available: false, reason: 'warming up (no tick baseline yet)', logical_cores: cpus.length }
    }
    return {
      available: true,
      usage_percent: round(Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100)), 1),
      logical_cores: cpus.length,
      current_frequency_mhz: Number(cpus[0]?.speed) || null
    }
  }
}

/**
 * Runtime Capability Probe (plan §28): what HNS may use right now. Called once
 * per start (and then continuously by the Resource Monitor).
 */
function runtimeProbe({ root, log = () => {}, probe = {}, userActivity = null, config = defaultResourceConfig() } = {}) {
  const degraded = []
  const latency = measureDiskLatency(root)
  if (!latency.available) degraded.push('disk latency unavailable')
  // No `force`: platform facts are cached for a minute, so a start that already
  // profiled the host reuses that result instead of paying for a second shell.
  const collected = collectFacts({ probe, log, io: latency, config })
  const facts = collected.facts
  degraded.push(...collected.degraded.filter((entry) => !degraded.includes(entry)))
  const memory = {
    available: true,
    total_gb: gb(os.totalmem()),
    available_gb: gb(os.freemem()),
    used_percent: round((1 - os.freemem() / os.totalmem()) * 100, 1)
  }
  const disk = diskSpace(root)
  if (!disk.available) degraded.push('disk space unavailable')
  const temperature = facts.temperature_c !== undefined
    ? { available: true, celsius: facts.temperature_c, source: facts.temperature_source }
    : { available: false, note: 'no temperature sensor; the monitor uses utilization and frequency throttling instead' }
  const storageClass = facts.storage_class && facts.storage_class !== 'unknown'
    ? facts.storage_class
    : config.storage.assumeWhenUnknown

  return {
    at: new Date().toISOString(),
    cpu: {
      available: true,
      logical_cores: facts.cpu.logicalCores,
      physical_cores: facts.cpu.physicalCores,
      model: facts.cpu.model,
      current_frequency_mhz: facts.cpu.currentClockMhz || null,
      max_frequency_mhz: facts.cpu.maxClockMhz || null
    },
    memory,
    swap: facts.pageFile
      ? { available: true, total_gb: round(Number(facts.pageFile.AllocatedBaseSize) / 1024, 2), used_gb: round(Number(facts.pageFile.CurrentUsage) / 1024, 2) }
      : { available: false, note: 'virtual memory is never counted as usable RAM' },
    disk: { ...disk, latency, storage_class: storageClass, storage_reason: facts.storage_reason || null },
    gpu: { available: facts.gpus.length > 0, gpus: facts.gpus, vram_total_gb: facts.gpu_vram_gb || 0 },
    power: facts.battery
      ? { available: true, ...facts.battery }
      : { available: false, note: 'no battery reported: treated as mains powered' },
    temperature,
    user_activity: userActivity || { available: false, note: 'foreground user activity is not probed by default' },
    degraded
  }
}

module.exports = {
  FACTS_TTL_MS,
  PROBE_TIMEOUT_MS,
  RAM_PER_WORKER_GB_CONSERVATIVE,
  CPU_CORE_FACTOR,
  probeWindowsFacts,
  probeStorageClass,
  probeNvidiaSmi,
  classifyStorage,
  classifyStorageFromLatency,
  classifyTier,
  hardwareCeiling,
  buildHardwareProfile,
  hardwareProfilePath,
  readHardwareProfile,
  writeHardwareProfile,
  ensureHardwareProfile,
  collectFacts,
  measureDiskLatency,
  diskSpace,
  createCpuSampler,
  runtimeProbe,
  gb,
  mb
}
