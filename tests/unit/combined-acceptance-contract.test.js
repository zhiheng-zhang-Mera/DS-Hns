'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const source = fs.readFileSync(path.resolve(__dirname, '..', '..', 'scripts', 'combined-acceptance.cjs'), 'utf8')

test('Phase C batches the same verification workload on the optimized path and reports process starts', () => {
  assert.match(source, /batchVerification/)
  assert.match(source, /verificationBatch/)
  assert.match(source, /processStarts/)
  assert.match(source, /optimized\.processStarts < baseline\.processStarts/)
})

test('Phase C keeps the original threshold and reports timing decomposition', () => {
  assert.match(source, /improvement >= 1\.2/)
  assert.match(source, /modelLatencyBudgetMs/)
  assert.match(source, /nonModelWallMs/)
})
