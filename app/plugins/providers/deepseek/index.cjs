'use strict'

/**
 * DS-Hns provider: DeepSeek.
 *
 * Everything DeepSeek-specific lives here and in the profiles that select it. A
 * generic plugin never sees this file: it is handed a *descriptor* — what the model
 * can do — and asks capability questions. That is what makes "swap the provider,
 * keep the plugins" true rather than aspirational.
 *
 * The provider is data plus one `describe()`: the capability set of a DeepSeek
 * model, and the policy defaults its profiles rely on. It deliberately declares
 * only what it can honour, because a capability claimed and not delivered is worse
 * than one missing: the runtime would plan work the model cannot run.
 */

const { normalizeCapabilities } = require('../../../core/contracts/model.cjs')

/** The DeepSeek models this build knows about, and what each can do. */
const MODELS = Object.freeze({
  'deepseek-v4.1-flash': {
    toolCalling: true,
    parallelToolCalls: true,
    reasoningControl: true,
    vision: false,
    promptCaching: true,
    cacheHints: true,
    codingOptimized: true,
    contextWindow: 128_000,
    /**
     * Flash is fast and cheap, which is why it tops out at `medium`: the plan's
     * whole point is to spend short, frequent, cheap calls, and a `high` reasoning
     * request would turn it into a slow model with a fast model's context limit.
     */
    reasoningCeiling: 'medium'
  },
  'deepseek-v4.1': {
    toolCalling: true,
    parallelToolCalls: true,
    reasoningControl: true,
    vision: false,
    promptCaching: true,
    cacheHints: true,
    codingOptimized: true,
    contextWindow: 256_000,
    reasoningCeiling: 'high'
  },
  'deepseek-coder': {
    toolCalling: true,
    parallelToolCalls: false,
    reasoningControl: false,
    vision: false,
    promptCaching: true,
    cacheHints: false,
    codingOptimized: true,
    contextWindow: 128_000,
    reasoningCeiling: 'none'
  }
})

const PROVIDER_ID = 'deepseek'

/**
 * The provider itself.
 *
 * @param {object} [options]
 * @param {string} [options.model] the model id this instance describes
 * @param {object} [options.overrides] capability overrides from configuration
 */
function createDeepSeekProvider(options = {}) {
  const defaultModel = options.model || 'deepseek-v4.1-flash'
  const overrides = options.overrides && typeof options.overrides === 'object' ? options.overrides : {}

  function known(model) {
    return MODELS[model] || null
  }

  return {
    id: PROVIDER_ID,
    name: 'DeepSeek',

    /** What this provider can describe. */
    describe(input = {}) {
      const model = String(input.model || defaultModel)
      const known_ = known(model)
      if (!known_) {
        // An unknown model is described conservatively rather than refused: the
        // runtime keeps working with a text model instead of failing a run because
        // somebody added a model name the build has not seen.
        return {
          provider: PROVIDER_ID,
          model,
          capabilities: normalizeCapabilities({ toolCalling: false, contextWindow: null }),
          known: false,
          reason: `the provider does not know the model "${model}"; describing it as a text model`
        }
      }
      const { reasoningCeiling, ...capabilities } = known_
      return {
        provider: PROVIDER_ID,
        model,
        capabilities: normalizeCapabilities({ ...capabilities, ...overrides }),
        reasoningCeiling,
        known: true
      }
    },

    /** The models this build ships, for the settings UI. */
    models() {
      return Object.keys(MODELS).map((model) => ({ model, ...MODELS[model] }))
    },

    /**
     * The request shape for one call.
     *
     * This is where provider detail lives: the reasoning level the model accepts,
     * whether a cache hint is useful. A generic plugin asks the *runtime* for a
     * call, and the runtime asks the provider.
     */
    request(input = {}) {
      const described = this.describe({ model: input.model })
      const request = {
        model: described.model,
        messages: Array.isArray(input.messages) ? input.messages : [],
        tools: Array.isArray(input.tools) ? input.tools : undefined
      }
      if (input.reasoning && described.capabilities.reasoningControl && input.reasoning !== 'none') {
        request.reasoning = { effort: input.reasoning }
      }
      if (input.cacheHint && described.capabilities.cacheHints) {
        request.prompt_cache = { key: String(input.cacheHint) }
      }
      return request
    }
  }
}

module.exports = { createDeepSeekProvider, MODELS, PROVIDER_ID }
