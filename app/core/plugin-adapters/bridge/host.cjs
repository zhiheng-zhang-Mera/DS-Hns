'use strict'

/**
 * The bridge's host side: the process that owns the real services.
 *
 * This is the half that makes the containment claim checkable. The plugin's process can only send
 * *descriptions of intentions*; every one of them arrives here, is validated against the closed
 * vocabulary in `contract.cjs`, and is then performed — or refused — by code that holds the actual
 * service. At no point does a host object travel in the other direction, and at no point does the
 * child get to name a target that this file does not recognise.
 *
 * Three design points worth stating, because each is a way this could have been built wrong:
 *
 *   1. **The host owns the socket.** The plugin's handler runs in the child, but routing, headers,
 *      status and the response stream are the host's. That is what lets a bridged route be served
 *      on the harness's existing web server rather than on a second one the plugin opened.
 *   2. **Refusals are answers, not silence.** A refused call resolves the plugin's promise with a
 *      coded refusal and is recorded on the bridge's capability report, so the plugin keeps running
 *      and the reason it has no route is visible in its health surface.
 *   3. **Teardown is total.** Routes are disposed, pending calls and requests are failed, the child
 *      is asked to unwind and then killed if it will not. A disabled plugin must leave no route, no
 *      timer and no process behind, because "disable" that leaks a route is not disable.
 */

const path = require('node:path')
const { spawn: defaultSpawn } = require('node:child_process')

const {
  BRIDGE_API_VERSION,
  BRIDGE_MESSAGES,
  BRIDGE_FAULT_CODES,
  BRIDGE_LIMITS,
  BRIDGE_REPORT_PREFIX,
  bridgeFault,
  validateBridgeCall,
  normalizeRoutePath,
  summarizeArgs
} = require('./contract.cjs')

const LIFECYCLE = Object.freeze({
  IDLE: 'idle',
  ACTIVATING: 'activating',
  ACTIVE: 'active',
  FAILED: 'failed',
  STOPPED: 'stopped'
})

/** A coded refusal in the shape the plugin manager and the panel both read. */
function toError(code, reason) {
  const error = new Error(reason)
  error.code = code
  return error
}

/**
 * A minimal, real `webServer` service for an embedder that does not have one.
 *
 * It implements exactly the contract a community plugin's `inject: ['webServer']` expects —
 * `register({ kind, path, handler })` returning a disposer — on a real `node:http` server. The
 * harness has its own; this exists so the bridge can be exercised, and so an embedder that is not
 * the harness still mounts bridged routes on a socket the *host* owns rather than one the plugin
 * opened.
 */
function createHostWebServer(options = {}) {
  const http = require('node:http')
  const log = typeof options.log === 'function' ? options.log : () => {}
  const routes = []
  let server = null
  let port = null

  const matches = (route, url) => {
    const pathname = String(url || '/').split('?')[0]
    if (route.kind === 'exact') return pathname === route.path
    if (route.kind === 'prefix') return pathname.startsWith(route.path)
    return false
  }

  const instance = {
    get port() {
      return port
    },
    get server() {
      return server
    },
    register(route) {
      if (!route || typeof route !== 'object') throw new Error('webserver: a route object is required')
      if (typeof route.handler !== 'function') throw new Error('webserver: a route needs a handler')
      const kind = route.kind === 'prefix' ? 'prefix' : 'exact'
      const normalized = normalizeRoutePath(route.path)
      if (normalized.ok !== true) throw new Error(`webserver: ${normalized.reason}`)
      if (routes.some((existing) => existing.kind === kind && existing.path === normalized.path)) {
        throw new Error(`webserver: duplicate (${kind}, ${normalized.path})`)
      }
      const entry = { kind, path: normalized.path, handler: route.handler }
      routes.push(entry)
      return () => {
        const index = routes.indexOf(entry)
        if (index >= 0) routes.splice(index, 1)
      }
    },
    /** Start listening. `port: 0` lets the OS pick, which is what a test wants. */
    listen(input = {}) {
      const host = String(input.host || '127.0.0.1')
      const wanted = Number.isInteger(input.port) ? input.port : 0
      server = http.createServer((req, res) => {
        let chosen = null
        for (const route of routes) {
          if (!matches(route, req.url)) continue
          if (route.kind === 'exact') {
            chosen = route
            break
          }
          if (!chosen || route.path.length > chosen.path.length) chosen = route
        }
        if (!chosen) {
          res.writeHead(404, { 'content-type': 'text/plain' })
          res.end('not found\n')
          return
        }
        try {
          chosen.handler(req, res)
        } catch (error) {
          log(`a host route handler threw: ${error && error.message ? error.message : error}`)
          if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' })
          res.end('handler failed\n')
        }
      })
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(wanted, host, () => {
          port = server.address().port
          resolve({ host, port })
        })
      })
    },
    close() {
      return new Promise((resolve) => {
        if (!server) return resolve(false)
        server.close(() => resolve(true))
        server = null
      })
    },
    /** The routes currently mounted, for the acceptance report. */
    routes: () => routes.map((route) => ({ kind: route.kind, path: route.path }))
  }
  return instance
}

/**
 * @param {object} input
 * @param {string} input.id the plugin id the bridge reports as
 * @param {string} input.dir the plugin directory
 * @param {string} input.entry the entry, package-relative
 * @param {object} [input.config] the resolved plugin configuration
 * @param {string[]} [input.roots] directories that provide host dependencies
 * @param {object} [input.services] the real services: `{ webServer, settings }`
 * @param {string} [input.nodeExe]
 * @param {Function} [input.spawn] injectable, for tests
 * @param {Function} [input.log]
 * @param {Function} [input.now]
 * @param {object} [input.limits]
 */
function createCordisBridge(input = {}) {
  const id = String(input.id || 'unknown')
  const dir = path.resolve(String(input.dir || '.'))
  const log = typeof input.log === 'function' ? input.log : () => {}
  const now = typeof input.now === 'function' ? input.now : () => Date.now()
  const spawn = typeof input.spawn === 'function' ? input.spawn : defaultSpawn
  const nodeExe = String(input.nodeExe || process.execPath)
  const services = input.services && typeof input.services === 'object' ? input.services : {}
  const limits = { ...BRIDGE_LIMITS, ...(input.limits && typeof input.limits === 'object' ? input.limits : {}) }

  let child = null
  let state = LIFECYCLE.IDLE
  let lastFailure = null
  let activatedAt = null
  let stoppedAt = null

  /** routeToken → the disposer the real service returned. */
  const mountedRoutes = new Map()
  /** callId → `{ timer }` while a mediated call is awaiting its answer. */
  const pendingCalls = new Map()
  /** requestId → `{ res, timer }` while a forwarded request is in flight. */
  const pendingRequests = new Map()

  const capabilityUses = []
  const refusals = []
  const pluginLogs = []
  let requestCount = 0

  let stdoutBuffer = ''
  let stderrTail = ''
  let settleReady = null
  let settleExit = null

  function record(refusal, context = {}) {
    const entry = { ...refusal, at: now(), ...context }
    refusals.push(entry)
    if (refusals.length > 100) refusals.shift()
    log({ kind: 'bridge-refusal', plugin: id, code: entry.code, reason: entry.reason, ...context })
    return entry
  }

  function sendToChild(message) {
    if (!child || child.killed || child.exitCode !== null) return false
    try {
      child.stdin.write(`${BRIDGE_REPORT_PREFIX}${JSON.stringify(message)}\n`)
      return true
    } catch {
      return false
    }
  }

  // -------------------------------------------------------------------------------------------
  // Mediated calls: the plugin's intentions, validated and then performed by the host.
  // -------------------------------------------------------------------------------------------

  function answerCall(callId, outcome) {
    const entry = pendingCalls.get(String(callId))
    if (entry) {
      clearTimeout(entry.timer)
      pendingCalls.delete(String(callId))
    }
    if (outcome && outcome.ok === true) sendToChild({ kind: BRIDGE_MESSAGES.CALL_RESULT, callId, ok: true, result: outcome.result === undefined ? null : outcome.result })
    else {
      const refusal = outcome && outcome.code ? outcome : bridgeFault(BRIDGE_FAULT_CODES.MALFORMED_MESSAGE, 'the host could not apply the call')
      sendToChild({ kind: BRIDGE_MESSAGES.CALL_RESULT, callId, ok: false, code: refusal.code, reason: refusal.reason })
    }
  }

  /**
   * Mount one route on the host's real web server, with a handler that forwards to the child.
   *
   * The plugin's own handler never leaves the child. What crosses is the request and the response
   * stream, which is the only way a bridged handler can be real without the host handing anything
   * over.
   */
  function registerRoute(token, args) {
    const route = args && typeof args[0] === 'object' ? args[0] : null
    if (!route) return bridgeFault(BRIDGE_FAULT_CODES.MISSING_ARGUMENT, 'webServer.register needs a route object')
    const kind = String(route.kind || 'exact')
    if (!['exact', 'prefix'].includes(kind)) {
      return bridgeFault(BRIDGE_FAULT_CODES.BAD_KIND, `a route kind must be exact or prefix, got ${kind}`)
    }
    const normalized = normalizeRoutePath(route.path)
    if (normalized.ok !== true) return normalized
    if (!token) return bridgeFault(BRIDGE_FAULT_CODES.MISSING_ARGUMENT, 'a route registration needs its token')
    if (mountedRoutes.has(token)) return bridgeFault(BRIDGE_FAULT_CODES.DUPLICATE_ROUTE, `the route token ${token} is already mounted`)
    if (mountedRoutes.size >= limits.maxRoutes) {
      return bridgeFault(BRIDGE_FAULT_CODES.ROUTE_LIMIT, `this plugin already holds ${limits.maxRoutes} routes, which is the bridge's limit`)
    }
    if (!services.webServer || typeof services.webServer.register !== 'function') {
      return bridgeFault(BRIDGE_FAULT_CODES.SERVICE_UNAVAILABLE, 'the host has no webServer service, so a route cannot be mounted')
    }

    const handler = (req, res) => forwardRequest(token, req, res)
    let dispose = null
    try {
      dispose = services.webServer.register({ kind, path: normalized.path, handler })
    } catch (error) {
      return bridgeFault(BRIDGE_FAULT_CODES.DUPLICATE_ROUTE, `the host refused the route (${kind}, ${normalized.path}): ${error && error.message ? error.message : error}`)
    }
    mountedRoutes.set(token, { dispose, kind, path: normalized.path })
    return { ok: true, result: { token, kind, path: normalized.path } }
  }

  function unregisterRoute(token) {
    const mounted = mountedRoutes.get(String(token))
    if (!mounted) return { ok: true, result: { already: true } }
    mountedRoutes.delete(String(token))
    try {
      if (typeof mounted.dispose === 'function') mounted.dispose()
    } catch (error) {
      record(bridgeFault(BRIDGE_FAULT_CODES.MALFORMED_MESSAGE, `disposing a route threw: ${error && error.message ? error.message : error}`), { token })
    }
    return { ok: true, result: { removed: true } }
  }

  function applyCall(call) {
    if (call.capabilityName === 'webServer') {
      if (call.method === 'register') return registerRoute(call.token, call.args)
      if (call.method === 'unregister') return unregisterRoute(call.token || (call.args && call.args[0]))
    }
    if (call.capabilityName === 'settings') {
      const request = call.args && typeof call.args[0] === 'object' ? call.args[0] : {}
      const namespace = String(request.namespace || '')
      if (!/^[a-z0-9][a-z0-9._-]*$/i.test(namespace)) {
        return bridgeFault(BRIDGE_FAULT_CODES.MISSING_ARGUMENT, `a settings namespace must be a plain identifier, got ${namespace || '(nothing)'}`)
      }
      // A host with a real settings service gets the registration; a host without one records it,
      // because "the namespace is known" and "the namespace is editable" are different facts and
      // the capability report says which one this deployment has.
      if (services.settings && typeof services.settings[call.method] === 'function') {
        try {
          services.settings[call.method](namespace, request.description, request.options || request.meta || {})
          return { ok: true, result: { namespace, applied: true } }
        } catch (error) {
          return bridgeFault(BRIDGE_FAULT_CODES.SERVICE_UNAVAILABLE, `the settings service refused ${namespace}: ${error && error.message ? error.message : error}`)
        }
      }
      return { ok: true, result: { namespace, applied: false, reason: 'the host has no settings service; the namespace is recorded only' } }
    }
    return bridgeFault(BRIDGE_FAULT_CODES.UNKNOWN_CAPABILITY, `${call.capabilityName} has no host implementation`)
  }

  function onCall(message) {
    const validated = validateBridgeCall(message)
    if (validated.ok !== true) {
      record(validated, { capability: message.capability, method: message.method })
      answerCall(message.callId, validated)
      return
    }
    // The timer is armed before the call is applied: a service that never returns must not hold the
    // plugin's activation open forever.
    const timer = setTimeout(() => {
      const refusal = bridgeFault(BRIDGE_FAULT_CODES.TIMEOUT, `${validated.capabilityName}.${validated.method} did not answer within ${limits.callTimeoutMs}ms`)
      record(refusal, { capability: validated.capabilityName, method: validated.method })
      answerCall(message.callId, refusal)
    }, limits.callTimeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    pendingCalls.set(String(message.callId), { timer, at: now() })

    let outcome = null
    try {
      outcome = applyCall({
        capabilityName: validated.capabilityName,
        method: validated.method,
        args: validated.args,
        token: message.token
      })
    } catch (error) {
      outcome = bridgeFault(BRIDGE_FAULT_CODES.MALFORMED_MESSAGE, `applying ${validated.capabilityName}.${validated.method} threw: ${error && error.message ? error.message : error}`)
    }
    capabilityUses.push({
      capability: validated.capabilityName,
      method: validated.method,
      args: summarizeArgs(validated.args),
      ok: outcome && outcome.ok === true,
      at: now()
    })
    if (capabilityUses.length > 200) capabilityUses.shift()
    if (outcome && outcome.ok !== true) record(outcome, { capability: validated.capabilityName, method: validated.method })
    answerCall(message.callId, outcome)
  }

  // -------------------------------------------------------------------------------------------
  // Forwarded HTTP requests.
  // -------------------------------------------------------------------------------------------

  function forwardRequest(token, req, res) {
    const mounted = mountedRoutes.get(token)
    if (!mounted) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('route is no longer mounted\n')
      return
    }
    requestCount += 1
    const requestId = `req-${requestCount}`
    const chunks = []
    let size = 0
    let aborted = false

    const timer = setTimeout(() => {
      finish()
      if (!res.headersSent) res.writeHead(504, { 'content-type': 'text/plain' })
      res.end('the bridged handler did not answer in time\n')
      record(bridgeFault(BRIDGE_FAULT_CODES.TIMEOUT, `a request to ${mounted.path} was not answered within ${limits.requestTimeoutMs}ms`), { requestId })
    }, limits.requestTimeoutMs)
    if (typeof timer.unref === 'function') timer.unref()

    function finish() {
      clearTimeout(timer)
      pendingRequests.delete(requestId)
    }

    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limits.maxRequestBodyBytes) {
        aborted = true
        finish()
        if (!res.headersSent) res.writeHead(413, { 'content-type': 'text/plain' })
        res.end('request body too large for the bridge\n')
        record(bridgeFault(BRIDGE_FAULT_CODES.PAYLOAD_TOO_LARGE, `a request body exceeded ${limits.maxRequestBodyBytes} bytes`), { requestId })
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('error', () => {
      if (aborted) return
      aborted = true
      finish()
    })
    req.on('end', () => {
      if (aborted) return
      pendingRequests.set(requestId, { res, token, path: mounted.path, finish })
      const sent = sendToChild({
        kind: BRIDGE_MESSAGES.REQUEST,
        requestId,
        method: req.method,
        url: req.url,
        headers: req.headers,
        bodyBase64: chunks.length ? Buffer.concat(chunks).toString('base64') : null
      })
      if (!sent) {
        finish()
        if (!res.headersSent) res.writeHead(503, { 'content-type': 'text/plain' })
        res.end('the plugin process is not running\n')
      }
    })
  }

  function onResponse(message) {
    const entry = pendingRequests.get(String(message.requestId))
    if (!entry) return
    const { res } = entry
    if (message.kind === BRIDGE_MESSAGES.RESPONSE_HEAD) {
      if (res.headersSent) return
      const headers = {}
      for (const pair of Array.isArray(message.headers) ? message.headers : []) {
        if (Array.isArray(pair) && pair.length === 2) headers[String(pair[0])] = pair[1]
      }
      try {
        res.writeHead(Number(message.status) || 200, headers)
      } catch (error) {
        record(bridgeFault(BRIDGE_FAULT_CODES.MALFORMED_MESSAGE, `the bridged response headers were refused: ${error && error.message ? error.message : error}`), { requestId: message.requestId })
      }
      return
    }
    if (message.kind === BRIDGE_MESSAGES.RESPONSE_CHUNK) {
      if (!res.headersSent) res.writeHead(200)
      res.write(Buffer.from(String(message.dataBase64 || ''), 'base64'))
      return
    }
    if (message.kind === BRIDGE_MESSAGES.RESPONSE_END) {
      entry.finish()
      if (!res.headersSent) res.writeHead(message.failed ? 500 : 200)
      res.end()
    }
  }

  // -------------------------------------------------------------------------------------------
  // Child lifecycle.
  // -------------------------------------------------------------------------------------------

  function onChildMessage(message) {
    if (!message || typeof message !== 'object') return
    if (message.kind === BRIDGE_MESSAGES.CALL) return onCall(message)
    if (message.kind === BRIDGE_MESSAGES.REQUEST) return
    if (message.kind === BRIDGE_MESSAGES.RESPONSE_HEAD || message.kind === BRIDGE_MESSAGES.RESPONSE_CHUNK || message.kind === BRIDGE_MESSAGES.RESPONSE_END) {
      return onResponse(message)
    }
    if (message.kind === BRIDGE_MESSAGES.LOG) {
      if (pluginLogs.length < limits.maxLogs) pluginLogs.push(String(message.line || ''))
      log({ kind: 'bridge-plugin-log', plugin: id, line: String(message.line || '').slice(0, 400) })
      return
    }
    if (message.kind === BRIDGE_MESSAGES.FAULT) {
      record(bridgeFault(message.code || BRIDGE_FAULT_CODES.MALFORMED_MESSAGE, message.reason || 'the plugin reported a fault'))
      return
    }
    if (message.kind === BRIDGE_MESSAGES.READY || message.kind === BRIDGE_MESSAGES.FAILED) {
      if (settleReady) settleReady(message)
    }
  }

  function onChildStdout(chunk) {
    stdoutBuffer += chunk
    let index = stdoutBuffer.indexOf('\n')
    while (index !== -1) {
      const line = stdoutBuffer.slice(0, index)
      stdoutBuffer = stdoutBuffer.slice(index + 1)
      if (line.startsWith(BRIDGE_REPORT_PREFIX)) {
        try {
          onChildMessage(JSON.parse(line.slice(BRIDGE_REPORT_PREFIX.length)))
        } catch {
          record(bridgeFault(BRIDGE_FAULT_CODES.MALFORMED_MESSAGE, 'the plugin process reported a line that is not a message'))
        }
      } else if (line.trim()) {
        if (pluginLogs.length < limits.maxLogs) pluginLogs.push(line.slice(0, 2000))
        log({ kind: 'bridge-plugin-stdout', plugin: id, line: line.slice(0, 400) })
      }
      index = stdoutBuffer.indexOf('\n')
    }
  }

  function failEverything(code, reason) {
    for (const [callId] of pendingCalls) answerCall(callId, bridgeFault(code, reason))
    for (const [, entry] of pendingRequests) {
      entry.finish()
      try {
        if (!entry.res.headersSent) entry.res.writeHead(503, { 'content-type': 'text/plain' })
        entry.res.end('the plugin process stopped\n')
      } catch {
        /* the client is gone */
      }
    }
    pendingRequests.clear()
  }

  function disposeRoutes() {
    for (const [token, mounted] of [...mountedRoutes.entries()]) {
      mountedRoutes.delete(token)
      try {
        if (typeof mounted.dispose === 'function') mounted.dispose()
      } catch {
        /* a route that will not dispose must not hold the teardown open */
      }
    }
  }

  async function activate() {
    if (state === LIFECYCLE.ACTIVE) return { ok: true, already: true, ...runtimeInfo() }
    state = LIFECYCLE.ACTIVATING
    const payload = Buffer.from(JSON.stringify({
      id,
      name: input.name ? String(input.name) : id,
      dir,
      entry: String(input.entry || ''),
      api: input.api ? String(input.api) : 'cordis',
      config: input.config && typeof input.config === 'object' ? input.config : {},
      roots: Array.isArray(input.roots) ? input.roots.map(String) : []
    }), 'utf8').toString('base64')

    const ready = new Promise((resolve) => {
      settleReady = resolve
    })
    const exited = new Promise((resolve) => {
      settleExit = resolve
    })

    try {
      child = spawn(nodeExe, [path.join(__dirname, 'child.cjs'), payload], {
        cwd: dir,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        // A packaged application runs this as Electron; the child must be a plain node program.
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      })
    } catch (error) {
      state = LIFECYCLE.FAILED
      lastFailure = bridgeFault(BRIDGE_FAULT_CODES.SPAWN_FAILED, `the plugin process could not be started: ${error && error.message ? error.message : error}`)
      return lastFailure
    }

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', onChildStdout)
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-4000)
    })
    child.on('error', (error) => {
      if (settleReady) settleReady({ kind: BRIDGE_MESSAGES.FAILED, code: BRIDGE_FAULT_CODES.SPAWN_FAILED, reason: String(error && error.message ? error.message : error) })
    })
    child.on('exit', (code, signal) => {
      const wasActive = state === LIFECYCLE.ACTIVE
      child = null
      stoppedAt = now()
      if (state !== LIFECYCLE.STOPPED) state = wasActive ? LIFECYCLE.STOPPED : LIFECYCLE.FAILED
      lastFailure = lastFailure || bridgeFault(
        BRIDGE_FAULT_CODES.EXITED,
        `the plugin process exited (code ${code}${signal ? `, signal ${signal}` : ''})${stderrTail.trim() ? `: ${stderrTail.trim().split('\n').slice(-2).join(' ')}` : ''}`
      )
      failEverything(BRIDGE_FAULT_CODES.EXITED, 'the plugin process exited')
      if (settleExit) settleExit({ code, signal })
    })

    let timer = null
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ kind: BRIDGE_MESSAGES.FAILED, code: BRIDGE_FAULT_CODES.ACTIVATION_TIMEOUT, reason: `activation did not report within ${limits.activationTimeoutMs}ms` }), limits.activationTimeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
    })

    const outcome = await Promise.race([ready, timeout, exited.then(() => ({ kind: BRIDGE_MESSAGES.FAILED, code: BRIDGE_FAULT_CODES.EXITED, reason: 'the plugin process exited before reporting' }))])
    if (timer) clearTimeout(timer)

    if (!outcome || outcome.kind !== BRIDGE_MESSAGES.READY) {
      lastFailure = bridgeFault(
        (outcome && outcome.code) || BRIDGE_FAULT_CODES.ACTIVATION_FAILED,
        (outcome && outcome.reason) || 'the plugin did not activate'
      )
      // Clean up first, then record the failure. `stop()` sets the state to STOPPED, so setting
      // FAILED before it would be erased -- and a plugin that failed to activate would report
      // itself as merely stopped, which is the least useful thing a diagnostic surface can say.
      await stop()
      state = LIFECYCLE.FAILED
      return { ...lastFailure, missing: outcome && outcome.missing ? outcome.missing : [], stack: outcome && outcome.stack ? outcome.stack : null }
    }

    state = LIFECYCLE.ACTIVE
    activatedAt = now()
    lastFailure = null
    for (const fault of Array.isArray(outcome.faults) ? outcome.faults : []) record(fault)
    log({ kind: 'bridge-activated', plugin: id, api: outcome.api, routes: (outcome.routes || []).length, ms: outcome.ms })
    return {
      ok: true,
      api: outcome.api,
      bridge: outcome.bridge || BRIDGE_API_VERSION,
      routes: outcome.routes || [],
      settings: outcome.settings || [],
      provided: outcome.provided || [],
      logs: outcome.logs || [],
      resolution: outcome.resolution || null,
      faults: refusals.slice(),
      ms: outcome.ms
    }
  }

  /** Ask the child to unwind, then make sure it is gone. */
  async function stop() {
    const running = child
    disposeRoutes()
    failEverything(BRIDGE_FAULT_CODES.DISPOSED, 'the bridge was stopped')
    if (!running) {
      state = LIFECYCLE.STOPPED
      stoppedAt = now()
      return { ok: true, already: true }
    }
    state = LIFECYCLE.STOPPED
    sendToChild({ kind: BRIDGE_MESSAGES.SHUTDOWN })
    const gone = await Promise.race([
      new Promise((resolve) => running.once('exit', () => resolve(true))),
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), 3000)
        if (typeof timer.unref === 'function') timer.unref()
      })
    ])
    if (!gone) {
      try {
        running.kill()
      } catch {
        /* already gone */
      }
    }
    child = null
    stoppedAt = now()
    return { ok: true, forced: !gone }
  }

  function runtimeInfo() {
    return {
      state,
      pid: child ? child.pid : null,
      bridge: BRIDGE_API_VERSION,
      activatedAt,
      stoppedAt,
      uptimeMs: state === LIFECYCLE.ACTIVE && activatedAt !== null ? now() - activatedAt : 0,
      routes: [...mountedRoutes.values()].map((route) => ({ kind: route.kind, path: route.path })),
      requests: requestCount,
      failures: refusals.length
    }
  }

  function capabilityReport() {
    return {
      bridge: BRIDGE_API_VERSION,
      available: ['webServer', 'settings'],
      /** Which of them this deployment actually has a real service behind. */
      backed: {
        webServer: Boolean(services.webServer && typeof services.webServer.register === 'function'),
        settings: Boolean(services.settings && typeof services.settings.register === 'function')
      },
      uses: capabilityUses.slice(),
      refusals: refusals.slice()
    }
  }

  function healthCheck() {
    if (state === LIFECYCLE.ACTIVE && child && child.exitCode === null && !child.killed) {
      const degraded = refusals.length > 0
      return {
        status: degraded ? 'degraded' : 'healthy',
        reason: degraded
          ? `${refusals.length} bridge refusal${refusals.length === 1 ? '' : 's'}, the most recent being ${refusals[refusals.length - 1].code}`
          : `the plugin process ${child.pid} is running with ${mountedRoutes.size} bridged route(s)`
      }
    }
    if (state === LIFECYCLE.STOPPED) return { status: 'unknown', reason: 'the plugin is stopped' }
    return { status: 'unhealthy', reason: (lastFailure && lastFailure.reason) || `the bridge is ${state}` }
  }

  return {
    BRIDGE_API_VERSION,
    LIFECYCLE,
    activate,
    stop,
    runtimeInfo,
    capabilityReport,
    healthCheck,
    /** The live state, for the adapter and the panel. */
    get state() {
      return state
    },
    get process() {
      return child
    },
    get pid() {
      return child ? child.pid : null
    },
    get routes() {
      return [...mountedRoutes.values()].map((route) => ({ kind: route.kind, path: route.path }))
    },
    get refusals() {
      return refusals.slice()
    },
    get logs() {
      return pluginLogs.slice()
    },
    get lastFailure() {
      return lastFailure
    },
    /** For the adapter's error surface: a refusal is an error the user should see. */
    errorReport() {
      return {
        bridge: BRIDGE_API_VERSION,
        refusals: refusals.length,
        byCode: refusals.reduce((accumulator, entry) => {
          accumulator[entry.code] = (accumulator[entry.code] || 0) + 1
          return accumulator
        }, {}),
        last: refusals.length ? refusals[refusals.length - 1] : null
      }
    }
  }
}

module.exports = {
  createCordisBridge,
  createHostWebServer,
  LIFECYCLE,
  toError,
  BRIDGE_API_VERSION
}
