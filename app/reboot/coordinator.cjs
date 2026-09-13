'use strict'

/**
 * Who decides that the moment has come, and what happens around it.
 *
 * A scheduled restart is easy to get wrong in one specific way: it fires while a long task is in the
 * middle of a stage, and the task is lost. So the coordinator is built around a single rule — **a
 * restart that exists to continue a task never fires before that task can be parked** — and around
 * a second one — **a restart that would lose the task is refused rather than executed**.
 *
 * The sequence, in order, every time:
 *
 *   1. the plan is due and its target reports a boundary it can be parked at;
 *   2. the target is parked (for the sub-worker that is `pause`, which the worker honours at its own
 *      checkpoint — so "parked" means it answered, not that a timer expired);
 *   3. the intent is written to disk *before* anything is asked of the operating system, because the
 *      moment the machine goes down is the moment the process's memory stops being a record;
 *   4. the relaunch is armed, and a restart that cannot bring the application back is refused;
 *   5. `shutdown /r` is issued with the plan's grace period, and the plan is marked executing.
 *
 * And after the machine comes back: `resumeOnStartup()` reads the intent, asks the target to
 * continue, and the plan leaves the list. The boundary between the two lives of the application is
 * that file — nothing else is trusted across it.
 *
 * Every target is injected. A build without a sub-worker simply has no target to park, and the plan
 * degrades to "restart the machine", which is reported rather than silently assumed.
 */

const { PLAN_STATES, TARGET_KINDS, describePlan, formatDuration, isDue } = require('./plan.cjs')

/**
 * The engineering phases an episode may be stopped in.
 *
 * Taken from the runtime's own vocabulary rather than copied: a second list here would be a list
 * that drifts, and the drift would be a restart in a phase the engine considers mid-mutation.
 */
const { PARKABLE_PHASES } = require('../engineering/episode.cjs')

/** How long a park may take before the plan gives up and reports why. Never a forced restart. */
const PARK_TIMEOUT_MS = 120_000

/**
 * @param {object} input
 * @param {object} input.store the plan store
 * @param {object} input.platform the OS half (`platform.cjs`)
 * @param {object} [input.targets] `{ subWorker, engineering }`, each `{ status, park, resume }`
 * @param {Function} [input.now]
 * @param {Function} [input.log]
 */
function createRebootCoordinator(input = {}) {
  const store = input.store
  const platform = input.platform
  const targets = input.targets && typeof input.targets === 'object' ? input.targets : {}
  const now = typeof input.now === 'function' ? input.now : () => Date.now()
  const log = typeof input.log === 'function' ? input.log : () => {}
  const parkTimeoutMs = Number.isFinite(input.parkTimeoutMs) ? input.parkTimeoutMs : PARK_TIMEOUT_MS

  /** The target adapter for a plan, or null when nothing is being continued. */
  function adapterFor(plan) {
    const kind = plan && plan.target ? plan.target.kind : TARGET_KINDS.NONE
    if (kind === TARGET_KINDS.SUB_WORKER) return targets.subWorker || null
    if (kind === TARGET_KINDS.ENGINEERING) return targets.engineering || null
    return null
  }

  function safeStatus(adapter) {
    if (!adapter || typeof adapter.status !== 'function') return null
    try {
      return adapter.status() || null
    } catch (error) {
      log(`a reboot target could not report its status: ${error && error.message ? error.message : error}`)
      return null
    }
  }

  /**
   * Is the target at a point where it can be stopped?
   *
   * The sub-worker reports `stage: null` between stages and its own `pause` is honoured at a
   * checkpoint, so "between stages" and "already parked" are both boundaries. An engineering episode
   * is only stoppable in the phases its own state machine calls parkable — a mutation in flight is
   * not one of them, and that is the point of asking.
   */
  function boundaryOf(plan) {
    const adapter = adapterFor(plan)
    if (!adapter) return { ready: true, detail: 'no target: nothing to park' }
    const status = safeStatus(adapter)
    if (!status) return { ready: true, detail: 'the target is not available; the restart continues without it' }
    if (status.running !== true) return { ready: true, detail: 'the target is not running' }
    if (plan.target.kind === TARGET_KINDS.SUB_WORKER) {
      if (status.paused === true || status.state === 'PAUSED') return { ready: true, detail: 'the worker is already parked' }
      if (!status.stage) return { ready: true, detail: 'the worker is between stages' }
      return { ready: false, detail: `the worker is in stage ${status.stage}` }
    }
    const phase = String(status.phase || '')
    if (!phase) return { ready: true, detail: 'no phase is being reported' }
    if (PARKABLE_PHASES.includes(phase)) return { ready: true, detail: `the episode is parkable in ${phase}` }
    return { ready: false, detail: `the episode is in ${phase}, which is not a parkable phase` }
  }

  /**
   * Park the target, and say whether it is finished parking.
   *
   * Two policies, because the two targets genuinely differ, and pretending otherwise would either
   * spam a worker or stop an episode in a phase its state machine forbids:
   *
   *   * `request-first` (the sub-worker) — ask to stop, then wait. Its `pause` is honoured at its own
   *     checkpoint, so asking immediately is how "park after the current stage" is achieved; asking
   *     only after the stage happened to end would make a plan that fires mid-stage do nothing.
   *   * `boundary-first` (an engineering episode) — wait for a phase the runtime calls parkable, then
   *     ask. A mutation in flight cannot be stopped, and the runtime says so by naming the phase.
   *
   * A park that never settles fails the *plan*: no deadline in this module ends a running task.
   */
  async function parkFor(plan) {
    const adapter = adapterFor(plan)
    if (!adapter) return { ok: true, pending: false, detail: 'no target to park' }
    if (typeof adapter.park !== 'function') return { ok: true, pending: false, detail: 'the target cannot be parked; continuing without it' }

    // Already asked on an earlier tick: the question now is whether it has finished parking.
    if (plan.state === PLAN_STATES.WAITING_BOUNDARY) {
      const boundary = boundaryOf(plan)
      const startedAt = plan.stateChangedAt || now()
      if (!boundary.ready) {
        if (now() - startedAt > parkTimeoutMs) {
          return { ok: false, pending: false, detail: `the target did not reach a boundary within ${formatDuration(parkTimeoutMs)} (${boundary.detail})`, reason: boundary.detail }
        }
        return { ok: true, pending: true, detail: `${plan.detail || 'park requested'}; ${boundary.detail}` }
      }
      return { ok: true, pending: false, detail: `the target is parked (${boundary.detail})`, boundary }
    }

    // A target that can only be stopped at a boundary it names is not asked before that boundary.
    if (adapter.parkPolicy === 'boundary-first') {
      const boundary = boundaryOf(plan)
      if (!boundary.ready) return { ok: true, pending: true, detail: boundary.detail, boundary }
    }

    let parked = null
    try {
      parked = await adapter.park({ plan, reason: `reboot plan ${plan.id}: ${plan.reason}` })
    } catch (error) {
      return { ok: false, pending: false, detail: `the target could not be parked: ${error && error.message ? error.message : error}` }
    }
    if (!parked || parked.ok === false) {
      return { ok: false, pending: false, detail: `the target refused to park: ${(parked && parked.reason) || 'no reason given'}` }
    }
    // A park that reports `pending` has only been requested; the next tick asks whether it is done.
    if (parked.pending === true || parked.state === 'PAUSING') {
      return { ok: true, pending: true, detail: parked.detail || 'parking: the target is finishing its current stage' }
    }
    return { ok: true, pending: false, detail: parked.detail || 'the target is parked', parked }
  }

  /** Undo a park, for a restart that could not be issued after all. */
  async function unparkFor(plan, detail) {
    const adapter = adapterFor(plan)
    if (!adapter || typeof adapter.resume !== 'function') return { ok: false, resumed: false, reason: 'the target cannot be resumed' }
    try {
      const resumed = await adapter.resume({ planId: plan.id, target: plan.target, reason: 'the restart was not issued', detail })
      return { ok: Boolean(resumed && resumed.ok !== false), resumed: true, detail: (resumed && resumed.detail) || null }
    } catch (error) {
      return { ok: false, resumed: false, reason: String(error && error.message ? error.message : error) }
    }
  }

  /**
   * Issue the restart for one plan.
   *
   * The order is the contract: intent, then relaunch, then the machine. If the relaunch cannot be
   * armed the plan fails *before* `shutdown` is called, because a restart that loses the task is not
   * the restart the user scheduled.
   */
  async function execute(plan, parked) {
    const adapter = adapterFor(plan)
    let intentWritten = false
    if (plan.resumeAfterRestart && adapter) {
      const status = safeStatus(adapter)
      store.setIntent({
        planId: plan.id,
        target: { ...plan.target },
        label: plan.label,
        reason: plan.reason,
        parked: parked ? parked.detail : null,
        targetState: status ? { state: status.state || null, phase: status.phase || null, episode: status.episode || null, taskId: status.task_id || status.taskId || null, request: status.request || null } : null
      })
      intentWritten = true
    }

    const armed = plan.resumeAfterRestart && adapter ? platform.armRelaunch() : { ok: true, skipped: true }
    if (!armed.ok) {
      if (intentWritten) store.clearIntent()
      const detail = `the application could not be set to come back after the restart (${armed.reason || 'the relaunch could not be armed'}), so the restart was not issued`
      store.setState(plan.id, PLAN_STATES.FAILED, detail)
      log(`reboot plan ${plan.id} refused: ${detail}`)
      return { ok: false, planId: plan.id, code: armed.code || 'REBOOT_RELAUNCH_NOT_ARMED', detail, armed, unparked: await unparkFor(plan, detail) }
    }

    const restart = platform.scheduleRestart({ seconds: plan.graceSeconds, reason: plan.reason })
    if (!restart.ok) {
      if (intentWritten) store.clearIntent()
      if (armed.ok && !armed.skipped) platform.disarmRelaunch()
      const detail = `the restart could not be issued: ${restart.reason || 'the shutdown command failed'}`
      store.setState(plan.id, PLAN_STATES.FAILED, detail)
      log(`reboot plan ${plan.id} failed: ${detail}`)
      return { ok: false, planId: plan.id, code: restart.code, detail, armed, restart, unparked: await unparkFor(plan, detail) }
    }

    store.setState(plan.id, PLAN_STATES.EXECUTING, `restart in ${plan.graceSeconds}s${parked && parked.detail ? `; ${parked.detail}` : ''}`)
    log(`reboot plan ${plan.id} issued: ${restart.seconds}s grace, relaunch ${armed.skipped ? 'not needed' : 'armed'}`)
    return {
      ok: true,
      planId: plan.id,
      detail: `restart in ${restart.seconds}s`,
      parked: parked || null,
      armed,
      restart,
      intent: intentWritten ? store.intent() : null
    }
  }

  /**
   * One pass over the plans. Called by the shell's ticker, and again the moment a stage boundary is
   * reported — so a restart released by "the current stage finished" happens then, not a tick later.
   */
  async function tick() {
    const reports = []
    for (const plan of store.list()) {
      if (plan.state === PLAN_STATES.EXECUTING) {
        // The restart has been issued and the machine has not gone down yet: nothing to do but wait,
        // and the user may still abort it.
        reports.push({ ok: true, planId: plan.id, skipped: 'executing' })
        continue
      }
      if (!isDue(plan, now())) continue
      const parked = await parkFor(plan)
      if (parked.pending) {
        store.setState(plan.id, PLAN_STATES.WAITING_BOUNDARY, parked.detail)
        reports.push({ ok: true, planId: plan.id, waiting: parked.detail })
        continue
      }
      if (!parked.ok) {
        store.setState(plan.id, PLAN_STATES.FAILED, parked.detail)
        reports.push({ ok: false, planId: plan.id, code: 'REBOOT_PARK_FAILED', detail: parked.detail })
        continue
      }
      reports.push(await execute(plan, parked))
    }
    return reports
  }

  /**
   * A stage boundary was reported: release any plan that was waiting for this target.
   *
   * This is what makes "park after the current stage completes" prompt: the worker says it finished a
   * stage, and the plan that was held for it runs its next tick immediately.
   */
  async function handleBoundary(event = {}) {
    const kind = String(event.kind || event.target || '')
    const waiting = store.list().filter((plan) => plan.state === PLAN_STATES.WAITING_BOUNDARY && (!kind || (plan.target && plan.target.kind === kind)))
    if (!waiting.length) return { ok: true, acted: false, waiting: 0 }
    const reports = await tick()
    return { ok: true, acted: true, waiting: waiting.length, reports }
  }

  /**
   * The other side of the boundary: the application has come back.
   *
   * Acting on the intent is the whole reason the restart was allowed in the first place, so a resume
   * that fails is reported as a failed plan rather than as a quiet log line.
   */
  async function resumeOnStartup() {
    const intent = store.intent()
    const reports = []
    if (intent) {
      const adapter = intent.target && intent.target.kind === TARGET_KINDS.SUB_WORKER
        ? targets.subWorker || null
        : intent.target && intent.target.kind === TARGET_KINDS.ENGINEERING
          ? targets.engineering || null
          : null
      let resumed = { ok: false, reason: 'the target is not available in this build' }
      if (adapter && typeof adapter.resume === 'function') {
        try {
          resumed = await adapter.resume(intent)
        } catch (error) {
          resumed = { ok: false, reason: String(error && error.message ? error.message : error) }
        }
      }
      const detail = resumed.ok
        ? `the task was continued after the restart (${resumed.detail || 'resumed'})`
        : `the task could not be continued after the restart: ${resumed.reason || 'no reason given'}`
      if (intent.planId) store.complete(intent.planId, { state: resumed.ok ? PLAN_STATES.DONE : PLAN_STATES.FAILED, detail, outcome: resumed.detail || resumed.reason || null })
      store.clearIntent()
      // The relaunch entry has done its job: it must not start the application again next boot.
      platform.disarmRelaunch()
      reports.push({ ok: resumed.ok, planId: intent.planId || null, resumed: resumed.ok, detail })
      log(`reboot resume: ${detail}`)
    }
    // A plan that was executing and has no intent (no target, or the intent was already acted on)
    // is finished: the application is running again, which is the only thing it was waiting for.
    for (const plan of store.list().filter((candidate) => candidate.state === PLAN_STATES.EXECUTING)) {
      store.complete(plan.id, { state: PLAN_STATES.DONE, detail: 'the restart was issued and the application is back; there was nothing to continue' })
      reports.push({ ok: true, planId: plan.id, resumed: false, detail: 'restart completed; nothing to continue' })
    }
    return { ok: true, resumed: reports.some((report) => report.resumed === true), reports, intent }
  }

  /**
   * Cancel a plan, including one whose restart is already scheduled.
   *
   * The requirement is that a plan can be changed or deleted before it runs; a plan that is in its
   * grace period is a plan whose restart has not happened yet, so cancelling it also aborts the
   * shutdown and clears the intent. What it cannot do is un-park a task that has already been
   * parked — so it resumes it, which is the honest equivalent.
   */
  async function cancel(id, options = {}) {
    const plan = store.find(id)
    if (!plan) return { ok: false, code: 'REBOOT_PLAN_NOT_FOUND', reason: `${id} is not scheduled` }
    const wasExecuting = plan.state === PLAN_STATES.EXECUTING
    let aborted = null
    let unparked = null
    if (wasExecuting && options.abortRestart !== false) {
      aborted = platform.cancelRestart()
      if (aborted.ok) {
        store.clearIntent()
        platform.disarmRelaunch()
        unparked = await unparkFor(plan, 'the restart was cancelled by the user')
      }
    }
    const removed = store.remove(id)
    return {
      ok: removed.ok,
      planId: plan.id,
      aborted: aborted ? aborted.ok === true : false,
      abortReason: aborted && aborted.ok !== true ? aborted.reason || 'the restart could not be aborted' : null,
      unparked: unparked ? unparked.ok === true : null,
      reason: removed.ok ? null : removed.reason
    }
  }

  /** Everything the panel and the dashboard draw. */
  function describe() {
    const described = store.describe()
    const statuses = {
      subWorker: safeStatus(targets.subWorker),
      engineering: safeStatus(targets.engineering)
    }
    return {
      ...described,
      platform: platform.describe(),
      relaunchArmed: platform.supported ? platform.relaunchArmed().armed === true : false,
      boundary: {
        subWorker: described.plans.some((plan) => plan.target.kind === TARGET_KINDS.SUB_WORKER) ? boundaryOf({ target: { kind: TARGET_KINDS.SUB_WORKER } }).detail : null,
        engineering: described.plans.some((plan) => plan.target.kind === TARGET_KINDS.ENGINEERING) ? boundaryOf({ target: { kind: TARGET_KINDS.ENGINEERING } }).detail : null
      },
      statuses: {
        subWorker: statuses.subWorker ? { running: statuses.subWorker.running === true, state: statuses.subWorker.state || null, stage: statuses.subWorker.stage || null } : null,
        engineering: statuses.engineering ? { running: statuses.engineering.running === true, phase: statuses.engineering.phase || null, episode: statuses.engineering.episode || null } : null
      },
      /** The dashboard shows the nearest plan and nothing else when there is none. */
      next: described.plans
        .filter((plan) => plan.state !== PLAN_STATES.EXECUTING)
        .sort((left, right) => left.remainingMs - right.remainingMs)[0] || null
    }
  }

  return {
    tick,
    handleBoundary,
    resumeOnStartup,
    cancel,
    describe,
    execute,
    parkFor,
    boundaryOf,
    parkTimeoutMs
  }
}

module.exports = { createRebootCoordinator, PARK_TIMEOUT_MS, PARKABLE_PHASES }