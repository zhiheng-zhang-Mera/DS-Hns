'use strict'

/**
 * The Computer Use boundary: core in the Runtime, page capability in Electron.
 *
 * `computer-use/index.cjs` is Electron-free by construction — it takes ports — so
 * the *core* (scheduling, state, policy, history) belongs to the Runtime Host and
 * survives the UI. The one thing it cannot own is the page: driving the visible
 * surface needs `webContents.debugger`, which only the Electron Client has.
 *
 * That is expressed as a **capability** rather than a dependency, and these tests
 * are about the consequence the requirement names: when the UI goes away, the core
 * reports the capability unavailable and keeps running. It must not fail, and the
 * whole machine must not come down with it.
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const instanceModule = require('../../app/runtime/instance.cjs')
const { canConnect } = require('../../app/runtime/client.cjs')

const ROOT = path.resolve(__dirname, '..', '..')
const RUNTIME_ENTRY = path.join(ROOT, 'app', 'runtime', 'runtime.cjs')
const COMPUTER_USE_DIR = path.join(ROOT, 'app', 'computer-use')

function scratchInstance(name = 'cu') {
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

function json(result) {
  const last = String(result.stdout || '').trim().split('\n').pop()
  return last && last.startsWith('{') ? JSON.parse(last) : null
}

async function startHost(instance) {
  runRuntime(['start', '--root', instance.root, '--dsh-home', instance.dshHome, '--port', String(instance.requestedPort || 3520)])
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

test('the Computer Use core does not require Electron', () => {
  // The core is what moves to the Runtime, so this is the assertion that makes the
  // move possible rather than aspirational.
  const core = fs.readFileSync(path.join(COMPUTER_USE_DIR, 'index.cjs'), 'utf8')
  assert.equal(/require\(['"]electron['"]\)/.test(core), false, 'the Computer Use core requires Electron')

  // The whole directory except the Electron host must be Electron-free too.
  const offenders = []
  for (const name of fs.readdirSync(COMPUTER_USE_DIR)) {
    const file = path.join(COMPUTER_USE_DIR, name)
    if (!fs.statSync(file).isFile() || !name.endsWith('.cjs')) continue
    if (name === 'host-electron.cjs') continue
    if (/require\(['"]electron['"]\)/.test(fs.readFileSync(file, 'utf8'))) offenders.push(name)
  }
  assert.deepEqual(offenders, [], `these modules require Electron: ${offenders.join(', ')}`)
})

test('the Electron host is the only Electron-aware part, and it is a provider', () => {
  const host = fs.readFileSync(path.join(COMPUTER_USE_DIR, 'host-electron.cjs'), 'utf8')
  // It supplies ports (page/desktop/accessibility/screenshot) to the core; it does
  // not reach into the core's scheduling or state.
  assert.match(host, /createElectronHost/)
  assert.match(host, /getPage/)
  assert.match(host, /createElectronDebuggerTransport/)
  // The provider does not itself require('electron'): it is handed a webContents,
  // which is what keeps it out of the module graph the Runtime loads.
  assert.equal(/require\(['"]electron['"]\)/.test(host), false)
})

test('the CDP driver is written against a transport, not against Electron', () => {
  const driver = fs.readFileSync(path.join(COMPUTER_USE_DIR, 'drivers', 'cdp-page.cjs'), 'utf8')
  // One adapter takes an Electron webContents debugger; the other takes a
  // WebSocket. The core only ever sees `send`/`onEvent`.
  assert.match(driver, /createElectronDebuggerTransport/)
  assert.match(driver, /createWebSocketTransport/)
  assert.match(driver, /requireTransport\(\)/)
})

test('the Runtime Host owns the core with the page capability absent', async () => {
  const instance = scratchInstance('cu-core')
  try {
    await startHost(instance)
    const status = runRuntime(['command', '--root', instance.root, '--dsh-home', instance.dshHome])
    assert.ok(status)
    // Ask through the protocol rather than by importing the host: this is the
    // surface a client actually has.
    const probe = probeCommand(instance, 'computerUse.status')
    assert.equal(probe.ok, true, probe.error || 'computerUse.status failed')
    assert.equal(probe.data.capability, 'unavailable', 'the core must start with no page capability')
    assert.equal(probe.data.status, 'CAPABILITY_UNAVAILABLE')
  } finally {
    stopHost(instance)
  }
})

test('announcing and withdrawing the capability never fails the core', async () => {
  const instance = scratchInstance('cu-cap')
  try {
    await startHost(instance)
    const available = probeCommand(instance, 'computerUse.capability', { available: true })
    assert.equal(available.ok, true, available.error)
    assert.equal(available.data.capability, 'available')
    assert.equal(available.data.status, 'AVAILABLE')

    // Withdrawing it is the Electron client disconnecting. The core must report
    // the loss as state, not as an error.
    const withdrawn = probeCommand(instance, 'computerUse.capability', { available: false })
    assert.equal(withdrawn.ok, true, withdrawn.error)
    assert.equal(withdrawn.data.capability, 'unavailable')
    assert.equal(withdrawn.data.status, 'CAPABILITY_UNAVAILABLE')

    // And the rest of the runtime is unaffected.
    const health = probeCommand(instance, 'host.capability', {})
    assert.equal(health.ok, true)
  } finally {
    stopHost(instance)
  }
})

test('the capability is withdrawn automatically when the client disappears', async () => {
  const instance = scratchInstance('cu-disconnect')
  try {
    await startHost(instance)
    /**
     * Announce, then *hold* the connection, then die abruptly.
     *
     * The hold matters: announcing and exiting in the same tick races the very
     * disconnect this test is about, and the probe would then correctly observe an
     * already-withdrawn capability. So the child is told to keep the client alive
     * for a moment, which makes "announced" and "the client is gone" two distinct,
     * observable phases.
     */
    const clientPath = path.join(ROOT, 'app', 'runtime', 'client.cjs')
    const script = `
      const { createRuntimeClient } = require(${JSON.stringify(clientPath)})
      const instance = ${JSON.stringify(instance)}
      const client = createRuntimeClient({ instance, autoStartRuntime: false, log: () => {} })
      client.attach()
        .then(() => client.command('computerUse.capability', { available: true }))
        .then(() => {
          process.stdout.write('announced')
          // Hold the subscription open, then die without a goodbye.
          setTimeout(() => process.exit(0), 12_000)
        })
        .catch((e) => { process.stderr.write(String(e.message || e)); process.exit(1) })
    `
    return await new Promise((resolve, reject) => {
      const child = require('node:child_process').spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      let announced = ''
      child.stdout.on('data', (chunk) => {
        announced += String(chunk)
        if (!announced.includes('announced')) return
        // Phase one: the capability is recorded while the client is alive.
        try {
          const during = probeCommand(instance, 'computerUse.status')
          assert.equal(during.data.capability, 'available', 'the announcement was not recorded')
        } catch (error) {
          reject(error)
          return
        }
        // Phase two: the client dies abruptly; the capability must be withdrawn.
        child.kill('SIGKILL')
        const deadline = Date.now() + 15_000
        const poll = async () => {
          while (Date.now() < deadline) {
            const after = probeCommand(instance, 'computerUse.status')
            if (after.data?.capability === 'unavailable') {
              // The requirement's own words: PAUSED / CAPABILITY_UNAVAILABLE, not a crash.
              assert.equal(after.data.status, 'CAPABILITY_UNAVAILABLE')
              resolve()
              return
            }
            await new Promise((r) => setTimeout(r, 300))
          }
          reject(new Error('the capability was never withdrawn after the client died'))
        }
        void poll()
      })
      child.once('error', reject)
      setTimeout(() => reject(new Error('the announcing client never announced')), 25_000).unref?.()
    })
  } finally {
    stopHost(instance)
  }
})

test('the runtime is still serving after the page capability goes away', async () => {
  const instance = scratchInstance('cu-survives')
  try {
    await startHost(instance)
    const clientPath = path.join(ROOT, 'app', 'runtime', 'client.cjs')
    const script = `
      const { createRuntimeClient } = require(${JSON.stringify(clientPath)})
      const instance = ${JSON.stringify(instance)}
      const client = createRuntimeClient({ instance, autoStartRuntime: false, log: () => {} })
      client.attach()
        .then(() => client.command('computerUse.capability', { available: true }))
        .then(() => client.status())
        .then((status) => { process.stdout.write(JSON.stringify(status)); process.exit(0) })
        .catch(() => process.exit(1))
    `
    const announced = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 30_000, windowsHide: true })
    assert.equal(announced.status, 0, `the announcing client failed: ${announced.stderr || announced.stdout}`)
    await new Promise((resolve) => setTimeout(resolve, 1500))
    // The Runtime, its endpoint and its other services are all still there.
    assert.equal(await canConnect(instance.ipcEndpoint, 1000), true, 'the runtime went down with the capability')
    const status = probeCommand(instance, null)
    assert.equal(status.ok, true, status.error || 'the runtime stopped answering')
    // The protocol frame is the Runtime's own answer, so it is asserted on its own
    // fields: a live host pid, not shutting down, and a Computer Use *core* that
    // still exists and reports the missing capability as its state.
    assert.ok(status.data?.hostPid > 0, `no live host pid: ${JSON.stringify(status.data)}`)
    assert.equal(status.data?.shuttingDown, false)
    assert.equal(status.data?.electronAttached, false)
    assert.equal(status.data?.services?.computerUse?.capability, 'unavailable')
    assert.equal(status.data?.services?.computerUse?.status, 'CAPABILITY_UNAVAILABLE')
  } finally {
    stopHost(instance)
  }
})

/**
 * Run one command through a short-lived client and return `{ok, data, error}`.
 *
 * A `null` command asks for `status` instead, which is how the "is it still
 * serving" question is asked.
 */
function probeCommand(instance, command, args = {}) {
  const clientPath = path.join(ROOT, 'app', 'runtime', 'client.cjs')
  const script = `
    const { createRuntimeClient } = require(${JSON.stringify(clientPath)})
    const instance = ${JSON.stringify(instance)}
    const client = createRuntimeClient({ instance, autoStartRuntime: false, subscribe: false, log: () => {} })
    const command = ${JSON.stringify(command)}
    client.attach()
      .then(() => command ? client.command(command, ${JSON.stringify(args)}) : client.status())
      .then((data) => { process.stdout.write(JSON.stringify({ ok: true, data })); process.exit(0) })
      .catch((error) => { process.stdout.write(JSON.stringify({ ok: false, error: String(error && error.message ? error.message : error) })); process.exit(0) })
  `
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 30_000, windowsHide: true })
  try {
    return JSON.parse(String(result.stdout || '').trim())
  } catch {
    return { ok: false, error: `the probe produced no answer: ${result.stderr || result.stdout}` }
  }
}
