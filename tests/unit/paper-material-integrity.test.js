'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { readCatalog, validateCatalog } = require('../../scripts/validate-paper-material.cjs')
const ROOT = path.resolve(__dirname, '../..')

test('published paper claim IDs, source paths and historical experiment evidence agree', () => {
  assert.deepEqual(validateCatalog(ROOT, readCatalog(ROOT)), [])
})

test('paper validation rejects swapped claim identities even when IDs remain unique', () => {
  const catalog = readCatalog(ROOT)
  const first = catalog.claims[0].id
  catalog.claims[0].id = catalog.claims[1].id
  catalog.claims[1].id = first
  assert.ok(validateCatalog(ROOT, catalog).some(e => e.includes('CLAIM_TITLE_MISMATCH')))
})

test('paper validation rejects missing source files instead of accepting conceptual paths', () => {
  const catalog = readCatalog(ROOT)
  catalog.claims[0].code = ['app/does-not-exist.cjs']
  assert.ok(validateCatalog(ROOT, catalog).some(e => e.includes('SOURCE_NOT_FOUND')))
})

test('paper validation rejects a stale commit attribution on a historical experiment', () => {
  const catalog = readCatalog(ROOT)
  const experiment = catalog.experiments.find(e => e.evidence)
  experiment.commit = '0000000000000000000000000000000000000000'
  assert.ok(validateCatalog(ROOT, catalog).some(e => e.includes('EXPERIMENT_SHA_MISMATCH')))
})

test('paper validation rejects PASS when the bound child report failed', () => {
  const catalog = readCatalog(ROOT)
  const experiment = catalog.experiments.find(e => e.id === 'E-UI')
  experiment.status = 'PASS_HISTORICAL_CHILD_ONLY'
  assert.ok(validateCatalog(ROOT, catalog).some(e => e.includes('EXPERIMENT_VERDICT_MISMATCH')))
})

test('paper validation rejects an altered bound metric and unknown experiment reference', () => {
  const catalog = readCatalog(ROOT)
  catalog.experiments.find(e => e.id === 'E-INSTALL').aggregate = { checks: 999, failures: 0 }
  catalog.claims[0].experiments.push('E-NONEXISTENT')
  const errors = validateCatalog(ROOT, catalog)
  assert.ok(errors.some(e => e.includes('EXPERIMENT_COUNT_MISMATCH')))
  assert.ok(errors.some(e => e.includes('UNKNOWN_EXPERIMENT')))
})
