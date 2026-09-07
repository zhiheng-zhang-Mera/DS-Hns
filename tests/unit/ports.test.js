'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const net = require('node:net')
const { findFreePort, tryListen } = require('../../app/monitor/utils/ports')

function listenOnce(port) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.once('listening', () => resolve(srv))
    srv.listen(port, '127.0.0.1')
  })
}

test('findFreePort returns a bindable port at/after the base', async () => {
  const base = 20000 + (process.pid % 5000)
  const port = await findFreePort(base)
  assert.ok(port >= base && port < base + 30)
  assert.equal(await tryListen(port, '127.0.0.1'), true)
})

test('findFreePort staggers past an occupied base port', async () => {
  const base = 21000 + (process.pid % 5000)
  const blocker = await listenOnce(base)
  try {
    const port = await findFreePort(base)
    assert.equal(port, base + 1)
  } finally {
    blocker.close()
  }
})

test('findFreePort throws when the whole range is busy', async () => {
  const base = 22000 + (process.pid % 5000)
  const blockers = []
  try {
    blockers.push(await listenOnce(base))
    blockers.push(await listenOnce(base + 1))
    await assert.rejects(() => findFreePort(base, { maxTries: 2 }), /未找到/)
  } finally {
    for (const s of blockers) s.close()
  }
})
