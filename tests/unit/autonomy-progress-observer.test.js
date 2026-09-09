'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { observe, ProgressObserver, emptyHeartbeat, normalizeBounds, DEFAULT_BOUNDS } = require('../../app/extensions/mega/autonomy/progress-observer')

const BOUNDS = { quietAfterMs: 10_000, hardStallAfterMs: 60_000, failAfterMs: 200_000 }

test('WORKING while busy evidence is fresh (long-thinking episode)', () => {
  const result = observe(30_000, { ...emptyHeartbeat(0), busy: true, lastPageStateAt: 29_500 }, BOUNDS)
  assert.equal(result.verdict, 'WORKING')
  assert.equal(result.lifecycle, 'ACTIVE')
  assert.equal(result.probeSuggested, false)
})

test('WORKING while semantic progress or response deltas stay fresh', () => {
  assert.equal(observe(15_000, { ...emptyHeartbeat(0), lastSemanticProgressAt: 12_000 }, BOUNDS).verdict, 'WORKING')
  assert.equal(observe(15_000, { ...emptyHeartbeat(0), lastResponseDeltaAt: 13_000 }, BOUNDS).verdict, 'WORKING')
})

test('soft deadline inside hard-stall window -> SLOW + probe, never a kill', () => {
  const result = observe(50_000, { ...emptyHeartbeat(0), lastAnyActivityAt: 5_000 }, BOUNDS)
  assert.equal(result.verdict, 'SLOW')
  assert.equal(result.probeSuggested, true)
  assert.equal(result.stalenessMs, 45_000)
})

test('hard stall -> STALLED; absolute silence -> FAILED (slow != killed, stalled != forever)', () => {
  assert.equal(observe(150_000, { ...emptyHeartbeat(0), lastAnyActivityAt: 10_000 }, BOUNDS).verdict, 'STALLED')
  assert.equal(observe(500_000, emptyHeartbeat(0), BOUNDS).verdict, 'FAILED')
})

test('a stuck busy flag cannot mask a hard stall', () => {
  const result = observe(90_000, { ...emptyHeartbeat(0), busy: true, lastPageStateAt: 5_000 }, BOUNDS)
  assert.equal(result.verdict, 'STALLED')
  assert.equal(result.lifecycle, 'RECOVERING')
})

test('bounds are validated and default ordering is sane', () => {
  assert.throws(() => observe(10, emptyHeartbeat(5), { quietAfterMs: 0, hardStallAfterMs: 1, failAfterMs: 2 }))
  assert.throws(() => observe(1, emptyHeartbeat(5)))
  const merged = normalizeBounds({ quietAfterMs: 500 })
  assert.equal(merged.hardStallAfterMs, DEFAULT_BOUNDS.hardStallAfterMs)
  assert.equal(merged.quietAfterMs, 500)
})

test('ProgressObserver.tick merges partial updates into a heartbeat', () => {
  const observer = new ProgressObserver({ bounds: BOUNDS, now: () => 20_000 })
  const heartbeat = emptyHeartbeat(0)
  const first = observer.tick(heartbeat, { busy: true, lastPageStateAt: 19_000 }, 20_000)
  assert.equal(first.observation.verdict, 'WORKING')
  const second = observer.tick(first.heartbeat, { lastSemanticProgressAt: 20_000 }, 20_000)
  assert.equal(second.observation.verdict, 'WORKING')
})
