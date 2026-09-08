'use strict'
const os = require('node:os')
const { spawnSync } = require('node:child_process')

let lastCpuSample = null
let cachedHardware = null

function cpuTimes() {
  let idle = 0
  let total = 0
  for (const c of os.cpus()) {
    idle += c.times.idle
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq
  }
  return { idle, total }
}

function cpuUsagePercent() {
  const nowSample = cpuTimes()
  if (!lastCpuSample) {
    lastCpuSample = nowSample
    return 0
  }
  const idleDelta = nowSample.idle - lastCpuSample.idle
  const totalDelta = nowSample.total - lastCpuSample.total
  lastCpuSample = nowSample
  if (totalDelta <= 0) return 0
  return Math.max(0, Math.min(100, ((totalDelta - idleDelta) / totalDelta) * 100))
}

function memoryGb(bytes) {
  return bytes / (1024 ** 3)
}

function readWindowsInventory() {
  if (process.platform !== 'win32') return { physicalCores: null, gpus: [] }
  const script = [
    '$ErrorActionPreference="SilentlyContinue"',
    '$cpu=Get-CimInstance Win32_Processor | Select-Object -First 1 Name,NumberOfCores,NumberOfLogicalProcessors',
    '$gpu=@(Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM)',
    '[pscustomobject]@{cpu=$cpu;gpu=$gpu}|ConvertTo-Json -Depth 4 -Compress'
  ].join(';')
  try {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000
    })
    if (result.status !== 0 || !result.stdout) return { physicalCores: null, gpus: [] }
    const parsed = JSON.parse(result.stdout.trim())
    const rawGpu = parsed.gpu == null ? [] : (Array.isArray(parsed.gpu) ? parsed.gpu : [parsed.gpu])
    return {
      physicalCores: Number(parsed.cpu?.NumberOfCores) || null,
      gpus: rawGpu.filter(Boolean).map((g) => ({
        name: String(g.Name || 'unknown'),
        adapterRamGb: Number.isFinite(Number(g.AdapterRAM)) && Number(g.AdapterRAM) > 0
          ? Number(memoryGb(Number(g.AdapterRAM)).toFixed(2))
          : null
      }))
    }
  } catch {
    return { physicalCores: null, gpus: [] }
  }
}

function hardwareInventory({ refresh = false } = {}) {
  if (cachedHardware && !refresh) return cachedHardware
  const cpus = os.cpus()
  const win = readWindowsInventory()
  cachedHardware = {
    cpu: {
      model: cpus[0]?.model || 'unknown',
      logicalCores: cpus.length,
      physicalCores: win.physicalCores
    },
    memory: {
      totalGb: Number(memoryGb(os.totalmem()).toFixed(2))
    },
    gpus: win.gpus,
    platform: os.platform(),
    arch: os.arch(),
    hostname: os.hostname(),
    detectedAt: Date.now()
  }
  return cachedHardware
}

function probe() {
  const hardware = hardwareInventory()
  const freeGb = memoryGb(os.freemem())
  return {
    hardware,
    cpu: {
      cores: hardware.cpu.logicalCores,
      logicalCores: hardware.cpu.logicalCores,
      physicalCores: hardware.cpu.physicalCores,
      model: hardware.cpu.model,
      usagePercent: Number(cpuUsagePercent().toFixed(1))
    },
    memory: {
      totalGb: hardware.memory.totalGb,
      freeGb: Number(freeGb.toFixed(2)),
      usedPercent: Number(((1 - os.freemem() / os.totalmem()) * 100).toFixed(1))
    },
    uptimeSeconds: Math.floor(os.uptime())
  }
}

function computeMaxConcurrent(sys, config = {}) {
  const logical = Math.max(1, Number(sys.cpu?.logicalCores || sys.cpu?.cores || 1))
  const usage = Math.max(0, Math.min(100, Number(sys.cpu?.usagePercent || 0)))
  const freeGb = Math.max(0, Number(sys.memory?.freeGb || 0))

  const minRequested = Math.max(1, Number(config.minConcurrent || 1))
  const manualCap = Math.max(0, Number(config.maxConcurrent || 0))
  const cpuReservePercent = Math.max(5, Math.min(80, Number(config.cpuReservePercent || 25)))
  const memoryReserveGb = Math.max(0.5, Number(config.memoryReserveGb || 2))
  const memoryPerWorkerGb = Math.max(0.5, Number(config.memoryPerWorkerGb || 2.5))

  // DSH workers are mostly API/network bound, so half the logical cores is a
  // conservative static ceiling. Runtime CPU pressure then scales that down.
  const byCpuStatic = Math.max(1, Math.floor(logical / 2))
  const usableCpuPercent = Math.max(10, 100 - usage - cpuReservePercent)
  const byCpuLoad = Math.max(1, Math.floor(byCpuStatic * (usableCpuPercent / Math.max(10, 100 - cpuReservePercent))))
  const ramBudget = Math.max(0, freeGb - memoryReserveGb)
  const byRam = Math.max(1, Math.floor(ramBudget / memoryPerWorkerGb))
  const hardwareCap = Math.max(1, Math.min(byCpuStatic, byRam))
  const adaptiveSuggested = Math.max(1, Math.min(byCpuLoad, byRam))
  const cap = manualCap > 0 ? Math.min(hardwareCap, manualCap) : hardwareCap
  const current = Math.max(1, Math.min(cap, Math.max(minRequested, adaptiveSuggested)))

  return {
    mode: 'hardware-auto',
    minRequested,
    manualCap,
    byCpuStatic,
    byCpuLoad,
    byRam,
    hardwareCap,
    adaptiveSuggested,
    current,
    cpuUsagePercent: usage,
    freeMemoryGb: freeGb,
    cpuReservePercent,
    memoryReserveGb,
    memoryPerWorkerGb
  }
}

module.exports = { probe, hardwareInventory, cpuUsagePercent, computeMaxConcurrent }
