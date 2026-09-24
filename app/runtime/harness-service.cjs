'use strict'

/**
 * The managed Harness child: lifecycle, ownership, and readiness.
 *
 * This module is the Harness half of the old `desktop-main.cjs` lifted out
 * verbatim in behaviour and free of Electron. That is the whole point: the
 * Harness is a plain Node web server, it never needed a GUI, and while it lived
 * inside `desktop-main.cjs` closing the window was the only way to stop it and
 * keeping the window open was the only way to keep it alive.
 *
 * Everything the Runtime Host needs is here:
 *
 *   - the canonical launch line (`web --no-open`, plus `--port` only when the
 *     port was explicitly chosen, so the default line stays byte-identical);
 *   - the ownership record, written through `runtime-process.cjs` so there is
 *     still exactly ONE ownership system and the stale-recovery path that already
 *     knows how to reap an orphan keeps working;
 *   - readiness: the access URL and token are captured from the child's own
 *     output, which is the only place DSH announces them;
 *   - the profile plugin refresh that must happen before the Harness boots.
 */

const fs = require('node:fs')
const net = require('node:net')
const http = require('node:http')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const { EventEmitter } = require('node:events')

const { syncShippedPackage } = require('../harness-profile.cjs')
const { resolveCommandTemp } = require('./temp-root.cjs')
const { patchPluginMarket } = require('./plugin-market-canonical.cjs')

const STARTUP_BUFFER_LIMIT = 64 * 1024

/** Strip ANSI so the launch line captured from the child is comparable to a plain URL. */
function stripAnsi(text) {
  return String(text).replace(/\x1B(?:[@-_][0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g, '')
}

/** Never let a launch token reach a log, a snapshot or a status answer. */
function redact(text) {
  return String(text).replace(/(\?token=)[^\s)\]]+/gi, '$1[REDACTED]')
}

/** Resolve a Node executable the same way the shell always has. */
function resolveNodeExe({ root, env = process.env, log = () => {} } = {}) {
  if (env.DSH_NODE_EXE && fs.existsSync(env.DSH_NODE_EXE)) return env.DSH_NODE_EXE
  const runtimeDir = path.join(root, 'runtime')
  const candidates = []
  try {
    if (fs.existsSync(runtimeDir)) {
      for (const entry of fs.readdirSync(runtimeDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const exe = path.join(runtimeDir, entry.name, 'node.exe')
        if (fs.existsSync(exe)) candidates.push(exe)
      }
    }
  } catch (error) {
    log(`node resolution failed: ${error?.message || error}`)
  }
  if (candidates.length) {
    candidates.sort()
    return candidates[candidates.length - 1]
  }
  return 'node'
}

/** The instance's own directories, which the Harness is told to use and nothing else. */
function ensureRuntimeDirs(root, dshHome, commandTemp) {
  const dirs = ['logs', 'cache', 'data', 'workspace', 'runtime']
  for (const dir of dirs) fs.mkdirSync(path.join(root, dir), { recursive: true })
  if (dshHome) fs.mkdirSync(dshHome, { recursive: true })
  fs.mkdirSync(commandTemp || resolveCommandTemp(root, process.env), { recursive: true })
}

/**
 * Detect ANY listener on a port. Not an HTTP probe on purpose: DSH answers 401 at
 * bare `/` until the token/cookie exchange completes, so a status code says
 * nothing about whether the port is taken.
 */
function isPortListening(port, host = '127.0.0.1', timeoutMs = 1200) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port })
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

/** Is the authenticated URL actually serving? */
function requestUrl(url, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let request
    try {
      request = http.get(url, { timeout: timeoutMs }, (response) => {
        response.resume()
        resolve(response.statusCode >= 200 && response.statusCode < 400)
      })
    } catch {
      resolve(false)
      return
    }
    request.on('timeout', () => request.destroy())
    request.on('error', () => resolve(false))
  })
}

/**
 * Own one managed Harness child.
 *
 * The object is inert until `start()`. Every failure is reported through the
 * returned promise AND as an `error` event, because a caller that is waiting on
 * readiness and a caller that is only watching state both need to hear it.
 */
function createHarnessService({
  root,
  dshHome,
  port,
  host = '127.0.0.1',
  entry,
  runtimeProcess,
  env = process.env,
  log = () => {},
  startupTimeoutMs = Number(env.DSH_STARTUP_TIMEOUT_MS || 120_000),
  /** Whether `--port` is passed at all. False keeps the canonical launch line byte-identical. */
  portExplicit = true
} = {}) {
  if (!root) throw new Error('the Harness service needs a root')
  const ROOT = path.resolve(root)
  const HOME = dshHome ? path.resolve(dshHome) : path.join(ROOT, 'data')
  const DSH_ENTRY = entry || path.join(__dirname, '..', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const HARNESS_PORT = Number(port) || 3080
  const launchArgs = ['web', '--no-open', ...(portExplicit ? ['--port', String(HARNESS_PORT)] : [])]
  const commandTemp = resolveCommandTemp(ROOT, env)
  const events = new EventEmitter()
  events.setMaxListeners(0)

  let child = null
  let childPid = 0
  let url = null
  let output = ''
  let logStream = null
  let startedAt = null
  let stopped = false

  function logPath() {
    return path.join(ROOT, 'logs', 'desktop-runtime.log')
  }

  function emitLog(message) {
    try {
      fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true })
      fs.appendFileSync(logPath(), `${new Date().toISOString()} ${String(message)}\n`, 'utf8')
    } catch {}
    log(message)
  }

  /** The Harness' own last words, redacted. The only place a launch failure explains itself. */
  function outputTail(maxLines = 50) {
    return output
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.trim())
      .slice(-maxLines)
      .join('\n')
  }

  /** Refresh the profile's copy of the shipped plugin DS-Hns ships, before the Harness boots it. */
  function syncProfilePlugin(profileName = env.DSH_PROFILE || 'web') {
    try {
      const changed = syncShippedPackage({
        sourceDir: path.join(__dirname, '..', 'plugins', 'mega-core'),
        modulesDir: path.join(HOME, 'profiles', profileName, 'node_modules'),
        log: emitLog
      })
      if (changed.length) emitLog(`[profile] the profile's copy of the shipped plugin was refreshed: ${changed.join(', ')}`)
    } catch (error) {
      emitLog(`[profile] the profile's copy of the shipped plugin could not be refreshed: ${error?.message || error}`)
    }
  }

  function observe(chunk) {
    const raw = chunk.toString()
    try {
      logStream?.write(`[harness] ${redact(raw)}`)
    } catch {}
    const clean = stripAnsi(raw)
    output = `${output}${clean}`.slice(-STARTUP_BUFFER_LIMIT)
    const match = output.match(/https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/\?token=[^\s)\]"']+/i)
    if (match && !url) {
      url = match[0]
      events.emit('url', url)
    }
  }

  function start() {
    if (child && child.exitCode === null) return Promise.resolve(url)
    stopped = false
    const nodeExe = resolveNodeExe({ root: ROOT, env, log: emitLog })
    ensureRuntimeDirs(ROOT, HOME, commandTemp)
    syncProfilePlugin()
    const activeProfile = env.DSH_PROFILE || 'web'
    patchPluginMarket({ profileDir: path.join(HOME, 'profiles', activeProfile), log: emitLog })
    output = ''
    url = null
    startedAt = new Date().toISOString()

    emitLog('--- Harness launch begin (runtime host) ---')
    emitLog(`node=${nodeExe}`)
    emitLog(`entry=${DSH_ENTRY}`)
    emitLog(`cwd=${ROOT}`)
    emitLog(`DSH_HOME=${HOME}`)
    emitLog(`port=${HARNESS_PORT}`)

    try {
      fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true })
      logStream = fs.createWriteStream(logPath(), { flags: 'a' })
    } catch {
      logStream = null
    }

    child = spawn(nodeExe, [DSH_ENTRY, ...launchArgs], {
      cwd: ROOT,
      env: {
        ...env,
        DSH_ROOT: ROOT,
        DSH_HOME: HOME,
        DSH_PROFILE: activeProfile,
        DSH_NODE: nodeExe,
        DSH_HARNESS_PORT: String(HARNESS_PORT),
        npm_config_cache: path.join(ROOT, 'cache', 'npm'),
        TEMP: commandTemp,
        TMP: commandTemp,
        PATH: `${path.dirname(nodeExe)};${env.PATH || ''}`
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    childPid = child.pid
    if (runtimeProcess) {
      runtimeProcess.writeOwnership({ root: ROOT, dshEntry: DSH_ENTRY, childPid, parentPid: process.pid })
    }
    emitLog(`ownership childPid=${childPid} parentPid=${process.pid}`)

    child.stdout.on('data', observe)
    child.stderr.on('data', observe)
    child.once('error', (error) => {
      if (runtimeProcess) runtimeProcess.clearOwnership({ root: ROOT, childPid })
      try {
        logStream?.write(`\n[runtime] ${error.stack || error}\n`)
      } catch {}
      events.emit('error', error)
    })
    child.once('exit', (code, signal) => {
      if (runtimeProcess) runtimeProcess.clearOwnership({ root: ROOT, childPid })
      try {
        logStream?.write(`\n[runtime] Harness process exit code=${code} signal=${signal || ''}\n`)
      } catch {}
      const wasStopped = stopped
      child = null
      url = null
      if (!wasStopped) events.emit('exit', { code, signal, childPid })
      events.emit('state')
    })
    events.emit('state')
    return Promise.resolve(null)
  }

  /** Wait until the child has announced its authenticated URL and that URL answers. */
  async function waitUntilReady(timeoutMs = startupTimeoutMs) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (url && (await requestUrl(url))) return url
      if (!child) throw new Error('the Harness child is not running')
      if (child.exitCode !== null) throw new Error(`Harness service exited early with code ${child.exitCode}`)
      if (stopped) throw new Error('the Harness was stopped before it became ready')
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
    throw new Error(`Harness service did not become ready within ${Math.round(timeoutMs / 1000)} seconds`)
  }

  function stop() {
    stopped = true
    const pid = childPid
    if (child && child.exitCode === null) {
      emitLog(`stopping Harness child pid=${pid}`)
      if (process.platform === 'win32') {
        spawnSync('taskkill.exe', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 10_000 })
      } else {
        try {
          child.kill('SIGTERM')
        } catch {}
      }
    }
    if (pid && runtimeProcess) runtimeProcess.clearOwnership({ root: ROOT, childPid: pid })
    child = null
    url = null
    events.emit('state')
    return { stopped: true, childPid: pid || null }
  }

  function describe() {
    return {
      running: Boolean(child && child.exitCode === null),
      childPid: child ? child.pid : null,
      lastChildPid: childPid || null,
      port: HARNESS_PORT,
      entry: DSH_ENTRY,
      root: ROOT,
      dshHome: HOME,
      startedAt,
      ready: Boolean(url),
      /** The URL is redacted: it carries the launch token. */
      urlRedacted: url ? redact(url) : null,
      launchLine: `${path.basename(process.execPath)} ${path.relative(ROOT, DSH_ENTRY)} ${launchArgs.join(' ')}`
    }
  }

  return {
    start,
    stop,
    describe,
    waitUntilReady,
    outputTail,
    logPath,
    events,
    /** The authenticated URL, for the client that needs to point a window at it. Never logged raw. */
    get url() {
      return url
    },
    get pid() {
      return child ? child.pid : null
    },
    port: HARNESS_PORT,
    isPortListening: (timeoutMs) => isPortListening(HARNESS_PORT, host, timeoutMs)
  }
}

module.exports = {
  createHarnessService,
  resolveNodeExe,
  ensureRuntimeDirs,
  isPortListening,
  requestUrl,
  stripAnsi,
  redact,
  STARTUP_BUFFER_LIMIT
}
