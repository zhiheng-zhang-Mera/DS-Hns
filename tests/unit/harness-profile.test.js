'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { syncShippedPackage, shadowManifests } = require('../../app/harness-profile.cjs')

/**
 * The Harness profile's copy of the plugin DS-Hns ships (`app/harness-profile.cjs`).
 *
 * The profile's copy once carried the package manifest into `lib/` along with the two halves, and
 * the Harness resolves a client plugin's bundle by walking up to the *nearest* manifest that names
 * the package — so it looked for `lib/lib/client.js`, found nothing, and ended the launch before the
 * official UI existed. These tests hold the copy to what the product ships, and hold the launch to
 * doing that refresh before it spawns the Harness.
 */

const ROOT = path.resolve(__dirname, '..', '..')
const PLUGIN = path.join(ROOT, 'app', 'plugins', 'mega-core')
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8')

function writeFiles(root, files) {
  for (const [relative, body] of Object.entries(files)) {
    const file = path.join(root, relative.split('/').join(path.sep))
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, body)
  }
}

/** A shipped package and the copy a profile happens to hold, in a scratch directory. */
function scratchPair(t, { manifest, sourceFiles = {}, targetFiles = {} }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshns-profile-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const sourceDir = path.join(dir, 'shipped')
  const modulesDir = path.join(dir, 'node_modules')
  const targetDir = path.join(modulesDir, manifest.name)
  writeFiles(sourceDir, { 'package.json': `${JSON.stringify(manifest, null, 2)}\n`, ...sourceFiles })
  writeFiles(targetDir, targetFiles)
  return { dir, sourceDir, modulesDir, targetDir }
}

const EXAMPLE = {
  name: 'dsh-plugin-example',
  version: '1.0.0',
  type: 'module',
  main: 'lib/index.js',
  exports: { '.': './lib/index.js', './client': './lib/client.js' },
  files: ['lib/index.js', 'lib/client.js', 'cordis.patch.yml']
}

test('the shipped plugin keeps its manifest at its root, where the Harness looks for the bundle', () => {
  const manifest = JSON.parse(read('app/plugins/mega-core/package.json'))
  assert.equal(
    fs.existsSync(path.join(PLUGIN, 'lib', 'package.json')),
    false,
    'a manifest inside lib/ would be taken for the package root and the bundle looked for one directory too deep'
  )
  for (const relative of ['lib/index.js', 'lib/client.js', 'lib/view.js', 'cordis.patch.yml']) {
    assert.ok(manifest.files.includes(relative), `${relative} is part of the shipped package`)
  }
  assert.equal(manifest.exports['./client'], './lib/client.js')
})

test('the profile copy is brought back to the shipped package', (t) => {
  const { sourceDir, modulesDir, targetDir } = scratchPair(t, {
    manifest: EXAMPLE,
    sourceFiles: {
      'lib/index.js': 'export const host = 1\n',
      'lib/client.js': 'export const bundle = 2\n',
      'cordis.patch.yml': '- insert:\n'
    },
    targetFiles: {
      'package.json': `${JSON.stringify({ ...EXAMPLE, version: '0.0.1' })}\n`,
      'lib/index.js': 'export const host = 0\n',
      'lib/client.js': 'export const bundle = 2\n',
      'lib/view.js': 'export const stale = true\n',
      'lib/package.json': `${JSON.stringify(EXAMPLE)}\n`,
      'cordis.patch.yml': '- insert:\n'
    }
  })

  const changed = syncShippedPackage({ sourceDir, modulesDir })

  assert.deepEqual(changed, [
    'package.json',
    'lib/index.js',
    'lib/package.json (a second manifest for this package)',
    'lib/view.js (not part of the shipped package)'
  ])
  assert.equal(
    fs.readFileSync(path.join(targetDir, 'package.json'), 'utf8'),
    fs.readFileSync(path.join(sourceDir, 'package.json'), 'utf8')
  )
  assert.equal(fs.readFileSync(path.join(targetDir, 'lib', 'index.js'), 'utf8'), 'export const host = 1\n')
  assert.equal(fs.existsSync(path.join(targetDir, 'lib', 'package.json')), false)
  assert.equal(fs.existsSync(path.join(targetDir, 'lib', 'view.js')), false)
  // A file that already matched is left where it is.
  assert.equal(fs.readFileSync(path.join(targetDir, 'lib', 'client.js'), 'utf8'), 'export const bundle = 2\n')
})

test('a copy that already matches the shipped package is left alone', (t) => {
  const { sourceDir, modulesDir } = scratchPair(t, {
    manifest: EXAMPLE,
    sourceFiles: { 'lib/index.js': 'export const host = 1\n' },
    targetFiles: {
      'package.json': `${JSON.stringify(EXAMPLE, null, 2)}\n`,
      'lib/index.js': 'export const host = 1\n'
    }
  })
  assert.deepEqual(syncShippedPackage({ sourceDir, modulesDir }), [])
  assert.deepEqual(syncShippedPackage({ sourceDir, modulesDir }), [])
})

test('a profile that never installed the package is not touched', (t) => {
  const { sourceDir, modulesDir } = scratchPair(t, { manifest: EXAMPLE })
  assert.deepEqual(syncShippedPackage({ sourceDir, modulesDir }), [])
  assert.equal(fs.existsSync(modulesDir), false, 'nothing is created for a package the profile does not have')
})

test('only a manifest that repeats the package name shadows the package root', (t) => {
  const { targetDir } = scratchPair(t, {
    manifest: EXAMPLE,
    targetFiles: {
      'package.json': `${JSON.stringify(EXAMPLE)}\n`,
      'lib/nested/package.json': `${JSON.stringify(EXAMPLE)}\n`,
      'src/another/package.json': `${JSON.stringify({ name: 'another-package' })}\n`,
      'node_modules/dsh-plugin-example/package.json': `${JSON.stringify(EXAMPLE)}\n`
    }
  })
  assert.deepEqual(shadowManifests(targetDir, EXAMPLE.name), [path.join(targetDir, 'lib', 'nested', 'package.json')])
})

test('the launch refreshes the profile copy before the Harness is spawned', () => {
  const main = read('app/desktop-main.cjs')
  assert.match(main, /const \{ syncShippedPackage \} = require\('\.\/harness-profile\.cjs'\)/)
  assert.match(main, /function syncHarnessProfilePlugin\(\)/)
  assert.match(main, /sourceDir: path\.join\(__dirname, 'plugins', 'mega-core'\)/)
  assert.match(main, /modulesDir: path\.join\(ROOT, 'data', 'profiles', profile, 'node_modules'\)/)
  assert.match(main, /const profile = process\.env\.DSH_PROFILE \|\| 'web'/)
  const refresh = main.indexOf('syncHarnessProfilePlugin()')
  const launch = main.indexOf("logLine('--- DSH launch begin ---')")
  assert.ok(refresh > 0 && launch > 0 && refresh < launch, 'the copy is refreshed before the launch line')
})

test('a launch that dies before its URL is announced carries the Harness own account', () => {
  const main = read('app/desktop-main.cjs')
  assert.match(main, /function harnessOutputTail\(maxLines = 24\)/)
  assert.match(main, /const harness = harnessOutputTail\(\)/)
  assert.match(main, /--- Harness output \(tail\) ---/)
  // The token the child prints in its access URL must never reach a dialog.
  assert.match(main, /const text = redact\(startupOutput\)\.trim\(\)/)
})
