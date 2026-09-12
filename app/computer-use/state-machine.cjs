'use strict'

/**
 * Computer Use Runtime: the explicit state machine (plan §51, §52).
 *
 * The loop is a state machine rather than a pile of nested callbacks for one
 * practical reason: a run has to be *auditable* while it is happening. The
 * dock can show "the task is in VERIFYING", the log shows which transition
 * happened and why, and an illegal transition (a completion straight out of
 * ACTING, say) is a bug that fails loudly instead of a silent success.
 */

const { CU_STATES, CU_TRANSITIONS, TERMINAL_STATES } = require('./constants.cjs')
const { CODES, ComputerUseError } = require('./errors.cjs')

function createStateMachine(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const initialState = options.initialState || CU_STATES.IDLE
  if (!CU_STATES[initialState]) {
    throw new ComputerUseError(CODES.STATE_INVALID, `unknown initial state: ${initialState}`, { state: initialState })
  }
  const history = []
  let current = initialState
  let reason = 'created'

  function record(next, meta, direction) {
    history.push({
      from: current,
      to: next,
      at: now(),
      reason: meta && meta.reason ? String(meta.reason) : reason,
      step: meta && Number.isInteger(meta.step) ? meta.step : null,
      action: meta && meta.action ? meta.action : null,
      direction
    })
    current = next
    reason = meta && meta.reason ? String(meta.reason) : null
    if (typeof options.onTransition === 'function') {
      try {
        options.onTransition({ from: history[history.length - 1].from, to: next, meta: meta || {} })
      } catch {
        // A listener must never be able to break the run (plan §37).
      }
    }
    return current
  }

  return {
    get state() {
      return current
    },
    get previous() {
      return history.length ? history[history.length - 1].from : null
    },
    isTerminal() {
      return TERMINAL_STATES.includes(current)
    },
    canTransition(next) {
      if (!CU_STATES[next]) return false
      const allowed = CU_TRANSITIONS[current] || []
      return allowed.includes(next)
    },
    /** Legal transition; throws STATE_TRANSITION_INVALID otherwise. */
    transition(next, meta = {}) {
      if (!CU_STATES[next]) {
        throw new ComputerUseError(CODES.STATE_INVALID, `unknown state: ${next}`, { state: next, from: current })
      }
      if (next === current) return current
      if (!this.canTransition(next)) {
        throw new ComputerUseError(CODES.STATE_TRANSITION_INVALID, `illegal transition ${current} -> ${next}`, {
          from: current,
          to: next,
          allowed: CU_TRANSITIONS[current] || [],
          reason: meta.reason || null
        })
      }
      return record(next, meta, 'forward')
    },
    /**
     * A terminal transition taken from anywhere. Only the runtime's own
     * teardown uses this (cancel, run timeout, unrecoverable failure) and it is
     * labelled `forced` in the history so it can never be confused with a
     * normal path.
     */
    force(next, meta = {}) {
      if (!CU_STATES[next]) throw new ComputerUseError(CODES.STATE_INVALID, `unknown state: ${next}`, { state: next, from: current })
      if (next === current) return current
      return record(next, meta, 'forced')
    },
    history() {
      return history.slice()
    },
    path() {
      return [initialState, ...history.map((entry) => entry.to)]
    },
    reset() {
      current = initialState
      history.length = 0
      reason = 'reset'
      return current
    }
  }
}

module.exports = { createStateMachine }
