'use strict'

/**
 * DS-Hns autonomy: decision ledger (Owner-Result.md Rev.2 §38, §42).
 *
 * Every automatic decision (question interception, stall recovery, bounded
 * retry, provider replacement) is appended before it is acted on, so the
 * operator audits afterwards without pre-approving routine decisions. Durable
 * JSON file, atomic write, id-dedupe, fail-closed restore — a corrupt ledger
 * must never be silently dropped.
 */

const fs = require('node:fs')
const path = require('node:path')

const SOURCES = ['question-interceptor', 'direction-stall', 'continuation-controller', 'episode-supervisor', 'result-validator', 'operator']
const OUTCOMES = ['APPLIED', 'ROLLED_BACK', 'DEFERRED']

function validateEntry(entry) {
  if (!entry || typeof entry.id !== 'string' || !entry.id.trim()) throw new Error('decision-ledger: entry requires an id')
  if (typeof entry.episodeId !== 'string' || !entry.episodeId.trim()) throw new Error('decision-ledger: entry requires an episodeId')
  if (typeof entry.createdAt !== 'string' || !Number.isFinite(Date.parse(entry.createdAt))) throw new Error('decision-ledger: entry requires a valid createdAt')
  if (typeof entry.question !== 'string' || !entry.question.trim() || entry.question.length > 2000) throw new Error('decision-ledger: question invalid')
  if (!Array.isArray(entry.candidates) || entry.candidates.length > 10 || entry.candidates.some((item) => typeof item !== 'string')) throw new Error('decision-ledger: candidates invalid')
  if (typeof entry.chosen !== 'string' || !entry.chosen.trim()) throw new Error('decision-ledger: chosen invalid')
  if (!Array.isArray(entry.evidence) || entry.evidence.length > 50 || entry.evidence.some((item) => typeof item !== 'string')) throw new Error('decision-ledger: evidence invalid')
  if (!OUTCOMES.includes(entry.outcome)) throw new Error('decision-ledger: outcome invalid')
  if (!SOURCES.includes(entry.source)) throw new Error('decision-ledger: source invalid')
  if (entry.rollback !== undefined && typeof entry.rollback !== 'string') throw new Error('decision-ledger: rollback invalid')
  return true
}

/** Immutable append with id-dedupe. */
function append(entries, entry) {
  validateEntry(entry)
  if (entries.some((item) => item.id === entry.id)) throw new Error(`decision-ledger: duplicate entry ${entry.id}`)
  return [...entries, entry]
}

function summarize(entries) {
  const bySource = {}
  const byOutcome = {}
  for (const entry of entries) {
    bySource[entry.source] = (bySource[entry.source] || 0) + 1
    byOutcome[entry.outcome] = (byOutcome[entry.outcome] || 0) + 1
  }
  return { total: entries.length, bySource, byOutcome, rollbacks: byOutcome.ROLLED_BACK || 0 }
}

class DecisionLedger {
  constructor(filePath) {
    this.filePath = filePath || null
    this.entries = []
    if (this.filePath) this.restore()
  }

  append(entry) {
    this.entries = append(this.entries, entry)
    if (this.filePath) this.persist()
    return structuredClone(entry)
  }

  list(episodeId) {
    const items = this.entries
      .filter((entry) => !episodeId || entry.episodeId === episodeId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    return items.map((entry) => structuredClone(entry))
  }

  stats(episodeId) {
    return summarize(this.list(episodeId))
  }

  restore() {
    if (!this.filePath || !fs.existsSync(this.filePath)) return
    const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
    if (parsed && parsed.schemaVersion !== 1 || !Array.isArray(parsed.entries)) throw new Error('decision-ledger: invalid store')
    const loaded = []
    for (const entry of parsed.entries) {
      validateEntry(entry)
      if (loaded.some((item) => item.id === entry.id)) throw new Error(`decision-ledger: duplicate stored id ${entry.id}`)
      loaded.push(entry)
    }
    this.entries = loaded
  }

  persist() {
    if (!this.filePath) return
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    const temporary = `${this.filePath}.${process.pid}.tmp`
    fs.writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, entries: this.entries }, null, 2), 'utf8')
    fs.renameSync(temporary, this.filePath)
  }
}

module.exports = { SOURCES, OUTCOMES, validateEntry, append, summarize, DecisionLedger }
