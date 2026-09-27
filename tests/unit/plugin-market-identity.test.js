'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..', '..')
const TEST_ROOT = process.env.DSH_TEST_ROOT || path.join(ROOT, 'test-artifacts')
const { canonicalizeInstalledRows, patchPluginMarket } = require('../../app/runtime/plugin-market-canonical.cjs')

test('one logical plugin becomes one row and retains discovery providers', () => {
  const rows = canonicalizeInstalledRows([
    { pluginId: 'scheduler', localName: 'dsh-health-scheduler', version: '2.0.1', source: 'profile' },
    { pluginId: 'scheduler', localName: 'dsh-health-scheduler-2.0.1', version: '2.0.1', source: 'skills' },
    { pluginId: null, localName: 'dshns.restart-supervisor', source: 'profile' },
    { pluginId: null, localName: 'dsh-restart-supervisor', version: '1.0.1', source: 'profile' }
  ])
  assert.equal(rows.length, 2)
  assert.deepEqual(rows[0].providers, ['profile', 'skills'])
  assert.equal(rows[1].localName, 'dshns.restart-supervisor')
  assert.equal(rows[1].version, '1.0.1')
})

test('the pinned Plugin Market materialization is patched idempotently and fails closed on drift', () => {
  fs.mkdirSync(TEST_ROOT, { recursive: true })
  const profile = fs.mkdtempSync(path.join(TEST_ROOT, 'market-patch-'))
  const pkg = path.join(profile, 'node_modules', '@dsh-market', 'plugin')
  fs.mkdirSync(path.join(pkg, 'lib'), { recursive: true })
  try {
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ version: '0.4.7' }))
    fs.writeFileSync(path.join(pkg, 'lib', 'index.js'), 'function apply(ctx) {\ncase "installed": return (await market()).plugins && scanInstalled(cfg, await market()).map((i) => ({\n}')
    fs.writeFileSync(path.join(pkg, 'lib', 'client.js'), 'x(`${i.version ?? "未知版本"} · ${i.source === "skills" ? "skill" : "profile"}`)')
    assert.deepEqual(patchPluginMarket({ profileDir: profile }), { state: 'patched', changed: true, version: '0.4.7' })
    assert.deepEqual(patchPluginMarket({ profileDir: profile }), { state: 'patched', changed: false, version: '0.4.7' })
    assert.match(fs.readFileSync(path.join(pkg, 'lib', 'index.js'), 'utf8'), /canonicalInstalled\(scanInstalled/)
    assert.match(fs.readFileSync(path.join(pkg, 'lib', 'client.js'), 'utf8'), /providers\?\.length/)

    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ version: '0.4.9' }))
    assert.throws(() => patchPluginMarket({ profileDir: profile }), /supports 0\.4\.7, found 0\.4\.9/)
  } finally {
    fs.rmSync(profile, { recursive: true, force: true })
  }
})

test('the Harness patches the materialized market before launch', () => {
  const source = fs.readFileSync(path.join(ROOT, 'app', 'runtime', 'harness-service.cjs'), 'utf8')
  assert.match(source, /patchPluginMarket\(\{ profileDir:/)
  assert.doesNotMatch(source, /DSH_PROFILES_DIR/)
})
