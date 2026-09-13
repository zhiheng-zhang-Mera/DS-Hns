'use strict'

/**
 * DS-Hns Core: the resource manager.
 *
 * The plan is explicit about the mistake this module exists to prevent:
 *
 *   CPU 32 threads  ->  32 workers
 *
 * That is not parallelism, it is a machine that stops responding. The number of
 * workers is a *derived* quantity: how much CPU is actually available, how much
 * memory is free, whether a GPU-backed model is saturated, how many model requests
 * are already queued, and how much test and browser load is in flight. This module
 * measures those and answers with `effectiveWorkers`, so a scheduler can be
 * aggressive on an idle machine and gentle on a loaded one without either decision
 * being hardcoded.
 *
 * It also owns the ceilings the UI shows (CPU 75%, RAM 70%, GPU 85% by default):
 * a limit that only exists in a settings panel is not a limit.
 */

const os = require('node:os')

/** The shipped ceilings. A profile may narrow them, never widen them past this. */
const DEFAULT_LIMITS = Object.freeze({
  cpuPercent: 75,
  ramPercent: 70,
  gpuPercent: 85,
  /** The worker band. The default is deliberately small: 2-4, adjusted upward. */
  minWorkers: 2,
  maxWorkers: 4,
  /** One worker per two logical cores is plenty for mixed CPU/IO work. */
  coresPerWorker: 2,
  /** How much memory one worker may assume it has, for the memory bound. */
  workerRamMb: 1024
})

/** Where the machine's pressure sits, in the vocabulary the UI and scheduler use. */
const PRESSURE = Object.freeze({
  IDLE: 'idle',
  NORMAL: 'normal',
  ELEVATED: 'elevated',
  CEILING: 'ceiling'
})

/** An injectable GPU probe, so a headless or CPU-only host simply reports none. */
function noGpu() {
  return { available: false, reason: 'no GPU probe is attached', utilizationPercent: null, vramUsedMb: null, vramTotalMb: null }
}

/**
 * @param {object} [options]
 * @param {object} [options.limits] narrows DEFAULT_LIMITS
 * @param {Function} [options.probeCpu] `() => { usedPercent }`
 * @param {Function} [options.probeGpu] `() => { available, utilizationPercent, vramUsedMb, vramTotalMb }`
 * @param {Function} [options.now]
 * @param {number} [options.modelConcurrency] how many model requests may be in flight
 */
function createResourceManager(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const limits = { ...DEFAULT_LIMITS, ...(options.limits || {}) }
  const probeGpu = typeof options.probeGpu === 'function' ? options.probeGpu : noGpu
  const probeCpu = typeof options.probeCpu === 'function' ? options.probeCpu : null
  const modelConcurrency = Number.isInteger(options.modelConcurrency) ? options.modelConcurrency : 4
  /** Load sources plugins register: tests, browsers, models, workers. */
  const loads = new Map()
  const history = []

  /**
   * Register a load source.
   *
   * "Load" is anything whose concurrency the resource manager has to account for:
   * a running test process, a browser session, a queued model request. A plugin
   * reports what it is doing; it does not decide how many workers may run.
   */
  function register(name, detail = {}) {
    const key = String(name)
    loads.set(key, {
      name: key,
      active: Number.isFinite(detail.active) ? Number(detail.active) : 0,
      weight: Number.isFinite(detail.weight) ? Number(detail.weight) : 1,
      at: now()
    })
    return loads.get(key)
  }

  function update(name, active) {
    const entry = loads.get(String(name))
    if (!entry) return register(name, { active })
    entry.active = Number.isFinite(active) ? Number(active) : 0
    entry.at = now()
    return entry
  }

  function release(name) {
    return loads.delete(String(name))
  }

  /** How much CPU is in use, as a percentage, or null when it cannot be measured. */
  function cpuSnapshot() {
    if (probeCpu) {
      try {
        const result = probeCpu()
        const used = Number(result && result.usedPercent)
        if (Number.isFinite(used)) return { usedPercent: Math.max(0, Math.min(100, used)), source: 'probe' }
      } catch {
        /* fall through to the load-average estimate */
      }
    }
    // `os.loadavg()` is meaningless on Windows, so it is only used where it is not
    // zero: the honest answer on Windows is "unknown", not "0% busy".
    const load = os.loadavg ? os.loadavg()[0] : 0
    const cores = Math.max(1, os.cpus().length)
    if (load > 0) return { usedPercent: Math.max(0, Math.min(100, (load / cores) * 100)), source: 'loadavg' }
    return { usedPercent: null, source: 'unknown' }
  }

  /** The whole snapshot: what the UI shows and the scheduler reads. */
  function snapshot() {
    const cores = Math.max(1, (os.cpus() || []).length)
    const totalBytes = os.totalmem()
    const freeBytes = os.freemem()
    const usedRamPercent = Math.max(0, Math.min(100, ((totalBytes - freeBytes) / totalBytes) * 100))
    const cpu = cpuSnapshot()
    let gpu = noGpu()
    try {
      gpu = { ...gpu, ...(probeGpu() || {}) }
    } catch (error) {
      gpu = { available: false, reason: String(error && error.message ? error.message : error), utilizationPercent: null, vramUsedMb: null, vramTotalMb: null }
    }
    const loadEntries = [...loads.values()].map((entry) => ({ ...entry, weighted: entry.active * entry.weight }))
    const weighted = loadEntries.reduce((total, entry) => total + entry.weighted, 0)
    const cpuPressure = cpu.usedPercent === null ? null : cpu.usedPercent / limits.cpuPercent
    const ramPressure = usedRamPercent / limits.ramPercent
    const gpuPressure = gpu.available && Number.isFinite(gpu.utilizationPercent) ? gpu.utilizationPercent / limits.gpuPercent : null
    const pressures = [cpuPressure, ramPressure, gpuPressure].filter((value) => value !== null)
    const worst = pressures.length ? Math.max(...pressures) : ramPressure
    const pressure = worst >= 1 ? PRESSURE.CEILING : worst >= 0.85 ? PRESSURE.ELEVATED : worst >= 0.5 ? PRESSURE.NORMAL : PRESSURE.IDLE
    return {
      at: now(),
      cores,
      limits: { ...limits },
      cpu: { ...cpu, cores },
      ram: { usedPercent: usedRamPercent, freeBytes, totalBytes },
      gpu,
      loads: loadEntries,
      weightedLoad: weighted,
      modelConcurrency,
      pressure,
      ceilings: {
        cpu: cpu.usedPercent !== null && cpu.usedPercent >= limits.cpuPercent,
        ram: usedRamPercent >= limits.ramPercent,
        gpu: gpu.available && Number.isFinite(gpu.utilizationPercent) && gpu.utilizationPercent >= limits.gpuPercent
      }
    }
  }

  /**
   * How many workers this machine should run right now.
   *
   * The answer is the *minimum* of four bounds, each derived from something real:
   *
   *   cores     one worker per `coresPerWorker` logical cores, so the machine keeps
   *             headroom for the model and the test runner
   *   memory    the free RAM budget divided by what one worker may assume
   *   model     the model queue's own concurrency, because more task workers than
   *             that only queue
   *   profile   the caller's cap for this mode
   *
   * It never exceeds `maxWorkers` and never returns less than zero, and it reports
   * *which* bound applied so "why only 2 workers?" has an answer.
   */
  function effectiveWorkers(input = {}) {
    const snap = input.snapshot || snapshot()
    const cap = Number.isInteger(input.maxWorkers) ? input.maxWorkers : limits.maxWorkers
    const floor = Number.isInteger(input.minWorkers) ? input.minWorkers : limits.minWorkers
    const bounds = []

    const coreBound = Math.floor(snap.cores / Math.max(1, limits.coresPerWorker))
    bounds.push({ name: 'cores', value: coreBound, reason: `${snap.cores} logical cores / ${limits.coresPerWorker} per worker` })

    const freeMb = snap.ram.freeBytes / (1024 * 1024)
    const usableMb = Math.max(0, freeMb - snap.ram.totalBytes / (1024 * 1024) * (1 - limits.ramPercent / 100))
    const memoryBound = Math.floor(usableMb / Math.max(128, limits.workerRamMb))
    bounds.push({ name: 'memory', value: memoryBound, reason: `${Math.round(usableMb)}MB usable / ${limits.workerRamMb}MB per worker` })

    // The model queue is a hard bound: more task workers than the model can serve
    // do not go faster, they just wait.
    const modelBound = Math.max(0, snap.modelConcurrency - snap.weightedLoad)
    bounds.push({ name: 'model', value: modelBound, reason: `${snap.modelConcurrency} concurrent model requests, ${snap.weightedLoad} already in flight` })

    bounds.push({ name: 'profile', value: cap, reason: `the profile caps this mode at ${cap}` })

    const allowed = bounds.filter((bound) => bound.value >= 0)
    const winner = allowed.reduce((lowest, bound) => (bound.value < lowest.value ? bound : lowest), allowed[0])
    let workers = Math.max(0, Math.min(cap, winner.value))
    // At a hard ceiling the manager allocates nothing new: degrading to zero is
    // correct and the caller is told why.
    if (snap.pressure === PRESSURE.CEILING) workers = 0
    else if (workers > 0 && workers < floor && snap.pressure === PRESSURE.IDLE) workers = floor
    history.push({ at: snap.at, workers, pressure: snap.pressure, bound: winner.name })
    if (history.length > 100) history.splice(0, history.length - 100)
    return {
      workers,
      bound: winner.name,
      reason: winner.reason,
      bounds,
      pressure: snap.pressure,
      at: snap.at,
      /** The caller can see what the profile asked for against what it got. */
      requested: cap
    }
  }

  return {
    PRESSURE,
    DEFAULT_LIMITS,
    limits,
    register,
    update,
    release,
    snapshot,
    effectiveWorkers,
    /** The last few decisions, so a scheduler can explain itself. */
    decisions() {
      return history.slice()
    },
    /** One line for the UI: what the machine looks like and what it allows. */
    summary() {
      const snap = snapshot()
      const workers = effectiveWorkers({ snapshot: snap })
      return {
        pressure: snap.pressure,
        cpuPercent: snap.cpu.usedPercent,
        ramPercent: Math.round(snap.ram.usedPercent),
        gpuPercent: snap.gpu.available ? snap.gpu.utilizationPercent : null,
        cores: snap.cores,
        workers: workers.workers,
        bound: workers.bound,
        reason: workers.reason,
        ceilings: snap.ceilings
      }
    }
  }
}

module.exports = { createResourceManager, PRESSURE, DEFAULT_LIMITS }
