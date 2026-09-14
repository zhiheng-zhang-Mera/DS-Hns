'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createAppearanceProviders, APPEARANCE_PROVIDER_IDS, availability } = require('../../app/extensions/mega/appearance/providers.cjs')
const { createAppearanceState } = require('../../app/extensions/mega/appearance/state.cjs')
const ROOT = path.resolve(__dirname, '..', '..')
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8')

/**
 * The appearance providers (`updateplan/startup2.md` §43-§44).
 *
 * The behaviour that matters is the refusal: choosing Wallpaper Engine while its plugin is missing must not
 * install anything, must not move the user off what they were using, and must offer the two things a person can
 * decide — stay on the official interface, or go look at the plugin.
 */

function bundledWith(state, extra = {}) {
  return () => ({
    plugins: [{ id: 'dsh-wallpaper-engine', state, present: state === 'installed', expected: 'v0.7.1', installedVersion: state === 'installed' ? 'v0.7.1' : null, reason: extra.reason || null }]
  })
}

test('the three providers exist, and only the community one requires a plugin', () => {
  assert.deepEqual(APPEARANCE_PROVIDER_IDS, ['official', 'simple', 'community'])
  const described = createAppearanceProviders({}).describe('simple')
  assert.equal(described.active, 'simple')
  assert.equal(described.installsAutomatically, false, 'the provider list must never promise an automatic install')
  for (const provider of described.providers) {
    assert.equal(provider.requires === 'dsh-wallpaper-engine', provider.id === 'community')
    if (provider.id !== 'community') assert.equal(provider.available, true, `${provider.id} must always be usable`)
  }
  assert.equal(described.providers.find((provider) => provider.id === 'community').available, false)
  assert.equal(availability({ requires: null }, null).available, true, 'the official baseline depends on no plugin')
})

test('choosing a provider whose plugin is untested refuses, keeps the user, and installs nothing', async () => {
  const applied = []
  const providers = createAppearanceProviders({
    bundled: bundledWith('untested', { reason: 'pinned at v0.7.1, but nobody has tested it inside DS-Hns yet' }),
    apply: { community: async () => { applied.push('community'); return 'delegated' } }
  })
  const result = await providers.select('community', { current: 'simple' })
  assert.equal(result.ok, false)
  assert.match(result.reason, /nobody has tested it/)
  assert.equal(result.kept, 'simple', 'the user was moved off their provider by a refusal')
  assert.equal(result.fallback, 'simple')
  assert.deepEqual(result.actions, ['keep-official', 'open-store'])
  assert.equal(result.installed, false)
  assert.deepEqual(applied, [], 'an unavailable provider still touched the layers')
})

test('a plugin the user disabled is reported as their decision, not as a missing one', () => {
  const providers = createAppearanceProviders({ bundled: bundledWith('user-disabled') })
  const described = providers.describe('official').providers.find((provider) => provider.id === 'community')
  assert.equal(described.available, false)
  assert.match(described.reason, /switched off by the user/)
  assert.deepEqual(described.actions, ['keep-official', 'open-store'])
})

test('an installed plugin is usable, and the provider applies through its own hook', async () => {
  const applied = []
  const providers = createAppearanceProviders({ bundled: bundledWith('installed'), apply: { community: async () => { applied.push('community'); return 'delegated' } } })
  assert.equal(providers.describe('official').providers.find((provider) => provider.id === 'community').version, 'v0.7.1')
  const result = await providers.select('community', { current: 'simple' })
  assert.equal(result.ok, true)
  assert.equal(result.fallback, 'simple')
  assert.deepEqual(applied, ['community'])
})

test('a hook that throws is reported with the provider\'s fallback, not thrown at the caller', async () => {
  const providers = createAppearanceProviders({ bundled: bundledWith('installed'), apply: { simple: async () => { throw new Error('the wallpaper layer is gone') } } })
  const result = await providers.select('simple')
  assert.equal(result.ok, false)
  assert.match(result.reason, /wallpaper layer is gone/)
  assert.equal(result.fallback, 'official')
  assert.equal((await providers.select('neon')).ok, false)
})

test('the appearance decisions persist like every other preference, and drop what they cannot honour', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshns-appearance-'))
  try {
    const file = path.join(dir, 'appearance.json')
    const state = createAppearanceState({ root: dir, file, log: () => {} })
    assert.deepEqual({ provider: state.read().provider, preset: state.read().preset }, { provider: 'simple', preset: 'work' })
    assert.equal(state.set({ provider: 'neon' }).ok, false, 'an unknown provider was stored')
    assert.equal(state.set({ preset: 'neon' }).ok, false, 'an unknown preset was stored')
    assert.equal(state.set({ provider: 'community', preset: 'reading' }).ok, true)
    const reread = createAppearanceState({ root: dir, file })
    assert.equal(reread.read().provider, 'community')
    assert.equal(reread.read().preset, 'reading')
    // A file holding something this build does not have keeps the default for that value and says why.
    fs.writeFileSync(file, JSON.stringify({ provider: 'neon', preset: 'reading' }), 'utf8')
    const lines = []
    const tolerant = createAppearanceState({ root: dir, file, log: (line) => lines.push(line) })
    assert.equal(tolerant.read().provider, 'simple')
    assert.equal(tolerant.read().preset, 'reading')
    assert.ok(lines.some((line) => /not one this build has/.test(line)))
    fs.writeFileSync(file, '{oops', 'utf8')
    assert.equal(createAppearanceState({ root: dir, file, log: () => {} }).read().provider, 'simple')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the settings page and the shell are wired for the provider choice and the missing-plugin path', () => {
  const index = read('app/extensions/mega/index.cjs')
  const preload = read('app/extensions/mega/ui/preload.cjs')
  const html = read('app/extensions/mega/ui/dock.html')
  const panel = read('app/extensions/mega/ui/appearance-panel.js')
  assert.match(index, /const \{ createAppearanceProviders \} = require\('\.\/appearance\/providers\.cjs'\)/)
  assert.match(index, /ipcMain\.handle\('mega:appearance-providers'/)
  assert.match(index, /ipcMain\.handle\('mega:appearance-provider-set'/)
  assert.match(index, /ipcMain\.handle\('mega:open-store'/)
  assert.match(index, /'mega:appearance-providers', 'mega:appearance-provider-set', 'mega:open-store'/)
  // The provider's own implementation of "official" is that this product draws nothing over the UI.
  assert.match(index, /official: \(\) => setWallpaperEnabled\(false\)/)
  assert.match(index, /simple: \(\) => setWallpaperEnabled\(true\)/)
  assert.match(preload, /setProvider: \(provider\)/)
  assert.match(preload, /openStore: \(\) => ipcRenderer\.invoke\('mega:open-store'\)/)
  assert.match(html, /id="appearanceProvider"/)
  assert.match(html, /id="appearanceProviderNote"/)
  assert.match(html, /id="appearanceKeepOfficial"/)
  assert.match(html, /id="appearanceOpenStore"/)
  assert.match(panel, /function renderProviders\(/)
  assert.match(panel, /不会自动安装第三方插件/, 'the notice must say that nothing is installed on the user\'s behalf')
})
