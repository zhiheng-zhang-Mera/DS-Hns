'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')
const { resolveTestRoot } = require('../../app/runtime/storage-roots.cjs')
const identity = require('../../app/runtime/instance.cjs')
const { createRuntimeHost } = require('../../app/runtime/host.cjs')
const protocol = require('../../app/runtime/protocol.cjs')

// Catches the actual fresh17 reopen break: resolving a client must not allocate
// a replacement port or erase the existing live Host's authoritative record.
// Real Host IPC and filesystem; TCP listener represents the occupied Harness
// port, not a claim that this unit test runs the official Harness or Electron.
test('resolving a reopened shell preserves a live Host port and ownership record', async () => {
  const testRoot = resolveTestRoot(path.resolve(__dirname, '../..'))
  fs.mkdirSync(testRoot, { recursive: true })
  const root = fs.mkdtempSync(path.join(testRoot, 'reopen-identity-'))
  const dshHome = path.join(root, 'data')
  const listener = net.createServer()
  await new Promise((resolve, reject) => {
    listener.once('error', reject)
    listener.listen(0, '127.0.0.1', resolve)
  })
  const port = listener.address().port
  const host = createRuntimeHost({ root, dshHome, port })
  try {
    await host.listen()
    const descriptor = identity.describeInstance({ root, dshHome })
    const before = fs.readFileSync(descriptor.paths.identityFile, 'utf8')
    const reopened = await identity.resolveInstance({ root, dshHome, requestedPort: port })
    assert.equal(reopened.harnessPort, port, 'shell allocated away from its live Host')
    assert.equal(fs.readFileSync(descriptor.paths.identityFile, 'utf8'), before,
      'client resolution overwrote the live Host ownership record')
    assert.equal(identity.readInstanceRecord(reopened).hostPid, process.pid)
  } finally {
    await host.shutdown({ reason: 'reopen identity test complete' })
    await new Promise(resolve => listener.close(resolve))
  }
})

test('a reachable foreign IPC endpoint cannot overwrite or authorize the instance record', async () => {
  const testRoot = resolveTestRoot(path.resolve(__dirname, '../..'))
  fs.mkdirSync(testRoot, { recursive: true })
  const root = fs.mkdtempSync(path.join(testRoot, 'reopen-foreign-'))
  const options = { root, dshHome: path.join(root, 'data') }
  const descriptor = identity.describeInstance(options)
  identity.writeInstanceRecord({ ...descriptor, harnessPort: 31972 }, { hostPid: 12345 })
  const before = fs.readFileSync(descriptor.paths.identityFile, 'utf8')
  // Deliberately wrong peer, not a mock of the resolver or Host under test.
  const peer = net.createServer(socket => {
    socket.setEncoding('utf8')
    let buffer = ''
    socket.on('data', chunk => {
      const decoded = protocol.decode(buffer + chunk)
      buffer = decoded.remainder
      for (const frame of decoded.frames) socket.write(protocol.encode(protocol.reply('welcome', frame.id, {
        protocol: protocol.PROTOCOL_VERSION, instanceId: 'foreign', root, dshHome: options.dshHome,
        hostPid: process.pid, harnessPort: 31972
      })))
    })
  })
  await new Promise((resolve, reject) => { peer.once('error', reject); peer.listen(descriptor.ipcEndpoint, resolve) })
  try {
    await assert.rejects(identity.resolveInstance(options), /did not match/)
    assert.equal(fs.readFileSync(descriptor.paths.identityFile, 'utf8'), before)
  } finally {
    await new Promise(resolve => peer.close(resolve))
  }
})

test('stale Host metadata does not authorize reuse of an occupied TCP port', async () => {
  const testRoot = resolveTestRoot(path.resolve(__dirname, '../..'))
  fs.mkdirSync(testRoot, { recursive: true })
  const root = fs.mkdtempSync(path.join(testRoot, 'reopen-stale-'))
  const options = { root, dshHome: path.join(root, 'data') }
  const listener = net.createServer()
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve))
  const port = listener.address().port
  identity.writeInstanceRecord({ ...identity.describeInstance(options), harnessPort: port }, { hostPid: 0x7ffffff0 })
  try {
    const resolved = await identity.resolveInstance({ ...options, requestedPort: port })
    assert.notEqual(resolved.harnessPort, port)
    assert.equal(identity.readInstanceRecord(resolved).hostPid, undefined)
  } finally {
    await new Promise(resolve => listener.close(resolve))
  }
})

test('Host authority record retains explicitly isolated shell identity paths', async () => {
  const testRoot = resolveTestRoot(path.resolve(__dirname, '../..'))
  fs.mkdirSync(testRoot, { recursive: true })
  const root = fs.mkdtempSync(path.join(testRoot, 'reopen-custom-'))
  const options = { root, dshHome: path.join(root, 'data'), appName: 'Reopen fixture', userDataDir: path.join(root, 'ui-data') }
  const host = createRuntimeHost({ ...options, port: 31971 })
  try {
    await host.listen()
    const descriptor = identity.describeInstance(options)
    const record = identity.readInstanceRecord(descriptor)
    assert.equal(record.userData, options.userDataDir)
    assert.equal(identity.recordBelongsToInstance(record, descriptor), true)
  } finally {
    await host.shutdown({ reason: 'custom identity test complete' })
  }
})
