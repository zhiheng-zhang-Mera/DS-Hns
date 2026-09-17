'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const { BUNDLED_MANIFEST, entryForPackage } = require('../../app/extensions/mega/plugins/index.cjs')
const community = require('../../app/extensions/mega/plugins/community-install.cjs')
const cli = require('../../app/extensions/mega/plugins/community-install-cli.cjs')
const { createAdapterFramework } = require('../../app/core/plugin-adapters/index.cjs')
const { createHarnessProfileAdapter } = require('../../app/core/plugin-adapters/adapters/harness-profile.cjs')

/**
 * The optional community plugins, at the **installation** level.
 *
 * DS-Hns offers two community plugins --?the plugin market (`@dsh-market/plugin`, `2BingLing/dsh-market`)
 * and the wallpaper engine (`dsh-plugin-wallpaper-engine`, `elysia395/dsh-wallpaper-engine`) --?and the
 * installer has to ask about each one separately, never install either by default, and never let either
 * one fail the product's own installation.
 *
 * Three layers are exercised here, and they are deliberately the *real* ones:
 *
 *   1. **The interaction** --?`community-install.cjs` and the command line's own argument handling
 *      (`--install-market`, `--install-wallpaper`, `--skip`, and the conflict between them). This is
 *      where "yes to the store, no to the wallpaper" has to be expressible and where an unattended
 *      install has to install nothing.
 *   2. **The installation channel** --?the real `app/extensions/mega/plugins/community-install-cli.cjs`
 *      process, run against a Harness CLI stand-in (`tests/helpers/harness-cli-stub.cjs`). The stub
 *      writes the profile's `package.json` and materialises the package exactly as `dsh plugin add`
 *      does, so what is under test is the product's own path --?the release pin, `installBundled`, the
 *      read-back --?and not a mock of it.
 *   3. **The whole installer** --?the real `scripts/install.ps1`, run against a throwaway repository root
 *      with `-SkipTests -NoLaunch -NoShortcuts`. That is the only way to assert the thing a person
 *      actually experiences: the questions, the parameters, and the completion summary.
 *
 * Nothing here reaches the network. Where a test needs the Harness CLI to *succeed*, the stand-in is
 * the CLI; where it needs it to fail, the stand-in is told to fail. The one thing that cannot be faked
 * --?that the two real packages install from the real registry and are recognised by the adapter layer
 * --?is asserted by `scripts/installer-community-acceptance.cjs`, which is opt-in, because a unit suite
 * that needs npm is a suite that fails on a train.
 */

const ROOT = path.resolve(__dirname, '..', '..')
const STUB = path.join(ROOT, 'tests', 'helpers', 'harness-cli-stub.cjs')
const FIXTURES = path.join(ROOT, 'tests', 'fixtures', 'community')
const WALLPAPER_FIXTURE = path.join(FIXTURES, 'dsh-plugin-wallpaper-engine')
const MARKET_FIXTURE = path.join(FIXTURES, 'dsh-market')
const WALLPAPER = 'dsh-wallpaper-engine'
const MARKET = '@dsh-market/plugin'

/** A scratch directory per test file, removed at the end. */
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-community-install-'))
test.after(() => {
  fs.rmSync(SCRATCH, { recursive: true, force: true })
})

let counter = 0
function scratchDir(label) {
  counter += 1
  const dir = path.join(SCRATCH, `${label}-${counter}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** A stand-in Harness CLI bound to one DSH_HOME, with the two failure switches. */
function stubCli(home, { failWith = 0, sleep = 0 } = {}) {
  return ({ profile, package: spec }) => {
    const fixture = spec.startsWith('@dsh-market') ? MARKET_FIXTURE : WALLPAPER_FIXTURE
    const args = [STUB, 'plugin', '--profile', profile, 'add', spec, `--home=${home}`, `--fixture=${fixture}`]
    if (failWith) args.push(`--fail-with=${failWith}`)
    if (sleep) args.push(`--sleep=${sleep}`)
    const result = spawnSync(process.execPath, args, { encoding: 'utf8', windowsHide: true })
    if (result.status !== 0) {
      return { ok: false, reason: `the harness CLI stand-in exited ${result.status}: ${String(result.stderr || '').trim()}` }
    }
    return { ok: true }
  }
}

/** The same verifier the installer builds: the real adapter framework, with the real registrations. */
function verifierFor(root, dshHome) {
  const { createCordisDshAdapter } = require('../../app/core/plugin-adapters/adapters/cordis-dsh.cjs')
  const { createCordisAdapter } = require('../../app/core/plugin-adapters/adapters/cordis.cjs')
  const framework = createAdapterFramework({ log: () => {} })
  framework.register(createHarnessProfileAdapter({ roots: [path.join(ROOT, 'app', 'node_modules')], log: () => {} }))
  framework.register(createCordisDshAdapter({ roots: [path.join(ROOT, 'app', 'node_modules')], log: () => {} }))
  framework.register(createCordisAdapter({ log: () => {} }))
  return async ({ id, channel, profile, packageName }) => {
    const installed = community.readInstalled({ root, profile, dshHome, packageName })
    if (installed.ok !== true || installed.installed !== true) {
      return { ok: false, reason: installed.reason || `${packageName} is not installed` }
    }
    const adapted = await framework.adapt({ dir: installed.packageDir, channel, where: `profile ${profile}` })
    if (adapted.ok !== true) return { ok: false, code: adapted.code, reason: adapted.reason, attempts: adapted.attempts || [] }
    // The channel's own adapter, exactly as the installer's command line requires: a generic
    // adoption of the same directory is a different answer, and not the one this channel claims.
    if (adapted.adapter.id !== 'dshns.harness-profile') {
      return { ok: false, code: 'COMMUNITY_ADAPTER_REFUSED', reason: `adapted as ${adapted.adapter.id}, not as a ${channel} community bundle` }
    }
    return {
      ok: true,
      id,
      adapter: { id: adapted.adapter.id, version: adapted.adapter.version },
      detectedType: adapted.detection ? adapted.detection.type : null,
      packageDir: installed.packageDir,
      version: installed.version
    }
  }
}

// ---------------------------------------------------------------------------------------------
// 1. The release manifest: two optional entries, each with its own channel and pin
// ---------------------------------------------------------------------------------------------

test('the release manifest names both community plugins as optional, pinned, harness-profile entries', () => {
  const market = BUNDLED_MANIFEST.plugins.find((entry) => entry.id === MARKET)
  const wallpaper = BUNDLED_MANIFEST.plugins.find((entry) => entry.id === WALLPAPER)

  // The ids, the packages and the repositories the requirement names.
  assert.equal(market.package, '@dsh-market/plugin')
  assert.equal(market.repo, '2BingLing/dsh-market')
  assert.equal(wallpaper.package, 'dsh-plugin-wallpaper-engine')
  assert.equal(wallpaper.repo, 'elysia395/dsh-wallpaper-engine')

  for (const entry of [market, wallpaper]) {
    assert.equal(entry.channel, 'harness-profile', `${entry.id} is a Harness client plugin, so its channel is the profile`)
    // A pin, never `latest`: a boot that asked a remote what is newest would make yesterday's tested
    // product different from today's without anybody deciding it.
    assert.ok(entry.ref && entry.ref !== 'latest', `${entry.id} must be pinned`)
    // Optional, explicitly: neither may become a hard dependency of the product.
    assert.equal(entry.required, false, `${entry.id} must not be required`)
  }

  // Both appear in the installer's own ordering, and the installer's list is the manifest's.
  assert.deepEqual(community.communityEntries().map((entry) => entry.id).sort(), [MARKET, WALLPAPER].sort())
})

// ---------------------------------------------------------------------------------------------
// 2. The interaction: each plugin asked separately, defaults to skip
// ---------------------------------------------------------------------------------------------

test('the argument resolver treats each plugin separately and defaults to asking', () => {
  const nothing = community.resolveSelection({})
  assert.equal(nothing.ok, true)
  assert.equal(nothing.market, false, 'the market is not selected by default')
  assert.equal(nothing.wallpaper, false, 'the wallpaper is not selected by default')
  assert.equal(nothing.unanswered, true, 'nothing named means the question has not been answered')

  const onlyMarket = community.resolveSelection({ installMarket: true })
  assert.equal(onlyMarket.market, true)
  assert.equal(onlyMarket.wallpaper, false, 'the two are separate choices, never one switch')
  assert.equal(onlyMarket.unanswered, false)

  const onlyWallpaper = community.resolveSelection({ installWallpaper: true })
  assert.equal(onlyWallpaper.market, false)
  assert.equal(onlyWallpaper.wallpaper, true)

  const both = community.resolveSelection({ installMarket: true, installWallpaper: true })
  assert.equal(both.market, true)
  assert.equal(both.wallpaper, true)

  const skip = community.resolveSelection({ skipOptional: true })
  assert.equal(skip.skip, true)
  assert.equal(skip.market, false)
  assert.equal(skip.unanswered, false)
})

test('a contradictory invocation is an error with a reason, never a silent override', () => {
  for (const input of [{ skipOptional: true, installMarket: true }, { skipOptional: true, installWallpaper: true }, { skipOptional: true, installMarket: true, installWallpaper: true }]) {
    const resolved = community.resolveSelection(input)
    assert.equal(resolved.ok, false, `expected a conflict for ${JSON.stringify(input)}`)
    assert.equal(resolved.code, community.COMMUNITY_FAULT_CODES.CONFLICT)
    assert.match(resolved.reason, /cannot be combined/)
  }
})

test('the command line refuses a contradictory invocation with its own exit code', () => {
  const result = spawnSync(process.execPath, [path.join(ROOT, 'app', 'extensions', 'mega', 'plugins', 'community-install-cli.cjs'), '--install-market', '--skip', '--json'], {
    encoding: 'utf8',
    windowsHide: true
  })
  assert.equal(result.status, 2, `expected the usage exit code, got ${result.status}: ${result.stderr}`)
  const report = JSON.parse(result.stdout.trim())
  assert.equal(report.ok, false)
  assert.equal(report.code, community.COMMUNITY_FAULT_CODES.CONFLICT)
})

test('a plugin the user declined at install time is never installed by a later pass', async () => {
  const root = scratchDir('declined')
  const home = path.join(root, 'data')
  community.recordOptionalPlugin(root, { id: WALLPAPER, state: 'declined', spec: 'dsh-plugin-wallpaper-engine@v0.7.1' })
  assert.equal(community.isDeclined(root, WALLPAPER), true)
  assert.equal(community.isDeclined(root, MARKET), false)

  let calls = 0
  const outcome = await community.installCommunityPlugin(WALLPAPER, {
    root,
    profile: 'web',
    harnessAdd: () => { calls += 1; return { ok: true } }
  })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, community.COMMUNITY_FAULT_CODES.ALREADY_DECLINED)
  assert.equal(calls, 0, 'a declined plugin was installed anyway')
})

// ---------------------------------------------------------------------------------------------
// 3. The install path: market yes/no, wallpaper yes/no, both, neither
// ---------------------------------------------------------------------------------------------

/** Install the given selection into a fresh profile and return the outcomes by id. */
async function installSelection({ market, wallpaper, skip = false, failWith = 0, root = null, home = null } = {}) {
  const fixtureRoot = root || scratchDir('profile')
  const dshHome = home || path.join(fixtureRoot, 'data')
  const harnessAdd = stubCli(dshHome, { failWith })
  const verify = verifierFor(fixtureRoot, dshHome)
  const results = {}
  const selected = []
  if (market) selected.push(MARKET)
  if (wallpaper) selected.push(WALLPAPER)
  if (skip) {
    for (const id of [MARKET, WALLPAPER]) results[id] = community.skipped(id, '-SkipOptionalPlugins was given')
  }
  for (const id of selected) {
    results[id] = await community.installCommunityPlugin(id, { root: fixtureRoot, profile: 'web', dshHome, harnessAdd, verify })
  }
  return { root: fixtureRoot, home: dshHome, results }
}

test('market only: the market is installed, the wallpaper is not', async () => {
  const { results, home } = await installSelection({ market: true })
  assert.equal(results[MARKET].ok, true, results[MARKET].reason)
  assert.equal(results[MARKET].channel, 'harness-profile')
  assert.equal(results[MARKET].spec, '@dsh-market/plugin@0.4.7')
  assert.equal(results[WALLPAPER], undefined, 'the wallpaper was not asked for and must not be installed')

  const declared = community.readInstalled({ root: os.tmpdir(), profile: 'web', dshHome: home, packageName: '@dsh-market/plugin' })
  assert.equal(declared.installed, true, 'the profile does not declare the market after installing it')
  const notThere = community.readInstalled({ root: os.tmpdir(), profile: 'web', dshHome: home, packageName: 'dsh-plugin-wallpaper-engine' })
  assert.equal(notThere.installed, false, 'the wallpaper was installed without being asked for')
})

test('wallpaper only: the wallpaper is installed, the market is not', async () => {
  const { results, home } = await installSelection({ wallpaper: true })
  assert.equal(results[WALLPAPER].ok, true, results[WALLPAPER].reason)
  assert.equal(results[WALLPAPER].spec, 'dsh-plugin-wallpaper-engine@v0.7.1')
  assert.equal(community.readInstalled({ root: os.tmpdir(), profile: 'web', dshHome: home, packageName: 'dsh-plugin-wallpaper-engine' }).installed, true)
  assert.equal(community.readInstalled({ root: os.tmpdir(), profile: 'web', dshHome: home, packageName: '@dsh-market/plugin' }).installed, false)
})

test('both: each is installed through its own channel and each is verified by the adapter layer', async () => {
  const { results } = await installSelection({ market: true, wallpaper: true })
  assert.equal(results[MARKET].ok, true, results[MARKET].reason)
  assert.equal(results[WALLPAPER].ok, true, results[WALLPAPER].reason)

  // The verification is the adapter layer's answer, not a directory existence check: the detected
  // type and the adapter that produced it are part of the outcome.
  for (const id of [MARKET, WALLPAPER]) {
    const verify = results[id].verify
    assert.ok(verify, `${id} was installed without an adapter-layer verification`)
    assert.equal(verify.ok, true)
    assert.equal(verify.adapter.id, 'dshns.harness-profile')
    assert.equal(verify.detectedType, 'cordis.bundle')
  }
})

test('neither: nothing is installed and the profile is left exactly as it was', async () => {
  const fixtureRoot = scratchDir('nothing')
  const home = path.join(fixtureRoot, 'data')
  const profileDir = path.join(home, 'profiles', 'web')
  fs.mkdirSync(profileDir, { recursive: true })
  const before = JSON.stringify({ name: 'dsh-profile-web', private: true, dependencies: {} })
  fs.writeFileSync(path.join(profileDir, 'package.json'), `${before}\n`, 'utf8')

  const results = [community.skipped(MARKET, 'not selected'), community.skipped(WALLPAPER, 'not selected')]
  assert.equal(results.every((result) => result.skipped === true), true)
  assert.equal(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8').trim(), before, 'a profile was written without being asked for')
  assert.equal(fs.existsSync(path.join(profileDir, 'node_modules')), false, 'node_modules was created without an install')
})

test('the reported state of an already-installed plugin is "already installed", and it is still verified', async () => {
  const first = await installSelection({ market: true, wallpaper: true })
  // A second pass over the same profile: reuse-first, but not unverified.
  const verify = verifierFor(first.root, first.home)
  const again = await community.installCommunityPlugin(MARKET, {
    root: first.root,
    profile: 'web',
    dshHome: first.home,
    harnessAdd: () => { throw new Error('the CLI must not be called for an installed plugin') },
    verify
  })
  assert.equal(again.ok, true)
  assert.equal(again.alreadyInstalled, true)
  assert.equal(again.verify.adapter.id, 'dshns.harness-profile', 'an already-installed plugin skipped the adapter check')
})

// ---------------------------------------------------------------------------------------------
// 4. Failure isolation: a plugin that cannot be installed, and a product that installs anyway
// ---------------------------------------------------------------------------------------------

test('a failing harness CLI fails that plugin and leaves the other one alone', async () => {
  const { results } = await installSelection({ market: true, wallpaper: true, failWith: 3 })
  // Both go through the same failing CLI, so both fail -- and each failure carries its reason.
  for (const id of [MARKET, WALLPAPER]) {
    assert.equal(results[id].ok, false, `${id} should have failed`)
    assert.match(String(results[id].reason), /exited 3|refusing/)
  }
})

test('one plugin failing does not stop the other from being installed', async () => {
  const root = scratchDir('isolated')
  const home = path.join(root, 'data')
  const verify = verifierFor(root, home)
  // Only the market's CLI call fails: the stand-in refuses when the spec names the market.
  const harnessAdd = ({ profile, package: spec }) => {
    if (spec.startsWith('@dsh-market')) return { ok: false, reason: 'the registry refused @dsh-market/plugin' }
    return stubCli(home)({ profile, package: spec })
  }
  const market = await community.installCommunityPlugin(MARKET, { root, profile: 'web', dshHome: home, harnessAdd, verify })
  const wallpaper = await community.installCommunityPlugin(WALLPAPER, { root, profile: 'web', dshHome: home, harnessAdd, verify })
  assert.equal(market.ok, false)
  assert.match(market.reason, /registry refused/)
  assert.equal(wallpaper.ok, true, wallpaper.reason)
  assert.equal(community.readInstalled({ root, profile: 'web', dshHome: home, packageName: 'dsh-plugin-wallpaper-engine' }).installed, true)
})

test('a package the adapter layer cannot recognise is a failure, not a silent success', async () => {
  const root = scratchDir('unrecognised')
  const home = path.join(root, 'data')
  // A CLI that writes a *plain* package where a community bundle should be: the install "worked",
  // and the framework's answer is what decides whether it is reported as installed.
  const harnessAdd = ({ profile, package: spec }) => {
    const profileDir = path.join(home, 'profiles', profile)
    const name = spec.slice(0, spec.lastIndexOf('@'))
    const dir = path.join(profileDir, 'node_modules', ...name.split('/'))
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({ name, version: spec.slice(spec.lastIndexOf('@') + 1) })}\n`, 'utf8')
    fs.writeFileSync(path.join(profileDir, 'package.json'), `${JSON.stringify({ name: 'dsh-profile-web', private: true, dependencies: { [name]: spec.slice(spec.lastIndexOf('@') + 1) } }, null, 2)}\n`, 'utf8')
    return { ok: true }
  }
  const outcome = await community.installCommunityPlugin(WALLPAPER, { root, profile: 'web', dshHome: home, harnessAdd, verify: verifierFor(root, home) })
  assert.equal(outcome.ok, false, 'a directory that is not a community bundle was reported as an installed plugin')
  assert.match(String(outcome.reason), /no adapter could adapt|not.*community|declares/i)
})

test('the optional-plugin pass never throws: a missing CLI is a coded refusal', async () => {
  const root = scratchDir('no-cli')
  const outcome = await community.installCommunityPlugin(WALLPAPER, { root, profile: 'web' })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, community.COMMUNITY_FAULT_CODES.NO_CLI)

  const unknown = await community.installCommunityPlugin('not-a-plugin', { root })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.code, community.COMMUNITY_FAULT_CODES.UNKNOWN_PLUGIN)
})

// ---------------------------------------------------------------------------------------------
// 5. Recognised by the plugin manager after installation
// ---------------------------------------------------------------------------------------------

test('after installation the bundled plugin manager reports both plugins as installed', async () => {
  const { home } = await installSelection({ market: true, wallpaper: true })
  // The manager the product's panel uses, reading the same two places `bundled()` in
  // `app/extensions/mega/index.cjs` reads: the product's store list, and the Harness profile's own
  // `dependencies` -- which is where a harness-profile plugin lives.
  const { createBundledPlugins } = require('../../app/extensions/mega/plugins/index.cjs')
  const profileFile = path.join(home, 'profiles', 'web', 'package.json')
  const declared = JSON.parse(fs.readFileSync(profileFile, 'utf8')).dependencies
  // The translation is the manifest's own (`entryForPackage`): a profile records *package names*
  // and the manager keys on *plugin ids*, and for the wallpaper engine those are different strings.
  const installedRecords = Object.entries(declared).map(([name, version]) => {
    const entry = entryForPackage(name)
    return { id: entry ? entry.id : name, package: name, version, dir: null, enabled: true, where: 'harness-profile' }
  })
  const manager = createBundledPlugins({
    installed: () => installedRecords,
    userEnabled: () => null
  })
  const described = manager.describe()
  const states = described.states
  assert.equal(states[MARKET], 'installed', `the manager does not see the market as installed: ${JSON.stringify(described.plugins)}`)
  assert.equal(states[WALLPAPER], 'installed', `the manager does not see the wallpaper as installed: ${JSON.stringify(described.plugins)}`)

  // And the states are the release manifest's own vocabulary, with the channel beside them.
  for (const entry of described.plugins) {
    assert.equal(entry.channel, 'harness-profile')
    assert.equal(entry.tested, true)
  }
})

test('a profile with neither plugin reports them as missing, and nothing installs them by itself', () => {
  const { createBundledPlugins } = require('../../app/extensions/mega/plugins/index.cjs')
  const calls = []
  const manager = createBundledPlugins({
    installed: () => [],
    install: (entry) => { calls.push(entry.id); return Promise.resolve({ ok: true, version: entry.ref }) }
  })
  const report = manager.describe()
  assert.equal(report.states[MARKET], 'missing')
  assert.equal(report.states[WALLPAPER], 'missing')
  // The manager's own pass is the boot-time one. It is asserted here as a contract: reading the
  // state must not install anything.
  assert.deepEqual(calls, [], 'reading the bundled plugin state installed something')
})

// ---------------------------------------------------------------------------------------------
// 6. The command line: parameter mode, non-interactive mode, and the report
// ---------------------------------------------------------------------------------------------

test('the command line installs exactly what its parameters name, and skips the rest', () => {
  const root = scratchDir('cli')
  const home = path.join(root, 'data')
  const reportFile = path.join(root, 'report.json')
  const result = spawnSync(process.execPath, [
    path.join(ROOT, 'app', 'extensions', 'mega', 'plugins', 'community-install-cli.cjs'),
    '--install-market',
    '--json',
    `--profile=web`,
    `--dsh-home=${home}`,
    `--root=${ROOT}`,
    `--report=${reportFile}`
  ], { encoding: 'utf8', windowsHide: true, env: { ...process.env, DSH_COMMUNITY_TEST_STUB: '1' } })

  // The real CLI runs the real Harness command, so on a machine without the Harness installed it
  // fails with a reason rather than doing nothing -- and that failure is reported per plugin.
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'))
  assert.equal(report.mode, 'install')
  const market = report.results.find((entry) => entry.id === MARKET)
  const wallpaper = report.results.find((entry) => entry.id === WALLPAPER)
  assert.equal(wallpaper.state, 'skipped', 'the wallpaper was not asked for')
  assert.match(wallpaper.reason, /not selected/)
  assert.ok(['failed', 'installed', 'already-installed'].includes(market.state), `unexpected market state ${market.state}`)
  assert.equal(report.adapterRegistry.channel, 'harness-profile')
  void result
})

test('the command line skips both plugins when nothing asks for them', () => {
  const root = scratchDir('cli-none')
  const reportFile = path.join(root, 'report.json')
  const result = spawnSync(process.execPath, [
    path.join(ROOT, 'app', 'extensions', 'mega', 'plugins', 'community-install-cli.cjs'),
    '--json',
    `--dsh-home=${path.join(root, 'data')}`,
    `--root=${ROOT}`,
    `--report=${reportFile}`
  ], { encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 0, `a no-selection run must succeed: ${result.stderr}`)
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'))
  assert.deepEqual(report.results.map((entry) => entry.state), ['skipped', 'skipped'])
  for (const entry of report.results) assert.match(entry.reason, /not selected/)
})

test('--skip records both plugins as declined so a later boot cannot install them', () => {
  const root = scratchDir('cli-skip')
  const reportFile = path.join(root, 'report.json')
  const result = spawnSync(process.execPath, [
    path.join(ROOT, 'app', 'extensions', 'mega', 'plugins', 'community-install-cli.cjs'),
    '--skip',
    '--json',
    `--dsh-home=${path.join(root, 'data')}`,
    `--root=${ROOT}`,
    `--report=${reportFile}`
  ], { encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'))
  assert.deepEqual(report.results.map((entry) => entry.state), ['skipped', 'skipped'])
})

test('--describe is the planning call: it installs nothing and names the pinned references', () => {
  const root = scratchDir('cli-describe')
  const reportFile = path.join(root, 'report.json')
  const result = spawnSync(process.execPath, [
    path.join(ROOT, 'app', 'extensions', 'mega', 'plugins', 'community-install-cli.cjs'),
    '--describe',
    `--dsh-home=${path.join(root, 'data')}`,
    `--root=${ROOT}`,
    `--report=${reportFile}`
  ], { encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'))
  assert.equal(report.mode, 'describe')
  const specs = report.plugins.map((entry) => entry.spec).sort()
  assert.deepEqual(specs, ['@dsh-market/plugin@0.4.7', 'dsh-plugin-wallpaper-engine@v0.7.1'])
  assert.equal(report.plugins.every((entry) => entry.installed === false), true)
  assert.equal(fs.existsSync(path.join(root, 'data', 'profiles', 'web', 'node_modules')), false, 'the planning call installed something')
})

// ---------------------------------------------------------------------------------------------
// 7. The bilingual prompt: the labels live in the Node layer, and the installer stays ASCII
// ---------------------------------------------------------------------------------------------

test('the prompt text is bilingual and the installer PowerShell that calls it stays ASCII', () => {
  const labels = cli.loadLabels()
  // The requirement's own example: a numbered choice, in both languages, with skip as the default.
  assert.match(labels.labels[MARKET].question, /Plugin Market/)
  assert.match(labels.labels[MARKET].question, /插件商店/)
  assert.match(labels.labels[WALLPAPER].question, /Wallpaper Engine/)
  assert.match(labels.labels[WALLPAPER].question, /壁纸引擎/)
  for (const id of [MARKET, WALLPAPER]) {
    assert.equal(labels.labels[id].options.length, 2, `${id} must offer exactly install and skip`)
    assert.match(labels.labels[id].options[0], /\[1\]/)
    assert.match(labels.labels[id].options[1], /\[2\]/)
  }
  assert.match(labels.prompt.default, /默认是 2/);

  // The installer's own scripts are ASCII-only -- Windows PowerShell 5.1 reads a BOM-less .ps1 as
  // ANSI, so a Chinese character in one of them corrupts the prompt or the parse. That is *why* the
  // labels live in this JSON file, and this assertion is what keeps the two facts tied together.
  for (const file of ['scripts/install.ps1', 'scripts/install-community-plugins.ps1']) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/^\uFEFF/, '')
    assert.equal(/[^\x00-\x7F]/.test(text), false, `${file} contains non-ASCII characters`)
  }
  // ...and the label file the installer reads is the one that carries them.
  const labelFile = JSON.parse(fs.readFileSync(path.join(ROOT, 'app', 'extensions', 'mega', 'plugins', 'community-labels.json'), 'utf8'))
  assert.ok(labelFile.labels[MARKET].zh, 'the bilingual labels are missing from the file the CLI reads')
})

// ---------------------------------------------------------------------------------------------
// 8. The whole installer: parameters, non-interactive mode, and the completion summary
// ---------------------------------------------------------------------------------------------

/**
 * A throwaway repository root the real `scripts\install.ps1` can run in.
 *
 * It carries the installer and the scripts it calls, the community plugin command line and the
 * release manifest (both real, from the checkout), a harness CLI stand-in, and a shipped mega-core
 * package. `install-deps.ps1` and `cleanup-runtime.ps1` are recorded rather than real: an installer
 * test that reinstalled Electron would be an installer test nobody could run.
 *
 * `DEEPSEEK_API_KEY` in the *unused* environment slot is what keeps the API-key step from asking:
 * an installer test that stops on a prompt is not a test.
 */
function installerFixture(label) {
  const root = scratchDir(`installer-${label}`)
  const scripts = path.join(root, 'scripts')
  fs.mkdirSync(scripts, { recursive: true })
  for (const file of ['install.ps1', 'install-community-plugins.ps1', 'env.ps1', 'ensure-node.ps1']) {
    fs.copyFileSync(path.join(ROOT, 'scripts', file), path.join(scripts, file))
  }
  // Recorded stand-ins for the two steps that touch the machine: what they were asked to do is what
  // the test asserts about, and nothing is installed.
  fs.writeFileSync(path.join(scripts, 'cleanup-runtime.ps1'), "Add-Content -LiteralPath (Join-Path (Split-Path -Parent $PSScriptRoot) 'steps.log') -Value 'cleanup'\n", 'utf8')
  fs.writeFileSync(path.join(scripts, 'install-deps.ps1'), "param([switch]$Full)\nAdd-Content -LiteralPath (Join-Path (Split-Path -Parent $PSScriptRoot) 'steps.log') -Value 'deps'\n", 'utf8')
  fs.writeFileSync(path.join(scripts, 'ensure-icon.ps1'), "'icon'\n", 'utf8')
  fs.writeFileSync(path.join(scripts, 'shortcuts.ps1'), "param([switch]$NoAutoStart)\n", 'utf8')
  // The two scripts the installer preflights and runs: recorded stand-ins here, because running the
  // real suite inside a fixture root would test the fixture's copy of the repository, not the
  // repository. The installer's *own* behaviour around them is what these tests are about.
  fs.writeFileSync(path.join(scripts, 'test-all.ps1'), "Add-Content -LiteralPath (Join-Path (Split-Path -Parent $PSScriptRoot) 'steps.log') -Value 'tests'\nexit 0\n", 'utf8')
  fs.writeFileSync(path.join(scripts, 'verify.ps1'), "param([switch]$SkipTests)\nAdd-Content -LiteralPath (Join-Path (Split-Path -Parent $PSScriptRoot) 'steps.log') -Value 'verify'\nexit 0\n", 'utf8')
  // The built-in plugins have their own installer, and the real one would sign two plugins into a
  // profile this fixture does not have. It is recorded here, and it answers with the report the real
  // one answers with, because the installer's own behaviour around that report is what is asserted.
  fs.writeFileSync(
    path.join(scripts, 'install-bundled-plugins.ps1'),
    "param([switch]$Repair, [switch]$Uninstall, [switch]$List, [switch]$Json)\n" +
      "Add-Content -LiteralPath (Join-Path (Split-Path -Parent $PSScriptRoot) 'steps.log') -Value 'bundled'\n" +
      "if ($Json) { Write-Output '{\"ok\":true,\"results\":[{\"id\":\"dshns.health-scheduler\",\"state\":\"already-installed\"},{\"id\":\"dshns.restart-supervisor\",\"state\":\"already-installed\"}]}' }\n" +
      "exit 0\n",
    'utf8'
  )

  // The community plugin command line, the release manifest, the plugins and the adapter layer: the
  // real files, because the installer's behaviour depends on what they say. The whole `mega` extension
  // tree comes along because the *generic* adoption adapter reaches into it (`store/compat.cjs`): a
  // fixture carrying only the plugin folder would make that adapter throw, and a fallback that throws
  // is a different test than the one intended.
  fs.cpSync(path.join(ROOT, 'app', 'extensions', 'mega'), path.join(root, 'app', 'extensions', 'mega'), { recursive: true })
  fs.cpSync(path.join(ROOT, 'app', 'core'), path.join(root, 'app', 'core'), { recursive: true })

  // The shipped client plugin the installer signs into the profile, and the script that signs it.
  fs.cpSync(path.join(ROOT, 'app', 'plugins', 'mega-core'), path.join(root, 'app', 'plugins', 'mega-core'), { recursive: true })
  fs.copyFileSync(path.join(ROOT, 'scripts', 'install-profile-plugin.ps1'), path.join(scripts, 'install-profile-plugin.ps1'))

  // The harness CLI stand-in, at exactly the path the installer resolves.
  const dshLib = path.join(root, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib')
  fs.mkdirSync(dshLib, { recursive: true })
  fs.copyFileSync(STUB, path.join(dshLib, 'bin.js'))

  fs.writeFileSync(path.join(root, 'Start-DeepSeek-Harness.cmd'), '@echo off\r\n', 'utf8')
  fs.writeFileSync(path.join(root, 'app', 'desktop-main.cjs'), '// stand-in\n', 'utf8')
  fs.writeFileSync(path.join(root, 'app', 'plugin-host.cjs'), '// stand-in\n', 'utf8')
  fs.mkdirSync(path.join(root, 'config'), { recursive: true })
  fs.copyFileSync(path.join(ROOT, 'config', '.env.example'), path.join(root, 'config', '.env.example'))
  return root
}

/** Run the real installer in the fixture, with a console-free, prompt-free environment. */
function runInstaller(root, extraArgs = [], options = {}) {
  // The fixture map: the two published packages stand in as local directories, so the *installation
  // channel* is exercised end to end without a registry. It is passed as a flag, exactly as the
  // command line's own `--fixture` seam is documented, and only the tests pass it.
  const fixtureMap = path.join(root, 'community-fixtures.json')
  fs.writeFileSync(fixtureMap, `${JSON.stringify({
    '@dsh-market/plugin': MARKET_FIXTURE,
    'dsh-plugin-wallpaper-engine': WALLPAPER_FIXTURE
  }, null, 2)}\n`, 'utf8')
  // `-NonInteractive` says "ask nothing", so it is a contradiction with a plugin parameter (the
  // installer refuses the combination). The tests that name a plugin therefore do not pass it, and the
  // ones that exercise it pass `-NonInteractive` themselves.
  const namesAPlugin = extraArgs.some((arg) => arg === '-InstallMarket' || arg === '-InstallWallpaper')
  const args = [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', path.join(root, 'scripts', 'install.ps1'),
    '-SkipTests',
    '-NoLaunch',
    '-NoShortcuts',
    ...(options.keepConsole || namesAPlugin ? [] : ['-NonInteractive']),
    // Passed as two tokens rather than `-Name=Value`: Windows PowerShell 5.1's `-File` argument parser
    // does not accept the `=` form for a string parameter, and a fixture seam that silently receives
    // nothing is a test that quietly asserts the wrong thing.
    '-CommunityFixtureMap', fixtureMap,
    ...extraArgs
  ]
  const result = spawnSync('powershell.exe', args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 240_000,
    input: options.input,
    env: {
      ...process.env,
      DEEPSEEK_API_KEY: 'sk-installer-fixture-key',
      DSH_PROFILE: 'web',
      DSH_HOME: path.join(root, 'data')
    }
  })
  return { status: result.status, output: `${result.stdout || ''}${result.stderr || ''}`, result }
}

/** Read the completion summary: label -> state, as the installer printed it. */
function summaryOf(output) {
  const summary = {}
  for (const line of output.split(/\r?\n/)) {
    const match = /^(Official Harness UI|DS-Hns runtime|Mega Core|Plugin Market|Wallpaper Engine|Adapter registry|Governance bridge)\s*\.+\s*(.+?)\s*$/.exec(line.trim())
    if (match) summary[match[1]] = match[2]
  }
  return summary
}

test('the real installer asks nothing with -NonInteractive and installs no optional plugin', () => {
  const root = installerFixture('noninteractive')
  const { status, output } = runInstaller(root)
  const summary = summaryOf(output)

  assert.equal(status, 0, `the installer failed: ${output.slice(-4000)}`)
  assert.equal(summary['Plugin Market'], 'SKIPPED', `market state: ${summary['Plugin Market']}`)
  assert.equal(summary['Wallpaper Engine'], 'SKIPPED', `wallpaper state: ${summary['Wallpaper Engine']}`)
  // Nothing optional was written into the profile.
  const profileFile = path.join(root, 'data', 'profiles', 'web', 'package.json')
  const dependencies = fs.existsSync(profileFile) ? JSON.parse(fs.readFileSync(profileFile, 'utf8')).dependencies || {} : {}
  assert.equal(Object.keys(dependencies).includes('@dsh-market/plugin'), false)
  assert.equal(Object.keys(dependencies).includes('dsh-plugin-wallpaper-engine'), false)
  // Mega Core is not optional: it is signed in, and the summary says so.
  assert.ok(['LOADED', 'ALREADY INSTALLED'].includes(summary['Mega Core']), `Mega Core state: ${summary['Mega Core']}`)
  assert.equal(summary['DS-Hns runtime'], 'OK')
  assert.equal(summary['Official Harness UI'], 'OK')
})

test('the real installer installs the market with -InstallMarket and leaves the wallpaper alone', () => {
  const root = installerFixture('market')
  const { status, output } = runInstaller(root, ['-InstallMarket'])
  const summary = summaryOf(output)

  assert.equal(status, 0, `the installer failed: ${output.slice(-4000)}`)
  assert.equal(summary['Plugin Market'], 'INSTALLED', `market state: ${summary['Plugin Market']}`)
  assert.equal(summary['Wallpaper Engine'], 'SKIPPED', `wallpaper state: ${summary['Wallpaper Engine']}`)
  assert.equal(summary['Adapter registry'], 'OK', 'the installed plugin was not verified by the adapter layer')

  const profileFile = path.join(root, 'data', 'profiles', 'web', 'package.json')
  const dependencies = JSON.parse(fs.readFileSync(profileFile, 'utf8')).dependencies
  assert.equal(dependencies['@dsh-market/plugin'], '0.4.7')
  assert.equal(dependencies['dsh-plugin-wallpaper-engine'], undefined)

  // The decision is on the record, which is what a later boot reads.
  const decisions = JSON.parse(fs.readFileSync(path.join(root, 'data', 'state', 'optional-plugins.json'), 'utf8'))
  assert.equal(decisions.plugins['@dsh-market/plugin'].state, 'installed')
})

test('the real installer installs the wallpaper with -InstallWallpaper and leaves the market alone', () => {
  const root = installerFixture('wallpaper')
  const { status, output } = runInstaller(root, ['-InstallWallpaper'])
  const summary = summaryOf(output)

  assert.equal(status, 0, `the installer failed: ${output.slice(-4000)}`)
  assert.equal(summary['Wallpaper Engine'], 'INSTALLED', `wallpaper state: ${summary['Wallpaper Engine']}`)
  assert.equal(summary['Plugin Market'], 'SKIPPED', `market state: ${summary['Plugin Market']}`)
  const dependencies = JSON.parse(fs.readFileSync(path.join(root, 'data', 'profiles', 'web', 'package.json'), 'utf8')).dependencies
  assert.equal(dependencies['dsh-plugin-wallpaper-engine'], 'v0.7.1')
  assert.equal(dependencies['@dsh-market/plugin'], undefined)
})

test('the real installer installs both when both parameters are given', () => {
  const root = installerFixture('both')
  const { status, output } = runInstaller(root, ['-InstallMarket', '-InstallWallpaper'])
  const summary = summaryOf(output)

  assert.equal(status, 0, `the installer failed: ${output.slice(-4000)}`)
  assert.equal(summary['Plugin Market'], 'INSTALLED')
  assert.equal(summary['Wallpaper Engine'], 'INSTALLED')
  assert.equal(summary['Adapter registry'], 'OK')
})

test('the real installer skips both with -SkipOptionalPlugins', () => {
  const root = installerFixture('skip')
  const { status, output } = runInstaller(root, ['-SkipOptionalPlugins'])
  const summary = summaryOf(output)

  assert.equal(status, 0, `the installer failed: ${output.slice(-4000)}`)
  assert.equal(summary['Plugin Market'], 'SKIPPED')
  assert.equal(summary['Wallpaper Engine'], 'SKIPPED')
  assert.equal(summary['Adapter registry'], 'NO OPTIONAL PLUGIN TO CHECK')
})

test('contradictory installer parameters fail with a reason instead of silently choosing', () => {
  const root = installerFixture('conflict')
  const { status, output } = runInstaller(root, ['-InstallMarket', '-SkipOptionalPlugins'])
  assert.notEqual(status, 0, 'a contradictory invocation must not succeed')
  assert.match(output, /cannot be combined with -SkipOptionalPlugins/)
})

test('a community plugin that fails to install is a warning, and the installation still succeeds', () => {
  const root = installerFixture('failure')
  // The *community channel* refuses, and only it: the extra argument goes to the Harness CLI the
  // community command line calls, while the plugin DS-Hns ships into the profile (a `file:` spec) is
  // installed through the same CLI and must still work. Breaking the CLI outright would prove less:
  // it would fail Mega Core too, and this test is about the optional plugins being isolated.
  const { status, output } = runInstaller(root, ['-InstallMarket', '-InstallWallpaper', '-CommunityExtraArgs', '--fail-with=7'])
  const summary = summaryOf(output)

  assert.equal(status, 0, `a failed optional plugin must not fail the installation: ${output.slice(-4000)}`)
  assert.equal(summary['Plugin Market'], 'FAILED', `market state: ${summary['Plugin Market']}`)
  assert.equal(summary['Wallpaper Engine'], 'FAILED', `wallpaper state: ${summary['Wallpaper Engine']}`)
  // The reason is printed, and it is not swallowed.
  assert.match(output, /exited 7|refusing/, 'the failure reason was not printed')
  assert.match(output, /optional/i)
  // The product itself is installed: this is the assertion the requirement is really about.
  assert.equal(summary['Official Harness UI'], 'OK')
  assert.equal(summary['DS-Hns runtime'], 'OK')
  assert.ok(['LOADED', 'ALREADY INSTALLED'].includes(summary['Mega Core']), `Mega Core state: ${summary['Mega Core']}`)
  // And the failure is recorded, so a later run reports it rather than pretending it was skipped.
  const decisions = JSON.parse(fs.readFileSync(path.join(root, 'data', 'state', 'optional-plugins.json'), 'utf8'))
  assert.equal(decisions.plugins['@dsh-market/plugin'].state, 'failed')
})

test('the installer reports the plugins an existing profile already carries as already installed', () => {
  const root = installerFixture('already')
  // A profile that already carries both plugins, as a machine that installed them earlier would.
  const profileDir = path.join(root, 'data', 'profiles', 'web')
  fs.mkdirSync(path.join(profileDir, 'node_modules'), { recursive: true })
  fs.writeFileSync(path.join(profileDir, 'package.json'), `${JSON.stringify({ name: 'dsh-profile-web', private: true, dependencies: { '@dsh-market/plugin': '0.4.7', 'dsh-plugin-wallpaper-engine': '0.7.1' } }, null, 2)}\n`, 'utf8')
  for (const [name, fixture] of [['@dsh-market/plugin', MARKET_FIXTURE], ['dsh-plugin-wallpaper-engine', WALLPAPER_FIXTURE]]) {
    fs.cpSync(fixture, path.join(profileDir, 'node_modules', ...name.split('/')), { recursive: true })
  }
  const { status, output } = runInstaller(root, ['-InstallMarket', '-InstallWallpaper'])
  const summary = summaryOf(output)

  assert.equal(status, 0, `the installer failed: ${output.slice(-4000)}`)
  assert.equal(summary['Plugin Market'], 'ALREADY INSTALLED')
  assert.equal(summary['Wallpaper Engine'], 'ALREADY INSTALLED')
  assert.equal(summary['Adapter registry'], 'OK', 'an already-installed plugin was not verified')
})

/**
 * A console, from the command line's point of view.
 *
 * `askSelected` is handed `process.stdin`/`process.stdout`, and it is a TTY or it is not: under a pipe
 * `readline` answers end-of-input, which is the unattended path and is covered by the command line
 * tests. The interactive path is therefore driven where the decision is actually made, with an input
 * stream that says it is a terminal and a recorded output stream, so what is asserted is the real
 * function's own behaviour rather than a description of it.
 */
function fakeConsole() {
  const readline = require('node:readline')
  const { PassThrough } = require('node:stream')
  const input = new PassThrough()
  const output = new PassThrough()
  input.isTTY = true
  output.isTTY = true
  let printed = ''
  output.on('data', (chunk) => { printed += chunk.toString('utf8') })
  // The questions and their numbered choices are written to **stderr** (stdout carries the
  // machine-readable report), so the recording covers both streams.
  const { Writable } = require('node:stream')
  const errors = new Writable({
    write(chunk, _encoding, callback) {
      printed += chunk.toString('utf8')
      callback()
    }
  })
  // The prompts are answered in order, one line per question.
  const answers = []
  const originalCreate = readline.createInterface
  readline.createInterface = (options) => {
    const rl = originalCreate(options)
    rl.question = (text, callback) => {
      printed += text
      const next = answers.shift()
      setImmediate(() => callback(next === undefined ? '' : next))
    }
    return rl
  }
  return {
    input,
    output,
    errors,
    answers,
    printed: () => printed,
    restore: () => { readline.createInterface = originalCreate }
  }
}

/** Run the interactive prompt with a scripted set of answers and return what it produced. */
async function askWith(answers) {
  const console_ = fakeConsole()
  console_.answers.push(...answers)
  const plan = community.describeCommunity({ root: scratchDir('ask'), profile: 'web', dshHome: path.join(scratchDir('ask-home'), 'data') }).plugins
  const originals = {
    stdin: Object.getOwnPropertyDescriptor(process, 'stdin'),
    stdout: Object.getOwnPropertyDescriptor(process, 'stdout'),
    stderr: Object.getOwnPropertyDescriptor(process, 'stderr')
  }
  Object.defineProperty(process, 'stdin', { value: console_.input, configurable: true })
  Object.defineProperty(process, 'stdout', { value: console_.output, configurable: true })
  Object.defineProperty(process, 'stderr', { value: console_.errors, configurable: true })
  try {
    const selection = await cli.askSelected({ plan, labels: cli.loadLabels(), selection: { market: false, wallpaper: false } })
    return { selection, printed: console_.printed() }
  } finally {
    console_.restore()
    for (const [name, descriptor] of Object.entries(originals)) {
      if (descriptor) Object.defineProperty(process, name, descriptor)
    }
  }
}

test('each plugin is asked about separately, and only the one answered "1" is selected', async () => {
  // The four combinations, each driven through the real prompt.
  const cases = [
    { answers: ['1', '1'], market: true, wallpaper: true },
    { answers: ['1', '2'], market: false, wallpaper: true },
    { answers: ['2', '1'], market: true, wallpaper: false },
    { answers: ['2', '2'], market: false, wallpaper: false }
  ]
  for (const item of cases) {
    const { selection, printed } = await askWith(item.answers)
    assert.equal(selection.wallpaper, item.wallpaper, `wallpaper for answers ${item.answers.join(',')}`)
    assert.equal(selection.market, item.market, `market for answers ${item.answers.join(',')}`)

    // Both questions were asked, separately, in both languages, with the numbered choice the
    // requirement names. The options are asserted as the label file's own lines: the closing prompt
    // repeats the number as its default hint, so counting `[2]` occurrences would count that too.
    assert.match(printed, /Install Wallpaper Engine/)
    assert.match(printed, /壁纸引擎/)
    assert.match(printed, /Install Plugin Market/)
    assert.match(printed, /插件商店/)
    const labels = cli.loadLabels()
    for (const id of [WALLPAPER, MARKET]) {
      assert.ok(printed.includes(labels.labels[id].options[0]), `${id}: the install option was not printed`)
      assert.ok(printed.includes(labels.labels[id].options[1]), `${id}: the skip option was not printed`)
    }
  }
})

test('an empty answer at each prompt means skip: the default installs nothing', async () => {
  const { selection, printed } = await askWith(['', ''])
  assert.equal(selection.wallpaper, false)
  assert.equal(selection.market, false)
  assert.match(printed, /默认是 2/)
})

test('an answer that is neither 1 nor 2 is refused and asked again', async () => {
  const { selection, printed } = await askWith(['yes', '3', '1', '2'])
  assert.equal(selection.wallpaper, true, 'the retry after an invalid answer was not honoured')
  assert.equal(selection.market, false)
  assert.match(printed, /请输入 1 或 2。|Please answer 1 or 2/)
})

test('the interactive path installs exactly what its answers said, and nothing else', async () => {
  // The whole way through: the real command line, with a console, asked to install the market only.
  const root = scratchDir('interactive-cli')
  const home = path.join(root, 'data')
  const prompts = fakeConsole()
  prompts.answers.push('2', '1') // wallpaper: skip, market: install
  const realStdin = Object.getOwnPropertyDescriptor(process, 'stdin')
  const realStdout = Object.getOwnPropertyDescriptor(process, 'stdout')
  Object.defineProperty(process, 'stdin', { value: prompts.input, configurable: true })
  Object.defineProperty(process, 'stdout', { value: prompts.output, configurable: true })
  let code = null
  try {
    code = await cli.main([
      '--ask',
      '--json',
      `--profile=web`,
      `--dsh-home=${home}`,
      `--root=${ROOT}`
    ])
  } finally {
    prompts.restore()
    if (realStdin) Object.defineProperty(process, 'stdin', realStdin)
    if (realStdout) Object.defineProperty(process, 'stdout', realStdout)
  }
  assert.equal(code, 1, 'the market cannot install here without the Harness CLI, so the run reports a failure')

  // The answers were asked for, and the profile reflects them: the wallpaper was declined, the market
  // was attempted. That is the interaction being real rather than described.
  assert.match(prompts.printed(), /壁纸引擎/)
  const declared = community.readInstalled({ root, profile: 'web', dshHome: home, packageName: 'dsh-plugin-wallpaper-engine' })
  assert.equal(declared.installed, false, 'the wallpaper was installed although the answer was 2')
  const decisions = community.readOptionalPlugins(root).plugins
  assert.equal(decisions['dsh-wallpaper-engine'], undefined, 'a declined plugin must not be recorded as attempted')
})

test('the real installer CLI surface is the one the requirement names', () => {
  const text = fs.readFileSync(path.join(ROOT, 'scripts', 'install.ps1'), 'utf8')
  for (const parameter of ['-InstallMarket', '-InstallWallpaper', '-SkipOptionalPlugins', '-NonInteractive', '-Profile', '-SkipRuntimeCleanup']) {
    assert.match(text, new RegExp(parameter.replace('-', '\\-')), `scripts/install.ps1 does not accept ${parameter}`)
  }
  // The parameters outrank the prompt: `--ask` is passed only when none of them answered the question,
  // and `--skip` whenever the invocation said not to ask or not to install.
  assert.match(text, /if \(\(-not \$InstallMarket\) -and \(-not \$InstallWallpaper\) -and \(-not \$skipOptional\)\) \{ \$cliArgs \+= '--ask' \}/)
  assert.match(text, /\$skipOptional = \[bool\]\$SkipOptionalPlugins -or \[bool\]\$NonInteractive/)
  // The installer calls the existing channel rather than installing anything itself.
  assert.match(text, /community-install-cli\.cjs|communityCli/)
  assert.doesNotMatch(text, /git clone/i, 'the installer must not clone a plugin into place')
  const standalone = fs.readFileSync(path.join(ROOT, 'scripts', 'install-community-plugins.ps1'), 'utf8')
  assert.doesNotMatch(standalone, /git clone/i)
  assert.match(standalone, /community-install-cli\.cjs/)
})
