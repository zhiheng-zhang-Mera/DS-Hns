'use strict'

/**
 * Computer Use Runtime: transient stabilization.
 *
 * This module is the answer to the two failure modes every computer-use agent
 * hits: acting on a target that has already moved, and *concluding failure*
 * before the UI has had a chance to react.
 *
 * It is also the **only** place transient UI timing is decided:
 * every caller asks this module when it is safe to act and when it is safe to
 * verify, instead of inventing its own delay.
 *
 * The policy is fixed and deliberately boring:
 *
 *   short forced delay  +  long conditional wait
 *   minimum settle → check stability → revalidate → act
 *   act → bounded grace → observe events
 *
 * Nothing here is remembered between tasks: the ladders below depend only on the
 * *current* step's observations. No application-specific latency
 * profile appears in this file, and none ever will.
 */

const { TIMING, TARGET_MOVEMENT } = require('./constants.cjs')
const { revalidate } = require('./target.cjs')

/**
 * The complete signal vocabulary.
 *
 * Both spellings are accepted — the camelCase key and the hyphenated name the
 * recovery ladder emits — because the two existed side by side and a signal that
 * is silently unrecognised is a signal that silently does nothing.
 */
const SIGNALS = Object.freeze({
  UI_CHANGING: 'uiChanging',
  TARGET_MOVED: 'targetMoved',
  PREVIOUS_MISS: 'previousMiss',
  WINDOW_CHANGED: 'windowChanged',
  ANIMATION_DETECTED: 'animationDetected',
  NAVIGATION_PENDING: 'navigationPending',
  MODAL_APPEARED: 'modalAppeared',
  TARGET_DETACHED: 'targetDetached'
})

const SIGNAL_LIST = Object.freeze(Object.values(SIGNALS))

/** Hyphenated aliases the recovery ladder and the log use. */
const SIGNAL_ALIASES = Object.freeze({
  'ui-changing': SIGNALS.UI_CHANGING,
  'target-moved': SIGNALS.TARGET_MOVED,
  'previous-miss': SIGNALS.PREVIOUS_MISS,
  'window-changed': SIGNALS.WINDOW_CHANGED,
  animation: SIGNALS.ANIMATION_DETECTED,
  'navigation-pending': SIGNALS.NAVIGATION_PENDING,
  'modal-appeared': SIGNALS.MODAL_APPEARED,
  'target-detached': SIGNALS.TARGET_DETACHED
})

/**
 * Normalize anything signal-shaped into the canonical camelCase keys.
 *
 * Accepts an array of hyphenated names (what recovery emits), a partial object,
 * or a mix. Unknown names are dropped rather than silently treated as false —
 * the caller can compare `unknown` against what it passed.
 *
 * @returns {{signals:object, unknown:string[]}}
 */
function normalizeSignals(input) {
  const signals = {}
  const unknown = []
  for (const name of SIGNAL_LIST) signals[name] = false
  if (!input) return { signals, unknown }
  if (Array.isArray(input)) {
    for (const entry of input) {
      const key = SIGNAL_ALIASES[String(entry)] || (SIGNAL_LIST.includes(String(entry)) ? String(entry) : null)
      if (key) signals[key] = true
      else unknown.push(String(entry))
    }
    return { signals, unknown }
  }
  if (typeof input === 'object') {
    for (const [name, value] of Object.entries(input)) {
      const key = SIGNAL_ALIASES[name] || (SIGNAL_LIST.includes(name) ? name : null)
      if (!key) {
        if (value) unknown.push(name)
        continue
      }
      signals[key] = Boolean(value)
    }
  }
  return { signals, unknown }
}

function createStabilizer(options = {}) {
  const clock = options.clock || { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }
  const limits = { ...TIMING, ...(options.limits || {}) }
  const thresholds = { ...TARGET_MOVEMENT, ...(options.thresholds || {}) }
  const trace = []

  function note(entry) {
    trace.push({ at: clock.now(), ...entry })
    if (trace.length > 200) trace.splice(0, trace.length - 200)
    return entry
  }

  /**
   * Wait until a condition is true, polling on a short interval.
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
   * Settles before acting:
   *
   *   1. spend the action's minimum settle (short forced delay)
   *   2. observe; is the UI stable *and* is the target where it was?
   *   3. if not, add one dynamic cooldown step and re-check, feeding every signal
   *      the observation produced into the cooldown
   *   4. past the ceiling, stop waiting and hand back `WAIT_STATE` so the caller
   *      escalates to a conditional wait or a re-observe instead of sleeping on
   *
   * The forced minimum can never push the wait past the action's own ceiling: the
   * ceiling is the bound, and a minimum that exceeds it is clamped to it rather
   * than slept through (never an unbounded sleep).
   *
   * @param {object} input
   * @param {object} input.action normalized action carrying its stabilization block
   * @param {object|null} input.previous the earlier target resolution
   * @param {function} input.observe async () => world state
   * @param {function} [input.locateTarget] async () => resolved target again
   * @param {string} [input.waitForState] an optional condition the caller wants
   *   satisfied before acting (a toast, a load state, an enabled control)
   * @param {object} [input.signals] extra signals known *before* observing
   *   (`previousMiss`, `windowChanged`, `animationDetected`, `navigationPending`)
   */
  async function settle(input) {
    const action = input.action
    const minimumMs = action && action.stabilization ? action.stabilization.minimumMs : limits.settleMinMs
    const maximumMs = action && action.stabilization ? action.stabilization.maximumMs : limits.settleMaxMs
    const startedAt = clock.now()
    let waitedMs = 0
    // Signals the caller already knows about (a previous miss, a window change)
    // are part of this step's state, so they count towards the cooldown from the
    // first observation instead of being rediscovered by it.
    const carried = normalizeSignals(input.signals).signals

    const boundedMinimum = Math.max(0, Math.min(minimumMs, maximumMs))
    if (boundedMinimum > 0) {
      await clock.sleep(boundedMinimum)
      waitedMs = clock.now() - startedAt
    }

    let attempts = 0
    let lastWorld = input.world || null
    let lastSignals = null
    for (;;) {
      attempts += 1
      const world = await input.observe()
      const currentResolution = typeof input.locateTarget === 'function' ? await input.locateTarget() : null
      const observed = stabilitySignals(lastWorld, world, { previousResolution: input.previous, currentResolution })
      // The detected signals and the carried ones are merged, not replaced: a
      // modal that appeared during this observation and a miss from the previous
      // step are both true.
      lastSignals = mergeSignalSets(observed, carried)
      const comparison = revalidate(input.previous, currentResolution, thresholds)
      const elapsed = clock.now() - startedAt
      // A target that is already known to have moved or vanished is not something
      // to wait for: re-observe now (a movement past the update threshold means
      // the coordinate is stale).
      if (comparison.verdict === 'stale' || comparison.verdict === 'missing') {
        return note({
          kind: 'settle',
          verdict: 'reobserve',
          waitedMs: elapsed,
          attempts,
          signals: lastSignals,
          revalidation: comparison,
          resolved: currentResolution,
          world,
          reason: comparison.verdict === 'missing'
            ? 'the target could not be re-resolved during the settle window - re-observe before acting'
            : `target moved ${comparison.movement}px during the settle window - re-observe before acting`
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
      // One dynamic step per unstable observation, never the whole
      // remaining budget in one sleep. Every signal the observation produced is
      // forwarded, so the step reflects *why* the UI is unstable.
      const cooldown = dynamicCooldown(signalInputs(lastSignals))
      const step = Math.max(0, Math.min(cooldown.ms, maximumMs - elapsed))
      if (step > 0) await clock.sleep(step)
      waitedMs = clock.now() - startedAt
    }
  }

  /** Turn a signal set into `dynamicCooldown`'s input, carrying the reasons too. */
  function signalInputs(signals) {
    return {
      uiChanging: !signals.stable,
      targetMoved: signals.reasons.includes('target bounding box moved'),
      previousMiss: Boolean(signals.previousMiss),
      windowChanged: Boolean(signals.windowChanged),
      animationDetected: Boolean(signals.animationDetected),
      navigationPending: Boolean(signals.navigationPending),
      modalAppeared: Boolean(signals.modalAppeared),
      targetDetached: Boolean(signals.targetDetached)
    }
  }

  function mergeSignalSets(observed, carried) {
    const reasons = observed.reasons.slice()
    const merged = {
      stable: observed.stable,
      reasons,
      previousMiss: Boolean(carried.previousMiss),
      windowChanged: Boolean(carried.windowChanged) || reasons.includes('window state changed'),
      animationDetected: Boolean(carried.animationDetected) || reasons.includes('animation detected'),
      navigationPending: Boolean(carried.navigationPending) || reasons.includes('page still loading'),
      modalAppeared: Boolean(carried.modalAppeared) || reasons.includes('dialogs changed'),
      targetDetached: Boolean(carried.targetDetached) || reasons.includes('target is not visible') || reasons.includes('target is disabled')
    }
    return merged
  }

  /**
   * The dynamic cooldown depends only on what this step has just
   * observed. Each active signal adds one step (80 ms) and the ladder stops at
   * the soft ceiling — past it the caller must use an event wait instead.
   *
   * Every signal in the vocabulary is consumed here: a signal the
   * stabilizer can detect but does not act on is a signal that does nothing.
   */
  function dynamicCooldown(state = {}) {
    let ms = limits.cooldownBaseMs
    const signals = []
    if (state.uiChanging) { ms += limits.cooldownStepMs; signals.push('ui-changing') }
    if (state.targetMoved) { ms += limits.cooldownStepMs; signals.push('target-moved') }
    if (state.previousMiss) { ms += limits.cooldownStepMs; signals.push('previous-miss') }
    if (state.windowChanged) { ms += limits.cooldownStepMs; signals.push('window-changed') }
    if (state.animationDetected) { ms += limits.cooldownStepMs; signals.push('animation') }
    if (state.modalAppeared) { ms += limits.cooldownStepMs; signals.push('modal-appeared') }
    if (state.targetDetached) { ms += limits.cooldownStepMs; signals.push('target-detached') }
    // A navigation in flight is the one case where a short fixed step is wrong:
    // the right answer is to wait for the load state, so the cooldown jumps to the
    // navigation budget and the caller is expected to use `waitFor`.
    if (state.navigationPending) {
      return { ms: Math.min(limits.navigationCooldownMs, limits.navigationCooldownMaxMs), signals: [...signals, 'navigation-pending'], ceiling: 'navigation' }
    }
    const ceiling = state.escalate ? limits.cooldownHardMaxMs : limits.cooldownSoftMaxMs
    if (ms > ceiling) return { ms: ceiling, signals, ceiling: 'soft-max', exhausted: true }
    return { ms, signals, ceiling: 'soft', exhausted: ms >= limits.cooldownSoftMaxMs }
  }

  /**
   * A bounded grace period after acting, so a click that needs 120 ms
   * to take effect is not mistaken for a miss.
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
   * Cheap stability signals only — no screenshot required:
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
    if (extra.miss && extra.miss.missed === true) reasons.push('previous action missed')
    if (extra.animation === true) reasons.push('animation detected')
    return { stable: reasons.length === 0, reasons }
  }

  /**
   * The same signals, expanded into the named vocabulary.
   *
   * `stabilitySignals` answers "may I act"; this answers "why not", in the terms
   * the cooldown ladder and the recovery decision both consume.
   */
  function detectSignals(previousWorld, currentWorld, extra = {}) {
    const observed = stabilitySignals(previousWorld, currentWorld, extra)
    const reasons = observed.reasons
    const merged = {
      stable: observed.stable,
      reasons,
      uiChanging: !observed.stable,
      targetMoved: reasons.includes('target bounding box moved'),
      previousMiss: Boolean(extra.miss && extra.miss.missed === true),
      windowChanged: reasons.includes('window state changed'),
      animationDetected: reasons.includes('animation detected'),
      navigationPending: reasons.includes('page still loading'),
      modalAppeared: reasons.includes('dialogs changed'),
      targetDetached: reasons.includes('target is not visible') || reasons.includes('target is disabled')
    }
    return merged
  }

  function trace_() {
    return trace.slice()
  }

  return {
    waitFor,
    settle,
    grace,
    dynamicCooldown,
    stabilitySignals,
    detectSignals,
    signalInputs,
    normalizeSignals,
    trace: trace_,
    limits,
    thresholds,
    SIGNALS,
    SIGNAL_LIST
  }
}

module.exports = { createStabilizer, SIGNALS, SIGNAL_LIST, SIGNAL_ALIASES, normalizeSignals }
