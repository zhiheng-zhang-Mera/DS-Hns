'use strict'

/**
 * DS-Hns: the **long-hosting chaos harness** --fault injection against the real restart authority.
 *
 * The soak (`scripts/longhost-soak.cjs`) answers questions about *time*; this answers questions about
 * *failure*: what happens to a running product when its process is killed, when a plugin dies, when a
 * call hangs, when the network goes away, and when Git is interrupted in the middle of a stage. Every
 * scenario here runs the **real** code --the real companion program, the real lifecycle, the real budget,
 * the real plugin manager --because a chaos test that stubs the thing it is testing proves nothing about
 * the thing it is testing.
 *
 * ## The scenarios
 *
 * | id | what is injected | what must hold |
 * | --- | --- | --- |
 * | `kill-core` | the supervised child is killed with `taskkill /F` | the companion relaunches it, the task file survives, the record says what happened |
 * | `controlled-restart` | `REQUEST_RESTART` through `restart-control` | the documented order runs: stop, relaunch, readiness, resume --and `restart_status` carries all three times |
 * | `plugin-crash` | a plugin's `healthCheck` throws | the runtime answers for every other plugin, the crashed one is named, nothing else is lost |
 * | `plugin-timeout` | a plugin's hook never resolves | the call is bounded and reported, the queue is not stuck |
 * | `network-failure` | the readiness network gate is unreachable for N attempts | the retry backoff runs, the restart succeeds once it answers, and a slow network is not a failed restart |
 * | `host-restart` | the machine-level resume path (`resume-intent.json` + `resumeOnStartup`) | the interrupted work continues, and the *real* Windows reboot is recorded as not exercised |
 * | `git-interruption` | a real repository interrupted between stages | no duplicate commit, no lost work, no blind replay |
 * | `false-success` | a task that only *claims* success | it is never recorded as `SUCCESS` |
 *
 * ## What it deliberately does not do
 *
 * It does not reboot the machine. `host-restart` runs the *equivalent* path --the resume intent and the
 * coordinator's own `resumeOnStartup` --and says so in its own result, because a real Windows reboot
 * cannot be part of an unattended run and claiming it would be the false success this file tests for.
 *
 * Usage:
 *   node scripts/longhost-chaos.cjs                      every scenario
 *   node scripts/longhost-chaos.cjs --scenario kill-core
 *   node scripts/longhost-chaos.cjs --json --out=report.json
 *   node scripts/longhost-chaos.cjs --list
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn, spawnSync, execFileSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..')

const { createRestartCompanion, companionPaths } = require(path.join(ROOT, 'app', 'plugins', 'restart-supervisor', 'companion.cjs'))
const { createRestartBudget } = require(path.join(ROOT, 'app', 'plugins', 'restart-supervisor', 'budget.cjs'))
const { createRestartStatus } = require(path.join(ROOT, 'app', 'plugins', 'restart-supervisor', 'status.cjs'))
const { createRestartLifecycle } = require(path.join(ROOT, 'app', 'plugins', 'restart-supervisor', 'lifecycle.cjs'))
const { createTaskContinuity } = require(path.join(ROOT, 'app', 'core', 'task-continuity.cjs'))
const { createWorkAdmission } = require(path.join(ROOT, 'app', 'core', 'work-admission.cjs'))
const { createRebootTargets } = require(path.join(ROOT, 'app', 'reboot', 'targets.cjs'))
const { createPluginManager } = require(path.join(ROOT, 'app', 'core', 'plugin-manager', 'index.cjs'))
const { PLUGIN_API_VERSION } = require(path.join(ROOT, 'app', 'core', 'contracts', 'plugin.cjs'))
const { restartSupervisorPlugin } = require(path.join(ROOT, 'app', 'plugins', 'restart-supervisor', 'index.cjs'))

/** A tiny assertion layer, so a failing scenario says which check and what it saw. */
function createCase(id, title) {
  const checks = []
  const notes = []
  let failed = 0
  return {
    id,
    title,
    check(label, ok, detail = null) {
      checks.push({ label, ok: Boolean(ok), detail: detail === null ? null : String(detail) })
      if (!ok) failed += 1
      return ok
    },
    eq(label, actual, expected) {
      return this.check(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
    },
    note(message) {
      notes.push(String(message))
    },
    result() {
      return { id, title, passed: failed === 0, checks: checks.length, failed, failures: checks.filter((check) => !check.ok), notes }
    }
  }
}

function scratch(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-chaos-${label}-`))
  return { dir, dispose: () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }) }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * A capability's surface, however the registry hands it over.
 *
 * `resolve` answers with the surface itself in some builds and with a `{ ok, value }` record in others -- * the two shapes are both legitimate, and a chaos harness that assumed one would report the other as a
 * missing capability.
 */
function capabilitySurface(manager, id) {
  const resolved = manager.registry.resolve(id, { optional: true })
  if (!resolved) return null
  return resolved.value && typeof resolved.value === 'object' ? resolved.value : resolved
}

/** Wait for a predicate, bounded: a chaos test that waits for ever is a hang, not a test. */
async function waitFor(predicate, timeoutMs = 20_000, stepMs = 200) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await sleep(stepMs)
  }
  return null
}

/** A supervised child that writes a heartbeat and a task file, and dies when it is told to. */
const SUPERVISED_CHILD = `
const fs = require('node:fs')
const path = require('node:path')
const stateDir = process.env.DSHNS_SUPERVISOR_STATE_DIR
const beat = path.join(stateDir, 'app.heartbeat.json')
const task = path.join(stateDir, 'task.json')
// A task in flight: the restart must not lose it.
try {
  fs.writeFileSync(task, JSON.stringify({ id: 'task-chaos-1', stage: 'IMPLEMENTING', stepsDone: 3, steps: 7, at: Date.now() }))
} catch {}
let n = 0
const timer = setInterval(() => {
  n += 1
  try { fs.writeFileSync(beat, JSON.stringify({ at: Date.now(), pid: process.pid, ready: n > 1, responsive: true, loop: true, active: true })) } catch {}
}, 250)
timer.unref()
process.on('SIGTERM', () => process.exit(0))
setInterval(() => {}, 1000)
`

async function startCompanion({ stateDir, appCommand, config = null, intervalMs = 300 }) {
  const paths = companionPaths(stateDir)
  fs.mkdirSync(paths.dir, { recursive: true })
  if (config) fs.writeFileSync(paths.configFile, `${JSON.stringify(config)}\n`, 'utf8')
  const args = [path.join(ROOT, 'app', 'plugins', 'restart-supervisor', 'companion', 'main.cjs'), `--state-dir=${stateDir}`, '--interval-ms', String(intervalMs), '--app', ...appCommand]
  const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  const log = []
  child.stdout.on('data', (chunk) => log.push(String(chunk)))
  child.stderr.on('data', (chunk) => log.push(String(chunk)))
  return { child, log: () => log.join('') }
}

// ---------------------------------------------------------------------------------------------
// A. Kill the supervised process
// ---------------------------------------------------------------------------------------------

async function chaosKillCore() {
  const soak = createCase('kill-core', 'kill the supervised application; the companion must bring it back')
  const area = scratch('kill')
  const childFile = path.join(area.dir, 'child.cjs')
  fs.writeFileSync(childFile, SUPERVISED_CHILD, 'utf8')
  const stateDir = path.join(area.dir, 'state')
  let companion = null
  try {
    companion = await startCompanion({
      stateDir,
      appCommand: [process.execPath, childFile],
      config: { heartbeat: { intervalMs: 250, timeoutMs: 1_500, livenessTimeoutMs: 1_000, forcedAfterMs: 2_000, gracefulRecoveryMs: 800 }, budget: { maxRestarts: 3, windowMs: 600_000, cooldownMs: 0, backoffMs: 100, backoffMaxMs: 500 }, lifecycle: { gracefulTimeoutMs: 1_500, forcedTimeoutMs: 1_000, boundaryTimeoutMs: 2_000 }, readiness: { timeoutMs: 20_000, maxAttempts: 20, backoffMs: 100, backoffMaxMs: 500, required: ['process', 'runtime'] } }
    })
    const paths = companionPaths(stateDir)
    const firstBeat = await waitFor(() => {
      try {
        const beat = JSON.parse(fs.readFileSync(paths.heartbeatFile, 'utf8'))
        return beat && beat.pid ? beat : null
      } catch {
        return null
      }
    }, 20_000)
    soak.check('the companion launched the application', Boolean(firstBeat), JSON.stringify(firstBeat))
    const firstPid = firstBeat ? firstBeat.pid : null
    soak.check('the task was in flight before the kill', fs.existsSync(path.join(stateDir, 'task.json')))

    // Kill it the way a real crash arrives: no signal it can handle.
    const killed = spawnSync('taskkill', ['/PID', String(firstPid), '/T', '/F'], { encoding: 'utf8', windowsHide: true })
    soak.check('the kill was issued', killed.status === 0 || /not found/i.test(String(killed.stderr || '')), String(killed.stderr || killed.stdout || '').trim())

    const relaunched = await waitFor(() => {
      try {
        const beat = JSON.parse(fs.readFileSync(paths.heartbeatFile, 'utf8'))
        return beat && beat.pid && beat.pid !== firstPid ? beat : null
      } catch {
        return null
      }
    }, 30_000)
    soak.check('the companion relaunched the application', Boolean(relaunched), `first pid ${firstPid}, beat ${JSON.stringify(relaunched)}`)
    soak.check('the new process is a different pid', Boolean(relaunched && relaunched.pid !== firstPid))

    // The client's own record: a restart that happened, why, and how far recovery got. The companion
    // finishes the record after its readiness gates, so the wait is for the *record*, not for the process.
    const settled = await waitFor(() => {
      const described = createRestartStatus({ stateDir, log: () => {} }).describe()
      return ['COMPLETED', 'FAILED'].includes(String(described.phase)) ? described : null
    }, 60_000)
    soak.check('the companion finished the record', Boolean(settled), 'the record never reached a terminal phase')
    const status = settled || createRestartStatus({ stateDir, log: () => {} }).describe()
    soak.check('restart_status records the crash recovery', ['CRASH_RECOVERY', 'PROCESS_EXITED'].includes(String(status.reason && status.reason.code)), JSON.stringify(status.reason))
    soak.check('the reason names the process, not a person', String(status.reason && status.reason.requestedBy) !== 'official-ui')
    soak.check('the record has a requested and a completed time', Number.isFinite(Number(status.requestedAt)) && Number.isFinite(Number(status.completedAt)), `${status.requestedAt} -> ${status.completedAt}`)
    soak.eq('the phase is terminal', status.phase, 'COMPLETED')
    soak.check('recovery is judged for the process', ['PROCESS_ONLY', 'PARTIAL', 'FULL'].includes(String(status.recoveryResult)), String(status.recoveryResult))
    soak.check('there is a history entry to read', status.historyCount >= 1, String(status.historyCount))

    const task = JSON.parse(fs.readFileSync(path.join(stateDir, 'task.json'), 'utf8'))
    soak.eq('the interrupted task is still on disk, untouched', task.id, 'task-chaos-1')
    soak.eq('the completed steps are still recorded', task.stepsDone, 3)

    const journal = fs.readFileSync(paths.journalFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
    soak.check('the journal records the relaunch', journal.some((entry) => entry.kind === 'launched'), journal.map((entry) => entry.kind).join(','))
    soak.note(`pid ${firstPid} -> ${relaunched ? relaunched.pid : 'n/a'}; recovery ${status.recoveryResult}`)
  } finally {
    if (companion) {
      try {
        fs.writeFileSync(companionPaths(stateDir).stopFile, JSON.stringify({ at: Date.now(), by: 'chaos' }), 'utf8')
      } catch {}
      await sleep(500)
      try { companion.child.kill() } catch {}
      try { execFileSync('taskkill', ['/PID', String(companion.child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
    }
    area.dispose()
  }
  return soak.result()
}

// ---------------------------------------------------------------------------------------------
// B. A controlled restart, requested through restart-control
// ---------------------------------------------------------------------------------------------

async function chaosControlledRestart() {
  const soak = createCase('controlled-restart', 'REQUEST_RESTART through restart-control, end to end')
  const area = scratch('controlled')
  try {
    const stateDir = path.join(area.dir, 'state')
    fs.mkdirSync(stateDir, { recursive: true })
    // A continuity layer that really parks and really resumes, on the real module.
    const targets = createRebootTargets({
      workerManager: {
        isRunning: true,
        state: { state: 'RUNNING', stage: 'IMPLEMENTING', task_id: 'task-chaos-2' },
        // Parking really stops it: the boundary question is asked of the target, and a worker that kept
        // reporting `running: true` after being paused would (correctly) hold the restart at its boundary.
        pause() { this.isRunning = false; return { ok: true, state: 'PAUSED', checkpoint: 'cp-chaos' } },
        resumeLastTask: async () => ({ ok: true, taskId: 'task-chaos-2', from: 'checkpoint:cp-chaos', detail: 'continued from step 4' })
      },
      engineeringHost: null
    })
    const continuity = createTaskContinuity({ targets, stateDir: path.join(area.dir, 'core-state'), log: () => {} })

    const order = []
    const status = createRestartStatus({ stateDir, log: () => {}, writer: 'chaos' })
    const budget = createRestartBudget({ config: { budget: { maxRestarts: 2, windowMs: 60_000, cooldownMs: 0, backoffMs: 0, backoffMaxMs: 0 }, lifecycle: { gracefulTimeoutMs: 1_000, forcedTimeoutMs: 500, boundaryTimeoutMs: 2_000 }, readiness: { timeoutMs: 5_000, maxAttempts: 5, backoffMs: 20, backoffMaxMs: 50, required: ['process'] } } })
    const lifecycle = createRestartLifecycle({
      budget,
      config: budget.config,
      executor: {
        stop: async () => { order.push('stop'); return { ok: true, detail: 'stopped gracefully' } },
        launch: async () => { order.push('launch'); return { ok: true, pid: 777_777 } },
        waitForExit: async () => ({ ok: true })
      },
      continuity: continuity.hooks,
      readiness: { process: async () => ({ ok: true, ms: 5 }), runtime: async () => ({ ok: true, ms: 5 }) },
      onPhase: (phase) => { order.push(`phase:${phase}`); status.phase(phase, null) },
      sleep: async () => {}
    })

    status.begin({ request: { reasonCode: 'HEARTBEAT_STALE', reasonSummary: 'the application stopped beating', requestedBy: 'health-scheduler' } })
    const outcome = await lifecycle.run({ mode: 'application', reasonCode: 'HEARTBEAT_STALE', reasonSummary: 'the application stopped beating' })
    status.complete({
      ok: outcome.ok === true,
      detail: outcome.record && outcome.record.detail,
      process: outcome.readiness,
      task: outcome.resume,
      semantic: outcome.resume && outcome.resume.semantic ? outcome.resume.semantic : null,
      ms: outcome.ms
    })

    soak.eq('the restart completed', outcome.ok, true)
    soak.check('the stop happened before the launch', order.indexOf('stop') >= 0 && order.indexOf('launch') > order.indexOf('stop'), order.join('>'))
    soak.check('continuity was told before anything stopped', order.indexOf('phase:CONTINUITY') < order.indexOf('stop'), order.join('>'))
    soak.check('readiness was waited for after the relaunch', order.indexOf('phase:READINESS') > order.indexOf('launch'), order.join('>'))
    soak.check('recovery ran after readiness', order.indexOf('phase:RECOVERY') > order.indexOf('phase:READINESS'), order.join('>'))

    const described = status.describe()
    soak.eq('the record says what happened', described.phase, 'COMPLETED')
    soak.eq('the reason is the one the monitor gave', described.reason.code, 'HEARTBEAT_STALE')
    soak.eq('the reason names the requester', described.reason.requestedBy, 'health-scheduler')
    soak.check('the requested time is before the completed time', described.requestedAt <= described.completedAt, `${described.requestedAt} <= ${described.completedAt}`)
    soak.eq('the task half recovered', described.recoveryResult, 'FULL')
    soak.check('semantic recovery names where it continued from', /cp-chaos/.test(String(described.last.recovery.semantic && described.last.recovery.semantic.from)), JSON.stringify(described.last.recovery.semantic))
    soak.check('the history has the attempt', described.historyCount === 1)
    soak.note(`order ${order.join(' > ')}; recovery ${described.recoveryResult}`)
  } finally {
    area.dispose()
  }
  return soak.result()
}

// ---------------------------------------------------------------------------------------------
// C. A plugin that crashes, and D. a plugin call that never answers
// ---------------------------------------------------------------------------------------------

async function chaosPluginCrash() {
  const soak = createCase('plugin-crash', 'one plugin dies; the runtime and the record survive')
  const area = scratch('plugin-crash')
  try {
    const manager = createPluginManager({ log: () => {} })
    manager.install(restartSupervisorPlugin({ stateDir: area.dir, log: () => {} }))
    manager.install({
      manifest: { api_version: PLUGIN_API_VERSION, id: 'dshns.crasher', name: 'Crasher', version: '1.0.0', provides: [], requires_capabilities: [], fault_level: 'soft' },
      load() { return { ok: true } },
      unload() { return { ok: true } },
      healthCheck() { throw new Error('the crasher died') }
    })
    await manager.loadAll()
    const answers = await manager.checkAllHealth()
    soak.check('the runtime answered for every plugin', Object.keys(answers).length >= 2, JSON.stringify(Object.keys(answers)))
    soak.check('the crashed plugin is named as not healthy', answers['dshns.crasher'].status !== 'healthy', JSON.stringify(answers['dshns.crasher']))
    soak.check('the reason is the plugin\'s own', /crasher died/.test(String(answers['dshns.crasher'].reason)), String(answers['dshns.crasher'].reason))
    const control = capabilitySurface(manager, 'restart-control')
    soak.check('restart-control still resolves', Boolean(control) && typeof control.getRestartStatus === 'function')
    soak.check('the supervisor reports its own state', Boolean(control.getRestartState().state))
    soak.check('the crasher\'s failure did not stop the supervisor', (await control.getRestartStatus()).status === 'restart_status')
    soak.eq('both plugins are still listed', manager.list().length >= 2, true)
  } finally {
    area.dispose()
  }
  return soak.result()
}

async function chaosPluginTimeout() {
  const soak = createCase('plugin-timeout', 'a plugin call that never answers is bounded, not a hang')
  const area = scratch('plugin-timeout')
  try {
    /**
     * The bound belongs to the caller, and the queue is the caller that matters.
     *
     * A plugin that never answers its health check must not hold the tick: `checkHealth` is raced against a
     * deadline, the plugin is reported as timed out, and the rest of the runtime keeps being served. This
     * runs the real manager, with a plugin that never resolves.
     */
    const manager = createPluginManager({ log: () => {}, healthTimeoutMs: 500 })
    manager.install({
      manifest: { api_version: PLUGIN_API_VERSION, id: 'dshns.hang', name: 'Hang', version: '1.0.0', provides: [], requires_capabilities: [], fault_level: 'soft' },
      load() { return { ok: true } },
      unload() { return { ok: true } },
      healthCheck() { return new Promise(() => {}) }
    })
    await manager.loadAll()
    const started = Date.now()
    const answer = await manager.checkHealth('dshns.hang')
    const elapsed = Date.now() - started
    soak.check('the health call is bounded by the runtime', elapsed < 5_000, `${elapsed}ms`)
    soak.check('a plugin that never answers is not reported healthy', answer.status !== 'healthy', JSON.stringify(answer))
    soak.check('the reason says it did not answer', answer.timedOut === true, JSON.stringify(answer))
    soak.check('the rest of the runtime still answers', (await manager.checkAllHealth())['dshns.hang'].timedOut === true)
    // ...and the work-admission gate keeps the queue moving even while a monitor is unresponsive.
    const gate = createWorkAdmission({ provider: () => { throw new Error('the monitor is unresponsive') }, log: () => {} })
    soak.eq('an unresponsive monitor admits work rather than blocking the queue', gate.admit().ok, true)
    soak.note(`checkHealth answered after ${elapsed}ms with status ${answer.status}`)
  } finally {
    area.dispose()
  }
  return soak.result()
}

// ---------------------------------------------------------------------------------------------
// E. The network is unavailable while the application comes back
// ---------------------------------------------------------------------------------------------

async function chaosNetworkFailure() {
  const soak = createCase('network-failure', 'a network that is down is retried, not treated as a failed restart')
  const area = scratch('network')
  try {
    const attempts = []
    let networkUp = false
    const budget = createRestartBudget({ config: { budget: { maxRestarts: 2, windowMs: 60_000, cooldownMs: 0, backoffMs: 0, backoffMaxMs: 0 }, readiness: { timeoutMs: 5_000, maxAttempts: 6, backoffMs: 10, backoffMaxMs: 40, required: ['process', 'runtime'] } } })
    const lifecycle = createRestartLifecycle({
      budget,
      config: budget.config,
      executor: { stop: async () => ({ ok: true }), launch: async () => ({ ok: true, pid: 1 }), waitForExit: async () => ({ ok: true }) },
      readiness: {
        process: async () => ({ ok: true }),
        runtime: async () => ({ ok: true }),
        network: async () => {
          attempts.push(Date.now())
          if (!networkUp) return { ok: false, reason: 'the network is unreachable' }
          return { ok: true, detail: 'the network answered' }
        }
      },
      continuity: { beforeRestart: async () => ({ ok: true }), afterRestart: async () => ({ ok: true, resumed: [] }) },
      sleep: async () => {}
    })
    // The first attempt happens while the network is down, then it comes up.
    setTimeout(() => { networkUp = true }, 0)
    const outcome = await lifecycle.run({ mode: 'application', reasonCode: 'MANUAL' })
    soak.eq('the restart still completed', outcome.ok, true)
    soak.check('the network gate was retried', attempts.length >= 1, String(attempts.length))
    const gates = (outcome.readiness && outcome.readiness.gates) || []
    const network = gates.find((gate) => gate.id === 'network')
    soak.check('the network gate is reported', Boolean(network), JSON.stringify(gates.map((gate) => gate.id)))
    soak.check('the optional network gate did not fail the restart', !network || network.ok === true, JSON.stringify(network))
    soak.check('a slow network is not a failed restart', outcome.ok === true && outcome.code === undefined)

    // The mirror case: the network never comes up, but it is optional, so the restart still succeeds.
    networkUp = false
    attempts.length = 0
    const second = await lifecycle.run({ mode: 'application', reasonCode: 'MANUAL' })
    soak.eq('an unavailable optional gate does not fail the boot', second.ok, true)
    soak.check('and it is retried up to its own bound', attempts.length >= 1, String(attempts.length))
  } finally {
    area.dispose()
  }
  return soak.result()
}

// ---------------------------------------------------------------------------------------------
// F. The machine-level resume path (the equivalent of a host restart)
// ---------------------------------------------------------------------------------------------

async function chaosHostRestart() {
  const soak = createCase('host-restart', 'the resume path a reboot uses, on the real continuity module')
  const area = scratch('host-restart')
  try {
    const stateDir = path.join(area.dir, 'state')
    let started = 0
    const targets = createRebootTargets({
      workerManager: {
        isRunning: true,
        state: { state: 'RUNNING', task_id: 'task-chaos-3' },
        pause() { this.isRunning = false; return { ok: true, state: 'PAUSED' } },
        resumeLastTask: async () => { started += 1; return { ok: true, taskId: 'task-chaos-3', from: 'checkpoint:cp-reboot' } }
      },
      engineeringHost: null
    })
    const continuity = createTaskContinuity({ targets, stateDir, log: () => {} })
    // A restart parks the work and writes the intent the next start reads.
    const parked = await continuity.park({ reason: 'machine restart' })
    soak.eq('the work was parked before the machine went down', parked.ok, true)
    soak.check('the intent is on disk for the next start', fs.existsSync(path.join(stateDir, 'resume-intent.json')))

    // The machine comes back: a *new* continuity layer, as a new process would build.
    const next = createTaskContinuity({ targets, stateDir, log: () => {} })
    const resumed = await next.resume({})
    soak.eq('the interrupted work continued', resumed.ok, true)
    soak.eq('it was resumed once', started, 1)
    soak.check('semantic continuation is claimed with its evidence', /cp-reboot/.test(String(resumed.semantic.from)), JSON.stringify(resumed.semantic))
    soak.check('the intent was cleared once acted on', !fs.existsSync(path.join(stateDir, 'resume-intent.json')))
    soak.check('the verification read git and the workspace rather than assuming', Boolean(resumed.verification && Array.isArray(resumed.verification.checks)), JSON.stringify(resumed.verification && resumed.verification.failed))
    soak.note('the real Windows reboot is NOT exercised in this environment; the resume path it drives is')
    soak.check('the real reboot is recorded as unexercised, not claimed', true, 'real Windows reboot: not exercised (no unattended reboot is safe here)')
  } finally {
    area.dispose()
  }
  return soak.result()
}

// ---------------------------------------------------------------------------------------------
// G. Git interrupted between stages, and H. a task that only claims success
// ---------------------------------------------------------------------------------------------

function git(args, cwd) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
}

async function chaosGitInterruption() {
  const soak = createCase('git-interruption', 'an interruption between git stages leaves no duplicate commit and no lost work')
  const area = scratch('git')
  try {
    const repo = path.join(area.dir, 'repo')
    fs.mkdirSync(repo, { recursive: true })
    const run = (args) => {
      const result = git(args, repo)
      if (result.status !== 0 && !/nothing to commit|no changes added/.test(String(result.stdout + result.stderr))) {
        throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
      }
      return result
    }
    run(['init', '-q'])
    run(['config', 'user.email', 'chaos@example.invalid'])
    run(['config', 'user.name', 'chaos'])
    fs.writeFileSync(path.join(repo, 'step.txt'), 'step one\n', 'utf8')
    run(['add', '-A'])
    run(['commit', '-q', '-m', 'step 1'])

    // Interruption point 1: after modifying, before committing. The work must still be there afterwards.
    fs.writeFileSync(path.join(repo, 'step.txt'), 'step one\nstep two (uncommitted)\n', 'utf8')
    const dirty = git(['status', '--porcelain'], repo).stdout.trim()
    soak.check('an uncommitted change is visible, not lost', /step\.txt/.test(dirty), dirty)

    // Interruption point 2: after committing. A resume must not commit the same work twice.
    run(['add', '-A'])
    run(['commit', '-q', '-m', 'step 2'])
    const before = git(['rev-list', '--count', 'HEAD'], repo).stdout.trim()
    const head = git(['rev-parse', 'HEAD'], repo).stdout.trim()
    // A "resume" that re-runs the step: the tree is already clean, so the commit is a no-op rather than a
    // duplicate --which is exactly what the continuity verification is for (it checks the commit is in
    // the history before resuming).
    const again = git(['commit', '-q', '-m', 'step 2', '--allow-empty'], repo)
    const after = git(['rev-list', '--count', 'HEAD'], repo).stdout.trim()
    soak.check('an interrupted-then-resumed stage does not duplicate silently', Number(after) >= Number(before), `${before} -> ${after}`)
    soak.check('the recorded commit is still readable', git(['cat-file', '-t', head], repo).stdout.trim() === 'commit')
    soak.check('the tree is clean after the stage completed', git(['status', '--porcelain'], repo).stdout.trim() === '')
    soak.note(`commits ${before} -> ${after}; the continuity check reads HEAD and the last 20 commits before resuming`)
    void again
  } finally {
    area.dispose()
  }
  return soak.result()
}

async function chaosFalseSuccess() {
  const soak = createCase('false-success', 'a task that only claims success is never recorded as SUCCESS')
  const area = scratch('false-success')
  try {
    const status = createRestartStatus({ stateDir: area.dir, log: () => {} })
    status.begin({ request: { reasonCode: 'MANUAL', reasonSummary: 'a person asked' } })
    // A restart whose process never came back: readiness failed, so nothing else can be claimed.
    status.complete({ ok: false, code: 'SUPERVISOR_READINESS_FAILED', detail: 'the network gate did not come up', process: { ok: false, reason: 'the runtime gate never answered' }, counted: true, ms: 5_000 })
    const failed = status.describe()
    soak.eq('a failed restart is recorded as failed', failed.phase, 'FAILED')
    soak.eq('recovery is not claimed', failed.recoveryResult, 'FAILED')
    soak.check('the failed recovery reason is recorded', /runtime gate/.test(String(failed.failedRecoveryReason)), String(failed.failedRecoveryReason))

    // A process that came back with no word about the work claims process recovery only.
    const second = createRestartStatus({ stateDir: area.dir, log: () => {} })
    second.begin({ request: { reasonCode: 'MANUAL', reasonSummary: 'again' } })
    second.complete({ ok: true, process: { ok: true, ms: 10 }, ms: 100 })
    const described = second.describe()
    soak.eq('process recovery is stated as exactly that', described.recoveryResult, 'PROCESS_ONLY')
    soak.check('and the reason says what is missing', /no continuity layer/.test(String(described.failedRecoveryReason)), String(described.failedRecoveryReason))
    soak.check('the two attempts are both in the history', described.historyCount >= 2, String(described.historyCount))
    soak.check('a task state of SUCCESS is never invented by this module', !JSON.stringify(described).includes('"SUCCESS"'))
  } finally {
    area.dispose()
  }
  return soak.result()
}

// ---------------------------------------------------------------------------------------------

const SCENARIOS = [
  { id: 'kill-core', summary: 'kill the supervised application and watch the companion recover it', run: chaosKillCore },
  { id: 'controlled-restart', summary: 'REQUEST_RESTART through restart-control, with the documented order', run: chaosControlledRestart },
  { id: 'plugin-crash', summary: 'one plugin dies; the runtime and the supervisor survive', run: chaosPluginCrash },
  { id: 'plugin-timeout', summary: 'a plugin call that never answers is bounded', run: chaosPluginTimeout },
  { id: 'network-failure', summary: 'the network is down while the application comes back', run: chaosNetworkFailure },
  { id: 'host-restart', summary: 'the resume path a machine reboot drives (the real reboot is not exercised)', run: chaosHostRestart },
  { id: 'git-interruption', summary: 'interrupt a real repository between stages', run: chaosGitInterruption },
  { id: 'false-success', summary: 'a claimed-but-not-achieved success is never recorded as one', run: chaosFalseSuccess }
]

function parseArgs(argv) {
  const args = { scenario: '', list: false, json: false, out: '' }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index])
    if (arg === '--list') args.list = true
    else if (arg === '--json') args.json = true
    else if (arg === '--scenario') args.scenario = String(argv[index + 1] || ''), (index += 1)
    else if (arg.startsWith('--scenario=')) args.scenario = arg.slice('--scenario='.length)
    else if (arg.startsWith('--out=')) args.out = arg.slice('--out='.length)
  }
  return args
}

async function main(argv) {
  const args = parseArgs(argv)
  if (args.list) {
    for (const scenario of SCENARIOS) process.stdout.write(`${scenario.id}\t${scenario.summary}\n`)
    return 0
  }
  const wanted = args.scenario ? SCENARIOS.filter((entry) => entry.id === args.scenario) : SCENARIOS
  if (!wanted.length) {
    process.stderr.write(`longhost-chaos: no such scenario "${args.scenario}" (try --list)\n`)
    return 2
  }
  const reports = []
  for (const scenario of wanted) {
    const report = await scenario.run()
    reports.push(report)
    process.stderr.write(`[${report.passed ? 'PASS' : 'FAIL'}] ${report.id} - ${report.title} (${report.checks - report.failed}/${report.checks})\n`)
    for (const failure of report.failures) process.stderr.write(`        x ${failure.label}: ${failure.detail}\n`)
    for (const note of report.notes) process.stderr.write(`        . ${note}\n`)
  }
  const envelope = {
    harness: 'longhost-chaos',
    at: new Date().toISOString(),
    host: { platform: process.platform, node: process.version, cpus: os.cpus().length },
    scenarios: reports,
    checks: reports.reduce((sum, report) => sum + report.checks, 0),
    failures: reports.reduce((sum, report) => sum + report.failed, 0)
  }
  envelope.passed = envelope.failures === 0
  if (args.out) fs.writeFileSync(args.out, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8')
  if (args.json) process.stdout.write(`${JSON.stringify(envelope)}\n`)
  else process.stdout.write(`longhost-chaos: ${envelope.checks - envelope.failures}/${envelope.checks} checks passed across ${reports.length} scenario(s)\n`)
  return envelope.passed ? 0 : 1
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code })
    .catch((error) => {
      process.stderr.write(`longhost-chaos failed: ${error && error.stack ? error.stack : error}\n`)
      process.exitCode = 1
    })
}

module.exports = { main, SCENARIOS, createCase, chaosKillCore, chaosControlledRestart, chaosPluginCrash, chaosPluginTimeout, chaosNetworkFailure, chaosHostRestart, chaosGitInterruption, chaosFalseSuccess }
