'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createPluginManager } = require('../../app/core/plugin-manager/index.cjs')
const { createHealthSchedulerPlugin } = require('../../app/plugins/health-scheduler/index.cjs')

// Break caught: retaining load-time optional authority availability after a
// provider appears or disappears. Real manager/registry and monitor; only the
// authority's potentially destructive operation is a non-acting fixture.
for (const observation of ['health', 'diagnostics', 'tick']) {
  test(`${observation} follows late restart authority registration and removal`, async () => {
    const manager = createPluginManager({ log: () => {} })
    let requests = 0
    const monitor = createHealthSchedulerPlugin({
      readings: () => ({ memory: { value: 20, warn: 70, critical: 92 }, cpu: { value: 20, warn: 75, critical: 95 }, runtime: { value: 0, warn: 60, critical: 90 } }),
      config: { sampling: { intervalMs: 60000 } }
    })
    const authority = {
      manifest: { api_version: 'dshns.plugin/v1', id: 'test.late-authority', name: 'Late authority fixture', version: '1.0.0', provides: ['restart-control'], default_enabled: true },
      load(context) { context.provide('restart-control', { request() { requests++; return { accepted: true } }, getRestartHistory() { return { attempts: [] } } }); return { ok: true } }
    }
    async function available() {
      if (observation === 'health') return (await manager.checkHealth(monitor.manifest.id)).detail.restart.available
      if (observation === 'tick') {
        const { sample } = await monitor.tick()
        return sample.enrichment.restartHistory !== null
      }
      return monitor.diagnostics().restart.available
    }
    try {
      assert.equal(manager.install(monitor).ok, true)
      manager.enable(monitor.manifest.id)
      assert.equal((await manager.load(monitor.manifest.id)).ok, true)
      assert.equal(await available(), false)
      assert.equal(manager.install(authority).ok, true)
      assert.equal((await manager.load(authority.manifest.id)).ok, true)
      assert.equal(manager.registry.has('restart-control'), true)
      assert.equal(await available(), true, 'late provider remains reported unavailable')
      await manager.disable(authority.manifest.id)
      assert.equal(manager.registry.has('restart-control'), false)
      assert.equal(await available(), false, 'removed provider remains reported available')
      assert.equal(requests, 0, 'status/sampling under low pressure must not request a restart')
    } finally { await manager.unloadAll() }
  })
}
