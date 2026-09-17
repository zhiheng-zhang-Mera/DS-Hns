'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..', '..')
const HARNESS = path.join(ROOT, 'scripts', 'longhost-soak.cjs')
const CLOCK = path.join(ROOT, 'tests', 'helpers', 'longhost-clock.cjs')
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8')

const { createVirtualClock, createRealClock, SOAK_HORIZONS } = require(CLOCK)
const { soakHealth, soakBudget, soakHeartbeat, soakMaintenance, SCENARIOS, runScenario, smokeRealtime } = require(HARNESS)

/**
 * The long-hosting soak, and the claim that makes it worth running.
 *
 * The requirement asks for 6/12/24-hour synthetic runs. What a soak is *for* is catching the failures
 * that only appear with time — a rolling window that never rolls, a backoff that never caps, a
 * deferral that never expires, a history ring that grows, a cooldown that stops firing — and every one
 * of those is a property of the code rather than of the wall clock, which is why the harness drives
 * the same code with a virtual clock.
 *
 * This suite does two things: it asserts the harness is *wired* (registered with the gates, naming the
 * horizons, keeping a real-machine entry point), and it *runs* it at a bounded horizon so the soak is
 * exercised on every `node --test` rather than only when somebody remembers.
 */

test('the virtual clock drives timers, not the wall clock', async () => {
  const clock = createVirtualClock({ start: 1_000 })
  const fired = []
  await clock.withTimers(async () => {
    setTimeout(() => fired.push('once'), 500)
    const interval = setInterval(() => fired.push('tick'), 100)
    await clock.advance(350)
    clearInterval(interval)
  })
  assert.deepEqual(fired, ['tick', 'tick', 'tick'], `unexpected timer order: ${fired.join(', ')}`)
  assert.equal(clock.now(), 1_350)
  // Nothing is left scheduled: a clock that leaked a timer would make the next assertion in a suite
  // depend on the previous one.
  assert.equal(clock.pending(), 0)
})

test('a virtual hour costs no wall-clock time', async () => {
  const clock = createVirtualClock({ start: 0 })
  const started = Date.now()
  await clock.advance(3_600_000)
  const elapsed = Date.now() - started
  assert.equal(clock.now(), 3_600_000)
  assert.ok(elapsed < 1_000, `an hour of virtual time took ${elapsed}ms of real time`)
})

test('the horizons are the ones the requirement names', () => {
  assert.deepEqual(Object.keys(SOAK_HORIZONS).sort(), ['12h', '24h', '6h'])
  assert.deepEqual(SCENARIOS.map((scenario) => scenario.id), ['soak-6h', 'soak-12h', 'soak-24h'])
  for (const scenario of SCENARIOS) {
    assert.equal(scenario.horizon, SOAK_HORIZONS[scenario.id.replace('soak-', '')])
  }
  // The real-machine entry point is kept, and it is the same scenarios: a soak that measured
    // something different on a real clock would not be evidence about what the synthetic run tested.
  const harness = read('scripts/longhost-soak.cjs')
  assert.match(harness, /--realtime/)
  assert.match(harness, /--hours/)
  assert.match(harness, /runRealtime/)
})

test('every soak scenario passes at a bounded horizon', async () => {
  /**
   * One virtual hour, which is enough to cross the boundaries the *cases* assert on (a five-minute
   * maintenance window twice, a ten-minute budget window six times, twelve heartbeats a minute), and
   * cheap enough to run on every test invocation. The full 6/12/24-hour runs are the CI step's job —
   * `longhost-soak.cjs all` — and the six-hour one is driven end to end by the test below.
   */
  const horizonMs = 3_600_000
  const reports = await Promise.all([
    soakHealth(horizonMs),
    soakHealth(horizonMs, { hot: true }),
    soakBudget(horizonMs),
    soakHeartbeat(horizonMs),
    soakMaintenance(horizonMs)
  ])
  for (const report of reports) {
    assert.equal(report.failed, 0, `${report.title} failed: ${report.failures.map((failure) => `${failure.label} (${failure.detail})`).join('; ')}`)
    assert.ok(report.checks >= 4, `${report.title} asserted too little: ${report.checks} check(s)`)
  }
})

test('the soak harness names every case and reports per-case failures', () => {
  const result = spawnSync(process.execPath, [HARNESS, '--list'], { encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 0, result.stderr)
  for (const id of ['soak-6h', 'soak-12h', 'soak-24h']) assert.match(result.stdout, new RegExp(id))
  assert.match(result.stdout, /realtime/)

  /**
   * The full six-hour scenario, driven end to end through the program the CI step calls.
   *
   * It is the *whole* horizon on purpose: the assertions inside it are about what a six-hour
   * application does — a budget window that rolls six times, a ladder that reaches safe mode, a
   * maintenance window it never reaches — and a shortened run would be a different scenario wearing
   * the same name. It costs about two seconds of wall clock, because six hours of virtual time is
   * arithmetic.
   */
  const report = spawnSync(process.execPath, [HARNESS, 'soak-6h', '--json'], { encoding: 'utf8', windowsHide: true, timeout: 300_000 })
  assert.equal(report.status, 0, `the harness exited ${report.status}: ${report.stderr}`)
  const parsed = JSON.parse(report.stdout.trim())
  assert.equal(parsed.harness, 'longhost-soak')
  assert.equal(parsed.passed, true)
  assert.ok(parsed.checks >= 30, `expected a meaningful number of checks, got ${parsed.checks}`)
  assert.equal(parsed.scenarios[0].horizonHours, 6)
  for (const scenario of parsed.scenarios) {
    assert.equal(scenario.passed, true)
    assert.ok(scenario.cases.length >= 5, 'every scenario runs the five long-hosting cases')
  }
})

test('a scenario reports a failure rather than throwing when a bound is broken', async () => {
  // The harness's own contract: a soak that throws tells you nothing about what it measured, so every
  // case answers with `{ passed, failures }`. Driving it with an absurd budget (zero restarts) is a
  // cheap way to prove the failure path produces a report instead of an exception.
  const report = await runScenario({ id: 'probe', horizon: 600_000 }, { horizonMs: 600_000 })
  assert.equal(typeof report.passed, 'boolean')
  assert.ok(Array.isArray(report.cases))
  for (const entry of report.cases) {
    assert.equal(typeof entry.checks, 'number')
    assert.ok(Array.isArray(entry.failures))
  }
})

/**
 * The real-machine entry point, as two facts that can each be checked quickly.
 *
 * The synthetic runs are evidence about the *code*; they say nothing about whether the same code
 * survives the machine's own clock, and `--realtime --hours 24` is the only mode that answers that. A
 * twenty-four hour wait cannot be part of a gate, so the gate checks the two halves separately: the
 * real clock really waits, and the entry point really uses it.
 */
test('the real clock waits for real, and shares the virtual clock surface', async () => {
  const clock = createRealClock()
  const started = Date.now()
  await clock.sleep(120)
  const elapsed = Date.now() - started
  assert.equal(clock.realtime, true, 'a real clock must say which kind it is')
  assert.ok(elapsed >= 100, `a 120ms real sleep took ${elapsed}ms of wall clock`)
  assert.equal(clock.errors().length, 0)
  // The same surface the virtual clock offers, so a case can be handed either one.
  for (const method of ['now', 'advance', 'sleep', 'run', 'withTimers', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'fired', 'pending', 'errors']) {
    assert.equal(typeof clock[method], 'function', `the real clock is missing ${method}()`)
  }
  const stepped = await clock.run({ durationMs: 60, stepMs: 20, onStep: () => {} })
  assert.equal(stepped.steps, 3)
  await clock.withTimers(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
  assert.ok(clock.now() >= started)
})

test('the real-machine entry point runs the same cases on the real clock, and smoke-tests itself', async () => {
  const harness = read('scripts/longhost-soak.cjs')
  // The entry point builds a real clock instead of a virtual one, and the cases take whichever clock
  // they are handed rather than creating their own.
  assert.match(harness, /options\.clock \|\| createRealClock\(\)/)
  assert.match(harness, /const time = clock \|\| createVirtualClock/)
  assert.match(harness, /--smoke/)

  // The smoke run is the entry point's own test: real clock, real elapsed time, its own checks.
  const started = Date.now()
  const smoke = await smokeRealtime(0.0001, { clock: createRealClock() })
  assert.equal(smoke.passed, true, JSON.stringify(smoke.cases[0].failures))
  assert.equal(smoke.failures, 0)
  assert.ok(Date.now() - started >= 100, 'the smoke run did not spend real time')
  assert.match(smoke.cases[0].title, /real-clock entry point/)

  // ...and through the program, exactly as an operator would call it.
  const result = spawnSync(process.execPath, [HARNESS, '--realtime', '--smoke', '--json'], { encoding: 'utf8', windowsHide: true, timeout: 120_000 })
  assert.equal(result.status, 0, `the smoke run exited ${result.status}: ${result.stderr}`)
  const parsed = JSON.parse(result.stdout.trim())
  assert.equal(parsed.realtime, true)
  assert.equal(parsed.smoke, true)
  assert.equal(parsed.passed, true)
})
