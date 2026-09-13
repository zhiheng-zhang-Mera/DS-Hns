'use strict'

/**
 * The compatibility layer's loading half.
 *
 * It turns a staged compat descriptor into something the plugin manager can treat as an ordinary
 * plugin: a real `dshns.plugin/v1` manifest plus the lifecycle hooks, where `load` activates the
 * plugin *in a separate process* and `healthCheck` reports whether that process is still alive.
 *
 * Three properties this module is responsible for, and they are the whole point of doing it this
 * way rather than `require`-ing somebody else's package in the shell:
 *
 *   1. **Containment.** Import-time exceptions, `process.exit`, an infinite loop at activation and
 *      a plugin that crashes ten minutes later all stay in the child. The worst outcome here is a
 *      plugin listed as faulty with a reason.
 *   2. **Honesty.** An activation failure keeps its *code*: missing dependencies list the packages,
 *      a missing entry names the build script, an unsupported exports shape lists what the module
 *      did export. None of those are turned into "the plugin failed to load".
 *   3. **No silent work.** Activating never installs and never builds. Those are separate,
 *      described, user-confirmed actions (`deps.cjs`), because they run third-party code on the
 *      user's machine.
 */

const path = require('node:path')
const { spawn: defaultSpawn } = require('node:child_process')

const { validateManifest } = require('../contracts/plugin.cjs')

/** The marker the worker prefixes its one report line with. */
const COMPAT_REPORT_PREFIX = '@@DSHNS-COMPAT@@'

const COMPAT_LOAD_REASONS = Object.freeze({
  NO_ENTRY: 'COMPAT_NO_ENTRY',
  ENTRY_MISSING: 'COMPAT_ENTRY_MISSING',
  SPAWN_FAILED: 'COMPAT_SPAWN_FAILED',
  ACTIVATION_TIMEOUT: 'COMPAT_ACTIVATION_TIMEOUT',
  EXITED: 'COMPAT_EXITED',
  BAD_DESCRIPTOR: 'COMPAT_BAD_DESCRIPTOR',
  /** Passed through from the worker, because they are the actionable ones. */
  MISSING_DEPENDENCIES: 'COMPAT_MISSING_DEPENDENCIES',
  IMPORT_FAILED: 'COMPAT_IMPORT_FAILED',
  UNSUPPORTED_API: 'COMPAT_UNSUPPORTED_API',
  ACTIVATION_FAILED: 'COMPAT_ACTIVATION_FAILED'
})

const DEFAULT_ACTIVATION_TIMEOUT_MS = 20_000

/**
 * Build the plugin object for one staged compat descriptor.
 *
 * @param {object} input
 * @param {object} input.descriptor the descriptor the installer wrote (`dshns-plugin.compat.json`)
 * @param {string} input.dir the plugin's root, already verified to contain the descriptor
 * @param {string} [input.nodeExe] the node binary to run the isolated process with
 * @param {Function} [input.log]
 * @param {Function} [input.spawn] injectable, for tests
 * @param {number} [input.timeoutMs]
 */
function createCompatPlugin(input = {}) {
  const descriptor = input.descriptor && typeof input.descriptor === 'object' ? input.descriptor : {}
  const dir = path.resolve(String(input.dir || '.'))
  const log = typeof input.log === 'function' ? input.log : () => {}
  const spawn = typeof input.spawn === 'function' ? input.spawn : defaultSpawn
  const nodeExe = String(input.nodeExe || process.execPath)
  const timeoutMs = Number.isFinite(input.timeoutMs) ? input.timeoutMs : DEFAULT_ACTIVATION_TIMEOUT_MS

  const validated = validateManifest(descriptor.manifest)
  const manifest = validated.ok ? validated.manifest : null

  /** What the panel shows about this plugin beyond "enabled": never a bare boolean. */
  const state = {
    status: descriptor.state || 'staged',
    reason: descriptor.state_reason || null,
    kind: descriptor.kind || 'package',
    api: descriptor.api || 'unknown',
    format: descriptor.format || 'unknown',
    entry: descriptor.entry || null,
    entryExists: descriptor.entry_exists === true,
    build: descriptor.build || null,
    buildCommand: descriptor.build_command || null,
    dependencies: Array.isArray(descriptor.dependencies) ? descriptor.dependencies.slice() : [],
    missing: [],
    pid: null,
    activatedAt: null,
    exit: null,
    source: descriptor.source || null,
    guarantees: descriptor.guarantees || null
  }

  /** The isolated process, while it lives. */
  let child = null
  let stopped = false

  function failure(code, reason, extra = {}) {
    state.status = code === COMPAT_LOAD_REASONS.MISSING_DEPENDENCIES
      ? 'needs-dependencies'
      : code === COMPAT_LOAD_REASONS.ENTRY_MISSING
        ? 'needs-build'
        : 'failed'
    state.reason = reason
    if (Array.isArray(extra.missing)) state.missing = extra.missing.slice()
    return { ok: false, code, reason, ...extra }
  }

  /**
   * Start the isolated process and wait for its one report line.
   *
   * The wait is bounded: a plugin that hangs during activation is killed and reported, because a
   * plugin load that never returns would otherwise hold the shell's rebuild open forever.
   */
  function activate(config) {
    if (!manifest) return Promise.resolve(failure(COMPAT_LOAD_REASONS.BAD_DESCRIPTOR, 'the compat descriptor does not carry a valid manifest'))
    if (!descriptor.entry) return Promise.resolve(failure(COMPAT_LOAD_REASONS.NO_ENTRY, 'the package declares no entry point'))
    if (descriptor.entry_exists !== true) {
      return Promise.resolve(failure(COMPAT_LOAD_REASONS.ENTRY_MISSING, descriptor.state_reason || `the declared entry ${descriptor.entry} is not in the plugin directory`, { build: descriptor.build || null }))
    }

    const payload = Buffer.from(JSON.stringify({
      id: manifest.id,
      name: manifest.name,
      dir,
      entry: descriptor.entry,
      api: descriptor.api || 'unknown',
      config: config && typeof config === 'object' ? config : {}
    }), 'utf8').toString('base64')

    return new Promise((resolve) => {
      let settled = false
      let stdout = ''
      let stderr = ''
      let timer = null

      const finish = (outcome) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        resolve(outcome)
      }

      try {
        child = spawn(nodeExe, [path.join(__dirname, 'worker.cjs'), payload], {
          cwd: dir,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          // The worker is a plain node program even when `nodeExe` is the Electron binary: a
          // packaged application has no other node on the machine.
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
        })
      } catch (error) {
        child = null
        finish(failure(COMPAT_LOAD_REASONS.SPAWN_FAILED, `the isolated process could not be started: ${(error && error.message) || error}`))
        return
      }

      state.pid = child.pid || null
      timer = setTimeout(() => {
        try {
          child.kill()
        } catch {}
        finish(failure(COMPAT_LOAD_REASONS.ACTIVATION_TIMEOUT, `activation did not report within ${timeoutMs}ms, so the isolated process was stopped`))
      }, timeoutMs)

      child.on('error', (error) => {
        finish(failure(COMPAT_LOAD_REASONS.SPAWN_FAILED, `the isolated process failed: ${(error && error.message) || error}`))
      })
      if (child.stdout) {
        child.stdout.setEncoding('utf8')
        child.stdout.on('data', (chunk) => {
          stdout += chunk
          let index = stdout.indexOf('\n')
          while (index !== -1) {
            const line = stdout.slice(0, index)
            stdout = stdout.slice(index + 1)
            if (line.startsWith(COMPAT_REPORT_PREFIX)) {
              let report = null
              try {
                report = JSON.parse(line.slice(COMPAT_REPORT_PREFIX.length))
              } catch {
                report = null
              }
              if (!report) {
                finish(failure(COMPAT_LOAD_REASONS.EXITED, 'the isolated process reported something that was not a report'))
              } else if (report.ok === true) {
                state.status = 'running'
                state.reason = null
                state.missing = []
                state.activatedAt = Date.now()
                log(`compat plugin ${manifest.id} activated in an isolated process (pid ${state.pid}, api ${report.api})`)
                for (const line$ of Array.isArray(report.logs) ? report.logs : []) log(`compat ${manifest.id}: ${line$}`)
                finish({ ok: true, api: report.api, provided: report.provided || [], logs: report.logs || [], ms: report.ms || null })
              } else {
                finish(failure(report.code || COMPAT_LOAD_REASONS.ACTIVATION_FAILED, String(report.reason || 'activation failed'), {
                  missing: report.missing || [],
                  exports: report.exports || null,
                  stack: report.stack || null
                }))
              }
            } else if (line.trim()) {
              log(`compat ${manifest.id}: ${line.slice(0, 400)}`)
            }
            index = stdout.indexOf('\n')
          }
        })
      }
      if (child.stderr) {
        child.stderr.setEncoding('utf8')
        child.stderr.on('data', (chunk) => {
          stderr = `${stderr}${chunk}`.slice(-4000)
        })
      }
      child.on('exit', (code, signal) => {
        state.exit = { code, signal, at: Date.now() }
        child = null
        if (!settled) {
          finish(failure(
            COMPAT_LOAD_REASONS.EXITED,
            `the isolated process exited before reporting (code ${code}${signal ? `, signal ${signal}` : ''})${stderr.trim() ? `: ${stderr.trim().split('\n').slice(-3).join(' ')}` : ''}`
          ))
          return
        }
        // It had reported: a clean exit means the plugin registered nothing that keeps a process
        // alive, which is a legitimate outcome and not a fault.
        if (!stopped) {
          state.status = code === 0 ? 'exited' : 'failed'
          state.reason = code === 0
            ? 'activated and exited cleanly: the plugin left nothing running'
            : `the isolated process exited with code ${code}${signal ? ` (signal ${signal})` : ''}`
          log(`compat plugin ${manifest.id}: ${state.reason}`)
        }
      })
    })
  }

  /**
   * Stop the isolated process, and wait for it to actually be gone.
   *
   * Waiting matters on Windows for a reason that is easy to miss: the child's working directory is
   * the plugin's own directory, and a process that still exists — even one that has been signalled
   * — keeps that directory locked. An `unload` that returned before the exit would make the next
   * removal or reinstall of the plugin fail with a permission error that has nothing to do with
   * permissions.
   */
  function stop() {
    stopped = true
    const running = child
    child = null
    state.pid = null
    if (!running) return Promise.resolve(false)
    return new Promise((resolve) => {
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        resolve(true)
      }
      running.once('exit', done)
      try {
        running.kill()
      } catch {
        done()
      }
      // A process that will not die must not hold the unload open forever.
      const timer = setTimeout(done, 3000)
      if (typeof timer.unref === 'function') timer.unref()
    })
  }

  return {
    manifest,
    /** Where the plugin lives: the setup commands run here, and the panel shows it. */
    directory: dir,
    /** The flag the host and the panel key off: this plugin was adopted, not declared. */
    compatibility: 'compat',
    compatibilityInfo: state,
    install() {
      return { ok: true }
    },
    async load(context = {}) {
      const outcome = await activate(context.config || {})
      if (outcome.ok !== true) {
        const error = new Error(outcome.reason)
        error.code = outcome.code
        throw error
      }
      return outcome
    },
    async unload() {
      await stop()
      return true
    },
    async healthCheck() {
      if (child && child.exitCode === null && !child.killed) {
        return { status: 'healthy', reason: `the isolated process ${state.pid} is alive` }
      }
      if (state.status === 'exited') return { status: 'degraded', reason: state.reason }
      return { status: 'unhealthy', reason: state.reason || 'the isolated process is not running' }
    },
    /** The live state, for the manager's list and the panel's detail view. */
    compatibilityState() {
      return { ...state, running: Boolean(child && child.exitCode === null && !child.killed) }
    },
    /** For tests and teardown: the process this plugin owns, if any. */
    get process() {
      return child
    }
  }
}

module.exports = { createCompatPlugin, COMPAT_REPORT_PREFIX, COMPAT_LOAD_REASONS, DEFAULT_ACTIVATION_TIMEOUT_MS }
