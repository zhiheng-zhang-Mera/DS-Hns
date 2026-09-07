'use strict'
const net = require('node:net')

/**
 * Smallest free-port helper used at startup so the desktop shell and the
 * monitor automatically “stagger” away from a busy default port
 * (3080 for the dsh Web engine, 3300 for the 调度中心 monitor).
 */

function tryListen(port, host) {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.once('listening', () => srv.close(() => resolve(true)))
    srv.listen(port, host)
  })
}

/**
 * Returns the first free TCP port at/after `start` (loopback only).
 * Throws when none of the candidates is free.
 */
async function findFreePort(start, { host = '127.0.0.1', maxTries = 30 } = {}) {
  const base = Number(start)
  const first = Number.isInteger(base) && base > 0 && base < 65535 ? base : 3000
  for (let i = 0; i < maxTries; i++) {
    const candidate = first + i
    if (candidate > 65535) break
    if (await tryListen(candidate, host)) return candidate
  }
  throw new Error(`未找到 ${first} 起 ${maxTries} 个范围内的可用端口`)
}

module.exports = { findFreePort, tryListen }
