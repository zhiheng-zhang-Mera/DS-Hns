'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const evidence = require('../../scripts/lib/engineering-recovery-evidence.cjs')
const e0 = require('../../scripts/lib/engineering-recovery-e0.cjs')
const e0Cli = require('../../scripts/engineering-recovery-e0.cjs')

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

function passingE0Gate(implementationSha, branch = 'dev/crash-resume-recovery-v1') {
  const startedAt = new Date().toISOString()
  return {
    schemaVersion: 1,
    runId: 'E0-fixture-001',
    branch,
    implementationSha,
    runtime: 'node-test-fixture',
    os: 'Windows test fixture',
    tempVolume: 'D:',
    startedAt,
    finishedAt: startedAt,
    gates: ['syntax', 'full-unit', 'focused-recovery', 'test-all'].map((id, index) => ({
      id,
      status: 'PASS',
      exitCode: 0,
      durationMs: index + 1,
      logSha256: String(index + 1).repeat(64),
      checkedFiles: id === 'syntax' ? 277 : null,
      totalFiles: id === 'syntax' ? 277 : null,
      tests: id === 'syntax' ? null : 1886,
      passed: id === 'syntax' ? null : 1884,
      failed: id === 'syntax' ? null : 0,
      skipped: id === 'syntax' ? null : 2
    })),
    passed: true
  }
}

test('E0 test summaries distinguish a complete green TAP run from missing or failed counts', () => {
  assert.deepEqual(e0.summarizeTestOutput('ℹ tests 12\nℹ pass 10\nℹ fail 0\nℹ skipped 2\n'), {
    tests: 12, passed: 10, failed: 0, skipped: 2, checkedFiles: null, totalFiles: null
  })
  assert.deepEqual(e0.summarizeTestOutput('# tests 3\n# pass 2\n# fail 1\n'), {
    tests: 3, passed: 2, failed: 1, skipped: 0, checkedFiles: null, totalFiles: null
  })
  assert.deepEqual(e0.summarizeTestOutput('checked 277/277 files'), {
    tests: null, passed: null, failed: null, skipped: null, checkedFiles: 277, totalFiles: 277
  })
})

test('the E0 command entry point is import-safe and exposes the runner without launching gates', () => {
  assert.equal(typeof e0Cli.runE0, 'function')
})

test('the E0 syntax gate passes only when every declared source file was checked', () => {
  const common = { id: 'syntax', exitCode: 0, durationMs: 10, logSha256: 'a'.repeat(64) }
  assert.equal(e0.makeGateRecord({ ...common, output: 'checked 277/277 files' }).status, 'PASS')
  assert.equal(e0.makeGateRecord({ ...common, output: 'checked 276/277 files' }).status, 'FAIL')
})

test('the frozen catalog is contiguous, unique and leaves reboot-only cases explicitly gated', () => {
  const catalog = evidence.loadFaultCatalog()
  assert.equal(catalog.schemaVersion, 1)
  assert.equal(catalog.faults.length, 89)
  assert.deepEqual(catalog.faults.map((entry) => entry.id), Array.from({ length: 89 }, (_, index) => index + 1))
  assert.equal(catalog.faults.filter((entry) => entry.executionMode === 'maintenance-window').length, 6)
  assert.match(catalog.sha256, /^[a-f0-9]{64}$/)
})

test('a FINAL batch cannot be created without a matching passing E0 gate', () => {
  const root = tempDir()
  try {
    const batchDir = path.join(root, 'E2-without-e0')
    assert.throws(() => evidence.createBatch({
      root,
      batchId: 'E2-without-e0',
      phase: 'FINAL',
      seed: 7,
      implementationSha: 'a'.repeat(40),
      harnessSha: 'a'.repeat(40),
      sourceRef: 'dev/crash-resume-recovery-v1'
    }), /passing E0 gate/)
    assert.equal(fs.existsSync(batchDir), false, 'a rejected final batch must leave no partial directory')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a FINAL batch freezes and checksums its exact passing E0 evidence', () => {
  const root = tempDir()
  const commit = 'b'.repeat(40)
  try {
    const gate = passingE0Gate(commit)
    const batch = evidence.createBatch({
      root, batchId: 'E2-e0-bound', phase: 'FINAL', seed: 11,
      implementationSha: commit, harnessSha: commit,
      sourceRef: 'dev/crash-resume-recovery-v1', e0Gate: gate
    })
    const gatePath = path.join(batch.batchDir, 'e0-gate.json')
    const manifest = JSON.parse(fs.readFileSync(path.join(batch.batchDir, 'batch-manifest.json'), 'utf8'))
    const freeze = JSON.parse(fs.readFileSync(path.join(batch.batchDir, 'evidence-freeze.json'), 'utf8'))
    assert.equal(evidence.validateEvidenceDocument('e0Gate', gate).ok, true)
    assert.equal(manifest.e0GateSha256, evidence.sha256File(gatePath))
    assert.equal(freeze.e0GateSha256, manifest.e0GateSha256)
    const diskGate = JSON.parse(fs.readFileSync(gatePath, 'utf8'))
    assert.deepEqual(diskGate, gate)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a FINAL batch rejects a syntax gate whose checked-file count is incomplete', () => {
  const root = tempDir()
  const commit = 'd'.repeat(40)
  const gate = passingE0Gate(commit)
  gate.gates[0].checkedFiles = 276
  try {
    assert.equal(evidence.passesE0Gate(gate), false)
    assert.throws(() => evidence.createBatch({
      root, batchId: 'E2-bad-e0-count', phase: 'FINAL', seed: 13,
      implementationSha: commit, harnessSha: commit,
      sourceRef: 'dev/crash-resume-recovery-v1', e0Gate: gate
    }), /passing E0 gate/)
    assert.equal(fs.existsSync(path.join(root, 'E2-bad-e0-count')), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('the FINAL W0 fault-04 CLI refuses to create a batch when E0 evidence is absent', () => {
  const root = path.resolve(__dirname, '..', '..')
  const batchId = `E2-no-e0-${process.pid}`
  const batchDir = path.join(root, 'runtime', 'engineering', 'evidence', 'recovery', batchId)
  const cli = path.join(root, 'scripts', 'engineering-recovery-evidence.cjs')
  const result = spawnSync(process.execPath, [
    cli, '--mode', 'final-w0-fault04', '--seed', '19', '--batch-id', batchId
  ], { cwd: root, encoding: 'utf8', windowsHide: true, env: process.env })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /FINAL_E0_GATE_REQUIRED/)
  assert.equal(fs.existsSync(batchDir), false)
})

test('FINAL analysis records conservative gate states, per-fault NOT_RUN reasons and batch identity', () => {
  const root = tempDir()
  try {
    const commit = 'c'.repeat(40)
    const batch = evidence.createBatch({
      root, batchId: 'E2-report-no-observations', phase: 'FINAL', seed: 29,
      implementationSha: commit, harnessSha: commit,
      sourceRef: 'dev/crash-resume-recovery-v1', e0Gate: passingE0Gate(commit)
    })
    const result = evidence.deriveBatch(batch.batchDir)
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.analysis.acceptanceStatus, 'HNS_INTEGRATION_RC_NOT_READY')
    assert.equal(result.analysis.faultCoverage.notRun, 89)
    assert.deepEqual(result.analysis.faultCoverage.notRunByStatus, {
      NOT_RUN_IMPLEMENTED_FAULT: 1,
      NOT_RUN_MAINTENANCE_WINDOW: 6,
      NOT_RUN_NO_ADAPTER: 82
    })
    const coverage = fs.readFileSync(path.join(batch.batchDir, 'derived', 'fault-coverage.csv'), 'utf8')
    assert.match(coverage, /NOT_RUN_IMPLEMENTED_FAULT/)
    assert.match(coverage, /NOT_RUN_MAINTENANCE_WINDOW/)
    assert.match(coverage, /NOT_RUN_NO_ADAPTER/)
    const report = fs.readFileSync(path.join(batch.batchDir, 'FINAL_EVIDENCE_REPORT.md'), 'utf8')
    assert.match(report, /\| A1 \| PASS \|/)
    assert.match(report, /\| A2 \| NOT_READY \|/)
    assert.match(report, /\| A6 \| NOT_RUN \|/)
    assert.match(report, /\| syntax \| PASS \| 277\/277 source files checked \|/)
    assert.match(report, /\| full-unit \| PASS \| 1884\/1886 passed; 0 failed; 2 skipped \|/)
    assert.match(report, /E4 paired baseline: NOT_RUN; N=0/)
    assert.match(report, /Batch SHA256SUMS\.txt SHA-256: [a-f0-9]{64}/)
    assert.ok(report.includes(evidence.sha256File(path.join(batch.batchDir, 'SHA256SUMS.txt'))))
    assert.equal(evidence.verifyBatchIntegrity(batch.batchDir).ok, true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
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
    'scripts/engineering-recovery-e0.cjs',
    'scripts/engineering-recovery-evidence.cjs',
    'scripts/lib/engineering-recovery-e0.cjs',
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
  assert.match(workflow, /engineering-recovery-e0\.cjs/)
})
