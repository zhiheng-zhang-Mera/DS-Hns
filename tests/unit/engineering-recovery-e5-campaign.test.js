'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const evidence = require('../../scripts/lib/engineering-recovery-evidence.cjs')
const { buildE5Plan, E5_SCENARIOS, runE5Observation, validateE5Environment } = require('../../scripts/lib/engineering-recovery-e5.cjs')
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

test('E5 records registered children deleted before an expected parent cleanup block', async (t) => {
  let volumes
  try {
    volumes = validateE5Environment(os.tmpdir())
  } catch (error) {
    return t.skip(`cross-volume campaign volumes are unavailable: ${error.code || error.message}`)
  }
  assert.equal(volumes.workVolume, 'D:')
  const fixtureRoot = path.join(path.resolve(__dirname, '../..'), 'runtime', 'engineering', 'test-fixtures', 'tmp')
  fs.mkdirSync(fixtureRoot, { recursive: true })
  const root = fs.mkdtempSync(path.join(fixtureRoot, 'e5-delete-ledger-'))
  try {
    const seed = 833
    const batch = evidence.createBatch({ root, batchId: 'E5-delete-ledger-fixture', phase: 'PILOT', seed })
    const planEntry = buildE5Plan(seed).find((entry) => entry.faultId === 83)
    const result = await runE5Observation(batch, planEntry, { scratchRoot: os.tmpdir() })
    assert.equal(result.classification, 'EXPECTED_BLOCK')

    const runDir = path.join(batch.batchDir, 'runs', planEntry.runId)
    const resultJson = JSON.parse(fs.readFileSync(path.join(runDir, 'result.json'), 'utf8'))
    assert.equal(resultJson.offWorkVolumeTempCreatedCount, 2)
    assert.equal(resultJson.offWorkVolumeTempDeletedCount, 2, 'the registered file deleted before the directory block must be recorded')
    assert.equal(resultJson.offWorkVolumeResidualCount, 0)
    assert.equal(evidence.verifyRunIntegrity(runDir).ok, true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
