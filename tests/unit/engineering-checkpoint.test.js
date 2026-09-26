'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  createCheckpointStore,
  verifyResume,
  truncateOutput,
  summarizeTestOutput,
  CHECKPOINT_VERSION
} = require('../../app/engineering/checkpoint.cjs')
const repository = require('../../app/engineering/repository.cjs')
const { createMutationLog, hashContent } = require('../../app/engineering/mutation.cjs')

/**
 * Checkpoints and the resume gate.
 *
 * The runtime is killed, not shut down, so every test here is about what survives
 * a kill: a checkpoint that either lands whole or not at all, a reader that
 * refuses to be defeated by one corrupt file, a prune that keeps a directory from
 * growing forever, and a `verifyResume` that re-checks the world instead of
 * trusting the file. `verifyResume` is also asserted to be read-only, because a
 * gate that mutates is not a gate.
 *
 * Every test builds a real temporary directory and removes it in `finally`, and
 * every clock is injected, so the results do not depend on the machine.
 */

/** A temporary directory removed when the test ends. */
function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'eng-checkpoint-'))
}

/** A clock the test drives by hand. */
function clockFrom(start = 1_700_000_000_000) {
  let value = start
  return {
    now: () => value,
    advance(ms = 60_000) {
      value += ms
      return value
    }
  }
}

/** The `.json` checkpoint files on disk, sorted. */
function checkpointFiles(dir) {
  try {
    return fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort()
  } catch {
    return []
  }
}

test('a checkpoint round-trips through disk with every saved field intact', () => {
  const dir = tempDir()
  try {
    const clock = clockFrom()
    const store = createCheckpointStore({ dir, now: clock.now })
    const saved = store.save({
      episodeId: 'episode 1/with spaces',
      goal: 'make the flaky test deterministic',
      workspace: 'D:\\work\\repo',
      fingerprint: { head: 'abc123', branch: 'main', dirtyHash: 'd1', manifestHash: 'm1', testConfigHash: 't1' },
      plan: [{ id: 's1', description: 'read the test' }, { id: 's2', description: 'fix the race' }],
      cursor: { step: 's2', index: 1 },
      verifiedMutations: [{ id: 'm1', result: 'applied', path: 'test/a.test.js' }],
      ownedProcesses: [{ id: 'p1', pid: 4242, status: 'running' }],
      lastFailure: { class: 'unit-test', signature: 'unit-test|test|sig' },
      progress: { completed: 1, total: 2 },
      phase: 'REPAIRING'
    })
    assert.equal(saved.ok, true)
    assert.equal(fs.existsSync(saved.path), true)
    assert.equal(fs.statSync(saved.path).size, saved.bytes)

    const read = store.latest('episode 1/with spaces')
    assert.equal(read.version, CHECKPOINT_VERSION)
    assert.equal(read.episodeId, 'episode 1/with spaces')
    assert.equal(read.goal, 'make the flaky test deterministic')
    assert.equal(read.phase, 'REPAIRING')
    assert.equal(read.cursor.step, 's2')
    assert.equal(read.plan.length, 2)
    assert.equal(read.fingerprint.head, 'abc123')
    assert.deepEqual(read.verifiedMutations, [{ id: 'm1', result: 'applied', path: 'test/a.test.js' }])
    assert.deepEqual(read.ownedProcesses, [{ id: 'p1', pid: 4242, status: 'running' }])
    assert.deepEqual(read.lastFailure, { class: 'unit-test', signature: 'unit-test|test|sig' })
    assert.deepEqual(read.progress, { completed: 1, total: 2 })
    assert.equal(read.at, 1_700_000_000_000)
    assert.equal(store.latest('episode_1_with_spaces').cursor.step, 's2', 'the same episode is found under its file-name spelling')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the checkpoint directory defaults under the root option instead of a hardcoded path', () => {
  const root = tempDir()
  try {
    const store = createCheckpointStore({ root })
    assert.equal(store.dir, path.join(root, 'runtime', 'engineering', 'checkpoints'))
    assert.equal(store.maxFiles, 5)
    const explicit = createCheckpointStore({ root, dir: path.join(root, 'elsewhere'), maxFiles: 2 })
    assert.equal(explicit.dir, path.join(root, 'elsewhere'))
    assert.equal(explicit.maxFiles, 2)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('recovery checkpoints preserve the full recovery descriptor and assign the first sequence', () => {
  const dir = tempDir()
  try {
    const descriptor = {
      version: 1,
      episodeId: 'ep',
      request: {
        workspace: 'D:\\work\\fixture',
        goal: 'continue from the next safe step',
        startedAt: 1_700_000_000_000,
        deadlineAt: 1_700_086_400_000,
        contract: { maxSteps: 8 }
      },
      plan: {
        version: 1,
        steps: [{ id: 'step-1', kind: 'test', command: 'node --test' }]
      },
      planDigest: 'sha256:fixture-digest',
      cursor: { nextStepIndex: 0, lastVerifiedStepId: null },
      executorCompatibility: 'engineering-v1',
      workRoot: 'D:\\work',
      crossVolumeTemp: []
    }
    const store = createCheckpointStore({ dir, now: () => 1_700_000_000_000 })
    const saved = store.save({
      episodeId: 'ep',
      goal: descriptor.request.goal,
      workspace: descriptor.request.workspace,
      plan: descriptor.plan.steps,
      cursor: { step: 'step-1', index: 0 },
      recovery: descriptor
    })
    assert.equal(saved.ok, true)

    const checkpoint = store.latest('ep')
    assert.deepEqual(checkpoint && checkpoint.recovery, {
      ...descriptor,
      cursor: { ...descriptor.cursor, checkpointSeq: 1 }
    }, 'the complete recovery contract must survive the atomic checkpoint write')
    assert.equal(checkpoint.version, 2, 'the checkpoint schema changes once to carry recovery state')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the latest recovery checkpoint follows checkpointSeq when the wall clock moves backward', () => {
  const dir = tempDir()
  try {
    let at = 1_700_000_000_000
    const store = createCheckpointStore({ dir, now: () => at })
    const recovery = (nextStepIndex) => ({
      version: 1,
      episodeId: 'ep',
      request: { workspace: 'D:\\work\\fixture', goal: 'resume safely', startedAt: 1_700_000_000_000, deadlineAt: 1_700_086_400_000, contract: {} },
      plan: { version: 1, steps: [{ id: 'step-1' }, { id: 'step-2' }] },
      planDigest: 'sha256:fixture-digest',
      cursor: { nextStepIndex, lastVerifiedStepId: nextStepIndex ? 'step-1' : null },
      executorCompatibility: 'engineering-v1',
      workRoot: 'D:\\work',
      crossVolumeTemp: []
    })

    assert.equal(store.save({ episodeId: 'ep', recovery: recovery(0) }).ok, true)
    at -= 60_000
    assert.equal(store.save({ episodeId: 'ep', recovery: recovery(1) }).ok, true)

    const latest = store.latest('ep')
    assert.equal(latest.recovery.cursor.checkpointSeq, 2, 'logical checkpoint order must not depend on a clock correction')
    assert.equal(latest.recovery.cursor.nextStepIndex, 1, 'the newest verified next-safe cursor must be restored')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a corrupt checkpoint is skipped and latest() still returns the newest good one', () => {
  const dir = tempDir()
  try {
    const clock = clockFrom()
    const store = createCheckpointStore({ dir, now: clock.now, maxFiles: 5 })
    store.save({ episodeId: 'ep', cursor: { step: 'one' } })
    clock.advance()
    store.save({ episodeId: 'ep', cursor: { step: 'two' } })
    clock.advance()
    const newest = store.save({ episodeId: 'ep', cursor: { step: 'three' } })
    fs.writeFileSync(newest.path, '{ "cursor": { "step": "thr', 'utf8')

    const latest = store.latest('ep')
    assert.equal(latest.cursor.step, 'two', 'the newest readable checkpoint wins, not the newest file')
    const listed = store.list('ep')
    assert.equal(listed.length, 3, 'list() is a filesystem view and still shows the corrupt file')
    assert.equal(listed[0].path, newest.path)
    assert.equal(listed[0].at > listed[1].at, true)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a half-written temporary file is never read as a checkpoint', () => {
  const dir = tempDir()
  try {
    const clock = clockFrom()
    const store = createCheckpointStore({ dir, now: clock.now })
    const saved = store.save({ episodeId: 'ep', cursor: { step: 'good' } })
    // The shape a killed writer leaves behind: the payload is valid JSON, the
    // name says it was never renamed into place, and it is newer than the good one.
    clock.advance()
    fs.writeFileSync(path.join(dir, `ep.${String(clock.now()).padStart(16, '0')}-000001.json.tmp-4242`), JSON.stringify({ cursor: { step: 'ghost' } }), 'utf8')
    assert.equal(store.latest('ep').cursor.step, 'good')
    assert.equal(store.list('ep').length, 1)
    assert.deepEqual(checkpointFiles(dir), [path.basename(saved.path)])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('list() is newest first and prune() keeps at most maxFiles checkpoints per episode', () => {
  const dir = tempDir()
  try {
    const clock = clockFrom()
    const writer = createCheckpointStore({ dir, now: clock.now, maxFiles: 10 })
    for (let index = 1; index <= 7; index += 1) {
      writer.save({ episodeId: 'ep', cursor: { step: index } })
      clock.advance()
    }
    writer.save({ episodeId: 'other', cursor: { step: 'kept' } })
    assert.equal(checkpointFiles(dir).length, 8)

    const bounded = createCheckpointStore({ dir, now: clock.now, maxFiles: 3 })
    const pruned = bounded.prune('ep')
    assert.equal(pruned.removed, 4)
    assert.equal(checkpointFiles(dir).length, 4, 'the other episode keeps its checkpoint')
    assert.equal(checkpointFiles(dir).filter((name) => name.startsWith('other.')).length, 1)
    const listed = bounded.list('ep')
    assert.equal(listed.length, 3)
    assert.deepEqual(listed.map((entry) => entry.at), [...listed.map((entry) => entry.at)].sort((a, b) => b - a), 'newest first')
    assert.deepEqual(checkpointFiles(dir).filter((name) => name.startsWith('ep.')), [
      `ep.${String(1_700_000_000_000 + 4 * 60_000).padStart(16, '0')}-000005.json`,
      `ep.${String(1_700_000_000_000 + 5 * 60_000).padStart(16, '0')}-000006.json`,
      `ep.${String(1_700_000_000_000 + 6 * 60_000).padStart(16, '0')}-000007.json`
    ], 'the oldest checkpoints are the ones that go')
    assert.deepEqual(bounded.prune('ep'), { removed: 0, files: [] }, 'prune is idempotent')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('save() enforces maxFiles by itself and leaves no temporary files behind', () => {
  const dir = tempDir()
  try {
    const clock = clockFrom()
    const store = createCheckpointStore({ dir, now: clock.now, maxFiles: 2 })
    for (let index = 0; index < 6; index += 1) {
      store.save({ episodeId: 'ep', cursor: { step: index } })
      clock.advance()
    }
    assert.equal(store.list('ep').length, 2)
    assert.equal(fs.readdirSync(dir).some((name) => name.includes('.tmp')), false)
    assert.equal(store.latest('ep').cursor.step, 5)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('remove() discards one episode and leaves the others alone', () => {
  const dir = tempDir()
  try {
    const clock = clockFrom()
    const store = createCheckpointStore({ dir, now: clock.now, maxFiles: 10 })
    store.save({ episodeId: 'doomed', cursor: { step: 'a' } })
    store.save({ episodeId: 'survivor', cursor: { step: 'b' } })
    clock.advance()
    store.save({ episodeId: 'doomed', cursor: { step: 'c' } })
    const removed = store.remove('doomed')
    assert.equal(removed.removed, 2)
    assert.equal(store.latest('doomed'), null)
    assert.equal(store.list('doomed').length, 0)
    assert.equal(store.latest('survivor').cursor.step, 'b')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('latest() returns null — never throws — for a missing directory, an unknown episode and corrupt-only files', () => {
  const dir = tempDir()
  try {
    const store = createCheckpointStore({ dir: path.join(dir, 'does-not-exist'), now: clockFrom().now })
    assert.equal(store.latest('ep'), null)
    assert.deepEqual(store.list('ep'), [])
    assert.deepEqual(store.prune('ep'), { removed: 0, files: [] })
    assert.equal(store.latest(), null)

    const clock = clockFrom()
    const existing = createCheckpointStore({ dir, now: clock.now })
    assert.equal(existing.latest('unknown-episode'), null)
    const saved = existing.save({ episodeId: 'corrupt-only', cursor: { step: 1 } })
    fs.writeFileSync(saved.path, 'not json at all', 'utf8')
    assert.equal(existing.latest('corrupt-only'), null)
    assert.equal(existing.list('corrupt-only').length, 1)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('truncateOutput keeps the head, the tail and the region around the first error', () => {
  const lines = []
  for (let index = 0; index < 4000; index += 1) {
    lines.push(`build line ${String(index).padStart(4, '0')} ${'x'.repeat(40)}`)
  }
  lines.splice(2000, 0, 'ERROR: the bundler failed here')
  const text = lines.join('\n')
  const originalBytes = Buffer.byteLength(text, 'utf8')
  const result = truncateOutput(text, { maxBytes: 2048 })

  assert.equal(result.truncated, true)
  assert.equal(result.originalBytes, originalBytes)
  assert.equal(result.bytes <= 2048, true, 'the returned text is inside the ceiling')
  assert.equal(result.bytes < result.originalBytes, true)
  assert.equal(result.text.startsWith(result.head), true)
  assert.equal(result.head.length > 0 && result.tail.length > 0, true)
  assert.equal(result.text.includes('build line 0000'), true, 'the head says what was being run')
  assert.equal(result.text.includes('build line 3999'), true, 'the tail says how it ended')
  assert.equal(result.text.includes('ERROR: the bundler failed here'), true, 'the error region survives the cut')
  assert.equal(result.errorRegion.includes('ERROR: the bundler failed here'), true)
  assert.equal(result.errorRegion.includes('build line 1998'), true, 'the region carries the lines before the error')
})

test('truncateOutput reports no region when nothing matches, and leaves a small output alone', () => {
  const small = 'step one\nAssertionError: expected 1 to equal 2\nstep three'
  const kept = truncateOutput(small, { maxBytes: 4096 })
  assert.equal(kept.truncated, false)
  assert.equal(kept.text, small)
  assert.equal(kept.bytes, kept.originalBytes)
  assert.equal(kept.errorRegion.includes('AssertionError'), true)

  const clean = truncateOutput('all good\nstill good', { maxBytes: 4096 })
  assert.equal(clean.truncated, false)
  assert.equal(clean.errorRegion, null, 'a clean log has no error region')

  const disabled = truncateOutput('ERROR: ignored on purpose', { maxBytes: 4096, errorPattern: null })
  assert.equal(disabled.errorRegion, null)

  const custom = truncateOutput('a\nBOOM: custom\nd', { maxBytes: 4096, errorPattern: /BOOM/ })
  assert.equal(custom.errorRegion.includes('BOOM: custom'), true)
})

test('summarizeTestOutput extracts the failure summary, failed cases, traces, last lines and artifacts', () => {
  const output = [
    'not ok 1 - adds two numbers',
    '  at Object.<anonymous> (/repo/test/math.test.js:12:9)',
    '✖ renders the empty state (18ms)',
    'FAIL src/ui/panel.test.js',
    '● ui panel › shows the empty state',
    '  at render (/repo/src/ui/panel.test.js:31:5)',
    'FAILED tests/test_api.py::test_health - AssertionError: 503 != 200',
    'File "/repo/tests/test_api.py", line 44, in test_health',
    '    assert response.status == 200',
    'Tests: 3 failed, 12 passed, 15 total',
    'junit report written to test-results/junit.xml',
    'coverage/index.html'
  ].join('\n')
  const summary = summarizeTestOutput(output, { maxBytes: 16384 })

  assert.equal(summary.truncated, false)
  assert.equal(summary.summary.includes('3 failed of 15'), true)
  assert.equal(summary.summary.includes('12 passed'), true)
  assert.equal(summary.failedCases.includes('adds two numbers'), true)
  assert.equal(summary.failedCases.includes('renders the empty state'), true, 'the duration is not part of the case name')
  assert.equal(summary.failedCases.includes('src/ui/panel.test.js'), true)
  assert.equal(summary.failedCases.includes('ui panel › shows the empty state'), true)
  assert.equal(summary.failedCases.includes('tests/test_api.py::test_health'), true)
  assert.equal(summary.stackTraces.some((trace) => trace.includes('at Object.<anonymous> (/repo/test/math.test.js:12:9)')), true)
  assert.equal(summary.stackTraces.some((trace) => trace.includes('File "/repo/tests/test_api.py", line 44, in test_health')), true)
  assert.equal(summary.stackTraces.some((trace) => trace.includes('assert response.status == 200')), true, 'a python trace keeps its source line')
  assert.deepEqual(summary.lastLines.slice(-1), ['coverage/index.html'])
  assert.equal(summary.artifactPaths.includes('test-results/junit.xml'), true)
  assert.equal(summary.artifactPaths.includes('coverage/index.html'), true)
})

test('summarizeTestOutput bounds a huge suite and says it truncated', () => {
  const lines = []
  for (let index = 0; index < 20000; index += 1) {
    lines.push(`ok ${index} - case number ${index} ${'y'.repeat(30)}`)
  }
  lines.splice(10000, 0, 'not ok 10001 - the one that broke')
  lines.push('Tests: 1 failed, 20000 passed, 20001 total')
  const output = lines.join('\n')
  const summary = summarizeTestOutput(output, { maxBytes: 4096 })
  assert.equal(summary.truncated, true)
  assert.equal(summary.summary.includes('1 failed of 20001'), true, 'the counts come from the whole output')
  assert.equal(summary.summary.includes('truncated from'), true)
  assert.equal(summary.failedCases.includes('the one that broke'), true)
  assert.equal(summary.lastLines.length <= 20, true)
})

/** A checkpoint over a real temporary workspace, for the resume tests. */
function checkpointFor(workspace, extra = {}) {
  return {
    version: CHECKPOINT_VERSION,
    episodeId: 'ep',
    at: 1_700_000_000_000,
    goal: 'green the suite',
    workspace,
    fingerprint: repository.fingerprint({ root: workspace }),
    plan: [{ id: 's1' }],
    cursor: { step: 's1' },
    verifiedMutations: [],
    ownedProcesses: [],
    lastFailure: null,
    progress: { completed: 0, total: 1 },
    phase: 'TESTING',
    ...extra
  }
}

test('verifyResume resumes an unchanged world', () => {
  const workspace = tempDir()
  try {
    fs.writeFileSync(path.join(workspace, 'a.txt'), 'unchanged', 'utf8')
    const checkpoint = checkpointFor(workspace)
    const verdict = verifyResume({
      checkpoint,
      workspace,
      fingerprint: repository.fingerprint({ root: workspace }),
      gitState: repository.gitState(workspace)
    })
    assert.equal(verdict.action, 'resume')
    assert.equal(verdict.ok, true)
    assert.deepEqual(verdict.reasons, [])
    assert.equal(verdict.staleMutation, null)
    assert.deepEqual(verdict.missingProcesses, [])
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test('verifyResume restarts when HEAD moved', () => {
  const workspace = tempDir()
  try {
    const checkpoint = checkpointFor(workspace)
    const verdict = verifyResume({
      checkpoint,
      workspace,
      fingerprint: { ...checkpoint.fingerprint, head: 'ffffffff' },
      gitState: { head: 'ffffffff', branch: checkpoint.fingerprint.branch }
    })
    assert.equal(verdict.action, 'restart')
    assert.equal(verdict.ok, false)
    assert.equal(verdict.reasons.some((reason) => reason.includes('HEAD moved')), true)
    assert.equal(verdict.drift.drifted, true)
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test('verifyResume restarts when a manifest drifted under the same HEAD', () => {
  const workspace = tempDir()
  try {
    const checkpoint = checkpointFor(workspace)
    // The world moves without a commit: somebody edits the manifest.
    fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ name: 'moved' }), 'utf8')
    const verdict = verifyResume({ checkpoint, workspace, fingerprint: repository.fingerprint({ root: workspace }) })
    assert.equal(verdict.action, 'restart')
    assert.equal(verdict.reasons.some((reason) => reason.includes('manifest')), true)
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test('verifyResume refuses when the workspace is gone or is a different workspace', () => {
  const root = tempDir()
  try {
    const gone = path.join(root, 'gone')
    const goneCheckpoint = checkpointFor(root, { workspace: gone })
    const refused = verifyResume({ checkpoint: goneCheckpoint, workspace: gone })
    assert.equal(refused.action, 'refuse')
    assert.equal(refused.ok, false)
    assert.equal(refused.reasons.some((reason) => reason.includes('not usable')), true)

    const first = path.join(root, 'first')
    const second = path.join(root, 'second')
    fs.mkdirSync(first)
    fs.mkdirSync(second)
    const moved = verifyResume({ checkpoint: checkpointFor(first), workspace: second, fingerprint: repository.fingerprint({ root: first }) })
    assert.equal(moved.action, 'refuse')
    assert.equal(moved.reasons.some((reason) => reason.includes('workspace moved')), true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a pending mutation whose effect is already on disk resumes as already-complete', () => {
  const workspace = tempDir()
  try {
    const target = path.join(workspace, 'patched.txt')
    const content = 'the repaired content'
    // The shape a crash leaves: the mutation was planned, the write happened, the
    // verification never did.
    const pending = {
      id: 'm1',
      at: 1_700_000_000_000,
      kind: 'write',
      path: target,
      relative: 'patched.txt',
      to: null,
      reason: 'apply the repair',
      step: 's1',
      before: null,
      after: null,
      result: 'pending',
      verification: null,
      dryRun: false,
      intended: { bytes: Buffer.byteLength(content), hash: hashContent(Buffer.from(content)) }
    }
    fs.writeFileSync(target, content, 'utf8')
    const mutationLog = createMutationLog({ now: () => 1_700_000_000_000 })
    const verdict = verifyResume({
      checkpoint: checkpointFor(workspace, { verifiedMutations: [pending] }),
      workspace,
      fingerprint: repository.fingerprint({ root: workspace }),
      mutationLog
    })
    assert.equal(verdict.action, 'resume')
    assert.equal(verdict.ok, true)
    assert.equal(verdict.staleMutation, null)
    assert.equal(verdict.mutations.length, 1)
    assert.equal(verdict.mutations[0].verdict, 'already_complete')
    assert.equal(verdict.reasons.some((reason) => reason.includes('already on disk')), true)
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test('a pending mutation that conflicts with the file on disk forces a restart', () => {
  const workspace = tempDir()
  try {
    const target = path.join(workspace, 'conflicted.txt')
    const pending = {
      id: 'm2',
      at: 1_700_000_000_000,
      kind: 'write',
      path: target,
      relative: 'conflicted.txt',
      to: null,
      reason: 'apply the repair',
      step: 's1',
      before: hashContent(Buffer.from('what the file held before the episode')),
      after: null,
      result: 'pending',
      verification: null,
      dryRun: false,
      intended: { bytes: 8, hash: hashContent(Buffer.from('intended')) }
    }
    fs.writeFileSync(target, 'somebody else wrote this', 'utf8')
    const mutationLog = createMutationLog({ now: () => 1_700_000_000_000 })
    const verdict = verifyResume({
      checkpoint: checkpointFor(workspace, { verifiedMutations: [pending] }),
      workspace,
      fingerprint: repository.fingerprint({ root: workspace }),
      mutationLog
    })
    assert.equal(verdict.action, 'restart')
    assert.equal(verdict.ok, false)
    assert.equal(verdict.staleMutation.id, 'm2')
    assert.equal(verdict.staleMutation.path, target)
    assert.equal(verdict.mutations[0].verdict, 'failed')
    assert.equal(verdict.reasons.some((reason) => reason.includes('no longer matches the file on disk')), true)
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test('verifyResume will not resume over a pending mutation it cannot re-check', () => {
  const workspace = tempDir()
  try {
    const pending = { id: 'm3', kind: 'write', path: path.join(workspace, 'x.txt'), result: 'pending' }
    const verdict = verifyResume({
      checkpoint: checkpointFor(workspace, { verifiedMutations: [pending] }),
      workspace,
      fingerprint: repository.fingerprint({ root: workspace })
    })
    assert.equal(verdict.action, 'restart')
    assert.equal(verdict.reasons.some((reason) => reason.includes('cannot be re-checked')), true)
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test('missing owned processes are reported, and the checkpoint is still resumable', () => {
  const workspace = tempDir()
  try {
    const owned = [
      { id: 'p-live', pid: 4242, command: 'npm test', status: 'running' },
      { id: 'p-gone', pid: 4343, command: 'npm test', status: 'running' },
      { id: 'p-settled', pid: 4444, command: 'npm test', status: 'exited' }
    ]
    const verdict = verifyResume({
      checkpoint: checkpointFor(workspace, { ownedProcesses: owned }),
      workspace,
      fingerprint: repository.fingerprint({ root: workspace }),
      processes: [{ id: 'p-live', pid: 4242 }]
    })
    assert.equal(verdict.action, 'resume')
    assert.deepEqual(verdict.missingProcesses.map((entry) => entry.id), ['p-gone'])
    assert.equal(verdict.reasons.some((reason) => reason.includes('no longer running')), true)
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test('verifyResume only inspects: nothing on disk changes', () => {
  const workspace = tempDir()
  const dir = tempDir()
  try {
    const target = path.join(workspace, 'tracked.txt')
    fs.writeFileSync(target, 'do not touch', 'utf8')
    const clock = clockFrom()
    const store = createCheckpointStore({ dir, now: clock.now })
    const saved = store.save(checkpointFor(workspace, { episodeId: 'inspect' }))
    const before = {
      content: fs.readFileSync(target, 'utf8'),
      checkpoint: fs.readFileSync(saved.path, 'utf8'),
      files: checkpointFiles(dir),
      workspace: fs.readdirSync(workspace).sort()
    }
    const verdict = verifyResume({
      checkpoint: store.latest('inspect'),
      workspace,
      fingerprint: repository.fingerprint({ root: workspace }),
      gitState: repository.gitState(workspace),
      processes: []
    })
    assert.equal(verdict.action, 'resume')
    assert.equal(fs.readFileSync(target, 'utf8'), before.content)
    assert.equal(fs.readFileSync(saved.path, 'utf8'), before.checkpoint)
    assert.deepEqual(checkpointFiles(dir), before.files)
    assert.deepEqual(fs.readdirSync(workspace).sort(), before.workspace)
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('verifyResume restarts when there is no checkpoint at all', () => {
  const workspace = tempDir()
  try {
    const verdict = verifyResume({ checkpoint: null, workspace, fingerprint: repository.fingerprint({ root: workspace }) })
    assert.equal(verdict.action, 'restart')
    assert.equal(verdict.ok, false)
    assert.equal(verdict.reasons.length, 1)
    assert.equal(verdict.staleMutation, null)
    assert.deepEqual(verdict.missingProcesses, [])
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})
