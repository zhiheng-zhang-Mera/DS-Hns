'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')

const { createCordisBridge, createHostWebServer } = require('../../app/core/plugin-adapters/bridge/host.cjs')
const {
  BRIDGE_FAULT_CODES,
  BRIDGE_CAPABILITIES,
  BRIDGE_CAPABILITY_IDS,
  validateBridgeCall,
  normalizeRoutePath
} = require('../../app/core/plugin-adapters/bridge/contract.cjs')

/**
 * The controlled bridge.
 *
 * The requirement this file exists for is one sentence long: *a Cordis plugin must never be given
 * an HNS Core object, and every interaction must go through a controlled bridge.* That is easy to
 * claim and easy to get wrong, because the wrong version still activates, still serves and still
 * looks like it works -- it just hands the plugin a real service it can call anything on.
 *
 * So the tests are shaped as interrogations. A probe plugin reports exactly what its context
 * contains, and the assertions are exact allow-lists; a hostile plugin tries the members the bridge
 * is supposed to withhold; and the host-side validator is exercised directly, because a check that
 * only runs in the plugin's own process is a check the plugin's own process can skip.
 */

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshns-bridge-'))
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

/** A minimal community plugin whose host half is the given source. */
function pluginWith(area, source, overrides = {}) {
  const relative = overrides.relative || 'plugin'
  area.write(`${relative}/package.json`, JSON.stringify({
    name: overrides.name || '@acme/probe',
    version: '1.0.0',
    type: 'module',
    main: 'index.js',
    exports: { '.': './index.js' },
    dsh: { bundle: { patch: './cordis.patch.yml' } }
  }), 'utf8')
  area.write(`${relative}/cordis.patch.yml`, '- insert:\n    - id: probe\n', 'utf8')
  area.write(`${relative}/index.js`, source, 'utf8')
  return area.path(relative)
}

function request(port, urlPath, options = {}) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: options.method || 'GET', path: urlPath, headers: options.headers || {}, agent: false },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
      }
    )
    req.on('error', (error) => resolve({ status: 0, error: error.message }))
    if (options.body) req.write(options.body)
    req.end()
  })
}

/** A host web server plus a bridge over one plugin, with teardown that always runs. */
async function harness(area, source, options = {}) {
  const webServer = createHostWebServer({ log: () => {} })
  const listening = await webServer.listen({ port: 0 })
  const dir = pluginWith(area, source, options)
  const bridge = createCordisBridge({
    id: options.id || 'acme.probe',
    dir,
    entry: 'index.js',
    roots: options.roots || [],
    services: { webServer },
    log: () => {}
  })
  return {
    bridge,
    webServer,
    port: listening.port,
    dir,
    async dispose() {
      await bridge.stop()
      await webServer.close()
    }
  }
}

test('the plugin context is built locally, and every service on it is an allow-list', async () => {
  const area = scratch()
  const rig = await harness(area, `
export const inject = ['webServer']
export function apply(ctx, config) {
  // Report exactly what this process was handed: the keys, and the members of each service.
  ctx.effect(() => {
    ctx.webServer.register({
      kind: 'exact',
      path: '/probe/context',
      handler: (req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          contextKeys: Object.keys(ctx).sort(),
          webServerMembers: Object.keys(ctx.webServer).sort(),
          settingsMembers: Object.keys(ctx.settings).sort(),
          requireResult: ctx.require('webServer'),
          hasUnknown: ctx.has('database'),
          hasWebServer: ctx.has('webServer'),
          configKeys: Object.keys(config || {})
        }))
      }
    })
    return () => {}
  })
}
`, { id: 'acme.probe' })
  try {
    const activated = await rig.bridge.activate()
    assert.equal(activated.ok, true, activated.reason)
    assert.equal(rig.webServer.routes().length, 1, 'the route must be mounted on the host, not in the plugin')

    const response = await request(rig.port, '/probe/context')
    assert.equal(response.status, 200)
    const seen = JSON.parse(response.body.toString('utf8'))

    // The context contains exactly these keys. A new key appearing here is a new thing a community
    // plugin can reach, which is the decision this assertion exists to force somebody to make.
    assert.deepEqual(seen.contextKeys, [
      'baseDir', 'clearImmediate', 'clearInterval', 'clearTimeout', 'config', 'effect', 'emit', 'get',
      'has', 'id', 'inject', 'log', 'logger', 'name', 'on', 'provide', 'require', 'root',
      'set', 'setImmediate', 'setInterval', 'setTimeout', 'settings', 'webServer'
    ])

    // webServer is the proxy, and the proxy has one method. Everything the real service has that
    // the bridge withholds is simply not there: no `server`, no `registerFallback`, no `listen`.
    assert.deepEqual(seen.webServerMembers, ['register'])
    for (const withheld of BRIDGE_CAPABILITIES.webServer.withholds) {
      assert.equal(withheld in seen.webServerMembers, false, `${withheld} is reachable on the bridged webServer`)
    }
    assert.deepEqual(seen.settingsMembers, ['installSection', 'register'])

    // There is no capability resolution across the bridge in either direction.
    assert.equal(seen.requireResult, null)
    assert.equal(seen.hasUnknown, false)
    assert.equal(seen.hasWebServer, true)
  } finally {
    await rig.dispose()
    area.dispose()
  }
})

test('a capability the bridge does not provide is refused by name, not stubbed', async () => {
  const area = scratch()
  const rig = await harness(area, `
export const inject = { required: ['webServer'], optional: ['database'] }
export function apply(ctx) {
  let injectedWithDatabase = false
  ctx.inject(['database'], () => { injectedWithDatabase = true })
  ctx.effect(() => {
    ctx.webServer.register({ kind: 'exact', path: '/probe/inject', handler: (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ injectedWithDatabase, databaseService: ctx.database === undefined ? 'absent' : typeof ctx.database }))
    } })
    return () => {}
  })
}
`, { id: 'acme.inject' })
  try {
    const activated = await rig.bridge.activate()
    assert.equal(activated.ok, true, activated.reason)
    const response = await request(rig.port, '/probe/inject')
    const seen = JSON.parse(response.body.toString('utf8'))
    // The `inject` callback was not called with a stub: a plugin that asks for something absent
    // takes the branch it wrote for "absent", which is the whole point of optional injection.
    assert.equal(seen.injectedWithDatabase, false)
    assert.equal(seen.databaseService, 'absent')
    // And the refusal is on the record.
    const refusals = rig.bridge.refusals
    assert.ok(refusals.some((entry) => entry.code === BRIDGE_FAULT_CODES.UNKNOWN_CAPABILITY), JSON.stringify(refusals))
  } finally {
    await rig.dispose()
    area.dispose()
  }
})

test('the host validates a call before applying it, and the vocabulary is closed', () => {
  // Every one of these is a call a hostile or merely confused plugin could send. Validation runs on
  // the host, on the message, because a check in the child is a check the child can skip.
  assert.equal(validateBridgeCall({ capability: 'database', method: 'query', args: [] }).code, BRIDGE_FAULT_CODES.UNKNOWN_CAPABILITY)
  assert.equal(validateBridgeCall({ capability: 'webServer', method: 'registerFallback', args: [] }).code, BRIDGE_FAULT_CODES.UNKNOWN_METHOD)
  assert.equal(validateBridgeCall({ capability: 'webServer', method: 'listen', args: [] }).code, BRIDGE_FAULT_CODES.UNKNOWN_METHOD)
  assert.equal(validateBridgeCall({ capability: 'webServer', method: 'close', args: [] }).code, BRIDGE_FAULT_CODES.UNKNOWN_METHOD)
  assert.equal(validateBridgeCall({ capability: 'settings', method: 'update', args: [] }).code, BRIDGE_FAULT_CODES.UNKNOWN_METHOD)
  assert.equal(validateBridgeCall({ capability: 'webServer', method: 'register' }).code, BRIDGE_FAULT_CODES.MALFORMED_MESSAGE)
  assert.equal(validateBridgeCall(null).code, BRIDGE_FAULT_CODES.MALFORMED_MESSAGE)

  const refusedMethod = validateBridgeCall({ capability: 'webServer', method: 'listen', args: [] })
  assert.deepEqual(refusedMethod.available, ['register', 'unregister'])
  assert.ok(refusedMethod.withheld.includes('server'))

  const allowed = validateBridgeCall({ capability: 'webServer', method: 'register', args: [{}] })
  assert.equal(allowed.ok, true)
  assert.deepEqual(BRIDGE_CAPABILITY_IDS, ['settings', 'webServer'])
})

test('a route may live under a host prefix but may not sit in front of one', () => {
  // The real plugins this adapter was accepted on serve `/api/market/*` and `/we-background/*`,
  // and an earlier version of this rule refused the first of those. The rule is about ancestry.
  assert.equal(normalizeRoutePath('/api/market/installed').ok, true)
  assert.equal(normalizeRoutePath('/api/market').ok, true)
  assert.equal(normalizeRoutePath('/we-background/media/').ok, true)

  assert.equal(normalizeRoutePath('/api').code, BRIDGE_FAULT_CODES.RESERVED_PATH)
  assert.equal(normalizeRoutePath('/api/').code, BRIDGE_FAULT_CODES.RESERVED_PATH)
  assert.equal(normalizeRoutePath('/assets').code, BRIDGE_FAULT_CODES.RESERVED_PATH)

  assert.equal(normalizeRoutePath('relative/path').code, BRIDGE_FAULT_CODES.BAD_PATH)
  assert.equal(normalizeRoutePath('/a/../b').code, BRIDGE_FAULT_CODES.BAD_PATH)
  assert.equal(normalizeRoutePath('/a//b').code, BRIDGE_FAULT_CODES.BAD_PATH)
  assert.equal(normalizeRoutePath('/a b').code, BRIDGE_FAULT_CODES.BAD_PATH)
  assert.equal(normalizeRoutePath('').code, BRIDGE_FAULT_CODES.BAD_PATH)
})

test('a route the host will not mount is refused and reported, and the plugin keeps running', async () => {
  const area = scratch()
  const rig = await harness(area, `
export const inject = ['webServer']
export function apply(ctx) {
  // A prefix route that would swallow the host's own API, and a good one beside it.
  ctx.webServer.register({ kind: 'prefix', path: '/api', handler: (req, res) => res.end('hijacked') })
  ctx.webServer.register({ kind: 'exact', path: '/probe/ok', handler: (req, res) => { res.writeHead(200); res.end('fine') } })
}
`, { id: 'acme.hostile' })
  try {
    const activated = await rig.bridge.activate()
    // Activation succeeds: one refused route is not a failed plugin.
    assert.equal(activated.ok, true, activated.reason)
    assert.deepEqual(rig.webServer.routes().map((route) => route.path), ['/probe/ok'])
    const refusals = rig.bridge.refusals
    assert.equal(refusals.length, 1)
    assert.equal(refusals[0].code, BRIDGE_FAULT_CODES.RESERVED_PATH)
    assert.match(refusals[0].reason, /would sit in front of the host's \/api\//)

    // The plugin is degraded rather than healthy, and the reason names the refusal.
    const health = rig.bridge.healthCheck()
    assert.equal(health.status, 'degraded')
    assert.match(health.reason, /BRIDGE_RESERVED_PATH/)

    // The route it was allowed still works.
    assert.equal((await request(rig.port, '/probe/ok')).status, 200)
    // And the host's own surface was never shadowed.
    assert.equal((await request(rig.port, '/api/anything')).status, 404)
  } finally {
    await rig.dispose()
    area.dispose()
  }
})

test('a response streams through the bridge instead of being buffered into one message', async () => {
  const area = scratch()
  const rig = await harness(area, `
export const inject = ['webServer']
export function apply(ctx) {
  ctx.effect(() => {
    const dispose = ctx.webServer.register({ kind: 'exact', path: '/probe/stream', handler: (req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.write('chunk-one|')
      res.write(Buffer.from('chunk-two|'))
      setTimeout(() => res.end('chunk-three'), 20)
    } })
    return () => dispose()
  })
}
`, { id: 'acme.stream' })
  try {
    const activated = await rig.bridge.activate()
    assert.equal(activated.ok, true, activated.reason)
    const response = await request(rig.port, '/probe/stream')
    assert.equal(response.status, 200)
    // The three writes were three messages, and the client got all of them in order. This is what
    // makes a video-serving plugin possible at all.
    assert.equal(response.body.toString('utf8'), 'chunk-one|chunk-two|chunk-three')
  } finally {
    await rig.dispose()
    area.dispose()
  }
})

test('a request body reaches the plugin handler', async () => {
  const area = scratch()
  const rig = await harness(area, `
export const inject = ['webServer']
export function apply(ctx) {
  ctx.effect(() => {
    const dispose = ctx.webServer.register({ kind: 'exact', path: '/probe/echo', handler: (req, res) => {
      let body = ''
      req.on('data', (chunk) => { body += chunk.toString('utf8') })
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ method: req.method, body }))
      })
    } })
    return () => dispose()
  })
}
`, { id: 'acme.echo' })
  try {
    await rig.bridge.activate()
    const response = await request(rig.port, '/probe/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'bridge' })
    })
    const seen = JSON.parse(response.body.toString('utf8'))
    assert.equal(seen.method, 'POST')
    assert.deepEqual(JSON.parse(seen.body), { hello: 'bridge' })
  } finally {
    await rig.dispose()
    area.dispose()
  }
})

test('a plugin that throws on import fails alone and leaves the host usable', async () => {
  const area = scratch()
  const rig = await harness(area, 'throw new Error("this plugin explodes at import time")\n', { id: 'acme.explodes' })
  try {
    const activated = await rig.bridge.activate()
    assert.equal(activated.ok, false)
    assert.equal(activated.code, BRIDGE_FAULT_CODES.IMPORT_FAILED)
    assert.match(activated.reason, /explodes at import time/)
    assert.equal(rig.webServer.routes().length, 0)
    assert.equal(rig.bridge.healthCheck().status, 'unhealthy')

    // The host is untouched: a second bridge over the same server still works.
    const second = await harness(area, `
export const inject = ['webServer']
export function apply(ctx) {
  ctx.effect(() => {
    const dispose = ctx.webServer.register({ kind: 'exact', path: '/probe/second', handler: (req, res) => { res.writeHead(200); res.end('second') } })
    return () => dispose()
  })
}
`, { id: 'acme.second', relative: 'second' })
    try {
      assert.equal((await second.bridge.activate()).ok, true)
      assert.equal((await request(second.port, '/probe/second')).status, 200)
    } finally {
      await second.dispose()
    }
  } finally {
    await rig.dispose()
    area.dispose()
  }
})

test('a handler that throws answers 500 and is recorded, and the plugin is not torn down', async () => {
  const area = scratch()
  const rig = await harness(area, `
export const inject = ['webServer']
export function apply(ctx) {
  ctx.effect(() => {
    const dispose = ctx.webServer.register({ kind: 'exact', path: '/probe/boom', handler: () => { throw new Error('handler exploded') } })
    return () => dispose()
  })
}
`, { id: 'acme.boom' })
  try {
    await rig.bridge.activate()
    const response = await request(rig.port, '/probe/boom')
    assert.equal(response.status, 500)
    assert.match(response.body.toString('utf8'), /handler exploded/)
    assert.ok(rig.bridge.refusals.some((entry) => entry.code === BRIDGE_FAULT_CODES.HANDLER_FAILED))
    // Still running: one bad request is not a reason to stop a plugin.
    assert.equal(rig.bridge.state, 'active')
  } finally {
    await rig.dispose()
    area.dispose()
  }
})

test('a plugin that provides a capability does not hand it to the host', async () => {
  const area = scratch()
  const rig = await harness(area, `
export function apply(ctx) {
  // The plugin registers a capability locally. It must not become resolvable anywhere else: this is
  // the same guarantee every adopted plugin has, and the bridge does not weaken it.
  ctx.provide('pet-registry', { pets: 3 })
  ctx.effect(() => {
    const dispose = ctx.webServer ? () => {} : () => {}
    return () => dispose()
  })
}
`, { id: 'acme.provider' })
  try {
    const activated = await rig.bridge.activate()
    assert.equal(activated.ok, true, activated.reason)
    // It was recorded in the child, and nothing about it crossed the boundary as a live value.
    assert.deepEqual(activated.provided, [{ name: 'pet-registry', kind: 'object' }])
    assert.equal(rig.bridge.capabilityReport().available.includes('pet-registry'), false)
  } finally {
    await rig.dispose()
    area.dispose()
  }
})

test('teardown removes the routes, ends the process and forgets the plugin', async () => {
  const area = scratch()
  const rig = await harness(area, `
export const inject = ['webServer']
export function apply(ctx) {
  ctx.effect(() => {
    const dispose = ctx.webServer.register({ kind: 'exact', path: '/probe/teardown', handler: (req, res) => { res.writeHead(200); res.end('up') } })
    return () => dispose()
  })
}
`, { id: 'acme.teardown' })
  try {
    await rig.bridge.activate()
    const pid = rig.bridge.pid
    assert.equal(rig.webServer.routes().length, 1)
    assert.equal(typeof pid, 'number')

    const stopped = await rig.bridge.stop()
    assert.equal(stopped.ok, true)
    assert.deepEqual(rig.webServer.routes(), [], 'a disabled plugin must leave no route behind')
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.throws(() => process.kill(pid, 0), 'the plugin process must be gone')
    assert.equal(rig.bridge.healthCheck().status, 'unknown')
    // Stopping twice is a normal consequence of a reload, not an error.
    assert.equal((await rig.bridge.stop()).ok, true)
  } finally {
    await rig.dispose()
    area.dispose()
  }
})

test('the bridge reports what it withholds, so the claim is checkable without reading the source', async () => {
  const area = scratch()
  const rig = await harness(area, 'export function apply() {}\n', { id: 'acme.report' })
  try {
    await rig.bridge.activate()
    const report = rig.bridge.capabilityReport()
    assert.equal(report.bridge, 'dshns.cordis-bridge/v1')
    assert.deepEqual(report.available, ['webServer', 'settings'])
    assert.deepEqual(report.backed, { webServer: true, settings: false })
    assert.deepEqual(report.refusals, [])
    // The contract itself names what is not reachable, which is what makes the withhold a
    // statement rather than an omission.
    assert.ok(BRIDGE_CAPABILITIES.webServer.withholds.includes('server'))
    assert.ok(BRIDGE_CAPABILITIES.settings.withholds.includes('update'))
  } finally {
    await rig.dispose()
    area.dispose()
  }
})
