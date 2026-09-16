'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createPluginHost } = require('../../app/plugin-host.cjs')
const { createPluginManager } = require('../../app/core/plugin-manager/index.cjs')
const { createAdapterFramework } = require('../../app/core/plugin-adapters/index.cjs')
const { createNativeAdapter } = require('../../app/core/plugin-adapters/adapters/native.cjs')
const { registerMockFormat, MOCK_FORMAT_FILE } = require('../../app/core/plugin-adapters/adapters/mock.cjs')
const { validateManifest, normalizeManifest, PLUGIN_API_VERSION } = require('../../app/core/contracts/plugin.cjs')
const { classifyCompatible, COMPAT_FILE } = require('../../app/extensions/mega/store/compat.cjs')

/**
 * Compatibility: what must not change, and what must now be true.
 *
 * The adapter framework is an addition, and an addition that quietly changed the platform's own
 * plugin contract or weakened the isolation of an adopted plugin would be a regression wearing a
 * new name. So this file pins both directions:
 *
 *   * **the old contract still holds** — a hand-written `dshns.plugin/v1` plugin behaves exactly as
 *     it did, and an adopted plugin is still adopted in its own process with the same guarantees;
 *   * **the new property is real** — the manager receives one shape from every format, and neither
 *     the manager nor the host contains knowledge of any particular external format any more.
 */

const ROOT = path.resolve(__dirname, '..', '..')
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8')

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshns-adaptercompat-'))
  return {
    dir,
    write(relative, content) {
      const file = path.join(dir, relative)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`, 'utf8')
      return file
    },
    path: (relative) => path.join(dir, relative),
    dispose: () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 })
  }
}

test('the platform\'s own contract is unchanged, and gains the standard sections as defaults', () => {
  const plain = {
    api_version: PLUGIN_API_VERSION,
    id: 'acme.plain',
    name: 'Plain',
    version: '1.0.0',
    provides: ['thing'],
    requires_capabilities: ['other'],
    fault_level: 'soft'
  }
  const validated = validateManifest(plain)
  assert.equal(validated.ok, true, validated.errors.join('; '))

  const normalized = normalizeManifest(plain)
  // Everything that was there before is still there, with the same values.
  assert.equal(normalized.id, 'acme.plain')
  assert.deepEqual(normalized.provides, ['thing'])
  assert.deepEqual(normalized.requires_capabilities, ['other'])
  assert.equal(normalized.fault_level, 'soft')
  assert.equal(normalized.default_enabled, true)
  assert.equal(normalized.entry, null)
  // And the new sections default to the neutral value rather than to `undefined`, so no reader
  // has to test for their absence.
  assert.deepEqual(normalized.permissions, { declared: [], granted: [], unknown: [], refused: [], complete: true })
  assert.equal(normalized.runtime, null)
  assert.equal(normalized.adapter, null)
  assert.equal(normalized.health, null)

  // The old refusals still refuse.
  assert.equal(validateManifest({ ...plain, api_version: 'dshns.plugin/v2' }).ok, false)
  assert.equal(validateManifest({ ...plain, version: 'nope' }).ok, false)
  assert.equal(validateManifest({ ...plain, permissions: 'yes' }).ok, false)
  assert.equal(validateManifest({ ...plain, permissions: { declares: [1] } }).ok, false)
  assert.equal(validateManifest({ ...plain, runtime: [] }).ok, false)
})

test('the plugin manager names no external format at all', () => {
  const manager = read('app/core/plugin-manager/index.cjs')
  // This is the requirement in one assertion: the manager consumes the standard model and nothing
  // else, so a new external format cannot require an edit here. The patterns are word-bounded on
  // purpose — "incompatible" contains "compat" and means nothing of the sort.
  for (const [what, pattern] of [
    ['the compatibility layer', /\bcompat\b/i],
    ['Cordis', /cordis/i],
    ['the store manifest file', /dshns-plugin\.json/],
    ['npm packaging', /\bpackage\.json\b/],
    ['the compatibility module', /plugin-compat/],
    ['the adapter framework', /plugin-adapters/]
  ]) {
    assert.equal(pattern.test(manager), false, `the plugin manager must not know about ${what}`)
  }
  // It still speaks the platform's own contract, which is the one thing it is allowed to know.
  assert.match(manager, /require\('\.\.\/contracts\/plugin\.cjs'\)/)
})

test('the host delegates format knowledge to the framework instead of branching on it', () => {
  const host = read('app/plugin-host.cjs')
  // The old implementation had the Cordis/compat path inline. It must not any more: the adapter
  // is the only thing that knows how to turn a foreign package into a plugin.
  assert.equal(host.includes('readCompatDescriptor'), false, 'the host still reads a foreign descriptor')
  assert.equal(host.includes('createCompatPlugin'), false, 'the host still constructs a foreign plugin')
  assert.equal(host.includes("require('./core/plugin-compat/index.cjs')"), false, 'the host still reaches into the compat layer')
  assert.equal(host.includes(COMPAT_FILE), false, 'the host still names the compatibility descriptor file')
  // It must not choose an adapter itself either: selection is the registry's job, and a host that
  // picked one would be a host that knows which formats exist.
  assert.equal(/adapters\.(select|get)\(/.test(host), false, 'the host chooses an adapter itself')
  // What it does instead: build artifacts and hand them to the framework.
  assert.match(host, /adapters\.adaptMany\(artifacts\)/)
  assert.match(host, /createAdapterFramework\(\{/)
  assert.match(host, /adapters\.register\(createNativeAdapter\(\)\)/)
  assert.match(host, /adapters\.register\(createCordisAdapter\(\{/)
})

test('a plugin from any format reaches the manager in one shape', async () => {
  const area = scratch()
  try {
    const framework = createAdapterFramework({ log: () => {} })
    framework.register(createNativeAdapter())
    registerMockFormat(framework)

    // Three different origins: the platform's own declared manifest, an imported module, and a
    // format invented for the demonstration adapter.
    area.write('declared/dshns-plugin.json', { api_version: PLUGIN_API_VERSION, id: 'acme.one', name: 'One', version: '1.0.0' })
    area.write(`${MOCK_FORMAT_FILE}`, 'placeholder') // not used; keeps the helper honest about paths
    const mockDir = area.path('mock')
    fs.mkdirSync(mockDir, { recursive: true })
    fs.writeFileSync(path.join(mockDir, MOCK_FORMAT_FILE), JSON.stringify({ mock_format: 1, name: '@acme/two', version: '1.0.0', handler: 'handler.js' }), 'utf8')
    fs.writeFileSync(path.join(mockDir, 'handler.js'), 'module.exports = { start: () => ({ ok: true }) }\n', 'utf8')

    const adapted = await framework.adaptMany([
      { dir: area.path('declared') },
      { dir: mockDir },
      { dir: area.dir, module: { manifest: { api_version: PLUGIN_API_VERSION, id: 'acme.three', name: 'Three', version: '1.0.0' } } }
    ])
    assert.equal(adapted.plugins.length, 3, JSON.stringify(adapted.failures))

    const manager = createPluginManager({ log: () => {} })
    for (const plugin of adapted.plugins) assert.equal(manager.install(plugin).ok, true)

    const listed = manager.list()
    assert.equal(listed.length, 3)
    // Every entry has the same fields, whatever it arrived as. That is what "one shape" means, and
    // it is what lets one panel render all of them.
    const keys = listed.map((entry) => Object.keys(entry).sort().join(','))
    assert.equal(new Set(keys).size, 1, 'plugins from different formats produced different shapes')
    for (const entry of listed) {
      assert.equal(entry.apiVersion, PLUGIN_API_VERSION)
      assert.ok(entry.adapter && entry.adapter.id, `${entry.id} has no adapter record`)
      assert.ok(entry.runtime && entry.runtime.kind, `${entry.id} has no runtime record`)
      assert.ok(entry.permissions && Array.isArray(entry.permissions.granted), `${entry.id} has no permission record`)
      assert.ok(entry.adaptation && entry.adaptation.detected_type, `${entry.id} has no adaptation record`)
      assert.ok(entry.lifecycle, `${entry.id} has no lifecycle state`)
      assert.equal(typeof entry.errorCount, 'number')
    }
    // The three really did come from three different places.
    assert.deepEqual(
      listed.map((entry) => entry.adaptation.detected_type).sort(),
      ['dshns.declared', 'dshns.module', 'mock.manifest']
    )
  } finally {
    area.dispose()
  }
})

test('an adapted plugin still participates in capabilities and the event bus', async () => {
  const area = scratch()
  try {
    const framework = createAdapterFramework({ log: () => {} })
    framework.register(createNativeAdapter())
    const adapted = await framework.adapt({
      dir: area.dir,
      module: {
        manifest: { api_version: PLUGIN_API_VERSION, id: 'acme.provider', name: 'Provider', version: '1.0.0', provides: ['thing-making'] },
        load(context) {
          context.provide('thing-making', { make: () => 1 })
          context.emit('plugin.announced', { hello: 'world' })
        }
      }
    })
    assert.equal(adapted.ok, true, adapted.reason)

    const manager = createPluginManager({ log: () => {} })
    manager.install(adapted.plugin)
    const seen = []
    manager.bus.on('plugin.announced', (payload) => seen.push(payload))

    const loaded = await manager.loadAll()
    assert.equal(loaded.results[0].ok, true)
    // The capability registry, the bus and the health path all still work for an adapted plugin:
    // the framework changed how a plugin is *described*, not how it is mounted.
    assert.equal(manager.registry.has('thing-making'), true)
    assert.equal(manager.registry.resolve('thing-making').make(), 1)
    assert.equal(seen.length, 1)
    assert.equal(seen[0].hello, 'world')
    assert.equal(manager.status('acme.provider').permissions.granted.length, 0)
    await manager.unload('acme.provider')
    assert.equal(manager.registry.has('thing-making'), false, 'unload must still revoke')
  } finally {
    area.dispose()
  }
})

test('a Cordis package is still adopted in its own process, with the same guarantees', async () => {
  const area = scratch()
  try {
    const root = path.join(area.dir, 'root')
    const store = path.join(root, 'data', 'plugins', 'store', 'acme_plug')
    fs.mkdirSync(store, { recursive: true })
    fs.writeFileSync(path.join(store, 'package.json'), JSON.stringify({ name: '@acme/plug', version: '2.0.0', type: 'module', main: 'index.js' }), 'utf8')
    fs.writeFileSync(path.join(store, 'index.js'), 'export const apply = (ctx) => { setInterval(() => {}, 1000) }\n', 'utf8')

    const classified = classifyCompatible(store, { repo: 'acme/plug', branch: 'main' })
    assert.equal(classified.ok, true, classified.reason)
    fs.writeFileSync(path.join(store, COMPAT_FILE), `${JSON.stringify(classified.descriptor, null, 2)}\n`, 'utf8')

    fs.mkdirSync(path.join(root, 'data', 'plugins'), { recursive: true })
    fs.writeFileSync(path.join(root, 'data', 'plugins', 'installed.json'), `${JSON.stringify({
      version: 1,
      plugins: [{
        id: classified.descriptor.id,
        dir: store,
        repo: 'acme/plug',
        branch: 'main',
        compatibility: 'compat',
        version: '2.0.0',
        main: 'index.js',
        name: '@acme/plug',
        enabled: true,
        enabledAt: 1
      }]
    }, null, 2)}\n`, 'utf8')

    const host = createPluginHost({ root, log: () => {}, nodeExe: process.execPath })
    try {
      const built = await host.ensure()
      assert.equal(built.ok, true, built.error)
      const listed = host.list().plugins.find((plugin) => plugin.id === classified.descriptor.id)
      assert.ok(listed, 'the adopted plugin is not in the list')

      // The pre-existing compat guarantees are all still true.
      assert.equal(listed.compatibility, 'compat')
      assert.equal(listed.compat.status, 'running')
      assert.equal(listed.loaded, true)
      assert.deepEqual(listed.provides, [], 'an adopted plugin still provides nothing')
      assert.equal(Array.isArray(listed.guarantees.cn), true)
      assert.equal(host.lockfile({}).fromStore, 1, 'an adopted plugin is still outside the lock')
      assert.equal(host.compatSetup({ id: classified.descriptor.id }).ok, true)

      // And now it also carries the standard sections, produced by the adapter rather than by a
      // branch in the host.
      assert.equal(listed.adapter.id, 'dshns.cordis')
      assert.equal(listed.adaptation.detected_type, 'compat.descriptor')
      assert.equal(listed.runtime.kind, 'isolated-process')
      assert.equal(listed.runtime.enforcement, 'process-boundary')
      // The declared permissions describe what the child process can reach, not a comfortable
      // subset of it.
      assert.deepEqual(listed.permissions.granted.sort(), ['fs.read', 'fs.write', 'network', 'process.spawn'])
      assert.equal(listed.lifecycle, 'loaded')

      // The isolated process is real: it is not this one.
      const runtimeInfo = host.describe({ id: classified.descriptor.id }).runtimeInfo
      assert.equal(typeof runtimeInfo.pid, 'number')
      assert.notEqual(runtimeInfo.pid, process.pid)

      const status = host.status()
      assert.equal(status.compat.total, 1)
      assert.equal(status.compat.running, 1)

      // And the framework's own description is available without adapting anything.
      const described = host.adapters()
      assert.ok(described.adapters.some((adapter) => adapter.id === 'dshns.cordis'))
      assert.ok(described.adapters.some((adapter) => adapter.id === 'dshns.native'))
      assert.ok(described.types.includes('cordis.bundle'))
      assert.ok(described.permissions.some((permission) => permission.id === 'worker.control'))
    } finally {
      await host.dispose('test teardown')
    }
  } finally {
    area.dispose()
  }
})

test('a host with no installed plugins behaves exactly as it did before', async () => {
  const area = scratch()
  try {
    const root = path.join(area.dir, 'root')
    fs.mkdirSync(path.join(root, 'data', 'plugins'), { recursive: true })
    const host = createPluginHost({ root, log: () => {} })
    try {
      const built = await host.ensure()
      assert.equal(built.ok, true, built.error)
      // The shipped set is mounted, and not one of them is described as adapted.
      const plugins = host.list().plugins
      assert.ok(plugins.length > 0)
      assert.equal(plugins.every((plugin) => plugin.compatibility === 'native'), true)
      assert.equal(host.status().compat.total, 0)
      assert.equal((host.status().errors || []).filter((entry) => entry.source === 'adapter').length, 0)
    } finally {
      await host.dispose('test teardown')
    }
  } finally {
    area.dispose()
  }
})
