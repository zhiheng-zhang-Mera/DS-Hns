'use strict'

/**
 * Does the extension load, install its feature gate and register the feature channels?
 *
 * The feature registry is data; this is the wiring. The check is deliberately about the
 * shipped file rather than a stubbed module, because the failure this guards against is the
 * one that is invisible to a unit test of `features.cjs`: a registry that nothing consults.
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..', '..')
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8')

test('the extension installs the feature gate before it registers its channels', () => {
  const mega = read('app/extensions/mega/index.cjs')
  assert.match(mega, /const \{ MEGA_FEATURES, FEATURE_GROUPS, featureFor, featureForChannel, createFeatureState \} = require\('\.\/features\.cjs'\)/)
  assert.match(mega, /function installFeatureGate\(\)/)
  assert.match(mega, /function registerFeatureIpc\(\)/)
  assert.match(mega, /function pushFeatureState\(\)/)
  assert.match(mega, /features: \(\(\) => \{/)
  // The gate is a wrapper, so a channel registered *after* it is gated without the
  // registration having to remember; the order in `start()` is therefore load-bearing.
  const start = mega.slice(mega.indexOf('  loadDockState()'), mega.indexOf('  notificationService.setCreateNotification'))
  assert.match(start, /installFeatureGate\(\)\s*\n\s*registerIpc\(\)/, 'the gate must be installed before registerIpc()')
  assert.match(start, /pushFeatureState\(\)/, 'the dock must learn the feature map before its first paint')
  // The manager's own channels are registered last and are not themselves feature-gated:
  // switching a feature off is how a user fixes one.
  assert.match(mega, /registerCompatibilityIpc\(\)\s*\n\s*\/\/[^\n]*\n\s*registerFeatureIpc\(\)|registerCompatibilityIpc\(\)[\s\S]{0,200}registerFeatureIpc\(\)/)
  assert.match(mega, /ipcMain\.handle\('mega:features-snapshot'/)
  assert.match(mega, /ipcMain\.handle\('mega:features-set'/)
  // The map is pushed to the dock, whose preload gates the chokepoint every renderer call
  // goes through.
  assert.match(mega, /dockTarget\.send\('mega:features'/)
})

test('the state file lives under data/state and the registry is consulted, not restated', () => {
  const mega = read('app/extensions/mega/index.cjs')
  assert.match(mega, /path\.join\(PATHS\.ROOT, 'data', 'state', 'mega-features\.json'\)/)
  const features = read('app/extensions/mega/features.cjs')
  assert.match(features, /const MEGA_FEATURES = Object\.freeze\(\[/)
  const listed = [...features.matchAll(/id: '(mega\.[a-z-]+)'/g)].map((match) => match[1])
  assert.ok(listed.length >= 10, `the registry should list the dock's features (${listed.length})`)
  // One registry: the extension asks it questions rather than carrying a second copy of the
  // set. (A single id in a `switch` — the computer-use case — is not a second copy.)
  assert.match(mega, /featureForChannel\(channel\)/)
  assert.match(mega, /featureFor\(id\)/)
  assert.match(mega, /features\(\)\.isEnabled\(/)
  const restated = /const\s+\w*FEATURES\w*\s*=\s*(?:\[|\{)/.test(mega)
  assert.equal(restated, false, 'the extension declares a second feature table')
})
