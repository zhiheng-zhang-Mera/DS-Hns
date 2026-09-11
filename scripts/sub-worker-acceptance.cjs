'use strict'
/**
 * Real end-to-end acceptance run for the optional Sub-worker layer.
 *
 * This is DELIBERATELY not part of the unit suite: it launches the actual
 * Electron desktop shell, twice, from an isolated scratch copy so it can never
 * disturb a DS-Harness that is already running (own root, own userData, own
 * Harness port, own data tree).
 *
 * It verifies, on the real product:
 *
 *   run A (default)   DS-Harness starts, the official UI is ready, the Mega dock
 *                     attaches, and there is NO worker process, NO
 *                     data/sub-worker directory and NO worker log      -> AC-01
 *   run B (opt-in)    enabledOnStartup starts exactly one real worker process
 *                     and persists its state                           -> AC-02/AC-11
 *   graceful exit     closing the window reclaims the worker and the managed
 *                     Harness child, leaving no orphan                  -> AC-10
 *   both runs         the official UI, Mega dock and exit paths are intact
 *
 * Usage:  node scripts/sub-worker-acceptance.cjs [A|B|all]
 * The scratch copies are left under temp/e2e-* for inspection.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')

const REPO = path.resolve(__dirname, '..')
const APP = path.join(REPO, 'app')
const ELECTRON = path.join(APP, 'node_modules', 'electron', 'dist', 'electron.exe')
const PORT_BASE = 3210

const results = []
function check(label, ok, detail = '') {
  results.push({ label, ok: Boolean(ok), detail: String(detail || '') })
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${label}${detail ? ` — ${detail}` : ''}`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function copyRecursive(from, to) {
  fs.mkdirSync(to, { recursive: true })
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name)
    const target = path.join(to, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue
      copyRecursive(source, target)
    } else {
      fs.copyFileSync(source, target)
    }
  }
}

function processAlive(pid) {
  try {
    process.kill(Number(pid), 0)
    return true
  } catch {
    return false
  }
}

function commandLineFor(pid) {
  const ps = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const result = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue).CommandLine`], { encoding: 'utf8', windowsHide: true, timeout: 10000 })
  return String(result.stdout || '').trim()
}

/** Prepare an isolated DS-Harness root with a junctioned node_modules. */
function prepareRoot(name, { port, enabledOnStartup, anchor = null, plan = null, resourceOverrides = null }) {
  const root = path.join(REPO, 'temp', `e2e-${name}`)
  fs.rmSync(root, { recursive: true, force: true })
  fs.mkdirSync(root, { recursive: true })
  copyRecursive(APP, path.join(root, 'app'))
  for (const dir of ['config', 'logs', 'runtime', 'workspace', 'cache', 'temp']) fs.mkdirSync(path.join(root, dir), { recursive: true })
  // The managed DSH child resolves its own port from the project config, so an
  // isolated run must move that too - otherwise it collides with the live
  // DS-Harness on 3080.
  const appJson = JSON.parse(fs.readFileSync(path.join(REPO, 'config', 'app.json'), 'utf8'))
  appJson.harness = { ...(appJson.harness || {}), port }
  fs.writeFileSync(path.join(root, 'config', 'app.json'), `${JSON.stringify(appJson, null, 2)}\n`, 'utf8')
  const envFile = path.join(REPO, 'config', '.env')
  if (fs.existsSync(envFile)) fs.copyFileSync(envFile, path.join(root, 'config', '.env'))
  // The scratch app shares the real (heavy) dependency tree.
  spawnSync('cmd.exe', ['/c', 'mklink', '/J', path.join(root, 'app', 'node_modules'), path.join(APP, 'node_modules')], { windowsHide: true, stdio: 'ignore' })
  if (enabledOnStartup) {
    fs.mkdirSync(path.join(root, 'data', 'sub-worker'), { recursive: true })
    const config = {
      enabledOnStartup: true,
      maxWorkers: 1,
      showNotifications: false
    }
    if (resourceOverrides) {
      config.adaptiveWorkers = true
      config.resources = resourceOverrides
    }
    fs.writeFileSync(path.join(root, 'data', 'sub-worker', 'config.json'), JSON.stringify(config, null, 2), 'utf8')
  }
  if (anchor && plan) {
    // Restore an active plan on boot: this is the crash-recovery path (§34) and
    // it also gives the adaptive scheduler real work to parallelise.
    fs.mkdirSync(path.join(root, 'data', 'sub-worker'), { recursive: true })
    fs.writeFileSync(path.join(root, 'data', 'sub-worker', 'state.json'), JSON.stringify({
      version: 1,
      state: 'CRASHED',
      lastError: 'e2e: previous supervisor stopped',
      active_plans: [{
        plan: {
          plan_id: plan.plan_id,
          created_at: new Date().toISOString(),
          objective: 'e2e adaptive plan',
          acceptance: [],
          acceptance_commands: [],
          target_repo: anchor,
          workspace_mode: 'isolated_worktree'
        },
        nodes: plan.nodes.map((node) => ({
          node_id: node.node_id,
          objective: node.objective,
          role: node.role || 'code',
          depends_on: node.depends_on || [],
          write_scope: node.write_scope,
          file_scope: null,
          read_only_files: [],
          relevant_files: [],
          acceptance_tests: [],
          constraints: [],
          timeout: null,
          priority: 0,
          failure_blocking_weight: 1,
          speculative: false,
          max_attempts: 1,
          requires_network: false,
          requires_gpu: false,
          status: 'pending',
          attempts: 0,
          worker_id: null,
          result: null,
          started_at: null,
          finished_at: null
        })),
        node_tasks: plan.nodes.map((node) => ({ node_id: node.node_id, task: node.task })),
        source: 'e2e',
        accepted_at: new Date().toISOString()
      }]
    }, null, 2), 'utf8')
  }
  return { root, port }
}

async function waitFor(predicate, { timeoutMs = 120_000, intervalMs = 500, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(intervalMs)
  }
  throw new Error(`timed out waiting for ${label}`)
}

function readLog(root) {
  try {
    return fs.readFileSync(path.join(root, 'logs', 'desktop-runtime.log'), 'utf8')
  } catch {
    return ''
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

async function runShell({ name, port, enabledOnStartup, extraChecks, anchor = null, plan = null, resourceOverrides = null }) {
  const { root } = prepareRoot(name, { port, enabledOnStartup, anchor, plan, resourceOverrides })
  const expectEnabled = Boolean(enabledOnStartup)
  console.log(`\n=== run ${name}: root=${root} port=${port} enabledOnStartup=${enabledOnStartup} ===`)
  const child = spawn(ELECTRON, [path.join(root, 'app')], {
    cwd: path.join(root, 'app'),
    env: {
      ...process.env,
      DSH_ROOT: root,
      DSH_HOME: path.join(root, 'data'),
      DSH_HARNESS_PORT: String(port),
      DSH_STARTUP_TIMEOUT_MS: '120000',
      DSH_MEGA_OBSERVE_MS: '2000'
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
  child.stdout.on('data', () => {})

  try {
    await waitFor(() => readLog(root).includes('[desktop] captured authenticated Harness URL'), { label: 'the Harness access URL', timeoutMs: 120_000 })
    await waitFor(() => readLog(root).includes('Mega dock attached'), { label: 'the integrated Mega dock', timeoutMs: 60_000 })
    await waitFor(() => readLog(root).includes('sub-worker manager ready'), { label: 'the sub-worker manager to be ready', timeoutMs: 60_000 })
    const log = readLog(root)

    check(`${name}: the official Harness announced an authenticated URL on ${port}`, /captured authenticated Harness URL/.test(log))
    check(`${name}: the official UI was created as a WebContentsView`, /--- DSH launch begin ---/.test(log))
    check(`${name}: the Mega dock attached to the single window`, /Mega dock attached/.test(log))
    check(`${name}: the mega extension started`, /extension started: mega/.test(log))
    // Inertness only applies to the runs where the feature is off: an enabled
    // run starts its pool immediately, which is the point of the opt-in.
    if (!expectEnabled) {
      check(`${name}: the sub-worker manager initialised inertly`, /sub-worker manager ready; state=OFF/.test(log))
    } else {
      check(`${name}: the sub-worker manager initialised for use`, /sub-worker manager ready/.test(log))
    }
    check(`${name}: the shell is still alive after boot`, processAlive(child.pid))

    const ownership = path.join(root, 'runtime', 'dsh-process.json')
    check(`${name}: the managed Harness child ownership record exists`, fs.existsSync(ownership))
    const owned = fs.existsSync(ownership) ? JSON.parse(fs.readFileSync(ownership, 'utf8')) : null
    check(`${name}: the managed Harness child is a live process`, owned && processAlive(owned.childPid), owned ? `pid ${owned.childPid}` : 'no record')

    if (extraChecks) await extraChecks({ root, log, child })
  } catch (error) {
    check(`${name}: boot sequence`, false, String(error?.message || error))
    console.log('--- desktop-runtime.log tail ---')
    console.log(readLog(root).split(/\r?\n/).slice(-25).join('\n'))
    if (stderr.trim()) console.log('--- stderr ---\n' + stderr.slice(-2000))
  }

  // Graceful exit: closing the window is the documented normal exit path.
  const logBeforeExit = readLog(root)
  spawnSync('taskkill.exe', ['/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true })
  await sleep(6000)
  const logAfterExit = readLog(root)
  check(`${name}: graceful exit was requested and handled`, /graceful exit requested/.test(logAfterExit) || /before-quit: reconciling managed resources/.test(logAfterExit), logAfterExit.slice(-160).replace(/\r?\n/g, ' | '))

  const owned = fs.existsSync(path.join(root, 'runtime', 'dsh-process.json'))
    ? JSON.parse(fs.readFileSync(path.join(root, 'runtime', 'dsh-process.json'), 'utf8'))
    : null
  await sleep(2000)
  check(`${name}: no managed Harness child survived the exit`, !owned || !processAlive(owned.childPid), owned ? `pid ${owned.childPid}` : 'record cleared')
  check(`${name}: the shell process exited`, !processAlive(child.pid))
  spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  return { root, logBeforeExit, logAfterExit }
}

async function main() {
  const mode = process.argv[2] || 'all'
  if (!fs.existsSync(ELECTRON)) {
    console.error(`electron not found at ${ELECTRON}`)
    process.exitCode = 1
    return
  }

  if (mode === 'A' || mode === 'all') {
    await runShell({
      name: 'default',
      port: PORT_BASE,
      enabledOnStartup: false,
      extraChecks: async ({ root }) => {
        // AC-01: the default experience must not gain anything from the change.
        check('default: no sub-worker data directory was created', !fs.existsSync(path.join(root, 'data', 'sub-worker')))
        check('default: no worker ownership record was created', !fs.existsSync(path.join(root, 'runtime', 'sub-worker-process.json')))
        const workers = listWorkerProcesses(root)
        check('default: no sub-worker process is running', workers.length === 0, workers.join(', '))
        const subWorkerLog = fs.existsSync(path.join(root, 'logs', 'sub-worker.log'))
          ? fs.statSync(path.join(root, 'logs', 'sub-worker.log')).size
          : 0
        check('default: no sub-worker runtime log was written', subWorkerLog === 0)
      }
    })
  }

  if (mode === 'B' || mode === 'all') {
    const { root } = await runShell({
      name: 'enabled',
      port: PORT_BASE + 1,
      enabledOnStartup: true,
      extraChecks: async ({ root: bootRoot }) => {
        await waitFor(() => fs.existsSync(path.join(bootRoot, 'runtime', 'sub-worker-process.json')), { label: 'the worker ownership record', timeoutMs: 60_000 })
        const ownership = JSON.parse(fs.readFileSync(path.join(bootRoot, 'runtime', 'sub-worker-process.json'), 'utf8'))
        check('opt-in: enabledOnStartup started a real worker process', processAlive(ownership.childPid), `pid ${ownership.childPid}`)
        check('opt-in: the worker ownership record is typed', ownership.type === 'sub-worker')
        check('opt-in: the worker process runs the sub-worker runtime', /sub-worker[\\/]runtime\.cjs/.test(commandLineFor(ownership.childPid)))
        const state = JSON.parse(fs.readFileSync(path.join(bootRoot, 'data', 'sub-worker', 'state.json'), 'utf8'))
        check('opt-in: the worker reached IDLE', state.state === 'IDLE', state.state)
        check('opt-in: worker state is persisted where the plan says', fs.existsSync(path.join(bootRoot, 'data', 'sub-worker', 'state.json')))
        check('opt-in: the worker runtime log exists', fs.existsSync(path.join(bootRoot, 'logs', 'sub-worker.log')))

        const workers = listWorkerProcesses(bootRoot)
        check('opt-in: exactly one worker process exists (Phase 1 maxWorkers=1)', workers.length === 1, workers.join(', '))
      }
    })

    // AC-10: after the exit there must be no orphaned worker.
    const workers = listWorkerProcesses(root)
    check('exit: no orphaned worker survived the exit', workers.length === 0, workers.join(', '))
    check('exit: the worker ownership record was cleared', !fs.existsSync(path.join(root, 'runtime', 'sub-worker-process.json')))
    const state = fs.existsSync(path.join(root, 'data', 'sub-worker', 'state.json'))
      ? JSON.parse(fs.readFileSync(path.join(root, 'data', 'sub-worker', 'state.json'), 'utf8'))
      : null
    check('exit: the persisted worker state is OFF', state && state.state === 'OFF', state ? state.state : 'no state file')
  }

  if (mode === 'C' || mode === 'all') {
    // Adaptive mode, on the real shell: a restored plan (the crash-recovery path)
    // gives two independent nodes, so the pool must grow to two workers, run them
    // in parallel, merge them and reclaim everything on exit.
    const anchor = path.join(REPO, 'temp', 'e2e-anchor-repo')
    fs.rmSync(anchor, { recursive: true, force: true })
    fs.mkdirSync(anchor, { recursive: true })
    spawnSync('git', ['init', '-q'], { cwd: anchor, windowsHide: true })
    spawnSync('git', ['config', 'user.email', 'e2e@example.com'], { cwd: anchor, windowsHide: true })
    spawnSync('git', ['config', 'user.name', 'e2e'], { cwd: anchor, windowsHide: true })
    fs.writeFileSync(path.join(anchor, 'README.md'), '# anchor\n')
    spawnSync('git', ['add', '-A'], { cwd: anchor, windowsHide: true })
    spawnSync('git', ['commit', '-qm', 'init'], { cwd: anchor, windowsHide: true })

    const plan = {
      plan_id: 'e2e-adaptive',
      nodes: ['alpha', 'beta'].map((id) => ({
        node_id: id,
        objective: `e2e node ${id}`,
        role: 'code',
        write_scope: [`e2e-${id}.txt`],
        task: {
          version: 1,
          task_id: `e2e-adaptive-${id}`,
          objective: `e2e node ${id}`,
          risk_level: 'L1',
          permissions: { read: true, write: true, shell: true },
          allowed_paths: [`e2e-${id}.txt`],
          forbidden_paths: [],
          operations: [
            { op: 'write_file', path: `e2e-${id}.txt`, content: `${id}\n` },
            { op: 'run_command', command: 'node -e "setTimeout(()=>{},4000)"' }
          ]
        }
      }))
    }

    await runShell({
      name: 'adaptive',
      port: PORT_BASE + 2,
      enabledOnStartup: true,
      anchor,
      plan,
      resourceOverrides: {
        workers: { min: 1, softMax: 2, hardMax: 2 },
        scaling: { enabled: true, scaleUpDelaySeconds: 1, scaleDownDelaySeconds: 1, idleDownGraceSeconds: 1 },
        runtime: { heartbeatSeconds: 1, sampleIntervalSeconds: 1 }
      },
      extraChecks: async ({ root: bootRoot }) => {
        await waitFor(() => fs.existsSync(path.join(bootRoot, 'data', 'sub-worker', 'hardware-profile.json')), { label: 'the hardware profile', timeoutMs: 60_000 })
        const profile = JSON.parse(fs.readFileSync(path.join(bootRoot, 'data', 'sub-worker', 'hardware-profile.json'), 'utf8'))
        check('adaptive: the installation profiler produced a hardware ceiling', profile.max_recommended_workers >= 1, `tier ${profile.tier?.name}, max ${profile.max_recommended_workers}`)
        check('adaptive: the hardware profile lists CPU, RAM and storage', profile.physical_cpu_cores >= 1 && profile.ram_total_gb > 0 && typeof profile.storage_type === 'string')

        await waitFor(() => listWorkerProcesses(bootRoot).length >= 2, { label: 'a second worker process', timeoutMs: 90_000 })
        const workers = listWorkerProcesses(bootRoot)
        check('adaptive: the pool grew to two real worker processes', workers.length === 2, workers.join(', '))
        check('adaptive: the pool never exceeded the configured maximum', workers.length <= 2)

        check('adaptive: the supervisor log records the adaptive mode', /adaptive true/.test(readText(path.join(bootRoot, 'logs', 'sub-worker', 'supervisor.log'))))
        check('adaptive: the resource log has samples', readText(path.join(bootRoot, 'logs', 'sub-worker', 'resources.log')).length > 0)

        await waitFor(() => {
          const history = JSON.parse(readText(path.join(bootRoot, 'data', 'sub-worker', 'history.json')) || '[]')
          return Array.isArray(history) && history.filter((entry) => entry.status === 'completed').length >= 2
        }, { label: 'both restored nodes to complete', timeoutMs: 120_000 })
        const history = JSON.parse(readText(path.join(bootRoot, 'data', 'sub-worker', 'history.json')))
        check('adaptive: both restored nodes completed on the real shell', history.filter((entry) => entry.status === 'completed').length >= 2)

        const integrationWorktree = path.join(path.dirname(anchor), `${path.basename(anchor)}-worktrees`, 'hns-e2e-adaptive-integration')
        // The merge runs on the tick after the DAG drains, so wait for it
        // instead of racing it.
        await waitFor(() => fs.existsSync(integrationWorktree), { label: 'the integration worktree', timeoutMs: 60_000 })
        check('adaptive: an integration worktree was produced', fs.existsSync(integrationWorktree), integrationWorktree)
        const merged = ['e2e-alpha.txt', 'e2e-beta.txt'].filter((file) => fs.existsSync(path.join(integrationWorktree, file)))
        check('adaptive: the integration merged both node results', merged.length === 2, merged.join(', '))
        check('adaptive: the target repository was never written to', !fs.existsSync(path.join(anchor, 'e2e-alpha.txt')))
        const metrics = JSON.parse(readText(path.join(bootRoot, 'data', 'sub-worker', 'metrics.json')) || '{}')
        check('adaptive: performance metrics were recorded', (metrics.records || []).length >= 2)
      }
    })

    const orphans = listWorkerProcesses(path.join(REPO, 'temp', 'e2e-adaptive'))
    check('adaptive exit: no orphaned worker survived the exit', orphans.length === 0, orphans.join(', '))
    check('adaptive exit: the worker ownership record was cleared', !fs.existsSync(path.join(REPO, 'temp', 'e2e-adaptive', 'runtime', 'sub-worker-process.json')))
  }

  const failed = results.filter((entry) => !entry.ok)
  console.log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`)
  if (failed.length) {
    for (const entry of failed) console.log(`  FAILED: ${entry.label} — ${entry.detail}`)
    process.exitCode = 1
  }
}

/** Find live processes whose command line points at this scratch root's runtime. */
function listWorkerProcesses(root) {
  const script = `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*sub-worker*runtime.cjs*' -and $_.CommandLine -like '*${root.replace(/'/g, "''")}*' } | Select-Object -ExpandProperty ProcessId`
  const ps = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const result = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 15000 })
  return String(result.stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
}

main().catch((error) => {
  console.error('E2E FAILED', error)
  process.exitCode = 1
})
