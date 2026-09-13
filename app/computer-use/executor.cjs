'use strict'

/**
 * Computer Use Runtime: the Action Executor (plan §2, §43, §51, §52).
 *
 * This is the one path every computer-use behaviour takes:
 *
 *   OBSERVE -> PLAN -> STABILIZE -> REVALIDATE -> ACT -> GRACE -> VERIFY
 *      ^                                                           |
 *      +---------------- success --------------------------------+
 *                          | failure
 *                          v
 *                  RETRY -> ALTERNATIVE -> REPLAN -> STALL -> FAIL
 *
 * Nothing in this file clicks twice and hopes. Each step is a small state
 * machine of its own, and every branch either produces verified progress, a
 * recovery decision, or a bounded failure with the context it gathered.
 *
 * The loop reads like the plan's diagram on purpose -a reader who knows §2 can
 * follow `runOnce()` line by line.
 */

const { ACTION_TYPES, ACTION_CAPABILITY, CU_STATES, RUN_STATUS, SCREENSHOT_LEVELS, STEP_RESULTS, VERDICTS, TIMING } = require('./constants.cjs')
const { CODES, ComputerUseError } = require('./errors.cjs')
const { createContract, assertCapability, describeContract } = require('./contract.cjs')
const { createStateMachine } = require('./state-machine.cjs')
const { createSafetyGuard } = require('./safety.cjs')
const { createStabilizer } = require('./stabilization.cjs')
const { createVerifier } = require('./verification.cjs')
const { createRecoveryController, alternativeAction, alternativeController, RECOVERY_VERDICTS } = require('./recovery.cjs')
const { createStallDetector, STALL_RECOVERY_LADDER } = require('./stall.cjs')
const { detectMiss } = require('./miss.cjs')
const { routeAction } = require('./routing.cjs')
const { describeAction, requiresTarget, normalizeAction } = require('./action.cjs')
const { describeTarget, revalidate, centerOf } = require('./target.cjs')
const { evaluateCriteria } = require('./criteria.cjs')
const { meaningfulChange, summarizeWorldState, discardWorldState } = require('./world-state.cjs')
// Long-running execution (Update-Plan/24h.md): each of these owns one concern the
// executor used to carry inline, so this file stays orchestration + state
// transitions + controller selection (Task 15).
const { createFocusTrust, FOCUS_INVALIDATION } = require('./focus.cjs')
const { planModal, MODAL_ACTION } = require('./modal.cjs')
const { createProgressTracker, PROGRESS_KINDS } = require('./progress.cjs')
const { assess: assessEvidence } = require('./evidence.cjs')
const { createProcessRegistry } = require('./processes.cjs')
const { createResourceBudget } = require('./resources.cjs')
const { buildHealthSnapshot, HEALTH_STATUS, capabilityVerdict, capabilityIsUsable } = require('./health.cjs')
const { createMutationVerifier } = require('./mutation.cjs')
const { createReconnectPolicy, isTransportFailure } = require('./reconnect.cjs')
// The workspace boundary and the bounded command contract: the executor checks
// both at the run level, so a drifted workspace or an unbounded command is
// refused before the hands move (Tasks 11/13, plan §13/§15).
const { createWorkspaceGuard } = require('./workspace.cjs')
const { normalizeCommand, invalidError: commandInvalidError } = require('./command.cjs')

const DEFAULT_PLANNER = { next: () => null }

/** A planner may be an object with `next()` or a bare function. */
function normalizePlanner(candidate) {
  if (!candidate) return DEFAULT_PLANNER
  if (typeof candidate === 'function') return { next: candidate }
  if (typeof candidate.next === 'function') return candidate
  return DEFAULT_PLANNER
}

/**
 * The controller a capability is carried by, used as the *channel* hint for a
 * bounded reconnect (24h.md Task 10). The channel names the controller on
 * purpose: the reconnect budget is spent per channel, and the thing that has to
 * come back is the controller itself.
 */
const CAPABILITY_CONTROLLER = Object.freeze({
  browser: 'browser',
  desktop: 'desktop',
  vision: 'vision',
  shell: 'shell',
  filesystem: 'file',
  file: 'file'
})

/**
 * The workspace guard, from whatever shape the host handed over (Task 11): the
 * runtime's shared guard, a bare workspace path, or a getter around either. With
 * nothing to guard the executor's workspace gate is inert and the controllers
 * keep enforcing their own boundary.
 */
function resolveWorkspaceGuard(options, clock) {
  const provided = options.workspaceGuard || options.workspace || null
  if (!provided) return null
  let source = provided
  if (typeof provided === 'function') {
    try {
      source = provided()
    } catch {
      return null
    }
  }
  if (!source) return null
  if (typeof source.resolvePath === 'function' && typeof source.verify === 'function') return source
  return createWorkspaceGuard({ now: clock.now, workspace: String(source), allowOutside: options.allowOutsideWorkspace === true })
}

function createExecutor(options = {}) {
  const clock = options.clock || { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }
  const log = options.log || null
  const observer = options.observer
  const controllers = options.controllers || {}
  const runtimeOptions = options.options || {}
  const planner = normalizePlanner(options.planner)
  if (!observer) throw new ComputerUseError(CODES.CONTROLLER_UNAVAILABLE, 'the executor needs an observer')

  const stabilizer = options.stabilizer || createStabilizer({ clock, limits: runtimeOptions.timing, thresholds: runtimeOptions.targetMovement })
  const verifier = options.verifier || createVerifier({ clock })
  // The runtime owns every process it starts, which is what makes "dispose only
  // what we own" enforceable (24h.md Task 7). It may hand the shared registry over
  // under either name, so the executor reports on the very processes the shell
  // controller starts.
  const processes = options.processes || options.processRegistry || createProcessRegistry({ now: clock.now, maxOwned: runtimeOptions.maxOwnedProcesses })
  // Resource ceilings: screenshots, evidence bytes and per-step history
  // (24h.md Task 8). The shared budget wins when the runtime passes one, so a
  // capture taken here is counted by the same ceiling the health reader reports.
  const resources = options.resources || options.resourceBudget || createResourceBudget({ now: clock.now, maxScreenshots: runtimeOptions.maxScreenshots })
  // Bounded reconnection for a channel that loses its transport (Task 10).
  const reconnect = options.reconnect || createReconnectPolicy({ now: clock.now, sleep: clock.sleep, maxAttempts: runtimeOptions.maxReconnects })
  // Filesystem mutation evidence, and the resume-safe re-observation (Task 12/14).
  const mutations = options.mutations || createMutationVerifier({ now: clock.now })
  // The workspace boundary this executor checks itself (Task 11).
  const workspaceGuard = resolveWorkspaceGuard(options, clock)

  let availability = null
  let running = false
  let cancelled = false
  let currentRun = null

  /** One probe per controller per run, cached (plan §37 degradation). */
  function probeControllers(force = false) {
    if (availability && !force) return availability
    const entry = (controller) => {
      if (!controller || typeof controller.probe !== 'function') return { available: false, reason: 'controller is not attached' }
      try {
        const verdict = controller.probe()
        return { available: verdict.available !== false, reason: verdict.reason || null, detail: verdict.detail || null }
      } catch (error) {
        return { available: false, reason: error && error.message ? error.message : String(error) }
      }
    }
    availability = {
      browser: entry(controllers.browser),
      desktop: entry(controllers.desktop),
      accessibility: controllers.desktop && typeof controllers.desktop.accessibilityProbe === 'function'
        ? controllers.desktop.accessibilityProbe()
        : { available: false, reason: 'no desktop controller' },
      vision: entry(controllers.vision),
      shell: entry(controllers.shell),
      file: entry(controllers.file)
    }
    return availability
  }

  /** The channel a failure belongs to, when the error names one (Task 10). */
  function channelOfError(error, fallback = null) {
    const details = error && error.details ? error.details : {}
    const named = details.channel || details.controller || null
    return named ? String(named) : fallback
  }

  /**
   * The controller an action is expected to use, as a reconnect channel hint.
   *
   * A hint is only a hint: an error that names its own channel wins (Task 10),
   * and a failure nobody can attribute to a channel is never guessed at.
   */
  function channelHintFor(action, run) {
    if (run && run.lastRoute && run.lastRoute.controller) return String(run.lastRoute.controller)
    const capability = action && action.capability ? String(action.capability) : null
    return capability ? CAPABILITY_CONTROLLER[capability] || null : null
  }

  /**
   * Task 10: re-attach one channel.
   *
   * The executor owns no attach seam of its own - the page is attached by the
   * runtime host (`index.cjs`'s `syncPage`) and this layer is handed live
   * controllers - so "reattach" means: ask the controller whether it is back
   * (`probe()`) and read its facts surface. The fresh observation that proves the
   * channel is usable comes from the reconnect policy's own `observe` callback.
   * That is the strongest confirmation available here, and it is deliberately not
   * a guess about what the channel looked like before it broke.
   */
  function reattachChannel(channel) {
    return async ({ attempt }) => {
      const controller = controllers[channel] || null
      if (!controller) return { ok: false, reason: `no controller implements the ${channel} channel` }
      if (typeof controller.probe === 'function') {
        const verdict = await Promise.resolve(controller.probe())
        if (verdict && verdict.available === false) return { ok: false, reason: verdict.reason || `${channel} is still unavailable` }
      }
      if (typeof controller.facts === 'function') await Promise.resolve(controller.facts())
      writeLog('event', { type: 'channel-reattach', channel, attempt })
      return { ok: true }
    }
  }

  /**
   * Task 10: rebuild a channel whose transport died, bounded by the reconnect
   * policy's per-step budget. On success the caller continues from the fresh
   * observation the reconnect took - never from the state (or the target) that
   * was resolved before the failure.
   *
   * @returns {Promise<{ok:boolean, outcome:object, world:object|null, error:Error|null}>}
   */
  async function recoverChannel(channel, run, action) {
    const name = String(channel || 'unknown')
    const outcome = await reconnect.reconnect({
      channel: name,
      reattach: reattachChannel(name),
      // The contract is the only authority on whether the run may continue, so
      // the reconnect asks it instead of assuming the run is still valid.
      stillValid: () => !cancelled && clock.now() - run.startedAt <= run.contract.limits.runTimeoutMs,
      observe: async () => {
        const world = await observer.observe(observeOptions(run, action))
        run.world = world
        return world
      }
    })
    writeLog('event', { type: 'reconnect', channel: name, outcome: outcome.outcome, attempt: outcome.attempt, reason: outcome.reason })
    if (outcome.outcome !== reconnect.RECONNECT.RECONNECTED) {
      // EXHAUSTED and CONTEXT_INVALID are the same verdict for the step: the
      // channel is not usable, so the step fails with that code rather than a
      // generic controller error.
      return { ok: false, outcome, world: null, error: reconnect.exhaustedError(outcome) }
    }
    // A stale target is never reused, and the availability cache has to hear that
    // the channel came back (Task 9).
    run.lastResolution = null
    probeControllers(true)
    return { ok: true, outcome, world: run.world, error: null }
  }

  /**
   * Task 10: the OBSERVE half of the transport wiring.
   *
   * The observer degrades a dead source inside its own fault boundary, so a throw
   * that reaches here is a transport failure that escaped that boundary:
   * re-observe through a reconnected channel instead of failing the step. A
   * non-transport error - or one nobody can attribute to a channel - is rethrown
   * untouched.
   */
  async function observeWorld(run, action, channel = null) {
    try {
      return await observer.observe(observeOptions(run, action))
    } catch (error) {
      const name = channelOfError(error, channel || channelHintFor(action, run))
      if (!isTransportFailure(error) || !name) throw error
      const recovered = await recoverChannel(name, run, action)
      if (!recovered.ok) throw recovered.error
      return recovered.world
    }
  }

  async function withTimeout(promise, ms, label) {
    if (!Number.isFinite(ms) || ms <= 0) return promise
    let timer = null
    try {
      return await Promise.race([
        promise,
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new ComputerUseError(CODES.ACTION_TIMEOUT, `${label} exceeded its ${ms}ms budget`, { label, timeoutMs: ms }))
          }, ms)
        })
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /** Builds resolver functions for the target ladder from the live controllers. */
  function buildResolvers(world) {
    return {
      selector: async (selector) => (controllers.browser ? controllers.browser.facts().domQuery(selector) : null),
      accessibility: async (query) => (controllers.desktop ? controllers.desktop.locate({ accessibility: query }).then((hit) => (hit ? [hit.element || hit] : [])) : null),
      semantic: async (semantic) => {
        if (controllers.browser && controllers.browser.probe().available !== false) {
          const hits = await controllers.browser.facts().domQuery('body')
          void hits
        }
        return null
      },
      bbox: async (bbox) => {
        if (!controllers.desktop) return null
        return null
      }
    }
  }

  /**
   * Resolves a target through the live controllers, recording every rung tried.
   * The result is stored on the run so timing decisions can revalidate it.
   */
  async function resolveActionTarget(action, run) {
    const world = run ? run.world : null
    if (!requiresTarget(action) || !action.target) {
      return { resolved: action.params.point ? { kind: 'point', point: action.params.point, source: 'explicit', coordinateFallback: true } : null, attempts: [] }
    }
    const attempts = []
    if (action.target.ref && controllers.desktop) {
      const hit = await controllers.desktop.locate(action.target)
      attempts.push({ kind: 'accessibility', ok: Boolean(hit) })
      if (hit) return { resolved: hit, attempts }
    }
    if (action.target.selector && controllers.browser) {
      const hit = await controllers.browser.locate(action.target)
      attempts.push({ kind: 'selector', ok: Boolean(hit) })
      if (hit) return { resolved: hit, attempts }
    }
    if (controllers.desktop && wantsDesktopLookup(action)) {
      const hit = await controllers.desktop.locate(action.target)
      attempts.push({ kind: 'accessibility', ok: Boolean(hit) })
      if (hit) return { resolved: hit, attempts }
    }
    if (controllers.browser) {
      const hit = await controllers.browser.locate(action.target)
      attempts.push({ kind: 'semantic', ok: Boolean(hit) })
      if (hit) return { resolved: hit, attempts }
    }
    if (action.target.bbox) return { resolved: { kind: 'bbox', bbox: action.target.bbox, point: centerOf(action.target.bbox), source: 'target', coordinateFallback: true }, attempts }
    // Plan §4/§48: a visual target is the last structured-independent rung -a
    // canvas or a custom-drawn control has no DOM node and no accessibility
    // node, so the runtime looks at the pixels and clicks what it found.
    if (action.target.visual) {
      const visual = await resolveVisualTarget(action.target.visual, run)
      attempts.push({ kind: 'visual', ok: Boolean(visual) })
      if (visual) return { resolved: visual, attempts }
    }
    if (action.target.point || action.params.point) {
      const point = action.target.point || action.params.point
      return { resolved: { kind: 'point', point, bbox: null, source: action.target.point ? 'target' : 'params', coordinateFallback: true, disabled: null, visible: null }, attempts }
    }
    return { resolved: null, attempts }
  }

  /**
   * A desktop lookup answers "which accessibility node / window is this?".
   * It is only meaningful when the target names an automation identifier or the
   * action is *about* a window; for a visual or coordinate target the window is
   * context, and resolving it to the window itself would click the middle of a
   * window instead of the thing the caller described.
   */
  function wantsDesktopLookup(action) {
    const target = action.target || {}
    if (target.accessibility || target.semantic || target.ref) return true
    const windowAction = [ACTION_TYPES.FOCUS, ACTION_TYPES.SWITCH_WINDOW, ACTION_TYPES.CLOSE_WINDOW].includes(action.type)
    return Boolean(windowAction && target.window)
  }

  /**
   * Captures at the level the caller asked for and locates the painted or
   * templated target inside it. The returned rectangle is in screen
   * coordinates, so the click that follows is a real coordinate click whose
   * position was observed rather than assumed.
   */
  async function resolveVisualTarget(visual, run) {
    if (!controllers.vision || !controllers.vision.capture) return null
    try {
      // A target inside a page is looked for in the page's *own* pixels: a
      // viewport capture is exact, while a window capture has to be aligned to
      // the browser chrome. The hit is then translated to screen coordinates
      // using the page's screen origin.
      const page = controllers.browser && controllers.browser.page
      if (page && typeof page.screenshot === 'function' && typeof page.pageOrigin === 'function') {
        const shot = await page.screenshot()
        const origin = await page.pageOrigin()
        if (shot && shot.png && origin) {
          // Three coordinate spaces meet here: the screenshot is in *device*
          // pixels, the page reports CSS pixels, and the desktop driver clicks
          // in physical screen pixels. Both conversions are explicit.
          const decoded = controllers.vision.decode({ png: shot.png })
          const imageScale = origin.viewport && origin.viewport.width ? decoded.width / origin.viewport.width : 1
          const dpr = Number(origin.devicePixelRatio) || 1
          const capture = {
            png: shot.png,
            level: SCREENSHOT_LEVELS.WINDOW,
            levelName: 'page-viewport',
            // The capture origin is (0,0) on purpose: the hit is wanted in
            // *image* coordinates so the mapping below can do all three
            // conversions itself, exactly once.
            rect: { x: 0, y: 0, width: origin.viewport.width, height: origin.viewport.height },
            backend: 'page',
            at: clock.now(),
            reason: 'visual-target'
          }
          // Task 8: an evidence capture is accounted for even when it is only
          // used to resolve a target - the ceiling has to cover every capture a
          // long run takes, not only the ones that are logged.
          budgetCapture(run, capture, capture.level, 'visual-target')
          const located = await controllers.vision.locateVisual({ visual }, { capture })
          if (located && located.ok) {
            const cssRect = {
              x: located.rect.x / imageScale,
              y: located.rect.y / imageScale,
              width: located.rect.width / imageScale,
              height: located.rect.height / imageScale
            }
            const physical = {
              x: Math.round((origin.x + cssRect.x + cssRect.width / 2) * dpr),
              y: Math.round((origin.y + cssRect.y + cssRect.height / 2) * dpr)
            }
            return {
              kind: 'visual',
              ref: null,
              bbox: {
                x: Math.round((origin.x + cssRect.x) * dpr),
                y: Math.round((origin.y + cssRect.y) * dpr),
                width: Math.round(cssRect.width * dpr),
                height: Math.round(cssRect.height * dpr)
              },
              point: physical,
              score: located.score,
              strategy: `${located.strategy}/page`,
              source: 'vision',
              coordinateFallback: true,
              disabled: null,
              visible: true
            }
          }
        }
      }
      const level = Number.isInteger(visual.level)
        ? visual.level
        : (controllers.desktop && controllers.desktop.driver ? SCREENSHOT_LEVELS.WINDOW : SCREENSHOT_LEVELS.FULL)
      const capture = await controllers.vision.capture(level, {
        windowHandle: run && run.world && run.world.foreground ? run.world.foreground.handle : null,
        reason: 'visual-target',
        allowFullScreen: run ? run.contract.vision.allowFullScreenFallback : true
      })
      budgetCapture(run, capture, level, 'visual-target')
      const located = await controllers.vision.locateVisual({ visual }, { capture })
      if (!located || !located.ok) {
        writeLog('event', { type: 'visual-miss', reason: located ? located.reason : 'the vision controller returned nothing', level })
        return null
      }
      return {
        kind: 'visual',
        ref: null,
        bbox: located.rect,
        point: located.point,
        score: located.score,
        strategy: located.strategy,
        source: 'vision',
        coordinateFallback: true,
        disabled: null,
        visible: true
      }
    } catch (error) {
      writeLog('event', { type: 'visual-error', reason: error && error.message ? error.message : String(error) })
      return null
    }
  }

  function controllerFor(route) {
    switch (route.controller) {
      case 'browser': return controllers.browser
      case 'desktop': return controllers.desktop
      case 'shell': return controllers.shell
      case 'file': return controllers.file
      case 'vision': return controllers.vision
      default: return null
    }
  }

  /**
   * Phase 1 acceptance (plan §43): a single action, executed through exactly the
   * same machinery as a full run -stabilization, revalidation, safety gates,
   * routing, verification and the recovery ladder. "One action" is modelled as a
   * one-step contract so there is no second execution path that could drift away
   * from the run loop.
   */
  async function executeAction(actionInput, context = {}) {
    const action = normalizeAction(actionInput)
    const contract = context.contract || createContract({
      goal: context.goal || `execute ${action.type}`,
      plan: [{ id: action.id || 'action', action: actionInput }],
      allowed_capabilities: context.allowedCapabilities,
      safety: context.safety,
      limits: context.limits,
      autonomy_enabled: false
    }, runtimeOptions)
    const report = await run(contract, { autonomous: false })
    const last = report.outcomes[report.outcomes.length - 1] || null
    return {
      status: report.status === RUN_STATUS.COMPLETED ? 'success' : last && last.verification === 'unknown' ? 'unknown' : 'failed',
      action: action.type,
      steps: report.steps,
      verification: last ? last.verification : null,
      error: report.error,
      outcome: last,
      report
    }
  }

  /**
   * Plan §3.1: perception is asked for the cheapest source that can answer the
   * question. The desktop accessibility walk crosses process boundaries and is
   * the most expensive observation the runtime can make, so it is read only
   * when the step genuinely needs it:
   *
   *   - an accessibility action (invoke / set value) needs the tree,
   *   - a recovery that asked for a full re-observe gets it,
   *   - a desktop-only task gets one read per run (so the first world state has
   *     the focused control), and the cheap window list covers dialogs.
   *
   * Everything else — settling, waiting for an effect, verifying a click — is
   * answered from the page, the window list and the filesystem.
   */
  function observeOptions(run, action) {
    run.observations = (run.observations || 0) + 1
    const accessibilityAction = Boolean(action) && (action.type === ACTION_TYPES.ACCESSIBILITY_INVOKE || action.type === ACTION_TYPES.ACCESSIBILITY_SET_VALUE)
    const hasPage = Boolean(controllers.browser && controllers.browser.page)
    let ax = false
    if (accessibilityAction) ax = true
    else if (run.wantAx === true) ax = true
    else if (!hasPage && run.axRead !== true) ax = true
    if (ax) run.axRead = true
    return { taskId: run.contract ? run.contract.id : run.id, lastAction: run.lastAction || null, ax }
  }

  /**
   * A bounded summary of one observation (Update-Plan/24h.md Task 3).
   *
   * This is deliberately a summary, not the world state itself: the stabilizer
   * only compares the fields below, and keeping a whole previous world alive
   * would be exactly the unbounded observation history Task 8 forbids.
   */
  function summarizeObservation(world) {
    if (!world) return null
    return {
      revision: world.revision,
      axSignature: world.axSignature,
      windowSignature: world.windowSignature,
      dialogSignature: world.dialogSignature,
      signature: world.signature,
      loading: world.loading,
      readyState: world.readyState,
      // The focused/foreground window *ref*: the one identity a window change has
      // that a signature does not ("the same window list, a different one in
      // front").
      windowRef: world.foreground ? String(world.foreground.handle) : null
    }
  }

  /**
   * Update-Plan/24h.md Task 3: the signals this run already knows, in the
   * stabilizer's own vocabulary, computed *before* the settle window so the first
   * cooldown step reflects them instead of rediscovering them.
   *
   * Everything here comes from this run's own observations: the miss the previous
   * step produced, the transition between the last two observations, the window
   * that is in front now, and the dialogs the current world reports.
   */
  function stabilizationSignals(action, run, priorObservation) {
    // `detectSignals` answers "why is the UI changing" from the run's two most
    // recent observations; `signalInputs` turns that set into the cooldown input
    // the stabilizer consumes.
    const detected = stabilizer.detectSignals(priorObservation, run.world, { miss: run.lastMiss })
    const signals = stabilizer.signalInputs(detected)
    // A miss only counts for the *same* action: a miss from an unrelated step is
    // not evidence that this target is about to move.
    signals.previousMiss = signals.previousMiss && sameActionMiss(run.lastMiss, action)
    // The window ref is the change the signature comparison cannot see.
    signals.windowChanged = signals.windowChanged || Boolean(priorObservation
      && priorObservation.windowRef
      && run.world
      && run.world.foreground
      && priorObservation.windowRef !== String(run.world.foreground.handle))
    // A dialog in the current world is the one signal the run can read directly.
    signals.modalAppeared = signals.modalAppeared || Boolean(run.world && Array.isArray(run.world.dialogs) && run.world.dialogs.length)
    return signals
  }

  function sameActionMiss(miss, action) {
    return Boolean(miss && miss.missed === true && action && miss.actionType === action.type)
  }

  /** Plan §30/§31/§33/§34: every gate that must pass before the hands move. */
  async function runGates(action, world, context) {
    const { contract, safety, run } = context
    // Waiting is a runtime primitive, not a machine capability: it borrows the
    // channel of whatever it is waiting on, so a contract that allows only
    // `browser` may still wait for the page to settle (plan §12).
    const waits = action.type === ACTION_TYPES.WAIT_EVENT || action.type === ACTION_TYPES.WAIT_STATE
    if (!waits) assertCapability(contract, action.capability || 'desktop', { action: action.type })
    // Task 11/13: the workspace boundary and the bounded command contract are
    // checked before any other gate, because "where would this even run" is a
    // question that has to be answered before "may it run".
    const workspace = workspaceGate(action, run)
    if (workspace.blocked) {
      return { blocked: true, code: workspace.error.code, reason: workspace.error.message, error: workspace.error, action }
    }
    if (!safety || action.capability === 'filesystem') {
      // The filesystem and shell controllers enforce their own boundaries, but
      // the destructive gate still applies to a delete.
      if (safety) await safety.assertActionAllowed(action, { contract })
      return { blocked: false }
    }
    // Plan §30: a blocking modal pauses the original action. The dismissal step
    // itself is exempt -otherwise every attempt to answer the dialog would be
    // blocked by the dialog it is answering.
    const modalDismiss = Boolean(action.params && action.params.__modalDismiss)
    const modal = safety.inspectModals(world)
    if (!modalDismiss && modal.blocking && action.type !== ACTION_TYPES.ACCESSIBILITY_INVOKE) {
      writeLog('event', {
        type: 'modal-blocking',
        modals: modal.modals.map((entry) => `${entry.source || '?'}:${entry.type}:${entry.message}`),
        pausedAction: action.type
      })
      return {
        blocked: true,
        reason: 'a blocking dialog is open',
        code: CODES.MODAL_BLOCKING,
        modal,
        action
      }
    }
    await safety.assertActionAllowed(action, { contract })
    return { blocked: false }
  }

  /**
   * Update-Plan/24h.md Task 11/13: the run-level check a shell or filesystem
   * action passes before the hands move.
   *
   * The controllers enforce the same boundary at their own edge; this is the
   * *block* the run needs, so a workspace that drifted mid-run (or a shell action
   * with no bounded command contract) stops the step instead of quietly running
   * somewhere else. With no workspace handed to the executor the boundary check is
   * inert, and the command contract is still normalized.
   */
  function workspaceGate(action, run) {
    const params = action.params || {}
    if (action.capability === 'shell') {
      // Task 13/plan §15: an unbounded command is refused *before* it runs, which
      // is the only point at which refusing it is cheap.
      const normalized = normalizeCommand(params, {
        cwd: params.cwd || verifiedWorkspaceCwd(),
        defaultTimeoutMs: action.timeoutMs
      })
      if (!normalized.ok) return { blocked: true, error: commandInvalidError(normalized.issues) }
    }
    if (!workspaceGuard) return { blocked: false }
    if (action.capability !== 'shell' && action.capability !== 'filesystem') return { blocked: false }
    const verdict = action.capability === 'shell'
      ? workspaceGuard.resolveCwd({ cwd: params.cwd, step: run.steps })
      : workspaceGuard.resolvePath(params.path, { step: run.steps })
    if (verdict.ok) return { blocked: false }
    // "The caller named a directory outside the boundary" is a different failure
    // from "there is no workspace to work in": the first is a mismatch, the
    // second is a block (Task 20).
    const details = { action: action.type, step: run.steps }
    const error = verdict.source === 'explicit'
      ? workspaceGuard.mismatchError(verdict, details)
      : workspaceGuard.unavailableError(verdict, details)
    writeLog('event', { type: 'workspace-blocked', step: run.steps, action: action.type, reason: verdict.reason })
    return { blocked: true, error }
  }

  /** The verified workspace directory, or null when there is none to inherit. */
  function verifiedWorkspaceCwd() {
    if (!workspaceGuard) return null
    const verdict = workspaceGuard.verify()
    return verdict.ok ? verdict.cwd : null
  }

  /**
   * The body of ACTING: route, execute, and report a receipt. The caller has
   * already stabilized and revalidated.
   */
  async function performAction(action, world, context) {
    const { contract, attempt, run } = context
    const route = routeAction(action, {
      contract,
      world,
      availability: probeControllers(),
      resolved: context.resolved || null,
      pageReady: Boolean(controllers.browser && controllers.browser.page),
      allowVision: context.allowVision === true
    })
    if (!route.ok) {
      return { status: 'failed', error: route.error, route, action, receipt: null }
    }
    const controller = controllerFor(route)
    if (!controller) {
      return {
        status: 'failed',
        route,
        action,
        receipt: null,
        error: new ComputerUseError(CODES.CONTROLLER_UNAVAILABLE, `no controller implements the ${route.channel} channel`, { channel: route.channel })
      }
    }
    // Task 9: a capability that is *degraded* right now is reported for this
    // action — `CAPABILITY_UNAVAILABLE` — instead of being discovered as a
    // generic controller crash halfway through the action. The rest of the
    // runtime keeps working; only the action that needs this channel stops.
    const probed = probeControllers()
    if (!capabilityIsUsable(probed, route.controller)) {
      const entry = probed[route.controller] || null
      const capability = ACTION_CAPABILITY[action.type] || route.controller
      return {
        status: 'failed',
        route,
        action,
        receipt: null,
        controller: route.controller,
        capabilityUnavailable: true,
        error: new ComputerUseError(
          CODES.CAPABILITY_UNAVAILABLE,
          `${route.channel} is not usable right now${entry && entry.reason ? `: ${entry.reason}` : ''}`,
          { channel: route.channel, capability, controllerId: route.controller, action: action.type }
        )
      }
    }
    try {
      // Task 12: the destination's mtime *before* the action is what lets the
      // write verifier tell "this write landed" from "the file was already
      // there". It is read here, before the hands move.
      const beforeMtime = mutations.MUTATION_TYPES.includes(action.type)
        ? mutations.mtime(action.params ? action.params.path : null)
        : null
      const receipt = await withTimeout(
        Promise.resolve(controller.perform(action, { contract, world, resolved: context.resolved, attempt, channel: route.channel })),
        action.timeoutMs || contract.limits.stepTimeoutMs,
        `${action.type} via ${route.channel}`
      )
      return { status: receipt && receipt.ok === false ? 'failed' : 'acted', route, action, receipt, controller: route.controller, beforeMtime }
    } catch (error) {
      // Task 10: a transport failure is not "the action failed" - it is a channel
      // that has to be rebuilt before anything else happens. The step continues
      // from a fresh observation instead of the target this attempt resolved.
      if (isTransportFailure(error) && run) {
        writeLog('event', {
          type: 'transport-failure',
          step: run.steps + 1,
          action: action.type,
          channel: route.controller || route.channel,
          code: error && error.code ? error.code : null,
          message: error && error.message ? error.message : String(error)
        })
        const recovered = await recoverChannel(route.controller || route.channel, run, action)
        if (!recovered.ok) return { status: 'failed', route, action, receipt: null, controller: route.controller, error: recovered.error }
        return { status: 'reconnect', route, action, receipt: null, controller: route.controller, error: null, world: recovered.world }
      }
      return { status: 'failed', route, action, receipt: null, controller: route.controller, error }
    }
  }

  /**
   * One full iteration: stabilize, revalidate, act, grace, verify.
   * Returns a structured outcome; the run loop decides what happens next.
   */
  async function executeStep(action, run) {
    try {
      return await executeStepInner(action, run)
    } catch (error) {
      // Plan §37: a controller that throws, a safety gate that refuses or a
      // stabilizer that fails is one *step* failure -it may not take the run
      // loop down with it.
      const typed = error && error.code
        ? error
        : new ComputerUseError(CODES.CONTROLLER_FAILED, error && error.message ? error.message : String(error), { action: action.type })
      writeLog('event', {
        type: 'step-failed',
        step: run.steps + 1,
        action: action.type,
        code: typed.code,
        message: typed.message
      })
      return { status: 'failed', error: typed, world: run.world, fatal: typed.retryable === false }
    }
  }

  async function executeStepInner(action, run) {
    const contract = run.contract
    const safety = run.safety
    const stepNumber = run.steps + 1
    const stateMachine = run.stateMachine
    const startedAt = clock.now()

    stateMachine.transition(CU_STATES.PLANNING_ACTION, { step: stepNumber, action: action.type, reason: 'planner produced an action' })
    const before = run.world

    // ---- STABILIZING (plan §9/§10/§13) -------------------------------------
    stateMachine.transition(CU_STATES.STABILIZING, { step: stepNumber })
    let resolved = null
    // Task 3: the observation the previous step ended on is the baseline every
    // carried stabilization signal is measured against, so it is taken before the
    // settle window opens - and replaced with this step's own entry observation
    // for the step after it.
    const priorObservation = run.lastObservation
    run.lastObservation = summarizeObservation(run.world)
    const attemptResolve = async () => {
      try {
        const result = await resolveActionTarget(action, run)
        run.resolveAttempts = result.attempts
        return result.resolved
      } catch (error) {
        // Task 10: a resolution that dies with its channel's transport is redone
        // through a reconnected one; a resolution from before the failure is never
        // reused (the reconnect clears `run.lastResolution`).
        if (!isTransportFailure(error)) throw error
        const recovered = await recoverChannel(channelHintFor(action, run), run, action)
        if (!recovered.ok) throw recovered.error
        const result = await resolveActionTarget(action, run)
        run.resolveAttempts = result.attempts
        return result.resolved
      }
    }
    if (requiresTarget(action) && action.target) {
      // Plan §10, step 1: the target is detected *now*, and that resolution is
      // the baseline the post-settle resolution is compared against.
      const detected = await attemptResolve()
      const settleOutcome = await stabilizer.settle({
        action,
        previous: detected,
        world: run.world,
        // Update-Plan/24h.md Task 3: the signals this run already knows travel
        // into the settle window with the observation, so the cooldown reflects
        // them from its first step.
        signals: stabilizationSignals(action, run, priorObservation),
        observe: () => observeWorld(run, action),
        locateTarget: attemptResolve
      })
      run.stabilizationMs = settleOutcome.waitedMs
      run.world = settleOutcome.world || run.world
      run.revalidation = settleOutcome.revalidation
      resolved = settleOutcome.resolved

      if (settleOutcome.verdict === 'reobserve') {
        // The target moved while settling: rebuild the picture and resolve once
        // more instead of acting on a coordinate we already know is wrong.
        run.world = await observeWorld(run, action)
        resolved = await attemptResolve()
        run.revalidated = true
        if (!resolved) {
          return {
            status: 'failed',
            error: new ComputerUseError(CODES.TARGET_STALE, settleOutcome.reason || 'the target moved and could not be re-resolved', {
              movement: settleOutcome.revalidation ? settleOutcome.revalidation.movement : null,
              step: stepNumber
            }),
            world: run.world,
            stabilizationMs: run.stabilizationMs
          }
        }
      } else if (settleOutcome.verdict === 'wait_state') {
        // Plan §24: past the cooldown ceiling the runtime stops adding delay and
        // waits for the UI to go quiet, with a bounded timeout.
        const quiet = await waitForQuiet(action, run)
        if (!quiet.ok) {
          return {
            status: 'failed',
            error: new ComputerUseError(CODES.UI_UNSTABLE, settleOutcome.reason || 'the UI never settled before the deadline', {
              step: stepNumber,
              waitedMs: settleOutcome.waitedMs,
              attempts: settleOutcome.attempts,
              reasons: settleOutcome.signals ? settleOutcome.signals.reasons : []
            }),
            world: run.world,
            stabilizationMs: settleOutcome.waitedMs
          }
        }
        resolved = await attemptResolve()
      }

      run.lastResolution = resolved
      if (!resolved) {
        return {
          status: 'failed',
          error: new ComputerUseError(CODES.TARGET_NOT_FOUND, `the target could not be resolved: ${describeTarget(action.target)}`, {
            step: stepNumber,
            target: describeTarget(action.target)
          }),
          world: run.world,
          stabilizationMs: run.stabilizationMs
        }
      }
    }

    // ---- REVALIDATING (plan §10) -------------------------------------------
    stateMachine.transition(CU_STATES.REVALIDATING, { step: stepNumber })

    // ---- Safety gates (plan §30/§31/§33/§34) --------------------------------
    const gate = await runGates(action, run.world, { contract, safety, run })
    if (gate.blocked) {
      if (gate.code === CODES.MODAL_BLOCKING) {
        return handleModal(gate, action, run, stepNumber)
      }
      return {
        status: 'failed',
        error: gate.error || new ComputerUseError(gate.code || CODES.SAFETY_REFUSED, gate.reason || 'a safety gate refused the action'),
        world: run.world
      }
    }
    if (requiresTarget(action) && action.target) {
      if (action.capability === 'desktop' && (action.type === ACTION_TYPES.TYPE || action.type === ACTION_TYPES.KEY_PRESS || action.type === ACTION_TYPES.HOTKEY)) {
        // Update-Plan/24h.md Task 1: only a *verified* focus authorizes typing.
        // The attempt itself is recorded for the log and authorizes nothing.
        run.focus.attempt(focusRefOf(action), { action: action.type, step: stepNumber })
        const focusDecision = safety.checkFocus(action, run.world, { contract, verifiedFocusRef: run.focus.verifiedFocusRef })
        if (!focusDecision.allowed) {
          // Focus safety (plan §31): establish focus first instead of refusing
          // the whole step -but only when there is something to focus.
          const focusAction = buildFocusAction(action)
          if (focusAction) {
            const focusOutcome = await executeStep(focusAction, run)
            if (focusOutcome.status !== 'success') return focusOutcome
            // The FOCUS step verified, so the trust is now established; if it did
            // not verify, `run.focus` already cleared the reference and the gate
            // below refuses rather than typing blind.
            const recheck = safety.checkFocus(action, run.world, { contract, verifiedFocusRef: run.focus.verifiedFocusRef })
            if (!recheck.allowed) {
              return { status: 'failed', error: new ComputerUseError(CODES.FOCUS_MISMATCH, recheck.reason, { focus: run.focus.snapshot() }), world: run.world }
            }
          } else {
            return { status: 'failed', error: new ComputerUseError(CODES.FOCUS_MISMATCH, focusDecision.reason), world: run.world }
          }
        }
      }
      if (action.capability === 'desktop' && ['CLICK', 'DOUBLE_CLICK', 'RIGHT_CLICK', 'DRAG', 'SCROLL'].includes(action.type)) {
        const windowDecision = safety.checkWindow(action, run.world, resolved && resolved.windowHandle ? { handle: resolved.windowHandle } : null)
        if (!windowDecision.allowed && windowDecision.checked) {
          return {
            status: 'failed',
            error: new ComputerUseError(CODES.WINDOW_MISMATCH, windowDecision.reason, { expected: windowDecision.expected || null, foreground: windowDecision.foreground || null }),
            world: run.world
          }
        }
      }
    }

    // ---- ACTING (plan §6/§29) ----------------------------------------------
    stateMachine.transition(CU_STATES.ACTING, { step: stepNumber })
    // Task 10: the reconnect budget belongs to this step attempt, so a channel
    // that keeps dropping cannot spend the run's budget.
    reconnect.beginStep()
    let acted = await performAction(action, run.world, { contract, resolved, attempt: run.attempt, visualLevel: run.visualLevel, run })
    // A channel that came back is not a licence to reuse the target that was
    // resolved before the failure: the step re-observes and re-resolves, and the
    // loop is bounded by the same per-step budget the reconnect drew from.
    let reconnects = 0
    while (acted.status === 'reconnect') {
      const route = acted.route || null
      if (reconnects >= reconnect.maxAttempts) {
        acted = {
          status: 'failed',
          route,
          action,
          receipt: null,
          controller: route ? route.controller : null,
          error: reconnect.exhaustedError({
            channel: route ? route.controller || route.channel : null,
            attempts: reconnects,
            reason: 'the channel did not stay up through the step'
          })
        }
        break
      }
      reconnects += 1
      // The step stays in ACTING on purpose: plan §52 allows no transition from
      // ACTING back to an observation state, so a channel that came back
      // continues the step in place (the reconnect is recorded in the log,
      // including its attempt and outcome).
      run.world = await observeWorld(run, action)
      resolved = requiresTarget(action) && action.target ? await attemptResolve() : resolved
      if (requiresTarget(action) && action.target && !resolved) {
        acted = {
          status: 'failed',
          route,
          action,
          receipt: null,
          controller: route ? route.controller : null,
          error: new ComputerUseError(CODES.TARGET_NOT_FOUND, `the target could not be re-resolved after reconnecting ${route ? route.controller || route.channel : 'the channel'}`, {
            step: stepNumber,
            target: describeTarget(action.target)
          })
        }
        break
      }
      run.lastResolution = resolved || run.lastResolution
      acted = await performAction(action, run.world, { contract, resolved, attempt: run.attempt, visualLevel: run.visualLevel, run })
    }
    run.lastAction = { type: action.type, target: action.target ? describeTarget(action.target) : null, result: acted.status }
    // Task 10: the channel this step actually used is the hint a later
    // observation's transport failure is attributed to.
    run.lastRoute = acted.route || run.lastRoute

    if (resolved && resolved.ref && (action.type === ACTION_TYPES.FOCUS || action.type === ACTION_TYPES.DOM_TYPE)) {
      // A resolution is only *candidate* evidence: the verification below decides
      // whether the focus may be trusted (Task 1). Nothing is promoted here.
      run.focus.attempt(resolved.ref, { action: action.type, step: stepNumber, source: 'resolution' })
    }

    // Plan §32: remember what a sensitive action typed, so the value cannot
    // reappear through a later step's world-state summary.
    if (action.sensitive) {
      for (const candidate of [action.params.text, action.params.value, action.params.stdin]) {
        if (typeof candidate === 'string' && candidate.length >= 2 && !run.sensitiveValues.includes(candidate)) {
          run.sensitiveValues.push(candidate)
        }
      }
    }

    // ---- POST_ACTION_GRACE (plan §11) --------------------------------------
    stateMachine.transition(CU_STATES.POST_ACTION_GRACE, { step: stepNumber })
    const grace = await stabilizer.grace(action)
    run.graceMs = grace.waitedMs

    // ---- VERIFYING (plan §12/§14/§15) --------------------------------------
    stateMachine.transition(CU_STATES.VERIFYING, { step: stepNumber })
    const verification = await waitForEffect(action, run, before, acted)
    const after = verification.world
    run.world = after
    const miss = detectMiss({
      action,
      before,
      after,
      verification: verification.result,
      receipt: acted.receipt,
      visualDigestBefore: run.visualDigest,
      visualDigestAfter: after ? after.signature : null
    })
    // Task 3: the miss this step produced is what the *next* settle needs to know
    // about, so it is recorded here rather than inferred later from the log.
    run.lastMiss = { step: stepNumber, actionType: action.type, missed: miss.missed === true, signals: miss.signals }
    const change = meaningfulChange(before, after)
    const stallState = run.stall.record({
      step: stepNumber,
      actionType: action.type,
      changed: change.changed,
      fields: change.fields,
      signature: after ? after.signature : null,
      verification: verification.result ? verification.result.verdict : null
    })
    // FOCUS is the one action whose *whole* purpose is the focus, so its
    // verification is what promotes the trust (Task 1). Any other action leaves
    // the reference exactly as the context check left it.
    if (action.type === ACTION_TYPES.FOCUS || action.type === ACTION_TYPES.DOM_TYPE) {
      const verdict = verification.result ? verification.result.verdict : VERDICTS.UNKNOWN
      const focusedNow = after && after.focusedRef ? after.focusedRef : null
      // The reference that is handed over is the one that is *actually* focused,
      // never the one that was merely attempted: passing the attempted ref for a
      // failed or unknown verdict would leave a trusted-looking reference behind
      // (Task 1).
      const confirmed = verdict === VERDICTS.SUCCESS && focusedNow ? focusedNow : null
      run.focus.verified(verdict, confirmed)
    }
    // Task 4: the verification says *what* happened; the risk of the action says
    // whether that evidence is good enough to carry it.
    const evidence = assessEvidence({
      action,
      verification: verification.result,
      declaredEffect: Boolean(action.expectedEffect)
    })
    // Task 5: only a verified effect, a finished process or a confirmed mutation
    // counts as progress. Issuing an action never does.
    if (evidence.ok) {
      run.progress.progress(PROGRESS_KINDS.VERIFIED_EFFECT, {
        step: stepNumber,
        verdict: verification.result ? verification.result.verdict : null,
        kind: verification.result ? verification.result.kind : null,
        detail: verification.result && verification.result.evidence ? verification.result.evidence.length : 0
      })
    } else if (verification.result && verification.result.verdict === VERDICTS.SUCCESS) {
      run.progress.noOp(after ? after.signature : null)
    }
    // Task 12: a filesystem mutation is checked against the disk, not against the
    // controller's own report.
    const mutation = await mutations.verify({ action, receipt: acted.receipt, beforeMtime: acted.beforeMtime })
    if (mutation && mutation.verified === true) {
      run.progress.progress(PROGRESS_KINDS.FILE_OPERATION, { step: stepNumber, operation: mutation.operation, path: mutation.path })
    }
    run.steps = stepNumber

    writeStepLog({
      step: stepNumber,
      state: stateMachine.state,
      action,
      route: acted.route,
      before,
      after,
      verification: verification.result,
      receipt: acted.receipt,
      miss,
      retryCount: run.attempt - 1,
      resolved: run.lastResolution,
      stabilizationMs: run.stabilizationMs,
      graceMs: run.graceMs,
      durationMs: clock.now() - startedAt,
      waitedMs: run.waitMs,
      sensitiveValues: run.sensitiveValues,
      evidence,
      mutation
    })

    // A verified effect whose evidence is not strong enough for the action's own
    // risk is *not* success: the step is reported as unverified rather than
    // letting a weak "something changed" carry a save, a send or a delete
    // (Task 4).
    if (verification.result && verification.result.verdict === VERDICTS.SUCCESS && !miss.missed) {
      if (evidence.ok) {
        return { status: 'success', world: after, verification: verification.result, stallState, miss, action, receipt: acted.receipt, route: acted.route, evidence, mutation }
      }
      const weak = new ComputerUseError(
        CODES.EVIDENCE_INSUFFICIENT,
        `the action was verified but the evidence is not strong enough to accept it: ${evidence.reason}`,
        { step: stepNumber, grade: evidence.grade, required: evidence.required, risk: evidence.risk, evidence: verification.result.evidence }
      )
      // A retry with stronger evidence is the right answer, so this is retryable
      // by default (see errors.defaultRetryable).
      return {
        status: 'failed',
        error: weak,
        world: after,
        verification: verification.result,
        miss,
        stallState,
        route: acted.route,
        receipt: acted.receipt,
        evidence,
        mutation,
        durationMs: clock.now() - startedAt
      }
    }

    // A filesystem mutation that cannot be confirmed is a failure even when the
    // controller reported success: "the command exited 0" is not "the file is
    // right" (Task 12).
    if (mutation && mutation.verified === false && !mutation.skipped) {
      return {
        status: 'failed',
        error: mutations.unverifiedError(mutation),
        world: after,
        verification: verification.result,
        miss,
        stallState,
        route: acted.route,
        receipt: acted.receipt,
        evidence,
        mutation,
        durationMs: clock.now() - startedAt
      }
    }

    const error = acted.error || new ComputerUseError(
      verification.result && verification.result.verdict === VERDICTS.UNKNOWN ? CODES.VERIFICATION_UNKNOWN : CODES.VERIFICATION_FAILED,
      miss.missed
        ? `the action was issued but had no observed effect (${miss.signals.join(', ')})`
        : 'the expected effect was not observed',
      { step: stepNumber, verification: verification.result ? verification.result.evidence : null, signals: miss.signals }
    )
    return {
      status: 'failed',
      error,
      world: after,
      verification: verification.result,
      miss,
      stallState,
      route: acted.route,
      receipt: acted.receipt,
      durationMs: clock.now() - startedAt
    }
  }

  /**
   * Plan §12: after acting, wait for the expected effect -conditionally, up to
   * the action's timeout. A 700 ms UI is waited for exactly as long as it needs
   * (plus the poll interval), never a fixed two seconds.
   */
  async function waitForEffect(action, run, before, acted) {
    const timeoutMs = action.timeoutMs || TIMING.defaultActionTimeoutMs
    const startedAt = clock.now()
    let world = await observeWorld(run, action)
    let result = await verifyOnce(action, run, before, world, acted)
    let waits = 0
    while (result.verdict !== VERDICTS.SUCCESS && clock.now() - startedAt < timeoutMs) {
      waits += 1
      await clock.sleep(Math.min(TIMING.eventPollMs, Math.max(0, timeoutMs - (clock.now() - startedAt))))
      world = await observeWorld(run, action)
      result = await verifyOnce(action, run, before, world, acted)
    }
    run.waitMs = clock.now() - startedAt
    run.waits = waits
    return { result, world, waitedMs: run.waitMs, polls: waits }
  }

  async function verifyOnce(action, run, before, world, acted) {
    try {
      return await verifier.verify({
        action,
        before,
        after: world,
        facts: verificationFacts(run),
        receipt: acted.receipt,
        effectMode: action.expectedEffect && action.expectedEffect.mode
      })
    } catch (error) {
      return {
        verdict: VERDICTS.UNKNOWN,
        kind: 'none',
        evidence: [{ kind: 'verifier-error', ok: null, detail: error && error.message ? error.message : String(error) }],
        error
      }
    }
  }

  function verificationFacts(run) {
    const facts = {}
    if (controllers.file) Object.assign(facts, controllers.file.facts())
    if (controllers.shell) Object.assign(facts, controllers.shell.facts())
    if (controllers.browser) Object.assign(facts, controllers.browser.facts())
    if (controllers.desktop) Object.assign(facts, controllers.desktop.facts())
    // Host-supplied facts win: the host knows the environment it handed over
    // (a virtual filesystem, an application API), and both step verification
    // and success criteria read the same view of it.
    if (options.hostFacts && typeof options.hostFacts === 'object') {
      for (const [key, value] of Object.entries(options.hostFacts)) {
        if (typeof value === 'function') facts[key] = value
      }
    }
    facts.events = run.world ? run.world.systemEvents : []
    facts.world = run.world
    facts.initialUrl = run.initialUrl
    facts.startedAt = run.startedAt
    return facts
  }

  /** The reference an action intends to focus, for the attempt log (Task 1). */
  function focusRefOf(action) {
    if (!action || !action.target) return null
    return action.target.ref || action.target.selector || null
  }

  /** Plan §31: turn "typing is not focused" into an explicit FOCUS step. */
  function buildFocusAction(action) {    if (!action.target) return null
    return {
      ...action,
      type: ACTION_TYPES.FOCUS,
      id: action.id ? `${action.id}#focus` : null,
      description: 'establish focus before typing',
      expectedEffect: { any: [{ focus_changed: true }], mode: 'any' },
      retry: action.retry ? { ...action.retry, maxAttempts: 1 } : null,
      timeoutMs: Math.min(action.timeoutMs || TIMING.defaultActionTimeoutMs, 2000)
    }
  }

  /**
   * Plan §30 + Update-Plan/24h.md Task 2: pause the original action, handle the
   * modal, resume. The controls are classified by `modal.cjs` and the decision is
   * fail-safe: a safe dismissal is pressed, a destructive one needs the contract,
   * the declared effect and the safety gate to agree, and anything unclassifiable
   * becomes USER_ACTION_REQUIRED — never "the first button".
   */
  async function handleModal(gate, action, run, stepNumber) {
    const contract = run.contract
    const modal = gate.modal.modals[0]
    run.stateMachine.transition(CU_STATES.RECOVERING, { step: stepNumber, reason: 'blocking modal detected' })
    run.modalHandled = (run.modalHandled || 0) + 1
    if (run.modalHandled > 3) {
      return {
        status: 'failed',
        error: new ComputerUseError(CODES.MODAL_BLOCKING, 'a blocking dialog keeps reappearing - refusing to dismiss dialogs in a loop', { modals: gate.modal.modals }),
        world: run.world
      }
    }
    if (!modal || !modal.ref) {
      return {
        status: 'failed',
        error: new ComputerUseError(CODES.MODAL_BLOCKING, 'a blocking dialog is open and cannot be addressed through a structured control', { modals: gate.modal.modals }),
        world: run.world
      }
    }

    const candidates = await collectModalControls(modal)
    const planned = planModal({
      modal,
      candidates,
      context: {
        destructiveMode: contract.safety.destructiveActions,
        destructiveKinds: action.destructive,
        expectedEffect: expectationText(action),
        // The gate ran before this point, so reaching here means the action itself
        // was authorized; a *destructive dialog control* still has to be justified
        // by the action's own declared effect.
        safetyPassed: true
      }
    })

    writeLog('event', {
      type: 'modal-plan',
      step: stepNumber,
      kind: planned.kind,
      ref: planned.ref,
      source: planned.source,
      label: planned.control ? planned.control.label : null,
      action: planned.action,
      reason: planned.reason
    })

    if (planned.action !== MODAL_ACTION.PRESS || !planned.ref) {      // The fail-safe answer: report it and stop the step. `USER_ACTION_REQUIRED`
      // says who has to decide.
      writeLog('event', {
        type: 'modal-user-required',
        step: stepNumber,
        kind: planned.kind,
        controls: planned.classification.controls.map((control) => control.label || '?'),
        reason: planned.reason
      })
      return {
        status: 'failed',
        error: new ComputerUseError(CODES.MODAL_BLOCKING, planned.reason, {
          modal,
          kind: planned.kind,
          destructiveKind: planned.destructiveKind,
          verdict: RECOVERY_VERDICTS.USER_ACTION_REQUIRED
        }),
        world: run.world
      }
    }

    // A dialog hosted by the page is dismissed through the DOM; a native window
    // dialog through UI Automation. Both are the dialog's *own* control.
    const pageHosted = planned.source === 'page'
    const dismissAction = {
      type: pageHosted ? ACTION_TYPES.DOM_CLICK : ACTION_TYPES.ACCESSIBILITY_INVOKE,
      target: { ref: planned.ref },
      params: { __modalDismiss: true },
      capability: pageHosted ? 'browser' : 'desktop',
      precondition: { targetExists: true, targetEnabled: true, targetVisible: true, windowForeground: null, focusMatches: null, custom: [] },
      stabilization: { minimumMs: 50, maximumMs: 150, requireStable: true, waitForQuiet: true },
      expectedEffect: null,
      timeoutMs: 2000,
      retry: { maxAttempts: 1, allowAlternative: false, backoffMs: 80 },
      destructive: null,
      id: 'modal-dismiss',
      description: `dismiss dialog (${planned.kind}): ${modal.message || modal.type} via "${planned.control.label || '?'}"`,
      sensitive: false
    }
    const outcome = await executeStep(dismissAction, run)
    if (outcome.status !== 'success') {
      return {
        status: 'failed',
        error: new ComputerUseError(CODES.MODAL_BLOCKING, `the dialog could not be dismissed: ${outcome.error ? outcome.error.message : 'unknown reason'}`, { modal, kind: planned.kind }),
        world: outcome.world || run.world
      }
    }
    return {
      // The original action is resumed by the run loop: 'resume' means "try the
      // same step again now that the dialog is out of the way".
      status: 'resume',
      world: outcome.world,
      action,
      modal,
      modalKind: planned.kind
    }
  }

  /** What a dialog control's effect would be, as the text the classifier reads. */
  function expectationText(action) {
    if (!action || !action.expectedEffect) return ''
    const parts = []
    const effects = action.expectedEffect.any || action.expectedEffect.all || []
    for (const effect of effects) {
      if (effect && typeof effect === 'object') parts.push(Object.keys(effect).join(' '))
    }
    if (Array.isArray(action.destructive)) parts.push(action.destructive.join(' '))
    if (action.description) parts.push(action.description)
    if (action.params && typeof action.params.path === 'string') parts.push(action.params.path)
    return parts.join(' ')
  }

  /**
   * Gather the candidate controls of a dialog.
   *
   * This collects; it does not choose. Choosing is `modal.planModal`, which is
   * pure and testable, and which never falls back to position.
   */
  async function collectModalControls(modal) {
    const candidates = []
    if (modal.source === 'browser' && controllers.browser && controllers.browser.page) {
      try {
        const controls = await withTimeout(Promise.resolve(controllers.browser.page.queryAll()), 3000, 'modal scan')
        if (Array.isArray(controls)) {
          for (const control of controls) {
            if (String(control.role || '').toLowerCase() !== 'button') continue
            if (control.disabled === true) continue
            candidates.push({
              ref: control.ref,
              label: control.name || control.text || '',
              role: control.role,
              bbox: control.bbox || null,
              source: 'page'
            })
          }
        }
      } catch {
        /* fall through to the desktop path */
      }
    }
    if (!candidates.length && controllers.desktop && controllers.desktop.accessibility) {
      try {
        const nodes = await withTimeout(Promise.resolve(controllers.desktop.accessibility.find({ windowHandle: modal.windowHandle }, { limit: 40 })), 3000, 'modal scan')
        if (Array.isArray(nodes)) {
          for (const node of nodes) {
            candidates.push({
              ref: node.ref,
              label: node.name || node.text || '',
              role: node.role || node.controlType || null,
              bbox: node.bounds || node.bbox || null,
              source: 'desktop',
              disabled: node.enabled === false || node.disabled === true
            })
          }
        }
      } catch {
        /* no candidates from this source */
      }
    }
    return candidates
  }

  /**
   * Plan §24/§25: once the cooldown ladder is exhausted the runtime stops
   * adding delay and switches to a *conditional* wait for the UI to go quiet
   * (loading finished, no further DOM/AX churn, no dialogs). It is bounded by
   * the action's timeout, so an animation that never stops becomes UI_UNSTABLE
   * rather than a hang.
   */
  async function waitForQuiet(action, run) {
    const timeoutMs = action.timeoutMs || TIMING.defaultWaitTimeoutMs
    const startedAt = clock.now()
    let quietPolls = 0
    let previousSignature = null
    for (;;) {
      const world = await observeWorld(run, action)
      run.world = world
      const quiet = world.loading !== true && world.readyState !== 'loading' && world.dialogs.length === 0
      if (quiet && previousSignature !== null && previousSignature === world.signature) quietPolls += 1
      else quietPolls = quiet ? 1 : 0
      previousSignature = world.signature
      if (quietPolls >= 2) return { ok: true, world, waitedMs: clock.now() - startedAt }
      if (clock.now() - startedAt >= timeoutMs) return { ok: false, world, waitedMs: clock.now() - startedAt }
      await clock.sleep(TIMING.eventPollMs)
    }
  }

  /**
   * Plan §18/§19: one failed step becomes a decision, not a dead end.
   */
  async function recover(stepOutcome, action, run) {
    const decision = run.recovery.decide({
      action,
      attempt: run.attempt,
      error: stepOutcome.error,
      miss: stepOutcome.miss,
      stallRecoveries: run.stallRecoveries,
      // Plan §21: retry, alternative and replan all draw from one bounded
      // per-step round budget, so no ladder can run forever.
      recoveryRounds: run.recoveryRounds,
      allowedCapabilities: run.contract.allowedCapabilities,
      visualLevel: run.visualLevel,
      usedChannel: stepOutcome.route ? stepOutcome.route.channel : null,
      point: run.lastResolution ? run.lastResolution.point : null,
      resolved: run.lastResolution,
      context: { contract: run.contract }
    })
    run.recoveryRounds += 1
    // Plan §21: when the recovery ladder itself runs out *after* a stall, the
    // run must end as FAIL_WITH_CONTEXT -the stall is the reason, and the log
    // should say so rather than blaming the last verification.
    if (decision.step === 'fail' && run.stall.consecutive > 0) {
      decision.stallTerminal = true
      decision.stallHistory = run.stall.history().slice(-5)
      decision.reason = `${decision.reason}; the run had stalled (${run.stall.consecutive} consecutive actions without meaningful change)`
    }
    run.recoveryDecisions.push(decision)
    writeLog('event', { type: 'recovery', step: run.steps, step_: decision.step, reason: decision.reason, attempt: decision.attempt })
    return decision
  }

  /**
   * What each rung of the stall ladder actually *does* (Update-Plan/24h.md
   * Task 6).
   *
   * The ladder itself - which rungs exist and in which order - is defined exactly
   * once, in `stall.cjs`. The work below is aligned with that canonical list
   * position by position, so this file carries no second copy of the rung names
   * and cannot drift from the ladder it walks. The terminal rung has no work
   * here on purpose: it is the "stop with context" verdict, handled before the
   * dispatch.
   */
  const stallRungWork = [
    // 1. rebuild the world state from structured sources only
    async (run, action) => {
      run.world = await observeWorld(run, action)
      return { status: 'continue' }
    },
    // 2. verify the expected window is still present and in front
    async (run, action) => {
      run.world = await observeWorld(run, action)
      if (!run.world.foreground && runtimeOptions.requireForeground !== false) {
        writeLog('event', { type: 'stall-window-check', result: 'no foreground window is observable' })
      }
      return { status: 'continue' }
    },
    // 3. re-resolve the target from scratch through the full ladder
    async (run, action) => {
      run.lastResolution = null
      run.wantAx = true
      run.world = await observeWorld(run, action)
      return { status: 'continue' }
    },
    // 4. capture the smallest region that could explain the stall
    async (run) => {
      if (controllers.vision) {
        const capture = await captureEvidence(run, SCREENSHOT_LEVELS.REGION, 'stall-targeted')
        if (capture && capture.ok === false) writeLog('event', { type: 'stall-screenshot', ok: false, reason: capture.reason })
      }
      return { status: 'continue' }
    },
    // 5. use a different interaction channel for the same intent
    async (run, action) => {
      const alternative = alternativeAction(action, { attempt: 2, usedChannel: null, point: run.lastResolution ? run.lastResolution.point : null })
      if (alternative) run.pendingAction = alternative
      return { status: 'continue' }
    },
    // 6. ask the planner for a different next action
    async (run) => {
      run.pendingAction = null
      run.forceReplan = true
      return { status: 'continue' }
    },
    // 7. escalate to a full-screen capture - once, and only once: the next rung is
    // the terminal one, and the flag keeps that true even if the ladder grows.
    async (run) => {
      if (!run.fullScreenshotUsed) {
        run.fullScreenshotUsed = true
        await captureEvidence(run, SCREENSHOT_LEVELS.FULL, 'stall-full')
      }
      return { status: 'continue' }
    }
  ]

  /** Rung name -> work, keyed by the canonical ladder itself (Task 6). */
  const stallRungs = new Map()
  STALL_RECOVERY_LADDER.forEach((rung, index) => {
    const work = stallRungWork[index]
    if (typeof work === 'function') stallRungs.set(rung.step, work)
  })

  /**
   * Plan §20/§21: the stall ladder. The rungs come from `stall.cjs` (Task 6) and
   * each one is real work -re-observe, check the window, re-resolve the target,
   * take a *targeted* screenshot, switch the interaction, replan -and the ladder
   * ends in FAIL_WITH_CONTEXT.
   */
  async function recoverFromStall(run, action) {
    const index = run.stallRecoveries
    const rung = run.recovery.stallStep(index)
    run.stallRecoveries += 1
    run.stateMachine.transition(CU_STATES.STALLED, { reason: `stall detected: ${run.stall.consecutive} actions without meaningful change` })
    writeLog('event', { type: 'stall', rung: rung.ladderStep, recoveries: run.stallRecoveries, limit: run.stall.maxRecoveries })

    // Task 6: the terminal rung, a rung this file has no work for, and a spent
    // recovery budget all end the same way - FAIL_WITH_CONTEXT with the stall
    // history attached. The rung is recognised from the canonical ladder's own
    // verdict (`terminal`), never from a name written here, so an unknown rung is
    // treated as the terminal one instead of being guessed at.
    const work = stallRungs.get(rung.ladderStep)
    if (rung.terminal === true || !work || run.stallRecoveries > run.stall.maxRecoveries) {
      return {
        status: 'fatal',
        error: new ComputerUseError(CODES.STALL_DETECTED, `the task stalled: ${run.stall.consecutive} consecutive actions produced no meaningful change`, {
          stallRecoveries: run.stallRecoveries,
          rung: rung.ladderStep,
          history: run.stall.history().slice(-5)
        })
      }
    }

    run.stall.reset()
    const outcome = await work(run, action)
    return outcome || { status: 'continue' }
  }

  /** Captures evidence, honouring the contract's screenshot policy (plan §40). */
  async function captureEvidence(run, level, reason, options_ = {}) {
    if (!controllers.vision) return { ok: false, reason: 'no vision controller' }
    try {
      const allowed = level < SCREENSHOT_LEVELS.FULL || run.contract.vision.allowFullScreenFallback
      const capture = await withTimeout(Promise.resolve(controllers.vision.capture(allowed ? level : SCREENSHOT_LEVELS.WINDOW, {
        region: options_.region,
        windowHandle: options_.windowHandle || (run.world && run.world.foreground ? run.world.foreground.handle : null),
        reason,
        allowFullScreen: run.contract.vision.allowFullScreenFallback
      })), 5000, 'screenshot')
      run.visualLevel = Math.max(run.visualLevel, capture.level)
      // Task 8: the capture goes through the shared resource budget before
      // anything else touches it, so a ceiling that is reached degrades the
      // capture (it is dropped and reported) instead of throwing or leaking.
      const verdict = budgetCapture(run, capture, level, reason)
      let path_ = null
      if (log) {
        const retention = log.screenshot(capture.png, {
          level: capture.level,
          reason,
          step: run.steps,
          runFailed: run.failed === true,
          explicit: reason === 'requested'
        })
        capture.retained = retention.retained
        capture.path = retention.path
        path_ = retention.path || null
      }
      return {
        ok: true,
        level: capture.level,
        bytes: capture.bytes,
        rect: capture.rect,
        // The budget's verdict travels with the capture: `retained` is what the
        // run keeps, `dropped` is the capture the policy refused, and `evicted`
        // counts the older captures registering this one pushed over a ceiling.
        retained: verdict.keep,
        dropped: verdict.keep !== true,
        retention: verdict.retention,
        rationale: verdict.rationale,
        evicted: verdict.evicted,
        path: path_
      }
    } catch (error) {
      return { ok: false, reason: error && error.message ? error.message : String(error) }
    }
  }

  /**
   * Task 8: register one capture with the resource budget, and record a drop in
   * the log.
   *
   * The budget never throws: a capture it refuses is an outcome the run reports,
   * not a failure of the step that asked for the evidence.
   */
  function budgetCapture(run, capture, level, reason) {
    const bytes = capture && Number.isFinite(capture.bytes)
      ? capture.bytes
      : (capture && capture.png && Number.isFinite(capture.png.length) ? capture.png.length : 0)
    const verdict = resources.registerScreenshot({
      png: capture ? capture.png : null,
      bytes,
      level: capture && Number.isInteger(capture.level) ? capture.level : level,
      reason,
      step: run ? run.steps : null,
      runFailed: Boolean(run && run.failed === true),
      explicit: reason === 'requested'
    })
    if (!verdict.keep) {
      writeLog('event', {
        type: 'screenshot-dropped',
        level: capture && Number.isInteger(capture.level) ? capture.level : level,
        reason,
        retention: verdict.retention,
        rationale: verdict.rationale
      })
    }
    return verdict
  }

  /**
   * Update-Plan/24h.md Task 14: re-observe the effect of the step a resumed run
   * was handed, before issuing anything new.
   *
   * The shape consumed on `runOptions.resume` is deliberately small, and it adds
   * nothing to the public run report:
   *
   *   resume = {
   *     completedPlanSteps?: number,   // the existing plan-cursor hint
   *     lastStep?: {                   // the step whose outcome was never recorded
   *       source?: string,             // its plan source ('plan:<step id>')
   *       action: object,              // the action that was issued
   *       receipt?: object|null,       // whatever the controller managed to report
   *       beforeMtime?: number|null    // the destination's mtime before the action
   *     },
   *     mutation?: { action, receipt, beforeMtime }   // shorthand for `lastStep`
   *   }
   *
   * The probe happens once per resumed step: `already_complete` skips the step and
   * counts as progress (the effect is on disk), `retry` leaves the step to the plan
   * to issue again, and `failed` stops the run with the evidence instead of
   * blindly rewriting a half-finished file.
   *
   * @returns {Promise<Error|null>} the failure that stops the run, or null
   */
  async function probeResumedStep(run, resume) {
    const last = resume && typeof resume === 'object' ? (resume.lastStep || resume.mutation || null) : null
    const actionInput = last && last.action ? last.action : null
    if (!actionInput) return null
    let action = null
    try {
      action = normalizeAction(actionInput)
    } catch (error) {
      // An action that cannot even be normalized cannot be re-observed; the plan
      // re-issues it and reports the failure honestly there.
      writeLog('event', { type: 'resume-probe', step: run.steps, ok: false, reason: error && error.message ? error.message : String(error) })
      return null
    }
    const observed = await mutations.resume({
      action,
      receipt: last.receipt || null,
      beforeMtime: Number.isFinite(last.beforeMtime) ? last.beforeMtime : null
    })
    writeLog('event', { type: 'resume-probe', step: run.steps, action: action.type, verdict: observed.verdict, reason: observed.reason })

    if (observed.verdict === mutations.RESUME_VERDICT.ALREADY_COMPLETE) {
      const source = last.source || `resume:${action.id || action.type}`
      // The step is recorded exactly once, as a completed outcome, and the plan
      // cursor's own bookkeeping hears about it too - the next round must not
      // replay it.
      run.outcomes.push({
        step: run.steps,
        action: action.type,
        target: action.target ? describeTarget(action.target) : null,
        source,
        status: 'success',
        verification: STEP_RESULTS.SUCCESS,
        error: null,
        alreadyComplete: true
      })
      if (String(source).startsWith('plan:')) run.stepResults.set(source, true)
      // The step is skipped, not re-issued: the plan cursor moves past the plan
      // step this effect belongs to, so a completed write is never rewritten
      // (Task 14). A source that names no plan step leaves the cursor alone.
      skipCompletedPlanStep(run, source)
      // The effect is on disk, so it is progress - the same claim a verified
      // mutation makes (Task 5).
      run.progress.progress(PROGRESS_KINDS.FILE_OPERATION, {
        step: run.steps,
        operation: observed.operation || action.type,
        path: action.params && action.params.path ? action.params.path : null,
        verified: true
      })
      return null
    }

    if (observed.verdict === mutations.RESUME_VERDICT.FAILED) {
      return mutations.unverifiedError({
        operation: action.type,
        path: action.params && action.params.path ? action.params.path : null,
        reason: observed.reason,
        evidence: observed.evidence
      })
    }

    return null
  }

  /**
   * Task 14: move the plan cursor past a plan step whose effect a resumed run
   * found already complete, so the plan does not issue it a second time. The
   * `plan:<step id>` source is the identity `planNext()` gives a plan step; a
   * source that names no plan step (a recovery action, a planner action) leaves
   * the cursor alone.
   */
  function skipCompletedPlanStep(run, source) {
    const text = String(source || '')
    if (!text.startsWith('plan:')) return false
    const id = text.slice('plan:'.length)
    const position = run.contract.plan.findIndex((step) => String(step.id) === id)
    if (position < 0 || run.planCursor.step > position) return false
    run.planCursor.step = position + 1
    run.planCursor.action = 0
    return true
  }

  /** Plan §35 planning: the contract's plan first, then the optional planner hook. */
  async function planNext(run) {
    if (run.pendingAction) {
      const action = run.pendingAction
      const source = run.pendingSource || 'recovery'
      run.pendingAction = null
      run.pendingSource = null
      return { action, source }
    }
    if (run.forceReplan) {
      run.forceReplan = false
      run.wantAx = true
      const proposed = await askPlanner(run)
      if (proposed) return { action: proposed, source: 'planner-after-replan' }
    }
    while (run.planCursor.step < run.contract.plan.length) {
      const step = run.contract.plan[run.planCursor.step]
      if (run.planCursor.action >= step.actions.length) {
        run.planCursor.step += 1
        run.planCursor.action = 0
        continue
      }
      if (step.when && !evaluateWhen(step.when, run.world)) {
        run.planCursor.step += 1
        run.planCursor.action = 0
        continue
      }
      const action = step.actions[run.planCursor.action]
      run.planCursor.action += 1
      run.currentStep = step
      return { action, source: `plan:${step.id}` }
    }
    const proposed = await askPlanner(run)
    if (proposed) return { action: proposed, source: 'planner' }
    return { action: null, source: 'exhausted' }
  }

  async function askPlanner(run) {
    try {
      const proposed = await planner.next({
        world: run.world,
        contract: run.contract,
        history: run.outcomes.slice(-10),
        step: run.steps,
        state: run.stateMachine.state,
        availability: probeControllers()
      })
      if (!proposed) return null
      return normalizeAction(proposed)
    } catch (error) {
      writeLog('event', { type: 'planner-error', error: error && error.message ? error.message : String(error) })
      return null
    }
  }

  function evaluateWhen(when, world) {
    if (!when || !world) return true
    if (typeof when === 'object') {
      if (when.url && world.url && !world.url.toLowerCase().includes(String(when.url).toLowerCase())) return false
      if (when.window && !(world.windows || []).some((window) => String(window.title || '').toLowerCase().includes(String(when.window).toLowerCase()))) return false
      if (when.dom) return (world.controls || []).some((control) => control.selector === when.dom)
      return true
    }
    const [kind, value] = String(when).split(':')
    if (kind === 'url') return Boolean(world.url && world.url.toLowerCase().includes(String(value || '').toLowerCase()))
    if (kind === 'window') return (world.windows || []).some((window) => String(window.title || '').toLowerCase().includes(String(value || '').toLowerCase()))
    if (kind === 'dom') return (world.controls || []).some((control) => control.selector === value)
    return true
  }

  /**
   * Plan §36: completion is decided by the success criteria, never by "the plan
   * ran out".
   *
   * A contract that declares no criteria is still judged on evidence: the
   * implicit criterion is "every planned step was executed and verified". A
   * contract with neither criteria nor steps satisfies nothing -an empty
   * contract must not be able to report success.
   */
  async function checkCriteria(run) {
    if (run.contract.successCriteria.length) return evaluateCriteria(run.contract.successCriteria, criteriaFacts(run))
    const planLength = run.contract.plan.length
    const verified = run.stepResults ? [...run.stepResults.values()] : []
    if (!planLength && !run.outcomes.length) {
      return {
        satisfied: false,
        unknown: false,
        results: [{
          kind: 'implicit',
          description: 'the contract declares neither success criteria nor plan steps',
          verdict: 'unsatisfied'
        }]
      }
    }
    // The implicit criterion: the plan ran to its end and every plan step that
    // ran was verified. A step that failed and was never recovered keeps the run
    // short of completion (plan §36).
    const satisfied = Boolean(run.planExhausted) && verified.length > 0 && verified.every(Boolean)
    return {
      satisfied,
      unknown: false,
      results: [{
        kind: 'implicit',
        description: 'every planned step was executed and verified',
        verdict: satisfied ? 'satisfied' : 'unsatisfied'
      }]
    }
  }

  function criteriaFacts(run) {
    const facts = verificationFacts(run)
    if (controllers.vision) Object.assign(facts, { visualChange: (effect) => controllers.vision.visualChange(effect, {}) })
    if (run.contract.safety.confirm) facts.custom = (criterion) => run.contract.safety.confirm({ criterion, goal: run.contract.goal })
    return facts
  }

  /**
   * The run loop (plan §2/§52). Returns the run report; it never throws for a
   * task-level failure -a failure is a result the caller inspects.
   */
  async function run(contractInput, runOptions = {}) {
    if (running) throw new ComputerUseError(CODES.CONTRACT_INVALID, 'this executor is already running a task')
    running = true
    cancelled = false
    const contract = isContract(contractInput) ? contractInput : createContract(contractInput, runtimeOptions)
    const stateMachine = createStateMachine({ now: clock.now, initialState: CU_STATES.IDLE, onTransition: (entry) => writeLog('event', { type: 'state', from: entry.from, to: entry.to, reason: entry.meta.reason || null }) })
    const run = {
      id: contract.id || `run-${clock.now()}`,
      contract,
      stateMachine,
      // The host's confirmation callback is the fallback for a contract that
      // asks for "confirm" without carrying its own channel (plan §34).
      safety: createSafetyGuard({ contract, confirm: contract.safety.confirm || options.confirm, now: clock.now }),
      recovery: createRecoveryController({
        maxRetriesPerAction: contract.limits.maxRetriesPerAction,
        maxStallRecoveries: contract.limits.maxStallRecoveries,
        visualLevelCeiling: contract.vision.allowFullScreenFallback ? SCREENSHOT_LEVELS.FULL : SCREENSHOT_LEVELS.WINDOW,
        now: clock.now
      }),
      stall: createStallDetector({ consecutiveActions: runtimeOptions.stall ? runtimeOptions.stall.consecutiveActions : undefined, maxRecoveries: contract.limits.maxStallRecoveries, now: clock.now }),
      // Focus trust (Task 1): attempted and verified are separate fields and only
      // a verification promotes one to the other.
      focus: createFocusTrust({ now: clock.now }),
      // Meaningful-progress heartbeat (Task 5): only verified effects, finished
      // processes and confirmed mutations move `lastProgressAt`.
      progress: createProgressTracker({ now: clock.now }),
      steps: 0,
      attempt: 1,
      stallRecoveries: 0,
      visualLevel: SCREENSHOT_LEVELS.NONE,
      stabilizationMs: 0,
      graceMs: 0,
      waitMs: 0,
      planCursor: { step: 0, action: 0 },
      pendingAction: null,
      pendingSource: null,
      planExhausted: false,
      stepResults: new Map(),
      forceReplan: false,
      lastResolution: null,
      lastAction: null,
      // Task 3: the miss and the observation the *previous* step ended on, kept as
      // bounded summaries rather than world states (see `summarizeObservation`).
      lastMiss: null,
      lastObservation: null,
      // Task 10: the channel the last step actually used, as the hint a later
      // transport failure is attributed to.
      lastRoute: null,
      // Task 6: the full-screen capture is spent at most once per run.
      fullScreenshotUsed: false,
      verifiedFocusRef: null,
      outcomes: [],
      recoveryDecisions: [],
      recoveryRounds: 0,
      sensitiveValues: [],
      startedAt: clock.now(),
      world: null,
      initialUrl: null,
      failed: false
    }
    currentRun = run

    // Plan §49: an autonomous continuation round resumes where the previous
    // round stopped instead of replaying steps that already succeeded.
    if (runOptions.resume && Number.isInteger(runOptions.resume.completedPlanSteps)) {
      run.planCursor.step = Math.max(0, Math.min(contract.plan.length, runOptions.resume.completedPlanSteps))
    }

    stateMachine.transition(CU_STATES.RECEIVING_TASK, { reason: 'execution contract received' })
    writeLog('event', { type: 'run-start', contract: describeContract(contract), availability: probeControllers(true) })

    run.world = await observer.observe(observeOptions(run, null))
    run.initialUrl = run.world.url
    stateMachine.transition(CU_STATES.OBSERVING, { reason: 'initial observation' })
    // The initial observation establishes the window and navigation context the
    // focus trust compares against.
    run.focus.observeContext(run.world)

    // Update-Plan/24h.md Task 12/14: the resume-safe step boundary. When the host
    // hands over the step that was in flight when the previous round stopped, its
    // effect is re-observed *before* anything new is issued.
    const resumeStop = await probeResumedStep(run, runOptions.resume)

    let status = RUN_STATUS.FAILED
    let error = null
    let criteria = { satisfied: false, unknown: false, results: [] }

    for (;;) {
      if (resumeStop) {
        // A resumed mutation that cannot be re-observed stops the run here rather
        // than being rewritten blind (Task 14).
        status = RUN_STATUS.FAILED
        error = resumeStop
        run.failed = true
        break
      }
      if (cancelled) {
        status = RUN_STATUS.CANCELLED
        error = new ComputerUseError(CODES.RUN_CANCELLED, 'the run was cancelled')
        break
      }
      if (run.steps >= contract.limits.maxSteps) {
        status = RUN_STATUS.FAILED
        error = new ComputerUseError(CODES.STEP_LIMIT_REACHED, `the run reached its step limit (${contract.limits.maxSteps})`, { steps: run.steps })
        break
      }
      if (clock.now() - run.startedAt > contract.limits.runTimeoutMs) {
        status = RUN_STATUS.FAILED
        error = new ComputerUseError(CODES.RUN_TIMEOUT, `the run exceeded its time budget (${contract.limits.runTimeoutMs}ms)`, { steps: run.steps })
        break
      }

      criteria = await checkCriteria(run)
      if (criteria.satisfied) {
        status = RUN_STATUS.COMPLETED
        break
      }

      const planned = await planNext(run)
      if (!planned.action) {
        // The plan and the planner are both out of ideas: re-judge the criteria
        // one last time before declaring the run unfinished.
        run.planExhausted = true
        criteria = await checkCriteria(run)
        if (criteria.satisfied) {
          status = RUN_STATUS.COMPLETED
          break
        }
        status = criteria.unknown ? RUN_STATUS.BLOCKED : RUN_STATUS.FAILED
        error = new ComputerUseError(CODES.PLAN_EXHAUSTED, criteria.unknown
          ? 'the plan is exhausted and a success criterion could not be checked'
          : 'the plan is exhausted and the success criteria are not satisfied', {
          criteria: criteria.results,
          steps: run.steps
        })
        break
      }

      // Task 1: the step boundary drops the previous step's verified focus
      // reference. A reference that outlives the step that verified it is a stale
      // reference, and a focus gate that consults one is a gate that types into
      // whatever now happens to be focused. The next step re-establishes it (or
      // the safety gate inserts a FOCUS step that does).
      run.focus.beginStep()
      const outcome = await executeStep(planned.action, run)
      run.outcomes.push({
        step: run.steps,
        action: planned.action.type,
        target: planned.action.target ? describeTarget(planned.action.target) : null,
        source: planned.source,
        status: outcome.status,
        verification: outcome.verification ? outcome.verification.verdict : null,
        error: outcome.error ? outcome.error.code : null
      })
      // Per-plan-step outcome, so the implicit completion criterion can tell a
      // recovered step from a step that never worked.
      if (String(planned.source).startsWith('plan:')) {
        run.stepResults.set(planned.source, outcome.status === 'success')
      }

      if (outcome.status === 'success') {
        run.attempt = 1
        run.recoveryRounds = 0
        run.world = outcome.world || run.world
        stateMachine.transition(CU_STATES.OBSERVING, { step: run.steps, reason: 'step verified' })
        if (run.currentStep && run.planCursor.action >= (run.currentStep.actions.length || 0) && run.currentStep.expectedEffect) {
          run.currentStep = null
        }
        continue
      }

      if (outcome.status === 'resume') {
        run.world = outcome.world || run.world
        // Plan §30: pause the original action, handle the modal, then *resume
        // the original action* -not "carry on with the next plan step".
        run.pendingAction = outcome.action || planned.action
        run.pendingSource = planned.source
        stateMachine.transition(CU_STATES.OBSERVING, { step: run.steps, reason: 'modal handled - resuming the original action' })
        continue
      }

      // ---- failure paths ----------------------------------------------------
      run.world = outcome.world || run.world
      if (outcome.stallState && outcome.stallState.stalled) {
        const recovery = await recoverFromStall(run, planned.action)
        if (recovery.status === 'fatal') {
          status = RUN_STATUS.FAILED
          error = recovery.error
          run.failed = true
          break
        }
        stateMachine.transition(CU_STATES.OBSERVING, { reason: 'stall recovery' })
        continue
      }

      stateMachine.transition(CU_STATES.RETRYING, { step: run.steps, reason: outcome.error ? outcome.error.code : 'step failed' })
      const decision = await recover(outcome, planned.action, run)
      if (decision.step === 'retry') {
        run.attempt += 1
        // A retry is the *same* action again (after revalidation), not "move on
        // to the next plan step" -the plan cursor must not advance on failure.
        run.pendingAction = planned.action
        run.pendingSource = planned.source
        continue
      }
      if (decision.step === 'alternative_action' && decision.alternative) {
        run.attempt = 1
        run.pendingAction = decision.alternative
        // The alternative carries the same *intent*, so it keeps the plan step's
        // identity for the completion judgement.
        run.pendingSource = planned.source
        stateMachine.transition(CU_STATES.RECOVERING, { reason: 'switching to an alternative interaction' })
        continue
      }
      if (decision.step === 'replan') {
        run.attempt = 1
        run.forceReplan = true
        stateMachine.transition(CU_STATES.REPLANNING, { reason: decision.reason })
        continue
      }
      run.failed = true
      status = RUN_STATUS.FAILED
      error = decision.stallTerminal
        ? new ComputerUseError(CODES.STALL_DETECTED, decision.reason, {
            stallRecoveries: run.stallRecoveries,
            history: decision.stallHistory || [],
            cause: outcome.error ? outcome.error.code : null
          })
        : outcome.error || new ComputerUseError(CODES.PLAN_EXHAUSTED, decision.reason)
      break
    }

    // ---- completion / teardown ---------------------------------------------
    if (status === RUN_STATUS.COMPLETED) {
      criteria = await checkCriteria(run)
      if (!criteria.satisfied) {
        // A criterion stopped holding between the check and the teardown: the
        // honest answer is a blocked run, not a completion (plan §36).
        status = criteria.unknown ? RUN_STATUS.BLOCKED : RUN_STATUS.FAILED
        error = new ComputerUseError(CODES.VERIFICATION_FAILED, 'the success criteria stopped holding before completion', { criteria: criteria.results })
      }
    }
    run.stateMachine.force(status === RUN_STATUS.COMPLETED ? CU_STATES.COMPLETED : CU_STATES.FAILED, { reason: error ? error.message : 'run finished' })

    const report = {
      id: run.id,
      status,
      goal: contract.goal,
      criteria,
      steps: run.steps,
      outcomes: run.outcomes,
      recoveryDecisions: run.recoveryDecisions,
      stallRecoveries: run.stallRecoveries,
      states: run.stateMachine.path(),
      world: summarizeWorldState(run.world),
      error: error ? { code: error.code, message: error.message, details: error.details } : null,
      health: health(),
      startedAt: run.startedAt,
      finishedAt: clock.now()
    }
    writeLog('finish', { status, steps: run.steps, criteria: criteria.results, error: report.error })
    if (log) log.finish({ status, steps: run.steps, criteria: criteria.results })
    // Plan §5: the task's world state is dropped when the task ends.
    discardWorldState(run.world)
    observer.reset()
    running = false
    currentRun = null
    return report
  }

  /** One loop iteration, for an interactive "step" button in the UI. */
  async function stepOnce(contractInput, runOptions = {}) {
    return run(contractInput, { ...runOptions, maxStepsOverride: 1 })
  }

  function cancel(reason = 'cancelled by the host') {
    cancelled = true
    writeLog('event', { type: 'cancel', reason })
    return true
  }

  function writeLog(kind, payload) {
    if (!log) return
    try {
      if (kind === 'event') log.event(payload.type || 'event', payload)
      else log.event(kind, payload)
    } catch {
      /* logging never breaks the run */
    }
  }

  function writeStepLog(entry) {
    if (!log) return
    try {
      log.step(sanitizeLogEntry({
        step: entry.step,
        state: entry.state,
        action: entry.action ? describeAction(entry.action) : null,
        actionType: entry.action ? entry.action.type : null,
        // The author's own description travels with the step, so "dismiss
        // dialog: Delete this file?" is visible in the log next to the action.
        description: entry.action ? entry.action.description : null,
        target: entry.action && entry.action.target ? describeTarget(entry.action.target) : null,
        channel: entry.route ? entry.route.channel : null,
        controller: entry.route ? entry.route.controller : null,
        preState: summarizeWorldState(entry.before),
        stabilizationMs: entry.stabilizationMs,
        graceMs: entry.graceMs,
        waitMs: entry.waitedMs,
        durationMs: entry.durationMs,
        result: entry.verification && entry.verification.verdict === VERDICTS.SUCCESS ? STEP_RESULTS.SUCCESS : entry.verification && entry.verification.verdict === VERDICTS.UNKNOWN ? STEP_RESULTS.UNKNOWN : STEP_RESULTS.FAILURE,
        verification: entry.verification ? describeVerification(entry.verification) : null,
        verificationKind: entry.verification ? entry.verification.kind : null,
        evidence: entry.verification ? entry.verification.evidence : null,
        retryCount: entry.retryCount,
      waitedMs: entry.waitedMs,
      // Where the action was actually addressed (audit: a coordinate click must
      // be explainable after the fact).
      resolvedPoint: entry.resolved && entry.resolved.point ? entry.resolved.point : null,
        coordinateFallback: Boolean((entry.action && entry.action.target && (entry.action.target.point || entry.action.target.visual))
          || (entry.resolved && entry.resolved.coordinateFallback)),
        notes: entry.miss && entry.miss.signals.length ? `miss signals: ${entry.miss.signals.join(', ')}` : null
      }, entry.sensitiveValues || []))
    } catch {
      /* logging never breaks the run */
    }
  }

  /**
   * Plan §32: a value typed into a sensitive field must never reach the log - * not in the action, and not in the world-state summary of the *next* step
   * either, where a textbox's value would otherwise reappear.
   */
  function sanitizeLogEntry(entry, sensitiveValues) {
    if (!Array.isArray(sensitiveValues) || !sensitiveValues.length) return entry
    try {
      let text = JSON.stringify(entry)
      for (const value of sensitiveValues) {
        if (typeof value !== 'string' || value.length < 2) continue
        text = text.split(value).join('[redacted]')
      }
      return JSON.parse(text)
    } catch {
      return entry
    }
  }

  function describeVerification(verification) {
    if (!verification) return null
    const evidence = Array.isArray(verification.evidence) ? verification.evidence : []
    const passed = evidence.find((entry) => entry && entry.ok === true)
    if (passed && passed.detail) return passed.detail
    const failed = evidence.find((entry) => entry && entry.ok === false)
    if (failed && failed.detail) return failed.detail
    return verification.verdict
  }

  /** Plan §37: what is currently working and what is not, for the UI and the log. */
  function health() {
    const probed = probeControllers()
    return Object.entries(probed).map(([name, entry]) => ({
      controller: name,
      available: entry.available,
      reason: entry.reason,
      degraded: !entry.available
    }))
  }

  return {
    run,
    stepOnce,
    executeAction,
    cancel,
    health,
    probeControllers,
    captureEvidence,
    get running() {
      return running
    },
    get currentRun() {
      return currentRun
    },
    stabilizer,
    verifier
  }
}

function isContract(value) {
  return Boolean(value && typeof value === 'object' && value.goal && value.limits && value.safety && Array.isArray(value.successCriteria))
}

module.exports = { createExecutor }
