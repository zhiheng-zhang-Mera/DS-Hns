'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { planFor, verify } = require('../../app/extensions/mega/autonomy/result-validator')

test('model-done-only claims enter VERIFYING and never PASS', () => {
  const verdict = verify({ kind: 'official-session', risk: 'high', modelDoneOnly: true })
  assert.equal(verdict.phase, 'VERIFYING')
  assert.equal(verdict.verdict, 'REWORK')
  assert.ok(verdict.missing.includes('artifacts'))
})

test('headless completion needs exit + log + artifact evidence', () => {
  const verdict = verify({
    kind: 'headless',
    risk: 'high',
    results: [
      { gate: 'exit-ok', evidence: 'exit code 0' },
      { gate: 'log-nonempty', evidence: 'log has output' },
      { gate: 'artifacts', error: 'no artifacts directory' }
    ]
  })
  assert.equal(verdict.verdict, 'REWORK')
  assert.deepEqual(verdict.missing, ['artifacts'])
})

test('all planned gates with evidence -> PASS', () => {
  const verdict = verify({
    kind: 'official-session',
    risk: 'high',
    results: [
      { gate: 'artifacts', evidence: 'task dir populated' },
      { gate: 'blank-false', evidence: 'session/list blank=false' },
      { gate: 'seen-running', evidence: 'session was observed running' }
    ]
  })
  assert.equal(verdict.verdict, 'PASS')
  assert.equal(verdict.phase, 'PASS')
  assert.deepEqual(verdict.missing, [])
})

test('low-risk plans stay cheap; high/critical use the full delivery gate set', () => {
  assert.deepEqual(planFor('headless', 'low'), ['exit-ok'])
  assert.deepEqual(planFor('headless', 'high'), ['exit-ok', 'log-nonempty', 'artifacts'])
  assert.deepEqual(planFor('official-session', 'critical'), ['artifacts', 'blank-false', 'seen-running'])
})
