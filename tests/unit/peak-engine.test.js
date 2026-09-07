'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const {
  statusAt,
  nextChangeInfo,
  buildTimeline
} = require('../../app/billing/peak-engine')

// Beijing (Asia/Shanghai) is UTC+8 without DST.
const beijingUtc = (day, hour, minute = 0) => Date.UTC(2026, 8, day, hour - 8, minute)

test('Monday 2026-09-07 Beijing schedule boundaries', () => {
  assert.equal(statusAt(beijingUtc(7, 8, 59)), 'OFF-PEAK')
  assert.equal(statusAt(beijingUtc(7, 9, 0)), 'PEAK')
  assert.equal(statusAt(beijingUtc(7, 11, 59)), 'PEAK')
  assert.equal(statusAt(beijingUtc(7, 12, 0)), 'OFF-PEAK')
  assert.equal(statusAt(beijingUtc(7, 14, 0)), 'PEAK')
  assert.equal(statusAt(beijingUtc(7, 17, 59)), 'PEAK')
  assert.equal(statusAt(beijingUtc(7, 18, 0)), 'OFF-PEAK')
  assert.equal(statusAt(beijingUtc(7, 23, 59)), 'OFF-PEAK')
})

test('weekends are fully off-peak', () => {
  // Saturday 2026-09-05 10:00 Beijing.
  assert.equal(statusAt(beijingUtc(5, 10, 0)), 'OFF-PEAK')
  // Sunday 2026-09-06 15:00 Beijing.
  assert.equal(statusAt(beijingUtc(6, 15, 0)), 'OFF-PEAK')
})

test('next change from 08:30 Beijing Monday is 09:00 peak', () => {
  const info = nextChangeInfo(beijingUtc(7, 8, 30))
  assert.ok(info)
  assert.equal(info.iso, '2026-09-07T01:00:00.000Z')
  assert.equal(info.statusAfter, 'PEAK')
  assert.equal(info.secondsLeft, 30 * 60)
})

test('Beijing 24h timeline has five weekday segments', () => {
  const tl = buildTimeline(beijingUtc(7, 12, 0))
  // Beijing midnight Monday = UTC 2026-09-06 16:00.
  assert.equal(tl.dayStartMs, Date.UTC(2026, 8, 6, 16, 0))
  assert.equal(tl.segments.length, 5)
  assert.deepEqual(
    tl.segments.map((s) => s.status),
    ['OFF-PEAK', 'PEAK', 'OFF-PEAK', 'PEAK', 'OFF-PEAK']
  )
  assert.equal(tl.segments[1].fromMs, Date.UTC(2026, 8, 7, 1, 0)) // 09:00 Beijing
  assert.equal(tl.segments[1].untilMs, Date.UTC(2026, 8, 7, 4, 0)) // 12:00 Beijing
})

test('weekend timeline is a single off-peak segment', () => {
  const tl = buildTimeline(beijingUtc(5, 10, 0))
  assert.equal(tl.segments.length, 1)
  assert.equal(tl.segments[0].status, 'OFF-PEAK')
})
