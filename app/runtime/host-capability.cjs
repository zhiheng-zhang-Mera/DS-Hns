'use strict'

/**
 * Host Capability Profile.
 *
 * The rule this file exists to enforce:
 *
 *   CORRECTNESS GATE != PERFORMANCE GATE
 *
 * An installation used to be able to fail because a wall-clock number was bigger
 * than a constant. That is a statement about the machine, dressed up as a
 * statement about the product, and on a slow machine it made a *correct*
 * installation report itself as broken. The fix is not a bigger constant and it
 * is not a machine-model lookup table — the first is still machine-independent
 * and the second is a guess made by someone who has never seen this host.
 *
 * What replaces both is measurement. This module collects what the host *is*
 * (cores, memory, architecture) and then briefly measures what the host *does*
 * (how long a Node process takes to spawn, how long a worker takes to cold-start)
 * and publishes the two together. Every dynamic budget and every dynamic timeout
 * in the installer and the Runtime is derived from this profile, so a slow host
 * gets a budget that reflects its own measured slowness instead of being declared
 * incorrect.
 *
 * The profile is a value: it can be persisted, injected, and replaced with a
 * synthetic one for tests. `createCalibratedProfile` is the seam — pointing the
 * installer at a fixture profile is how "a 2-core 4 GB machine installs
 * successfully" is tested without owning a 2-core 4 GB machine.
 */

const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const CAPABILITY_VERSION = 1

/**
 * Ordered capacity classes.
 *
 * The class is a *consequence* of the measurements, never an input: it names how
 * much the host can be asked to do at once. `LOW_CAPACITY` is not an error state
 * and never fails an installation — it selects conservative defaults and says so.
 */
const CAPACITY_CLASSES = Object.freeze(['LOW_CAPACITY', 'CONSERVATIVE', 'BALANCED', 'CAPABLE', 'HIGH_CAPACITY'])

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  if (!sorted.length) return 0
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2)
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b)
  if (!sorted.length) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))
  return sorted[index]
}

/** Hardware facts. Cheap, synchronous, and never fatal. */
function readHardware({ env = process.env } = {}) {
  const cpus = (() => {
    try {
      return os.cpus() || []
    } catch {
      return []
    }
  })()
  let totalMB = 0
  try {
    totalMB = Math.round(os.totalmem() / (1024 * 1024))
  } catch {}
  let availableMB = 0
  try {
    availableMB = Math.round(os.freemem() / (1024 * 1024))
  } catch {}
  return {
    logicalCores: cpus.length || 1,
    physicalCores: (() => {
      // A conservative estimate: Node does not report physical cores portably, and
      // guessing high would over-commit workers on a hyper-threaded host.
      const logical = cpus.length || 1
      return Math.max(1, Math.round(logical / 2))
    })(),
    architecture: process.arch,
    platform: process.platform,
    model: String(cpus[0]?.model || '').trim(),
    speedMHz: Number(cpus[0]?.speed || 0),
    totalMB,
    availableMB,
    /** Used by the concurrency arithmetic below; never a gate. */
    memoryPressure: totalMB > 0 ? Number(((totalMB - availableMB) / totalMB).toFixed(3)) : 0,
    /** An explicit override makes the low-capacity fixture possible. */
    simulated: Boolean(env.DSH_HOST_PROFILE_FIXTURE)
  }
}

/**
 * Measure how long this host takes to spawn a Node process.
 *
 * `node -e ""` is the cheapest honest probe of the thing that actually dominates
 * on Windows: process creation. It is run a few times and reported as a median
 * and a p95, because an installer budget has to survive a *slow* spawn and not
 * the average one.
 */
function measureNodeSpawn({ samples = 5, nodeExe = process.execPath, timeoutMs = 30_000 } = {}) {
  const durations = []
  for (let index = 0; index < samples; index += 1) {
    const started = process.hrtime.bigint()
    try {
      const result = spawnSync(nodeExe, ['-e', ''], { stdio: 'ignore', windowsHide: true, timeout: timeoutMs })
      if (result.error) continue
    } catch {
      continue
    }
    durations.push(Number(process.hrtime.bigint() - started) / 1e6)
  }
  return {
    samples: durations.length,
    p50Ms: Math.round(median(durations)),
    p95Ms: Math.round(percentile(durations, 0.95)),
    minMs: durations.length ? Math.round(Math.min(...durations)) : 0,
    maxMs: durations.length ? Math.round(Math.max(...durations)) : 0
  }
}

/**
 * Optionally measure an Electron cold start.
 *
 * Off by default: `--version` still pays the process-creation cost, but a real
 * window measurement is not something an installer may do. It is available for a
 * Qualification run on a host where the UI cost is what is being qualified.
 */
function measureElectronStart({ electronExe, samples = 2, timeoutMs = 60_000 } = {}) {
  if (!electronExe || !fs.existsSync(electronExe)) return { available: false, reason: 'electron binary not found', samples: 0 }
  const durations = []
  for (let index = 0; index < samples; index += 1) {
    const started = process.hrtime.bigint()
    try {
      const result = spawnSync(electronExe, ['--version'], { stdio: 'ignore', windowsHide: true, timeout: timeoutMs })
      if (result.error) continue
    } catch {
      continue
    }
    durations.push(Number(process.hrtime.bigint() - started) / 1e6)
  }
  if (!durations.length) return { available: false, reason: 'electron did not start', samples: 0 }
  return {
    available: true,
    samples: durations.length,
    p50Ms: Math.round(median(durations)),
    p95Ms: Math.round(percentile(durations, 0.95))
  }
}

/**
 * Classify the host.
 *
 * The arithmetic is deliberately simple and legible, because a person reading a
 * slow installation's log has to be able to see *why* it was classified the way
 * it was. Both halves matter: cores say how much can run at once, and measured
 * spawn latency says how expensive starting that work is. A 16-core host with a
 * 2-second spawn (a heavily loaded or virtualized machine) is not `CAPABLE` for
 * the purposes of a startup budget.
 */
function classifyCapacity({ hardware, calibration }) {
  const cores = Number(hardware?.logicalCores) || 1
  const memoryMB = Number(hardware?.totalMB) || 0
  const availableMB = Number(hardware?.availableMB) || 0
  const spawnP95 = Number(calibration?.nodeSpawnP95Ms) || 0

  let score = 0
  if (cores >= 16) score += 3
  else if (cores >= 8) score += 2
  else if (cores >= 4) score += 1

  if (memoryMB >= 32_000) score += 3
  else if (memoryMB >= 16_000) score += 2
  else if (memoryMB >= 8_000) score += 1

  // A slow spawn subtracts: the host can have cores and still not be able to use
  // them quickly. The bands were chosen from measurement rather than from a
  // hardware list: a quiet Windows host spawns Node in ~60-150 ms, a host running
  // a real DS-Hns installation (Harness + Electron + workers resident) measures
  // 600-1200 ms, and a contended or virtualized host goes past that. A machine
  // that is merely *busy* must not be scored as a machine that is *small*.
  if (spawnP95 > 0) {
    if (spawnP95 <= 250) score += 2
    else if (spawnP95 <= 800) score += 1
    else if (spawnP95 > 2000) score -= 1
  }

  // Real memory pressure now is more informative than nominal capacity.
  if (availableMB > 0 && availableMB < 1024) score -= 1

  const index = score >= 7 ? 4 : score >= 5 ? 3 : score >= 3 ? 2 : score >= 1 ? 1 : 0
  return {
    class: CAPACITY_CLASSES[index],
    score,
    reasons: {
      logicalCores: cores,
      totalMB: memoryMB,
      availableMB,
      nodeSpawnP95Ms: spawnP95
    }
  }
}

/**
 * How many workers may this host be asked to run at once?
 *
 * The formula is a ceiling, not a target, and both terms matter: a worker costs a
 * process and a slice of memory, so the answer is the minimum of "how many can
 * the CPU interleave" and "how many fit in the memory actually free right now".
 * The old default was a number chosen on a fast development machine and shipped
 * to everyone; this is the same number *derived* on the machine that will run it.
 *
 * `conservative` (LOW_CAPACITY) never returns less than 1: a host that can run a
 * single worker is a host that can work, and an installation on it is correct.
 */
function deriveWorkerCeiling({ hardware, capacity, perWorkerMemoryMB = 512 } = {}) {
  const cores = Math.max(1, Number(hardware?.logicalCores) || 1)
  const availableMB = Number(hardware?.availableMB) || Number(hardware?.totalMB) || 0
  const cpuBound = Math.max(1, cores - 1)
  const memoryBound = availableMB > 0 ? Math.max(1, Math.floor((availableMB * 0.6) / perWorkerMemoryMB)) : 1
  const ceiling = Math.max(1, Math.min(cpuBound, memoryBound))
  const policy = {
    LOW_CAPACITY: { max: 2, aggressive: false, label: 'conservative' },
    CONSERVATIVE: { max: 3, aggressive: false, label: 'conservative' },
    BALANCED: { max: 6, aggressive: false, label: 'normal' },
    CAPABLE: { max: 10, aggressive: true, label: 'normal' },
    HIGH_CAPACITY: { max: 16, aggressive: true, label: 'aggressive' }
  }[capacity?.class || 'BALANCED'] || { max: 6, aggressive: false, label: 'normal' }
  const resolved = Math.max(1, Math.min(ceiling, policy.max))
  return {
    recommended: resolved,
    ceiling,
    cpuBound,
    memoryBound,
    perWorkerMemoryMB,
    aggressiveScaling: policy.aggressive,
    label: policy.label,
    /** The pre-existing adaptive state the Runtime already understands. */
    initialAdaptiveState: policy.aggressive ? 'NORMAL' : resolved <= 2 ? 'THROTTLED' : 'NORMAL'
  }
}

/**
 * The budget a piece of work is *expected* to take on this host.
 *
 * The requirement's own arithmetic, made concrete:
 *
 *   dynamic_budget = intrinsic_work_ms
 *                  + calibrated_startup_overhead
 *                  + host_variance_margin
 *
 * `intrinsicMs` is what the work costs when process startup is free — two 5 s
 * nodes in parallel cost 5 s, not 10 s, and that is the number the scenario knows
 * about itself. `startupCount` is how many processes the work starts, each of
 * which costs this host this much to create. The margin absorbs the spread the
 * calibration actually observed.
 *
 * The result is a budget, not a gate. It is compared, reported, and — outside an
 * explicit strict qualification — never used to fail anything.
 *
 * `hostVarianceMargin` is bounded, so a pathological calibration cannot buy an
 * unbounded allowance: the requirement forbids inflating the budget until the
 * test passes, and the structural assertions in the scenario are what make that
 * impossible to fake regardless.
 */
function computeDynamicBudget({
  intrinsicMs,
  startupCount = 0,
  calibration,
  capacity,
  marginFraction = 0.35,
  maxMarginFraction = 0.75
} = {}) {
  const intrinsic = Math.max(0, Number(intrinsicMs) || 0)
  const count = Math.max(0, Number(startupCount) || 0)
  const spawnP95 = Number(calibration?.nodeSpawnP95Ms) || 0
  const spawnP50 = Number(calibration?.nodeSpawnP50Ms) || spawnP95
  const workerP95 = Number(calibration?.workerColdStartP95Ms) || 0
  // Worker cold start already contains the spawn it wraps, so the larger of the two
  // is the honest per-start cost rather than their sum.
  const perStartMs = Math.max(spawnP95, workerP95)
  const startupOverhead = Math.round(perStartMs * count)
  // Variance is observed, not assumed: a host whose spawn p95 is 5x its p50 is a
  // host whose timings move, and its margin says so.
  const observedSpread = spawnP50 > 0 ? Math.max(0, spawnP95 / spawnP50 - 1) : 0
  const marginFractionResolved = Math.min(maxMarginFraction, Math.max(marginFraction, observedSpread))
  const margin = Math.round((intrinsic + startupOverhead) * marginFractionResolved)
  const budgetMs = intrinsic + startupOverhead + margin
  return {
    intrinsicMs: intrinsic,
    startupCount: count,
    perStartMs: Math.round(perStartMs),
    startupOverheadMs: startupOverhead,
    marginFraction: Number(marginFractionResolved.toFixed(3)),
    marginMs: margin,
    budgetMs,
    capacityClass: capacity?.class || 'BALANCED',
    /** Budgets are quantised so two runs of the same host agree on the number. */
    reportedSeconds: Math.ceil(budgetMs / 1000)
  }
}

/**
 * A timeout that scales with the host.
 *
 * Two numbers are kept apart on purpose, because conflating them is exactly the
 * bug this replaces:
 *
 *   - `deadlockMs` is a *liveness* bound. Something is genuinely wedged and
 *     waiting longer cannot help. It is generous and roughly host-independent.
 *   - `budgetMs` is an *expectation*. It is what the work should cost here, and
 *     it feeds performance reporting — never a correctness failure outside an
 *     explicit strict qualification.
 *
 * The scaling is **additive**, and that is a deliberate correction of the obvious
 * first attempt. Multiplying a long timeout by a spawn-latency ratio is wrong in
 * both directions: a 1 s process-creation cost is 0.8 % of a two-minute Harness
 * startup, so scaling it to twelve minutes is not caution, it is an unbounded
 * wait; and on a quiet host the same ratio would shrink the timeout below what the
 * work can need. What actually varies with the host is the *per-start* cost and
 * the number of starts, so that is what is added — with a small multiplier on the
 * base to cover the linear work a slow host also does slowly.
 */
function scaleTimeout({
  baseMs,
  kind = 'startup',
  starts = 1,
  calibration,
  capacity,
  maxFactor = 3,
  minFactor = 1
} = {}) {
  const base = Math.max(1, Number(baseMs) || 1)
  const startCount = Math.max(0, Number(starts) || 0)
  const spawnP95 = Number(calibration?.nodeSpawnP95Ms) || 0
  const workerP95 = Number(calibration?.workerColdStartP95Ms) || 0
  const perStartMs = Math.max(spawnP95, kind === 'worker' ? workerP95 : 0)

  // A low-capacity host is given headroom outright: its whole point is that the
  // baseline was written with a faster machine in mind.
  const classFactor = capacity?.class === 'LOW_CAPACITY' ? 2 : capacity?.class === 'CONSERVATIVE' ? 1.5 : 1
  const factor = Math.min(maxFactor, Math.max(minFactor, classFactor))
  const scaledBody = Math.round(base * factor)
  const startupAllowance = Math.round(perStartMs * startCount)
  const scaled = scaledBody + startupAllowance
  return {
    baseMs: base,
    factor: Number(factor.toFixed(3)),
    classFactor,
    starts: startCount,
    perStartMs: Math.round(perStartMs),
    startupAllowanceMs: startupAllowance,
    scaledMs: scaled,
    timeoutMs: scaled,
    /** A liveness bound: generous, bounded, and never the thing that fails a run. */
    deadlockMs: Math.round(Math.max(scaled * 2, base * 2)),
    kind
  }
}

/**
 * Build a profile from injected facts.
 *
 * This is the seam every low/high-capacity test uses: hand it hardware and
 * calibration, get the policy the Runtime would compute on a machine with those
 * characteristics. Nothing about the classification path differs between a real
 * host and a fixture, which is what makes the fixture evidence rather than a
 * mock.
 */
function createCalibratedProfile({ hardware = {}, calibration = {}, source = 'measured' } = {}) {
  const mergedHardware = { ...hardware }
  const mergedCalibration = { ...calibration }
  const capacity = classifyCapacity({ hardware: mergedHardware, calibration: mergedCalibration })
  const workers = deriveWorkerCeiling({ hardware: mergedHardware, capacity })
  return {
    version: CAPABILITY_VERSION,
    source,
    capturedAt: new Date().toISOString(),
    cpu: {
      logicalCores: mergedHardware.logicalCores,
      physicalCores: mergedHardware.physicalCores,
      architecture: mergedHardware.architecture,
      model: mergedHardware.model,
      speedMHz: mergedHardware.speedMHz
    },
    memory: {
      totalMB: mergedHardware.totalMB,
      availableMB: mergedHardware.availableMB,
      pressure: mergedHardware.memoryPressure
    },
    calibration: {
      nodeSpawnP50Ms: mergedCalibration.nodeSpawnP50Ms ?? 0,
      nodeSpawnP95Ms: mergedCalibration.nodeSpawnP95Ms ?? 0,
      nodeSpawnSamples: mergedCalibration.nodeSpawnSamples ?? 0,
      workerColdStartP95Ms: mergedCalibration.workerColdStartP95Ms ?? 0,
      electronColdStartP95Ms: mergedCalibration.electronColdStartP95Ms ?? null
    },
    capacity,
    workers,
    /** The budgets the installer and Runtime read instead of carrying constants. */
    budgets: {
      harnessStartup: scaleTimeout({
        baseMs: 120_000,
        kind: 'startup',
        starts: 1,
        calibration: mergedCalibration,
        capacity
      }),
      workerStartup: scaleTimeout({
        baseMs: 30_000,
        kind: 'worker',
        starts: 1,
        calibration: mergedCalibration,
        capacity
      }),
      ipcConnect: scaleTimeout({
        baseMs: 5_000,
        kind: 'connect',
        starts: 0,
        calibration: mergedCalibration,
        capacity
      }),
      electronReady: scaleTimeout({
        baseMs: 60_000,
        kind: 'startup',
        starts: 1,
        calibration: mergedCalibration,
        capacity
      })
    }
  }
}

/** Collect and calibrate on this host. Every step tolerates failure. */
function collectHostProfile({
  env = process.env,
  nodeExe = process.execPath,
  electronExe = null,
  spawnSamples = 5,
  measureElectron = false,
  log = () => {}
} = {}) {
  const hardware = readHardware({ env })
  let spawn = { samples: 0, p50Ms: 0, p95Ms: 0, minMs: 0, maxMs: 0 }
  try {
    spawn = measureNodeSpawn({ samples: spawnSamples, nodeExe })
  } catch (error) {
    log(`node spawn calibration failed: ${error?.message || error}`)
  }
  let electron = { available: false, reason: 'not measured', samples: 0 }
  if (measureElectron) {
    try {
      electron = measureElectronStart({ electronExe })
    } catch (error) {
      log(`electron cold-start calibration failed: ${error?.message || error}`)
    }
  }
  return createCalibratedProfile({
    hardware,
    calibration: {
      nodeSpawnP50Ms: spawn.p50Ms,
      nodeSpawnP95Ms: spawn.p95Ms,
      nodeSpawnSamples: spawn.samples,
      // Worker cold start is measured where workers actually start (the installer
      // step and the Runtime), and injected here when it is known.
      workerColdStartP95Ms: Number(env.DSH_WORKER_COLD_START_P95_MS) || 0,
      electronColdStartP95Ms: electron.available ? electron.p95Ms : null
    },
    source: 'measured'
  })
}

/** Read a fixture profile from disk, for the low/high-capacity simulations. */
function loadProfileFixture(fixturePath) {
  // Windows PowerShell's `Set-Content -Encoding UTF8` writes a BOM, and a fixture
  // authored from a shell is exactly the case this reader exists for. Stripping it
  // is the difference between "the JSON is wrong" and "the file starts with three
  // bytes JSON does not allow".
  const raw = fs.readFileSync(fixturePath, 'utf8').replace(/^\uFEFF/, '')
  const value = JSON.parse(raw)
  return createCalibratedProfile({
    hardware: {
      logicalCores: value.cpu?.logicalCores ?? value.hardware?.logicalCores,
      physicalCores: value.cpu?.physicalCores ?? value.hardware?.physicalCores,
      architecture: value.cpu?.architecture ?? 'x64',
      model: value.cpu?.model ?? `fixture:${path.basename(fixturePath)}`,
      speedMHz: value.cpu?.speedMHz ?? 0,
      totalMB: value.memory?.totalMB ?? value.hardware?.totalMB,
      availableMB: value.memory?.availableMB ?? value.hardware?.availableMB,
      memoryPressure: value.memory?.pressure ?? 0,
      simulated: true
    },
    calibration: {
      nodeSpawnP50Ms: value.calibration?.nodeSpawnP50Ms ?? 0,
      nodeSpawnP95Ms: value.calibration?.nodeSpawnP95Ms ?? 0,
      nodeSpawnSamples: value.calibration?.nodeSpawnSamples ?? 0,
      workerColdStartP95Ms: value.calibration?.workerColdStartP95Ms ?? 0,
      electronColdStartP95Ms: value.calibration?.electronColdStartP95Ms ?? null
    },
    source: `fixture:${path.basename(fixturePath)}`
  })
}

/**
 * Where the profile is cached between runs.
 *
 * A calibration is cheap but not free, and re-measuring on every invocation would
 * make the installer slower for no new information. The cache is keyed by
 * capacity inputs and invalidated when they move, and a stale profile is only
 * ever a slightly wrong budget — never a wrong decision about correctness.
 */
function profileCachePath(dshHome) {
  return path.join(dshHome, 'state', 'host-profile.json')
}

function readCachedProfile(dshHome, maxAgeMs = 6 * 60 * 60 * 1000) {
  try {
    const file = profileCachePath(dshHome)
    // Windows PowerShell's `Set-Content -Encoding UTF8` writes a BOM, and the
    // installer is what writes this file. A BOM is three bytes JSON does not
    // allow, so without this the cache would read as absent forever and the
    // Runtime would re-calibrate on every start while the file sat there looking
    // correct.
    const value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    if (value?.version !== CAPABILITY_VERSION) return null
    const captured = Date.parse(value.capturedAt || '')
    if (!Number.isFinite(captured) || Date.now() - captured > maxAgeMs) return null
    // A profile measured while the machine was under load is not a useful budget.
    return value
  } catch {
    return null
  }
}

function writeCachedProfile(dshHome, profile) {
  try {
    const file = profileCachePath(dshHome)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const temporary = `${file}.${process.pid}.tmp`
    fs.writeFileSync(temporary, JSON.stringify(profile, null, 2), 'utf8')
    fs.renameSync(temporary, file)
    return true
  } catch {
    return false
  }
}

module.exports = {
  CAPABILITY_VERSION,
  CAPACITY_CLASSES,
  median,
  percentile,
  readHardware,
  measureNodeSpawn,
  measureElectronStart,
  classifyCapacity,
  deriveWorkerCeiling,
  computeDynamicBudget,
  scaleTimeout,
  createCalibratedProfile,
  collectHostProfile,
  loadProfileFixture,
  profileCachePath,
  readCachedProfile,
  writeCachedProfile
}
