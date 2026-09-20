'use strict'

/**
 * The Runtime Client — the Desktop's half of the Runtime connection.
 *
 * This is the module that makes "the UI does not own the Runtime" true rather than
 * aspirational, because it is the only thing the UI has: a connection.
 *
 * The four states the requirement names are the four states this object has:
 *
 *   Runtime already alive  -> attach
 *   Runtime absent         -> request/start Runtime -> attach
 *   Runtime dies           -> stay alive, report `disconnected`, keep retrying
 *   Electron dies/closes   -> nothing happens here at all; the Runtime is a
 *                             separate process that was never a child of the UI
 *
 * That last line is the important one, and it is why `detach()` exists separately
 * from `shutdown()`: the UI can go away without asking the Runtime to stop, and
 * the only path that stops a Runtime is an explicit one.
 *
 * The client never requires Electron, so it is testable against a real Host in a
 * plain Node process and reusable by the `runtime status` CLI.
 */

const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { spawn } = require('node:child_process')

const protocol = require('./protocol.cjs')
const instanceModule = require('./instance.cjs')
const runtimeProcess = require('../runtime-process.cjs')

/**
 * The ownership record type the Runtime Host writes.
 *
 * Read from the ownership module rather than imported from `host.cjs`, because
 * the Client must be loadable without loading the Host — the UI should never
 * pull the Runtime's implementation into its own process just to learn a string,
 * and the reverse dependency would be a cycle.
 */
const HOST_OWNERSHIP_TYPE = 'runtime-host'

/** Connection states a UI can render. */
const CLIENT_STATES = Object.freeze(['idle', 'connecting', 'attached', 'disconnected', 'failed'])

/**
 * Is a Runtime Host already alive for this instance?
 *
 * Two independent answers, and both are used: the ownership record says one was
 * started, and the endpoint decides whether it is *still* there. The record alone
 * is not enough (a killed host leaves one behind), and a bind attempt alone is not
 * enough (this client must not take the endpoint just to test it).
 */
async function probeRuntime({ instance, timeoutMs = 1500 } = {}) {
  const record = runtimeProcess.readOwnershipByType(instance.root, HOST_OWNERSHIP_TYPE)
  const recordPid = Number(record?.childPid ?? record?.pid) || 0
  const recordAlive = recordPid > 0 && runtimeProcess.processExists(recordPid)
  const reachable = await canConnect(instance.ipcEndpoint, timeoutMs)
  return {
    running: reachable,
    reachable,
    recordPresent: Boolean(record),
    recordPid,
    recordAlive,
    /** A record with a dead owner is stale and reported as such so it can be cleared. */
    stale: Boolean(record) && !recordAlive,
    ownershipPath: runtimeProcess.ownershipPathFor(instance.root, HOST_OWNERSHIP_TYPE)
  }
}

/** Can this client reach the endpoint? Never throws, never leaves a socket behind. */
function canConnect(endpoint, timeoutMs = 1500) {
  return new Promise((resolve) => {
    if (!endpoint) {
      resolve(false)
      return
    }
    const socket = net.createConnection(endpoint)
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      try {
        socket.destroy()
      } catch {}
      resolve(value)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
    setTimeout(() => finish(false), timeoutMs + 250).unref?.()
  })
}

/**
 * Start a Runtime Host as a *detached* process.
 *
 * Detachment is the whole mechanism behind `Electron dies -> Runtime survives`:
 * the child gets its own process group and its own stdio, and the parent does not
 * wait on it. Electron exiting therefore cannot take the Runtime with it — not
 * because something cleans up carefully, but because there is no parent-child
 * lifetime left to inherit.
 */
function spawnRuntimeHost({
  instance,
  env = process.env,
  nodeExe = process.execPath,
  entry = path.join(__dirname, 'runtime.cjs'),
  extraArgs = [],
  env_overrides = {}
} = {}) {
  // The Runtime's own stdio goes to files under the instance's log directory, so a
  // detached host that fails to start still leaves a reason behind. The directory
  // is created here because a first run on a fresh checkout has no `logs/` yet.
  fs.mkdirSync(instance.paths.logsDir, { recursive: true })
  const out = fs.openSync(path.join(instance.paths.logsDir, 'runtime-host.out.log'), 'a')
  const err = fs.openSync(path.join(instance.paths.logsDir, 'runtime-host.err.log'), 'a')
  const child = spawn(nodeExe, [entry, 'serve', '--root', instance.root, '--dsh-home', instance.dshHome, '--port', String(instance.harnessPort), ...extraArgs], {
    cwd: instance.root,
    env: {
      ...env,
      DSH_ROOT: instance.root,
      DSH_HOME: instance.dshHome,
      DSH_HARNESS_PORT: String(instance.harnessPort),
      DSH_INSTANCE_ID: instance.instanceId,
      ...env_overrides
    },
    detached: true,
    stdio: ['ignore', out, err],
    windowsHide: true
  })
  child.unref()
  return child
}

/**
 * Create a client for one instance.
 *
 * `autoStartRuntime` is true by default because that is the behaviour a user
 * expects from double-clicking the application: if nothing is running, start it.
 * It is an option, not a rule, because the acceptance tests need to attach to a
 * Runtime they started themselves and prove no second one was created.
 */
function createRuntimeClient({
  instance,
  env = process.env,
  log = () => {},
  autoStartRuntime = true,
  /** Milliseconds between reconnect attempts while disconnected. */
  reconnectMs = 1500,
  /** How long a single request may wait for its answer. */
  requestTimeoutMs = 30_000,
  nodeExe = process.execPath,
  runtimeEntry = path.join(__dirname, 'runtime.cjs')
} = {}) {
  if (!instance) throw new Error('the Runtime client needs an instance')
  const events = new EventEmitter()
  events.setMaxListeners(0)

  let socket = null
  let rest = ''
  let state = 'idle'
  let pending = new Map()
  let seq = 0
  let welcome = null
  let reconnectTimer = null
  let closedByCaller = false
  const topicListeners = new Set()

  function clientLog(message) {
    log(`[runtime-client] ${String(message)}`)
  }

  function setState(next, detail = null) {
    if (state === next) return
    const previous = state
    state = next
    clientLog(`state ${previous} -> ${next}${detail ? ` (${detail})` : ''}`)
    events.emit('state', { state: next, previous, detail })
  }

  function settle(frame) {
    const id = frame?.id
    if (id === undefined || id === null) return false
    const entry = pending.get(id)
    if (!entry) return false
    pending.delete(id)
    clearTimeout(entry.timer)
    if (frame.method === 'error') entry.reject(Object.assign(new Error(frame.params?.message || 'runtime error'), { code: frame.params?.code, detail: frame.params?.detail }))
    else entry.resolve(frame.params)
    return true
  }

  function handleFrame(frame) {
    if (!frame || typeof frame !== 'object') return
    if (frame.method === 'event') {
      const topic = frame.params?.topic
      const payload = frame.params?.payload
      for (const listener of topicListeners) {
        try {
          listener(topic, payload)
        } catch (error) {
          clientLog(`topic listener failed: ${error?.message || error}`)
        }
      }
      events.emit('event', { topic, payload })
      return
    }
    if (frame.method === 'bye') {
      clientLog(`runtime said goodbye: ${frame.params?.reason || ''}`)
      return
    }
    // `welcome` is the *answer to `hello`*, so it carries the request id and must
    // be correlated before it is interpreted. Settling first is what releases the
    // handshake; handling it as an unsolicited frame left `attach()` waiting for a
    // reply that had already arrived.
    const wasPending = settle(frame)
    if (frame.method === 'welcome') {
      welcome = frame.params || null
      if (!wasPending) clientLog('received an uncorrelated welcome frame')
      events.emit('welcome', welcome)
    }
  }

  function connectOnce() {
    return new Promise((resolve, reject) => {
      if (closedByCaller) {
        resolve(false)
        return
      }
      setState('connecting')
      const candidate = net.createConnection(instance.ipcEndpoint)
      let settled = false
      const finish = (ok, error) => {
        if (settled) return
        settled = true
        if (ok) resolve(true)
        else reject(error)
      }
      candidate.setEncoding('utf8')
      candidate.once('connect', async () => {
        socket = candidate
        rest = ''
        try {
          const answer = await request('hello', {
            client: 'ds-hns-desktop',
            pid: process.pid,
            protocol: protocol.PROTOCOL_VERSION
          })
          welcome = answer
          events.emit('welcome', welcome)
          setState('attached')
          try {
            await request('subscribe', { topics: ['harness', 'worker', 'computer-use', 'runtime'] })
          } catch (error) {
            clientLog(`subscribe failed: ${error?.message || error}`)
          }
          events.emit('attached', welcome)
          finish(true)
        } catch (error) {
          clientLog(`handshake failed: ${error?.message || error}`)
          try {
            candidate.destroy()
          } catch {}
          finish(false, error)
        }
      })
      candidate.on('data', (chunk) => {
        const decoded = protocol.decode(chunk, rest)
        rest = decoded.remainder
        for (const frame of decoded.frames) handleFrame(frame)
      })
      candidate.on('error', (error) => {
        if (socket === candidate) socket = null
        clientLog(`socket error: ${error?.message || error}`)
        finish(false, error)
        onLost(error)
      })
      candidate.on('close', () => {
        if (socket === candidate) socket = null
        finish(false, new Error('the runtime socket closed'))
        onLost(new Error('the runtime socket closed'))
      })
    })
  }

  /**
   * The Runtime went away. The UI does **not**: every in-flight request is
   * rejected with a typed error the renderer can show as "disconnected", and a
   * reconnect is scheduled. Nothing here throws into the caller's event loop.
   */
  function onLost(reason) {
    if (closedByCaller) return
    const wasAttached = state === 'attached'
    for (const [, entry] of pending) {
      clearTimeout(entry.timer)
      entry.reject(Object.assign(new Error('the runtime disconnected before answering'), { code: 'runtime-disconnected' }))
    }
    pending = new Map()
    welcome = null
    setState('disconnected', reason?.message || String(reason || ''))
    events.emit('disconnected', { reason: reason?.message || String(reason || '') })
    if (wasAttached || state === 'disconnected') scheduleReconnect()
  }

  function scheduleReconnect() {
    if (closedByCaller || reconnectTimer) return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      void attach({ allowStart: false }).catch((error) => clientLog(`reconnect failed: ${error?.message || error}`))
    }, reconnectMs)
    reconnectTimer.unref?.()
  }

  /**
   * Attach to the Runtime, starting one when there is none and `allowStart` is set.
   *
   * The order is deliberate: probe, attach, and only then start. Starting first
   * would race two clients into two Runtimes; this way the second one to arrive
   * finds the first one's endpoint already bound.
   */
  async function attach({ allowStart = autoStartRuntime, timeoutMs = 20_000 } = {}) {
    closedByCaller = false
    if (socket && state === 'attached') return { attached: true, alreadyAttached: true, welcome }
    const probe = await probeRuntime({ instance })
    if (!probe.running && allowStart) {
      clientLog(`no runtime on ${instance.ipcEndpoint}; starting one`)
      const child = spawnRuntimeHost({ instance, env, nodeExe, entry: runtimeEntry })
      events.emit('runtime-spawned', { pid: child.pid })
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250))
        if (await canConnect(instance.ipcEndpoint, 1000)) break
      }
    }
    try {
      await connectOnce()
      return { attached: true, welcome }
    } catch (error) {
      setState('failed', error?.message || String(error))
      if (!closedByCaller) scheduleReconnect()
      throw error
    }
  }

  /** Send one request and resolve with its answer. */
  function request(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (!socket) {
        reject(Object.assign(new Error('the runtime is not attached'), { code: 'runtime-not-attached' }))
        return
      }
      seq += 1
      const id = `${process.pid}-c${seq}`
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(Object.assign(new Error(`the runtime did not answer ${method} within ${requestTimeoutMs} ms`), { code: 'runtime-timeout' }))
      }, requestTimeoutMs)
      timer.unref?.()
      pending.set(id, { resolve, reject, timer, method })
      try {
        socket.write(protocol.encode(protocol.request(method, params, id)))
      } catch (error) {
        pending.delete(id)
        clearTimeout(timer)
        reject(error)
      }
    })
  }

  /** Convenience: run a named command. */
  function command(name, args = {}) {
    return request('command', { command: name, args })
  }

  /**
   * Let go of the Runtime without stopping it.
   *
   * This is what "Quit Desktop" calls. The name matters: it is a *detach*, and it
   * is the difference between closing a window and ending a session.
   */
  function detach() {
    closedByCaller = true
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    for (const [, entry] of pending) {
      clearTimeout(entry.timer)
      entry.reject(Object.assign(new Error('the client detached'), { code: 'runtime-detached' }))
    }
    pending = new Map()
    try {
      socket?.end()
    } catch {}
    socket = null
    setState('idle', 'detached by the caller')
    return { detached: true, runtimeStopped: false }
  }

  /** The explicit full stop: ask the Runtime to shut itself down, then let go. */
  async function shutdownRuntime({ reason = 'desktop requested a full stop' } = {}) {
    if (!socket) {
      // Nothing attached: if a Runtime is nevertheless alive, it is a deliberate
      // explicit stop, so it is still asked to stop.
      const probe = await probeRuntime({ instance })
      if (!probe.running) return { stopped: false, reason: 'no runtime was running' }
      closedByCaller = false
      await connectOnce()
    }
    try {
      const answer = await request('shutdown', { reason })
      const deadline = Date.now() + 15_000
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 200))
        if (!(await canConnect(instance.ipcEndpoint, 500))) break
      }
      return { stopped: true, answer }
    } finally {
      detach()
    }
  }

  function onEvent(listener) {
    if (typeof listener !== 'function') return () => {}
    topicListeners.add(listener)
    return () => topicListeners.delete(listener)
  }

  return {
    instance,
    events,
    onEvent,
    attach,
    detach,
    request,
    command,
    shutdownRuntime,
    onLost: (reason) => onLost(reason instanceof Error ? reason : new Error(String(reason))),
    get state() {
      return state
    },
    get attached() {
      return state === 'attached' && Boolean(socket)
    },
    get welcome() {
      return welcome
    },
    status: () => request('status', {}),
    snapshot: () => request('snapshot', {}),
    health: () => request('health', {}),
    /** Every connection state a UI can render, for the header of a status panel. */
    describe: () => ({
      state,
      attached: state === 'attached' && Boolean(socket),
      endpoint: instance.ipcEndpoint,
      instanceId: instance.instanceId,
      harnessPort: instance.harnessPort,
      hostPid: welcome?.hostPid ?? null,
      inFlight: pending.size
    })
  }
}

/**
 * Resolve the instance and attach in one call: what the Desktop Client actually
 * needs at boot. Returns both the client and the resolved instance, because the
 * caller needs the port and the userData path before it creates a window.
 */
async function attachOrStartInstance({ root, dshHome, requestedPort, ...rest } = {}) {
  const instance = await instanceModule.resolveInstance({ root, dshHome, requestedPort })
  const client = createRuntimeClient({ instance, ...rest })
  const result = await client.attach()
  return { instance, client, ...result }
}

module.exports = {
  CLIENT_STATES,
  probeRuntime,
  canConnect,
  spawnRuntimeHost,
  createRuntimeClient,
  attachOrStartInstance
}
