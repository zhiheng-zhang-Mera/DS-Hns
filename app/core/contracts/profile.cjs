'use strict'

/**
 * DS-Hns Core: profiles.
 *
 * A profile is the *policy* half of the mechanism/policy split: the plugins
 * implement mechanisms (a repo map, a tool batcher, a reasoning governor) and a
 * profile decides which of them are switched on for this machine, this model and
 * this kind of task. That is why swapping DeepSeek for another provider should
 * mean adding a profile rather than touching a plugin.
 *
 * Profiles ship as data (`profiles/*.json`) so the settings UI can list them and a
 * user can add one without a code change, and they are validated on load: a
 * profile naming a provider that is not installed, or a reasoning level that is not
 * a level, is refused with the reason rather than half-applied.
 *
 * The shipped set is the plan's: `flash-fast`, `flash-balanced` (the default),
 * `flash-deep`, `autonomous-24h` and `desktop-agent`.
 */

const fs = require('node:fs')
const path = require('node:path')

const { REASONING_LEVELS, PARALLEL_MODES } = require('./model.cjs')

const DEFAULT_PROFILE = 'flash-balanced'

/** What each shipped profile means, for the UI and for the validator. */
const PROFILE_INTENT = Object.freeze({
  'flash-fast': 'small tasks: low reasoning, aggressive pruning, batched tools, safe parallelism, targeted tests',
  'flash-balanced': 'the default: adaptive reasoning, dirty context, batched tools, adaptive parallelism, incremental validation',
  'flash-deep': 'large refactors and unknown bugs: larger context, medium/high reasoning, stronger validation',
  'autonomous-24h': 'long unattended work: the worker, checkpoint, watchdog, recovery, telemetry and acceptance gate',
  'desktop-agent': 'GUI-driven work: computer use, ui stability and vision fallback'
})

/**
 * Validate one profile.
 *
 * The rules are the ones that would otherwise fail much later, in the middle of a
 * task: an unknown provider, an unknown reasoning level, an unknown parallelism
 * mode.
 */
function validateProfile(profile, options = {}) {
  const errors = []
  if (!profile || typeof profile !== 'object') return { ok: false, errors: ['a profile must be an object'] }
  const id = String(profile.id || '')
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) errors.push(`id "${id}" is not a valid profile id`)
  if (!profile.provider) errors.push('a profile must name a provider')
  else if (Array.isArray(options.providers) && !options.providers.includes(String(profile.provider))) {
    errors.push(`the profile names the provider "${profile.provider}", which is not registered`)
  }
  if (profile.reasoning && profile.reasoning.default && !Object.values(REASONING_LEVELS).includes(String(profile.reasoning.default))) {
    errors.push(`reasoning.default "${profile.reasoning.default}" is not one of ${Object.values(REASONING_LEVELS).join(', ')}`)
  }
  if (profile.reasoning && profile.reasoning.ceiling && !Object.values(REASONING_LEVELS).includes(String(profile.reasoning.ceiling))) {
    errors.push(`reasoning.ceiling "${profile.reasoning.ceiling}" is not one of ${Object.values(REASONING_LEVELS).join(', ')}`)
  }
  if (profile.parallelism && profile.parallelism.mode && !Object.values(PARALLEL_MODES).includes(String(profile.parallelism.mode))) {
    errors.push(`parallelism.mode "${profile.parallelism.mode}" is not one of ${Object.values(PARALLEL_MODES).join(', ')}`)
  }
  for (const field of ['context', 'execution', 'validation', 'plugins']) {
    if (profile[field] !== undefined && (profile[field] === null || typeof profile[field] !== 'object')) {
      errors.push(`${field} must be an object when it is present`)
    }
  }
  if (errors.length) return { ok: false, errors }
  return {
    ok: true,
    errors: [],
    profile: {
      id,
      name: profile.name || id,
      description: profile.description || PROFILE_INTENT[id] || null,
      provider: String(profile.provider),
      model: profile.model ? String(profile.model) : null,
      reasoning: profile.reasoning || null,
      parallelism: profile.parallelism || null,
      context: profile.context || null,
      execution: profile.execution || null,
      validation: profile.validation || null,
      plugins: profile.plugins || null,
      source: options.source || 'built-in'
    }
  }
}

/**
 * Load every profile from a directory, plus the built-in set.
 *
 * A profile that fails validation is *reported* and skipped, so one malformed file
 * cannot stop the runtime from starting with the profiles that are fine.
 */
function loadProfiles(options = {}) {
  const dir = options.dir ? path.resolve(String(options.dir)) : null
  const builtIn = options.builtIn !== false
  const profiles = []
  const errors = []
  if (builtIn) {
    for (const [id, intent] of Object.entries(PROFILE_INTENT)) {
      const file = dir ? path.join(dir, `${id}.json`) : null
      if (file && fs.existsSync(file)) continue
      profiles.push(builtInProfile(id, intent))
    }
  }
  if (dir && fs.existsSync(dir)) {
    let entries = []
    try {
      entries = fs.readdirSync(dir)
    } catch (error) {
      errors.push({ file: dir, reason: String(error && error.message ? error.message : error) })
    }
    for (const entry of entries.filter((name) => name.endsWith('.json')).sort()) {
      const file = path.join(dir, entry)
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
        const validated = validateProfile(parsed, { providers: options.providers, source: entry })
        if (!validated.ok) {
          errors.push({ file: entry, reason: validated.errors.join('; ') })
          continue
        }
        const existing = profiles.findIndex((candidate) => candidate.id === validated.profile.id)
        if (existing >= 0) profiles[existing] = validated.profile
        else profiles.push(validated.profile)
      } catch (error) {
        errors.push({ file: entry, reason: String(error && error.message ? error.message : error) })
      }
    }
  }
  return { profiles, errors }
}

/** The built-in profile for one intent, when no file overrides it. */
function builtInProfile(id, intent) {
  const base = { id, name: id, description: intent, provider: 'deepseek', model: 'deepseek-v4.1-flash', source: 'built-in' }
  switch (id) {
    case 'flash-fast':
      return {
        ...base,
        reasoning: { mode: 'fixed', default: REASONING_LEVELS.LOW, ceiling: REASONING_LEVELS.LOW },
        parallelism: { mode: PARALLEL_MODES.SAFE },
        context: { repoMap: true, dirtyContext: true, aggressivePruning: true },
        execution: { toolBatching: true, parallelExecution: true },
        validation: { incremental: true, afterTask: 'tier2' }
      }
    case 'flash-deep':
      return {
        ...base,
        reasoning: { mode: 'adaptive', default: REASONING_LEVELS.MEDIUM, ceiling: REASONING_LEVELS.HIGH },
        parallelism: { mode: PARALLEL_MODES.ADAPTIVE },
        context: { repoMap: true, dirtyContext: true, aggressivePruning: false, largerContext: true },
        execution: { toolBatching: true, parallelExecution: true },
        validation: { incremental: false, afterTask: 'tier3' }
      }
    case 'autonomous-24h':
      return {
        ...base,
        reasoning: { mode: 'adaptive', default: REASONING_LEVELS.LOW, ceiling: REASONING_LEVELS.MEDIUM },
        parallelism: { mode: PARALLEL_MODES.ADAPTIVE },
        context: { repoMap: true, dirtyContext: true, aggressivePruning: true },
        execution: { toolBatching: true, parallelExecution: true, persistentTools: true },
        validation: { incremental: true, afterPatch: 'tier1', afterTask: 'tier2', beforeCommit: 'tier3' },
        plugins: {
          'dshns.long-term-worker': { enabled: true },
          'dshns.checkpoint': { enabled: true },
          'dshns.watchdog': { enabled: true },
          'dshns.failure-recovery': { enabled: true },
          'dshns.telemetry': { enabled: true },
          'dshns.acceptance-gate': { enabled: true }
        }
      }
    case 'desktop-agent':
      return {
        ...base,
        reasoning: { mode: 'adaptive', default: REASONING_LEVELS.LOW, ceiling: REASONING_LEVELS.MEDIUM },
        parallelism: { mode: PARALLEL_MODES.SAFE },
        context: { repoMap: false, dirtyContext: true },
        execution: { toolBatching: false, parallelExecution: false, persistentTools: true },
        validation: { incremental: true, afterTask: 'tier2' },
        plugins: {
          'dshns.computer-use': { enabled: true },
          'dshns.ui-stability': { enabled: true }
        }
      }
    case 'flash-balanced':
    default:
      return {
        ...base,
        reasoning: { mode: 'adaptive', default: REASONING_LEVELS.LOW, ceiling: REASONING_LEVELS.MEDIUM },
        parallelism: { mode: PARALLEL_MODES.ADAPTIVE },
        context: { repoMap: true, dirtyContext: true, aggressivePruning: true },
        execution: { toolBatching: true, parallelExecution: true },
        validation: { incremental: true, afterTask: 'tier2' }
      }
  }
}

/**
 * Register a loaded set into a model registry.
 *
 * @returns {{registered:string[], rejected:object[]}}
 */
function registerProfiles(registry, profiles) {
  const registered = []
  const rejected = []
  for (const profile of profiles) {
    const result = registry.registerProfile(profile)
    if (result.ok) registered.push(profile.id)
    else rejected.push({ id: profile.id, reason: result.reason })
  }
  return { registered, rejected }
}

module.exports = {
  DEFAULT_PROFILE,
  PROFILE_INTENT,
  validateProfile,
  loadProfiles,
  builtInProfile,
  registerProfiles
}
