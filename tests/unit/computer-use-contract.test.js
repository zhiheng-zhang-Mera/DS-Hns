'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')

const { createContract, hasCapability, assertCapability, describeContract } = require('../../app/computer-use/contract.cjs')
const { normalizeAction, describeAction, destructiveKinds } = require('../../app/computer-use/action.cjs')
const { normalizeTarget, describeTarget, resolveTarget, revalidate, distance } = require('../../app/computer-use/target.cjs')
const { evaluateCriteria, normalizeCriteria } = require('../../app/computer-use/criteria.cjs')
const { ACTION_TYPES, CONTRACT_DEFAULTS, DESTRUCTIVE_MODES } = require('../../app/computer-use/constants.cjs')
const { CODES, ComputerUseError } = require('../../app/computer-use/errors.cjs')

/**
 * Phase 1 — the contract and action schema (plan §6, §7, §16, §35, §36).
 * These tests are the contract of the contract: everything the rest of the
 * runtime assumes about an action or an execution contract is checked here.
 */

test('an execution contract keeps the documented shape and defaults', () => {
  const contract = createContract({ goal: 'open the release page' })
  assert.equal(contract.goal, 'open the release page')
  assert.deepEqual(contract.allowedCapabilities, ['browser', 'desktop', 'shell', 'filesystem', 'vision'])
  assert.equal(contract.limits.maxSteps, CONTRACT_DEFAULTS.maxSteps)
  assert.equal(contract.limits.maxRetriesPerAction, CONTRACT_DEFAULTS.maxRetriesPerAction)
  assert.equal(contract.safety.destructiveActions, DESTRUCTIVE_MODES.CONFIRM)
  assert.equal(contract.autonomyEnabled, false)
  assert.deepEqual(contract.plan, [])
  assert.deepEqual(contract.successCriteria, [])
})

test('a contract without a goal is refused, not defaulted', () => {
  assert.throws(() => createContract({}), (error) => error.code === CODES.CONTRACT_GOAL_MISSING)
  assert.throws(() => createContract({ goal: '   ' }), (error) => error.code === CODES.CONTRACT_GOAL_MISSING)
})

test('unknown capabilities and invalid safety modes are rejected instead of widened', () => {
  assert.throws(() => createContract({ goal: 'x', allowed_capabilities: ['browser', 'telepathy'] }), (error) => error.code === CODES.CONTRACT_INVALID)
  assert.throws(() => createContract({ goal: 'x', safety: { destructive_actions: 'maybe' } }), (error) => error.code === CODES.CONTRACT_INVALID)
  const contract = createContract({ goal: 'x', allowed_capabilities: ['shell'], safety: { destructive_actions: 'forbidden' } })
  assert.equal(hasCapability(contract, 'browser'), false)
  assert.equal(contract.safety.destructiveActions, 'forbidden')
  assert.throws(() => assertCapability(contract, 'browser'), (error) => error.code === CODES.CAPABILITY_NOT_ALLOWED)
})

test('the plan is normalized into validated actions per step', () => {
  const contract = createContract({
    goal: 'fill the form',
    plan: [
      { id: 'type', action: { type: 'DOM_TYPE', target: '#username', text: 'alice' } },
      { action: { type: 'SHELL_EXEC', command: 'node', args: ['--version'] }, optional: true },
      'BROWSER_REFRESH'
    ]
  })
  assert.equal(contract.plan.length, 3)
  assert.equal(contract.plan[0].id, 'type')
  assert.equal(contract.plan[0].actions[0].type, ACTION_TYPES.DOM_TYPE)
  assert.equal(contract.plan[1].optional, true)
  assert.equal(contract.plan[2].actions[0].type, ACTION_TYPES.BROWSER_REFRESH)
  assert.match(contract.plan[0].actions[0].target.selector, /#username/)
})

test('an invalid plan action fails the contract instead of failing mid-run', () => {
  assert.throws(
    () => createContract({ goal: 'x', plan: [{ action: { type: 'DOM_TYPE' } }] }),
    (error) => error.code === CODES.PLAN_INVALID && /DOM_TYPE/.test(error.message)
  )
})

test('the action schema carries precondition, stabilization, effect, timeout and retry', () => {
  const action = normalizeAction({
    type: 'CLICK',
    target: { accessibility: { role: 'button', name: 'Save' } },
    precondition: { target_exists: true, target_enabled: true },
    stabilization: { minimum_ms: 100 },
    expected_effect: { any: [{ toast: 'Saved' }, { file_modified: true }] },
    timeout_ms: 3000,
    retry: { max_attempts: 2 }
  })
  assert.equal(action.type, 'CLICK')
  assert.equal(action.capability, 'desktop')
  assert.equal(action.precondition.targetExists, true)
  assert.equal(action.precondition.targetEnabled, true)
  assert.equal(action.stabilization.minimumMs, 100)
  assert.equal(action.timeoutMs, 3000)
  assert.equal(action.retry.maxAttempts, 2)
  assert.equal(action.expectedEffect.any.length, 2)
  assert.equal(action.expectedEffect.mode, 'any')
})

test('the stabilization window is clamped into the documented band, so no action can order a sleep', () => {
  const slow = normalizeAction({ type: 'BROWSER_REFRESH', stabilization: { minimum_ms: 5000 } })
  assert.equal(slow.stabilization.minimumMs, 300)
  const negative = normalizeAction({ type: 'BROWSER_REFRESH', stabilization: { minimum_ms: -20 } })
  assert.equal(negative.stabilization.minimumMs, 0)
  assert.throws(
    () => normalizeAction({ type: 'BROWSER_REFRESH', stabilization: { minimum_ms: 200, maximum_ms: 100 } }),
    (error) => error.code === CODES.ACTION_INVALID
  )
})

test('actions without their required parameter are rejected at build time', () => {
  assert.throws(() => normalizeAction({ type: 'TYPE' }), (error) => error.code === CODES.ACTION_INVALID)
  assert.throws(() => normalizeAction({ type: 'HOTKEY', keys: [] }), (error) => error.code === CODES.ACTION_INVALID)
  assert.throws(() => normalizeAction({ type: 'CLICK' }), (error) => error.code === CODES.ACTION_INVALID)
  assert.throws(() => normalizeAction({ type: 'NOT_A_REAL_ACTION' }), (error) => error.code === CODES.ACTION_INVALID)
  assert.throws(() => normalizeAction({ type: 'SHELL_EXEC' }), (error) => error.code === CODES.ACTION_INVALID)
})

test('a sensitive action never prints its payload', () => {
  const action = normalizeAction({ type: 'TYPE', text: 'hunter2', sensitive: true })
  const description = describeAction(action)
  assert.equal(description.includes('hunter2'), false)
  assert.match(description, /\[redacted\]/)
  const visible = describeAction(normalizeAction({ type: 'TYPE', text: 'hello' }))
  assert.match(visible, /hello/)
})

test('destructive commands are classified so the gate can judge them (plan §34)', () => {
  const action = normalizeAction({ type: 'SHELL_EXEC', command: 'Remove-Item -Recurse -Force D:\\tmp\\x' })
  assert.deepEqual(destructiveKinds(action), ['DELETE'])
  assert.deepEqual(destructiveKinds(normalizeAction({ type: 'SHELL_EXEC', command: 'git push origin main' })), ['PUBLISH'])
  assert.deepEqual(destructiveKinds(normalizeAction({ type: 'SHELL_EXEC', command: 'npm install left-pad' })), ['INSTALL'])
  assert.deepEqual(destructiveKinds(normalizeAction({ type: 'SHELL_EXEC', command: 'node --version' })), [])
})

test('the target ladder prefers structured identifiers over coordinates', () => {
  const target = normalizeTarget({ selector: '#save', accessibility: { role: 'button', name: 'Save' }, point: { x: 800, y: 420 } })
  assert.deepEqual(target.kinds, ['selector', 'accessibility', 'point'])
  assert.equal(target.rank, 1)
  assert.equal(target.primaryKind, 'selector')
  assert.equal(normalizeTarget('#save').primaryKind, 'selector')
  assert.equal(normalizeTarget('Save').primaryKind, 'semantic')
  assert.equal(normalizeTarget({ point: { x: 1, y: 2 } }).primaryKind, 'point')
  assert.match(describeTarget(normalizeTarget({ point: { x: 800, y: 420 } })), /point:800,420/)
})

test('a target that carries no identifier is refused', () => {
  assert.throws(() => normalizeTarget({}), (error) => error.code === CODES.TARGET_INVALID)
  assert.throws(() => normalizeTarget({ bbox: { x: 0, y: 0, width: 0, height: 10 } }), (error) => error.code === CODES.TARGET_INVALID)
  assert.throws(() => normalizeTarget('   '), (error) => error.code === CODES.TARGET_INVALID)
})

test('target resolution walks the ladder and reports what it tried', () => {
  const world = {
    controls: [
      { ref: 'a', role: 'textbox', name: 'username', selector: '#username', bbox: { x: 10, y: 10, width: 100, height: 20 }, disabled: false, visible: true },
      { ref: 'b', role: 'button', name: 'Save', selector: '#save', bbox: { x: 10, y: 40, width: 80, height: 20 }, disabled: false, visible: true }
    ]
  }
  const bySelector = resolveTarget(normalizeTarget('#save'), world)
  assert.equal(bySelector.ok, true)
  assert.equal(bySelector.kind, 'selector')
  assert.equal(bySelector.resolved.ref, 'b')
  assert.equal(bySelector.resolved.point.x, 50)

  const bySemantic = resolveTarget(normalizeTarget('Save'), world)
  assert.equal(bySemantic.ok, true)
  assert.equal(bySemantic.resolved.ref, 'b')

  const missing = resolveTarget(normalizeTarget('#nope'), world)
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, CODES.TARGET_NOT_FOUND)
  assert.ok(missing.attempts.length >= 1)
})

test('a resolver that throws degrades the ladder instead of failing it', () => {
  const world = { controls: [{ ref: 'b', role: 'button', name: 'Save', bbox: { x: 10, y: 40, width: 80, height: 20 } }] }
  const result = resolveTarget(normalizeTarget({ selector: '#save', accessibility: { role: 'button', name: 'Save' } }), world, {
    selector: () => {
      throw new ComputerUseError(CODES.CONTROLLER_UNAVAILABLE, 'the browser controller is down')
    }
  })
  assert.equal(result.ok, true)
  assert.equal(result.kind, 'accessibility')
  assert.equal(result.attempts[0].ok, false)
  assert.equal(result.attempts[0].reason, CODES.CONTROLLER_UNAVAILABLE)
})

test('revalidation applies the documented 3 px / 10 px thresholds (plan §10)', () => {
  const previous = { ref: 'a', bbox: { x: 800, y: 420, width: 20, height: 20 }, point: { x: 810, y: 430 } }
  const stable = revalidate(previous, { ref: 'a', bbox: { x: 801, y: 421, width: 20, height: 20 }, point: { x: 811, y: 431 } })
  assert.equal(stable.verdict, 'stable')
  assert.ok(stable.movement < 3)

  const updated = revalidate(previous, { ref: 'a', bbox: { x: 806, y: 420, width: 20, height: 20 }, point: { x: 816, y: 430 } })
  assert.equal(updated.verdict, 'updated')
  assert.ok(updated.movement >= 3 && updated.movement <= 10)

  const stale = revalidate(previous, { ref: 'a', bbox: { x: 850, y: 480, width: 20, height: 20 }, point: { x: 860, y: 490 } })
  assert.equal(stale.verdict, 'stale')
  assert.ok(stale.movement > 10)

  assert.equal(revalidate(previous, null).verdict, 'missing')
  assert.equal(revalidate(null, previous).verdict, 'unknown')
})

test('revalidation thresholds are configurable', () => {
  const previous = { ref: 'a', point: { x: 0, y: 0 } }
  const current = { ref: 'a', point: { x: 6, y: 0 } }
  assert.equal(revalidate(previous, current).verdict, 'updated')
  assert.equal(revalidate(previous, current, { stablePx: 8, updatePx: 20 }).verdict, 'stable')
  assert.equal(distance({ x: 0, y: 0 }, { x: 3, y: 4 }), 5)
})

test('success criteria are evaluated against real facts, and unknown stays unknown (plan §36)', async () => {
  const facts = {
    fileExists: async (path) => path === 'out.txt',
    lastShell: { exited: true, exitCode: 0, stdout: 'built ok', stderr: '' },
    world: { url: 'https://example.test/done' },
    domText: async (selector) => (selector === '#status' ? 'Saved' : ''),
    eventObserved: async (name) => name === 'saved'
  }
  const satisfied = await evaluateCriteria(normalizeCriteria([
    { kind: 'file_exists', path: 'out.txt' },
    { kind: 'exit_code', value: 0 },
    { kind: 'stdout_matches', pattern: 'ok' },
    { kind: 'url_matches', pattern: 'example\\.test/done' },
    { kind: 'dom_text', selector: '#status', text: 'Saved' },
    { kind: 'event', name: 'saved' }
  ]), facts)
  assert.equal(satisfied.satisfied, true)
  assert.equal(satisfied.unknown, false)
  assert.equal(satisfied.results.length, 6)

  const unsatisfied = await evaluateCriteria(normalizeCriteria([{ kind: 'file_exists', path: 'missing.txt' }]), facts)
  assert.equal(unsatisfied.satisfied, false)
  assert.equal(unsatisfied.unknown, false)

  // A criterion nobody can check must not be rounded up to "true".
  const unknown = await evaluateCriteria(normalizeCriteria([{ kind: 'visual_change' }]), facts)
  assert.equal(unknown.satisfied, false)
  assert.equal(unknown.unknown, true)
  assert.equal(unknown.results[0].verdict, 'unknown')
})

test('all/any criteria nest and negate', async () => {
  const facts = { fileExists: async (path) => path === 'a.txt' }
  const all = await evaluateCriteria(normalizeCriteria([{ kind: 'all', criteria: [{ kind: 'file_exists', path: 'a.txt' }, { kind: 'file_missing', path: 'b.txt' }] }]), facts)
  assert.equal(all.satisfied, true)
  const any = await evaluateCriteria(normalizeCriteria([{ kind: 'any', criteria: [{ kind: 'file_exists', path: 'nope.txt' }, { kind: 'file_exists', path: 'a.txt' }] }]), facts)
  assert.equal(any.satisfied, true)
  const negated = await evaluateCriteria(normalizeCriteria([{ kind: 'file_exists', path: 'a.txt', negate: true }]), facts)
  assert.equal(negated.satisfied, false)
})

test('describeContract summarizes without leaking the plan payload', () => {
  const contract = createContract({
    goal: 'publish the release',
    success_criteria: [{ kind: 'url_matches', pattern: '/releases' }],
    plan: [{ action: { type: 'BROWSER_NAVIGATE', url: 'https://example.test' } }]
  })
  const summary = describeContract(contract)
  assert.equal(summary.goal, 'publish the release')
  assert.equal(summary.steps, 1)
  assert.deepEqual(summary.criteria, ['url matches /releases'])
  assert.equal(JSON.stringify(summary).includes('https://example.test'), false)
})
