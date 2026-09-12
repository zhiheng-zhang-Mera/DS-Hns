'use strict'

/**
 * A virtual clock for Computer Use tests.
 *
 * Timing policy in this subsystem *is* behaviour (settle windows, grace, the
 * cooldown ladder, event-driven waits), so the tests must be able to assert on
 * elapsed virtual time instead of hoping a wall-clock sleep landed in the right
 * window. `sleep()` advances virtual time and resolves immediately: a test that
 * proves "the runtime waited exactly until the 700 ms mutation" runs in
 * microseconds and never flakes on a loaded CI machine.
 */
function createVirtualClock(start = 1000) {
  let current = start
  let sleeps = 0
  return {
    now: () => current,
    async sleep(ms) {
      sleeps += 1
      const amount = Number(ms)
      current += Number.isFinite(amount) && amount > 0 ? amount : 0
    },
    advance(ms) {
      current += Number(ms) || 0
      return current
    },
    get sleeps() {
      return sleeps
    },
    elapsedSince(mark) {
      return current - mark
    }
  }
}

/**
 * A page/desktop double builder is deliberately *not* provided here: the
 * acceptance scenarios use the in-process device (tests/helpers/computer-use-device.cjs)
 * and the unit tests build the smallest double their subject needs, so a test
 * never hides behind a helper that could itself be wrong.
 */

module.exports = { createVirtualClock }
