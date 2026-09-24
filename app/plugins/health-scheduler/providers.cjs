'use strict'

/**
 * DS-Hns: the health scheduler's telemetry providers, and the rule that one broken sensor is one
 * broken sensor.
 *
 * The scheduler reads a dozen different things about the machine, the process, the workers and the
 * task queue. Each of them is somebody else's data, arriving through somebody else's API, and the
 * requirement is explicit about what happens when one of them misbehaves:
 *
 * > A single provider failing must not take the health scheduler down.
 *
 * That is made structural here rather than remembered at every call site. A provider is a small
 * object — an `id`, the dimensions it feeds, and a `read()` that returns readings — and *every* call
 * goes through `readAll()`, which catches a throw, catches a missing reading, records a fault against
 * that provider and carries on with the rest. There is no path from a broken provider to a broken
 * sample, because there is no other way to call one.
 *
 * ## Unknown is not healthy
 *
 * A dimension no provider reported is `unknown`, and its weight is redistributed across the
 * dimensions that *did* report, with `coverage` published beside the score. Scoring a silent sensor
 * as zero pressure is how a monitor reports calm on a machine it cannot see, and it is the defect
 * this module exists to make impossible: `readings()` never invents a value, and a provider that
 * answers `null` produces `unknown`, not `0`.
 *
 * ## Why providers, and not one big collector
 *
 * The previous shape was a single injectable `readings()` function. It worked, and it made one thing
 * impossible: giving the plugin the *worker* and *queue* dimensions at all, because those come from
 * capabilities the plugin may or may not have rather than from `node:os`. A provider can be optional,
 * can be added by a deployment, and can fail alone — which is exactly the shape of the data.
 */

/** The dimensions the score is made of, and what each one is reading. */
const DIMENSIONS = Object.freeze({
  memory: 'how much of the machine\'s memory is committed',
  cpu: 'how loaded the machine\'s processors are',
  runtime: 'how long this process has been up and how much it has grown',
  responsiveness: 'how far the event loop is drifting from its schedule'
})

/**
 * The enrichment a provider may contribute beyond the four scored dimensions.
 *
 * These are the same measurements, kept in their own vocabulary so a consumer that wants "is the
 * event loop drifting" does not have to know which score it rolled into. `unknown` is a value here
 * too: an absent worker reading is reported as `null`, never as a healthy worker.
 */
const ENRICHMENT_KEYS = Object.freeze([
  'processMemoryBytes',
  'processAgeMs',
  'eventLoopDriftMs',
  'runtimeResponsive',
  'heartbeatQuality',
  'workerResponsive',
  'queuePressure',
  'longRunningTaskPressure',
  'restartHistory',
  'recentFailures'
])

function clamp(value) {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, value))
}

/** Fit a raw measurement into a warn/critical reading, or `null` when there is no measurement. */
function reading(value, warn, critical, detail = null) {
  if (!Number.isFinite(value)) return null
  return { value: Number(value), warn, critical, detail }
}

/**
 * The default machine provider: `node:os` and `node:process`, nothing else.
 *
 * Windows is why the CPU number is derived from the tick counters instead of `os.loadavg()`: the
 * load average is meaningless there, and a monitor that reported 0.00 on a machine at 100% would be
 * the exact failure this whole file is about.
 */
function machineProvider() {
  return {
    id: 'machine',
    summary: 'the machine and this process, through node:os and node:process',
    dimensions: ['memory', 'cpu', 'runtime'],
    optional: false,
    read() {
      const os = require('node:os')
      const total = os.totalmem()
      const free = os.freemem()
      const usedRatio = total > 0 ? 1 - (free / total) : 0

      const cpus = os.cpus()
      const loadAvg = typeof os.loadavg === 'function' ? os.loadavg()[0] : 0
      let idle = 0
      let ticks = 0
      for (const cpu of cpus) {
        for (const value of Object.values(cpu.times || {})) ticks += value
        idle += (cpu.times && cpu.times.idle) || 0
      }
      const busyRatio = ticks > 0 ? 1 - (idle / ticks) : Math.min(loadAvg / Math.max(cpus.length, 1), 1)

      const usage = process.memoryUsage()
      return {
        readings: {
          memory: reading(usedRatio * 100, 70, 92, { freeBytes: free, totalBytes: total }),
          cpu: reading(busyRatio * 100, 75, 95, { cores: cpus.length, loadAvg })
        },
        enrichment: {
          processMemoryBytes: { rss: usage.rss, heapUsed: usage.heapUsed, heapTotal: usage.heapTotal, external: usage.external },
          processAgeMs: Math.round(process.uptime() * 1000)
        }
      }
    }
  }
}

/** The process-age provider: how long this process has been up, as its own dimension. */
function processAgeProvider() {
  return {
    id: 'process-age',
    summary: 'how long this process has been running, and how much it has grown',
    dimensions: ['runtime'],
    optional: false,
    read() {
      const usage = process.memoryUsage()
      const hours = process.uptime() / 3600
      return {
        readings: { runtime: reading(Math.min(hours * 4.2, 100), 60, 90, { uptimeSec: Math.round(process.uptime()) }) },
        enrichment: { processAgeMs: Math.round(process.uptime() * 1000), processMemoryBytes: { heapUsed: usage.heapUsed } }
      }
    }
  }
}

/**
 * The event-loop provider: the scheduler's own observation about its own responsiveness.
 *
 * It is deliberately *not* a dimension a caller can inject away. `responsiveness` is measured from
 * the sampler's own tick drift, which is the one reading a broken machine cannot make disappear —
 * and the drift is also published as `eventLoopDriftMs` so a consumer can see the raw milliseconds
 * rather than only the 0-100 score they became.
 */
function eventLoopProvider() {
  let driftMs = 0
  return {
    id: 'event-loop',
    summary: 'how late this scheduler\'s own scheduled work ran',
    dimensions: ['responsiveness'],
    optional: false,
    /** Called by the engine on each sample with the observed lateness. */
    observe(observedDriftMs) {
      driftMs = Number.isFinite(observedDriftMs) ? Math.max(0, observedDriftMs) : 0
      return driftMs
    },
    read({ intervalMs = 15_000 } = {}) {
      const share = Math.min((driftMs / Math.max(intervalMs, 1)) * 100, 100)
      return {
        readings: { responsiveness: reading(share, 60, 90, { driftMs }) },
        enrichment: {
          eventLoopDriftMs: driftMs,
          /** A loop that is on schedule is responsive; one that is not, is not. */
          runtimeResponsive: share < 60
        }
      }
    }
  }
}

/**
 * The heartbeat provider: how good this process's liveness story is.
 *
 * The quality is a 0-1 number rather than a boolean because "the heartbeat is fine" and "the
 * heartbeat has not been written yet" are different facts, and the second one must read as *partial*
 * rather than as healthy. A quality below the configured floor makes the whole sample low-confidence,
 * which is what keeps `UNKNOWN != HEALTHY` true at the top of the model.
 */
function heartbeatProvider() {
  const beats = []
  return {
    id: 'heartbeat',
    summary: 'whether this process has been writing its own liveness beat',
    dimensions: [],
    optional: true,
    beat(atMs = Date.now(), detail = null) {
      beats.push({ at: atMs, detail })
      if (beats.length > 64) beats.shift()
      return beats.length
    },
    read({ atMs = Date.now(), intervalMs = 15_000 } = {}) {
      if (!beats.length) {
        return { readings: {}, enrichment: { heartbeatQuality: 0, heartbeatBeats: 0 } }
      }
      const latest = beats[beats.length - 1]
      const age = Math.max(0, atMs - latest.at)
      // Quality is 1 while the beat is inside two intervals, and decays to 0 by eight.
      const quality = age <= intervalMs * 2 ? 1 : Math.max(0, 1 - (age - intervalMs * 2) / (intervalMs * 6))
      return { readings: {}, enrichment: { heartbeatQuality: Number(quality.toFixed(3)), heartbeatBeats: beats.length, heartbeatAgeMs: age } }
    },
    reset() {
      beats.length = 0
      return { ok: true }
    }
  }
}

/**
 * The worker provider: the sub-worker pool's responsiveness, when the capability is there.
 *
 * `read()` is handed the capability value by the engine, so this provider holds no handle of its own
 * and the plugin stays free of any dependency on the worker runtime existing. No capability means
 * `null` enrichment, which the severity model reports as unknown rather than as a healthy pool.
 */
function workerProvider() {
  return {
    id: 'worker',
    summary: 'the sub-worker pool\'s responsiveness, through the runtime-health capability',
    dimensions: [],
    optional: true,
    read({ runtimeHealth = null } = {}) {
      if (!runtimeHealth || typeof runtimeHealth.snapshot !== 'function') {
        return { readings: {}, enrichment: { workerResponsive: null } }
      }
      let snapshot = null
      try {
        snapshot = runtimeHealth.snapshot()
      } catch (error) {
        // A capability that throws is a *provider* failure, reported like any other.
        throw new Error(`the runtime-health capability threw: ${error && error.message ? error.message : error}`)
      }
      if (!snapshot || typeof snapshot !== 'object') return { readings: {}, enrichment: { workerResponsive: null } }
      const scores = snapshot.scores && typeof snapshot.scores === 'object' ? snapshot.scores : {}
      const responsiveness = Number.isFinite(scores.responsiveness) ? scores.responsiveness : null
      return {
        readings: {},
        enrichment: {
          workerResponsive: responsiveness === null ? null : responsiveness < 60,
          workerPressure: responsiveness
        }
      }
    }
  }
}

/**
 * The queue/task provider: queue pressure and long-running task pressure, from Core.
 *
 * Both are Core's facts and neither is guessed: the provider asks, and a `null` answer stays `null`.
 * The pressure shaping — how many queued tasks is "pressure" — is a configured ceiling here rather
 * than a hard-coded number, because it is a property of the deployment's sizing.
 */
function taskProvider() {
  return {
    id: 'tasks',
    summary: 'queue depth and long-running task load, through the continuity layer',
    dimensions: [],
    optional: true,
    read({ pendingWork = null, ceilings = {} } = {}) {
      if (!pendingWork || typeof pendingWork !== 'object') {
        return { readings: {}, enrichment: { queuePressure: null, longRunningTaskPressure: null } }
      }
      const queued = Number.isFinite(pendingWork.queued) ? Number(pendingWork.queued) : null
      const running = Number.isFinite(pendingWork.active) ? Number(pendingWork.active) : null
      const queueCeiling = Number.isFinite(ceilings.queue) ? Number(ceilings.queue) : 20
      const longCeiling = Number.isFinite(ceilings.longRunningMinutes) ? Number(ceilings.longRunningMinutes) : 30
      const longestMinutes = Number.isFinite(pendingWork.longestRunningMinutes) ? Number(pendingWork.longestRunningMinutes) : null
      return {
        readings: {},
        enrichment: {
          queuePressure: queued === null ? null : clamp((queued / Math.max(queueCeiling, 1)) * 100),
          longRunningTaskPressure: longestMinutes === null ? null : clamp((longestMinutes / Math.max(longCeiling, 1)) * 100),
          queueDepth: queued,
          runningTasks: running
        }
      }
    }
  }
}

/**
 * The history provider: the restart history and the recent failures.
 *
 * It is a provider like any other because it is data from somewhere else — the restart supervisor —
 * and because a missing restart authority must degrade to `null`, not to "no restarts happened".
 * Those are different facts and only one of them is reassuring.
 */
function historyProvider() {
  return {
    id: 'history',
    summary: 'restart history and recent failures, through restart-control',
    dimensions: [],
    optional: true,
    read({ restartControl = null, atMs = Date.now(), windowMs = 3_600_000 } = {}) {
      if (!restartControl || typeof restartControl.getRestartHistory !== 'function') {
        return { readings: {}, enrichment: { restartHistory: null, recentFailures: null } }
      }
      const history = restartControl.getRestartHistory()
      const attempts = history && Array.isArray(history.attempts) ? history.attempts : []
      const inWindow = attempts.filter((entry) => Number.isFinite(entry.at) && entry.at >= atMs - windowMs)
      const failures = inWindow.filter((entry) => entry.ok !== true).length
      return {
        readings: {},
        enrichment: {
          restartHistory: {
            total: attempts.length,
            inWindow: inWindow.length,
            lastAt: inWindow.length ? inWindow[inWindow.length - 1].at : null,
            lastReason: inWindow.length ? inWindow[inWindow.length - 1].reasonCode || null : null
          },
          recentFailures: { inWindow: failures, last: inWindow.filter((entry) => entry.ok !== true).slice(-1)[0] || null }
        }
      }
    }
  }
}

/** The providers every scheduler ships with, in the order they are read. */
function defaultProviders() {
  return [machineProvider(), processAgeProvider(), eventLoopProvider(), heartbeatProvider(), workerProvider(), taskProvider(), historyProvider()]
}

/**
 * @param {object} [options]
 * @param {Array}  [options.providers] extra providers, appended to the registry
 * @param {Function} [options.log]
 * @param {Function} [options.now]
 */
function createProviderRegistry(options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {}
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const providers = []
  /** id -> the fault record from the last read, so a broken provider is visible, not just survived. */
  const faults = new Map()
  let reads = 0

  function register(provider) {
    if (!provider || typeof provider !== 'object') return { ok: false, reason: 'a provider must be an object' }
    const id = String(provider.id || '')
    if (!id) return { ok: false, reason: 'a provider needs an id' }
    if (typeof provider.read !== 'function') return { ok: false, reason: `provider ${id} has no read function` }
    if (providers.some((entry) => entry.id === id)) return { ok: false, reason: `provider ${id} is already registered` }
    providers.push({ id, summary: provider.summary ? String(provider.summary) : null, dimensions: Array.isArray(provider.dimensions) ? provider.dimensions.slice() : [], optional: provider.optional === true, read: provider.read, observe: typeof provider.observe === 'function' ? provider.observe : null, beat: typeof provider.beat === 'function' ? provider.beat : null, reset: typeof provider.reset === 'function' ? provider.reset : null })
    return { ok: true, id }
  }

  for (const provider of (Array.isArray(options.providers) ? options.providers : defaultProviders())) register(provider)
  /** A caller-supplied collector, kept as a provider so it has the same fault boundary. */
  if (typeof options.readings === 'function') {
    register({ id: 'injected', summary: 'readings supplied by the caller', dimensions: ['memory', 'cpu', 'runtime'], optional: false, read: () => ({ readings: options.readings() || {} }) })
  }

  function get(id) {
    return providers.find((entry) => entry.id === String(id)) || null
  }

  /** Tell an observer provider something only the caller knows (the loop's drift, a beat). */
  function observe(id, value) {
    const provider = get(id)
    if (!provider || typeof provider.observe !== 'function') return { ok: false, reason: `provider ${id} does not observe anything` }
    try {
      return { ok: true, value: provider.observe(value) }
    } catch (error) {
      return { ok: false, reason: String(error && error.message ? error.message : error) }
    }
  }

  function beat(id, atMs, detail) {
    const provider = get(id)
    if (!provider || typeof provider.beat !== 'function') return { ok: false, reason: `provider ${id} does not record beats` }
    try {
      return { ok: true, count: provider.beat(atMs, detail) }
    } catch (error) {
      return { ok: false, reason: String(error && error.message ? error.message : error) }
    }
  }

  /**
   * Read every provider, isolating each one.
   *
   * The isolation is the whole point: a provider that throws is a fault against *it*, the dimensions
   * it would have fed stay unknown, and every other provider still answers. `ok` on the result says
   * whether at least the *required* providers answered — which is the only thing that can make a
   * sample meaningless enough to be called UNKNOWN.
   */
  function readAll(context = {}) {
    reads += 1
    const readings = {}
    const enrichment = {}
    const answered = []
    const failures = []
    for (const provider of providers) {
      let outcome = null
      try {
        outcome = provider.read({ atMs: context.atMs === undefined ? now() : context.atMs, ...context })
      } catch (error) {
        const reason = String(error && error.message ? error.message : error)
        const fault = { provider: provider.id, at: context.atMs === undefined ? now() : context.atMs, reason }
        faults.set(provider.id, fault)
        failures.push(fault)
        log(`health provider ${provider.id} failed: ${reason}`)
        continue
      }
      if (!outcome || typeof outcome !== 'object') {
        const fault = { provider: provider.id, at: context.atMs === undefined ? now() : context.atMs, reason: 'the provider returned nothing' }
        faults.set(provider.id, fault)
        failures.push(fault)
        continue
      }
      faults.delete(provider.id)
      answered.push(provider.id)
      for (const [dimension, value] of Object.entries(outcome.readings || {})) {
        // A provider that answers `null` for a dimension contributes *nothing*: the dimension stays
        // unknown rather than becoming zero. This is the rule, in one line.
        if (value && Number.isFinite(value.value)) readings[dimension] = value
      }
      for (const [key, value] of Object.entries(outcome.enrichment || {})) {
        if (ENRICHMENT_KEYS.includes(key) || key.startsWith('heartbeat') || key.startsWith('worker') || key.startsWith('queue') || key.startsWith('running') || key.startsWith('process')) enrichment[key] = value
      }
      if (Array.isArray(outcome.enrichment && outcome.enrichment.recentFailures)) enrichment.recentFailures = outcome.enrichment.recentFailures
    }
    const required = providers.filter((provider) => provider.optional !== true)
    const requiredAnswered = required.filter((provider) => answered.includes(provider.id))
    return {
      ok: requiredAnswered.length === required.length,
      at: context.atMs === undefined ? now() : context.atMs,
      readings,
      enrichment,
      answered,
      failures,
      /**
       * The share of providers that answered. It is published so a *low* confidence can be seen
       * rather than inferred, and so the severity model can refuse to call a blinded sample healthy.
       */
      confidence: providers.length ? Number((answered.length / providers.length).toFixed(3)) : 0,
      missingRequired: required.filter((provider) => !answered.includes(provider.id)).map((provider) => provider.id),
      faults: [...faults.values()]
    }
  }

  function describe() {
    return {
      reads,
      providers: providers.map((provider) => ({
        id: provider.id,
        summary: provider.summary,
        dimensions: provider.dimensions.slice(),
        optional: provider.optional,
        fault: faults.get(provider.id) || null
      }))
    }
  }

  function reset() {
    faults.clear()
    reads = 0
    for (const provider of providers) if (typeof provider.reset === 'function') provider.reset()
    return { ok: true }
  }

  return { register, get, readAll, describe, reset, observe, beat, providers: () => providers.map((provider) => provider.id) }
}

module.exports = {
  DIMENSIONS,
  ENRICHMENT_KEYS,
  createProviderRegistry,
  defaultProviders,
  machineProvider,
  processAgeProvider,
  eventLoopProvider,
  heartbeatProvider,
  workerProvider,
  taskProvider,
  historyProvider,
  clamp,
  reading
}
