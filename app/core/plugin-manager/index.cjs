'use strict'

/**
 * DS-Hns Core: the plugin manager.
 *
 * This is the mechanism every feature is mounted through, and it is deliberately
 * the only place that knows a plugin's lifecycle. Four things it must get right:
 *
 *  1. **Four states, never conflated.** A plugin can be installed and disabled; it
 *     can be enabled and fail to load; it can be loaded and unhealthy. Collapsing
 *     those into one "on/off" flag is how a broken plugin looks fine.
 *  2. **A failure stays inside the plugin.** A plugin that throws while loading is
 *     recorded with its fault level and the rest of the runtime keeps working; only
 *     a FATAL fault (a corrupt workspace, an incompatible contract) stops a task.
 *  3. **Requirements are capabilities.** Load order is computed from
 *     `requires_capabilities`, so a plugin that needs `validation` loads after
 *     whatever provides it — and if nothing does, it is refused at load time with
 *     the capability named, not crashed later.
 *  4. **Unloading actually releases.** `unload()` is called, the plugin's
 *     capabilities are revoked and its bus subscriptions are dropped, so a
 *     plugin's footprint is measurable after it is gone.
 */

const { PLUGIN_API_VERSION, PLUGIN_STATES, FAULT_LEVELS, HEALTH_STATUS, LOAD_REASONS, validatePlugin, normalizeManifest, createPluginContext } = require('../contracts/plugin.cjs')
const { createEventBus } = require('../event-bus/index.cjs')
const { createCapabilityRegistry } = require('../capability-registry/index.cjs')

/**
 * Order plugins so a provider loads before its consumers.
 *
 * A cycle in the requirement graph is reported rather than resolved by guessing:
 * two plugins that need each other cannot be loaded in any order that satisfies
 * both, which is a plugin-design error the manager must surface.
 */
function orderPlugins(entries) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const providerOf = new Map()
  for (const entry of entries) {
    for (const capability of entry.capabilities) {
      if (!providerOf.has(capability)) providerOf.set(capability, entry.id)
    }
  }
  const ordered = []
  const visiting = new Set()
  const visited = new Set()
  const cycles = []

  function visit(id, trail) {
    if (visited.has(id)) return true
    if (visiting.has(id)) {
      cycles.push([...trail, id].join(' -> '))
      return false
    }
    visiting.add(id)
    const entry = byId.get(id)
    if (entry) {
      for (const capability of entry.requires) {
        const provider = providerOf.get(capability)
        if (provider && provider !== id) visit(provider, [...trail, id])
      }
    }
    visiting.delete(id)
    visited.add(id)
    if (entry) ordered.push(entry)
    return true
  }

  for (const entry of entries) visit(entry.id, [])
  return { ordered, cycles }
}

/**
 * Resolve a promise, or fail with a marked error after `timeoutMs`.
 *
 * The timer is cleared on the fast path so a healthy plugin does not leave a ten-second timer behind on
 * every health pass. The rejected error carries `timedOut: true`, which is what lets the caller report
 * "it did not answer" instead of pretending the plugin is broken.
 */
function withTimeout(promise, timeoutMs, message) {
  let timer = null
  const bound = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(message)
      error.timedOut = true
      reject(error)
    }, timeoutMs)
    /**
     * Deliberately **not** unref'd.
     *
     * An unref'd timer does not keep the event loop alive, so a health check that never settles and has no
     * other handle would let the process exit instead of timing out — the timeout would work in a busy
     * process and silently do nothing in a quiet one. The timer is cleared the moment the hook answers.
     */
  })
  return Promise.race([
    Promise.resolve(promise).finally(() => { if (timer) clearTimeout(timer) }),
    bound
  ])
}

/**
 * @param {object} [options]
 * @param {object} [options.bus] a bus to reuse (the runtime owns one)
 * @param {object} [options.registry] a registry to reuse
 * @param {object} [options.config] `{ plugins: { <id>: {...} }, enabled: {...} }`
 * @param {Function} [options.now]
 * @param {Function} [options.log]
 * @param {number}   [options.healthTimeoutMs] how long a plugin's healthCheck may take (default 10s)
 * @param {object} [options.services] core services handed to every plugin context
 */
function createPluginManager(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const log = typeof options.log === 'function' ? options.log : () => {}
  const bus = options.bus || createEventBus({ now })
  const registry = options.registry || createCapabilityRegistry({ now, bus })
  const config = options.config && typeof options.config === 'object' ? options.config : {}
  /**
   * How long a plugin's `healthCheck` may take before it is reported as not answering.
   *
   * A hook that never settles is plugin code, and the health pass is sequential — so without a bound one
   * hung plugin would hold the whole runtime's health for ever (and the host's world build with it). Ten
   * seconds is long enough for a probe that talks to a child process and short enough that a person
   * watching the panel sees an answer.
   */
  const healthTimeoutMs = Number.isFinite(Number(options.healthTimeoutMs)) ? Math.max(1, Number(options.healthTimeoutMs)) : 10_000
  const services = options.services && typeof options.services === 'object' ? options.services : {}
  /** id -> the record the manager reports on */
  const records = new Map()
  /** id -> the live context, for unload */
  const contexts = new Map()

  function effectiveEnabled(manifest) {
    const override = config.plugins && Object.prototype.hasOwnProperty.call(config.plugins, manifest.id)
      ? config.plugins[manifest.id]
      : null
    if (override && typeof override.enabled === 'boolean') return override.enabled
    return manifest.default_enabled
  }

  function pluginConfig(manifest) {
    const override = config.plugins && config.plugins[manifest.id] ? config.plugins[manifest.id].config : null
    return { ...(manifest.config || {}), ...(override && typeof override === 'object' ? override : {}) }
  }

  /**
   * Register a plugin without loading it.
   *
   * Installation is where the *contract* is checked: an incompatible API version
   * or an invalid manifest is refused here, before anything runs.
   */
  function install(candidate, installOptions = {}) {
    const validated = validatePlugin(candidate)
    if (!validated.ok) {
      const reason = validated.errors.join('; ')
      const code = /api_version/.test(reason) ? LOAD_REASONS.API_INCOMPATIBLE : LOAD_REASONS.MANIFEST_INVALID
      bus.emit('plugin.fault', { plugin: candidate && candidate.manifest ? candidate.manifest.id : null, code, reason, level: FAULT_LEVELS.SOFT, phase: 'install' })
      return { ok: false, code, reason }
    }
    // The manifest is normalized before it is stored, so nothing downstream has to
    // guess a default for `optional_capabilities`, `default_enabled` or anything
    // else: a plugin's declaration is complete or it was refused.
    const manifest = normalizeManifest(candidate.manifest)
    const plugin = { ...candidate, manifest }
    if (records.has(manifest.id) && installOptions.replace !== true) {
      return { ok: false, code: LOAD_REASONS.DUPLICATE, reason: `${manifest.id} is already installed` }
    }
    const record = {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      api_version: manifest.api_version,
      installed: true,
      // Installation applies the plugin's own default, which the config may have
      // overridden: "installed" and "enabled" are separate facts, and a plugin that
      // ships disabled is installed without being enabled.
      enabled: effectiveEnabled(manifest),
      loaded: false,
      healthy: null,
      health: null,
      fault: null,
      faults: [],
      capabilities: manifest.provides.slice(),
      requires: manifest.requires_capabilities.slice(),
      optional: manifest.optional_capabilities.slice(),
      model_specific: manifest.model_specific,
      fault_level: manifest.fault_level,
      // The standard sections an adapter filled in. The manager reports them and never
      // interprets them: which adapter produced a plugin, what it asked for and what it
      // was granted are facts about the plugin, and the manager is the surface that
      // publishes facts about plugins.
      permissions: manifest.permissions,
      runtime: manifest.runtime,
      adapter: manifest.adapter,
      health_contract: manifest.health,
      plugin,
      installedAt: now(),
      loadedAt: null,
      healthAt: null
    }
    records.set(manifest.id, record)
    bus.emit('plugin.installed', { plugin: manifest.id, version: manifest.version, provides: record.capabilities })
    log({ kind: 'plugin-installed', plugin: manifest.id, version: manifest.version })
    return { ok: true, record }
  }

  function entry(id) {
    return records.get(String(id)) || null
  }

  function setEnabled(id, enabled) {
    const record = entry(id)
    if (!record) return { ok: false, code: LOAD_REASONS.NOT_FOUND, reason: `no plugin ${id}` }
    record.enabled = Boolean(enabled)
    if (record.enabled) bus.emit('plugin.enabled', { plugin: record.id })
    else bus.emit('plugin.disabled', { plugin: record.id })
    return { ok: true, record }
  }

  /**
   * Load one installed plugin.
   *
   * Everything that can be checked before the plugin's code runs is checked
   * first: enabled, requirements present, no conflicts, no cycle. A plugin whose
   * requirements are missing is refused with the capability named rather than
   * failing later inside a task.
   */
  async function loadOne(id, loadOptions = {}) {
    const record = entry(id)
    if (!record) return { ok: false, code: LOAD_REASONS.NOT_FOUND, reason: `no plugin ${id}` }
    if (record.loaded) return { ok: true, record, already: true }
    if (!record.enabled && loadOptions.force !== true) {
      return { ok: false, code: LOAD_REASONS.DISABLED, reason: `${record.id} is disabled` }
    }
    // Conflicts are declared in both directions or not at all: either side saying
    // so is enough to refuse the pair.
    for (const other of records.values()) {
      if (other.id === record.id || !other.loaded) continue
      if (record.plugin.manifest.conflicts.includes(other.id) || other.plugin.manifest.conflicts.includes(record.id)) {
        const reason = `${record.id} conflicts with the loaded plugin ${other.id}`
        record.fault = { code: LOAD_REASONS.CONFLICT, reason, level: FAULT_LEVELS.DEGRADED, at: now(), phase: 'load' }
        record.faults.push(record.fault)
        bus.emit('plugin.fault', { plugin: record.id, code: LOAD_REASONS.CONFLICT, reason, level: FAULT_LEVELS.DEGRADED })
        return { ok: false, code: LOAD_REASONS.CONFLICT, reason }
      }
    }
    const missing = registry.missingRequired(record.requires)
    if (missing.length) {
      for (const capability of missing) registry.recordMiss(capability, record.id)
      const reason = `${record.id} needs capabilities nothing provides: ${missing.join(', ')}`
      record.fault = { code: LOAD_REASONS.MISSING_CAPABILITY, reason, level: FAULT_LEVELS.DEGRADED, at: now(), phase: 'load', missing }
      record.faults.push(record.fault)
      bus.emit('plugin.fault', { plugin: record.id, code: LOAD_REASONS.MISSING_CAPABILITY, reason, level: FAULT_LEVELS.DEGRADED, missing })
      log({ kind: 'plugin-load-refused', plugin: record.id, reason })
      return { ok: false, code: LOAD_REASONS.MISSING_CAPABILITY, reason, missing }
    }

    const context = createPluginContext({
      manifest: record.plugin.manifest,
      registry,
      bus,
      config: pluginConfig(record.plugin.manifest),
      services,
      log: (event) => log({ plugin: record.id, ...event })
    })
    try {
      if (typeof record.plugin.install === 'function') await record.plugin.install(context)
      if (typeof record.plugin.load === 'function') await record.plugin.load(context)
    } catch (error) {
      const reason = String(error && error.message ? error.message : error)
      context.dispose()
      registry.revokeOwner(record.id)
      record.fault = { code: LOAD_REASONS.LOAD_FAILED, reason, level: record.fault_level, at: now(), phase: 'load' }
      record.faults.push(record.fault)
      record.loaded = false
      bus.emit('plugin.fault', { plugin: record.id, code: LOAD_REASONS.LOAD_FAILED, reason, level: record.fault_level })
      log({ kind: 'plugin-load-failed', plugin: record.id, reason })
      return { ok: false, code: LOAD_REASONS.LOAD_FAILED, reason, level: record.fault_level }
    }
    contexts.set(record.id, context)
    record.loaded = true
    record.loadedAt = now()
    record.fault = null
    bus.emit('plugin.loaded', { plugin: record.id, version: record.version, provides: record.capabilities })
    log({ kind: 'plugin-loaded', plugin: record.id })
    return { ok: true, record }
  }

  /** Unload one plugin: its hooks, its capabilities and its subscriptions all go. */
  async function unloadOne(id) {
    const record = entry(id)
    if (!record) return { ok: false, code: LOAD_REASONS.NOT_FOUND, reason: `no plugin ${id}` }
    if (!record.loaded) return { ok: true, record, already: true }
    const context = contexts.get(record.id)
    try {
      if (typeof record.plugin.unload === 'function') await record.plugin.unload(context)
    } catch (error) {
      // An unload that throws is recorded but does not prevent the release below:
      // leaving the capabilities and subscriptions behind would be worse.
      record.faults.push({ code: LOAD_REASONS.LOAD_FAILED, reason: String(error && error.message ? error.message : error), level: record.fault_level, at: now(), phase: 'unload' })
      log({ kind: 'plugin-unload-failed', plugin: record.id, reason: String(error && error.message ? error.message : error) })
    }
    if (context) context.dispose()
    contexts.delete(record.id)
    const revoked = registry.revokeOwner(record.id)
    record.loaded = false
    record.loadedAt = null
    record.healthy = null
    record.health = null
    bus.emit('plugin.unloaded', { plugin: record.id, revoked })
    log({ kind: 'plugin-unloaded', plugin: record.id, revoked })
    return { ok: true, record, revoked }
  }

  /**
   * Load every enabled plugin, in requirement order.
   *
   * A refusal is a *reported* outcome for that plugin: the others still load,
   * because one broken plugin must not stop the runtimes that work.
   */
  async function loadAll(loadOptions = {}) {
    const enabled = [...records.values()].filter((record) => record.enabled)
    const { ordered, cycles } = orderPlugins(enabled)
    const results = []
    for (const cycle of cycles) {
      bus.emit('plugin.fault', { plugin: null, code: LOAD_REASONS.MANIFEST_INVALID, reason: `requirement cycle: ${cycle}`, level: FAULT_LEVELS.DEGRADED })
      log({ kind: 'plugin-cycle', cycle })
    }
    for (const record of ordered) {
      const result = await loadOne(record.id, loadOptions)
      results.push({ plugin: record.id, ...result, record: undefined })
    }
    return { results, cycles, loaded: [...records.values()].filter((entry_) => entry_.loaded).map((entry_) => entry_.id) }
  }

  /** Unload everything, newest first. Used by the shell's teardown. */
  async function unloadAll() {
    const loaded = [...records.values()].filter((record) => record.loaded).reverse()
    const results = []
    for (const record of loaded) results.push({ plugin: record.id, ...(await unloadOne(record.id)) })
    return results
  }

  /**
   * Ask one plugin how it is.
   *
   * `healthCheck` is optional: a plugin that does not implement it is `unknown`
   * rather than assumed healthy. A `healthCheck` that throws is `unhealthy` with
   * the reason, and never propagates.
   *
   * **A `healthCheck` that never answers is bounded.** It is plugin code, and a plugin whose promise never
   * settles would otherwise hang `checkAllHealth` — and with it the host's world build, since the pass is
   * sequential — for ever. The bound turns that into `unknown` with the reason "it did not answer", which is
   * the honest answer and keeps the rest of the runtime serving. The pending promise is left alone: it is
   * the plugin's, and this manager has no way to cancel it.
   */
  async function checkHealth(id) {
    const record = entry(id)
    if (!record) return { ok: false, code: LOAD_REASONS.NOT_FOUND, reason: `no plugin ${id}` }
    if (!record.loaded) return { status: HEALTH_STATUS.UNKNOWN, reason: `${record.id} is not loaded` }
    if (typeof record.plugin.healthCheck !== 'function') {
      record.health = { status: HEALTH_STATUS.UNKNOWN, reason: 'the plugin implements no healthCheck', at: now() }
      record.healthy = null
      return record.health
    }
    try {
      const result = await withTimeout(record.plugin.healthCheck(), healthTimeoutMs, `${record.id} did not answer its health check within ${healthTimeoutMs}ms`)
      const status = result && Object.values(HEALTH_STATUS).includes(result.status) ? result.status : HEALTH_STATUS.UNKNOWN
      record.health = {
        status,
        reason: result && result.reason ? String(result.reason) : null,
        latency_ms: Number.isFinite(result && result.latency_ms) ? Number(result.latency_ms) : null,
        detail: result && result.detail ? result.detail : null,
        at: now()
      }
      record.healthy = status === HEALTH_STATUS.HEALTHY
      record.healthAt = now()
      bus.emit('plugin.health', { plugin: record.id, status, reason: record.health.reason })
      return record.health
    } catch (error) {
      const timedOut = Boolean(error && error.timedOut)
      record.health = {
        status: timedOut ? HEALTH_STATUS.UNKNOWN : HEALTH_STATUS.UNHEALTHY,
        reason: String(error && error.message ? error.message : error),
        latency_ms: null,
        timedOut,
        at: now()
      }
      record.healthy = timedOut ? null : false
      record.healthAt = now()
      bus.emit('plugin.fault', { plugin: record.id, code: timedOut ? 'PLUGIN_HEALTH_TIMEOUT' : LOAD_REASONS.LOAD_FAILED, reason: record.health.reason, level: record.fault_level, phase: 'health' })
      return record.health
    }
  }

  async function checkAllHealth() {
    const out = {}
    for (const record of records.values()) out[record.id] = await checkHealth(record.id)
    return out
  }

  /** The report the plugin UI and `plugin list` read. */
  function list() {
    return [...records.values()]
      .map((record) => ({
        id: record.id,
        name: record.name,
        version: record.version,
        apiVersion: record.api_version,
        installed: record.installed,
        enabled: record.enabled,
        loaded: record.loaded,
        healthy: record.healthy,
        health: record.health,
        fault: record.fault,
        faultLevel: record.fault_level,
        provides: record.capabilities,
        requires: record.requires,
        modelSpecific: record.model_specific,
        // The standard sections. One line each, and the same on every plugin whatever format
        // it arrived in — that uniformity is what the adapter framework exists to produce.
        permissions: record.permissions,
        runtime: record.runtime,
        adapter: record.adapter,
        adaptation: record.plugin.adaptation || null,
        lifecycle: typeof record.plugin.lifecycleState === 'function' ? record.plugin.lifecycleState() : null,
        errorCount: record.plugin.errorReport ? record.plugin.errorReport().total : 0
      }))
      .sort((a, b) => a.id.localeCompare(b.id))
  }

  /** Why a plugin is not working, in one line, for the UI. */
  function status(id) {
    const record = entry(id)
    if (!record) return { ok: false, code: LOAD_REASONS.NOT_FOUND, reason: `no plugin ${id}` }
    const state = !record.installed ? 'not-installed'
      : !record.enabled ? 'disabled'
        : !record.loaded ? 'enabled'
          : record.healthy === false ? 'unhealthy'
            : record.healthy === true ? 'healthy'
              : 'loaded'
    return {
      ok: true,
      plugin: record.id,
      state,
      installed: record.installed,
      enabled: record.enabled,
      loaded: record.loaded,
      healthy: record.healthy,
      health: record.health,
      fault: record.fault,
      faultLevel: record.fault_level,
      dependencies: {
        requires: record.requires,
        optional: record.optional,
        missing: registry.missingRequired(record.requires),
        providers: Object.fromEntries(record.requires.map((capability) => [capability, registry.describe(capability)]))
      },
      config: pluginConfig(record.plugin.manifest),
      capabilities: record.capabilities.map((capability) => ({ capability, providers: registry.describe(capability) })),
      subscriptions: bus.subscriptionCount(record.id),
      loadedAt: record.loadedAt,
      faults: record.faults.slice(-10),
      // The diagnostic half of the standard sections: where it runs, what boundary that gives,
      // what it asked for, and what has gone wrong. All of it comes from the adapter framework's
      // unified interfaces, so a plugin adopted from a foreign format answers exactly like one
      // that declared the contract by hand.
      permissions: record.permissions,
      runtime: record.runtime,
      adapter: record.adapter,
      healthContract: record.health_contract,
      adaptation: record.plugin.adaptation || null,
      lifecycle: typeof record.plugin.lifecycleState === 'function' ? record.plugin.lifecycleState() : null,
      runtimeInfo: typeof record.plugin.runtimeInfo === 'function' ? record.plugin.runtimeInfo() : null,
      errorReport: typeof record.plugin.errorReport === 'function' ? record.plugin.errorReport() : null
    }
  }

  /**
   * Uninstall one plugin: unload it, then forget it.
   *
   * Unloading and uninstalling are different requests, and the platform only had the first. A
   * plugin that is unloaded is still installed — it is listed, it is disabled, and enabling it
   * again brings it back. A plugin that is removed is gone: it leaves the list, its record is
   * dropped, and a later `install` of the same id is a fresh install rather than a duplicate.
   *
   * The unload is awaited first, because removing a record while its capabilities are still
   * registered would leave the registry holding an owner nothing can name again.
   */
  async function removeOne(id) {
    const record = entry(id)
    if (!record) return { ok: false, code: LOAD_REASONS.NOT_FOUND, reason: `no plugin ${id}` }
    await unloadOne(record.id)
    records.delete(record.id)
    contexts.delete(record.id)
    bus.emit('plugin.removed', { plugin: record.id, version: record.version })
    log({ kind: 'plugin-removed', plugin: record.id })
    return { ok: true, plugin: record.id, removed: true }
  }

  return {
    PLUGIN_STATES,
    FAULT_LEVELS,
    HEALTH_STATUS,
    LOAD_REASONS,
    bus,
    registry,
    install,
    load: loadOne,
    unload: unloadOne,
    remove: removeOne,
    loadAll,
    unloadAll,
    enable: (id) => setEnabled(id, true),
    disable: async (id) => {
      const result = setEnabled(id, false)
      if (result.ok && result.record.loaded) await unloadOne(id)
      return result
    },
    reload: async (id) => {
      await unloadOne(id)
      return loadOne(id)
    },
    checkHealth,
    checkAllHealth,
    list,
    status,
    has: (id) => records.has(String(id)),
    entry,
    /** The bus and registry are the runtime's; a plugin only ever sees them
     *  through its own context. */
    report() {
      const all = list()
      return {
        at: now(),
        total: all.length,
        installed: all.length,
        enabled: all.filter((entry_) => entry_.enabled).length,
        loaded: all.filter((entry_) => entry_.loaded).length,
        healthy: all.filter((entry_) => entry_.healthy === true).length,
        unhealthy: all.filter((entry_) => entry_.healthy === false).length,
        faults: all.filter((entry_) => entry_.fault).length,
        capabilities: registry.capabilities(),
        plugins: all,
        bus: bus.stats()
      }
    }
  }
}

module.exports = { createPluginManager, orderPlugins, PLUGIN_API_VERSION }
