'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const engineering = require('../../app/engineering/index.cjs')

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'eng-recovery-store-'))
}

function recoveryDescriptor(episodeId = 'ep') {
  const workspace = 'D:\\work\\fixture'
  const plan = { version: 1, steps: [{ id: 'step-1', kind: 'test', command: 'node --test' }] }
  return {
    version: 1,
    episodeId,
    request: { workspace, goal: 'resume safely', startedAt: 1_700_000_000_000, deadlineAt: 1_700_086_400_000, contract: { maxSteps: 4 } },
    plan,
    planDigest: 'sha256:fixture-digest',
    cursor: { nextStepIndex: 0, lastVerifiedStepId: null },
    executorCompatibility: 'engineering-v1',
    workRoot: 'D:\\work',
    crossVolumeTemp: []
  }
}

function recordCheckpoint(runtimeRoot, episodeId = 'ep', now = () => 1_700_000_000_000) {
  const checkpointDir = path.join(runtimeRoot, 'checkpoints')
  const checkpoints = engineering.createCheckpointStore({ dir: checkpointDir, now })
  const saved = checkpoints.save({ episodeId, recovery: recoveryDescriptor(episodeId) })
  assert.equal(saved.ok, true)
  return { checkpointDir, saved }
}

function makeStore(options) {
  assert.equal(typeof engineering.createRecoveryStore, 'function', 'the recovery-store factory must be exported')
  return engineering.createRecoveryStore(options)
}

test('the engineering public API exposes a durable recovery-store factory', () => {
  assert.equal(
    typeof engineering.createRecoveryStore,
    'function',
    'startup recovery needs one durable index and claim store'
  )
})

test('a written recovery checkpoint is indexed as ACTIVE using its persisted sequence and filename', () => {
  const root = tempDir()
  try {
    const { checkpointDir, saved } = recordCheckpoint(root)
    const store = makeStore({ root, checkpointDir, now: () => 1_700_000_001_000 })
    const recorded = store.recordCheckpoint({ episodeId: 'ep', checkpointPath: saved.path })

    assert.equal(recorded.ok, true)
    assert.equal(recorded.entry.episodeId, 'ep')
    assert.equal(recorded.entry.state, 'ACTIVE')
    assert.equal(recorded.entry.latestCheckpointSeq, 1)
    assert.equal(recorded.entry.latestCheckpointFile, path.basename(saved.path))
    const index = JSON.parse(fs.readFileSync(path.join(root, 'recovery-index.json'), 'utf8'))
    assert.equal(index.version, 1)
    assert.equal(index.episodes.ep.state, 'ACTIVE')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('the recovery index refuses a checkpoint that is absent or outside its checkpoint directory', () => {
  const root = tempDir()
  try {
    const checkpointDir = path.join(root, 'checkpoints')
    const outside = path.join(root, 'foreign.json')
    fs.writeFileSync(outside, JSON.stringify({ version: 2, episodeId: 'ep', recovery: recoveryDescriptor() }), 'utf8')
    const store = makeStore({ root, checkpointDir })

    const missing = store.recordCheckpoint({ episodeId: 'ep', checkpointPath: path.join(checkpointDir, 'missing.json') })
    const foreign = store.recordCheckpoint({ episodeId: 'ep', checkpointPath: outside })
    assert.equal(missing.ok, false)
    assert.equal(missing.code, 'CHECKPOINT_MISSING')
    assert.equal(foreign.ok, false)
    assert.equal(foreign.code, 'CHECKPOINT_OUTSIDE_ROOT')
    assert.equal(store.get('ep'), null, 'rejected pointers must not create index state')
    assert.equal(fs.existsSync(path.join(root, 'recovery-index.json')), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('the recovery index refuses to regress to an older checkpoint sequence', () => {
  const root = tempDir()
  try {
    let at = 1_700_000_000_000
    const checkpointDir = path.join(root, 'checkpoints')
    const checkpoints = engineering.createCheckpointStore({ dir: checkpointDir, now: () => at })
    const first = checkpoints.save({ episodeId: 'ep', recovery: recoveryDescriptor() })
    at += 1_000
    const second = checkpoints.save({ episodeId: 'ep', recovery: recoveryDescriptor() })
    const store = makeStore({ root, checkpointDir })
    assert.equal(store.recordCheckpoint({ episodeId: 'ep', checkpointPath: second.path }).ok, true)

    const regression = store.recordCheckpoint({ episodeId: 'ep', checkpointPath: first.path })
    assert.equal(regression.ok, false)
    assert.equal(regression.code, 'CHECKPOINT_SEQUENCE_REGRESSION')
    assert.equal(store.get('ep').latestCheckpointSeq, 2)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a missing recovery index is reconstructed from the highest valid checkpoint sequence', () => {
  const root = tempDir()
  try {
    let at = 1_700_000_000_000
    const checkpointDir = path.join(root, 'checkpoints')
    const checkpoints = engineering.createCheckpointStore({ dir: checkpointDir, now: () => at })
    checkpoints.save({ episodeId: 'ep', recovery: recoveryDescriptor() })
    at += 1_000
    const latest = checkpoints.save({ episodeId: 'ep', recovery: recoveryDescriptor() })
    const store = makeStore({ root, checkpointDir })

    const repaired = store.reconcileIndex()
    assert.equal(repaired.ok, true)
    assert.equal(repaired.repairedEpisodes, 1)
    assert.equal(store.get('ep').latestCheckpointSeq, 2)
    assert.equal(store.get('ep').latestCheckpointFile, path.basename(latest.path))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a corrupt newest checkpoint falls back to the next lower valid sequence', () => {
  const root = tempDir()
  try {
    let at = 1_700_000_000_000
    const checkpointDir = path.join(root, 'checkpoints')
    const checkpoints = engineering.createCheckpointStore({ dir: checkpointDir, now: () => at })
    const first = checkpoints.save({ episodeId: 'ep', recovery: recoveryDescriptor() })
    at += 1_000
    const newer = checkpoints.save({ episodeId: 'ep', recovery: recoveryDescriptor() })
    fs.writeFileSync(newer.path, '{partial', 'utf8')
    const store = makeStore({ root, checkpointDir })

    const repaired = store.reconcileIndex()
    assert.equal(repaired.ok, true)
    assert.equal(store.get('ep').state, 'ACTIVE')
    assert.equal(store.get('ep').latestCheckpointSeq, 1)
    assert.equal(store.get('ep').latestCheckpointFile, path.basename(first.path))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('two checkpoint files cannot claim the same recovery sequence', () => {
  const root = tempDir()
  try {
    const { checkpointDir, saved } = recordCheckpoint(root)
    const conflict = path.join(checkpointDir, 'alternate-copy.json')
    fs.copyFileSync(saved.path, conflict)
    const store = makeStore({ root, checkpointDir })
    assert.equal(store.recordCheckpoint({ episodeId: 'ep', checkpointPath: saved.path }).ok, true)

    const duplicate = store.recordCheckpoint({ episodeId: 'ep', checkpointPath: conflict })
    assert.equal(duplicate.ok, false)
    assert.equal(duplicate.code, 'CHECKPOINT_SEQUENCE_CONFLICT')
    assert.equal(store.get('ep').latestCheckpointFile, path.basename(saved.path))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a corrupt recovery index is reconstructed from the newest valid checkpoint', () => {
  const root = tempDir()
  try {
    let at = 1_700_000_000_000
    const checkpointDir = path.join(root, 'checkpoints')
    const checkpoints = engineering.createCheckpointStore({ dir: checkpointDir, now: () => at })
    const first = checkpoints.save({ episodeId: 'ep', recovery: recoveryDescriptor() })
    at -= 60_000
    const second = checkpoints.save({ episodeId: 'ep', recovery: recoveryDescriptor() })
    assert.equal(first.ok, true)
    assert.equal(second.ok, true)
    fs.writeFileSync(path.join(root, 'recovery-index.json'), '{corrupt', 'utf8')

    const store = makeStore({ root, checkpointDir })
    assert.equal(typeof store.reconcileIndex, 'function', 'startup needs checkpoint-driven index repair')
    const repaired = store.reconcileIndex()

    assert.equal(repaired.ok, true)
    assert.equal(repaired.repairedEpisodes, 1)
    assert.equal(repaired.entries[0].episodeId, 'ep')
    assert.equal(repaired.entries[0].state, 'ACTIVE')
    assert.equal(repaired.entries[0].latestCheckpointSeq, 2)
    assert.equal(repaired.entries[0].latestCheckpointFile, path.basename(second.path))
    assert.equal(store.get('ep').latestCheckpointSeq, 2)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('index reconstruction preserves terminal lifecycle state embedded in its checkpoint', () => {
  const root = tempDir()
  try {
    const checkpointDir = path.join(root, 'checkpoints')
    const checkpoints = engineering.createCheckpointStore({ dir: checkpointDir })
    const saved = checkpoints.save({ episodeId: 'done', recovery: { ...recoveryDescriptor('done'), lifecycleState: 'COMPLETED' } })
    assert.equal(saved.ok, true)

    const store = makeStore({ root, checkpointDir })
    const repaired = store.reconcileIndex()
    assert.equal(repaired.ok, true)
    assert.equal(store.get('done').state, 'COMPLETED')
    assert.equal(store.acquireClaim({ episodeId: 'done', checkpointSeq: 1, owner: { instanceId: 'new', pid: 55, processIdentity: 'start-new' } }).code, 'CHECKPOINT_NOT_CURRENT')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('index reconstruction blocks duplicate files claiming the highest checkpoint sequence', () => {
  const root = tempDir()
  try {
    const { checkpointDir, saved } = recordCheckpoint(root)
    fs.copyFileSync(saved.path, path.join(checkpointDir, 'duplicate.json'))

    const store = makeStore({ root, checkpointDir })
    const repaired = store.reconcileIndex()
    assert.equal(repaired.ok, true)
    assert.equal(store.get('ep').state, 'RECOVERY_BLOCKED')
    assert.match(store.get('ep').blockedReason, /duplicate.*sequence/i)
    assert.equal(store.acquireClaim({ episodeId: 'ep', checkpointSeq: 1, owner: { instanceId: 'new', pid: 55, processIdentity: 'start-new' } }).ok, false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('indexing an unsupported lifecycle marker fails closed as RECOVERY_BLOCKED', () => {
  const root = tempDir()
  try {
    const checkpointDir = path.join(root, 'checkpoints')
    const checkpoints = engineering.createCheckpointStore({ dir: checkpointDir })
    const saved = checkpoints.save({ episodeId: 'ep', recovery: { ...recoveryDescriptor(), lifecycleState: 'RESUMING' } })
    assert.equal(saved.ok, true)
    const store = makeStore({ root, checkpointDir })

    const recorded = store.recordCheckpoint({ episodeId: 'ep', checkpointPath: saved.path })
    assert.equal(recorded.ok, true)
    assert.equal(recorded.entry.state, 'RECOVERY_BLOCKED')
    assert.match(recorded.entry.blockedReason, /unsupported.*lifecycle/i)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a live episode claim blocks a second owner without replacing the first', () => {
  const root = tempDir()
  try {
    const { checkpointDir, saved } = recordCheckpoint(root)
    const first = makeStore({ root, checkpointDir, isOwnerAlive: (owner) => owner.instanceId === 'runtime-a' })
    assert.equal(first.recordCheckpoint({ episodeId: 'ep', checkpointPath: saved.path }).ok, true)
    const ownerA = { instanceId: 'runtime-a', pid: 3101, processIdentity: 'start-a' }
    const ownerB = { instanceId: 'runtime-b', pid: 3102, processIdentity: 'start-b' }
    assert.equal(first.acquireClaim({ episodeId: 'ep', checkpointSeq: 1, owner: ownerA }).ok, true)

    let ownerProbes = 0
    const second = makeStore({
      root,
      checkpointDir,
      isOwnerAlive: (owner) => {
        ownerProbes += 1
        return owner.instanceId === 'runtime-a'
      }
    })
    const blocked = second.acquireClaim({ episodeId: 'ep', checkpointSeq: 1, owner: ownerB })
    assert.equal(blocked.ok, false)
    assert.equal(blocked.code, 'CLAIM_ALREADY_OWNED')
    assert.equal(ownerProbes, 1, 'one stale/live classification must use one identity observation')
    assert.equal(second.get('ep').ownerInstanceId, 'runtime-a')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a stale claim with a reused PID but different process identity can be replaced and only its owner can release it', () => {
  const root = tempDir()
  try {
    const { checkpointDir, saved } = recordCheckpoint(root)
    const staleStore = makeStore({ root, checkpointDir, isOwnerAlive: () => true })
    assert.equal(staleStore.recordCheckpoint({ episodeId: 'ep', checkpointPath: saved.path }).ok, true)
    const oldOwner = { instanceId: 'runtime-old', pid: 4200, processIdentity: 'start-old' }
    const newOwner = { instanceId: 'runtime-new', pid: 4200, processIdentity: 'start-new' }
    assert.equal(staleStore.acquireClaim({ episodeId: 'ep', checkpointSeq: 1, owner: oldOwner }).ok, true)

    const resumedStore = makeStore({ root, checkpointDir, isOwnerAlive: (owner) => owner.processIdentity === 'start-new' })
    const acquired = resumedStore.acquireClaim({ episodeId: 'ep', checkpointSeq: 1, owner: newOwner })
    assert.equal(acquired.ok, true)
    assert.equal(resumedStore.get('ep').ownerInstanceId, 'runtime-new')

    const wrongRelease = resumedStore.releaseClaim({ episodeId: 'ep', owner: oldOwner })
    assert.equal(wrongRelease.ok, false)
    assert.equal(wrongRelease.code, 'CLAIM_NOT_OWNED')
    assert.equal(resumedStore.get('ep').ownerInstanceId, 'runtime-new')
    assert.equal(resumedStore.releaseClaim({ episodeId: 'ep', owner: newOwner }).ok, true)
    assert.equal(resumedStore.get('ep').ownerInstanceId, null)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
