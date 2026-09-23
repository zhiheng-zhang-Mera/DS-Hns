'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createPluginHost } = require('../../app/plugin-host.cjs')

// Regression: rebuilding the plugin world after an advanced write must not
// silently discard an operator's explicit enable decision.
test('enabled Health Scheduler remains loaded after changing its sampling interval', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshns-enable-continuity-'))
  const host = createPluginHost({ root: dir, configDir: path.join(dir, 'config', 'plugins'), lockFile: path.join(dir, 'lock.yaml') })
  try {
    assert.notEqual((await host.ensure()).ok, false)
    assert.equal((await host.setEnabled({ id: 'dshns.health-scheduler', enabled: true })).ok, true)
    const before = host.serviceReports().find((entry) => entry.id === 'dshns.health-scheduler')
    assert.equal(before.enabled, true)
    assert.equal(before.loaded, true)
    const written = await host.configure({ settings: { intervalMs: 16000 } })
    assert.equal(written.ok, true, JSON.stringify(written))
    const after = host.serviceReports().find((entry) => entry.id === 'dshns.health-scheduler')
    assert.equal(after.enabled, true, 'advanced configuration discarded explicit enable')
    assert.equal(after.loaded, true, 'sampling stopped after a successful configuration write')
  } finally {
    await host.dispose('enable continuity test teardown')
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('explicit disable survives configuration rebuild and a new host', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshns-disable-continuity-'))
  const options = { root: dir, configDir: path.join(dir, 'config', 'plugins'), lockFile: path.join(dir, 'lock.yaml') }
  let host = createPluginHost(options)
  try {
    await host.ensure()
    assert.equal((await host.setEnabled({ id: 'dshns.telemetry', enabled: false })).ok, true)
    assert.equal((await host.configure({ settings: { intervalMs: 16000 } })).ok, true)
    assert.equal(host.serviceReports().find((entry) => entry.id === 'dshns.telemetry').enabled, false)
    await host.dispose('new host boundary')
    host = createPluginHost(options)
    await host.ensure()
    const report = host.serviceReports().find((entry) => entry.id === 'dshns.telemetry')
    assert.equal(report.enabled, false)
    assert.equal(report.loaded, false)
  } finally {
    await host.dispose('test teardown')
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('explicit enable survives a new host while a fresh profile remains default off', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshns-enable-reopen-'))
  const options = { root: dir, configDir: path.join(dir, 'config', 'plugins'), lockFile: path.join(dir, 'lock.yaml') }
  let host = createPluginHost(options)
  try {
    await host.ensure()
    assert.equal(host.serviceReports().find((entry) => entry.id === 'dshns.health-scheduler').enabled, false)
    assert.equal((await host.setEnabled({ id: 'dshns.health-scheduler', enabled: true })).ok, true)
    await host.dispose('new host boundary')
    host = createPluginHost(options)
    await host.ensure()
    const report = host.serviceReports().find((entry) => entry.id === 'dshns.health-scheduler')
    assert.equal(report.enabled, true)
    assert.equal(report.loaded, true)
  } finally {
    await host.dispose('test teardown')
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
