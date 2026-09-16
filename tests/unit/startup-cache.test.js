'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createStartupCache, CACHE_KEYS } = require('../../app/extensions/mega/startup-cache.cjs')

/**
 * The startup cache (`updateplan/startup2.md` §52-§54).
 *
 * The behaviour that matters is not "it stores a value" but the three properties that make a cache safe:
 * an unreadable cache is an empty cache, a write never breaks a start, and a hint that is too old stops being
 * a hint. Plus one rule from the plan's §54: the market's *catalogue* is not ours to cache.
 */

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshns-startup-cache-'))
  return { dir, dispose: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

test('what the owners last said is remembered and read back', () => {
  const { dir, dispose } = scratch()
  try {
    let clock = 1_000_000
    const cache = createStartupCache({ root: dir, now: () => clock, log: () => {} })
    assert.equal(cache.describe().warm, false, 'an empty cache was reported as a warm start')
    const written = cache.record({
      workspace: 'D:/work/one',
      wallpaper: { main: 'C:/pics/a.png', dock: null },
      appearance: { preset: 'reading' },
      bundled: { 'dsh-wallpaper-engine': 'untested' },
      health: { degraded: 0 }
    })
    assert.equal(written.ok, true)
    assert.deepEqual(written.refused, [])
    clock += 5_000
    const second = createStartupCache({ root: dir, now: () => clock })
    const described = second.describe()
    assert.equal(described.warm, true)
    assert.equal(described.ageMs, 5_000)
    assert.equal(described.entries.workspace, 'D:/work/one')
    assert.deepEqual(described.entries.wallpaper, { main: 'C:/pics/a.png', dock: null })
    assert.equal(described.entries.appearance.preset, 'reading')
  } finally {
    dispose()
  }
})

test('a key this cache does not own is refused rather than stored', () => {
  const { dir, dispose } = scratch()
  try {
    const cache = createStartupCache({ root: dir, log: () => {} })
    const written = cache.record({ workspace: 'D:/w', somethingElse: { a: 1 } })
    assert.deepEqual(written.refused, ['somethingElse'])
    assert.equal(cache.describe().entries.somethingElse, undefined)
    assert.equal(CACHE_KEYS.includes('somethingElse'), false)
    // §54: the market's catalogue is the market's; only its presence, version and health are ours.
    assert.deepEqual(CACHE_KEYS, ['workspace', 'session', 'bundled', 'wallpaper', 'appearance', 'health', 'boot'])
  } finally {
    dispose()
  }
})

test('a cache that cannot be read is an empty cache, and never a crash', () => {
  const { dir, dispose } = scratch()
  try {
    const file = path.join(dir, 'startup-cache.json')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(file, '{"version":1,"at":1,"entries":{"workspace":', 'utf8')
    const broken = createStartupCache({ root: dir, file, log: () => {} })
    assert.deepEqual(broken.describe().entries, {})
    assert.equal(broken.warm(), false)
    // A file that parses but is not our shape is ignored for the same reason.
    fs.writeFileSync(file, JSON.stringify({ hello: 'world' }), 'utf8')
    assert.deepEqual(createStartupCache({ root: dir, file, log: () => {} }).describe().entries, {})
    // And it can be used, and rewritten, from that state.
    const recovered = createStartupCache({ root: dir, file, log: () => {} })
    assert.equal(recovered.record({ workspace: 'D:/w' }).ok, true)
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).entries.workspace, 'D:/w')
  } finally {
    dispose()
  }
})

test('an old hint stops being a hint, and forgetting is explicit', () => {
  const { dir, dispose } = scratch()
  try {
    let clock = 1_000_000
    const cache = createStartupCache({ root: dir, maxAgeMs: 1_000, now: () => clock, log: () => {} })
    cache.record({ workspace: 'D:/w' })
    assert.equal(cache.warm(), true)
    clock += 10_000
    assert.equal(cache.warm(), false, 'a stale cache was still reported as a warm start')
    assert.equal(cache.age(), 10_000)
    // The entry is still readable — it is a hint that is old, not a hint that is wrong — and `clear` removes it.
    assert.equal(cache.describe().entries.workspace, 'D:/w')
    assert.equal(cache.clear('workspace').ok, true)
    assert.equal(cache.describe().entries.workspace, undefined)
    assert.equal(cache.clear('not-a-key').ok, false)
    assert.equal(cache.clear().cleared, 'all')
    assert.equal(cache.describe().entries.workspace, undefined)
  } finally {
    dispose()
  }
})

test('a write that cannot happen is a log line, not a failed start', () => {
  const { dir, dispose } = scratch()
  try {
    // A directory where the file should be: the write cannot succeed, and nothing may be thrown.
    const file = path.join(dir, 'startup-cache.json')
    fs.mkdirSync(file, { recursive: true })
    const lines = []
    const cache = createStartupCache({ root: dir, file, log: (line) => lines.push(line) })
    const written = cache.record({ workspace: 'D:/w' })
    assert.equal(written.ok, false)
    assert.ok(lines.some((line) => /could not be written/.test(line)))
  } finally {
    dispose()
  }
})
