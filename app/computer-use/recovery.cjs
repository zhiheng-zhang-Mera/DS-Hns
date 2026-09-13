'use strict'

/**
 * Computer Use Runtime: the recovery ladder (plan §18, §19, §21, §22;
 * Update-Plan/24h.md Task 17).
 *
 *   retry  →  revalidate  →  re-observe  →  alternative action  →  replan  →  escalate
 *
 * Recovery is explicitly *not* "run the same thing again". The ladder knows
 * which rung comes next, what an alternative interaction is for a given action
 * (a swallowed mouse click becomes an accessibility invoke, which becomes a DOM
 * click), and when the budget is spent, so the runtime can fail locally with
 * context instead of looping (plan §21: 禁止无限 retry).
 *
 * It is also **not** allowed to change what the task is (24h.md Task 17). It can
 * never touch the goal, the success criteria or the plan; the most it can say is
 * that a human or an upper layer has to decide. Every decision therefore carries a
 * *verdict* from a closed vocabulary:
 *
 *   RETRYABLE               another attempt at the same action can work
 *   ALTERNATIVE_AVAILABLE   the same intent can be carried another way
 *   REPLAN_REQUIRED         this action cannot be recovered; a different action is
 *                           needed — a *report*, never a replanning act
 *   USER_ACTION_REQUIRED    a human must decide (a destructive confirmation the
 *                           contract did not authorize)
 *   FAILED                  stop with the context that was gathered
 *
 * Screenshot escalation is part of the same ladder (plan §22): a first miss may
 * never buy a full-screen capture. The visual level climbs one rung at a time.
 */

const { RETRY, SCREENSHOT_LEVELS, DESTRUCTIVE_MODES } = require('./constants.cjs')
const { CODES, ComputerUseError } = require('./errors.cjs')
const { fallbackChannels, CHANNEL_CONTROLLER, CHANNEL_CAPABILITY } = require('./routing.cjs')
const { STALL_RECOVERY_LADDER } = require('./stall.cjs')

/** The documented rungs, in order. Kept in step with what `decide()` returns. */
const RECOVERY_STEPS = Object.freeze([
  'retry',
  'revalidate',
  'reobserve',
  'alternative_action',
  'replan',
  'escalate',
  'fail'
])

/** The verdict vocabulary. Nothing else may be reported (Task 17). */
const RECOVERY_VERDICTS = Object.freeze({
  RETRYABLE: 'RETRYABLE',
  ALTERNATIVE_AVAILABLE: 'ALTERNATIVE_AVAILABLE',
  REPLAN_REQUIRED: 'REPLAN_REQUIRED',
  USER_ACTION_REQUIRED: 'USER_ACTION_REQUIRED',
  FAILED: 'FAILED'
})

/** Which verdict each ladder rung produces. */
const VERDICT_BY_STEP = Object.freeze({
  retry: RECOVERY_VERDICTS.RETRYABLE,
  alternative_action: RECOVERY_VERDICTS.ALTERNATIVE_AVAILABLE,
  replan: RECOVERY_VERDICTS.REPLAN_REQUIRED,
  escalate: RECOVERY_VERDICTS.REPLAN_REQUIRED,
  fail: RECOVERY_VERDICTS.FAILED
})

/**
 * Failures that need a human rather than another attempt: a destructive
 * confirmation nobody authorized, a capability the contract withholds, a
 * workspace that is not there. Retrying those would either loop or, worse,
 * succeed at something nobody approved.
 */
const USER_ACTION_CODES = Object.freeze([
  CODES.DESTRUCTIVE_NEEDS_CONFIRMATION,
  CODES.DESTRUCTIVE_FORBIDDEN,
  CODES.SAFETY_REFUSED,
  CODES.MODAL_BLOCKING,
  CODES.WORKSPACE_UNAVAILABLE,
  CODES.WORKSPACE_MISMATCH,
  CODES.CAPABILITY_NOT_ALLOWED,
  // Task 9: the channel this action needs is gone. Retrying spends the budget
  // against a capability that is not coming back on its own, so the honest
  // answer is "a decision or a different channel is needed" (Task 20).
  CODES.CAPABILITY_UNAVAILABLE,
  CODES.STATE_INTEGRITY_UNCERTAIN
])

function createRecoveryController(options = {}) {
  const maxRetriesPerAction = Number.isInteger(options.maxRetriesPerAction) ? options.maxRetriesPerAction : RETRY.maxAttempts
  const maxStallRecoveries = Number.isInteger(options.maxStallRecoveries) ? options.maxStallRecoveries : 2
  const visualLevelCeiling = Number.isInteger(options.visualLevelCeiling) ? options.visualLevelCeiling : SCREENSHOT_LEVELS.FULL
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const decisions = []

  /**
   * Decides what happens after a failed attempt.
   *
   * @param {object} failure
   * @param {object} failure.action the action that failed
   * @param {number} failure.attempt 1-based attempt number
   * @param {Error} failure.error typed failure
   * @param {object} [failure.miss] miss detection result
   * @param {number} [failure.stallRecoveries] stall recoveries already spent
   * @param {string} [failure.visualLevel] current screenshot level for this step
   * @param {boolean} [failure.retryable] whether the error allows another attempt
   */
  function decide(failure = {}) {
    const action = failure.action
    const attempt = Number.isInteger(failure.attempt) ? failure.attempt : 1
    const error = failure.error || null
    const retryable = failure.retryable === undefined
      ? (!error || error.retryable !== false)
      : Boolean(failure.retryable)
    const attemptsAllowed = action && action.retry ? action.retry.maxAttempts : maxRetriesPerAction
    const stallRecoveries = Number.isInteger(failure.stallRecoveries) ? failure.stallRecoveries : 0
    const visualLevel = failure.visualLevel || SCREENSHOT_LEVELS.NONE
    // Plan §21 ("禁止无限 retry"): the ladder for one step is bounded by a round
    // count, independent of how the attempts were spent — retry, alternative
    // and replan all draw from the same small budget.
    const recoveryRounds = Number.isInteger(failure.recoveryRounds) ? failure.recoveryRounds : 0
    const maxRecoveryRounds = Number.isInteger(failure.maxRecoveryRounds)
      ? failure.maxRecoveryRounds
      : attemptsAllowed + 2

    const base = { attempt, attemptsAllowed, retryable, recoveryRounds, maxRecoveryRounds, code: error && error.code ? error.code : null, at: now() }

    // Rung 0 — a failure that needs a human, not another attempt. This is checked
    // before the retry rung on purpose: retrying a refusal would either loop or
    // eventually succeed at something nobody authorized.
    if (USER_ACTION_CODES.includes(base.code)) {
      return record({
        ...base,
        step: 'fail',
        verdict: RECOVERY_VERDICTS.USER_ACTION_REQUIRED,
        reason: `${base.code} needs a decision the runtime may not make: ${error && error.message ? error.message : 'the action was refused'}`,
        terminal: true
      })
    }

    if (!retryable) {
      return record({
        ...base,
        step: 'fail',
        verdict: RECOVERY_VERDICTS.FAILED,
        reason: `failure ${base.code || 'unknown'} is not retryable`,
        terminal: true
      })
    }

    if (recoveryRounds >= maxRecoveryRounds) {
      return record({
        ...base,
        step: 'fail',
        verdict: RECOVERY_VERDICTS.FAILED,
        reason: `the recovery ladder for this step is exhausted (${recoveryRounds}/${maxRecoveryRounds} rounds) - failing with context`,
        terminal: true,
        visualLevel: visualLevelCeiling
      })
    }

    // Rung 1 — a bounded retry, but only after revalidating the target
    // (plan §18: "revalidate target → retry"). `attempt` is the attempt that
    // just failed, so another is available only while attempt < maxAttempts.
    if (attempt < attemptsAllowed) {
      const escalateVisual = attempt > 1
      return record({
        ...base,
        step: 'retry',
        verdict: RECOVERY_VERDICTS.RETRYABLE,
        reason: `attempt ${attempt} of ${attemptsAllowed} failed (${base.code || 'unknown'}) - revalidate the target and retry`,
        revalidate: true,
        cooldownSignals: collectCooldownSignals(failure),
        visualLevel: escalateVisual ? nextVisualLevel(visualLevel, visualLevelCeiling) : visualLevel
      })
    }

    // Rung 2 — the same intent through a different channel. This is what turns
    // a swallowed mouse click into an accessibility invoke or a DOM click.
    const alternative = alternativeAction(action, {
      attempt,
      // The channel the failed attempt actually used (and the coordinate it
      // used) is what makes the next attempt a *different* interaction rather
      // than the same one again.
      usedChannel: failure.usedChannel || failure.channel || null,
      point: failure.point || null,
      resolved: failure.resolved || null,
      // Plan §35: the contract is the authority — an alternative that needs a
      // capability the contract withheld is not an alternative at all.
      allowedCapabilities: failure.allowedCapabilities || null,
      context: failure.context || {}
    })
    if (alternative && action && action.retry && action.retry.allowAlternative !== false) {
      return record({
        ...base,
        step: 'alternative_action',
        verdict: RECOVERY_VERDICTS.ALTERNATIVE_AVAILABLE,
        reason: `retries are exhausted - switching ${action.type} to ${alternative.type} (different interaction channel)`,
        alternative,
        revalidate: true,
        cooldownSignals: [...collectCooldownSignals(failure), 'previous-miss'],
        visualLevel: nextVisualLevel(visualLevel, visualLevelCeiling)
      })
    }

    // Rung 3 — re-observe from scratch, then replan.
    if (stallRecoveries < maxStallRecoveries) {
      return record({
        ...base,
        step: 'replan',
        verdict: RECOVERY_VERDICTS.REPLAN_REQUIRED,
        reason: `no alternative interaction exists for ${action ? action.type : 'the action'} - re-observe and replan`,
        revalidate: true,
        reobserve: true,
        cooldownSignals: [...collectCooldownSignals(failure), 'previous-miss'],
        visualLevel: nextVisualLevel(visualLevel, visualLevelCeiling)
      })
    }

    // Rung 4 — out of budget: stop with everything that was observed.
    return record({
      ...base,
      step: 'fail',
      verdict: RECOVERY_VERDICTS.FAILED,
      reason: `recovery budget exhausted (${stallRecoveries}/${maxStallRecoveries} stall recoveries) - failing with context`,
      terminal: true,
      visualLevel: visualLevelCeiling
    })
  }

  /**
   * Plan §22: one rung at a time, and the full screen only when the contract
   * allows it and the cheaper levels are exhausted.
   */
  function nextVisualLevel(current, ceiling = visualLevelCeiling) {
    const level = Number.isInteger(current) ? current : SCREENSHOT_LEVELS.NONE
    const next = Math.min(ceiling, level + 1)
    return next
  }

  function collectCooldownSignals(failure) {
    const signals = []
    const error = failure.error
    const code = error && error.code
    if (code === CODES.TARGET_STALE) signals.push('target-moved')
    if (code === CODES.UI_UNSTABLE) signals.push('ui-changing')
    if (code === CODES.WINDOW_MISMATCH) signals.push('window-changed')
    if (failure.miss && failure.miss.missed) signals.push('previous-miss')
    if (code === CODES.VERIFICATION_FAILED || code === CODES.ACTION_MISSED) signals.push('previous-miss')
    return [...new Set(signals)]
  }

  /**
   * Records a stall recovery (plan §21) and reports the next ladder rung.
   *
   * The ladder itself lives in `stall.cjs` so there is exactly one definition of
   * what the rungs are (24h.md Task 6: the executor, the recovery module and the
   * stall module must not each carry their own copy).
   */
  function stallStep(index) {
    const position = Math.max(0, Math.min(Number(index) || 0, STALL_RECOVERY_LADDER.length - 1))
    const rung = STALL_RECOVERY_LADDER[position]
    return record({
      step: 'stall',
      ladderStep: rung.step,
      description: rung.description,
      index: position,
      terminal: rung.step === 'fail_with_context',
      at: now(),
      reason: `stall recovery rung ${position + 1}/${STALL_RECOVERY_LADDER.length}: ${rung.step}`
    })
  }

  function record(decision) {
    decisions.push(decision)
    return decision
  }

  return {
    maxRetriesPerAction,
    maxStallRecoveries,
    decide,
    stallStep,
    nextVisualLevel,
    decisions() {
      return decisions.slice()
    }
  }
}

/**
 * Plan §18 — what else could carry the same intent.
 * The mapping is by *intent*, not by action type: "activate this element",
 * "put this text in this field", "point at this place".
 */
function alternativeAction(action, context = {}) {
  if (!action) return null
  const attempts = context.attempt || 1
  const allowed = Array.isArray(context.allowedCapabilities) && context.allowedCapabilities.length
    ? context.allowedCapabilities
    : null
  // A visual target has no DOM node and no accessibility node by definition, so
  // the only meaningful alternatives are the ones that can click pixels.
  const visualTarget = Boolean(action.target && action.target.visual)
  const channels = fallbackChannels(action).filter((channel) => {
    if (visualTarget && (channel === 'dom' || channel === 'accessibility')) return false
    if (!allowed) return true
    const capability = CHANNEL_CAPABILITY[channel]
    // A channel with no declared capability (a host API) is always allowed.
    return !capability || allowed.includes(capability)
  })
  const usedChannel = context.usedChannel || null
  const remaining = channels.filter((channel) => channel !== usedChannel)
  if (!remaining.length) return null

  const intent = intentOf(action)
  const candidates = remaining.map((channel) => ({ channel, action: convert(action, intent, channel, context) })).filter((entry) => entry.action)
  if (!candidates.length) return null
  // Prefer the cheapest channel that has not been tried yet.
  const preferred = candidates.find((entry) => entry.channel !== 'gui') || candidates[0]
  const alternative = { ...preferred.action }
  alternative.id = action.id ? `${action.id}#alt${attempts}` : null
  alternative.description = action.description ? `${action.description} (alternative via ${preferred.channel})` : `alternative via ${preferred.channel}`
  alternative.retry = action.retry ? { ...action.retry, maxAttempts: 1 } : null
  return alternative
}

function intentOf(action) {
  switch (action.type) {
    case 'CLICK':
    case 'DOUBLE_CLICK':
    case 'RIGHT_CLICK':
    case 'DOM_CLICK':
    case 'ACCESSIBILITY_INVOKE':
      return 'activate'
    case 'TYPE':
    case 'DOM_TYPE':
    case 'ACCESSIBILITY_SET_VALUE':
      return 'set-text'
    case 'FOCUS':
      return 'focus'
    case 'SELECT':
    case 'DOM_SELECT':
      return 'select'
    case 'SCROLL':
      return 'scroll'
    default:
      return null
  }
}

function convert(action, intent, channel, context) {
  const type = mapType(intent, channel)
  if (!type) return null
  const converted = {
    ...action,
    type,
    // The channel is a property of the *execution*, not of the action schema,
    // so it travels in params where the executor reads it.
    params: { ...action.params, __channel: channel },
    channel
  }
  if (channel === 'gui' && intent === 'activate') {
    const point = context.point
      || (action.target && action.target.point)
      || (action.params && action.params.point)
      || (context.resolved && context.resolved.point)
    if (!point) return null
    converted.params.point = point
  }
  if ((channel === 'dom' || channel === 'accessibility') && !action.target) return null
  return converted
}

function mapType(intent, channel) {
  const table = {
    activate: { dom: 'DOM_CLICK', accessibility: 'ACCESSIBILITY_INVOKE', gui: 'CLICK', vision: 'CLICK' },
    'set-text': { dom: 'DOM_TYPE', accessibility: 'ACCESSIBILITY_SET_VALUE', gui: 'TYPE' },
    focus: { dom: 'FOCUS', accessibility: 'FOCUS', gui: 'FOCUS' },
    select: { dom: 'DOM_SELECT', accessibility: 'SELECT', gui: 'SELECT' },
    scroll: { dom: 'SCROLL', gui: 'SCROLL' }
  }
  return (table[intent] || {})[channel] || null
}

/** The controller that owns the channel an alternative uses. */
function alternativeController(alternative) {
  const channel = alternative && alternative.channel ? alternative.channel : alternative && alternative.params ? alternative.params.__channel : null
  return channel ? CHANNEL_CONTROLLER[channel] || null : null
}

function exhaustedError(decision) {
  return new ComputerUseError(CODES.PLAN_EXHAUSTED, decision.reason || 'the recovery ladder is exhausted', {
    attempts: decision.attempt,
    code: decision.code || null
  })
}

module.exports = {
  createRecoveryController,
  alternativeAction,
  alternativeController,
  mapType,
  RECOVERY_STEPS,
  RECOVERY_VERDICTS,
  VERDICT_BY_STEP,
  USER_ACTION_CODES,
  exhaustedError
}
