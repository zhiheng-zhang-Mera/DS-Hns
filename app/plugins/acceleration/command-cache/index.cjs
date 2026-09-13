'use strict'

/**
 * DS-Hns acceleration: the command cache.
 *
 * `test`, `lint`, `typecheck`, `build` and the dependency commands dominate the wall
 * time of a long run, and most of those runs repeat a command whose inputs did not
 * change. Reusing the result is the largest single saving available to the runtime.
 *
 * It is also the most dangerous accelerator in the set, because its failure mode is
 * not "slow", it is "wrong":
 *
 *   **A cached pass that predates the last edit is worse than no cache at all.** The
 *   runtime accepts a patch nobody verified and the edit stands. A cached result is
 *   therefore returned only when *every* input is identical — the same command string,
 *   the same relevant file hashes, and the same environment fingerprint — and every
 *   source of doubt refuses the cache instead of guessing:
 *
 *  * **Only known commands are cached.** `CACHEABLE_COMMANDS` names the commands whose
 *    result is a deterministic function of their inputs. The name is read at the
 *    command position, so `npm run build` is a build and `echo build` is not.
 *  * **A failing run is evidence too.** `record(..., ok: false)` stores nothing and
 *    drops every entry for that command, because the earlier pass no longer describes
 *    the tree. A run whose outcome was not reported as successful is treated the same
 *    way: silence is not a pass.
 *  * **An unreadable or truncated input set is not an identity.** A file that cannot
 *    be hashed is recorded as `null` (which changes the key), and a hash set cut short
 *    by the file cap refuses to be stored at all, because "the files I happened to read
 *    are unchanged" is not "the inputs are unchanged".
 *
 * `lookup` never returns a bare false: it says *why* it missed, so a caller can tell
 * "the cache never had this" from "the cache had this and the tree moved on".
 */

const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

/** The commands whose result is a deterministic function of their inputs. */
const CACHEABLE_COMMANDS = Object.freeze({
  test: 'test',
  lint: 'lint',
  typecheck: 'typecheck',
  build: 'build',
  install: 'dependency',
  audit: 'dependency',
  outdated: 'dependency',
  list: 'dependency'
})

/**
 * The environment variables a command's result may genuinely depend on.
 *
 * `PATH` is deliberately absent. It differs between shells, machines and terminals, so
 * including it would turn almost every run into a miss while proving nothing about the
 * tree; the allowlist is the small set that changes what a command actually does.
 */
const ENV_ALLOWLIST = Object.freeze(['CI', 'NODE_ENV', 'npm_config_registry'])

const DEFAULT_TTL_MS = 30 * 60 * 1000
const DEFAULT_MAX_ENTRIES = 200
const DEFAULT_MAX_FILES = 500

/**
 * Tokens that introduce a command rather than being one, so `npm run build` is
 * recognised at the same position as a bare `build`, and `echo build` is not a build.
 */
const RUNNERS = Object.freeze(['npm', 'npx', 'pnpm', 'pnpx', 'yarn', 'bun', 'bunx', 'node', 'run', 'run-script', 'exec', 'dlx', 'env'])

const KEY_PREFIX = 'cmd'
const ENV_PREFIX = 'env'
const DIGEST_LENGTH = 16

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex')
}

function shortDigest(value) {
  return sha256(value).slice(0, DIGEST_LENGTH)
}

function text(value, fallback) {
  return value === undefined || value === null || value === '' ? String(fallback) : String(value)
}

/** A fixed key order, so the same input always serializes to the same bytes. */
function sortPairs(pairs) {
  return [...pairs].sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
}

/**
 * The cacheable name of a command, or null.
 *
 * The name is read at the command position — after any leading runner tokens — rather
 * than anywhere in the string, because "build" appearing as an argument does not make
 * `echo build` a build, and a compound `cd x && npm test` is not a plain test run.
 */
function commandName(command) {
  const tokens = String(command === undefined || command === null ? '' : command).trim().split(/\s+/).filter(Boolean)
  let index = 0
  while (index < tokens.length && RUNNERS.includes(tokens[index])) index += 1
  const candidate = tokens[index] || ''
  return Object.prototype.hasOwnProperty.call(CACHEABLE_COMMANDS, candidate) ? candidate : null
}

/** What the table says about a command: its name, its kind, and whether it is cacheable. */
function classifyCommand(command) {
  const name = commandName(command)
  if (!name) return { name: null, kind: null, cacheable: false }
  return { name, kind: CACHEABLE_COMMANDS[name], cacheable: true }
}

/**
 * Which object holds the environment variables.
 *
 * `fingerprintEnv` accepts the named-input shape (`{ node, platform, arch, env }`) and,
 * because a caller that just wants to say "this ran with NODE_ENV=production" should
 * not have to know that shape, a bare bag of the allowlisted variables as well.
 */
function envSourceOf(input) {
  if (input && typeof input.env === 'object' && input.env !== null) return input.env
  if (input && typeof input === 'object') {
    for (const name of ENV_ALLOWLIST) {
      if (Object.prototype.hasOwnProperty.call(input, name)) return input
    }
  }
  return process.env
}

/**
 * A short, stable fingerprint of everything about the environment that can change a
 * command's result.
 *
 * Only the allowlist is read, so the fingerprint is deterministic and does not carry
 * the process environment (and its secrets) into a cache key.
 *
 * @param {object} [input]
 * @param {string} [input.node] defaults to `process.versions.node`
 * @param {string} [input.platform] defaults to `process.platform`
 * @param {string} [input.arch] defaults to `process.arch`
 * @param {object} [input.env] the environment bag; defaults to `process.env`
 * @param {string} [input.lockfile] a lockfile hash, when the caller has one
 */
function fingerprintEnv(input = {}) {
  const source = envSourceOf(input)
  const env = sortPairs(ENV_ALLOWLIST.map((name) => {
    const value = source ? source[name] : undefined
    return [name, value === undefined || value === null ? null : String(value)]
  }))
  const pairs = sortPairs([
    ['arch', text(input.arch, process.arch)],
    ['env', env],
    ['lockfile', input.lockfile === undefined || input.lockfile === null ? null : String(input.lockfile)],
    ['node', text(input.node, process.versions.node)],
    ['platform', text(input.platform, process.platform)]
  ])
  return `${ENV_PREFIX}${shortDigest(JSON.stringify(pairs))}`
}

/**
 * The environment half of a cache key.
 *
 * An already-computed fingerprint is passed through unchanged, so a caller can carry
 * one value through a whole run instead of re-deriving it per lookup.
 */
function resolveEnvFingerprint(value) {
  if (typeof value === 'string' && value) return value
  return fingerprintEnv(value && typeof value === 'object' ? value : {})
}

/**
 * Hash the files a command depends on.
 *
 * A file that cannot be read is recorded as `null` and listed in `missing`, never
 * skipped: a hash set that silently omits a file is a cache key that cannot notice the
 * file changing. The cap is the same kind of statement — when it is hit, `truncated`
 * says the set is incomplete, and `createCommandCache` refuses to treat it as identity.
 *
 * @param {string[]} files
 * @param {object} [options]
 * @param {number} [options.maxFiles]
 */
function hashFiles(files, options = {}) {
  const maxFiles = Number.isInteger(options.maxFiles) && options.maxFiles >= 0 ? options.maxFiles : DEFAULT_MAX_FILES
  const list = Array.isArray(files)
    ? [...new Set(files.filter((file) => file !== undefined && file !== null).map(String))]
    : []
  const hashes = {}
  const missing = []
  let bytes = 0
  for (const file of list.slice(0, maxFiles)) {
    let buffer = null
    try {
      buffer = fs.readFileSync(file)
    } catch {
      hashes[file] = null
      missing.push(file)
      continue
    }
    hashes[file] = createHash('sha256').update(buffer).digest('hex')
    bytes += buffer.length
  }
  return { hashes, missing, bytes, truncated: list.length > maxFiles }
}

/** Do two path strings name the same file? Callers mix absolute and relative forms. */
function sameFile(left, right) {
  const a = String(left)
  const b = String(right)
  if (a === b) return true
  return path.resolve(a) === path.resolve(b)
}

/**
 * @param {object} [options]
 * @param {Function} [options.now] injected clock, so the core stays pure
 * @param {number} [options.ttlMs]
 * @param {number} [options.maxEntries]
 * @param {Function} [options.hashFiles] injected hasher
 */
function createCommandCache(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const ttlMs = Number.isFinite(options.ttlMs) ? Number(options.ttlMs) : DEFAULT_TTL_MS
  const maxEntries = Number.isInteger(options.maxEntries) && options.maxEntries > 0 ? options.maxEntries : DEFAULT_MAX_ENTRIES
  const hashFilesImpl = typeof options.hashFiles === 'function' ? options.hashFiles : hashFiles

  /** key -> entry, held in least-recently-used order: the first key is the victim. */
  let entries = new Map()
  /** command name -> the last failing run, so a lookup can say why it has nothing. */
  const failures = new Map()
  let hits = 0
  let misses = 0
  let evictions = 0
  let savedMs = 0

  /**
   * Normalize the `files` argument into hashes plus the file list the key was computed
   * over. A caller may pass the paths (they are hashed here) or an already-computed
   * `hashFiles` result, which is what an injected hasher or a shared scan produces.
   */
  function resolveHashes(files) {
    if (Array.isArray(files)) {
      const computed = hashFilesImpl(files) || {}
      const hashes = computed.hashes && typeof computed.hashes === 'object' ? computed.hashes : {}
      return {
        hashes: { ...hashes },
        missing: Array.isArray(computed.missing) ? computed.missing.map(String) : [],
        truncated: computed.truncated === true,
        files: Object.keys(hashes).map(String)
      }
    }
    if (files && typeof files === 'object') {
      const source = files.hashes && typeof files.hashes === 'object' ? files.hashes : files
      const hashes = {}
      for (const name of Object.keys(source)) {
        const value = source[name]
        hashes[String(name)] = value === undefined || value === null ? null : String(value)
      }
      return {
        hashes,
        missing: Array.isArray(files.missing) ? files.missing.map(String) : Object.keys(hashes).filter((file) => hashes[file] === null),
        truncated: files.truncated === true,
        files: Object.keys(hashes)
      }
    }
    return { hashes: {}, missing: [], truncated: false, files: [] }
  }

  /** The key material: command, sorted file hashes, env fingerprint, truncation. */
  function keyFrom(command, resolved, env) {
    const files = sortPairs(Object.keys(resolved.hashes).map((file) => [file, resolved.hashes[file]]))
    const material = JSON.stringify(sortPairs([
      ['command', command],
      ['env', env],
      ['files', files],
      ['truncated', resolved.truncated === true]
    ]))
    return `${KEY_PREFIX}:${shortDigest(material)}`
  }

  function key(input = {}) {
    const command = String(input.command === undefined || input.command === null ? '' : input.command)
    return keyFrom(command, resolveHashes(input.files), resolveEnvFingerprint(input.env))
  }

  function entriesFor(name) {
    const found = []
    for (const entry of entries.values()) {
      if (entry.name === name) found.push(entry)
    }
    return found
  }

  /** A hit (or a re-record) makes an entry the most recently used one. */
  function store(key, entry) {
    entries.delete(key)
    entries.set(key, entry)
    evict()
  }

  function evict() {
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next()
      if (oldest.done) return
      entries.delete(oldest.value)
      evictions += 1
    }
  }

  function dropCommand(name) {
    let removed = 0
    for (const [entryKey, entry] of entries) {
      if (entry.name !== name) continue
      entries.delete(entryKey)
      removed += 1
    }
    return removed
  }

  /**
   * Is there a usable result for exactly these inputs?
   *
   * Every miss carries the reason it missed, because the caller's next move differs:
   * "'no entry'" means run it, "'inputs changed'" and "'the previous run failed'" mean
   * the previous evidence is void, "'expired'" means it is too old to trust.
   */
  function lookup(input = {}) {
    const classified = classifyCommand(input.command)
    if (!classified.cacheable) {
      misses += 1
      return { hit: false, key: null, reason: 'not a cacheable command' }
    }
    const cacheKey = key(input)
    const entry = entries.get(cacheKey)
    if (entry) {
      const ageMs = now() - entry.at
      if (ageMs >= ttlMs) {
        // Dead evidence is dropped, so it cannot push a live entry out of the bound.
        entries.delete(cacheKey)
        misses += 1
        return { hit: false, key: cacheKey, reason: 'expired' }
      }
      entry.touchedAt = now()
      store(cacheKey, entry)
      hits += 1
      savedMs += entry.durationMs
      return { hit: true, result: entry.result, key: cacheKey, ageMs, savedMs: entry.durationMs }
    }
    misses += 1
    if (entriesFor(classified.name).length > 0) return { hit: false, key: cacheKey, reason: 'inputs changed' }
    if (failures.has(classified.name)) return { hit: false, key: cacheKey, reason: 'the previous run failed' }
    return { hit: false, key: cacheKey, reason: 'no entry' }
  }

  /**
   * Store a successful run.
   *
   * Only `ok: true` is cached — a run whose outcome was not reported as successful is
   * not evidence — and any non-success drops every entry for that command, so a stale
   * pass can never be returned after a failure.
   */
  function record(input = {}) {
    const classified = classifyCommand(input.command)
    if (!classified.cacheable) return { stored: false, reason: 'not a cacheable command' }
    const command = String(input.command === undefined || input.command === null ? '' : input.command)
    if (input.ok !== true) {
      dropCommand(classified.name)
      failures.set(classified.name, { at: now(), command })
      return { stored: false, reason: 'failures are not cached' }
    }
    const resolved = resolveHashes(input.files)
    if (resolved.truncated) return { stored: false, reason: 'the file set was truncated' }
    const env = resolveEnvFingerprint(input.env)
    const cacheKey = keyFrom(command, resolved, env)
    const at = now()
    const durationMs = Number.isFinite(input.durationMs) && Number(input.durationMs) > 0 ? Number(input.durationMs) : 0
    store(cacheKey, {
      key: cacheKey,
      command,
      name: classified.name,
      kind: classified.kind,
      files: resolved.files,
      missing: resolved.missing,
      env,
      result: input.result,
      durationMs,
      at,
      touchedAt: at
    })
    failures.delete(classified.name)
    return { stored: true, key: cacheKey }
  }

  /**
   * Drop what is no longer true.
   *
   * `input.command` removes every entry for that command; `input.files` removes every
   * entry whose key was computed over any of those files, which is what a caller knows
   * after a patch.
   */
  function invalidate(input = {}) {
    let removed = 0
    const classified = classifyCommand(input.command)
    if (classified.cacheable) {
      removed += dropCommand(classified.name)
      failures.delete(classified.name)
    }
    const changed = Array.isArray(input.files) ? input.files.filter((file) => file !== undefined && file !== null) : []
    if (changed.length) {
      for (const [entryKey, entry] of entries) {
        if (!entry.files.some((file) => changed.some((target) => sameFile(file, target)))) continue
        entries.delete(entryKey)
        removed += 1
      }
    }
    return { removed }
  }

  function clear() {
    const removed = entries.size
    entries = new Map()
    failures.clear()
    hits = 0
    misses = 0
    evictions = 0
    savedMs = 0
    return { removed }
  }

  function stats() {
    const lookups = hits + misses
    return {
      entries: entries.size,
      hits,
      misses,
      hitRate: lookups === 0 ? 0 : hits / lookups,
      evictions,
      savedMs
    }
  }

  return {
    CACHEABLE_COMMANDS,
    DEFAULT_TTL_MS,
    DEFAULT_MAX_ENTRIES,
    ttlMs,
    maxEntries,
    key,
    lookup,
    record,
    invalidate,
    clear,
    stats,
    get size() {
      return entries.size
    }
  }
}

module.exports = {
  createCommandCache,
  fingerprintEnv,
  hashFiles,
  classifyCommand,
  commandName,
  CACHEABLE_COMMANDS,
  ENV_ALLOWLIST,
  RUNNERS,
  DEFAULT_TTL_MS,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_MAX_FILES
}
