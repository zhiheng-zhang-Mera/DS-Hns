'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

/**
 * The long-running acceptance harness is itself part of the shipped surface
 * (Update-Plan/24h.md §23-§26), so it gets the same treatment as the modules it
 * exercises: it must exist, it must be gated by the syntax gate, and it must
 * actually pass when it runs. A harness that is only referenced from a document
 * is a claim nobody checks.
 */
const ROOT = path.resolve(__dirname, '..', '..')
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8')
const exists = (relative) => fs.existsSync(path.join(ROOT, relative))

const HARNESS = 'scripts/computer-use-longrun-acceptance.cjs'

test('the long-running acceptance harness ships and is syntax-gated (plan 23-26)', () => {
  assert.equal(exists(HARNESS), true, `${HARNESS} is missing`)
  assert.ok(fs.statSync(path.join(ROOT, HARNESS)).size > 0, `${HARNESS} is empty`)
  const check = read('scripts/check-syntax.cjs')
  assert.ok(check.includes('computer-use-longrun-acceptance.cjs'), 'the syntax gate does not cover the long-running harness')
})

test('the harness names every injected failure and every documented scenario', () => {
  const harness = read(HARNESS)
  // Plan 24: the twelve failures that must each end in recover / degrade /
  // block / fail-with-evidence.
  for (const id of [
    'cdp-disconnect',
    'window-closes',
    'target-moves',
    'target-disappears',
    'ui-freezes',
    'modal-appears',
    'shell-timeout',
    'child-crash',
    'file-locked',
    'workspace-inaccessible',
    'vision-unavailable',
    'verification-unknown'
  ]) {
    assert.ok(harness.includes(`id: '${id}'`), `the harness does not inject ${id}`)
  }
  // Plan 25: scenarios A-G.
  assert.match(harness, /for \(const id of \['A', 'B', 'C', 'D', 'E', 'F', 'G'\]\)/)
  assert.match(harness, /Update-Plan\/24h\.md §23-§26/)
})

test('the soak asserts the long-run invariants rather than only running steps', () => {
  const harness = read(HARNESS)
  for (const [name, pattern] of [
    ['bounded rings', /stayed bounded/],
    ['no process leakage', /no owned process leaked/],
    ['screenshot retention', /transient captures were dropped rather than accumulated/],
    ['focus trust', /focus trust was cleared/],
    ['retry bound', /retries stayed proportional/],
    ['log growth bound', /byte ceiling/]
  ]) {
    assert.match(harness, pattern, `the soak does not assert ${name}`)
  }
})

test('the harness really passes when it runs (accelerated, bounded)', () => {
  const result = spawnSync(process.execPath, [path.join(ROOT, HARNESS), '--cycles', '220', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 180000,
    windowsHide: true
  })
  assert.equal(result.error, undefined, result.error ? String(result.error) : 'the harness could not be started')
  let report = null
  try {
    report = JSON.parse(result.stdout)
  } catch (error) {
    assert.fail(`the harness did not print a JSON report: ${String(result.stdout).slice(-2000)}\n${String(result.stderr).slice(-2000)}`)
  }
  assert.equal(report.failures, 0, `the acceptance harness reported failures: ${JSON.stringify(report.cases.filter((entry) => entry.status !== 'passed'), null, 2)}`)
  assert.ok(report.checks >= 90, `the harness only ran ${report.checks} checks`)
  assert.equal(result.status, 0, `the harness exited ${result.status}`)
})
