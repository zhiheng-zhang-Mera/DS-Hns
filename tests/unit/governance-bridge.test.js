'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createGovernanceBridge, BRIDGE_ACTIONS, LOOPBACK } = require('../../app/core/governance-bridge.cjs')

/**
 * The governance bridge (`updateplan/pluginize.md` Phase 1).
 *
 * This is the one place a plugin can reach into this product's state, so the tests are about the boundary rather
 * than the payload: loopback only, a per-run token, a closed set of actions, and a bridge that can fail without
 * taking anything else with it.
 */

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshns-bridge-'))
  return { dir, dispose: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

async function withBridge(run, options = {}) {
  const { dir, dispose } = scratch()
  const actions = []
  const bridge = createGovernanceBridge({
    stateDir: dir,
    snapshot: () => ({
      protection: { modules: [{ id: 'wallpaper-layer', state: 'HEALTHY' }], degraded: [], failed: [] },
      plugins: [{ id: 'dsh-wallpaper-engine', state: 'installed' }],
      boot: { state: 'ENHANCED' }
    }),
    act: async ({ action, id }) => {
      actions.push({ action, id })
      return { ok: action !== 'repair', reason: action === 'repair' ? 'nothing to repair against yet' : null }
    },
    log: () => {},
    ...options
  })
  const started = await bridge.start()
  try {
    await run({ bridge, started, actions, dir })
  } finally {
    await bridge.stop()
    dispose()
  }
}

test('it listens on loopback only, and the discovery file carries a fresh token', async () => {
  await withBridge(async ({ bridge, started, dir }) => {
    assert.equal(started.ok, true, started.reason)
    assert.equal(started.host, LOOPBACK)
    assert.ok(started.port > 0)
    const file = path.join(dir, 'governance-bridge.json')
    const discovery = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(discovery.host, '127.0.0.1')
    assert.equal(discovery.port, started.port)
    assert.equal(discovery.pid, process.pid)
    assert.ok(discovery.token.length >= 32, 'the token is too short to be a secret')
    assert.equal(discovery.token, bridge.token())
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o077, 0, 'the token file is readable by others')
  })
})

test('a second bridge gets a different token, so a token cannot outlive its process', async () => {
  await withBridge(async ({ bridge }) => {
    await withBridge(async ({ bridge: second }) => {
      assert.notEqual(second.token(), bridge.token())
    })
  })
})

test('reading needs the token; the health probe does not', async () => {
  await withBridge(async ({ started, bridge }) => {
    const health = await fetch(`http://${LOOPBACK}:${started.port}/health`)
    assert.equal(health.status, 200)
    assert.equal((await health.json()).service, 'hns-governance-bridge')

    assert.equal((await fetch(`http://${LOOPBACK}:${started.port}/governance`)).status, 401)
    assert.equal((await fetch(`http://${LOOPBACK}:${started.port}/governance`, { headers: { authorization: 'Bearer nonsense' } })).status, 401)

    const authorized = await fetch(`http://${LOOPBACK}:${started.port}/governance`, { headers: { authorization: `Bearer ${bridge.token()}` } })
    assert.equal(authorized.status, 200)
    const body = await authorized.json()
    assert.equal(body.ok, true)
    assert.equal(body.protection.modules[0].id, 'wallpaper-layer')
    assert.equal(body.boot.state, 'ENHANCED')
    assert.equal(bridge.describe().refused, 2, 'refusals are counted')
  })
})

test('only the named governance actions are accepted, and their answer travels back', async () => {
  await withBridge(async ({ started, bridge, actions }) => {
    const call = (body) => fetch(`http://${LOOPBACK}:${started.port}/action`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bridge.token()}`, 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
    const ok = await call({ action: 'retry', id: 'wallpaper-layer' })
    assert.equal(ok.status, 200)
    assert.deepEqual(actions[0], { action: 'retry', id: 'wallpaper-layer' })
    // A refused action is the layer's answer, carried through rather than turned into a success.
    const refused = await call({ action: 'repair', id: 'dsh-wallpaper-engine' })
    assert.equal(refused.status, 409)
    assert.match((await refused.json()).result.reason, /nothing to repair against yet/)
    // A closed set: an action the plan does not name is refused by name.
    const unknown = await call({ action: 'setWallpaper', id: 'x' })
    assert.equal(unknown.status, 400)
    assert.match((await unknown.json()).reason, /is not a governance action/)
    assert.equal((await call({ action: 'retry' })).status, 400, 'an action without an id must be refused')
    assert.deepEqual(BRIDGE_ACTIONS, ['check', 'retry', 'reset-fallback', 'repair', 'disable', 'enable'])
  })
})

test('it refuses anything but loopback, and stopping removes the token from disk', async () => {
  const { dir, dispose } = scratch()
  try {
    assert.throws(() => createGovernanceBridge({ stateDir: dir, snapshot: () => ({}), host: '0.0.0.0' }), /loopback-only/)
    assert.throws(() => createGovernanceBridge({ stateDir: dir, act: async () => ({}) }), /needs a snapshot/)
  } finally {
    dispose()
  }
  await withBridge(async ({ bridge, started, dir: stateDir }) => {
    const file = path.join(stateDir, 'governance-bridge.json')
    assert.equal(fs.existsSync(file), true)
    await bridge.stop()
    assert.equal(fs.existsSync(file), false, 'the token outlived the bridge')
    await assert.rejects(fetch(`http://${LOOPBACK}:${started.port}/health`), 'a stopped bridge still answered')
  })
})

test('the extension serves the Control Center\'s own data and actions through it', () => {
  const fsRead = require('node:fs')
  const index = fsRead.readFileSync(path.join(__dirname, '..', '..', 'app', 'extensions', 'mega', 'index.cjs'), 'utf8')
  // One truth, two surfaces: the bridge answers with what the Control Center shows, and performs the actions the
  // Control Center offers. A second assembly of the same facts would be a second answer.
  assert.match(index, /const \{ createGovernanceBridge \} = require\('\.\.\/\.\.\/core\/governance-bridge\.cjs'\)/)
  assert.match(index, /snapshot: \(\) => controlCenter\(\)/)
  assert.match(index, /act: \(payload\) => controlAction\(payload\)/)
  assert.match(index, /stateDir: path\.join\(PATHS\.ROOT, 'data', 'state'\)/)
  // It starts in the background at the end of `start()`, and it does not outlive the process.
  assert.match(index, /\.then\(\(\) => governanceBridge\(\)\.start\(\)\)/)
  assert.match(index, /try \{ governanceBridgeState\?\.stop\?\.\(\) \} catch \{\}/)
  // And the Control Center reports the channel, so a user can see whether Mega's plugin can reach it.
  assert.match(index, /bridge: \(\(\) => \{/)
  assert.match(fsRead.readFileSync(path.join(__dirname, '..', '..', 'app', 'extensions', 'mega', 'control-center.cjs'), 'utf8'), /Governance bridge/)
})
