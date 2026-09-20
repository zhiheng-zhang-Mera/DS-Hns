'use strict'

/**
 * Adaptive performance policy: dynamic budgets and dynamic timeouts.
 *
 * This file is the guard on the two rules the requirement states outright:
 *
 *   CORRECTNESS GATE != PERFORMANCE GATE
 *   a slow host may run slowly; it must not be declared incorrectly installed
 *
 * So the tests here are about *policy shape*, not about any machine's numbers.
 * They assert that a budget is derived from the work plus the host's own measured
 * cost, that it is bounded in both directions, and that a slow host's budget is
 * larger rather than its installation being failed.
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const capability = require('../../app/runtime/host-capability.cjs')

function profile({ cores = 8, totalMB = 16384, availableMB = 8192, spawnP50 = 120, spawnP95 = 260, workerP95 = 1400 } = {}) {
  return capability.createCalibratedProfile({
    hardware: {
      logicalCores: cores,
      physicalCores: Math.max(1, Math.round(cores / 2)),
      totalMB,
      availableMB,
      architecture: 'x64',
      memoryPressure: (totalMB - availableMB) / totalMB
    },
    calibration: { nodeSpawnP50Ms: spawnP50, nodeSpawnP95Ms: spawnP95, workerColdStartP95Ms: workerP95 }
  })
}

const LOW = profile({ cores: 2, totalMB: 4096, availableMB: 1800, spawnP50: 420, spawnP95: 900, workerP95: 4200 })
const MID = profile({ cores: 8, totalMB: 16384, availableMB: 8192, spawnP50: 120, spawnP95: 260, workerP95: 1400 })
const HIGH = profile({ cores: 32, totalMB: 65536, availableMB: 52000, spawnP50: 40, spawnP95: 70, workerP95: 300 })

test('a dynamic budget is work + measured startup + margin, and says which is which', () => {
  const budget = capability.computeDynamicBudget({
    intrinsicMs: 10_000,
    startupCount: 2,
    calibration: MID.calibration,
    capacity: MID.capacity
  })
  assert.equal(budget.intrinsicMs, 10_000)
  assert.equal(budget.startupCount, 2)
  assert.ok(budget.startupOverheadMs > 0, 'the measured startup cost must appear')
  assert.ok(budget.marginMs > 0, 'a variance margin must appear')
  assert.equal(budget.budgetMs, budget.intrinsicMs + budget.startupOverheadMs + budget.marginMs)
})

test('a slower host gets a larger budget, never a failure', () => {
  const args = { intrinsicMs: 10_000, startupCount: 2 }
  const low = capability.computeDynamicBudget({ ...args, calibration: LOW.calibration, capacity: LOW.capacity })
  const mid = capability.computeDynamicBudget({ ...args, calibration: MID.calibration, capacity: MID.capacity })
  const high = capability.computeDynamicBudget({ ...args, calibration: HIGH.calibration, capacity: HIGH.capacity })
  assert.ok(low.budgetMs > mid.budgetMs, 'the slow host must get more room than the mid one')
  assert.ok(mid.budgetMs > high.budgetMs, 'the fast host must get the tightest budget')
  // The intrinsic work is the same on all three; only the host's cost differs.
  for (const budget of [low, mid, high]) assert.equal(budget.intrinsicMs, 10_000)
})

test('the margin follows observed variance and stays bounded', () => {
  // A host whose p95 is 5x its p50 is a host whose timings move; the margin says so.
  const jittery = capability.computeDynamicBudget({
    intrinsicMs: 10_000,
    startupCount: 1,
    calibration: { nodeSpawnP50Ms: 100, nodeSpawnP95Ms: 500 },
    capacity: MID.capacity
  })
  const steady = capability.computeDynamicBudget({
    intrinsicMs: 10_000,
    startupCount: 1,
    calibration: { nodeSpawnP50Ms: 100, nodeSpawnP95Ms: 110 },
    capacity: MID.capacity
  })
  assert.ok(jittery.marginFraction > steady.marginFraction)
  // The requirement forbids inflating the budget until a test passes: the margin
  // is capped, so a pathological calibration cannot buy an unbounded allowance.
  assert.ok(jittery.marginFraction <= 0.75, `margin fraction was ${jittery.marginFraction}`)
})

test('a budget can never be smaller than the work it budgets for', () => {
  const tiny = capability.computeDynamicBudget({
    intrinsicMs: 5_000,
    startupCount: 0,
    calibration: { nodeSpawnP50Ms: 0, nodeSpawnP95Ms: 0 },
    capacity: HIGH.capacity
  })
  assert.ok(tiny.budgetMs >= 5_000)
})

test('a timeout scales additively with the per-start cost', () => {
  const low = capability.scaleTimeout({ baseMs: 120_000, calibration: LOW.calibration, capacity: LOW.capacity })
  const high = capability.scaleTimeout({ baseMs: 120_000, calibration: HIGH.calibration, capacity: HIGH.capacity })
  assert.ok(low.timeoutMs > high.timeoutMs)
  // The additive term is what the host actually pays to create a process; the
  // class factor is the headroom a small machine is given outright.
  assert.equal(high.startupAllowanceMs, HIGH.calibration.nodeSpawnP95Ms)
  assert.equal(high.classFactor, 1)
  assert.equal(low.classFactor, 2)
})

test('scaling a long timeout by spawn latency cannot produce an unbounded wait', () => {
  // A 1 s process-creation cost is under 1 % of a two-minute startup, so
  // multiplying the whole timeout by that ratio would be an unbounded wait.
  const pathological = capability.scaleTimeout({
    baseMs: 120_000,
    calibration: { nodeSpawnP50Ms: 5_000, nodeSpawnP95Ms: 9_000 },
    capacity: HIGH.capacity
  })
  assert.ok(pathological.timeoutMs <= 120_000 * 3 + 9_000 * 5, `timeout was ${pathological.timeoutMs}`)
  assert.ok(pathological.factor <= 3, `factor was ${pathological.factor}`)
  assert.ok(pathological.deadlockMs >= pathological.timeoutMs)
})

test('a timeout never shrinks below its base, and never below one millisecond', () => {
  const shrunk = capability.scaleTimeout({ baseMs: 1_000, calibration: { nodeSpawnP95Ms: 0 }, capacity: HIGH.capacity })
  assert.ok(shrunk.timeoutMs >= 1_000, 'a calibrated-fast host must not get less than the base')
  const zero = capability.scaleTimeout({ baseMs: 0, calibration: HIGH.calibration, capacity: HIGH.capacity })
  assert.ok(zero.timeoutMs >= 1)
})

test('a worker timeout uses the worker cold-start cost when it is known', () => {
  const withWorker = capability.scaleTimeout({ baseMs: 30_000, kind: 'worker', starts: 1, calibration: LOW.calibration, capacity: LOW.capacity })
  const withoutWorker = capability.scaleTimeout({ baseMs: 30_000, kind: 'startup', starts: 1, calibration: LOW.calibration, capacity: LOW.capacity })
  assert.ok(withWorker.perStartMs > withoutWorker.perStartMs, 'the larger, measured worker start must be used')
})

test('each budget in the profile stays bounded and ordered', () => {
  for (const host of [LOW, MID, HIGH]) {
    const b = host.budgets
    for (const key of Object.keys(b)) {
      assert.ok(b[key].timeoutMs > 0, `${key} on ${host.capacity.class} had no timeout`)
      // Bounded above: no budget may become an indefinite wait.
      assert.ok(b[key].timeoutMs <= 10 * 60 * 1000, `${key} on ${host.capacity.class} was ${b[key].timeoutMs}`)
    }
    assert.ok(b.harnessStartup.timeoutMs >= b.workerStartup.timeoutMs)
  }
})

test('the low-capacity fixture installs: its policy is conservative and its budgets are positive', () => {
  // This is the acceptance the requirement names for a small machine: the
  // classification is CONSERVATIVE/LOW_CAPACITY and *installation proceeds*.
  assert.ok(['LOW_CAPACITY', 'CONSERVATIVE'].includes(LOW.capacity.class))
  assert.equal(LOW.workers.aggressiveScaling, false)
  assert.ok(LOW.workers.recommended >= 1)
  assert.ok(LOW.budgets.harnessStartup.timeoutMs >= 120_000, 'a slow host must be allowed at least the base time')
  // Nothing about the profile is an error state.
  assert.equal(typeof LOW.capacity.class, 'string')
})

test('the high-capacity fixture is allowed to be more aggressive without breaking correctness', () => {
  assert.equal(HIGH.capacity.class, 'HIGH_CAPACITY')
  assert.equal(HIGH.workers.aggressiveScaling, true)
  assert.ok(HIGH.workers.recommended > LOW.workers.recommended)
  // A tighter expectation, but still a positive budget rather than zero.
  assert.ok(HIGH.budgets.harnessStartup.timeoutMs >= 120_000)
})

test('the profile carries no wall-clock pass/fail number of its own', () => {
  // The rule the timing-gate test also guards: a budget is *reported*. Nothing in
  // the capability module may name a fixed machine-independent threshold that an
  // installation could fail on.
  const fs = require('node:fs')
  const path = require('node:path')
  const text = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'runtime', 'host-capability.cjs'), 'utf8')
  assert.equal(/8500/.test(text), false, 'the capability policy carries a fixed threshold')
  assert.equal(/assert\./.test(text), false, 'the capability policy asserts a measurement')
})
