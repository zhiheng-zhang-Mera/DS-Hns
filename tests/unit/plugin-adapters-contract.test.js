'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  ADAPTER_API_VERSION,
  ADAPTER_FAULT_CODES,
  RUNTIME_KINDS,
  PERMISSION_IDS,
  PERMISSIONS,
  adapterFault,
  validateAdapter,
  normalizeAdapter,
  declarePermissions,
  resolvePermissions,
  standardizeRuntime,
  standardizeManifest,
  validateAdapterOutput
} = require('../../app/core/plugin-adapters/contract.cjs')

/**
 * The adapter contract.
 *
 * Everything an adapter is allowed to produce is decided here, once, so that the framework can
 * treat every adapter — the two that ship and any that are added — as untrusted in the same way.
 * These tests are about the four rules the module states: an adapter cannot invent a manifest, it
 * cannot widen its own authority, it cannot claim an isolation it does not provide, and its
 * failures are values rather than exceptions.
 */

function validAdapter(overrides = {}) {
  return {
    id: 'test.adapter',
    version: '1.2.3',
    api_version: ADAPTER_API_VERSION,
    supports: ['test.type'],
    async adapt() {
      return { manifest: minimalManifest() }
    },
    ...overrides
  }
}

function minimalManifest(overrides = {}) {
  return {
    api_version: 'dshns.plugin/v1',
    id: 'test.plugin',
    name: 'Test plugin',
    version: '1.0.0',
    ...overrides
  }
}

test('an adapter definition is validated in full, and every problem is named', () => {
  assert.deepEqual(validateAdapter(validAdapter()), { ok: true, errors: [] })

  // Each of these is a way an adapter can be wrong, and each must be reported rather than
  // discovered later by whichever plugin happens to select it.
  const cases = [
    [{ id: 'Bad Id' }, /not a valid adapter id/],
    [{ version: 'v1' }, /not a semantic version/],
    [{ api_version: 'dshns.adapter/v2' }, /api_version must be/],
    [{ adapt: undefined }, /adapt must be a function/],
    [{ supports: [] }, /supports must be a non-empty array/],
    [{ supports: ['  '] }, /non-empty type names/],
    [{ accepts: 'yes' }, /accepts must be a function/],
    [{ priority: 'high' }, /priority must be a number/]
  ]
  for (const [override, pattern] of cases) {
    const result = validateAdapter(validAdapter(override))
    assert.equal(result.ok, false, `${JSON.stringify(override)} was accepted`)
    assert.match(result.errors.join('; '), pattern)
  }

  // The whole list is reported, not the first problem: an adapter author should get one answer
  // with everything in it rather than a sequence of runs.
  const many = validateAdapter({ id: 'x', version: 'no', api_version: 'no', supports: [] })
  assert.equal(many.ok, false)
  assert.ok(many.errors.length >= 4, `expected several errors, got ${many.errors.join('; ')}`)

  assert.equal(validateAdapter(null).ok, false)
  assert.equal(validateAdapter('adapter').ok, false)
})

test('a normalized adapter carries the documented defaults', () => {
  const normalized = normalizeAdapter(validAdapter({ supports: ['a', 'b', 'a'] }))
  assert.deepEqual(normalized.supports, ['a', 'b'], 'duplicate types must collapse')
  assert.equal(normalized.priority, 0, 'a missing priority is zero, never undefined')
  assert.equal(normalized.runtime_kind, RUNTIME_KINDS.IN_PROCESS.id)
  assert.deepEqual(normalized.guarantees, [])
  assert.equal(normalized.accepts, null, 'a missing accepts is null rather than a stub')
  assert.equal(normalized.name, 'test.adapter', 'name falls back to the id')
  assert.equal(normalized.api_version, ADAPTER_API_VERSION)
})

test('the permission vocabulary is closed, and unknown names are reported rather than dropped', () => {
  assert.ok(PERMISSION_IDS.length >= 8)
  for (const id of PERMISSION_IDS) {
    assert.match(id, /^[a-z][a-z0-9.]*$/, `${id} is not in the platform's id style`)
    assert.ok(PERMISSIONS[id].summary, `${id} has no summary`)
    assert.ok(PERMISSIONS[id].detail, `${id} has no detail`)
  }

  const declared = declarePermissions(['fs.read', 'fs.read', 'network', 'root.everything', ''])
  assert.deepEqual(
    declared.declared,
    ['fs.read', 'network', 'root.everything'],
    'everything the plugin asked for is kept, including what the platform cannot name'
  )
  assert.deepEqual(declared.unknown, ['root.everything'], 'an unknown permission must be surfaced, not silently accepted')
  assert.deepEqual(declarePermissions(null), { declared: [], unknown: [] })
})

test('the platform decides what a plugin holds, and a policy can only narrow', () => {
  // No policy: everything in the vocabulary is granted.
  const open = resolvePermissions({ proposed: ['fs.read', 'network'] })
  assert.deepEqual(open.granted, ['fs.read', 'network'])
  assert.deepEqual(open.refused, [])
  assert.equal(open.complete, true)

  // A deny-list removes one, and says why.
  const denied = resolvePermissions({ proposed: ['fs.read', 'network'], policy: { deny: ['network'] } })
  assert.deepEqual(denied.granted, ['fs.read'])
  assert.equal(denied.refused.length, 1)
  assert.equal(denied.refused[0].permission, 'network')
  assert.match(denied.refused[0].reason, /policy denies/)
  assert.equal(denied.complete, false)

  // An allow-list is a whitelist: anything not on it is refused.
  const limited = resolvePermissions({ proposed: ['fs.read', 'network', 'process.spawn'], policy: { allow: ['fs.read'] } })
  assert.deepEqual(limited.granted, ['fs.read'])
  assert.deepEqual(limited.refused.map((entry) => entry.permission), ['network', 'process.spawn'])

  // The plugin's own declaration and the adapter's proposal are unioned, so neither can be
  // overruled by the other's silence.
  const unioned = resolvePermissions({ proposed: ['fs.read'], declared: ['bus.emit'] })
  assert.deepEqual(unioned.declared, ['bus.emit', 'fs.read'])
  assert.deepEqual(unioned.granted, ['bus.emit', 'fs.read'])

  // An unknown permission is refused with a reason that says why it cannot simply be honoured.
  const unknown = resolvePermissions({ proposed: ['root.everything'] })
  assert.deepEqual(unknown.unknown, ['root.everything'])
  assert.equal(unknown.refused.length, 1)
  assert.match(unknown.refused[0].reason, /vocabulary/)
})

test('a runtime kind states the enforcement it actually has', () => {
  const inProcess = standardizeRuntime({ kind: RUNTIME_KINDS.IN_PROCESS.id })
  assert.equal(inProcess.enforcement, 'advisory', 'in-process code has the process\'s own rights and the declaration must say so')
  assert.equal(inProcess.isolation, 'none')

  const isolated = standardizeRuntime({ kind: RUNTIME_KINDS.ISOLATED_PROCESS.id })
  assert.equal(isolated.enforcement, 'process-boundary')
  assert.equal(isolated.isolation, 'process')

  const declarative = standardizeRuntime({ kind: RUNTIME_KINDS.DECLARATIVE.id })
  assert.equal(declarative.enforcement, 'declared-only')

  // An unknown kind is not a crash and not a silent pass-through: it falls back to the weakest
  // claim, which is the in-process one.
  const unknown = standardizeRuntime({ kind: 'quantum' })
  assert.equal(unknown.kind, RUNTIME_KINDS.IN_PROCESS.id)
  assert.equal(unknown.enforcement, 'advisory')

  assert.equal(standardizeRuntime({}).kind, RUNTIME_KINDS.IN_PROCESS.id)
})

test('an adapter may not invent a manifest the platform would refuse from anybody else', () => {
  const adapter = normalizeAdapter(validAdapter())

  const good = standardizeManifest({ manifest: minimalManifest(), adapter })
  assert.equal(good.ok, true)
  assert.equal(good.manifest.permissions.declared.length, 0)
  assert.equal(good.manifest.runtime.kind, RUNTIME_KINDS.IN_PROCESS.id)
  assert.equal(good.manifest.adapter.id, 'test.adapter')
  assert.equal(good.manifest.adapter.api_version, ADAPTER_API_VERSION)
  assert.equal(typeof good.manifest.adapter.adapted_at, 'number')

  // Every one of these is a manifest the platform refuses, and the refusal is the platform's own
  // code — the adapter does not get a second, weaker contract.
  for (const broken of [
    minimalManifest({ api_version: 'dshns.plugin/v2' }),
    minimalManifest({ id: 'Not An Id' }),
    minimalManifest({ version: 'latest' })
  ]) {
    const refused = standardizeManifest({ manifest: broken, adapter })
    assert.equal(refused.ok, false, `${JSON.stringify(broken)} was accepted from an adapter`)
    assert.equal(refused.code, ADAPTER_FAULT_CODES.INVALID_MANIFEST)
  }

  assert.equal(standardizeManifest({ manifest: null, adapter }).ok, false)
})

test('standardising a manifest resolves permissions against the deployment policy', () => {
  const adapter = normalizeAdapter(validAdapter())
  const standardized = standardizeManifest({
    manifest: minimalManifest({ permissions: { declares: ['fs.read', 'network'] } }),
    adapter,
    permissions: ['bus.emit'],
    policy: { deny: ['network'] }
  })
  assert.equal(standardized.ok, true)
  // Proposal and declaration are unioned, then the policy is applied to the union.
  assert.deepEqual(standardized.manifest.permissions.declared, ['bus.emit', 'fs.read', 'network'])
  assert.deepEqual(standardized.manifest.permissions.granted, ['bus.emit', 'fs.read'])
  assert.deepEqual(standardized.manifest.permissions.refused.map((entry) => entry.permission), ['network'])
  assert.equal(standardized.permissions.complete, false)
})

test('the output an adapter returns is checked before the framework attaches anything to it', () => {
  assert.equal(validateAdapterOutput(null, 'a').ok, false)
  assert.equal(validateAdapterOutput('descriptor', 'a').code, ADAPTER_FAULT_CODES.INVALID_OUTPUT)
  assert.equal(validateAdapterOutput({}, 'a').reason, 'adapter a returned a descriptor with no manifest')
  assert.equal(validateAdapterOutput({ manifest: minimalManifest(), load: 'yes' }, 'a').reason, 'adapter a returned a load that is not a function')
  assert.equal(validateAdapterOutput({ manifest: minimalManifest(), runtimeInfo: 5 }, 'a').ok, false)
  assert.equal(validateAdapterOutput({ manifest: minimalManifest(), load() {}, unload() {}, healthCheck() {} }, 'a').ok, true)
})

test('a fault is one shape, so no caller has to parse a message to branch on it', () => {
  const fault = adapterFault('CODE', 'a reason', { extra: 1 })
  assert.deepEqual(fault, { ok: false, code: 'CODE', reason: 'a reason', extra: 1 })
  assert.equal(typeof adapterFault('C', 123).reason, 'string', 'a non-string reason is coerced, never passed through')
})
