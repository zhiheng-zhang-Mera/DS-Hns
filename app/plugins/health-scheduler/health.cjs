'use strict'

/**
 * DS-Hns: the health engine behind `dshns.health-scheduler`.
 *
 * This is the part that reads the machine and the runtime, keeps a bounded history, scores a
 * pressure, decides what to do about it and explains the whole chain. It is deliberately free of any
 * host coupling: it takes a clock, a configuration, a provider registry and an optional readings
 * function, and returns values. That is what makes it testable without a machine under load, and what
 * keeps the plugin's lifecycle in `index.cjs` where the platform's contract lives.
 *
 * ## Three rules the model follows
 *
 * **Unknown is never healthy.** A dimension whose telemetry is missing is reported `unknown` and its
 * weight is *redistributed* across the dimensions that did report, with the coverage published
 * alongside the score. A sample that could see too little of the machine is `UNKNOWN` at the state
 * level too, and `UNKNOWN` never escalates to a maintenance action. Scoring a missing sensor as zero
 * pressure is how a monitor reports calm on a machine it cannot see.
 *
 * **Pressure is a trend, not a spike.** Samples enter a rolling window and both the score and the
 * state use the window's behaviour: hysteresis on the thresholds, a debounce on the transitions and a
 * least-squares trend beside them. One garbage collection is not memory pressure, and one checkpoint
 * is not a reason to restart.
 *
 * **One broken sensor is one broken sensor.** Every reading arrives through a provider, and every
 * provider call is isolated (`providers.cjs`). A provider that throws leaves the dimensions it fed
 * *unknown*, records a fault against itself, lowers the sample's confidence and changes nothing else.
 *
 * ## The action ladder, and where authority stops
 *
 * The ladder is `NO_ACTION → THROTTLE → PAUSE_NEW_WORK → REQUEST_RESTART`, with hysteresis so a score
 * hovering on a threshold does not flap between two decisions. The engine *decides* up to
 * `PAUSE_NEW_WORK`; beyond that it produces a **request**, and a request is not an action. Nothing in
 * this file restarts anything, and nothing in it can: the caller passes in whatever can execute a
 * restart, and when it passes nothing the decision is still made and reported — with the restart
 * marked unavailable rather than silently dropped.
 */

const {
  DIMENSIONS,
  ENRICHMENT_KEYS,
  createProviderRegistry,
  defaultProviders,
  machineProvider,
  processAgeProvider,
  eventLoopProvider,
  workerProvider,
  taskProvider,
  historyProvider,
  clamp,
  reading: makeReading
} = require('./providers.cjs')

const { HEALTH_STATES, TRENDS, DEFAULT_MODEL, createSeverityModel, stateForSample, trendOf } = require('./severity.cjs')

/** The actions, in escalating order. The rank is the order, not a severity scale. */
const ACTIONS = Object.freeze({
  NO_ACTION: 'NO_ACTION',
  THROTTLE: 'THROTTLE',
  PAUSE_NEW_WORK: 'PAUSE_NEW_WORK',
  REQUEST_RESTART: 'REQUEST_RESTART'
})

const ACTION_RANK = Object.freeze({
  NO_ACTION: 0,
  THROTTLE: 1,
  PAUSE_NEW_WORK: 2,
  REQUEST_RESTART: 3
})

/**
 * The shipped defaults. Every threshold has an `exit` below its `enter`, which is the hysteresis.
 *
 * `enrichment` is the part a panel configures: the ceilings the new dimensions are scored against,
 * and the weights they carry *in the enrichment score* — a separate, advisory number that never
 * drives an action on its own. The four base dimensions keep their weights exactly, so the action
 * ladder's behaviour is unchanged by the richer telemetry; what the new dimensions do is change the
 * *state* and the *explanation*.
 */
const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  sampling: { intervalMs: 15_000, windowMs: 300_000, maxSamples: 64 },
  weights: { memory: 0.35, cpu: 0.3, runtime: 0.2, responsiveness: 0.15 },
  thresholds: {
    throttle: { enter: 55, exit: 45 },
    pause: { enter: 70, exit: 60 },
    restart: { enter: 85, exit: 72 }
  },
  cooldowns: { restartMs: 1_800_000, actionMs: 300_000 },
  maintenance: {
    enabled: false,
    windowStart: '03:00',
    windowEnd: '05:00',
    /** How long a restart may be deferred waiting for a safe moment. Never unbounded. */
    maxDeferMs: 1_800_000,
    /** The hard deadline. Past it the request is refused with a reason rather than deferred again. */
    deadlineMs: 7_200_000,
    /**
     * Whether a *planned* machine-level escalation is the tier once the deadline is near.
     *
     * It is off by default and it is not reachable from this plugin: the escalation tier is the
     * restart supervisor's, decided by its maintenance policy, and this monitor never asks for one.
     * The flag exists so a deployment can record the intent without this file gaining a path to it.
     */
    allowSystemEscalation: false
  },
  /** A restart is requested only when the pressure has been sustained, never on one sample. */
  restartRequiresSustainedMs: 120_000,
  /** The five-state model: thresholds, debounce and the floors below which a sample is UNKNOWN. */
  model: { ...DEFAULT_MODEL, thresholds: { ...DEFAULT_MODEL.thresholds } },
  /** The ceilings the enrichment dimensions are measured against. */
  enrichment: {
    queueCeiling: 20,
    longRunningMinutes: 30,
    /** Below this heartbeat quality the sample's confidence is treated as low. */
    heartbeatQualityFloor: 0.5
  }
})

/** Read a clock as minutes since midnight. */
function minutesOfDay(clock) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(clock || ''))
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return null
  return hours * 60 + minutes
}

/**
 * Whether a moment falls inside the maintenance window.
 *
 * A window that ends before it starts is not an error: `23:00` to `01:00` is a perfectly ordinary
 * nightly window and it means "wraps around midnight", not "misconfigured".
 */
function inWindow(minuteOfDay, startClock, endClock) {
  const start = minutesOfDay(startClock)
  const end = minutesOfDay(endClock)
  if (start === null || end === null) return false
  if (start === end) return false
  if (start < end) return minuteOfDay >= start && minuteOfDay < end
  return minuteOfDay >= start || minuteOfDay < end
}

/** A dimension's 0-100 pressure, or null when its telemetry is missing. */
function scoreDimension(name, reading) {
  if (!reading || !Number.isFinite(reading.value)) return null
  const { value, warn, critical } = reading
  if (value <= warn) return clamp((value / Math.max(warn, 1)) * 40)
  if (value >= critical) return 100
  return clamp(40 + ((value - warn) / Math.max(critical - warn, 1)) * 60)
}

/**
 * The default readings, from `node:os` and `node:process`.
 *
 * Kept as an injectable function because a test drives the engine with it, and because a deployment
 * may replace the whole collector. It is one *provider-like* source among several now — the extra
 * dimensions arrive through `providers.cjs` — but it is deliberately still the simplest thing that
 * can work, so a test that only wants the four base dimensions has nothing to set up.
 */
function defaultReadings() {
  const os = require('node:os')
  const total = os.totalmem()
  const free = os.freemem()
  const usedRatio = total > 0 ? 1 - (free / total) : 0

  const cpus = os.cpus()
  const loadAvg = typeof os.loadavg === 'function' ? os.loadavg()[0] : 0
  // Windows reports a meaningless load average, so processor time is derived from the counters
  // instead: the share of ticks that were not idle, across every core.
  let idle = 0
  let total_ = 0
  for (const cpu of cpus) {
    for (const value of Object.values(cpu.times || {})) total_ += value
    idle += (cpu.times && cpu.times.idle) || 0
  }
  const busyRatio = total_ > 0 ? 1 - (idle / total_) : Math.min(loadAvg / Math.max(cpus.length, 1), 1)

  const usage = process.memoryUsage()
  return {
    memory: { value: usedRatio * 100, warn: 70, critical: 92, detail: { freeBytes: free, totalBytes: total } },
    cpu: { value: busyRatio * 100, warn: 75, critical: 95, detail: { cores: cpus.length, loadAvg } },
    runtime: { value: Math.min((process.uptime() / (24 * 3600)) * 100, 100), warn: 60, critical: 90, detail: { uptimeSec: Math.round(process.uptime()), heapUsedBytes: usage.heapUsed } },
    responsiveness: { value: 0, warn: 60, critical: 90, detail: { note: 'the sampler measures event-loop drift itself' } }
  }
}

/**
 * @param {object} [options]
 * @param {Function} [options.readings] returns the raw base-dimension readings
 * @param {Array}  [options.providers] extra telemetry providers
 * @param {object} [options.capabilities] live capability values the providers read through
 * @param {Function} [options.now]
 */
function createHealthEngine(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const read = typeof options.readings === 'function' ? options.readings : defaultReadings
  const config = mergeConfig(DEFAULT_CONFIG, options.config)

  /**
   * Which providers this engine reads through.
   *
   * The registry always carries the *independent* observations — the event loop's own lateness, the
   * heartbeat, the worker pool, the queue and the restart history — because none of them can be
   * supplied by the base collector and none of them overlaps with it.
   *
   * The machine and process-age providers are the opposite case: they produce exactly the dimensions
   * the base collector produces, so registering both would mean two answers to one question. They are
   * therefore registered only when the caller did *not* supply a collector, and a caller that did is
   * the authority for those dimensions — its reading wins, and the provider enriches nothing there.
   */
  const injected = typeof options.readings === 'function'
  const baseProviders = injected ? [] : [machineProvider(), processAgeProvider()]
  const extraProviders = Array.isArray(options.providers) ? options.providers : []
  const providers = createProviderRegistry({
    providers: [...baseProviders, eventLoopProvider(), workerProvider(), taskProvider(), historyProvider(), ...extraProviders]
  })
  const severity = createSeverityModel({ config: config.model, now })
  /** The capability values a provider may read through, refreshed by the plugin on each tick. */
  const capabilities = options.capabilities && typeof options.capabilities === 'object' ? options.capabilities : {}

  const samples = []
  const decisions = []
  let lastAction = ACTIONS.NO_ACTION
  let lastActionAt = 0
  /**
   * `null` means "no restart has ever been requested".
   *
   * This was `0`, which is indistinguishable from "requested at epoch 0" — so under an injected
   * clock producing small timestamps the *first* restart request was suppressed by a cooldown that
   * had never started. Real wall-clock timestamps hid it; a test clock did not.
   */
  let restartRequestedAt = null
  let pressureSince = null
  /** When the current maintenance deferral began, for the bounded defer. */
  let deferringSince = null
  /** Loop drift: how late a scheduled tick actually ran, as a share of its interval. */
  let lastTickAt = null
  let driftMs = 0

  function mergeConfig(base, override) {
    if (!override || typeof override !== 'object') return { ...base }
    const out = { ...base }
    for (const [key, value] of Object.entries(override)) {
      out[key] = value && typeof value === 'object' && !Array.isArray(value)
        ? mergeConfig(base[key] && typeof base[key] === 'object' ? base[key] : {}, value)
        : value
    }
    return out
  }

  /** Update the capability values a provider reads through, without rebuilding the engine. */
  function bindCapabilities(next = {}) {
    Object.assign(capabilities, next)
    return { ...capabilities }
  }

  /** Record a heartbeat beat, so the heartbeat provider has something to score. */
  function beat(atMs = now(), detail = null) {
    return providers.beat('heartbeat', atMs, detail)
  }

  /**
   * Take one sample.
   *
   * The readings are read through a guard because a collector is the one thing here that touches
   * the machine: a `node:os` call that throws must leave a dimension *unknown*, not take the
   * monitor down with it. The same guard, generalized, is what `providers.cjs` does for every
   * provider — this one remains because the base collector is injectable and is not a provider.
   */
  function sample(atMs = now()) {
    let injected = {}
    let failure = null
    try {
      injected = read() || {}
    } catch (error) {
      failure = String(error && error.message ? error.message : error)
      injected = {}
    }

    if (lastTickAt !== null) {
      const interval = config.sampling.intervalMs
      driftMs = Math.max(0, (atMs - lastTickAt) - interval)
    }
    lastTickAt = atMs
    // The loop's own lateness is handed to the provider that owns the dimension, rather than being
    // written straight into the readings: it is one provider's observation, with the same fault
    // boundary as every other, and keeping it there is what makes "a provider cannot take the
    // monitor down" true without an exception for the one reading the monitor makes itself.
    providers.observe('event-loop', driftMs)

    const provided = providers.readAll({
      atMs,
      intervalMs: config.sampling.intervalMs,
      capabilities,
      runtimeHealth: capabilities['runtime-health'] || null,
      restartControl: capabilities['restart-control'] || null,
      pendingWork: typeof capabilities.pendingWork === 'function' ? capabilities.pendingWork() : (capabilities.pendingWork || null),
      ceilings: config.enrichment
    })

    // The base readings are merged with the providers', and the injected value wins for a dimension
    // it names. That precedence is deliberate and observable: a caller that supplied `readings` is
    // the authority for the dimensions it returns, and a provider enriches around it.
    const readings = { ...provided.readings }
    for (const [dimension, value] of Object.entries(injected)) {
      if (value && Number.isFinite(value.value)) readings[dimension] = value
    }
    // Responsiveness is the sampler's own observation, so it always comes from the provider.
    if (provided.readings.responsiveness) readings.responsiveness = provided.readings.responsiveness

    const scores = {}
    const unknown = []
    let weighted = 0
    let weightUsed = 0
    for (const dimension of Object.keys(DIMENSIONS)) {
      const score = scoreDimension(dimension, readings[dimension])
      if (score === null) {
        unknown.push(dimension)
        scores[dimension] = null
        continue
      }
      scores[dimension] = Math.round(score)
      const weight = Number.isFinite(config.weights[dimension]) ? config.weights[dimension] : 0
      weighted += score * weight
      weightUsed += weight
    }
    // Redistribution, not a zero: the score is the weighted mean over the dimensions that *did*
    // report, and the coverage says how much of the intended weight that was.
    const mean = weightUsed > 0 ? weighted / weightUsed : 0
    const reported = Object.values(scores).filter((value) => value !== null)
    const worst = reported.length ? Math.max(...reported) : 0
    /**
     * The mean says how bad things are overall; the worst dimension says whether one thing is on
     * fire.
     *
     * The mean alone is not enough, and this is not a refinement — it was a defect. With the
     * shipped weights, memory and CPU both pinned at critical score 65: above `throttle` and below
     * `pause`, because two calm dimensions (a young process, a responsive loop) dilute them. A
     * monitor that cannot escalate on a machine it can *see* burning is not monitoring anything.
     * The escalation term only applies past 60, so ordinary load still has to accumulate.
     */
    const escalation = Math.max(0, (worst - 60) / 2)
    const pressure = Math.round(clamp(mean + escalation))

    /**
     * The sample confidence combines what the *providers* answered with the *heartbeat quality*.
     *
     * Coverage already says how much of the machine reported; this says how much of the telemetry
     * machinery is working at all. A product whose heartbeat has stopped is a product whose readings
     * are stale even when every dimension answered, and the model refuses to call that healthy.
     */
    const heartbeatQuality = Number.isFinite(provided.enrichment.heartbeatQuality) ? provided.enrichment.heartbeatQuality : null
    const qualityFactor = heartbeatQuality === null ? 1 : Math.max(0.25, heartbeatQuality)
    const confidence = Number(((provided.confidence * qualityFactor)).toFixed(3))

    const entry = {
      at: atMs,
      pressure,
      mean: Math.round(mean),
      worst,
      scores,
      unknown,
      coverage: Math.round(weightUsed * 100),
      confidence,
      driftMs,
      failure,
      /** Every dimension's raw reading, so a report can show what the score was made of. */
      readings: Object.fromEntries(Object.entries(readings).map(([dimension, value]) => [dimension, value ? { value: Math.round(value.value * 100) / 100, warn: value.warn, critical: value.critical, detail: value.detail || null } : null])),
      /** The enrichment dimensions: the extra facts a provider contributed, `null` when unknown. */
      enrichment: Object.fromEntries(ENRICHMENT_KEYS.map((key) => [key, provided.enrichment[key] === undefined ? null : provided.enrichment[key]])),
      /** Which providers answered, and which broke — the fault boundary made visible. */
      providers: { answered: provided.answered.slice(), failures: provided.failures.slice(), missingRequired: provided.missingRequired.slice(), confidence: provided.confidence },
      /** The five-state verdict for *this* sample, before debounce. */
      state: stateForSample({ pressure, coverage: Math.round(weightUsed * 100), confidence }, config.model).state
    }
    samples.push(entry)
    if (samples.length > config.sampling.maxSamples) samples.shift()
    // The severity model sees the sample, which is what carries the debounce and the transitions.
    entry.model = severity.observe(entry, atMs)
    return entry
  }

  /** Samples inside the rolling window, oldest first. */
  function windowed(atMs = now()) {
    const cutoff = atMs - config.sampling.windowMs
    return samples.filter((entry) => entry.at >= cutoff)
  }

  /**
   * The action the current score warrants, with hysteresis.
   *
   * A level is entered at its `enter` threshold and left at its `exit` one, so a score sitting on a
   * boundary does not flap between two decisions -- which for `PAUSE_NEW_WORK` would mean work
   * stopping and starting repeatedly.
   */
  function actionFor(pressure, current) {
    const { throttle, pause, restart } = config.thresholds
    const rank = ACTION_RANK[current] || 0
    let next = ACTIONS.NO_ACTION
    if (pressure >= (rank >= ACTION_RANK.THROTTLE ? throttle.exit : throttle.enter)) next = ACTIONS.THROTTLE
    if (pressure >= (rank >= ACTION_RANK.PAUSE_NEW_WORK ? pause.exit : pause.enter)) next = ACTIONS.PAUSE_NEW_WORK
    if (pressure >= (rank >= ACTION_RANK.REQUEST_RESTART ? restart.exit : restart.enter)) next = ACTIONS.REQUEST_RESTART
    return next
  }

  function minuteOfDayFrom(atMs) {
    const date = new Date(atMs)
    return date.getHours() * 60 + date.getMinutes()
  }

  /** Whether a *planned* restart may happen at this moment, and if not, why not. */
  function maintenanceVerdict(atMs, request) {
    const maintenance = config.maintenance
    if (!request) return { allowed: true, reason: null, deferUntil: null }
    if (!maintenance.enabled) return { allowed: true, reason: 'no maintenance window is configured', deferUntil: null }
    const minute = minuteOfDayFrom(atMs)
    const open = inWindow(minute, maintenance.windowStart, maintenance.windowEnd)
    if (open) {
      deferringSince = null
      return { allowed: true, reason: 'now is inside the maintenance window', deferUntil: null }
    }
    // Outside the window the request is *deferred*, inside a bounded horizon: `maxDeferMs` is how long
    // it may wait for the window to open, and `deadlineMs` is the hard stop past which the answer is
    // a refusal with a reason rather than another deferral.
    if (deferringSince === null) deferringSince = atMs
    const deferredFor = atMs - deferringSince
    if (deferredFor >= maintenance.deadlineMs) {
      return {
        allowed: false,
        reason: `the restart has been deferred for ${deferredFor}ms, past the ${maintenance.deadlineMs}ms maintenance deadline`,
        deferUntil: null,
        deadlinePassed: true
      }
    }
    if (deferredFor >= maintenance.maxDeferMs) {
      return {
        allowed: false,
        reason: `the restart has waited ${deferredFor}ms for the maintenance window, past the ${maintenance.maxDeferMs}ms maximum defer`,
        deferUntil: null,
        maxDeferReached: true
      }
    }
    return {
      allowed: false,
      reason: `now is outside the maintenance window (${maintenance.windowStart}-${maintenance.windowEnd}); the restart is deferred`,
      deferUntil: maintenance.windowStart,
      deferredForMs: deferredFor
    }
  }

  /**
   * Decide, given the current window.
   *
   * The decision is a value: `{ action, pressure, reasons, request }`. When the action is
   * `REQUEST_RESTART` the result carries a **request** and not an instruction — the caller decides
   * whether anything can execute it, and reports back what happened.
   */
  function decide(atMs = now()) {
    const window = windowed(atMs)
    /**
     * A decision with no samples is reported as exactly that, and takes no sample of its own.
     *
     * `decide` used to sample when the window was empty, which made a *read* of the state perform
     * a *write* to it: a caller asking "what do you think" silently consumed a reading, and the
     * sampler's own event-loop drift then reflected the caller's timing rather than the plugin's.
     * No data is a state worth reporting, not a state worth filling in.
     */
    if (!window.length) {
      const empty = {
        at: atMs,
        action: ACTIONS.NO_ACTION,
        pressure: 0,
        peak: 0,
        mean: 0,
        worst: 0,
        scores: Object.fromEntries(Object.keys(DIMENSIONS).map((dimension) => [dimension, null])),
        unknown: Object.keys(DIMENSIONS).slice(),
        coverage: 0,
        confidence: 0,
        state: HEALTH_STATES.UNKNOWN,
        trend: TRENDS.UNKNOWN,
        inMaintenance: false,
        sustainedMs: 0,
        request: null,
        held: null,
        reasons: ['no samples have been taken yet'],
        coverage_note: null,
        maintenance: { allowed: false, reason: 'nothing has been sampled, so nothing may be scheduled', deferUntil: null }
      }
      decisions.push(empty)
      if (decisions.length > 50) decisions.shift()
      return empty
    }
    const latest = window[window.length - 1]
    const peak = window.reduce((max, entry) => Math.max(max, entry.pressure), latest.pressure)
    const sustainedSince = pressureSince === null ? (latest.pressure >= config.thresholds.restart.enter ? latest.at : null) : pressureSince
    pressureSince = latest.pressure >= config.thresholds.restart.enter ? (sustainedSince === null ? latest.at : sustainedSince) : null
    const sustainedMs = pressureSince === null ? 0 : atMs - pressureSince

    const wanted = actionFor(latest.pressure, lastAction)
    const inMaintenance = config.maintenance.enabled && inWindow(minuteOfDayFrom(atMs), config.maintenance.windowStart, config.maintenance.windowEnd)
    const trendResult = trendOf(window, config.model)
    const model = severity.explain(latest, atMs, window)

    const reasons = []
    if (latest.unknown.length) reasons.push(`${latest.unknown.join(', ')} reported no telemetry`)
    if (latest.providers && latest.providers.failures.length) reasons.push(`${latest.providers.failures.map((fault) => fault.provider).join(', ')} telemetry provider(s) failed`)
    if (latest.pressure >= config.thresholds.throttle.enter) reasons.push(`pressure ${latest.pressure} is at or above the throttle threshold`)
    if (trendResult.trend === TRENDS.RISING) reasons.push(`pressure is rising (${trendResult.slopePerMinute}/min)`)
    if (inMaintenance) reasons.push('now is inside the maintenance window')

    let action = wanted
    let request = null
    let held = null
    let maintenance = { allowed: true, reason: null, deferUntil: null }

    if (action === ACTIONS.REQUEST_RESTART) {
      // A restart is the one decision that is *requested* rather than taken, so it has four
      // separate gates: the state must not be UNKNOWN, the pressure must have been sustained, the
      // cooldown must have elapsed, and a maintenance window must allow it.
      if (latest.state === HEALTH_STATES.UNKNOWN) {
        held = `the sample is ${HEALTH_STATES.UNKNOWN} (${model.triggeredReason}), and a restart is never requested on a sample that cannot see the machine`
        action = ACTIONS.PAUSE_NEW_WORK
      } else if (sustainedMs < config.restartRequiresSustainedMs) {
        held = `pressure has been above ${config.thresholds.restart.enter} for ${sustainedMs}ms, short of the ${config.restartRequiresSustainedMs}ms a restart requires`
        action = ACTIONS.PAUSE_NEW_WORK
      } else if (restartRequestedAt !== null && atMs - restartRequestedAt < config.cooldowns.restartMs) {
        held = `a restart was requested ${atMs - restartRequestedAt}ms ago, inside the ${config.cooldowns.restartMs}ms cooldown`
        action = ACTIONS.PAUSE_NEW_WORK
      } else {
        const candidate = {
          reasonCode: 'RUNTIME_PRESSURE',
          reasonSummary: `health pressure ${latest.pressure} sustained for ${sustainedMs}ms (state ${latest.state}, trend ${trendResult.trend})`,
          mode: 'application',
          priority: latest.pressure >= 95 ? 'high' : 'normal',
          checkpointRequired: true
        }
        maintenance = maintenanceVerdict(atMs, candidate)
        if (maintenance.allowed) {
          request = { ...candidate, maintenance: maintenance.reason }
          restartRequestedAt = atMs
        } else {
          held = maintenance.reason
          // A deferral is `PAUSE_NEW_WORK` with a stated horizon: the monitor keeps watching, the
          // request stays pending, and the deadline is what stops it pending forever.
          action = ACTIONS.PAUSE_NEW_WORK
        }
      }
    }

    // The cooldown on *acting* stops the log filling with the same decision, and stops a caller
    // from being told to throttle on every tick.
    if (action !== lastAction || atMs - lastActionAt >= config.cooldowns.actionMs) {
      lastAction = action
      lastActionAt = atMs
    }

    const decision = {
      at: atMs,
      action,
      pressure: latest.pressure,
      peak,
      scores: latest.scores,
      unknown: latest.unknown,
      coverage: latest.coverage,
      confidence: latest.confidence,
      state: latest.state,
      model,
      trend: trendResult.trend,
      slopePerMinute: trendResult.slopePerMinute,
      inMaintenance,
      maintenance,
      sustainedMs,
      request,
      held,
      reasons,
      coverage_note: latest.coverage < 100 ? 'some dimensions had no telemetry; the score is over the rest' : null
    }
    severity.noteDecision(decision)
    decisions.push(decision)
    if (decisions.length > 50) decisions.shift()
    return decision
  }

  /** Note the outcome of a restart request so the cooldown and the report reflect reality. */
  function noteRestartOutcome(outcome) {
    if (outcome && outcome.ok === true) restartRequestedAt = now()
    return outcome
  }

  function report() {
    const window = windowed()
    const latest = samples.length ? samples[samples.length - 1] : null
    return {
      samples: samples.length,
      window: window.length,
      latest,
      peak: window.reduce((max, entry) => Math.max(max, entry.pressure), 0),
      lastAction,
      lastDecision: decisions.length ? decisions[decisions.length - 1] : null,
      restartRequestedAt: restartRequestedAt || null,
      /** The five-state model in force, with its trend and its transitions. */
      state: { current: severity.state, trend: trendOf(window, config.model), since: latest && latest.model ? latest.model.stateSince : null },
      providers: providers.describe(),
      config: {
        intervalMs: config.sampling.intervalMs,
        windowMs: config.sampling.windowMs,
        thresholds: config.thresholds,
        maintenance: config.maintenance,
        model: config.model
      }
    }
  }

  return {
    DIMENSIONS,
    ACTIONS,
    HEALTH_STATES,
    TRENDS,
    config,
    sample,
    decide,
    windowed,
    report,
    noteRestartOutcome,
    decisions: () => decisions.slice(),
    samples: () => samples.slice(),
    providers,
    severity,
    bindCapabilities,
    beat,
    /** One deterministic observation rather than a timer, for the plugin and for tests. */
    observeEventLoop: (drift) => providers.observe('event-loop', drift),
    /** For a test that wants to start clean without rebuilding the engine. */
    reset() {
      samples.length = 0
      decisions.length = 0
      lastAction = ACTIONS.NO_ACTION
      lastActionAt = 0
      restartRequestedAt = null
      pressureSince = null
      deferringSince = null
      providers.reset()
      severity.reset()
    }
  }
}

module.exports = {
  DIMENSIONS,
  ACTIONS,
  ACTION_RANK,
  DEFAULT_CONFIG,
  HEALTH_STATES,
  TRENDS,
  createHealthEngine,
  defaultReadings,
  scoreDimension,
  inWindow,
  minutesOfDay,
  clamp,
  makeReading
}
