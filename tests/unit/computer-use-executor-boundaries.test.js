'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createComputerUseRuntime } = require('../../app/computer-use/index.cjs')
const { createVirtualClock } = require('../helpers/computer-use-clock.cjs')

/**
 * The work the executor is not allowed to do (Update-Plan/cleaning-refactor.md
 * phases G, H, I and §29's "no fixed sleep" rule).
 *
 * A module that passes its own test proves the module; it does not prove the
 * runtime uses it instead of a second copy. These are structural assertions over
 * the shipped executor and an assembled runtime: the policies live in their
 * modules, one pipeline carries every action, controllers stay independent, no
 * fixed sleep was reintroduced, and no one-time plan citation is left in the
 * production source to explain the code.
 */
const ROOT = path.resolve(__dirname, '..', '..')
const CU = path.join(ROOT, 'app', 'computer-use')
const executor = fs.readFileSync(path.join(CU, 'executor.cjs'), 'utf8')
const read = (file) => fs.readFileSync(path.join(CU, file), 'utf8')

test('the executor delegates each policy to the module that owns it (phase G)', () => {
  const delegated = {
    'focus.cjs': ['focus trust'],
    'modal.cjs': ['the modal classification and choice'],
    'evidence.cjs': ['evidence strength'],
    'progress.cjs': ['progress semantics'],
    'processes.cjs': ['process registration'],
    'resources.cjs': ['the resource budget'],
    'health.cjs': ['the health snapshot'],
    'workspace.cjs': ['the workspace gate'],
    'command.cjs': ['the bounded command contract'],
    'reconnect.cjs': ['the reconnect policy and channel recovery'],
    'mutation.cjs': ['filesystem mutation verification'],
    'stabilization.cjs': ['the cooldown math and the post-action wait'],
    'stall.cjs': ['the stall ladder'],
    'recovery.cjs': ['the recovery ladder']
  }
  for (const [file] of Object.entries(delegated)) {
    const moduleName = file.replace('.cjs', '')
    assert.match(executor, new RegExp(`require\\('\\./${moduleName}\\.cjs'\\)`), `the executor must use ${file}`)
  }
  // None of the policy tables or algorithms may exist a second time here. The
  // *names* may appear as an import or a property of the module that owns them;
  // a definition may not.
  const forbiddenDefinitions = [
    /const\s+DESTRUCTIVE_LABELS\s*=/,
    /const\s+SAFE_DISMISS_LABELS\s*=/,
    /function\s+classifyControl\s*\(/,
    /function\s+classifyModal\s*\(/,
    /function\s+dynamicCooldown\s*\(/,
    /const\s+STALL_RECOVERY_LADDER\s*=/,
    /const\s+HEALTH_STATUS\s*=/,
    /const\s+BLOCK_REASONS\s*=/,
    /const\s+RESUME_VERDICT\s*=/,
    /const\s+COMMAND_DEFAULTS\s*=/,
    /const\s+TRANSPORT_CODES\s*=/,
    /const\s+CAPABILITY_CONTROLLER\s*=/,
    /const\s+MODAL_KINDS\s*=/,
    /const\s+PROGRESS_KINDS\s*=/,
    /const\s+RECOVERY_VERDICTS\s*=/
  ]
  for (const pattern of forbiddenDefinitions) {
    assert.equal(pattern.test(executor), false, `executor.cjs must not define its own copy of ${pattern}`)
  }
  // The stall ladder is *walked* from the module that defines it.
  assert.match(executor, /STALL_RECOVERY_LADDER\.forEach|STALL_RECOVERY_LADDER\.map|for \(const rung of STALL_RECOVERY_LADDER\)/, 'the executor must walk the ladder stall.cjs defines')
  // The modal decision comes from the module, not from a local heuristic: no
  // position-based fallback may survive anywhere in the runtime.
  for (const file of fs.readdirSync(CU).filter((name) => name.endsWith('.cjs'))) {
    const source = read(file)
    for (const pattern of [/controls\[0\]\.ref\s*\|\|/, /first\s+enabled\s+button/i, /default\s+button/i, /button\[0\]/]) {
      assert.equal(pattern.test(source), false, `${file} must not fall back to a positional control choice`)
    }
  }
})

test('one pipeline carries every action, with no capability bypass (phase H)', () => {
  // Every action reaches the machine through `performAction` -> the routed
  // controller; a capability may not call a controller directly from the step
  // body or from recovery.
  const directCalls = executor.match(/controllers\.\w+\.perform\(/g) || []
  assert.equal(directCalls.length, 0, `the executor must route actions, not call controllers directly (${directCalls.join(', ')})`)
  assert.match(executor, /function performAction\(/, 'there is exactly one acting path')
  assert.equal((executor.match(/function performAction\(/g) || []).length, 1, 'there must be exactly one acting path')
  // Recovery re-issues through the same step loop rather than acting itself.
  assert.match(executor, /run\.pendingAction = /, 'recovery resumes through the step loop')
  // The pipeline order is the documented one, and it is a single function body.
  const order = ['STABILIZING', 'REVALIDATING', 'ACTING', 'POST_ACTION_GRACE', 'VERIFYING']
  let cursor = -1
  for (const state of order) {
    const at = executor.indexOf(`CU_STATES.${state}, { step: stepNumber }`)
    assert.ok(at > cursor, `the step must enter ${state} after the previous state`)
    cursor = at
  }
})

test('controllers stay independent of each other and of the runtime (phase I)', () => {
  const controllers = fs.readdirSync(path.join(CU, 'controllers'))
  for (const file of controllers) {
    const source = read(path.join('controllers', file))
    assert.equal(/require\('\.\/\w+\.cjs'\)/.test(source), false, `${file} must not import a sibling controller`)
    assert.equal(/require\('\.\.\/index\.cjs'\)/.test(source), false, `${file} must not import the runtime`)
    // A controller returns a receipt; it does not decide the step's success and
    // does not own recovery policy. (A comment may *mention* recovery — the vision
    // controller explains that its escalation level rises during one.)
    assert.equal(/RECOVERY_VERDICTS|createRecoveryController|USER_ACTION_REQUIRED|recovery\.cjs/.test(source), false, `${file} must not own recovery policy`)
  }
})

test('no fixed sleep was reintroduced into the runtime (phase F/§29)', () => {
  // A literal sleep is the failure mode the whole timing model exists to prevent,
  // so the *only* places a numeric delay may appear are the modules whose job is
  // to bound one. Anything else has to come from the constants.
  const allowed = new Set(['constants.cjs', 'stabilization.cjs', 'reconnect.cjs', 'controllers/shell.cjs', 'drivers/cdp-page.cjs', 'drivers/win32.cjs', 'controllers/desktop.cjs'])
  for (const file of fs.readdirSync(CU).filter((name) => name.endsWith('.cjs'))) {
    if (allowed.has(file)) continue
    const source = read(file)
    const literalSleeps = source.match(/sleep\(\s*\d+\s*\)/g) || []
    assert.deepEqual(literalSleeps, [], `${file} must not sleep a literal duration (${literalSleeps.join(', ')})`)
    const literalTimeouts = source.match(/setTimeout\([^,]+,\s*\d{3,}\s*\)/g) || []
    assert.deepEqual(literalTimeouts, [], `${file} must not hold a literal long timer (${literalTimeouts.join(', ')})`)
  }
  // And the runtime's own post-action wait is bounded by the action, not by a
  // magic number in the step body.
  assert.match(executor, /stabilizer\.grace\(action, graceBudgetFor\(action\)\)/)
})

test('no production source needs a plan document to be understood (phase 29)', () => {
  const sources = []
  const walk = (dir, prefix = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name), `${prefix}${entry.name}/`)
      else if (entry.name.endsWith('.cjs')) sources.push([`${prefix}${entry.name}`, fs.readFileSync(path.join(dir, entry.name), 'utf8')])
    }
  }
  walk(CU)
  for (const [name, source] of sources) {
    assert.equal(/(plan\s*§|24h\.md|Update-Plan|Tasks?\s*\d)/.test(source), false, `${name} must not cite a one-time plan`)
  }
})

test('the runtime assembles one pipeline end to end with no host', async () => {
  // The strongest wiring statement available without hardware: a runtime built
  // from nothing still runs a contract through the whole chain and reports it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-pipeline-'))
  const clock = createVirtualClock()
  const runtime = createComputerUseRuntime({
    host: {},
    clock,
    log: { dir: null },
    options: { workspace: dir, maxSteps: 4 }
  })
  try {
    const report = await runtime.run({
      goal: 'write one file through the pipeline',
      plan: [{ id: 'write', action: { type: 'FILE_WRITE', path: path.join(dir, 'pipeline.txt'), content: 'through the pipeline', expected_effect: { any: [{ file_exists: path.join(dir, 'pipeline.txt') }] } } }],
      limits: { max_steps: 4, max_retries_per_action: 0 }
    })
    assert.equal(report.status, 'completed', JSON.stringify(report.error))
    assert.equal(fs.readFileSync(path.join(dir, 'pipeline.txt'), 'utf8'), 'through the pipeline')
    assert.equal(report.outcomes.length, 1)
    assert.equal(report.outcomes[0].verification, 'success')
    // The chain is visible in the state list, in order.
    const states = report.states.filter(Boolean)
    for (const state of ['STABILIZING', 'REVALIDATING', 'ACTING', 'POST_ACTION_GRACE', 'VERIFYING']) {
      assert.ok(states.includes(state), `the run must pass through ${state} (${states.join(' -> ')})`)
    }
  } finally {
    runtime.dispose('test teardown')
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
