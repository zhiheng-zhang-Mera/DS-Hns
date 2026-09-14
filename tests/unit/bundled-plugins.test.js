'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { createBundledPlugins, installBundled, removeBundled, BUNDLED_MANIFEST, BUNDLED_STATE } = require('../../app/extensions/mega/plugins/index.cjs')
const { createProtectionLayer, MODULE_STATE } = require('../../app/extensions/mega/protection/index.cjs')
const ROOT = path.resolve(__dirname, '..', '..')
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8')

/**
 * The Bundled Plugin Manager (`updateplan/startup2.md` §19-§23).
 *
 * The behaviour is a policy table, and the interesting entries are the ones that *do nothing*: an
 * untested reference is never installed, `latest` is never asked for, a healthy plugin is left alone,
 * a version the manifest does not know about is reported rather than replaced, and a plugin the user
 * disabled stays disabled.
 */

/** A manifest shaped like the shipped one, with the pin marked tested so the install path is reachable. */
const TESTED_MANIFEST = {
  version: 'test',
  plugins: [
    { id: 'dsh-wallpaper-engine', role: 'appearance', repo: 'elysia395/dsh-wallpaper-engine', ref: 'v0.7.1', commit: '4de97fc', tested: true, required: false },
    { id: '@dsh-market/plugin', role: 'plugin-store', repo: '2BingLing/dsh-market', ref: 'abc1234', commit: 'abc1234', tested: true, required: false }
  ]
}

function build({ manifest = BUNDLED_MANIFEST, installed = [], userEnabled = () => null, install = null, uninstall = null, compatibility = () => ({ ok: true }), protection = null } = {}) {
  const calls = []
  const manager = createBundledPlugins({
    manifest,
    installed: () => installed,
    userEnabled,
    install: install || (async (entry) => { calls.push({ action: 'install', ...entry }); return { ok: true, version: entry.ref } }),
    uninstall: uninstall || (async (id) => { calls.push({ action: 'uninstall', id }); return { ok: true } }),
    compatibility,
    protection,
    log: () => {}
  })
  return { manager, calls }
}

test('the shipped manifest pins real references and never says "latest"', () => {
  const ids = BUNDLED_MANIFEST.plugins.map((entry) => entry.id)
  assert.deepEqual(ids, ['dsh-wallpaper-engine', '@dsh-market/plugin'])
  for (const entry of BUNDLED_MANIFEST.plugins) {
    // A pin is a tag, a published version, or a commit — never "latest" (the assertion below says so).
    assert.match(entry.ref, /^(v?\d+\.\d+\.\d+|[0-9a-f]{7,40})$/, `${entry.id} is pinned to something that is not a tag, a version or a commit`)
    assert.equal(/latest/i.test(entry.ref), false)
    assert.equal(entry.required, false, `${entry.id} is bundled as required, which the plan does not allow`)
  }
  // The market publishes no tags, so its version *is* a commit — that is the point of pinning one.
  const market = BUNDLED_MANIFEST.plugins.find((entry) => entry.id === '@dsh-market/plugin')
  // Its *published* version is what a Harness profile installs (`pnpm add @dsh-market/plugin@0.4.7`), and the
  // repository commit stays recorded beside it so the source of that version is traceable.
  assert.equal(market.ref, '0.4.7')
  assert.match(market.commit, /^[0-9a-f]{7,40}$/, 'the repository commit must stay recorded beside the published version')
  // Each entry names the channel it can actually be installed through, read from the repository rather than
  // assumed: both are Harness *client* plugins (`dsh.client.platform: web`), installed by the Harness' own CLI.
  const wallpaper = BUNDLED_MANIFEST.plugins.find((entry) => entry.id === 'dsh-wallpaper-engine')
  assert.equal(wallpaper.channel, 'harness-profile')
  assert.equal(wallpaper.package, 'dsh-plugin-wallpaper-engine')
  // The market's name *is* published — the first pass read a workspace root's package.json and concluded
  // otherwise. Its own README gives the installation command:
  // `dsh plugin --profile web add @dsh-market/plugin`.
  assert.equal(market.channel, 'harness-profile')
  assert.equal(market.package, '@dsh-market/plugin')
  assert.match(market.ref, /^\d+\.\d+\.\d+$/, 'the market must be pinned to a published version')
  assert.equal(/latest/i.test(market.ref), false)
  // Two claims, kept apart: the install command was run for real in a throwaway profile, the plugins have not
  // been run inside the product yet.
  for (const entry of BUNDLED_MANIFEST.plugins) {
    assert.equal(entry.channelVerified, true, `${entry.id}'s installation channel is not recorded as verified`)
    assert.equal(entry.tested, false, `${entry.id} claims a runtime test nobody ran`)
  }
  const reported = build().manager.describe().manifest.plugins
  assert.deepEqual(reported.map((entry) => [entry.id, entry.channel, entry.channelVerified, entry.tested]), [
    ['dsh-wallpaper-engine', 'harness-profile', true, false],
    ['@dsh-market/plugin', 'harness-profile', true, false]
  ])
  // The assessment entries carry the same three facts, because that is what the Control Center reads: a panel
  // that saw only the state would show "declared" and "installable" as the same thing.
  const assessments = build().manager.describe().plugins
  assert.deepEqual(assessments.map((entry) => [entry.id, entry.channel, entry.channelVerified, entry.tested]), [
    ['dsh-wallpaper-engine', 'harness-profile', true, false],
    ['@dsh-market/plugin', 'harness-profile', true, false]
  ])
})

test('an untested pin is declared, reported, and never installed', async () => {
  const { manager, calls } = build()
  const assessed = manager.assess('dsh-wallpaper-engine')
  assert.equal(assessed.state, BUNDLED_STATE.UNTESTED)
  assert.match(assessed.reason, /nobody has tested it inside DS-Hns yet/)
  const applied = await manager.ensure()
  // Both entries are declared, pinned and *untested*: the manager reports that and installs nothing.
  assert.deepEqual(applied.map((entry) => entry.action), ['none', 'none'])
  assert.equal(applied[1].state, BUNDLED_STATE.UNTESTED)
  assert.equal(calls.length, 0, 'an untested reference was installed')
})

test('a missing tested plugin is installed at the pin, and a healthy one is left alone', async () => {
  const { manager, calls } = build({ manifest: TESTED_MANIFEST, installed: [{ id: '@dsh-market/plugin', version: 'abc1234' }] })
  const applied = await manager.ensure()
  assert.deepEqual(calls.map((call) => call.id), ['dsh-wallpaper-engine'])
  assert.equal(calls[0].ref, 'v0.7.1', 'the install did not use the pinned reference')
  const byId = Object.fromEntries(applied.map((entry) => [entry.id, entry]))
  assert.equal(byId['dsh-wallpaper-engine'].state, BUNDLED_STATE.INSTALLED)
  assert.equal(byId['@dsh-market/plugin'].action, 'none')
})

test('the user\'s decision outranks the manifest', async () => {
  const { manager, calls } = build({ manifest: TESTED_MANIFEST, userEnabled: (id) => (id === 'dsh-wallpaper-engine' ? false : null) })
  const assessed = manager.assess('dsh-wallpaper-engine')
  assert.equal(assessed.state, BUNDLED_STATE.USER_DISABLED)
  assert.match(assessed.reason, /outranks/)
  await manager.ensure()
  assert.equal(calls.some((call) => call.id === 'dsh-wallpaper-engine'), false, 'a plugin the user disabled was installed anyway')
})

test('a version the manifest does not know is reported, not replaced', async () => {
  const { manager, calls } = build({ manifest: TESTED_MANIFEST, installed: [{ id: 'dsh-wallpaper-engine', version: 'v0.9.9' }] })
  const assessed = manager.assess('dsh-wallpaper-engine')
  assert.equal(assessed.state, BUNDLED_STATE.AHEAD_OF_PIN)
  assert.match(assessed.reason, /left alone/)
  await manager.ensure()
  // The other bundled plugin may be missing and installed; what must not happen is a write to *this* one.
  assert.equal(calls.some((call) => call.id === 'dsh-wallpaper-engine'), false, 'an unknown version was overwritten without being asked')
})

test('an incompatible plugin is reported, and repair is the one path that reinstalls', async () => {
  const { manager, calls } = build({ manifest: TESTED_MANIFEST, installed: [{ id: 'dsh-wallpaper-engine', version: 'v0.7.1' }], compatibility: (entry) => (entry.id === 'dsh-wallpaper-engine' ? { ok: false, reason: 'needs a newer Harness' } : { ok: true }) })
  const assessed = manager.assess('dsh-wallpaper-engine')
  assert.equal(assessed.state, BUNDLED_STATE.INCOMPATIBLE)
  const applied = await manager.ensure()
  assert.equal(applied.find((entry) => entry.id === 'dsh-wallpaper-engine').action, 'report')
  assert.equal(calls.some((call) => call.id === 'dsh-wallpaper-engine'), false, 'an incompatible plugin was silently replaced')

  const repaired = await manager.repair('dsh-wallpaper-engine')
  assert.equal(repaired.ok, true)
  const repairs = calls.filter((call) => call.id === 'dsh-wallpaper-engine')
  assert.deepEqual(repairs.map((call) => call.action), ['uninstall', 'install'])
  assert.equal(repairs[1].ref, 'v0.7.1')
})

test('repair refuses to conjure a version out of an untested pin', async () => {
  const { manager, calls } = build()
  const repaired = await manager.repair('dsh-wallpaper-engine')
  assert.equal(repaired.ok, false)
  assert.match(repaired.reason, /has not been tested inside DS-Hns yet/)
  assert.equal(calls.length, 0)
})

test('bundled plugins are protected modules with a fallback, and an untested one is not a fault', async () => {
  const protection = createProtectionLayer({ log: () => {} })
  const tested = build({ manifest: TESTED_MANIFEST, protection })
  assert.deepEqual(tested.manager.registerProtected(), ['dsh-wallpaper-engine', '@dsh-market/plugin'])
  await protection.start('bundled:dsh-wallpaper-engine')
  const healthy = protection.describe().modules.find((module) => module.id === 'bundled:dsh-wallpaper-engine')
  assert.equal(healthy.state, MODULE_STATE.HEALTHY, 'a declared plugin was reported as a fault')

  // A real install failure degrades that module and runs its fallback instead of reaching the boot.
  // A fresh layer for the failing case: registering the same id twice returns the module that already
  // exists (registration is idempotent), so reusing the layer above would test nothing.
  const failingProtection = createProtectionLayer({ log: () => {} })
  const failing = build({ manifest: TESTED_MANIFEST, protection: failingProtection, install: async () => ({ ok: false, reason: 'the clone failed' }) })
  failing.manager.registerProtected()
  await failingProtection.start('bundled:@dsh-market/plugin')
  const described = failingProtection.describe().modules.find((module) => module.id === 'bundled:@dsh-market/plugin')
  assert.equal(described.state, MODULE_STATE.DEGRADED)
  assert.match(described.lastError, /clone failed/)
  assert.equal(described.fallback, 'store-hidden')
})

test('the manager is wired into MEGA, and the shell hands it the protection layer', () => {
  const index = read('app/extensions/mega/index.cjs')
  const main = read('app/desktop-main.cjs')
  // MEGA owns the bundled set (§19): the manager is created there, reads the store's own record, and
  // its protected modules are registered on start.
  assert.match(index, /const \{ createBundledPlugins, installBundled, removeBundled \} = require\('\.\/plugins\/index\.cjs'\)/)
  assert.match(index, /bundled\(\)\.registerProtected\(\)/)
  assert.match(index, /installed: \(\) => list\(\)/)
  assert.match(index, /protection: ctx\?\.protection \|\| null/)
  // Both channels the panel needs, declared for cleanup as well.
  assert.match(index, /ipcMain\.handle\('mega:bundled-plugins'/)
  assert.match(index, /ipcMain\.handle\('mega:bundled-plugins-repair'/)
  assert.match(index, /'mega:bundled-plugins', 'mega:bundled-plugins-repair'/)
  // The policy pass is *not* on the boot path: it runs after the rest of Mega is up.
  assert.match(index, /Promise\.resolve\(\)\s*\n\s*\.then\(\(\) => bundled\(\)\.ensure\(\)\)/)
  // The shell hands the layer over, and the install call is the store's own two steps behind one function.
  assert.match(main, /officialSurfaces: officialSurfaceAdapter,[\s\S]{0,400}protection,/, 'the protection layer never reaches the extension')
  assert.match(index, /install: \(entry\) => installPinnedPlugin\(entry\)/, 'the bundled manager cannot install a pinned reference')
})

/**
 * Removal follows the same channel as installation — and that is not symmetry for its own sake: a repair which
 * asked *our* store to remove a Harness client plugin would remove nothing and then report success, which is
 * worse than a repair that fails.
 */
test('removal follows the entry\'s channel, and an unresolved entry has nothing to remove', async () => {
  const calls = []
  const harness = await removeBundled(BUNDLED_MANIFEST.plugins[0], { harnessRemove: async (input) => { calls.push(input); return { ok: true } } })
  assert.equal(harness.ok, true)
  assert.deepEqual(calls[0], { profile: 'web', package: 'dsh-plugin-wallpaper-engine' })

  const store = await removeBundled({ id: 'dshns.some-plugin', channel: 'dshns-store' }, { store: { remove: async (input) => { calls.push(input); return { ok: true } } } })
  assert.equal(store.ok, true)
  assert.deepEqual(calls[1], { id: 'dshns.some-plugin' })

  // The market names the same channel, so its removal goes through the same CLI.
  const market = await removeBundled(BUNDLED_MANIFEST.plugins[1], { harnessRemove: async (input) => { calls.push(input); return { ok: true } } })
  assert.equal(market.ok, true)
  assert.deepEqual(calls[2], { profile: 'web', package: '@dsh-market/plugin' })

  // An entry with no channel has nothing to remove — the branch stays for a future entry that needs a decision.
  const unresolved = await removeBundled({ id: 'some-plugin', channel: 'unresolved', reason: 'no dsh descriptor yet' }, {})
  assert.equal(unresolved.ok, false)
  assert.match(unresolved.reason, /no dsh descriptor yet/)
  assert.equal((await removeBundled({ id: 'x', channel: 'neon' }, {})).ok, false)
  // A channel with no tool available is a refusal, not a silent success.
  assert.equal((await removeBundled(BUNDLED_MANIFEST.plugins[0], {})).ok, false)

  // And the installer dispatches the same way, for the same reason.
  assert.equal((await installBundled(BUNDLED_MANIFEST.plugins[0], { harnessAdd: async (input) => { calls.push(input); return { ok: true } } })).ok, true)
  assert.deepEqual(calls[3], { profile: 'web', package: 'dsh-plugin-wallpaper-engine@v0.7.1' })
  assert.equal((await installBundled(BUNDLED_MANIFEST.plugins[1], { harnessAdd: async (input) => { calls.push(input); return { ok: true } } })).ok, true)
  assert.deepEqual(calls[4], { profile: 'web', package: '@dsh-market/plugin@0.4.7' })
})

test('compatibility is answered by whoever owns the descriptor, and says which one answered', () => {
  const index = read('app/extensions/mega/index.cjs')
  // A Harness client plugin's descriptor belongs to the Harness; the product says so instead of claiming it
  // checked something it cannot see.
  assert.match(index, /entry\?\.channel === 'harness-profile'[\s\S]{0,300}checked: 'harness'/)
  // A dshns plugin is checked against the store's own record.
  assert.match(index, /checked: 'store'/)
  assert.match(index, /compatibility: \(entry, record\) => \{/)
  // Removal and installation are wired to the same dispatch.
  assert.match(index, /uninstall: \(id\) => \{[\s\S]{0,400}removeBundled\(entry, \{/)
  assert.match(index, /harnessRemove: \(\{ profile, package: spec \}\) => runHarnessPluginCli\(\['plugin', '--profile', profile, 'remove', spec\]\)/)
})

/**
 * The installer call itself, tested against a store stand-in with the store's own two steps: `stage` puts the
 * code on disk, `enable` records that the host may run it. What is asserted here is the *reference* that gets
 * asked for, and the one honest refusal: a commit pin cannot be staged by a store that clones a branch or tag.
 */
test('a pin goes through the channel its entry names', () => {
  const index = read('app/extensions/mega/index.cjs')
  const plugins = read('app/extensions/mega/plugins/index.cjs')
  // The extension delegates to the channel dispatch, and hands it both tools: the Harness' own plugin CLI for a
  // Harness *client* plugin, and this product's two-step store for a `dshns.plugin/v1` plugin.
  assert.match(index, /function installPinnedPlugin\(entry = \{\}\)[\s\S]{0,400}return installBundled\(entry, \{/)
  assert.match(index, /runHarnessPluginCli\(\['plugin', '--profile', profile, 'add', spec\]\)/)
  assert.match(index, /store: \{ stage: \(input\) => installer\(\)\.stage\(input\), enable: \(input\) => installer\(\)\.enable\(input\) \}/)
  assert.match(plugins, /async function installBundled\(/)
  // A commit pin still uses the store's revision path, because a repository with no tags can only be pinned by
  // a commit — and `git clone --branch` cannot express that.
  assert.match(plugins, /store\.stage\(\{ source: entry\.repo, revision: entry\.ref \}\)/)
  assert.match(plugins, /store\.stage\(\{ source: entry\.repo, branch: entry\.ref \}\)/)
  assert.match(index, /install: \(entry\) => installPinnedPlugin\(entry\)/)
  assert.match(index, /uninstall: \(id\) => \{/)
  // The Harness command is the Harness' own tool, run against the profile the product boots.
  assert.match(index, /function harnessProfile\(\)/)
  assert.match(index, /1000|120_000/, 'the Harness CLI call is bounded')
})
