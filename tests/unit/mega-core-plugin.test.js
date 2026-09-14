'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const { createGovernanceBridge } = require('../../app/core/governance-bridge.cjs')

/**
 * The Mega Core Plugin's host half (`updateplan/pluginize.md` Phase 1).
 *
 * The plugin package is the thing that makes Mega appear inside the official UI, and the host half is the only
 * part of it that can be verified without a browser: it must mount its routes on the Harness' web server, mirror
 * DS-Hns' governance bridge faithfully — including "unavailable" — and unwind everything when it is unloaded.
 */

const ROOT = path.resolve(__dirname, '..', '..')
const PLUGIN = path.join(ROOT, 'app', 'plugins', 'mega-core')
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8')

/** The host half is ESM, so it is imported by URL like the Cordis loader would. */
async function loadHost() {
  return import(pathToFileURL(path.join(PLUGIN, 'lib', 'index.js')).href)
}

/** A stub web server that records registrations and can call them, like the Harness' own service. */
function stubWebServer() {
  const routes = new Map()
  const disposed = []
  return {
    routes,
    disposed,
    register({ kind, path: routePath, handler }) {
      routes.set(routePath, { kind, handler })
      return () => {
        disposed.push(routePath)
        routes.delete(routePath)
      }
    }
  }
}

/** A request/response pair with just what the handlers use. */
function fakeExchange({ method = 'GET', body = null } = {}) {
  const request = {
    method,
    _handlers: new Map(),
    on(event, handler) {
      this._handlers.set(event, handler)
      return this
    },
    _send(payload) {
      // A string body is already JSON (that is what a request carries); an object is serialised like `fetch` does.
      const text = payload === null || payload === undefined ? '' : (typeof payload === 'string' ? payload : JSON.stringify(payload))
      this._handlers.get('data')?.(Buffer.from(text))
      this._handlers.get('end')?.()
    },
    destroy() {}
  }
  const response = {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) { this.headers[name] = value },
    end(text) { this.body = text }
  }
  if (body !== null) setImmediate(() => request._send(body))
  return { request, response }
}

test('the package declares the bundle patch, the client half and the web platform', () => {
  const pkg = JSON.parse(read('app/plugins/mega-core/package.json'))
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.deepEqual(pkg.dsh.client.inject, ['@deepseek-ai/dsh-client-runtime'])
  assert.equal(pkg.dsh.client.immediately, true)
  assert.equal(pkg.exports['./client'], './lib/client.js')
  assert.equal(pkg.type, 'module')
  // The patch inserts one host row and never overrides a shipped one (a patch replaces a row's whole config).
  const patch = read('app/plugins/mega-core/cordis.patch.yml')
  assert.match(patch, /^- insert:/m)
  assert.match(patch, /- id: mega-core/)
  assert.match(patch, /name: 'dsh-plugin-mega-core'/)
  assert.equal(/- remove:|replace:/.test(patch), false, 'the patch must be additive only')
})

test('the host half mounts its three routes and unwinds them on unload', async () => {
  const host = await loadHost()
  const server = stubWebServer()
  const dispose = host.apply({ webServer: server })
  assert.deepEqual([...server.routes.keys()].sort(), ['/mega-core/action', '/mega-core/governance', '/mega-core/health'])
  for (const route of server.routes.values()) assert.equal(route.kind, 'exact')
  assert.equal(typeof dispose, 'function')
  dispose()
  assert.equal(server.routes.size, 0, 'the routes outlived the plugin')
  assert.deepEqual(server.disposed.sort(), ['/mega-core/action', '/mega-core/governance', '/mega-core/health'])
  // `inject` is what makes the loader wait for the web server, so it must be declared.
  assert.deepEqual(host.inject, ['webServer'])
  assert.equal(host.name, 'dsh-plugin-mega-core')
})

test('the host half mirrors DS-Hns\' governance bridge, token and all', async () => {
  const host = await loadHost()
  // The bridge writes `<stateDir>/governance-bridge.json`, and the plugin looks for
  // `<DSH_HOME>/state/governance-bridge.json` — the same relationship the product has with `data/` and
  // `data/state/`.
  const dshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshns-mega-core-'))
  const stateDir = path.join(dshHome, 'state')
  const bridge = createGovernanceBridge({
    stateDir,
    snapshot: () => ({ protection: { modules: [{ id: 'mega-dock', state: 'HEALTHY' }], degraded: [], failed: [] }, boot: { state: 'ENHANCED' } }),
    act: async ({ action, id }) => ({ ok: action === 'retry', action, id, reason: action === 'retry' ? null : 'refused by the layer' }),
    log: () => {}
  })
  await bridge.start()
  try {
    const env = { DSH_HOME: dshHome }
    const server = stubWebServer()
    host.apply({ webServer: server }, { env })

    const health = fakeExchange()
    await server.routes.get('/mega-core/health').handler(health.request, health.response)
    const healthBody = JSON.parse(health.response.body)
    assert.equal(healthBody.ok, true)
    assert.equal(healthBody.governance.available, true)
    assert.equal(healthBody.governance.port, bridge.describe().port)

    const governance = fakeExchange()
    await server.routes.get('/mega-core/governance').handler(governance.request, governance.response)
    assert.equal(governance.response.statusCode, 200)
    assert.equal(JSON.parse(governance.response.body).protection.modules[0].id, 'mega-dock')

    const retry = fakeExchange({ method: 'POST', body: JSON.stringify({ action: 'retry', id: 'mega-dock' }) })
    await server.routes.get('/mega-core/action').handler(retry.request, retry.response)
    assert.equal(retry.response.statusCode, 200)
    assert.equal(JSON.parse(retry.response.body).ok, true)

    // A refused action keeps the bridge's own status: the plugin does not turn a refusal into a success.
    const refused = fakeExchange({ method: 'POST', body: JSON.stringify({ action: 'repair', id: 'mega-dock' }) })
    await server.routes.get('/mega-core/action').handler(refused.request, refused.response)
    assert.equal(refused.response.statusCode, 409)
    assert.match(JSON.parse(refused.response.body).result.reason, /refused by the layer/)

    // A GET on the action route is refused by method, not silently treated as a read.
    const wrongMethod = fakeExchange({ method: 'GET' })
    await server.routes.get('/mega-core/action').handler(wrongMethod.request, wrongMethod.response)
    assert.equal(wrongMethod.response.statusCode, 405)
  } finally {
    await bridge.stop()
    fs.rmSync(dshHome, { recursive: true, force: true })
  }
})

test('when DS-Hns is not running the plugin says so instead of inventing an answer', async () => {
  const host = await loadHost()
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshns-mega-core-empty-'))
  try {
    const server = stubWebServer()
    host.apply({ webServer: server }, { env: { DSH_HOME: stateDir } })
    const health = fakeExchange()
    await server.routes.get('/mega-core/health').handler(health.request, health.response)
    const healthBody = JSON.parse(health.response.body)
    assert.equal(healthBody.ok, true, 'the plugin itself is up')
    assert.equal(healthBody.governance.available, false)
    assert.match(healthBody.governance.reason, /not running|no governance bridge file/)

    const governance = fakeExchange()
    await server.routes.get('/mega-core/governance').handler(governance.request, governance.response)
    assert.equal(governance.response.statusCode, 503)
    const body = JSON.parse(governance.response.body)
    assert.equal(body.ok, false)
    assert.equal(body.available, false)
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
})

test('a bridge file that claims a non-loopback host is refused', async () => {
  const host = await loadHost()
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshns-mega-core-far-'))
  try {
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true })
    fs.writeFileSync(path.join(stateDir, 'state', 'governance-bridge.json'), JSON.stringify({ host: '10.0.0.5', port: 1, token: 'x' }), 'utf8')
    const discovery = host.readDiscovery({ DSH_HOME: stateDir })
    assert.equal(discovery.available, false)
    assert.match(discovery.reason, /not loopback/)
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
})
