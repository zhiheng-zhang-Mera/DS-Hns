'use strict'

/**
 * DS-Hns Core: the plugin lockfile.
 *
 * A plugin runtime that resolves by capability is, by design, a runtime whose exact
 * composition depends on what is installed. That is what makes it composable and also
 * what makes "it worked yesterday" hard to reproduce: a plugin that gained a version,
 * or lost one, changes which provider wins a capability, and nothing in the log says
 * so. `dshns-lock.yaml` records the plugin set and its versions so a run can be
 * reproduced, and `verify` compares a lock against the plugins actually installed.
 *
 * The file is YAML because the plan says so and because a human may read or edit it,
 * but the *only* shape it may contain is the one this module understands:
 *
 *   plugins:
 *     computer-use:
 *       version: 1.4.2
 *
 * Anything else — a nested key, a list, a duplicate id, a version that is not a
 * string — is refused with a reason and a line number rather than guessed at. A
 * lockfile parser that silently ignores what it does not understand is worse than no
 * lockfile: it reports a stable environment that was never checked.
 *
 * Drift is a *refusal*, never a warning with a shrug: `verify` reports exactly which
 * plugins were added, removed or moved, because "the composition changed" is the one
 * thing a lockfile exists to say out loud.
 */

const fs = require('node:fs')
const path = require('node:path')

const LOCK_FILE = 'dshns-lock.yaml'
const LOCK_VERSION = 1

/** Every reason a lockfile can be refused, so callers match on a code, not a string. */
const LOCK_REASONS = Object.freeze({
  MISSING: 'PLUGIN_LOCK_MISSING',
  INVALID: 'PLUGIN_LOCK_INVALID',
  DRIFT: 'PLUGIN_LOCK_DRIFT'
})

/**
 * Parse the lockfile's one shape.
 *
 * @param {string} text
 * @returns {{ok:boolean, plugins?:object, reason?:string, line?:number}}
 */
function parseLock(text) {
  const plugins = {}
  const lines = String(text === undefined || text === null ? '' : text).split('\n')
  let inPlugins = false
  let current = null
  let sawPlugins = false
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index].replace(/\r$/, '')
    const line = index + 1
    if (!raw.trim() || raw.trim().startsWith('#')) continue
    const indent = raw.length - raw.trimStart().length
    const body = raw.trim()
    if (indent === 0) {
      if (body !== 'plugins:') return { ok: false, reason: `the only top-level key is "plugins:", found ${JSON.stringify(body)}`, line }
      inPlugins = true
      sawPlugins = true
      current = null
      continue
    }
    if (!inPlugins) return { ok: false, reason: `indented content before the "plugins:" key: ${JSON.stringify(body)}`, line }
    if (indent === 2) {
      const match = body.match(/^([A-Za-z0-9._@/-]+):$/)
      if (!match) return { ok: false, reason: `expected a plugin id at two spaces of indentation, found ${JSON.stringify(body)}`, line }
      if (Object.prototype.hasOwnProperty.call(plugins, match[1])) return { ok: false, reason: `${match[1]} is listed twice`, line }
      plugins[match[1]] = { version: null }
      current = match[1]
      continue
    }
    if (indent === 4 && current) {
      const match = body.match(/^version:\s*(.+)$/)
      if (!match) return { ok: false, reason: `expected "version:" under ${current}, found ${JSON.stringify(body)}`, line }
      const version = match[1].trim().replace(/^["']|["']$/g, '')
      if (!version) return { ok: false, reason: `${current} has an empty version`, line }
      plugins[current].version = version
      continue
    }
    return { ok: false, reason: `unexpected indentation or key: ${JSON.stringify(body)}`, line }
  }
  if (!sawPlugins) return { ok: false, reason: 'the file has no "plugins:" key' }
  for (const [id, entry] of Object.entries(plugins)) {
    if (!entry.version) return { ok: false, reason: `${id} has no version` }
  }
  return { ok: true, plugins }
}

/** Render the documented shape, ids sorted so the file only changes when it must. */
function renderLock(entries = {}, options = {}) {
  const lines = ['# DS-Hns plugin lockfile.', '# Generated from the installed plugin set; edit only to pin a reproduced environment.', '', 'plugins:']
  for (const id of Object.keys(entries).sort()) {
    const entry = entries[id] || {}
    const version = entry.version === undefined || entry.version === null ? '0.0.0' : String(entry.version)
    lines.push(`  ${id}:`)
    lines.push(`    version: ${version}`)
  }
  lines.push('')
  if (options.header) lines.splice(0, 0, ...String(options.header).split('\n'))
  return `${lines.join('\n')}`
}

/**
 * Compare a lock against the plugins that are actually installed.
 *
 * @param {object} lock the parsed `{ id: { version } }` map
 * @param {object[]} installed `[{ id, version }]`
 */
function compareLock(lock, installed = []) {
  const present = new Map(installed.map((entry) => [String(entry.id), entry.version === undefined ? null : String(entry.version)]))
  const added = []
  const removed = []
  const changed = []
  for (const [id, entry] of Object.entries(lock || {})) {
    if (!present.has(id)) {
      removed.push({ id, expected: entry.version, found: null })
      continue
    }
    const found = present.get(id)
    if (found !== entry.version) changed.push({ id, expected: entry.version, found })
  }
  for (const [id, version] of present) {
    if (!Object.prototype.hasOwnProperty.call(lock || {}, id)) added.push({ id, found: version })
  }
  const drift = added.length + removed.length + changed.length
  return {
    ok: drift === 0,
    drift,
    added,
    removed,
    changed,
    reason: drift === 0 ? null : `${drift} plugin(s) drifted from the lock: ${[...changed.map((entry) => `${entry.id} ${entry.expected} -> ${entry.found}`), ...removed.map((entry) => `${entry.id} missing`), ...added.map((entry) => `${entry.id} added`)].join(', ')}`
  }
}

/**
 * @param {object} [options]
 * @param {string} [options.root] the directory the lockfile lives in
 * @param {string} [options.file] an explicit lockfile path
 * @param {Function} [options.log]
 */
function createPluginLock(options = {}) {
  const root = options.root ? path.resolve(String(options.root)) : process.cwd()
  const file = options.file ? path.resolve(String(options.file)) : path.join(root, LOCK_FILE)
  const log = typeof options.log === 'function' ? options.log : () => {}

  function read() {
    if (!fs.existsSync(file)) return { ok: false, code: LOCK_REASONS.MISSING, reason: `${file} does not exist`, file, plugins: null }
    let text = ''
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch (error) {
      return { ok: false, code: LOCK_REASONS.INVALID, reason: `cannot read ${file}: ${error && error.message ? error.message : error}`, file, plugins: null }
    }
    const parsed = parseLock(text)
    if (!parsed.ok) return { ok: false, code: LOCK_REASONS.INVALID, reason: `${file}: ${parsed.reason}`, line: parsed.line || null, file, plugins: null }
    return { ok: true, file, plugins: parsed.plugins, count: Object.keys(parsed.plugins).length }
  }

  /**
   * Compare the installed set against the lock.
   *
   * A missing lockfile is *not* drift: a runtime that has never been locked is a
   * runtime whose composition is whatever is installed, and refusing to start over
   * that would make the lockfile a barrier to first use rather than a guarantee.
   */
  function verify(installed = []) {
    const locked = read()
    if (!locked.ok && locked.code === LOCK_REASONS.MISSING) {
      return { ok: true, locked: false, reason: 'no lockfile is present, so the installed set is authoritative', file }
    }
    if (!locked.ok) return locked
    const compared = compareLock(locked.plugins, installed)
    if (!compared.ok) {
      return { ok: false, code: LOCK_REASONS.DRIFT, reason: compared.reason, drift: compared.drift, added: compared.added, removed: compared.removed, changed: compared.changed, file }
    }
    return { ok: true, locked: true, plugins: locked.count, file }
  }

  /** Write the lock from the installed set. Refuses an empty set rather than emptying the file. */
  function write(installed = [], options_ = {}) {
    if (!Array.isArray(installed) || installed.length === 0) {
      return { ok: false, reason: 'refusing to write an empty lockfile: a lock over nothing would silently allow anything' }
    }
    const entries = {}
    for (const entry of installed) entries[String(entry.id)] = { version: entry.version === undefined || entry.version === null ? '0.0.0' : String(entry.version) }
    const text = renderLock(entries, { header: `# api_version: ${options_.apiVersion || 'dshns.plugin/v1'}` })
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, text, 'utf8')
    } catch (error) {
      return { ok: false, reason: `cannot write ${file}: ${error && error.message ? error.message : error}` }
    }
    log(`plugin lock written: ${file} (${installed.length} plugins)`)
    return { ok: true, file, plugins: installed.length, text }
  }

  return { LOCK_FILE, LOCK_VERSION, LOCK_REASONS, root, file, read, verify, write, compare: compareLock, render: renderLock, parse: parseLock }
}

module.exports = { createPluginLock, parseLock, renderLock, compareLock, LOCK_FILE, LOCK_VERSION, LOCK_REASONS }
