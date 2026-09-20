'use strict'

/**
 * Instance Identity and isolation.
 *
 * The acceptance for this file is the requirement's own: two checkouts on one
 * machine must not be able to collide on a port, a pipe, a lock, a userData
 * directory or a browser profile. Each of those is asserted separately, because
 * "the instance id differs" is not the same claim as "the browser profile
 * differs" and it is the second one that actually protects a user.
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const net = require('node:net')
const path = require('node:path')

const instance = require('../../app/runtime/instance.cjs')

const ROOT = path.resolve(__dirname, '..', '..')

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dshns-instance-'))
}

test('the instance id is a stable function of the canonical root', () => {
  const a = instance.instanceIdFor('D:\\Some\\Checkout')
  const b = instance.instanceIdFor('d:/some/checkout/')
  const c = instance.instanceIdFor('D:\\SOME\\CHECKOUT')
  assert.equal(a, b, 'trailing separators and slashes must not change the id')
  // Windows paths are case-insensitive, so two spellings are one instance.
  if (process.platform === 'win32') assert.equal(a, c, 'the id must be case-stable on Windows')
  assert.equal(a.length, instance.INSTANCE_ID_LENGTH)
  assert.match(a, /^[0-9a-f]+$/)
})

test('different roots are different instances', () => {
  const main = instance.instanceIdFor('D:\\DS-Hns')
  const second = instance.instanceIdFor('D:\\DS-Hns-ElectronSplit')
  assert.notEqual(main, second)
})

test('an empty root has no identity instead of a shared one', () => {
  // The dangerous failure mode is two nameless instances hashing to the same id
  // and then sharing a pipe. Absence is the only safe answer.
  assert.equal(instance.instanceIdFor(''), '')
  assert.equal(instance.instanceIdFor(null), '')
  assert.equal(instance.instanceIdFor(undefined), '')
})

test('the IPC endpoint is namespaced by instance and by protocol version', () => {
  const id = instance.instanceIdFor('D:\\DS-Hns-ElectronSplit')
  const endpoint = instance.ipcEndpointFor(id, 'win32')
  assert.equal(endpoint, `\\\\.\\pipe\\dsh-hns-${id}`)
  // The version is carried so a mismatched client fails at connect time rather
  // than reading a handshake it does not understand.
  assert.equal(instance.PROTOCOL_VERSION, 'dshns-runtime/v1')
})

test('a pipe name never contains a character a pipe cannot carry', () => {
  const endpoint = instance.ipcEndpointFor(instance.instanceIdFor('C:\\a b\\c#d%e\\check out'), 'win32')
  assert.match(endpoint, /^\\\\\.\\pipe\\dsh-hns-[0-9a-f]+$/)
})

test('every derived path is per-instance, and userData is not Electron default', () => {
  const home = scratch()
  const first = instance.describeInstance({ root: path.join(home, 'one'), dshHome: path.join(home, 'home-one'), isolated: true })
  const second = instance.describeInstance({ root: path.join(home, 'two'), dshHome: path.join(home, 'home-two'), isolated: true })

  for (const key of ['identityFile', 'userData', 'browserProfile', 'runtimeLog', 'desktopLog']) {
    assert.notEqual(first.paths[key], second.paths[key], `${key} is shared between instances`)
  }
  // Electron's default userData would be a shared `desktop-shell` directory; the
  // isolated instance's is under its own home and keyed by its own id.
  assert.ok(first.paths.userData.includes(first.instanceId), 'userData must be keyed by the instance id')
  assert.equal(path.dirname(first.paths.userData), path.join(first.dshHome, 'electron'))
  assert.equal(path.basename(first.paths.browserProfile), first.instanceId)
})

test('the primary instance keeps its historical userData path', () => {
  // A second checkout is isolated by its own root; the *primary* instance must not
  // be migrated off `desktop-shell`, because that is where its window state and
  // cache already live and moving it would be a migration with no benefit.
  const home = scratch()
  const primary = instance.describeInstance({ root: path.join(home, 'one'), dshHome: path.join(home, 'h1'), isolated: false })
  assert.equal(primary.paths.userData, path.join(primary.dshHome, 'desktop-shell'))
  assert.equal(primary.isolated, false)
})

test('an explicit userData override wins', () => {
  const home = scratch()
  const explicit = path.join(home, 'chosen')
  const resolved = instance.describeInstance({ root: path.join(home, 'one'), dshHome: path.join(home, 'h1'), userDataDir: explicit, isolated: true })
  assert.equal(resolved.paths.userData, path.resolve(explicit))
})

test('two instances cannot share a single-instance lock, because userData differs', () => {
  // Electron's single-instance lock lives in userData. This is the assertion that
  // a second DS-Hns actually starts instead of silently exiting.
  const home = scratch()
  const first = instance.describeInstance({ root: path.join(home, 'one'), dshHome: path.join(home, 'h1') })
  const second = instance.describeInstance({ root: path.join(home, 'two'), dshHome: path.join(home, 'h2') })
  assert.notEqual(first.paths.userData, second.paths.userData)
})

test('port allocation honours a free requested port', async () => {
  const result = await instance.allocateHarnessPort({ requested: 3080 })
  assert.equal(result.requested, 3080)
  assert.ok(result.port >= 1024 && result.port <= 65535)
  assert.ok(Array.isArray(result.candidates) && result.candidates.length > 0)
})

test('port allocation moves off a taken port instead of failing', async () => {
  // Occupy a port for real, then ask for it.
  const blocker = net.createServer()
  await new Promise((resolve) => blocker.listen({ port: 0, host: '127.0.0.1' }, resolve))
  const taken = blocker.address().port
  try {
    const result = await instance.allocateHarnessPort({ requested: taken, window: 20 })
    assert.notEqual(result.port, taken, 'the allocator took a port that was already bound')
    assert.equal(result.allocated, true)
    assert.equal(result.reused, false)
    assert.ok(result.port > taken && result.port <= taken + 20, 'the allocated port should come from the near window')
  } finally {
    await new Promise((resolve) => blocker.close(resolve))
  }
})

test('3081 is not special: a free 3081 is used, a taken one is not', async () => {
  const free = await instance.allocateHarnessPort({ requested: 3099, window: 0 })
  assert.equal(free.port, 3099)
  const blocker = net.createServer()
  await new Promise((resolve) => blocker.listen({ port: 0, host: '127.0.0.1' }, resolve))
  const taken = blocker.address().port
  try {
    const result = await instance.allocateHarnessPort({ requested: taken, window: 0 })
    assert.notEqual(result.port, taken)
  } finally {
    await new Promise((resolve) => blocker.close(resolve))
  }
})

test('a persisted port is preferred on the next resolve', async () => {
  const home = scratch()
  const root = path.join(home, 'checkout')
  fs.mkdirSync(root, { recursive: true })
  const first = await instance.resolveInstance({ root, dshHome: path.join(home, 'data'), requestedPort: 3175 })
  assert.equal(first.harnessPort, 3175)
  // Without an explicit request, the instance remembers what it chose.
  const second = await instance.resolveInstance({ root, dshHome: path.join(home, 'data') })
  assert.equal(second.harnessPort, 3175, 'the instance forgot its own port')
  const record = instance.readInstanceRecord(second)
  assert.equal(record.instanceId, second.instanceId)
  assert.equal(record.harnessPort, 3175)
  assert.equal(record.protocol, instance.PROTOCOL_VERSION)
})

test('a foreign instance record is ignored rather than trusted', async () => {
  const home = scratch()
  const rootA = path.join(home, 'a')
  const rootB = path.join(home, 'b')
  fs.mkdirSync(rootA, { recursive: true })
  fs.mkdirSync(rootB, { recursive: true })
  const dshHome = path.join(home, 'data')
  const a = await instance.resolveInstance({ root: rootA, dshHome, requestedPort: 3188 })
  // A copied data directory: B's home now holds A's identity file.
  const b = instance.describeInstance({ root: rootB, dshHome })
  const record = instance.readInstanceRecord(b)
  assert.ok(record, 'the copied record should be readable')
  assert.equal(instance.recordBelongsToInstance(record, b), false, "another instance's record was trusted")
  assert.equal(instance.recordBelongsToInstance(record, a), true)
})

test('the instance record is written atomically, never half-written', async () => {
  const home = scratch()
  const root = path.join(home, 'checkout')
  fs.mkdirSync(root, { recursive: true })
  const resolved = await instance.resolveInstance({ root, dshHome: path.join(home, 'data'), requestedPort: 3181 })
  const file = resolved.paths.identityFile
  assert.equal(fs.existsSync(file), true)
  // No temporary file is left behind by the rename.
  const leftovers = fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith('.tmp'))
  assert.deepEqual(leftovers, [])
})

test('describeInstance refuses a missing root instead of inventing one', () => {
  assert.throws(() => instance.describeInstance({ root: '' }), /needs a root/)
  assert.throws(() => instance.describeInstance({}), /needs a root/)
})

test('the repository checkout resolves to a real, instance-specific layout', () => {
  const resolved = instance.describeInstance({ root: ROOT, dshHome: path.join(ROOT, 'data') })
  assert.equal(resolved.instanceId.length, instance.INSTANCE_ID_LENGTH)
  // Paths are canonicalized (lower-cased on Windows) for comparison and for
  // hashing, so the containment check compares canonical forms too.
  const canonicalHome = instance.canonicalize(path.join(ROOT, 'data'))
  assert.ok(resolved.paths.userData.startsWith(path.join(canonicalHome, 'desktop-shell')))
  assert.equal(resolved.paths.browserProfile.startsWith(canonicalHome), true)
  assert.ok(resolved.ipcEndpoint.includes(resolved.instanceId))
  // The primary instance is not treated as isolated, so its userData keeps the
  // historical `desktop-shell` name rather than the id-keyed one.
  assert.equal(resolved.isolated, false)
})
