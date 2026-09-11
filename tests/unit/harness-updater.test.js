'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  HarnessUpdater,
  parseVersion,
  compareVersions,
  isNewer,
  readDistTag,
  resolveNpmCli
} = require('../../app/extensions/mega/updater/harness-updater')

/**
 * 拓展状态 module backend: the dock may only ever show the real installed
 * version and the real official dist-tag, and the update hand-off must never
 * pretend to have started when npm or Node is missing.
 */

const SCRATCH = path.join(process.env.TEMP || os.tmpdir(), `dsh-harness-updater-${process.pid}`)

function freshRoot() {
  fs.rmSync(SCRATCH, { recursive: true, force: true })
  for (const dir of ['app/node_modules/@deepseek-ai/dsh/lib', 'data/state', 'logs', 'runtime/node-test/node_modules/npm/bin']) {
    fs.mkdirSync(path.join(SCRATCH, dir), { recursive: true })
  }
  fs.writeFileSync(path.join(SCRATCH, 'app', 'package.json'), JSON.stringify({
    name: 'ds-harness',
    dependencies: { '@deepseek-ai/dsh': '0.1.2-rc.1' }
  }, null, 2))
  fs.writeFileSync(path.join(SCRATCH, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.2-rc.1' }))
  fs.writeFileSync(path.join(SCRATCH, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '')
  fs.writeFileSync(path.join(SCRATCH, 'runtime', 'node-test', 'node_modules', 'npm', 'bin', 'npm-cli.js'), '')
  return SCRATCH
}

function makeUpdater(overrides = {}) {
  const root = freshRoot()
  return new HarnessUpdater({
    root,
    appDir: path.join(root, 'app'),
    nodeExe: path.join(root, 'runtime', 'node-test', 'node.exe'),
    stateDir: path.join(root, 'data', 'state'),
    log: () => {},
    fetchRegistryDocument: async () => ({ ok: true, document: { 'dist-tags': { latest: '0.1.5-rc.1' } } }),
    spawnProcess: () => { throw new Error('spawn must not run in this test') },
    ...overrides
  })
}

test('semver comparison orders releases, prereleases and build metadata', () => {
  assert.deepEqual(parseVersion('1.2.3-rc.1'), { numbers: [1, 2, 3], prerelease: ['rc', '1'] })
  assert.equal(parseVersion('not-a-version'), null)

  assert.equal(compareVersions('0.1.5-rc.1', '0.1.2-rc.1'), 1)
  assert.equal(compareVersions('0.1.2-rc.1', '0.1.5-rc.1'), -1)
  assert.equal(compareVersions('0.1.5', '0.1.5-rc.2'), 1, 'a release outranks its prereleases')
  assert.equal(compareVersions('0.1.5-rc.2', '0.1.5-rc.10'), -1, 'numeric prerelease identifiers compare numerically')
  assert.equal(compareVersions('0.1.5-rc.1', '0.1.5-rc.1'), 0)
  assert.equal(compareVersions('1.0.0+build.7', '1.0.0'), 0, 'build metadata is ignored')

  assert.equal(isNewer('0.1.5-rc.1', '0.1.2-rc.1'), true)
  assert.equal(isNewer('0.1.2-rc.1', '0.1.5-rc.1'), false)
  assert.equal(isNewer('garbage', '0.1.2-rc.1'), false, 'an unparseable tag never counts as newer')
  assert.equal(isNewer('0.1.5-rc.1', 'not-installed'), false)
})

test('only a real dist-tag string is accepted as the official latest', () => {
  assert.equal(readDistTag({ 'dist-tags': { latest: '0.1.5-rc.1' } }, 'latest'), '0.1.5-rc.1')
  assert.equal(readDistTag({ 'dist-tags': { next: '0.1.5-rc.2' } }, 'latest'), null)
  assert.equal(readDistTag({ 'dist-tags': { latest: 'not-a-version' } }, 'latest'), null)
  assert.equal(readDistTag(null, 'latest'), null)
})

test('a check reports the installed harness, the official latest and the gap', async () => {
  const updater = makeUpdater()
  assert.equal(updater.describe().status, 'idle')
  assert.equal(updater.describe().currentVersion, '0.1.2-rc.1')

  const status = await updater.check()
  assert.equal(status.status, 'outdated')
  assert.equal(status.currentVersion, '0.1.2-rc.1')
  assert.equal(status.latestVersion, '0.1.5-rc.1')
  assert.equal(status.updateAvailable, true)
  assert.equal(status.tag, 'latest')
  assert.ok(status.checkedAt > 0)
  assert.equal(status.npmAvailable, true, 'the bundled npm CLI is discovered from the Node runtime')
})

test('an already-current harness reports current instead of offering an update', async () => {
  const updater = makeUpdater({
    fetchRegistryDocument: async () => ({ ok: true, document: { 'dist-tags': { latest: '0.1.2-rc.1' } } })
  })
  const status = await updater.check()
  assert.equal(status.status, 'current')
  assert.equal(status.updateAvailable, false)
  assert.deepEqual(updater.apply(), { started: false, reason: 'ALREADY_CURRENT', message: '当前已是 0.1.2-rc.1，无需更新。' })
})

test('a registry failure is described, never thrown at the dock', async () => {
  const updater = makeUpdater({ fetchRegistryDocument: async () => ({ ok: false, error: 'getaddrinfo ENOTFOUND' }) })
  const status = await updater.check()
  assert.equal(status.status, 'failed')
  assert.equal(status.error.code, 'REGISTRY_UNAVAILABLE')
  assert.match(status.error.message, /ENOTFOUND/)
  assert.equal(status.latestVersion, null)
})

test('an unknown dist-tag is a reported failure, not a silent "up to date"', async () => {
  const updater = makeUpdater({
    fetchRegistryDocument: async () => ({ ok: true, document: { 'dist-tags': { next: '0.1.5-rc.2' } } })
  })
  const status = await updater.check()
  assert.equal(status.status, 'failed')
  assert.equal(status.error.code, 'TAG_MISSING')
})

test('applying without a checked target refuses instead of spawning anything', () => {
  const updater = makeUpdater()
  const result = updater.apply()
  assert.equal(result.started, false)
  assert.equal(result.reason, 'NO_TARGET')
})

test('applying with a missing runtime refuses before the shell is told to restart', async () => {
  const noNode = makeUpdater({ nodeExe: '' })
  await noNode.check()
  assert.equal(noNode.apply().reason, 'NODE_UNAVAILABLE')

  // Node is present but the bundled npm CLI is not: still a clean refusal.
  const noNpm = makeUpdater()
  fs.rmSync(path.join(SCRATCH, 'runtime'), { recursive: true, force: true })
  await noNpm.check()
  const result = noNpm.apply()
  assert.equal(result.started, false)
  assert.equal(result.reason, 'NPM_UNAVAILABLE')
})

test('applying spawns one detached runner, records the intent, and never installs itself', async () => {
  const spawned = []
  const updater = makeUpdater({
    spawnProcess: (command, args, options) => {
      spawned.push({ command, args, options })
      return { pid: 4242, unref() {} }
    }
  })
  await updater.check()
  const result = updater.apply()

  assert.equal(result.started, true)
  assert.equal(result.from, '0.1.2-rc.1')
  assert.equal(result.to, '0.1.5-rc.1')
  assert.equal(spawned.length, 1)
  assert.equal(spawned[0].options.detached, true, 'the runner must survive the shell exiting')
  assert.match(spawned[0].args[0], /update-runner\.js$/)
  for (const flag of ['--root', '--app', '--node', '--npm-cli', '--target', '--parent-pid']) {
    assert.ok(spawned[0].args.includes(flag), `${flag} must be passed to the runner`)
  }
  assert.equal(spawned[0].args[spawned[0].args.indexOf('--target') + 1], '0.1.5-rc.1')

  // The marker records what the restart must report back to the dock.
  const marker = JSON.parse(fs.readFileSync(path.join(SCRATCH, 'data', 'state', 'mega-update.json'), 'utf8'))
  assert.equal(marker.status, 'updating')
  assert.equal(marker.from, '0.1.2-rc.1')
  assert.equal(marker.to, '0.1.5-rc.1')
  assert.equal(marker.pid, process.pid)
  // A marker written by this very process is in-flight work, not a result.
  assert.equal(updater.describe().lastUpdate, null)
})

test('a marker left by an earlier process is reported, and an interrupted run is labelled', () => {
  const updater = makeUpdater()
  const markerPath = path.join(SCRATCH, 'data', 'state', 'mega-update.json')

  fs.writeFileSync(markerPath, JSON.stringify({ status: 'succeeded', from: '0.1.2-rc.1', to: '0.1.5-rc.1', pid: 999999, finishedAt: 1 }))
  assert.equal(updater.describe().lastUpdate.status, 'succeeded')

  fs.writeFileSync(markerPath, JSON.stringify({ status: 'updating', phase: 'installing', pid: 999999 }))
  assert.equal(updater.describe().lastUpdate.status, 'interrupted', 'an update that never finished must not read as success')
})

test('the npm CLI is resolved from the bundled runtime or reported as unavailable', () => {
  freshRoot()
  assert.match(resolveNpmCli(path.join(SCRATCH, 'runtime', 'node-test', 'node.exe'), SCRATCH), /npm-cli\.js$/)
  fs.rmSync(path.join(SCRATCH, 'runtime'), { recursive: true, force: true })
  assert.equal(resolveNpmCli('', SCRATCH), null)
})
