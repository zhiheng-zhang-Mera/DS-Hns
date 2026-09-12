'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const { main } = require('../../app/extensions/mega/updater/update-runner')

/**
 * Detached update runner: this is the part that actually replaces the harness,
 * so it is exercised end to end here with a stubbed npm CLI - no network, no
 * real installation, but the real marker, transaction, rollback and relaunch
 * behaviour.
 *
 * The stub npm is deliberately faithful about the one thing that made the old
 * rollback wrong: `npm install --save-exact <pkg>@<version>` really rewrites
 * app\package.json, so a rollback that restored the manifests and then ran the
 * *upgrade* command again would visibly re-pin the manifest. It also records the
 * dependency it installs in app\package-lock.json, so `npm ci` restores the
 * previous version the way the real npm would.
 *
 * Env switches understood by the stub:
 *   DSH_FAKE_NPM_NOOP=1            install exits 0 without installing anything
 *   DSH_FAKE_NPM_FAIL_AFTER_PIN=1  rewrites the manifest pin, then fails
 *   DSH_FAKE_FAIL_CI=1             `npm ci` (the rollback) fails
 */

const SCRATCH_BASE = path.join(process.env.TEMP || os.tmpdir(), `dsh-update-runner-${process.pid}`)
const PACKAGE = '@deepseek-ai/dsh'
const TARGET = '0.1.5-rc.1'
const OLD = '0.1.2-rc.1'
let SCRATCH = ''

function cleanup(dir = SCRATCH) {
  // The relaunch fallback may still hold the scratch directory as its cwd, so
  // removal is best effort - a leftover temp directory must not fail a test.
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {}
}

function freshRoot({ npmScript, installedVersion = OLD, stub = {} }, name = 'root') {
  SCRATCH = path.join(SCRATCH_BASE, name)
  cleanup(SCRATCH)
  for (const dir of ['app/node_modules/@deepseek-ai/dsh/lib', 'app/tools', 'data/state', 'logs', 'cache/temp', 'cache/npm']) {
    fs.mkdirSync(path.join(SCRATCH, dir), { recursive: true })
  }
  fs.writeFileSync(path.join(SCRATCH, 'app', 'package.json'), `${JSON.stringify({
    name: 'ds-harness',
    version: '1.0.0-alien-rebuild',
    dependencies: { [PACKAGE]: OLD }
  }, null, 2)}\n`)
  fs.writeFileSync(path.join(SCRATCH, 'app', 'package-lock.json'), `${JSON.stringify({
    lockfileVersion: 3,
    name: 'ds-harness',
    packages: { [`node_modules/${PACKAGE}`]: { version: installedVersion } }
  }, null, 2)}\n`)
  writeInstalled(installedVersion)
  fs.writeFileSync(path.join(SCRATCH, 'app', 'tools', 'npm-cli.js'), npmScript)
  // Per-scenario stub behavior, read by the stub from its own directory.
  fs.writeFileSync(path.join(SCRATCH, 'app', 'tools', 'fake-npm.json'), `${JSON.stringify(stub, null, 2)}\n`)
  // A harmless launcher, so the relaunch fallback never needs Electron.
  fs.writeFileSync(path.join(SCRATCH, 'Start-DeepSeek-Harness.cmd'), '@echo off\r\nexit /b 0\r\n')
  return SCRATCH
}

function writeInstalled(version) {
  const dir = path.join(SCRATCH, 'app', 'node_modules', PACKAGE)
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: PACKAGE, version }))
  // A stand-in CLI that answers --help like the real harness does, so the
  // runner's CLI boot check is exercised rather than skipped.
  fs.writeFileSync(path.join(dir, 'lib', 'bin.js'), 'process.stdout.write("Usage: dsh [options] [command]\\n")\n')
}

const installedVersion = () => JSON.parse(
  fs.readFileSync(path.join(SCRATCH, 'app', 'node_modules', PACKAGE, 'package.json'), 'utf8')
).version

const manifestText = () => fs.readFileSync(path.join(SCRATCH, 'app', 'package.json'), 'utf8')
const lockText = () => fs.readFileSync(path.join(SCRATCH, 'app', 'package-lock.json'), 'utf8')
const marker = () => JSON.parse(fs.readFileSync(path.join(SCRATCH, 'data', 'state', 'mega-update.json'), 'utf8'))
const logText = () => fs.readFileSync(path.join(SCRATCH, 'logs', 'mega-update.log'), 'utf8')

/**
 * Minimal but honest npm stand-in, used for every scenario.
 *
 *   install --save-exact @deepseek-ai/dsh@X  -> installs X and pins package.json
 *   install (no spec)                        -> reinstalls the lockfile version
 *   ci                                       -> reinstalls the lockfile version
 *
 * Per-scenario switches come from `<tools>\fake-npm.json` in the scratch root:
 *   failInstall    the upgrade itself fails
 *   failAfterPin   the upgrade rewrites package.json / the lockfile, then fails
 *   failCi         the rollback (`npm ci`) fails
 *   noop           install exits 0 without installing anything
 */
const FAKE_NPM = `
const fs = require('node:fs')
const path = require('node:path')

const argv = process.argv.slice(2)
const command = argv[0]
const cwd = process.cwd()
const PACKAGE = '${PACKAGE}'
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'fake-npm.json'), 'utf8'))

if (command === 'ci' && config.failCi === true) {
  process.stderr.write('npm ERR! simulated ci failure\\n')
  process.exit(1)
}
if (config.noop === true) {
  process.stdout.write('up to date (no-op stub)\\n')
  process.exit(0)
}
if (config.failInstall === true && command === 'install') {
  process.stderr.write('npm ERR! simulated install failure\\n')
  process.exit(1)
}

const manifestPath = path.join(cwd, 'package.json')
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
manifest.dependencies = manifest.dependencies || {}
let version = manifest.dependencies[PACKAGE] || null

if (command === 'install') {
  const spec = argv.find((token) => token.startsWith(PACKAGE + '@'))
  const lockPath = path.join(cwd, 'package-lock.json')
  let lock = {}
  try { lock = JSON.parse(fs.readFileSync(lockPath, 'utf8')) } catch { lock = { lockfileVersion: 3, packages: {} } }
  if (spec) {
    version = spec.slice(spec.indexOf('@', 1) + 1)
    if (argv.includes('--save-exact')) manifest.dependencies[PACKAGE] = version
    lock.packages = lock.packages || {}
    lock.packages['node_modules/' + PACKAGE] = { version }
    fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\\n')
    // The pin is written before the failure, so a rollback has real damage to
    // undo: this is the state the old "reuse the upgrade command" rollback got
    // wrong.
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\\n')
    if (config.failAfterPin === true) {
      process.stderr.write('npm ERR! simulated failure after the manifest was pinned\\n')
      process.exit(1)
    }
  } else {
    version = (lock.packages && lock.packages['node_modules/' + PACKAGE] && lock.packages['node_modules/' + PACKAGE].version) || version
  }
}

if (!version) {
  process.stderr.write('npm ERR! nothing to install\\n')
  process.exit(1)
}

fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\\n')
const dir = path.join(cwd, 'node_modules', PACKAGE)
fs.mkdirSync(path.join(dir, 'lib'), { recursive: true })
fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: PACKAGE, version }))
fs.writeFileSync(path.join(dir, 'lib', 'bin.js'), 'process.stdout.write("Usage: dsh [options] [command]\\\\n")\\n')
process.stdout.write('added 1 package\\n')
process.exit(0)
`

/**
 * Run the runner against the current scratch root.
 *
 * Behavior switches live in the scratch root's own `app\tools\fake-npm.json`
 * (written by `freshRoot`), never in a process-global variable: node:test runs
 * the tests of one file concurrently, and a leaked `DSH_FAKE_FAIL_CI=1` from one
 * scenario silently made an unrelated rollback fail.
 */
async function run() {
  return main([
    '--root', SCRATCH,
    '--app', path.join(SCRATCH, 'app'),
    '--node', process.execPath,
    '--npm-cli', path.join(SCRATCH, 'app', 'tools', 'npm-cli.js'),
    '--target', TARGET,
    '--tag', 'latest',
    // A pid that is certainly gone: the shell has already exited.
    '--parent-pid', '999999'
  ])
}


// --- Test A: the target install succeeds ------------------------------------

test('A: a successful run installs the target, pins the manifest and records the transaction', async (t) => {
  freshRoot({ npmScript: FAKE_NPM }, 'success')
  t.after(() => cleanup())

  const code = await run()
  assert.equal(code, 0)

  assert.equal(installedVersion(), TARGET, 'the requested version is what ends up installed')

  const manifest = JSON.parse(manifestText())
  assert.equal(manifest.dependencies[PACKAGE], TARGET, 'the pin must follow the install or install-deps.ps1 would revert it')
  assert.equal(manifest.version, '1.0.0-alien-rebuild', 'unrelated manifest fields are preserved')

  const result = marker()
  assert.equal(result.status, 'succeeded')
  assert.equal(result.phase, 'done')
  assert.equal(result.from, OLD, 'the source version comes from the package that was installed, not the pin')
  assert.equal(result.to, TARGET)
  assert.equal(result.error, null)
  assert.equal(result.rollback, null, 'a successful update has nothing to roll back')
  assert.equal(result.transaction.fromVersion, OLD)
  assert.equal(result.transaction.targetVersion, TARGET)
  assert.equal(result.transaction.installedVersionAtStart, OLD)
  assert.ok(Number.isFinite(result.transaction.startedAt))
  assert.ok(fs.existsSync(path.join(SCRATCH, 'logs', 'mega-update.log')))
  assert.match(logText(), /update succeeded/)
})

// --- Test B: npm install fails outright -------------------------------------

test('B: a failing install restores both manifests, reinstalls the old version and still relaunches', async (t) => {
  freshRoot({ npmScript: FAKE_NPM, stub: { failInstall: true } }, 'failure')
  t.after(() => cleanup())
  const manifestBefore = manifestText()
  const lockBefore = lockText()

  const code = await run()
  assert.equal(code, 1)

  assert.equal(manifestText(), manifestBefore, 'the target pin is undone byte for byte')
  assert.equal(lockText(), lockBefore, 'the lockfile is restored byte for byte')
  assert.equal(installedVersion(), OLD, 'the previous package is really back on disk')

  const result = marker()
  assert.equal(result.status, 'failed_rolled_back')
  assert.equal(result.phase, 'failed')
  assert.equal(result.error.code, 'INSTALL_FAILED')
  assert.match(result.error.message, /exited with code 1/)
  assert.equal(result.rollback.ok, true)
  assert.equal(result.rollback.code, null)
  assert.equal(result.rollback.restoredVersion, OLD)
  assert.equal(result.from, OLD)
  assert.equal(result.to, TARGET)
  assert.ok(result.relaunchedPid, 'a failed update must never leave the user without an app')
  assert.match(logText(), /rollback started/)
  assert.match(logText(), /rollback.*npm ci/, 'the rollback must be a lockfile reinstall, not another targeted install')
  assert.equal(
    /rolling back[\s\S]*--save-exact/.test(logText()),
    false,
    'the upgrade command is never reused for the rollback'
  )
})

// --- Test C: npm exits 0 but the target never lands -------------------------

test('C: an install that does not produce the target version fails verification and rolls back', async (t) => {
  freshRoot({ npmScript: FAKE_NPM, stub: { noop: true } }, 'lying')
  t.after(() => cleanup())
  const manifestBefore = manifestText()

  const code = await run()
  assert.equal(code, 1)
  const result = marker()
  assert.equal(result.status, 'failed_rolled_back')
  assert.equal(result.error.code, 'INSTALL_FAILED')
  assert.match(result.error.message, /does not match requested 0\.1\.5-rc\.1/)
  assert.equal(result.rollback.ok, true)
  assert.equal(result.rollback.restoredVersion, OLD)
  assert.equal(installedVersion(), OLD)
  assert.equal(manifestText(), manifestBefore)
})

// --- Test D: --save-exact really rewrites the manifest ----------------------

test('D: rollback restores a manifest that npm --save-exact really mutated', async (t) => {
  freshRoot({ npmScript: FAKE_NPM, stub: { failAfterPin: true } }, 'save-exact')
  t.after(() => cleanup())
  const manifestBefore = manifestText()
  const lockBefore = lockText()

  // The upgrade pins the manifest and only then fails: without a rollback the
  // manifest would stay re-pinned to the version that never installed.
  const code = await run()
  assert.equal(code, 1)

  assert.equal(manifestText(), manifestBefore, 'package.json is back to the original bytes')
  assert.equal(lockText(), lockBefore, 'package-lock.json is back to the original bytes')
  assert.equal(installedVersion(), OLD, 'node_modules still holds the previous version')

  const result = marker()
  assert.equal(result.status, 'failed_rolled_back')
  assert.equal(result.rollback.ok, true)
  assert.equal(result.rollback.restoredVersion, OLD)
  assert.equal(result.error.code, 'INSTALL_FAILED')
  assert.equal(result.transaction.packageJson, undefined, 'manifest bytes never leak into the marker')
  assert.match(fs.readFileSync(path.join(SCRATCH, 'app', 'package.json'), 'utf8'), /"@deepseek-ai\/dsh": "0\.1\.2-rc\.1"/, 'the pre-update manifest is what the rollback restored')
})

// --- Test E: the rollback itself fails --------------------------------------

test('E: a failing rollback is reported as failed_rollback_failed, never as an ordinary failure', async (t) => {
  freshRoot({ npmScript: FAKE_NPM, stub: { failAfterPin: true, failCi: true } }, 'rollback-failure')
  t.after(() => cleanup())

  const code = await run()
  assert.equal(code, 1)

  const result = marker()
  assert.equal(result.status, 'failed_rollback_failed')
  assert.notEqual(result.status, 'failed', 'a broken rollback must never look like an ordinary failure')
  assert.equal(result.error.code, 'INSTALL_FAILED_ROLLBACK_FAILED')
  assert.equal(result.error.rollback.code, 'ROLLBACK_RESTORE_INCOMPLETE')
  assert.equal(result.rollback.ok, false)
  assert.equal(result.rollback.restoredVersion, null)
  assert.equal(result.rollback.code, 'ROLLBACK_RESTORE_INCOMPLETE')
  assert.match(result.rollback.message, /exited with code 1/)
  assert.equal(manifestText().includes(TARGET), false, 'the manifests are still restored even when the reinstall fails')
  assert.equal(installedVersion(), OLD, 'nothing could replace the installed package, so it is still the old one')
  assert.ok(result.relaunchedPid, 'the app is relaunched even after a failed rollback')
  assert.match(logText(), /update rollback FAILED/)
  assert.match(logText(), /may now be inconsistent/)
})

// --- rollback target identification -----------------------------------------

test('the transaction records the installed package, not the manifest pin', async (t) => {
  freshRoot({ npmScript: FAKE_NPM, stub: { noop: true } }, 'pin-drift')
  t.after(() => cleanup())
  // The pin says 0.1.2-rc.1 but the disk holds something else: the rollback
  // target must follow the disk.
  writeInstalled('0.1.1-rc.9')

  const code = await run()
  assert.equal(code, 1)
  const result = marker()
  assert.equal(result.transaction.fromVersion, '0.1.1-rc.9')
  assert.equal(result.from, '0.1.1-rc.9')
  assert.equal(result.error.message.includes(TARGET), true)
})

// --- abort paths -------------------------------------------------------------

test('a run without a target version aborts without touching the installation', async (t) => {
  freshRoot({ npmScript: FAKE_NPM }, 'no-target')
  t.after(() => cleanup())
  const manifestBefore = manifestText()

  const code = await main(['--root', SCRATCH, '--app', path.join(SCRATCH, 'app'), '--node', process.execPath, '--parent-pid', '999999'])
  assert.equal(code, 1)
  assert.equal(manifestText(), manifestBefore)
  assert.equal(installedVersion(), OLD)
  assert.equal(marker().error.code, 'NO_TARGET')
})

test('the runner only refuses to continue while the requesting shell is alive', () => {
  freshRoot({ npmScript: FAKE_NPM }, 'alive')
  // A real, live process: this very test runner is guaranteed to exist.
  const { processAlive } = require('../../app/extensions/mega/updater/update-runner')
  assert.equal(processAlive(process.pid), true)
  assert.equal(processAlive(999999), false)
  // Sanity: the stub npm really is runnable by this Node build, and it really
  // mutates the manifest when it is handed --save-exact.
  const probe = spawnSync(process.execPath, [path.join(SCRATCH, 'app', 'tools', 'npm-cli.js'), 'install', '--save-exact', `${PACKAGE}@${TARGET}`], { cwd: path.join(SCRATCH, 'app'), encoding: 'utf8' })
  assert.equal(probe.status, 0)
  assert.equal(installedVersion(), TARGET)
  assert.equal(JSON.parse(manifestText()).dependencies[PACKAGE], TARGET)
  cleanup()
})
