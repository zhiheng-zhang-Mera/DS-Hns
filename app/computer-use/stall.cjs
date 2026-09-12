'use strict'

/**
 * Computer Use Runtime: stall detection (plan §20, §21).
 *
 * A stall is not "an action failed". It is:
 *
 *   same state  +  several actions  +  no observable progress
 *
 * which is what an unresponsive page, a dead window or a silently swallowed
 * click looks like from the outside. Three consecutive actions without a
 * meaningful state change escalates the run into stall recovery — structured
 * re-observe, window check, target re-resolution, targeted screenshot, an
 * alternative interaction — and the ladder is *bounded*, so the end of the road
 * is FAIL_WITH_CONTEXT rather than an infinite retry loop (plan §21).
 */

const { STALL } = require('./constants.cjs')

function createStallDetector(options = {}) {
  const threshold = Number.isInteger(options.consecutiveActions) ? options.consecutiveActions : STALL.consecutiveActions
  const maxRecoveries = Number.isInteger(options.maxRecoveries) ? options.maxRecoveries : STALL.maxRecoveries
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const history = []
  let consecutive = 0
  let lastSignature = null
  let recoveries = 0
  let stalledSince = null

  /**
   * Records the outcome of one action.
   * @param {object} entry { step, actionType, signature, changed, fields, verification }
   */
  function record(entry = {}) {
    const meaningful = entry.meaningful === undefined ? Boolean(entry.changed) : Boolean(entry.meaningful)
    const signature = entry.signature === undefined ? null : entry.signature
    const progressed = meaningful || (signature !== null && lastSignature !== null && signature !== lastSignature)
    if (progressed) {
      consecutive = 0
      stalledSince = null
    } else {
      consecutive += 1
      stalledSince = stalledSince || now()
    }
    lastSignature = signature === null ? lastSignature : signature
    const record_ = {
      at: now(),
      step: Number.isInteger(entry.step) ? entry.step : history.length + 1,
      actionType: entry.actionType || null,
      meaningful,
      consecutive,
      fields: Array.isArray(entry.fields) ? entry.fields : [],
      verification: entry.verification || null
    }
    history.push(record_)
    if (history.length > 200) history.splice(0, history.length - 200)
    return {
      ...record_,
      stalled: consecutive >= threshold,
      stalledSinceMs: stalledSince === null ? 0 : now() - stalledSince,
      threshold,
      recoveries,
      exhausted: recoveries >= maxRecoveries
    }
  }

  /** Plan §21: each stall recovery is counted, and the ladder has an end. */
  function registerRecovery() {
    recoveries += 1
    return {
      recoveries,
      remaining: Math.max(0, maxRecoveries - recoveries),
      exhausted: recoveries >= maxRecoveries
    }
  }

  function reset() {
    consecutive = 0
    stalledSince = null
    lastSignature = null
  }

  return {
    threshold,
    maxRecoveries,
    record,
    registerRecovery,
    reset,
    get consecutive() {
      return consecutive
    },
    get recoveries() {
      return recoveries
    },
    get exhausted() {
      return recoveries >= maxRecoveries
    },
    history() {
      return history.slice()
    }
  }
}

/**
 * Plan §21 — the stall recovery ladder, in order. The runtime walks it one rung
 * per recovery attempt, and the last rung produces FAIL_WITH_CONTEXT: the run
 * stops with the context it gathered instead of retrying forever.
 */
const STALL_RECOVERY_LADDER = Object.freeze([
  { step: 'structured_reobserve', description: 'rebuild the world state from structured sources only' },
  { step: 'window_check', description: 'verify the expected window is still present and in front' },
  { step: 'target_re_resolution', description: 're-resolve the target from scratch through the full ladder' },
  { step: 'targeted_screenshot', description: 'capture the smallest region that could explain the stall' },
  { step: 'alternative_interaction', description: 'use a different interaction channel for the same intent' },
  { step: 'replan', description: 'ask the planner for a different next action' },
  { step: 'full_screenshot', description: 'escalate to a full-screen capture, once' },
  { step: 'fail_with_context', description: 'stop and report everything observed' }
])

module.exports = { createStallDetector, STALL_RECOVERY_LADDER }
