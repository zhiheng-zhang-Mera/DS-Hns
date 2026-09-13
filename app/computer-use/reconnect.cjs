'use strict'

/**
 * Computer Use Runtime: bounded tool reconnection.
 *
 * Long watch means tools break while nothing else does: CDP disconnects, a UIA
 * handle goes stale, a shell child crashes, a window disappears. The answer is
 * never "remember what the app used to look like and guess" — it is:
 *
 *   mark the channel degraded
 *     → attempt a *bounded* reconnect
 *     → re-observe the current state through the tool that just came back
 *     → continue only if the contract is still valid
 *
 * Two rules make that safe:
 *
 *  - The attempt budget belongs to the *step*, not to the channel. A channel that
 *    reconnects on its own schedule is a channel that can retry forever.
 *  - A stale target is never reused. Whatever was resolved before the failure is
 *    discarded, and the reconnect's whole job is to make a *fresh* observation
 *    possible.
 */

const { CODES, ComputerUseError } = require('./errors.cjs')
const { CAPABILITY_CONTROLLER } = require('./constants.cjs')

/** Reconnect outcome vocabulary. */
const RECONNECT = Object.freeze({
  /** The channel is usable again and its context was rebuilt. */
  RECONNECTED: 'reconnected',
  /** The channel is down and the budget for this step is spent. */
  EXHAUSTED: 'exhausted',
  /** Nobody asked for a reconnect (the channel never failed). */
  NOT_NEEDED: 'not_needed',
  /** The reattach itself worked but the observation that followed did not. */
  CONTEXT_INVALID: 'context_invalid'
})

/** How many bounded attempts a step may spend per channel. */
const DEFAULT_MAX_ATTEMPTS = 2

/**
 * @param {object} [options]
 * @param {Function} [options.now]
 * @param {number} [options.maxAttempts] per step, per channel
 * @param {Function} [options.sleep] injectable delay (tests use a virtual clock)
 * @param {number} [options.backoffMs] the gap between attempts (bounded)
 * @param {number} [options.maxBackoffMs] the ceiling on that gap
 */
function createReconnectPolicy(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const sleep = typeof options.sleep === 'function' ? options.sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const maxAttempts = Number.isInteger(options.maxAttempts) && options.maxAttempts > 0 ? options.maxAttempts : DEFAULT_MAX_ATTEMPTS
  const backoffMs = Number.isFinite(options.backoffMs) && options.backoffMs >= 0 ? options.backoffMs : 120
  const maxBackoffMs = Number.isFinite(options.maxBackoffMs) && options.maxBackoffMs >= 0 ? options.maxBackoffMs : 400

  /** attempts spent this step, keyed by channel */
  const spent = new Map()
  const events = []

  function record(entry) {
    const noted = { at: now(), ...entry }
    events.push(noted)
    if (events.length > 100) events.splice(0, events.length - 100)
    return noted
  }

  function attemptsFor(channel) {
    return spent.get(String(channel)) || 0
  }

  function budget(channel) {
    const used = attemptsFor(channel)
    return { channel: String(channel), used, max: maxAttempts, remaining: Math.max(0, maxAttempts - used), exhausted: used >= maxAttempts }
  }

  /** A new step resets the budget: the ladder is per step, not per run. */
  function beginStep() {
    spent.clear()
    return { at: now() }
  }

  /**
   * Run a bounded reconnection.
   *
   * @param {object} input
   * @param {string} input.channel the channel that failed ('browser', 'desktop', 'vision', 'shell')
   * @param {Function} input.reattach async () => boolean|{ok, detail} — rebuild the transport
   * @param {Function} [input.observe] async () => state — the fresh observation that must succeed
   * @param {Function} [input.stillValid] () => boolean — is the contract still valid?
   * @returns {Promise<object>} a RECONNECT outcome; never throws
   */
  async function reconnect({ channel, reattach, observe, stillValid } = {}) {
    const name = String(channel || 'unknown')
    if (typeof reattach !== 'function') {
      return record({ channel: name, outcome: RECONNECT.EXHAUSTED, reason: 'no reattach function was supplied', attempts: 0 })
    }
    if (attemptsFor(name) >= maxAttempts) {
      return record({ channel: name, outcome: RECONNECT.EXHAUSTED, reason: `the reconnect budget for ${name} is spent (${maxAttempts} attempts)`, attempts: attemptsFor(name) })
    }

    let lastReason = null
    for (let index = 0; index < maxAttempts; index += 1) {
      spent.set(name, attemptsFor(name) + 1)
      const attempt = attemptsFor(name)
      let attached = false
      try {
        const result = await reattach({ channel: name, attempt, reason: lastReason })
        attached = result === undefined ? true : result === true || Boolean(result && result.ok !== false)
        if (!attached && result && result.reason) lastReason = String(result.reason)
      } catch (error) {
        lastReason = String(error && error.message ? error.message : error)
      }

      if (!attached) {
        record({ channel: name, outcome: 'attempt_failed', attempt, reason: lastReason })
        if (attempt >= maxAttempts) break
        await sleep(Math.min(maxBackoffMs, backoffMs * attempt))
        continue
      }

      // A transport that is back is not yet a usable context: the state has to be
      // re-observed through it, and the contract has to still hold.
      if (typeof stillValid === 'function') {
        let valid = true
        try {
          valid = stillValid() !== false
        } catch {
          valid = false
        }
        if (!valid) {
          return record({ channel: name, outcome: RECONNECT.EXHAUSTED, attempt, reason: 'the contract is no longer valid after the reconnect' })
        }
      }

      if (typeof observe === 'function') {
        try {
          const observed = await observe({ channel: name, attempt })
          if (observed === null || observed === undefined || observed === false) {
            return record({ channel: name, outcome: RECONNECT.CONTEXT_INVALID, attempt, reason: `${name} reattached but the state could not be re-observed` })
          }
          return record({ channel: name, outcome: RECONNECT.RECONNECTED, attempt, reason: `${name} is usable again with a fresh observation` })
        } catch (error) {
          return record({
            channel: name,
            outcome: RECONNECT.CONTEXT_INVALID,
            attempt,
            reason: `${name} reattached but observing the current state failed: ${error && error.message ? error.message : error}`
          })
        }
      }
      return record({ channel: name, outcome: RECONNECT.RECONNECTED, attempt, reason: `${name} reattached` })
    }

    return record({
      channel: name,
      outcome: RECONNECT.EXHAUSTED,
      attempts: attemptsFor(name),
      reason: `${name} did not come back within ${maxAttempts} bounded attempts${lastReason ? ` (${lastReason})` : ''}`
    })
  }

  /** The typed failure a spent budget produces, so the caller stops rather than guesses. */
  function exhaustedError(outcome) {
    return new ComputerUseError(
      CODES.RECONNECT_EXHAUSTED,
      outcome && outcome.reason ? outcome.reason : 'the reconnect budget is spent',
      { channel: outcome ? outcome.channel : null, attempts: outcome ? outcome.attempts : 0 }
    )
  }

  return {
    RECONNECT,
    maxAttempts,
    beginStep,
    reconnect,
    exhaustedError,
    budget,
    events() {
      return events.slice()
    }
  }
}

/**
 * Does this failure mean "the transport is gone" rather than "the action failed"?
 *
 * Only the transport failures are worth a reconnect: a stale target or a refused
 * capability is a *different* problem, and reconnecting for those would waste the
 * budget and hide the real cause.
 */
const TRANSPORT_CODES = Object.freeze([
  CODES.CONTROLLER_UNAVAILABLE,
  CODES.CONTROLLER_FAILED,
  CODES.CONTROLLER_TIMEOUT,
  CODES.CAPABILITY_UNAVAILABLE
])

function isTransportFailure(error) {
  if (!error) return false
  const code = error.code || (error.details && error.details.code) || null
  if (code && TRANSPORT_CODES.includes(code)) return true
  // A raw socket/pipe failure surfaces without one of our codes.
  const message = String(error.message || error)
  return /(disconnect|detach|socket|pipe|closed|ECONNRESET|EPIPE|target closed|no such session|not connected)/i.test(message)
}

/**
 * The channel a failure belongs to, when the error names one.
 *
 * An error that says which channel it came from wins over any hint the caller
 * has: the runtime must never attribute a browser failure to the desktop
 * channel and then spend the desktop channel's budget on it.
 */
function channelOfError(error, fallback = null) {
  const details = error && error.details ? error.details : {}
  const named = details.channel || details.controller || null
  return named ? String(named) : fallback
}

/**
 * The controller an action is expected to use, as a reconnect channel hint.
 *
 * A hint is only a hint: a failure nobody can attribute to a channel is never
 * guessed at, because reconnecting the wrong channel both wastes the budget and
 * hides the real cause.
 */
function channelHintFor(action, run = null) {
  if (run && run.lastRoute && run.lastRoute.controller) return String(run.lastRoute.controller)
  const capability = action && action.capability ? String(action.capability) : null
  return capability ? CAPABILITY_CONTROLLER[capability] || null : null
}

/**
 * The channel-level reconnect wiring for one execution.
 *
 * This is the topology the policy needs and cannot know by itself: which
 * controller implements a channel, how to ask that controller whether it is
 * back, and how to re-observe the world once it is. Keeping it here rather than
 * in the executor is what leaves the executor with orchestration instead of
 * transport plumbing.
 *
 * `reattach` is necessarily shallow: this layer is handed live controllers and
 * owns no attach seam of its own (the runtime host attaches the page), so
 * "reattach" means "ask the controller whether it is back and read its facts" —
 * the *proof* that the channel works is the fresh observation the policy takes
 * afterwards, never a guess about what the channel looked like before it broke.
 *
 * @param {object} deps
 * @param {object} deps.policy a policy from `createReconnectPolicy`
 * @param {object} deps.controllers controller id -> controller
 * @param {Function} deps.observe async (channel) => world
 * @param {Function} [deps.stillValid] () => boolean
 * @param {Function} [deps.onEvent] (event) => void
 * @param {Function} [deps.onReconnected] (channel) => void, to drop stale state
 */
function createChannelRecovery(deps = {}) {
  const policy = deps.policy
  if (!policy || typeof policy.reconnect !== 'function') {
    throw new ComputerUseError(CODES.CONTRACT_INVALID, 'channel recovery needs a reconnect policy')
  }
  const controllers = deps.controllers || {}
  const observe = typeof deps.observe === 'function' ? deps.observe : null
  const stillValid = typeof deps.stillValid === 'function' ? deps.stillValid : null
  const onEvent = typeof deps.onEvent === 'function' ? deps.onEvent : () => {}
  const onReconnected = typeof deps.onReconnected === 'function' ? deps.onReconnected : () => {}

  /** Re-attach one channel: ask the controller, then prove it with an observation. */
  function reattach(channel) {
    return async ({ attempt }) => {
      const controller = controllers[channel] || null
      if (!controller) return { ok: false, reason: `no controller implements the ${channel} channel` }
      if (typeof controller.probe === 'function') {
        const verdict = await Promise.resolve(controller.probe())
        if (verdict && verdict.available === false) return { ok: false, reason: verdict.reason || `${channel} is still unavailable` }
      }
      if (typeof controller.facts === 'function') await Promise.resolve(controller.facts())
      onEvent({ type: 'channel-reattach', channel, attempt })
      return { ok: true }
    }
  }

  /**
   * Rebuild a channel whose transport died, bounded by the policy's per-step
   * budget. On success the caller continues from the *fresh* observation, never
   * from the state — or the target — that was resolved before the failure.
   *
   * @returns {Promise<{ok:boolean, outcome:object, world:object|null, error:Error|null}>}
   */
  async function recover(channel, { action = null } = {}) {
    const name = String(channel || 'unknown')
    const outcome = await policy.reconnect({
      channel: name,
      reattach: reattach(name),
      stillValid,
      observe: observe ? async ({ channel: observedChannel, attempt }) => observe({ channel: observedChannel, attempt, action }) : undefined
    })
    onEvent({ type: 'reconnect', channel: name, outcome: outcome.outcome, attempt: outcome.attempt, reason: outcome.reason })
    if (outcome.outcome !== RECONNECT.RECONNECTED) {
      // EXHAUSTED and CONTEXT_INVALID are the same verdict for the step: the
      // channel is not usable, so the step fails with that code rather than a
      // generic controller error.
      return { ok: false, outcome, world: null, error: policy.exhaustedError(outcome) }
    }
    // A stale target is never reused, and whatever cached the channel's
    // availability has to hear that it came back.
    onReconnected(name)
    return { ok: true, outcome, world: null, error: null }
  }

  return { reattach, recover, channelOfError, channelHintFor, policy }
}

module.exports = {
  createReconnectPolicy,
  createChannelRecovery,
  RECONNECT,
  isTransportFailure,
  channelOfError,
  channelHintFor,
  TRANSPORT_CODES,
  DEFAULT_MAX_ATTEMPTS
}
