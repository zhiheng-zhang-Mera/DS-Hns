'use strict'

/**
 * DS-Hns Core: the config manager.
 *
 * Configuration has to be layered, because the same key means different things at
 * different levels: the shipped default is safe for everybody, the profile is what
 * this machine and this model want, `config/plugins/<id>.json` is what the user
 * decided for one plugin, and an explicit override is what *this run* needs. The
 * precedence is fixed and one-directional:
 *
 *   defaults  <  profile  <  plugin config  <  explicit override
 *
 * A plugin never reads a file. It is handed its own resolved block through its
 * context, which means a plugin cannot widen its own permissions by finding the
 * right JSON — the manager decided what it gets, and the resolved block is
 * inspectable so "why did it use that value?" has an answer.
 *
 * Validation is per-plugin and fail-closed: a value outside its declared range
 * falls back to the default and is *reported*, never silently clamped or accepted.
 */

const fs = require('node:fs')
const path = require('node:path')

/**
 * @param {object} [options]
 * @param {string} [options.root] the repository root
 * @param {string} [options.dir] where plugin config files live (default `<root>/config/plugins`)
 * @param {object} [options.defaults] `{ plugins: { <id>: {...} } }`
 * @param {object} [options.profile] the active profile's config block
 * @param {object} [options.overrides] explicit per-run overrides
 * @param {Function} [options.log]
 */
function createConfigManager(options = {}) {
  const root = options.root ? path.resolve(String(options.root)) : process.cwd()
  const dir = options.dir ? path.resolve(String(options.dir)) : path.join(root, 'config', 'plugins')
  const defaults = options.defaults && typeof options.defaults === 'object' ? options.defaults : { plugins: {} }
  const profile = options.profile && typeof options.profile === 'object' ? options.profile : {}
  const overrides = options.overrides && typeof options.overrides === 'object' ? options.overrides : {}
  const log = typeof options.log === 'function' ? options.log : () => {}
  const issues = []
  const fileCache = new Map()

  /** Read one plugin's config file, bounded and never throwing. */
  function readPluginFile(id) {
    if (fileCache.has(id)) return fileCache.get(id)
    const file = path.join(dir, `${id}.json`)
    let value = null
    try {
      if (fs.existsSync(file)) {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
        value = parsed && typeof parsed === 'object' ? parsed : null
        if (value === null) issues.push({ plugin: id, file, problem: 'the file does not contain an object' })
      }
    } catch (error) {
      issues.push({ plugin: id, file, problem: String(error && error.message ? error.message : error) })
      value = null
    }
    fileCache.set(id, value)
    return value
  }

  /** Merge the four layers for one plugin. */
  function forPlugin(id, schema = null) {
    const layers = [
      { name: 'defaults', value: (defaults.plugins && defaults.plugins[id]) || {} },
      { name: 'profile', value: (profile.plugins && profile.plugins[id]) || (profile[id] && typeof profile[id] === 'object' ? profile[id] : {}) },
      { name: 'plugin-config', value: readPluginFile(id) || {} },
      { name: 'override', value: (overrides.plugins && overrides.plugins[id]) || (overrides[id] && typeof overrides[id] === 'object' ? overrides[id] : {}) }
    ]
    const resolved = {}
    const sources = {}
    for (const layer of layers) {
      for (const [key, value] of Object.entries(layer.value || {})) {
        resolved[key] = value
        sources[key] = layer.name
      }
    }
    if (!schema) return { id, resolved, sources, layers: layers.map((layer) => layer.name) }
    const validated = validate(id, resolved, schema)
    return { id, resolved: validated.value, sources, rejected: validated.rejected, layers: layers.map((layer) => layer.name) }
  }

  /**
   * Validate a resolved block against a plugin's own schema.
   *
   * The schema is deliberately small — `{ key: { type, min, max, enum, default } }`
   * — because a plugin's config is a handful of settings, and a full schema
   * language would be a new dependency and a new failure mode. A value that fails
   * its rule is replaced by the default and *reported*.
   */
  function validate(id, resolved, schema = {}) {
    const value = {}
    const rejected = []
    for (const [key, rule] of Object.entries(schema || {})) {
      const raw = Object.prototype.hasOwnProperty.call(resolved, key) ? resolved[key] : undefined
      const fallback = rule && Object.prototype.hasOwnProperty.call(rule, 'default') ? rule.default : undefined
      if (raw === undefined) {
        if (fallback !== undefined) value[key] = fallback
        continue
      }
      const checked = checkValue(raw, rule)
      if (!checked.ok) {
        rejected.push({ key, value: raw, reason: checked.reason, used: fallback })
        log({ kind: 'config-rejected', plugin: id, key, reason: checked.reason })
        if (fallback !== undefined) value[key] = fallback
        continue
      }
      value[key] = checked.value
    }
    // A key the schema does not know is still carried: the schema declares what is
    // *checked*, not what is permitted, so a plugin may take extra settings.
    for (const [key, raw] of Object.entries(resolved)) {
      if (Object.prototype.hasOwnProperty.call(schema || {}, key)) continue
      value[key] = raw
    }
    return { value, rejected }
  }

  function checkValue(raw, rule) {
    const type = rule && rule.type ? String(rule.type) : null
    if (type === 'number') {
      const number = Number(raw)
      if (!Number.isFinite(number)) return { ok: false, reason: `expected a number, got ${JSON.stringify(raw)}` }
      if (Number.isFinite(rule.min) && number < rule.min) return { ok: false, reason: `${number} is below the minimum ${rule.min}` }
      if (Number.isFinite(rule.max) && number > rule.max) return { ok: false, reason: `${number} is above the maximum ${rule.max}` }
      return { ok: true, value: number }
    }
    if (type === 'boolean') {
      if (typeof raw !== 'boolean') return { ok: false, reason: `expected a boolean, got ${JSON.stringify(raw)}` }
      return { ok: true, value: raw }
    }
    if (type === 'string') {
      if (typeof raw !== 'string') return { ok: false, reason: `expected a string, got ${JSON.stringify(raw)}` }
      if (Array.isArray(rule.enum) && !rule.enum.includes(raw)) return { ok: false, reason: `${JSON.stringify(raw)} is not one of ${rule.enum.join(', ')}` }
      return { ok: true, value: raw }
    }
    if (type === 'array') {
      if (!Array.isArray(raw)) return { ok: false, reason: `expected an array, got ${JSON.stringify(raw)}` }
      return { ok: true, value: raw.slice() }
    }
    if (Array.isArray(rule && rule.enum) && !rule.enum.includes(raw)) {
      return { ok: false, reason: `${JSON.stringify(raw)} is not one of ${rule.enum.join(', ')}` }
    }
    return { ok: true, value: raw }
  }

  /** The whole resolved configuration, for the plugin UI's config panel. */
  function resolveAll(ids = []) {
    const out = {}
    for (const id of ids) {
      const resolved = forPlugin(id)
      out[id] = { config: resolved.resolved, sources: resolved.sources }
    }
    return out
  }

  return {
    root,
    dir,
    forPlugin,
    validate,
    checkValue,
    resolveAll,
    /** Where a plugin's configuration would be read from, for the UI. */
    fileFor(id) {
      return path.join(dir, `${String(id)}.json`)
    },
    /** Every rejection, so a misconfigured run can explain itself. */
    issues() {
      return issues.slice()
    },
    /** Drop the file cache: used after a config file changes. */
    refresh() {
      fileCache.clear()
      return true
    },
    layers() {
      return {
        defaults: Object.keys(defaults.plugins || {}),
        profile: Object.keys(profile.plugins || {}),
        files: fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith('.json')) : [],
        overrides: Object.keys(overrides.plugins || {})
      }
    }
  }
}

module.exports = { createConfigManager }
