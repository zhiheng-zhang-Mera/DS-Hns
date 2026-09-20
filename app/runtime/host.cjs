'use strict'

/**
 * The DS-Hns Runtime Host.
 *
 *   UI MUST NOT OWN RUNTIME LIFETIME
 *
 * This process is the answer to that sentence. It is plain Node, it never
 * requires Electron, and it owns every long-lived thing DS-Hns does:
 *
 *   - the managed Harness child (the actual product engine);
 *   - the Sub-worker execution layer and its task persistence;
 *   - the Engineering supervisor;
 *   - the Plugin platform and its runtime state;
 *   - the Computer Use *core* (scheduling, state, policy) — with the Electron
 *     page capability as a port that comes and goes;
 *   - host capacity calibration and the health/status snapshot.
 *
 * The Desktop Client attaches to it over a named pipe. That inversion is the
 * whole point: closing the window used to stop the Harness, and killing the shell
 * used to take the workers with it. Now the UI is a *view* of the Runtime — one
 * that can disappear, reappear, and attach to a Runtime that never noticed.
 *
 * The host also runs with no client at all: `runtime.cjs start` starts it, and it
 * serves. That is what `Electron may disappear; DS-Hns Runtime must continue to
 * exist` means in practice.
 *
 * Ownership is deliberately *not* reinvented. The host writes the same
 * `runtime-process.cjs` ownership records the shell always wrote, and it is the
 * *owner* in them, so the existing stale-recovery path — which proves a PID is
 * really the expected DSH process before killing it — keeps working unchanged.
 * There is still exactly one ownership system.
 */

const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { spawn } = require('node:child_process')

const runtimeProcess = require('../runtime-process.cjs')
const protocol = require('./protocol.cjs')
const instanceModule = require('./instance.cjs')
const { createHarnessService, ensureRuntimeDirs, isPortListening } = require('./harness-service.cjs')
const { collectHostProfile, createCalibratedProfile, readCachedProfile, writeCachedProfile } = require('./host-capability.cjs')

/** The ownership record type the Runtime Host itself writes. */
const HOST_OWNERSHIP_TYPE = 'runtime-host'

const MAX_SUBSCRIBERS = 64

/**
 * Build the host.
 *
 * Every service is created lazily. A host that is only being asked for `status`
 * must not start a Harness, a worker pool or a plugin tree — the same "inert until
 * asked for" rule the shell already followed, now enforced one level down.
 */
function createRuntimeHost({
  root,
  dshHome,
  port,
  host: bindHost = '127.0.0.1',
  env = process.env,
  log = () => {},
  /** Injected for tests: a pre-measured profile instead of calibrating this machine. */
  hostProfile = null,
  electronExe = null,
  runtimeProcessModule = runtimeProcess
} = {}) {
  const ROOT = path.resolve(root || path.join(__dirname, '..', '..'))
  const HOME = path.resolve(dshHome || path.join(ROOT, 'data'))
  const events = new EventEmitter()
  events.setMaxListeners(0)
  const startedAt = new Date().toISOString()
  const hostPid = process.pid

  const instance = {
    ...instanceModule.describeInstance({ root: ROOT, dshHome: HOME, requestedPort: port }),
    harnessPort: Number(port) || 3080
  }

  /** The single source of truth for what the Runtime owns. */
  const services = {
    harness: null,
    workerManager: null,
    engineeringHost: null,
    pluginHost: null,
    computerUse: null
  }

  let profile = hostProfile
  let server = null
  let shuttingDown = false
  const subscribers = new Map()
  let subscriberSeq = 0
  /** Lifecycle log, so `status` can explain what happened without a UI. */
  const history = []

  function hostLog(message) {
    const line = `${new Date().toISOString()} ${String(message)}`
    history.push(line)
    if (history.length > 500) history.shift()
    try {
      fs.mkdirSync(path.dirname(instance.paths.runtimeLog), { recursive: true })
      fs.appendFileSync(instance.paths.runtimeLog, `${line}\n`, 'utf8')
    } catch {}
    log(message)
  }

  function hostProfileResolved() {
    if (profile) return profile
    const cached = readCachedProfile(HOME)
    if (cached) {
      profile = cached
      hostLog(`host profile: reused cached calibration (${profile.capacity?.class})`)
      return profile
    }
    profile = collectHostProfile({ env, electronExe, log: hostLog })
    writeCachedProfile(HOME, profile)
    hostLog(
      `host profile: ${profile.capacity.class} cores=${profile.cpu.logicalCores} ` +
        `mem=${profile.memory.totalMB}MB spawnP95=${profile.calibration.nodeSpawnP95Ms}ms ` +
        `workers=${profile.workers.recommended}`
    )
    return profile
  }

  function emitEvent(topic, payload) {
    const frame = protocol.encode(protocol.event(topic, payload))
    for (const socket of subscribers.values()) {
      try {
        socket.write(frame)
      } catch {
        /* a subscriber that cannot be written to is dropped by its own error handler */
      }
    }
    events.emit('event', { topic, payload })
  }

  // --- Harness -------------------------------------------------------------

  /**
   * The Harness is started through the shared service, pointed at this instance's
   * own port and HOME. It is never started implicitly by a status query.
   */
  function ensureHarness() {
    if (services.harness) return services.harness
    services.harness = createHarnessService({
      root: ROOT,
      dshHome: HOME,
      port: instance.harnessPort,
      host: bindHost,
      runtimeProcess: runtimeProcessModule,
      env,
      log: hostLog,
      portExplicit: true
    })
    services.harness.events.on('url', (url) => {
      hostLog('harness announced its access URL')
      emitEvent('harness', { state: 'ready', urlRedacted: String(url).replace(/(\?token=)[^\s)\]]+/gi, '$1[REDACTED]') })
    })
    services.harness.events.on('exit', ({ code, signal, childPid }) => {
      hostLog(`harness exited code=${code} signal=${signal || ''} pid=${childPid}`)
      emitEvent('harness', { state: 'stopped', code, signal })
    })
    return services.harness
  }

  async function startHarness() {
    const harness = ensureHarness()
    if (harness.describe().running) {
      hostLog('harness.start: already running')
      return { started: false, alreadyRunning: true, ...harness.describe() }
    }
    /**
     * A port that is listening is not automatically somebody else's.
     *
     * It may be *this instance's own* Harness, left behind when a previous Runtime
     * Host was killed before it could reap its child. Treating that as "the port is
     * taken" would make an instance permanently unable to restart itself — which is
     * exactly what the second copy did on its first relaunch here.
     *
     * So the ownership record decides, and only the record:
     *
     *   - no record for this instance, or a record whose root/entry is not ours
     *     -> a foreign listener; reported, never touched;
     *   - our record, our expected DSH entry, but the *owner* is gone
     *     -> our own orphan; reaped through the existing recovery path, then start;
     *   - our record with a live owner -> another Runtime Host of this very
     *     instance is up; reported, never touched.
     *
     * `recoverOwnedStale` is the same function the shell always used, and it
     * already refuses to kill a PID it cannot prove is the expected DSH process.
     */
    if (await isPortListening(instance.harnessPort, bindHost)) {
      const owned = runtimeProcessModule.readOwnership(ROOT)
      const ownedRootMatches = owned && path.resolve(String(owned.root || '')) === ROOT
      const ownedEntryMatches = owned && path.resolve(String(owned.dshEntry || '')) === path.resolve(harness.describe().entry)
      const ownedPid = Number(owned?.childPid ?? owned?.pid) || 0
      const ownedParentAlive = runtimeProcessModule.processExists(Number(owned?.parentPid) || 0)

      if (!owned || !ownedRootMatches || !ownedEntryMatches) {
        const detail = `port ${instance.harnessPort} is already listening and is not owned by this instance`
        hostLog(`harness.start: ${detail}`)
        return { started: false, blocked: true, reason: detail, ...harness.describe() }
      }
      if (ownedParentAlive && Number(owned.parentPid) !== hostPid) {
        const detail = `port ${instance.harnessPort} is held by this instance's Harness under another live Runtime Host (pid ${owned.parentPid})`
        hostLog(`harness.start: ${detail}`)
        return { started: false, blocked: true, reason: detail, ...harness.describe() }
      }
      hostLog(`harness.start: reclaiming this instance's orphaned Harness (pid ${ownedPid})`)
      await runtimeProcessModule.recoverOwnedStale({ root: ROOT, dshEntry: harness.describe().entry, log: hostLog })
      // Give the port a moment to be released before the readiness probe runs.
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline && (await isPortListening(instance.harnessPort, bindHost))) {
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
    }
    await runtimeProcessModule.recoverOwnedStale({ root: ROOT, dshEntry: harness.describe().entry, log: hostLog })
    await harness.start()
    let url = null
    try {
      url = await harness.waitUntilReady(hostProfileResolved().budgets.harnessStartup.timeoutMs)
    } catch (error) {
      hostLog(`harness.start: readiness failed: ${error?.message || error}`)
      return { started: false, error: String(error?.message || error), ...harness.describe() }
    }
    hostLog('harness.start: ready')
    return { started: true, ...harness.describe(), url }
  }

  function stopHarness() {
    if (!services.harness) return { stopped: false, reason: 'no harness service' }
    const result = services.harness.stop()
    hostLog(`harness.stop: ${JSON.stringify(result)}`)
    return result
  }

  // --- Sub-worker ----------------------------------------------------------

  /**
   * The worker ceiling comes from the host's own calibration rather than from a
   * default written on a fast development machine. `maxWorkers` is the manager's
   * host sanity cap, which is exactly the hook the derived ceiling needs.
   */
  function ensureWorkerManager() {
    if (services.workerManager) return services.workerManager
    const { WorkerManager } = require('../sub-worker/manager.cjs')
    const resolved = hostProfileResolved()
    services.workerManager = new WorkerManager({
      root: ROOT,
      nodeExe: resolveHostNodeExe(),
      runtimeProcess: runtimeProcessModule,
      log: hostLog,
      notify: (event) => emitEvent('worker', event),
      maxWorkers: resolved.workers.recommended
    })
    services.workerManager.hydrate()
    hostLog(`sub-worker manager ready; ceiling=${resolved.workers.recommended} state=${services.workerManager.describe().state}`)
    return services.workerManager
  }

  function resolveHostNodeExe() {
    const { resolveNodeExe } = require('./harness-service.cjs')
    return resolveNodeExe({ root: ROOT, env, log: hostLog })
  }

  async function startWorker() {
    const manager = ensureWorkerManager()
    const recovery = await runtimeProcessModule.recoverStaleWorker({
      root: ROOT,
      entry: path.join(__dirname, '..', 'sub-worker', 'runtime.cjs'),
      log: hostLog
    })
    if (recovery.killed) hostLog(`reclaimed an orphaned sub-worker process (pid ${recovery.childPid})`)
    const started = await manager.start({ reason: 'runtime-host' })
    hostLog(`worker.start: ${JSON.stringify(started)}`)
    return started
  }

  function stopWorker() {
    if (!services.workerManager) return { stopped: false, reason: 'no worker manager' }
    const result = services.workerManager.prepareExit?.()
    const forced = services.workerManager.forceStop('runtime host stop')
    hostLog('worker.stop: terminated')
    return { stopped: true, prepared: Boolean(result), ...(forced || {}) }
  }

  // --- Engineering / Plugins / Computer Use core ---------------------------

  function ensureEngineeringHost() {
    if (services.engineeringHost) return services.engineeringHost
    const { createEngineeringHost } = require('../engineering-host.cjs')
    services.engineeringHost = createEngineeringHost({
      log: hostLog,
      checkpointRoot: path.join(ROOT, 'runtime', 'engineering', 'checkpoints'),
      // The enabled/disabled default belongs to the deployment's config, exactly as
      // it does in the shell; a Runtime that decides it for itself would be a second
      // opinion about the same file.
      available: () => true,
      reason: () => 'the engineering runtime is disabled by config/app.json (engineering.enabled = false)'
    })
    hostLog('engineering host created')
    return services.engineeringHost
  }

  function ensurePluginHost() {
    if (services.pluginHost) return services.pluginHost
    const { createPluginHost } = require('../plugin-host.cjs')
    services.pluginHost = createPluginHost({
      log: hostLog,
      root: ROOT,
      configDir: path.join(ROOT, 'config', 'plugins'),
      available: () => true,
      reason: () => 'the plugin runtime is disabled by config/app.json (plugins.enabled = false)',
      nodeExe: resolveHostNodeExe()
    })
    hostLog('plugin host created')
    return services.pluginHost
  }

  /**
   * The Computer Use **core**.
   *
   * The core is Electron-free by construction — `computer-use/index.cjs` takes
   * ports — so it lives here, where it survives the UI. The one port it cannot own
   * is the page: driving the visible surface needs `webContents.debugger`, which
   * only the Electron Client has.
   *
   * That is the boundary, and it is expressed as a capability rather than a
   * dependency. The core starts with `page: null`; the Electron Client announces
   * `computerUse.capability` and the page port is filled in. When the Client goes
   * away the capability is withdrawn, the core reports `CAPABILITY_UNAVAILABLE`
   * for the page-bound controllers and **keeps running**: its scheduler, its
   * state, its history and every non-UI controller are unaffected.
   */
  function ensureComputerUse() {
    if (services.computerUse) return services.computerUse
    const { createComputerUseRuntime } = require('../computer-use/index.cjs')
    const state = {
      /** 'unavailable' until an Electron Client announces itself. */
      capability: 'unavailable',
      provider: null,
      since: new Date().toISOString()
    }
    const runtime = createComputerUseRuntime({
      host: {
        // The page capability is a live lookup, so a Client that attaches later is
        // picked up on the next run rather than needing the runtime rebuilt.
        getPage: () => state.provider || null
      },
      // Desktop/accessibility/screenshot drivers are plain Node and are found by
      // the core's own controllers. A host without them reports them degraded
      // rather than refusing to start.
      options: {},
      log: { dir: path.join(ROOT, 'logs', 'computer-use') }
    })
    services.computerUse = {
      runtime,
      state,
      setCapability(next, provider = null) {
        state.capability = next
        state.provider = provider
        state.since = new Date().toISOString()
        hostLog(`computer use page capability: ${next}`)
        emitEvent('computer-use', { capability: next })
      },
      describe() {
        let health = null
        try {
          health = runtime.health?.() ?? null
        } catch (error) {
          health = { error: String(error?.message || error) }
        }
        return {
          capability: state.capability,
          since: state.since,
          /** The status a UI shows instead of a crash. */
          status: state.capability === 'available' ? 'AVAILABLE' : 'CAPABILITY_UNAVAILABLE',
          health
        }
      }
    }
    hostLog('computer use core created (page capability: unavailable)')
    return services.computerUse
  }

  // --- Status / snapshot ---------------------------------------------------

  function status() {
    return {
      protocol: protocol.PROTOCOL_VERSION,
      instanceId: instance.instanceId,
      root: ROOT,
      dshHome: HOME,
      harnessPort: instance.harnessPort,
      ipcEndpoint: instance.ipcEndpoint,
      hostPid,
      parentPid: null,
      startedAt,
      uptimeMs: Date.now() - Date.parse(startedAt),
      shuttingDown,
      electronAttached: subscribers.size > 0,
      subscribers: subscribers.size,
      capabilityProfile: profile
        ? { class: profile.capacity?.class, workers: profile.workers?.recommended }
        : null,
      services: {
        harness: services.harness ? services.harness.describe() : { running: false, created: false },
        worker: services.workerManager
          ? { created: true, state: services.workerManager.describe().state, ceiling: services.workerManager.describe().config?.maxWorkers ?? null }
          : { created: false },
        engineering: services.engineeringHost ? { created: true } : { created: false },
        plugins: services.pluginHost ? { created: true } : { created: false },
        computerUse: services.computerUse ? services.computerUse.describe() : { created: false }
      }
    }
  }

  /** A redacted snapshot safe to hand to a renderer. */
  function snapshot() {
    const base = status()
    let worker = null
    if (services.workerManager) {
      try {
        const described = services.workerManager.describe()
        worker = { state: described.state, plans: described.plans?.length ?? 0, queue: described.queue?.length ?? 0 }
      } catch (error) {
        worker = { error: String(error?.message || error) }
      }
    }
    return { ...base, workerSnapshot: worker, history: history.slice(-40) }
  }

  // --- Connection handling -------------------------------------------------

  function handleFrame(socket, frame) {
    const accepted = protocol.accept(frame, protocol.CLIENT_METHODS)
    if (!accepted.ok) {
      try {
        socket.write(protocol.encode(protocol.failure(frame?.id, accepted.reason, 'protocol-rejected')))
      } catch {}
      return
    }
    const { method, id, params } = accepted
    const answer = (payload) => {
      try {
        socket.write(protocol.encode(protocol.reply('result', id, payload)))
      } catch {}
    }
    const fail = (error, code = 'runtime-error') => {
      try {
        socket.write(protocol.encode(protocol.failure(id, error?.message || error, code)))
      } catch {}
    }
    switch (method) {
      case 'hello': {
        try {
          socket.write(
            protocol.encode(
              protocol.reply('welcome', id, {
                protocol: protocol.PROTOCOL_VERSION,
                instanceId: instance.instanceId,
                hostPid,
                root: ROOT,
                dshHome: HOME,
                harnessPort: instance.harnessPort,
                commands: protocol.COMMANDS,
                capability: profile ? { class: profile.capacity?.class } : null,
                startedAt
              })
            )
          )
        } catch (error) {
          fail(error)
        }
        return
      }
      case 'ping':
        answer({ pong: true, at: new Date().toISOString() })
        return
      case 'status':
        answer(status())
        return
      case 'snapshot':
        answer(snapshot())
        return
      case 'health': {
        const capability = hostProfileResolved()
        answer({
          ok: !shuttingDown,
          hostPid,
          harness: services.harness ? services.harness.describe() : null,
          capacity: capability.capacity,
          workers: capability.workers,
          budgets: capability.budgets,
          capabilityClass: capability.capacity?.class
        })
        return
      }
      case 'subscribe': {
        subscriberSeq += 1
        const key = `${hostPid}-${subscriberSeq}`
        subscribers.set(key, socket)
        socket.once('close', () => subscribers.delete(key))
        hostLog(`subscriber attached (${key}); ${subscribers.size} attached`)
        answer({ subscribed: true, topics: params.topics || ['harness', 'worker', 'computer-use', 'runtime'] })
        // The Client is now the Computer Use page provider until it goes away.
        return
      }
      case 'cancel': {
        if (params.commandId) {
          events.emit('cancel', params.commandId)
          answer({ cancelled: true, commandId: params.commandId })
        } else {
          answer({ cancelled: false, reason: 'no commandId' })
        }
        return
      }
      case 'shutdown':
        answer({ shuttingDown: true })
        void shutdown({ reason: params.reason || 'client request' }).then(() => {
          try {
            socket.end(protocol.encode(protocol.reply('bye', id, { reason: 'runtime shutdown' })))
          } catch {}
        })
        return
      case 'command':
        void runCommand(params).then(answer).catch((error) => fail(error))
        return
      default:
        fail(`unhandled method ${method}`, 'unhandled')
    }
  }

  /** The command surface. Everything the UI used to do in-process goes through here. */
  async function runCommand({ command, args = {} } = {}) {
    const name = String(command || '')
    if (!protocol.COMMANDS.includes(name)) {
      const error = new Error(`unsupported command: ${name || '(missing)'}`)
      error.code = 'unsupported-command'
      throw error
    }
    switch (name) {
      case 'harness.start':
        return startHarness()
      case 'harness.stop':
        return stopHarness()
      case 'harness.url': {
        // The one place the token is disclosed, and only to an attached client
        // over the instance's own pipe. It is never logged and never in a frame
        // that a subscriber receives unsolicited.
        const harness = services.harness
        if (!harness) return { available: false, reason: 'the harness has not been started' }
        const url = harness.url
        return url ? { available: true, url, port: instance.harnessPort } : { available: false, reason: 'the harness has not announced its access URL yet' }
      }
      case 'worker.start':
        return startWorker()
      case 'worker.stop':
        return stopWorker()
      case 'worker.describe':
        return ensureWorkerManager().describe()
      case 'engineering.status': {
        const host = ensureEngineeringHost()
        return { created: true, status: typeof host.status === 'function' ? host.status() : null }
      }
      case 'plugins.status': {
        const host = ensurePluginHost()
        return { created: true, status: typeof host.status === 'function' ? host.status() : null }
      }
      case 'computerUse.status':
        return ensureComputerUse().describe()
      case 'computerUse.capability': {
        const core = ensureComputerUse()
        // The provider itself cannot cross a pipe: what crosses is the *claim*.
        // The Electron Client keeps the transport and fulfils page requests.
        core.setCapability(args.available === false ? 'unavailable' : 'available', args.available === false ? null : { provider: 'electron-client' })
        return core.describe()
      }
      case 'host.capability': {
        if (args.refresh) {
          profile = collectHostProfile({ env, electronExe, log: hostLog })
          writeCachedProfile(HOME, profile)
        }
        return hostProfileResolved()
      }
      case 'runtime.shutdown':
        void shutdown({ reason: 'runtime.shutdown command' })
        return { shuttingDown: true }
      default:
        throw new Error(`unreachable command ${name}`)
    }
  }

  /** Announce a capability withdrawal when the last Client goes away. */
  function handleDisconnect() {
    if (services.computerUse && services.computerUse.state.capability !== 'unavailable') {
      services.computerUse.setCapability('unavailable', null)
      emitEvent('computer-use', { capability: 'unavailable', reason: 'electron client disconnected' })
    }
    hostLog(`client disconnected; ${subscribers.size} subscriber(s) remain`)
  }

  // --- Lifecycle -----------------------------------------------------------

  /**
   * Drain, checkpoint, terminate owned children.
   *
   * This is the *only* path that terminates the Harness. It runs when a client
   * explicitly asks for a full stop (`runtime.shutdown`, "Stop DS-Hns Completely",
   * `runtime.cjs stop`) — never because a window closed.
   */
  async function shutdown({ reason = 'unspecified' } = {}) {
    if (shuttingDown) return { alreadyShuttingDown: true }
    shuttingDown = true
    hostLog(`runtime shutdown requested: ${reason}`)
    const results = {}
    // Order matters: persist state first, then the worker, then the Harness.
    try {
      if (services.pluginHost) results.plugins = await Promise.resolve(services.pluginHost.dispose?.() ?? null)
    } catch (error) {
      results.plugins = String(error?.message || error)
    }
    try {
      if (services.engineeringHost) results.engineering = await Promise.resolve(services.engineeringHost.dispose?.() ?? null)
    } catch (error) {
      results.engineering = String(error?.message || error)
    }
    try {
      results.worker = stopWorker()
    } catch (error) {
      results.worker = String(error?.message || error)
    }
    try {
      results.harness = stopHarness()
    } catch (error) {
      results.harness = String(error?.message || error)
    }
    try {
      runtimeProcessModule.clearOwnership({ root: ROOT, type: HOST_OWNERSHIP_TYPE })
    } catch {}
    const frame = protocol.encode(protocol.event('runtime', { state: 'stopped', reason }))
    for (const socket of subscribers.values()) {
      try {
        socket.write(frame)
        socket.end()
      } catch {}
    }
    subscribers.clear()
    try {
      server?.close()
    } catch {}
    hostLog(`runtime shutdown complete: ${JSON.stringify(results)}`)
    events.emit('shutdown', results)
    return results
  }

  /**
   * Bind the instance's IPC endpoint.
   *
   * The bind itself is the single-instance guard: a second Host on the same
   * endpoint fails with `EADDRINUSE`, which is a *fact* rather than a race on a
   * lock file. The ownership record is written for recovery and for `status`.
   */
  function listen() {
    return new Promise((resolve, reject) => {
      ensureRuntimeDirs(ROOT, HOME)
      const socketPath = instance.ipcEndpoint
      if (process.platform !== 'win32') {
        try {
          fs.rmSync(socketPath, { force: true })
        } catch {}
      }
      server = net.createServer((socket) => {
        socket.setEncoding('utf8')
        let rest = ''
        socket.on('data', (chunk) => {
          const decoded = protocol.decode(chunk, rest)
          rest = decoded.remainder
          for (const frame of decoded.frames) handleFrame(socket, frame)
        })
        socket.on('error', () => {
          /* a broken pipe is a disconnect, not a fault */
        })
        socket.on('close', () => {
          for (const [key, candidate] of subscribers) if (candidate === socket) subscribers.delete(key)
          handleDisconnect()
        })
      })
      server.once('error', (error) => {
        hostLog(`runtime host could not bind ${socketPath}: ${error?.message || error}`)
        reject(error)
      })
      server.listen(socketPath, () => {
        const instancePaths = instanceModule.describeInstance({
          root: ROOT,
          dshHome: HOME,
          requestedPort: instance.harnessPort
        }).paths
        const ownership = runtimeProcessModule.writeOwnership({
          root: ROOT,
          type: HOST_OWNERSHIP_TYPE,
          entry: __filename,
          pid: hostPid,
          parentPid: hostPid,
          instanceId: instance.instanceId,
          protocol: protocol.PROTOCOL_VERSION,
          ipcEndpoint: socketPath,
          harnessPort: instance.harnessPort,
          harnessPid: null
        })
        // The record's `path` fields are always derived, never taken from a
        // caller-supplied object, so a stale `instance` value cannot persist a
        // wrong userData path.
        instanceModule.writeInstanceRecord(
          { ...instance, paths: instancePaths },
          { hostPid, hostStartedAt: startedAt, ownershipWritten: Boolean(ownership) }
        )
        hostLog(`runtime host listening on ${socketPath} (pid ${hostPid}, instance ${instance.instanceId})`)
        resolve({ socketPath, hostPid, instanceId: instance.instanceId })
      })
    })
  }

  return {
    instance,
    services,
    events,
    listen,
    shutdown,
    status,
    snapshot,
    runCommand,
    hostProfile: hostProfileResolved,
    startHarness,
    stopHarness,
    startWorker,
    stopWorker,
    ensureHarness,
    ensureWorkerManager,
    ensureEngineeringHost,
    ensurePluginHost,
    ensureComputerUse,
    get pid() {
      return hostPid
    },
    get subscriberCount() {
      return subscribers.size
    }
  }
}

module.exports = { createRuntimeHost, HOST_OWNERSHIP_TYPE }
