'use strict'

/**
 * DS-Hns: `dshns.health-scheduler` — perception, judgement and scheduling, and nothing else.
 *
 * It samples the machine and the runtime through a registry of telemetry providers, scores a pressure,
 * holds a five-state model with hysteresis, debounce and a trend, and decides what to do about it.
 * Two properties are the reason it exists in this shape rather than as a process or an adopted bundle:
 *
 * **It is a `dshns.plugin/v1` plugin, mounted through the same adapter as everything else.** It has
 * a manifest, a capability surface and a lifecycle; it is enabled, disabled, reloaded and
 * uninstalled by the ordinary plugin flow. `NativeHnsAdapter` is what puts it there, which makes
 * this plugin the proof that the platform's own plugins are not a special case.
 *
 * **It cannot restart anything.** It holds no way to stop the machine or the process — no command,
 * no signal, no handle — and that is asserted by scanning its source rather than promised in prose.
 * When the pressure warrants a restart it produces a *request* and hands it to whatever provides
 * `restart-control`; when nothing does, everything else keeps working and the restart is reported
 * **unavailable**. That separation is the whole design: a monitor whose bug can stop the machine is
 * a monitor that is more dangerous than the condition it watches.
 *
 * ## The responsibility line, stated once
 *
 * ```
 *   dshns.health-scheduler   perception, scoring, state, trend, maintenance decision
 *   restart-control          the request goes here and no further
 *   dshns.restart-supervisor execution, budget, crash-loop protection, readiness, recovery
 *   Core continuity          task state, checkpoint, resume
 * ```
 *
 * Nothing above the line knows a pid; nothing below it scores a pressure. The plugin consumes
 * `restart-control` — and nothing else — which is why uninstalling the supervisor leaves a monitor
 * that reports `restart unavailable`, and uninstalling the monitor leaves a supervisor that still
 * answers a manual restart.
 *
 * ## Failing open, and saying so
 *
 * Every external dependency here is optional, and each absent one degrades a *named* thing rather
 * than the plugin:
 *
 * | Absent | What still works | What is reported |
 * | --- | --- | --- |
 * | `restart-control` | all sampling and every decision up to `PAUSE_NEW_WORK` | `restart.available: false` with the reason |
 * | a health dimension's telemetry | the other dimensions, and the other providers | that dimension `unknown`, with coverage and provider faults published |
 * | a single telemetry provider | every other provider | a fault against *that provider*, and a lower sample confidence |
 * | a consumer of the health capabilities | everything | nothing; the capabilities are simply unread |
 */

const { PLUGIN_API_VERSION, FAULT_LEVELS, HEALTH_STATUS } = require('../../core/contracts/plugin.cjs')
const { createHealthEngine, ACTIONS, DEFAULT_CONFIG, HEALTH_STATES, inWindow } = require('./health.cjs')
const { createProviderRegistry, defaultProviders } = require('./providers.cjs')

const API = PLUGIN_API_VERSION

/** The capabilities this plugin consumes, all of them optionally. */
const OPTIONAL_CAPABILITIES = Object.freeze(['restart-control', 'runtime-health'])

/** The capabilities it provides, which is the long-term-hosting half of the vocabulary. */
const PROVIDES = Object.freeze(['hardware-health', 'runtime-health', 'health-pressure', 'maintenance-scheduling'])

/**
 * @param {object} [options]
 * @param {object} [options.config] overrides merged over the shipped defaults
 * @param {Function} [options.readings] injectable base collector, for tests and for a deployment
 * @param {Array}  [options.providers] extra telemetry providers, appended to the registry
 * @param {Function} [options.now]
 */
function createHealthSchedulerPlugin(options = {}) {
  const engine = createHealthEngine({
    config: { ...DEFAULT_CONFIG, ...(options.config || {}) },
    readings: options.readings,
    providers: options.providers,
    now: options.now
  })

  /** Live state, reset on every load: a disabled plugin holds nothing. */
  let timer = null
  let context = null
  let restartControl = null
  let restartAvailability = { available: false, reason: 'the plugin has not been loaded' }
  let lastOutcome = null
  let lastTickAt = null
  /** When the current maintenance deferral began, so the defer is bounded rather than open-ended. */
  let deferringSince = null
  const events = []

  function note(type, detail) {
    const entry = { type, at: Date.now(), ...detail }
    events.push(entry)
    if (events.length > 100) events.shift()
    if (context) context.emit(`health-scheduler.${type}`, entry)
    return entry
  }

  /**
   * Resolve a capability *at the moment it is needed* rather than once at load.
   *
   * A capability that appears after this plugin loaded — a supervisor started later, say — must
   * become usable without reloading the monitor, and one that disappears must stop being trusted.
   * Resolving lazily is what makes "restart is unavailable" a live fact rather than a statement made
   * once at startup and never revisited.
   */
  function resolveOptional(name) {
    if (!context || typeof context.require !== 'function') {
      return { available: false, reason: 'the plugin context cannot resolve capabilities' }
    }
    let resolved = null
    try {
      resolved = context.require(name, { optional: true })
    } catch (error) {
      return { available: false, reason: `resolving ${name} threw: ${error && error.message ? error.message : error}` }
    }
    if (!resolved) return { available: false, reason: `no plugin provides ${name}` }
    return { available: true, reason: null, value: resolved }
  }

  /**
   * The restart authority, resolved through the capability registry and nothing else.
   *
   * This plugin never imports the supervisor, never holds a pid and never sees a process handle: the
   * `require` below is the *only* line in this file that reaches the restart authority at all, and
   * the suite asserts both that it is there and that nothing else can stop anything. Resolving here,
   * at the moment the request is made, is what lets a supervisor that appears later become usable
   * without a reload — and one that disappears stop being trusted.
   */
  function resolveRestartControl() {
    if (!context || typeof context.require !== 'function') {
      return { available: false, reason: 'the plugin context cannot resolve capabilities' }
    }
    let resolved = null
    try {
      resolved = context.require('restart-control', { optional: true })
    } catch (error) {
      return { available: false, reason: `resolving restart-control threw: ${error && error.message ? error.message : error}` }
    }
    if (!resolved) return { available: false, reason: 'no plugin provides restart-control' }
    const usable = typeof resolved.requestRestart === 'function' || typeof resolved.request === 'function' || typeof resolved.requestApplicationRestart === 'function'
    if (!usable) {
      // A provider that does not answer the one call this plugin makes is not a usable authority,
      // and saying so is better than calling into it and reporting whatever comes back.
      return { available: false, reason: 'the restart-control provider accepts no restart request' }
    }
    return { available: true, reason: null, control: resolved }
  }

  /**
   * Hand the engine the live capability values its providers read through.
   *
   * This is the seam that gives the monitor the *worker* and *queue* dimensions at all: they come
   * from `runtime-health` and from Core's own continuity report, both of which are the plugin
   * context's to resolve and neither of which the engine can reach. Absent capabilities are passed as
   * `null`, which the providers report as `unknown` rather than as a healthy worker or an empty queue.
   */
  function bindCapabilities() {
    const runtimeHealth = resolveOptional('runtime-health')
    let pendingWork = null
    if (context && typeof context.require === 'function') {
      try {
        const continuity = context.require('continuity-state', { optional: true })
        if (continuity && typeof continuity.pendingWork === 'function') pendingWork = continuity.pendingWork()
        else if (continuity && typeof continuity.describe === 'function') {
          const described = continuity.describe()
          pendingWork = described && described.queue ? { active: described.queue.running, queued: described.queue.pending, longestRunningMinutes: described.queue.longestRunningMinutes } : null
        }
      } catch {
        pendingWork = null
      }
    }
    const bound = {
      'runtime-health': runtimeHealth.available === true ? runtimeHealth.value : null,
      'restart-control': restartControl && restartControl.available === true ? restartControl.control : null
    }
    engine.bindCapabilities(bound)
    return { ...bound, pendingWork }
  }

  /** One tick: sample, decide, and act on the decision as far as this plugin is allowed to. */
  async function tick() {
    lastTickAt = Date.now()
    // The heartbeat is written here, by the code that would be frozen if the loop froze: a missing
    // beat is how the supervisor learns that being alive and being responsive are different facts.
    engine.beat(Date.now())
    bindCapabilities()
    const sample = engine.sample()
    const decision = engine.decide()
    note('decision', {
      action: decision.action,
      state: decision.state,
      pressure: decision.pressure,
      trend: decision.trend,
      unknown: decision.unknown,
      providerFailures: sample.providers ? sample.providers.failures.map((fault) => fault.provider) : []
    })

    if (decision.action === ACTIONS.REQUEST_RESTART && decision.request) {
      await requestRestart(decision)
    }
    // `THROTTLE` and `PAUSE_NEW_WORK` are decisions this plugin publishes; applying them is the
    // consumer's business, which is why nothing here reaches into a task queue.
    return { sample, decision }
  }

  /**
   * Ask the restart authority to act.
   *
   * The request is *reported* either way. An unavailable authority is not an error: it is an
   * expected deployment, the capabilities stay up, and the reason is on the plugin's status. Nothing
   * here waits for the restart to happen either — that is the supervisor's lifecycle, and its
   * outcome comes back through `getRestartHistory`, not through this call.
   */
  async function requestRestart(decision) {
    restartControl = resolveRestartControl()
    restartAvailability = { available: restartControl.available, reason: restartControl.reason }
    if (!restartControl.available) {
      lastOutcome = { ok: false, unavailable: true, reason: restartControl.reason }
      note('restart-unavailable', { reason: restartControl.reason, requested: decision.request })
      return lastOutcome
    }
    const control = restartControl.control
    try {
      const answer = typeof control.requestRestart === 'function'
        ? await control.requestRestart({ ...decision.request, requestedBy: 'dshns.health-scheduler' })
        : typeof control.request === 'function'
          ? await control.request(decision.request)
          : await control.requestApplicationRestart(decision.request)
      const accepted = !(answer && answer.accepted === false)
      lastOutcome = { ok: accepted, answer, refused: answer && answer.refused === true ? answer : null }
      engine.noteRestartOutcome({ ok: accepted })
      note(accepted ? 'restart-requested' : 'restart-refused', { request: decision.request, answer, code: answer && answer.code ? answer.code : null })
      if (answer && answer.accepted === false) {
        // A refusal is a *decision* by the authority — a cooldown, a budget, safe mode — and the
        // monitor's job is to record it and keep watching, not to route around it.
        note('restart-decision', { code: answer.code || null, reason: answer.reason || null })
      }
      return lastOutcome
    } catch (error) {
      const reason = String(error && error.message ? error.message : error)
      lastOutcome = { ok: false, reason }
      note('restart-failed', { reason })
      return lastOutcome
    }
  }

  /** The engine's state for one group of dimensions, read-only. */
  function snapshotOf(dimensions) {
    const latest = engine.report().latest
    if (!latest) return { at: null, scores: {}, unknown: dimensions.slice() }
    const scores = {}
    const unknown = []
    for (const dimension of dimensions) {
      if (latest.scores[dimension] === null || latest.scores[dimension] === undefined) unknown.push(dimension)
      else scores[dimension] = latest.scores[dimension]
    }
    return { at: latest.at, pressure: latest.pressure, scores, unknown }
  }

  return {
    manifest: {
      api_version: API,
      id: 'dshns.health-scheduler',
      name: 'Health Scheduler',
      version: '2.0.0',
      description: 'device and runtime health sampling through isolated telemetry providers, a five-state pressure model with trend and debounce, maintenance windows with a bounded defer, and an action decision that requests a restart rather than performing one',
      provides: [...PROVIDES],
      requires_capabilities: [],
      // Every dependency is optional. A monitor that refused to load without a restart authority
      // would be a monitor that stops watching exactly when the machine is in trouble.
      optional_capabilities: [...OPTIONAL_CAPABILITIES],
      conflicts: [],
      // Opt-in: sampling the machine is a decision a user makes, not one taken for them.
      default_enabled: false,
      hot_reload: false,
      model_specific: false,
      fault_level: FAULT_LEVELS.SOFT,
      entry: 'app/plugins/health-scheduler/index.cjs',
      config: {
        intervalMs: DEFAULT_CONFIG.sampling.intervalMs,
        thresholds: DEFAULT_CONFIG.thresholds,
        maintenance: DEFAULT_CONFIG.maintenance,
        model: DEFAULT_CONFIG.model,
        enrichment: DEFAULT_CONFIG.enrichment
      }
    },

    install() {
      return { ok: true }
    },

    /**
     * Start sampling and publish the capabilities.
     *
     * Starting is idempotent and stopping is total: `unload` clears the timer and drops every
     * handle, so enabling and disabling the plugin repeatedly leaves nothing behind.
     */
    load(loadContext) {
      context = loadContext
      const interval = engine.config.sampling.intervalMs

      const provided = []
      // The capabilities are the *engine's* state, exposed read-only. A consumer asking for
      // `health-pressure` gets the score, the state, the trend and the explanation, never a handle
      // on the sampler.
      const surface = {
        'hardware-health': { snapshot: () => snapshotOf(['memory', 'cpu']) },
        'runtime-health': { snapshot: () => snapshotOf(['runtime', 'responsiveness']) },
        'health-pressure': {
          pressure: () => engine.report().latest,
          decide: () => engine.decide(),
          report: () => engine.report(),
          /** The five-state model: what state we are in, how sure, and which way it is going. */
          state: () => ({
            state: engine.report().state.current,
            trend: engine.report().state.trend,
            since: engine.report().state.since,
            lastDecision: engine.report().lastDecision
          }),
          /** Everything a person may ask: why, which metric, how long, what thresholds, last action. */
          explain: () => engine.decide().model,
          /** Which telemetry providers answered and which broke. */
          providers: () => engine.providers.describe()
        },
        'maintenance-scheduling': {
          inWindow: (atMs) => {
            if (!engine.config.maintenance.enabled) return false
            const when = new Date(Number.isFinite(atMs) ? Number(atMs) : Date.now())
            return inWindow(when.getHours() * 60 + when.getMinutes(), engine.config.maintenance.windowStart, engine.config.maintenance.windowEnd)
          },
          window: () => ({ enabled: engine.config.maintenance.enabled, ...engine.config.maintenance }),
          /** Whether a restart may happen *now*, and if not, what is holding it and until when. */
          verdict: () => {
            const decision = engine.decide()
            return { allowed: decision.maintenance ? decision.maintenance.allowed === true : false, reason: decision.maintenance ? decision.maintenance.reason : null, deferUntil: decision.maintenance ? decision.maintenance.deferUntil || null : null, held: decision.held || null, action: decision.action }
          }
        }
      }
      for (const capability of PROVIDES) {
        const result = context.provide(capability, surface[capability], { detail: { from: 'dshns.health-scheduler' } })
        provided.push({ capability, ok: result && result.ok !== false })
      }

      restartControl = resolveRestartControl()
      restartAvailability = { available: restartControl.available, reason: restartControl.reason }
      bindCapabilities()

      // One sample immediately, so a consumer that asks the moment the plugin loads gets a reading
      // rather than an empty window.
      engine.sample()
      timer = setInterval(() => {
        tick().catch((error) => note('tick-failed', { reason: String(error && error.message ? error.message : error) }))
      }, interval)
      // The sampler is a plugin's own lifecycle timer, not a reason to keep a host alive: it is
      // cleared on unload, and the plugin is an opt-in background feature.
      if (typeof timer.unref === 'function') timer.unref()

      note('loaded', { intervalMs: interval, restartAvailable: restartAvailability.available, providers: engine.providers.providers() })
      return { ok: true, provides: provided, restart: restartAvailability, providers: engine.providers.describe() }
    },

    unload() {
      if (timer) clearInterval(timer)
      timer = null
      context = null
      restartControl = null
      restartAvailability = { available: false, reason: 'the plugin has not been loaded' }
      deferringSince = null
      lastTickAt = null
      return { ok: true }
    },

    /**
     * The health of the *monitor*, which is not the health of the machine.
     *
     * `degraded` here means the plugin is running but cannot see something — a dimension with no
     * telemetry, a provider that failed, or no restart authority. That is exactly the distinction
     * the platform's health vocabulary exists for, and reporting `healthy` while flying blind would
     * hide it. A sample the model calls `UNKNOWN` is reported `unknown`, because the monitor is
     * saying it cannot judge, and that is not a healthy monitor.
     */
    healthCheck() {
      if (!timer) return { status: HEALTH_STATUS.UNKNOWN, reason: 'the plugin is not sampling' }
      const report = engine.report()
      const latest = report.latest
      const notes = []
      if (latest && latest.unknown.length) notes.push(`no telemetry for ${latest.unknown.join(', ')}`)
      if (latest && latest.providers && latest.providers.failures.length) notes.push(`${latest.providers.failures.map((fault) => fault.provider).join(', ')} provider(s) failed`)
      if (!restartAvailability.available) notes.push(`restart unavailable: ${restartAvailability.reason}`)
      const state = report.state.current
      const detail = {
        state,
        trend: report.state.trend,
        pressure: latest ? latest.pressure : null,
        confidence: latest ? latest.confidence : null,
        restart: restartAvailability,
        providers: engine.providers.describe().providers.map((provider) => ({ id: provider.id, fault: provider.fault ? provider.fault.reason : null }))
      }
      if (state === HEALTH_STATES.UNKNOWN) {
        return { status: HEALTH_STATUS.UNKNOWN, reason: `the pressure model cannot judge: ${notes.join('; ') || 'not enough telemetry has arrived'}`, detail }
      }
      if (notes.length) return { status: HEALTH_STATUS.DEGRADED, reason: notes.join('; '), detail }
      return {
        status: HEALTH_STATUS.HEALTHY,
        reason: `sampling every ${engine.config.sampling.intervalMs}ms; state ${state}, pressure ${latest ? latest.pressure : 0}`,
        detail
      }
    },

    /** Everything a diagnostic surface needs, without reaching into the engine. */
    diagnostics() {
      const decision = engine.decide()
      return {
        report: engine.report(),
        state: decision.state,
        trend: decision.trend,
        slopePerMinute: decision.slopePerMinute,
        explanation: decision.model,
        maintenance: decision.maintenance,
        providers: engine.providers.describe(),
        restart: restartAvailability,
        lastOutcome,
        events: events.slice(-20),
        sampling: timer !== null
      }
    },

    /** For a test that needs one deterministic tick rather than a timer. */
    tick,
    engine
  }
}

/** The plugin object the platform loads: a manifest and the lifecycle hooks. */
function healthSchedulerPlugin() {
  return createHealthSchedulerPlugin()
}

module.exports = {
  healthSchedulerPlugin,
  createHealthSchedulerPlugin,
  PROVIDES,
  OPTIONAL_CAPABILITIES,
  createProviderRegistry,
  defaultProviders,
  HEALTH_STATES
}
