'use strict'

/**
 * DS-Hns Core: the adapter registry.
 *
 * Registration and *selection* are the two halves of "the manager no longer knows about any one
 * external format". The manager asks this registry for the plugin model; the registry asks its
 * adapters which of them takes this artifact. Nothing above this module names a format.
 *
 * Selection is intentionally conservative, in a way that has already paid for itself in this
 * codebase: when two adapters both accept an artifact at the same priority, the registry **picks
 * deterministically and says that it was ambiguous**. It does not refuse — a plugin that could be
 * read two ways should still be readable — and it does not hide the tie, because "which adapter
 * ran" is the first question anybody asks when an adapted plugin misbehaves.
 *
 * Ordering is therefore total and reproducible:
 *
 *   1. higher `priority` wins;
 *   2. then lower adapter id, lexicographically.
 *
 * That second rule is what makes selection stable across restarts and across machines, which
 * matters because the adapter that ran is recorded in the plugin's manifest.
 */

const { ADAPTER_FAULT_CODES, adapterFault, validateAdapter, normalizeAdapter } = require('./contract.cjs')

/** The wildcard an adapter may declare to be considered for every type. */
const ANY_TYPE = '*'

/**
 * @param {object} [options]
 * @param {Function} [options.log]
 */
function createAdapterRegistry(options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {}
  /** id -> normalized adapter */
  const adapters = new Map()

  /**
   * Register one adapter.
   *
   * Validation happens once, here. An adapter that is malformed is refused at the point somebody
   * wrote it, with every problem listed, rather than throwing on the first artifact that happens
   * to select it.
   *
   * @param {object} adapter
   * @param {object} [registerOptions]
   * @param {boolean} [registerOptions.replace] allow replacing an adapter with the same id
   */
  function register(adapter, registerOptions = {}) {
    const validated = validateAdapter(adapter)
    if (!validated.ok) {
      return adapterFault(ADAPTER_FAULT_CODES.BAD_ADAPTER, `the adapter was refused: ${validated.errors.join('; ')}`, {
        errors: validated.errors
      })
    }
    const normalized = normalizeAdapter(adapter)
    if (adapters.has(normalized.id) && registerOptions.replace !== true) {
      return adapterFault(ADAPTER_FAULT_CODES.BAD_ADAPTER, `adapter ${normalized.id} is already registered`)
    }
    adapters.set(normalized.id, normalized)
    log({ kind: 'adapter-registered', adapter: normalized.id, version: normalized.version, supports: normalized.supports })
    return { ok: true, adapter: normalized }
  }

  /** Remove one adapter. Removing one that is not there is reported, never thrown. */
  function unregister(id) {
    const key = String(id)
    if (!adapters.has(key)) return adapterFault(ADAPTER_FAULT_CODES.BAD_ADAPTER, `no adapter ${key}`)
    adapters.delete(key)
    log({ kind: 'adapter-unregistered', adapter: key })
    return { ok: true, id: key }
  }

  function get(id) {
    return adapters.get(String(id)) || null
  }

  /** Every registered adapter, in selection order. */
  function list() {
    return [...adapters.values()].sort(compareAdapters)
  }

  /**
   * The adapters that could take a detection, whether or not they will.
   *
   * Kept separate from `select` because the diagnostic surface needs to show *why* an adapter was
   * passed over, and computing it twice in two places is how the panel and the runtime start
   * disagreeing.
   */
  function candidatesFor(type) {
    const wanted = String(type)
    return list().filter((adapter) => adapter.supports.includes(wanted) || adapter.supports.includes(ANY_TYPE))
  }

  /**
   * Ask every candidate whether it will take this artifact, in selection order.
   *
   * This is the one place `accepts` is called, so `select` (which answers "who would run") and the
   * framework's adaptation loop (which answers "who did run, and what happened when they tried")
   * cannot disagree about what an adapter said.
   *
   * @returns {{ok:boolean, plan?:Array, code?:string, reason?:string}}
   */
  function plan(detection, artifact = null) {
    const type = detection && detection.type ? String(detection.type) : null
    if (!type) return adapterFault(ADAPTER_FAULT_CODES.UNDETECTED, 'selection needs a detected type')

    const candidates = candidatesFor(type)
    if (!candidates.length) {
      return adapterFault(ADAPTER_FAULT_CODES.NO_ADAPTER, `no registered adapter accepts the plugin type ${type}`, { type })
    }

    const entries = []
    for (const adapter of candidates) {
      const entry = { adapter, priority: adapter.priority, runtime_kind: adapter.runtime_kind, accepted: false, refusal: null }
      if (!adapter.accepts) {
        // No predicate means "I take every artifact of a type I declared", which is the common
        // case and the one that keeps a simple adapter simple.
        entry.accepted = true
        entries.push(entry)
        continue
      }
      let accepted = null
      try {
        accepted = adapter.accepts(artifact, detection)
      } catch (error) {
        // An `accepts` that throws is a refusal by that adapter, not a failure of selection: the
        // next adapter is still asked, because this is exactly the "one bad adapter" case.
        entry.refusal = { code: ADAPTER_FAULT_CODES.THREW, reason: String(error && error.message ? error.message : error) }
        log({ kind: 'adapter-accepts-threw', adapter: adapter.id, reason: entry.refusal.reason })
        entries.push(entry)
        continue
      }
      if (accepted === true) {
        entry.accepted = true
      } else if (accepted && typeof accepted === 'object' && accepted.ok === false) {
        entry.refusal = {
          code: accepted.code || ADAPTER_FAULT_CODES.REFUSED,
          reason: String(accepted.reason || 'the adapter declined this artifact'),
          detail: accepted.detail || null
        }
      } else {
        entry.refusal = { code: ADAPTER_FAULT_CODES.REFUSED, reason: 'the adapter does not accept this artifact' }
      }
      entries.push(entry)
    }
    return { ok: true, type, plan: entries, willing: entries.filter((entry) => entry.accepted).map((entry) => entry.adapter) }
  }

  /**
   * Choose the adapter for one detection.
   *
   * @param {object} detection a `detect()` result (or anything with a `type`)
   * @param {object} [artifact] the artifact, handed to each candidate's `accepts`
   * @returns {{ok:boolean, adapter?:object, considered?:Array, refusals?:Array, ambiguous?:boolean, code?:string, reason?:string}}
   */
  function select(detection, artifact = null) {
    const planned = plan(detection, artifact)
    if (planned.ok !== true) return planned

    const considered = planned.plan.map((entry) => ({ adapter: entry.adapter.id, priority: entry.priority, runtime_kind: entry.runtime_kind }))
    const refusals = planned.plan
      .filter((entry) => !entry.accepted)
      .map((entry) => ({ adapter: entry.adapter.id, ...entry.refusal }))

    const chosen = planned.willing[0]
    if (!chosen) {
      return adapterFault(ADAPTER_FAULT_CODES.REFUSED, `every adapter that accepts ${planned.type} declined this artifact`, {
        type: planned.type,
        considered,
        refusals
      })
    }

    // Two adapters at the top priority both willing to run is not an error, but it is a fact the
    // caller is entitled to: the winner is deterministic, and the tie is reported.
    const tied = considered.filter((entry) => entry.priority === chosen.priority && entry.adapter !== chosen.id)
    return {
      ok: true,
      adapter: chosen,
      considered,
      refusals,
      ambiguous: tied.length > 0,
      alternatives: tied.map((entry) => entry.adapter)
    }
  }

  /**
   * Select and adapt in one step, for a caller that wants a single answer rather than a plan.
   *
   * The framework's own `adapt` does not use this: it needs to try the *next* adapter when one
   * refuses, which is a property of the plan rather than of a single choice. This is kept for
   * callers (and tests) whose question really is "pick one and run it".
   */
  async function adaptWith(type, detection, artifact, adaptOptions = {}) {
    const selection = select({ type }, artifact)
    if (!selection.ok) return selection
    try {
      const output = await selection.adapter.adapt(artifact, detection, adaptOptions)
      if (output && output.ok === false) return { ...output, adapter: selection.adapter, selection }
      return { ...output, adapter: selection.adapter, selection }
    } catch (error) {
      return adapterFault(ADAPTER_FAULT_CODES.THREW, `adapter ${selection.adapter.id} threw instead of returning a descriptor: ${String(error && error.message ? error.message : error)}`, {
        adapter: selection.adapter,
        selection,
        stack: error && error.stack ? String(error.stack) : null
      })
    }
  }

  /** The panel's view: what is registered, what each takes, and what it promises. */
  function describe() {
    return list().map((adapter) => ({
      id: adapter.id,
      name: adapter.name,
      version: adapter.version,
      api_version: adapter.api_version,
      summary: adapter.summary,
      supports: adapter.supports.slice(),
      priority: adapter.priority,
      runtime_kind: adapter.runtime_kind,
      guarantees: adapter.guarantees.slice(),
      detail: adapter.describe ? safeDescribe(adapter) : null
    }))
  }

  function safeDescribe(adapter) {
    try {
      return adapter.describe() || null
    } catch (error) {
      return { error: String(error && error.message ? error.message : error) }
    }
  }

  return {
    ANY_TYPE,
    register,
    unregister,
    get,
    list,
    candidatesFor,
    plan,
    select,
    adaptWith,
    describe,
    has: (id) => adapters.has(String(id)),
    get size() {
      return adapters.size
    }
  }
}

/** Total order: higher priority first, then adapter id, so selection never depends on insertion. */
function compareAdapters(left, right) {
  if (right.priority !== left.priority) return right.priority - left.priority
  return left.id.localeCompare(right.id)
}

module.exports = { createAdapterRegistry, compareAdapters, ANY_TYPE }
