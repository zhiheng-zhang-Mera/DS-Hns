'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createAdapterFramework } = require('../../app/core/plugin-adapters/index.cjs')
const { createNativeHnsAdapter } = require('../../app/core/plugin-adapters/adapters/native-hns.cjs')
const { createMockAdapter, createMockDetector, registerMockFormat, MOCK_FORMAT_FILE, MOCK_PLUGIN_TYPE } = require('../../app/core/plugin-adapters/adapters/mock.cjs')
const { ADAPTER_API_VERSION, ADAPTER_FAULT_CODES, RUNTIME_KINDS } = require('../../app/core/plugin-adapters/contract.cjs')

/**
 * The framework end to end, and the mock adapter that proves it is extensible.
 *
 * The claim this file exists to test is a strong one: a plugin in a format the platform has never
 * seen can be installed, detected, adapted, loaded, health-checked and unloaded without a single
 * change to the framework, the registry, the contract or the manager. The mock format is that
 * claim, executed.
 */

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshns-framework-'))
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

/** A mock-format plugin on disk, with a handler that records what happened to it. */
function mockPlugin(area, name, overrides = {}) {
  const relative = overrides.relative || name.replace(/[^a-z0-9]+/gi, '-')
  area.write(`${relative}/${MOCK_FORMAT_FILE}`, {
    mock_format: 1,
    name,
    version: overrides.version || '2.1.0',
    handler: 'handler.js',
    capabilities: overrides.capabilities || ['demo'],
    permissions: overrides.permissions || ['fs.read'],
    ...(overrides.declaration || {})
  })
  area.write(`${relative}/handler.js`, overrides.handler || `
module.exports = {
  start: (ctx) => ({ ok: true, detail: 'started ' + ctx.id }),
  stop: () => true,
  health: () => ({ status: 'healthy', reason: 'the handler is up' })
}
`)
  return area.path(relative)
}

function frameworkWithNative() {
  const framework = createAdapterFramework({ log: () => {} })
  framework.register(createNativeHnsAdapter())
  return framework
}

test('the mock format is registered with two calls and the framework is otherwise untouched', () => {
  const framework = frameworkWithNative()
  const before = framework.describe()

  const registered = registerMockFormat(framework)
  assert.equal(registered.ok, true, registered.reason)
  assert.equal(registered.detector, 'mock-format')
  assert.equal(registered.adapter, 'mock.format')

  const after = framework.describe()
  // Nothing about the platform changed except two more entries in two lists.
  assert.equal(after.types.length, before.types.length, 'the platform type vocabulary is not edited by an extension')
  assert.equal(after.adapters.length, before.adapters.length + 1)
  assert.equal(after.api_version, before.api_version)
  assert.ok(after.adapters.some((adapter) => adapter.id === 'mock.format'))
})

test('a plugin in a brand-new format is detected, adapted, loaded and unloaded', async () => {
  const area = scratch()
  try {
    const framework = frameworkWithNative()
    registerMockFormat(framework)
    const dir = mockPlugin(area, '@acme/demo', { permissions: ['fs.read', 'bus.emit'] })

    const adapted = await framework.adapt({ dir, source: 'acme/demo' })
    assert.equal(adapted.ok, true, adapted.reason)

    // Detection named a type the platform has never heard of, with the evidence for it.
    assert.equal(adapted.detection.type, MOCK_PLUGIN_TYPE)
    assert.deepEqual(adapted.detection.evidence, [`${MOCK_FORMAT_FILE}#mock_format=1`])

    // The adapter translated the format's own declaration into a real platform manifest.
    const plugin = adapted.plugin
    assert.equal(plugin.manifest.api_version, 'dshns.plugin/v1')
    assert.equal(plugin.manifest.id, 'mock.acme.demo')
    assert.equal(plugin.manifest.version, '2.1.0')
    assert.deepEqual(plugin.manifest.provides, ['demo'])
    assert.equal(plugin.manifest.adapter.id, 'mock.format')
    assert.equal(plugin.manifest.adapter.source_format, MOCK_PLUGIN_TYPE)

    // The permissions were the framework's to grant, not the adapter's.
    assert.deepEqual(plugin.manifest.permissions.granted, ['bus.emit', 'fs.read'])
    assert.equal(plugin.manifest.permissions.complete, true)

    // The lifecycle is the platform's, whatever the handler called its hooks.
    assert.equal(plugin.lifecycleState(), 'new')
    await plugin.load({ id: plugin.manifest.id, config: {} })
    assert.equal(plugin.lifecycleState(), 'loaded')
    assert.equal((await plugin.healthCheck()).status, 'healthy')
    assert.equal(plugin.runtimeInfo().detail.started, true)
    assert.equal((await plugin.unload()).ok, true)
    assert.equal(plugin.lifecycleState(), 'unloaded')
    assert.equal(plugin.errorReport().total, 0)

    // And the whole adaptation is on the record.
    assert.equal(plugin.adaptation.adapter.id, 'mock.format')
    assert.equal(plugin.adaptation.detected_type, MOCK_PLUGIN_TYPE)
    assert.equal(plugin.standard.runtime_kind, RUNTIME_KINDS.IN_PROCESS.id)
  } finally {
    area.dispose()
  }
})

test('the deployment policy decides what a plugin holds, and the refusal is reported', async () => {
  const area = scratch()
  try {
    const framework = frameworkWithNative()
    registerMockFormat(framework)
    const dir = mockPlugin(area, '@acme/risky', { permissions: ['fs.read', 'network', 'root.everything'] })

    // The policy narrows; it cannot widen.
    const adapted = await framework.adapt({ dir }, { policy: { deny: ['network'] } })
    assert.equal(adapted.ok, true, adapted.reason)
    const permissions = adapted.plugin.manifest.permissions
    assert.deepEqual(permissions.granted, ['fs.read'])
    assert.deepEqual(permissions.declared, ['fs.read', 'network', 'root.everything'])
    assert.deepEqual(permissions.refused.map((entry) => entry.permission).sort(), ['network', 'root.everything'])
    assert.deepEqual(permissions.unknown, ['root.everything'], 'a permission the platform cannot name is surfaced')
    assert.equal(permissions.complete, false)

    // A deployment that allows only one thing gets only that one thing, whatever was declared.
    const narrowed = await framework.adapt({ dir }, { policy: { allow: ['fs.read'] } })
    assert.deepEqual(narrowed.plugin.manifest.permissions.granted, ['fs.read'])
    assert.equal(narrowed.plugin.manifest.permissions.refused.length, 2)
  } finally {
    area.dispose()
  }
})

test('the framework refuses a format nobody adapts, without asking anybody to throw', async () => {
  const area = scratch()
  try {
    area.write('plain/package.json', { name: 'plain', version: '1.0.0', type: 'module' })
    const framework = frameworkWithNative()
    const adapted = await framework.adapt({ dir: area.path('plain') })
    // A node package with no adapter registered for it is a named refusal, not a crash and not a
    // silent success.
    assert.equal(adapted.ok, false)
    assert.equal(adapted.code, ADAPTER_FAULT_CODES.NO_ADAPTER)
    assert.match(adapted.reason, /no registered adapter accepts/)
  } finally {
    area.dispose()
  }
})

test('when the first willing adapter refuses, the next one still gets its turn', async () => {
  const area = scratch()
  try {
    const framework = frameworkWithNative()
    // A specific adapter that recognises the type but refuses this artifact...
    framework.register({
      id: 'specific.first',
      version: '1.0.0',
      api_version: ADAPTER_API_VERSION,
      supports: ['shared.type'],
      priority: 50,
      accepts: () => true,
      async adapt() {
        return { ok: false, code: 'SPECIFIC_NEEDS_A_BUILD', reason: 'the declared entry is not in the repository' }
      }
    })
    // ...and a broader one that can handle it.
    let secondRan = false
    framework.register({
      id: 'broad.fallback',
      version: '1.0.0',
      api_version: ADAPTER_API_VERSION,
      supports: ['shared.type'],
      priority: 10,
      accepts: () => true,
      async adapt() {
        secondRan = true
        return { manifest: { api_version: 'dshns.plugin/v1', id: 'x.fallback', name: 'Fallback', version: '1.0.0' } }
      }
    })

    // Drive it through a detector that produces the shared type.
    framework.detector.register({
      id: 'shared-detector',
      priority: 500,
      detect: () => ({ type: 'shared.type', confidence: 0.9, evidence: ['test'] })
    })

    const adapted = await framework.adapt({ dir: area.dir })
    assert.equal(adapted.ok, true, adapted.reason)
    assert.equal(secondRan, true, 'a refusal from the first adapter must not end the search')
    assert.equal(adapted.adapter.id, 'broad.fallback')
    // The refusal that was passed over is kept: it is often the more actionable of the two.
    assert.deepEqual(adapted.plugin.adaptation.attempts, [
      { adapter: 'specific.first', code: 'SPECIFIC_NEEDS_A_BUILD', reason: 'the declared entry is not in the repository' }
    ])
  } finally {
    area.dispose()
  }
})

test('adaptMany adapts a mixed batch, keeps the order, and reports one failure per bad artifact', async () => {
  const area = scratch()
  try {
    const framework = frameworkWithNative()
    registerMockFormat(framework)
    const good = mockPlugin(area, '@acme/good')
    const second = mockPlugin(area, '@acme/second')
    // A mock declaration whose handler is not there: the adapter refuses, the batch continues.
    area.write('broken/' + MOCK_FORMAT_FILE, { mock_format: 1, name: 'broken', version: '1.0.0', handler: 'missing.js' })
    fs.mkdirSync(area.path('empty'), { recursive: true })

    const adapted = await framework.adaptMany([
      { dir: good },
      { dir: area.path('empty') },
      { dir: area.path('broken') },
      { dir: second }
    ])
    assert.deepEqual(adapted.plugins.map((plugin) => plugin.manifest.id), ['mock.acme.good', 'mock.acme.second'])
    assert.equal(adapted.failures.length, 2)
    // The results array pairs each answer with the index it came from, so a caller need not guess.
    assert.deepEqual(adapted.results.map((result) => (result.ok ? 'ok' : result.code)), [
      'ok', ADAPTER_FAULT_CODES.UNDETECTED, ADAPTER_FAULT_CODES.REFUSED, 'ok'
    ])
    assert.deepEqual(adapted.results.map((result) => result.index), [0, 1, 2, 3])
    // The refusal carries the adapter's own actionable reason rather than a framework complaint.
    assert.match(adapted.failures[1].reason, /missing\.js is not in the plugin directory/)
  } finally {
    area.dispose()
  }
})

test('the artifact budget stops the work and says so instead of running away', async () => {
  const area = scratch()
  try {
    const framework = frameworkWithNative()
    registerMockFormat(framework)
    const artifacts = [0, 1, 2, 3].map((index) => ({ dir: mockPlugin(area, `@acme/p${index}`) }))
    const adapted = await framework.adaptMany(artifacts, { limit: 2 })
    assert.equal(adapted.plugins.length, 2)
    assert.equal(adapted.failures.length, 2)
    for (const failure of adapted.failures) {
      assert.equal(failure.code, ADAPTER_FAULT_CODES.BUDGET_EXCEEDED)
      assert.match(failure.reason, /only the first 2 artifacts were adapted/)
    }
  } finally {
    area.dispose()
  }
})

test('the native adapter handles both of the platform\'s own shapes', async () => {
  const area = scratch()
  try {
    const framework = frameworkWithNative()

    // A declared manifest with no entry: a declarative plugin. The adapter must not invent a
    // runtime for code that does not exist.
    area.write('declared/dshns-plugin.json', {
      api_version: 'dshns.plugin/v1',
      id: 'acme.declared',
      name: 'Declared',
      version: '1.0.0',
      permissions: { declares: ['fs.read'] }
    })
    const declared = await framework.adapt({ dir: area.path('declared') })
    assert.equal(declared.ok, true, declared.reason)
    assert.equal(declared.plugin.manifest.runtime.kind, RUNTIME_KINDS.DECLARATIVE.id)
    assert.equal(declared.plugin.manifest.runtime.enforcement, 'declared-only')
    assert.deepEqual(declared.plugin.manifest.permissions.granted, ['fs.read'])

    // An already-imported module: the plugin's own hooks are used unchanged.
    let loaded = 0
    const module_ = {
      manifest: { api_version: 'dshns.plugin/v1', id: 'acme.module', name: 'Module', version: '1.0.0' },
      async load() {
        loaded += 1
      },
      healthCheck: () => ({ status: 'healthy', reason: 'the module is up' })
    }
    const imported = await framework.adapt({ dir: area.dir, module: module_ })
    assert.equal(imported.ok, true, imported.reason)
    assert.equal(imported.detection.type, 'dshns.module')
    assert.equal(imported.plugin.manifest.adapter.id, 'dshns.native')
    await imported.plugin.load({})
    assert.equal(loaded, 1, 'the plugin\'s own load hook must run, not a substitute')
    assert.equal((await imported.plugin.healthCheck()).status, 'healthy')
  } finally {
    area.dispose()
  }
})

test('describe() is the panel\'s whole vocabulary, and reading it adapts nothing', () => {
  const framework = frameworkWithNative()
  registerMockFormat(framework)
  const described = framework.describe()
  assert.equal(described.api_version, ADAPTER_API_VERSION)
  assert.ok(described.adapters.length >= 2)
  assert.ok(described.types.includes('dshns.declared'))
  assert.ok(described.runtime_kinds.some((kind) => kind.id === 'isolated-process' && kind.enforcement === 'process-boundary'))
  assert.ok(described.permissions.some((permission) => permission.id === 'process.spawn' && permission.detail))
  assert.deepEqual(described.policy, { allow: null, deny: [] })
  assert.equal(described.limits.artifacts > 0, true)
  // It is a snapshot of the registration, not a run: the adapter list is unchanged by reading it.
  assert.deepEqual(framework.describe().adapters.map((adapter) => adapter.id), described.adapters.map((adapter) => adapter.id))
})

test('an adapter that throws or returns nonsense is a coded refusal, never an exception', async () => {
  const area = scratch()
  try {
    for (const [id, adapt, expected] of [
      ['throwing', async () => { throw new Error('adapter exploded') }, ADAPTER_FAULT_CODES.REFUSED],
      ['nullish', async () => null, ADAPTER_FAULT_CODES.REFUSED],
      ['manifestless', async () => ({ load() {} }), ADAPTER_FAULT_CODES.REFUSED]
    ]) {
      const framework = frameworkWithNative()
      framework.register({ id: `bad.${id}`, version: '1.0.0', api_version: ADAPTER_API_VERSION, supports: ['probe.type'], accepts: () => true, adapt })
      framework.detector.register({ id: `probe-${id}`, priority: 500, detect: () => ({ type: 'probe.type', confidence: 1, evidence: [] }) })
      const adapted = await framework.adapt({ dir: area.dir })
      assert.equal(adapted.ok, false, `${id} was accepted`)
      assert.equal(adapted.code, expected, `${id} produced ${adapted.code}`)
      // The framework's own reason names the adapter that failed, which is the actionable part.
      assert.match(adapted.reason, new RegExp(`bad\\.${id}`))
    }
  } finally {
    area.dispose()
  }
})

test('the mock detector reports the mock type and nothing else', () => {
  const area = scratch()
  try {
    area.write('package.json', { name: 'plain', version: '1.0.0' })
    assert.equal(createMockDetector().detect({ dir: area.dir }), null, 'a package with no mock declaration is not this detector\'s business')
    area.write(MOCK_FORMAT_FILE, { mock_format: 1, name: 'x', version: '1.0.0', handler: 'h.js' })
    const detected = createMockDetector().detect({ dir: area.dir })
    assert.equal(detected.type, MOCK_PLUGIN_TYPE)
    assert.equal(detected.detail.declaration.name, 'x')
  } finally {
    area.dispose()
  }
})

test('the mock adapter refuses a format version it does not understand', async () => {
  const area = scratch()
  try {
    const framework = frameworkWithNative()
    registerMockFormat(framework)
    const dir = mockPlugin(area, '@acme/future', { declaration: { mock_format: 99 } })
    const adapted = await framework.adapt({ dir })
    assert.equal(adapted.ok, false)
    assert.match(adapted.reason, /mock_format 99 is newer than this adapter understands/)
  } finally {
    area.dispose()
  }
})

test('a handler outside the plugin directory is refused rather than imported', async () => {
  const area = scratch()
  try {
    const framework = frameworkWithNative()
    registerMockFormat(framework)
    area.write('escape/' + MOCK_FORMAT_FILE, { mock_format: 1, name: 'escape', version: '1.0.0', handler: '../../outside.js' })
    area.write('outside.js', 'module.exports = {}')
    const adapted = await framework.adapt({ dir: area.path('escape') })
    assert.equal(adapted.ok, false)
    assert.match(adapted.reason, /escapes the plugin directory/)
  } finally {
    area.dispose()
  }
})

test('the mock adapter can be built with an injected loader, so its refusals are testable', async () => {
  const adapter = createMockAdapter({ require: () => { throw new Error('no loader here') } })
  assert.equal(adapter.id, 'mock.format')
  assert.equal(typeof adapter.adapt, 'function')
})
