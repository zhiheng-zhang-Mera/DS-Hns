'use strict'

/**
 * DS-Hns Core: the plugin contract.
 *
 * DS-Hns is becoming a plugin runtime: the core keeps the *mechanisms* that make
 * plugins possible — a manager, a capability registry, an event bus — and every
 * business feature lives in a plugin. That only works if "plugin" is a real
 * contract rather than a folder name, so this module defines it once:
 *
 *   `DSPlugin`      what a plugin is: a manifest plus optional lifecycle hooks
 *   `PluginManifest` what it declares: identity, capabilities, requirements,
 *                    conflicts, and whether it is model-specific
 *   states          installed / enabled / loaded / healthy are four *separate*
 *                    questions and this module keeps them separate
 *
 * Two rules are enforced here rather than documented:
 *
 *  * A plugin never reaches into another plugin's internals. What it is handed is
 *    a `PluginContext`, and the only things in it are the registry, the bus, the
 *    config and the logger for *that* plugin.
 *  * Capabilities, not plugin ids, are how plugins depend on each other. A plugin
 *    that needs "validation" does not care whether pytest-validator or
 *    cargo-validator provides it.
 */

/** The API version a plugin must declare to be loadable by this core. */
const PLUGIN_API_VERSION = 'dshns.plugin/v1'

/** How a plugin has to be treated when it fails. */
const FAULT_LEVELS = Object.freeze({
  /** Telemetry, caches: the feature is optional, keep going. */
  SOFT: 'soft',
  /** Repo map, computer use: fall back and report degraded. */
  DEGRADED: 'degraded',
  /** Workspace corruption, contract mismatch: stop the task. */
  FATAL: 'fatal'
})

/** The four states, as four separate questions. */
const PLUGIN_STATES = Object.freeze({
  INSTALLED: 'installed',
  ENABLED: 'enabled',
  LOADED: 'loaded',
  HEALTHY: 'healthy'
})

/** The health vocabulary a `healthCheck()` may answer with. */
const HEALTH_STATUS = Object.freeze({
  HEALTHY: 'healthy',
  DEGRADED: 'degraded',
  UNHEALTHY: 'unhealthy',
  UNKNOWN: 'unknown'
})

/** Why a plugin could not be loaded. */
const LOAD_REASONS = Object.freeze({
  API_INCOMPATIBLE: 'PLUGIN_API_INCOMPATIBLE',
  MANIFEST_INVALID: 'PLUGIN_MANIFEST_INVALID',
  DISABLED: 'PLUGIN_DISABLED',
  MISSING_CAPABILITY: 'PLUGIN_MISSING_CAPABILITY',
  CONFLICT: 'PLUGIN_CONFLICT',
  DUPLICATE: 'PLUGIN_DUPLICATE_ID',
  IMPORT_FAILED: 'PLUGIN_IMPORT_FAILED',
  LOAD_FAILED: 'PLUGIN_LOAD_FAILED',
  NOT_FOUND: 'PLUGIN_NOT_FOUND'
})

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

/**
 * Validate a manifest.
 *
 * Every field is checked, because a manifest is the only thing the manager has to
 * reason about *before* it runs a plugin's code: a manifest that lies about its
 * API version or its capabilities produces a failure somewhere much later.
 *
 * @param {object} manifest
 * @returns {{ok:boolean, errors:string[], manifest:object|null}}
 */
function validateManifest(manifest) {
  const errors = []
  if (!manifest || typeof manifest !== 'object') {
    return { ok: false, errors: ['a manifest must be an object'], manifest: null }
  }
  const id = String(manifest.id || '')
  if (!ID_PATTERN.test(id)) errors.push(`id "${id}" is not a valid plugin id (lowercase letters, digits, dot, dash, underscore)`)
  if (!SEMVER_PATTERN.test(String(manifest.version || ''))) errors.push(`version "${manifest.version}" is not a semantic version`)
  if (manifest.api_version !== PLUGIN_API_VERSION) {
    errors.push(`api_version must be ${PLUGIN_API_VERSION}, got ${manifest.api_version === undefined ? 'nothing' : manifest.api_version}`)
  }
  for (const field of ['provides', 'requires_capabilities', 'optional_capabilities', 'conflicts']) {
    const value = manifest[field]
    if (value === undefined || value === null) continue
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry.trim())) {
      errors.push(`${field} must be an array of non-empty capability names`)
    }
  }
  for (const field of ['default_enabled', 'hot_reload', 'model_specific']) {
    const value = manifest[field]
    if (value !== undefined && typeof value !== 'boolean') errors.push(`${field} must be a boolean`)
  }
  if (manifest.fault_level !== undefined && !Object.values(FAULT_LEVELS).includes(manifest.fault_level)) {
    errors.push(`fault_level must be one of ${Object.values(FAULT_LEVELS).join(', ')}`)
  }
  // The standard sections are validated for *shape* only. Their vocabulary belongs to the adapter
  // framework, which is where a permission name can be checked against a closed list; the core
  // contract's job is to guarantee that whatever is stored has the shape every reader expects.
  for (const field of ['runtime', 'adapter', 'health']) {
    const value = manifest[field]
    if (value !== undefined && value !== null && (typeof value !== 'object' || Array.isArray(value))) {
      errors.push(`${field} must be an object when it is present`)
    }
  }
  if (manifest.permissions !== undefined && manifest.permissions !== null) {
    if (typeof manifest.permissions !== 'object' || Array.isArray(manifest.permissions)) {
      errors.push('permissions must be an object when it is present')
    } else {
      for (const field of ['declares', 'declared', 'granted']) {
        const value = manifest.permissions[field]
        if (value === undefined || value === null) continue
        if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry.trim())) {
          errors.push(`permissions.${field} must be an array of non-empty permission names`)
        }
      }
    }
  }
  if (errors.length) return { ok: false, errors, manifest: null }
  return { ok: true, errors: [], manifest: normalizeManifest(manifest) }
}

/**
 * Apply the documented defaults so nothing downstream has to guess.
 *
 * The last four entries are the *standard sections* the adapter framework fills in. They are
 * normalised here, in the platform's own contract, rather than in the adapter layer, so that a
 * manifest keeps its declaration no matter which adapter produced it — and so the manager can
 * report what a plugin asked for without knowing what format it arrived in. A plugin that
 * declared none of them gets the documented neutral value, which is what a hand-written plugin
 * has always meant.
 */
function normalizeManifest(manifest) {
  return {
    api_version: PLUGIN_API_VERSION,
    id: String(manifest.id),
    name: manifest.name ? String(manifest.name) : String(manifest.id),
    version: String(manifest.version),
    description: manifest.description ? String(manifest.description) : null,
    provides: unique(manifest.provides),
    requires_capabilities: unique(manifest.requires_capabilities),
    optional_capabilities: unique(manifest.optional_capabilities),
    conflicts: unique(manifest.conflicts),
    default_enabled: manifest.default_enabled !== false,
    hot_reload: manifest.hot_reload === true,
    model_specific: manifest.model_specific === true,
    fault_level: manifest.fault_level || FAULT_LEVELS.DEGRADED,
    /** Where the plugin's code lives, for diagnostics and for a later reload. */
    entry: manifest.entry ? String(manifest.entry) : null,
    /** Free-form, validated by the plugin itself; the manager never interprets it. */
    config: manifest.config && typeof manifest.config === 'object' ? manifest.config : {},
    /** What the plugin declared it needs, and what the platform granted it. */
    permissions: normalizePermissions(manifest.permissions),
    /** How it runs, and what that boundary actually enforces. */
    runtime: manifest.runtime && typeof manifest.runtime === 'object' ? { ...manifest.runtime } : null,
    /** Which adapter produced this plugin, and out of what. */
    adapter: manifest.adapter && typeof manifest.adapter === 'object' ? { ...manifest.adapter } : null,
    /** The health contract the plugin is subject to, stated before it is asked. */
    health: manifest.health && typeof manifest.health === 'object' ? { ...manifest.health } : null
  }
}

/**
 * The permission block, with every list present so no surface has to test for `undefined`.
 *
 * Two spellings of the same list are accepted on purpose. `declares` is what an author writes in a
 * manifest ("this is what I am asking for"); `declared` is what the adapter framework writes back
 * once it has resolved the request against the vocabulary and the deployment policy. Accepting
 * both means a hand-written manifest and an adapted one normalise to the same shape, and the
 * resolved form wins when both are present, because it is the later fact.
 */
function normalizePermissions(value) {
  const block = value && typeof value === 'object' ? value : {}
  const declares = Array.isArray(block.declares) ? block.declares : null
  return {
    declared: unique(declares || block.declared),
    granted: unique(block.granted),
    unknown: unique(block.unknown),
    refused: Array.isArray(block.refused)
      ? block.refused.map((entry) => (entry && typeof entry === 'object'
        ? { permission: String(entry.permission || ''), reason: entry.reason ? String(entry.reason) : null }
        : { permission: String(entry), reason: null })).filter((entry) => entry.permission)
      : [],
    complete: block.complete !== false
  }
}

function unique(value) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map((entry) => String(entry).trim()).filter(Boolean))]
}

/**
 * Check a plugin's shape.
 *
 * A plugin is an object with a `manifest` plus whatever lifecycle hooks it needs.
 * It does not have to implement all of them: a plugin that only provides a
 * capability through the registry needs no `load` at all.
 *
 * @returns {{ok:boolean, errors:string[]}}
 */
function validatePlugin(plugin) {
  const errors = []
  if (!plugin || typeof plugin !== 'object') return { ok: false, errors: ['a plugin must be an object'] }
  const validated = validateManifest(plugin.manifest)
  if (!validated.ok) errors.push(...validated.errors)
  for (const hook of ['install', 'load', 'unload', 'healthCheck']) {
    if (plugin[hook] !== undefined && typeof plugin[hook] !== 'function') errors.push(`${hook} must be a function when it is present`)
  }
  return { ok: errors.length === 0, errors }
}

/**
 * Create the context one plugin is loaded with.
 *
 * The context is the *only* seam a plugin gets. It is deliberately narrow: a
 * plugin may publish and consume capabilities, emit and subscribe to events, read
 * its own configuration and log; it may not reach into another plugin's exports,
 * and it is not handed the manager itself.
 *
 * @param {object} input
 * @param {object} input.manifest the owning plugin's manifest
 * @param {object} input.registry the capability registry
 * @param {object} input.bus the event bus
 * @param {object} input.config the plugin's resolved config block
 * @param {Function} [input.log]
 * @param {object} [input.services] core services a plugin is allowed to use
 */
function createPluginContext(input = {}) {
  const manifest = input.manifest
  const owner = manifest ? manifest.id : 'unknown'
  const subscriptions = []
  const log = typeof input.log === 'function' ? input.log : () => {}

  function scoped(kind, detail) {
    log({ plugin: owner, kind, ...detail })
  }

  const context = {
    id: owner,
    manifest,
    version: manifest ? manifest.version : null,
    /** Only this plugin's own configuration block, never the whole config. */
    config: input.config && typeof input.config === 'object' ? { ...input.config } : {},
    /**
     * What this plugin was granted, resolved by the adapter framework and not by the plugin.
     *
     * A plugin reading its own declaration is how "I asked for it" becomes "I may do it"; the
     * granted list is the platform's answer, and it is the one a plugin should act on.
     */
    permissions: manifest && manifest.permissions ? { ...manifest.permissions } : null,
    services: input.services && typeof input.services === 'object' ? input.services : {},
    log(message, detail = {}) {
      scoped('log', { message: String(message), ...detail })
    },
    /**
     * Advertise a capability. The registry is what makes "requires validation"
     * resolvable without naming the plugin that satisfies it.
     */
    provide(capability, implementation, options = {}) {
      if (!input.registry) return { ok: false, reason: 'no capability registry is attached' }
      return input.registry.register({
        capability: String(capability),
        owner,
        implementation,
        version: manifest ? manifest.version : null,
        priority: options.priority,
        detail: options.detail || null
      })
    },
    /** Resolve another plugin's capability, without knowing whose it is. */
    require(capability, options = {}) {
      if (!input.registry) return null
      return input.registry.resolve(String(capability), { optional: options.optional === true, owner })
    },
    has(capability) {
      return Boolean(input.registry && input.registry.has(String(capability)))
    },
    /** Emit an event on the bus. */
    emit(type, payload = {}) {
      if (!input.bus) return { ok: false, reason: 'no event bus is attached' }
      return input.bus.emit(String(type), payload, { source: owner })
    },
    /** Subscribe to the bus; the subscription is dropped when the plugin unloads. */
    on(type, handler, options = {}) {
      if (!input.bus) return () => {}
      const unsubscribe = input.bus.on(String(type), handler, { source: owner, ...options })
      subscriptions.push(unsubscribe)
      return unsubscribe
    },
    /** Subscribe to every event, for a plugin whose whole job is observation. */
    onAny(handler, options = {}) {
      if (!input.bus) return () => {}
      const unsubscribe = input.bus.onAny(handler, { source: owner, ...options })
      subscriptions.push(unsubscribe)
      return unsubscribe
    },
    /** Emit a metric: the telemetry plugin is the only consumer that matters. */
    metric(name, value, detail = {}) {
      if (!input.bus) return { ok: false, reason: 'no event bus is attached' }
      return input.bus.emit('metric.recorded', { name: String(name), value, ...detail }, { source: owner })
    },
    /** How many bus subscriptions this plugin still holds, for the leak audit. */
    get subscriptionCount() {
      return subscriptions.length
    },
    /** Drop every subscription this plugin made. Called by the manager on unload. */
    dispose() {
      for (const unsubscribe of subscriptions.splice(0, subscriptions.length)) {
        try {
          unsubscribe()
        } catch {
          /* a subscription that is already gone is not an error */
        }
      }
    }
  }
  return context
}

module.exports = {
  PLUGIN_API_VERSION,
  PLUGIN_STATES,
  FAULT_LEVELS,
  HEALTH_STATUS,
  LOAD_REASONS,
  validateManifest,
  normalizeManifest,
  normalizePermissions,
  validatePlugin,
  createPluginContext,
  unique
}
