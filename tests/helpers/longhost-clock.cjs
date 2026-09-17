'use strict'

/**
 * DS-Hns: the virtual clock the long-hosting soak tests run on.
 *
 * The two built-in plugins are built to run for days, and the questions worth asking about them are
 * questions about *time*: does the rolling window really roll, does the backoff really double, does a
 * maintenance deferral really stop at its deadline, does the cooldown really hold. Waiting for
 * wall-clock hours to answer those is how a soak test becomes a thing nobody runs.
 *
 * So the clock is a number. `createVirtualClock` advances on demand, `run` drives the clock from
 * `startAt` to `endAt` in fixed steps, and every timer either plugin registers is fired by
 * `advance()` rather than by the operating system. A six-hour soak costs milliseconds and asserts the
 * same transitions a real one would.
 *
 * It is deliberately tiny and dependency-free: a clock with a bug in it is a soak that proves nothing,
 * so there is nothing here to have a bug in beyond arithmetic.
 */

/** The shipped soak horizons. `6h`/`12h`/`24h` as the requirement names them, in milliseconds. */
const SOAK_HORIZONS = Object.freeze({
  '6h': 6 * 60 * 60 * 1000,
  '12h': 12 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000
})

/**
 * @param {object} [options]
 * @param {number} [options.start] the epoch milliseconds the clock starts at
 */
function createVirtualClock(options = {}) {
  let current = Number.isFinite(options.start) ? Number(options.start) : 1_000_000
  const timers = []
  let nextTimerId = 1
  let fired = 0
  const sleeps = []

  const now = () => current

  /**
   * Register a timer, the way `setTimeout`/`setInterval` do — but nothing fires until `advance()`.
   *
   * The two real timer functions are replaced with these while a soak drives a plugin, so a plugin
   * that schedules work is driven by the virtual clock without knowing it.
   */
  function setTimeoutVirtual(fn, ms = 0, ...args) {
    const id = nextTimerId
    nextTimerId += 1
    timers.push({ id, fn, at: current + Math.max(0, Number(ms) || 0), every: null, args, cancelled: false })
    return id
  }

  function setIntervalVirtual(fn, ms = 1, ...args) {
    const period = Math.max(1, Number(ms) || 1)
    const id = nextTimerId
    nextTimerId += 1
    timers.push({ id, fn, at: current + period, every: period, args, cancelled: false })
    return id
  }

  function clearTimer(id) {
    const timer = timers.find((entry) => entry.id === id)
    if (timer) timer.cancelled = true
    return { ok: true }
  }

  /**
   * Advance to a moment, firing every timer due on the way — in time order, so a callback that
   * schedules another callback does not run out of order.
   */
  async function advance(ms) {
    const target = current + Math.max(0, Number(ms) || 0)
    let guard = 0
    for (;;) {
      const due = timers
        .filter((timer) => !timer.cancelled && timer.at <= target)
        .sort((left, right) => left.at - right.at || left.id - right.id)[0]
      if (!due) break
      guard += 1
      // A pathological interval (zero or a callback that reschedules itself at the same instant)
      // would otherwise spin forever; the bound is reported rather than hidden.
      if (guard > 1_000_000) throw new Error('the virtual clock fired a million timers without reaching its target; an interval is probably zero')
      current = due.at
      fired += 1
      if (due.every === null) due.cancelled = true
      else due.at = due.at + due.every
      try {
        await due.fn(...due.args)
      } catch (error) {
        // A timer that throws is the plugin's problem and not the clock's: the soak records it and
        // keeps time moving, exactly as the operating system would.
        sleeps.push({ at: current, error: String(error && error.message ? error.message : error) })
      }
    }
    current = target
    return current
  }

  /** A sleep that advances the clock, so a plugin's own backoff wait can be driven. */
  async function sleep(ms) {
    await advance(ms)
    return current
  }

  /** Replace the global timers for the duration of a callback, and restore them afterwards. */
  async function withTimers(fn) {
    const real = { setTimeout: global.setTimeout, setInterval: global.setInterval, clearTimeout: global.clearTimeout, clearInterval: global.clearInterval }
    global.setTimeout = setTimeoutVirtual
    global.setInterval = setIntervalVirtual
    global.clearTimeout = clearTimer
    global.clearInterval = clearTimer
    try {
      return await fn()
    } finally {
      global.setTimeout = real.setTimeout
      global.setInterval = real.setInterval
      global.clearTimeout = real.clearTimeout
      global.clearInterval = real.clearInterval
      for (const timer of timers) timer.cancelled = true
    }
  }

  /** Run `breath()` at `stepMs` intervals from now to `now + durationMs`. */
  async function run({ durationMs, stepMs = 1_000, breath = null, onStep = null } = {}) {
    const steps = Math.max(1, Math.ceil(durationMs / stepMs))
    for (let step = 0; step < steps; step += 1) {
      if (typeof breath === 'function') await breath({ step, at: current, steps })
      if (typeof onStep === 'function') await onStep({ step, at: current, steps })
      await advance(stepMs)
    }
    return { steps, at: current }
  }

  return {
    now,
    advance,
    sleep,
    run,
    withTimers,
    setTimeout: setTimeoutVirtual,
    setInterval: setIntervalVirtual,
    clearTimeout: clearTimer,
    clearInterval: clearTimer,
    /** How many timers the clock has fired: the soak's own work counter. */
    fired: () => fired,
    /** Timers still scheduled, so a leak is a number rather than a suspicion. */
    pending: () => timers.filter((timer) => !timer.cancelled).length,
    errors: () => sleeps.filter((entry) => entry.error).map((entry) => ({ ...entry })),
    set(ms) {
      current = Number(ms)
      return current
    }
  }
}

module.exports = { createVirtualClock, SOAK_HORIZONS }
