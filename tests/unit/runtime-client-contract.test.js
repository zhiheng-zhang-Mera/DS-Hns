'use strict'

/**
 * The Runtime Client contract.
 *
 * The requirement names four situations the Desktop must survive, and this file
 * tests each one directly:
 *
 *   Runtime already alive  -> attach
 *   Runtime absent         -> start one, then attach
 *   Runtime dies           -> the UI stays alive and reports `disconnected`
 *   Electron dies/closes   -> detach, and the Runtime is untouched
 *
 * The second half of each pair is the part that matters: surviving an *absence*
 * is easy, and surviving the Runtime's death without taking the process with it is
 * the property that was missing when the UI owned the Harness.
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const instanceModule = require('../../app/runtime/instance.cjs')
const { createRuntimeClient, probeRuntime, canConnect, spawnRuntimeHost, CLIENT_STATES } = require('../../app/runtime/client.cjs')

const ROOT = path.resolve(__dirname, '..', '..')
const RUNTIME_ENTRY = path.join(ROOT, 'app', 'runtime', 'runtime.cjs')

function scratchInstance(name = 'client') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dshns-${name}-`))
  const root = path.join(dir, 'checkout')
  fs.mkdirSync(path.join(root, 'app'), { recursive: true })
  return instanceModule.describeInstance({ root, dshHome: path.join(dir, 'data'), isolated: true, requestedPort: 0 })
}

function runRuntime(args, timeout = 60_000) {
  return spawnSync(process.execPath, [RUNTIME_ENTRY, '--json', ...args], {
    encoding: 'utf8',
    timeout,
    windowsHide: true,
    env: { ...process.env, DSH_RUNTIME_QUIET: '1' }
  })
}

async function startHost(instance) {
  runRuntime(['start', '--root', instance.root, '--dsh-home', instance.dshHome, '--port', String(instance.requestedPort || 3510)])
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (await canConnect(instance.ipcEndpoint, 500)) return
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error('host never became reachable')
}

function stopHost(instance) {
  try {
    runRuntime(['stop', '--root', instance.root, '--dsh-home', instance.dshHome], 30_000)
  } catch {}
}

/** Wait for a client to reach a state, or fail with what it actually did. */
async function waitForState(client, wanted, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (client.state === wanted) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`client never reached ${wanted}; it is ${client.state}`)
}

test('the client exposes the connection states a UI can render', () => {
  assert.deepEqual([...CLIENT_STATES], ['idle', 'connecting', 'attached', 'disconnected', 'failed'])
})

test('probeRuntime reports absence without creating anything', async () => {
  const instance = scratchInstance('absent')
  const probe = await probeRuntime({ instance, timeoutMs: 600 })
  assert.equal(probe.running, false)
  assert.equal(probe.recordPresent, false)
  // A probe must not bind the endpoint: testing for a Runtime must not become one.
  assert.equal(await canConnect(instance.ipcEndpoint, 400), false)
})

test('a stale ownership record is reported as stale, not as a running runtime', async () => {
  const instance = scratchInstance('stale')
  const runtimeProcess = require('../../app/runtime-process.cjs')
  // A record whose owner is this very test process is alive; one with a dead pid
  // is not. Use a pid that cannot exist to make the second case unambiguous.
  runtimeProcess.writeOwnership({
    root: instance.root,
    type: 'runtime-host',
    entry: RUNTIME_ENTRY,
    pid: 0x7ffffff0,
    parentPid: 0x7ffffff0,
    instanceId: instance.instanceId
  })
  const probe = await probeRuntime({ instance, timeoutMs: 600 })
  assert.equal(probe.recordPresent, true)
  assert.equal(probe.recordAlive, false)
  assert.equal(probe.stale, true)
  assert.equal(probe.running, false)
})

test('Runtime absent: the client starts one and attaches', async () => {
  const instance = scratchInstance('autostart')
  try {
    const client = createRuntimeClient({ instance, autoStartRuntime: true, log: () => {} })
    const result = await client.attach()
    assert.equal(result.attached, true)
    assert.equal(client.state, 'attached')
    assert.ok(client.welcome?.hostPid, 'the welcome frame must name the host')
    client.detach()
  } finally {
    stopHost(instance)
  }
})

test('Runtime alive: the client attaches and never starts a second one', async () => {
  const instance = scratchInstance('existing')
  try {
    await startHost(instance)
    const before = await probeRuntime({ instance })
    const spawned = []
    const client = createRuntimeClient({ instance, autoStartRuntime: true, log: () => {} })
    client.events.on('runtime-spawned', (info) => spawned.push(info))
    await client.attach()
    assert.equal(client.state, 'attached')
    assert.equal(client.welcome.hostPid, before.recordPid, 'the client attached to a different host')
    // The load-bearing assertion: autoStartRuntime must not mean "always start".
    assert.deepEqual(spawned, [], 'the client spawned a Runtime that was already running')
    client.detach()
  } finally {
    stopHost(instance)
  }
})

test('Runtime dies: the UI stays alive and reports disconnected', async () => {
  const instance = scratchInstance('dies')
  try {
    await startHost(instance)
    const client = createRuntimeClient({ instance, autoStartRuntime: false, log: () => {} })
    await client.attach()
    assert.equal(client.state, 'attached')

    const disconnected = new Promise((resolve) => client.events.once('disconnected', resolve))
    // Kill the Runtime the way a crash would: from outside, with no goodbye.
    const probe = await probeRuntime({ instance })
    spawnSync('taskkill.exe', ['/pid', String(probe.recordPid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })

    const reason = await disconnected
    assert.ok(reason, 'no disconnected event was emitted')
    assert.equal(client.state, 'disconnected')
    assert.equal(client.attached, false)

    // The client process is very much alive: this is the whole point.
    assert.equal(typeof client.describe().state, 'string')

    // And every in-flight request fails as data rather than as a crash.
    await assert.rejects(() => client.status(), (error) => error.code === 'runtime-not-attached' || /disconnected|not attached/.test(error.message))
    client.detach()
  } finally {
    stopHost(instance)
  }
})

test('an in-flight request is rejected when the Runtime dies under it', async () => {
  const instance = scratchInstance('inflight')
  try {
    await startHost(instance)
    const client = createRuntimeClient({ instance, autoStartRuntime: false, requestTimeoutMs: 30_000, log: () => {} })
    await client.attach()
    const probe = await probeRuntime({ instance })
    // A request that cannot answer, killed mid-flight.
    const pending = client.request('health', {})
    setTimeout(() => {
      spawnSync('taskkill.exe', ['/pid', String(probe.recordPid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    }, 50)
    await assert.rejects(() => pending, (error) => {
      assert.ok(['runtime-disconnected', 'runtime-timeout'].includes(error.code), `unexpected code ${error.code}`)
      return true
    })
    client.detach()
  } finally {
    stopHost(instance)
  }
})

test('a runtime that comes back can be attached to again', async () => {
  const instance = scratchInstance('reattach')
  try {
    await startHost(instance)
    const client = createRuntimeClient({ instance, autoStartRuntime: false, reconnectMs: 300, log: () => {} })
    await client.attach()
    const firstHost = client.welcome.hostPid

    // Kill it, wait for the loss to be noticed, then bring a new one up.
    const probe = await probeRuntime({ instance })
    spawnSync('taskkill.exe', ['/pid', String(probe.recordPid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    await waitForState(client, 'disconnected')

    // The reconnect loop is allowed to find it on its own; start one to be sure.
    await startHost(instance)
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline && client.state !== 'attached') {
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    assert.equal(client.state, 'attached', 'the client never reattached')
    assert.notEqual(client.welcome.hostPid, firstHost, 'a new Runtime should be a new pid')
    client.detach()
  } finally {
    stopHost(instance)
  }
})

test('detach leaves the Runtime running; only an explicit shutdown stops it', async () => {
  const instance = scratchInstance('detach')
  try {
    await startHost(instance)
    const client = createRuntimeClient({ instance, autoStartRuntime: false, log: () => {} })
    await client.attach()
    const result = client.detach()
    assert.deepEqual(result, { detached: true, runtimeStopped: false })
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal((await probeRuntime({ instance })).running, true, 'detach stopped the runtime')

    // The explicit stop is a different call, and it is the only one that stops it.
    const client2 = createRuntimeClient({ instance, autoStartRuntime: false, subscribe: false, log: () => {} })
    const stopped = await client2.shutdownRuntime({ reason: 'test' })
    assert.equal(stopped.stopped, true)
    assert.equal((await probeRuntime({ instance, timeoutMs: 600 })).running, false)
  } finally {
    stopHost(instance)
  }
})

test('a one-shot client does not register as an attached UI', async () => {
  const instance = scratchInstance('oneshot')
  try {
    await startHost(instance)
    // `subscribe: false` is what the `runtime status` command uses: asking a
    // question must not make the asker look like a window that is open.
    const client = createRuntimeClient({ instance, autoStartRuntime: false, subscribe: false, log: () => {} })
    await client.attach()
    const status = await client.status()
    assert.equal(status.electronAttached, false)
    client.detach()
  } finally {
    stopHost(instance)
  }
})

test('spawnRuntimeHost starts a detached process, not a child of the caller', async () => {
  const instance = scratchInstance('detached')
  try {
    const child = spawnRuntimeHost({ instance, env: process.env })
    assert.ok(child.pid > 0)
    // `detached` and `unref` are why the Runtime outlives the Desktop; assert the
    // shape rather than the platform behaviour, which the acceptance run covers.
    assert.equal(typeof child.unref, 'function')
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline && !(await canConnect(instance.ipcEndpoint, 400))) {
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    assert.equal(await canConnect(instance.ipcEndpoint, 400), true, 'the spawned host never listened')
  } finally {
    stopHost(instance)
  }
})

test('the client never requires Electron', () => {
  const text = fs.readFileSync(path.join(ROOT, 'app', 'runtime', 'client.cjs'), 'utf8')
  assert.equal(/require\(['"]electron['"]\)/.test(text), false)
})
