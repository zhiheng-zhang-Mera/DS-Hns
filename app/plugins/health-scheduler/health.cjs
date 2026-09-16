'use strict'

/**
 * DS-Hns: the health engine behind `dshns.health-scheduler`.
 *
 * This is the part that reads the machine and the runtime, keeps a bounded history, scores a
 * pressure and decides what to do about it. It is deliberately free of any host coupling: it takes
 * a `readings()` function, a clock and a configuration, and returns values. That is what makes it
 * testable without a machine under load, and what keeps the plugin's lifecycle in `index.cjs`
 * where the platform's contract lives.
 *
 * ## Two rules the scoring follows
 *
 * **Unknown is never healthy.** A dimension whose telemetry is missing is reported `unknown` and
 * its weight is *redistributed* across the dimensions that did report, with the coverage published
 * alongside the score. Scoring a missing sensor as zero pressure is how a monitor reports calm on a
 * machine it cannot see.
 *
 * **Pressure is a trend, not a spike.** Samples enter a rolling window and the score uses the
 * window's behaviour, not the latest number. One garbage collection is not memory pressure.
 *
 * ## The action ladder, and where authority stops
 *
 * The ladder is `NO_ACTION → THROTTLE → PAUSE_NEW_WORK → REQUEST_RESTART`, with hysteresis so a
 * score hovering on a threshold does not flap between two decisions. The engine *decides* up to
 * `PAUSE_NEW_WORK`; beyond that it produces a **request**, and a request is not an action. Nothing
 * in this file restarts anything, and nothing in it can: the caller passes in whatever can execute
 * a restart, and when it passes nothing the decision is still made and reported — with the restart
 * marked unavailable rather than silently dropped.
 */

/** The dimensions a score is made of, and what each one is reading. */
const DIMENSIONS = Object.freeze({
  memory: 'how much of the machine\'s memory is committed',
  cpu: 'how loaded the machine\'s processors are',
  runtime: 'how long this process has been up and how much it has grown',
  responsiveness: 'how far the event loop is drifting from its schedule'
})

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

/** The shipped defaults. Every threshold has an `exit` below its `enter`, which is the hysteresis. */
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
  maintenance: { enabled: false, windowStart: '03:00', windowEnd: '05:00' },
  /** A restart is requested only when the pressure has been sustained, never on one sample. */
  restartRequiresSustainedMs: 120_000
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

/** Clamp to the 0-100 a score lives in. */
function clamp(value) {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, value))
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
 * Injectable so a test can drive the engine without a machine under load, and so a deployment can
 * extend it without editing this file.
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
 * @param {Function} [options.readings] returns the raw dimension readings
 * @param {Function} [options.now]
 */
function createHealthEngine(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const read = typeof options.readings === 'function' ? options.readings : defaultReadings
  const config = mergeConfig(DEFAULT_CONFIG, options.config)

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

  /**
   * Take one sample.
   *
   * The readings are read through a guard because a collector is the one thing here that touches
   * the machine: a `node:os` call that throws must leave a dimension *unknown*, not take the
   * monitor down with it.
   */
  function sample(atMs = now()) {
    let readings = {}
    let failure = null
    try {
      readings = read() || {}
    } catch (error) {
      failure = String(error && error.message ? error.message : error)
      readings = {}
    }

    if (lastTickAt !== null) {
      const interval = config.sampling.intervalMs
      driftMs = Math.max(0, (atMs - lastTickAt) - interval)
    }
    lastTickAt = atMs
    // Responsiveness is measured here rather than collected: it is the sampler's own observation
    // about the process it is running in.
    const driftShare = Math.min((driftMs / Math.max(config.sampling.intervalMs, 1)) * 100, 100)
    readings = {
      ...readings,
      responsiveness: { value: driftShare, warn: 60, critical: 90, detail: { driftMs } }
    }

    const at = atMs
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
    const entry = { at, pressure, mean: Math.round(mean), worst, scores, unknown, coverage: Math.round(weightUsed * 100), driftMs, failure }
    samples.push(entry)
    if (samples.length > config.sampling.maxSamples) samples.shift()
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
        inMaintenance: false,
        sustainedMs: 0,
        request: null,
        held: null,
        reasons: ['no samples have been taken yet'],
        coverage_note: null
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

    const reasons = []
    if (latest.unknown.length) reasons.push(`${latest.unknown.join(', ')} reported no telemetry`)
    if (latest.pressure >= config.thresholds.throttle.enter) reasons.push(`pressure ${latest.pressure} is at or above the throttle threshold`)
    if (inMaintenance) reasons.push('now is inside the maintenance window')

    let action = wanted
    let request = null
    let held = null

    if (action === ACTIONS.REQUEST_RESTART) {
      // A restart is the one decision that is *requested* rather than taken, so it has three
      // separate gates: the pressure must have been sustained, the cooldown must have elapsed, and
      // the caller must be able to execute it.
      if (sustainedMs < config.restartRequiresSustainedMs) {
        held = `pressure has been above ${config.thresholds.restart.enter} for ${sustainedMs}ms, short of the ${config.restartRequiresSustainedMs}ms a restart requires`
        action = ACTIONS.PAUSE_NEW_WORK
      } else if (restartRequestedAt !== null && atMs - restartRequestedAt < config.cooldowns.restartMs) {
        held = `a restart was requested ${atMs - restartRequestedAt}ms ago, inside the ${config.cooldowns.restartMs}ms cooldown`
        action = ACTIONS.PAUSE_NEW_WORK
      } else {
        request = {
          reasonCode: 'RUNTIME_PRESSURE',
          reasonSummary: `health pressure ${latest.pressure} sustained for ${sustainedMs}ms`,
          mode: 'application',
          priority: latest.pressure >= 95 ? 'high' : 'normal',
          checkpointRequired: true
        }
        restartRequestedAt = atMs
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
      inMaintenance,
      sustainedMs,
      request,
      held,
      reasons,
      coverage_note: latest.coverage < 100 ? 'some dimensions had no telemetry; the score is over the rest' : null
    }
    decisions.push(decision)
    if (decisions.length > 50) decisions.shift()
    return decision
  }

  function minuteOfDayFrom(atMs) {
    const date = new Date(atMs)
    return date.getHours() * 60 + date.getMinutes()
  }

  /** Note the outcome of a restart request so the cooldown and the report reflect reality. */
  function noteRestartOutcome(outcome) {
    if (outcome && outcome.ok === true) restartRequestedAt = now()
    return outcome
  }

  function report() {
    const window = windowed()
    return {
      samples: samples.length,
      window: window.length,
      latest: samples.length ? samples[samples.length - 1] : null,
      peak: window.reduce((max, entry) => Math.max(max, entry.pressure), 0),
      lastAction,
      lastDecision: decisions.length ? decisions[decisions.length - 1] : null,
      restartRequestedAt: restartRequestedAt || null,
      config: {
        intervalMs: config.sampling.intervalMs,
        windowMs: config.sampling.windowMs,
        thresholds: config.thresholds,
        maintenance: config.maintenance
      }
    }
  }

  return {
    DIMENSIONS,
    ACTIONS,
    config,
    sample,
    decide,
    windowed,
    report,
    noteRestartOutcome,
    decisions: () => decisions.slice(),
    samples: () => samples.slice(),
    /** For a test that wants to start clean without rebuilding the engine. */
    reset() {
      samples.length = 0
      decisions.length = 0
      lastAction = ACTIONS.NO_ACTION
      lastActionAt = 0
      restartRequestedAt = 0
      pressureSince = null
    }
  }
}

module.exports = {
  DIMENSIONS,
  ACTIONS,
  ACTION_RANK,
  DEFAULT_CONFIG,
  createHealthEngine,
  defaultReadings,
  scoreDimension,
  inWindow,
  minutesOfDay,
  clamp
}
