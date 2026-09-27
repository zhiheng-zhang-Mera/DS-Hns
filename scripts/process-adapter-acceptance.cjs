'use strict'

/**
 * `ProcessPluginAdapter` acceptance: a real companion, driven through the unified plugin flow.
 *
 * The subject is `dsh-restart-supervisor` — the real supervisor shipped by the `dsh-restart`
 * project. The companion in `tests/fixtures/process/restart-companion.mjs` runs it and speaks the
 * process protocol; DS-Hns starts that companion as a plugin and keeps exactly one thing on its
 * side: a `restart-control` capability bridge.
 *
 * Four claims are checked, and they are the requirement:
 *
 *   1. **DS-Hns holds no restart logic.** Asserted behaviourally — every answer about the restart
 *      comes from the companion's own reading of the supervisor's files — and structurally, by
 *      scanning the adapter's source for the vocabulary of the business it must not know.
 *   2. **When the companion crashes, DS-Hns keeps running.** Asserted by killing the companion and
 *      showing the manager, its registry and its other plugins are untouched.
 *   3. **When the application crashes, the companion handles it per protocol.** Asserted by killing
 *      the watched process and watching the supervisor notice, relaunch it and record it.
 *   4. **No infinite restart loop.** Asserted by crashing the companion until its budget is spent,
 *      then showing the state is terminal and the exit count stops growing.
 *
 * ## One thing this acceptance does not do, and says so
 *
 * The "application" whose crash is handled is a **stand-in process**, not the real DS-Hns: a test
 * cannot usefully kill the application it is running inside. The companion, the supervisor and the
 * protocol are the real ones — only the identity of the watched pid differs. Nothing in this file
 * restarts DS-Hns, and the report says so rather than implying otherwise.
 *
 * Usage:
 *   node scripts/process-adapter-acceptance.cjs [--companion-repo <dir>] [--json]
 *
 * Exit code 0 when every check passes, 1 otherwise.
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..')
const { createAdapterFramework } = require(path.join(ROOT, 'app/core/plugin-adapters/index.cjs'))
const { createProcessPluginAdapter } = require(path.join(ROOT, 'app/core/plugin-adapters/adapters/process.cjs'))
const { createPluginManager } = require(path.join(ROOT, 'app/core/plugin-manager/index.cjs'))

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const JSON_OUT = process.argv.includes('--json')
const COMPANION_REPO = path.resolve(arg('companion-repo', path.join(process.env.DSH_TEST_ROOT || path.join(ROOT, 'test-artifacts'), 'qualification-fixtures', 'dsh-restart')))
const SUPERVISOR_ENTRY = path.join(COMPANION_REPO, 'bin', 'supervisor.mjs')
const COMPANION_SOURCE = path.join(ROOT, 'tests', 'fixtures', 'process', 'restart-companion.mjs')

const results = []
let failures = 0

function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: detail === undefined ? null : detail })
  if (!ok) failures += 1
  if (!JSON_OUT) process.stdout.write(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}\n`)
}

function section(title) {
  if (!JSON_OUT) process.stdout.write(`\n== ${title} ==\n`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function processAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Poll until `probe` returns truthy, or the budget runs out. Returns the last value either way. */
async function until(probe, timeoutMs, stepMs = 150) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await probe()
    if (last) return last
    await sleep(stepMs)
  }
  return last
}

/** A disposable application process: records its pid, then idles. The crash-direction stand-in. */
function writeStandInApp(file) {
  fs.writeFileSync(file, [
    "const fs = require('node:fs')",
    'fs.appendFileSync(process.argv[2], `${process.pid}\\n`)',
    'setInterval(() => {}, 1000)',
    ''
  ].join('\n'), 'utf8')
}

function startStandInApp(appFile, pidsFile) {
  const child = spawn(process.execPath, [appFile, pidsFile], { stdio: 'ignore', windowsHide: true })
  return child
}

async function main() {
  const started = Date.now()
  if (!JSON_OUT) {
    process.stdout.write('ProcessPluginAdapter acceptance\n')
    process.stdout.write(`companion repo: ${COMPANION_REPO}\n`)
  }

  if (!fs.existsSync(SUPERVISOR_ENTRY)) {
    check('the dsh-restart-supervisor is present', false, `not found at ${SUPERVISOR_ENTRY}; pass --companion-repo`)
    report(started)
    return
  }
  check('the dsh-restart-supervisor is present', true, SUPERVISOR_ENTRY)

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dshns-process-acc-'))
  const stateDir = path.join(workspace, 'restart-state')
  const appFile = path.join(workspace, 'app.cjs')
  const pidsFile = path.join(workspace, 'pids.txt')
  const pluginDir = path.join(workspace, 'restart-companion')
  fs.mkdirSync(stateDir, { recursive: true })
  fs.mkdirSync(pluginDir, { recursive: true })
  fs.writeFileSync(pidsFile, '', 'utf8')
  writeStandInApp(appFile)
  fs.copyFileSync(COMPANION_SOURCE, path.join(pluginDir, 'companion.mjs'))

  const app = startStandInApp(appFile, pidsFile)
  await until(async () => fs.readFileSync(pidsFile, 'utf8').trim().length > 0, 5000)
  const watchedPid = Number(fs.readFileSync(pidsFile, 'utf8').trim().split('\n')[0])
  check('the stand-in application is running', processAlive(watchedPid), `pid=${watchedPid} (a stand-in, not the real DS-Hns)`)

  fs.writeFileSync(path.join(pluginDir, 'dshns-process.json'), `${JSON.stringify({
    api_version: 'dshns.process/v1',
    id: 'restart-companion',
    name: 'restart-companion',
    version: '1.0.0',
    description: 'the external companion that owns restart supervision',
    command: ['node', 'companion.mjs'],
    transport: 'stdio-jsonl',
    heartbeat: { intervalMs: 500, timeoutMs: 4000, handshakeTimeoutMs: 15000 },
    restart: { policy: 'on-failure', maxRestarts: 2, windowMs: 60000, backoffMs: 150, backoffMaxMs: 500 },
    provides: { capabilities: [{ name: 'restart-control', methods: ['status', 'request', 'cancel'], detail: 'the restart authority, held outside DS-Hns' }] },
    permissions: { declares: ['fs.write', 'process.spawn'] },
    limits: { invokeTimeoutMs: 15000, stopTimeoutMs: 5000 },
    env: {
      DSHNS_STATE_DIR: stateDir,
      DSHNS_SUPERVISOR_ENTRY: SUPERVISOR_ENTRY,
      DSHNS_WATCH_PID: String(watchedPid),
      DSHNS_LAUNCH: JSON.stringify([process.execPath, appFile, pidsFile]),
      DSHNS_TICK_MS: '200'
    }
  }, null, 2)}\n`, 'utf8')

  const framework = createAdapterFramework({ log: () => {} })
  framework.register(createProcessPluginAdapter({ log: () => {} }))
  const manager = createPluginManager({ log: () => {} })

  // --- 1. DS-Hns holds no restart logic -------------------------------------
  section('DS-Hns holds only a bridge')
  const adapterSource = fs.readFileSync(path.join(ROOT, 'app/core/plugin-adapters/adapters/process.cjs'), 'utf8')
  const supervisorSource = fs.readFileSync(path.join(ROOT, 'app/core/plugin-adapters/process/supervisor.cjs'), 'utf8')
  const businessVocabulary = ['ticket', 'relaunch', 'supervisor.mjs', 'dsh-restart', 'shutdown.exe', 'restart-attempts', 'safeModeReason']
  const leaked = businessVocabulary.filter((word) => adapterSource.includes(word) || supervisorSource.includes(word))
  check('the adapter contains no restart business vocabulary', leaked.length === 0, leaked.length ? `found: ${leaked.join(', ')}` : 'scanned 2 modules')

  // --- adapt / install / enable / load --------------------------------------
  section('the unified flow')
  const adapted = await framework.adapt({ dir: pluginDir })
  check('adapts through the framework', adapted.ok === true, adapted.ok ? `adapter=${adapted.adapter.id}` : `${adapted.code}: ${adapted.reason}`)
  if (!adapted.ok) {
    cleanup()
    report(started)
    return
  }
  const plugin = adapted.plugin
  const id = plugin.manifest.id
  check('detected as a process plugin', adapted.detection.type === 'dshns.process', `type=${adapted.detection.type}`)
  check('runtime is a managed process', plugin.manifest.runtime.kind === 'managed-process', `${plugin.manifest.runtime.kind}/${plugin.manifest.runtime.enforcement}`)
  check('capabilities are declared, not discovered', JSON.stringify(plugin.manifest.provides) === '["restart-control"]', JSON.stringify(plugin.manifest.provides))
  if (!JSON_OUT) process.stdout.write(`       permissions: ${JSON.stringify(plugin.manifest.permissions.granted)}\n`)

  check('installs', manager.install(plugin).ok === true)
  check('never auto-enabled', manager.entry(id).enabled === false)
  manager.enable(id)
  const loaded = await manager.load(id)
  check('enables and loads', loaded.ok === true, loaded.reason || '')
  if (!loaded.ok) {
    cleanup()
    report(started)
    return
  }
  check('health is healthy', (await manager.checkHealth(id)).status === 'healthy')
  const companionPid = adapted.plugin.runtimeInfo().detail.process.pid
  check('the companion runs in its own process', Number.isInteger(companionPid) && companionPid !== process.pid, `pid=${companionPid}`)

  // --- the bridge carries real supervision data -----------------------------
  section('the restart-control bridge answers with real supervision data')
  const control = manager.registry.resolve('restart-control')
  check('the capability is registered in HNS', Boolean(control))
  const firstStatus = await control.status()
  check('status answers through the bridge', firstStatus.ok === true, firstStatus.ok ? '' : firstStatus.reason)
  // The supervisor writes its first heartbeat on its first tick, so a status taken the instant the
  // plugin loaded legitimately says UNKNOWN. Waiting for a real phase is the meaningful check: it
  // proves the answer comes from the supervisor's own file rather than from a default.
  const live = await until(async () => {
    const status = await control.status()
    if (!status.ok) return null
    return status.result.phase && status.result.phase !== 'UNKNOWN' ? status.result : null
  }, 8000, 200)
  const seen = live || (firstStatus.ok ? firstStatus.result : {})
  check('the supervisor is watching the application', seen.watchedPid === watchedPid, `watched=${seen.watchedPid}`)
  check('the supervisor reports a real phase from its own state file', typeof seen.phase === 'string' && seen.phase !== 'UNKNOWN', `phase=${seen.phase}`)
  check('the supervisor has a live pid of its own', Number.isInteger(seen.supervisorPid), `supervisorPid=${seen.supervisorPid}`)

  // --- 3. the application crashes, the companion handles it ------------------
  section('the application crashes: the companion handles it')
  const uncleanBefore = seen.uncleanStarts
  try {
    process.kill(watchedPid)
  } catch (error) {
    check('the application could be stopped', false, String(error && error.message ? error.message : error))
  }
  let crashObserved = null
  await until(async () => {
    const status = await control.status()
    if (!status.ok) return null
    if (status.result.uncleanStarts > uncleanBefore) crashObserved = status.result
    // The supervisor records the crash before the spawned application executes
    // its first instruction. Observe the application's own readiness evidence
    // within the same budget before checking recovery or killing its companion.
    const pids = fs.readFileSync(pidsFile, 'utf8').trim().split('\n').filter(Boolean)
    const newPid = Number(pids[pids.length - 1])
    return crashObserved && pids.length >= 2 && newPid !== watchedPid && processAlive(newPid)
      ? status.result : null
  }, 20000, 200)
  check('the supervisor noticed the application leave', Boolean(crashObserved), crashObserved ? `phase=${crashObserved.phase} unclean=${crashObserved.uncleanStarts}` : 'no unclean start recorded')
  const pidsAfter = fs.readFileSync(pidsFile, 'utf8').trim().split('\n').filter(Boolean)
  check('the companion brought the application back', pidsAfter.length >= 2, `pids recorded: ${pidsAfter.length}`)
  const relaunchedPid = Number(pidsAfter[pidsAfter.length - 1])
  check('the relaunched application is a different, live process', relaunchedPid !== watchedPid && processAlive(relaunchedPid), `new pid=${relaunchedPid}`)

  // --- 2. the companion crashes, DS-Hns keeps running ------------------------
  section('the companion crashes: DS-Hns keeps running')
  const registryBefore = manager.registry.has('restart-control')
  try {
    process.kill(companionPid)
  } catch (error) {
    check('the companion could be stopped', false, String(error && error.message ? error.message : error))
  }
  await sleep(300)
  check('this host is still running', true, `pid=${process.pid}`)
  check('the plugin manager is still answering', Array.isArray(manager.list()) && manager.list().length > 0)
  check('the capability registry is untouched by the crash', manager.registry.has('restart-control') === registryBefore)
  const crashedStatus = manager.status(id)
  check('the crash is reported, not thrown', crashedStatus.ok === true, `state=${crashedStatus.state}`)
  const restarted = await until(async () => {
    const status = plugin.runtimeInfo().detail.process
    return status && status.running && status.pid !== companionPid ? status : null
  }, 15000, 200)
  check('the bounded restart brought the companion back', Boolean(restarted), restarted ? `new pid=${restarted.pid}` : 'no restart observed')

  // --- 4. no infinite restart loop ------------------------------------------
  section('no infinite restart loop')
  const budget = plugin.runtimeInfo().detail.process.restarts.maxRestarts
  let kills = 0
  const deadline = Date.now() + 30000
  while (Date.now() < deadline && kills < budget + 3) {
    const live = plugin.runtimeInfo().detail.process
    const terminal = live.state === 'safe-mode' || live.state === 'failed' || live.state === 'stopped'
    if (terminal) break
    if (!live.pid || !processAlive(live.pid)) {
      await sleep(200)
      continue
    }
    try {
      process.kill(live.pid)
      kills += 1
    } catch {
      /* it died on its own */
    }
    await sleep(400)
  }
  const settled = await until(async () => {
    const status = plugin.runtimeInfo().detail.process
    return status.state === 'safe-mode' || status.state === 'failed' || status.state === 'stopped' ? status : null
  }, 20000, 250)
  check('the restart budget ends in a terminal state', Boolean(settled), settled ? `state=${settled.state} after ${settled.restarts.attempts}/${settled.restarts.maxRestarts} restarts` : 'never settled')
  const exitsAtSettle = settled ? plugin.runtimeInfo().detail.process.exits.length : 0
  await sleep(3000)
  const after = plugin.runtimeInfo().detail.process
  check('nothing restarts after the budget is spent', after.state === (settled ? settled.state : 'unknown'), `state stayed ${after.state}`)
  check('the exit count stops growing', after.exits.length === exitsAtSettle, `exits=${after.exits.length}`)
  check('the reason is recorded', Boolean(after.lastFault && after.lastFault.code), after.lastFault ? after.lastFault.code : 'none')

  // --- uninstall -------------------------------------------------------------
  section('uninstall')
  const lastPid = plugin.runtimeInfo().detail.process.pid
  const removed = await manager.remove(id)
  check('uninstalls', removed.ok === true, removed.reason || '')
  check('is gone from the plugin list', manager.has(id) === false)
  await sleep(500)
  check('the companion process is gone', processAlive(lastPid) === false, `pid=${lastPid}`)
  check('its capability was revoked', manager.registry.has('restart-control') === false)

  cleanup()
  report(started)

  function cleanup() {
    try {
      if (app && app.exitCode === null) app.kill()
    } catch {
      /* already gone */
    }
    for (const line of fs.existsSync(pidsFile) ? fs.readFileSync(pidsFile, 'utf8').trim().split('\n').filter(Boolean) : []) {
      try {
        process.kill(Number(line))
      } catch {
        /* already gone */
      }
    }
    try {
      fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 })
    } catch {
      /* a locked temp directory is not worth failing the run for */
    }
  }
}

function report(started) {
  const summary = { ok: failures === 0, checks: results.length, failures, ms: Date.now() - started, results }
  if (JSON_OUT) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  else process.stdout.write(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${results.length - failures}/${results.length} checks in ${summary.ms}ms\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  process.stderr.write(`acceptance failed to run: ${error && error.stack ? error.stack : error}\n`)
  process.exit(1)
})
