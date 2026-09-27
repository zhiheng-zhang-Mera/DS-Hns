'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..', '..')
const CHAOS = path.join(ROOT, 'scripts', 'longhost-chaos.cjs')
const REGISTRATION = path.join(ROOT, 'scripts', 'plugin-registration-check.cjs')
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8')

const { SCENARIOS, chaosPluginCrash, chaosPluginTimeout, chaosFalseSuccess, chaosHostRestart, chaosNetworkFailure } = require(CHAOS)

/**
 * The chaos harness and the installer's registration probe.
 *
 * The harness itself is the acceptance evidence for long-term unattended hosting (it kills a real
 * supervised process and watches the real companion bring it back), and a harness nobody runs is a
 * document. This suite therefore does three things: it asserts the harness is *wired* (named in the
 * gates, listing the scenarios the requirement names), it runs the cheap half of it on every
 * `node --test`, and it drives the registration probe the installer now ends with.
 *
 * `kill-core` and `controlled-restart` are deliberately **not** in this suite: they spawn a real
 * companion and a real child process and take tens of seconds, so they belong to the acceptance run
 * (`node scripts/longhost-chaos.cjs`), which the installer and CI call. What is asserted here is that
 * they exist, are listed, and are shaped like the others.
 */
test('the chaos harness lists every scenario the requirement names', () => {
  const ids = SCENARIOS.map((scenario) => scenario.id)
  for (const wanted of ['kill-core', 'controlled-restart', 'plugin-crash', 'plugin-timeout', 'network-failure', 'host-restart', 'git-interruption', 'false-success']) {
    assert.ok(ids.includes(wanted), `the harness does not cover ${wanted}`)
  }
  for (const scenario of SCENARIOS) {
    assert.equal(typeof scenario.run, 'function', `${scenario.id} has no runner`)
    assert.ok(scenario.summary && scenario.summary.length > 10, `${scenario.id} has no summary`)
  }
  const listed = spawnSync(process.execPath, [CHAOS, '--list'], { encoding: 'utf8', windowsHide: true })
  assert.equal(listed.status, 0, listed.stderr)
  for (const id of ids) assert.match(listed.stdout, new RegExp(id))
})

test('a plugin that dies, one that never answers, and a claimed success are all reported honestly', async () => {
  const crash = await chaosPluginCrash()
  assert.equal(crash.failed, 0, JSON.stringify(crash.failures))
  const timeout = await chaosPluginTimeout()
  assert.equal(timeout.failed, 0, JSON.stringify(timeout.failures))
  const falseSuccess = await chaosFalseSuccess()
  assert.equal(falseSuccess.failed, 0, JSON.stringify(falseSuccess.failures))
})

test('the network and the resume path are exercised without a real reboot', async () => {
  const network = await chaosNetworkFailure()
  assert.equal(network.failed, 0, JSON.stringify(network.failures))
  const host = await chaosHostRestart()
  assert.equal(host.failed, 0, JSON.stringify(host.failures))
  // The one claim the harness must never make: that a real Windows reboot was exercised here.
  assert.ok(host.notes.some((note) => /NOT exercised/.test(note)), JSON.stringify(host.notes))
})

test('the installer verifies registration, not only the files it wrote', () => {
  const result = spawnSync(process.execPath, [REGISTRATION, '--json'], { encoding: 'utf8', windowsHide: true, timeout: 300_000 })
  assert.equal(result.status, 0, `the registration check failed: ${result.stdout} ${result.stderr}`)
  const report = JSON.parse(result.stdout.trim())
  assert.equal(report.harness, 'plugin-registration-check')
  assert.equal(report.ok, true, report.reason)
  const ids = report.plugins.map((entry) => entry.id)
  assert.ok(ids.includes('dshns.health-scheduler') && ids.includes('dshns.restart-supervisor'), ids.join(', '))
  for (const entry of report.plugins) {
    assert.equal(entry.registered, true, `${entry.id} is not registered: ${entry.reason}`)
    // The official page draws a row per service record: no record, no row.
    assert.equal(entry.officialUi, true, `${entry.id} has no official-UI row`)
  }
  assert.deepEqual(report.duplicateRegistrations, [], 'a plugin was registered more than once')

  // ...and the installer calls it, and reports what it said.
  const installer = read('scripts/install.ps1')
  assert.match(installer, /plugin-registration-check\.cjs/)
  assert.match(installer, /Health Scheduler \(runtime\)/)
  assert.match(installer, /Restart Supervisor \(runtime\)/)
})

test('the harness and the probe are registered with the gates', () => {
  const check = read('scripts/check-syntax.cjs')
  assert.match(check, /longhost-chaos\.cjs/)
  assert.match(check, /plugin-registration-check\.cjs/)
  const testAll = read('scripts/test-all.ps1')
  assert.match(testAll, /longhost-chaos\.cjs/)
  assert.match(testAll, /plugin-registration-check\.cjs/)
  assert.ok(testAll.includes('longhost-chaos.test.js'), 'test-all.ps1 does not assert this suite by name')
  const verify = read('scripts/verify.ps1')
  assert.match(verify, /longhost-chaos/)
})

/**
 * The acceptance record, as the deliverable it is.
 *
 * The requirement names the documents; this asserts they ship, that the machine-readable one carries the
 * metrics it asks for, and that the record says what it did *not* exercise instead of claiming it. A
 * record that asserted a real Windows reboot had been performed would be the false success this whole
 * branch is written against.
 */
test('the long-hosting acceptance record ships with the metrics and the honest gaps', () => {
  const dir = path.join(ROOT, 'docs', 'acceptance')
  for (const name of ['architecture-before.json', 'architecture-after.json', 'cleanup-candidates.json', 'cleanup-review-needed.json', 'dead-code-report.json', 'ui-surface-report.json', 'restart-recovery-report.json', 'longhost-chaos-report.json', 'longhost-soak-report.json', 'installer-registration-report.json', 'LONGHOST-ACCEPTANCE.json', 'LONGHOST-ACCEPTANCE.md']) {
    assert.ok(fs.existsSync(path.join(dir, name)), `${name} is missing`)
  }
  const acceptance = JSON.parse(fs.readFileSync(path.join(dir, 'LONGHOST-ACCEPTANCE.json'), 'utf8'))
  for (const metric of ['lostTasks', 'duplicateTasks', 'duplicateSideEffects', 'falseSuccess', 'unrecoverableCoreCrashes', 'infiniteRestartLoops', 'repositoryCorruption', 'pluginIsolationFailures', 'restartRecoveryFailures', 'intendedUiUnreachable', 'duplicatePluginRegistrations', 'unexpectedDeletedFeatures', 'deferredTaskLoss']) {
    assert.ok(acceptance.metrics[metric], `the record does not state ${metric}`)
    assert.ok(String(acceptance.metrics[metric].evidence).length > 20, `${metric} has no evidence`)
  }
  assert.equal(acceptance.metrics.lostTasks.value, 0)
  assert.equal(acceptance.metrics.falseSuccess.value, 0)
  assert.equal(acceptance.metrics.infiniteRestartLoops.value, 0)
  assert.equal(acceptance.metrics.repositoryCorruption.value, 0)
  assert.equal(acceptance.metrics.duplicatePluginRegistrations.value, 0)
  assert.ok(acceptance.notExercised.some((line) => /real Windows reboot/i.test(line)), 'the record must say the real reboot was not exercised')
  for (const [name, verdict] of Object.entries(acceptance.verdicts)) {
    assert.equal(typeof verdict.pass, 'boolean', `${name} has no verdict`)
    assert.ok(String(verdict.evidence).length > 10, `${name} has no evidence`)
  }
  const markdown = fs.readFileSync(path.join(dir, 'LONGHOST-ACCEPTANCE.md'), 'utf8')
  assert.match(markdown, /## Metrics/)
  assert.match(markdown, /## Verdicts/)
  assert.match(markdown, /## What was NOT exercised/)
})
