'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { computeMaxConcurrent } = require('../../app/scheduler/system')

function sys(cpuCores, freeGb) {
  return { cpu: { cores: cpuCores }, memory: { freeGb } }
}

test('dynamic concurrency from CPU and free RAM', () => {
  const r = computeMaxConcurrent(sys(8, 10), { minConcurrent: 1, maxConcurrent: 4 })
  assert.equal(r.byCpu, 4)
  assert.equal(r.current, 3) // min(4 cpu-based, 3 ram-based), bounded 1..4
})

test('user minimum can raise the ceiling', () => {
  const r = computeMaxConcurrent(sys(4, 50), { minConcurrent: 5, maxConcurrent: 8 })
  assert.equal(r.current, 5)
})

test('low free memory still leaves one worker', () => {
  const r = computeMaxConcurrent(sys(8, 0.6), { minConcurrent: 1, maxConcurrent: 4 })
  assert.equal(r.current, 1)
})

test('user maximum caps the ceiling', () => {
  const r = computeMaxConcurrent(sys(64, 200), { minConcurrent: 1, maxConcurrent: 2 })
  assert.equal(r.current, 2)
})
