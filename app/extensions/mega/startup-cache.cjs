'use strict'

/**
 * The startup cache (`updateplan/startup2.md` §52-§54).
 *
 * One file that remembers what the last run looked like, so a start can **restore first and verify after**
 * instead of discovering everything again: the last workspace, the bundled plugin states, the wallpaper and
 * appearance configuration, and MEGA's last health. For the market it records only what §54 allows — installed,
 * version, health, entry availability — because the catalogue belongs to the market, not to us.
 *
 * It is **not** a second copy of the settings. Every fact in it has an owner (the wallpaper file, the glass
 * file, the store's installed set, the protection layer); this cache records what those owners last said and
 * reads it back as a warm-start *hint*. A value here never overrides an owner — when they disagree, the owner
 * is right and the cache is stale, which is what "restore first, verify after" means.
 *
 * Three properties that make a cache safe to have: a cache that cannot be read is an empty cache (missing,
 * truncated or hand-edited nonsense all answer "nothing remembered", and nothing is thrown); a write goes
 * through a temporary file and a rename, and a failure to write is a log line rather than a failed start; and
 * it forgets — an entry older than `maxAgeMs` is reported as stale and never used as a hint, because what the
 * machine looked like three weeks ago is not a warm start.
 */

const fs = require('node:fs')
const path = require('node:path')

/** What a warm start still counts as warm (§52). A day is the plan's "recent", rounded down. */
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000

/** The keys this cache is allowed to hold. Anything else a caller sends is refused, not stored. */
const CACHE_KEYS = Object.freeze(['workspace', 'session', 'bundled', 'wallpaper', 'appearance', 'health', 'boot'])

/**
 * @param {object}   [options]
 * @param {string}   [options.root]    the repository root
 * @param {string}   [options.file]    an explicit cache file
 * @param {number}   [options.maxAgeMs]
 * @param {Function} [options.now]     test seam
 * @param {Function} [options.log]
 */
function createStartupCache({ root = process.cwd(), file = null, maxAgeMs = DEFAULT_MAX_AGE_MS, now = () => Date.now(), log = () => {} } = {}) {
  const cacheFile = path.resolve(String(file || path.join(root, 'data', 'state', 'startup-cache.json')))
  let cache = null

  /** Read the cache, or an empty one. Never throws: a cache that cannot be read is a cache with nothing in it. */
  function read() {
    if (cache) return cache
    const empty = { version: 1, at: null, entries: {} }
    try {
      if (!fs.existsSync(cacheFile)) {
        cache = empty
        return cache
      }
      const parsed = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
      if (!parsed || typeof parsed !== 'object' || typeof parsed.entries !== 'object' || parsed.entries === null) {
        log('the startup cache is not the shape this build writes; it was ignored')
        cache = empty
        return cache
      }
      const entries = {}
      for (const key of CACHE_KEYS) {
        if (parsed.entries[key] === undefined) continue
        entries[key] = parsed.entries[key]
      }
      cache = { version: 1, at: Number(parsed.at) || null, entries }
    } catch (error) {
      log(`the startup cache could not be read (${error?.message || error}); this is a cold start`)
      cache = empty
    }
    return cache
  }

  /** How old the cache is, in milliseconds — `null` when nothing was ever recorded. */
  function age() {
    const at = read().at
    if (!at) return null
    return Math.max(0, now() - at)
  }

  /** True when there is something remembered and it is young enough to be a warm start (§52). */
  function warm() {
    const current = age()
    return current !== null && current <= maxAgeMs
  }

  /**
   * Record what the owners last said. Unknown keys are reported rather than stored, so this file cannot quietly
   * become a settings store for something else.
   */
  function record(values = {}) {
    const current = read()
    const entries = { ...current.entries }
    const refused = []
    for (const [key, value] of Object.entries(values || {})) {
      if (!CACHE_KEYS.includes(key)) {
        refused.push(key)
        continue
      }
      if (value === undefined || value === null) delete entries[key]
      else entries[key] = value
    }
    const next = { version: 1, at: now(), entries }
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true })
      const temporary = `${cacheFile}.tmp`
      fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
      fs.renameSync(temporary, cacheFile)
    } catch (error) {
      // A cache that can break a start is worse than no cache.
      log(`the startup cache could not be written (${error?.message || error}); the run continues`)
      return { ok: false, reason: String(error?.message || error), refused }
    }
    cache = next
    return { ok: true, at: next.at, refused, keys: Object.keys(entries) }
  }

  /** The warm-start hints, with their age, for the diagnostics panel and for a start that wants to restore. */
  function describe() {
    const current = read()
    return {
      ok: true,
      file: cacheFile,
      warm: warm(),
      ageMs: age(),
      maxAgeMs,
      at: current.at,
      entries: { ...current.entries },
      /** What the plan calls "restore first, verify after": the hint and the fact that it is only a hint. */
      note: 'a warm-start hint, never an owner: the wallpaper, glass, store and protection layer are the truth'
    }
  }

  /** Forget the cache (a cold start on demand, or a corrupt entry the caller wants gone). */
  function clear(key = null) {
    if (!key) {
      try {
        if (fs.existsSync(cacheFile)) fs.rmSync(cacheFile)
      } catch (error) {
        log(`the startup cache could not be removed (${error?.message || error})`)
      }
      cache = { version: 1, at: null, entries: {} }
      return { ok: true, cleared: 'all' }
    }
    if (!CACHE_KEYS.includes(key)) return { ok: false, reason: `"${key}" is not a cache key` }
    const entries = { ...read().entries }
    delete entries[key]
    return writeEntries(entries)
  }

  function writeEntries(entries) {
    const next = { version: 1, at: now(), entries }
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true })
      fs.writeFileSync(cacheFile, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
      cache = next
      return { ok: true, keys: Object.keys(entries) }
    } catch (error) {
      return { ok: false, reason: String(error?.message || error) }
    }
  }

  return { CACHE_KEYS, read, record, describe, clear, warm, age, file: cacheFile, maxAgeMs }
}

module.exports = { createStartupCache, CACHE_KEYS, DEFAULT_MAX_AGE_MS }
