'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const net = require('node:net')
const { findFreePort, tryListen } = require('../../app/extensions/mega/utils/ports')

function listenOnce(port) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.once('listening', () => resolve(srv))
    srv.listen(port, '127.0.0.1')
  })
}

test('findFreePort returns a bindable port', async () => {
  const base = 20000 + (process.pid % 5000)
  const port = await findFreePort(base)
  assert.ok(port >= base && port < base + 30)
  assert.equal(await tryListen(port, '127.0.0.1'), true)
})

test('findFreePort staggers past occupied base', async () => {
  const base = 21000 + (process.pid % 5000)
  const blocker = await listenOnce(base)
  try { assert.equal(await findFreePort(base), base + 1) } finally { blocker.close() }
})
