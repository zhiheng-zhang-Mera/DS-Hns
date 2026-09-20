'use strict'

/**
 * The Runtime Host, exercised as a real detached process.
 *
 * The claim these tests make is the requirement's central sentence:
 *
 *   Electron may disappear; DS-Hns Runtime must continue to exist.
 *
 * It is tested here without Electron at all, because that is the strongest form
 * of the claim — if the Runtime needs the UI to exist, then the UI owns it, and
 * this test would fail. So the host is started the way the Desktop starts it
 * (detached, over the instance's own named pipe), driven through the protocol, and
 * then abandoned: the assertion is that the *client* can die while the host and
 * its owned child keep running.
 *
 * The Harness itself is not started here. It is a real `dsh web` process and
 * starting one per test would make this file a slow integration test rather than
 * the contract check the installer runs. What is asserted is the ownership and
 * protocol machinery, which is the part that was missing.
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const instanceModule = require('../../app/runtime/instance.cjs')
const protocol = require('../../app/runtime/protocol.cjs')
const { createRuntimeClient, probeRuntime, canConnect } = require('../../app/runtime/client.cjs')

const ROOT = path.resolve(__dirname, '..', '..')
const RUNTIME_ENTRY = path.join(ROOT, 'app', 'runtime', 'runtime.cjs')

/** A throwaway instance that cannot collide with the real one. */
function scratchInstance(name = 'runtime') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dshns-${name}-`))
  const root = path.join(dir, 'checkout')
  fs.mkdirSync(path.join(root, 'app'), { recursive: true })
  const dshHome = path.join(dir, 'data')
  return instanceModule.describeInstance({ root, dshHome, isolated: true, requestedPort: 0 })
}

/**
 * Run the CLI and return its parsed output.
 *
 * `--json` makes the answer a single line, so "the last line" is the whole
 * answer and a helper does not have to reassemble pretty-printed JSON. `serve`
 * never returns, so it is only ever spawned detached; the other commands are
 * short-lived and are run synchronously so a failure surfaces immediately.
 */
function runRuntime(args, { cwd = ROOT, timeout = 60_000 } = {}) {
  const result = spawnSync(process.execPath, [RUNTIME_ENTRY, '--json', ...args], {
    cwd,
    encoding: 'utf8',
    timeout,
    windowsHide: true,
    env: { ...process.env, DSH_RUNTIME_QUIET: '1', DSH_HOST_PROFILE_FIXTURE: '' }
  })
  const last = String(result.stdout || '').trim().split('\n').pop()
  let parsed = null
  try {
    parsed = last && last.startsWith('{') ? JSON.parse(last) : null
  } catch {
    parsed = null
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, parsed }
}

/** Start a detached host and wait for its endpoint to answer. */
async function startHost(instance) {
  const started = runRuntime(['start', '--root', instance.root, '--dsh-home', instance.dshHome, '--port', String(instance.requestedPort || 3500)])
  assert.equal(started.parsed?.started ?? started.parsed?.alreadyRunning, true, `the host did not start: ${started.stderr}`)
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (await canConnect(instance.ipcEndpoint, 500)) return started.parsed
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error('the host never became reachable')
}

function stopHost(instance) {
  try {
    runRuntime(['stop', '--root', instance.root, '--dsh-home', instance.dshHome], { timeout: 30_000 })
  } catch {}
}

test('the runtime protocol is versioned and refuses a foreign version', () => {
  assert.equal(protocol.PROTOCOL_VERSION, 'dshns-runtime/v1')
  const good = protocol.request('status', {}, 'x1')
  assert.equal(protocol.accept(good, protocol.CLIENT_METHODS).ok, true)
  const wrong = { ...good, v: 'dshns-runtime/v99' }
  const rejected = protocol.accept(wrong, protocol.CLIENT_METHODS)
  assert.equal(rejected.ok, false)
  assert.match(rejected.reason, /protocol mismatch/)
})

test('the protocol frames are newline-delimited and survive a payload with newlines', () => {
  const frame = protocol.request('command', { command: 'harness.start', args: { note: 'line one\nline two' } }, 'x2')
  const encoded = protocol.encode(frame)
  assert.equal(encoded.endsWith('\n'), true)
  assert.equal(encoded.split('\n').length, 2, 'a newline in the payload must not split the frame')
  const { frames, remainder } = protocol.decode(encoded)
  assert.equal(frames.length, 1)
  assert.equal(remainder, '')
  assert.equal(frames[0].params.args.note, 'line one\nline two')
})

test('a partial frame is buffered rather than misparsed', () => {
  const whole = protocol.encode(protocol.request('status', {}, 'x3'))
  const half = whole.slice(0, Math.floor(whole.length / 2))
  const first = protocol.decode(half, '')
  assert.deepEqual(first.frames, [])
  assert.equal(first.remainder, half)
  const second = protocol.decode(whole.slice(Math.floor(whole.length / 2)), first.remainder)
  assert.equal(second.frames.length, 1)
  assert.equal(second.frames[0].method, 'status')
})

test('a malformed line becomes an error frame and does not desynchronize the stream', () => {
  const good = protocol.encode(protocol.request('ping', {}, 'x4'))
  const { frames } = protocol.decode(`{not json\n${good}`)
  assert.equal(frames.length, 2)
  assert.equal(frames[0].method, 'error')
  assert.equal(frames[1].method, 'ping')
})

test('an unsupported method or version is reported, not silently ignored', () => {
  const unknown = protocol.accept({ v: protocol.PROTOCOL_VERSION, id: 'x5', method: 'teleport' }, protocol.CLIENT_METHODS)
  assert.equal(unknown.ok, false)
  assert.match(unknown.reason, /unsupported method/)
})

test('a host can serve with no client at all, and reports its own identity', async () => {
  const instance = scratchInstance('serve')
  try {
    await startHost(instance)
    const probe = await probeRuntime({ instance })
    assert.equal(probe.running, true)
    assert.equal(probe.recordAlive, true)
    assert.equal(probe.recordPresent, true)

    const status = runRuntime(['status', '--root', instance.root, '--dsh-home', instance.dshHome])
    assert.equal(status.parsed.ok, true)
    assert.equal(status.parsed.running, true)
    assert.equal(status.parsed.instanceId, instance.instanceId)
    assert.equal(status.parsed.ipcEndpoint, instance.ipcEndpoint)
    // Nothing attached: the Runtime exists without a UI, which is the whole point.
    assert.equal(status.parsed.electronAttached, false)
    // The Harness is created lazily, so a status query must not have started it.
    assert.equal(status.parsed.services.harness.created, false)
  } finally {
    stopHost(instance)
  }
})

test('a second host on the same instance is refused, and start reports the existing one', async () => {
  const instance = scratchInstance('single')
  try {
    const first = await startHost(instance)
    const second = runRuntime(['start', '--root', instance.root, '--dsh-home', instance.dshHome])
    assert.equal(second.parsed.alreadyRunning, true, 'a second Runtime must not be created')
    assert.equal(second.parsed.started, false)
    assert.equal(second.parsed.hostPid, first?.hostPid ?? second.parsed.hostPid)
  } finally {
    stopHost(instance)
  }
})

test('a client can attach, ask, and detach without stopping the runtime', async () => {
  const instance = scratchInstance('attach')
  try {
    await startHost(instance)
    const client = createRuntimeClient({ instance, autoStartRuntime: false, log: () => {} })
    await client.attach()
    assert.equal(client.state, 'attached')
    assert.ok(client.welcome?.hostPid, 'the welcome frame must carry the host pid')

    const health = await client.health()
    assert.equal(health.ok, true)
    assert.ok(health.capacity, 'the health answer must carry the capability class')
    assert.ok(health.budgets, 'the health answer must carry the derived budgets')

    // Detach: the client lets go, the runtime stays.
    const detach = client.detach()
    assert.equal(detach.runtimeStopped, false)
    assert.equal(client.attached, false)
    await new Promise((resolve) => setTimeout(resolve, 300))
    const probe = await probeRuntime({ instance })
    assert.equal(probe.running, true, 'the runtime must survive the client detaching')
  } finally {
    stopHost(instance)
  }
})

test('the runtime survives the client process exiting entirely', async () => {
  const instance = scratchInstance('survive')
  try {
    await startHost(instance)
    // A whole separate process attaches and then exits, exactly like a Desktop
    // that is killed. The host must not notice the difference between this and a
    // clean detach -- it is not the host's parent either way.
    //
    // The child holds nothing open: it attaches, subscribes (as the Desktop
    // does), asks once, detaches and exits. An explicit `process.exit` keeps the
    // assertion about the *host* from becoming an assertion about this script's
    // event loop.
    const clientPath = path.join(ROOT, 'app', 'runtime', 'client.cjs')
    const script = `
      const { createRuntimeClient } = require(${JSON.stringify(clientPath)})
      const instance = ${JSON.stringify(instance)}
      const client = createRuntimeClient({ instance, autoStartRuntime: false, subscribe: true, log: () => {} })
      client.attach().then(async () => {
        const status = await client.status()
        process.stdout.write(JSON.stringify({ attached: true, hostPid: status.hostPid, instanceId: status.instanceId }))
        client.detach()
        process.exit(0)
      }).catch((error) => {
        process.stderr.write(String(error && error.message ? error.message : error))
        process.exit(1)
      })
    `
    const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 30_000, windowsHide: true })
    assert.equal(result.status, 0, `the attaching client failed: ${result.stderr || result.stdout}`)
    const seen = JSON.parse(String(result.stdout).trim())
    assert.equal(seen.attached, true)
    assert.equal(seen.instanceId, instance.instanceId)

    // That process is gone. Is the runtime still there?
    await new Promise((resolve) => setTimeout(resolve, 500))
    const probe = await probeRuntime({ instance })
    assert.equal(probe.running, true, 'the runtime died with the client that attached to it')
    assert.equal(probe.recordAlive, true)
  } finally {
    stopHost(instance)
  }
})

test('an explicit shutdown stops the runtime and clears its ownership record', async () => {
  const instance = scratchInstance('shutdown')
  try {
    await startHost(instance)
    const stopped = runRuntime(['stop', '--root', instance.root, '--dsh-home', instance.dshHome])
    assert.equal(stopped.parsed.stopped, true)
    const deadline = Date.now() + 20_000
    let running = true
    while (Date.now() < deadline && running) {
      running = await canConnect(instance.ipcEndpoint, 400)
      if (running) await new Promise((resolve) => setTimeout(resolve, 200))
    }
    assert.equal(running, false, 'the runtime did not stop')
    const probe = await probeRuntime({ instance })
    assert.equal(probe.running, false)
    assert.equal(probe.recordPresent, false, 'the ownership record must be cleared on shutdown')
  } finally {
    stopHost(instance)
  }
})

test('two instances on one machine use different endpoints and cannot see each other', async () => {
  const first = scratchInstance('dual-a')
  const second = scratchInstance('dual-b')
  try {
    assert.notEqual(first.instanceId, second.instanceId)
    assert.notEqual(first.ipcEndpoint, second.ipcEndpoint)
    await startHost(first)
    await startHost(second)
    // Each answers about itself, not about the other.
    const a = runRuntime(['status', '--root', first.root, '--dsh-home', first.dshHome])
    const b = runRuntime(['status', '--root', second.root, '--dsh-home', second.dshHome])
    assert.equal(a.parsed.instanceId, first.instanceId)
    assert.equal(b.parsed.instanceId, second.instanceId)
    assert.notEqual(a.parsed.hostPid, b.parsed.hostPid)
    // Stopping one leaves the other running.
    stopHost(first)
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline && (await canConnect(first.ipcEndpoint, 400))) {
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    assert.equal(await canConnect(first.ipcEndpoint, 400), false)
    assert.equal(await canConnect(second.ipcEndpoint, 400), true, 'stopping one instance stopped the other')
  } finally {
    stopHost(first)
    stopHost(second)
  }
})

test('the runtime entry point can be inspected without starting anything', () => {
  const capabilityRun = runRuntime(['capability'])
  assert.equal(capabilityRun.status, 0)
  assert.ok(capabilityRun.parsed.capacity.class)
  assert.ok(capabilityRun.parsed.budgets.harnessStartup.timeoutMs > 0)
})

test('the runtime modules never require Electron', () => {
  const dir = path.join(ROOT, 'app', 'runtime')
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.cjs')) continue
    const text = fs.readFileSync(path.join(dir, name), 'utf8')
    assert.equal(/require\(['"]electron['"]\)/.test(text), false, `${name} requires Electron`)
  }
})
