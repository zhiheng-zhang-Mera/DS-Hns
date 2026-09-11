'use strict'
/**
 * Detached harness update runner.
 *
 * Started (and immediately released) by `harness-updater.js` right before the
 * Electron shell quits. Running the install in its own process is what makes a
 * self-update reliable on Windows: `node_modules` can not be replaced while the
 * old harness still holds its files open, so the shell exits first and this
 * runner takes over.
 *
 * Order of operations, each step recorded in data\state\mega-update.json so the
 * dock can report the outcome after the restart:
 *
 *   stopping   -> wait until the requesting DS-Harness process is really gone
 *   installing -> pin app\package.json and run npm install
 *   verifying  -> the installed package version and CLI entry must match
 *   relaunching-> start DS-Harness again (always, even after a failure)
 *
 * A failed install is rolled back to the previous manifests and repaired with a
 * best-effort npm install, so a broken update can not leave a dead installation.
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')

const PACKAGE_NAME = '@deepseek-ai/dsh'
const PARENT_EXIT_TIMEOUT_MS = 90_000
const INSTALL_TIMEOUT_MS = 20 * 60_000
const LOG_TAIL_LIMIT = 4000

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const value = argv[i + 1] !== undefined && !String(argv[i + 1]).startsWith('--') ? argv[++i] : 'true'
    args[key] = value
  }
  return args
}

function createRuntime({ root, appDir, nodeExe, npmCli, target, tag, parentPid }) {
  const stateDir = path.join(root, 'data', 'state')
  const markerPath = path.join(stateDir, 'mega-update.json')
  const logPath = path.join(root, 'logs', 'mega-update.log')
  const logDir = path.dirname(logPath)

  const log = (message) => {
    const line = `${new Date().toISOString()} ${message}\n`
    try {
      fs.mkdirSync(logDir, { recursive: true })
      fs.appendFileSync(logPath, line, 'utf8')
    } catch {
      // Logging must never be the reason an update fails.
    }
  }

  const readMarker = () => {
    try {
      return JSON.parse(fs.readFileSync(markerPath, 'utf8'))
    } catch {
      return {}
    }
  }

  const writeMarker = (patch) => {
    try {
      fs.mkdirSync(stateDir, { recursive: true })
      const next = { ...readMarker(), ...patch }
      fs.writeFileSync(markerPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
      return next
    } catch (error) {
      log(`marker write failed: ${error?.message || error}`)
      return null
    }
  }

  const setPhase = (phase, patch = {}) => {
    log(`phase=${phase}${patch.error ? ` error=${patch.error.message}` : ''}`)
    return writeMarker({ status: 'updating', phase, ...patch })
  }

  return { root, appDir, nodeExe, npmCli, target, tag, parentPid, log, readMarker, writeMarker, setPhase, logPath }
}

function installEnv(rt) {
  return {
    ...process.env,
    DSH_ROOT: rt.root,
    DSH_HOME: path.join(rt.root, 'data'),
    npm_config_cache: path.join(rt.root, 'cache', 'npm'),
    TEMP: path.join(rt.root, 'cache', 'temp'),
    TMP: path.join(rt.root, 'cache', 'temp'),
    PATH: `${path.dirname(rt.nodeExe)};${process.env.PATH || ''}`
  }
}

function processAlive(pid) {
  if (!pid || !Number.isFinite(pid)) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but is owned by someone else.
    return error?.code === 'EPERM'
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** The shell quits itself; this is the safety net if it does not. */
async function waitForParentExit(rt) {
  const deadline = Date.now() + PARENT_EXIT_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (!processAlive(rt.parentPid)) return true
    await sleep(400)
  }
  rt.log(`parent pid ${rt.parentPid} still alive after ${PARENT_EXIT_TIMEOUT_MS} ms; forcing exit`)
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill.exe', ['/pid', String(rt.parentPid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } else {
      process.kill(rt.parentPid, 'SIGKILL')
    }
  } catch (error) {
    rt.log(`forced parent exit failed: ${error?.message || error}`)
  }
  for (let i = 0; i < 30; i += 1) {
    if (!processAlive(rt.parentPid)) return true
    await sleep(200)
  }
  return !processAlive(rt.parentPid)
}

function readPackageVersion(packageDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')).version || null
  } catch {
    return null
  }
}

function backupManifests(rt) {
  const backups = []
  for (const name of ['package.json', 'package-lock.json']) {
    const file = path.join(rt.appDir, name)
    try {
      backups.push({ file, text: fs.readFileSync(file, 'utf8') })
    } catch {
      // A missing lockfile is not an error: npm will create it.
    }
  }
  return backups
}

function restoreManifests(rt, backups) {
  for (const backup of backups) {
    try {
      fs.writeFileSync(backup.file, backup.text, 'utf8')
    } catch (error) {
      rt.log(`manifest restore failed for ${backup.file}: ${error?.message || error}`)
    }
  }
}

/**
 * The pin is what keeps the installer honest: `scripts\install-deps.ps1` runs
 * `npm ci` whenever the installed version differs from `app\package.json`, so
 * an update that skipped the pin would be silently reverted on the next start.
 */
function pinManifestVersion(rt) {
  const file = path.join(rt.appDir, 'package.json')
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
  manifest.dependencies = manifest.dependencies || {}
  manifest.dependencies[PACKAGE_NAME] = rt.target
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

function runNpmInstall(rt) {
  const npmCli = rt.npmCli || path.join(path.dirname(rt.nodeExe), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  const result = spawnSync(rt.nodeExe, [
    npmCli,
    'install',
    '--no-audit',
    '--no-fund',
    '--save-exact',
    `${PACKAGE_NAME}@${rt.target}`
  ], {
    cwd: rt.appDir,
    env: installEnv(rt),
    encoding: 'utf8',
    windowsHide: true,
    timeout: INSTALL_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024
  })
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim()
  if (output) {
    rt.log(`npm install output (tail):\n${output.slice(-LOG_TAIL_LIMIT)}`)
  }
  return {
    ok: result.status === 0,
    status: result.status,
    output: output.slice(-LOG_TAIL_LIMIT),
    error: result.error ? String(result.error.message || result.error) : null
  }
}

function verifyInstall(rt) {
  const packageDir = path.join(rt.appDir, 'node_modules', '@deepseek-ai', 'dsh')
  const installed = readPackageVersion(packageDir)
  if (installed !== rt.target) {
    return { ok: false, message: `installed version ${installed || 'missing'} does not match requested ${rt.target}` }
  }
  const bin = path.join(packageDir, 'lib', 'bin.js')
  if (!fs.existsSync(bin)) {
    return { ok: false, message: `harness CLI entry missing after install: ${bin}` }
  }
  return { ok: true, message: `installed ${PACKAGE_NAME}@${installed}` }
}

/** Always bring the product back, whatever the install outcome was. */
function relaunch(rt) {
  const electronExe = path.join(rt.appDir, 'node_modules', 'electron', 'dist', 'electron.exe')
  const entry = path.join(rt.appDir, 'desktop-main.cjs')
  const env = installEnv(rt)
  // A detached spawn reports failures asynchronously, so both spawn results are
  // wired to the log before anything can throw.
  const detach = (command, args, options) => {
    const child = spawn(command, args, options)
    child.on('error', (error) => rt.log(`relaunch spawn error: ${error?.message || error}`))
    child.unref()
    return child
  }
  try {
    if (!fs.existsSync(electronExe) || !fs.existsSync(entry)) {
      rt.log(`relaunch fallback: electron=${electronExe} entry=${entry}`)
      const launcher = path.join(rt.root, 'Start-DeepSeek-Harness.cmd')
      const child = detach(process.env.ComSpec || 'cmd.exe', ['/c', launcher], {
        cwd: rt.root,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env
      })
      return child.pid || null
    }
    const child = detach(electronExe, [entry], {
      cwd: rt.appDir,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env
    })
    rt.log(`DS-Harness relaunched (pid ${child.pid})`)
    return child.pid || null
  } catch (error) {
    rt.log(`relaunch failed: ${error?.message || error}`)
    return null
  }
}

async function main(argv) {
  const args = parseArgs(argv)
  const rt = createRuntime({
    root: path.resolve(args.root || process.cwd()),
    appDir: path.resolve(args.app || path.join(args.root || process.cwd(), 'app')),
    nodeExe: args.node || process.execPath,
    npmCli: args['npm-cli'] || '',
    target: args.target || '',
    tag: args.tag || 'latest',
    parentPid: Number(args['parent-pid']) || 0
  })

  if (!rt.target) {
    rt.log('no --target version supplied; aborting')
    rt.writeMarker({ status: 'failed', phase: 'aborted', error: { code: 'NO_TARGET', message: 'no target version supplied' }, finishedAt: Date.now() })
    return 1
  }

  rt.log(`update runner start: ${rt.readMarker().from || 'unknown'} -> ${rt.target} (tag ${rt.tag})`)
  rt.setPhase('stopping', { from: rt.readMarker().from || null, to: rt.target, tag: rt.tag, pid: rt.parentPid })

  if (!(await waitForParentExit(rt))) {
    const message = `DS-Harness (pid ${rt.parentPid}) is still running; refusing to replace node_modules`
    rt.setPhase('failed', { status: 'failed', error: { code: 'SHELL_RUNNING', message }, finishedAt: Date.now() })
    return 1
  }
  // Give the killed Harness child a moment to release its own files.
  await sleep(1500)

  const backups = backupManifests(rt)
  rt.setPhase('installing')
  let outcome = { ok: false, message: '' }
  try {
    pinManifestVersion(rt)
    const install = runNpmInstall(rt)
    if (!install.ok) {
      outcome = { ok: false, message: install.error || `npm install exited with code ${install.status}` }
    } else {
      rt.setPhase('verifying')
      outcome = verifyInstall(rt)
    }
  } catch (error) {
    outcome = { ok: false, message: String(error?.message || error) }
  }

  if (!outcome.ok) {
    rt.log(`update failed: ${outcome.message}; rolling back manifests`)
    restoreManifests(rt, backups)
    try {
      runNpmInstall(rt)
    } catch (error) {
      rt.log(`rollback install failed: ${error?.message || error}`)
    }
    rt.writeMarker({
      status: 'failed',
      phase: 'failed',
      from: rt.readMarker().from || null,
      to: rt.target,
      tag: rt.tag,
      pid: rt.parentPid,
      error: { code: 'INSTALL_FAILED', message: outcome.message },
      finishedAt: Date.now()
    })
  } else {
    rt.log(`update succeeded: ${outcome.message}`)
    rt.writeMarker({
      status: 'succeeded',
      phase: 'done',
      from: rt.readMarker().from || null,
      to: rt.target,
      tag: rt.tag,
      pid: rt.parentPid,
      error: null,
      finishedAt: Date.now()
    })
  }

  // Relaunch last and without changing the recorded phase: the outcome marker
  // above is the report the next boot shows, and it must keep saying what the
  // install actually did.
  rt.log('relaunching DS-Harness')
  const relaunchedPid = relaunch(rt)
  rt.writeMarker({ relaunchedPid, relaunchedAt: Date.now() })
  return outcome.ok ? 0 : 1
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      try {
        const args = parseArgs(process.argv.slice(2))
        const root = path.resolve(args.root || process.cwd())
        fs.mkdirSync(path.join(root, 'data', 'state'), { recursive: true })
        fs.writeFileSync(path.join(root, 'data', 'state', 'mega-update.json'), `${JSON.stringify({
          status: 'failed',
          phase: 'failed',
          to: args.target || null,
          pid: Number(args['parent-pid']) || 0,
          error: { code: 'RUNNER_CRASHED', message: String(error?.stack || error).slice(0, 1000) },
          finishedAt: Date.now()
        }, null, 2)}\n`, 'utf8')
      } catch {}
      process.exit(1)
    })
}

module.exports = { main, parseArgs, processAlive, waitForParentExit, verifyInstall, pinManifestVersion }
