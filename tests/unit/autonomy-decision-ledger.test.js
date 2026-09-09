'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { append, summarize, validateEntry, DecisionLedger } = require('../../app/extensions/mega/autonomy/decision-ledger')

function entry(overrides = {}) {
  return {
    id: 'dec-1',
    episodeId: 'ep-1',
    createdAt: '2026-09-09T06:00:00.000Z',
    question: '是否继续执行？',
    candidates: ['继续', '暂停'],
    chosen: '继续（auto）',
    evidence: ['policy owner-result:continue:v1'],
    outcome: 'APPLIED',
    source: 'question-interceptor',
    ...overrides
  }
}

test('pure model validates, appends immutably and dedupes ids', () => {
  assert.equal(validateEntry(entry()), true)
  assert.throws(() => validateEntry(entry({ id: '' })))
  assert.throws(() => validateEntry(entry({ createdAt: 'nope' })))
  const base = [entry()]
  const next = append(base, entry({ id: 'dec-2', episodeId: 'ep-2' }))
  assert.equal(base.length, 1)
  assert.equal(next.length, 2)
  assert.throws(() => append(base, entry()))
})

test('summarize counts sources, outcomes and rollbacks', () => {
  const stats = summarize([
    entry(),
    entry({ id: 'dec-2', episodeId: 'ep-2', outcome: 'ROLLED_BACK', rollback: 'reverted' }),
    entry({ id: 'dec-3', episodeId: 'ep-2', source: 'continuation-controller' })
  ])
  assert.equal(stats.total, 3)
  assert.equal(stats.rollbacks, 1)
  assert.equal(stats.bySource['question-interceptor'], 2)
  assert.equal(stats.bySource['continuation-controller'], 1)
})

test('durable ledger persists across reopen and fails closed on corruption', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ledger-'))
  try {
    const file = path.join(dir, 'decision-ledger.json')
    const ledger = new DecisionLedger(file)
    ledger.append(entry())
    ledger.append(entry({ id: 'dec-2', episodeId: 'ep-2', createdAt: '2026-09-09T07:00:00.000Z' }))
    const reopened = new DecisionLedger(file)
    const list = reopened.list()
    assert.equal(list.length, 2)
    assert.equal(list[0].id, 'dec-2') // newest first
    assert.equal(reopened.stats('ep-2').total, 1)

    fs.writeFileSync(file, '{"schemaVersion":1,"entries":[{"id":"x"}]}', 'utf8')
    assert.throws(() => new DecisionLedger(file))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
