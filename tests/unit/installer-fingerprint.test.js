'use strict'

/**
 * Incremental install state.
 *
 * The installer used to have no memory: every run re-derived everything and ran
 * the whole test suite. These tests are the guard on the memory that replaced
 * that, and they are written against the *decision*, not the file format — what
 * matters is that an unchanged lockfile reuses and a changed one does not.
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const fingerprint = require('../../scripts/install-fingerprint.cjs')

const ROOT = path.resolve(__dirname, '..', '..')
const CLI = path.join(ROOT, 'scripts', 'install-fingerprint.cjs')

/** A throwaway checkout-shaped tree: just enough for the fingerprints to read. */
function scratchCheckout({ lock = '{"lockfileVersion":3}', dsh = '0.1.5-rc.1', electron = '43.4.0' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshns-fingerprint-'))
  const app = path.join(root, 'app')
  fs.mkdirSync(path.join(app, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
  fs.mkdirSync(path.join(app, 'node_modules', 'electron', 'dist'), { recursive: true })
  fs.writeFileSync(
    path.join(app, 'package.json'),
    JSON.stringify({ dependencies: { '@deepseek-ai/dsh': dsh }, devDependencies: { electron } }, null, 2)
  )
  fs.writeFileSync(path.join(app, 'package-lock.json'), lock)
  fs.writeFileSync(path.join(app, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({ version: dsh }))
  fs.writeFileSync(path.join(app, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '// cli')
  fs.writeFileSync(path.join(app, 'node_modules', 'electron', 'package.json'), JSON.stringify({ version: electron }))
  fs.writeFileSync(path.join(app, 'node_modules', 'electron', 'install.js'), '// installer')
  fs.writeFileSync(path.join(app, 'node_modules', 'electron', 'dist', 'electron.exe'), 'MZ')
  return { root, app, dshHome: path.join(root, 'data') }
}

function stateFor(tree, previous = null, extra = {}) {
  return fingerprint.computeState({
    root: tree.root,
    dshHome: tree.dshHome,
    profile: 'web',
    pluginName: 'dsh-plugin-mega-core',
    pluginDir: path.join(tree.app, 'plugins', 'mega-core'),
    nodeVersion: 'v24.14.1',
    electronExe: path.join(tree.app, 'node_modules', 'electron', 'dist', 'electron.exe'),
    previous,
    ...extra
  })
}

test('the lockfile is part of the fingerprint, so a lock change re-installs', () => {
  const tree = scratchCheckout({ lock: '{"lockfileVersion":3,"a":1}' })
  const first = stateFor(tree)
  assert.equal(first.dependencies.valid, true)
  assert.ok(first.dependencies.lockHash)

  // Same versions, different lock: the old installer could not see this at all.
  fs.writeFileSync(path.join(tree.app, 'package-lock.json'), '{"lockfileVersion":3,"a":2}')
  const second = stateFor(tree, first)
  assert.notEqual(second.dependencies.lockHash, first.dependencies.lockHash)
  assert.equal(second.decisions.dependencies.reuse, false)
  assert.match(second.decisions.dependencies.reason, /package-lock\.json changed/)
})

test('an unchanged checkout reuses its installed dependencies', () => {
  const tree = scratchCheckout()
  const first = stateFor(tree)
  const second = stateFor(tree, first)
  assert.equal(second.decisions.dependencies.reuse, true)
  assert.match(second.decisions.dependencies.reason, /unchanged/)
})

test('a missing binary invalidates the fingerprint even when versions match', () => {
  const tree = scratchCheckout()
  const first = stateFor(tree)
  assert.equal(first.dependencies.valid, true)
  // The rule that keeps the fast path honest: a fingerprint never overrides a
  // missing file, because the existence checks are part of the computation.
  fs.rmSync(path.join(tree.app, 'node_modules', 'electron', 'dist', 'electron.exe'))
  const second = stateFor(tree, first)
  assert.equal(second.dependencies.valid, false)
  assert.equal(second.decisions.dependencies.reuse, false)
  assert.match(second.decisions.dependencies.reason, /incomplete or version-mismatched/)
})

test('a Node build change invalidates the dependency layer', () => {
  const tree = scratchCheckout()
  const first = stateFor(tree)
  const second = fingerprint.computeState({
    root: tree.root,
    dshHome: tree.dshHome,
    profile: 'web',
    pluginName: 'dsh-plugin-mega-core',
    pluginDir: path.join(tree.app, 'plugins', 'mega-core'),
    nodeVersion: 'v26.0.0',
    electronExe: path.join(tree.app, 'node_modules', 'electron', 'dist', 'electron.exe'),
    previous: first
  })
  assert.equal(second.decisions.dependencies.reuse, false)
  assert.match(second.decisions.dependencies.reason, /Node build changed/)
})

test('a required version change invalidates the dependency layer', () => {
  const tree = scratchCheckout({ dsh: '0.1.5-rc.1' })
  const first = stateFor(tree)
  // The installed package still says the old version, so this is both a
  // "expected changed" and a "not installed" condition -- either is enough.
  fs.writeFileSync(
    path.join(tree.app, 'package.json'),
    JSON.stringify({ dependencies: { '@deepseek-ai/dsh': '0.1.6' }, devDependencies: { electron: '43.4.0' } })
  )
  const second = stateFor(tree, first)
  assert.equal(second.decisions.dependencies.reuse, false)
})

test('a satisfied profile plugin is reused, an unsatisfied one is not', () => {
  const tree = scratchCheckout()
  const pluginDir = path.join(tree.app, 'plugins', 'mega-core')
  const profileDir = path.join(tree.dshHome, 'profiles', 'web')
  const installed = path.join(profileDir, 'node_modules', 'dsh-plugin-mega-core', 'lib')
  fs.mkdirSync(installed, { recursive: true })
  fs.writeFileSync(path.join(installed, 'client.js'), '// client')
  fs.writeFileSync(path.join(installed, 'index.js'), '// server')
  fs.writeFileSync(
    path.join(profileDir, 'package.json'),
    JSON.stringify({ dependencies: { 'dsh-plugin-mega-core': `file:${pluginDir.replace(/\\/g, '/')}` } })
  )
  const first = stateFor(tree)
  assert.equal(first.profile.valid, true)
  const second = stateFor(tree, first)
  assert.equal(second.decisions.profile.reuse, true)

  // A profile that points at a *different* checkout is a repair, not a reuse.
  fs.writeFileSync(
    path.join(profileDir, 'package.json'),
    JSON.stringify({ dependencies: { 'dsh-plugin-mega-core': 'file:D:/somewhere/else/mega-core' } })
  )
  const third = stateFor(tree, second)
  assert.equal(third.profile.valid, false)
  assert.equal(third.decisions.profile.reuse, false)
})

test('a profile whose installed copy is gone is repaired, never trusted', () => {
  const tree = scratchCheckout()
  const pluginDir = path.join(tree.app, 'plugins', 'mega-core')
  const profileDir = path.join(tree.dshHome, 'profiles', 'web')
  fs.mkdirSync(profileDir, { recursive: true })
  fs.writeFileSync(
    path.join(profileDir, 'package.json'),
    JSON.stringify({ dependencies: { 'dsh-plugin-mega-core': `file:${pluginDir.replace(/\\/g, '/')}` } })
  )
  const state = stateFor(tree)
  assert.equal(state.profile.specMatches, true, 'the declared spec does match this checkout')
  assert.equal(state.profile.installed, false, 'but its installed halves are not there')
  assert.equal(state.profile.valid, false)
})

test('no previous state means no reuse, and says so', () => {
  const tree = scratchCheckout()
  const state = stateFor(tree, null)
  assert.equal(state.decisions.dependencies.reuse, false)
  assert.match(state.decisions.dependencies.reason, /no previous install state/)
})

test('the installer revision is reported without forcing dependency work', () => {
  const tree = scratchCheckout()
  const first = stateFor(tree)
  const stale = { ...first, installerRevision: 0 }
  const second = stateFor(tree, stale)
  assert.equal(second.decisions.installerRevision.changed, true)
  // A new installer step can change what runs without invalidating node_modules.
  assert.equal(second.decisions.dependencies.reuse, true)
})

test('a corrupt or version-mismatched state file reads as absent', () => {
  const tree = scratchCheckout()
  const file = fingerprint.stateFilePath(tree.dshHome)
  fs.mkdirSync(path.dirname(file), { recursive: true })

  fs.writeFileSync(file, 'not json at all')
  assert.equal(fingerprint.readState(tree.dshHome), null)

  fs.writeFileSync(file, JSON.stringify({ version: 1, dependencies: { lockHash: 'x' } }))
  assert.equal(fingerprint.readState(tree.dshHome), null, 'an older state version must not be trusted')

  const good = stateFor(tree)
  fs.writeFileSync(file, JSON.stringify(good))
  assert.ok(fingerprint.readState(tree.dshHome))
})

test('the state is written atomically and read back', () => {
  const tree = scratchCheckout()
  const state = stateFor(tree)
  const result = fingerprint.writeState(tree.dshHome, state)
  assert.equal(result.ok, true)
  const read = fingerprint.readState(tree.dshHome)
  assert.equal(read.version, fingerprint.STATE_VERSION)
  assert.equal(read.dependencies.lockHash, state.dependencies.lockHash)
  // No temporary file is left behind by the rename.
  const leftovers = fs.readdirSync(path.dirname(result.file)).filter((name) => name.endsWith('.tmp'))
  assert.deepEqual(leftovers, [])
})

test('the optional plugin decisions are recorded so they are not re-asked', () => {
  const tree = scratchCheckout()
  const stateFile = path.join(tree.dshHome, 'state', 'optional-plugins.json')
  fs.mkdirSync(path.dirname(stateFile), { recursive: true })
  fs.writeFileSync(
    stateFile,
    JSON.stringify({
      plugins: {
        '@dsh-market/plugin': { state: 'installed', spec: 'x' },
        'dsh-wallpaper-engine': { state: 'installed', spec: 'y' }
      }
    })
  )
  const state = stateFor(tree)
  assert.equal(state.optional.present, true)
  assert.equal(Object.keys(state.optional.decisions).length, 2)
  assert.equal(state.optional.decisions['dsh-wallpaper-engine'].state, 'installed')
})

test('the CLI writes state that a later run reads as reusable', () => {
  const tree = scratchCheckout()
  const run = (command) =>
    JSON.parse(
      execFileSync(process.execPath, [CLI, command, '--root', tree.root, '--dsh-home', tree.dshHome, '--node-version', 'v24.14.1'], {
        encoding: 'utf8'
      })
        .trim()
        .split('\n')
        .pop()
    )
  const written = run('write')
  assert.equal(written.write.ok, true)
  const second = run('describe')
  assert.equal(second.decisions.dependencies.reuse, true, 'the CLI must remember what it wrote')
})

test('the fingerprint module never requires Electron', () => {
  // The installer runs in plain Node, and it is also the thing a bootstrap uses.
  const text = fs.readFileSync(CLI, 'utf8')
  assert.equal(/require\(['"]electron['"]\)/.test(text), false)
})
