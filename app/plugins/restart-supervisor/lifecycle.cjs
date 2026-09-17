'use strict'

/**
 * DS-Hns: the restart lifecycle — the ordered sequence, with every side effect injected.
 *
 * ```
 *   restart requested
 *     → validate the request
 *     → check the restart budget
 *     → check the cooldown
 *     → notify the Core continuity layer
 *     → stop accepting unsafe new work
 *     → checkpoint / persist state
 *     → wait for a safe boundary
 *     → graceful shutdown        (forced only if the graceful path does not finish)
 *     → the executor observes the exit and relaunches
 *     → wait for process readiness
 *     → wait for network readiness
 *     → wait for plugin readiness
 *     → tell continuity it may resume
 *     → the previous tasks continue (Core's job, not this file's)
 * ```
 *
 * Every arrow is a function the caller supplies. That is not testability for its own sake — it is the
 * architecture: this module must not know how a task is checkpointed, how the network is probed or
 * how a process is started. It knows the **order**, which is the thing that is easy to get wrong and
 * expensive to get wrong: a checkpoint written after the process dies is not a checkpoint.
 *
 * ## What this module deliberately does not do
 *
 * It does not implement task recovery. `continuity.beforeRestart()` is asked to park and persist, and
 * `continuity.afterRestart()` is *told* the application is ready again. What resuming means, which
 * tasks continue and from which checkpoint, belongs to Core continuity (`app/extensions/mega/…` and
 * the task layer), and duplicating it here would be a second answer to a question that already has
 * one.
 *
 * ## The boundary, and why it is bounded
 *
 * A restart that exists to continue a task never fires before that task can be parked — and a park
 * that never settles is a restart that never happens, which is its own outage. So the boundary wait
 * is bounded by `lifecycle.boundaryTimeoutMs`, and a boundary that is never reached is **reported**
 * with the last thing that blocked it rather than forced through. That is the same choice the reboot
 * coordinator makes, for the same reason: no deadline in this product ends a running task.
 */

const { REFUSAL_CODES, READINESS_GATES, SUPERVISOR_FAULT_CODES, SHUTDOWN_KINDS } = require('./policy.cjs')

function fault(code, reason, extra = {}) {
  return { ok: false, code, reason: String(reason), ...extra }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * @param {object} input
 * @param {object} input.budget the restart budget (`budget.cjs`)
 * @param {object} [input.config] the merged supervisor configuration
 * @param {Function} [input.now]
 * @param {Function} [input.log]
 * @param {object} [input.executor] how a process is stopped and started
 * @param {Function} [input.executor.stop] `({ kind, timeoutMs }) => { ok, detail }`
 * @param {Function} [input.executor.launch] `() => { ok, pid }`
 * @param {Function} [input.executor.waitForExit] `({ timeoutMs }) => { ok, exited, code }`
 * @param {object} [input.continuity] the Core continuity hooks
 * @param {Function} [input.continuity.beforeRestart] `(plan) => { ok, detail, parked }`
 * @param {Function} [input.continuity.afterRestart] `(plan) => { ok, detail, resumed }`
 * @param {Function} [input.continuity.pendingWork] `() => { active, nearCheckpoint, uninterruptible, queued }`
 * @param {object} [input.readiness] the readiness probes, `{ process, runtime, network, plugins, continuity }`
 * @param {Function} [input.sleep] injectable, so a test does not wait out a real backoff
 * @param {Function} [input.onPhase] `(phase, detail) => void` — called at each stage of the sequence
 */
function createRestartLifecycle(input = {}) {
  const budget = input.budget
  const config = input.config || {}
  const now = typeof input.now === 'function' ? input.now : () => Date.now()
  const log = typeof input.log === 'function' ? input.log : () => {}
  const wait = typeof input.sleep === 'function' ? input.sleep : sleep
  const executor = input.executor && typeof input.executor === 'object' ? input.executor : {}
  const continuity = input.continuity && typeof input.continuity === 'object' ? input.continuity : {}
  const probes = input.readiness && typeof input.readiness === 'object' ? input.readiness : {}
  /**
   * The stage observer.
   *
   * A restart destroys the memory it runs in, so the *progress* of one has to leave the process as it
   * happens — that is what `restart_status` is for, and this is where the lifecycle reports it. The
   * callback is deliberately fire-and-forget: an observer that throws must not fail a restart, and one
   * that is absent must not change the sequence.
   */
  const onPhase = typeof input.onPhase === 'function' ? input.onPhase : null
  function notePhase(phase, detail = null) {
    if (!onPhase) return
    try {
      onPhase(String(phase), detail === null || detail === undefined ? null : String(detail))
    } catch (error) {
      log(`the restart stage observer threw at ${phase}: ${error && error.message ? error.message : error}`)
    }
  }
  const lifecycleConfig = (config.lifecycle && typeof config.lifecycle === 'object') ? config.lifecycle : {}
  const readinessConfig = (config.readiness && typeof config.readiness === 'object') ? config.readiness : {}
  const gracefulTimeoutMs = Number.isFinite(lifecycleConfig.gracefulTimeoutMs) ? lifecycleConfig.gracefulTimeoutMs : 45_000
  const forcedTimeoutMs = Number.isFinite(lifecycleConfig.forcedTimeoutMs) ? lifecycleConfig.forcedTimeoutMs : 15_000
  const boundaryTimeoutMs = Number.isFinite(lifecycleConfig.boundaryTimeoutMs) ? lifecycleConfig.boundaryTimeoutMs : 300_000
  const readinessTimeoutMs = Number.isFinite(readinessConfig.timeoutMs) ? readinessConfig.timeoutMs : 180_000
  const readinessAttempts = Number.isFinite(readinessConfig.maxAttempts) ? readinessConfig.maxAttempts : 8
  const readinessBackoffMs = Number.isFinite(readinessConfig.backoffMs) ? readinessConfig.backoffMs : 1_000
  const readinessBackoffMaxMs = Number.isFinite(readinessConfig.backoffMaxMs) ? readinessConfig.backoffMaxMs : 20_000
  const requiredGates = Array.isArray(readinessConfig.required) ? readinessConfig.required.map(String) : ['process', 'runtime']

  /** The one restart in flight, if any. A second request is refused while this is set. */
  let active = null

  /** Call an injected hook, and turn a throw into a value. A hook is third-party code from here. */
  async function call(hook, args, label) {
    if (typeof hook !== 'function') return { ok: true, skipped: true, detail: `no ${label} is configured` }
    try {
      const outcome = await hook(...args)
      if (!outcome || typeof outcome !== 'object') return { ok: true, skipped: true, detail: `${label} returned nothing` }
      return outcome
    } catch (error) {
      const reason = String(error && error.message ? error.message : error)
      log(`${label} threw: ${reason}`)
      return { ok: false, threw: true, reason }
    }
  }

  /**
   * The safe-boundary question, asked of the continuity layer.
   *
   * `pendingWork()` is Core's answer, not this module's guess: only the task layer knows whether a
   * task is mid-stage, near a checkpoint or in an operation its own state machine calls
   * uninterruptible. The decision made from it is this module's, and it is deliberately conservative:
   * an uninterruptible operation always defers, and a task near its checkpoint is worth waiting a
   * moment for.
   */
  function boundaryAssessment() {
    return call(continuity.pendingWork, [], 'continuity.pendingWork')
  }

  async function waitForBoundary(deadlineAt, onWaiting) {
    let last = null
    while (now() < deadlineAt) {
      const assessment = await boundaryAssessment()
      if (assessment.ok !== true) {
        // A continuity layer that cannot answer is not a reason to refuse a restart that was asked
        // for: it is a reason to say so, and continue without a boundary promise.
        return { ok: true, safe: true, unknown: true, detail: assessment.reason || 'the continuity layer could not report pending work' }
      }
      const active_ = assessment.active === true
      if (assessment.uninterruptible === true) {
        last = 'an uninterruptible operation is in flight'
      } else if (active_ && assessment.nearCheckpoint !== true) {
        last = 'an active task is not yet near a checkpoint'
      } else {
        return { ok: true, safe: true, detail: last ? `the boundary was reached (${last})` : 'the boundary is clear', assessment }
      }
      if (typeof onWaiting === 'function') onWaiting({ at: now(), detail: last, assessment })
      log(`restart waiting for a safe boundary: ${last}`)
      await wait(Math.min(2_000, Math.max(0, deadlineAt - now())))
    }
    return fault(REFUSAL_CODES.UNSAFE_BOUNDARY, `no safe boundary was reached within ${boundaryTimeoutMs}ms (${last || 'the boundary was never clear'})`)
  }

  /**
   * One readiness gate, with bounded retries and backoff.
   *
   * The retry budget exists for one concrete Windows behaviour: after a logon or a reboot the network
   * often comes up *after* the application does, so the first failure of a network probe is not a
   * failed boot. The bound exists because "retry forever" is the other way to turn a slow start into
   * a hang. A gate that exhausts its attempts is reported with its last reason, and only a gate in
   * `readiness.required` fails the sequence.
   */
  async function waitForGate(gateId, deadlineAt) {
    const probe = probes[gateId]
    const required = requiredGates.includes(gateId)
    const gate = READINESS_GATES.find((entry) => entry.id === gateId) || { id: gateId, label: gateId }
    if (typeof probe !== 'function') {
      return { id: gateId, ok: true, skipped: true, required, attempts: 0, detail: `no ${gateId} probe is configured`, label: gate.label }
    }
    let attempt = 0
    let lastReason = null
    let backoff = readinessBackoffMs
    while (attempt < readinessAttempts && now() < deadlineAt) {
      attempt += 1
      let outcome = null
      try {
        outcome = await probe({ attempt, deadlineAt })
      } catch (error) {
        outcome = { ok: false, reason: String(error && error.message ? error.message : error) }
      }
      const ok = outcome && outcome.ok === true
      lastReason = outcome && outcome.reason ? String(outcome.reason) : lastReason
      if (ok) {
        return { id: gateId, ok: true, required, attempts: attempt, detail: (outcome && outcome.detail) || gate.label, label: gate.label }
      }
      log(`readiness ${gateId} not up yet (attempt ${attempt}/${readinessAttempts}): ${lastReason || 'no reason given'}`)
      if (attempt < readinessAttempts && now() + backoff < deadlineAt) await wait(backoff)
      backoff = Math.min(backoff * 2, readinessBackoffMaxMs)
    }
    return {
      id: gateId,
      ok: !required,
      skipped: !required,
      required,
      attempts: attempt,
      detail: lastReason || 'the gate did not come up',
      label: gate.label,
      timedOut: now() >= deadlineAt
    }
  }

  /**
   * The whole readiness sequence, in the order `READINESS_GATES` names.
   *
   * Gates run in order rather than in parallel on purpose: "the network is reachable" is only a
   * meaningful question once the runtime answered, and a plugin host that reports ready before its
   * runtime exists is reporting a lie. The global deadline is shared, so a slow network gate cannot
   * extend the boot past `readiness.timeoutMs`.
   */
  async function waitForReadiness(startedAt) {
    const deadlineAt = startedAt + readinessTimeoutMs
    const gates = []
    for (const gate of READINESS_GATES) {
      const outcome = await waitForGate(gate.id, deadlineAt)
      gates.push(outcome)
      if (outcome.ok !== true) break
    }
    const failed = gates.filter((gate) => gate.required && gate.ok !== true)
    const skipped = gates.filter((gate) => gate.skipped === true)
    return {
      ok: failed.length === 0,
      at: now(),
      ms: now() - startedAt,
      gates,
      failed: failed.map((gate) => gate.id),
      skipped: skipped.map((gate) => gate.id),
      code: failed.length ? SUPERVISOR_FAULT_CODES.READINESS_FAILED : null,
      reason: failed.length ? `${failed.map((gate) => `${gate.id}: ${gate.detail}`).join('; ')}` : null
    }
  }

  /**
   * Stop the application, gracefully then forcibly.
   *
   * The graceful attempt is not a formality: it is what lets the runtime flush, close its sockets and
   * release its locks. The forced path is taken only after `gracefulTimeoutMs`, and a forced stop
   * **removes the checkpoint guarantee** for anything that had not been persisted — which is exactly
   * why the checkpoint step is ordered before it and not after.
   */
  async function stopApplication(at) {
    const graceful = await call(executor.stop, [{ kind: SHUTDOWN_KINDS.GRACEFUL, timeoutMs: gracefulTimeoutMs, reason: at.plan.reasonSummary }], 'executor.stop(graceful)')
    if (graceful.ok === true) return { ok: true, kind: SHUTDOWN_KINDS.GRACEFUL, detail: graceful.detail || 'the application stopped gracefully', ms: now() - at.stoppingAt }

    const detail = graceful.reason || graceful.detail || 'the graceful stop did not complete'
    log(`graceful stop did not finish (${detail}); forcing`)
    const forced = await call(executor.stop, [{ kind: SHUTDOWN_KINDS.FORCED, timeoutMs: forcedTimeoutMs, reason: at.plan.reasonSummary }], 'executor.stop(forced)')
    if (forced.ok === true) {
      return { ok: true, kind: SHUTDOWN_KINDS.FORCED, forced: true, detail: `forced after a graceful stop failed: ${detail}`, ms: now() - at.stoppingAt, gracefulFailure: detail }
    }
    return fault(
      SUPERVISOR_FAULT_CODES.EXECUTION_FAILED,
      `the application could not be stopped (graceful: ${detail}; forced: ${forced.reason || forced.detail || 'no reason given'})`,
      { gracefulFailure: detail, forcedFailure: forced.reason || forced.detail || null }
    )
  }

  /**
   * Run one restart end to end.
   *
   * The returned value is the record that goes into the history: `{ ok, code, detail, gates, ms }`.
   * A refusal before execution is `ok: false` with a `REFUSAL_CODES` code and `counted: false` — it
   * did not spend the budget, because nothing happened.
   */
  async function run(request = {}) {
    if (active) return fault(REFUSAL_CODES.ALREADY_PENDING, `a restart is already in flight (${active.plan.id})`, { plan: active.plan })
    const at = { plan: null, startedAt: now(), stoppingAt: null }
    const decision = budget.evaluate(request, at.startedAt)
    if (decision.ok !== true) return { ...decision, counted: false, ms: 0 }
    at.plan = budget.accept(request, at.startedAt)
    active = at
    log(`restart ${at.plan.id} accepted: ${at.plan.reasonCode} (${decision.remaining} left in the budget)`)

    try {
      // 1. Tell Core continuity what is about to happen, before anything stops accepting work: the
      //    layer that owns the tasks has to know first, or it will be asked to park something it has
      //    already lost.
      notePhase('CONTINUITY', `${at.plan.reasonCode}: ${request.reasonSummary || 'no summary'}`)
      const notified = await call(continuity.beforeRestart, [{ plan: at.plan, request, at: at.startedAt }], 'continuity.beforeRestart')
      if (notified.ok !== true && notified.threw !== true) {
        // A continuity layer that answers "no" is refusing: the request is cancelled and the budget
        // is not spent on it.
        budget.cancelPending('continuity refused')
        const record = budget.record({ at: now(), ok: false, counted: false, reasonCode: at.plan.reasonCode, code: notified.code || 'CONTINUITY_REFUSED', detail: notified.reason || 'the continuity layer refused the restart' })
        return { ok: false, code: notified.code || 'CONTINUITY_REFUSED', reason: record.detail, record, counted: false, ms: now() - at.startedAt }
      }

      // 2. Wait for a boundary the task layer calls safe, inside a bounded window.
      notePhase('BOUNDARY', 'waiting for a safe boundary')
      const boundary = await waitForBoundary(at.startedAt + boundaryTimeoutMs)
      if (boundary.ok !== true) {
        budget.cancelPending('no safe boundary')
        const unparked = await call(continuity.afterRestart, [{ plan: at.plan, aborted: true, reason: boundary.reason }], 'continuity.afterRestart(aborted)')
        const record = budget.record({ at: now(), ok: false, counted: false, reasonCode: at.plan.reasonCode, code: boundary.code, detail: boundary.reason })
        return { ok: false, code: boundary.code, reason: boundary.reason, record, counted: false, unparked: unparked.detail || null, ms: now() - at.startedAt }
      }

      // 3. Stop the application. Everything after this point is post-mortem for this process.
      at.stoppingAt = now()
      notePhase('STOPPING', `graceful, then forced after ${gracefulTimeoutMs}ms`)
      const stopped = await stopApplication(at)
      if (stopped.ok !== true) {
        const record = budget.record({ at: now(), ok: false, reasonCode: at.plan.reasonCode, code: stopped.code, detail: stopped.reason, durationMs: now() - at.startedAt })
        return { ok: false, code: stopped.code, reason: stopped.reason, record, counted: true, ms: now() - at.startedAt }
      }
      notePhase('STOPPED', `${stopped.kind}${stopped.forced ? ' (forced)' : ''}`)

      // 4. The executor relaunches. From here the supervisor is waiting for evidence, not commanding.
      notePhase('RELAUNCHING', 'the executor is starting the application again')
      const launched = await call(executor.launch, [{ plan: at.plan, kind: stopped.kind }], 'executor.launch')
      if (launched.ok !== true) {
        const record = budget.record({ at: now(), ok: false, reasonCode: at.plan.reasonCode, code: SUPERVISOR_FAULT_CODES.EXECUTION_FAILED, detail: launched.reason || 'the application could not be relaunched', durationMs: now() - at.startedAt })
        return { ok: false, code: record.code, reason: record.detail, record, counted: true, ms: now() - at.startedAt }
      }
      at.relaunchedAt = now()
      const waited = await call(executor.waitForExit, [{ timeoutMs: gracefulTimeoutMs }], 'executor.waitForExit')

      // 5. Readiness: five gates, bounded retries, one shared deadline.
      notePhase('READINESS', 'waiting for the readiness gates')
      const readiness = await waitForReadiness(at.relaunchedAt)
      if (readiness.ok !== true) {
        const record = budget.record({ at: now(), ok: false, reasonCode: at.plan.reasonCode, code: readiness.code, detail: readiness.reason, readiness, durationMs: now() - at.startedAt })
        return { ok: false, code: readiness.code, reason: readiness.reason, readiness, record, counted: true, ms: now() - at.startedAt }
      }

      // 6. Tell continuity it may resume. It does the resuming.
      notePhase('RECOVERY', 'asking Core continuity to resume the interrupted work')
      const resume = await call(continuity.afterRestart, [{ plan: at.plan, readiness }], 'continuity.afterRestart')
      const record = budget.record({
        at: now(),
        ok: true,
        reasonCode: at.plan.reasonCode,
        reasonSummary: request.reasonSummary || null,
        detail: `restarted in ${stopped.kind}; readiness ${readiness.ms}ms; continuity ${resume.ok === true ? 'resumed' : resume.skipped ? 'not configured' : `did not resume (${resume.reason})`}`,
        readiness,
        durationMs: now() - at.startedAt
      })
      void waited
      return {
        ok: true,
        record,
        shutdown: stopped,
        readiness,
        resume,
        /** The honest statement about who continues the work. */
        resumed: resume.ok === true,
        ms: now() - at.startedAt
      }
    } finally {
      active = null
      budget.refreshLadder()
    }
  }

  /** The restart in flight, for a caller that wants to report or cancel it. */
  function pending() {
    return active ? { plan: { ...active.plan }, startedAt: active.startedAt, forMs: now() - active.startedAt } : null
  }

  function cancel(reason = 'cancelled by the user') {
    if (!active) return fault(REFUSAL_CODES.ALREADY_PENDING, 'there is no restart in flight')
    // The lifecycle cannot un-stop a process that is already stopping, so a cancel is honest about
    // which phase it interrupted: before the stop it prevents the restart, after it only records.
    const phase = active.stoppingAt === null ? 'before-stop' : 'after-stop'
    const cancelled = budget.cancelPending(reason)
    return { ok: phase === 'before-stop', phase, reason: phase === 'before-stop' ? null : 'the application is already stopping; the request cannot be withdrawn', cancelled: cancelled.cancelled || null, at: now() }
  }

  return {
    run,
    pending,
    cancel,
    waitForReadiness: () => waitForReadiness(now()),
    waitForBoundary: (timeoutMs) => waitForBoundary(now() + (Number.isFinite(timeoutMs) ? timeoutMs : boundaryTimeoutMs)),
    stopApplication,
    config: { gracefulTimeoutMs, forcedTimeoutMs, boundaryTimeoutMs, readinessTimeoutMs, readinessAttempts, requiredGates }
  }
}

module.exports = { createRestartLifecycle }
