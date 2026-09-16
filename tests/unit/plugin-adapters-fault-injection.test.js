'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createAdapterFramework } = require('../../app/core/plugin-adapters/index.cjs')
const { createAdapterRegistry } = require('../../app/core/plugin-adapters/registry.cjs')
const { createTypeDetector } = require('../../app/core/plugin-adapters/detect.cjs')
const { createNativeHnsAdapter } = require('../../app/core/plugin-adapters/adapters/native-hns.cjs')
const { registerMockFormat, MOCK_FORMAT_FILE } = require('../../app/core/plugin-adapters/adapters/mock.cjs')
const { ADAPTER_API_VERSION, ADAPTER_FAULT_CODES } = require('../../app/core/plugin-adapters/contract.cjs')
const { createPluginHost } = require('../../app/plugin-host.cjs')

/**
 * Error injection: the requirement that an adapter failure affects one plugin and nothing else.
 *
 * This is the suite that matters most, because the failure it guards against is the worst one this
 * architecture can have: adapter code is third-party code that runs during startup, so a framework
 * that lets it throw is a framework that lets one malformed plugin directory stop DS-Hns from
 * starting. Every test here injects a specific defect and asserts two things — the defect is
 * reported with a usable reason, and *everything else still works*.
 */

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshns-inject-'))
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

/** A framework with the platform's own adapter plus the demonstration format. */
function framework() {
  const built = createAdapterFramework({ log: () => {} })
  built.register(createNativeHnsAdapter())
  registerMockFormat(built)
  return built
}

/** A working mock-format plugin, used as the control in every experiment below. */
function goodMockPlugin(area, name = '@acme/good') {
  const relative = 'good-' + name.replace(/[^a-z0-9]+/gi, '-')
  area.write(`${relative}/${MOCK_FORMAT_FILE}`, { mock_format: 1, name, version: '1.0.0', handler: 'handler.js', permissions: [] })
  area.write(`${relative}/handler.js`, 'module.exports = { start: () => ({ ok: true }), stop: () => true, health: () => ({ status: "healthy" }) }\n')
  return area.path(relative)
}

test('an adapter that throws on every call is refused per artifact, and the batch continues', async () => {
  const area = scratch()
  try {
    const built = framework()
    let calls = 0
    built.register({
      id: 'hostile.adapter',
      version: '1.0.0',
      api_version: ADAPTER_API_VERSION,
      // Highest priority, so it is asked first for everything it claims.
      priority: 1000,
      supports: ['dshns.declared', MOCK_FORMAT_FILE === 'mock-plugin.json' ? 'mock.manifest' : 'mock.manifest'],
      accepts: () => true,
      async adapt() {
        calls += 1
        throw new Error(`adapter exploded on call ${calls}`)
      }
    })

    const good = goodMockPlugin(area)
    const adapted = await built.adaptMany([{ dir: good }, { dir: good }, { dir: good }])

    // The hostile adapter was tried, refused, and the working one still produced plugins.
    assert.equal(calls, 3, 'the hostile adapter must be asked, not skipped')
    assert.equal(adapted.plugins.length, 3, 'a throwing adapter must not stop the other adapters')
    for (const plugin of adapted.plugins) {
      assert.equal(plugin.manifest.adapter.id, 'mock.format')
      // The passed-over failure is kept: it names the adapter and the reason.
      assert.equal(plugin.adaptation.attempts.length, 1)
      assert.equal(plugin.adaptation.attempts[0].adapter, 'hostile.adapter')
      assert.equal(plugin.adaptation.attempts[0].code, ADAPTER_FAULT_CODES.THREW)
      assert.match(plugin.adaptation.attempts[0].reason, /adapter exploded on call/)
    }
  } finally {
    area.dispose()
  }
})

test('an adapter that returns nonsense is refused, and the next adapter still gets its turn', async () => {
  const area = scratch()
  try {
    const good = goodMockPlugin(area)
    for (const [label, adapt] of [
      ['null', async () => null],
      ['a string', async () => 'not a descriptor'],
      ['no manifest', async () => ({ load() {} })],
      ['a bad hook', async () => ({ manifest: { api_version: 'dshns.plugin/v1', id: 'x.y', name: 'y', version: '1.0.0' }, load: 'yes' })],
      ['an invalid manifest', async () => ({ manifest: { api_version: 'dshns.plugin/v1', id: 'Not An Id', version: 'nope' } })]
    ]) {
      const built = framework()
      built.register({
        id: 'malformed.adapter',
        version: '1.0.0',
        api_version: ADAPTER_API_VERSION,
        priority: 1000,
        supports: ['mock.manifest'],
        accepts: () => true,
        adapt
      })
      const adapted = await built.adapt({ dir: good })
      assert.equal(adapted.ok, true, `adapter returning ${label} was not skipped`)
      assert.equal(adapted.adapter.id, 'mock.format')
      assert.equal(adapted.plugin.adaptation.attempts[0].adapter, 'malformed.adapter')
    }
  } finally {
    area.dispose()
  }
})

test('a detector that throws does not stop detection, and a detector that returns junk is ignored', () => {
  const detector = createTypeDetector({ log: () => {} })
  detector.register({ id: 'throws', priority: 900, detect: () => { throw new Error('detector exploded') } })
  detector.register({ id: 'junk', priority: 800, detect: () => 'not a detection' })
  detector.register({ id: 'half', priority: 700, detect: () => ({ confidence: 1 }) })

  const area = scratch()
  try {
    area.write('dshns-plugin.json', { api_version: 'dshns.plugin/v1', id: 'acme.x', name: 'X', version: '1.0.0' })
    const detected = detector.detect({ dir: area.dir })
    assert.equal(detected.ok, true, 'the built-in detector must still answer')
    assert.equal(detected.type, 'dshns.declared')
    assert.equal(detected.faults.length, 1)
    assert.equal(detected.faults[0].detector, 'throws')
    // A detector that returns something without a type contributes nothing rather than a bad type.
    assert.equal(detected.detections.every((entry) => typeof entry.type === 'string' && entry.type), true)
  } finally {
    area.dispose()
  }
})

test('a malformed adapter definition cannot be registered, and registration survives it', () => {
  const registry = createAdapterRegistry({ log: () => {} })
  registry.register({
    id: 'ok.adapter',
    version: '1.0.0',
    api_version: ADAPTER_API_VERSION,
    supports: ['t'],
    async adapt() { return { manifest: { api_version: 'dshns.plugin/v1', id: 'a.b', name: 'b', version: '1.0.0' } } }
  })

  for (const broken of [
    null,
    {},
    { id: 'x', version: '1.0.0', api_version: ADAPTER_API_VERSION, supports: ['t'] },
    { id: 'x', version: '1.0.0', api_version: 'wrong', supports: ['t'], adapt() {} },
    { id: 'x', version: '1.0.0', api_version: ADAPTER_API_VERSION, supports: [], adapt() {} }
  ]) {
    const refused = registry.register(broken)
    assert.equal(refused.ok, false, `${JSON.stringify(broken)} was registered`)
    assert.equal(refused.code, ADAPTER_FAULT_CODES.BAD_ADAPTER)
    assert.ok(refused.reason.length > 0)
  }
  // The good adapter is untouched by all of that.
  assert.equal(registry.size, 1)
  assert.equal(registry.select({ type: 't' }).adapter.id, 'ok.adapter')
})

test('a plugin whose load hook throws is one faulty plugin, not a failed platform', async () => {
  const area = scratch()
  try {
    const built = framework()
    area.write('bad/dshns-plugin.json', { api_version: 'dshns.plugin/v1', id: 'acme.bad', name: 'Bad', version: '1.0.0', main: 'index.cjs' })
    const good = goodMockPlugin(area)

    const badAdapted = await built.adapt({ dir: area.path('bad'), module: { manifest: { api_version: 'dshns.plugin/v1', id: 'acme.bad', name: 'Bad', version: '1.0.0' }, async load() { throw new Error('this plugin cannot start') } } })
    const goodAdapted = await built.adapt({ dir: good })
    assert.equal(badAdapted.ok, true, 'a plugin that will fail later must still be installable')

    const { createPluginManager } = require('../../app/core/plugin-manager/index.cjs')
    const manager = createPluginManager({ log: () => {} })
    assert.equal(manager.install(badAdapted.plugin).ok, true)
    assert.equal(manager.install(goodAdapted.plugin).ok, true)
    // The demonstration format never enables itself — the same rule adoption follows — so the
    // working plugin is enabled the way a user would enable one.
    assert.equal(manager.entry('mock.acme.good').enabled, false, 'a plugin from a foreign format must not auto-enable')
    manager.enable('mock.acme.good')

    const loaded = await manager.loadAll()
    const bad = loaded.results.find((result) => result.plugin === 'acme.bad')
    const okay = loaded.results.find((result) => result.plugin === 'mock.acme.good')
    assert.equal(bad.ok, false)
    assert.equal(bad.code, 'PLUGIN_LOAD_FAILED')
    // The other plugin loaded, which is the property the platform is built on.
    assert.equal(okay.ok, true)
    const status = manager.status('acme.bad')
    assert.equal(status.state, 'enabled', 'a plugin that failed to load is enabled and not loaded, which is a state a user can act on')
    assert.match(status.fault.reason, /this plugin cannot start/)
  } finally {
    area.dispose()
  }
})

test('a health check that throws is reported as unhealthy and never escapes', async () => {
  const area = scratch()
  try {
    const built = framework()
    const adapted = await built.adapt({
      dir: area.dir,
      module: {
        manifest: { api_version: 'dshns.plugin/v1', id: 'acme.sick', name: 'Sick', version: '1.0.0' },
        async healthCheck() { throw new Error('the probe is broken') }
      }
    })
    const { createPluginManager } = require('../../app/core/plugin-manager/index.cjs')
    const manager = createPluginManager({ log: () => {} })
    manager.install(adapted.plugin)
    await manager.loadAll()
    const health = await manager.checkHealth('acme.sick')
    assert.equal(health.status, 'unhealthy')
    assert.match(health.reason, /the probe is broken/)
  } finally {
    area.dispose()
  }
})

test('the plugin host still boots when every installed plugin is defective', async () => {
  const area = scratch()
  try {
    const root = path.join(area.dir, 'root')
    fs.mkdirSync(path.join(root, 'data', 'plugins', 'store'), { recursive: true })

    // A store of nothing but ways a plugin can be broken.
    const store = path.join(root, 'data', 'plugins', 'store')

    // 1. A module that throws at import time.
    fs.mkdirSync(path.join(store, 'explodes'), { recursive: true })
    fs.writeFileSync(path.join(store, 'explodes', 'index.cjs'), 'throw new Error("import-time explosion")\n', 'utf8')

    // 2. A module that exports nothing resembling a plugin.
    fs.mkdirSync(path.join(store, 'empty'), { recursive: true })
    fs.writeFileSync(path.join(store, 'empty', 'index.cjs'), 'module.exports = { notAPlugin: true }\n', 'utf8')

    // 3. A directory that is not there at all.
    // 4. A manifest that is not JSON.
    fs.mkdirSync(path.join(store, 'badmanifest'), { recursive: true })
    fs.writeFileSync(path.join(store, 'badmanifest', 'dshns-plugin.json'), '{ this is not json', 'utf8')

    // 5. A directory nothing can recognise at all.
    fs.mkdirSync(path.join(store, 'nothing'), { recursive: true })

    // 6. An entry point that escapes its directory.
    fs.mkdirSync(path.join(store, 'escapee'), { recursive: true })
    fs.writeFileSync(path.join(store, 'escapee', 'index.cjs'), 'module.exports = {}\n', 'utf8')

    const entries = [
      { id: 'explodes', dir: path.join(store, 'explodes'), main: 'index.cjs', enabled: true, repo: 'a/explodes' },
      { id: 'empty', dir: path.join(store, 'empty'), main: 'index.cjs', enabled: true, repo: 'a/empty' },
      { id: 'missing', dir: path.join(store, 'not-there'), main: 'index.cjs', enabled: true, repo: 'a/missing' },
      { id: 'badmanifest', dir: path.join(store, 'badmanifest'), main: 'index.cjs', enabled: true, repo: 'a/bad' },
      { id: 'nothing', dir: path.join(store, 'nothing'), main: 'index.cjs', enabled: true, repo: 'a/nothing' },
      { id: 'escapee', dir: path.join(store, 'escapee'), main: '../../outside.cjs', enabled: true, repo: 'a/escapee' }
    ]
    fs.writeFileSync(path.join(root, 'data', 'plugins', 'installed.json'), `${JSON.stringify({ version: 1, plugins: entries }, null, 2)}\n`, 'utf8')

    const host = createPluginHost({ root, log: () => {}, nodeExe: process.execPath })
    try {
      // The whole point: `ensure()` resolves. It does not reject, and it does not report the
      // product as unable to start because of a plugin somebody else wrote.
      const built = await host.ensure()
      assert.equal(built.ok, true, `the host refused to boot: ${built.error}`)

      const status = host.status()
      assert.equal(status.ok, true)
      // The shipped plugin set is always mounted, so "no plugin is running" would be the wrong
      // expectation. What matters is that not one of the *installed* entries became a plugin.
      const broken = new Set(entries.map((entry) => entry.id))
      assert.deepEqual(
        host.list().plugins.filter((plugin) => broken.has(plugin.id)).map((plugin) => plugin.id),
        [],
        'not one of these is a plugin that can run'
      )

      // And every one of them is reported, by id, with a reason a user can act on.
      const reported = new Map(status.errors.filter((entry) => entry.source === 'adapter').map((entry) => [entry.id, entry.error]))
      assert.ok(reported.size >= 5, `expected each broken install to be reported, got ${JSON.stringify(status.errors)}`)
      assert.match(reported.get('explodes'), /import-time explosion/)
      assert.match(reported.get('missing'), /ENOENT|no such file|cannot find/i)
      assert.match(reported.get('escapee'), /escapes the plugin directory/)
      // A module that imports but exports nothing recognisable reaches the detector and is refused
      // there — which is the case the framework's own vocabulary exists for.
      assert.match(reported.get('empty'), /no detector recognised/i)
      assert.match(reported.get('nothing'), /Cannot find module/i)
      assert.match(reported.get('badmanifest'), /badmanifest|index\.cjs/i)
      // An adapter failure names the adapter and the phase, so the report says where it happened.
      const undetected = status.errors.find((entry) => entry.id === 'empty' && entry.source === 'adapter')
      assert.equal(undetected.code, ADAPTER_FAULT_CODES.UNDETECTED)
      assert.equal(undetected.phase, 'detect')
    } finally {
      await host.dispose('test teardown')
    }
  } finally {
    area.dispose()
  }
})

test('a host with one good plugin and several broken ones still mounts the good one', async () => {
  const area = scratch()
  try {
    const root = path.join(area.dir, 'root')
    const store = path.join(root, 'data', 'plugins', 'store')
    fs.mkdirSync(path.join(store, 'good'), { recursive: true })
    fs.writeFileSync(
      path.join(store, 'good', 'index.cjs'),
      'module.exports = { manifest: { api_version: "dshns.plugin/v1", id: "acme.good", name: "Good", version: "1.0.0" }, load() {} }\n',
      'utf8'
    )
    fs.mkdirSync(path.join(store, 'broken'), { recursive: true })
    fs.writeFileSync(path.join(store, 'broken', 'index.cjs'), 'throw new Error("broken on import")\n', 'utf8')

    fs.writeFileSync(path.join(root, 'data', 'plugins', 'installed.json'), `${JSON.stringify({
      version: 1,
      plugins: [
        { id: 'broken', dir: path.join(store, 'broken'), main: 'index.cjs', enabled: true, repo: 'a/broken' },
        { id: 'acme.good', dir: path.join(store, 'good'), main: 'index.cjs', enabled: true, repo: 'a/good' },
        { id: 'ghost', dir: path.join(store, 'ghost'), main: 'index.cjs', enabled: true, repo: 'a/ghost' }
      ]
    }, null, 2)}\n`, 'utf8')

    const host = createPluginHost({ root, log: () => {}, nodeExe: process.execPath })
    try {
      const built = await host.ensure()
      assert.equal(built.ok, true, built.error)
      const plugins = host.list().plugins
      const mounted = plugins.find((plugin) => plugin.id === 'acme.good')
      assert.ok(mounted, `the working plugin must still be mounted; mounted: ${plugins.map((plugin) => plugin.id).join(', ')}`)
      // The defective entries did not become plugins — the shipped set is all that is left.
      assert.equal(plugins.some((plugin) => plugin.id === 'broken' || plugin.id === 'ghost'), false)
      assert.equal(mounted.loaded, true)
      // And it carries the standard sections the adapter framework produced.
      assert.equal(mounted.adapter.id, 'dshns.native')
      assert.equal(mounted.adaptation.detected_type, 'dshns.module')
      assert.equal(mounted.runtime.kind, 'in-process')
      assert.deepEqual(mounted.permissions.granted, [])
      assert.equal(mounted.lifecycle, 'loaded')
      assert.equal(mounted.errorCount, 0)
    } finally {
      await host.dispose('test teardown')
    }
  } finally {
    area.dispose()
  }
})

test('the framework never rejects, even when the whole adapter set is hostile', async () => {
  const area = scratch()
  try {
    const built = createAdapterFramework({ log: () => {} })
    // Every adapter throws from both hooks, and one of them throws from a getter that the
    // framework reads while building its own description.
    built.register({
      id: 'hostile.one',
      version: '1.0.0',
      api_version: ADAPTER_API_VERSION,
      priority: 100,
      supports: ['*'],
      accepts() { throw new Error('accepts exploded') },
      async adapt() { throw new Error('adapt exploded') }
    })
    built.register({
      id: 'hostile.two',
      version: '1.0.0',
      api_version: ADAPTER_API_VERSION,
      priority: 50,
      supports: ['*'],
      accepts() { return true },
      async adapt() { throw new Error('adapt exploded again') },
      describe() { throw new Error('describe exploded') }
    })
    built.detector.register({ id: 'hostile-detector', priority: 1000, detect() { throw new Error('detect exploded') } })

    // A recognizable package on disk, so detection succeeds and the hostile *adapters* are what
    // gets exercised — the detector failure is covered separately above.
    area.write('pkg/package.json', { name: 'acme.hostile', version: '1.0.0', type: 'module' })

    // Neither call rejects, and both answer.
    const many = await built.adaptMany([{ dir: area.path('pkg') }, { dir: area.path('pkg') }])
    assert.equal(many.plugins.length, 0)
    assert.equal(many.failures.length, 2)
    for (const failure of many.failures) {
      assert.equal(failure.ok, false)
      assert.equal(failure.code, ADAPTER_FAULT_CODES.REFUSED)
      assert.match(failure.reason, /hostile\.(one|two)/)
    }

    const described = built.describe()
    assert.equal(described.adapters.length, 2, 'the description survives an adapter whose describe() throws')
    assert.equal(described.adapters.find((adapter) => adapter.id === 'hostile.two').detail.error, 'describe exploded')
  } finally {
    area.dispose()
  }
})

test('an artifact that is not an object is refused without touching an adapter', async () => {
  const built = framework()
  for (const artifact of [null, undefined, 42, 'a path', true]) {
    const adapted = await built.adapt(artifact)
    assert.equal(adapted.ok, false, `${String(artifact)} was adapted`)
    assert.equal(adapted.code, ADAPTER_FAULT_CODES.BAD_ARTIFACT)
  }
  const many = await built.adaptMany([null, 1, 'x'])
  assert.equal(many.failures.length, 3)
  assert.equal(many.plugins.length, 0)
})
