'use strict'

/**
 * The governance bridge (`updateplan/pluginize.md` Phase 1: "Plugin registry bridge" + "Protection bridge").
 *
 * The plan moves Mega out of this product's own window and into the official Harness UI as a **plugin** — and
 * that plugin runs in the *Harness* process, not in this one. So the two halves need a channel, and this is it:
 * a loopback-only HTTP endpoint that answers what the plugin needs to know (plugin registry, protection state,
 * capabilities, versions, pending human work) and accepts the actions governance is allowed to take.
 *
 * Four properties, because this is the one place where a plugin can reach into this product's state:
 *
 *   1. **Loopback only.** It binds `127.0.0.1` and refuses any other host, so "the plugin can read governance"
 *      never becomes "anything on the network can".
 *   2. **A per-run token.** The token is generated with `crypto.randomBytes` at every start and written beside
 *      the port in a discovery file. A token that outlived the process would be a password nobody rotated.
 *   3. **Read is a snapshot, write is a named action.** The plugin asks for data, or asks for one of a closed
 *      set of actions (`check`, `retry`, `reset-fallback`, `repair`, `disable`, `enable`). There is no "call
 *      this function" surface, which is what keeps a UI plugin from becoming a remote control for the kernel.
 *   4. **The bridge is optional.** If it cannot bind (a busy environment, a sandbox), the product runs exactly
 *      as before and says so; the plugin then reports "governance unavailable" instead of inventing an answer.
 *
 * The discovery file lives under `$DSH_HOME/state/` — the same directory the Harness child is spawned with — so
 * the host half of the plugin can find it by environment rather than by a hard-coded path.
 */

const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')

/** The only host this bridge may listen on. */
const LOOPBACK = '127.0.0.1'

/** The actions a client may ask for, and nothing else (`updateplan/pluginize.md` §22's governance boundary). */
const BRIDGE_ACTIONS = Object.freeze(['check', 'retry', 'reset-fallback', 'repair', 'disable', 'enable'])

/**
 * The bridge's own state schema, so a later version can migrate rather than guess.
 *
 * 2 adds the two opt-in halves of the timing surface (`updateplan/pluginize.md` Phase 2): `timing()` answers how a
 * scheduled task may be timed, and `createTask()` asks for one. **`BRIDGE_ACTIONS` is unchanged**: scheduling is
 * not a recovery action on a module, so it does not widen what a plugin may ask governance to *do* to the layer.
 */
const BRIDGE_FILE_VERSION = 2

function json(response, status, body) {
  const text = JSON.stringify(body)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store' })
  response.end(text)
}

/**
 * @param {object}   options
 * @param {string}   options.stateDir   where the discovery file goes (the Harness' `$DSH_HOME/state`)
 * @param {Function} options.snapshot   () => the governance snapshot (plugin registry + protection + boot)
 * @param {Function} options.act        async ({ action, id }) => { ok, ... }
 * @param {Function} [options.timing]   () => what a scheduled task may be (windows, peak/valley, defaults)
 * @param {Function} [options.createTask] async ({ prompt, startAt, allowPeak }) => { ok, task }
 * @param {Function} [options.log]
 * @param {string}   [options.host]     test seam; only loopback is accepted
 * @param {number}   [options.port]     0 for an ephemeral port
 */
function createGovernanceBridge({ stateDir, snapshot, act, timing = null, createTask = null, log = () => {}, host = LOOPBACK, port = 0 } = {}) {
  if (!stateDir) throw new Error('the governance bridge needs a state directory')
  if (typeof snapshot !== 'function') throw new Error('the governance bridge needs a snapshot()')
  if (host !== LOOPBACK) throw new Error(`the governance bridge is loopback-only; "${host}" is not ${LOOPBACK}`)

  const token = crypto.randomBytes(32).toString('base64url')
  const discoveryFile = path.join(stateDir, 'governance-bridge.json')
  let server = null
  let listening = null
  let requests = 0
  let refused = 0
  let lastError = null

  function authorized(request) {
    const header = String(request.headers.authorization || '')
    const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : (String(request.headers['x-hns-token'] || ''))
    if (!presented) return false
    const a = Buffer.from(presented)
    const b = Buffer.from(token)
    // Constant-time: an equality check on a secret is a timing oracle.
    return a.length === b.length && crypto.timingSafeEqual(a, b)
  }

  function readBody(request, limit = 64 * 1024) {
    return new Promise((resolve, reject) => {
      let size = 0
      const chunks = []
      request.on('data', (chunk) => {
        size += chunk.length
        if (size > limit) {
          reject(new Error('body too large'))
          request.destroy()
          return
        }
        chunks.push(chunk)
      })
      request.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if (!text) return resolve({})
        try {
          resolve(JSON.parse(text))
        } catch (error) {
          reject(new Error(`the request body is not JSON: ${error.message}`))
        }
      })
      request.on('error', reject)
    })
  }

  async function handle(request, response) {
    requests += 1
    const url = new URL(request.url, `http://${LOOPBACK}`)
    // Liveness is the one answer that needs no secret: the plugin uses it to decide whether to show anything.
    if (url.pathname === '/health') return json(response, 200, { ok: true, service: 'hns-governance-bridge', version: BRIDGE_FILE_VERSION })
    if (!authorized(request)) {
      refused += 1
      return json(response, 401, { ok: false, reason: 'a bearer token is required' })
    }
    if (url.pathname === '/governance' && request.method === 'GET') {
      try {
        return json(response, 200, { ok: true, ...snapshot() })
      } catch (error) {
        lastError = String(error?.message || error)
        return json(response, 500, { ok: false, reason: lastError })
      }
    }
    if (url.pathname === '/action' && request.method === 'POST') {
      let body = null
      try {
        body = await readBody(request)
      } catch (error) {
        return json(response, 400, { ok: false, reason: String(error?.message || error) })
      }
      const action = String(body.action || '')
      const id = String(body.id || '')
      if (!BRIDGE_ACTIONS.includes(action)) return json(response, 400, { ok: false, reason: `"${action}" is not a governance action; expected ${BRIDGE_ACTIONS.join(', ')}` })
      if (!id) return json(response, 400, { ok: false, reason: 'an action needs an id' })
      try {
        const result = await act({ action, id })
        return json(response, result?.ok === false ? 409 : 200, { ok: result?.ok !== false, action, id, result: result || null })
      } catch (error) {
        lastError = String(error?.message || error)
        log(`governance action ${action} failed: ${lastError}`)
        return json(response, 500, { ok: false, action, id, reason: lastError })
      }
    }
    /**
     * What a scheduled task may be: the timing surface, for a UI that has to offer the choices without guessing.
     *
     * It is a **separate endpoint from `/governance`** on purpose. The snapshot is the Control Center's answer and
     * is assembled on every poll; this is a question about a capability, it is asked once when a dialog opens, and
     * mixing the two would make "governance is slow" and "the timing surface is missing" the same symptom.
     */
    if (url.pathname === '/timing' && request.method === 'GET') {
      if (typeof timing !== 'function') return json(response, 404, { ok: false, reason: 'this DS-Hns does not answer timing questions' })
      try {
        return json(response, 200, { ok: true, ...timing() })
      } catch (error) {
        lastError = String(error?.message || error)
        return json(response, 500, { ok: false, reason: lastError })
      }
    }
    /**
     * Schedule a task. `POST /task` with `{ prompt, startAt?, allowPeak? }`, answered with the task the scheduler
     * actually recorded — its id, its status and the instant it will run — never with a hopeful `{ ok: true }`.
     */
    if (url.pathname === '/task' && request.method === 'POST') {
      if (typeof createTask !== 'function') return json(response, 404, { ok: false, reason: 'this DS-Hns cannot schedule tasks' })
      let body = null
      try {
        body = await readBody(request)
      } catch (error) {
        return json(response, 400, { ok: false, reason: String(error?.message || error) })
      }
      try {
        const result = await createTask(body || {})
        // 400 for a request the scheduler refused on its merits (no prompt, a time in the past); 200 only for a
        // task that now exists.
        return json(response, result?.ok === false ? 400 : 200, result || { ok: false, reason: 'no answer' })
      } catch (error) {
        lastError = String(error?.message || error)
        log(`scheduling a task failed: ${lastError}`)
        return json(response, 500, { ok: false, reason: lastError })
      }
    }
    return json(response, 404, { ok: false, reason: `"${url.pathname}" is not part of the governance bridge` })
  }

  /** Start listening and publish the discovery file. Answers; does not throw. */
  function start() {
    if (listening) return Promise.resolve(listening)
    listening = new Promise((resolve) => {
      try {
        server = http.createServer((request, response) => {
          handle(request, response).catch((error) => {
            lastError = String(error?.message || error)
            try { json(response, 500, { ok: false, reason: lastError }) } catch {}
          })
        })
        server.on('error', (error) => {
          lastError = String(error?.message || error)
          server = null
          resolve({ ok: false, reason: lastError })
        })
        server.listen(port, LOOPBACK, () => {
          const address = server.address()
          const discovery = {
            version: BRIDGE_FILE_VERSION,
            service: 'hns-governance-bridge',
            host: LOOPBACK,
            port: address.port,
            token,
            pid: process.pid,
            startedAt: new Date().toISOString()
          }
          try {
            fs.mkdirSync(stateDir, { recursive: true })
            // 0600: the token is a secret on disk, and the plugin runs as the same user.
            fs.writeFileSync(discoveryFile, `${JSON.stringify(discovery, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
          } catch (error) {
            lastError = `the discovery file could not be written: ${error?.message || error}`
            log(lastError)
          }
          log(`governance bridge listening on http://${LOOPBACK}:${address.port} (token in ${discoveryFile})`)
          resolve({ ok: true, host: LOOPBACK, port: address.port, discoveryFile })
        })
      } catch (error) {
        lastError = String(error?.message || error)
        resolve({ ok: false, reason: lastError })
      }
    })
    return listening
  }

  /** Stop listening and remove the discovery file (a stale token must not outlive its process). */
  function stop() {
    return new Promise((resolve) => {
      try {
        if (fs.existsSync(discoveryFile)) fs.rmSync(discoveryFile, { force: true })
      } catch (error) {
        log(`the discovery file could not be removed: ${error?.message || error}`)
      }
      if (!server) return resolve({ ok: true, stopped: false })
      const closing = server
      server = null
      listening = null
      closing.close(() => resolve({ ok: true, stopped: true }))
      // A keep-alive client must not hold the process open.
      try { closing.closeAllConnections?.() } catch {}
    })
  }

  return {
    BRIDGE_ACTIONS,
    start,
    stop,
    token: () => token,
    file: discoveryFile,
    describe: () => ({
      ok: Boolean(server),
      host: LOOPBACK,
      port: server && server.address() ? server.address().port : null,
      discoveryFile,
      requests,
      refused,
      lastError,
      actions: [...BRIDGE_ACTIONS],
      // Whether the two timing halves are wired, so the Control Center's diagnostics row can say which bridge a
      // plugin is talking to (a plugin asking for a surface this host does not have would 404, not lie).
      timing: typeof timing === 'function',
      tasks: typeof createTask === 'function'
    })
  }
}

module.exports = { createGovernanceBridge, BRIDGE_ACTIONS, BRIDGE_FILE_VERSION, LOOPBACK }
