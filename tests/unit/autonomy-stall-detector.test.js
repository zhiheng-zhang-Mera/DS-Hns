'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { StallDetector } = require('../../app/extensions/mega/autonomy/stall-detector')

const BOUNDS = { quietAfterMs: 10_000, hardStallAfterMs: 60_000, failAfterMs: 200_000 }

test('stall detector accumulates no-progress ticks and reports probe/stall', () => {
  const detector = new StallDetector({ bounds: BOUNDS })
  detector.start('ep-1', 0)
  // Working at t=5s
  let result = detector.observe('ep-1', { lastResponseDeltaAt: 4_000, lastAnyActivityAt: 4_000 }, 5_000)
  assert.equal(result.verdict, 'WORKING')
  assert.equal(result.consecutiveNoProgressTicks, 0)
  // Silence until t=50s (inside hard-stall window) -> SLOW + probe
  result = detector.observe('ep-1', {}, 50_000)
  assert.equal(result.verdict, 'SLOW')
  assert.equal(result.shouldProbe, true)
  assert.equal(result.consecutiveNoProgressTicks, 1)
  // Silence past hard stall (t=150s) -> STALLED
  result = detector.observe('ep-1', {}, 150_000)
  assert.equal(result.verdict, 'STALLED')
  assert.equal(detector.isStalled('ep-1'), true)
})

test('markProbe with no activity pushes a SLOW episode toward stall detection', () => {
  const detector = new StallDetector({ bounds: BOUNDS })
  detector.start('ep-2', 0)
  detector.observe('ep-2', { lastAnyActivityAt: 5_000 }, 50_000)
  assert.equal(detector.markProbe('ep-2', { busy: false, anyActivity: false }), 1)
  // Probe proved nothing; hard-stall bound now governs quickly.
  const result = detector.observe('ep-2', {}, 150_000)
  assert.equal(result.verdict, 'STALLED')
})

test('reset clears counters and restores a fresh heartbeat', () => {
  const detector = new StallDetector({ bounds: BOUNDS })
  detector.start('ep-3', 0)
  detector.observe('ep-3', {}, 150_000)
  assert.equal(detector.isStalled('ep-3'), true)
  detector.reset('ep-3')
  assert.equal(detector.isStalled('ep-3'), false)
  const result = detector.observe('ep-3', { lastResponseDeltaAt: 10_000 }, 15_000)
  assert.equal(result.verdict, 'WORKING')
})

test('drop removes the episode record', () => {
  const detector = new StallDetector({ bounds: BOUNDS })
  detector.start('ep-4', 0)
  assert.equal(detector.drop('ep-4'), true)
  assert.equal(detector.isStalled('ep-4'), false)
})
