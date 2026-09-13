'use strict'

/**
 * Computer Use Runtime: bounded tool reconnection
 * (Update-Plan/24h.md Task 10, §12 of the plan).
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

module.exports = { createReconnectPolicy, RECONNECT, isTransportFailure, TRANSPORT_CODES, DEFAULT_MAX_ATTEMPTS }
