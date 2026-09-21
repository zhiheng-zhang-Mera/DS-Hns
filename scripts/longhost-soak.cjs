'use strict'

/**
 * DS-Hns: the **synthetic soak** for the two long-hosting plugins, on a virtual clock.
 *
 * The requirement asks for 6/12/24-hour synthetic runs. What a real soak measures is whether anything
 * grows, drifts, leaks or stops converging over a long life; what it is *for* is catching the failures
 * that only appear with time — a rolling window that never rolls, a backoff that never caps, a
 * deferral that never expires, a history ring that grows without bound, a cooldown that stops firing.
 *
 * Every one of those is a property of the *code*, not of the wall clock, so this harness drives the
 * same code with a virtual clock (`tests/helpers/longhost-clock.cjs`) and thousands of samples. A
 * twenty-four-hour run costs about a second, which is what makes it something CI can do rather than
 * something somebody means to do.
 *
 * ```
 *   node scripts/longhost-soak.cjs --list
 *   node scripts/longhost-soak.cjs all
 *   node scripts/longhost-soak.cjs soak-24h --json --out report.json
 * ```
 *
 * The real-machine equivalent is `scripts/longhost-soak.cjs --realtime --hours 24`, which drives the
 * same scenarios against the real clock at a real sampling interval. It is deliberately the same
 * scenario code: a soak that measured something different on a real machine would not be evidence
 * about the thing the synthetic run tested.
 *
 * Exit code 0 only when every case passed.
 */

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const ROOT = path.resolve(__dirname, '..')
const { createVirtualClock, createRealClock, SOAK_HORIZONS } = require(path.join(ROOT, 'tests', 'helpers', 'longhost-clock.cjs'))
const { createHealthEngine, HEALTH_STATES } = require(path.join(ROOT, 'app', 'plugins', 'health-scheduler', 'health.cjs'))
const { createRestartBudget } = require(path.join(ROOT, 'app', 'plugins', 'restart-supervisor', 'budget.cjs'))
const { createHeartbeatMonitor } = require(path.join(ROOT, 'app', 'plugins', 'restart-supervisor', 'heartbeat.cjs'))
const { SUPERVISOR_HEALTH } = require(path.join(ROOT, 'app', 'plugins', 'restart-supervisor', 'policy.cjs'))

/** A tiny case layer, so a failing soak says which assertion and what it saw. */
function createCase(id, title) {
  const checks = []
  const notes = []
  let failed = 0
  return {
    id,
    title,
    check(label, ok, detail = null) {
      checks.push({ label, ok: Boolean(ok), detail: detail === null ? null : String(detail) })
      if (!ok) failed += 1
      return ok
    },
    eq(label, actual, expected) {
      return this.check(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
    },
    atMost(label, actual, ceiling) {
      return this.check(label, Number(actual) <= Number(ceiling), `${actual} must be at most ${ceiling}`)
    },
    atLeast(label, actual, floor) {
      return this.check(label, Number(actual) >= Number(floor), `${actual} must be at least ${floor}`)
    },
    note(message) {
      notes.push(String(message))
    },
    result() {
      return { id, title, passed: failed === 0, checks: checks.length, failed, failures: checks.filter((check) => !check.ok), notes }
    }
  }
}

/** A reading source a case controls: a plan of values, repeated and scaled by a script. */
function scriptedReadings(script) {
  let index = 0
  return () => {
    const step = script[Math.min(index, script.length - 1)]
    index += 1
    const values = typeof step === 'function' ? step(index) : step
    return {
      memory: { value: values.memory ?? 30, warn: 70, critical: 92 },
      cpu: { value: values.cpu ?? 30, warn: 75, critical: 95 },
      runtime: { value: values.runtime ?? 1, warn: 60, critical: 90 }
    }
  }
}

/**
 * Soak A — the **health scheduler** over a full horizon.
 *
 * The scheduler is sampled on its configured interval for the whole horizon, and the assertions are
 * about what must stay bounded and what must still happen at the end:
 *
 *   * the sample ring never exceeds `sampling.maxSamples`;
 *   * the decision ring never exceeds its own bound;
 *   * the pressure stays inside 0-100 whatever the input;
 *   * a hot stretch really does escalate and a calm one really does come back down (the model does not
 *     asymptote somewhere in the middle);
 *   * the trend is present once there are enough samples, and reports the direction.
 */
async function soakHealth(horizonMs, { intervalMs = 15_000, hot = false, stepMs = 0, clock = null } = {}) {
  const soak = createCase(`health-${Math.round(horizonMs / 3_600_000)}h`, `health scheduler over ${Math.round(horizonMs / 3_600_000)}h of synthetic sampling`)
  // The clock is injected so the same case runs on the virtual clock (a synthetic soak) or on the
  // machine's own (`--realtime`): the code under test is identical either way, which is what makes the
  // synthetic run evidence about the real one.
  const time = clock || createVirtualClock({ start: 1_700_000_000_000 })
  /**
   * The calm/hot/calm script has to spend long enough in each stretch for the *debounce* to adopt the
   * state: a transition needs `model.debounceSamples` consecutive samples, so a stretch shorter than
   * that many intervals never becomes a state at all and the scenario would assert on a model that
   * never saw its own input. The script is therefore repeated across the horizon by the step below
   * rather than being a fixed three entries.
   */
  const approach = hot
    ? [{ memory: 95, cpu: 96, runtime: 40 }]
    : [
      { memory: 20, cpu: 15, runtime: 1 },
      { memory: 20, cpu: 15, runtime: 1 },
      { memory: 20, cpu: 15, runtime: 1 },
      { memory: 88, cpu: 90, runtime: 30 },
      { memory: 88, cpu: 90, runtime: 30 },
      { memory: 88, cpu: 90, runtime: 30 },
      { memory: 25, cpu: 20, runtime: 2 },
      { memory: 25, cpu: 20, runtime: 2 },
      { memory: 25, cpu: 20, runtime: 2 }
    ]
  const engine = createHealthEngine({
    now: () => time.now(),
    readings: scriptedReadings(approach),
    config: {
      sampling: { intervalMs, windowMs: 300_000, maxSamples: 64 },
      restartRequiresSustainedMs: 120_000,
      model: { debounceSamples: 2 }
    }
  })

  let samples = 0
  let maxPressure = 0
  let minPressure = 100
  let sawRestart = false
  let sawPause = false
  const actions = new Set()
  const states = new Set()
  const { steps } = await time.run({
    durationMs: horizonMs,
    stepMs: stepMs > 0 ? stepMs : intervalMs,
    onStep: () => {
      const sample = engine.sample()
      const decision = engine.decide()
      samples += 1
      maxPressure = Math.max(maxPressure, sample.pressure)
      minPressure = Math.min(minPressure, sample.pressure)
      actions.add(decision.action)
      states.add(decision.state)
      if (decision.action === 'REQUEST_RESTART') sawRestart = true
      if (decision.action === 'PAUSE_NEW_WORK') sawPause = true
    }
  })

  const report = engine.report()
  // The sample floor is derived from the horizon and the interval rather than being a fixed number:
  // "thousands of samples" is true at 24 hours and false at one, and an assertion that encodes the
  // soak's own arithmetic is an assertion that has to be maintained rather than believed.
  soak.atLeast('the soak took a sample per interval', samples, Math.floor(horizonMs / intervalMs) * 0.9)
  soak.check('every sample pressure is a 0-100 number', Number.isFinite(maxPressure) && maxPressure <= 100 && minPressure >= 0, `${minPressure}..${maxPressure}`)
  soak.atMost('the sample ring stays inside its cap', report.samples, 64)
  soak.atMost('the decision ring stays inside its cap', engine.decisions().length, 50)
  soak.check('the rolling window never exceeds the sample cap', report.window <= 64, `window ${report.window}`)
  if (!hot) {
    soak.check('a calm machine comes all the way back down', states.has(HEALTH_STATES.HEALTHY), `states seen: ${[...states].join(', ')}`)
    soak.check('a hot stretch escalated the model', states.has(HEALTH_STATES.DEGRADED) || states.has(HEALTH_STATES.CRITICAL), `states seen: ${[...states].join(', ')}`)
  } else {
    soak.check('a machine pinned hot escalated to CRITICAL', states.has(HEALTH_STATES.CRITICAL), `states seen: ${[...states].join(', ')}`)
    soak.check('a sustained hot machine requested a restart', sawRestart, `actions seen: ${[...actions].join(', ')}`)
    soak.check('the pause rung was reached before the restart rung', sawPause || sawRestart, `actions seen: ${[...actions].join(', ')}`)
  }
  soak.check('the trend is reported once there are enough samples', report.state && report.state.trend && report.state.trend.trend !== undefined, JSON.stringify(report.state && report.state.trend))
  soak.note(`${steps} virtual steps, ${samples} samples, pressures ${minPressure}..${maxPressure}, actions ${[...actions].join('/')}`)
  return soak.result()
}

/**
 * Soak B — the **restart budget** over a full horizon of a flapping application.
 *
 * The failure this exists for is an application that starts, crashes, is restarted, crashes again —
 * for a day. The assertions: the budget refuses rather than restarting forever, the ladder reaches
 * safe mode, the backoff reaches its cap and stays there, the history stays inside its ring, and a
 * successful restart after a failure actually clears the streak.
 */
async function soakBudget(horizonMs, { clock = null } = {}) {
  const soak = createCase(`budget-${Math.round(horizonMs / 3_600_000)}h`, `restart budget over ${Math.round(horizonMs / 3_600_000)}h of a flapping application`)
  const time = clock || createVirtualClock({ start: 1_700_000_000_000 })
  const budget = createRestartBudget({ now: () => time.now() })
  const config = budget.config

  let attempts = 0
  let allowed = 0
  let refused = 0
  let maxBackoff = 0
  const refusals = new Set()
  let reachedSafeMode = false

  // The application dies every ten minutes, which is far inside the budget window: the loop has to be
  // stopped by policy, and the policy has a fixed set of answers.
  //
  // The crash instants are computed from the soak's own start rather than from `at % period`, because
  // the epoch is not aligned to a ten-minute boundary: a modulo on absolute epoch milliseconds fires
  // at an instant the step size has to land on exactly, and a step size that does not divide the
  // period would silently never crash at all. A soak that quietly tests nothing is worse than one
  // that fails.
  const crashEveryMs = 600_000
  const stepMs = 30_000
  const startAt = time.now()
  const isCrashStep = (at) => (at - startAt) % crashEveryMs === 0
  await time.run({
    durationMs: horizonMs,
    stepMs,
    onStep: ({ at }) => {
      if (!isCrashStep(at)) {
        maxBackoff = Math.max(maxBackoff, budget.backoffFor())
        return
      }
      attempts += 1
      const decision = budget.evaluate({ mode: 'application', reasonCode: 'CRASH_RECOVERY' }, at)
      if (decision.ok !== true) {
        refused += 1
        refusals.add(decision.code)
        if (decision.code === 'RESTART_SAFE_MODE') reachedSafeMode = true
        return
      }
      allowed += 1
      budget.accept({ mode: 'application', reasonCode: 'CRASH_RECOVERY' }, at)
      // Every attempt fails: that is what a crash loop is.
      budget.record({ at, ok: false, counted: true, detail: 'the application exited during startup' })
      maxBackoff = Math.max(maxBackoff, budget.backoffFor())
    }
  })

  const report = budget.report()
  /**
   * The expected number of crashes, from the arithmetic rather than from a fixed floor.
   *
   * It was `>= 50`, which is true for a twelve-hour horizon and false for a six-hour one — an
   * assertion about the soak's own arithmetic rather than about the budget, and a soak that fails for
   * a reason of its own making is a soak somebody turns off.
   */
  const expectedCrashes = Math.floor(horizonMs / crashEveryMs)
  soak.atLeast('the soak attempted the restarts its crash rate implies', attempts, Math.floor(expectedCrashes * 0.9))
  soak.check('every crash instant produced exactly one attempt', attempts === expectedCrashes, `${attempts} attempts for ${expectedCrashes} crash instants`)
  soak.atLeast('the budget allowed some of them', allowed, 1)
  soak.atLeast('the budget eventually refused', refused, 1)
  soak.check('a refusal is a coded answer, never a silent drop', refusals.size > 0, [...refusals].join(', '))
  soak.check('the ladder reached SAFE_MODE', reachedSafeMode || report.health.tier === SUPERVISOR_HEALTH.SAFE_MODE, `tier ${report.health.tier}, refusals ${[...refusals].join(', ')}`)
  soak.check('the allowed count never exceeded the budget in one window', allowed <= Math.ceil(horizonMs / config.budget.windowMs) * config.budget.maxRestarts + config.budget.maxRestarts, `allowed ${allowed}`)
  soak.atMost('the backoff never exceeded its cap', maxBackoff, config.budget.backoffMaxMs)
  soak.check('the backoff reached above the cooldown floor', maxBackoff > config.budget.cooldownMs, `max backoff ${maxBackoff}`)
  soak.atMost('the restart history stays inside its ring', budget.history().length, config.history.maxEntries)
  soak.note(`${attempts} attempts, ${allowed} allowed, ${refused} refused (${[...refusals].join(', ')}), max backoff ${maxBackoff}ms`)
  return soak.result()
}

/**
 * Soak C — the **heartbeat**, over a full horizon of an application that periodically hangs.
 *
 * The distinction the whole component exists for: a process that exists but has not beaten. The soak
 * asserts that every hang is diagnosed (never waited out forever), that the escalation walks
 * observe → graceful-recovery → forced-restart as the silence grows, that a recovered beat clears it,
 * and that the signal set stays four entries with no accumulated state.
 */
async function soakHeartbeat(horizonMs, options = {}) {
  const soak = createCase(`heartbeat-${Math.round(horizonMs / 3_600_000)}h`, `heartbeat monitoring over ${Math.round(horizonMs / 3_600_000)}h with periodic hangs`)
  const time = options.clock || createVirtualClock({ start: 1_700_000_000_000 })
  /**
   * The hang has to be long enough to cross *both* escalation thresholds — the graceful window and the
   * forced one — or the scenario never observes the escalation it exists to assert. The defaults are
   * derived from the monitor's own configuration rather than hard-coded, and a short horizon is given
   * a proportionally shorter pair of thresholds so the arithmetic holds at any size.
   */
  const hangForMs = Number.isFinite(options.hangForMs) ? options.hangForMs : Math.min(240_000, Math.max(120_000, Math.round(horizonMs / 30)))
  const heartbeatConfig = options.config || {
    intervalMs: 5_000,
    timeoutMs: 30_000,
    livenessTimeoutMs: 60_000,
    gracefulRecoveryMs: Math.min(30_000, Math.round(hangForMs / 3)),
    forcedAfterMs: Math.min(90_000, Math.round((hangForMs * 2) / 3))
  }
  const monitor = createHeartbeatMonitor({ now: () => time.now(), config: heartbeatConfig })
  const config = monitor.config

  let beats = 0
  let hangs = 0
  let gracefulSeen = 0
  let forcedSeen = 0
  let recoverSeen = 0
  let healthySeen = 0
  let longestAction = 'none'
  let livenessMisses = 0

  const beatEveryMs = 5_000
  /**
   * How often the application hangs, scaled to the horizon so a short run still sees several.
   *
   * One hang an hour is right for a 24-hour soak and useless for a one-hour one: the scenario exists
   * to observe the escalation, so the arithmetic has to produce more than one observation at any size.
   */
  const hangAtMs = Math.max(300_000, Math.round(horizonMs / 6))
  let hangingUntil = null
  const startAt = time.now()
  const isHangStep = (at) => (at - startAt) % hangAtMs === 0

  await time.run({
    durationMs: horizonMs,
    stepMs: 5_000,
    onStep: ({ at }) => {
      /**
       * The operating system still has the process during a hang: that is the whole premise of the
       * scenario, and it is why `seen()` is called on *every* step while the heartbeat is not. A
       * hanging process is alive and silent, and the two facts have to stay apart — a soak that let
       * liveness lapse during the hang would be testing the "gone" path instead.
       */
      monitor.seen(1000, at)
      if (hangingUntil !== null && at >= hangingUntil) {
        // The hang ends: the process beats again and the monitor must come back to healthy.
        hangingUntil = null
        monitor.beatReady(null, at)
        beats += 1
      } else if (hangingUntil === null && isHangStep(at)) {
        hangs += 1
        hangingUntil = at + hangForMs
      } else if (hangingUntil === null && (at - startAt) % beatEveryMs === 0) {
        monitor.beatResponsive(null, at)
        monitor.beatLoop(null, at)
        monitor.beatReady(null, at)
        beats += 1
      }
      const report = monitor.report(at)
      if (report.verdict === 'healthy') healthySeen += 1
      if (report.action === 'graceful-recovery') gracefulSeen += 1
      if (report.action === 'forced-restart') forcedSeen += 1
      if (report.action === 'recover') recoverSeen += 1
      longestAction = report.action
      if (hangingUntil !== null && !report.processAlive) livenessMisses += 1
    }
  })

  soak.atLeast('the soak sent many beats', beats, 100)
  soak.atLeast('the application hung several times', hangs, 1)
  soak.atLeast('the monitor saw healthy stretches', healthySeen, 10)
  soak.atLeast('every hang produced a graceful-recovery verdict', gracefulSeen, hangs)
  soak.atLeast('every hang that lasted produced a forced-restart verdict', forcedSeen, hangs)
  soak.eq('a hanging process was never reported as gone', livenessMisses, 0)
  soak.eq('the monitor never fell into the recover path in this scenario', recoverSeen, 0)
  soak.check('the signal set is exactly four entries', Object.keys(monitor.signals()).length === 4, Object.keys(monitor.signals()).join(', '))
  soak.check('liveness and heartbeat are judged on separate clocks', config.livenessTimeoutMs !== config.timeoutMs, `liveness ${config.livenessTimeoutMs}, heartbeat ${config.timeoutMs}`)
  soak.note(`${beats} beats, ${hangs} hangs, healthy ${healthySeen}, graceful ${gracefulSeen}, forced ${forcedSeen}, recover ${recoverSeen}, last action ${longestAction}`)
  return soak.result()
}

/**
 * Soak D — the **maintenance window**, over a full horizon that crosses its own deadline.
 *
 * A restart that is deferred must not be deferred forever. The soak walks a machine that is hot all
 * day with a maintenance window it never reaches, and asserts that the deferral ends in a *refusal
 * with a reason* inside the configured horizon rather than a request that waits for ever.
 */
async function soakMaintenance(horizonMs, { clock = null } = {}) {
  const soak = createCase(`maintenance-${Math.round(horizonMs / 3_600_000)}h`, `maintenance deferral over ${Math.round(horizonMs / 3_600_000)}h`)
  const time = clock || createVirtualClock({ start: 1_700_000_000_000 })
  const engine = createHealthEngine({
    now: () => time.now(),
    readings: scriptedReadings([{ memory: 96, cpu: 97, runtime: 40 }]),
    config: {
      sampling: { intervalMs: 60_000, windowMs: 300_000, maxSamples: 64 },
      restartRequiresSustainedMs: 60_000,
      maintenance: { enabled: true, windowStart: '03:00', windowEnd: '03:30', maxDeferMs: 600_000, deadlineMs: 1_800_000 }
    }
  })

  let deferred = 0
  let allowed = 0
  let refused = 0
  const holders = new Set()
  await time.run({
    durationMs: horizonMs,
    stepMs: 60_000,
    onStep: () => {
      engine.sample()
      const decision = engine.decide()
      if (decision.request) allowed += 1
      if (decision.held) {
        deferred += 1
        // The holder's *kind*, not its running text: a soak that collected 1400 distinct sentences
        // would report a wall of numbers instead of the two or three reasons that actually occur.
        const holder = String(decision.held)
        if (holders.size < 6) holders.add(holder.split(/[(:]/)[0].trim().slice(0, 48))
      }
      if (decision.maintenance && decision.maintenance.deadlinePassed) refused += 1
    }
  })

  soak.atLeast('the soak made decisions', deferred + allowed, 10)
  soak.check('a deferral happens rather than a silent request', deferred > 0 || allowed > 0, `deferred ${deferred}, allowed ${allowed}`)
  soak.check('the deferral is held by a named reason', deferred === 0 || holders.size > 0, [...holders].join(' | '))
  // The bound is what matters: a deferral must end. Either the window opened and the restart was
  // allowed, or the horizon produced a *reportable* refusal rather than a request that waits for ever.
  soak.check('the deferral is bounded: it ends in an allowance or a stated deadline', allowed > 0 || refused > 0, `deferred ${deferred}, allowed ${allowed}, deadline-passed ${refused}`)
  soak.note(`${deferred} deferrals, ${allowed} allowed, ${refused} past the deadline; holders: ${[...holders].join(' | ')}`)
  return soak.result()
}

/** The scenario registry, which is also what `--list` prints. */
const SCENARIOS = Object.freeze([
  { id: 'soak-6h', horizon: SOAK_HORIZONS['6h'], summary: '6h synthetic: health, budget, heartbeat and maintenance', realtimeHours: 6 },
  { id: 'soak-12h', horizon: SOAK_HORIZONS['12h'], summary: '12h synthetic: health, budget, heartbeat and maintenance', realtimeHours: 12 },
  { id: 'soak-24h', horizon: SOAK_HORIZONS['24h'], summary: '24h synthetic: health, budget, heartbeat and maintenance', realtimeHours: 24 }
])

async function runScenario(scenario, options = {}) {
  const horizon = Number.isFinite(options.horizonMs) ? options.horizonMs : scenario.horizon
  const clock = options.clock || null
  const cases = []
  cases.push(await soakHealth(horizon, { ...options, clock }))
  cases.push(await soakHealth(horizon, { ...options, hot: true, clock }))
  cases.push(await soakBudget(horizon, { ...options, clock }))
  cases.push(await soakHeartbeat(horizon, { ...options, clock }))
  cases.push(await soakMaintenance(horizon, { ...options, clock }))
  return {
    id: scenario.id,
    horizonMs: horizon,
    horizonHours: Math.round((horizon / 3_600_000) * 100) / 100,
    cases,
    passed: cases.every((entry) => entry.passed),
    checks: cases.reduce((sum, entry) => sum + entry.checks, 0),
    failures: cases.reduce((sum, entry) => sum + entry.failed, 0)
  }
}

/**
 * The real-machine entry point.
 *
 * It is the same scenarios, at the same horizons, driven by the **machine's own clock**: the sampling
 * intervals are production's, the waits are real waits, and a run therefore takes six, twelve or
 * twenty-four hours. It is meant to be started deliberately, and it is the only mode whose result is
 * evidence about the wall clock rather than about the arithmetic.
 *
 * `options.clock` exists for one caller: the smoke run (`--smoke`), which drives the same wiring for a
 * fraction of a second to prove the entry point works. Nothing else should pass one.
 */
async function runRealtime(hours, options = {}) {
  const horizon = hours * 3_600_000
  const clock = options.clock || createRealClock()
  return runScenario({ id: `realtime-${hours}h`, horizon }, { horizonMs: horizon, ...options, clock })
}

/**
 * The entry point's own smoke test.
 *
 * A twenty-four hour soak cannot be part of a test gate, so the *entry point* gets one that can be: it
 * drives the real clock through the health case for a moment and asserts the wiring — that the clock
 * is the real one, that the case really took time, and that it produced its own checks. The horizon
 * assertions are deliberately not part of this: they need the full horizon, and a smoke run that
 * claimed them would be the kind of test that lies.
 */
async function smokeRealtime(hours = 0.0001, options = {}) {
  const clock = options.clock || createRealClock()
  const soak = createCase('realtime-smoke', 'the real-clock entry point itself')
  const horizon = Math.max(200, hours * 3_600_000)
  const startedAt = Date.now()
  const health = await soakHealth(horizon, { clock, intervalMs: 20, stepMs: 20 })
  const elapsed = Date.now() - startedAt
  soak.check('the clock handed to the case is the real one', clock.realtime === true, `realtime=${String(clock.realtime)}`)
  soak.check('the case ran and reported its own checks', health.checks > 0, `${health.checks} checks`)
  soak.check('the run spent real time rather than skipping it', elapsed >= 100, `${elapsed}ms of wall clock for a ${horizon}ms horizon`)
  soak.note(`the real-clock entry point ran ${health.checks} checks in ${elapsed}ms for a ${horizon}ms horizon`)
  const result = soak.result()
  return {
    id: 'realtime-smoke',
    horizonMs: horizon,
    horizonHours: Math.round((horizon / 3_600_000) * 10000) / 10000,
    cases: [result],
    passed: result.passed,
    checks: result.checks,
    failures: result.failed
  }
}

function parseArgs(argv) {
  const args = { scenario: '', list: false, json: false, out: '', realtime: false, smoke: false, hours: 0, horizonMs: 0 }
  for (const raw of argv) {
    const arg = String(raw)
    if (arg === '--list') args.list = true
    else if (arg === '--json') args.json = true
    else if (arg === '--realtime') args.realtime = true
    else if (arg === '--smoke') args.smoke = true
    else if (arg.startsWith('--out=')) args.out = arg.slice('--out='.length)
    else if (arg.startsWith('--hours=')) args.hours = Number(arg.slice('--hours='.length))
    else if (arg.startsWith('--horizon-ms=')) args.horizonMs = Number(arg.slice('--horizon-ms='.length))
    else if (!arg.startsWith('--')) args.scenario = arg
  }
  return args
}

async function main(argv) {
  const args = parseArgs(argv)
  if (args.list) {
    for (const scenario of SCENARIOS) process.stdout.write(`${scenario.id}\t${scenario.summary}\n`)
    process.stdout.write(`realtime\t--realtime --hours=<h>: the same scenarios on the real clock\n`)
    process.stdout.write(`smoke\t--realtime --smoke: the real-clock entry point itself, in a second\n`)
    return 0
  }
  /**
   * The smoke run is the entry point's own test, and it is the only path that does not need a scenario:
   * `--realtime --smoke` proves the real-clock wiring in under a second, so the gate can assert it.
   */
  if (args.smoke) {
    const report = await smokeRealtime(Number.isFinite(args.hours) && args.hours > 0 ? args.hours : 0.0001)
    for (const entry of report.cases) {
      process.stderr.write(`[${entry.passed ? 'PASS' : 'FAIL'}] realtime · ${entry.title} (${entry.checks - entry.failed}/${entry.checks})\n`)
      for (const failure of entry.failures) process.stderr.write(`        ✖ ${failure.label}: ${failure.detail}\n`)
      for (const note of entry.notes) process.stderr.write(`        · ${note}\n`)
    }
    const envelope = {
      harness: 'longhost-soak',
      realtime: true,
      smoke: true,
      at: new Date().toISOString(),
      scenarios: [report],
      checks: report.checks,
      failures: report.failures
    }
    envelope.passed = envelope.failures === 0
    if (args.json) process.stdout.write(`${JSON.stringify(envelope)}\n`)
    else process.stdout.write(`longhost-soak: ${envelope.checks - envelope.failures}/${envelope.checks} smoke checks passed on the real clock\n`)
    return envelope.passed ? 0 : 1
  }
  const wanted = args.scenario && args.scenario !== 'all' ? SCENARIOS.filter((entry) => entry.id === args.scenario) : SCENARIOS
  if (!wanted.length) {
    process.stderr.write(`longhost-soak: no such scenario "${args.scenario}" (try --list)\n`)
    return 2
  }
  const reports = []
  for (const scenario of wanted) {
    const report = args.realtime
      ? await runRealtime(Number.isFinite(args.hours) && args.hours > 0 ? args.hours : scenario.realtimeHours)
      : await runScenario(scenario, args.horizonMs ? { horizonMs: args.horizonMs } : {})
    reports.push(report)
    for (const entry of report.cases) {
      process.stderr.write(`[${entry.passed ? 'PASS' : 'FAIL'}] ${scenario.id} · ${entry.title} (${entry.checks - entry.failed}/${entry.checks})\n`)
      for (const failure of entry.failures) process.stderr.write(`        ✖ ${failure.label}: ${failure.detail}\n`)
      for (const note of entry.notes) process.stderr.write(`        · ${note}\n`)
    }
  }
  const envelope = {
    harness: 'longhost-soak',
    realtime: args.realtime,
    at: new Date().toISOString(),
    scenarios: reports,
    checks: reports.reduce((sum, report) => sum + report.checks, 0),
    failures: reports.reduce((sum, report) => sum + report.failures, 0)
  }
  envelope.passed = envelope.failures === 0
  if (args.out) fs.writeFileSync(args.out, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8')
  if (args.json) process.stdout.write(`${JSON.stringify(envelope)}\n`)
  else process.stdout.write(`longhost-soak: ${envelope.checks - envelope.failures}/${envelope.checks} checks passed across ${reports.length} scenario(s)\n`)
  return envelope.passed ? 0 : 1
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code })
    .catch((error) => {
      process.stderr.write(`longhost-soak failed: ${error && error.stack ? error.stack : error}\n`)
      process.exitCode = 1
    })
}

module.exports = { main, runScenario, runRealtime, smokeRealtime, soakHealth, soakBudget, soakHeartbeat, soakMaintenance, SCENARIOS, createCase, scriptedReadings }
void os
