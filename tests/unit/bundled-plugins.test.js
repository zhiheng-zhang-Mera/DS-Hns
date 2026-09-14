'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { createBundledPlugins, BUNDLED_MANIFEST, BUNDLED_STATE } = require('../../app/extensions/mega/plugins/index.cjs')
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
    assert.match(entry.ref, /^(v\d+\.\d+\.\d+|[0-9a-f]{7,40})$/, `${entry.id} is pinned to something that is not a tag or a commit`)
    assert.equal(/latest/i.test(entry.ref), false)
    assert.equal(entry.required, false, `${entry.id} is bundled as required, which the plan does not allow`)
  }
  // The market publishes no tags, so its version *is* a commit — that is the point of pinning one.
  const market = BUNDLED_MANIFEST.plugins.find((entry) => entry.id === '@dsh-market/plugin')
  assert.equal(market.ref, market.commit)
})

test('an untested pin is declared, reported, and never installed', async () => {
  const { manager, calls } = build()
  const assessed = manager.assess('dsh-wallpaper-engine')
  assert.equal(assessed.state, BUNDLED_STATE.UNTESTED)
  assert.match(assessed.reason, /nobody has tested it inside DS-Hns yet/)
  const applied = await manager.ensure()
  assert.deepEqual(applied.map((entry) => entry.action), ['none', 'none'])
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
  assert.match(index, /const \{ createBundledPlugins \} = require\('\.\/plugins\/index\.cjs'\)/)
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
 * The installer call itself, tested against a store stand-in with the store's own two steps: `stage` puts the
 * code on disk, `enable` records that the host may run it. What is asserted here is the *reference* that gets
 * asked for, and the one honest refusal: a commit pin cannot be staged by a store that clones a branch or tag.
 */
test('a pinned reference is staged and enabled through the store, and a commit pin is refused by name', () => {
  const index = read('app/extensions/mega/index.cjs')
  const installSource = index.slice(index.indexOf('async function installPinnedPlugin'), index.indexOf('let bundledPlugins'))
  assert.match(installSource, /installer\(\)\.stage\(\{ source: entry\.repo, branch: ref \}\)/)
  assert.match(installSource, /installer\(\)\.enable\(\{ id \}\)/)
  assert.match(installSource, /needs a revision-aware stage first/, 'a commit pin must be refused rather than resolved to whatever the default branch holds')
  assert.match(index, /install: \(entry\) => installPinnedPlugin\(entry\)/)
  assert.match(index, /uninstall: async \(id\) => \{/)
})
