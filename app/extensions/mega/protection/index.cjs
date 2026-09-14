'use strict'

/**
 * The MEGA Protection Layer (`updateplan/startup2.md` §12-§18).
 *
 * MEGA is no longer a status strip: it is the control plane for everything this product adds on top of
 * the official UI, and the rule that makes that safe is that **nothing optional starts bare**. Every
 * enhancement module (wallpaper, market, appearance, a future community plugin) is registered here, and
 * this layer decides what its failure means.
 *
 *   * **A failure is never the Core's.** `start()` here answers, it does not throw: a module that times
 *     out, throws, or comes up unhealthy becomes DEGRADED or FAILED and its fallback runs. The plan's
 *     forbidden list — an optional plugin failure causing a blank application, a wallpaper failure
 *     taking the input box with it, a market failure stopping the Harness — is what this prevents by
 *     construction rather than by care.
 *   * **Time is bounded.** An optional module gets a budget (2–3s by default) and the boot does not
 *     wait past it: the module is marked degraded and may finish in the background, but INTERACTIVE
 *     has already happened (`app/startup.cjs`).
 *   * **Recovery is a ladder, not a loop.** One immediate retry, one delayed retry, then it stops.
 *     Retrying forever is how an enhancement hides a real failure and spends the machine's battery
 *     doing it.
 *   * **Every module answers the same questions**: state, version, how long it took, the last error,
 *     how many retries it has had, and where its fallback ended up. That is what the MEGA panel shows
 *     and what acceptance reads.
 */

/** The plan's module states (§14), in the order a module moves through them. */
const MODULE_STATE = Object.freeze({
  DISABLED: 'DISABLED',
  STARTING: 'STARTING',
  HEALTHY: 'HEALTHY',
  DEGRADED: 'DEGRADED',
  FAILED: 'FAILED',
  RECOVERING: 'RECOVERING'
})

/** §16: an optional module's first start is allowed this long before it is treated as degraded. */
const DEFAULT_TIMEOUT_MS = 3000
/** §17: one immediate retry, one delayed, then stop. */
const DEFAULT_RETRY_DELAY_MS = 1500

function nowMs() {
  return Date.now()
}

/**
 * A promise that cannot hang the caller: it always answers with `{ ok }`.
 *
 * `Promise.race` is not enough on its own — the losing promise still runs, and an unhandled rejection
 * from it would be reported against the wrong place — so the loser is caught here.
 */
function withTimeout(promise, timeoutMs) {
  if (!(timeoutMs > 0)) return Promise.resolve({ ok: true, value: undefined, timedOut: false })
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve({ ok: false, timedOut: true, reason: `did not answer within ${timeoutMs}ms` })
    }, timeoutMs)
    Promise.resolve(promise).then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ ok: true, value, timedOut: false })
      },
      (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ ok: false, timedOut: false, reason: String(error?.message || error) })
      }
    )
  })
}

/**
 * @param {object}   [options]
 * @param {Function} [options.log]      one line per state change
 * @param {Function} [options.setTimeout] test seam for the retry ladder
 * @param {number}   [options.defaultTimeoutMs]
 * @param {number}   [options.retryDelayMs]
 */
function createProtectionLayer({ log = () => {}, setTimeout: schedule = setTimeout, defaultTimeoutMs = DEFAULT_TIMEOUT_MS, retryDelayMs = DEFAULT_RETRY_DELAY_MS } = {}) {
  const modules = new Map()
  const events = []

  function record(entry) {
    events.push({ at: new Date().toISOString(), ...entry })
    if (events.length > 128) events.splice(0, events.length - 128)
  }

  function setState(module, state, reason = null) {
    if (module.state === state) return
    module.state = state
    if (reason) module.lastError = reason
    record({ module: module.id, event: 'state', state, reason })
    log(`[protection] ${module.id}: ${state}${reason ? ` — ${reason}` : ''}`)
  }

  /** The fallback chain (§18): what this module can degrade to, in order. */
  async function runFallback(module, reason) {
    const steps = Array.isArray(module.fallback) ? module.fallback : []
    module.fallbackState = steps.length ? 'running' : 'unavailable'
    for (const step of steps) {
      const outcome = await withTimeout(
        Promise.resolve().then(() => (typeof step === 'function' ? step() : step.run?.())),
        module.timeoutMs
      )
      if (outcome.ok) {
        module.fallbackState = typeof step === 'object' && step.id ? step.id : 'active'
        record({ module: module.id, event: 'fallback', state: module.fallbackState, reason })
        log(`[protection] ${module.id}: fallback ${module.fallbackState} is carrying it (${reason})`)
        return true
      }
      record({ module: module.id, event: 'fallback-failed', reason: outcome.reason || 'unknown' })
    }
    module.fallbackState = 'unavailable'
    log(`[protection] ${module.id}: no fallback left (${reason})`)
    return false
  }

  /** One attempt: STARTING → HEALTHY, or the failure that decides DEGRADED / FAILED. */
  async function attempt(module) {
    setState(module, module.retries === 0 ? MODULE_STATE.STARTING : MODULE_STATE.RECOVERING)
    const startedAt = nowMs()
    const outcome = await withTimeout(
      Promise.resolve().then(() => module.start?.()),
      module.timeoutMs
    )
    module.startMs = nowMs() - startedAt

    if (!outcome.ok) {
      module.lastError = outcome.reason
      setState(module, module.optional ? MODULE_STATE.DEGRADED : MODULE_STATE.FAILED, outcome.reason)
      await runFallback(module, outcome.reason)
      return { ok: false, reason: outcome.reason, timedOut: Boolean(outcome.timedOut) }
    }

    const described = typeof module.healthCheck === 'function' ? module.healthCheck() : true
    if (described === false || described?.healthy === false) {
      const reason = described?.reason || 'the module reported itself unhealthy'
      module.lastError = reason
      setState(module, MODULE_STATE.DEGRADED, reason)
      await runFallback(module, reason)
      return { ok: false, reason }
    }

    setState(module, MODULE_STATE.HEALTHY)
    module.lastError = null
    module.fallbackState = 'idle'
    return { ok: true, value: outcome.value }
  }

  /**
   * Register a module. Nothing optional runs outside this call (§13).
   *
   * `fallback` is a list — a function, or `{ id, run }` — tried in order when the module fails (§18).
   * `optional: true` is what makes a failure DEGRADED rather than FAILED, which is the difference the
   * MEGA panel shows and the difference that keeps a broken plugin from looking like a broken product.
   */
  function register({ id, optional = true, version = null, start = null, stop = null, healthCheck = null, fallback = [], timeoutMs = defaultTimeoutMs }) {
    if (!id || typeof id !== 'string') throw new Error('a protected module needs an id')
    if (modules.has(id)) return modules.get(id)
    const module = {
      id,
      optional: optional !== false,
      version,
      start,
      stop,
      healthCheck,
      fallback: Array.isArray(fallback) ? fallback : fallback ? [fallback] : [],
      timeoutMs: Number(timeoutMs) > 0 ? Number(timeoutMs) : defaultTimeoutMs,
      state: MODULE_STATE.DISABLED,
      retries: 0,
      startMs: null,
      lastError: null,
      fallbackState: 'idle',
      attempts: 0
    }
    modules.set(id, module)
    record({ module: id, event: 'registered', optional: module.optional, version })
    return module
  }

  /**
   * Start one module, with the plan's retry ladder (§17): the first failure falls back immediately,
   * then one quick retry, then one delayed retry, and then it stops. It never throws.
   */
  async function start(id) {
    const module = modules.get(id)
    if (!module) return { id, ok: false, reason: 'unknown_module' }
    if (module.state === MODULE_STATE.HEALTHY) return { id, ok: true, already: true }
    module.retries = 0
    let result = await attempt(module)
    if (result.ok) return { id, ok: true, startMs: module.startMs }

    for (const delay of [0, retryDelayMs]) {
      module.retries += 1
      module.attempts += 1
      if (delay > 0) await new Promise((resolve) => schedule(resolve, delay))
      result = await attempt(module)
      if (result.ok) return { id, ok: true, retried: module.retries, startMs: module.startMs }
    }
    setState(module, module.optional ? MODULE_STATE.DEGRADED : MODULE_STATE.FAILED, module.lastError || 'still failing after the retry ladder')
    record({ module: id, event: 'gave-up', retries: module.retries, reason: module.lastError })
    return { id, ok: false, retries: module.retries, reason: module.lastError, fallback: module.fallbackState }
  }

  /** Health is re-readable at any time: a module that came up healthy can still decay. */
  async function check(id) {
    const module = modules.get(id)
    if (!module) return { id, ok: false, reason: 'unknown_module' }
    if (module.state === MODULE_STATE.DISABLED) return { id, ok: true, state: module.state }
    const described = typeof module.healthCheck === 'function' ? module.healthCheck() : true
    if (described === false || described?.healthy === false) {
      const reason = described?.reason || 'reported unhealthy'
      setState(module, MODULE_STATE.DEGRADED, reason)
      await runFallback(module, reason)
      return { id, ok: false, state: module.state, reason }
    }
    // A module that answers its own health check again is healthy again: recovery has to be as visible
    // as failure, or the panel keeps reporting a state the module has already left (§18).
    if (module.state === MODULE_STATE.DEGRADED) {
      setState(module, MODULE_STATE.HEALTHY)
      module.lastError = null
      module.fallbackState = 'idle'
    }
    return { id, ok: true, state: module.state }
  }

  async function checkAll() {
    const results = await Promise.all([...modules.keys()].map((id) => check(id)))
    return results
  }

  /** Stop one module (or all of them) — the exit path, and the "safe disable" of §15. */
  async function stop(id = null) {
    const targets = id ? [modules.get(id)].filter(Boolean) : [...modules.values()]
    for (const module of targets) {
      const outcome = await withTimeout(Promise.resolve().then(() => module.stop?.()), module.timeoutMs)
      setState(module, MODULE_STATE.DISABLED, outcome.ok ? null : `stop failed: ${outcome.reason}`)
    }
    return targets.map((module) => module.id)
  }

  /** The MEGA panel's data, and acceptance's (§14). */
  function describe() {
    return {
      modules: [...modules.values()].map((module) => ({
        id: module.id,
        optional: module.optional,
        version: module.version,
        state: module.state,
        startMs: module.startMs,
        retries: module.retries,
        lastError: module.lastError,
        fallback: module.fallbackState
      })),
      degraded: [...modules.values()].filter((module) => module.state === MODULE_STATE.DEGRADED).map((module) => module.id),
      failed: [...modules.values()].filter((module) => module.state === MODULE_STATE.FAILED).map((module) => module.id),
      healthy: [...modules.values()].filter((module) => module.state === MODULE_STATE.HEALTHY).map((module) => module.id),
      events: events.slice(-24)
    }
  }

  return {
    MODULE_STATE,
    register,
    start,
    check,
    checkAll,
    stop,
    describe,
    withTimeout,
    DEFAULT_TIMEOUT_MS,
    retryDelayMs
  }
}

module.exports = {
  createProtectionLayer,
  MODULE_STATE,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_RETRY_DELAY_MS,
  withTimeout
}
