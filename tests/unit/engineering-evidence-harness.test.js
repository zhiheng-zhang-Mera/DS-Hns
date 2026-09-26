'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const evidence = require('../../scripts/lib/engineering-recovery-evidence.cjs')

function tempDir() {
  const root = os.tmpdir()
  if (process.platform === 'win32' && path.parse(root).root.toLowerCase() !== 'd:\\') {
    // CI has no user-selected D: drive. This explicit exception applies only to
    // disposable unit fixtures; the executable evidence runner remains D:-only.
    process.env.HNS_EVIDENCE_TEST_ALLOW_NON_D = '1'
  }
  return fs.mkdtempSync(path.join(root, 'engineering-evidence-'))
}

function passingEvents(run, ids = {}) {
  const {
    appendEvent,
    batchId,
    runId,
    episodeId
  } = run
  const faultId = ids.faultId || 4
  const stepIds = run.manifest.workloadStepIds
  assert.equal(Array.isArray(stepIds), true)
  const scratch = 'scratch-root-1'
  const sentinel = 'source-sentinel-1'
  const mutationHash = 'a'.repeat(64)
  const events = [
    { type: 'episode_started' },
    { type: 'checkpoint_observed', checkpointSeq: 1, cursor: { nextStepIndex: 0, verifiedStepIds: [], skippedStepIds: [] }, verifiedStepIds: [], verifiedMutationIds: [] },
    { type: 'mutation_effect', mutationId: 'm1', effectId: `m1:${mutationHash}`, sha256: mutationHash, effect: 'applied', phase: 'before_fault' },
    { type: 'checkpoint_observed', checkpointSeq: 2, cursor: { nextStepIndex: 1, verifiedStepIds: [stepIds[0]], skippedStepIds: [] }, verifiedStepIds: [stepIds[0]], verifiedMutationIds: ['m1'] },
    { type: 'fault_armed', faultId },
    { type: 'fault_injected', faultId },
    { type: 'target_exit_observed', faultId },
    { type: 'relaunch_started' },
    { type: 'recovery_candidate_detected', checkpointSeq: 2, cursor: { nextStepIndex: 1, verifiedStepIds: [stepIds[0]], skippedStepIds: [] } },
    { type: 'recovery_claim_acquired', ownerId: 'owner-new', liveOwnerCount: 1 },
    { type: 'recovery_verified', checkpointSeq: 2, cursor: { nextStepIndex: 1, verifiedStepIds: [stepIds[0]], skippedStepIds: [] } },
    { type: 'resume_accepted', checkpointSeq: 2, cursor: { nextStepIndex: 1, verifiedStepIds: [stepIds[0]], skippedStepIds: [] } },
    { type: 'checkpoint_observed', checkpointSeq: 3, cursor: { nextStepIndex: 2, verifiedStepIds: [stepIds[0], stepIds[1]], skippedStepIds: [] }, verifiedStepIds: [stepIds[0], stepIds[1]], verifiedMutationIds: ['m1'] },
    { type: 'mutation_effect', mutationId: 'm1', effectId: `m1:${mutationHash}`, sha256: mutationHash, effect: 'present_after_resume', phase: 'after_resume' },
    { type: 'first_post_resume_checkpoint', checkpointSeq: 3, cursor: { nextStepIndex: 2, verifiedStepIds: [stepIds[0], stepIds[1]], skippedStepIds: [] } },
    { type: 'cross_volume_temp_registered', pathId: scratch, entryType: 'directory' },
    { type: 'sentinel_observed', phase: 'before', pathId: sentinel, sha256: 'a'.repeat(64) },
    { type: 'cleanup_started' },
    { type: 'cleanup_entry_deleted', pathId: scratch },
    { type: 'sentinel_observed', phase: 'after', pathId: sentinel, sha256: 'a'.repeat(64) },
    { type: 'cleanup_verified', residualCount: 0 },
    { type: 'episode_completed' }
  ]
  for (const event of events) appendEvent(event)
  return { batchId, runId, episodeId }
}

test('the frozen catalog is contiguous, unique and leaves reboot-only cases explicitly gated', () => {
  const catalog = evidence.loadFaultCatalog()
  assert.equal(catalog.schemaVersion, 1)
  assert.equal(catalog.faults.length, 89)
  assert.deepEqual(catalog.faults.map((entry) => entry.id), Array.from({ length: 89 }, (_, index) => index + 1))
  assert.equal(catalog.faults.filter((entry) => entry.executionMode === 'maintenance-window').length, 6)
  assert.match(catalog.sha256, /^[a-f0-9]{64}$/)
})

test('workload definitions preserve W0-W4 scope and hashes', () => {
  const workloads = evidence.loadWorkloads()
  assert.deepEqual(workloads.workloads.map((entry) => entry.id), ['W0', 'W1', 'W2', 'W3', 'W4'])
  const micro = workloads.workloads[0]
  assert.equal(micro.steps >= 8 && micro.steps <= 12, true)
  assert.equal(micro.verifiedMutations >= 3, true)
  assert.equal(micro.commandSteps >= 2, true)
  for (const workload of workloads.workloads) assert.match(workload.sha256, /^[a-f0-9]{64}$/)
  for (const workload of workloads.workloads) assert.equal(workload.stepIds.length, workload.steps)
})

test('seeded randomization is repeatable for campaign order', () => {
  const left = evidence.seededRandom(246813579)
  const right = evidence.seededRandom(246813579)
  assert.deepEqual(Array.from({ length: 20 }, () => left()), Array.from({ length: 20 }, () => right()))
})

test('run events are ordered and sealed artifacts verify before derived analysis', () => {
  const root = tempDir()
  try {
    const batch = evidence.createBatch({ root, batchId: 'E1-fixture', phase: 'PILOT', seed: 11 })
    const run = evidence.createRun(batch, {
      runId: 'run-001',
      runOrdinal: 1,
      seed: 11,
      implementationSha: 'a'.repeat(40),
      workloadId: 'W0',
      faultId: 4,
      expectedOutcome: 'RESUME',
      episodeId: 'episode-001'
    })
    passingEvents(run)
    const outcome = evidence.finalizeRun(run, { testStopReason: 'first_newer_checkpoint' })
    assert.equal(outcome.classification, 'PASS')
    assert.equal(outcome.lostVerifiedSteps, 0)
    assert.equal(outcome.verifiedMutationReplayCount, 0)
    assert.equal(outcome.duplicateEffectCount, 0)
    assert.equal(outcome.offWorkVolumeResidualCount, 0)
    assert.equal(evidence.verifyRunIntegrity(run.runDir).ok, true)
    assert.equal(evidence.appendEvent(run, { type: 'episode_completed' }).ok, false, 'sealed raw runs are immutable')

    const analysis = evidence.deriveBatch(batch.batchDir)
    assert.equal(analysis.ok, true, JSON.stringify(analysis))
    assert.equal(analysis.analysis.counts.PASS, 1)
    assert.equal(fs.existsSync(path.join(batch.batchDir, 'derived', 'fault-coverage.csv')), true)
    assert.equal(evidence.verifyBatchIntegrity(batch.batchDir).ok, true)
    fs.appendFileSync(path.join(batch.batchDir, 'derived', 'runs.csv'), 'tampered\n', 'utf8')
    assert.equal(evidence.verifyBatchIntegrity(batch.batchDir).code, 'BATCH_CHECKSUM_MISMATCH')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('independent oracles detect lost progress, replay, duplicate effects and unsafe cleanup', () => {
  const root = tempDir()
  try {
    const batch = evidence.createBatch({ root, batchId: 'E1-negative', phase: 'PILOT', seed: 17 })
    const run = evidence.createRun(batch, {
      runId: 'run-negative',
      runOrdinal: 1,
      seed: 17,
      implementationSha: 'b'.repeat(40),
      workloadId: 'W2',
      faultId: 87,
      expectedOutcome: 'RESUME',
      episodeId: 'episode-negative'
    })
    passingEvents(run)
    run.appendEvent({ type: 'mutation_effect', mutationId: 'm1', effectId: `m1:${'a'.repeat(64)}:replayed`, sha256: 'a'.repeat(64), effect: 'applied', phase: 'after_resume' })
    run.appendEvent({ type: 'mutation_effect', mutationId: 'm2', effectId: `m1:${'a'.repeat(64)}`, sha256: 'a'.repeat(64), effect: 'applied', phase: 'after_resume' })
    run.appendEvent({ type: 'checkpoint_observed', checkpointSeq: 4, cursor: { nextStepIndex: 0, verifiedStepIds: [], skippedStepIds: [] }, verifiedStepIds: [], verifiedMutationIds: [] })
    run.appendEvent({ type: 'cleanup_entry_deleted', pathId: 'unregistered-foreign-path' })
    const outcome = evidence.finalizeRun(run, { testStopReason: 'diagnostic' })
    const oracle = JSON.parse(fs.readFileSync(path.join(run.runDir, 'oracle.json'), 'utf8')).oracle
    assert.notEqual(outcome.classification, 'PASS')
    assert.equal(outcome.lostVerifiedSteps > 0, true)
    assert.equal(outcome.verifiedMutationReplayCount > 0, true)
    assert.equal(outcome.duplicateEffectCount > 0, true)
    assert.equal(oracle.O4_cursor_monotonic.pass, false)
    assert.equal(oracle.O7_cleanup_safety.pass, false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('cursor oracle rejects a cursor that jumps over an unsettled workload step', () => {
  const root = tempDir()
  try {
    const batch = evidence.createBatch({ root, batchId: 'E1-cursor-gap', phase: 'PILOT', seed: 23 })
    const run = evidence.createRun(batch, {
      runId: 'run-cursor-gap', runOrdinal: 1, seed: 23,
      implementationSha: 'd'.repeat(40), workloadId: 'W0', faultId: 4,
      expectedOutcome: 'RESUME_NO_REPLAY', episodeId: 'episode-cursor-gap'
    })
    passingEvents(run)
    const stepIds = run.manifest.workloadStepIds
    run.appendEvent({
      type: 'checkpoint_observed', checkpointSeq: 4,
      cursor: { nextStepIndex: 4, verifiedStepIds: [stepIds[1], stepIds[2], stepIds[3]], skippedStepIds: [] },
      verifiedStepIds: [stepIds[1], stepIds[2], stepIds[3]], verifiedMutationIds: ['m1']
    })
    const outcome = evidence.finalizeRun(run, { testStopReason: 'cursor_gap_fixture' })
    const oracle = JSON.parse(fs.readFileSync(path.join(run.runDir, 'oracle.json'), 'utf8')).oracle
    assert.notEqual(outcome.classification, 'PASS')
    assert.equal(oracle.O4_cursor_monotonic.pass, false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('checksum tampering is classified as invalid evidence, never PASS', () => {
  const root = tempDir()
  try {
    const batch = evidence.createBatch({ root, batchId: 'E1-tamper', phase: 'PILOT', seed: 19 })
    const run = evidence.createRun(batch, {
      runId: 'run-tamper', runOrdinal: 1, seed: 19,
      implementationSha: 'c'.repeat(40), workloadId: 'W0', faultId: 4,
      expectedOutcome: 'RESUME', episodeId: 'episode-tamper'
    })
    passingEvents(run)
    evidence.finalizeRun(run)
    fs.appendFileSync(run.eventsPath, '{"tampered":true}\n', 'utf8')
    const integrity = evidence.verifyRunIntegrity(run.runDir)
    assert.equal(integrity.ok, false)
    assert.equal(integrity.code, 'INVALID_EVIDENCE_INTEGRITY')
    const report = evidence.deriveBatch(batch.batchDir)
    assert.equal(report.ok, false)
    assert.equal(report.invalidRuns, 1)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('checksummed malformed events are invalid and unsafe path fields are rejected', () => {
  const root = tempDir()
  try {
    const batch = evidence.createBatch({ root, batchId: 'E1-schema', phase: 'PILOT', seed: 29 })
    const run = evidence.createRun(batch, {
      runId: 'run-schema', runOrdinal: 1, seed: 29,
      implementationSha: 'e'.repeat(40), workloadId: 'W0', faultId: 4,
      expectedOutcome: 'RESUME_NO_REPLAY', episodeId: 'episode-schema'
    })
    assert.equal(run.appendEvent({ type: 'sentinel_observed', phase: 'before', pathId: 'C:\\foreign\\file' }).code, 'EVENT_PATH_MUST_BE_ABSTRACT_ID')
    passingEvents(run)
    evidence.finalizeRun(run)
    const eventPath = path.join(run.runDir, 'events.jsonl')
    const lines = fs.readFileSync(eventPath, 'utf8').trimEnd().split('\n')
    const last = JSON.parse(lines[lines.length - 1])
    last.type = 'unrecognized_event'
    lines[lines.length - 1] = JSON.stringify(last)
    fs.writeFileSync(eventPath, `${lines.join('\n')}\n`, 'utf8')
    const sumsPath = path.join(run.runDir, 'SHA256SUMS.txt')
    const rows = fs.readFileSync(sumsPath, 'utf8').replace(/^([a-f0-9]{64})  events\.jsonl$/m, `${evidence.sha256File(eventPath)}  events.jsonl`)
    fs.writeFileSync(sumsPath, rows, 'utf8')
    assert.equal(evidence.verifyRunIntegrity(run.runDir).code, 'INVALID_EVIDENCE_INTEGRITY')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('the published v1 evidence schema validates every frozen raw document and rejects unknown fields', () => {
  const root = tempDir()
  try {
    const batch = evidence.createBatch({ root, batchId: 'E1-schema-contract', phase: 'PILOT', seed: 31 })
    const run = evidence.createRun(batch, {
      runId: 'run-schema-contract', runOrdinal: 1, seed: 31,
      implementationSha: 'f'.repeat(40), workloadId: 'W0', faultId: 4,
      expectedOutcome: 'RESUME_NO_REPLAY', episodeId: 'episode-schema-contract'
    })
    passingEvents(run)
    evidence.finalizeRun(run)

    const documents = [
      ['evidenceFreeze', path.join(batch.batchDir, 'evidence-freeze.json')],
      ['batchManifest', path.join(batch.batchDir, 'batch-manifest.json')],
      ['runManifest', path.join(run.runDir, 'manifest.json')],
      ['event', run.eventsPath],
      ['result', path.join(run.runDir, 'result.json')],
      ['oracleDocument', path.join(run.runDir, 'oracle.json')]
    ]
    for (const [kind, file] of documents) {
      const contents = fs.readFileSync(file, 'utf8')
      const values = kind === 'event'
        ? [JSON.parse(contents.trim().split('\n')[0])]
        : [JSON.parse(contents)]
      for (const value of values) {
        assert.equal(evidence.validateEvidenceDocument(kind, value).ok, true, `${kind} should satisfy the frozen schema`)
        assert.equal(evidence.validateEvidenceDocument(kind, { ...value, unreviewedField: 'forbidden' }).ok, false, `${kind} must reject unknown fields`)
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('evidence harness source and fixtures are covered by syntax, test and feature-branch CI gates', () => {
  const root = path.resolve(__dirname, '..', '..')
  const syntaxGate = fs.readFileSync(path.join(root, 'scripts', 'check-syntax.cjs'), 'utf8')
  const testGate = fs.readFileSync(path.join(root, 'scripts', 'test-all.ps1'), 'utf8')
  const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'verify.yml'), 'utf8')
  for (const file of [
    'scripts/engineering-recovery-evidence.cjs',
    'scripts/lib/engineering-recovery-evidence.cjs',
    'tests/fixtures/engineering-recovery/episode-worker.cjs',
    'tests/fixtures/engineering-recovery/workloads/w0.test.cjs',
    'tests/fixtures/engineering-recovery/workloads/w1.test.cjs',
    'tests/fixtures/engineering-recovery/workloads/w2.test.cjs',
    'tests/fixtures/engineering-recovery/workloads/w3.test.cjs',
    'tests/fixtures/engineering-recovery/workloads/w4.test.cjs'
  ]) {
    const joinedPath = file.split('/').join("', '")
    assert.equal(syntaxGate.includes(`'${joinedPath}'`), true, `syntax gate should list ${file}`)
  }
  assert.match(testGate, /'engineering-evidence-harness\.test\.js'/)
  assert.match(workflow, /dev\/crash-resume-recovery-v1/)
  assert.match(workflow, /Engineering recovery evidence gate/)
  assert.match(workflow, /engineering-evidence-harness\.test\.js/)
})
