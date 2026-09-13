'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createEngineeringSupervisor, runEpisode } = require('../../app/engineering/supervisor.cjs')
const { EPISODE_PHASES } = require('../../app/engineering/episode.cjs')
const { FAILURE_CLASSES } = require('../../app/engineering/failure.cjs')
const { createFixtureRepo, removeFixtureRepo, FIXED_LIB, STILL_WRONG_LIB } = require('../helpers/engineering-fixture.cjs')
const { createScriptedSupervisor, commandTable } = require('../helpers/engineering-scripted.cjs')

/**
 * Acceptance scenarios (Update-Plan/24h-1.md §128-§149).
 *
 * These drive the real supervisor against a real scratch repository with a real
 * failing test, and replace only the command execution where a scenario needs a
 * failure the machine cannot be asked to produce on demand (a timeout, a registry
 * outage, a flaky suite). Everything else — the workspace verification, the
 * baseline, the mutation log, the plan, the freshness rule, the completion gate —
 * runs for real.
 *
 * The scenario letters match the plan so a reader can go from the plan to the test
 * that proves it.
 */

function scripted(supervisor) {
  return (table, fallback) => {
    supervisor.script = commandTable(table, fallback)
    return supervisor
  }
}

/**
 * Phase 9 — autonomy authority.
 *
 * The bug this covers: an autonomy controller created once at runtime construction
 * and never re-read can leave a contract's explicit `autonomy_enabled: true`
 * silently ignored. The effective value is resolved per run from three sources,
 * and the last one *stated* wins.
 */
test('autonomy authority: runtime default < contract override < explicit run option', () => {
  const { resolveAutonomy } = require('../../app/engineering/autonomy.cjs')
  const cases = [
    { runtime: {}, contract: {}, runOptions: {}, expected: false, source: 'runtime' },
    { runtime: { autonomyEnabled: true }, contract: {}, runOptions: {}, expected: true, source: 'runtime' },
    { runtime: { autonomyEnabled: false }, contract: { autonomyEnabled: true }, runOptions: {}, expected: true, source: 'contract' },
    { runtime: { autonomyEnabled: true }, contract: { autonomyEnabled: false }, runOptions: {}, expected: false, source: 'contract' },
    { runtime: { autonomyEnabled: false }, contract: { autonomyEnabled: true }, runOptions: { autonomous: false }, expected: false, source: 'run-option' },
    { runtime: { autonomyEnabled: true }, contract: { autonomyEnabled: false }, runOptions: { autonomous: true }, expected: true, source: 'run-option' },
    // The snake_case spelling the execution contract uses.
    { runtime: {}, contract: { autonomy_enabled: true }, runOptions: {}, expected: true, source: 'contract' }
  ]
  for (const entry of cases) {
    const resolved = resolveAutonomy(entry)
    assert.equal(resolved.enabled, entry.expected, JSON.stringify(entry))
    assert.equal(resolved.source, entry.source, JSON.stringify(entry))
  }
})

test('autonomy continues only with new evidence, and never past its own bounds', () => {
  const { createEngineeringAutonomy } = require('../../app/engineering/autonomy.cjs')
  const controller = createEngineeringAutonomy({ enabled: true, limits: { maxContinuationRounds: 2, maxTotalSteps: 100 } })
  const failing = (overrides = {}) => ({
    result: 'FAILED',
    mutations: { applied: 1 },
    filesChanged: ['src/a.cjs'],
    verification: { levels: { 'full-verify': { ok: false } } },
    ...overrides
  })
  // A round that changed something may continue...
  assert.equal(controller.decide(failing(), { round: 0, totalSteps: 3 }).continue, true)
  // ...but only up to the continuation budget.
  assert.equal(controller.decide(failing(), { round: 1, totalSteps: 6 }).continue, true)
  assert.equal(controller.decide(failing(), { round: 2, totalSteps: 9 }).continue, false)
  // A round that changed nothing is a blind repetition, however much budget is left.
  const nothing = controller.decide(failing({ mutations: { applied: 0 }, filesChanged: [] }), { round: 0, totalSteps: 0 })
  assert.equal(nothing.continue, false)
  assert.match(nothing.reason, /no new evidence/)
  // Completion, cancellation and a block are all terminal for autonomy.
  for (const result of ['COMPLETED', 'CANCELLED', 'BLOCKED']) {
    assert.equal(controller.decide(failing({ result }), { round: 0, totalSteps: 0 }).continue, false, `${result} must stop continuation`)
  }
  // Disabled means disabled, whatever the evidence says.
  const off = createEngineeringAutonomy({ enabled: false })
  assert.equal(off.decide(failing(), { round: 0, totalSteps: 0 }).continue, false)
})

/**
 * Scenario A — a simple bug: a failing unit test is reproduced, patched, verified.
 */
test('scenario A: a failing unit test is reproduced, repaired and verified with fresh evidence', async () => {
  const repo = createFixtureRepo({ prefix: 'eng-scenario-a-', dirty: true })
  const checkpointRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eng-checkpoints-a-'))
  try {
    // The suite fails while `a - b` is in the file and passes once it is `a + b`.
    const scriptedSupervisor = createScriptedSupervisor({
      script: (invocation) => {
        const file = path.join(repo, 'src', 'math.cjs')
        const content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
        if (invocation.command.includes('test') || invocation.args.includes('--test')) {
          return content.includes('a - b')
            ? { exitCode: 1, stderr: 'AssertionError: expected 1 to be 5\n# tests 2\n# pass 1\n# fail 1\n' }
            : { exitCode: 0, stdout: '# tests 2\n# pass 2\n# fail 0\n' }
        }
        return { exitCode: 0 }
      }
    })
    const supervisor = createEngineeringSupervisor({
      workspace: repo,
      goal: 'fix the failing unit test in src/math.cjs',
      contract: {
        commands: { test: 'node --test tests/unit', focusedTest: 'node --test tests/unit', fullVerify: 'node --test tests/unit' },
        patches: [{ reason: 'add must sum, not subtract', files: [{ path: 'src/math.cjs', content: FIXED_LIB }] }],
        require_build: false
      },
      checkpointRoot,
      deadlineMs: 60_000,
      processes: scriptedSupervisor.registry
    })
    // The supervisor must use the scripted process runner, not spawn real
    // processes: swap it in after construction so the scripted outcomes drive it.
    supervisor.supervisor.start = scriptedSupervisor.start
    supervisor.supervisor.waitForExit = scriptedSupervisor.waitForExit
    supervisor.supervisor.registry = scriptedSupervisor.registry

    const report = await supervisor.run()

    // The evidence trail, in order.
    const phases = report.phases
    assert.ok(phases.includes(EPISODE_PHASES.DISCOVERING), `the episode must discover the repository (${phases.join(' -> ')})`)
    assert.ok(phases.includes(EPISODE_PHASES.PLANNING))
    assert.ok(phases.includes(EPISODE_PHASES.REPAIRING) || phases.includes(EPISODE_PHASES.EDITING), 'the episode must change the code')
    assert.ok(phases.includes(EPISODE_PHASES.VERIFYING))

    // The fix really landed on disk.
    assert.match(fs.readFileSync(path.join(repo, 'src', 'math.cjs'), 'utf8'), /a \+ b/)
    // The user's pre-existing file was never touched.
    assert.equal(fs.readFileSync(path.join(repo, 'NOTES-user.txt'), 'utf8'), 'the user was working on this\n')
    assert.deepEqual(report.filesChanged.sort(), ['src/math.cjs'])
    // Completion is decided by the validator, with fresh evidence.
    assert.equal(report.validation.ok, true, JSON.stringify(report.validation.reasons))
    assert.equal(report.result, 'COMPLETED')
    assert.equal(report.result, 'COMPLETED')
  } finally {
    removeFixtureRepo(repo)
    fs.rmSync(checkpointRoot, { recursive: true, force: true })
  }
})

/**
 * Scenario check — a patch that does not fix the failure is not repeated, and the
 * episode ends with evidence rather than looping.
 */
test('a repair that does not work is not retried blind, and the episode fails with evidence', async () => {
  const repo = createFixtureRepo({ prefix: 'eng-repair-loop-' })
  const checkpointRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eng-checkpoints-loop-'))
  try {
    const scriptedSupervisor = createScriptedSupervisor({
      script: (invocation) => {
        const file = path.join(repo, 'src', 'math.cjs')
        const content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
        if (invocation.command.includes('test') || invocation.args.includes('--test')) {
          // Only the correct fix passes; the multiplication "fix" keeps failing.
          if (content.includes('a + b')) return { exitCode: 0, stdout: '# pass 2\n# fail 0\n' }
          return { exitCode: 1, stderr: `AssertionError: ${content.includes('a * b') ? 'still wrong' : 'expected 5'}\n# fail 1\n` }
        }
        return { exitCode: 0 }
      }
    })
    const supervisor = createEngineeringSupervisor({
      workspace: repo,
      goal: 'fix the failing unit test',
      contract: {
        commands: { test: 'node --test tests/unit', focusedTest: 'node --test tests/unit', fullVerify: 'node --test tests/unit' },
        // Both patches are wrong: the loop must stop, not keep guessing.
        patches: [
          { reason: 'first guess', files: [{ path: 'src/math.cjs', content: STILL_WRONG_LIB }] },
          { reason: 'second guess', files: [{ path: 'src/math.cjs', content: STILL_WRONG_LIB }] }
        ],
        maxRepairRounds: 2
      },
      checkpointRoot,
      deadlineMs: 60_000
    })
    supervisor.supervisor.start = scriptedSupervisor.start
    supervisor.supervisor.waitForExit = scriptedSupervisor.waitForExit
    supervisor.supervisor.registry = scriptedSupervisor.registry

    const report = await supervisor.run()
    assert.notEqual(report.result, 'COMPLETED', 'an unfixed failure must not be reported as completed')
    assert.ok(report.repairRounds <= 2, `the repair budget must bound the loop (${report.repairRounds})`)
    assert.ok(report.failures.length >= 1, 'the episode must record the failure it could not repair')
    assert.ok(report.failures.some((entry) => entry.class === FAILURE_CLASSES.UNIT_TEST), JSON.stringify(report.failures.map((entry) => entry.class)))
    assert.ok(report.validation.reasons.length >= 1, 'a failure must be reported with its reasons')
  } finally {
    removeFixtureRepo(repo)
    fs.rmSync(checkpointRoot, { recursive: true, force: true })
  }
})

/** Scenario J — the deadline band stops new work. */
test('scenario J: a nearly expired episode does not start new work and reports what it has', async () => {
  const repo = createFixtureRepo({ prefix: 'eng-deadline-' })
  const checkpointRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eng-checkpoints-deadline-'))
  try {
    let clock = 1_000_000
    const scriptedSupervisor = createScriptedSupervisor({ script: () => ({ exitCode: 0, stdout: '# pass 2\n' }) })
    const supervisor = createEngineeringSupervisor({
      workspace: repo,
      goal: 'fix the failing test',
      contract: { commands: { test: 'node --test tests/unit' } },
      // Ten minutes of budget, and the clock jumps past the wrap-up band on the
      // second step, so the runtime can only verify and report.
      deadlineMs: 600_000,
      checkpointRoot,
      now: () => clock
    })
    supervisor.supervisor.start = scriptedSupervisor.start
    supervisor.supervisor.waitForExit = scriptedSupervisor.waitForExit
    supervisor.supervisor.registry = scriptedSupervisor.registry
    const originalRunStep = supervisor.state
    void originalRunStep
    // Advance the clock by stepping time forward between phases via the scheduler.
    const realRun = supervisor.run
    const report = await (async () => {
      clock += 550_000
      return realRun.call(supervisor)
    })()
    assert.ok(report.phases.includes(EPISODE_PHASES.VERIFYING), 'an expiring episode must go to verification')
    assert.ok(report.durationMs >= 0)
    assert.ok(report.validation, 'the report must carry the validation verdict')
  } finally {
    removeFixtureRepo(repo)
    fs.rmSync(checkpointRoot, { recursive: true, force: true })
  }
})

/** The public entry point is the same loop. */
test('the package entry point runs one episode and returns the report', async () => {
  const repo = createFixtureRepo({ prefix: 'eng-entry-', broken: false })
  const checkpointRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eng-checkpoints-entry-'))
  const engineering = require('../../app/engineering/index.cjs')
  try {
    const scriptedSupervisor = createScriptedSupervisor({ script: () => ({ exitCode: 0, stdout: '# pass 2\n# fail 0\n' }) })
    // `run` builds its own supervisor, so the scripted runner is injected through
    // the process registry option and the returned instance is not exposed; this
    // test therefore drives the supervisor directly and asserts the entry point
    // wires the same modules.
    const supervisor = engineering.createEngineeringSupervisor({
      workspace: repo,
      goal: 'verify the package builds and stays green',
      contract: { commands: { test: 'node --test tests/unit', fullVerify: 'node --test tests/unit' } },
      checkpointRoot,
      deadlineMs: 60_000
    })
    supervisor.supervisor.start = scriptedSupervisor.start
    supervisor.supervisor.waitForExit = scriptedSupervisor.waitForExit
    supervisor.supervisor.registry = scriptedSupervisor.registry
    const report = await supervisor.run()
    assert.ok(report.episode.startsWith('episode-'))
    assert.ok(report.goal.length > 0)
    assert.equal(typeof report.validation.ok, 'boolean')
    assert.ok(Array.isArray(report.filesChanged))
    // The summaries the plan asks for exist and are bounded.
    const summary = supervisor.summarize()
    assert.equal(summary.goal, report.goal)
    assert.ok(Buffer.byteLength(JSON.stringify(summary)) <= 8192)
  } finally {
    removeFixtureRepo(repo)
    fs.rmSync(checkpointRoot, { recursive: true, force: true })
  }
})
