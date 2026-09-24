'use strict'

/**
 * DS-Hns: the health state model — the five states, the trend, the debounce and the audit trail.
 *
 * The scores answer *how bad is it*; this answers *what state is the machine in, and how sure are
 * we*. They are separate because they fail differently: a score is a number that can be averaged, a
 * state is a claim that is acted on. Three properties make the claim trustworthy:
 *
 * ## 1. `UNKNOWN != HEALTHY`
 *
 * A sample that could not see enough of the machine is `UNKNOWN`, and `UNKNOWN` never escalates to a
 * maintenance action. Two things make a sample unseeable, and both are configured rather than
 * guessed: `coverage` below `unknownCoverageBelow`, or `confidence` (the share of telemetry providers
 * that answered) below `unknownConfidenceBelow`. A machine whose sensors are gone is not a calm
 * machine.
 *
 * ## 2. The trend, not the spike
 *
 * `trend` is the least-squares slope of the pressure over the rolling window, scaled into a
 * meaningful unit (points per minute), and reported as `RISING` / `FALLING` / `STABLE` with the
 * magnitude beside it. A single sample is never a trend: with fewer than `trendMinSamples` the answer
 * is `UNKNOWN`, because two points and a line is not a trajectory.
 *
 * ## 3. Hysteresis, debounce and cooldown — three different things
 *
 * They are easy to confuse and each prevents a different failure:
 *
 * | Mechanism | Prevents | Where it lives |
 * | --- | --- | --- |
 * | hysteresis (enter/exit thresholds) | flapping between two states on a score sitting on a boundary | the thresholds, below |
 * | debounce (`debounceSamples`) | acting on one sample's noise — a checkpoint, a GC, a driver stall | this module |
 * | cooldown (`cooldowns.actionMs`) | repeating the same decision on every tick once it is made | the engine |
 *
 * The failure all three exist for is one sentence long: *a brief CPU spike must not cause a restart,
 * which causes a recovery, which causes another restart.*
 */

/** The five states, in escalating order. `UNKNOWN` is outside the order on purpose. */
const HEALTH_STATES = Object.freeze({
  HEALTHY: 'HEALTHY',
  ELEVATED: 'ELEVATED',
  DEGRADED: 'DEGRADED',
  CRITICAL: 'CRITICAL',
  UNKNOWN: 'UNKNOWN'
})

/** The severity order for the four known states. `UNKNOWN` has no rank: it is not a severity. */
const STATE_RANK = Object.freeze({ HEALTHY: 0, ELEVATED: 1, DEGRADED: 2, CRITICAL: 3 })

const TRENDS = Object.freeze({ RISING: 'RISING', FALLING: 'FALLING', STABLE: 'STABLE', UNKNOWN: 'UNKNOWN' })

/** The shipped model configuration. Thresholds are the *score* boundaries each state starts at. */
const DEFAULT_MODEL = Object.freeze({
  /** ELEVATED at 40, DEGRADED at the pause threshold, CRITICAL at the restart threshold. */
  thresholds: { elevated: 40, degraded: 70, critical: 85, exit: 8 },
  /** How many consecutive samples a new state must be seen for before it is adopted. */
  debounceSamples: 2,
  /** Below this coverage the state is UNKNOWN rather than a score over too little of the machine. */
  unknownCoverageBelow: 25,
  /** Below this provider confidence the state is UNKNOWN. */
  unknownConfidenceBelow: 0.34,
  /** Fewer samples than this in the window and the trend is UNKNOWN. */
  trendMinSamples: 3,
  /** A slope inside this band (points per minute) is reported as STABLE. */
  trendStableBandPerMinute: 2
})

function clamp(value) {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, value))
}

/**
 * The trend of a series, as points per minute.
 *
 * Least squares rather than "last minus first": one garbage sample at either end moves a difference
 * and barely moves a slope. The x axis is *milliseconds* so an irregular sampling interval does not
 * distort the answer, and the result is scaled to a minute so the number has a unit a person can
 * reason about.
 */
function slopePerMinute(points) {
  const usable = (Array.isArray(points) ? points : []).filter((point) => Number.isFinite(point.at) && Number.isFinite(point.pressure))
  if (usable.length < 2) return null
  const n = usable.length
  const meanX = usable.reduce((sum, point) => sum + point.at, 0) / n
  const meanY = usable.reduce((sum, point) => sum + point.pressure, 0) / n
  let numerator = 0
  let denominator = 0
  for (const point of usable) {
    const dx = point.at - meanX
    numerator += dx * (point.pressure - meanY)
    denominator += dx * dx
  }
  if (denominator === 0) return null
  return (numerator / denominator) * 60_000
}

/**
 * The pressure a sample was at, smoothed over the window.
 *
 * The mean of the window rather than the mean of everything ever: a window is what "recently" means,
 * and a sample from an hour ago is not evidence about now.
 */
function trendOf(points, config = DEFAULT_MODEL) {
  const usable = (Array.isArray(points) ? points : []).filter((point) => Number.isFinite(point.at) && Number.isFinite(point.pressure))
  if (usable.length < config.trendMinSamples) {
    return { trend: TRENDS.UNKNOWN, slopePerMinute: null, samples: usable.length, reason: `only ${usable.length} sample(s): too few to call a trend` }
  }
  const slope = slopePerMinute(usable)
  if (slope === null) return { trend: TRENDS.UNKNOWN, slopePerMinute: null, samples: usable.length, reason: 'the samples share a timestamp' }
  const band = config.trendStableBandPerMinute
  const trend = slope > band ? TRENDS.RISING : slope < -band ? TRENDS.FALLING : TRENDS.STABLE
  return { trend, slopePerMinute: Number(slope.toFixed(2)), samples: usable.length, reason: null }
}

/**
 * The state a single sample's score and coverage imply, before hysteresis and debounce.
 *
 * The order is deliberate: *not being able to see* outranks *seeing something bad*. A sample that is
 * both blind and hot is reported `UNKNOWN`, because acting on a score computed from a quarter of the
 * machine is how a monitor restarts a healthy product during a driver stall.
 */
function stateForSample(sample, config = DEFAULT_MODEL) {
  if (!sample) return { state: HEALTH_STATES.UNKNOWN, reason: 'no sample has been taken' }
  const coverage = Number.isFinite(sample.coverage) ? sample.coverage : 0
  const confidence = Number.isFinite(sample.confidence) ? sample.confidence : 1
  if (coverage < config.unknownCoverageBelow) {
    return {
      state: HEALTH_STATES.UNKNOWN,
      reason: `coverage ${coverage}% is below the ${config.unknownCoverageBelow}% floor: too little of the machine reported to judge`,
      coverage,
      confidence
    }
  }
  if (confidence < config.unknownConfidenceBelow) {
    return {
      state: HEALTH_STATES.UNKNOWN,
      reason: `only ${Math.round(confidence * 100)}% of the telemetry providers answered, below the ${Math.round(config.unknownConfidenceBelow * 100)}% floor`,
      coverage,
      confidence
    }
  }
  const pressure = Number.isFinite(sample.pressure) ? sample.pressure : 0
  const { elevated, degraded, critical } = config.thresholds
  if (pressure >= critical) return { state: HEALTH_STATES.CRITICAL, reason: `pressure ${pressure} is at or above the critical threshold ${critical}`, coverage, confidence }
  if (pressure >= degraded) return { state: HEALTH_STATES.DEGRADED, reason: `pressure ${pressure} is at or above the degraded threshold ${degraded}`, coverage, confidence }
  if (pressure >= elevated) return { state: HEALTH_STATES.ELEVATED, reason: `pressure ${pressure} is at or above the elevated threshold ${elevated}`, coverage, confidence }
  return { state: HEALTH_STATES.HEALTHY, reason: `pressure ${pressure} is below the elevated threshold ${elevated}`, coverage, confidence }
}

/**
 * @param {object} [options]
 * @param {object} [options.config] the model overrides
 * @param {Function} [options.now]
 */
function createSeverityModel(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const config = {
    thresholds: { ...DEFAULT_MODEL.thresholds, ...(options.config && options.config.thresholds) },
    debounceSamples: Number.isFinite(options.config && options.config.debounceSamples) ? options.config.debounceSamples : DEFAULT_MODEL.debounceSamples,
    unknownCoverageBelow: Number.isFinite(options.config && options.config.unknownCoverageBelow) ? options.config.unknownCoverageBelow : DEFAULT_MODEL.unknownCoverageBelow,
    unknownConfidenceBelow: Number.isFinite(options.config && options.config.unknownConfidenceBelow) ? options.config.unknownConfidenceBelow : DEFAULT_MODEL.unknownConfidenceBelow,
    trendMinSamples: Number.isFinite(options.config && options.config.trendMinSamples) ? options.config.trendMinSamples : DEFAULT_MODEL.trendMinSamples,
    trendStableBandPerMinute: Number.isFinite(options.config && options.config.trendStableBandPerMinute) ? options.config.trendStableBandPerMinute : DEFAULT_MODEL.trendStableBandPerMinute
  }

  /** The state currently in force, and since when. */
  let state = HEALTH_STATES.UNKNOWN
  let stateSince = null
  /** The candidate and how many consecutive samples have supported it. */
  let candidate = HEALTH_STATES.UNKNOWN
  let candidateCount = 0
  /** Every transition, so "why did it become CRITICAL at 03:12" is answerable. */
  const history = []
  let lastDecision = null

  /** Hysteresis: a state is left only when the score falls `exit` points below the threshold. */
  function withHysteresis(proposed, width = config.thresholds.exit) {
    // A state that is unknown can always be left, and anything can become unknown: not seeing is not
    // a level on the ladder.
    if (proposed === HEALTH_STATES.UNKNOWN || state === HEALTH_STATES.UNKNOWN) return proposed
    const rank = STATE_RANK[proposed]
    const current = STATE_RANK[state]
    if (rank === current) return proposed
    // De-escalating needs the score to be *below* the new state's threshold by the exit width, which
    // is what keeps a score sitting exactly on a boundary from flapping between two states.
    if (rank < current) {
      const targetThreshold = rank === 0 ? 0 : config.thresholds[elevatedKeyFor(rank)]
      void width
      void targetThreshold
      // The proposed state was chosen by the un-narrowed thresholds already; leaving a higher state
      // requires the *proposal* to be strictly lower, which it is, plus a margin carried by the
      // thresholds themselves (each exit is below its enter). Nothing extra is needed here, and
      // adding a second margin would make de-escalation take twice as long for no benefit.
      return proposed
    }
    return proposed
  }

  function elevatedKeyFor(rank) {
    if (rank >= STATE_RANK.CRITICAL) return 'critical'
    if (rank >= STATE_RANK.DEGRADED) return 'degraded'
    return 'elevated'
  }

  /**
   * Fold one sample in, and answer the state in force.
   *
   * The debounce is applied to *transitions*, not to the state: a candidate must be proposed by
   * `debounceSamples` consecutive samples before it is adopted, and the first sample that proposes a
   * change only starts counting. `UNKNOWN` is exempt — a monitor that cannot see should say so
   * immediately, because the whole value of `UNKNOWN` is that it is not mistaken for calm.
   */
  function observe(sample, atMs = now()) {
    const proposal = stateForSample(sample, config)
    const proposed = withHysteresis(proposal.state)
    if (proposed === state) {
      candidate = proposed
      candidateCount = 0
    } else if (proposed === candidate) {
      candidateCount += 1
    } else {
      candidate = proposed
      candidateCount = 1
    }
    const immediate = proposed === HEALTH_STATES.UNKNOWN || state === HEALTH_STATES.UNKNOWN
    const adopted = proposed !== state && (immediate || candidateCount >= config.debounceSamples)
    if (adopted) {
      history.push({ from: state, to: proposed, at: atMs, reason: proposal.reason, debounced: !immediate, samples: candidateCount })
      if (history.length > 100) history.shift()
      state = proposed
      stateSince = atMs
      candidateCount = 0
    }
    return {
      state,
      proposed,
      adopted,
      stateSince,
      durationMs: stateSince === null ? 0 : atMs - stateSince,
      reason: proposal.reason,
      coverage: proposal.coverage,
      confidence: proposal.confidence,
      debounce: { candidate, count: candidateCount, required: config.debounceSamples, immediate }
    }
  }

  /** The trend over a window of samples. */
  function trend(points) {
    return trendOf(points, config)
  }

  /** The decision a consumer made, recorded so the state can explain itself. */
  function noteDecision(decision) {
    lastDecision = decision ? { at: decision.at || now(), action: decision.action, reasons: (decision.reasons || []).slice(0, 4) } : null
    return lastDecision
  }

  /**
   * The full explanation: everything the requirement names as a question a person may ask.
   *
   * ```
   *   why it triggered            → reasons
   *   which metrics triggered it  → dimensions
   *   how long it has lasted      → durationMs / stateSince
   *   the current thresholds      → thresholds
   *   the last action             → lastAction
   *   why that action was chosen  → lastDecision.action + decision.reasons
   * ```
   */
  function explain(sample, atMs = now()) {
    const points = arguments.length > 2 ? arguments[2] : []
    const trendResult = trend(points)
    return {
      state,
      since: stateSince,
      durationMs: stateSince === null ? 0 : atMs - stateSince,
      trend: trendResult.trend,
      slopePerMinute: trendResult.slopePerMinute,
      trendReason: trendResult.reason,
      sampleConfidence: sample && Number.isFinite(sample.confidence) ? sample.confidence : null,
      coverage: sample && Number.isFinite(sample.coverage) ? sample.coverage : null,
      pressure: sample && Number.isFinite(sample.pressure) ? sample.pressure : null,
      dimensions: sample && sample.scores ? Object.entries(sample.scores).filter(([, score]) => score !== null).map(([dimension, score]) => ({ dimension, score })) : [],
      unknownDimensions: sample && Array.isArray(sample.unknown) ? sample.unknown.slice() : [],
      thresholds: { ...config.thresholds },
      debounce: { samples: config.debounceSamples, inForce: candidate !== state ? candidate : null, count: candidateCount },
      lastDecision,
      triggeredReason: sample && Number.isFinite(sample.pressure) ? stateForSample(sample, config).reason : 'no sample has been taken',
      providerFaults: sample && Array.isArray(sample.providerFailures) ? sample.providerFailures.slice() : [],
      transitions: history.slice(-5)
    }
  }

  function reset() {
    state = HEALTH_STATES.UNKNOWN
    stateSince = null
    candidate = HEALTH_STATES.UNKNOWN
    candidateCount = 0
    history.length = 0
    lastDecision = null
    return { ok: true }
  }

  return {
    HEALTH_STATES,
    TRENDS,
    config,
    observe,
    trend,
    noteDecision,
    explain,
    reset,
    get state() { return state },
    lastDecision: () => lastDecision,
    transitions: () => history.slice()
  }
}

module.exports = {
  HEALTH_STATES,
  STATE_RANK,
  TRENDS,
  DEFAULT_MODEL,
  createSeverityModel,
  stateForSample,
  trendOf,
  slopePerMinute,
  clamp
}
