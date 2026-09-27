'use strict'

/**
 * DS-Hns: the four heartbeat signals, and the rule that a live pid is not a healthy product.
 *
 * ```
 *   process alive        ── the operating system still has the pid
 *   runtime responsive   ── the runtime answered within its own budget
 *   loop responsive      ── the main event loop is scheduling its own work
 *   startup ready        ── the application finished booting, and said so
 * ```
 *
 * They are four separate facts because collapsing them is how a hung application looks healthy: a
 * process can exist, hold its port, answer nothing, and have a frozen event loop. The classic failure
 * is exactly that, and a supervisor that only watched `kill(pid, 0)` would wait forever.
 *
 * The module is a *tracker*, not a timer: it is told when a beat arrives and is asked, when the
 * supervisor needs to know, whether the picture is fresh. That keeps the supervisor's clock the only
 * clock, and makes "the heartbeat went stale 30 seconds before the restart" a fact a test can assert
 * without waiting thirty seconds.
 */

/** The signal ids, in the order they are reported. */
const HEARTBEAT_SIGNALS = Object.freeze(['alive', 'responsive', 'loop', 'ready'])

/** The vocabulary a beat or an observation may use. */
const HEARTBEAT_STATES = Object.freeze({
  /** Nothing has ever reported this signal. Unknown is not healthy. */
  UNKNOWN: 'unknown',
  FRESH: 'fresh',
  STALE: 'stale',
  /** The signal reported a failure of its own (the runtime threw, the loop is frozen). */
  FAILED: 'failed'
})

/**
 * @param {object} [options]
 * @param {object} [options.config] the `heartbeat` block of the supervisor configuration
 * @param {Function} [options.now]
 */
function createHeartbeatMonitor(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const config = {
    intervalMs: Number.isFinite(options.config && options.config.intervalMs) ? options.config.intervalMs : 5_000,
    timeoutMs: Number.isFinite(options.config && options.config.timeoutMs) ? options.config.timeoutMs : 30_000,
    forcedAfterMs: Number.isFinite(options.config && options.config.forcedAfterMs) ? options.config.forcedAfterMs : 90_000,
    gracefulRecoveryMs: Number.isFinite(options.config && options.config.gracefulRecoveryMs) ? options.config.gracefulRecoveryMs : 30_000,
    /**
     * How long the *process* may go unseen before it is treated as gone.
     *
     * Separate from, and much shorter than, `timeoutMs`, because they answer different questions. The
     * heartbeat may lag by a few intervals and still be a heartbeat; process liveness is a question
     * the operating system answers on every check, so "not seen for several intervals" means it is
     * not there. Collapsing the two is how a dead process gets reported as unresponsive, and how the
     * recovery path takes the wrong branch.
     */
    livenessTimeoutMs: Number.isFinite(options.config && options.config.livenessTimeoutMs)
      ? options.config.livenessTimeoutMs
      : Math.max(2_000, (Number.isFinite(options.config && options.config.intervalMs) ? options.config.intervalMs : 5_000) * 4)
  }

  /** When each signal was last observed fresh, and what it last said. */
  const signals = {}
  for (const id of HEARTBEAT_SIGNALS) signals[id] = { id, at: null, state: HEARTBEAT_STATES.UNKNOWN, detail: null, failures: 0, observations: 0 }
  /** When the process was seen to be alive, which is a fact the supervisor learns from the OS. */
  let processSeenAt = null
  let processPid = null

  /**
   * One observation of one signal.
   *
   * A signal may be *refreshed* (`state: fresh`) or *faulted* (`state: failed`) — the difference is
   * what makes the escalation meaningful: a runtime that answers "I am unresponsive" is a different
   * situation from a runtime that has stopped answering, even though both end in a restart. `detail`
   * is carried through to the diagnostics verbatim, so a fault says what threw.
   */
  function observe(id, state = HEARTBEAT_STATES.FRESH, detail = null, atMs = now(), healthConfig = config) {
    const signal = signals[id]
    if (!signal) return { ok: false, reason: `"${id}" is not a heartbeat signal`, known: HEARTBEAT_SIGNALS.slice() }
    signal.observations += 1
    signal.at = atMs
    signal.state = state
    signal.detail = detail === null || detail === undefined ? null : String(detail)
    if (state === HEARTBEAT_STATES.FAILED) signal.failures += 1
    if (state === HEARTBEAT_STATES.FRESH) {
      signal.failures = 0
      // A fresh `ready` beat is evidence that the runtime and the loop answered, so it implies them
      // rather than asking a caller to send four beats. It does **not** imply `alive`: process
      // liveness is the operating system's answer, and it arrives through `seen()` alone.
      if (id === 'ready') {
        for (const implied of ['responsive', 'loop']) {
          signals[implied] = { ...signals[implied], at: atMs, state: HEARTBEAT_STATES.FRESH, observations: signals[implied].observations + 1 }
        }
      }
    }
    void healthConfig
    return { ok: true, signal: { ...signal } }
  }

  /**
   * Record that the operating system still has the process.
   *
   * This is the *only* thing that reports `alive`, and it deliberately does not refresh the other
   * signals: "the pid exists" and "the runtime is answering" are the two facts this module exists to
   * keep apart, and a `seen()` that also refreshed responsiveness would collapse them into the one
   * check a hung application passes.
   */
  function seen(pid, atMs = now()) {
    processSeenAt = atMs
    processPid = pid === null || pid === undefined ? processPid : Number(pid)
    signals.alive = { ...signals.alive, at: atMs, state: HEARTBEAT_STATES.FRESH, observations: signals.alive.observations + 1 }
    return { ok: true, signal: { ...signals.alive } }
  }

  function ageOf(id, atMs = now()) {
    const signal = signals[id]
    if (!signal.at) return null
    return atMs - signal.at
  }

  /** One signal's verdict: fresh, stale, failed, or unknown. */
  function stateOf(id, atMs = now(), timeoutMs = null) {
    const signal = signals[id]
    if (!signal || signal.at === null) return { id, state: HEARTBEAT_STATES.UNKNOWN, ageMs: null, detail: 'nothing has reported this signal' }
    if (signal.state === HEARTBEAT_STATES.FAILED) return { id, state: HEARTBEAT_STATES.FAILED, ageMs: atMs - signal.at, detail: signal.detail }
    /**
     * `alive` is judged on its own clock, and the other signals on the heartbeat's.
     *
     * That split is the module's whole claim: a process can exist and answer nothing. The liveness
     * timeout is a few intervals (the operating system answers on every check), while the heartbeat
     * timeout is the declared budget for a beat — so "gone" is diagnosed sooner than "unresponsive",
     * which is the right way round: a dead process should not spend three missed beats looking slow.
     */
    const budget = Number.isFinite(timeoutMs)
      ? timeoutMs
      : id === 'alive' ? config.livenessTimeoutMs : config.timeoutMs
    const ageMs = atMs - signal.at
    if (ageMs > budget) return { id, state: HEARTBEAT_STATES.STALE, ageMs, detail: `no beat for ${ageMs}ms, past the ${budget}ms timeout` }
    return { id, state: HEARTBEAT_STATES.FRESH, ageMs, detail: signal.detail }
  }

  /**
   * The whole picture, and the escalation it implies.
   *
   * The escalation is the requirement's own table, made explicit rather than left to the caller:
   *
   * | What is seen | What the supervisor should do |
   * | --- | --- |
   * | alive and every other signal fresh | nothing |
   * | alive but a signal stale inside the graceful budget | *attempt a graceful recovery* |
   * | alive but any signal stale past `forcedAfterMs` | *forced restart* — stop waiting |
   * | not alive | the process is gone; recover it |
   *
   * The third row is the one that matters: a process that exists but has not beaten for ninety
   * seconds is not a process to keep waiting for, and "wait forever" is precisely the failure this
   * whole component exists to prevent.
   */
  function report(atMs = now()) {
    const perSignal = {}
    for (const id of HEARTBEAT_SIGNALS) perSignal[id] = stateOf(id, atMs)
    const alive = perSignal.alive
    const processAlive = processSeenAt !== null ? atMs - processSeenAt <= config.livenessTimeoutMs : false
    /**
     * The signals that are *late*, which is the heartbeat's own question.
     *
     * `alive` is excluded because process liveness has its own clock (`processSeenAt`, refreshed only
     * by `seen()`), and folding it in here would make a missing heartbeat look like a dead process.
     * That distinction is the whole point of the four signals: a process can exist and answer nothing,
     * and only keeping the two clocks apart can say so.
     */
    const pathological = HEARTBEAT_SIGNALS
      .filter((id) => id !== 'alive')
      .map((id) => perSignal[id])
      .filter((entry) => entry.state === HEARTBEAT_STATES.FAILED || entry.state === HEARTBEAT_STATES.STALE)
    const unknown = HEARTBEAT_SIGNALS.filter((id) => perSignal[id].state === HEARTBEAT_STATES.UNKNOWN)
    const staleSince = pathological.length ? Math.max(...pathological.map((entry) => entry.ageMs)) : 0
    /** How long the heartbeat itself has been silent, over the signals that were ever seen. */
    const seenSignals = HEARTBEAT_SIGNALS.filter((id) => perSignal[id].ageMs !== null)
    const heartbeatSilentForMs = seenSignals.length ? Math.max(...seenSignals.map((id) => perSignal[id].ageMs)) : 0

    let verdict = 'healthy'
    let action = 'none'
    let reason = null
    if (processSeenAt !== null && !processAlive) {
      // The operating system says the process is gone. Nothing else matters.
      verdict = 'gone'
      action = 'recover'
      reason = `the process has not been seen for ${atMs - processSeenAt}ms`
    } else if (!pathological.length) {
      verdict = unknown.length ? 'partial' : 'healthy'
      reason = unknown.length ? `no telemetry yet for ${unknown.join(', ')}` : null
    } else if (staleSince >= config.forcedAfterMs) {
      verdict = 'hung'
      action = 'forced-restart'
      reason = `the process is alive but ${pathological.map((entry) => entry.id).join(', ')} went stale ${staleSince}ms ago, past the ${config.forcedAfterMs}ms forced threshold`
    } else if (staleSince >= config.gracefulRecoveryMs) {
      verdict = 'unresponsive'
      action = 'graceful-recovery'
      reason = `${pathological.map((entry) => entry.id).join(', ')} went stale ${staleSince}ms ago; a graceful recovery is due`
    } else {
      verdict = 'unresponsive'
      action = 'observe'
      reason = `${pathological.map((entry) => entry.id).join(', ')} went stale ${staleSince}ms ago; inside the ${config.gracefulRecoveryMs}ms graceful window`
    }

    return {
      at: atMs,
      verdict,
      action,
      reason,
      processAlive,
      processPid,
      staleSinceMs: staleSince,
      heartbeatSilentForMs,
      signals: perSignal,
      config: { ...config },
      unknown
    }
  }

  /** Everything is dropped on unload: a disabled supervisor holds no liveness history. */
  function reset() {
    for (const id of HEARTBEAT_SIGNALS) signals[id] = { id, at: null, state: HEARTBEAT_STATES.UNKNOWN, detail: null, failures: 0, observations: 0 }
    processSeenAt = null
    processPid = null
    return { ok: true }
  }

  return {
    HEARTBEAT_SIGNALS,
    config,
    observe,
    seen,
    stateOf,
    ageOf,
    report,
    reset,
    signals: () => Object.fromEntries(HEARTBEAT_SIGNALS.map((id) => [id, { ...signals[id] }])),
    /** Bound helpers, so the plugin side of the heartbeat is one call per signal. */
    beatAlive: (pid, atMs) => seen(pid, atMs),
    beatResponsive: (detail, atMs) => observe('responsive', HEARTBEAT_STATES.FRESH, detail, atMs),
    beatLoop: (detail, atMs) => observe('loop', HEARTBEAT_STATES.FRESH, detail, atMs),
    beatReady: (detail, atMs) => observe('ready', HEARTBEAT_STATES.FRESH, detail, atMs),
    /** A signal that reported its own failure, e.g. a runtime probe that threw. */
    fail: (id, detail, atMs) => observe(id, HEARTBEAT_STATES.FAILED, detail, atMs)
  }
}

module.exports = { createHeartbeatMonitor, HEARTBEAT_SIGNALS, HEARTBEAT_STATES }
