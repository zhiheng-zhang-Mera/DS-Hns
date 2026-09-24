'use strict'

/**
 * Installer modes: Fast, Standard, Qualification.
 *
 * The installer used to have exactly two settings — run the whole 147-file suite,
 * or skip it — and both the default and the "skip" were wrong for somebody. These
 * tests guard the three-way split, and they are written against the *policy in
 * the source* rather than by running each mode, because running a Qualification
 * install inside a unit test is the recursion that made the old installer slow in
 * the first place (`installer-optional-plugins.test.js` already re-invokes the real
 * installer a dozen times).
 *
 * What must stay true:
 *
 *   Fast          no test suite, no verification
 *   Standard      a small deterministic smoke set, never the full suite
 *   Qualification the full suite and the verifier
 *   -SkipTests    still works, in every mode
 *   -SkipVerify   skips verification, which used to be impossible
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..', '..')
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8')

const INSTALLER = 'scripts/install.ps1'
const TIER_RUNNER = 'scripts/install-tests.ps1'

test('the installer offers exactly the three modes', () => {
  const text = read(INSTALLER)
  assert.match(text, /\[ValidateSet\('Fast', 'Standard', 'Qualification'\)\]\s*\r?\n\s*\[string\]\$Mode = 'Standard'/)
})

test('an unknown mode is refused by the shell rather than downgraded', () => {
  const text = read(INSTALLER)
  // A ValidateSet is what makes "I asked for Qualification and got a smoke test"
  // impossible: PowerShell rejects the value before the installer runs.
  assert.match(text, /\[ValidateSet\('Fast', 'Standard', 'Qualification'\)\]/)
})

test('the installer never runs the full unit suite outside Qualification', () => {
  const text = read(INSTALLER)
  // The old path invoked test-all.ps1 from the test step. The only remaining
  // mention must be the step 0/9 parser preflight, which merely parses the file.
  const invocations = text.split('\n').filter((line) => /test-all\.ps1/.test(line) && /^\s*&|Start-Process|Invoke-/.test(line))
  assert.deepEqual(invocations, [], `the installer still invokes the full suite: ${invocations.join(' | ')}`)
  // It is still preflighted, because a syntax error there would otherwise be found
  // only by the tier that runs it.
  assert.match(text, /'test-all\.ps1'/)
  assert.match(text, /install-tests\.ps1/)
  assert.match(text, /'-Tier', \$Mode/)
})

test('the tier runner selects a smoke set for Fast and Standard, the full suite for Qualification', () => {
  const text = read(TIER_RUNNER)
  assert.match(text, /\$Tier -eq 'Qualification'/)
  assert.match(text, /Get-ChildItem -LiteralPath \$testsDir -File -Filter '\*\.test\.js'/)
  assert.match(text, /\$smokeSet = @\(/)
  // The smoke set must not be the whole suite: it is a fixed, named list.
  const smoke = text.split('$smokeSet = @(')[1].split(')')[0]
  const entries = smoke.split('\n').filter((line) => line.includes('.test.js'))
  assert.ok(entries.length > 0, 'the smoke set is empty')
  assert.ok(entries.length <= 12, `the smoke set has grown to ${entries.length} files and is no longer a smoke set`)
})

test('the smoke set is deterministic: no benchmark is allowed to gate it', () => {
  const text = read(TIER_RUNNER)
  const smoke = text.split('$smokeSet = @(')[1].split(')')[0]
  // A benchmark file in the smoke set would restore exactly the failure this
  // round removes: a slow machine failing an installation.
  assert.equal(/multi-supervisor\.test\.js/.test(smoke), false, 'a benchmark is in the installer smoke set')
  // The timing-gate test *is* in the set, and that is correct: it asserts the
  // policy that no wall-clock number gates an installation.
  assert.match(smoke, /installer-timing-gate\.test\.js/)
})

test('the tier runner reports timing without ever failing on it', () => {
  const text = read(TIER_RUNNER)
  assert.match(text, /\[benchmark\] test tier/)
  // The exit code comes from the test run, not from the elapsed time.
  assert.match(text, /if \(\$exit -ne 0\)/)
  const reportBlock = text.split('if ($ReportTiming)')[1].split('if ($exit')[0]
  assert.equal(/throw|exit 1/.test(reportBlock), false, 'the timing report can fail the installer')
})

test('Fast skips verification and Standard runs it', () => {
  const text = read(INSTALLER)
  assert.match(text, /\$SkipVerify -or \$Mode -eq 'Fast'/)
  assert.match(text, /verify\.ps1/)
})

test('-SkipTests still skips the whole test tier in every mode', () => {
  const text = read(INSTALLER)
  const block = text.split("if ($SkipTests) {")[1].split('Write-Step')[0]
  assert.match(block, /Tests skipped by -SkipTests/)
  // The skip must be checked before the mode is consulted, so it wins in all three.
  const skipIndex = text.indexOf('if ($SkipTests) {')
  const modeIndex = text.indexOf("$tierArgs = @(")
  assert.ok(skipIndex > 0 && modeIndex > skipIndex, 'the -SkipTests guard no longer precedes the tier selection')
})

test('-SkipVerify exists, because verification used to be impossible to skip', () => {
  const text = read(INSTALLER)
  assert.match(text, /\[switch\]\$SkipVerify/)
})

test('a missing tier runner is reported, never replaced by the legacy full suite', () => {
  const text = read(INSTALLER)
  const block = text.split('$tierScript = Join-Path $PSScriptRoot')[1].split('Write-Step')[0]
  assert.match(block, /throw "The installer test runner is missing/)
  assert.equal(/test-all\.ps1/.test(block), false, 'the fallback restores the full suite')
})

test('the completion summary names the mode', () => {
  const text = read(INSTALLER)
  assert.match(text, /Write-SummaryLine 'Mode' \$Mode/)
})

test('the install state records the decisions the modes rely on', () => {
  const text = read(INSTALLER)
  assert.match(text, /install-fingerprint\.cjs/)
  assert.match(text, /\$installState\.decisions\.dependencies\.reuse/)
  assert.match(text, /\$installState\.decisions\.profile\.reuse/)
  // And it is written only at the end, after every step succeeded.
  const writeIndex = text.indexOf("$fingerprintScript, 'write'")
  const completeIndex = text.indexOf("Write-Step '9/9 Complete'")
  assert.ok(writeIndex > completeIndex, 'the state must be written after the install is complete, not before')
})

test('Fast and Standard report performance without gating on it', () => {
  const text = read(INSTALLER)
  // The host capability block prints and caches; it must not throw on a slow host.
  const block = text.split('if ($hostProfile) {')[1].split("Write-Step '3/9")[0]
  assert.equal(/throw/.test(block), false, 'the host capability report can fail an installation')
  assert.match(text, /this host is treated as conservative/)
})

test('the installer still carries no wall-clock threshold of its own', () => {
  const text = read(INSTALLER)
  assert.equal(/8500/.test(text), false, 'the installer grew a wall-clock threshold')
})

test('the host capability calibration is not a static machine table', () => {
  const capability = read('app/runtime/host-capability.cjs')
  // The requirement forbids deriving a machine class from a CPU model list.
  assert.equal(/i7-|Ryzen|Xeon|EPYC/.test(capability), false, 'a CPU model table appeared in the capability policy')
  assert.match(capability, /measureNodeSpawn/)
  assert.match(capability, /nodeSpawnP95Ms/)
})
