'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createEngineeringHost } = require('../../app/engineering-host.cjs')
const { createCheckpointStore } = require('../../app/engineering/checkpoint.cjs')
const { createRecoveryStore } = require('../../app/engineering/recovery-store.cjs')
const { buildPlan } = require('../../app/engineering/plan.cjs')
const { computePlanDigest } = require('../../app/engineering/recovery-schema.cjs')
const repository = require('../../app/engineering/repository.cjs')

const ROOT = path.resolve(__dirname, '..', '..')
const OWNER = { instanceId: 'test-runtime', pid: 7501, processIdentity: 'test-process-start' }

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'eng-host-resume-'))
}

function makeStores(root) {
  const checkpointRoot = path.join(root, 'runtime', 'engineering', 'checkpoints')
  const checkpoints = createCheckpointStore({ dir: checkpointRoot })
  const recovery = createRecoveryStore({
    root: path.dirname(checkpointRoot),
    checkpointDir: checkpointRoot,
    isOwnerAlive: () => false
  })
  return { checkpointRoot, checkpoints, recovery }
}

function makeActiveCheckpoint({ checkpointRoot, checkpoints }, options = {}) {
  const episodeId = options.episodeId || 'resume-from-latest-fixture'
  const goal = options.goal || 'resume from the newest valid checkpoint'
  const contract = { commands: {}, steps: [{ kind: 'report' }, { kind: 'report' }], lockWorkspace: false, tests: [] }
  const built = buildPlan({ goal, contract, inputs: { steps: contract.steps }, discovery: { commands: {} } })
  const plan = {
    version: 1,
    id: built.id,
    goal: built.goal,
    intent: built.intent,
    createdAt: built.createdAt,
    steps: built.steps.map((step) => ({ ...step })),
    budget: { ...built.budget },
    reasons: built.reasons.slice()
  }
  const startedAt = Date.now() - 1000
  const recovery = {
    version: 1,
    episodeId,
    request: { workspace: ROOT, goal, startedAt, deadlineAt: startedAt + 60_000, contract },
    plan,
    planDigest: computePlanDigest(plan),
    cursor: {
      nextStepIndex: 1,
      lastVerifiedStepId: plan.steps[0].id,
      verifiedStepIds: [plan.steps[0].id],
      skippedStepIds: [],
      checkpointSeq: 1
    },
    fingerprint: repository.snapshot({ root: ROOT }).fingerprint,
    verifiedMutationIds: [],
    unresolvedMutationIds: [],
    executorCompatibility: options.executorCompatibility || 'engineering-v1',
    workRoot: path.parse(checkpointRoot).root,
    crossVolumeTemp: [],
    lifecycleState: 'ACTIVE'
  }
  const saved = checkpoints.save({
    episodeId,
    goal,
    workspace: ROOT,
    fingerprint: recovery.fingerprint,
    plan: { id: plan.id, cursor: 1, steps: plan.steps },
    cursor: 1,
    recovery
  })
  assert.equal(saved.ok, true, saved.reason)
  return { episodeId, recovery, checkpoint: checkpoints.latest(episodeId), checkpointPath: saved.path }
}

test('resumeLatest is a no-op when there is no ACTIVE recovery candidate', async () => {
  const holder = tempDir()
  try {
    const stores = makeStores(holder)
    const host = createEngineeringHost({
      checkpointRoot: stores.checkpointRoot,
      recoveryRoot: path.dirname(stores.checkpointRoot),
      checkpoints: stores.checkpoints,
      recoveryStore: stores.recovery,
      recoveryOwner: OWNER
    })
    const result = await host.resumeLatest({ trigger: 'unclean_exit' })
    assert.equal(result.ok, true)
    assert.equal(result.resumed, false)
    assert.equal(result.code, 'NO_ACTIVE_EPISODE')
    assert.equal(host.running, false)
  } finally {
    fs.rmSync(holder, { recursive: true, force: true })
  }
})

test('a compatible recovery resumes the same episode and starts after its verified cursor', async () => {
  const holder = tempDir()
  const stores = makeStores(holder)
  const actionSteps = []
  const host = createEngineeringHost({
    checkpointRoot: stores.checkpointRoot,
    recoveryRoot: path.dirname(stores.checkpointRoot),
    checkpoints: stores.checkpoints,
    recoveryStore: stores.recovery,
    recoveryOwner: OWNER,
    log: (line) => {
      if (line.includes('engineering action:')) {
        const event = JSON.parse(line.slice(line.indexOf('{')))
        actionSteps.push(event.step)
      }
    }
  })
  try {
    const fixture = makeActiveCheckpoint(stores)
    const indexed = stores.recovery.recordCheckpoint({ episodeId: fixture.episodeId, checkpointPath: fixture.checkpointPath })
    assert.equal(indexed.ok, true, JSON.stringify(indexed))

    const resumed = await host.resumeLatest({ trigger: 'unclean_exit' })
    assert.equal(resumed.ok, true, JSON.stringify(resumed))
    assert.equal(resumed.accepted, true)
    assert.equal(resumed.episode, fixture.episodeId)
    assert.equal(resumed.checkpointSeq, 1)
    assert.equal(resumed.cursor.nextStepIndex, 1)
    const report = await host.settled()
    assert.deepEqual(actionSteps, [fixture.recovery.plan.steps[1].id])
    assert.equal(report.episode, fixture.episodeId)
    assert.equal(stores.checkpoints.latest(fixture.episodeId).recovery.cursor.nextStepIndex, 2)
    assert.equal(stores.recovery.get(fixture.episodeId).recoveryAttempts, 0, 'a newer valid checkpoint ends the consecutive-failure streak')
    assert.equal(stores.recovery.get(fixture.episodeId).ownerInstanceId, null)
  } finally {
    host.dispose('test teardown')
    fs.rmSync(holder, { recursive: true, force: true })
  }
})

test('a descriptor compatibility failure counts only after claim acquisition and remains blocked', async () => {
  const holder = tempDir()
  const stores = makeStores(holder)
  const host = createEngineeringHost({
    checkpointRoot: stores.checkpointRoot,
    recoveryRoot: path.dirname(stores.checkpointRoot),
    checkpoints: stores.checkpoints,
    recoveryStore: stores.recovery,
    recoveryOwner: OWNER
  })
  try {
    const fixture = makeActiveCheckpoint(stores, { episodeId: 'incompatible-resume', executorCompatibility: 'engineering-v999' })
    const indexed = stores.recovery.recordCheckpoint({ episodeId: fixture.episodeId, checkpointPath: fixture.checkpointPath })
    assert.equal(indexed.ok, true, JSON.stringify(indexed))

    const result = await host.resume({ episodeId: fixture.episodeId, trigger: 'planned_restart' })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'EXECUTOR_COMPATIBILITY_MISMATCH')
    assert.equal(stores.recovery.get(fixture.episodeId).state, 'RECOVERY_BLOCKED')
    assert.equal(stores.recovery.get(fixture.episodeId).recoveryAttempts, 1)
    assert.equal(stores.recovery.get(fixture.episodeId).ownerInstanceId, null, 'the failed recovery must release its durable claim')
  } finally {
    host.dispose('test teardown')
    fs.rmSync(holder, { recursive: true, force: true })
  }
})

test('a planned boundary stop retains an ACTIVE checkpoint and releases the live claim', async () => {
  const holder = tempDir()
  const stores = makeStores(holder)
  const host = createEngineeringHost({
    checkpointRoot: stores.checkpointRoot,
    recoveryRoot: path.dirname(stores.checkpointRoot),
    checkpoints: stores.checkpoints,
    recoveryStore: stores.recovery,
    recoveryOwner: OWNER
  })
  try {
    const started = host.run({
      workspace: ROOT,
      goal: 'preserve a planned restart checkpoint',
      deadlineMs: 60_000,
      contract: { commands: {}, steps: Array.from({ length: 8 }, () => ({ kind: 'report' })), lockWorkspace: false, tests: [] }
    })
    assert.equal(started.ok, true)
    const beforeCancel = stores.recovery.get(started.episode)
    assert.equal(beforeCancel.state, 'ACTIVE')
    assert.equal(beforeCancel.ownerInstanceId, OWNER.instanceId, 'fresh episodes acquire the same durable claim used by recovery')

    assert.equal(host.cancel({ reason: 'planned restart', preserveForResume: true }).cancelled, true)
    const report = await host.settled()
    assert.equal(report.result, 'CANCELLED')
    assert.equal(stores.checkpoints.latest(started.episode).recovery.lifecycleState, 'ACTIVE')
    assert.equal(stores.recovery.get(started.episode).state, 'ACTIVE')
    assert.equal(stores.recovery.get(started.episode).ownerInstanceId, null)
  } finally {
    host.dispose('test teardown')
    fs.rmSync(holder, { recursive: true, force: true })
  }
})

test('the supervisor stops before the next step when a post-step cursor checkpoint fails', async () => {
  const holder = tempDir()
  const checkpointRoot = path.join(holder, 'runtime', 'engineering', 'checkpoints')
  const durable = createCheckpointStore({ dir: checkpointRoot })
  let saveCount = 0
  const checkpoints = {
    ...durable,
    save(input) {
      saveCount += 1
      if (saveCount === 2) return { ok: false, reason: 'injected checkpoint storage failure' }
      return durable.save(input)
    }
  }
  const actionSteps = []
  try {
    const { createEngineeringSupervisor } = require('../../app/engineering/supervisor.cjs')
    const supervisor = createEngineeringSupervisor({
      episodeId: 'checkpoint-failure-fixture',
      workspace: ROOT,
      goal: 'stop before any step beyond a non-durable cursor',
      contract: { commands: {}, steps: [{ kind: 'report' }, { kind: 'report' }], lockWorkspace: false, tests: [] },
      checkpointRoot,
      checkpoints,
      deadlineMs: 60_000,
      log: (event) => { if (event.type === 'action') actionSteps.push(event.step) }
    })

    const report = await supervisor.run()
    assert.equal(report.result, 'BLOCKED')
    assert.equal(actionSteps.length, 1, 'the next step must not run after the prior cursor could not be persisted')
    assert.match(report.validation.reasons.join(' '), /checkpoint storage failure/i)
  } finally {
    fs.rmSync(holder, { recursive: true, force: true })
  }
})
