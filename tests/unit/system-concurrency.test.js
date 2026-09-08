'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { computeMaxConcurrent } = require('../../app/extensions/mega/scheduler/system')

const sys = (logicalCores, freeGb, usagePercent = 0) => ({
  cpu: { cores: logicalCores, logicalCores, usagePercent },
  memory: { freeGb }
})

test('dynamic concurrency is bounded by CPU and RAM', () => {
  assert.equal(computeMaxConcurrent(sys(8, 10), { minConcurrent: 1, maxConcurrent: 4 }).current, 3)
})

test('zero manual cap means fully hardware-auto', () => {
  const result = computeMaxConcurrent(sys(8, 20), { minConcurrent: 1, maxConcurrent: 0 })
  assert.equal(result.mode, 'hardware-auto')
  assert.equal(result.hardwareCap, 4)
  assert.equal(result.current, 4)
})

test('manual cap can only lower the hardware-safe ceiling', () => {
  assert.equal(computeMaxConcurrent(sys(64, 200), { minConcurrent: 1, maxConcurrent: 2 }).current, 2)
})

test('high current CPU load dynamically lowers new-worker concurrency', () => {
  const result = computeMaxConcurrent(sys(8, 20, 80), { minConcurrent: 1, maxConcurrent: 0 })
  assert.equal(result.hardwareCap, 4)
  assert.equal(result.current, 1)
})

test('RAM pressure limits concurrency even on a many-core CPU', () => {
  const result = computeMaxConcurrent(sys(32, 5, 0), { minConcurrent: 1, maxConcurrent: 0 })
  assert.equal(result.byRam, 1)
  assert.equal(result.current, 1)
})
