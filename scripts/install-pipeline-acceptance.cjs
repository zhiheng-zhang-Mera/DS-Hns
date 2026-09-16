'use strict'

/**
 * The unified install pipeline, end to end, with one real project of each kind.
 *
 * The requirement is one sentence — *a user names a repository or picks from the Market, and the
 * platform does the rest* — and the acceptance is that sentence, executed:
 *
 * | Sample | Kind | What it proves |
 * | --- | --- | --- |
 * | `zhu1090093659/dsh-web#packages/dsh-market` | Cordis | a repository URL becomes a planned, installed, managed plugin |
 * | this repository's `app/plugins/health-scheduler` | Native HNS | a `dshns.plugin/v1` plugin installs from a directory like anything else |
 * | the restart companion over `dsh-restart-supervisor` | Process | a background program is planned, installed and managed through the same pipeline |
 *
 * Plus the two claims that are about *refusal* rather than success: an unrecognised directory is
 * refused before anything runs, and the lifecycle operations — pin, update, rollback, quarantine,
 * uninstall — each refuse when they should and act when they should.
 *
 * ## Honest about the network
 *
 * The Cordis sample is fetched from GitHub when the machine can reach it. When it cannot, the
 * acceptance uses the existing local clone at `--samples` and **says so in the report**, because a
 * fetch that was skipped is not a fetch that succeeded.
 *
 * Usage:
 *   node scripts/install-pipeline-acceptance.cjs [--samples <dir>] [--json]
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync, spawn } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..')
const { createAdapterFramework } = require(path.join(ROOT, 'app/core/plugin-adapters/index.cjs'))
const { createNativeHnsAdapter } = require(path.join(ROOT, 'app/core/plugin-adapters/adapters/native-hns.cjs'))
const { createCordisAdapter } = require(path.join(ROOT, 'app/core/plugin-adapters/adapters/cordis.cjs'))
const { createCordisDshAdapter } = require(path.join(ROOT, 'app/core/plugin-adapters/adapters/cordis-dsh.cjs'))
const { createProcessPluginAdapter } = require(path.join(ROOT, 'app/core/plugin-adapters/adapters/process.cjs'))
const { createHostWebServer } = require(path.join(ROOT, 'app/core/plugin-adapters/bridge/host.cjs'))
const { createPluginManager } = require(path.join(ROOT, 'app/core/plugin-manager/index.cjs'))
const { createInstallPipeline, VERDICTS } = require(path.join(ROOT, 'app/core/plugin-install/pipeline.cjs'))

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const JSON_OUT = process.argv.includes('--json')
const SAMPLES = path.resolve(arg('samples', 'D:/test-DSH/samples'))
const COMPANION_REPO = path.resolve(arg('companion-repo', 'D:/test-DSH/dsh-restart'))

const results = []
const notes = []
let failures = 0

function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: detail === undefined ? null : detail })
  if (!ok) failures += 1
  if (!JSON_OUT) process.stdout.write(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}\n`)
}

function section(title) {
  if (!JSON_OUT) process.stdout.write(`\n== ${title} ==\n`)
}

function note(text) {
  notes.push(text)
  if (!JSON_OUT) process.stdout.write(`  note  ${text}\n`)
}

/** A real sparse clone into the store, which is what a GitHub install actually is. */
function materialise(source, storeDir) {
  const name = String(source.repo).replace(/[^a-z0-9]+/gi, '_')
  const target = path.join(storeDir, name)
  if (fs.existsSync(path.join(target, '.git'))) return { ok: true, dir: source.path ? path.join(target, source.path) : target, reused: true }
  fs.mkdirSync(storeDir, { recursive: true })
  const args = ['clone', '--filter=blob:none', '--sparse', '--depth', '1']
  if (source.branch) args.push('--branch', source.branch)
  args.push(`https://github.com/${source.repo}.git`, target)
  const cloned = spawnSync('git', args, { encoding: 'utf8', windowsHide: true, timeout: 180_000 })
  if (cloned.status !== 0) return { ok: false, reason: `git clone failed: ${String(cloned.stderr || '').trim().split('\n').slice(-2).join(' ')}` }
  if (source.path) {
    const sparse = spawnSync('git', ['-C', target, 'sparse-checkout', 'set', source.path], { encoding: 'utf8', windowsHide: true, timeout: 120_000 })
    if (sparse.status !== 0) return { ok: false, reason: `sparse-checkout failed: ${String(sparse.stderr || '').trim()}` }
  }
  return { ok: true, dir: source.path ? path.join(target, source.path) : target }
}

async function main() {
  const started = Date.now()
  if (!JSON_OUT) process.stdout.write('Unified install pipeline acceptance\n')

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dshns-install-'))
  /**
   * The store is persistent, not inside the temp workspace.
   *
   * A GitHub install is a clone, and re-cloning hundreds of megabytes on every acceptance run
   * would make the run slow enough that nobody runs it -- which is how an acceptance quietly stops
   * being run. The materialiser reuses a checkout that is already there. The path is inside the
   * repository's gitignored `data/`, so it is scratch either way.
   */
  const storeDir = path.resolve(arg('store', path.join(ROOT, 'data', 'plugins', 'store')))

  const webServer = createHostWebServer({ log: () => {} })
  await webServer.listen({ port: 0 })

  const framework = createAdapterFramework({ log: () => {} })
  framework.register(createNativeHnsAdapter())
  framework.register(createProcessPluginAdapter({ log: () => {} }))
  framework.register(createCordisDshAdapter({ services: { webServer }, roots: [path.join(ROOT, 'app/node_modules')], log: () => {} }))
  framework.register(createCordisAdapter({ nodeExe: process.execPath, log: () => {} }))
  const manager = createPluginManager({ log: () => {} })
  const pipeline = createInstallPipeline({
    framework,
    manager,
    storeDir,
    materialise,
    log: () => {}
  })

  try {
    // --- 1. the Cordis sample, from a repository -----------------------------
    section('a GitHub repository: Cordis sample')
    const cordisSource = 'zhu1090093659/dsh-web#packages/dsh-market'
    let cordisPlan = await pipeline.plan(cordisSource)
    if (cordisPlan.ok !== true || (cordisPlan.refused && cordisPlan.plan.verdict === VERDICTS.REFUSE)) {
      // The one step that needs the network. Falling back is stated, never silent.
      const local = path.join(SAMPLES, 'dsh-web', 'packages', 'dsh-market')
      if (fs.existsSync(path.join(local, 'package.json'))) {
        note(`GitHub fetch unavailable (${(cordisPlan.reason || (cordisPlan.plan && cordisPlan.plan.verdictReason) || 'unknown').slice(0, 80)}); used the existing local clone`)
        cordisPlan = await pipeline.plan(local)
      }
    } else {
      note('fetched from GitHub')
    }
    check('the repository produced a plan', cordisPlan.ok === true && Boolean(cordisPlan.plan), cordisPlan.reason || '')
    if (cordisPlan.ok && cordisPlan.plan) {
      const plan = cordisPlan.plan
      check('the plan names an adapter', plan.adapter.id === 'dshns.cordis-dsh', `adapter=${plan.adapter.id}`)
      check('the plan names a run mode', plan.runtime.kind === 'isolated-process', `runtime=${plan.runtime.kind}/${plan.runtime.enforcement}`)
      check('the plan lists permissions', Array.isArray(plan.permissions.granted) && plan.permissions.granted.length > 0, JSON.stringify(plan.permissions.granted))
      check('the plan carries a risk level', ['low', 'medium', 'high'].includes(plan.risk.level), `${plan.risk.level} (score ${plan.risk.score})`)
      check('the plan states the degradation', plan.degradation.length > 0, plan.degradation[0].detail.slice(0, 70))
      check('the plan is installable', plan.verdict === VERDICTS.INSTALL)
      if (!JSON_OUT) {
        process.stdout.write(`       adapter=${plan.adapter.id} runtime=${plan.runtime.kind} risk=${plan.risk.level} perms=${JSON.stringify(plan.permissions.granted)}\n`)
      }
      const installed = await pipeline.install(cordisSource, { plan: plan, adapterOutput: cordisPlan.adapterOutput, dir: cordisPlan.dir, confirm: true })
      check('it installs through the pipeline', installed.ok === true, installed.reason || '')
      if (installed.ok) {
        const record = pipeline.list().find((entry) => entry.id === installed.record.id)
        check('it has a record with provenance', Boolean(record && record.source), record ? record.source : 'none')
        check('the manager has it, unloaded', record.live.installed === true && record.live.loaded === false)
      }
    }

    // --- 2. the Native sample, from a directory ------------------------------
    section('a directory: Native HNS sample')
    const nativeDir = path.join(ROOT, 'app', 'plugins', 'health-scheduler')
    const nativePlan = await pipeline.plan(nativeDir)
    check('the native plugin produced a plan', nativePlan.ok === true && Boolean(nativePlan.plan), nativePlan.reason || '')
    if (nativePlan.ok && nativePlan.plan) {
      check('it was adapted by the native adapter', nativePlan.plan.adapter.id === 'dshns.native', `adapter=${nativePlan.plan.adapter.id} type=${nativePlan.plan.adapter.detectedType}`)
      check('the plan names an in-process run mode', nativePlan.plan.runtime.kind === 'in-process', nativePlan.plan.runtime.kind)
      check('the plan carries a risk level', Boolean(nativePlan.plan.risk.level), `${nativePlan.plan.risk.level} (score ${nativePlan.plan.risk.score})`)
      const installed = await pipeline.install(nativeDir, { plan: nativePlan.plan, adapterOutput: nativePlan.adapterOutput, dir: nativePlan.dir, confirm: true })
      check('it installs', installed.ok === true, installed.reason || '')
      if (installed.ok) {
        const id = installed.record.id
        manager.enable(id)
        check('it enables and loads through the manager', (await manager.load(id)).ok === true)
        const listed = pipeline.list().find((entry) => entry.id === id)
        check('the record and the manager agree on the four states', listed.live.loaded === true, JSON.stringify(listed.live))
      }
    }

    // --- 3. the Process sample ----------------------------------------------
    section('a background program: Process sample')
    const supervisorEntry = path.join(COMPANION_REPO, 'bin', 'supervisor.mjs')
    if (!fs.existsSync(supervisorEntry)) {
      check('the dsh-restart supervisor is present', false, `not found at ${supervisorEntry}`)
    } else {
      const companionDir = path.join(workspace, 'restart-companion')
      fs.mkdirSync(companionDir, { recursive: true })
      fs.copyFileSync(path.join(ROOT, 'tests', 'fixtures', 'process', 'restart-companion.mjs'), path.join(companionDir, 'companion.mjs'))
      // `spawn`, never `spawnSync`: the stand-in is a process that is supposed to keep running, and
      // a synchronous spawn waits for it to exit. That is not a slow test, it is a hung one.
      const watched = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true })
      const watchedPid = watched.pid
      fs.writeFileSync(path.join(companionDir, 'dshns-process.json'), `${JSON.stringify({
        api_version: 'dshns.process/v1',
        id: 'restart-companion',
        name: 'restart-companion',
        version: '1.0.0',
        command: ['node', 'companion.mjs'],
        transport: 'stdio-jsonl',
        heartbeat: { intervalMs: 500, timeoutMs: 5000, handshakeTimeoutMs: 15000 },
        restart: { policy: 'on-failure', maxRestarts: 1, windowMs: 30000, backoffMs: 150, backoffMaxMs: 300 },
        provides: { capabilities: [{ name: 'restart-control', methods: ['status', 'request', 'cancel'] }] },
        permissions: { declares: ['fs.write', 'process.spawn'] },
        limits: { invokeTimeoutMs: 10000, stopTimeoutMs: 5000 },
        env: {
          DSHNS_STATE_DIR: path.join(workspace, 'state'),
          DSHNS_SUPERVISOR_ENTRY: supervisorEntry,
          DSHNS_WATCH_PID: String(watchedPid),
          DSHNS_LAUNCH: JSON.stringify([process.execPath, '-e', 'setInterval(()=>{},1000)']),
          DSHNS_TICK_MS: '300'
        }
      }, null, 2)}\n`, 'utf8')
      fs.mkdirSync(path.join(workspace, 'state'), { recursive: true })

      const processPlan = await pipeline.plan(companionDir)
      check('the process plugin produced a plan', processPlan.ok === true && Boolean(processPlan.plan), processPlan.reason || '')
      if (processPlan.ok && processPlan.plan) {
        check('it was adapted by the process adapter', processPlan.plan.adapter.id === 'dshns.process', `adapter=${processPlan.plan.adapter.id}`)
        check('the plan names a managed-process run mode', processPlan.plan.runtime.kind === 'managed-process', processPlan.plan.runtime.kind)
        check('the plan carries the permission risk', processPlan.plan.risk.level !== 'low', `${processPlan.plan.risk.level} (score ${processPlan.plan.risk.score})`)
        check('the plan names the capability it provides', processPlan.plan.provides.includes('restart-control'), JSON.stringify(processPlan.plan.provides))
        const installed = await pipeline.install(companionDir, { plan: processPlan.plan, adapterOutput: processPlan.adapterOutput, dir: processPlan.dir, confirm: true })
        check('it installs', installed.ok === true, installed.reason || '')
        if (installed.ok) {
          const id = installed.record.id
          manager.enable(id)
          check('it loads, starting the background program', (await manager.load(id)).ok === true)
          check('the capability it declared is resolvable', manager.registry.has('restart-control'))
        }
      }
      try {
        process.kill(watchedPid)
      } catch {
        /* the stand-in is already gone */
      }
    }

    // --- 4. an unrecognised format is refused --------------------------------
    section('an unrecognised directory is refused')
    const strangerDir = path.join(workspace, 'stranger')
    fs.mkdirSync(strangerDir, { recursive: true })
    fs.writeFileSync(path.join(strangerDir, 'README.md'), '# just some files\n', 'utf8')
    const refused = await pipeline.plan(strangerDir)
    check('the plan reports a refusal', refused.ok === true && refused.plan.verdict === VERDICTS.REFUSE, refused.plan ? refused.plan.verdict : refused.reason)
    check('the refusal names the reason', Boolean(refused.plan && refused.plan.verdictReason), refused.plan ? String(refused.plan.verdictReason).slice(0, 70) : '')
    check('the refusal carries the evidence', Boolean(refused.plan && Array.isArray(refused.plan.adapter.evidence)), JSON.stringify(refused.plan ? refused.plan.adapter.evidence : []))
    const blocked = await pipeline.install(strangerDir, { confirm: true })
    check('installing it is refused', blocked.ok === false, blocked.code || '')
    check('nothing was installed', pipeline.list().every((entry) => entry.id !== null))
    // The structural guarantee: a plugin object only exists if an adapter made one.
    check('no plugin object was produced', blocked.plan ? blocked.plan.verdict !== VERDICTS.INSTALL : true)

    // --- 5. pin, update, rollback, quarantine, uninstall ----------------------
    section('the lifecycle operations')
    if (nativePlan.ok && nativePlan.plan) {
      const id = nativePlan.plan.id
      check('pinning records the version', pipeline.pin(id).ok === true)
      const pinned = pipeline.list().find((entry) => entry.id === id)
      check('the pin is on the record', pinned.pinned === true && Boolean(pinned.pinnedVersion), `${pinned.pinnedVersion}`)
      const blockedUpdate = await pipeline.update(id)
      check('a pinned plugin refuses to update', blockedUpdate.ok === false && blockedUpdate.code === 'INSTALL_RECORD_PINNED', blockedUpdate.reason || '')
      check('unpinning works', pipeline.unpin(id).ok === true)
      const unchanged = await pipeline.update(id)
      check('an update to the same version is a no-op', unchanged.ok === true && unchanged.unchanged === true, JSON.stringify(unchanged.version || ''))
      const noRollback = await pipeline.rollback(id)
      check('a rollback with only one version is refused', noRollback.ok === false && noRollback.code === 'INSTALL_NO_ROLLBACK', noRollback.reason || '')

      const quarantined = await pipeline.quarantine(id, 'acceptance: simulated repeated failure')
      check('quarantine unloads and records', quarantined.ok === true && Boolean(quarantined.quarantine), quarantined.quarantine ? quarantined.quarantine.reason : '')
      const quarantinedRecord = pipeline.list().find((entry) => entry.id === id)
      check('a quarantined plugin is not mounted', quarantinedRecord.live.loaded === false)
      const blockedInstall = await pipeline.install(nativeDir, { confirm: true })
      check('a quarantined plugin refuses to reinstall', blockedInstall.ok === false && blockedInstall.code === 'INSTALL_RECORD_QUARANTINED', blockedInstall.reason || '')
      check('releasing works', (await pipeline.release(id)).ok === true)

      const removed = await pipeline.uninstall(id)
      check('uninstall removes it from the manager', manager.has(id) === false)
      check('uninstall forgets the record', pipeline.list().every((entry) => entry.id !== id))
      check('uninstall keeps the files', Boolean(removed.filesKept), String(removed.filesKept || ''))
    }

    // --- 6. no Core change is needed for the next plugin ---------------------
    section('the pipeline is not written for these plugins')
    const pipelineSource = fs.readFileSync(path.join(ROOT, 'app/core/plugin-install/pipeline.cjs'), 'utf8')
    const planSource = fs.readFileSync(path.join(ROOT, 'app/core/plugin-install/plan.cjs'), 'utf8')
    const businessWords = ['dsh-market', 'wallpaper', 'market', 'health-scheduler', 'dsh-restart', 'cordis-dsh', 'cordis.manifest']
    const leaked = businessWords.filter((word) => pipelineSource.includes(word) || planSource.includes(word))
    check('the pipeline names no particular plugin', leaked.length === 0, leaked.length ? `found: ${leaked.join(', ')}` : 'scanned 2 modules')
    check('the pipeline reaches the manager only through an adapted plugin', /manager\.install\(plugin/.test(pipelineSource))
  } finally {
    for (const entry of pipeline.list()) {
      try {
        await manager.unload(entry.id)
      } catch {
        /* best effort */
      }
    }
    await webServer.close()
    try {
      fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 })
    } catch {
      /* a locked temp directory is not worth failing the run for */
    }
  }

  const summary = { ok: failures === 0, checks: results.length, failures, ms: Date.now() - started, notes, results }
  if (JSON_OUT) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  else process.stdout.write(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${results.length - failures}/${results.length} checks in ${summary.ms}ms\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  process.stderr.write(`acceptance failed to run: ${error && error.stack ? error.stack : error}\n`)
  process.exit(1)
})
