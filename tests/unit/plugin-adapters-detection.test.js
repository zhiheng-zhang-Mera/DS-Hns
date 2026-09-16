'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createTypeDetector, PLUGIN_TYPES, MANIFEST_FILE, COMPAT_FILE, CORDIS_PATCH_FILE } = require('../../app/core/plugin-adapters/detect.cjs')
const { createAdapterRegistry, compareAdapters } = require('../../app/core/plugin-adapters/registry.cjs')
const { ADAPTER_API_VERSION, ADAPTER_FAULT_CODES } = require('../../app/core/plugin-adapters/contract.cjs')

/**
 * Detection and selection: the two questions that used to be answered by `if` statements in the
 * host. A plugin's type must be *named* with evidence, and the adapter that takes it must be
 * chosen by a rule the caller can predict and inspect.
 */

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshns-adapters-'))
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

test('the platform\'s own manifest is detected with the evidence that produced it', () => {
  const area = scratch()
  try {
    area.write(`${MANIFEST_FILE}`, { api_version: 'dshns.plugin/v1', id: 'acme.plugin', name: 'Acme', version: '1.0.0' })
    const detected = createTypeDetector().detect({ dir: area.dir })
    assert.equal(detected.ok, true)
    assert.equal(detected.type, PLUGIN_TYPES.DECLARED)
    assert.equal(detected.confidence, 1)
    assert.deepEqual(detected.evidence, [`${MANIFEST_FILE}#api_version=dshns.plugin/v1`])
    assert.equal(detected.detail.manifest.id, 'acme.plugin', 'the parsed manifest is handed on, not re-read by the adapter')
  } finally {
    area.dispose()
  }
})

test('a package for another host is detected as a Cordis bundle, and named by what declares it', () => {
  const area = scratch()
  try {
    area.write('package.json', {
      name: '@acme/dsh-pet',
      version: '0.3.22',
      type: 'module',
      main: 'lib/index.js',
      dsh: { bundle: { patch: './cordis.patch.yml' } }
    })
    area.write(CORDIS_PATCH_FILE, '- insert:\n')
    const detected = createTypeDetector().detect({ dir: area.dir })
    assert.equal(detected.type, PLUGIN_TYPES.CORDIS_BUNDLE)
    assert.ok(detected.evidence.some((line) => line.includes('dsh.bundle.patch')), 'the declaration is the evidence')
    assert.ok(detected.evidence.includes(CORDIS_PATCH_FILE))
    assert.equal(detected.detail.patch, './cordis.patch.yml')
  } finally {
    area.dispose()
  }
})

test('detection distinguishes what it can and refuses to guess when there is nothing to go on', () => {
  const area = scratch()
  try {
    // A plain ESM package that declares nothing recognisable is still typed, at low confidence.
    area.write('plain/package.json', { name: 'plain', version: '1.0.0', type: 'module' })
    const plain = createTypeDetector().detect({ dir: area.path('plain') })
    assert.equal(plain.type, PLUGIN_TYPES.NODE_ESM)
    assert.ok(plain.confidence < 0.5, 'an unrecognised package must not be detected confidently')

    area.write('cjs/package.json', { name: 'cjs', version: '1.0.0' })
    assert.equal(createTypeDetector().detect({ dir: area.path('cjs') }).type, PLUGIN_TYPES.NODE_CJS)

    // A derived compatibility descriptor is the most specific thing present.
    area.write('adopted/package.json', { name: 'adopted', version: '1.0.0', type: 'module' })
    area.write('adopted/' + COMPAT_FILE, { compat_version: 'dshns.compat/v1', id: 'compat.adopted', manifest: {} })
    const adopted = createTypeDetector().detect({ dir: area.path('adopted') })
    assert.equal(adopted.type, PLUGIN_TYPES.COMPAT_DESCRIPTOR)
    assert.equal(adopted.detections.length, 2, 'both the descriptor and the package are evidence')
    assert.equal(adopted.detections[0].type, PLUGIN_TYPES.COMPAT_DESCRIPTOR, 'the most specific detection wins')

    // Nothing at all is a coded refusal, never a bare null and never a guess.
    fs.mkdirSync(area.path('empty'), { recursive: true })
    const empty = createTypeDetector().detect({ dir: area.path('empty') })
    assert.equal(empty.ok, false)
    assert.equal(empty.code, ADAPTER_FAULT_CODES.UNDETECTED)

    const bad = createTypeDetector().detect({})
    assert.equal(bad.code, ADAPTER_FAULT_CODES.BAD_ARTIFACT)
    assert.equal(createTypeDetector().detect(null).code, ADAPTER_FAULT_CODES.BAD_ARTIFACT)
  } finally {
    area.dispose()
  }
})

test('a detector that throws is one detector, not the run', () => {
  const area = scratch()
  try {
    area.write('package.json', { name: 'acme', version: '1.0.0', type: 'module', dsh: { bundle: { patch: './x.yml' } } })
    const detector = createTypeDetector({ log: () => {} })
    const registered = detector.register({
      id: 'exploding',
      priority: 200,
      detect() {
        throw new Error('this detector is broken')
      }
    })
    assert.equal(registered.ok, true)

    const detected = detector.detect({ dir: area.dir })
    // The broken detector ran first (highest priority), threw, and the built-ins still answered.
    assert.equal(detected.ok, true)
    assert.equal(detected.type, PLUGIN_TYPES.CORDIS_BUNDLE)
    assert.equal(detected.faults.length, 1)
    assert.equal(detected.faults[0].code, ADAPTER_FAULT_CODES.DETECTOR_THREW)
    assert.equal(detected.faults[0].detector, 'exploding')
    assert.match(detected.faults[0].reason, /this detector is broken/)
  } finally {
    area.dispose()
  }
})

test('a detector set can be extended, and a duplicate id is refused', () => {
  const detector = createTypeDetector()
  const custom = { id: 'custom', priority: 5, detect: () => null }
  assert.equal(detector.register(custom).ok, true)
  assert.equal(detector.register(custom).code, ADAPTER_FAULT_CODES.BAD_ADAPTER)
  assert.equal(detector.register({ id: 'no-detect' }).code, ADAPTER_FAULT_CODES.BAD_ADAPTER)
  assert.equal(detector.register(null).code, ADAPTER_FAULT_CODES.BAD_ADAPTER)
  assert.ok(detector.list().some((entry) => entry.id === 'custom'), 'a registered detector joins the set')
  assert.ok(detector.types().includes(PLUGIN_TYPES.DECLARED))
})

/** An adapter good enough to be registered: the tests below are about selection, not adaptation. */
function stubAdapter(id, supports, priority = 0, extra = {}) {
  return {
    id,
    version: '1.0.0',
    api_version: ADAPTER_API_VERSION,
    supports,
    priority,
    async adapt() {
      return { manifest: { api_version: 'dshns.plugin/v1', id: `x.${id}`, name: id, version: '1.0.0' } }
    },
    ...extra
  }
}

test('registration validates once, at the point somebody wrote the adapter', () => {
  const registry = createAdapterRegistry({ log: () => {} })
  assert.equal(registry.register(stubAdapter('good.one', ['a'])).ok, true)
  assert.equal(registry.size, 1)

  const malformed = registry.register({ id: 'bad', version: 'x', api_version: ADAPTER_API_VERSION, supports: ['a'] })
  assert.equal(malformed.ok, false)
  assert.equal(malformed.code, ADAPTER_FAULT_CODES.BAD_ADAPTER)
  assert.equal(registry.size, 1, 'a refused adapter must not be half-registered')

  assert.equal(registry.register(stubAdapter('good.one', ['a'])).code, ADAPTER_FAULT_CODES.BAD_ADAPTER, 'a duplicate id is refused')
  assert.equal(registry.register(stubAdapter('good.one', ['a']), { replace: true }).ok, true, 'replacement is explicit')
})

test('selection order is total: priority first, then adapter id', () => {
  const registry = createAdapterRegistry({ log: () => {} })
  registry.register(stubAdapter('zulu', ['t'], 5))
  registry.register(stubAdapter('alpha', ['t'], 5))
  registry.register(stubAdapter('low', ['t'], 1))
  registry.register(stubAdapter('high', ['t'], 50))

  assert.deepEqual(registry.list().map((entry) => entry.id), ['high', 'alpha', 'zulu', 'low'])
  // The order must not depend on registration order, which is what comparing two adapters directly
  // is checking.
  assert.ok(compareAdapters({ priority: 5, id: 'a' }, { priority: 5, id: 'b' }) < 0)
  assert.ok(compareAdapters({ priority: 9, id: 'z' }, { priority: 1, id: 'a' }) < 0)

  const selected = registry.select({ type: 't' })
  assert.equal(selected.adapter.id, 'high')
})

test('a tie is resolved deterministically and reported, never hidden', () => {
  const registry = createAdapterRegistry({ log: () => {} })
  registry.register(stubAdapter('beta', ['t'], 5))
  registry.register(stubAdapter('alpha', ['t'], 5))
  const selected = registry.select({ type: 't' })
  assert.equal(selected.adapter.id, 'alpha', 'the tie breaks on id, so it is stable across restarts')
  assert.equal(selected.ambiguous, true, 'the tie is reported: which adapter ran is the first question asked')
  assert.deepEqual(selected.alternatives, ['beta'])
})

test('planning reports who was asked and what each of them said', () => {
  const registry = createAdapterRegistry({ log: () => {} })
  registry.register(stubAdapter('willing', ['t']))
  registry.register(stubAdapter('unwilling', ['t'], 5, {
    accepts: () => ({ ok: false, code: 'NEEDS_BUILD', reason: 'the declared entry is not in the repository' })
  }))
  registry.register(stubAdapter('silent', ['other']))

  const planned = registry.plan({ type: 't' }, { dir: 'x' })
  assert.equal(planned.ok, true)
  assert.deepEqual(planned.plan.map((entry) => entry.adapter.id), ['unwilling', 'willing'])
  assert.equal(planned.plan[0].accepted, false)
  assert.equal(planned.plan[0].refusal.code, 'NEEDS_BUILD')
  assert.deepEqual(planned.willing.map((adapter) => adapter.id), ['willing'])
  // An adapter that does not declare the type is never considered, so it costs nothing.
  assert.equal(planned.plan.some((entry) => entry.adapter.id === 'silent'), false)

  // Selection uses the same plan, so the two can never disagree about what an adapter said.
  const selected = registry.select({ type: 't' }, {})
  assert.equal(selected.adapter.id, 'willing')
  assert.deepEqual(selected.refusals.map((refusal) => refusal.code), ['NEEDS_BUILD'])
})

test('an accepts that throws refuses that adapter and the next one is still asked', () => {
  const registry = createAdapterRegistry({ log: () => {} })
  registry.register(stubAdapter('broken', ['t'], 9, {
    accepts() {
      throw new Error('this predicate is broken')
    }
  }))
  registry.register(stubAdapter('working', ['t'], 1))

  const selected = registry.select({ type: 't' })
  assert.equal(selected.ok, true)
  assert.equal(selected.adapter.id, 'working')
  assert.equal(selected.refusals[0].code, ADAPTER_FAULT_CODES.THREW)
  assert.match(selected.refusals[0].reason, /this predicate is broken/)

  // The diagnostic surface must explain this without running anything again.
  assert.equal(registry.get('broken').id, 'broken')
  assert.equal(registry.has('nope'), false)
  assert.equal(registry.unregister('broken').ok, true)
  assert.equal(registry.unregister('broken').code, ADAPTER_FAULT_CODES.BAD_ADAPTER)
})

test('a type nobody adapts and a detection with no type are both coded refusals', () => {
  const registry = createAdapterRegistry({ log: () => {} })
  registry.register(stubAdapter('only', ['known']))

  const none = registry.select({ type: 'unknown' })
  assert.equal(none.ok, false)
  assert.equal(none.code, ADAPTER_FAULT_CODES.NO_ADAPTER)
  assert.match(none.reason, /no registered adapter accepts the plugin type unknown/)

  assert.equal(registry.select({}).code, ADAPTER_FAULT_CODES.UNDETECTED)

  const allDecline = createAdapterRegistry({ log: () => {} })
  allDecline.register(stubAdapter('picky', ['t'], 1, { accepts: () => false }))
  const refused = allDecline.select({ type: 't' })
  assert.equal(refused.code, ADAPTER_FAULT_CODES.REFUSED)
  assert.match(refused.reason, /every adapter that accepts t declined/)
})

test('the wildcard lets an adapter be considered for every type', () => {
  const registry = createAdapterRegistry({ log: () => {} })
  registry.register(stubAdapter('fallback', ['*'], -100))
  const selected = registry.select({ type: 'anything.at.all' })
  assert.equal(selected.ok, true)
  assert.equal(selected.adapter.id, 'fallback')
})
