'use strict'

/**
 * DS-Hns: **work admission** — the one place that turns the health decision into "may new work start?".
 *
 * The health scheduler's job ends at a decision (`NO_ACTION`, `THROTTLE`, `PAUSE_NEW_WORK`,
 * `REQUEST_RESTART`). The scheduler's job is to run tasks. Neither of them may reach into the other:
 * the monitor must not know what a task is (it cannot stop or start anything — that is asserted
 * against its source), and the queue must not grow its own idea of how pressured the machine is.
 *
 * This module is the seam, and it is deliberately tiny: it asks the `health-pressure` capability for
 * the current decision, and answers the queue with one of two things:
 *
 *   * **admit** — `{ ok: true, action }`, and what the concurrency should be (`concurrencyFactor`);
 *   * **hold** — `{ ok: false, defer: true, action, reason }`, which means the task stays queued and
 *     the reason is shown, never that it is failed.
 *
 * ## The rules that matter
 *
 *   * **Absent or unknown health admits.** A monitor that is disabled, absent or answering UNKNOWN is
 *     not a machine under pressure, and a queue that stopped because a plugin was off would be a
 *     product that stops working when its diagnostic is switched off. `UNKNOWN != HEALTHY` is the
 *     monitor's rule; on this side the same fact reads "no evidence, no restriction".
 *   * **A hold is never a failure.** The task keeps its state and its place in the queue. Marking work
 *     failed because the machine was busy is exactly the false success/false failure pair the
 *     requirement forbids.
 *   * **`THROTTLE` slows, it does not stop.** Half the slots (at least one) while the machine is under
 *     sustained pressure: the queue keeps making progress, which is what "throttle" means.
 *
 * @param {object} input
 * @param {Function} input.provider `() => snapshot | null` — the `health-pressure` reading
 * @param {Function} [input.log]
 * @param {Function} [input.now]
 */
function createWorkAdmission(input = {}) {
  const provider = typeof input.provider === 'function' ? input.provider : null
  const log = typeof input.log === 'function' ? input.log : () => {}
  const now = typeof input.now === 'function' ? input.now : () => Date.now()
  let last = null
  let consulted = 0

  /** The decision in force, or `null` when nothing is watching. See the rules above. */
  function consult() {
    let snapshot = null
    if (provider) {
      try {
        snapshot = provider()
      } catch (error) {
        // A monitor that throws is a monitor that is not restricting work. Failing *closed* here would
        // turn one plugin's bad day into a stopped queue, which is the failure this seam must not have.
        log(`work admission could not read the health decision: ${error && error.message ? error.message : error}`)
        snapshot = null
      }
    }
    consulted += 1
    const action = snapshot && snapshot.action ? String(snapshot.action) : 'NO_ACTION'
    const decision = {
      at: now(),
      available: Boolean(snapshot),
      action,
      state: snapshot && snapshot.state ? String(snapshot.state) : null,
      pressure: snapshot && Number.isFinite(Number(snapshot.pressure)) ? Number(snapshot.pressure) : null,
      trend: snapshot && snapshot.trend ? String(snapshot.trend) : null,
      reason: snapshot && snapshot.reason ? String(snapshot.reason) : (snapshot ? null : 'no health decision is available; new work is admitted'),
      explicit: snapshot && snapshot.explicit === true
    }
    last = decision
    return decision
  }

  /**
   * May new work start, and with how many slots?
   *
   * `concurrencyFactor` is a multiplier the queue applies to its own cap: `1` normally, `0.5` while
   * throttled. The queue keeps owning its numbers; this only says how much of them to use.
   */
  function admit() {
    const decision = consult()
    if (decision.action === 'PAUSE_NEW_WORK') {
      return { ok: false, defer: true, action: decision.action, reason: decision.reason || 'the machine is under sustained pressure; new work is held until it clears', decision, concurrencyFactor: 0 }
    }
    if (decision.action === 'REQUEST_RESTART') {
      return { ok: false, defer: true, action: decision.action, reason: decision.reason || 'a restart has been requested; new work is held until the machine is back', decision, concurrencyFactor: 0 }
    }
    if (decision.action === 'THROTTLE') {
      return { ok: true, action: decision.action, reason: decision.reason || 'the machine is under pressure; fewer slots are used', decision, concurrencyFactor: 0.5 }
    }
    return { ok: true, action: decision.action, reason: null, decision, concurrencyFactor: 1 }
  }

  function describe() {
    const decision = last || { action: 'NO_ACTION', available: false, reason: 'nothing has been admitted yet' }
    return {
      consulted,
      action: decision.action,
      available: decision.available === true,
      pressure: decision.pressure,
      state: decision.state || null,
      trend: decision.trend || null,
      reason: decision.reason || null,
      at: decision.at || null
    }
  }

  return { admit, consult, describe, last: () => last }
}

module.exports = { createWorkAdmission }
