'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..', '..')
const TEST_ROOT = process.env.DSH_TEST_ROOT || path.join(ROOT, 'test-artifacts')
const { parseJsonText, reportPassed, validateQualification } = require('../../scripts/evidence-consistency.cjs')

test('JSON evidence accepts the UTF-8 BOM emitted by Windows PowerShell 5', () => {
  assert.deepEqual(parseJsonText(`\uFEFF${JSON.stringify({ passed: true })}`), { passed: true })
})

test('acceptance reports that use ok instead of passed retain their verdict', () => {
  assert.equal(reportPassed({ ok: false, checks: 1, failures: 1 }), false)
  assert.equal(reportPassed({ ok: true, checks: 1, failures: 0 }), true)
})

function fixture() {
  fs.mkdirSync(TEST_ROOT, { recursive: true })
  const dir = fs.mkdtempSync(path.join(TEST_ROOT, 'evidence-consistency-'))
  const report = path.join(dir, 'child.json')
  fs.writeFileSync(report, JSON.stringify({ passed: true, checks: 3, failures: 0 }))
  const sha = 'a'.repeat(40)
  const tree = 'b'.repeat(40)
  const result = {
    id: 'child', runId: 'run-1', gitSha: sha, gitTree: tree, mandatory: true,
    startedAt: '2026-09-22T00:00:01.000Z', completedAt: '2026-09-22T00:00:02.000Z',
    exitCode: 0, passed: true, checks: 3, failures: 0, report
  }
  const summary = {
    runId: 'run-1', gitSha: sha, gitTree: tree, branch: 'dev/test',
    startedAt: '2026-09-22T00:00:00.000Z', completedAt: '2026-09-22T00:00:03.000Z',
    results: [result], mandatoryFailures: 0, passed: true
  }
  return { dir, report, result, summary }
}

test('one run with matching identity, timestamps, exit status and totals passes', () => {
  const f = fixture()
  try { assert.deepEqual(validateQualification(f.summary, { runDir: f.dir }), { ok: true, code: 'PASS', errors: [] }) }
  finally { fs.rmSync(f.dir, { recursive: true, force: true }) }
})

test('mixed run identity and stale external reports fail closed', () => {
  const f = fixture()
  try {
    f.result.runId = 'older-run'
    f.result.report = path.join(path.dirname(f.dir), 'stale.json')
    const checked = validateQualification(f.summary, { runDir: f.dir })
    assert.equal(checked.code, 'QUALIFICATION_EVIDENCE_INCONSISTENT')
    assert.ok(checked.errors.some((entry) => /runId mismatch/.test(entry)))
    assert.ok(checked.errors.some((entry) => /outside the immutable run directory/.test(entry)))
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }) }
})

test('the historical passed true plus exitCode 2 contradiction is rejected', () => {
  const f = fixture()
  try {
    f.result.exitCode = 2
    f.summary.mandatoryFailures = 1
    f.summary.passed = false
    const checked = validateQualification(f.summary, { runDir: f.dir })
    assert.equal(checked.ok, false)
    assert.ok(checked.errors.some((entry) => /passed contradicts exitCode/.test(entry)))
    assert.ok(checked.errors.some((entry) => /child report passed state contradicts exitCode/.test(entry)))
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }) }
})

test('top-level totals cannot disagree with mandatory children', () => {
  const f = fixture()
  try {
    f.result.exitCode = 1
    f.result.passed = false
    const checked = validateQualification(f.summary, { runDir: f.dir })
    assert.ok(checked.errors.some((entry) => /mandatory failure count mismatch/.test(entry)))
    assert.ok(checked.errors.some((entry) => /top-level passed state/.test(entry)))
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }) }
})
