'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { buildE5Plan, E5_SCENARIOS } = require('../../scripts/lib/engineering-recovery-e5.cjs')
const e5Cli = require('../../scripts/engineering-recovery-e5.cjs')

test('E5 FINAL command parsing requires an explicit seed and E0 gate', () => {
  assert.throws(() => e5Cli.parseArgs(['--seed', '42']), /--e0-gate is required/)
  assert.throws(() => e5Cli.parseArgs(['--seed', '-1', '--e0-gate', 'D:\\e0-gate.json']), /unsigned 32-bit integer/)
  assert.throws(() => e5Cli.parseArgs(['--mode', 'pilot']), /unsupported argument/)

  const parsed = e5Cli.parseArgs(['--seed', '42', '--batch-id', 'E5-W2-final-unit', '--e0-gate', 'D:\\e0-gate.json'])
  assert.deepEqual(parsed, { seed: 42, batchId: 'E5-W2-final-unit', e0Gate: 'D:\\e0-gate.json' })
})

test('E5 predeclares twenty reproducible observations covering every required cleanup scenario', () => {
  const first = buildE5Plan(20261005)
  const second = buildE5Plan(20261005)

  assert.deepEqual(first, second)
  assert.equal(first.length, 20)
  assert.deepEqual([...new Set(first.map((entry) => entry.faultId))].sort((a, b) => a - b), [80, 81, 82, 83, 84, 85, 86, 87])
  assert.equal(new Set(first.map((entry) => entry.runId)).size, 20)
  assert.equal(new Set(first.map((entry) => entry.seed)).size, 20)
  for (const entry of first) assert.equal(E5_SCENARIOS.has(entry.faultId), true)
})

test('E5 run order is seed-randomized while the scenario population remains fixed', () => {
  const first = buildE5Plan(20261005)
  const second = buildE5Plan(20261006)

  assert.notDeepEqual(first.map((entry) => entry.faultId), second.map((entry) => entry.faultId))
  assert.deepEqual([...first.map((entry) => entry.faultId)].sort((a, b) => a - b),
    [...second.map((entry) => entry.faultId)].sort((a, b) => a - b))
})
