'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { computeMaxConcurrent } = require('../../app/extensions/mega/scheduler/system')
const sys = (cpuCores, freeGb) => ({ cpu: { cores: cpuCores }, memory: { freeGb } })

test('dynamic concurrency from CPU and RAM', () => {
  assert.equal(computeMaxConcurrent(sys(8, 10), { minConcurrent: 1, maxConcurrent: 4 }).current, 3)
})

test('maximum caps concurrency', () => {
  assert.equal(computeMaxConcurrent(sys(64, 200), { minConcurrent: 1, maxConcurrent: 2 }).current, 2)
})
