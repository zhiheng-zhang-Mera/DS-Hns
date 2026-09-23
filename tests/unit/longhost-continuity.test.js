'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..', '..')
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8')

const { createRestartStatus, STATUS_PHASES, RECOVERY_RESULTS, judgeRecovery } = require('../../app/plugins/restart-supervisor/status.cjs')
const { createTaskContinuity } = require('../../app/core/task-continuity.cjs')
const { createWorkAdmission } = require('../../app/core/work-admission.cjs')
const { createRebootTargets } = require('../../app/reboot/targets.cjs')

/**
 * The half of a restart that is not a process: the **record** of what happened, the **tasks** that have
 * to survive it, and the **decision** that says whether new work may start.
 *
 * Three separate seams, because the requirement separates them: the restart supervisor stops and starts
 * a process; Core's continuity layer parks and continues the work; and the health decision gates new
 * work without either of them knowing about the other. Each is tested here for the property that makes
 * it worth having — that it tells the truth when something did not work.
 */

function scratch(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-${label}-`))
  return { dir, dispose: () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }) }
}

// ---------------------------------------------------------------------------------------------
// 1. restart_status: the formal record
// ---------------------------------------------------------------------------------------------

test('restart_status records the reason, the three times and the recovery verdict', () => {
  const area = scratch('status')
  try {
    let clock = 1_000
    const status = createRestartStatus({ stateDir: area.dir, now: () => clock, writer: 'plugin' })
    status.begin({ request: { mode: 'application', reasonCode: 'HEARTBEAT_STALE', reasonSummary: 'no beat for 40s', requestedBy: 'health-scheduler' } })
    clock = 2_000; status.phase('STOPPING', 'graceful')
    clock = 2_500; status.phase('STOPPED', 'graceful')
    clock = 3_000; status.phase('RELAUNCHING')
    clock = 4_000; status.phase('READINESS')
    clock = 5_000; status.complete({ ok: true, process: { ok: true, ms: 900, gates: [{ id: 'process', ok: true }] }, task: { ok: true, resumed: ['task-7'] }, semantic: { ok: true, from: 'checkpoint:cp-3' }, ms: 4_000 })

    const described = status.describe()
    assert.equal(described.status, 'restart_status')
    assert.equal(described.phase, STATUS_PHASES.COMPLETED)
    assert.equal(described.reason.code, 'HEARTBEAT_STALE')
    assert.equal(described.reason.summary, 'no beat for 40s')
    assert.equal(described.reason.requestedBy, 'health-scheduler')
    assert.equal(described.requestedAt, 1_000)
    assert.equal(described.startedAt, 1_000)
    assert.equal(described.completedAt, 5_000)
    assert.equal(described.recoveryResult, RECOVERY_RESULTS.FULL)
    assert.equal(described.failedRecoveryReason, null)
    assert.equal(described.historyCount, 1)
    assert.match(described.summary, /restart completed/)

    // The file is the record: it is what a process that did not run the restart reads.
    const file = JSON.parse(fs.readFileSync(path.join(area.dir, 'restart_status.json'), 'utf8'))
    assert.equal(file.current.phase, 'COMPLETED')
    assert.equal(file.current.stoppingAt, 2_000)
    assert.equal(file.current.relaunchedAt, 3_000)
    assert.equal(file.writer, 'plugin')
  } finally {
    area.dispose()
  }
})

test('recovery is judged in three separate claims, and only evidence makes the strongest one', () => {
  // Process only: the readiness gates passed and no continuity layer said anything about the work.
  const processOnly = judgeRecovery({ process: { ok: true, ms: 10 } })
  assert.equal(processOnly.result, RECOVERY_RESULTS.PROCESS_ONLY)
  assert.match(processOnly.failedReason, /no continuity layer/)

  // Partial: the task resumed, but nothing could confirm it continues from the recorded state.
  const partial = judgeRecovery({ process: { ok: true }, task: { ok: true, resumed: ['t1'] }, semantic: { ok: false, reason: 'no checkpoint was found' } })
  assert.equal(partial.result, RECOVERY_RESULTS.PARTIAL)
  assert.match(partial.failedReason, /no checkpoint was found/)

  // Full: both halves claim it, with where the continuation started.
  const full = judgeRecovery({ process: { ok: true }, task: { ok: true, resumed: ['t1'] }, semantic: { ok: true, from: 'checkpoint:cp-1' } })
  assert.equal(full.result, RECOVERY_RESULTS.FULL)
  assert.equal(full.semantic.from, 'checkpoint:cp-1')

  // Failed: the process never came back, so nothing else matters.
  const failed = judgeRecovery({ process: { ok: false, reason: 'the runtime gate never answered' }, task: { ok: true } })
  assert.equal(failed.result, RECOVERY_RESULTS.FAILED)
  assert.match(failed.failedReason, /runtime gate/)
})

test('a refused request is recorded, and it spends nothing', () => {
  const area = scratch('status-refuse')
  try {
    const status = createRestartStatus({ stateDir: area.dir, now: () => 5_000 })
    const refused = status.refuse({ request: { reasonCode: 'HEARTBEAT_STALE', summary: 'x' }, code: 'RESTART_COOLDOWN', reason: 'the cooldown has 30s left' })
    assert.equal(refused.phase, STATUS_PHASES.REFUSED)
    assert.equal(refused.counted, false)
    const described = status.describe()
    assert.equal(described.phase, 'REFUSED')
    assert.equal(described.recoveryResult, RECOVERY_RESULTS.NONE)
    assert.equal(described.last.code, 'RESTART_COOLDOWN')
    assert.equal(described.historyCount, 1, 'a refusal belongs in the history: "we tried and were told no" is part of the story')
  } finally {
    area.dispose()
  }
})

test('a restart interrupted by the machine it was restarting is left as interrupted, never as done', () => {
  const area = scratch('status-interrupted')
  try {
    const first = createRestartStatus({ stateDir: area.dir, now: () => 1_000, writer: 'companion' })
    first.begin({ request: { reasonCode: 'CRASH_RECOVERY', reasonSummary: 'the application left' } })
    first.phase('STOPPING', 'graceful')

    // The process that wrote that is gone; this is the next one, reading the file it left.
    const second = createRestartStatus({ stateDir: area.dir, now: () => 60_000, writer: 'plugin:new' })
    const described = second.describe()
    assert.equal(described.phase, STATUS_PHASES.STOPPING, 'an interrupted restart must not be reported as completed')
    assert.equal(described.inFlight, true)
    assert.equal(described.recoveredFromInterruption, true, 'the next process must know it started after an interrupted restart')
    assert.equal(described.completedAt, null)
    assert.equal(described.recoveryResult, RECOVERY_RESULTS.NONE)
    assert.ok(second.interrupted(), 'the interrupted entry must be readable so a caller can adopt it')
  } finally {
    area.dispose()
  }
})

test('the companion adopts the request the plugin wrote, instead of starting a second record', () => {
  const area = scratch('status-adopt')
  try {
    let clock = 1_000
    const plugin = createRestartStatus({ stateDir: area.dir, now: () => clock, writer: 'plugin' })
    plugin.begin({ request: { mode: 'application', reasonCode: 'MANUAL', reasonSummary: 'a person asked', requestedBy: 'official-ui' } })

    // The companion is already running and read the file before the request existed.
    const companion = createRestartStatus({ stateDir: area.dir, now: () => clock, writer: 'companion' })
    clock = 2_000
    companion.begin({ request: { reasonCode: 'MANUAL' }, executor: 'companion', adopt: true })
    clock = 3_000
    companion.phase('STOPPING', 'graceful')
    clock = 9_000
    companion.complete({ ok: true, process: { ok: true }, task: { ok: true, resumed: ['t1'] }, semantic: { ok: true, from: 'task:t1' }, ms: 8_000 })

    const described = plugin.describe()
    assert.equal(described.requestedAt, 1_000, 'the time a person asked must survive the hand-off')
    assert.equal(described.reason.requestedBy, 'official-ui')
    assert.equal(described.phase, 'COMPLETED')
    assert.equal(described.completedAt, 9_000)
    assert.equal(described.historyCount, 1, 'two processes must produce one record, not two')
    assert.ok(described.last.phases.some((entry) => /executed by companion/.test(String(entry.detail))))
  } finally {
    area.dispose()
  }
})

// ---------------------------------------------------------------------------------------------
// 2. Task continuity: park, remember, resume, and prove it
// ---------------------------------------------------------------------------------------------

/** A target that behaves, with the knobs a test needs to make it misbehave. */
function fakeTargets(overrides = {}) {
  const calls = []
  const targets = createRebootTargets({
    workerManager: {
      isRunning: overrides.running !== false,
      state: { state: 'RUNNING', stage: 'IMPLEMENTING', task_id: 'task-7' },
      pause: (reason) => { calls.push(['pause', reason]); return { ok: true, state: 'PAUSED' } },
      resumeLastTask: async () => { calls.push(['resume']); return { ok: true, taskId: 'task-7', from: 'checkpoint:cp-3', detail: 'continued' } }
    },
    engineeringHost: null
  })
  return { targets, calls }
}

test('parking writes an intent that names what will have to be continued', async () => {
  const area = scratch('continuity-park')
  try {
    const { targets, calls } = fakeTargets()
    const continuity = createTaskContinuity({ targets, stateDir: area.dir, now: () => 1_000, log: () => {} })

    const pending = continuity.pendingWork()
    assert.equal(pending.ok, true)
    assert.equal(pending.active, true)

    const parked = await continuity.park({ reason: 'restart: HEARTBEAT_STALE' })
    assert.equal(parked.ok, true)
    assert.deepEqual(parked.parked, ['sub-worker'])
    assert.equal(calls[0][0], 'pause')
    assert.match(String(calls[0][1]), /HEARTBEAT_STALE/)

    const intent = JSON.parse(fs.readFileSync(path.join(area.dir, 'resume-intent.json'), 'utf8'))
    assert.equal(intent.reason, 'restart: HEARTBEAT_STALE')
    assert.deepEqual(intent.parked, ['sub-worker'])
    assert.equal(intent.targets[0].taskId, 'task-7')
  } finally {
    area.dispose()
  }
})

test('a target that refuses to park is reported, and the restart is refused a boundary', async () => {
  const area = scratch('continuity-refuse')
  try {
    const targets = createRebootTargets({
      workerManager: {
        isRunning: true,
        state: { state: 'RUNNING', task_id: 'task-9' },
        pause: () => ({ ok: false, reason: 'the worker is inside a mutation' }),
        resumeLastTask: async () => ({ ok: true })
      }
    })
    const continuity = createTaskContinuity({ targets, stateDir: area.dir, log: () => {} })
    const parked = await continuity.park({ reason: 'restart' })
    assert.equal(parked.ok, false)
    assert.deepEqual(parked.refused, [{ target: 'sub-worker', reason: 'the worker is inside a mutation' }])
    assert.match(parked.detail, /refused a safe boundary/)
  } finally {
    area.dispose()
  }
})

test('resume continues what was parked, skips what was not, and claims semantics only with evidence', async () => {
  const area = scratch('continuity-resume')
  try {
    const { targets } = fakeTargets()
    const continuity = createTaskContinuity({ targets, stateDir: area.dir, now: () => 1_000, log: () => {} })
    await continuity.park({ reason: 'restart: MANUAL' })

    const resumed = await continuity.resume({})
    assert.equal(resumed.ok, true)
    assert.deepEqual(resumed.resumed.map((entry) => entry.target), ['sub-worker'])
    assert.equal(resumed.semantic.ok, true)
    assert.equal(resumed.semantic.from, 'checkpoint:cp-3')
    assert.equal(resumed.verification.ok, true, `verification failed: ${JSON.stringify(resumed.verification.failed)}`)
    assert.equal(fs.existsSync(path.join(area.dir, 'resume-intent.json')), false, 'the intent is cleared once it has been acted on')

    // A checkpoint the intent names but the machine does not have is a failed verification.
    continuity.writeIntent({ reason: 'restart', parked: ['sub-worker'], targets: [{ target: 'sub-worker', taskId: 't1' }], checkpoint: 'cp-missing' })
    const checked = continuity.verify({ intent: continuity.readIntent() })
    assert.equal(checked.ok, false)
    assert.ok(checked.failed.includes('checkpoint'), `expected the checkpoint check to fail: ${JSON.stringify(checked.failed)}`)
  } finally {
    area.dispose()
  }
})

test('failed recovery verification blocks target execution and preserves the durable intent', async () => {
  const area = scratch('continuity-refusal')
  try {
    let calls = 0
    const continuity = createTaskContinuity({
      stateDir: area.dir,
      git: () => ({ status: 1, stdout: '' }),
      targets: { task: {
        status: () => ({ running: false }),
        resume: async () => { calls += 1; return { ok: true, from: 'missing' } }
      } }
    })
    continuity.writeIntent({ checkpoint: 'missing', targets: [{ target: 'task' }], parked: ['task'] })
    const before = fs.readFileSync(continuity.intentFile, 'utf8')
    const result = await continuity.resume()
    assert.equal(result.verification.ok, false)
    assert.equal(calls, 0)
    assert.equal(result.ok, false)
    assert.equal(result.semantic.ok, false)
    assert.equal(result.code, 'CONTINUITY_VERIFICATION_FAILED')
    assert.equal(fs.readFileSync(continuity.intentFile, 'utf8'), before)
  } finally { area.dispose() }
})

test('a task that was already finished before the restart is not run again', async () => {
  const area = scratch('continuity-norepeat')
  try {
    let resumed = 0
    const targets = {
      finished: {
        status: () => null,
        suspend: async () => ({ ok: true, detail: 'nothing to park' }),
        resume: async () => { resumed += 1; return { ok: true } }
      }
    }
    const continuity = createTaskContinuity({ targets, stateDir: area.dir, log: () => {} })
    // An intent that names a target which was never parked: the restart did not interrupt it.
    continuity.writeIntent({ reason: 'restart', parked: [], targets: [{ target: 'finished', taskId: 't1' }] })
    const result = await continuity.resume({})
    assert.equal(resumed, 0, 'a target that was not parked must not be resumed')
    assert.equal(result.ok, true)
    assert.equal(result.alreadyComplete.length, 1)
    assert.match(String(result.alreadyComplete[0].reason), /already finished/)
  } finally {
    area.dispose()
  }
})

test('the continuity hooks are the shape the supervisor asks for', async () => {
  const area = scratch('continuity-hooks')
  try {
    const { targets } = fakeTargets()
    const continuity = createTaskContinuity({ targets, stateDir: area.dir, log: () => {} })
    assert.equal(typeof continuity.hooks.beforeRestart, 'function')
    assert.equal(typeof continuity.hooks.afterRestart, 'function')
    assert.equal(typeof continuity.hooks.pendingWork, 'function')
    const before = await continuity.hooks.beforeRestart({ request: { reasonCode: 'MANUAL' } })
    assert.equal(before.ok, true)
    assert.ok(Array.isArray(before.parked))
    const after = await continuity.hooks.afterRestart({})
    assert.equal(after.ok, true)
    assert.ok(after.semantic)
  } finally {
    area.dispose()
  }
})

// ---------------------------------------------------------------------------------------------
// 3. Work admission: the health decision, at the queue's door
// ---------------------------------------------------------------------------------------------

test('the action ladder decides admission: throttle halves, pause and restart hold', () => {
  let snapshot = { action: 'NO_ACTION', pressure: 20, state: 'HEALTHY' }
  const gate = createWorkAdmission({ provider: () => snapshot })
  assert.equal(gate.admit().ok, true)
  assert.equal(gate.admit().concurrencyFactor, 1)

  snapshot = { action: 'THROTTLE', pressure: 72, state: 'ELEVATED', reason: 'pressure 72 is above the elevated threshold 40' }
  const throttled = gate.admit()
  assert.equal(throttled.ok, true, 'a throttle slows the queue; it does not stop it')
  assert.equal(throttled.concurrencyFactor, 0.5)

  snapshot = { action: 'PAUSE_NEW_WORK', pressure: 88, state: 'DEGRADED', reason: 'pressure 88 is above the degraded threshold 70' }
  const paused = gate.admit()
  assert.equal(paused.ok, false)
  assert.equal(paused.defer, true, 'a held task is deferred, never failed')
  assert.match(paused.reason, /degraded threshold/)

  snapshot = { action: 'REQUEST_RESTART', pressure: 95, state: 'CRITICAL' }
  const restarting = gate.admit()
  assert.equal(restarting.ok, false)
  assert.equal(restarting.defer, true)
  assert.match(restarting.reason, /restart has been requested/)
})

test('no evidence means no restriction: an absent, blind or throwing monitor admits', () => {
  assert.equal(createWorkAdmission({}).admit().ok, true, 'a build with no provider must not stop the queue')
  assert.equal(createWorkAdmission({ provider: () => null }).admit().ok, true, 'a monitor that reports nothing admits')
  const blind = createWorkAdmission({ provider: () => { throw new Error('the sampler died') }, log: () => {} })
  const decision = blind.admit()
  assert.equal(decision.ok, true, 'a monitor that throws must not stop the product')
  assert.equal(blind.describe().available, false)
  assert.match(String(blind.describe().reason), /no health decision is available/)
})

// ---------------------------------------------------------------------------------------------
// 4. Wiring: the shell and the queue, in the shipped files
// ---------------------------------------------------------------------------------------------

test('the shell wires continuity into the host and admission into the queue', () => {
  const shell = read('app/desktop-main.cjs')
  assert.match(shell, /continuity: taskContinuity\(\)\.hooks/)
  assert.match(shell, /workAdmission: \(\) => workAdmission\(\)\.admit\(\)/)
  assert.match(shell, /registry\.resolve\('health-pressure', \{ optional: true \}\)/)
  assert.match(shell, /require\('\.\/core\/work-admission\.cjs'\)/)

  const scheduler = read('app/extensions/mega/scheduler/scheduler.js')
  assert.match(scheduler, /setWorkAdmission\(gate\)/)
  assert.match(scheduler, /const admission = this\.workAdmission \? this\.workAdmission\(\) : null/)
  assert.match(scheduler, /effectiveConcurrency\(\)/)
  const mega = read('app/extensions/mega/index.cjs')
  assert.match(mega, /scheduler\.setWorkAdmission\(typeof ctx\?\.workAdmission === 'function' \? ctx\.workAdmission : null\)/)
})

test('the official page shows the restart status, and one ball only', () => {
  const view = read('app/plugins/mega-core/lib/view.js')
  assert.match(view, /function restartStatusView\(status\)/)
  assert.match(view, /restartStatus,/)
  assert.match(view, /hideInUi: orbMode === 'system'/)
  const client = read('app/plugins/mega-core/lib/client.js')
  assert.match(client, /'data-hns-restart-status': view\.restartStatus\.phase/)
  assert.match(client, /if \(snapshot\?\.view\?\.orb\?\.hideInUi\) return null;/)
  const host = read('app/plugin-host.cjs')
  assert.match(host, /restartStatus: \(\) => \{/)
  const shell = read('app/desktop-main.cjs')
  assert.match(shell, /restartStatus: \(\) => pluginRuntime\(\)\.restartStatus\(\)/)
})

// ---------------------------------------------------------------------------------------------
// 5. Packaging: the plugins must load as installed profile packages too
// ---------------------------------------------------------------------------------------------

/**
 * A plugin that is installed into a Harness profile is composed by the **Harness' own process**, from
 * `data/profiles/<profile>/node_modules/<name>/`. A `require` that escapes the package directory -- the
 * obvious `require('../../core/contracts/plugin.cjs')` the in-repo mount resolves happily -- resolves to
 * `node_modules/core/...` there, throws `MODULE_NOT_FOUND`, and takes the whole harness process down with
 * it: the plugin is installed and **the product will not boot**.
 *
 * This was found by starting the product (the official-UI acceptance), not by a unit test, so the unit
 * test is written to be the same shape: the package is copied somewhere with no platform above it and
 * required from there.
 */
test('both plugins load as installed packages, with nothing above them to require', () => {  const area = scratch('package-standalone')
  try {
    for (const directory of ['restart-supervisor', 'health-scheduler']) {
      const source = path.join(ROOT, 'app', 'plugins', directory)
      const installed = path.join(area.dir, 'node_modules', `dsh-${directory}`)
      fs.cpSync(source, installed, { recursive: true })

      // Every relative require stays inside the package -- or is the *guarded* platform lookup in
      // `contract.cjs`, which is what makes the package work in both mounts.
      const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name)
          if (entry.isDirectory()) { walk(full); continue }
          if (!entry.name.endsWith('.cjs')) continue
          const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/)
          lines.forEach((line, index) => {
            const trimmed = line.trim()
            // A comment that *mentions* a path is documentation, not a require. This branch is written
            // about the very path it forbids, so the scanner has to read code only.
            if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return
            for (const match of line.matchAll(/require\('(\.[^']*)'\)/g)) {
              const target = path.resolve(path.dirname(full), match[1])
              if (target.startsWith(installed + path.sep)) continue
              const guarded = [lines[index - 1] || '', lines[index - 2] || '', line].some((near) => /try\s*\{/.test(near))
              assert.ok(guarded, `${directory}: ${path.relative(source, full)}:${index + 1} requires ${match[1]}, which leaves the package unguarded`)
            }
          })
        }
      }
      walk(installed)

      // ...and it really loads with the platform out of reach.
      const loaded = require(path.join(installed, 'index.cjs'))
      const plugin = directory === 'restart-supervisor' ? loaded.restartSupervisorPlugin() : loaded.healthSchedulerPlugin()
      assert.equal(plugin.manifest.api_version, 'dshns.plugin/v1', `${directory} does not declare the platform API version`)
      assert.ok(plugin.manifest.id, `${directory} has no plugin id`)
      assert.equal(typeof plugin.load, 'function')
      const contract = require(path.join(installed, 'contract.cjs')).contract()
      assert.equal(contract.source, 'the plugin package itself', `${directory} did not fall back to its own contract`)
      assert.equal(contract.PLUGIN_API_VERSION, require('../../app/core/contracts/plugin.cjs').PLUGIN_API_VERSION)
      // The Harness composes the package as a cordis plugin, and its loader wants a function or an object
      // with `apply`: an object of helpers is refused, and the whole profile then fails to boot.
      assert.equal(typeof require(path.join(installed, 'index.cjs')).apply, 'function', `${directory} exports no cordis half`)
    }
  } finally {
    area.dispose()
  }
})

/**
 * The companion is started through the **adapted** plugin, so the adapter has to carry the hook.
 *
 * `startCompanions` walks the plugin manager and calls `ensureCompanion` on each plugin -- but what it
 * reaches is the adapter's output, not the raw module, and that output is a deliberate whitelist. The two
 * process-ownership hooks were not on it, so the loop found no candidate and started nothing: the boot log
 * said `companions []` and the supervisor reported "no companion", which is the one state the out-of-process
 * half exists to prevent.
 */
test('the shell can start and stop the supervisor companion through the adapted plugin', async () => {
  const { createPluginHost } = require('../../app/plugin-host.cjs')
  const area = scratch('companion-hooks')
  const configDir = path.join(area.dir, 'config')
  fs.mkdirSync(configDir, { recursive: true })
  const host = createPluginHost({ root: ROOT, configDir, lockFile: path.join(area.dir, 'dshns-lock.yaml'), log: () => {} })
  try {
    await host.ensure()
    const started = host.startCompanions()
    assert.equal(started.built, true, 'the plugin world was not built')
    const supervisor = started.started.find((entry) => entry.id === 'dshns.restart-supervisor')
    assert.ok(supervisor, `the supervisor was not asked to start its companion: ${JSON.stringify(started.started)}`)
    assert.equal(supervisor.ok, true, JSON.stringify(supervisor))
    assert.ok(Number.isFinite(Number(supervisor.pid)) || supervisor.already === true, JSON.stringify(supervisor))
    const stopped = host.stopCompanions('test teardown')
    assert.equal(stopped.stopped[0].ok, true, JSON.stringify(stopped.stopped))
  } finally {
    await host.dispose('test teardown')
    // The companion is a real process: standing it down is part of the test, not an afterthought.
    try {
      const pidFile = path.join(area.dir, 'state', 'restart-supervisor', 'companion.pid')
      void pidFile
    } catch {}
    area.dispose()
  }
})
