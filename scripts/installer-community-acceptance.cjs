'use strict'

/**
 * The optional community plugins, installed from the **real registry** into a **real Harness profile**.
 *
 * Every other suite in this repository drives the installation channel with a stand-in for the Harness
 * CLI (`tests/helpers/harness-cli-stub.cjs`), because a unit suite that needs npm is a suite that fails
 * on a train. That leaves one question no stand-in can answer, and this script exists to answer it:
 *
 * > do the two packages the release pins really install from npm, and does the adapter layer recognise
 * > what lands?
 *
 * It is a script rather than a test on purpose. It reaches the network, it needs a profile, and it takes
 * as long as pnpm takes — so it is run deliberately, not on every `node --test`:
 *
 * ```
 *   node scripts\installer-community-acceptance.cjs
 *   node scripts\installer-community-acceptance.cjs --profile=hns-verify --keep
 *   node scripts\installer-community-acceptance.cjs --json --report=.\community-acceptance.json
 * ```
 *
 * ## What it asserts, and what it refuses to claim
 *
 * For each plugin it reports:
 *
 *   * `registry` — the published version really exists and was fetched (the CLI exited 0);
 *   * `installed` — the profile's own `package.json` declares it and the installed copy is there;
 *   * `adapter` — the **adapter framework** adapted the installed directory, which adapter took it, what
 *     type it detected and what evidence it produced;
 *   * `peers` — which of the plugin's declared host dependencies this machine provides, which the
 *     Harness' client-module table provides at load time, and which are simply absent. An absent peer is
 *     reported, never hidden: "installed" is a claim about the install, not about the plugin running.
 *
 * What it does **not** claim is that the plugin runs. Whether the browser half renders is the Harness'
 * answer, and this script does not start the Harness: that is the manual UI review's job
 * (`docs/pluginize.md`). A run that succeeds here means "the pinned packages install and are recognised",
 * which is exactly the gap the stand-in leaves.
 *
 * Exit code: 0 when every requested plugin installed and was adapted, 1 otherwise, 2 on a usage error.
 */

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..')
const { BUNDLED_MANIFEST } = require('../app/extensions/mega/plugins/index.cjs')
const community = require('../app/extensions/mega/plugins/community-install.cjs')
const { createAdapterFramework } = require('../app/core/plugin-adapters/index.cjs')
const { createHarnessProfileAdapter } = require('../app/core/plugin-adapters/adapters/harness-profile.cjs')
const { createCordisDshAdapter } = require('../app/core/plugin-adapters/adapters/cordis-dsh.cjs')
const { createCordisAdapter } = require('../app/core/plugin-adapters/adapters/cordis.cjs')

function parseArgs(argv) {
  const args = { profile: 'hns-community-verify', json: false, report: '', keep: false, which: [] }
  for (const raw of argv) {
    const arg = String(raw)
    if (arg.startsWith('--profile=')) args.profile = arg.slice('--profile='.length)
    else if (arg.startsWith('--report=')) args.report = arg.slice('--report='.length)
    else if (arg === '--json') args.json = true
    else if (arg === '--keep') args.keep = true
    else if (arg === '--market') args.which.push('@dsh-market/plugin')
    else if (arg === '--wallpaper') args.which.push('dsh-wallpaper-engine')
    else {
      process.stderr.write(`installer-community-acceptance: unknown argument ${arg}\n`)
      process.exit(2)
    }
  }
  if (args.which.length === 0) args.which.push('dsh-wallpaper-engine', '@dsh-market/plugin')
  return args
}

function say(line) {
  process.stderr.write(`${line}\n`)
}

/** The adapter framework the product builds, with the same registrations in the same order. */
function createFramework() {
  const framework = createAdapterFramework({ log: () => {} })
  framework.register(createHarnessProfileAdapter({ roots: [path.join(ROOT, 'app', 'node_modules')], log: () => {} }))
  framework.register(createCordisDshAdapter({ roots: [path.join(ROOT, 'app', 'node_modules')], log: () => {} }))
  framework.register(createCordisAdapter({ log: () => {} }))
  return framework
}

/**
 * Make a `pnpm` the Harness CLI can spawn, the same way the installer does.
 *
 * `dsh plugin … add` forwards to a bare `pnpm` inside the profile directory, so the channel needs one
 * on `PATH`. `scripts\install-profile-plugin.ps1` provides it with corepack (which ships with Node) into
 * the repository's own git-ignored `runtime\bin`; this script asks corepack for the same shim, because a
 * channel that works when the installer ran and not when this script runs would be a different channel.
 */
function ensurePnpm() {
  const probe = spawnSync('pnpm', ['--version'], { encoding: 'utf8', windowsHide: true, shell: true })
  if (probe.status === 0) return { ok: true, how: 'PATH', version: String(probe.stdout || '').trim() }
  const shimDir = path.join(ROOT, 'runtime', 'bin')
  fs.mkdirSync(shimDir, { recursive: true })
  const corepack = spawnSync('corepack', ['enable', 'pnpm', '--install-directory', shimDir], { encoding: 'utf8', windowsHide: true, shell: true })
  if (corepack.status !== 0) {
    return { ok: false, reason: `corepack could not provide pnpm (exit ${corepack.status}): ${String(corepack.stderr || '').trim()}` }
  }
  const shim = path.join(shimDir, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm')
  if (!fs.existsSync(shim)) return { ok: false, reason: `corepack did not produce ${shim}` }
  process.env.PATH = `${shimDir}${path.delimiter}${process.env.PATH}`
  return { ok: true, how: 'corepack', shim }
}

async function main(argv) {
  const args = parseArgs(argv)
  const dshHome = path.join(ROOT, 'temp', `community-acceptance-${process.pid}`)
  const dshEntry = path.join(ROOT, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!fs.existsSync(dshEntry)) {
    say(`the Harness CLI is not installed (${dshEntry} is missing); run scripts\\install-deps.ps1 first.`)
    return 1
  }
  fs.mkdirSync(dshHome, { recursive: true })
  say(`profile:    ${args.profile}`)
  say(`DSH_HOME:   ${dshHome}`)
  say(`packages:   ${args.which.join(', ')}`)

  const pnpm = ensurePnpm()
  if (pnpm.ok !== true) {
    say(`pnpm:       NOT AVAILABLE - ${pnpm.reason}`)
    return 1
  }
  say(`pnpm:       ${pnpm.how}${pnpm.version ? ` (${pnpm.version})` : ''}`)

  const harnessAdd = ({ profile, package: spec }) => {
    say(`  $ dsh plugin --profile ${profile} add ${spec}`)
    const result = spawnSync(process.execPath, [dshEntry, 'plugin', '--profile', profile, 'add', spec], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 600_000,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env,
        DSH_HOME: dshHome,
        DSH_ROOT: ROOT,
        DSH_PROFILE: profile,
        pnpm_config_store_dir: process.env.pnpm_config_store_dir || path.join(ROOT, 'cache', 'pnpm'),
        npm_config_cache: process.env.npm_config_cache || path.join(ROOT, 'cache', 'npm')
      }
    })
    if (result.error) return { ok: false, reason: `the Harness plugin command could not run: ${result.error.message}` }
    if (result.status !== 0) {
      const detail = String(result.stderr || result.stdout || '').trim().split('\n').filter(Boolean).slice(-4).join(' | ')
      return { ok: false, reason: `dsh plugin exited ${result.status}${detail ? `: ${detail}` : ''}` }
    }
    return { ok: true, output: String(result.stdout || '').trim() }
  }

  const framework = createFramework()
  const verify = async ({ id, channel, profile, packageName }) => {
    const installed = community.readInstalled({ root: ROOT, profile, dshHome, packageName })
    if (installed.ok !== true || installed.installed !== true) {
      return { ok: false, reason: installed.reason || `${packageName} is not installed` }
    }
    const adapted = await framework.adapt({
      dir: installed.packageDir,
      channel,
      where: `profile ${profile}`,
      source: `${packageName}@${installed.version || ''}`
    })
    if (adapted.ok !== true) return { ok: false, code: adapted.code, reason: adapted.reason, attempts: adapted.attempts || [] }
    const info = typeof adapted.plugin.runtimeInfo === 'function' ? adapted.plugin.runtimeInfo() : null
    const detail = info && info.detail ? info.detail : null
    const structure = detail && detail.structure ? detail.structure : null
    return {
      ok: true,
      id,
      adapter: { id: adapted.adapter.id, version: adapted.adapter.version },
      detectedType: adapted.detection ? adapted.detection.type : null,
      evidence: adapted.detection ? adapted.detection.evidence : [],
      packageDir: installed.packageDir,
      version: installed.version,
      structure,
      client: detail ? detail.client || null : null,
      /** Kept apart on purpose — see the header: recognised is not running. */
      runsInHarness: true,
      runsHere: false
    }
  }

  const results = []
  for (const id of args.which) {
    say('')
    say(`== ${id} ==`)
    const outcome = await community.installCommunityPlugin(id, {
      root: ROOT,
      profile: args.profile,
      dshHome,
      harnessAdd,
      verify,
      replace: true
    })
    const record = {
      id,
      ok: outcome.ok === true,
      state: outcome.ok === true ? (outcome.alreadyInstalled ? 'already-installed' : 'installed') : 'failed',
      reason: outcome.ok === true ? outcome.message || null : outcome.reason || null,
      spec: outcome.spec || null,
      version: outcome.version || null,
      adapter: outcome.verify && outcome.verify.adapter ? outcome.verify.adapter : null,
      detectedType: outcome.verify ? outcome.verify.detectedType || null : null,
      evidence: outcome.verify ? outcome.verify.evidence || [] : [],
      structure: outcome.verify ? outcome.verify.structure || null : null,
      client: outcome.verify ? outcome.verify.client || null : null
    }
    say(`  state:      ${record.state}`)
    if (record.adapter) say(`  adapter:    ${record.adapter.id} (${record.detectedType})`)
    if (record.structure && record.structure.peers) {
      const peers = record.structure.peers
      say(`  peers:      resolved=[${(peers.resolved ? Object.keys(peers.resolved) : []).join(', ')}]`)
      say(`              providedAtRuntime=[${(peers.providedAtRuntime || []).join(', ')}]`)
      say(`              missing=[${(peers.missing || []).join(', ')}]`)
    }
    if (record.client && record.client.declared) {
      say(`  client half: ${record.client.entry || '(none)'} platform=${record.client.platform} servable=${record.client.servable}`)
    }
    if (record.reason) say(`  reason:     ${record.reason}`)
    results.push(record)
  }

  const failed = results.filter((result) => result.ok !== true)

  /**
   * The last fact, and the one a person would check first: does the product's own plugin manager see
   * what was installed?
   *
   * It reads the profile the way `bundled()` in `app/extensions/mega/index.cjs` reads it — the profile's
   * `dependencies`, translated from package names to plugin ids by `entryForPackage` — and asks the
   * manager for each plugin's state. `INSTALLED` here means the panel will show it as installed; anything
   * else is reported as the failure it is, rather than left for a person to discover in the UI.
   */
  const profileFile = path.join(dshHome, 'profiles', args.profile, 'package.json')
  const declared = fs.existsSync(profileFile) ? JSON.parse(fs.readFileSync(profileFile, 'utf8')).dependencies || {} : {}
  const { entryForPackage, createBundledPlugins } = require('../app/extensions/mega/plugins/index.cjs')
  const installedRecords = Object.entries(declared).map(([name, version]) => {
    const entry = entryForPackage(name)
    return { id: entry ? entry.id : name, package: name, version, dir: null, enabled: true, where: 'harness-profile' }
  })
  const manager = createBundledPlugins({ installed: () => installedRecords, userEnabled: () => null })
  const states = manager.describe().states
  say('')
  say('== the product\'s plugin manager ==')
  say(`  profile dependencies: ${JSON.stringify(declared)}`)
  for (const id of args.which) {
    const state = states[id]
    say(`  ${id}: ${state}`)
    const record = results.find((result) => result.id === id)
    if (record) {
      record.managerState = state
      if (state !== 'installed') record.ok = false
    }
  }
  const unmanaged = results.filter((result) => result.managerState !== 'installed')

  const report = {
    ok: failed.length === 0 && unmanaged.length === 0,
    profile: args.profile,
    dshHome: args.keep ? dshHome : null,
    ranAt: new Date().toISOString(),
    profileDependencies: declared,
    results
  }
  if (args.report) {
    fs.writeFileSync(args.report, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    say(`\nreport: ${args.report}`)
  }
  if (args.json) process.stdout.write(`${JSON.stringify(report)}\n`)

  say('')
  say('Recognised is not running: the plugin\'s browser half renders inside the Harness, and whether it does')
  say('is the manual UI review\'s answer (docs/pluginize.md). Peers listed as missing are absent from this')
  say('machine\'s module roots; whether the Harness supplies them at load time is that review\'s business too.')

  if (!args.keep) {
    fs.rmSync(dshHome, { recursive: true, force: true })
  } else {
    say(`the throwaway profile was kept at ${dshHome}`)
  }
  void BUNDLED_MANIFEST
  return failed.length === 0 && unmanaged.length === 0 ? 0 : 1
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code })
    .catch((error) => {
      process.stderr.write(`installer-community-acceptance failed: ${error && error.stack ? error.stack : error}\n`)
      process.exitCode = 1
    })
}

module.exports = { parseArgs, main, ensurePnpm }
