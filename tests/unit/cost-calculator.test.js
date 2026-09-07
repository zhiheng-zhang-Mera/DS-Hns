'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const PricingRepository = require('../../app/billing/pricing-repository')
const { calculateTaskCost } = require('../../app/billing/cost-calculator')

const repo = new PricingRepository()
const flash = repo.getModel('deepseek-v4-flash')
const schedule = repo.getSchedule()
const bj = (hour, minute = 0) => Date.UTC(2026, 8, 7, hour - 8, minute)

test('peak/off-peak token billing matches official yuan rates', () => {
  const result = calculateTaskCost({
    model: flash,
    schedule,
    events: [
      { time: bj(9, 10), inputTokens: 1_000_000 }, // peak miss 3.0
      { time: bj(21, 0), cacheReadTokens: 1_000_000 }, // off cache hit 0.05
      { time: bj(9, 10), outputTokens: 1_000_000 } // peak output 9.0
    ]
  })
  assert.equal(result.costCny, 12.05)
  assert.equal(result.estimated, false)
  assert.deepEqual(result.tokens, {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheReadTokens: 1_000_000,
    cacheWriteTokens: 0
  })
})

test('usage straddling a price boundary is marked Estimated', () => {
  const result = calculateTaskCost({
    model: flash,
    schedule,
    events: [
      { time: bj(11, 58), outputTokens: 100_000 }, // still peak
      { time: bj(12, 2), outputTokens: 200_000 } // off-peak
    ]
  })
  assert.equal(result.estimated, true)
  assert.ok(result.costCny > 0)
})

test('zero usage returns zero cost with reason', () => {
  const result = calculateTaskCost({ model: flash, schedule, events: [] })
  assert.equal(result.costCny, 0)
  assert.equal(result.reason, 'no usage events')
})
