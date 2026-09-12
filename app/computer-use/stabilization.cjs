'use strict'

/**
 * Computer Use Runtime: transient stabilization (plan §8, §9, §10, §11, §12,
 * §13, §23, §24, §25).
 *
 * This module is the answer to the two failure modes every computer-use agent
 * hits: acting on a target that has already moved, and *concluding failure*
 * before the UI has had a chance to react.
 *
 * The policy is fixed and deliberately boring:
 *
 *   short forced delay  +  long conditional wait     (plan §12)
 *   minimum settle → check stability → revalidate → act   (plan §9/§10)
 *   act → bounded grace → observe events             (plan §11)
 *
 * Nothing here is remembered between tasks: the ladders below depend only on the
 * *current* step's observations (plan §23/§42). No application-specific latency
 * profile appears in this file, and none ever will.
 */

const { TIMING, TARGET_MOVEMENT } = require('./constants.cjs')
const { revalidate } = require('./target.cjs')

function createStabilizer(options = {}) {
  const clock = options.clock || { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }
  const limits = { ...TIMING, ...(options.limits || {}) }
  const thresholds = { ...TARGET_MOVEMENT, ...(options.thresholds || {}) }
  const trace = []

  function note(entry) {
    trace.push({ at: clock.now(), ...entry })
    return entry
  }

  /**
   * Plan §12/§13: wait until a condition is true, polling on a short interval.
   * The wait is conditional — the timeout is the *ceiling*, not the duration.
   */
  async function waitFor(check, waitOptions = {}) {
    const timeoutMs = Number.isFinite(waitOptions.timeoutMs) ? waitOptions.timeoutMs : limits.defaultWaitTimeoutMs
    const pollMs = Number.isFinite(waitOptions.pollMs) ? waitOptions.pollMs : limits.eventPollMs
    const startedAt = clock.now()
    let attempts = 0
    let lastValue
    for (;;) {
      attempts += 1
      lastValue = await check({ attempt: attempts, elapsedMs: clock.now() - startedAt })
      if (lastValue) {
        return { ok: true, waitedMs: clock.now() - startedAt, attempts, value: lastValue }
      }
      if (clock.now() - startedAt >= timeoutMs) {
        return { ok: false, waitedMs: clock.now() - startedAt, attempts, value: lastValue, timedOut: true }
      }
      await clock.sleep(Math.min(pollMs, Math.max(0, timeoutMs - (clock.now() - startedAt))))
    }
  }

  /**
   * Plan §9/§10/§13/§24. Settles before acting:
   *
   *   1. spend the action's minimum settle (short forced delay)
   *   2. observe; is the UI stable *and* is the target where it was?
   *   3. if not, add one dynamic cooldown step (plan §24: +80 ms) and re-check
   *   4. past the ceiling, stop waiting and hand back `WAIT_STATE` so the caller
   *      escalates to a conditional wait or a re-observe instead of sleeping on
   *
   * @param {object} input
   * @param {object} input.action normalized action carrying its stabilization block
   * @param {object|null} input.previous the earlier target resolution
   * @param {function} input.observe async () => world state
   * @param {function} [input.locateTarget] async () => resolved target again
   * @param {string} [input.waitForState] an optional condition the caller wants
   *   satisfied before acting (a toast, a load state, an enabled control)
   */
  async function settle(input) {
    const action = input.action
    const minimumMs = action && action.stabilization ? action.stabilization.minimumMs : limits.settleMinMs
    const maximumMs = action && action.stabilization ? action.stabilization.maximumMs : limits.settleMaxMs
    const startedAt = clock.now()
    let waitedMs = 0

    if (minimumMs > 0) {
      await clock.sleep(minimumMs)
      waitedMs = clock.now() - startedAt
    }

    let attempts = 0
    let lastWorld = input.world || null
    let lastSignals = null
    for (;;) {
      attempts += 1
      const world = await input.observe()
      const currentResolution = typeof input.locateTarget === 'function' ? await input.locateTarget() : null
      lastSignals = stabilitySignals(lastWorld, world, { previousResolution: input.previous, currentResolution })
      const comparison = revalidate(input.previous, currentResolution, thresholds)
      const elapsed = clock.now() - startedAt
      // A target that is already known to have moved is not something to wait
      // for: re-observe now (plan §10: "movement > 10 px → re-observe").
      if (comparison.verdict === 'stale') {
        return note({
          kind: 'settle',
          verdict: 'reobserve',
          waitedMs: elapsed,
          attempts,
          signals: lastSignals,
          revalidation: comparison,
          resolved: currentResolution,
          world,
          reason: `target moved ${comparison.movement}px during the settle window - re-observe before acting`
        })
      }
      // A refreshed coordinate (3–10 px) is usable, so the box movement itself
      // is not a blocking instability signal.
      const blocking = lastSignals.reasons.filter((reason) => reason !== 'target bounding box moved')
      const stable = blocking.length === 0
      lastWorld = world

      if (stable) {
        return note({
          kind: 'settle',
          verdict: comparison.verdict === 'updated' ? 'updated' : 'stable',
          waitedMs: elapsed,
          attempts,
          signals: lastSignals,
          revalidation: comparison,
          resolved: currentResolution,
          world
        })
      }
      if (elapsed >= maximumMs) {
        return note({
          kind: 'settle',
          verdict: 'wait_state',
          waitedMs: elapsed,
          attempts,
          signals: lastSignals,
          revalidation: comparison,
          resolved: currentResolution,
          world,
          reason: 'the UI was still changing when the settle ceiling was reached'
        })
      }
      // Plan §24: one dynamic step per unstable observation, never the whole
      // remaining budget in one sleep.
      const cooldown = dynamicCooldown({ uiChanging: !lastSignals.stable, targetMoved: comparison.verdict === 'updated' })
      const step = Math.max(0, Math.min(cooldown.ms, maximumMs - elapsed))
      if (step > 0) await clock.sleep(step)
      waitedMs = clock.now() - startedAt
    }
  }

  /**
   * Plan §11/§24: the dynamic cooldown depends only on what this step has just
   * observed. Each active signal adds one step (80 ms) and the ladder stops at
   * the soft ceiling — past it the caller must use an event wait instead.
   */
  function dynamicCooldown(state = {}) {
    let ms = limits.cooldownBaseMs
    const signals = []
    if (state.uiChanging) { ms += limits.cooldownStepMs; signals.push('ui-changing') }
    if (state.targetMoved) { ms += limits.cooldownStepMs; signals.push('target-moved') }
    if (state.previousMiss) { ms += limits.cooldownStepMs; signals.push('previous-miss') }
    if (state.windowChanged) { ms += limits.cooldownStepMs; signals.push('window-changed') }
    if (state.animationDetected) { ms += limits.cooldownStepMs; signals.push('animation') }
    if (state.navigationPending) {
      return { ms: Math.min(limits.navigationCooldownMs, limits.navigationCooldownMaxMs), signals: [...signals, 'navigation-pending'], ceiling: 'navigation' }
    }
    const ceiling = state.escalate ? limits.cooldownHardMaxMs : limits.cooldownSoftMaxMs
    if (ms > ceiling) return { ms: ceiling, signals, ceiling: 'soft-max', exhausted: true }
    return { ms, signals, ceiling: 'soft', exhausted: ms >= limits.cooldownSoftMaxMs }
  }

  /**
   * Plan §11: a bounded grace period after acting, so a click that needs 120 ms
   * to take effect is not mistaken for a miss (plan §17).
   */
  async function grace(action, overrideMs) {
    const ms = Number.isFinite(overrideMs)
      ? overrideMs
      : action && action.stabilization
        ? Math.max(limits.graceMinMs, Math.min(limits.graceMaxMs, action.stabilization.minimumMs + limits.graceMinMs))
        : limits.gracePreferredMs
    const bounded = Math.max(0, Math.min(limits.graceMaxMs, ms))
    const startedAt = clock.now()
    if (bounded > 0) await clock.sleep(bounded)
    return note({ kind: 'grace', waitedMs: clock.now() - startedAt, requestedMs: ms, appliedMs: bounded })
  }

  /**
   * Plan §13. Cheap stability signals only — no screenshot required:
   * DOM revision, accessibility tree digest, the window's own state and the
   * target's bounding box and actionability.
   */
  function stabilitySignals(previousWorld, currentWorld, extra = {}) {
    const reasons = []
    if (!currentWorld) return { stable: false, reasons: ['no observation'] }
    if (currentWorld.loading === true || currentWorld.readyState === 'loading') reasons.push('page still loading')
    if (previousWorld) {
      if (previousWorld.revision !== null && currentWorld.revision !== null && previousWorld.revision !== currentWorld.revision) {
        reasons.push('DOM changed')
      }
      if (previousWorld.axSignature && currentWorld.axSignature && previousWorld.axSignature !== currentWorld.axSignature) {
        reasons.push('accessibility tree changed')
      }
      if (previousWorld.windowSignature && currentWorld.windowSignature && previousWorld.windowSignature !== currentWorld.windowSignature) {
        reasons.push('window state changed')
      }
      if (previousWorld.dialogSignature !== currentWorld.dialogSignature) reasons.push('dialogs changed')
      if (previousWorld.signature && currentWorld.signature && previousWorld.signature !== currentWorld.signature) {
        reasons.push('world state changed')
      }
    }
    const previousResolution = extra.previousResolution
    const currentResolution = extra.currentResolution
    if (previousResolution && currentResolution && previousResolution.bbox && currentResolution.bbox) {
      const box = previousResolution.bbox
      const next = currentResolution.bbox
      if (box.x !== next.x || box.y !== next.y || box.width !== next.width || box.height !== next.height) {
        reasons.push('target bounding box moved')
      }
    }
    if (currentResolution && currentResolution.disabled === true) reasons.push('target is disabled')
    if (currentResolution && currentResolution.visible === false) reasons.push('target is not visible')
    return { stable: reasons.length === 0, reasons }
  }

  function trace_() {
    return trace.slice()
  }

  return { waitFor, settle, grace, dynamicCooldown, stabilitySignals, trace: trace_, limits, thresholds }
}

module.exports = { createStabilizer }
