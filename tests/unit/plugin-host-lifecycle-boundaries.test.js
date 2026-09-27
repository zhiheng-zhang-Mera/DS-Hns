'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createPluginHost } = require('../../app/plugin-host.cjs')

test('store installation default does not erase a later explicit disable', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshns-lifecycle-store-'))
  const dir = path.join(root, 'data', 'plugins', 'store', 'fixture')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'index.cjs'), `module.exports = {
    manifest: { api_version: 'dshns.plugin/v1', id: 'fixture.lifecycle', name: 'Lifecycle fixture', version: '1.0.0', provides: [], default_enabled: false, fault_level: 'soft' },
    async load() {}, async healthCheck() { return { status: 'healthy' } }
  }`)
  fs.writeFileSync(path.join(root, 'data', 'plugins', 'installed.json'), JSON.stringify({version: 1, plugins: [{id: 'fixture.lifecycle', dir, main: 'index.cjs', enabled: true, version: '1.0.0'}]}))
  let host = createPluginHost({ root })
  try {
    await host.ensure()
    assert.equal(host.list().plugins.find(x => x.id === 'fixture.lifecycle').loaded, true)
    assert.equal((await host.setEnabled({id: 'fixture.lifecycle', enabled: false})).ok, true)
    assert.equal((await host.configure({settings: {intervalMs: 16000}})).ok, true)
    assert.equal(host.list().plugins.find(x => x.id === 'fixture.lifecycle').loaded, false)
    await host.dispose('new host boundary')
    host = createPluginHost({ root })
    await host.ensure()
    const report = host.list().plugins.find(x => x.id === 'fixture.lifecycle')
    assert.equal(report.enabled, false)
    assert.equal(report.loaded, false)
  } finally {
    await host.dispose('store boundary teardown')
    fs.rmSync(root, { recursive: true, force: true })
  }
})

for (const malformed of ['{broken', '[]', 'null']) {
  test(`enable refuses malformed config without changing lifecycle: ${malformed}`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshns-lifecycle-boundary-'))
    const host = createPluginHost({ root })
    try {
      await host.ensure()
      const dir = path.join(root, 'config', 'plugins')
      fs.mkdirSync(dir, { recursive: true })
      const file = path.join(dir, 'dshns.health-scheduler.json')
      fs.writeFileSync(file, malformed)
      const result = await host.setEnabled({ id: 'dshns.health-scheduler', enabled: true })
      assert.equal(result.ok, false)
      assert.equal(result.code, 'CONFIG_UNREADABLE')
      assert.equal(fs.readFileSync(file, 'utf8'), malformed)
      const report = host.serviceReports().find(x => x.id === 'dshns.health-scheduler')
      assert.equal(report.enabled, false)
      assert.equal(report.loaded, false)
    } finally {
      await host.dispose('boundary teardown')
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
}

test('unwritable config parent refuses enable without changing lifecycle', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshns-lifecycle-write-'))
  const dir = path.join(root, 'config-blocked')
  const host = createPluginHost({ root, configDir: dir })
  try {
    await host.ensure()
    fs.writeFileSync(dir, 'not a directory')
    const result = await host.setEnabled({ id: 'dshns.health-scheduler', enabled: true })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'CONFIG_UNWRITABLE')
    assert.equal(host.serviceReports().find(x => x.id === 'dshns.health-scheduler').enabled, false)
    assert.equal(fs.readFileSync(dir, 'utf8'), 'not a directory')
  } finally {
    await host.dispose('boundary teardown')
    fs.rmSync(root, { recursive: true, force: true })
  }
})
