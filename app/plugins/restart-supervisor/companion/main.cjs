'use strict'

/**
 * DS-Hns: the restart supervisor's out-of-process companion — the program the installer registers.
 *
 * It is started by the shell (or by the installer's startup registration) and it owns exactly one
 * child: the application. Its whole job is the sentence the requirement is built around — *if the main
 * process is gone or hung, the main process cannot recover itself* — so the recovery lives here.
 *
 * ## Usage
 *
 * ```
 *   node app/plugins/restart-supervisor/companion/main.cjs --state-dir <dir> --app <cmd> [args...]
 *   node app/plugins/restart-supervisor/companion/main.cjs --state-dir <dir> --once       (one watch pass)
 *   node app/plugins/restart-supervisor/companion/main.cjs --state-dir <dir> --describe    (report and exit)
 *   node app/plugins/restart-supervisor/companion/main.cjs --stop                          (ask a running one to stand down)
 *   node app/plugins/restart-supervisor/companion/main.cjs --reset-budget                  (the human escape hatch)
 * ```
 *
 * It refuses to run a second copy for the same state directory (the pid file is the lock), it removes
 * its pid file on the way out, and it never leaves a startup entry behind: registration and
 * unregistration belong to `scripts/install.ps1`, which is the only thing that writes one.
 *
 * ## What it does not do
 *
 * It does not resume tasks, it does not read the task queue, and it does not know what the
 * application is for. It starts a process, watches a heartbeat file, and restarts within a budget.
 */

const fs = require('node:fs')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')

const { createRestartCompanion, companionPaths, readJson, writeJson } = require('../companion.cjs')
const { SHUTDOWN_KINDS } = require('../policy.cjs')

function parseArgs(argv) {
  const args = { stateDir: '', app: [], attach: 0, once: false, describe: false, stop: false, resetBudget: false, iterations: 0, intervalMs: 0, json: false, config: '' }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index])
    if (arg === '--state-dir') args.stateDir = String(argv[index + 1] || ''), (index += 1)
    else if (arg.startsWith('--state-dir=')) args.stateDir = arg.slice('--state-dir='.length)
    else if (arg === '--app') {
      // Everything after `--app` is the application command, verbatim.
      args.app = argv.slice(index + 1).map(String)
      break
    } else if (arg === '--attach') args.attach = Number(argv[index + 1] || 0), (index += 1)
    else if (arg.startsWith('--attach=')) args.attach = Number(arg.slice('--attach='.length))
    else if (arg === '--once') args.once = true
    else if (arg === '--describe') args.describe = true
    else if (arg === '--stop') args.stop = true
    else if (arg === '--reset-budget') args.resetBudget = true
    else if (arg === '--json') args.json = true
    else if (arg === '--iterations') args.iterations = Number(argv[index + 1] || 0), (index += 1)
    else if (arg.startsWith('--iterations=')) args.iterations = Number(arg.slice('--iterations='.length))
    else if (arg === '--interval-ms') args.intervalMs = Number(argv[index + 1] || 0), (index += 1)
    else if (arg.startsWith('--interval-ms=')) args.intervalMs = Number(arg.slice('--interval-ms='.length))
    else if (arg === '--config') args.config = String(argv[index + 1] || ''), (index += 1)
    else if (arg.startsWith('--config=')) args.config = arg.slice('--config='.length)
  }
  return args
}

/** The supervisor configuration file, when the plugin has written one. */
function loadConfig(file) {
  const parsed = readJson(file)
  return parsed && typeof parsed === 'object' ? parsed : {}
}

/**
 * Start the application as a child the companion owns.
 *
 * The child is started *detached from this process's stdio* rather than piped: the application writes
 * its own logs, and a supervisor that swallowed them would be a second logging system. `DSHNS_SUPERVISED`
 * is how the application knows it is being watched, and the heartbeat file path is passed to it so both
 * sides agree on where the beat goes without either guessing.
 */
function createSpawner({ args, paths, log }) {
  return ({ reasonCode }) => {
    const command = args.app[0]
    if (!command) return { ok: false, reason: 'no application command was given (--app <cmd> [args...])' }
    const child = spawn(command, args.app.slice(1), {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DSHNS_SUPERVISED: '1',
        DSHNS_SUPERVISOR_HEARTBEAT: paths.heartbeatFile,
        DSHNS_SUPERVISOR_STATE_DIR: paths.dir,
        DSHNS_RESTART_REASON: String(reasonCode || 'UNKNOWN')
      },
      stdio: 'inherit',
      windowsHide: false
    })
    log(`launched ${command} as pid ${child.pid} (${reasonCode})`)
    return { ok: true, child }
  }
}

/**
 * Stop the child.
 *
 * Windows has no SIGTERM, and Node's `child.kill()` on Windows terminates immediately whether the
 * child wanted to or not — so the graceful path is a *request* (`child.kill()` with no signal is
 * still a terminate) preceded by whatever the application itself offers. The companion's graceful
 * stop is therefore: ask the application to leave by touching a stop file it watches, wait for the
 * timeout, and terminate the tree only if it is still there. That is the honest Windows shape, and
 * pretending otherwise would be a graceful path that is not one.
 */
function createKiller({ paths, log }) {
  return async (child, kind, timeoutMs) => {
    if (!child || !child.pid) return { ok: true, detail: 'the child was already gone' }
    const graceful = kind === SHUTDOWN_KINDS.GRACEFUL
    const waitMs = Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : graceful ? 45_000 : 15_000
    if (graceful) {
      // The application watches this file; the companion only writes it.
      writeJson(path.join(paths.dir, 'app.stop-request.json'), { at: Date.now(), kind, reason: 'the restart supervisor is restarting the application' })
    }
    const exited = await waitForExit(child, graceful ? waitMs : 0)
    if (exited) return { ok: true, detail: `pid ${child.pid} left on its own`, graceful: true }
    const code = await terminateTree(child.pid, log)
    if (code.ok) return { ok: true, forced: true, detail: `pid ${child.pid} was terminated after ${waitMs}ms`, graceful: false }
    return { ok: false, reason: code.reason }
  }
}

/** Resolve when the child exits, or `false` after the budget. */
function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => done(false), Math.max(0, timeoutMs))
    child.once('exit', () => done(true))
  })
}

/** Is a pid still there? `process.kill(pid, 0)` is the only question Windows and POSIX agree on. */
function pidAlive(pid) {
  const target = Number(pid)
  if (!Number.isFinite(target) || target <= 0) return false
  try {
    process.kill(target, 0)
    return true
  } catch {
    return false
  }
}

/** Resolve when the pid is gone, or `false` after the budget. */
async function waitForPid(pid, timeoutMs) {
  const deadline = Date.now() + Math.max(0, timeoutMs)
  while (Date.now() <= deadline) {
    if (!pidAlive(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return !pidAlive(pid)
}

/** `taskkill /T /F` on Windows, `SIGKILL` elsewhere. A tree, because the app spawns workers. */
function terminateTree(pid, log) {
  try {
    if (process.platform === 'win32') {
      const taskkill = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'taskkill.exe')
      const result = spawnSync(taskkill, ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true })
      if (result.status === 0) return { ok: true }
      const detail = String(result.stderr || result.stdout || '').trim()
      // "not found" means the process left between the check and the kill, which is a success.
      if (/not found|no running instance/i.test(detail)) return { ok: true, detail: 'the process had already left' }
      return { ok: false, reason: `taskkill exited ${result.status}: ${detail}` }
    }
    process.kill(pid, 'SIGKILL')
    return { ok: true }
  } catch (error) {
    const reason = String(error && error.message ? error.message : error)
    if (/no such process|ESRCH/i.test(reason)) return { ok: true, detail: 'the process had already left' }
    log(`could not terminate pid ${pid}: ${reason}`)
    return { ok: false, reason }
  }
}

async function main(argv) {
  const args = parseArgs(argv)
  const paths = companionPaths(args.stateDir)
  fs.mkdirSync(paths.dir, { recursive: true })
  // Two one-shot commands a person or an installer runs, neither of which starts anything.
  if (args.stop) {
    writeJson(paths.stopFile, { at: Date.now(), by: 'manual', reason: 'the companion was asked to stand down' })
    process.stdout.write(`the restart supervisor was asked to stand down (${paths.stopFile})\n`)
    return 0
  }
  if (args.resetBudget) {
    // The escape hatch from safe mode: clear the budget *and* the stop file, so the next start is
    // allowed to restart again. The history is kept; see `budget.reset`.
    const budgetFile = path.join(paths.dir, 'budget.json')
    const previous = readJson(budgetFile)
    writeJson(budgetFile, { ...(previous || {}), resetAt: Date.now(), resetBy: 'manual' })
    try {
      fs.rmSync(paths.stopFile, { force: true })
    } catch {
      // Nothing to remove is the normal case.
    }
    process.stdout.write('the restart budget was reset; the next start may restart again\n')
    return 0
  }

  const log = (message) => process.stderr.write(`[restart-supervisor] ${message}\n`)
  const companion = createRestartCompanion({
    stateDir: paths.dir,
    config: loadConfig(args.config || paths.configFile),
    spawn: createSpawner({ args, paths, log }),
    kill: createKiller({ paths, log }),
    /**
     * Stopping and watching a process this companion did not start.
     *
     * `--attach <pid>` is how the *running* product hands its own supervision to a companion: the shell
     * is already up, so the companion adopts its pid instead of launching a second copy. It then needs
     * the two things a `ChildProcess` handle would have given it for free — a liveness check and a
     * bounded stop — and both are asked of the OS by pid.
     */
    killByPid: async (pid, kind, timeoutMs) => {
      const graceful = kind === SHUTDOWN_KINDS.GRACEFUL
      const waitMs = Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : graceful ? 45_000 : 15_000
      if (graceful) {
        // The application watches this file; the companion only writes it.
        writeJson(path.join(paths.dir, 'app.stop-request.json'), { at: Date.now(), kind, reason: 'the restart supervisor is restarting the application' })
      }
      const exited = graceful ? await waitForPid(pid, waitMs) : !pidAlive(pid)
      if (exited) return { ok: true, detail: `pid ${pid} left on its own`, graceful: true }
      const code = await terminateTree(pid, log)
      if (code.ok) return { ok: true, forced: true, detail: `pid ${pid} was terminated after ${waitMs}ms`, graceful: false }
      return { ok: false, reason: code.reason }
    },
    pidAlive,
    alive: (child) => Boolean(child) && child.exitCode === null && child.signalCode === null,
    log
  })

  if (args.describe) {
    const described = companion.describe()
    process.stdout.write(args.json ? `${JSON.stringify(described)}\n` : `${JSON.stringify(described, null, 2)}\n`)
    return 0
  }

  const claimed = companion.claim()
  if (claimed.ok !== true) {
    process.stderr.write(`[restart-supervisor] ${claimed.reason}\n`)
    return 1
  }

  /**
   * Either adopt the running application, or start one.
   *
   * A launcher companion starts the application before the watch loop so a fresh install comes up
   * immediately. An attaching companion has nothing to start — the caller *is* the application — so a
   * refused attach is the one fatal case: a companion that adopted nothing would watch `null`.
   */
  if (Number.isFinite(args.attach) && args.attach > 0) {
    const adopted = companion.attach(args.attach)
    if (adopted.ok !== true) {
      process.stderr.write(`[restart-supervisor] could not attach to pid ${args.attach}: ${adopted.reason}\n`)
      companion.release()
      return 1
    }
  } else {
    const first = companion.launchChild('SUPERVISOR_START')
    if (first.ok !== true) {
      process.stderr.write(`[restart-supervisor] could not start the application: ${first.reason}\n`)
      companion.release()
      return 1
    }
  }

  const watch = await companion.watch({
    iterations: args.once ? 1 : (Number.isFinite(args.iterations) && args.iterations > 0 ? args.iterations : Infinity),
    intervalMs: Number.isFinite(args.intervalMs) && args.intervalMs > 0 ? args.intervalMs : 0
  })
  companion.release()
  process.stdout.write(args.json ? `${JSON.stringify(watch)}\n` : `restart supervisor finished after ${watch.iterations} iteration(s); state ${watch.state}\n`)
  return 0
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code })
    .catch((error) => {
      process.stderr.write(`[restart-supervisor] companion failed: ${error && error.stack ? error.stack : error}\n`)
      process.exitCode = 1
    })
}

module.exports = { parseArgs, main, loadConfig, createSpawner, createKiller }
