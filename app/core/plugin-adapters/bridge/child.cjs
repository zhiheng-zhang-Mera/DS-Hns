'use strict'

/**
 * The bridge's child process: where a community plugin actually runs.
 *
 * This process exists for two reasons that reinforce each other. It is a **containment** boundary -- * an import-time throw, a `process.exit`, a hung handler or a crash ten minutes later stay here,
 * exactly as they do for any adopted plugin. And it is the **only** place the plugin's code and the
 * host meet, which is what makes the mediated surface in `contract.cjs` enforceable: everything the
 * plugin can reach is built in this file, out of local functions and JSON.
 *
 * What the plugin receives as `ctx`:
 *
 *   * local, inert values --`id`, `name`, `config`, `root`, `log`, a logger object;
 *   * `effect`, `on`, `emit`, `provide`, `require`, `has`, `inject`, `get`, `setTimeout` and
 *     friends --all implemented here;
 *   * `webServer` and `settings` --objects whose methods serialise a *description of an intention*
 *     and send it to the host.
 *
 * What it never receives: a Cordis container, an HNS Core object, a Node `Server`, a host
 * `ServerResponse`, a real service instance, or any value that originated outside this process.
 * The proxies hold no host state at all --they hold a callback into `send()`.
 *
 * ## Two details that took thought, and are load-bearing
 *
 * **`register` returns synchronously.** The real `webServer.register(route)` returns a disposer
 * immediately, and community plugins rely on that: `disposers.push(webServer.register({...}))` is
 * the idiom. So the proxy issues its call asynchronously but returns a *local* disposer at once.
 * The call is tracked, and activation does not report ready until every tracked call has been
 * answered --so a route is never registered after the host has been told the plugin is up.
 *
 * **Responses stream.** The wallpaper plugin serves video with `createReadStream(...).pipe(res)`,
 * so buffering a response into one JSON message would break the plugin's actual purpose. `res` is
 * a real facade: `write` sends a chunk, `end` closes, and the host writes them to its own socket as
 * they arrive.
 */

const path = require('node:path')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')

const {
  BRIDGE_API_VERSION,
  BRIDGE_MESSAGES,
  BRIDGE_FAULT_CODES,
  BRIDGE_LIMITS,
  BRIDGE_REPORT_PREFIX,
  BRIDGE_CAPABILITY_IDS,
  bridgeFault
} = require('./contract.cjs')

/**
 * Let a plugin's `peerDependencies` resolve out of the host.
 *
 * A peer dependency is, by definition, something the *host* provides --that is why these plugins
 * declare `@deepseek-ai/dsh-host-webserver` as a peer rather than a dependency. In a real install
 * the packages sit in a shared `node_modules`; here the plugin lives wherever the user cloned it,
 * so Node's resolver cannot find them and every community plugin would fail with
 * `Cannot find package '@deepseek-ai/dsh-host-webserver'` --a failure about our layout, not about
 * their plugin.
 *
 * The fix is a resolve hook that retries a failed bare specifier with the parent anchored inside a
 * host root. Retrying through `nextResolve` rather than hand-resolving means Node's own algorithm
 * still runs --`exports` maps, conditions, subpath patterns --instead of a second, worse resolver
 * being written here.
 */
function installHostResolution(roots) {
  if (!Array.isArray(roots) || !roots.length) return { installed: false, reason: 'no host roots were provided' }
  let registerHooks = null
  try {
    ({ registerHooks } = require('node:module'))
  } catch {
    registerHooks = null
  }
  if (typeof registerHooks !== 'function') {
    return { installed: false, reason: 'this node does not support synchronous resolve hooks' }
  }
  const anchors = roots.map((root) => pathToFileURL(path.join(root, '__dshns_host_anchor__.js')).href)
  registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context)
      } catch (error) {
        // Only bare specifiers are retried: a relative path that is missing is the plugin's own
        // missing file, and looking for it in the host would turn a real error into a wrong one.
        if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) throw error
        for (const parentURL of anchors) {
          try {
            return nextResolve(specifier, { ...context, parentURL })
          } catch {
            /* try the next root */
          }
        }
        throw error
      }
    }
  })
  return { installed: true, roots: roots.slice() }
}

/** The bare specifiers an import failure is about, in both resolvers' spellings. */
function missingFrom(error) {
  const messages = [error && error.message, error && error.cause && error.cause.message].filter(Boolean).map(String)
  const names = new Set()
  for (const message of messages) {
    for (const pattern of [
      /Cannot find package '([^']+)'/g,
      /Cannot find module '([^']+)'/g,
      /Failed to resolve module specifier "([^"]+)"/g,
      /Cannot find dependency '([^']+)'/g
    ]) {
      for (const match of message.matchAll(pattern)) {
        const name = match[1]
        if (!name || name.startsWith('.') || path.isAbsolute(name)) continue
        names.add(name.split('/').slice(0, name.startsWith('@') ? 2 : 1).join('/'))
      }
    }
  }
  return [...names]
}

const payload = (() => {
  try {
    return JSON.parse(Buffer.from(String(process.argv[2] || ''), 'base64').toString('utf8'))
  } catch {
    return null
  }
})()

/** One JSON message to the host, bounded so a plugin cannot flood the channel. */
function send(message) {
  const text = JSON.stringify(message)
  if (Buffer.byteLength(text, 'utf8') > BRIDGE_LIMITS.maxMessageBytes) {
    process.stdout.write(`${BRIDGE_REPORT_PREFIX}${JSON.stringify({
      kind: BRIDGE_MESSAGES.FAULT,
      code: BRIDGE_FAULT_CODES.PAYLOAD_TOO_LARGE,
      reason: `a ${Buffer.byteLength(text, 'utf8')} byte message exceeds the ${BRIDGE_LIMITS.maxMessageBytes} byte limit`
    })}\n`)
    return
  }
  process.stdout.write(`${BRIDGE_REPORT_PREFIX}${text}\n`)
}

// ---------------------------------------------------------------------------------------------
// Inbound lines from the host: call results and forwarded HTTP requests.
// ---------------------------------------------------------------------------------------------

const pendingCalls = new Map()
let callCounter = 0
const routes = new Map()
const routeOrder = []
const handlers = new Map()
const logs = []
const disposers = []
const provided = []
const settingsRegistrations = []
/**
 * Faults this process generated, which are the ones the host has not already recorded.
 *
 * A refusal that came *from* the host is deliberately not put here. The host recorded it when it
 * made the decision, and echoing it back would make the bridge report two refusals for one
 * refusal --an inflated count in exactly the number a user reads to decide whether the bridge is
 * misbehaving.
 */
const localFaults = []
let routeCounter = 0
let shutDown = false

function log(...args) {
  const line = args.map((value) => (typeof value === 'string' ? value : safeJson(value))).join(' ')
  if (logs.length < BRIDGE_LIMITS.maxLogs) logs.push(line)
  send({ kind: BRIDGE_MESSAGES.LOG, line: line.slice(0, 2000) })
}

function safeJson(value) {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/**
 * Issue one mediated capability call.
 *
 * The returned promise settles when the host answers. A refusal is *recorded* as a bridge fault and
 * resolves to a refusal object rather than rejecting: a plugin whose route the host declined must
 * keep running --it simply does not have that route --and the refusal has to reach the health
 * surface, which it cannot do if it becomes an unhandled rejection.
 */
function call(capability, method, args, token) {
  callCounter += 1
  const callId = `${capability}:${callCounter}`
  if (pendingCalls.size >= BRIDGE_LIMITS.maxPendingCalls) {
    const refusal = bridgeFault(BRIDGE_FAULT_CODES.PAYLOAD_TOO_LARGE, `more than ${BRIDGE_LIMITS.maxPendingCalls} capability calls are in flight`)
    localFaults.push({ ...refusal, capability, method })
    return Promise.resolve(refusal)
  }
  const promise = new Promise((resolve) => {
    pendingCalls.set(callId, { resolve, capability, method, at: Date.now() })
  })
  send({ kind: BRIDGE_MESSAGES.CALL, callId, capability, method, args, token })
  return promise
}

// ---------------------------------------------------------------------------------------------
// The mediated context. Everything here is local; nothing is a host object.
// ---------------------------------------------------------------------------------------------

function createRequestFacade(message) {
  const body = message.bodyBase64 ? Buffer.from(message.bodyBase64, 'base64') : Buffer.alloc(0)
  const listeners = new Map()
  const request = {
    method: String(message.method || 'GET'),
    url: String(message.url || '/'),
    headers: message.headers && typeof message.headers === 'object' ? { ...message.headers } : {},
    httpVersion: '1.1',
    socket: { remoteAddress: '127.0.0.1' },
    on(type, handler) {
      const list = listeners.get(String(type)) || []
      list.push(handler)
      listeners.set(String(type), list)
      return request
    },
    once(type, handler) {
      const wrap = (...args) => {
        request.removeListener(type, wrap)
        handler(...args)
      }
      return request.on(type, wrap)
    },
    removeListener(type, handler) {
      const list = listeners.get(String(type)) || []
      const index = list.indexOf(handler)
      if (index >= 0) list.splice(index, 1)
      return request
    }
  }
  // The body is delivered on the next turn, so a handler that subscribes inside `apply`-time always
  // sees it: replaying synchronously would drop a listener attached one line later.
  setImmediate(() => {
    const fire = (type, ...args) => {
      for (const handler of [...(listeners.get(type) || [])]) {
        try {
          handler(...args)
        } catch (error) {
          log(`a request ${type} listener threw: ${error && error.message ? error.message : error}`)
        }
      }
    }
    if (body.length) fire('data', body)
    fire('end')
    fire('close')
  })
  return request
}

function createResponseFacade(requestId) {
  const headers = new Map()
  let status = 200
  let ended = false
  let headSent = false
  const response = {
    /**
     * `statusCode` is an accessor onto the same variable `writeHead` writes.
     *
     * It was a plain property first, and `res.statusCode = 500` before `res.end()` was then
     * silently ignored -- the head had already been built from the other variable, so a handler
     * that failed still answered 200. Setting the status directly is the ordinary Node idiom, so
     * it has to mean the same thing here.
     */
    get statusCode() {
      return status
    },
    set statusCode(value) {
      const next = Number(value)
      if (Number.isFinite(next) && next >= 100 && next <= 599) status = next
    },
    statusMessage: '',
    get headersSent() {
      return headSent
    },
    get writableEnded() {
      return ended
    },
    setHeader(name, value) {
      headers.set(String(name).toLowerCase(), { name: String(name), value })
      return response
    },
    getHeader(name) {
      const entry = headers.get(String(name).toLowerCase())
      return entry ? entry.value : undefined
    },
    removeHeader(name) {
      headers.delete(String(name).toLowerCase())
    },
    writeHead(code, maybeHeaders) {
      const next = Number(code)
      if (Number.isFinite(next) && next >= 100 && next <= 599) status = next
      if (maybeHeaders && typeof maybeHeaders === 'object') {
        for (const [name, value] of Object.entries(maybeHeaders)) response.setHeader(name, value)
      }
      flushHead()
      return response
    },
    write(chunk, encodingOrCallback, maybeCallback) {
      const callback = typeof encodingOrCallback === 'function' ? encodingOrCallback : maybeCallback
      flushHead()
      const buffer = toBuffer(chunk, typeof encodingOrCallback === 'string' ? encodingOrCallback : 'utf8')
      if (buffer && buffer.length) {
        // A chunk larger than the cap is split rather than refused: the plugin is streaming a file
        // it did not choose the size of, and dropping the tail would corrupt a video silently.
        for (let offset = 0; offset < buffer.length; offset += BRIDGE_LIMITS.maxChunkBytes) {
          send({
            kind: BRIDGE_MESSAGES.RESPONSE_CHUNK,
            requestId,
            dataBase64: buffer.subarray(offset, offset + BRIDGE_LIMITS.maxChunkBytes).toString('base64')
          })
        }
      }
      if (typeof callback === 'function') setImmediate(callback)
      return true
    },
    end(chunk, encodingOrCallback, maybeCallback) {
      if (ended) return response
      if (chunk !== undefined && chunk !== null) response.write(chunk, encodingOrCallback, maybeCallback)
      else if (typeof encodingOrCallback === 'function') setImmediate(encodingOrCallback)
      flushHead()
      ended = true
      send({ kind: BRIDGE_MESSAGES.RESPONSE_END, requestId })
      return response
    },
    destroy(error) {
      if (ended) return
      ended = true
      send({
        kind: BRIDGE_MESSAGES.RESPONSE_END,
        requestId,
        failed: true,
        reason: error && error.message ? String(error.message) : 'the handler destroyed the response'
      })
    }
  }
  function flushHead() {
    if (headSent) return
    headSent = true
    response.statusCode = status
    send({
      kind: BRIDGE_MESSAGES.RESPONSE_HEAD,
      requestId,
      status,
      headers: [...headers.values()].map((entry) => [entry.name, entry.value])
    })
  }
  return response
}

function toBuffer(chunk, encoding) {
  if (chunk === null || chunk === undefined) return null
  if (Buffer.isBuffer(chunk)) return chunk
  if (chunk instanceof Uint8Array) return Buffer.from(chunk)
  return Buffer.from(String(chunk), encoding === 'buffer' ? 'utf8' : encoding)
}

/** Dispatch one forwarded request to the plugin's own handler. */
async function dispatch(message) {
  const requestId = message.requestId
  const url = String(message.url || '/')
  const pathname = url.split('?')[0]
  let chosen = null
  for (const token of routeOrder) {
    const route = routes.get(token)
    if (!route) continue
    if (route.kind === 'exact' && pathname === route.path) {
      chosen = route
      break
    }
    if (route.kind === 'prefix' && pathname.startsWith(route.path)) {
      // The longest matching prefix wins, which is what the real router does and what a plugin
      // registering both `/x/` and `/x/media/` expects.
      if (!chosen || route.path.length > chosen.path.length) chosen = route
    }
  }
  if (!chosen) {
    send({ kind: BRIDGE_MESSAGES.RESPONSE_HEAD, requestId, status: 404, headers: [['content-type', 'text/plain']] })
    send({ kind: BRIDGE_MESSAGES.RESPONSE_CHUNK, requestId, dataBase64: Buffer.from('no bridged route\n').toString('base64') })
    send({ kind: BRIDGE_MESSAGES.RESPONSE_END, requestId })
    return
  }
  const handler = handlers.get(chosen.token)
  if (typeof handler !== 'function') {
    send({ kind: BRIDGE_MESSAGES.RESPONSE_HEAD, requestId, status: 501, headers: [['content-type', 'text/plain']] })
    send({ kind: BRIDGE_MESSAGES.RESPONSE_CHUNK, requestId, dataBase64: Buffer.from('the bridged route has no handler\n').toString('base64') })
    send({ kind: BRIDGE_MESSAGES.RESPONSE_END, requestId })
    return
  }
  const response = createResponseFacade(requestId)
  try {
    await handler(createRequestFacade(message), response)
  } catch (error) {
    const reason = error && error.message ? String(error.message) : String(error)
    localFaults.push({ code: BRIDGE_FAULT_CODES.HANDLER_FAILED, reason, route: chosen.path })
    log(`a bridged handler for ${chosen.path} threw: ${reason}`)
    // Reported to the host as well: a failure that happens *after* activation is not in the ready
    // report, and a handler that throws on every request is exactly the thing the plugin's health
    // surface exists to show.
    send({ kind: BRIDGE_MESSAGES.FAULT, code: BRIDGE_FAULT_CODES.HANDLER_FAILED, reason: `${chosen.path}: ${reason}` })
    if (!response.headersSent) response.statusCode = 500
    response.end(`bridged handler failed: ${reason}\n`)
  }
}

/** One line from the host. */
function onHostMessage(line) {
  if (!line.startsWith(BRIDGE_REPORT_PREFIX)) return
  let message = null
  try {
    message = JSON.parse(line.slice(BRIDGE_REPORT_PREFIX.length))
  } catch {
    return
  }
  if (!message || typeof message !== 'object') return
  if (message.kind === BRIDGE_MESSAGES.CALL_RESULT) {
    const entry = pendingCalls.get(String(message.callId))
    if (!entry) return
    pendingCalls.delete(String(message.callId))
    if (message.ok === true) entry.resolve({ ok: true, result: message.result })
    else {
      // Not added to `localFaults`: the host recorded this refusal when it made the decision, and
      // echoing it back would make one refusal count as two on the health surface.
      entry.resolve(bridgeFault(message.code || BRIDGE_FAULT_CODES.MALFORMED_MESSAGE, message.reason || 'the host refused the call'))
    }
    return
  }
  if (message.kind === BRIDGE_MESSAGES.REQUEST) {
    dispatch(message).catch((error) => log(`dispatch failed: ${error && error.message ? error.message : error}`))
    return
  }
  if (message.kind === BRIDGE_MESSAGES.SHUTDOWN) {
    shutDown = true
    for (const dispose of disposers.splice(0, disposers.length)) {
      try {
        dispose()
      } catch (error) {
        log(`a plugin disposer threw: ${error && error.message ? error.message : error}`)
      }
    }
    // A plugin that holds a timer or a socket keeps this process alive after shutdown; the exit is
    // explicit because the host has already been told the plugin is unloaded.
    setImmediate(() => process.exit(0))
  }
}

let stdinBuffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  stdinBuffer += chunk
  let index = stdinBuffer.indexOf('\n')
  while (index !== -1) {
    const line = stdinBuffer.slice(0, index)
    stdinBuffer = stdinBuffer.slice(index + 1)
    onHostMessage(line)
    index = stdinBuffer.indexOf('\n')
  }
})
process.stdin.on('end', () => {
  if (!shutDown) process.exit(0)
})

// ---------------------------------------------------------------------------------------------
// The context handed to the plugin.
// ---------------------------------------------------------------------------------------------

function createMediatedContext(input) {
  const listeners = new Map()
  const available = new Set(BRIDGE_CAPABILITY_IDS)

  const webServer = {
    register(route) {
      const token = `route-${++routeCounter}`
      if (!route || typeof route !== 'object') {
        localFaults.push({ code: BRIDGE_FAULT_CODES.MISSING_ARGUMENT, reason: 'webServer.register needs a route object' })
        return () => {}
      }
      if (typeof route.handler === 'function') handlers.set(token, route.handler)
      routes.set(token, { token, kind: route.kind, path: route.path })
      routeOrder.push(token)
      // The call is asynchronous; the disposer the plugin gets is not, because the real API's is
      // not and community plugins depend on that shape.
      call('webServer', 'register', [{ kind: route.kind, path: route.path, name: route.name }], token)
      return () => {
        routes.delete(token)
        handlers.delete(token)
        const index = routeOrder.indexOf(token)
        if (index >= 0) routeOrder.splice(index, 1)
        call('webServer', 'unregister', [token])
      }
    }
  }

  const settings = {
    register(namespace, schema, options) {
      settingsRegistrations.push({ namespace: String(namespace || ''), method: 'register', hasSchema: Boolean(schema) })
      return call('settings', 'register', [{ namespace: String(namespace || ''), description: describeSchema(schema), options: safeOptions(options) }])
    },
    installSection(ctx, namespace, schema, base, meta) {
      settingsRegistrations.push({ namespace: String(namespace || ''), method: 'installSection', hasSchema: Boolean(schema) })
      return call('settings', 'installSection', [{ namespace: String(namespace || ''), description: describeSchema(schema), meta: safeOptions(meta) }])
    }
  }

  const context = {
    id: input.id,
    name: input.name,
    config: input.config && typeof input.config === 'object' ? input.config : {},
    root: input.dir,
    baseDir: input.dir,
    log,
    logger: { info: log, warn: log, error: log, debug: log, success: log, name: input.id },

    effect(fn) {
      const disposer = typeof fn === 'function' ? fn() : null
      if (typeof disposer === 'function') disposers.push(disposer)
      return () => {}
    },
    on(type, handler) {
      const key = String(type)
      const list = listeners.get(key) || []
      list.push(handler)
      listeners.set(key, list)
      return () => {}
    },
    emit(type, event) {
      for (const handler of [...(listeners.get(String(type)) || [])]) {
        try {
          handler(event)
        } catch (error) {
          log(`a listener for ${type} threw: ${error && error.message ? error.message : error}`)
        }
      }
    },

    // Capabilities stay in this process, exactly as they do for every adopted plugin: the host is
    // not told about them and nothing outside can resolve them.
    provide(name, value) {
      provided.push({ name: String(name), kind: value === null ? 'null' : typeof value })
      return () => {}
    },
    require: () => null,
    has: (name) => available.has(String(name)),

    /**
     * Cordis' conditional injection. A plugin uses it to use a service when it is there and skip
     * the block when it is not, so a capability this bridge does not provide means the callback is
     * not called --never that it is called with something undefined.
     */
    inject(names, callback) {
      const wanted = Array.isArray(names) ? names.map(String) : [String(names)]
      const missing = wanted.filter((name) => !available.has(name))
      if (missing.length) {
        localFaults.push({
          code: BRIDGE_FAULT_CODES.UNKNOWN_CAPABILITY,
          reason: `inject(${wanted.join(', ')}) skipped: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not provided by the bridge`
        })
        return () => {}
      }
      if (typeof callback === 'function') {
        try {
          callback(context)
        } catch (error) {
          log(`an inject callback for ${wanted.join(', ')} threw: ${error && error.message ? error.message : error}`)
        }
      }
      return () => {}
    },
    get(name) {
      const key = String(name)
      if (key === 'webServer') return webServer
      if (key === 'settings') return settings
      return null
    },
    set() {},

    webServer,
    settings,

    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    setImmediate,
    clearImmediate
  }
  return context
}

/** A serialisable description of a settings schema, never the schema object itself. */
function describeSchema(schema) {
  if (!schema || typeof schema !== 'object') return null
  try {
    if (typeof schema.toJSON === 'function') return { kind: 'json', value: schema.toJSON() }
    if (typeof schema.toString === 'function') return { kind: 'text', value: String(schema).slice(0, 2000) }
  } catch {
    /* a schema that cannot describe itself is described as opaque */
  }
  return { kind: 'opaque' }
}

/** Only JSON-safe, bounded option values cross the boundary. */
function safeOptions(options) {
  if (!options || typeof options !== 'object') return null
  const out = {}
  for (const [key, value] of Object.entries(options)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) out[key] = value
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Activation.
// ---------------------------------------------------------------------------------------------

async function main() {
  if (!payload || !payload.dir || !payload.entry) {
    send({ kind: BRIDGE_MESSAGES.FAILED, code: BRIDGE_FAULT_CODES.NO_ENTRY, reason: 'the bridge payload named no entry point' })
    return
  }
  const resolution = installHostResolution(payload.roots)
  const started = Date.now()
  const entry = path.resolve(payload.dir, payload.entry)
  if (!fs.existsSync(entry)) {
    send({ kind: BRIDGE_MESSAGES.FAILED, code: BRIDGE_FAULT_CODES.ENTRY_MISSING, reason: `the declared entry ${payload.entry} is not in the plugin directory` })
    return
  }

  let namespace = null
  try {
    namespace = await import(pathToFileURL(entry).href)
  } catch (error) {
    const missing = missingFrom(error)
    send({
      kind: BRIDGE_MESSAGES.FAILED,
      code: missing.length ? BRIDGE_FAULT_CODES.MISSING_DEPENDENCIES : BRIDGE_FAULT_CODES.IMPORT_FAILED,
      reason: missing.length
        ? `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not installed, and the host does not provide ${missing.length === 1 ? 'it' : 'them'}`
        : String((error && error.message) || error),
      missing,
      ms: Date.now() - started
    })
    return
  }

  const candidates = [
    ['apply', namespace.apply],
    ['default.apply', namespace.default && namespace.default.apply],
    ['default', typeof namespace.default === 'function' ? namespace.default : null],
    ['load', namespace.load]
  ].filter(([, fn]) => typeof fn === 'function')
  if (!candidates.length) {
    send({
      kind: BRIDGE_MESSAGES.FAILED,
      code: BRIDGE_FAULT_CODES.UNSUPPORTED_API,
      reason: 'the module exports neither apply(ctx) nor load(context)',
      exports: Object.keys(namespace).slice(0, 20)
    })
    return
  }

  const context = createMediatedContext(payload)
  const preferred = payload.api === 'cordis'
    ? ['apply', 'default.apply', 'default', 'load']
    : ['load', 'apply', 'default.apply', 'default']
  const chosen = preferred.map((name) => candidates.find(([candidate]) => candidate === name)).find(Boolean) || candidates[0]

  try {
    const outcome = chosen[1](context, payload.config || {})
    if (outcome && typeof outcome.then === 'function') await outcome
  } catch (error) {
    send({
      kind: BRIDGE_MESSAGES.FAILED,
      code: BRIDGE_FAULT_CODES.ACTIVATION_FAILED,
      reason: String((error && error.message) || error),
      stack: String((error && error.stack) || '').slice(0, 2000),
      logs: logs.slice(-50),
      ms: Date.now() - started
    })
    return
  }

  // Every capability call the plugin issued during apply is settled before the host is told the
  // plugin is up. Without this a route could be registered after activation was reported, and a
  // request arriving in that window would 404 against a plugin the host already believes is ready.
  if (pendingCalls.size) {
    const settled = [...pendingCalls.values()].map((entry) => new Promise((resolve) => {
      const original = entry.resolve
      entry.resolve = (value) => {
        original(value)
        resolve()
      }
    }))
    await Promise.allSettled(settled)
  }

  send({
    kind: BRIDGE_MESSAGES.READY,
    api: chosen[0],
    bridge: BRIDGE_API_VERSION,
    resolution,
    routes: [...routes.values()].map((route) => ({ kind: route.kind, path: route.path })),
    settings: settingsRegistrations.slice(),
    provided,
    logs: logs.slice(-50),
    faults: localFaults.slice(0, 20),
    ms: Date.now() - started
  })
}

main().catch((error) => {
  send({
    kind: BRIDGE_MESSAGES.FAILED,
    code: BRIDGE_FAULT_CODES.ACTIVATION_FAILED,
    reason: String((error && error.message) || error)
  })
})
