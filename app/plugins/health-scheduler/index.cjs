'use strict'

/**
 * DS-Hns: `dshns.health-scheduler`, the first complete native plugin.
 *
 * It samples the machine and the runtime, scores a pressure, holds a maintenance window and decides
 * what to do about it. Two properties are the reason it exists in this shape rather than as a
 * process or an adopted bundle:
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
 * ## Failing open, and saying so
 *
 * Every external dependency here is optional, and each absent one degrades a *named* thing rather
 * than the plugin:
 *
 * | Absent | What still works | What is reported |
 * | --- | --- | --- |
 * | `restart-control` | all sampling and every decision up to `PAUSE_NEW_WORK` | `restart.available: false` with the reason |
 * | a health dimension's telemetry | the other dimensions | that dimension `unknown`, with the coverage published |
 * | a consumer of the health capabilities | everything | nothing; the capabilities are simply unread |
 */

const { PLUGIN_API_VERSION, FAULT_LEVELS, HEALTH_STATUS } = require('../../core/contracts/plugin.cjs')
const { createHealthEngine, ACTIONS, DEFAULT_CONFIG, inWindow } = require('./health.cjs')

const API = PLUGIN_API_VERSION

/** The capabilities this plugin consumes, all of them optionally. */
const OPTIONAL_CAPABILITIES = Object.freeze(['restart-control'])

/** The capabilities it provides, which is the long-term-hosting half of the vocabulary. */
const PROVIDES = Object.freeze(['hardware-health', 'runtime-health', 'health-pressure', 'maintenance-scheduling'])

/**
 * @param {object} [options]
 * @param {object} [options.config] overrides merged over the shipped defaults
 * @param {Function} [options.readings] injectable collectors, for tests
 * @param {Function} [options.now]
 */
function createHealthSchedulerPlugin(options = {}) {
  const engine = createHealthEngine({
    config: { ...DEFAULT_CONFIG, ...(options.config || {}) },
    readings: options.readings,
    now: options.now
  })

  /** Live state, reset on every load: a disabled plugin holds nothing. */
  let timer = null
  let context = null
  let restartControl = null
  let restartAvailability = { available: false, reason: 'the plugin has not been loaded' }
  let lastOutcome = null
  const events = []

  function note(type, detail) {
    const entry = { type, at: Date.now(), ...detail }
    events.push(entry)
    if (events.length > 100) events.shift()
    if (context) context.emit(`health-scheduler.${type}`, entry)
    return entry
  }

  /**
   * Resolve the restart authority *at the moment it is needed* rather than once at load.
   *
   * A capability that appears after this plugin loaded — a companion process started later, say —
   * must become usable without reloading the monitor, and one that disappears must stop being
   * trusted. Resolving lazily is what makes "restart is unavailable" a live fact rather than a
   * statement made once at startup and never revisited.
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
    if (typeof resolved.request !== 'function' && typeof resolved.requestApplicationRestart !== 'function') {
      // A provider that does not answer the one call this plugin makes is not a usable authority,
      // and saying so is better than calling into it and reporting whatever comes back.
      return { available: false, reason: 'the restart-control provider accepts no restart request' }
    }
    return { available: true, reason: null, control: resolved }
  }

  /** One tick: sample, decide, and act on the decision as far as this plugin is allowed to. */
  async function tick() {
    const sample = engine.sample()
    const decision = engine.decide()
    note('decision', { action: decision.action, pressure: decision.pressure, unknown: decision.unknown })

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
   * expected deployment, the capabilities stay up, and the reason is on the plugin's status.
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
      const answer = typeof control.request === 'function'
        ? await control.request(decision.request)
        : await control.requestApplicationRestart(decision.request)
      lastOutcome = { ok: true, answer }
      engine.noteRestartOutcome({ ok: true })
      note('restart-requested', { request: decision.request, answer })
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
      version: '1.0.0',
      description: 'device and runtime health sampling, restart-pressure scoring, maintenance windows, and an action decision that requests a restart rather than performing one',
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
        maintenance: DEFAULT_CONFIG.maintenance
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
      // `health-pressure` gets the score and the decision, never a handle on the sampler.
      const surface = {
        'hardware-health': { snapshot: () => snapshotOf(['memory', 'cpu']) },
        'runtime-health': { snapshot: () => snapshotOf(['runtime', 'responsiveness']) },
        'health-pressure': {
          pressure: () => engine.report().latest,
          decide: () => engine.decide(),
          report: () => engine.report()
        },
        'maintenance-scheduling': {
          inWindow: (atMs) => {
            if (!engine.config.maintenance.enabled) return false
            const when = new Date(Number.isFinite(atMs) ? Number(atMs) : Date.now())
            return inWindow(when.getHours() * 60 + when.getMinutes(), engine.config.maintenance.windowStart, engine.config.maintenance.windowEnd)
          },
          window: () => ({ enabled: engine.config.maintenance.enabled, ...engine.config.maintenance })
        }
      }
      for (const capability of PROVIDES) {
        const result = context.provide(capability, surface[capability], { detail: { from: 'dshns.health-scheduler' } })
        provided.push({ capability, ok: result && result.ok !== false })
      }

      restartControl = resolveRestartControl()
      restartAvailability = { available: restartControl.available, reason: restartControl.reason }

      // One sample immediately, so a consumer that asks the moment the plugin loads gets a reading
      // rather than an empty window.
      engine.sample()
      timer = setInterval(() => {
        tick().catch((error) => note('tick-failed', { reason: String(error && error.message ? error.message : error) }))
      }, interval)
      // The sampler is a plugin's own lifecycle timer, not a reason to keep a host alive: it is
      // cleared on unload, and the plugin is an opt-in background feature.
      if (typeof timer.unref === 'function') timer.unref()

      note('loaded', { intervalMs: interval, restartAvailable: restartAvailability.available })
      return { ok: true, provides: provided, restart: restartAvailability }
    },

    unload() {
      if (timer) clearInterval(timer)
      timer = null
      context = null
      restartControl = null
      restartAvailability = { available: false, reason: 'the plugin has not been loaded' }
      return { ok: true }
    },

    /**
     * The health of the *monitor*, which is not the health of the machine.
     *
     * `degraded` here means the plugin is running but cannot see something — a dimension with no
     * telemetry, or no restart authority. That is exactly the distinction the platform's health
     * vocabulary exists for, and reporting `healthy` while flying blind would hide it.
     */
    healthCheck() {
      if (!timer) return { status: HEALTH_STATUS.UNKNOWN, reason: 'the plugin is not sampling' }
      const report = engine.report()
      const latest = report.latest
      const notes = []
      if (latest && latest.unknown.length) notes.push(`no telemetry for ${latest.unknown.join(', ')}`)
      if (!restartAvailability.available) notes.push(`restart unavailable: ${restartAvailability.reason}`)
      if (notes.length) {
        return { status: HEALTH_STATUS.DEGRADED, reason: notes.join('; '), detail: { pressure: latest ? latest.pressure : null, restart: restartAvailability } }
      }
      return {
        status: HEALTH_STATUS.HEALTHY,
        reason: `sampling every ${engine.config.sampling.intervalMs}ms; pressure ${latest ? latest.pressure : 0}`,
        detail: { pressure: latest ? latest.pressure : 0, restart: restartAvailability }
      }
    },

    /** Everything a diagnostic surface needs, without reaching into the engine. */
    diagnostics() {
      return {
        report: engine.report(),
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

module.exports = { healthSchedulerPlugin, createHealthSchedulerPlugin, PROVIDES, OPTIONAL_CAPABILITIES }
