#!/usr/bin/env node
'use strict'

/**
 * `runtime` — the standalone DS-Hns Runtime command line.
 *
 * The Runtime Host is not a library that only the Desktop can reach: it is a
 * program. That is what makes `Electron may disappear; DS-Hns Runtime must
 * continue to exist` verifiable instead of merely claimed — a Runtime can be
 * started, inspected and stopped with no UI in the picture at all.
 *
 *   runtime serve     run the host in the foreground (what the Desktop spawns detached)
 *   runtime start     ensure a host is running, detached, and return
 *   runtime stop      graceful shutdown of the running host
 *   runtime status    attach, ask, report — the UI's own view, without the UI
 *   runtime attach    hold a connection and stream events (debugging)
 *   runtime capability  print this host's capability profile and derived policy
 *
 * Every command resolves the instance identity from `--root`/`--dsh-home`, so two
 * checkouts are two instances and neither command ever reaches the other one.
 */

const path = require('node:path')
const fs = require('node:fs')

const instanceModule = require('./instance.cjs')
const protocol = require('./protocol.cjs')
const { createRuntimeClient, probeRuntime, spawnRuntimeHost } = require('./client.cjs')
const { collectHostProfile, loadProfileFixture } = require('./host-capability.cjs')

/** The ownership record type the Runtime Host writes; see `client.cjs` for why it is a literal. */
const HOST_OWNERSHIP_TYPE = 'runtime-host'

function parseArgs(argv) {
  const args = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      args._.push(token)
      continue
    }
    const equals = token.indexOf('=')
    if (equals > 0) {
      args[token.slice(2, equals)] = token.slice(equals + 1)
      continue
    }
    const key = token.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) {
      args[key] = true
    } else {
      args[key] = next
      index += 1
    }
  }
  return args
}

function resolveRootAndHome(args) {
  const root = path.resolve(String(args.root || process.env.DSH_ROOT || path.join(__dirname, '..', '..')))
  const dshHome = path.resolve(String(args['dsh-home'] || process.env.DSH_HOME || path.join(root, 'data')))
  const requestedPort = args.port !== undefined ? Number(args.port) : Number(process.env.DSH_HARNESS_PORT) || undefined
  return { root, dshHome, requestedPort }
}

function print(value) {
  process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`)
}

function logLine(line) {
  if (process.env.DSH_RUNTIME_QUIET === '1') return
  process.stderr.write(`${line}\n`)
}

/** `serve`: the foreground host. This is the process that must outlive the UI. */
async function commandServe(args) {
  const { root, dshHome, requestedPort } = resolveRootAndHome(args)
  // The host takes the port it was told to take: it is the *owner* of that
  // decision, and re-allocating here would move the port out from under the
  // client that already resolved the same instance. A port that is genuinely
  // taken is reported by `harness.start`, not fatal to the host.
  const instance = instanceModule.describeInstance({ root, dshHome, requestedPort })
  const port = Number(args.port) || Number(process.env.DSH_HARNESS_PORT) || instance.requestedPort || 3080
  const { createRuntimeHost } = require('./host.cjs')
  const host = createRuntimeHost({
    root,
    dshHome,
    port,
    hostProfile: args['profile-fixture'] ? loadProfileFixture(String(args['profile-fixture'])) : null,
    log: logLine
  })
  const bound = await host.listen()
  print({
    ok: true,
    event: 'runtime-host-listening',
    instanceId: bound.instanceId,
    hostPid: bound.hostPid,
    ipcEndpoint: bound.socketPath,
    harnessPort: port,
    protocol: protocol.PROTOCOL_VERSION
  })

  // The host owns its own lifetime. It exits when it is told to shut down, and
  // not because a client stopped talking to it.
  let stopping = false
  const stop = async (signal) => {
    if (stopping) return
    stopping = true
    logLine(`runtime host received ${signal}; shutting down`)
    await host.shutdown({ reason: `signal ${signal}` })
    process.exit(0)
  }
  process.on('SIGINT', () => void stop('SIGINT'))
  process.on('SIGTERM', () => void stop('SIGTERM'))
  host.events.on('shutdown', () => process.exit(0))
  // A GUI-less host has nothing else to do; keep the loop alive on the server.
  return new Promise(() => {})
}

/** `start`: ensure a host exists without stealing an attached one. */
async function commandStart(args) {
  const { root, dshHome, requestedPort } = resolveRootAndHome(args)
  const instance = await instanceModule.resolveInstance({ root, dshHome, requestedPort })
  const probe = await probeRuntime({ instance })
  if (probe.running) {
    print({ ok: true, started: false, alreadyRunning: true, instanceId: instance.instanceId, ipcEndpoint: instance.ipcEndpoint, harnessPort: instance.harnessPort, hostPid: probe.recordPid })
    return 0
  }
  if (probe.stale) {
    // A record whose owner is gone is cleared, so `status` afterwards tells the
    // truth rather than reporting a Runtime that no longer exists.
    require('../runtime-process.cjs').clearOwnership({ root: instance.root, type: HOST_OWNERSHIP_TYPE })
    logLine('cleared a stale runtime-host ownership record')
  }
  const child = spawnRuntimeHost({ instance, env: process.env, entry: __filename })
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    if (await probeRuntime({ instance, timeoutMs: 800 }).then((result) => result.running)) {
      print({ ok: true, started: true, instanceId: instance.instanceId, hostPid: child.pid, ipcEndpoint: instance.ipcEndpoint, harnessPort: instance.harnessPort })
      return 0
    }
  }
  print({ ok: false, started: false, error: 'the runtime host did not become reachable within 30 s', instanceId: instance.instanceId })
  return 1
}

/** `stop`: the explicit full stop, and the only command that ends a Runtime. */
async function commandStop(args) {
  const { root, dshHome, requestedPort } = resolveRootAndHome(args)
  const instance = await instanceModule.resolveInstance({ root, dshHome, requestedPort })
  const client = createRuntimeClient({ instance, log: logLine })
  const result = await client.shutdownRuntime({ reason: args.reason ? String(args.reason) : 'runtime stop' })
  print({ ok: result.stopped !== false, ...result, instanceId: instance.instanceId })
  return result.stopped === false && args.strict ? 1 : 0
}

async function withClient(args, fn) {
  const { root, dshHome, requestedPort } = resolveRootAndHome(args)
  const instance = await instanceModule.resolveInstance({ root, dshHome, requestedPort })
  const client = createRuntimeClient({ instance, log: logLine, autoStartRuntime: args['no-start'] !== true })
  await client.attach()
  try {
    return await fn(client, instance)
  } finally {
    client.detach()
  }
}

async function commandStatus(args) {
  const { root, dshHome, requestedPort } = resolveRootAndHome(args)
  const instance = await instanceModule.resolveInstance({ root, dshHome, requestedPort })
  const probe = await probeRuntime({ instance })
  if (!probe.running) {
    print({
      ok: true,
      running: false,
      instanceId: instance.instanceId,
      root: instance.root,
      dshHome: instance.dshHome,
      harnessPort: instance.harnessPort,
      ipcEndpoint: instance.ipcEndpoint,
      userData: instance.paths.userData,
      staleRecord: probe.stale,
      note: 'no runtime is running for this instance'
    })
    return 0
  }
  const client = createRuntimeClient({ instance, log: logLine })
  await client.attach()
  try {
    const status = await client.status()
    print({ ok: true, running: true, ...status })
    return 0
  } finally {
    client.detach()
  }
}

async function commandAttach(args) {
  const { root, dshHome, requestedPort } = resolveRootAndHome(args)
  const instance = await instanceModule.resolveInstance({ root, dshHome, requestedPort })
  const client = createRuntimeClient({ instance, log: logLine })
  await client.attach()
  print({ ok: true, attached: true, endpoint: instance.ipcEndpoint, hostPid: client.welcome?.hostPid ?? null })
  client.onEvent((topic, payload) => print({ event: topic, payload }))
  process.on('SIGINT', () => {
    client.detach()
    process.exit(0)
  })
  return new Promise(() => {})
}

async function commandCapability(args) {
  const { root, dshHome } = resolveRootAndHome(args)
  const profile = args['profile-fixture']
    ? loadProfileFixture(String(args['profile-fixture']))
    : collectHostProfile({ electronExe: args['electron-exe'] ? String(args['electron-exe']) : null, measureElectron: args['measure-electron'] === true, log: logLine })
  if (args.write) {
    const { writeCachedProfile } = require('./host-capability.cjs')
    writeCachedProfile(dshHome, profile)
  }
  print(profile)
  return 0
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const command = String(args._[0] || 'status')
  switch (command) {
    case 'serve':
      return commandServe(args)
    case 'start':
      return commandStart(args)
    case 'stop':
      return commandStop(args)
    case 'status':
      return commandStatus(args)
    case 'attach':
      return commandAttach(args)
    case 'capability':
      return commandCapability(args)
    case 'help':
    case '--help':
      print(
        [
          'usage: node app/runtime/runtime.cjs <command> [--root DIR] [--dsh-home DIR] [--port N]',
          '',
          '  serve        run the Runtime Host in the foreground',
          '  start        ensure a detached Runtime Host is running',
          '  stop         graceful shutdown of the running Runtime Host',
          '  status       report the instance and the running Runtime',
          '  attach       hold a connection and stream events',
          '  capability   print the host capability profile'
        ].join('\n')
      )
      return 0
    default:
      process.stderr.write(`unknown command: ${command}\n`)
      return 2
  }
}

if (require.main === module) {
  void main()
    .then((code) => {
      if (typeof code === 'number') process.exitCode = code
    })
    .catch((error) => {
      process.stderr.write(`${error?.stack || error}\n`)
      process.exitCode = 1
    })
}

module.exports = { main, parseArgs }
