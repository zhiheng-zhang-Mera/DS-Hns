'use strict'

/**
 * The verifier's invariants.
 *
 * The completion decision is the one place a runtime is most tempted to accept a
 * plausible answer instead of a demonstrated one, so these tests assert the rules
 * that make a "pass" mean something: the supervisor runs the command, a non-zero
 * exit and a timeout are failures, a summary is parsed from real output rather
 * than guessed, and satisfied() is false for evidence that predates a change.
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { createVerifier, VERIFICATION_LEVELS, parseTestSummary } = require('../../app/engineering/verifier.cjs')

const CHECKPOINT = path.join(__dirname, '..', '..', 'app', 'engineering', 'checkpoint.cjs')

/** A controllable clock, so freshness is asserted instead of hoped for. */
function createClock(start = 1_000) {
  let value = start
  return {
    now: () => value,
    advance(ms = 1) {
      value += ms
      return value
    }
  }
}

/** The checkpoint module's real truncation contract, as this module consumes it. */
function fakeTruncate(text, options = {}) {
  const source = String(text || '')
  const maxBytes = Number.isInteger(options.maxBytes) ? options.maxBytes : 256 * 1024
  const originalBytes = Buffer.byteLength(source)
  if (originalBytes <= maxBytes) {
    return { text: source, bytes: originalBytes, originalBytes, truncated: false, head: source, tail: source, errorRegion: source }
  }
  const head = source.slice(0, Math.floor(maxBytes / 2))
  const tail = source.slice(-Math.floor(maxBytes / 2))
  return { text: `${head}\n[... omitted ...]\n${tail}`, bytes: head.length + tail.length, originalBytes, truncated: true, head, tail, errorRegion: tail }
}

/**
 * A scripted supervisor: it records what it was asked to start and answers with
 * the outcome the test queued. No process is ever spawned.
 */
function createFakeSupervisor(script = [], options = {}) {
  const started = []
  const queue = script.slice()
  return {
    started,
    start(input) {
      const outcome = queue.shift() || {}
      started.push({ ...input, outcome })
      return { id: `p${started.length}`, ...outcome, startedAt: 0 }
    },
    async waitForExit(id, options = {}) {
      const entry = started[Number(String(id).slice(1)) - 1] || {}
      const outcome = entry.outcome || {}
      return {
        ok: outcome.exitCode === 0 && !outcome.timedOut,
        status: outcome.timedOut ? 'timed_out' : 'exited',
        exitCode: Number.isInteger(outcome.exitCode) ? outcome.exitCode : null,
        signal: outcome.signal || null,
        timedOut: outcome.timedOut === true,
        killed: outcome.killed === true,
        durationMs: Number.isFinite(outcome.durationMs) ? outcome.durationMs : 5,
        waitedMs: 5,
        output: outcome.output || ''
      }
    },
    options
  }
}

const DISCOVERY = {
  commands: {
    install: { command: 'npm ci', acceptsFocus: false, evidence: 'fixture' },
    build: { command: 'npm run build', acceptsFocus: false, evidence: 'fixture' },
    test: { command: 'npm test --silent', acceptsFocus: false, evidence: 'fixture' },
    focusedTest: { command: 'node --test', acceptsFocus: true, evidence: 'fixture' }
  }
}

/** A passing outcome for every level the ladder can run. */
function passingRuns() {
  return [
    { exitCode: 0, output: '# tests 12\n# pass 12\n# fail 0\n' },
    { exitCode: 0, output: '# tests 40\n# pass 40\n# fail 0\n' },
    { exitCode: 0, output: '# tests 300\n# pass 300\n# fail 0\n' }
  ]
}

function makeVerifier(options = {}) {
  const clock = options.clock || createClock()
  const supervisor = options.supervisor || createFakeSupervisor(passingRuns())
  const verifier = createVerifier({
    supervisor,
    workspace: process.cwd(),
    discovery: options.discovery || DISCOVERY,
    now: clock.now,
    truncate: options.truncate || fakeTruncate,
    mutations: options.mutations,
    required: options.required
  })
  return { verifier, supervisor, clock }
}

test('a run resolves the level command, appends the focus and goes through the supervisor', async () => {
  const { verifier, supervisor } = makeVerifier({ supervisor: createFakeSupervisor([{ exitCode: 0, output: '# tests 1\n# pass 1\n# fail 0\n' }]) })
  const result = await verifier.run(VERIFICATION_LEVELS.FOCUSED, { focus: 'tests/unit/foo.test.js' })
  assert.equal(supervisor.started.length, 1, 'the verifier must never spawn a process itself')
  assert.equal(supervisor.started[0].command, 'node')
  assert.deepEqual(supervisor.started[0].args, ['--test', 'tests/unit/foo.test.js'])
  assert.equal(result.level, 'focused-test')
  assert.equal(result.operation, 'focusedTest')
  assert.equal(result.cwd, process.cwd())
  assert.equal(result.ok, true)
  assert.deepEqual(result.testSummary, { tests: 1, passed: 1, failed: 0, durationMs: null, framework: 'node-test' })
})

test('a focus is not appended to a command that does not accept one', async () => {
  const { verifier, supervisor } = makeVerifier({ supervisor: createFakeSupervisor([{ exitCode: 0 }]) })
  await verifier.run(VERIFICATION_LEVELS.FULL, { focus: 'tests/unit/foo.test.js' })
  assert.equal(supervisor.started[0].command, 'npm')
  assert.deepEqual(supervisor.started[0].args, ['test', '--silent'])
})

test('a level with no discovered command reports the refusal instead of guessing one', async () => {
  const { verifier, supervisor } = makeVerifier({ discovery: { commands: {} }, supervisor: createFakeSupervisor([]) })
  const result = await verifier.run(VERIFICATION_LEVELS.FOCUSED)
  assert.equal(result.ok, false)
  assert.equal(supervisor.started.length, 0)
  assert.ok(result.reason.includes('no command was discovered'))
})

test('a non-zero exit is classified from the output and is not a success', async () => {
  const { verifier } = makeVerifier({
    supervisor: createFakeSupervisor([{ exitCode: 1, output: 'AssertionError: expected 1 to equal 2\n' }])
  })
  const result = await verifier.run(VERIFICATION_LEVELS.FULL)
  assert.equal(result.ok, false)
  assert.equal(result.exitCode, 1)
  assert.equal(result.signal, null)
  assert.equal(result.timedOut, false)
  assert.equal(typeof result.failure.class, 'string')
  assert.ok(result.failure.reason.length > 0)
  assert.match(result.reason, /\w/)
})

test('a timeout is a failure with the timeout class', async () => {
  const { verifier } = makeVerifier({
    supervisor: createFakeSupervisor([{ exitCode: null, timedOut: true, killed: true, output: 'the run exceeded its 100ms budget' }])
  })
  const result = await verifier.run(VERIFICATION_LEVELS.FULL)
  assert.equal(result.ok, false)
  assert.equal(result.timedOut, true)
  assert.equal(result.failure.class, 'timeout')
})

test('a killed process is not a success even when it exited zero', async () => {
  const { verifier } = makeVerifier({ supervisor: createFakeSupervisor([{ exitCode: 0, killed: true }]) })
  const result = await verifier.run(VERIFICATION_LEVELS.FULL)
  assert.equal(result.ok, false)
  assert.equal(result.killed, true)
})

test('a signalled exit is not a success', async () => {
  const { verifier } = makeVerifier({ supervisor: createFakeSupervisor([{ exitCode: null, signal: 'SIGKILL' }]) })
  const result = await verifier.run(VERIFICATION_LEVELS.FULL)
  assert.equal(result.ok, false)
  assert.equal(result.signal, 'SIGKILL')
})

test('every run carries a timeout and truncates the output it retains', async () => {
  const long = 'x'.repeat(4_000)
  const supervisor = createFakeSupervisor([{ exitCode: 0, output: long }])
  const verifier = createVerifier({
    supervisor,
    workspace: process.cwd(),
    discovery: DISCOVERY,
    truncate: fakeTruncate,
    maxBytes: 512
  })
  const result = await verifier.run(VERIFICATION_LEVELS.FULL)
  assert.equal(supervisor.started[0].softTimeoutMs, 30 * 60_000, 'the run defaults to the thirty-minute bound')
  assert.equal(supervisor.started[0].hardTimeoutMs, supervisor.started[0].softTimeoutMs)
  assert.equal(result.output.truncated, true)
  assert.ok(result.output.originalBytes > 512)
  assert.ok(Buffer.byteLength(result.output.text) < result.output.originalBytes)
})

test('a refused start is reported as a failure rather than thrown', async () => {
  const supervisor = {
    start() {
      throw new Error('the runtime already owns too many processes')
    },
    async waitForExit() {
      throw new Error('never reached')
    }
  }
  const { verifier } = makeVerifier({ supervisor })
  const result = await verifier.run(VERIFICATION_LEVELS.FULL)
  assert.equal(result.ok, false)
  assert.ok(result.reason.includes('refused to start'))
})

test('runLevels stops at the first level that breaks and names it', async () => {
  const { verifier } = makeVerifier({
    supervisor: createFakeSupervisor([
      { exitCode: 0, output: '# tests 3\n# pass 3\n# fail 0\n' },
      { exitCode: 1, output: '1 failed, 11 passed in 2.3s' }
    ])
  })
  const verdict = await verifier.runLevels([VERIFICATION_LEVELS.FOCUSED, VERIFICATION_LEVELS.AFFECTED, VERIFICATION_LEVELS.FULL])
  assert.equal(verdict.ok, false)
  assert.equal(verdict.broken, 'affected-test')
  assert.deepEqual(verdict.ran, ['focused-test'])
  assert.equal(verdict.results.length, 2)
})

test('satisfied() is false when the full level never ran', () => {
  const { verifier } = makeVerifier({})
  const gate = verifier.satisfied()
  assert.equal(gate.ok, false)
  assert.ok(gate.missing.includes('full-verify'))
  assert.ok(gate.reason.length > 0)
})

test('satisfied() is true only with fresh passing evidence at every required level', async () => {
  const clock = createClock()
  const { verifier } = makeVerifier({
    clock,
    supervisor: createFakeSupervisor([
      { exitCode: 0, output: '# tests 12\n# pass 12\n# fail 0\n' },
      { exitCode: 0, output: '# tests 40\n# pass 40\n# fail 0\n' },
      { exitCode: 0, output: '# tests 300\n# pass 300\n# fail 0\n' }
    ])
  })
  const verdict = await verifier.runLevels()
  assert.equal(verdict.ok, true)
  const gate = verifier.satisfied()
  assert.equal(gate.ok, true)
  assert.deepEqual(gate.missing, [])
})

test('satisfied() is false when the full level evidence predates a mutation', async () => {
  const clock = createClock()
  const mutations = { all: () => [{ at: clock.now() - 1, path: 'src/a.js' }] }
  const { verifier } = makeVerifier({ clock, mutations })
  await verifier.runLevels()
  assert.equal(verifier.satisfied().ok, true)
  // A mutation recorded after the green run invalidates it, because the tree the
  // evidence describes no longer exists.
  const mutationAt = clock.advance(10)
  mutations.all = () => [{ at: mutationAt, path: 'src/b.js' }]
  const after = verifier.satisfied()
  assert.equal(after.ok, false)
  assert.ok(after.missing.includes('full-verify'))
  assert.ok(after.reason.includes('full-verify'))
})

test('satisfied() honours sinceAt and sinceMs against the clock', async () => {
  const clock = createClock()
  const { verifier } = makeVerifier({ clock })
  await verifier.runLevels()
  const now = clock.now()
  assert.equal(verifier.satisfied({ sinceAt: now - 1 }).ok, true)
  assert.equal(verifier.satisfied({ sinceAt: now + 1 }).ok, false)
  assert.equal(verifier.satisfied({ sinceMs: 1_000 }).ok, true)
  clock.advance(60_000)
  const aged = verifier.satisfied({ sinceMs: 1_000 })
  assert.equal(aged.ok, false)
  assert.ok(aged.missing.includes('full-verify'))
})

test('invalidate marks the levels stale and makes the gate refuse', async () => {
  const clock = createClock()
  const { verifier } = makeVerifier({ clock })
  await verifier.runLevels()
  assert.equal(verifier.satisfied().ok, true)
  clock.advance(5)
  const dropped = verifier.invalidate('the patch changed src/a.js')
  assert.equal(dropped.ok, true)
  assert.deepEqual(dropped.stale, ['focused-test', 'affected-test', 'full-verify'])
  const state = verifier.stale()
  assert.equal(state.stale, true)
  assert.deepEqual(state.staleLevels, ['focused-test', 'affected-test', 'full-verify'])
  assert.equal(verifier.satisfied().ok, false)
  assert.equal(verifier.evidence().invalidation.reason, 'the patch changed src/a.js')
})

test('noteMutation bounds freshness for a verifier that has no mutation log', async () => {
  const clock = createClock()
  const { verifier } = makeVerifier({ clock })
  await verifier.runLevels()
  assert.equal(verifier.satisfied().ok, true)
  const changedAt = clock.advance(20)
  verifier.noteMutation(changedAt)
  assert.equal(verifier.satisfied().ok, false)
  assert.equal(verifier.stale().stale, true)
})

test('evidence() reports when each level last ran and whether it is fresh', async () => {
  const clock = createClock()
  const { verifier } = makeVerifier({ clock })
  const focusedAt = clock.now()
  await verifier.run(VERIFICATION_LEVELS.FOCUSED, { focus: 'tests/unit/foo.test.js' })
  await verifier.runLevels([VERIFICATION_LEVELS.AFFECTED, VERIFICATION_LEVELS.FULL])
  const recorded = verifier.evidence()
  assert.equal(recorded.levels['focused-test'].at, focusedAt)
  assert.equal(recorded.levels['focused-test'].ok, true)
  assert.equal(recorded.fresh, true)
  assert.equal(recorded.commands.length, 3)
  assert.equal(recorded.commands[0].level, 'focused-test')
  assert.equal(recorded.commands[0].truncated, false)
})

test('parseTestSummary reads node --test TAP-ish output', () => {
  const summary = parseTestSummary('# tests 12\n# pass 11\n# fail 1\n# duration_ms 421.5\n')
  assert.deepEqual(summary, { tests: 12, passed: 11, failed: 1, durationMs: 422, framework: 'node-test' })
})

test('parseTestSummary reads Jest and Vitest output', () => {
  const summary = parseTestSummary('Test Suites: 1 failed, 3 passed, 4 total\nTests:       1 failed, 11 passed, 12 total\nTime:        2.35 s\n')
  assert.equal(summary.tests, 12)
  assert.equal(summary.passed, 11)
  assert.equal(summary.failed, 1)
  assert.equal(summary.durationMs, 2350)
  assert.equal(summary.framework, 'jest-vitest', 'a Jest summary must not be mistaken for a pytest one')
})

test('parseTestSummary reads pytest output', () => {
  const summary = parseTestSummary('==================== 1 failed, 11 passed in 2.3s ====================')
  assert.equal(summary.tests, 12)
  assert.equal(summary.passed, 11)
  assert.equal(summary.failed, 1)
  assert.equal(summary.durationMs, 2300)
  assert.equal(summary.framework, 'pytest')
  assert.equal(parseTestSummary('===== 11 passed in 0.41s =====').failed, 0)
})

test('parseTestSummary reads cargo test output', () => {
  const summary = parseTestSummary('test result: FAILED. 11 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out')
  assert.equal(summary.tests, 12)
  assert.equal(summary.passed, 11)
  assert.equal(summary.failed, 1)
  assert.equal(summary.framework, 'cargo-test')
  assert.equal(summary.status, 'failed')
  const ok = parseTestSummary('test result: ok. 12 passed; 0 failed; 0 ignored; 0 measured')
  assert.equal(ok.failed, 0)
  assert.equal(ok.status, 'ok')
})

test('parseTestSummary returns null for junk and never throws', () => {
  for (const junk of ['', '   ', 'all good, trust me', 'Compiling ds-harness v1.0.0', null, undefined, 42, {}, []]) {
    assert.equal(parseTestSummary(junk), null, `junk must not produce a summary: ${String(junk)}`)
  }
})

test('a real command runs end to end through the real supervisor registry', { skip: fs.existsSync(CHECKPOINT) ? false : 'app/engineering/checkpoint.cjs has not landed yet' }, async () => {
  const { createProcessSupervisor } = require('../../app/engineering/process.cjs')
  const supervisor = createProcessSupervisor({ now: () => Date.now() })
  const discovery = { commands: { test: { command: process.execPath, args: ['-e', "console.log('# tests 2'); console.log('# pass 2'); console.log('# fail 0')"], acceptsFocus: false, evidence: 'fixture' } } }
  const verifier = createVerifier({ supervisor, workspace: process.cwd(), discovery, required: [VERIFICATION_LEVELS.FOCUSED] })
  try {
    const result = await verifier.run(VERIFICATION_LEVELS.FOCUSED, { timeoutMs: 30_000 })
    assert.equal(result.exitCode, 0, `the real node process must exit zero (${result.reason})`)
    assert.equal(result.ok, true)
    assert.equal(result.testSummary && result.testSummary.tests, 2)
    assert.equal(result.testSummary.failed, 0)
    assert.equal(verifier.satisfied().ok, true, 'a real green run is fresh evidence')
  } finally {
    supervisor.dispose('test teardown')
  }
})
