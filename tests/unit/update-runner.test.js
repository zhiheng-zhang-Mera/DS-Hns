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
 * real installation, but the real marker, rollback and relaunch behaviour.
 */

const SCRATCH_BASE = path.join(process.env.TEMP || os.tmpdir(), `dsh-update-runner-${process.pid}`)
let SCRATCH = ''

function cleanup(dir = SCRATCH) {
  // The relaunch fallback may still hold the scratch directory as its cwd, so
  // removal is best effort - a leftover temp directory must not fail a test.
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {}
}

function freshRoot({ npmScript, installedVersion = '0.1.2-rc.1' }, name = 'root') {
  SCRATCH = path.join(SCRATCH_BASE, name)
  cleanup(SCRATCH)
  for (const dir of ['app/node_modules/@deepseek-ai/dsh/lib', 'app/tools', 'data/state', 'logs', 'cache/temp', 'cache/npm']) {
    fs.mkdirSync(path.join(SCRATCH, dir), { recursive: true })
  }
  fs.writeFileSync(path.join(SCRATCH, 'app', 'package.json'), `${JSON.stringify({
    name: 'ds-harness',
    version: '1.0.0-alien-rebuild',
    dependencies: { '@deepseek-ai/dsh': '0.1.2-rc.1' }
  }, null, 2)}\n`)
  fs.writeFileSync(path.join(SCRATCH, 'app', 'package-lock.json'), `${JSON.stringify({ lockfileVersion: 3, name: 'ds-harness' }, null, 2)}\n`)
  writeInstalled(installedVersion)
  fs.writeFileSync(path.join(SCRATCH, 'app', 'tools', 'npm-cli.js'), npmScript)
  // A harmless launcher, so the relaunch fallback never needs Electron.
  fs.writeFileSync(path.join(SCRATCH, 'Start-DeepSeek-Harness.cmd'), '@echo off\r\nexit /b 0\r\n')
  return SCRATCH
}

function writeInstalled(version) {
  const dir = path.join(SCRATCH, 'app', 'node_modules', '@deepseek-ai', 'dsh')
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }))
  fs.writeFileSync(path.join(dir, 'lib', 'bin.js'), '')
}

/** Minimal npm stand-in: it only has to honour `install <pkg>@<version>`. */
const SUCCESSFUL_NPM = `
const fs = require('node:fs')
const path = require('node:path')
const target = process.argv[process.argv.length - 1].split('@').pop()
const dir = path.join(process.cwd(), 'node_modules', '@deepseek-ai', 'dsh')
fs.mkdirSync(path.join(dir, 'lib'), { recursive: true })
fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: target }))
fs.writeFileSync(path.join(dir, 'lib', 'bin.js'), '')
process.exit(0)
`

const FAILING_NPM = `
process.stderr.write('npm ERR! simulated install failure\\n')
process.exit(1)
`

/** npm that reports success but installs the wrong thing. */
const LYING_NPM = `
process.exit(0)
`

function marker() {
  return JSON.parse(fs.readFileSync(path.join(SCRATCH, 'data', 'state', 'mega-update.json'), 'utf8'))
}

async function run(nodeCount = 0) {
  return main([
    '--root', SCRATCH,
    '--app', path.join(SCRATCH, 'app'),
    '--node', process.execPath,
    '--npm-cli', path.join(SCRATCH, 'app', 'tools', 'npm-cli.js'),
    '--target', '0.1.5-rc.1',
    '--tag', 'latest',
    // A pid that is certainly gone: the shell has already exited.
    '--parent-pid', '999999'
  ])
}

test('a successful run installs the target, pins the manifest and reports success', async (t) => {
  freshRoot({ npmScript: SUCCESSFUL_NPM }, 'success')
  t.after(() => cleanup())

  const code = await run()
  assert.equal(code, 0)

  const installed = JSON.parse(fs.readFileSync(path.join(SCRATCH, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'))
  assert.equal(installed.version, '0.1.5-rc.1', 'the requested version is what ends up installed')

  const manifest = JSON.parse(fs.readFileSync(path.join(SCRATCH, 'app', 'package.json'), 'utf8'))
  assert.equal(manifest.dependencies['@deepseek-ai/dsh'], '0.1.5-rc.1', 'the pin must follow the install or install-deps.ps1 would revert it')
  assert.equal(manifest.version, '1.0.0-alien-rebuild', 'unrelated manifest fields are preserved')

  const result = marker()
  assert.equal(result.status, 'succeeded')
  assert.equal(result.phase, 'done')
  assert.equal(result.from, null, 'no previous marker means no known source version')
  assert.equal(result.to, '0.1.5-rc.1')
  assert.equal(result.error, null)
  assert.ok(fs.existsSync(path.join(SCRATCH, 'logs', 'mega-update.log')))
})

test('an install failure rolls the manifests back and still relaunches the product', async (t) => {
  freshRoot({ npmScript: FAILING_NPM }, 'failure')
  t.after(() => cleanup())
  const manifestBefore = fs.readFileSync(path.join(SCRATCH, 'app', 'package.json'), 'utf8')
  const lockBefore = fs.readFileSync(path.join(SCRATCH, 'app', 'package-lock.json'), 'utf8')

  const code = await run()
  assert.equal(code, 1)

  assert.equal(fs.readFileSync(path.join(SCRATCH, 'app', 'package.json'), 'utf8'), manifestBefore, 'the pin is undone')
  assert.equal(fs.readFileSync(path.join(SCRATCH, 'app', 'package-lock.json'), 'utf8'), lockBefore)

  const result = marker()
  assert.equal(result.status, 'failed')
  assert.equal(result.error.code, 'INSTALL_FAILED')
  assert.match(result.error.message, /exited with code 1/)
  assert.ok(result.relaunchedPid, 'a failed update must never leave the user without an app')
})

test('an install that does not produce the target version fails verification and rolls back', async (t) => {
  freshRoot({ npmScript: LYING_NPM }, 'lying')
  t.after(() => cleanup())

  const code = await run()
  assert.equal(code, 1)
  const result = marker()
  assert.equal(result.status, 'failed')
  assert.equal(result.error.code, 'INSTALL_FAILED')
  assert.match(result.error.message, /does not match requested 0\.1\.5-rc\.1/)
})

test('a run without a target version aborts without touching the installation', async (t) => {
  freshRoot({ npmScript: SUCCESSFUL_NPM }, 'no-target')
  t.after(() => cleanup())
  const manifestBefore = fs.readFileSync(path.join(SCRATCH, 'app', 'package.json'), 'utf8')

  const code = await main(['--root', SCRATCH, '--app', path.join(SCRATCH, 'app'), '--node', process.execPath, '--parent-pid', '999999'])
  assert.equal(code, 1)
  assert.equal(fs.readFileSync(path.join(SCRATCH, 'app', 'package.json'), 'utf8'), manifestBefore)
  assert.equal(marker().error.code, 'NO_TARGET')
})

test('the runner only refuses to continue while the requesting shell is alive', () => {
  freshRoot({ npmScript: SUCCESSFUL_NPM }, 'alive')
  // A real, live process: this very test runner is guaranteed to exist.
  const { processAlive } = require('../../app/extensions/mega/updater/update-runner')
  assert.equal(processAlive(process.pid), true)
  assert.equal(processAlive(999999), false)
  // Sanity: the stub npm really is runnable by this Node build.
  const probe = spawnSync(process.execPath, [path.join(SCRATCH, 'app', 'tools', 'npm-cli.js'), 'install', '@deepseek-ai/dsh@0.1.5-rc.1'], { cwd: path.join(SCRATCH, 'app'), encoding: 'utf8' })
  assert.equal(probe.status, 0)
  cleanup()
})
