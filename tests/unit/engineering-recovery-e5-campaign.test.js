'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const evidence = require('../../scripts/lib/engineering-recovery-evidence.cjs')
const { buildE5Plan, E5_SCENARIOS, runE5Observation, validateE5Environment } = require('../../scripts/lib/engineering-recovery-e5.cjs')
const e5Cli = require('../../scripts/engineering-recovery-e5.cjs')

test('E5 FINAL command parsing requires an explicit seed, E0 gate and bounded existing batch ID', () => {
  assert.throws(() => e5Cli.parseArgs(['--seed', '42']), /--e0-gate is required/)
  assert.throws(() => e5Cli.parseArgs(['--seed', '-1', '--e0-gate', 'D:\\e0-gate.json']), /unsigned 32-bit integer/)
  assert.throws(() => e5Cli.parseArgs(['--seed', '42', '--e0-gate', 'D:\\e0-gate.json']), /--batch-id must name an existing FINAL batch/)
  assert.throws(() => e5Cli.parseArgs(['--seed', '42', '--batch-id', '..\\outside', '--e0-gate', 'D:\\e0-gate.json']), /filename-safe identifier/)
  assert.throws(() => e5Cli.parseArgs(['--mode', 'pilot']), /unsupported argument/)

  const parsed = e5Cli.parseArgs(['--seed', '42', '--batch-id', 'E5-W2-final-unit', '--e0-gate', 'D:\\e0-gate.json'])
  assert.deepEqual(parsed, { seed: 42, batchId: 'E5-W2-final-unit', e0Gate: 'D:\\e0-gate.json' })
})

test('E5 FINAL attaches only to a matching, intact E2 batch and refuses identity drift', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e5-existing-final-batch-'))
  const previousAllowNonD = process.env.HNS_EVIDENCE_TEST_ALLOW_NON_D
  process.env.HNS_EVIDENCE_TEST_ALLOW_NON_D = '1'
  try {
    const sha = 'a'.repeat(40)
    const branch = 'dev/crash-resume-recovery-v1'
    const startedAt = new Date().toISOString()
    const e0Gate = {
      schemaVersion: 1,
      runId: 'E0-e5-attach-fixture',
      branch,
      implementationSha: sha,
      runtime: 'node-test-fixture',
      os: 'unit-test host',
      tempVolume: 'D:',
      startedAt,
      finishedAt: startedAt,
      gates: ['syntax', 'full-unit', 'focused-recovery', 'test-all'].map((id, index) => ({
        id,
        status: 'PASS',
        exitCode: 0,
        durationMs: index + 1,
        logSha256: String(index + 1).repeat(64),
        checkedFiles: id === 'syntax' ? 1 : null,
        totalFiles: id === 'syntax' ? 1 : null,
        tests: id === 'syntax' ? null : 2,
        passed: id === 'syntax' ? null : 2,
        failed: id === 'syntax' ? null : 0,
        skipped: id === 'syntax' ? null : 0
      })),
      passed: true
    }
    const batchId = 'E2-E5-final-attach-fixture'
    const batch = evidence.createBatch({ root, batchId, phase: 'FINAL', seed: 17, implementationSha: sha, harnessSha: sha, sourceRef: branch, e0Gate })
    const run = evidence.createRun(batch, {
      runId: 'E2-W0-fault04',
      episodeId: 'E2-W0-episode-fixture',
      runOrdinal: 1,
      seed: 17,
      implementationSha: sha,
      workloadId: 'W0',
      faultId: 4
    })
    assert.equal(run.appendEvent({ type: 'episode_started' }).ok, true)
    evidence.finalizeRun(run)
    const derived = evidence.deriveBatch(batch.batchDir)
    assert.equal(derived.integrity.ok, true)

    const attached = e5Cli.loadExistingFinalBatch({ batchId, batchDir: batch.batchDir, sourceRef: branch, implementationSha: sha, e0Gate })
    assert.equal(attached.phase, 'FINAL')
    assert.equal(attached.manifest.runs.length, 1)
    assert.throws(() => e5Cli.loadExistingFinalBatch({ batchId, batchDir: batch.batchDir, sourceRef: branch, implementationSha: 'b'.repeat(40), e0Gate }), /does not match/)
  } finally {
    if (previousAllowNonD === undefined) delete process.env.HNS_EVIDENCE_TEST_ALLOW_NON_D
    else process.env.HNS_EVIDENCE_TEST_ALLOW_NON_D = previousAllowNonD
    fs.rmSync(root, { recursive: true, force: true })
  }
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

test('E5 rejects a scratch root whose path crosses a reparse point', (t) => {
  if (process.platform !== 'win32' || !fs.existsSync('D:\\')) return t.skip('Windows D: is unavailable')
  try {
    validateE5Environment(os.tmpdir())
  } catch (error) {
    return t.skip(`the host temp root is not eligible for E5: ${error.code || error.message}`)
  }
  const holder = fs.mkdtempSync(path.join(os.tmpdir(), 'e5-reparse-root-'))
  const target = path.join(holder, 'target')
  const reparse = path.join(holder, 'reparse')
  fs.mkdirSync(target)
  try {
    try {
      fs.symlinkSync(target, reparse, 'junction')
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip(`junction creation is unavailable: ${error.code}`)
      throw error
    }
    assert.throws(() => validateE5Environment(reparse), (error) => error.code === 'E5_SCRATCH_PATH_UNSAFE')
  } finally {
    if (fs.existsSync(reparse)) fs.rmdirSync(reparse)
    if (fs.existsSync(holder)) fs.rmSync(holder, { recursive: true, force: true })
  }
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
    const baseline = evidence.createRun(batch, {
      runId: 'E2-W0-fault04-fixture',
      episodeId: 'E2-W0-episode-fixture',
      runOrdinal: 1,
      seed,
      workloadId: 'W0',
      faultId: 4
    })
    assert.equal(baseline.appendEvent({ type: 'episode_started' }).ok, true)
    evidence.finalizeRun(baseline)
    batch.manifest = JSON.parse(fs.readFileSync(path.join(batch.batchDir, 'batch-manifest.json'), 'utf8'))
    const planEntry = buildE5Plan(seed).find((entry) => entry.faultId === 83)
    const result = await runE5Observation(batch, planEntry, { scratchRoot: os.tmpdir(), runOrdinalOffset: batch.manifest.runs.length })
    assert.equal(result.classification, 'EXPECTED_BLOCK', JSON.stringify(result))

    const runDir = path.join(batch.batchDir, 'runs', planEntry.runId)
    const runManifest = JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf8'))
    const resultJson = JSON.parse(fs.readFileSync(path.join(runDir, 'result.json'), 'utf8'))
    assert.equal(runManifest.runOrdinal, planEntry.ordinal + 1)
    assert.deepEqual(runManifest.storageVolumeRoles, ['work:D', 'scratch:C'])
    assert.deepEqual(runManifest.taskScratchVolumes, ['C:'])
    assert.equal(resultJson.offWorkVolumeTempCreatedCount, 2)
    assert.equal(resultJson.offWorkVolumeTempDeletedCount, 2, 'the registered file deleted before the directory block must be recorded')
    assert.equal(resultJson.offWorkVolumeResidualCount, 0)
    assert.equal(evidence.verifyRunIntegrity(runDir).ok, true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
