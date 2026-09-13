'use strict'

/**
 * The engineering plan's invariants.
 *
 * The plan is the only thing standing between a goal and an edit, so these tests
 * assert the properties that make it worth having: a repair is reproduced before
 * it is patched, a contract's own plan wins, the step vocabulary is closed, the
 * plan is bounded, and the cursor cannot jump over verification.
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const plan = require('../../app/engineering/plan.cjs')
const { buildPlan, nextStep, advance, PLAN_KINDS, PLAN_KIND_LIST } = plan
const { OPERATIONS } = require('../../app/engineering/discovery.cjs')

/** A discovery record with every operation the templates can ask for. */
function discoveryWith(operations = {}) {
  const commands = {}
  for (const operation of operations.all || ['install', 'build', 'test', 'focusedTest', 'lint', 'typecheck', 'run']) {
    commands[operation] = {
      command: `cmd-${operation}`,
      cwd: null,
      acceptsFocus: operation === 'focusedTest',
      longRunning: operation === 'run',
      confidence: 'declared',
      evidence: `the fixture declares ${operation}`
    }
  }
  for (const [operation, value] of Object.entries(operations.only || {})) commands[operation] = value
  for (const operation of operations.without || []) delete commands[operation]
  return { root: process.cwd(), commands }
}

function kindsOf(built) {
  return built.steps.map((step) => step.kind)
}

test('a fix goal shows the failing test failing before anything patches code', () => {
  const built = buildPlan({ goal: 'Fix the failing test in the parser', discovery: discoveryWith({}) })
  const kinds = kindsOf(built)
  assert.ok(kinds.includes('reproduce'), 'the repair template must include a reproduce step')
  assert.ok(kinds.indexOf('reproduce') < kinds.indexOf('inspect'), 'reproduce must precede inspect')
  assert.ok(kinds.indexOf('reproduce') < kinds.indexOf('patch'), 'reproduce must precede the patch')
  assert.ok(kinds.indexOf('patch') < kinds.indexOf('focused-test'), 'the focused test must follow the patch')
  assert.ok(kinds.indexOf('focused-test') < kinds.indexOf('affected-test'), 'the affected suite follows the focused test')
  assert.ok(kinds.indexOf('affected-test') < kinds.indexOf('full-verify'), 'the full verification is last')
  assert.equal(built.intent, 'fix')
})

test('a bug wording alone selects the repair template', () => {
  const built = buildPlan({ goal: 'the build script has a bug', discovery: discoveryWith({}) })
  assert.equal(built.intent, 'fix')
  assert.equal(built.steps[0].kind, 'reproduce')
})

test('a build goal builds and then verifies', () => {
  const built = buildPlan({ goal: 'Build the bundle for release', discovery: discoveryWith({}) })
  assert.equal(built.intent, 'build')
  const kinds = kindsOf(built)
  assert.ok(kinds.includes('build'))
  assert.ok(kinds.includes('lint'))
  assert.ok(kinds.includes('typecheck'))
  assert.ok(kinds.indexOf('build') < kinds.indexOf('full-verify'))
})

test('a refactor goal runs the affected tests after the patch', () => {
  const built = buildPlan({ goal: 'Refactor the parser into two modules', discovery: discoveryWith({}) })
  assert.equal(built.intent, 'refactor')
  const kinds = kindsOf(built)
  assert.ok(kinds.indexOf('patch') < kinds.indexOf('affected-test'))
  assert.ok(kinds.includes('full-verify'))
})

test('a dependency goal installs, builds, tests and verifies', () => {
  const built = buildPlan({ goal: 'Upgrade the dependency to the new major version', discovery: discoveryWith({}) })
  assert.equal(built.intent, 'dependency')
  const kinds = kindsOf(built)
  assert.deepEqual([...kinds].sort(), ['affected-test', 'build', 'full-verify', 'install'])
  assert.equal(kinds[0], 'install')
})

test('the plan skips an unavailable command and records why in reasons', () => {
  const built = buildPlan({ goal: 'Fix the failing test', discovery: discoveryWith({ without: ['build', 'lint'] }) })
  const kinds = kindsOf(built)
  assert.ok(!kinds.includes('build'), 'a step whose command discovery did not provide cannot exist')
  assert.ok(!kinds.includes('lint'), 'a lint step cannot exist without a lint command')
  assert.ok(kinds.includes('reproduce'), 'the repair template still runs')
  assert.equal(built.reasons.length, 0, 'a kind the template never asked for is not a drop')
})

test('a template step whose command discovery did not provide is reported in reasons', () => {
  const built = buildPlan({ goal: 'Build the bundle', discovery: discoveryWith({ without: ['build'] }) })
  assert.ok(!kindsOf(built).includes('build'))
  assert.ok(
    built.reasons.some((reason) => reason.includes('build') && reason.includes('discovery provided none')),
    'the dropped build step must be explainable'
  )
})

test('a bounded plan refuses to grow past contract.maxSteps and says what it dropped', () => {
  const built = buildPlan({ goal: 'Fix the failing test', discovery: discoveryWith({}), contract: { maxSteps: 3 } })
  assert.equal(built.budget.maxSteps, 3)
  assert.equal(built.steps.length, 3)
  assert.ok(built.reasons.some((reason) => reason.includes('bounded at 3 steps')), 'the bound must be reported')
})

test('the default budget is the documented 40 steps', () => {
  const built = buildPlan({ goal: 'Fix the failing test', discovery: discoveryWith({}) })
  assert.equal(built.budget.maxSteps, plan.DEFAULT_MAX_STEPS)
  assert.equal(plan.DEFAULT_MAX_STEPS, 40)
})

test('no step may outlive the episode budget the contract declares', () => {
  const built = buildPlan({ goal: 'Fix the failing test', discovery: discoveryWith({}), contract: { deadlineMs: 60_000 } })
  for (const step of built.steps) {
    assert.equal(step.timeoutMs, 60_000, `${step.kind} must be clamped to the episode budget`)
  }
  assert.equal(built.deadlineMs, 60_000)

  // A longer episode keeps the step's own bound: a thirty-minute suite is still
  // allowed thirty minutes inside a day-long episode.
  const long = buildPlan({ goal: 'Fix the failing test', discovery: discoveryWith({}), contract: { deadlineMs: 24 * 60 * 60 * 1000 } })
  const focused = long.steps.find((step) => step.kind === 'focused-test')
  assert.equal(focused.timeoutMs, plan.DEFAULT_TIMEOUT_MS)

  // An explicit per-step bound is clamped too, never widened.
  const explicit = buildPlan({
    goal: 'anything',
    discovery: discoveryWith({}),
    contract: { deadlineMs: 5_000 },
    inputs: { steps: [{ kind: 'lint', timeoutMs: 900_000 }] }
  })
  assert.equal(explicit.steps[0].timeoutMs, 5_000)
})

test('every step carries a closed kind, an operation the supervisor knows and the evidence it records', () => {
  const built = buildPlan({ goal: 'Fix the failing test', discovery: discoveryWith({}) })
  for (const step of built.steps) {
    assert.ok(PLAN_KIND_LIST.includes(step.kind), `${step.kind} is a closed kind`)
    if (step.operation !== null) assert.ok(OPERATIONS.includes(step.operation), `${step.operation} is a known operation`)
    assert.ok(Array.isArray(step.evidence) && step.evidence.length > 0, `${step.kind} names the evidence it will record`)
    assert.ok(step.expects && typeof step.expects === 'object', `${step.kind} declares what done means`)
    assert.ok(Number.isFinite(step.timeoutMs), `${step.kind} carries a timeout`)
    assert.equal(typeof step.description, 'string')
    assert.ok(step.id)
  }
})

test('a test step expects a zero exit code and no failing tests', () => {
  const built = buildPlan({ goal: 'Fix the failing test', discovery: discoveryWith({}) })
  const focused = built.steps.find((step) => step.kind === 'focused-test')
  assert.deepEqual(focused.expects, { exitCode: 0, testCount: { failed: 0 } })
  assert.equal(focused.operation, 'focusedTest')
  assert.equal(focused.command, 'cmd-focusedTest')
})

test('an explicit contract plan wins over the inferred template', () => {
  const built = buildPlan({
    goal: 'Fix the failing test',
    discovery: discoveryWith({}),
    inputs: { steps: [{ kind: 'lint' }, { kind: 'report' }] }
  })
  assert.deepEqual(kindsOf(built), ['lint', 'report'])
  assert.equal(built.intent, 'contract')
  assert.equal(built.steps[0].source, 'contract')
})

test('an explicit step of an unknown kind is rejected and recorded, not silently kept', () => {
  const built = buildPlan({
    goal: 'Fix the failing test',
    discovery: discoveryWith({}),
    inputs: { steps: [{ kind: 'lint' }, { kind: 'time-machine' }, { kind: 'report' }] }
  })
  assert.deepEqual(kindsOf(built), ['lint', 'report'])
  assert.ok(built.reasons.some((reason) => reason.includes('time-machine')))
})

test('an explicit step naming an operation the supervisor cannot run is refused', () => {
  const built = buildPlan({
    goal: 'do the thing',
    discovery: discoveryWith({}),
    inputs: { steps: [{ kind: 'inspect', operation: 'teleport' }] }
  })
  assert.equal(built.steps.length, 0)
  assert.ok(built.reasons.some((reason) => reason.includes('teleport')))
})

test('a contract plan that omits reproduce is kept, and the missing regression evidence is recorded', () => {
  const built = buildPlan({
    goal: 'Fix the failing test',
    discovery: discoveryWith({}),
    inputs: { steps: [{ kind: 'patch' }, { kind: 'full-verify' }] }
  })
  assert.deepEqual(kindsOf(built), ['patch', 'full-verify'])
  assert.ok(built.reasons.some((reason) => reason.includes('no reproduce step')))
})

test('an explicit step is normalized: operation, command, args, cwd, expects, timeout and evidence', () => {
  const built = buildPlan({
    goal: 'anything',
    discovery: discoveryWith({}),
    inputs: {
      steps: [
        {
          kind: 'focused-test',
          command: 'node --test',
          args: ['one.test.js'],
          cwd: 'app',
          expects: { exitCode: 3 },
          timeoutMs: 1234,
          evidence: 'the failing test output',
          optional: true,
          description: 'run the one test'
        }
      ]
    }
  })
  const step = built.steps[0]
  assert.equal(step.command, 'node')
  assert.deepEqual(step.args, ['one.test.js'])
  assert.equal(step.cwd, 'app')
  assert.deepEqual(step.expects, { exitCode: 3 })
  assert.equal(step.timeoutMs, 1234)
  assert.deepEqual(step.evidence, ['the failing test output'])
  assert.equal(step.optional, true)
  assert.equal(step.description, 'run the one test')
  assert.equal(step.operation, 'focusedTest')
})

test('an explicit step may write its arguments as one string', () => {
  const built = buildPlan({
    goal: 'anything',
    discovery: { root: process.cwd(), commands: {} },
    inputs: { steps: [{ kind: 'inspect', command: 'node --test --reporter=tap', args: 'a.test.js --runInBand' }] }
  })
  const step = built.steps[0]
  assert.equal(step.command, 'node')
  assert.deepEqual(step.args, ['a.test.js', '--runInBand'])
})

test('an explicit command carries the discovered arguments of its kind', () => {
  const built = buildPlan({
    goal: 'anything',
    discovery: {
      commands: {
        focusedTest: { command: 'node --test', args: ['--test'], acceptsFocus: true, evidence: 'fixture' }
      }
    },
    inputs: { steps: [{ kind: 'focused-test', command: 'node' }] }
  })
  assert.equal(built.steps[0].command, 'node')
  assert.deepEqual(built.steps[0].args, ['--test'])

  // The same merge happens in the explicit-plan focus path, which is where the
  // split once dropped the discovered argument.
  const focused = buildPlan({
    goal: 'anything',
    discovery: {
      commands: {
        focusedTest: { command: 'node --test', args: ['--test'], acceptsFocus: true, evidence: 'fixture' }
      }
    },
    inputs: { steps: [{ kind: 'focused-test', command: 'node' }], focus: 'one.test.js' }
  })
  assert.deepEqual(focused.steps[0].args, ['--test', 'one.test.js'])
})

test('a step that does not run a command carries a null operation', () => {
  const built = buildPlan({ goal: 'Fix the failing test', discovery: discoveryWith({}) })
  for (const kind of ['inspect', 'patch', 'report']) {
    const step = built.steps.find((candidate) => candidate.kind === kind)
    if (step) assert.equal(step.operation, null, `${kind} does not run a command`)
  }
})

test('the module-level nextStep and advance read and move the same cursor the plan methods do', () => {
  const plan = buildPlan({ goal: 'Fix the failing test', discovery: discoveryWith({}) })
  assert.equal(nextStep({}), null, 'something that is not a plan has no next step')
  assert.equal(advance({}, 'anything').ok, false)
  assert.equal(nextStep(plan).id, plan.steps[0].id)
  assert.equal(advance(plan, plan.steps[0].id, { ok: true }).ok, true)
  assert.equal(plan.cursor, 1)
  assert.equal(advance(plan, plan.steps[0].id, { ok: true }).ok, false)
})

test('nextStep returns the cursor step and skips the steps already complete', () => {
  const built = buildPlan({ goal: 'Fix the failing test', discovery: discoveryWith({}) })
  const first = nextStep(built)
  assert.equal(first.id, built.steps[0].id)
  assert.equal(built.cursor, 0, 'reading the next step must not settle it')

  // The step behind the cursor is skipped rather than re-run.
  assert.equal(built.markedComplete(built.steps[0].id).ok, true)
  assert.equal(nextStep(built).id, built.steps[1].id)
  assert.equal(built.cursor, 1)

  // A step marked complete ahead of the cursor is skipped when the cursor reaches it.
  assert.equal(built.markedComplete(built.steps[2].id).ok, true)
  advance(built, built.steps[1].id, { ok: true })
  assert.equal(nextStep(built).id, built.steps[3].id, 'a step already complete is never executed twice')
})

test('the cursor refuses to advance a step that is not the current one', () => {
  const built = buildPlan({ goal: 'Fix the failing test', discovery: discoveryWith({}) })
  const later = built.steps[3].id
  const verdict = advance(built, later, { ok: true })
  assert.equal(verdict.ok, false)
  assert.ok(verdict.reason.includes('only the current step'))
  assert.equal(built.cursor, 0)
  assert.equal(advance(built, built.steps[0].id, { ok: true }).ok, true)
  assert.equal(built.cursor, 1)
})

test('advance records the outcome and refuses a step that was already settled', () => {
  const built = buildPlan({ goal: 'Fix the failing test', discovery: discoveryWith({}) })
  const first = built.steps[0]
  const verdict = advance(built, first.id, { ok: true, evidence: { exitCode: 1 }, failure: null })
  assert.equal(verdict.ok, true)
  assert.equal(built.completed.length, 1)
  assert.deepEqual(built.completed[0].evidence, { exitCode: 1 })
  assert.equal(built.completed[0].outcome.ok, true)
  assert.equal(advance(built, first.id, { ok: true }).ok, false)
})

test('the completed history is bounded at twice the step budget', () => {
  const built = buildPlan({
    goal: 'Fix the failing test',
    discovery: discoveryWith({}),
    contract: { maxSteps: 2 },
    inputs: { steps: [{ kind: 'inspect' }, { kind: 'patch' }, { kind: 'report' }] }
  })
  assert.equal(built.steps.length, 2)
  const ids = []
  let guard = 0
  while (built.cursor < built.steps.length && guard < 10) {
    guard += 1
    const current = nextStep(built)
    if (!current) break
    advance(built, current.id, { ok: true })
  }
  // Two steps settle, and the array may hold `maxSteps * 2` = 4 records.
  assert.ok(built.completed.length <= built.budget.maxSteps * 2)
  assert.equal(built.progress().complete, true)
  assert.deepEqual(ids, [])
})

test('an optional step may be recorded as failed without moving the cursor backwards', () => {
  const built = buildPlan({
    goal: 'anything',
    discovery: discoveryWith({}),
    inputs: { steps: [{ kind: 'lint', optional: true }, { kind: 'report' }] }
  })
  const optional = built.steps[0]
  const verdict = built.optionalFailed(optional.id, 'the linter is not installed')
  assert.equal(verdict.ok, true)
  assert.equal(built.cursor, 1)
  assert.equal(nextStep(built).id, built.steps[1].id)
  assert.ok(built.optionalFailures.some((entry) => entry.reason === 'the linter is not installed'))

  const resumed = buildPlan({
    goal: 'anything',
    discovery: discoveryWith({}),
    inputs: { steps: [{ kind: 'lint' }, { kind: 'report' }] }
  })
  assert.equal(resumed.optionalFailed(resumed.steps[0].id, 'nope').ok, false, 'a required step cannot be skipped')
})

test('a plan built from a goal with no discoverable command keeps only the steps that run no command and says why', () => {
  const built = buildPlan({ goal: 'Fix the failing test', discovery: { root: process.cwd(), commands: {} } })
  assert.deepEqual(kindsOf(built), ['inspect', 'patch'], 'only the command-free steps survive')
  assert.ok(built.reasons.some((reason) => reason.includes('no test command was discovered')), 'the missing regression evidence is recorded')
})

test('expectsMet judges a step outcome against the expectation it declares', () => {
  assert.equal(plan.expectsMet({ exitCode: 0 }, { exitCode: 0 }).ok, true)
  assert.equal(plan.expectsMet({ exitCode: 0 }, { exitCode: 1 }).ok, false)
  const counts = plan.expectsMet({ exitCode: 0, testCount: { failed: 0 } }, { exitCode: 0, testCount: { failed: 2 } })
  assert.equal(counts.ok, false)
  assert.ok(counts.reason.includes('failed'))
  assert.equal(plan.expectsMet({ exitCode: 0, testCount: { failed: 0 } }, { exitCode: 0, testCount: null }).ok, false)
})

test('the plan kind vocabulary is closed and frozen', () => {
  assert.equal(Object.isFrozen(PLAN_KINDS), true)
  assert.deepEqual(PLAN_KIND_LIST.slice().sort(), [
    'affected-test',
    'build',
    'focused-test',
    'full-verify',
    'inspect',
    'inspect-failure',
    'install',
    'lint',
    'patch',
    'report',
    'reproduce',
    'run-service',
    'typecheck',
    'wait-process'
  ])
})
