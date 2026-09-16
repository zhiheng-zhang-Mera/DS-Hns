'use strict'

/**
 * DS-Hns Core: what the install pipeline remembers.
 *
 * Installing a plugin is not one act, it is a small history: it arrived from somewhere, at a
 * version, through an adapter, with a set of permissions; it may be updated, pinned so it stops
 * moving, rolled back when the update was wrong, quarantined when it starts failing, and finally
 * removed. None of that survives in the plugin manager, which is deliberately only about the four
 * states a *running* plugin has — so it lives here.
 *
 * Two rules the store follows, and both are about not losing the trail:
 *
 *   * **Every mutation is appended to a bounded history.** A rollback needs a version to go back
 *     to, and "what did this look like before" is the first question asked when something breaks.
 *   * **A pin is a refusal, not a preference.** A pinned plugin is one an update must *decline* to
 *     move, with the pin named in the refusal. A pin that merely discouraged updates would be a
 *     setting, and settings are the things that get overridden in a hurry.
 */

const fs = require('node:fs')
const path = require('node:path')

const RECORDS_VERSION = 1
const MAX_HISTORY = 25

/** The lifecycle a record can be in. `quarantined` is the one that stops it being mounted. */
const RECORD_STATES = Object.freeze({
  INSTALLED: 'installed',
  QUARANTINED: 'quarantined',
  REMOVED: 'removed'
})

function readJson(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * @param {object} input
 * @param {string} input.file where the records live
 * @param {Function} [input.now]
 * @param {Function} [input.log]
 */
function createInstallRecords(input = {}) {
  const file = path.resolve(String(input.file || ''))
  const now = typeof input.now === 'function' ? input.now : () => Date.now()
  const log = typeof input.log === 'function' ? input.log : () => {}

  /** id → record */
  const records = new Map()

  function load() {
    const raw = readJson(file)
    if (!raw || raw.version !== RECORDS_VERSION || !Array.isArray(raw.plugins)) return { ok: true, loaded: 0 }
    for (const entry of raw.plugins) {
      if (entry && entry.id) records.set(String(entry.id), entry)
    }
    return { ok: true, loaded: records.size }
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, `${JSON.stringify({ version: RECORDS_VERSION, plugins: [...records.values()] }, null, 2)}\n`, 'utf8')
      return { ok: true }
    } catch (error) {
      // A store that cannot be written is reported, never thrown: losing the record is bad, losing
      // the install because the record could not be written is worse.
      const reason = String(error && error.message ? error.message : error)
      log({ kind: 'install-records-unwritable', file, reason })
      return { ok: false, reason }
    }
  }

  function get(id) {
    return records.get(String(id)) || null
  }

  function list() {
    return [...records.values()].sort((left, right) => String(left.id).localeCompare(String(right.id)))
  }

  /** Append to a record's bounded history, newest last. */
  function remember(id, entry) {
    const record = get(id)
    if (!record) return null
    record.history = Array.isArray(record.history) ? record.history : []
    record.history.push({ at: now(), ...entry })
    if (record.history.length > MAX_HISTORY) record.history.splice(0, record.history.length - MAX_HISTORY)
    return record
  }

  /**
   * Write one record, keeping whatever history it already had.
   *
   * A re-install of a plugin the store already knows about continues that plugin's history rather
   * than starting a new one, because "this has been installed three times and failed twice" is the
   * fact a person needs and a fresh record would erase.
   */
  function upsert(entry) {
    const id = String(entry.id)
    const existing = get(id)
    const record = {
      id,
      name: entry.name === undefined ? (existing ? existing.name : null) : entry.name,
      version: String(entry.version),
      adapter: entry.adapter || (existing ? existing.adapter : null),
      runtime: entry.runtime || (existing ? existing.runtime : null),
      permissions: entry.permissions || (existing ? existing.permissions : null),
      risk: entry.risk || (existing ? existing.risk : null),
      source: entry.source === undefined ? (existing ? existing.source : null) : entry.source,
      provenance: entry.provenance === undefined ? (existing ? existing.provenance : null) : entry.provenance,
      directory: entry.directory === undefined ? (existing ? existing.directory : null) : entry.directory,
      state: entry.state || RECORD_STATES.INSTALLED,
      /** A pin holds the exact version; `null` means the plugin may be updated. */
      pinned: existing ? existing.pinned === true : false,
      pinnedVersion: existing ? existing.pinnedVersion || null : null,
      quarantine: entry.quarantine === undefined ? (existing ? existing.quarantine : null) : entry.quarantine,
      installedAt: existing ? existing.installedAt : now(),
      updatedAt: now(),
      /** Every version this plugin has been installed at, newest last. */
      versions: [...new Set([...(existing && Array.isArray(existing.versions) ? existing.versions : []), String(entry.version)])],
      history: existing && Array.isArray(existing.history) ? existing.history : []
    }
    records.set(id, record)
    remember(id, { action: existing ? 'reinstalled' : 'installed', version: record.version, adapter: record.adapter ? record.adapter.id : null })
    save()
    log({ kind: 'install-record-written', id, version: record.version })
    return record
  }

  function setState(id, state, detail = {}) {
    const record = get(id)
    if (!record) return { ok: false, reason: `no record for ${id}` }
    record.state = state
    record.updatedAt = now()
    remember(id, { action: `state:${state}`, ...detail })
    save()
    return { ok: true, record }
  }

  /**
   * Pin a plugin to the version it is on.
   *
   * The version is recorded as well as the flag because a pin is a statement about a *specific*
   * version. `pin(id)` with a version pins that version; without one it pins what is installed.
   */
  function pin(id, version) {
    const record = get(id)
    if (!record) return { ok: false, reason: `no record for ${id}` }
    const wanted = version ? String(version) : record.version
    if (version && String(version) !== record.version) {
      // Pinning a version that is not the installed one is a request to *move* there, which is an
      // install, not a pin. Saying so is better than silently pinning something absent.
      return { ok: false, reason: `cannot pin ${wanted}: ${record.version} is installed` }
    }
    record.pinned = true
    record.pinnedVersion = wanted
    record.updatedAt = now()
    remember(id, { action: 'pinned', version: wanted })
    save()
    return { ok: true, record }
  }

  function unpin(id) {
    const record = get(id)
    if (!record) return { ok: false, reason: `no record for ${id}` }
    record.pinned = false
    record.pinnedVersion = null
    record.updatedAt = now()
    remember(id, { action: 'unpinned' })
    save()
    return { ok: true, record }
  }

  /** Whether an update to `version` may proceed, and if not, why. */
  function allowsUpdate(id, version) {
    const record = get(id)
    if (!record) return { ok: true, fresh: true }
    if (record.pinned) {
      return {
        ok: false,
        code: 'RECORD_PINNED',
        reason: `${id} is pinned to ${record.pinnedVersion || record.version}; unpin it before updating to ${version}`
      }
    }
    if (record.state === RECORD_STATES.QUARANTINED) {
      return { ok: false, code: 'RECORD_QUARANTINED', reason: `${id} is quarantined (${record.quarantine ? record.quarantine.reason : 'no reason recorded'}); release it before updating` }
    }
    return { ok: true, from: record.version, to: String(version) }
  }

  /**
   * The version to go back to.
   *
   * The newest version in the history that is not the one currently installed. "Previous version"
   * is otherwise recoverable only from a git reflog nobody kept.
   */
  function rollbackTarget(id) {
    const record = get(id)
    if (!record) return { ok: false, code: 'RECORD_NOT_FOUND', reason: `no record for ${id}` }
    const candidates = (record.versions || []).filter((version) => version !== record.version)
    if (!candidates.length) {
      return { ok: false, code: 'RECORD_NO_ROLLBACK', reason: `${id} has only ever been installed at ${record.version}` }
    }
    return { ok: true, from: record.version, to: candidates[candidates.length - 1] }
  }

  /** Quarantine: the plugin keeps its record, its files and its history, and stops being mounted. */
  function quarantine(id, reason) {
    const record = get(id)
    if (!record) return { ok: false, reason: `no record for ${id}` }
    record.quarantine = { at: now(), reason: String(reason) }
    return setState(id, RECORD_STATES.QUARANTINED, { reason: String(reason) })
  }

  function release(id) {
    const record = get(id)
    if (!record) return { ok: false, reason: `no record for ${id}` }
    const was = record.quarantine
    record.quarantine = null
    const outcome = setState(id, RECORD_STATES.INSTALLED, { released: was ? was.reason : null })
    return { ...outcome, released: was }
  }

  /** Forget a plugin entirely. Used by uninstall, and by nothing else. */
  function forget(id) {
    const record = get(id)
    if (!record) return { ok: false, reason: `no record for ${id}` }
    records.delete(String(id))
    save()
    return { ok: true, id: String(id), lastVersion: record.version }
  }

  load()

  return {
    RECORDS_VERSION,
    RECORD_STATES,
    file,
    load,
    save,
    get,
    list,
    upsert,
    remember,
    setState,
    pin,
    unpin,
    allowsUpdate,
    rollbackTarget,
    quarantine,
    release,
    forget,
    count: () => records.size
  }
}

module.exports = { createInstallRecords, RECORDS_VERSION, RECORD_STATES, MAX_HISTORY }
