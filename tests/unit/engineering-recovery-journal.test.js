'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createMutationLog, MUTATION_RESULTS, hashContent } = require('../../app/engineering/mutation.cjs')

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'eng-recovery-journal-'))
}

test('mutation intent is durably observed before the filesystem effect, then settled after it', () => {
  const root = tempDir()
  const target = path.join(root, 'episode-owned.txt')
  const observations = []
  try {
    const mutations = createMutationLog({
      onChange: (entry, phase) => {
        observations.push({ phase, result: entry.result, exists: fs.existsSync(target), intended: entry.intended })
        return { ok: true }
      }
    })
    const result = mutations.apply({ kind: 'create', path: target, content: 'durable intent first', root, reason: 'test journal' })

    assert.equal(result.result, MUTATION_RESULTS.APPLIED)
    assert.deepEqual(observations.map((entry) => [entry.phase, entry.result, entry.exists]), [
      ['before', MUTATION_RESULTS.PENDING, false],
      ['after', MUTATION_RESULTS.APPLIED, true]
    ])
    assert.equal(typeof observations[0].intended.hash, 'string')
    assert.equal(mutations.all().length, 1, 'one stable mutation id advances through pending and settled state')
    assert.equal(mutations.all()[0].result, MUTATION_RESULTS.APPLIED)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a failed pre-effect checkpoint blocks the write and leaves the target untouched', () => {
  const root = tempDir()
  const target = path.join(root, 'must-not-exist.txt')
  try {
    const mutations = createMutationLog({
      onChange: (_entry, phase) => phase === 'before' ? { ok: false, reason: 'checkpoint storage unavailable' } : { ok: true }
    })
    const result = mutations.apply({ kind: 'create', path: target, content: 'never written', root, reason: 'fail closed' })

    assert.equal(result.result, MUTATION_RESULTS.FAILED)
    assert.match(result.verification.reason, /checkpoint storage unavailable/)
    assert.equal(fs.existsSync(target), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a restored pending mutation is reconciled from disk without applying it again', () => {
  const root = tempDir()
  const target = path.join(root, 'already-written.txt')
  const content = 'the effect landed before the process died'
  fs.writeFileSync(target, content, 'utf8')
  try {
    const mutations = createMutationLog()
    const restored = mutations.restore([{
      id: 'm17',
      at: 1_700_000_000_000,
      kind: 'write',
      path: target,
      relative: path.basename(target),
      before: null,
      after: null,
      result: 'pending',
      intended: { bytes: Buffer.byteLength(content), hash: hashContent(Buffer.from(content)) },
      encoding: 'utf8'
    }])

    assert.equal(restored.ok, true)
    const outcome = mutations.resume(mutations.pending()[0])
    assert.equal(outcome.verdict, 'already_complete')
    assert.equal(fs.readFileSync(target, 'utf8'), content)
    assert.deepEqual(mutations.ownedFiles, [target])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
