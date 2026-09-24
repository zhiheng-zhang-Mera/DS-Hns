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
const { resolveTestRoot } = require('../../app/runtime/storage-roots.cjs')
const net = require('node:net')
const path = require('node:path')

const instance = require('../../app/runtime/instance.cjs')

const ROOT = path.resolve(__dirname, '..', '..')

function scratch() {
  const testRoot = resolveTestRoot(ROOT)
  fs.mkdirSync(testRoot, { recursive: true })
  return fs.mkdtempSync(path.join(testRoot, 'dshns-instance-'))
}

test('the instance id is a stable function of the canonical root and home', () => {
  const a = instance.instanceIdFor('D:\\Some\\Checkout', 'D:\\Some\\Checkout\\data')
  const b = instance.instanceIdFor('d:/some/checkout/', 'D:/some/checkout/data/')
  assert.equal(a, b, 'trailing separators and slashes must not change the id')
  assert.equal(a.length, instance.INSTANCE_ID_LENGTH)
  assert.match(a, /^[0-9a-f]+$/)
  // Omitting the home means `<root>/data`, which is what the Runtime Host and the
  // installer use when nothing overrides it.
  assert.equal(a, instance.instanceIdFor('D:\\Some\\Checkout'))
})

test('one checkout served from two data directories is two instances', () => {
  // This is what stops an id derived from the root alone: the id names the IPC
  // endpoint and the Electron userData (and therefore the single-instance lock),
  // so sharing it would let a second run attach to the first one's Runtime, or
  // silently refuse to start.
  const same = instance.instanceIdFor('D:\\One\\Checkout', 'D:\\One\\Checkout\\data')
  const other = instance.instanceIdFor('D:\\One\\Checkout', 'D:\\One\\data-2')
  assert.notEqual(same, other)
})

test('every input that changes a derived path also changes the id', () => {
  /**
   * The property, stated once: if two runs differ in *anything* that decides a
   * derived path or endpoint, they must not share an id — because the id is what
   * names the IPC endpoint and the Electron single-instance lock.
   *
   * Each of these was a real collision at some point while this was built: the id
   * started from the root alone, then the root and the home, and only hashing the
   * whole discriminator made the invariant hold.
   */
  const base = { root: 'D:\\One\\Checkout', dshHome: 'D:\\One\\Checkout\\data' }
  const plain = instance.describeInstance({ ...base, isolated: false })
  const named = instance.describeInstance({ ...base, appName: 'DS-Hns (second)', isolated: true })
  const custom = instance.describeInstance({ ...base, isolated: true, userDataDir: 'D:\\One\\userData-custom' })
  const otherHome = instance.describeInstance({ root: base.root, dshHome: 'D:\\One\\data-2', isolated: true })
  const otherRoot = instance.describeInstance({ root: 'D:\\Two\\Checkout', dshHome: base.dshHome, isolated: true })

  const ids = [plain, named, custom, otherHome, otherRoot].map((each) => each.instanceId)
  assert.equal(new Set(ids).size, ids.length, `ids collided: ${ids.join(', ')}`)

  // And the endpoint follows the id, so no two of them share a pipe either.
  const endpoints = [plain, named, custom, otherHome, otherRoot].map((each) => each.ipcEndpoint)
  assert.equal(new Set(endpoints).size, endpoints.length, 'two instances share an IPC endpoint')

  // The userData that the lock lives in follows too, which is the point of all of it.
  const userDatas = [plain, named, custom, otherHome, otherRoot].map((each) => each.paths.userData)
  assert.equal(new Set(userDatas).size, userDatas.length, 'two instances share an Electron userData')
})

test('a record is trusted only when its id, root and userData all belong to this instance', () => {
  const home = scratch()
  const rootA = path.join(home, 'a')
  fs.mkdirSync(rootA, { recursive: true })
  const a = instance.describeInstance({ root: rootA, dshHome: path.join(home, 'h-a'), appName: 'Named Run', isolated: true })
  const b = instance.describeInstance({ root: rootA, dshHome: path.join(home, 'h-a'), appName: 'Other Run', isolated: true })
  const record = instance.writeInstanceRecord({ ...a, harnessPort: 3188 })

  assert.equal(instance.recordBelongsToInstance(record, a), true)
  // A differently-named run of the same checkout is a different instance.
  assert.equal(instance.recordBelongsToInstance(record, b), false)

  /**
   * The same id with a different root, or with no recorded userData, is refused.
   *
   * The second case is the one a hand-written or older record produces: the id
   * alone would trust it, and the root alone would too.
   */
  assert.equal(instance.recordBelongsToInstance({ ...record, root: 'D:\\elsewhere' }, a), false, 'a record naming another root was trusted')
  assert.equal(instance.recordBelongsToInstance({ ...record, userData: undefined }, a), false, 'a record with no userData was trusted')
  assert.equal(instance.recordBelongsToInstance({ ...record, userData: path.join(home, 'other-user-data') }, a), false, 'a record naming another userData was trusted')
  assert.equal(instance.recordBelongsToInstance(null, a), false)
  assert.equal(instance.recordBelongsToInstance(record, null), false)
})

test('different roots are different instances', () => {
  const main = instance.instanceIdFor('D:\\DS-Hns', 'D:\\DS-Hns\\data')
  const second = instance.instanceIdFor('D:\\DS-Hns-ElectronSplit', 'D:\\DS-Hns-ElectronSplit\\data')
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
  const id = instance.instanceIdFor('D:\\DS-Hns-ElectronSplit', 'D:\\DS-Hns-ElectronSplit\\data')
  const endpoint = instance.ipcEndpointFor(id, 'win32')
  assert.equal(endpoint, `\\\\.\\pipe\\dsh-hns-${id}`)
  // The version is carried so a mismatched client fails at connect time rather
  // than reading a handshake it does not understand.
  assert.equal(instance.PROTOCOL_VERSION, 'dshns-runtime/v1')
})

test('a pipe name never contains a character a pipe cannot carry', () => {
  const endpoint = instance.ipcEndpointFor(instance.instanceIdFor('C:\\a b\\c#d%e\\check out', 'C:\\home'), 'win32')
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
  // Derived paths keep the operating system's spelling, so they are compared
  // against the resolved root rather than against a case-folded form.
  const realRoot = instance.resolveRoot(ROOT)
  assert.equal(resolved.root, realRoot)
  assert.equal(resolved.paths.userData, path.join(realRoot, 'data', 'desktop-shell'))
  assert.equal(resolved.paths.browserProfile.startsWith(realRoot), true)
  assert.ok(resolved.ipcEndpoint.includes(resolved.instanceId))
  // The primary instance is not treated as isolated, so its userData keeps the
  // historical `desktop-shell` name rather than the id-keyed one.
  assert.equal(resolved.isolated, false)
})

test('a root that does not exist yet canonicalizes its ancestor and preserves its missing tail', () => {
  const dir = scratch()
  const mixed = path.join(dir, 'MixedCaseRoot-ABC', 'checkout')
  const resolved = instance.describeInstance({ root: mixed, dshHome: path.join(dir, 'data') })
  // Windows runners may expose TEMP through an 8.3 alias such as RUNNER~1 even
  // though the filesystem reports the existing ancestor as `runneradmin`.
  // Existing segments therefore take their canonical filesystem spelling while
  // the not-yet-created tail must retain the caller's exact case.
  const canonicalDir = fs.realpathSync.native(dir)
  assert.equal(resolved.root, path.join(canonicalDir, 'MixedCaseRoot-ABC', 'checkout'))
  assert.equal(path.relative(canonicalDir, resolved.root), path.join('MixedCaseRoot-ABC', 'checkout'))
  assert.equal(fs.existsSync(dir), true)
})
