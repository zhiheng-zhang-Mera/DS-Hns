'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  createCommandCache,
  fingerprintEnv,
  hashFiles,
  classifyCommand,
  CACHEABLE_COMMANDS,
  ENV_ALLOWLIST,
  DEFAULT_TTL_MS,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_MAX_FILES
} = require('../../app/plugins/acceleration/command-cache/index.cjs')

/**
 * The command cache (Update-Plan/accleration.md phase 12).
 *
 * Every test here is about the one failure mode this accelerator can have: returning a
 * result that no longer describes the tree. A cache that is merely slow is a
 * disappointment; a cache that reports a passing `npm test` from before the last edit
 * makes the runtime accept a patch nobody verified. So the assertions are about *which
 * reason* a miss carries, and never only about `hit === false`.
 *
 * Everything runs in a temporary directory with an injected clock and an injected
 * environment, so no test reads or writes the real repository or the real `Date.now()`.
 */

const CACHE_MODULE = require('../../app/plugins/acceleration/command-cache/index.cjs')

/** A hermetic environment input: the real one would make the keys non-deterministic. */
const BASE_ENV = {
  env: { CI: '1', NODE_ENV: 'test', npm_config_registry: 'https://registry.example' },
  node: 'v20.11.0',
  platform: 'win32',
  arch: 'x64'
}

function envInput(overrides = {}) {
  return { ...BASE_ENV, ...overrides, env: { ...BASE_ENV.env, ...(overrides.env || {}) } }
}

/** A fake clock, so ttl and age assertions do not depend on wall time. */
function createClock(start = 0) {
  let value = start
  return {
    now: () => value,
    advance: (ms) => {
      value += ms
      return value
    },
    set: (ms) => {
      value = ms
      return value
    }
  }
}

/** Run a test body against a temporary repository and always remove it again. */
function withRepo(files, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshns-cache-'))
  try {
    for (const [name, content] of Object.entries(files)) {
      const target = path.join(dir, name)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, content, 'utf8')
    }
    return body(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('the command cache contract is frozen and complete', () => {
  assert.deepEqual(CACHEABLE_COMMANDS, {
    test: 'test',
    lint: 'lint',
    typecheck: 'typecheck',
    build: 'build',
    install: 'dependency',
    audit: 'dependency',
    outdated: 'dependency',
    list: 'dependency'
  })
  assert.equal(Object.isFrozen(CACHEABLE_COMMANDS), true)
  assert.equal(Object.isFrozen(ENV_ALLOWLIST), true)
  assert.deepEqual([...ENV_ALLOWLIST].sort(), ['CI', 'NODE_ENV', 'npm_config_registry'])
  assert.equal(ENV_ALLOWLIST.includes('PATH'), false, 'PATH must not be part of the identity')
  assert.equal(DEFAULT_TTL_MS, 30 * 60 * 1000)
  assert.equal(DEFAULT_MAX_ENTRIES, 200)
  assert.equal(DEFAULT_MAX_FILES, 500)
  for (const name of ['createCommandCache', 'fingerprintEnv', 'hashFiles', 'CACHEABLE_COMMANDS', 'DEFAULT_TTL_MS', 'DEFAULT_MAX_ENTRIES']) {
    assert.notEqual(CACHE_MODULE[name], undefined, `missing export: ${name}`)
  }
  // A cache with no options still works; only the clock and the environment are injected
  // where a test needs determinism.
  const cache = createCommandCache()
  assert.equal(cache.size, 0)
  assert.equal(cache.ttlMs, DEFAULT_TTL_MS)
  assert.equal(cache.maxEntries, DEFAULT_MAX_ENTRIES)
  assert.deepEqual(cache.stats(), { entries: 0, hits: 0, misses: 0, hitRate: 0, evictions: 0, savedMs: 0 })
})

test('an identical command over identical inputs is a hit that returns the recorded result', () => {
  withRepo({ 'src/a.cjs': 'module.exports = 1\n' }, (dir) => {
    const clock = createClock(1_000)
    const cache = createCommandCache({ now: clock.now })
    const file = path.join(dir, 'src', 'a.cjs')
    const input = { command: 'npm test', files: [file], env: envInput() }

    const recorded = cache.record({ ...input, result: { passed: 5, failed: 0 }, ok: true, durationMs: 1_200 })
    assert.equal(recorded.stored, true)
    assert.deepEqual(recorded, { stored: true, key: recorded.key })
    assert.match(recorded.key, /^cmd:[0-9a-f]{16}$/)

    clock.advance(1_000)
    const hit = cache.lookup(input)
    assert.equal(hit.hit, true)
    assert.deepEqual(hit.result, { passed: 5, failed: 0 }, 'the recorded result comes back, not a copy of the request')
    assert.equal(hit.key, recorded.key)
    assert.equal(hit.ageMs, 1_000)
    assert.equal(hit.savedMs, 1_200, 'the hit reports what the cached run would have cost')
    assert.equal(cache.size, 1)

    const stats = cache.stats()
    assert.equal(stats.entries, 1)
    assert.equal(stats.hits, 1)
    assert.equal(stats.misses, 0)
    assert.equal(stats.hitRate, 1)
    assert.equal(stats.savedMs, 1_200)

    // A second hit accumulates, and still does not count as a miss.
    clock.advance(500)
    assert.equal(cache.lookup(input).hit, true)
    assert.equal(cache.stats().hits, 2)
    assert.equal(cache.stats().misses, 0)
    assert.equal(cache.stats().savedMs, 2_400)
  })
})

test('a changed environment fingerprint misses with the reason "inputs changed"', () => {
  withRepo({ 'src/a.cjs': 'module.exports = 1\n' }, (dir) => {
    const clock = createClock()
    const cache = createCommandCache({ now: clock.now })
    const file = path.join(dir, 'src', 'a.cjs')
    const before = { command: 'npm test', files: [file], env: envInput() }
    cache.record({ ...before, result: { passed: 1 }, ok: true, durationMs: 10 })

    const after = { command: 'npm test', files: [file], env: envInput({ env: { NODE_ENV: 'production' } }) }
    assert.notEqual(fingerprintEnv(before.env), fingerprintEnv(after.env), 'the environment really did change')
    const miss = cache.lookup(after)
    assert.equal(miss.hit, false)
    assert.equal(miss.reason, 'inputs changed', 'an entry exists for this command, but under other inputs')
    assert.match(miss.key, /^cmd:[0-9a-f]{16}$/)
    assert.notEqual(miss.key, cache.key(before))

    // The environment is part of the identity, not a tie-breaker: the old inputs still
    // describe exactly the state that was recorded, so they still hit.
    assert.equal(cache.lookup(before).hit, true)
    assert.equal(cache.stats().misses, 1)

    // A different toolchain version is a different environment too.
    const otherNode = { command: 'npm test', files: [file], env: envInput({ node: 'v22.0.0' }) }
    assert.equal(cache.lookup(otherNode).reason, 'inputs changed')
  })
})

test('a changed relevant file misses with the reason "inputs changed"', () => {
  withRepo({ 'src/a.cjs': 'module.exports = 1\n' }, (dir) => {
    const clock = createClock()
    const cache = createCommandCache({ now: clock.now })
    const file = path.join(dir, 'src', 'a.cjs')
    const input = { command: 'npm run lint', files: [file], env: envInput() }
    const key = cache.record({ ...input, result: { warnings: 0 }, ok: true, durationMs: 300 }).key

    fs.writeFileSync(file, 'module.exports = 2\n', 'utf8')
    const changed = cache.lookup(input)
    assert.equal(changed.hit, false)
    assert.equal(changed.reason, 'inputs changed')
    assert.notEqual(changed.key, key)

    // A file that disappears is a change too: it hashes to null rather than being
    // quietly ignored.
    fs.rmSync(file)
    assert.deepEqual(hashFiles([file]).missing, [file])
    const gone = cache.lookup(input)
    assert.equal(gone.hit, false)
    assert.equal(gone.reason, 'inputs changed')
    assert.notEqual(gone.key, key)
    assert.notEqual(gone.key, changed.key)

    // Restoring the original bytes restores the original identity, and with it the entry.
    fs.writeFileSync(file, 'module.exports = 1\n', 'utf8')
    const restored = cache.lookup(input)
    assert.equal(restored.hit, true, 'the earlier result still describes these exact inputs')
    assert.equal(restored.key, key)
  })
})

test('a failing run is never cached and invalidates the previous entry', () => {
  withRepo({ 'src/a.cjs': 'module.exports = 1\n' }, (dir) => {
    const clock = createClock()
    const cache = createCommandCache({ now: clock.now })
    const input = { command: 'npm test', files: [path.join(dir, 'src', 'a.cjs')], env: envInput() }

    assert.equal(cache.record({ ...input, result: { passed: 5, failed: 0 }, ok: true, durationMs: 900 }).stored, true)
    assert.equal(cache.lookup(input).hit, true)

    const failed = cache.record({ ...input, result: { passed: 0, failed: 3 }, ok: false, durationMs: 950 })
    assert.deepEqual(failed, { stored: false, reason: 'failures are not cached' })
    assert.equal(cache.size, 0, 'the earlier pass is dropped: it describes a tree that no longer passes')
    assert.deepEqual(cache.stats().entries, 0)

    const miss = cache.lookup(input)
    assert.equal(miss.hit, false)
    assert.equal(miss.reason, 'the previous run failed')

    // A run whose outcome was not reported as successful is not evidence either.
    assert.deepEqual(cache.record({ ...input, result: { passed: 9 }, durationMs: 800 }), { stored: false, reason: 'failures are not cached' })
    assert.equal(cache.size, 0)
    assert.equal(cache.lookup(input).reason, 'the previous run failed')

    // A later pass clears the failure and is cacheable again, so a single red run does
    // not poison the command for the rest of the session.
    const again = cache.record({ ...input, result: { passed: 7, failed: 0 }, ok: true, durationMs: 500 })
    assert.equal(again.stored, true)
    const hit = cache.lookup(input)
    assert.equal(hit.hit, true)
    assert.deepEqual(hit.result, { passed: 7, failed: 0 })
  })
})

test('a non-cacheable command is refused by both lookup and record', () => {
  const clock = createClock()
  const cache = createCommandCache({ now: clock.now })
  for (const command of ['git commit -m wip', 'echo build', 'npx jest', 'rm -rf /', '', undefined]) {
    const miss = cache.lookup({ command, files: [], env: envInput() })
    assert.equal(miss.hit, false, `lookup of ${String(command)}`)
    assert.equal(miss.reason, 'not a cacheable command', `lookup of ${String(command)}`)
    assert.equal(miss.key, null, 'a command outside the table has no key at all')
    assert.deepEqual(
      cache.record({ command, files: [], env: envInput(), result: {}, ok: true, durationMs: 5 }),
      { stored: false, reason: 'not a cacheable command' },
      `record of ${String(command)}`
    )
  }
  assert.equal(cache.size, 0, 'nothing outside the table is ever stored')
  // The refusals are misses; `record` never counts as a lookup.
  assert.equal(cache.stats().misses, 6)
  assert.equal(cache.stats().hits, 0)

  // The name is read at the command position, not anywhere in the string.
  assert.deepEqual(classifyCommand('npm run lint'), { name: 'lint', kind: 'lint', cacheable: true })
  assert.deepEqual(classifyCommand('npm test -- --watch'), { name: 'test', kind: 'test', cacheable: true })
  assert.deepEqual(classifyCommand('yarn audit --json'), { name: 'audit', kind: 'dependency', cacheable: true })
  assert.deepEqual(classifyCommand('npm install left-pad'), { name: 'install', kind: 'dependency', cacheable: true })
  assert.deepEqual(classifyCommand('echo build'), { name: null, kind: null, cacheable: false })
  assert.deepEqual(classifyCommand('cd app && npm test'), { name: null, kind: null, cacheable: false })
})

test('an entry expires after ttlMs and reports the reason "expired"', () => {
  withRepo({ 'src/a.cjs': 'x\n' }, (dir) => {
    const clock = createClock(5_000)
    const cache = createCommandCache({ now: clock.now, ttlMs: 60_000 })
    const input = { command: 'npm run typecheck', files: [path.join(dir, 'src', 'a.cjs')], env: envInput() }
    cache.record({ ...input, result: { errors: 0 }, ok: true, durationMs: 4_000 })

    clock.advance(59_999)
    assert.equal(cache.lookup(input).hit, true, 'one millisecond short of the ttl is still a hit')

    clock.set(5_000 + 60_000)
    const expired = cache.lookup(input)
    assert.equal(expired.hit, false)
    assert.equal(expired.reason, 'expired')
    assert.match(expired.key, /^cmd:[0-9a-f]{16}$/)
    assert.equal(cache.size, 0, 'the dead entry is dropped, not kept to evict a live one later')
    assert.equal(cache.stats().misses, 1)
    assert.equal(cache.stats().savedMs, 4_000, 'the earlier hit still counts as saved time')
    assert.equal(cache.lookup(input).reason, 'no entry', 'the expired entry is gone, so it is not reported twice')
  })
})

test('the cache is bounded and evicts the least recently used entry', () => {
  withRepo({ 'f0.txt': '0', 'f1.txt': '1', 'f2.txt': '2', 'f3.txt': '3' }, (dir) => {
    const clock = createClock()
    const cache = createCommandCache({ now: clock.now, maxEntries: 3 })
    const commands = ['npm test', 'npm run lint', 'npm run typecheck', 'npm run build', 'npm install left-pad']
    const inputs = commands.map((command, index) => ({
      command,
      files: [path.join(dir, `f${index}.txt`)],
      env: envInput()
    }))

    for (const input of inputs) {
      clock.advance(10)
      assert.equal(cache.record({ ...input, result: { command: input.command }, ok: true, durationMs: 100 }).stored, true)
    }
    assert.equal(cache.size, 3, 'maxEntries is a ceiling, not a suggestion')
    assert.equal(cache.stats().evictions, 2, 'five records into a cache of three evict twice')
    assert.equal(cache.stats().entries, 3)
    assert.equal(cache.stats().misses, 0, 'record is not a lookup')

    // The two oldest — test and lint — were the victims.
    const evicted = cache.lookup(inputs[0])
    assert.equal(evicted.hit, false)
    assert.equal(evicted.reason, 'no entry', 'an evicted command has nothing left to describe')
    assert.equal(cache.lookup(inputs[1]).reason, 'no entry')
    const survivor = cache.lookup(inputs[4])
    assert.equal(survivor.hit, true)
    assert.deepEqual(survivor.result, { command: 'npm install left-pad' })
    assert.equal(cache.stats().misses, 2)

    // A hit refreshes recency, so the victim is the entry nobody used — not the oldest.
    const lru = createCommandCache({ now: clock.now, maxEntries: 3 })
    lru.record({ ...inputs[0], result: { command: inputs[0].command }, ok: true, durationMs: 1 })
    lru.record({ ...inputs[1], result: { command: inputs[1].command }, ok: true, durationMs: 1 })
    lru.record({ ...inputs[2], result: { command: inputs[2].command }, ok: true, durationMs: 1 })
    assert.equal(lru.lookup(inputs[0]).hit, true, 'the oldest entry is used, so it stops being the victim')
    lru.record({ ...inputs[3], result: { command: inputs[3].command }, ok: true, durationMs: 1 })
    assert.equal(lru.stats().evictions, 1)
    assert.equal(lru.lookup(inputs[0]).hit, true, 'the used entry survived the eviction')
    assert.equal(lru.lookup(inputs[2]).hit, true)
    assert.equal(lru.lookup(inputs[1]).reason, 'no entry', 'the untouched entry was the victim')
  })
})

test('invalidate drops every entry keyed over a file and every entry for a command', () => {
  withRepo({ 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c' }, (dir) => {
    const clock = createClock()
    const cache = createCommandCache({ now: clock.now })
    const a = path.join(dir, 'a.txt')
    const b = path.join(dir, 'b.txt')
    const c = path.join(dir, 'c.txt')
    const testInput = { command: 'npm test', files: [a, c], env: envInput() }
    const lintInput = { command: 'npm run lint', files: [b], env: envInput() }
    cache.record({ ...testInput, result: { passed: 1 }, ok: true, durationMs: 100 })
    cache.record({ ...lintInput, result: { warnings: 0 }, ok: true, durationMs: 50 })
    assert.equal(cache.size, 2)

    // One file, which only the test entry was keyed over.
    assert.deepEqual(cache.invalidate({ files: [c] }), { removed: 1 })
    assert.equal(cache.size, 1)
    assert.equal(cache.lookup(testInput).reason, 'no entry')
    assert.equal(cache.lookup(lintInput).hit, true, 'an unrelated file leaves the other entry alone')

    // Nothing to invalidate is not an error.
    assert.deepEqual(cache.invalidate({}), { removed: 0 })
    assert.deepEqual(cache.invalidate({ files: [] }), { removed: 0 })

    // A command-wide invalidation removes what is left.
    assert.deepEqual(cache.invalidate({ command: 'npm run lint' }), { removed: 1 })
    assert.equal(cache.size, 0)
    assert.equal(cache.lookup(lintInput).reason, 'no entry')

    // clear() empties the cache and its counters.
    cache.record({ ...testInput, result: { passed: 2 }, ok: true, durationMs: 100 })
    assert.equal(cache.lookup(testInput).hit, true)
    assert.deepEqual(cache.clear(), { removed: 1 })
    assert.equal(cache.size, 0)
    assert.deepEqual(cache.stats(), { entries: 0, hits: 0, misses: 0, hitRate: 0, evictions: 0, savedMs: 0 })
    assert.equal(cache.lookup(testInput).reason, 'no entry')
  })
})

test('a truncated or unreadable input set is never treated as a valid identity', () => {
  const clock = createClock()
  const hashes = { 'a.cjs': 'deadbeef' }
  const truncated = createCommandCache({
    now: clock.now,
    hashFiles: () => ({ hashes, missing: [], bytes: 4, truncated: true })
  })
  const input = { command: 'npm test', files: ['a.cjs'], env: envInput() }
  assert.deepEqual(truncated.record({ ...input, result: { passed: 1 }, ok: true, durationMs: 10 }), {
    stored: false,
    reason: 'the file set was truncated'
  })
  assert.equal(truncated.size, 0)
  assert.equal(truncated.lookup(input).reason, 'no entry', 'a truncated identity can never have been stored')

  // The same hashes with a complete scan do store, so the refusal is about truncation
  // and not about the injected hasher.
  const complete = createCommandCache({
    now: clock.now,
    hashFiles: () => ({ hashes, missing: [], bytes: 4, truncated: false })
  })
  assert.equal(complete.record({ ...input, result: { passed: 1 }, ok: true, durationMs: 10 }).stored, true)
  assert.equal(complete.lookup(input).hit, true)

  // Injected hashes are part of the key, so a caller can pass a shared scan instead of
  // a path list.
  const shared = createCommandCache({ now: clock.now, hashFiles: () => ({ hashes, missing: [], bytes: 4, truncated: false }) })
  const key = shared.record({ command: 'npm test', files: ['a.cjs'], env: envInput(), result: { passed: 1 }, ok: true, durationMs: 10 }).key
  assert.equal(shared.key({ command: 'npm test', files: { 'a.cjs': 'deadbeef' }, env: envInput() }), key)

  // A file that cannot be read is null in the key, so its disappearance is a change.
  withRepo({ 'a.txt': 'a' }, (dir) => {
    const file = path.join(dir, 'a.txt')
    const cache = createCommandCache({ now: clock.now })
    const keyed = { command: 'npm run build', files: [file], env: envInput() }
    const before = cache.record({ ...keyed, result: { ok: true }, ok: true, durationMs: 20 }).key
    assert.equal(cache.lookup(keyed).hit, true)
    fs.rmSync(file)
    const gone = cache.key(keyed)
    assert.notEqual(gone, before)
    const miss = cache.lookup(keyed)
    assert.equal(miss.hit, false)
    assert.equal(miss.reason, 'inputs changed')
    assert.equal(miss.key, gone)
  })
})

test('hashFiles marks a missing file and fingerprintEnv is stable under key reordering', () => {
  withRepo({ 'a.txt': 'alpha' }, (dir) => {
    const present = path.join(dir, 'a.txt')
    const absent = path.join(dir, 'gone.txt')

    const hashed = hashFiles([present, absent, present])
    assert.match(hashed.hashes[present], /^[0-9a-f]{64}$/)
    assert.equal(hashed.hashes[absent], null, 'an unreadable file is null, never absent from the map')
    assert.deepEqual(hashed.missing, [absent])
    assert.deepEqual(Object.keys(hashed.hashes).sort(), [absent, present].sort(), 'a repeated path is hashed once')
    assert.equal(hashed.bytes, 5)
    assert.equal(hashed.truncated, false)

    // The cap is declared, never silent: the file it cut short was never read.
    const capped = hashFiles([present, absent], { maxFiles: 1 })
    assert.equal(capped.truncated, true)
    assert.deepEqual(Object.keys(capped.hashes), [present])
    assert.deepEqual(capped.missing, [], 'the file past the cap was not read, so it is not reported as missing')
    assert.equal(hashFiles([], { maxFiles: 0 }).truncated, false)

    const first = fingerprintEnv({
      node: 'v20.11.0',
      platform: 'win32',
      arch: 'x64',
      lockfile: 'lock-abc',
      env: { NODE_ENV: 'test', CI: '1', npm_config_registry: 'https://r' }
    })
    const reordered = fingerprintEnv({
      env: { npm_config_registry: 'https://r', CI: '1', NODE_ENV: 'test' },
      lockfile: 'lock-abc',
      arch: 'x64',
      platform: 'win32',
      node: 'v20.11.0'
    })
    assert.equal(first, reordered, 'the same input always yields the same fingerprint')
    assert.match(first, /^env[0-9a-f]{16}$/)
    assert.match(fingerprintEnv(), /^env[0-9a-f]{16}$/, 'the fingerprint works with no input at all')
    assert.notEqual(
      first,
      fingerprintEnv({ node: 'v20.11.0', platform: 'win32', arch: 'x64', lockfile: 'lock-def', env: { NODE_ENV: 'test', CI: '1', npm_config_registry: 'https://r' } })
    )
    assert.notEqual(
      first,
      fingerprintEnv({ node: 'v20.11.0', platform: 'win32', arch: 'x64', lockfile: 'lock-abc', env: { NODE_ENV: 'test', CI: '1', npm_config_registry: 'https://other' } })
    )

    // PATH and everything else outside the allowlist is not part of the identity.
    assert.equal(
      fingerprintEnv({ node: 'v20.11.0', platform: 'win32', arch: 'x64', env: { NODE_ENV: 'test', PATH: 'C:\\one' } }),
      fingerprintEnv({ node: 'v20.11.0', platform: 'win32', arch: 'x64', env: { NODE_ENV: 'test', PATH: 'C:\\two' } })
    )
    // A bare bag of allowlisted variables and the named-input shape agree.
    assert.equal(fingerprintEnv({ NODE_ENV: 'production' }), fingerprintEnv({ env: { NODE_ENV: 'production' } }))
  })
})
