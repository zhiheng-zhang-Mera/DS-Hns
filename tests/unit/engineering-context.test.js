'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  createEpisodeContext,
  LIVE_KEYS,
  DEFAULT_EVIDENCE_RING
} = require('../../app/engineering/context.cjs')

/**
 * The episode context's three layers.
 *
 * These tests are about the one property that makes a 24-hour episode survivable:
 * the context is bounded at every layer, so the thousandth step costs exactly
 * what the twentieth did. A layer that is capped is proven by driving it past the
 * cap and asserting it stopped growing — not by reading the constructor.
 *
 * A frozen clock is used wherever the retention *size* matters: the timestamp is
 * part of a retained entry, so a clock that changes width would make a flat
 * structure look like a growing one.
 */
const FROZEN = 1_700_000_000_000

test('a live context holds only the six step fields and is replaced, not accumulated', () => {
  const context = createEpisodeContext({ now: () => FROZEN })
  context.setLive({ phase: 'EDITING', goal: 'repair the parser', planStep: '3/7 patch lexer' })
  assert.deepEqual(Object.keys(context.snapshot().live).sort(), ['goal', 'phase', 'planStep'])
  context.setLive({ phase: 'TESTING', currentFile: 'src/lexer.cjs', ignored: 'not a live field' })
  const live = context.snapshot().live
  assert.equal(live.phase, 'TESTING')
  assert.equal(live.goal, 'repair the parser')
  assert.equal(live.currentFile, 'src/lexer.cjs')
  assert.equal('ignored' in live, false)
  assert.deepEqual(Object.keys(live).sort(), LIVE_KEYS.filter((key) => key in live).sort())
})

test('snapshot().live is a copy: a caller cannot change what the context remembers', () => {
  const context = createEpisodeContext({ now: () => FROZEN })
  context.setLive({ phase: 'BUILDING', currentError: 'exit 1' })
  const live = context.snapshot().live
  live.phase = 'COMPLETED'
  delete live.currentError
  assert.equal(context.snapshot().live.phase, 'BUILDING')
  assert.equal(context.snapshot().live.currentError, 'exit 1')
})

test('clearLive removes the named keys and leaves the rest alone', () => {
  const context = createEpisodeContext({ now: () => FROZEN })
  context.setLive({ phase: 'EDITING', goal: 'goal', currentFile: 'a.cjs', currentError: 'boom' })
  context.clearLive(['currentError', 'currentFile'])
  assert.deepEqual(context.snapshot().live, { phase: 'EDITING', goal: 'goal' })
  context.clearLive('phase')
  assert.deepEqual(context.snapshot().live, { goal: 'goal' })
})

test('after 1000 observations the evidence ring is capped and the retained byte count stops growing', () => {
  const context = createEpisodeContext({ now: () => FROZEN, ringSize: 20, tailSize: 20 })
  // Padded indices: entries of identical size are what makes "flat" measurable.
  const stepLabel = (step) => `step ${String(step).padStart(4, '0')} produced the same shape of evidence`
  for (let step = 0; step < 20; step += 1) {
    context.observe({ kind: 'observation', summary: stepLabel(step), evidence: ['a detail', 'another detail'], bytes: 128 })
  }
  const atCapacity = context.snapshot()
  const bytesAtCapacity = context.bytes()
  assert.equal(atCapacity.evidence.length, 20)
  assert.equal(atCapacity.counts.evidence, 20)
  assert.equal(atCapacity.totals.evidence, 20)

  for (let step = 20; step < 1000; step += 1) {
    context.observe({ kind: 'observation', summary: stepLabel(step), evidence: ['a detail', 'another detail'], bytes: 128 })
  }
  const afterThousand = context.snapshot()
  assert.equal(afterThousand.totals.evidence, 1000, 'the total is counted without being retained')
  assert.equal(afterThousand.counts.evidence, 20, 'the ring retains a bounded number of entries')
  assert.equal(afterThousand.evidence.length, 20, 'the snapshot exposes a bounded tail, never the whole ring')
  assert.equal(context.bytes(), bytesAtCapacity, 'the retained size is flat after the first ringSize observations')
  assert.equal(afterThousand.evidence[0].summary.includes('step 0980'), true)
})

test('every ring is bounded: verifications, decisions, process milestones and changed files', () => {
  const context = createEpisodeContext({
    now: () => FROZEN,
    verificationRingSize: 4,
    decisionRingSize: 3,
    processRingSize: 5,
    fileRingSize: 6,
    stepRingSize: 4,
    tailSize: 3
  })
  const bytesAtCapacity = []
  for (let step = 0; step < 60; step += 1) {
    const index = String(step).padStart(3, '0')
    context.recordVerification({ operation: 'unitTest', command: 'npm test', ok: step % 2 === 0, summary: `run ${index}`, exitCode: step % 2 === 0 ? 0 : 1 })
    context.recordDecision({ kind: 'repair', detail: `attempt ${index}`, result: 'open' })
    context.recordProcess({ id: `p${index}`, command: 'npm test', milestone: 'started', step: `s${index}` })
    context.observe({ kind: 'observation', summary: `file change ${index}`, file: `src/file${index}.cjs` })
    // Once every ring is full, the retained size is what it will be at step 1000.
    if (step === 19) bytesAtCapacity.push(context.bytes())
  }
  const snapshot = context.snapshot()
  assert.equal(snapshot.counts.verifications, 4)
  assert.equal(snapshot.counts.decisions, 3)
  assert.equal(snapshot.counts.processMilestones, 5)
  assert.equal(snapshot.counts.filesChanged, 6)
  assert.equal(snapshot.counts.pendingSteps, 4, 'plan steps are a bounded ring too')
  assert.equal(snapshot.totals.verifications, 60, 'the totals keep counting after the rings turn over')
  assert.equal(snapshot.totals.processMilestones, 60)
  assert.equal(snapshot.evidence.length, 3, 'the tail is capped at tailSize')
  assert.equal(snapshot.verification.recent.length, 3)
  assert.equal(snapshot.filesChanged.length, 3)
  assert.equal(context.bytes(), bytesAtCapacity[0], 'retained bytes are flat once every ring is full')
})

test('a failed verification is a blocker, and the next passing run clears it', () => {
  const context = createEpisodeContext({ now: () => FROZEN })
  context.recordVerification({ operation: 'unitTest', command: 'npm test', ok: false, summary: 'one assertion failed', exitCode: 1 })
  assert.deepEqual(context.inventory().blockers.map((entry) => entry.key), ['verification:unitTest'])
  assert.equal(context.inventory().verification.ok, false)
  context.recordVerification({ operation: 'unitTest', command: 'npm test', ok: true, summary: 'all green', exitCode: 0 })
  assert.deepEqual(context.inventory().blockers, [])
  assert.equal(context.inventory().verification.ok, true)
  assert.equal(context.inventory().verification.total, 2)
})

test('a resolved decision completes the plan step it names, and a failed one becomes a blocker', () => {
  const context = createEpisodeContext({ now: () => FROZEN })
  context.observe({ kind: 'step-planned', step: 'step one' })
  context.observe({ kind: 'step-planned', step: 'step two' })
  assert.deepEqual(context.inventory().pendingSteps.map((entry) => entry.label), ['step one', 'step two'])
  context.recordDecision({ kind: 'repair', detail: 'guard the null path', result: 'resolved', step: 'step one' })
  const inventory = context.inventory()
  assert.deepEqual(inventory.pendingSteps.map((entry) => entry.label), ['step two'])
  assert.deepEqual(inventory.completedSteps.map((entry) => entry.label), ['step one'])
  assert.equal(inventory.completedStepCount, 1)
  context.recordDecision({ kind: 'retry', detail: 'the same command failed again', result: 'failed' })
  assert.deepEqual(context.inventory().blockers.map((entry) => entry.key), ['decision:retry'])
})

test('an owned process milestone plans a step and its completion closes the step', () => {
  const context = createEpisodeContext({ now: () => FROZEN })
  context.recordProcess({ id: 'proc-1', command: 'npm test', milestone: 'started', step: 'run the suite' })
  assert.deepEqual(context.inventory().pendingSteps.map((entry) => entry.label), ['run the suite'])
  context.recordProcess({ id: 'proc-1', command: 'npm test', milestone: 'exited', step: 'run the suite' })
  const inventory = context.inventory()
  assert.deepEqual(inventory.pendingSteps, [])
  assert.deepEqual(inventory.completedSteps.map((entry) => entry.label), ['run the suite'])
})

test('the summary is generated from the bounded layers and is not truncated when it fits', () => {
  const context = createEpisodeContext({ now: () => FROZEN })
  context.setLive({ phase: 'VERIFYING', goal: 'make the flaky test deterministic' })
  context.recordProcess({ id: 'p1', command: 'npm test', milestone: 'started', step: 'run the suite' })
  context.recordVerification({ operation: 'unitTest', command: 'npm test', ok: true, summary: 'all green', exitCode: 0, step: 'run the suite' })
  const summary = context.summarize(context.inventory())
  assert.equal(summary.truncated, false)
  assert.equal(summary.goal, 'make the flaky test deterministic')
  assert.equal(summary.phase, 'VERIFYING')
  assert.equal(summary.completed.steps, 1)
  assert.deepEqual(summary.completed.lastSteps, ['run the suite'])
  assert.deepEqual(summary.blockers, [])
  assert.deepEqual(summary.remaining, [])
  assert.equal(summary.verification.ok, true)
  assert.equal(summary.verification.total, 1)
  assert.equal(summary.bytes <= summary.budget, true)
})

test('a summary reports truncated when the budget forces it to cut', () => {
  const context = createEpisodeContext({ now: () => FROZEN, summaryBudgetBytes: 700 })
  context.setLive({ phase: 'REPAIRING', goal: `repair ${'a very long goal '.repeat(20)}` })
  for (let step = 0; step < 30; step += 1) {
    context.observe({ kind: 'step-planned', step: `pending step number ${step} with a description that costs bytes` })
    context.observe({ kind: 'observation', summary: `evidence ${step}`, file: `src/deeply/nested/file-${step}.cjs` })
  }
  context.recordVerification({ operation: 'unitTest', command: 'npm test', ok: false, summary: `a failing assertion ${'x'.repeat(200)}`, exitCode: 1 })
  const summary = context.summarize(context.inventory())
  assert.equal(summary.truncated, true)
  assert.equal(summary.bytes <= summary.budget, true)
  assert.equal(summary.budget, 700)
  assert.equal(Array.isArray(summary.remaining), true)
  assert.equal(summary.goal.length <= 500, true, 'the goal stays bounded even after cutting')
  assert.equal(summary.verification.failed, 1, 'counts survive the cut: they are the load-bearing part')
})

test('summarize accepts an inventory produced by the supervisor, not only this context', () => {
  const context = createEpisodeContext({ now: () => FROZEN })
  const summary = context.summarize({
    goal: 'green the suite',
    phase: 'TESTING',
    completedSteps: [{ id: 's1', description: 'first step' }, { title: 'second step' }],
    completedStepCount: 12,
    pendingSteps: ['third step'],
    blockers: [{ reason: 'credentials are missing' }],
    changedFiles: ['src/a.cjs', 'src/b.cjs'],
    verification: { ok: false, total: 4, passed: 3, failed: 1, last: { operation: 'build', ok: false, exitCode: 2, summary: 'compile error' } },
    processMilestones: [{ id: 'p1' }],
    decisions: [{ kind: 'repair' }, { kind: 'retry' }]
  })
  assert.equal(summary.completed.steps, 12)
  assert.deepEqual(summary.completed.lastSteps, ['first step', 'second step'])
  assert.deepEqual(summary.remaining, ['third step'])
  assert.deepEqual(summary.blockers, ['credentials are missing'])
  assert.deepEqual(summary.filesChanged, ['src/a.cjs', 'src/b.cjs'])
  assert.equal(summary.completed.decisions, 2)
  assert.equal(summary.completed.processMilestones, 1)
  assert.deepEqual(summary.verification.last, { operation: 'build', ok: false, exitCode: 2, summary: 'compile error' })
})

test('snapshot reports its own limits and byte count, and two contexts share no state', () => {
  const first = createEpisodeContext({ now: () => FROZEN, ringSize: 4, summaryBudgetBytes: 2048 })
  const second = createEpisodeContext({ now: () => FROZEN })
  first.observe({ kind: 'observation', summary: 'only in the first context' })
  const snapshot = first.snapshot()
  assert.equal(snapshot.counts.evidence, 1)
  assert.equal(snapshot.limits.evidence, 4)
  assert.equal(snapshot.limits.summaryBudgetBytes, 2048)
  assert.equal(snapshot.bytes, first.bytes())
  assert.equal(second.snapshot().counts.evidence, 0, 'nothing is remembered across episodes')
  assert.equal(second.bytes() < first.bytes(), true)
  assert.equal(DEFAULT_EVIDENCE_RING, 20)
})

test('a very long observation is clipped before it is retained, so one entry cannot blow the budget', () => {
  const context = createEpisodeContext({ now: () => FROZEN, ringSize: 2 })
  context.observe({ kind: 'observation', summary: 'x'.repeat(50000), evidence: ['y'.repeat(50000)], bytes: 10 * 1024 * 1024 })
  const entry = context.snapshot().evidence[0]
  assert.equal(entry.summary.length, 400)
  assert.equal(entry.evidence[0].length, 200)
  assert.equal(context.bytes() < 4096, true, 'the declared byte count is data, not retained text')
})
