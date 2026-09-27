'use strict'

/**
 * DS-Hns Core: the unified lifecycle, runtime information and error reporting.
 *
 * Every adapted plugin leaves this module looking the same to the manager, whatever the adapter
 * had to do to make it work. That uniformity is not cosmetic: the manager's refusal codes, the
 * health supervisor's reactions and the panel's badges are all keyed off this shape, and an
 * adapter that produced a slightly different one would produce a plugin that is half-supported.
 *
 * What is normalised, and the failure each rule exists for:
 *
 *   * **A missing hook is a documented no-op, not a crash.** An adapter that only contributes a
 *     manifest is a legitimate adapter; calling `record.plugin.load(...)` on it must not be.
 *   * **A hook that throws becomes a coded error, attributed to a phase.** The manager already
 *     catches, but "it threw" and "it threw during activation, code X" are different reports, and
 *     the second one is what a user can act on.
 *   * **`healthCheck` never throws and always answers in the health vocabulary.** A health check
 *     that can fail is a health check that turns a status page into an exception.
 *   * **`unload` is idempotent and always releases.** Unloading something already unloaded is a
 *     normal consequence of a hot reload, and release must not depend on the hook succeeding.
 *   * **Runtime information outlives the plugin.** The record of what ran, where and with what
 *     boundary is kept after unload, because the question "what was that plugin doing" is asked
 *     after it is gone.
 */

const { HEALTH_STATUS } = require('../contracts/plugin.cjs')
const { ADAPTER_FAULT_CODES, RUNTIME_KINDS, adapterFault } = require('./contract.cjs')

/** The lifecycle states, as separate facts rather than one flag. */
const LIFECYCLE_STATES = Object.freeze({
  NEW: 'new',
  INSTALLED: 'installed',
  LOADED: 'loaded',
  FAILED: 'failed',
  UNLOADED: 'unloaded'
})

/** The default size of the retained error ring: enough to see a pattern, bounded so it cannot grow. */
const DEFAULT_ERROR_LIMIT = 50

/**
 * A bounded, structured error log for one plugin.
 *
 * Structured rather than a message array because every consumer of this — the panel, the health
 * supervisor, a support report — needs the code and the phase, not prose. Bounded because a
 * plugin that fails in a loop must not be able to grow the shell's memory.
 */
function createErrorReporter(input = {}) {
  const limit = Number.isFinite(input.limit) ? Math.max(1, Number(input.limit)) : DEFAULT_ERROR_LIMIT
  const owner = String(input.owner || 'unknown')
  const adapterId = input.adapter ? String(input.adapter) : null
  const errors = []

  /**
   * Record one failure.
   *
   * `report` never throws: it is called from `catch` blocks whose whole purpose is to keep a
   * failure inside one plugin, and an error reporter that can itself fail would defeat that.
   */
  function report(error, phase, code, detail = {}) {
    const entry = {
      code: String(code || ADAPTER_FAULT_CODES.THREW),
      phase: phase ? String(phase) : null,
      reason: String(error && error.message ? error.message : error),
      adapter: adapterId,
      plugin: owner,
      at: Date.now(),
      detail: detail && typeof detail === 'object' ? detail : {}
    }
    errors.push(entry)
    if (errors.length > limit) errors.splice(0, errors.length - limit)
    return entry
  }

  return {
    report,
    limit,
    list: () => errors.slice(),
    /**
     * The newest `count` errors, newest last, which is the order a log is read in.
     *
     * `count <= 0` is answered explicitly rather than left to `slice(-0)`: negative zero is zero,
     * and `slice(0)` returns the *whole* array — so the obvious implementation of "give me none"
     * hands back everything.
     */
    last: (count = 10) => {
      const wanted = Number(count)
      if (!Number.isFinite(wanted) || wanted <= 0) return []
      return errors.slice(-wanted)
    },
    clear: () => {
      const cleared = errors.length
      errors.splice(0, errors.length)
      return cleared
    },
    summary() {
      const byCode = {}
      for (const entry of errors) byCode[entry.code] = (byCode[entry.code] || 0) + 1
      return { total: errors.length, limit, byCode, last: errors.length ? errors[errors.length - 1] : null }
    }
  }
}

/** Coerce whatever a plugin's `healthCheck` returned into the platform's health vocabulary. */
function normalizeHealth(result, now) {
  const at = typeof now === 'function' ? now() : Date.now()
  if (!result || typeof result !== 'object') {
    return { status: HEALTH_STATUS.UNKNOWN, reason: 'the health check returned nothing', latency_ms: null, detail: null, at }
  }
  const status = Object.values(HEALTH_STATUS).includes(result.status) ? result.status : HEALTH_STATUS.UNKNOWN
  return {
    status,
    reason: result.reason ? String(result.reason) : null,
    latency_ms: Number.isFinite(result.latency_ms) ? Number(result.latency_ms) : null,
    detail: result.detail && typeof result.detail === 'object' ? result.detail : null,
    at
  }
}

/**
 * Wrap one adapter's output in the platform's lifecycle.
 *
 * The returned object is what the plugin manager installs. It is a *superset* of what the manager
 * requires — the four hooks plus the three new interfaces — so an existing caller that only knows
 * `manifest`/`load`/`unload`/`healthCheck` keeps working unchanged.
 *
 * @param {object} input
 * @param {object} input.descriptor the adapter's output (`manifest` + optional hooks)
 * @param {object} [input.adapter] the adapter that produced it
 * @param {object} [input.runtime] the static runtime block
 * @param {Function} [input.log]
 * @param {Function} [input.now]
 * @param {number} [input.errorLimit]
 */
function unifyLifecycle(input = {}) {
  const descriptor = input.descriptor && typeof input.descriptor === 'object' ? input.descriptor : {}
  const manifest = descriptor.manifest || {}
  const id = String(manifest.id || descriptor.id || 'unknown')
  const adapter = input.adapter || null
  const now = typeof input.now === 'function' ? input.now : () => Date.now()
  const log = typeof input.log === 'function' ? input.log : () => {}

  const errors = createErrorReporter({ owner: id, adapter: adapter ? adapter.id : null, limit: input.errorLimit })
  const runtime = input.runtime && typeof input.runtime === 'object' ? { ...input.runtime } : {}

  /** The live half of the runtime information. Static fields come from the manifest. */
  const live = {
    state: LIFECYCLE_STATES.NEW,
    pid: null,
    startedAt: null,
    stoppedAt: null,
    loadedAt: null,
    unloadedAt: null,
    loads: 0,
    unloads: 0,
    lastError: null
  }

  /** The handles an adapter's `runtimeInfo` may contribute, merged into the standard answer. */
  function adapterRuntime() {
    if (typeof descriptor.runtimeInfo !== 'function') return {}
    try {
      const extra = descriptor.runtimeInfo()
      return extra && typeof extra === 'object' ? extra : {}
    } catch (error) {
      const entry = errors.report(error, 'runtime-info', ADAPTER_FAULT_CODES.THREW, { hook: 'runtimeInfo' })
      return { runtimeInfoError: entry.reason }
    }
  }

  /**
   * What the adapter itself has to report about failures.
   *
   * An adapter often knows about a class of failure the platform's lifecycle never sees -- for a
   * bridged plugin, every capability call the host refused is the most actionable error
   * information that plugin has. It is merged into the standard report under `adapter` rather than
   * left for a caller to dig out of `runtimeInfo`, and it is kept separate from the platform's own
   * counters: "this plugin threw" and "this plugin asked for something the host would not give it"
   * are different problems with different fixes.
   */
  function adapterErrors() {
    if (typeof descriptor.errorReport !== 'function') return null
    try {
      const report = descriptor.errorReport()
      return report && typeof report === 'object' ? report : null
    } catch (error) {
      const entry = errors.report(error, 'error-report', ADAPTER_FAULT_CODES.THREW, { hook: 'errorReport' })
      return { error: entry.reason }
    }
  }

  async function install(context) {
    if (typeof descriptor.install !== 'function') return { ok: true, skipped: true }
    try {
      const outcome = await descriptor.install(context)
      live.state = LIFECYCLE_STATES.INSTALLED
      return outcome === undefined ? { ok: true } : outcome
    } catch (error) {
      const entry = errors.report(error, 'install', ADAPTER_FAULT_CODES.THREW, { hook: 'install' })
      live.state = LIFECYCLE_STATES.FAILED
      live.lastError = entry
      throw codedError(entry)
    }
  }

  async function load(context) {
    // Loading something already loaded is a no-op rather than a second activation: the reload path
    // unloads first, so reaching here loaded means a caller asked twice.
    if (live.state === LIFECYCLE_STATES.LOADED) return { ok: true, already: true }
    live.startedAt = now()
    try {
      if (typeof descriptor.load === 'function') await descriptor.load(context)
    } catch (error) {
      const entry = errors.report(error, 'load', ADAPTER_FAULT_CODES.THREW, { hook: 'load' })
      live.state = LIFECYCLE_STATES.FAILED
      live.lastError = entry
      throw codedError(entry)
    }
    live.state = LIFECYCLE_STATES.LOADED
    live.loadedAt = now()
    live.loads += 1
    const extra = adapterRuntime()
    live.pid = Number.isInteger(extra.pid) ? extra.pid : null
    return { ok: true, runtime: extra }
  }

  async function unload(context) {
    // Idempotent: a hot reload unloads an unloaded plugin as a matter of course, and turning that
    // into an error would make the reload path fail for a reason that is not a failure.
    if (live.state === LIFECYCLE_STATES.UNLOADED || live.state === LIFECYCLE_STATES.NEW) {
      return { ok: true, already: true }
    }
    let hookFailed = null
    try {
      if (typeof descriptor.unload === 'function') await descriptor.unload(context)
    } catch (error) {
      // Recorded, then release still happens below. An unload that throws must not be the reason a
      // process, a capability or a subscription is left behind.
      hookFailed = errors.report(error, 'unload', ADAPTER_FAULT_CODES.THREW, { hook: 'unload' })
      live.lastError = hookFailed
      log({ kind: 'adapter-unload-failed', plugin: id, reason: hookFailed.reason })
    }
    live.state = LIFECYCLE_STATES.UNLOADED
    live.unloadedAt = now()
    live.unloads += 1
    live.pid = null
    return { ok: true, hookFailed }
  }

  async function healthCheck() {
    if (live.state !== LIFECYCLE_STATES.LOADED) {
      return { status: HEALTH_STATUS.UNKNOWN, reason: `${id} is not loaded`, latency_ms: null, detail: null, at: now() }
    }
    if (typeof descriptor.healthCheck !== 'function') {
      return { status: HEALTH_STATUS.UNKNOWN, reason: 'the plugin implements no healthCheck', latency_ms: null, detail: null, at: now() }
    }
    const started = Date.now()
    try {
      const result = await descriptor.healthCheck()
      const health = normalizeHealth(result, now)
      if (health.latency_ms === null) health.latency_ms = Date.now() - started
      return health
    } catch (error) {
      const entry = errors.report(error, 'health', ADAPTER_FAULT_CODES.THREW, { hook: 'healthCheck' })
      live.lastError = entry
      return {
        status: HEALTH_STATUS.UNHEALTHY,
        reason: entry.reason,
        latency_ms: Date.now() - started,
        detail: null,
        at: now()
      }
    }
  }

  /**
   * The runtime information interface.
   *
   * Deliberately a *function*, not a field: a plugin's pid, state and uptime change, and a
   * snapshot captured once would be the kind of stale answer that makes a diagnostic surface
   * worse than none. The static half comes from the manifest; the live half is merged in on each
   * call, and the adapter's own contributions are namespaced under `adapter`.
   */
  function runtimeInfo() {
    const extra = adapterRuntime()
    return {
      id,
      kind: runtime.kind || RUNTIME_KINDS.IN_PROCESS.id,
      enforcement: runtime.enforcement || null,
      isolation: runtime.isolation || null,
      entry: runtime.entry || null,
      source: runtime.source || null,
      adapter: adapter ? { id: adapter.id, version: adapter.version, api_version: adapter.api_version } : null,
      state: live.state,
      pid: live.pid,
      loads: live.loads,
      unloads: live.unloads,
      loadedAt: live.loadedAt,
      unloadedAt: live.unloadedAt,
      uptimeMs: live.state === LIFECYCLE_STATES.LOADED && live.loadedAt !== null ? now() - live.loadedAt : 0,
      /** Whatever the adapter knows and the platform does not: a child pid, an entry path, a port. */
      detail: Object.keys(extra).length ? extra : null
    }
  }

  /** The error reporting interface: structured, bounded, and readable after unload. */
  function errorReport() {
    return {
      plugin: id,
      adapter: adapter ? adapter.id : null,
      ...errors.summary(),
      errors: errors.list(),
      /** The adapter's own view, which the platform lifecycle cannot see. */
      adapterReport: adapterErrors()
    }
  }

  /** Everything a diagnostic surface needs, in one call. */
  async function diagnostics() {
    return {
      runtime: runtimeInfo(),
      health: await healthCheck(),
      errors: errorReport(),
      permissions: manifest.permissions || null,
      declared: {
        adapter: manifest.adapter || null,
        health: manifest.health || null
      }
    }
  }

  /**
   * The plugin's **own** diagnostics, when it publishes any, kept beside the standardised set.
   *
   * The two answer different questions and are owned by different layers. `diagnostics()` above is the
   * platform's: runtime, health, errors, permissions — the same fields for every plugin, and async
   * because a health check is. A domain plugin usually has a second, **synchronous** answer of its own
   * (the health monitor's pressure and trend, the restart supervisor's budget and companion), and that
   * is what a management surface draws. Merging them would lose which half the platform guarantees;
   * dropping the second one would leave the panel's rows for those plugins empty. So it travels as its
   * own hook, and a plugin that throws here is a fault against a *read* rather than against the plugin.
   */
  function domainDiagnostics() {
    if (typeof descriptor.diagnostics !== 'function') return null
    try {
      const answer = descriptor.diagnostics()
      /**
       * A promise is not a domain report.
       *
       * Some plugins implement `diagnostics()` asynchronously (they await a probe). A service record is
       * serialised by an IPC reply and by the governance bridge, and a promise inside it arrives on the
       * other side as `{}` — so an async answer is reported as *no synchronous domain report*, which is
       * true, rather than as an empty one, which is a lie the panels would then draw.
       */
      if (answer && typeof answer.then === 'function') return null
      return answer && typeof answer === 'object' ? answer : null
    } catch (error) {
      const entry = errors.report(error, 'diagnostics', ADAPTER_FAULT_CODES.THREW, { hook: 'diagnostics' })
      return { error: entry.reason }
    }
  }

  const unified = {
    // The standard manifest travels unchanged: the adapter already had it validated against the
    // platform's own contract, and re-deriving it here would be a second source of truth.
    manifest,
    install,
    load,
    unload,
    healthCheck,
    runtimeInfo,
    errorReport,
    diagnostics,
    /**
     * The plugin's own diagnostics, as its own hook.
     *
     * It is listed here so the loop below does not overwrite it: `diagnostics` above is the
     * platform's standard answer and it wins that name, which means the descriptor's own
     * `diagnostics` would otherwise be silently replaced by it — a plugin would publish a report
     * nobody could reach.
     */
    domainDiagnostics,
    /** The lifecycle state machine, for tests and for the panel. */
    lifecycleState: () => live.state,
    LIFECYCLE_STATES
  }

  // Anything else the adapter attached (a compat descriptor's own surface, a bridge handle) is
  // preserved rather than dropped: this wrapper adds the standard interfaces, it does not replace
  // what the adapter produced. The one name it does own is `diagnostics`, because that is the
  // platform's interface; the plugin's own report travels as `domainDiagnostics` above.
  for (const [key, value] of Object.entries(descriptor)) {
    if (key in unified) continue
    unified[key] = value
  }
  return unified
}

/** Turn a recorded error into an `Error` the manager can catch, keeping the code it was given. */
function codedError(entry) {
  const error = new Error(entry.reason)
  error.code = entry.code
  error.phase = entry.phase
  error.plugin = entry.plugin
  return error
}

module.exports = {
  LIFECYCLE_STATES,
  DEFAULT_ERROR_LIMIT,
  createErrorReporter,
  normalizeHealth,
  unifyLifecycle,
  codedError
}
