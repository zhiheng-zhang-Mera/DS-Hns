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

const { ACTION_TYPES, CU_STATES, RUN_STATUS, SCREENSHOT_LEVELS, STEP_RESULTS, VERDICTS, TIMING } = require('./constants.cjs')
const { CODES, ComputerUseError } = require('./errors.cjs')
const { createContract, assertCapability, describeContract } = require('./contract.cjs')
const { createStateMachine } = require('./state-machine.cjs')
const { createSafetyGuard } = require('./safety.cjs')
const { createStabilizer } = require('./stabilization.cjs')
const { createVerifier } = require('./verification.cjs')
const { createRecoveryController, alternativeController } = require('./recovery.cjs')
const { createStallDetector } = require('./stall.cjs')
const { detectMiss } = require('./miss.cjs')
const { routeAction } = require('./routing.cjs')
const { describeAction, requiresTarget } = require('./action.cjs')
const { describeTarget, revalidate, centerOf } = require('./target.cjs')
const { evaluateCriteria } = require('./criteria.cjs')
const { meaningfulChange, summarizeWorldState, discardWorldState } = require('./world-state.cjs')

const DEFAULT_PLANNER = { next: () => null }

/** A planner may be an object with `next()` or a bare function. */
function normalizePlanner(candidate) {
  if (!candidate) return DEFAULT_PLANNER
  if (typeof candidate === 'function') return { next: candidate }
  if (typeof candidate.next === 'function') return candidate
  return DEFAULT_PLANNER
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
    const { normalizeAction } = require('./action.cjs')
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

  /** Plan §30/§31/§33/§34: every gate that must pass before the hands move. */
  async function runGates(action, world, context) {
    const { contract, safety, attempt } = context
    // Waiting is a runtime primitive, not a machine capability: it borrows the
    // channel of whatever it is waiting on, so a contract that allows only
    // `browser` may still wait for the page to settle (plan §12).
    const waits = action.type === ACTION_TYPES.WAIT_EVENT || action.type === ACTION_TYPES.WAIT_STATE
    if (!waits) assertCapability(contract, action.capability || 'desktop', { action: action.type })
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
   * The body of ACTING: route, execute, and report a receipt. The caller has
   * already stabilized and revalidated.
   */
  async function performAction(action, world, context) {
    const { contract, attempt } = context
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
    try {
      const receipt = await withTimeout(
        Promise.resolve(controller.perform(action, { contract, world, resolved: context.resolved, attempt, channel: route.channel })),
        action.timeoutMs || contract.limits.stepTimeoutMs,
        `${action.type} via ${route.channel}`
      )
      return { status: receipt && receipt.ok === false ? 'failed' : 'acted', route, action, receipt, controller: route.controller }
    } catch (error) {
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
    if (requiresTarget(action) && action.target) {
      const attemptResolve = async () => {
        const result = await resolveActionTarget(action, run)
        run.resolveAttempts = result.attempts
        return result.resolved
      }
      // Plan §10, step 1: the target is detected *now*, and that resolution is
      // the baseline the post-settle resolution is compared against.
      const detected = await attemptResolve()
      const settleOutcome = await stabilizer.settle({
        action,
        previous: detected,
        world: run.world,
        observe: () => observer.observe(observeOptions(run, action)),
        locateTarget: attemptResolve
      })
      run.stabilizationMs = settleOutcome.waitedMs
      run.world = settleOutcome.world || run.world
      run.revalidation = settleOutcome.revalidation
      resolved = settleOutcome.resolved

      if (settleOutcome.verdict === 'reobserve') {
        // The target moved while settling: rebuild the picture and resolve once
        // more instead of acting on a coordinate we already know is wrong.
        run.world = await observer.observe(observeOptions(run, action))
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
    const gate = await runGates(action, run.world, { contract, safety, attempt: run.attempt })
    if (gate.blocked) {
      if (gate.code === CODES.MODAL_BLOCKING) {
        return handleModal(gate, action, run, stepNumber)
      }
      return { status: 'failed', error: new ComputerUseError(gate.code || CODES.SAFETY_REFUSED, gate.reason || 'a safety gate refused the action'), world: run.world }
    }
    if (requiresTarget(action) && action.target) {
      if (action.capability === 'desktop' && (action.type === ACTION_TYPES.TYPE || action.type === ACTION_TYPES.KEY_PRESS || action.type === ACTION_TYPES.HOTKEY)) {
        const focusDecision = safety.checkFocus(action, run.world, { contract, verifiedFocusRef: run.verifiedFocusRef })
        if (!focusDecision.allowed) {
          // Focus safety (plan §31): establish focus first instead of refusing
          // the whole step -but only when there is something to focus.
          const focusAction = buildFocusAction(action)
          if (focusAction) {
            const focusOutcome = await executeStep(focusAction, run)
            if (focusOutcome.status !== 'success') return focusOutcome
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
    const acted = await performAction(action, run.world, { contract, resolved, attempt: run.attempt, visualLevel: run.visualLevel })
    run.lastAction = { type: action.type, target: action.target ? describeTarget(action.target) : null, result: acted.status }

    if (resolved && resolved.ref && (action.type === ACTION_TYPES.FOCUS || action.type === ACTION_TYPES.DOM_TYPE)) {
      run.verifiedFocusRef = resolved.ref
    }
    if (resolved && !resolved.ref) run.verifiedFocusRef = null

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
    const change = meaningfulChange(before, after)
    const stallState = run.stall.record({
      step: stepNumber,
      actionType: action.type,
      changed: change.changed,
      fields: change.fields,
      signature: after ? after.signature : null,
      verification: verification.result ? verification.result.verdict : null
    })
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
      sensitiveValues: run.sensitiveValues
    })

    if (verification.result && verification.result.verdict === VERDICTS.SUCCESS && !miss.missed) {
      return { status: 'success', world: after, verification: verification.result, stallState, miss, action, receipt: acted.receipt, route: acted.route }
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
    let world = await observer.observe(observeOptions(run, action))
    let result = await verifyOnce(action, run, before, world, acted)
    let waits = 0
    while (result.verdict !== VERDICTS.SUCCESS && clock.now() - startedAt < timeoutMs) {
      waits += 1
      await clock.sleep(Math.min(TIMING.eventPollMs, Math.max(0, timeoutMs - (clock.now() - startedAt))))
      world = await observer.observe(observeOptions(run, action))
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

  /** Plan §31: turn "typing is not focused" into an explicit FOCUS step. */
  function buildFocusAction(action) {
    if (!action.target) return null
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
   * Plan §30: pause the original action, handle the modal, resume. The runtime
   * only ever presses a dialog's own dismiss/confirm control -deciding what a
   * permission prompt *means* stays with the contract's confirmation callback.
   */
  async function handleModal(gate, action, run, stepNumber) {
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
    if (!modal || !modal.ref || !controllers.desktop) {
      return {
        status: 'failed',
        error: new ComputerUseError(CODES.MODAL_BLOCKING, 'a blocking dialog is open and cannot be addressed through a structured control', { modals: gate.modal.modals }),
        world: run.world
      }
    }
    const dismiss = await findModalControl(modal)
    if (!dismiss) {
      return {
        status: 'failed',
        error: new ComputerUseError(CODES.MODAL_BLOCKING, `the dialog "${modal.message || modal.type}" has no dismiss/confirm control the runtime may press`, { modal }),
        world: run.world
      }
    }
    // A dialog hosted by the page is dismissed through the DOM; a native window
    // dialog through UI Automation. Both are the dialog's *own* control -the
    // runtime never guesses which button is safe beyond the documented names.
    const pageHosted = dismiss.source === 'page'
    const dismissAction = {
      type: pageHosted ? ACTION_TYPES.DOM_CLICK : ACTION_TYPES.ACCESSIBILITY_INVOKE,
      target: { ref: dismiss.ref },
      params: { __modalDismiss: true },
      capability: pageHosted ? 'browser' : 'desktop',
      precondition: { targetExists: true, targetEnabled: true, targetVisible: true, windowForeground: null, focusMatches: null, custom: [] },
      stabilization: { minimumMs: 50, maximumMs: 150, requireStable: true, waitForQuiet: true },
      expectedEffect: null,
      timeoutMs: 2000,
      retry: { maxAttempts: 1, allowAlternative: false, backoffMs: 80 },
      destructive: null,
      id: 'modal-dismiss',
      description: `dismiss dialog: ${modal.message || modal.type}`,
      sensitive: false
    }
    const outcome = await executeStep(dismissAction, run)
    if (outcome.status !== 'success') {
      return {
        status: 'failed',
        error: new ComputerUseError(CODES.MODAL_BLOCKING, `the dialog could not be dismissed: ${outcome.error ? outcome.error.message : 'unknown reason'}`, { modal }),
        world: outcome.world || run.world
      }
    }
    return {
      // The original action is resumed by the run loop: 'resume' means "try the
      // same step again now that the dialog is out of the way".
      status: 'resume',
      world: outcome.world,
      action,
      modal
    }
  }

  /**
   * Plan §30: find the dialog's own dismiss control. Page-hosted modals are
   * answered from the DOM (the runtime will not reach into a page's internals,
   * but the dialog it just observed is a normal control of that page).
   */
  async function findModalControl(modal) {
    const dismissName = /^(ok|close|dismiss|cancel|yes|confirm|confirmar|\u786e\u5b9a|\u53d6\u6d88|\u5173\u95ed|\u77e5\u9053\u4e86)$/i
    if (modal.source === 'browser' && controllers.browser && controllers.browser.page) {
      try {
        const controls = await withTimeout(Promise.resolve(controllers.browser.page.queryAll()), 3000, 'modal scan')
        if (Array.isArray(controls) && controls.length) {
          const buttons = controls.filter((control) => String(control.role || '').toLowerCase() === 'button' && control.disabled !== true)
          const named = buttons.find((button) => dismissName.test(String(button.name || '').trim()))
          if (named) return { ...named, source: 'page' }
          if (modal.bounds) {
            const inside = buttons.find((button) => button.bbox
              && button.bbox.x >= modal.bounds.x - 4
              && button.bbox.y >= modal.bounds.y - 4
              && button.bbox.x + button.bbox.width <= modal.bounds.x + modal.bounds.width + 4
              && button.bbox.y + button.bbox.height <= modal.bounds.y + modal.bounds.height + 4)
            if (inside) return { ...inside, source: 'page' }
          }
          // Last resort inside a page modal: the dialog's own first button.
          const fallback = buttons.find((button) => button.bbox && modal.bounds
            && Math.abs((button.bbox.y + button.bbox.height / 2) - (modal.bounds.y + modal.bounds.height / 2)) <= modal.bounds.height)
          if (fallback) return { ...fallback, source: 'page' }
        }
      } catch {
        /* fall through to the desktop path */
      }
    }
    try {
      const nodes = await withTimeout(Promise.resolve(controllers.desktop.accessibility.find({ windowHandle: modal.windowHandle }, { limit: 40 })), 3000, 'modal scan')
      if (!Array.isArray(nodes)) return null
      const preferred = nodes.find((node) => dismissName.test(String(node.name || '').trim()))
      if (preferred) return { ...preferred, source: 'desktop' }
      return nodes.find((node) => String(node.role || node.controlType || '').toLowerCase() === 'button') || null
    } catch {
      return null
    }
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
      const world = await observer.observe(observeOptions(run, action))
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
   * Plan §20/§21: the stall ladder. Each rung is real work -re-observe, check
   * the window, re-resolve the target, take a *targeted* screenshot, switch the
   * interaction, replan -and the ladder ends in FAIL_WITH_CONTEXT.
   */
  async function recoverFromStall(run, action) {
    const index = run.stallRecoveries
    const rung = run.recovery.stallStep(index)
    run.stallRecoveries += 1
    run.stateMachine.transition(CU_STATES.STALLED, { reason: `stall detected: ${run.stall.consecutive} actions without meaningful change` })
    writeLog('event', { type: 'stall', rung: rung.ladderStep, recoveries: run.stallRecoveries, limit: run.stall.maxRecoveries })

    if (rung.ladderStep === 'fail_with_context' || run.stallRecoveries > run.stall.maxRecoveries) {
      return {
        status: 'fatal',
        error: new ComputerUseError(CODES.STALL_DETECTED, `the task stalled: ${run.stall.consecutive} consecutive actions produced no meaningful change`, {
          stallRecoveries: run.stallRecoveries,
          history: run.stall.history().slice(-5)
        })
      }
    }

    run.stall.reset()
    switch (rung.ladderStep) {
      case 'structured_reobserve': {
        run.world = await observer.observe(observeOptions(run, action))
        return { status: 'continue' }
      }
      case 'window_check': {
        run.world = await observer.observe(observeOptions(run, action))
        if (!run.world.foreground && runtimeOptions.requireForeground !== false) {
          writeLog('event', { type: 'stall-window-check', result: 'no foreground window is observable' })
        }
        return { status: 'continue' }
      }
      case 'target_re_resolution': {
        run.lastResolution = null
        run.wantAx = true
        run.world = await observer.observe(observeOptions(run, action))
        return { status: 'continue' }
      }
      case 'targeted_screenshot': {
        if (controllers.vision) {
          const level = stabilizer.constructor ? SCREENSHOT_LEVELS.REGION : SCREENSHOT_LEVELS.REGION
          const capture = await captureEvidence(run, level, 'stall-targeted')
          if (capture && capture.ok === false) writeLog('event', { type: 'stall-screenshot', ok: false, reason: capture.reason })
        }
        return { status: 'continue' }
      }
      case 'alternative_interaction': {
        const alternative = require('./recovery.cjs').alternativeAction(action, { attempt: 2, usedChannel: null, point: run.lastResolution ? run.lastResolution.point : null })
        if (alternative) {
          run.pendingAction = alternative
          return { status: 'continue' }
        }
        return { status: 'continue' }
      }
      case 'replan': {
        run.pendingAction = null
        run.forceReplan = true
        return { status: 'continue' }
      }
      case 'full_screenshot': {
        await captureEvidence(run, SCREENSHOT_LEVELS.FULL, 'stall-full')
        return { status: 'continue' }
      }
      default:
        return { status: 'continue' }
    }
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
      }
      return { ok: true, level: capture.level, bytes: capture.bytes, rect: capture.rect }
    } catch (error) {
      return { ok: false, reason: error && error.message ? error.message : String(error) }
    }
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
      const { normalizeAction } = require('./action.cjs')
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

    let status = RUN_STATUS.FAILED
    let error = null
    let criteria = { satisfied: false, unknown: false, results: [] }

    for (;;) {
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
