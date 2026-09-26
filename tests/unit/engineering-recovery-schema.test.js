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
