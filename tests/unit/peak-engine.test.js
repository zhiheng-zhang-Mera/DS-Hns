'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { statusAt, nextChangeInfo, buildTimeline } = require('../../app/extensions/mega/billing/peak-engine')
const beijingUtc = (day, hour, minute = 0) => Date.UTC(2026, 8, day, hour - 8, minute)

test('weekday schedule boundaries', () => {
  assert.equal(statusAt(beijingUtc(7, 8, 59)), 'OFF-PEAK')
  assert.equal(statusAt(beijingUtc(7, 9, 0)), 'PEAK')
  assert.equal(statusAt(beijingUtc(7, 12, 0)), 'OFF-PEAK')
  assert.equal(statusAt(beijingUtc(7, 14, 0)), 'PEAK')
  assert.equal(statusAt(beijingUtc(7, 18, 0)), 'OFF-PEAK')
})

test('weekends are fully off-peak', () => {
  assert.equal(statusAt(beijingUtc(5, 10, 0)), 'OFF-PEAK')
  assert.equal(statusAt(beijingUtc(6, 15, 0)), 'OFF-PEAK')
})

test('next change is calculated', () => {
  const info = nextChangeInfo(beijingUtc(7, 8, 30))
  assert.equal(info.iso, '2026-09-07T01:00:00.000Z')
  assert.equal(info.statusAfter, 'PEAK')
})

test('weekday timeline has five segments', () => {
  const tl = buildTimeline(beijingUtc(7, 12, 0))
  assert.equal(tl.segments.length, 5)
})
