'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createPluginHost } = require('../../app/plugin-host.cjs')

// Catches persisted policy reaching settings readback but not the actual engine.
// Real host, adapters, config files and domain diagnostics; no process restart.
for (const owner of ['health', 'restart']) {
  test(`${owner} saved policy reaches runtime diagnostics after rebuild and reopen`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshns-effective-policy-'))
    const options = { root, configDir: path.join(root, 'config', 'plugins'), lockFile: path.join(root, 'lock.yaml'), restartSupervisorStateDir: path.join(root, 'supervisor') }
    let host = createPluginHost(options)
    const settings = owner === 'health'
      ? { intervalMs: 17000, 'thresholds.throttle.enter': 59, 'maintenance.maxDeferMs': 240000, 'model.debounceSamples': 4 }
      : { 'budget.maxRestarts': 2, 'heartbeat.intervalMs': 6000, 'readiness.maxAttempts': 7 }
    function check() {
      const id = owner === 'health' ? 'dshns.health-scheduler' : 'dshns.restart-supervisor'
      const diagnostics = host.serviceReports().find(entry => entry.id === id).diagnostics
      const config = owner === 'health' ? diagnostics.report.config : diagnostics.config
      if (owner === 'health') {
        assert.equal(config.intervalMs, 17000)
        assert.equal(config.thresholds.throttle.enter, 59)
        assert.equal(config.thresholds.throttle.exit, 45, 'partial policy must retain the default sibling')
        assert.equal(config.maintenance.maxDeferMs, 240000)
        assert.equal(config.model.debounceSamples, 4)
      } else {
        assert.equal(config.budget.maxRestarts, 2)
        assert.equal(config.heartbeat.intervalMs, 6000)
        assert.equal(config.readiness.maxAttempts, 7)
      }
    }
    try {
      await host.ensure()
      assert.equal((await host.setEnabled({ id: 'dshns.health-scheduler', enabled: true })).ok, true)
      const written = await host.configure({ settings })
      assert.equal(written.ok, true, JSON.stringify(written))
      check()
      await host.dispose('policy reopen')
      host = createPluginHost(options)
      await host.ensure()
      check()
    } finally {
      await host.dispose('effective policy teardown')
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
}
