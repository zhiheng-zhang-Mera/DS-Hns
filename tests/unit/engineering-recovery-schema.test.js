'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const { computePlanDigest, validateRecoveryDescriptor } = require('../../app/engineering/recovery-schema.cjs')

function plan() {
  return {
    version: 1,
    id: 'plan:1:contract',
    goal: 'resume safely',
    intent: 'contract',
    createdAt: 1_700_000_000_000,
    steps: [{ id: 'contract:report:1', kind: 'report', source: 'contract', args: [], optional: false }],
    budget: { maxSteps: 4 },
    reasons: []
  }
}

function descriptor(overrides = {}) {
  const savedPlan = plan()
  return {
    version: 1,
    episodeId: 'ep',
    request: {
      workspace: path.resolve(process.cwd()),
      goal: 'resume safely',
      startedAt: 1_700_000_000_000,
      deadlineAt: 1_700_086_400_000,
      contract: { maxSteps: 4 }
    },
    plan: savedPlan,
    planDigest: computePlanDigest(savedPlan),
    cursor: { nextStepIndex: 0, lastVerifiedStepId: null, verifiedStepIds: [], skippedStepIds: [], checkpointSeq: 1 },
    fingerprint: { head: 'abc123' },
    verifiedMutationIds: [],
    unresolvedMutationIds: [],
    executorCompatibility: 'engineering-v1',
    workRoot: path.parse(process.cwd()).root,
    crossVolumeTemp: [],
    lifecycleState: 'ACTIVE',
    ...overrides
  }
}

test('plan digests are canonical across object key order', () => {
  assert.match(computePlanDigest({ b: 2, a: { z: 3, y: 4 } }), /^sha256:[a-f0-9]{64}$/)
  assert.equal(computePlanDigest({ b: 2, a: { z: 3, y: 4 } }), computePlanDigest({ a: { y: 4, z: 3 }, b: 2 }))
})

test('the supported recovery descriptor validates as a complete replay-safe envelope', () => {
  const result = validateRecoveryDescriptor(descriptor(), { episodeId: 'ep' })
  assert.equal(result.ok, true, result.reason)
  assert.equal(result.descriptor.cursor.checkpointSeq, 1)
  assert.equal(result.descriptor.lifecycleState, 'ACTIVE')
})

test('a plan edited after checkpointing fails the digest gate', () => {
  const saved = descriptor()
  saved.plan.steps[0].kind = 'patch'
  const result = validateRecoveryDescriptor(saved, { episodeId: 'ep' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'PLAN_DIGEST_MISMATCH')
})

test('unsupported descriptor and plan versions fail closed', () => {
  const descriptorVersion = descriptor({ version: 99 })
  assert.equal(validateRecoveryDescriptor(descriptorVersion).code, 'RECOVERY_VERSION_UNSUPPORTED')

  const saved = descriptor()
  saved.plan.version = 99
  saved.planDigest = computePlanDigest(saved.plan)
  assert.equal(validateRecoveryDescriptor(saved).code, 'PLAN_VERSION_UNSUPPORTED')
})

test('a cursor cannot move beyond the contiguous verified or intentionally skipped prefix', () => {
  const saved = descriptor()
  saved.cursor.nextStepIndex = 1
  const result = validateRecoveryDescriptor(saved)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'CURSOR_UNVERIFIED')
})

test('an expired original deadline and an unknown lifecycle state are rejected', () => {
  const expired = descriptor()
  expired.request.deadlineAt = expired.request.startedAt
  assert.equal(validateRecoveryDescriptor(expired).code, 'REQUEST_DEADLINE_INVALID')

  const unknown = descriptor({ lifecycleState: 'RESUMING' })
  assert.equal(validateRecoveryDescriptor(unknown).code, 'LIFECYCLE_STATE_UNSUPPORTED')
})

test('cross-volume cleanup registrations are bound to episode, work volume, type and state', () => {
  const workRoot = path.parse(process.cwd()).root
  const scratchRoot = workRoot.toLowerCase().startsWith('d:') ? 'C:\\DS-Hns-Temp\\ep\\scratch' : 'D:\\DS-Hns-Temp\\ep\\scratch'
  const workRootIdentity = `sha256:${'a'.repeat(64)}`
  const valid = {
    path: scratchRoot,
    canonicalPath: scratchRoot,
    episodeId: 'ep',
    workRoot,
    workRootIdentity,
    type: 'directory',
    purposeClass: 'build',
    createdByEpisode: true,
    registeredAt: 1_700_000_000_000,
    cleanupState: 'ACTIVE',
    markerPath: path.win32.join(scratchRoot, '.dshns-episode-owner.json')
  }
  assert.equal(validateRecoveryDescriptor(descriptor({ workRoot, crossVolumeTemp: [valid] })).ok, true)

  const wrongEpisode = { ...valid, episodeId: 'other' }
  assert.equal(validateRecoveryDescriptor(descriptor({ workRoot, crossVolumeTemp: [wrongEpisode] })).code, 'CROSS_VOLUME_REGISTRY_INVALID')

  const wrongVolume = { ...valid, path: path.win32.join(workRoot, 'scratch'), canonicalPath: path.win32.join(workRoot, 'scratch'), markerPath: path.win32.join(workRoot, 'scratch', '.dshns-episode-owner.json') }
  assert.equal(validateRecoveryDescriptor(descriptor({ workRoot, crossVolumeTemp: [wrongVolume] })).code, 'CROSS_VOLUME_REGISTRY_INVALID')

  const malformedFile = { ...valid, type: 'file', markerPath: undefined }
  assert.equal(validateRecoveryDescriptor(descriptor({ workRoot, crossVolumeTemp: [malformedFile] })).code, 'CROSS_VOLUME_REGISTRY_INVALID')

  assert.equal(validateRecoveryDescriptor(descriptor({ workRoot, cleanupTerminalState: 'COMPLETED' })).ok, true)
  assert.equal(validateRecoveryDescriptor(descriptor({ workRoot, lifecycleState: 'COMPLETED', cleanupTerminalState: 'COMPLETED' })).code, 'CLEANUP_TERMINAL_STATE_INVALID')
})
