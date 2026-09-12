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
 *   installing -> pin app\package.json and run npm install --save-exact <target>
 *   verifying  -> installed version, CLI entry and CLI boot must match the target
 *   relaunching-> start DS-Harness again (always, even after a failure)
 *
 * Upgrade and rollback are two DIFFERENT operations with two different npm
 * invocations, and they stay that way:
 *
 *   installTargetVersion(rt)      npm install --save-exact @deepseek-ai/dsh@target
 *   restorePreviousInstallation() restore the manifests + npm ci (never the target)
 *
 * Reusing the upgrade command for the rollback was a real defect: restoring the
 * manifests and then running `npm install @deepseek-ai/dsh@<target>` again could
 * re-pin the manifest, re-install the version that had just failed verification,
 * and leave `node_modules` on the target while the marker claimed a clean
 * rollback. The rollback below never mentions the target version at all.
 *
 * The previous installation is identified by the package actually installed on
 * disk, never by the manifest pin alone (a pin can lag behind reality), and the
 * whole transaction is recorded so a failure is reported as what it is.
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')

const PACKAGE_NAME = '@deepseek-ai/dsh'
const PARENT_EXIT_TIMEOUT_MS = 90_000
const INSTALL_TIMEOUT_MS = 20 * 60_000
const SMOKE_TIMEOUT_MS = 60_000
const LOG_TAIL_LIMIT = 4000

/**
 * Terminal transaction outcomes. There is deliberately no single "failed":
 * "the update failed and the old version is back" and "the update failed AND the
 * rollback failed, the installation may now be broken" are different products
 * states, and the dock must be able to tell them apart.
 */
const UPDATE_OUTCOME = Object.freeze({
  SUCCEEDED: 'succeeded',
  FAILED_ROLLED_BACK: 'failed_rolled_back',
  FAILED_ROLLBACK_FAILED: 'failed_rollback_failed'
})

/** Why the rollback could not be completed, recorded on the marker. */
const ROLLBACK_ERROR = Object.freeze({
  RESTORE_INCOMPLETE: 'ROLLBACK_RESTORE_INCOMPLETE',
  VERSION_MISMATCH: 'ROLLBACK_VERSION_MISMATCH',
  IMPOSSIBLE: 'ROLLBACK_IMPOSSIBLE'
})

const TRANSACTION_VERSION = 1

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

/**
 * `--env KEY=VALUE` repeats. Extra environment for the npm child (registry,
 * proxy, cache overrides) — never applied to the relaunched product.
 */
function parseEnvPairs(values) {
  const list = Array.isArray(values) ? values : values ? [values] : []
  const env = {}
  for (const entry of list) {
    const text = String(entry || '')
    const index = text.indexOf('=')
    if (index <= 0) continue
    env[text.slice(0, index)] = text.slice(index + 1)
  }
  return env
}

function createRuntime({ root, appDir, nodeExe, npmCli, target, tag, parentPid, extraEnv = {} }) {
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

  return {
    root, appDir, nodeExe, npmCli, target, tag, parentPid, extraEnv,
    log, readMarker, writeMarker, setPhase, logPath
  }
}

function installEnv(rt) {
  return {
    ...process.env,
    ...(rt.extraEnv || {}),
    DSH_ROOT: rt.root,
    DSH_HOME: path.join(rt.root, 'data'),
    npm_config_cache: path.join(rt.root, 'cache', 'npm'),
    TEMP: path.join(rt.root, 'cache', 'temp'),
    TMP: path.join(rt.root, 'cache', 'temp'),
    // `path.delimiter` so the npm child can still resolve tools on POSIX; the
    // shipped platform is Windows, but the test suite and CI also run elsewhere.
    PATH: `${path.dirname(rt.nodeExe)}${path.delimiter}${process.env.PATH || ''}`
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

function packageDir(rt) {
  return path.join(rt.appDir, 'node_modules', '@deepseek-ai', 'dsh')
}

function readInstalledVersion(rt) {
  return readPackageVersion(packageDir(rt))
}

function readPinnedVersion(rt) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(rt.appDir, 'package.json'), 'utf8'))
    const pinned = manifest?.dependencies?.[PACKAGE_NAME]
    return typeof pinned === 'string' ? pinned : null
  } catch {
    return null
  }
}

function readManifestText(rt, name) {
  try {
    return fs.readFileSync(path.join(rt.appDir, name), 'utf8')
  } catch {
    return null
  }
}

/**
 * Capture the previous installation before anything is touched.
 *
 * `installedVersion` is read from the package on disk first, because the
 * manifest pin is a request and the installed package is the fact. The manifest
 * pin is kept as a fallback so a half-installed directory can still be rolled
 * back to what the repository asked for.
 */
function capturePreviousState(rt) {
  return {
    installedVersion: readInstalledVersion(rt),
    pinnedVersion: readPinnedVersion(rt),
    packageJson: readManifestText(rt, 'package.json'),
    packageLockJson: readManifestText(rt, 'package-lock.json'),
    capturedAt: Date.now()
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

/** Returns the names that could not be written back — empty means full restore. */
function restoreManifests(rt, backups) {
  const failed = []
  for (const backup of backups) {
    try {
      fs.writeFileSync(backup.file, backup.text, 'utf8')
    } catch (error) {
      failed.push(path.basename(backup.file))
      rt.log(`manifest restore failed for ${backup.file}: ${error?.message || error}`)
    }
  }
  return failed
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

function resolveNpmCli(rt) {
  return rt.npmCli || path.join(path.dirname(rt.nodeExe), 'node_modules', 'npm', 'bin', 'npm-cli.js')
}

/** One npm invocation, logged and never thrown. */
function runNpm(rt, args, { timeout = INSTALL_TIMEOUT_MS } = {}) {
  const result = spawnSync(rt.nodeExe, [resolveNpmCli(rt), ...args], {
    cwd: rt.appDir,
    env: installEnv(rt),
    encoding: 'utf8',
    windowsHide: true,
    timeout,
    maxBuffer: 32 * 1024 * 1024
  })
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim()
  if (output) {
    rt.log(`npm ${args[0]} output (tail):\n${output.slice(-LOG_TAIL_LIMIT)}`)
  }
  return {
    ok: result.status === 0,
    status: result.status,
    output: output.slice(-LOG_TAIL_LIMIT),
    error: result.error ? String(result.error.message || result.error) : null
  }
}

/**
 * Operation 1 — the upgrade. Only this function is allowed to mention the
 * target version, and only this function may pin the manifest.
 */
function installTargetVersion(rt) {
  pinManifestVersion(rt)
  const install = runNpm(rt, [
    'install',
    '--no-audit',
    '--no-fund',
    '--save-exact',
    `${PACKAGE_NAME}@${rt.target}`
  ])
  if (!install.ok) {
    return { ok: false, message: install.error || `npm install exited with code ${install.status}` }
  }
  return verifyInstall(rt)
}

/**
 * Operation 2 — the rollback. It restores the previous installation from the
 * restored lockfile with `npm ci`, which is a *pure reinstall of the lockfile*
 * and therefore can not bring the failed target back. `npm install` is used only
 * when there is no lockfile to be faithful to, and even then it is never given
 * the target version. The fallback is deliberately not `--save-exact` + a pin.
 */
function restorePreviousInstallation(rt, backups, previous) {
  const restored = restoreManifests(rt, backups)
  const lockRestored = Boolean(previous?.packageLockJson) && !restored.includes('package-lock.json')
  const npmArgs = lockRestored
    ? ['ci', '--no-audit', '--no-fund']
    : ['install', '--no-audit', '--no-fund']
  rt.log(`rollback: restoring the previous installation with npm ${npmArgs[0]}`)
  const install = runNpm(rt, npmArgs)
  if (!install.ok) {
    return {
      ok: false,
      code: ROLLBACK_ERROR.RESTORE_INCOMPLETE,
      message: install.error || `npm ${npmArgs[0]} exited with code ${install.status}`,
      restoredManifests: restored,
      installedVersion: readInstalledVersion(rt)
    }
  }

  const expected = previous?.installedVersion || previous?.pinnedVersion || null
  const actual = readInstalledVersion(rt)
  if (!restored.length && expected && actual !== expected) {
    return {
      ok: false,
      code: ROLLBACK_ERROR.VERSION_MISMATCH,
      message: `rollback left ${actual || 'no package'} installed, expected ${expected}`,
      restoredManifests: restored,
      installedVersion: actual
    }
  }

  const check = verifyInstall(rt, { expected })
  return {
    ok: check.ok,
    code: check.ok ? null : ROLLBACK_ERROR.VERSION_MISMATCH,
    message: check.message,
    restoredManifests: restored,
    installedVersion: actual,
    restoredVersion: check.ok ? actual : null
  }
}

/**
 * The installed package must be the expected version, expose its CLI entry and
 * still boot that CLI. The boot check is what separates "npm reported success"
 * from "the harness actually runs"; when no version was requested (`expected`
 * null) the current installation is verified as-is.
 */
function verifyInstall(rt, { expected = rt.target } = {}) {
  const dir = packageDir(rt)
  const installed = readPackageVersion(dir)
  if (expected && installed !== expected) {
    return { ok: false, message: `installed version ${installed || 'missing'} does not match requested ${expected}` }
  }
  if (!installed) {
    return { ok: false, message: `installed package version missing: ${dir}` }
  }
  const bin = path.join(dir, 'lib', 'bin.js')
  if (!fs.existsSync(bin)) {
    return { ok: false, message: `harness CLI entry missing after install: ${bin}` }
  }
  const smoke = smokeCheckCli(rt, bin)
  if (!smoke.ok) return smoke
  return { ok: true, message: `installed ${PACKAGE_NAME}@${installed}${smoke.detail ? ` (${smoke.detail})` : ''}` }
}

/**
 * Real CLI boot check (`node lib/bin.js --help`). A harness whose entry file
 * exists but can not start must never be reported as a successful install.
 */
function smokeCheckCli(rt, bin) {
  const probe = spawnSync(rt.nodeExe, [bin, '--help'], {
    cwd: rt.appDir,
    env: installEnv(rt),
    encoding: 'utf8',
    windowsHide: true,
    timeout: SMOKE_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024
  })
  const output = `${probe.stdout || ''}${probe.stderr || ''}`.trim()
  if (probe.error || probe.status !== 0) {
    const detail = probe.error ? String(probe.error.message || probe.error) : `exit ${probe.status}`
    rt.log(`harness CLI smoke check failed: ${detail}\n${output.slice(-LOG_TAIL_LIMIT)}`)
    return { ok: false, message: `harness CLI smoke check failed (${detail})`, smoke: { ok: false, detail } }
  }
  if (!output) {
    return { ok: false, message: 'harness CLI smoke check produced no output', smoke: { ok: false, detail: 'no output' } }
  }
  return { ok: true, smoke: { ok: true, detail: 'cli smoke ok' } }
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
    parentPid: Number(args['parent-pid']) || 0,
    extraEnv: parseEnvPairs(args.env)
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

  // Record the installation we are about to replace *before* touching anything:
  // the rollback target is the package that is really on disk, plus the exact
  // manifest bytes the repository shipped.
  const backups = backupManifests(rt)
  const previous = capturePreviousState(rt)
  const transaction = {
    version: TRANSACTION_VERSION,
    fromVersion: previous.installedVersion || previous.pinnedVersion || rt.readMarker().from || null,
    targetVersion: rt.target,
    packageJson: previous.packageJson,
    packageLockJson: previous.packageLockJson,
    installedVersion: previous.installedVersion,
    startedAt: Date.now()
  }
  rt.setPhase('installing', { rollbackTarget: transaction.fromVersion, transactionVersion: TRANSACTION_VERSION })

  let outcome = { ok: false, message: '' }
  try {
    outcome = installTargetVersion(rt)
  } catch (error) {
    outcome = { ok: false, message: String(error?.message || error) }
  }

  const base = {
    from: transaction.fromVersion,
    to: rt.target,
    tag: rt.tag,
    pid: rt.parentPid,
    // The transaction record is metadata only: the manifest bytes it captured
    // are used in-process for the rollback and must never be written into the
    // marker (that would copy the whole lockfile into the status the dock reads).
    transaction: {
      version: TRANSACTION_VERSION,
      fromVersion: transaction.fromVersion,
      targetVersion: transaction.targetVersion,
      installedVersionAtStart: transaction.installedVersion,
      startedAt: transaction.startedAt
    }
  }

  let status = UPDATE_OUTCOME.SUCCEEDED
  let error = null
  let rollback = null

  if (outcome.ok) {
    rt.log(`update succeeded: ${outcome.message}`)
  } else {
    rt.log(`update failed: ${outcome.message}; rollback started (restoring ${transaction.fromVersion || 'previous installation'})`)
    rt.setPhase('rolling-back', { error: { code: 'INSTALL_FAILED', message: outcome.message } })
    error = { code: 'INSTALL_FAILED', message: outcome.message }
    try {
      rollback = restorePreviousInstallation(rt, backups, previous)
    } catch (rollbackError) {
      rollback = {
        ok: false,
        code: ROLLBACK_ERROR.RESTORE_INCOMPLETE,
        message: String(rollbackError?.message || rollbackError),
        installedVersion: readInstalledVersion(rt)
      }
    }
    if (rollback.ok) {
      status = UPDATE_OUTCOME.FAILED_ROLLED_BACK
      rt.log(`update rollback succeeded: restored ${rollback.installedVersion || transaction.fromVersion}`)
    } else {
      status = UPDATE_OUTCOME.FAILED_ROLLBACK_FAILED
      // Never a silent failure: this is the one outcome that may leave the
      // installation broken, so it is both logged loudly and recorded.
      rt.log(`update rollback FAILED: ${rollback.message} — the installation may now be inconsistent`)
      error = {
        code: 'INSTALL_FAILED_ROLLBACK_FAILED',
        message: outcome.message,
        rollback: { code: rollback.code || ROLLBACK_ERROR.IMPOSSIBLE, message: rollback.message }
      }
    }
  }

  rt.writeMarker({
    status,
    phase: outcome.ok ? 'done' : 'failed',
    ...base,
    error,
    rollback: rollback
      ? {
          ok: rollback.ok,
          code: rollback.code || null,
          restoredVersion: rollback.ok ? rollback.installedVersion || transaction.fromVersion : null,
          installedVersion: rollback.installedVersion ?? null,
          message: rollback.message || null
        }
      : null,
    finishedAt: Date.now()
  })

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
          // A crash before or during the install is never a rollback report: the
          // runner could not verify anything, so the outcome stays "unknown" and
          // the dock must not claim the previous version is intact.
          status: 'failed_rollback_failed',
          phase: 'failed',
          to: args.target || null,
          pid: Number(args['parent-pid']) || 0,
          error: { code: 'RUNNER_CRASHED', message: String(error?.stack || error).slice(0, 1000) },
          rollback: { ok: false, code: ROLLBACK_ERROR.IMPOSSIBLE, message: 'the update runner crashed before it could roll back' },
          finishedAt: Date.now()
        }, null, 2)}\n`, 'utf8')
      } catch {}
      process.exit(1)
    })
}

module.exports = {
  main,
  parseArgs,
  processAlive,
  waitForParentExit,
  verifyInstall,
  pinManifestVersion,
  installTargetVersion,
  restorePreviousInstallation,
  capturePreviousState,
  readInstalledVersion,
  UPDATE_OUTCOME,
  ROLLBACK_ERROR
}
