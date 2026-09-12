'use strict'

/**
 * Optional model-assisted Design Intent interpreter (Theme Worker Adapter).
 *
 * Standard split (engineering spec §16):
 *
 *   deterministic engine = fallback / validator / compiler
 *   AI worker            = semantic designer
 *
 * The AI layer may only ever *refine* the intent. It is disabled by default, it
 * has no network code of its own, and every failure path returns to the
 * deterministic interpreter — so a missing, broken or unreachable model can never
 * become a start-up dependency of HNS.
 *
 * Wiring it up later means providing an `interpret` function; nothing else in the
 * theme engine has to change.
 */

/** Refinement is enabled only when a worker is explicitly provided. */
const DEFAULT_STATE = Object.freeze({
  enabled: false,
  reason: 'no model worker is configured; the deterministic interpreter is used'
})

/**
 * @param {object} options
 * @param {Function} [options.interpret] async ({ prompt, previousIntent, snapshot, capability, localIntent }) => intent patch
 * @param {Function} [options.log]
 * @param {boolean}  [options.enabled=true]  honoured only when `interpret` exists
 */
function createModelAdapter({ interpret = null, log = () => {}, enabled = true } = {}) {
  const hasWorker = typeof interpret === 'function'
  let active = hasWorker && enabled !== false
  let disabledReason = active ? null : (hasWorker ? 'disabled by configuration' : DEFAULT_STATE.reason)
  let calls = 0
  let failures = 0

  /**
   * The function handed to the orchestrator as `modelInterpreter`. It returns a
   * PARTIAL intent, which the orchestrator merges into the deterministic one —
   * never a complete intent, so the model cannot drop mandatory fields.
   */
  async function worker({ prompt, localIntent = null, previousIntent = null, snapshot = null, capability = null } = {}) {
    if (!active) return null
    calls += 1
    try {
      const refined = await interpret({ prompt, localIntent, previousIntent, snapshot, capability })
      if (!refined || typeof refined !== 'object') {
        failures += 1
        log('model designer unavailable: the worker returned no usable intent')
        return null
      }
      return refined
    } catch (error) {
      failures += 1
      log(`model designer unavailable: ${error?.message || error}`)
      return null
    }
  }

  function enable(value = true) {
    active = Boolean(value) && hasWorker
    disabledReason = active ? null : (hasWorker ? 'disabled by configuration' : DEFAULT_STATE.reason)
    return active
  }

  function describe() {
    return {
      enabled: active,
      available: hasWorker,
      reason: disabledReason,
      calls,
      failures
    }
  }

  return {
    /**
     * The function handed to the orchestrator. It is always the same reference;
     * while the adapter is disabled it simply answers `null`, which the
     * orchestrator reads as "keep the deterministic intent". That keeps enabling
     * and disabling the model a live decision instead of a start-up one.
     */
    interpreter: worker,
    worker,
    enable,
    describe
  }
}

module.exports = { createModelAdapter, DEFAULT_STATE }
