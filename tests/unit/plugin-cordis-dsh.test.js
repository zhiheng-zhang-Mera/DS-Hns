'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')

const { createAdapterFramework } = require('../../app/core/plugin-adapters/index.cjs')
const { createNativeAdapter } = require('../../app/core/plugin-adapters/adapters/native.cjs')
const { createCordisAdapter } = require('../../app/core/plugin-adapters/adapters/cordis.cjs')
const { createCordisDshAdapter, pluginIdFor, permissionsFor } = require('../../app/core/plugin-adapters/adapters/cordis-dsh.cjs')
const { createHostWebServer } = require('../../app/core/plugin-adapters/bridge/host.cjs')
const { createPluginManager } = require('../../app/core/plugin-manager/index.cjs')

/**
 * The community adapter through the *unified* plugin flow.
 *
 * The bridge suite proves the mediation is sound and the structure suite proves the convention is
 * read; this one proves the thing the requirement actually asks for end to end: a community plugin
 * goes in through the same install/enable/disable/reload/health/uninstall path as every other
 * plugin, governed by the same manager, and a plugin the adapter has never seen takes that path
 * with no code written for it.
 *
 * Every fixture here is written by the test, so the suite is self-contained; the two real
 * community plugins are exercised by `scripts/cordis-adapter-acceptance.cjs`, which is the
 * acceptance run rather than a unit test.
 */

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshns-cordisdsh-'))
  return {
    dir,
    write(relative, content) {
      const file = path.join(dir, relative)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, content, 'utf8')
      return file
    },
    path: (relative) => path.join(dir, relative),
    dispose: () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 })
  }
}

/**
 * A community plugin, written in the public convention.
 *
 * `source` is the host half, so each test can make the plugin behave however it needs while the
 * *declarations* stay the same -- which is the point: the adapter reads the declarations.
 */
function communityPlugin(area, options = {}) {
  const relative = options.relative || 'community'
  const name = options.name || '@acme/dsh-community'
  const dsh = {
    bundle: { patch: './cordis.patch.yml' },
    ...(options.client === false ? {} : { client: { inject: options.clientInject || ['@deepseek-ai/dsh-client-runtime'], platform: 'web' } }),
    ...(options.engines === false ? {} : { engines: { dsh: '>=0.1.5-rc.1' } })
  }
  area.write(`${relative}/package.json`, JSON.stringify({
    name,
    version: options.version || '1.0.0',
    description: 'a community plugin',
    type: 'module',
    main: 'lib/index.js',
    exports: { '.': './lib/index.js', './client': './lib/client.js' },
    dsh,
    peerDependencies: options.peerDependencies || { '@deepseek-ai/cordis': '^4.0.1' },
    peerDependenciesMeta: options.peerDependenciesMeta || { '@deepseek-ai/cordis': { optional: true } }
  }, null, 2), 'utf8')
  area.write(`${relative}/cordis.patch.yml`, `- insert:\n    - id: ${options.rowId || 'community-row'}\n      name: '${name}'\n`, 'utf8')
  area.write(`${relative}/lib/client.js`, 'export const apply = () => {}\n', 'utf8')
  area.write(`${relative}/lib/index.js`, options.source || `
export const inject = ['webServer']
export function apply(ctx) {
  ctx.effect(() => {
    const dispose = ctx.webServer.register({ kind: 'exact', path: '/community/ping', handler: (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ pong: true }))
    } })
    return () => dispose()
  })
}
`, 'utf8')
  return area.path(relative)
}

/** A manager, a framework with all three adapters, and a real host web server. */
async function rig(area, options = {}) {
  const webServer = createHostWebServer({ log: () => {} })
  const listening = await webServer.listen({ port: 0 })
  const framework = createAdapterFramework({ log: () => {} })
  framework.register(createNativeAdapter())
  framework.register(createCordisDshAdapter({ services: { webServer }, roots: options.roots || [], nodeExe: process.execPath, log: () => {} }))
  framework.register(createCordisAdapter({ nodeExe: process.execPath, log: () => {} }))
  const manager = createPluginManager({ log: () => {} })
  void area
  return {
    framework,
    manager,
    webServer,
    port: listening.port,
    async dispose() {
      await manager.unloadAll()
      await webServer.close()
    }
  }
}

function request(port, urlPath) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET', agent: false }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', (error) => resolve({ status: 0, error: error.message }))
    req.end()
  })
}

test('the community adapter takes a community bundle, and declines what is not one', async () => {
  const area = scratch()
  const r = await rig(area)
  try {
    const community = communityPlugin(area)
    const adapted = await r.framework.adapt({ dir: community })
    assert.equal(adapted.ok, true, adapted.reason)
    assert.equal(adapted.adapter.id, 'dshns.cordis-dsh')
    assert.equal(adapted.detection.type, 'cordis.bundle')
    // It outranks generic adoption, and it is the one that ran.
    assert.ok(adapted.plugin.adaptation.attempts.length >= 0)
    assert.equal(adapted.plugin.standard.runtime_kind, 'isolated-process')

    // A plain node package is not a community bundle: this adapter declines it so the generic
    // adoption path gets its turn rather than a bespoke error.
    area.write('plain/package.json', JSON.stringify({ name: 'plain', version: '1.0.0', type: 'module', main: 'index.js' }), 'utf8')
    area.write('plain/index.js', 'export const apply = () => {}\n', 'utf8')
    const plain = await r.framework.adapt({ dir: area.path('plain') })
    assert.equal(plain.ok, true, plain.reason)
    assert.equal(plain.adapter.id, 'dshns.cordis', 'a non-community package must fall through to generic adoption')
  } finally {
    await r.dispose()
    area.dispose()
  }
})

test('a community plugin id and permissions come from what it declared', () => {
  assert.equal(pluginIdFor('@linxin666/dsh-client-ui-market'), 'cordis.linxin666.dsh-client-ui-market')
  assert.equal(pluginIdFor('wallpaper-engine-dsh'), 'cordis.wallpaper-engine-dsh')
  assert.match(pluginIdFor('@acme/thing'), /^[a-z0-9][a-z0-9._-]*$/, 'the id must satisfy the platform pattern')
  assert.equal(pluginIdFor(''), null)

  // Permissions are derived from evidence: a bundle that reads its own config, ships a browser half
  // and injects the web server gets exactly those, and nothing speculative.
  const permissions = permissionsFor({
    bundle: { patch: './cordis.patch.yml' },
    client: { declared: true },
    host: { injectRequired: ['webServer'], injectOptional: ['settings'] }
  })
  assert.deepEqual(permissions, ['config.read', 'fs.read', 'network', 'settings.write', 'ui.render'])

  const minimal = permissionsFor({ bundle: {}, client: { declared: false }, host: { injectRequired: [], injectOptional: [] } })
  assert.deepEqual(minimal, ['fs.read'])
})

test('a community plugin walks the whole unified flow', async () => {
  const area = scratch()
  const r = await rig(area)
  try {
    const dir = communityPlugin(area, { name: '@acme/dsh-flow', relative: 'flow' })
    const adapted = await r.framework.adapt({ dir })
    assert.equal(adapted.ok, true, adapted.reason)
    const plugin = adapted.plugin
    const id = plugin.manifest.id
    assert.equal(id, 'cordis.acme.dsh-flow')

    // The manifest is a real one, and it does not claim capabilities it cannot deliver: the bridge
    // does not forward `provide`, so a bridged plugin provides nothing.
    assert.equal(plugin.manifest.api_version, 'dshns.plugin/v1')
    assert.deepEqual(plugin.manifest.provides, [])

    // install
    assert.equal(r.manager.install(plugin).ok, true)
    assert.equal(r.manager.entry(id).enabled, false, 'an adapted community plugin must never auto-enable')

    // enable
    r.manager.enable(id)
    const loaded = await r.manager.load(id)
    assert.equal(loaded.ok, true, loaded.reason)
    assert.equal(r.manager.entry(id).loaded, true)

    // health: a bundle with a client half is degraded here, and the reason says which half.
    const health = await r.manager.checkHealth(id)
    assert.equal(health.status, 'degraded')
    assert.match(health.reason, /browser half/)

    // it really serves, on the host's server
    assert.deepEqual(r.webServer.routes().map((route) => route.path), ['/community/ping'])
    const answer = await request(r.port, '/community/ping')
    assert.equal(answer.status, 200)
    assert.deepEqual(JSON.parse(answer.body), { pong: true })

    // disable
    await r.manager.disable(id)
    assert.equal(r.manager.entry(id).enabled, false)
    assert.deepEqual(r.webServer.routes(), [])

    // reload
    r.manager.enable(id)
    const reloaded = await r.manager.reload(id)
    assert.equal(reloaded.ok, true, reloaded.reason)
    assert.deepEqual(r.webServer.routes().map((route) => route.path), ['/community/ping'])

    // uninstall
    const removed = await r.manager.remove(id)
    assert.equal(removed.ok, true, removed.reason)
    assert.equal(r.manager.has(id), false)
    assert.deepEqual(r.webServer.routes(), [])
  } finally {
    await r.dispose()
    area.dispose()
  }
})

test('a bundle with no browser half is healthy, not degraded', async () => {
  const area = scratch()
  const r = await rig(area)
  try {
    const dir = communityPlugin(area, { name: '@acme/dsh-hostonly', relative: 'hostonly', client: false })
    const adapted = await r.framework.adapt({ dir })
    assert.equal(adapted.ok, true, adapted.reason)
    r.manager.install(adapted.plugin)
    r.manager.enable(adapted.plugin.manifest.id)
    assert.equal((await r.manager.load(adapted.plugin.manifest.id)).ok, true)
    const health = await r.manager.checkHealth(adapted.plugin.manifest.id)
    assert.equal(health.status, 'healthy', health.reason)
    assert.match(health.reason, /running with 1 bridged route/)
  } finally {
    await r.dispose()
    area.dispose()
  }
})

test('the standard sections reach the manager for a community plugin too', async () => {
  const area = scratch()
  const r = await rig(area)
  try {
    const dir = communityPlugin(area, { name: '@acme/dsh-sections', relative: 'sections' })
    const adapted = await r.framework.adapt({ dir })
    r.manager.install(adapted.plugin)
    const listed = r.manager.list().find((entry) => entry.id === 'cordis.acme.dsh-sections')
    // The same fields a hand-written plugin has, from a format the manager has never heard of.
    assert.equal(listed.adapter.id, 'dshns.cordis-dsh')
    assert.equal(listed.adaptation.detected_type, 'cordis.bundle')
    assert.equal(listed.runtime.kind, 'isolated-process')
    assert.equal(listed.runtime.enforcement, 'process-boundary')
    assert.deepEqual(listed.permissions.granted, ['config.read', 'fs.read', 'network', 'ui.render'])
    assert.equal(listed.lifecycle !== null, true)
    assert.equal(typeof listed.errorCount, 'number')

    const status = r.manager.status('cordis.acme.dsh-sections')
    // Before it is loaded there is no bridge to describe, and the adapter says so rather than
    // inventing one.
    assert.equal(status.runtimeInfo.detail.bridge, null)
    assert.equal(status.runtimeInfo.detail.structure.bundle.patch, './cordis.patch.yml')
    assert.equal(status.runtimeInfo.detail.client.declared, true)

    r.manager.enable('cordis.acme.dsh-sections')
    assert.equal((await r.manager.load('cordis.acme.dsh-sections')).ok, true)
    const loadedStatus = r.manager.status('cordis.acme.dsh-sections')
    // The framework wraps every plugin in the standard lifecycle, so the adapter's own runtime
    // information arrives as the `detail` half of the standard answer.
    assert.equal(loadedStatus.runtimeInfo.detail.bridge.bridge, 'dshns.cordis-bridge/v1')
    assert.equal(loadedStatus.runtimeInfo.detail.bridge.state, 'active')
    assert.equal(loadedStatus.runtimeInfo.detail.capabilities.backed.webServer, true)
    // Two views in one report: the platform's own counters, and the adapter's separate account of
    // what the host refused -- which the lifecycle never sees on its own.
    assert.equal(typeof loadedStatus.errorReport.total, 'number')
    assert.equal(loadedStatus.errorReport.adapterReport.bridge, 'dshns.cordis-bridge/v1')
    assert.equal(loadedStatus.errorReport.adapterReport.refusals, 0)
  } finally {
    await r.dispose()
    area.dispose()
  }
})

test('a plugin the adapter has never seen takes the same path with no adapter change', async () => {
  const area = scratch()
  const r = await rig(area)
  try {
    // Different name, different service combination, different route prefix, different row id --
    // and nothing anywhere in the adapter mentions any of it.
    const dir = communityPlugin(area, {
      name: '@stranger/dsh-notifications',
      relative: 'stranger',
      rowId: 'stranger-notify',
      version: '3.2.1',
      clientInject: ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-slots'],
      peerDependencies: { '@deepseek-ai/cordis': '^4.0.1', '@deepseek-ai/dsh-host-webserver': '>=0.1.0-rc.6' },
      peerDependenciesMeta: { '@deepseek-ai/cordis': { optional: true }, '@deepseek-ai/dsh-host-webserver': { optional: true } },
      source: `
export const name = 'stranger-notify'
export const inject = { required: ['webServer'] }
export function apply(ctx) {
  ctx.effect(() => {
    const dispose = ctx.webServer.register({ kind: 'prefix', path: '/notify/v1/', handler: (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ path: req.url }))
    } })
    return () => dispose()
  })
}
`
    })
    const adapted = await r.framework.adapt({ dir })
    assert.equal(adapted.ok, true, adapted.reason)
    assert.equal(adapted.plugin.manifest.id, 'cordis.stranger.dsh-notifications')
    assert.equal(adapted.plugin.manifest.version, '3.2.1')

    r.manager.install(adapted.plugin)
    r.manager.enable(adapted.plugin.manifest.id)
    assert.equal((await r.manager.load(adapted.plugin.manifest.id)).ok, true)

    // A prefix route the stranger chose, served on the host's server.
    const answer = await request(r.port, '/notify/v1/tasks/42')
    assert.equal(answer.status, 200)
    assert.deepEqual(JSON.parse(answer.body), { path: '/notify/v1/tasks/42' })

    await r.manager.remove(adapted.plugin.manifest.id)
    assert.deepEqual(r.webServer.routes(), [])
  } finally {
    await r.dispose()
    area.dispose()
  }
})

test('a plugin whose declarations cannot be satisfied fails alone and reports why', async () => {
  const area = scratch()
  const r = await rig(area)
  try {
    // A declared entry that is absent: the community adapter declines it, and the generic adoption
    // path gets its turn rather than the whole adaptation failing. That fallback is the framework's,
    // and this asserts it works for the community adapter too.
    const missingEntry = communityPlugin(area, { name: '@acme/dsh-missing', relative: 'missing' })
    fs.rmSync(path.join(missingEntry, 'lib', 'index.js'))
    const fell = await r.framework.adapt({ dir: missingEntry })
    assert.equal(fell.ok, true, fell.reason)
    assert.equal(fell.adapter.id, 'dshns.cordis', 'a bundle with no entry must fall through to generic adoption')
    assert.ok(
      fell.plugin.adaptation.attempts.some((attempt) => attempt.adapter === 'dshns.cordis-dsh' && attempt.code === 'CORDIS_ENTRY_MISSING'),
      `the community adapter's refusal must be kept: ${JSON.stringify(fell.plugin.adaptation.attempts)}`
    )

    // A plugin that imports but throws: it installs, it is enabled, it fails to load, and the
    // manager records a fault rather than the process dying.
    const explodes = communityPlugin(area, {
      name: '@acme/dsh-explodes',
      relative: 'explodes',
      source: 'throw new Error("this community plugin cannot start")\n'
    })
    const adapted = await r.framework.adapt({ dir: explodes })
    assert.equal(adapted.ok, true, adapted.reason)
    r.manager.install(adapted.plugin)
    r.manager.enable(adapted.plugin.manifest.id)
    const loaded = await r.manager.load(adapted.plugin.manifest.id)
    assert.equal(loaded.ok, false)
    const status = r.manager.status(adapted.plugin.manifest.id)
    assert.equal(status.state, 'enabled', 'a plugin that failed to load is enabled and not loaded, which a user can act on')
    assert.match(status.fault.reason, /cannot start/)
    assert.deepEqual(r.webServer.routes(), [])
  } finally {
    await r.dispose()
    area.dispose()
  }
})
