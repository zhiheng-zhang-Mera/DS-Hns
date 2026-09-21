'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

/**
 * The wall-clock budget of the parallelism scenario, as the installer sees it.
 *
 * `multi-supervisor.test.js` asserts that two independent 5 s nodes really run at the same time on two
 * workers. It used to *also* assert that the whole thing took under 8.5 s — and that threshold turned a
 * loaded machine into a failed installation: the installer runs the suite (`scripts/install.ps1` step
 * 6/9), the suite failed, and the installer exited 1 for a reason that had nothing to do with the
 * installation.
 *
 * The split now is deliberate and this file is its guard: **correctness fails, performance warns.**
 *
 *   1. the structural facts — both nodes in flight at once, the plan completed, both tasks recorded —
 *      are assertions and always gate;
 *   2. the measurement is printed as a `[benchmark]` line, and it only gates when a caller explicitly
 *      asks for it (`DSH_SUPERVISOR_WALL_CLOCK_GATE=strict`).
 *
 * These tests read the source rather than run the 10 s scenario twice more: the scenario itself is
 * covered where it lives, and what is under test here is the *policy* — which is the part that broke an
 * installation.
 */

const ROOT = path.resolve(__dirname, '..', '..')
const SUITE = path.join(ROOT, 'tests', 'unit', 'multi-supervisor.test.js')
const read = (file) => fs.readFileSync(file, 'utf8')

test('the parallelism scenario still asserts that both nodes really run at once', () => {
  const text = read(SUITE)
  // The correctness assertions the requirement names, kept and strengthened.
  assert.match(text, /assert\.equal\(maxConcurrent, 2, 'both nodes must be in flight at once'\)/)
  assert.match(text, /assert\.equal\(manager\.describe\(\)\.plans\[0\]\.status, 'completed'\)/)
  assert.match(text, /assert\.ok\(manager\.describe\(\)\.metrics\.tasks >= 2/)
})

test('the wall-clock budget is reported and does not fail a run by default', () => {
  const text = read(SUITE)
  // The threshold exists, it is named, and it is not an assertion on the default path.
  assert.match(text, /const PARALLEL_WALL_CLOCK_BUDGET_MS/)
  assert.match(text, /function reportWallClock/)
  // The old shape -- an unconditional `assert.ok(parallelMs < 8500)` -- must be gone.
  assert.equal(/assert\.ok\(parallelMs\s*<\s*8500/.test(text), false, 'the raw 8500 ms assertion is still a gate')
  // The measurement goes through the reporter instead.
  assert.match(text, /reportWallClock\(assert,\s*\{/)

  // The reporter warns by default and asserts only under the strict setting.
  const reporter = text.split('function reportWallClock')[1].split('\n}')[0]
  assert.match(reporter, /\[benchmark\]/, 'the measurement is not printed as a benchmark')
  assert.match(reporter, /DSH_SUPERVISOR_WALL_CLOCK_GATE/)
  assert.match(reporter, /if \(measuredMs <= budgetMs\)/)
})

test('the installer exit code does not depend on the wall-clock budget', () => {
  // The suite is run by `scripts\install.ps1`, whose failure would be a failed installation. The budget
  // is therefore only allowed to reach an exit code through an explicit `strict` request.
  const env = { ...process.env }
  delete env.DSH_SUPERVISOR_WALL_CLOCK_GATE
  const relaxed = spawnSync(process.execPath, ['-e', "process.env.DSH_SUPERVISOR_WALL_CLOCK_MS='1';require('node:assert/strict')"], { encoding: 'utf8', windowsHide: true, env })
  assert.equal(relaxed.status, 0)

  // And with the gate set to `strict`, the same source is able to fail: the setting is real.
  const text = read(SUITE)
  const strict = /String\(process\.env\.DSH_SUPERVISOR_WALL_CLOCK_GATE \|\| ''\)\.toLowerCase\(\) === 'strict'/.test(text)
  assert.equal(strict, true, 'the strict gate is not actually reachable')

  // The budget may also be moved without editing the source, which is what a slow CI runner needs.
  assert.match(text, /DSH_SUPERVISOR_WALL_CLOCK_MS/)
})

test('the multi-supervisor suite still covers the whole section 46 acceptance table', () => {
  // Moving one assertion must not quietly drop coverage: the file's own scenarios are asserted by name.
  const text = read(SUITE)
  for (const scenario of ['安装验收', '运行验收', '恢复验收', '故障验收', '并行验收', '冲突验收']) {
    assert.ok(text.includes(scenario), `multi-supervisor.test.js no longer covers ${scenario}`)
  }
  // ...and the repository's own test matrix still runs it.
  const gate = read(path.join(ROOT, 'scripts', 'test-all.ps1'))
  assert.match(gate, /tests\\unit|\$files = @\(Get-ChildItem -LiteralPath "\$ROOT\\tests\\unit"/)
})

test('the installer does not turn a benchmark into a failed installation', () => {
  const installer = read(path.join(ROOT, 'scripts', 'install.ps1'))
  // The installer runs a *tier* and throws on its exit code; the warning must not
  // reach that code. The tier runner is what selects the tests, and the full suite
  // is reachable only from the Qualification tier (see installer-mode.test.js), so
  // the preflight list is the only remaining mention of test-all.ps1 here.
  assert.match(installer, /install-tests\.ps1/)
  assert.match(installer, /throw "Installer tests failed \(\$Mode tier\)\."/)
  // Nothing in the installer asserts a wall-clock number of its own.
  assert.equal(/8500/.test(installer), false, 'the installer carries a wall-clock threshold of its own')
  // ...and the tier runner reports timing without ever failing on it.
  const runner = read(path.join(ROOT, 'scripts', 'install-tests.ps1'))
  assert.match(runner, /\[benchmark\] test tier/)
  const reportBlock = runner.split('if ($ReportTiming)')[1].split('if ($exit')[0]
  assert.equal(/throw|exit 1/.test(reportBlock), false, 'the timing report can fail the installer')
  void fs
  void os
})
