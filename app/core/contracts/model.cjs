'use strict'

/**
 * DS-Hns Core: the model contract.
 *
 * The point of this file is a rule the plan states as a prohibition:
 *
 *   a generic plugin may never write `if (model === "deepseek-v4.1-flash")`
 *
 * It may only ask what the model *can do*. So a model is described by capabilities
 * — does it call tools, can it call several at once, does it accept a reasoning
 * level, does it see images, does it get a prompt cache — and a profile decides
 * the policy for those capabilities. Swapping DeepSeek for anything else is then
 * installing a provider and adding a profile, with no plugin touched.
 *
 * Two boundaries are enforced here:
 *
 *  * **Capability questions, never identity questions.** `supports(model, 'x')`
 *    and `resolveReasoning(...)` are the whole interface; nothing in the runtime
 *    may branch on a model name.
 *  * **A profile narrows, it does not invent.** A profile may ask for a reasoning
 *    level or a parallelism mode, and the model layer answers with what the model
 *    can actually do — a request for a capability the model lacks is reported, not
 *    silently honoured.
 */

/** The capabilities a model exposes. Everything else is provider detail. */
const MODEL_CAPABILITIES = Object.freeze([
  'toolCalling',
  'parallelToolCalls',
  'reasoningControl',
  'vision',
  'promptCaching',
  'cacheHints',
  'codingOptimized',
  // Whether the provider can serve a draft-model hint. It is a capability rather than a
  // plugin setting on purpose: a speculative request sent to a provider that ignores it
  // is a silent no-op, and the only honest place to ask is the model descriptor.
  'speculativeDecoding'
])

/** The reasoning levels, weakest first. `null` means "ask for none". */
const REASONING_LEVELS = Object.freeze({
  NONE: 'none',
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high'
})

const REASONING_ORDER = Object.freeze([REASONING_LEVELS.NONE, REASONING_LEVELS.LOW, REASONING_LEVELS.MEDIUM, REASONING_LEVELS.HIGH])

/** The parallelism modes the workbench offers. */
const PARALLEL_MODES = Object.freeze({
  OFF: 'off',
  SAFE: 'safe',
  ADAPTIVE: 'adaptive',
  AGGRESSIVE: 'aggressive'
})

/**
 * Normalize a capability declaration.
 *
 * A model with no capabilities is a text-completion model, which is legal: it can
 * still answer, it just cannot be asked to call a tool or to think harder.
 */
function normalizeCapabilities(input = {}) {
  const capabilities = {
    toolCalling: input.toolCalling === true,
    parallelToolCalls: input.parallelToolCalls === true,
    reasoningControl: input.reasoningControl === true,
    vision: input.vision === true,
    promptCaching: input.promptCaching === true,
    cacheHints: input.cacheHints === true,
    codingOptimized: input.codingOptimized === true,
    speculativeDecoding: input.speculativeDecoding === true,
    contextWindow: Number.isFinite(input.contextWindow) ? Number(input.contextWindow) : null
  }
  // A model that cannot call tools cannot call several of them at once: reporting
  // otherwise would let a batching plugin plan work the model cannot run.
  if (!capabilities.toolCalling) capabilities.parallelToolCalls = false
  // Parallel tool calls without tool calling is the same contradiction.
  return capabilities
}

/**
 * A model descriptor: what it is called and what it can do.
 *
 * @param {object} input
 * @param {string} input.provider the provider id, for diagnostics only
 * @param {string} input.model the model id, for diagnostics only
 * @param {object} [input.capabilities]
 */
function createModelDescriptor(input = {}) {
  if (!input.provider) throw new Error('a model descriptor needs a provider id')
  if (!input.model) throw new Error('a model descriptor needs a model id')
  const capabilities = normalizeCapabilities(input.capabilities || {})
  return {
    provider: String(input.provider),
    model: String(input.model),
    capabilities,
    contextWindow: capabilities.contextWindow,
    /** The only supported question: can this model do X? */
    can(name) {
      return capabilities[String(name)] === true
    },
    /** A plain, serialisable view for the UI and the telemetry. */
    describe() {
      return { provider: this.provider, model: this.model, capabilities: { ...capabilities } }
    }
  }
}

/**
 * Resolve the reasoning level to use, given what a profile asks for and what the
 * model can do.
 *
 * The rule is "narrow, never invent": a model without reasoning control is asked
 * for nothing, and a model that tops out below the request gets its own ceiling
 * with the substitution reported.
 *
 * @param {object} input
 * @param {object} input.model a descriptor
 * @param {string} [input.requested] the profile's level
 * @param {string} [input.ceiling] the highest level this model claims to support
 */
function resolveReasoning(input = {}) {
  const model = input.model
  const requested = String(input.requested || REASONING_LEVELS.NONE)
  const resolved = { requested, level: REASONING_LEVELS.NONE, applied: false, reason: null }
  if (!REASONING_ORDER.includes(requested)) {
    return { ...resolved, reason: `"${requested}" is not a reasoning level` }
  }
  if (!model || !model.can('reasoningControl')) {
    return { ...resolved, reason: 'the model does not accept a reasoning level, so none is requested' }
  }
  const ceiling = REASONING_ORDER.includes(String(input.ceiling || '')) ? String(input.ceiling) : REASONING_LEVELS.HIGH
  const wanted = REASONING_ORDER.indexOf(requested)
  const allowed = REASONING_ORDER.indexOf(ceiling)
  if (wanted > allowed) {
    return {
      requested,
      level: ceiling,
      applied: true,
      substituted: true,
      reason: `the model's ceiling is ${ceiling}, so ${requested} was reduced to ${ceiling}`
    }
  }
  return { requested, level: requested, applied: requested !== REASONING_LEVELS.NONE, substituted: false, reason: requested === REASONING_LEVELS.NONE ? 'no reasoning was requested' : null }
}

/**
 * Resolve the parallelism mode against what the model and the contract allow.
 *
 * `safe` is the lowest mode that still parallelises reads; `off` disables
 * concurrency entirely. A model that cannot call tools in parallel caps the mode at
 * `safe`, because the alternative is a plugin planning work the model will
 * serialise anyway.
 */
function resolveParallelism(input = {}) {
  const model = input.model
  const requested = String(input.requested || PARALLEL_MODES.ADAPTIVE)
  if (!Object.values(PARALLEL_MODES).includes(requested)) {
    return { requested, mode: PARALLEL_MODES.SAFE, substituted: true, reason: `"${requested}" is not a parallelism mode` }
  }
  if (input.disabled === true) {
    return { requested, mode: PARALLEL_MODES.OFF, substituted: requested !== PARALLEL_MODES.OFF, reason: 'the contract disables parallel execution' }
  }
  if (model && !model.can('parallelToolCalls') && (requested === PARALLEL_MODES.ADAPTIVE || requested === PARALLEL_MODES.AGGRESSIVE)) {
    return {
      requested,
      mode: PARALLEL_MODES.SAFE,
      substituted: true,
      reason: 'the model cannot issue parallel tool calls, so only read-side parallelism is allowed'
    }
  }
  return { requested, mode: requested, substituted: false, reason: null }
}

/**
 * A registry of providers and the profiles that select them.
 *
 * The runtime resolves "which model do I use" once per run and hands the
 * *descriptor* to whoever needs it; nothing downstream ever sees a provider object
 * or a model name it could branch on.
 */
function createModelRegistry(options = {}) {
  const providers = new Map()
  const profiles = new Map()
  let activeProfileId = options.defaultProfile || null

  /** Register a provider: an id and a factory that returns a descriptor. */
  function registerProvider(input = {}) {
    const id = String(input.id || '').trim()
    if (!id) return { ok: false, reason: 'a provider needs an id' }
    if (typeof input.describe !== 'function') return { ok: false, reason: `the provider ${id} does not implement describe()` }
    providers.set(id, { id, name: input.name || id, describe: input.describe, config: input.config || {} })
    return { ok: true, provider: providers.get(id) }
  }

  /** Register a profile. A profile is data: it names a provider and sets policy. */
  function registerProfile(input = {}) {
    const id = String(input.id || '').trim()
    if (!id) return { ok: false, reason: 'a profile needs an id' }
    const providerId = String(input.provider || '').trim()
    if (!providerId) return { ok: false, reason: `the profile ${id} names no provider` }
    profiles.set(id, {
      id,
      name: input.name || id,
      provider: providerId,
      model: input.model ? String(input.model) : null,
      reasoning: input.reasoning || null,
      parallelism: input.parallelism || null,
      context: input.context || null,
      execution: input.execution || null,
      validation: input.validation || null,
      plugins: input.plugins || null,
      description: input.description || null
    })
    if (!activeProfileId) activeProfileId = id
    return { ok: true, profile: profiles.get(id) }
  }

  function setActiveProfile(id) {
    if (!profiles.has(String(id))) return { ok: false, reason: `no profile ${id}` }
    activeProfileId = String(id)
    return { ok: true, profile: profiles.get(activeProfileId) }
  }

  /**
   * Resolve the active profile into a descriptor plus the resolved policy.
   *
   * This is the one call a run makes, and everything it needs is on the answer —
   * so a plugin asks `resolve().model.can('vision')` rather than looking anything
   * up, and a profile can be swapped without a plugin change.
   */
  function resolve(profileId = activeProfileId) {
    const profile = profiles.get(String(profileId))
    if (!profile) return { ok: false, reason: `no profile ${profileId || '(none)'}`, model: null, profile: null }
    const provider = providers.get(profile.provider)
    if (!provider) return { ok: false, reason: `the profile ${profile.id} names an unregistered provider ${profile.provider}`, model: null, profile }
    let described = null
    try {
      described = provider.describe({ model: profile.model })
    } catch (error) {
      return { ok: false, reason: `the provider ${provider.id} could not describe its model: ${error && error.message ? error.message : error}`, model: null, profile }
    }
    const model = createModelDescriptor({
      provider: provider.id,
      model: (described && described.model) || profile.model || provider.id,
      capabilities: (described && described.capabilities) || {}
    })
    const reasoning = resolveReasoning({
      model,
      requested: profile.reasoning ? profile.reasoning.default || profile.reasoning.mode : REASONING_LEVELS.NONE,
      ceiling: profile.reasoning ? profile.reasoning.ceiling : undefined
    })
    const parallelism = resolveParallelism({ model, requested: profile.parallelism ? profile.parallelism.mode : PARALLEL_MODES.SAFE })
    return {
      ok: true,
      profile: { ...profile },
      model,
      reasoning,
      parallelism,
      policy: {
        context: profile.context || {},
        execution: profile.execution || {},
        validation: profile.validation || {}
      },
      /** Anything the profile asked for that the model could not do. */
      substitutions: [reasoning, parallelism].filter((entry) => entry && entry.substituted === true)
    }
  }

  return {
    MODEL_CAPABILITIES,
    REASONING_LEVELS,
    PARALLEL_MODES,
    registerProvider,
    registerProfile,
    setActiveProfile,
    resolve,
    providers: () => [...providers.keys()],
    profiles: () => [...profiles.keys()].map((id) => ({ ...profiles.get(id) })),
    get activeProfile() {
      return activeProfileId
    },
    /** The full table, for the settings UI. */
    describe() {
      return {
        activeProfile: activeProfileId,
        providers: [...providers.values()].map((provider) => ({ id: provider.id, name: provider.name })),
        profiles: [...profiles.values()].map((profile) => ({ id: profile.id, name: profile.name, provider: profile.provider, model: profile.model, description: profile.description }))
      }
    }
  }
}

module.exports = {
  MODEL_CAPABILITIES,
  REASONING_LEVELS,
  REASONING_ORDER,
  PARALLEL_MODES,
  normalizeCapabilities,
  createModelDescriptor,
  createModelRegistry,
  resolveReasoning,
  resolveParallelism
}
