'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { backoffDelayMs, decideContinuation } = require('../../app/extensions/mega/autonomy/continuation-controller')

test('WORKING and SLOW never kill; SLOW probes without blocking the tick', () => {
  const working = decideContinuation({ verdict: 'WORKING', attempts: 0, now: 1000, startedAt: 0 })
  assert.equal(working.action, 'KEEP_RUNNING')
  const slow = decideContinuation({ verdict: 'SLOW', attempts: 0, now: 1000, startedAt: 0 })
  assert.equal(slow.action, 'PROBE')
})

test('STALLED parks with bounded backoff and releases the slot; budget exhausted fails', () => {
  const parked = decideContinuation({ verdict: 'STALLED', attempts: 1, now: 100_000, startedAt: 0, maxAttempts: 3 })
  assert.equal(parked.action, 'PARK_AWAITING_RETRY')
  assert.ok(parked.retryAtMs > 100_000)
  assert.match(parked.reason, /slot released/)
  const exhausted = decideContinuation({ verdict: 'STALLED', attempts: 3, now: 100_000, startedAt: 0, maxAttempts: 3 })
  assert.equal(exhausted.action, 'FAIL')
})

test('FAILED verdict and hard-deadline overruns terminate the episode', () => {
  assert.equal(decideContinuation({ verdict: 'FAILED', attempts: 0, now: 100_000, startedAt: 0 }).action, 'FAIL')
  const deadline = decideContinuation({ verdict: 'WORKING', attempts: 0, now: 100_000, startedAt: 0, hardDeadlineMs: 50_000 })
  assert.equal(deadline.action, 'FAIL')
})

test('model-done requires verification: unverified -> REWORK (bounded), verified -> COMPLETE', () => {
  assert.equal(decideContinuation({ completed: true, verified: true, attempts: 0, now: 1000 }).action, 'COMPLETE')
  const rework = decideContinuation({ completed: true, verified: false, attempts: 0, now: 1000, maxAttempts: 3 })
  assert.equal(rework.action, 'REWORK')
  const noBudget = decideContinuation({ completed: true, verified: false, attempts: 3, now: 1000, maxAttempts: 3 })
  assert.equal(noBudget.action, 'FAIL')
})

test('backoff grows exponentially and is capped', () => {
  assert.equal(backoffDelayMs(0), 30_000)
  assert.equal(backoffDelayMs(1), 60_000)
  assert.ok(backoffDelayMs(9) <= 5 * 60_000)
  assert.throws(() => backoffDelayMs(-1))
})

test('validates maxAttempts bounds', () => {
  assert.throws(() => decideContinuation({ verdict: 'WORKING', maxAttempts: 0 }))
  assert.throws(() => decideContinuation({ verdict: 'WORKING', maxAttempts: 99 }))
})
