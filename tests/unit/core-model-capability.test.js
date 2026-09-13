'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const {
  MODEL_CAPABILITIES,
  REASONING_LEVELS,
  PARALLEL_MODES,
  normalizeCapabilities,
  createModelDescriptor,
  createModelRegistry,
  resolveReasoning,
  resolveParallelism
} = require('../../app/core/contracts/model.cjs')
const { createDeepSeekProvider, MODELS } = require('../../app/plugins/providers/deepseek/index.cjs')
const { DEFAULT_PROFILE, validateProfile, loadProfiles, registerProfiles } = require('../../app/core/contracts/profile.cjs')

/**
 * Model capability layer, provider and profiles (Update-Plan/accleration.md §7,
 * §10, §35-§39, §50).
 *
 * The rule under test is the prohibition the plan states: a generic plugin must
 * never branch on a model's name, only on what it can do. The tests therefore ask
 * capability questions and assert the *narrowing* behaviour — a profile may ask for
 * more than a model can do, and the answer says what was actually granted.
 */
const ROOT = path.resolve(__dirname, '..', '..')

test('a model is described by capabilities, never by its name', () => {
  const provider = createDeepSeekProvider()
  const flash = provider.describe({ model: 'deepseek-v4.1-flash' })
  assert.equal(flash.known, true)
  assert.equal(flash.capabilities.toolCalling, true)
  assert.equal(flash.capabilities.reasoningControl, true)
  assert.equal(flash.capabilities.parallelToolCalls, true)
  assert.equal(flash.capabilities.vision, false)
  assert.equal(flash.reasoningCeiling, 'medium')

  const model = createModelDescriptor({ provider: 'deepseek', model: 'deepseek-v4.1-flash', capabilities: flash.capabilities })
  // The only question a plugin may ask.
  assert.equal(model.can('vision'), false)
  assert.equal(model.can('toolCalling'), true)
  assert.equal(model.can('nonexistentCapability'), false)
  assert.deepEqual(Object.keys(model.describe().capabilities).sort(), [...MODEL_CAPABILITIES, 'contextWindow'].sort())
  // No plugin reachable question names a model.
  assert.equal(typeof model.can, 'function')
  assert.equal(model.model, 'deepseek-v4.1-flash', 'the name is available for diagnostics, not for branching')
})

test('capabilities cannot contradict each other', () => {
  // A model that cannot call tools cannot call several at once.
  assert.equal(normalizeCapabilities({ parallelToolCalls: true }).parallelToolCalls, false)
  assert.equal(normalizeCapabilities({ toolCalling: true, parallelToolCalls: true }).parallelToolCalls, true)
  // An unknown model is described conservatively rather than refused, so a new
  // model name does not break a run.
  const provider = createDeepSeekProvider()
  const unknown = provider.describe({ model: 'deepseek-v9-unreleased' })
  assert.equal(unknown.known, false)
  assert.equal(unknown.capabilities.toolCalling, false)
  assert.match(unknown.reason, /does not know the model/)
})

test('reasoning narrows to the model ceiling instead of being invented', () => {
  const flash = createModelDescriptor({
    provider: 'deepseek',
    model: 'flash',
    capabilities: { reasoningControl: true }
  })
  // A request above the ceiling is reduced, and the substitution is reported.
  const reduced = resolveReasoning({ model: flash, requested: REASONING_LEVELS.HIGH, ceiling: REASONING_LEVELS.MEDIUM })
  assert.equal(reduced.level, REASONING_LEVELS.MEDIUM)
  assert.equal(reduced.requested, REASONING_LEVELS.HIGH)
  assert.equal(reduced.substituted, true)
  assert.match(reduced.reason, /ceiling is medium/)
  // A request at or below it is honoured.
  assert.equal(resolveReasoning({ model: flash, requested: REASONING_LEVELS.LOW, ceiling: REASONING_LEVELS.MEDIUM }).level, REASONING_LEVELS.LOW)
  // A model with no reasoning control is asked for nothing.
  const dumb = createModelDescriptor({ provider: 'x', model: 'y', capabilities: { toolCalling: true } })
  const none = resolveReasoning({ model: dumb, requested: REASONING_LEVELS.HIGH })
  assert.equal(none.level, REASONING_LEVELS.NONE)
  assert.equal(none.applied, false)
  assert.match(none.reason, /does not accept a reasoning level/)
  // An unknown level is a refusal, not a silent default.
  assert.match(resolveReasoning({ model: flash, requested: 'maximum' }).reason, /not a reasoning level/)
})

test('parallelism is capped by what the model can actually do', () => {
  const parallel = createModelDescriptor({ provider: 'x', model: 'parallel', capabilities: { toolCalling: true, parallelToolCalls: true } })
  const serial = createModelDescriptor({ provider: 'x', model: 'serial', capabilities: { toolCalling: true } })
  assert.equal(resolveParallelism({ model: parallel, requested: PARALLEL_MODES.AGGRESSIVE }).mode, PARALLEL_MODES.AGGRESSIVE)
  const capped = resolveParallelism({ model: serial, requested: PARALLEL_MODES.ADAPTIVE })
  assert.equal(capped.mode, PARALLEL_MODES.SAFE)
  assert.equal(capped.substituted, true)
  assert.match(capped.reason, /cannot issue parallel tool calls/)
  // A contract may switch parallelism off entirely, whatever the model allows.
  assert.equal(resolveParallelism({ model: parallel, requested: PARALLEL_MODES.ADAPTIVE, disabled: true }).mode, PARALLEL_MODES.OFF)
  assert.match(resolveParallelism({ model: parallel, requested: 'turbo' }).reason, /not a parallelism mode/)
})

test('the registry resolves a profile into a descriptor plus its policy', () => {
  const registry = createModelRegistry()
  registry.registerProvider({ id: 'deepseek', name: 'DeepSeek', describe: (input) => createDeepSeekProvider().describe(input) })
  const loaded = loadProfiles({ dir: path.join(ROOT, 'profiles'), providers: ['deepseek'] })
  assert.equal(loaded.errors.length, 0, JSON.stringify(loaded.errors))
  const registered = registerProfiles(registry, loaded.profiles)
  assert.ok(registered.registered.includes('flash-balanced'))
  assert.ok(registered.registered.includes('flash-fast'))
  assert.ok(registered.registered.includes('flash-deep'))
  assert.ok(registered.registered.includes('autonomous-24h'))
  assert.ok(registered.registered.includes('desktop-agent'))

  const balanced = registry.resolve('flash-balanced')
  assert.equal(balanced.ok, true)
  assert.equal(balanced.profile.id, 'flash-balanced')
  assert.equal(balanced.model.can('toolCalling'), true)
  assert.equal(balanced.reasoning.level, REASONING_LEVELS.LOW)
  assert.equal(balanced.parallelism.mode, PARALLEL_MODES.ADAPTIVE)
  assert.equal(balanced.policy.context.repoMap, true)
  assert.equal(balanced.policy.validation.afterTask, 'tier2')

  // flash-deep asks for high reasoning on a model whose ceiling is medium: the
  // substitution is reported rather than silently honoured.
  const deep = registry.resolve('flash-deep')
  assert.equal(deep.model.can('reasoningControl'), true)
  assert.equal(deep.reasoning.requested, REASONING_LEVELS.MEDIUM)
  assert.equal(deep.reasoning.level, REASONING_LEVELS.MEDIUM)

  // An unregistered profile is a refusal with the reason.
  assert.equal(registry.resolve('nope').ok, false)
  assert.match(registry.resolve('nope').reason, /no profile/)
  assert.equal(registry.setActiveProfile('flash-fast').ok, true)
  assert.equal(registry.activeProfile, 'flash-fast')
})

test('a profile is validated on load and a bad one is reported, not half-applied', () => {
  const providers = ['deepseek']
  assert.equal(validateProfile({ id: 'ok', provider: 'deepseek' }, { providers }).ok, true)
  const cases = [
    [{ id: 'Bad Id', provider: 'deepseek' }, /not a valid profile id/],
    [{ id: 'x' }, /must name a provider/],
    [{ id: 'x', provider: 'openai' }, /not registered/],
    [{ id: 'x', provider: 'deepseek', reasoning: { default: 'max' } }, /not one of none, low, medium, high/],
    [{ id: 'x', provider: 'deepseek', parallelism: { mode: 'turbo' } }, /not one of off, safe, adaptive, aggressive/],
    [{ id: 'x', provider: 'deepseek', context: 'yes' }, /context must be an object/]
  ]
  for (const [profile, pattern] of cases) {
    const result = validateProfile(profile, { providers })
    assert.equal(result.ok, false, JSON.stringify(profile))
    assert.match(result.errors.join('; '), pattern)
  }

  // A malformed file does not stop the others loading.
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'dshns-profiles-'))
  try {
    fs.writeFileSync(path.join(dir, 'good.json'), JSON.stringify({ id: 'good', provider: 'deepseek', model: 'deepseek-v4.1-flash' }), 'utf8')
    fs.writeFileSync(path.join(dir, 'broken.json'), '{ not json', 'utf8')
    fs.writeFileSync(path.join(dir, 'invalid.json'), JSON.stringify({ id: 'invalid', provider: 'nobody' }), 'utf8')
    const loaded = loadProfiles({ dir, providers })
    const ids = loaded.profiles.map((profile) => profile.id)
    assert.ok(ids.includes('good'), 'a valid profile still loads')
    assert.equal(loaded.errors.length, 2, JSON.stringify(loaded.errors))
    assert.ok(loaded.errors.some((entry) => entry.file === 'broken.json'))
    assert.ok(loaded.errors.some((entry) => entry.file === 'invalid.json' && /not registered/.test(entry.reason)))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the shipped profiles exist and the default is flash-balanced', () => {
  const dir = path.join(ROOT, 'profiles')
  for (const id of ['flash-fast', 'flash-balanced', 'flash-deep', 'autonomous-24h', 'desktop-agent']) {
    assert.equal(fs.existsSync(path.join(dir, `${id}.json`)), true, `profiles/${id}.json is missing`)
  }
  assert.equal(DEFAULT_PROFILE, 'flash-balanced')
  const loaded = loadProfiles({ dir, providers: ['deepseek'] })
  assert.equal(loaded.errors.length, 0, JSON.stringify(loaded.errors))
  const autonomous = loaded.profiles.find((profile) => profile.id === 'autonomous-24h')
  // The 24h profile is the one that enables the long-running plugin set.
  assert.equal(autonomous.plugins['dshns.long-term-worker'].enabled, true)
  assert.equal(autonomous.plugins['dshns.checkpoint'].enabled, true)
  assert.equal(autonomous.validation.beforeCommit, 'tier3')
  const desktop = loaded.profiles.find((profile) => profile.id === 'desktop-agent')
  assert.equal(desktop.plugins['dshns.computer-use'].enabled, true)
  assert.equal(desktop.parallelism.mode, 'safe', 'GUI work does not parallelise writes')
})
