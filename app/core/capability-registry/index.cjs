'use strict'

/**
 * DS-Hns Core: the capability registry.
 *
 * A plugin that needs validation must not name `pytest-validator`. It asks for the
 * *capability* `validation`, and any plugin that provides it will do — pytest,
 * jest, cargo, a future one nobody has written. That indirection is the whole
 * point of the registry, and it is what makes a plugin replaceable rather than
 * merely optional.
 *
 * What the registry guarantees:
 *
 *  * **Resolution is by capability, never by plugin id.** The only way to find a
 *    provider is to ask for the capability it advertises.
 *  * **A missing required capability is a load-time refusal**, reported with the
 *    capability name and the asking plugin — not a crash in the middle of a task.
 *  * **One capability may have several providers**, ordered by priority, so a
 *    project-specific validator can win over a generic one without either knowing
 *    about the other.
 *  * **Nothing is resolved silently.** Every lookup is recorded, including the
 *    misses, because "why did this plugin use the fallback?" is a question the
 *    report has to be able to answer.
 */

/** Why a capability lookup failed. */
const CAPABILITY_REASONS = Object.freeze({
  MISSING: 'capability is not provided by any enabled plugin',
  CONFLICT: 'two plugins provide the same capability at the same priority',
  REVOKED: 'the providing plugin was unloaded'
})

const DEFAULT_PRIORITY = 50

/**
 * @param {object} [options]
 * @param {object} [options.bus] the event bus, so registration is observable
 * @param {Function} [options.now]
 * @param {number} [options.maxLookups] how many lookups to remember
 */
function createCapabilityRegistry(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const bus = options.bus || null
  const maxLookups = Number.isInteger(options.maxLookups) ? options.maxLookups : 200
  /** capability -> [{ owner, implementation, priority, version, detail, at }] */
  const providers = new Map()
  const lookups = []

  function recordLookup(entry) {
    lookups.push(entry)
    if (lookups.length > maxLookups) lookups.splice(0, lookups.length - maxLookups)
    return entry
  }

  /**
   * Advertise a capability.
   *
   * @param {object} input
   * @param {string} input.capability
   * @param {string} input.owner the plugin id that provides it
   * @param {*} input.implementation whatever the capability means; opaquely stored
   * @param {number} [input.priority] higher wins; ties are reported as a conflict
   * @param {string} [input.version]
   * @param {object} [input.detail] for the health/report view
   */
  function register(input = {}) {
    const capability = String(input.capability || '').trim()
    const owner = String(input.owner || '').trim()
    if (!capability) return { ok: false, reason: 'a capability needs a name' }
    if (!owner) return { ok: false, reason: 'a capability needs an owning plugin' }
    const entry = {
      capability,
      owner,
      implementation: input.implementation === undefined ? null : input.implementation,
      priority: Number.isFinite(input.priority) ? Number(input.priority) : DEFAULT_PRIORITY,
      version: input.version || null,
      detail: input.detail && typeof input.detail === 'object' ? { ...input.detail } : null,
      at: now()
    }
    const list = providers.get(capability) || []
    // A *second* provider at the same priority is not silently accepted: which one
    // wins would then depend on registration order, which is not a decision. The
    // same owner re-registering its own capability is an update, not a clash.
    const conflict = list.find((candidate) => candidate.owner !== owner && candidate.priority === entry.priority)
    if (conflict) {
      return {
        ok: false,
        reason: `${CAPABILITY_REASONS.CONFLICT}: ${capability} is already provided by ${conflict.owner} at priority ${entry.priority}`,
        conflict: { capability, owners: [conflict.owner, owner], priority: entry.priority }
      }
    }
    const existing = list.findIndex((candidate) => candidate.owner === owner)
    if (existing >= 0) list[existing] = entry
    else list.push(entry)
    list.sort((a, b) => b.priority - a.priority || a.owner.localeCompare(b.owner))
    providers.set(capability, list)
    if (bus) bus.emit('capability.registered', { capability, owner, priority: entry.priority, version: entry.version, replaced: existing >= 0 })
    return { ok: true, entry, providers: list.length }
  }

  /** Remove every capability one plugin provided. Called on unload. */
  function revokeOwner(owner) {
    const revoked = []
    for (const [capability, list] of providers) {
      const remaining = list.filter((entry) => entry.owner !== owner)
      if (remaining.length === list.length) continue
      revoked.push(capability)
      if (remaining.length) providers.set(capability, remaining)
      else providers.delete(capability)
      if (bus) bus.emit('capability.revoked', { capability, owner, remaining: remaining.length })
    }
    return revoked
  }

  /**
   * Resolve a capability.
   *
   * @param {string} capability
   * @param {object} [options]
   * @param {boolean} [options.optional] a miss is a null, not a record of failure
   * @param {string} [options.owner] who is asking, for the record
   * @returns {*} the winning implementation, or null
   */
  function resolve(capability, options_ = {}) {
    const name = String(capability || '')
    const list = providers.get(name) || []
    if (!list.length) {
      recordLookup({ at: now(), capability: name, by: options_.owner || null, ok: false, reason: CAPABILITY_REASONS.MISSING, optional: options_.optional === true })
      if (options_.optional !== true && bus) bus.emit('capability.missing', { capability: name, by: options_.owner || null })
      return null
    }
    const winner = list[0]
    recordLookup({ at: now(), capability: name, by: options_.owner || null, ok: true, owner: winner.owner, priority: winner.priority, alternatives: list.length - 1 })
    return winner.implementation
  }

  /** The full provider entry, when the caller needs the metadata as well. */
  function describe(capability) {
    const list = providers.get(String(capability || '')) || []
    return list.map((entry) => ({ capability: entry.capability, owner: entry.owner, priority: entry.priority, version: entry.version, detail: entry.detail }))
  }

  function has(capability) {
    const list = providers.get(String(capability || ''))
    return Boolean(list && list.length)
  }

  /**
   * Are every one of these capabilities provided?
   *
   * This is what a plugin's `requires_capabilities` is checked against *before*
   * its code runs, so a missing capability is a load-time refusal.
   */
  function missingRequired(requirements = []) {
    return (Array.isArray(requirements) ? requirements : []).map(String).filter((capability) => !has(capability))
  }

  /**
   * Note a capability nobody provides.
   *
   * The manager calls this when it refuses a plugin for a missing requirement, so
   * the miss is on the record even though no lookup was made: "why did this plugin
   * not load?" and "why did this plugin use the fallback?" are the same question.
   */
  function recordMiss(capability, by = null) {
    return recordLookup({ at: now(), capability: String(capability || ''), by, ok: false, reason: CAPABILITY_REASONS.MISSING, source: 'requirement' })
  }

  return {
    CAPABILITY_REASONS,
    register,
    revokeOwner,
    resolve,
    describe,
    has,
    missingRequired,
    recordMiss,
    capabilities() {
      return [...providers.keys()].sort()
    },
    /** Every provider, for the plugin UI's "capabilities" panel. */
    snapshot() {
      const out = {}
      for (const [capability, list] of [...providers].sort(([a], [b]) => a.localeCompare(b))) {
        out[capability] = list.map((entry) => ({ owner: entry.owner, priority: entry.priority, version: entry.version, detail: entry.detail }))
      }
      return out
    },
    /** Unresolved lookups: the evidence that a fallback was used. */
    misses() {
      return lookups.filter((entry) => entry.ok === false)
    },
    lookups() {
      return lookups.slice()
    },
    get size() {
      return providers.size
    }
  }
}

module.exports = { createCapabilityRegistry, CAPABILITY_REASONS, DEFAULT_PRIORITY }
