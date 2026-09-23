'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createPluginHost } = require('../../app/plugin-host.cjs')

/**
 * Installing a plugin must not need a restart, and switching one off must not be an uninstall.
 *
 * The plugin host builds its world once and caches it, which is what makes the panel fast and
 * what used to make an enable take effect only on the next start. `refreshInstalled` is the
 * other half of that contract: the installed set is re-read from disk, the store's own cached
 * modules are dropped, the world is rebuilt in place, and the caller is told exactly what was
 * mounted, what was removed and what failed.
 *
 * The tests below drive the real host against a real temporary root, because the interesting
 * failures are not in the shape of the answer — they are in the module cache, in what happens
 * to the plugin that is still on disk, and in whether the running set and the file on disk can
 * still disagree after a refresh.
 */
const ROOT = path.resolve(__dirname, '..', '..')

function moduleFor(id, version, capability = 'example-capability') {
  return `'use strict'
module.exports = {
  manifest: {
    api_version: 'dshns.plugin/v1',
    id: '${id}',
    name: '${id}',
    version: '${version}',
    description: 'installed from the store',
    provides: ['${capability}'],
    fault_level: 'soft'
  },
  async load(context) { context.provide('${capability}', { hello: () => 'world' }) },
  async healthCheck() { return { status: 'healthy' } }
}
`
}

/**
 * A temp root holding the store's own layout: the plugin directories, and the state file the
 * installer writes. `setState` is how a test plays the installer: it rewrites
 * `installed.json` exactly the way enabling, disabling or removing one would.
 */
function harness(entries) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshns-hot-'))
  const storeDir = path.join(root, 'data', 'plugins', 'store')
  fs.mkdirSync(storeDir, { recursive: true })
  fs.mkdirSync(path.join(root, 'data', 'plugins'), { recursive: true })

  for (const entry of entries) {
    if (entry.module === undefined) continue
    const dir = path.join(storeDir, entry.directory)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, entry.main || 'index.cjs'), entry.module, 'utf8')
  }

  const stateFile = path.join(root, 'data', 'plugins', 'installed.json')
  /** Write the state file with absolute `dir` values, the way the installer does. */
  function setState(next) {
    const plugins = next.map((entry) => ({
      id: entry.id,
      repo: entry.repo || `acme/${entry.id}`,
      branch: entry.branch || 'main',
      version: entry.version || '1.0.0',
      main: entry.main || 'index.cjs',
      name: entry.name || entry.id,
      directory: entry.directory,
      dir: path.join(storeDir, entry.directory),
      stagedAt: 1,
      enabled: entry.enabled === true,
      enabledAt: entry.enabled === true ? 2 : null
    }))
    fs.writeFileSync(stateFile, `${JSON.stringify({ version: 1, plugins }, null, 2)}\n`, 'utf8')
    return plugins
  }
  setState(entries)

  const host = createPluginHost({ root, log: () => {} })
  return {
    host,
    root,
    storeDir,
    stateFile,
    setState,
    /** Replace a staged plugin's code, the way a reinstall from a newer commit does. */
    writeModule(directory, source, main = 'index.cjs') {
      fs.writeFileSync(path.join(storeDir, directory, main), source, 'utf8')
    },
    dispose: async () => {
      await host.dispose('test teardown')
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
}

const ENTRY = {
  id: 'vendor.example',
  directory: 'acme_dshns-example',
  repo: 'acme/dshns-example',
  version: '1.0.0',
  enabled: true
}

// Execute the shipped desktop adapter against a real plugin host. These catch
// positional arguments silently crossing the host's object-input boundary.
function desktopServiceAdapter(name, host) {
  const source = fs.readFileSync(path.join(ROOT, 'app', 'desktop-main.cjs'), 'utf8')
  const block = source.slice(source.indexOf('      pluginServices: {'))
  const line = block.split(/\r?\n/).find((value) => value.trim().startsWith(`${name}:`))
  assert.ok(line, `desktop adapter ${name} exists`)
  const expression = line.trim().slice(name.length + 1).replace(/,$/, '')
  return require('node:vm').runInNewContext(`(${expression})`, { pluginRuntime: () => host })
}

test('desktop enable adapter changes the real named plugin without losing its id or boolean', async () => {
  const h = harness([{ ...ENTRY, module: moduleFor(ENTRY.id, '1.0.0') }])
  try {
    await h.host.ensure()
    const setEnabled = desktopServiceAdapter('setEnabled', h.host)
    const off = await setEnabled(ENTRY.id, false)
    assert.equal(off.ok, true, JSON.stringify(off))
    assert.equal(h.host.registry.has('example-capability'), false)
    const on = await setEnabled(ENTRY.id, true)
    assert.equal(on.ok, true, JSON.stringify(on))
    assert.equal(h.host.registry.has('example-capability'), true)
  } finally { await h.dispose() }
})

test('Mega service action preserves a real host refusal for a missing plugin', async () => {
  const h = harness([])
  try {
    const source = fs.readFileSync(path.join(ROOT, 'app/extensions/mega/index.cjs'), 'utf8')
    const start = source.indexOf('async function serviceAction(action, id) {')
    const end = source.indexOf('\n/**', start)
    const action = require('node:vm').runInNewContext(source.slice(start, end) + '\nserviceAction', {
      ctx: { pluginServices: {
        report: (id) => h.host.serviceReport(id),
        setEnabled: desktopServiceAdapter('setEnabled', h.host)
      } }, log: () => {}
    })
    const result = await action('enable', 'missing.plugin')
    assert.equal(result.ok, false)
    assert.match(result.reason || '', /no plugin missing\.plugin/)
    assert.equal(result.result.code, 'PLUGIN_NOT_FOUND')
  } finally { await h.dispose() }
})

test('desktop advanced adapter writes through the real host validator and owner config', async () => {
  const h = harness([])
  try {
    const configure = desktopServiceAdapter('setAdvanced', h.host)
    const result = await configure({ intervalMs: 5000 })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.written.length, 1)
    const ownerFile = result.written[0]
    assert.equal(path.basename(ownerFile), 'dshns.health-scheduler.json')
    assert.equal(JSON.parse(fs.readFileSync(ownerFile, 'utf8')).intervalMs, 5000)
    const refused = await configure({ intervalMs: 0 })
    assert.equal(refused.ok, false)
    assert.equal(refused.code, 'INVALID_SETTING')
    assert.equal(JSON.parse(fs.readFileSync(ownerFile, 'utf8')).intervalMs, 5000)
  } finally { await h.dispose() }
})

test('desktop advanced readback reports the value stored by the real host', async () => {
  const h = harness([])
  try {
    await h.host.ensure()
    assert.equal((await h.host.configure({ settings: { intervalMs: 5000 } })).ok, true)
    const source = fs.readFileSync(path.join(ROOT, 'app/desktop-main.cjs'), 'utf8')
    const start = source.indexOf('        advanced: () => {')
    const end = source.indexOf('\n        setAdvanced:', start)
    const expression = source.slice(start, end).trim().replace(/^advanced:\s*/, '').replace(/,$/, '')
    const read = require('node:vm').runInNewContext(`(${expression})`, { pluginRuntime: () => h.host, logLine: () => {} })
    assert.equal(read().find((field) => field.key === 'intervalMs').value, 5000)
  } finally { await h.dispose() }
})

test('desktop restart control resolves the real registry without invoking a restart', async () => {
  const h = harness([])
  try {
    await h.host.ensure()
    const source = fs.readFileSync(path.join(ROOT, 'app/desktop-main.cjs'), 'utf8')
    const start = source.indexOf('        restartControl: () => {')
    const end = source.indexOf('\n      },', start)
    const expression = source.slice(start, end).trim().replace(/^restartControl:\s*/, '')
    const resolve = require('node:vm').runInNewContext(`(${expression})`, { pluginRuntime: () => h.host })
    const result = resolve()
    assert.equal(result.ok, true, result.reason)
    assert.equal(result.value, h.host.registry.resolve('restart-control'))
    assert.equal(typeof result.value.manualRestart, 'function')
  } finally { await h.dispose() }
})

test('desktop health adapter checks only the requested real plugin', async () => {
  const h = harness([{ ...ENTRY, module: moduleFor(ENTRY.id, '1.0.0') }])
  try {
    await h.host.ensure()
    const result = await desktopServiceAdapter('checkHealth', h.host)(ENTRY.id)
    assert.equal(result.ok, true)
    assert.equal(result.id, ENTRY.id, 'a named check must not turn into check-all')
    assert.equal(result.health.status, 'healthy')
  } finally { await h.dispose() }
})

test('desktop reload adapter actually reloads the named real plugin', async () => {
  const h = harness([{ ...ENTRY, module: moduleFor(ENTRY.id, '1.0.0') }])
  try {
    await h.host.ensure()
    const result = await desktopServiceAdapter('reload', h.host)(ENTRY.id, { reason: 'contract test' })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.restartCount, 1)
    assert.equal(h.host.registry.has('example-capability'), true)
  } finally { await h.dispose() }
})

test('enabling a plugin while the world runs mounts it, with no restart and no false promise', async () => {
  const harnessed = harness([{ ...ENTRY, enabled: false, module: moduleFor('vendor.example', '1.0.0') }])
  try {
    const built = await harnessed.host.ensure()
    assert.equal(built.ok, true, built.error)
    assert.equal(harnessed.host.list().plugins.some((plugin) => plugin.id === 'vendor.example'), false, 'a disabled plugin must not be running')

    // The user presses Enable in the store: one flag changes in the state file.
    harnessed.setState([{ ...ENTRY, enabled: true }])
    const refreshed = await harnessed.host.refreshInstalled('test enable')

    assert.equal(refreshed.ok, true, refreshed.error)
    assert.equal(refreshed.rebuilt, true, 'a built world must be rebuilt in place')
    assert.deepEqual(refreshed.mounted, ['vendor.example'], 'the refresh did not report what it mounted')
    assert.deepEqual(refreshed.removed, [])
    assert.deepEqual(refreshed.failures, [])
    const mounted = harnessed.host.list().plugins.find((plugin) => plugin.id === 'vendor.example')
    assert.ok(mounted, 'the enabled plugin is missing from the running set')
    assert.equal(mounted.loaded, true, 'the plugin was listed but never loaded')
    assert.equal(harnessed.host.registry.has('example-capability'), true, 'the plugin never ran its load hook')
  } finally {
    await harnessed.dispose()
  }
})

test('disabling a plugin unloads it and leaves it installed on disk', async () => {
  const harnessed = harness([{ ...ENTRY, enabled: true, module: moduleFor('vendor.example', '1.0.0') }])
  try {
    await harnessed.host.ensure()
    assert.equal(harnessed.host.list().plugins.some((plugin) => plugin.id === 'vendor.example'), true)

    const state = harnessed.setState([{ ...ENTRY, enabled: false }])
    const refreshed = await harnessed.host.refreshInstalled('test disable')

    assert.equal(refreshed.ok, true, refreshed.error)
    assert.deepEqual(refreshed.removed, ['vendor.example'], 'the refresh did not report what it removed')
    assert.equal(harnessed.host.list().plugins.some((plugin) => plugin.id === 'vendor.example'), false, 'a disabled plugin must not be running')
    // Installed is not uninstalled: the code, the entry and the record are all still there.
    assert.equal(fs.existsSync(path.join(harnessed.storeDir, ENTRY.directory, 'index.cjs')), true, 'disabling deleted the plugin files')
    assert.equal(state.length, 1, 'disabling removed the plugin from the installed state')
    assert.equal(state[0].enabled, false)
    assert.equal(harnessed.host.lockfile({}).fromStore, 0, 'a disabled install is not part of the running store set')
  } finally {
    await harnessed.dispose()
  }
})

test('a reinstall is picked up because the store modules are dropped from the cache', async () => {
  const harnessed = harness([{ ...ENTRY, enabled: true, module: moduleFor('vendor.example', '1.0.0') }])
  try {
    await harnessed.host.ensure()
    const before = harnessed.host.list().plugins.find((plugin) => plugin.id === 'vendor.example')
    assert.equal(before.version, '1.0.0')

    // Reinstall from a newer commit: same directory, same id, different code.
    harnessed.writeModule(ENTRY.directory, moduleFor('vendor.example', '2.0.0'))
    const refreshed = await harnessed.host.refreshInstalled('test reinstall')

    assert.equal(refreshed.purged >= 1, true, 'the store module cache was not purged, so the old module would be handed back')
    const after = harnessed.host.list().plugins.find((plugin) => plugin.id === 'vendor.example')
    assert.equal(after.version, '2.0.0', 'the reinstall served the cached module instead of the new code')
  } finally {
    await harnessed.dispose()
  }
})

test('a refresh of a world that was never built builds nothing and says so', async () => {
  const harnessed = harness([{ ...ENTRY, enabled: true, module: moduleFor('vendor.example', '1.0.0') }])
  try {
    const refreshed = await harnessed.host.refreshInstalled('test unbuilt')
    assert.equal(refreshed.ok, true, refreshed.error)
    assert.equal(refreshed.rebuilt, false)
    assert.equal(refreshed.built, false)
    assert.match(String(refreshed.note), /first build/, 'the answer must say why nothing was reloaded')
    assert.equal(harnessed.host.manager, null, 'a refresh must not build the world the user never asked for')

    // The build that does happen reads the same file, so the plugin is there either way.
    await harnessed.host.ensure()
    assert.equal(harnessed.host.list().plugins.some((plugin) => plugin.id === 'vendor.example'), true)
  } finally {
    await harnessed.dispose()
  }
})

test('an installed plugin that breaks is reported, and the product keeps running', async () => {
  const harnessed = harness([{ ...ENTRY, enabled: true, module: moduleFor('vendor.example', '1.0.0') }])
  try {
    await harnessed.host.ensure()
    harnessed.writeModule(ENTRY.directory, "throw new Error('this update is broken')\n")

    const refreshed = await harnessed.host.refreshInstalled('test broken update')
    assert.equal(refreshed.ok, true, 'a broken third-party plugin must not fail the refresh itself')
    assert.deepEqual(refreshed.removed, ['vendor.example'])
    assert.equal(refreshed.failures.length, 1, 'the failure was not reported')
    assert.equal(refreshed.failures[0].id, 'vendor.example')
    assert.match(String(refreshed.failures[0].reason), /broken/)
    // The product's own plugins all survived the rebuild.
    assert.ok(harnessed.host.list().plugins.length >= 25, 'the shipped set must survive a broken install')
  } finally {
    await harnessed.dispose()
  }
})

test('the shell reloads the world when the store says the installed set changed', () => {
  const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8')
  const main = read('app/desktop-main.cjs')
  const mega = read('app/extensions/mega/index.cjs')
  const preload = read('app/extensions/mega/ui/preload.cjs')
  const panel = read('app/extensions/mega/ui/plugin-panel.js')
  const manager = read('app/extensions/mega/ui/feature-manager.js')

  // The channel exists on both sides of the shell, and its handler refreshes the installed set.
  assert.match(main, /'plugins:refresh'/, 'the shell has no rescan channel')
  assert.match(main, /ipcMain\.handle\('plugins:refresh'[\s\S]{0,200}refreshInstalled\(/, 'the rescan channel does not refresh the installed set')

  // The store's event is watched, and the watch is what reloads the world.
  assert.match(main, /ipcMain\.on\('mega:installed-plugins-changed'[\s\S]{0,200}reloadInstalledPlugins\(/, 'the store event does not reload the plugin world')
  assert.match(main, /watchInstalledPluginChanges\(\)/)
  assert.match(main, /reloadInstalledPlugins[\s\S]{0,400}refreshInstalled\(/, 'the reload does not ask the host to re-read the installed set')
  // The dock owns a view of that world, so it is told the world moved.
  assert.match(main, /webContents\.send\('plugins:changed'/, 'the dock is never told the world moved')
  // A listener left behind after teardown would reload a runtime that is gone.
  assert.match(main, /removeAllListeners\('mega:installed-plugins-changed'\)/, 'the store watch is not removed on teardown')
  // The store awaits the rebuild through the hook, so "enabled" cannot be shown before it is.
  assert.match(main, /reloadInstalledPlugins,/, 'the shell does not hand the extension the reload hook')
  assert.match(mega, /typeof ctx\.reloadInstalledPlugins === 'function'/, 'the store does not use the shell reload hook')
  assert.match(mega, /await hook\('the plugin store changed the installed set'\)/, 'the store does not wait for the rebuild')
  for (const action of ['mega:store-enable', 'mega:store-disable', 'mega:store-remove']) {
    const block = mega.slice(mega.indexOf(`ipcMain.handle('${action}'`))
    assert.match(block.slice(0, 400), /await notifyPluginHostReload\(\)/, `${action} did not wait for the plugin world`)
  }
  // The fallback event still exists for a build wired without the hook.
  assert.match(mega, /ipcMain\.emit\('mega:installed-plugins-changed'\)/, 'the store lost its fallback notification')

  // The renderer side: the bridge can ask for a rescan and listens for the world moving.
  assert.match(preload, /refresh: \(\) => ipcRenderer\.invoke\('plugins:refresh'\)/)
  assert.match(preload, /onChanged: \(callback\) => ipcRenderer\.on\('plugins:changed'/)
  assert.match(panel, /window\.megaPlugins\?\.onChanged\?\./, 'the plugin panel never hears that the world moved')
  assert.match(panel, /window\.megaPlugins\?\.refresh\?\.\(\)/, 'the plugin panel rescan button does not rescan')
  // Two tabs describing one world must not disagree: a store action moves both.
  assert.match(manager, /window\.megaPluginPanel\?\.refresh\?\.\(\)/, 'a store action leaves the plugin tab stale')
  assert.match(panel, /window\.megaPluginPanel = \{ attach, refresh:/, 'the plugin tab is not reachable by name')
})
