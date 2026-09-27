'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

test('W1 verifies five deterministic engineering outputs', () => {
  const root = process.env.HNS_CANDIDATE_ROOT
  assert.equal(typeof root, 'string')
  for (let index = 1; index <= 5; index += 1) {
    assert.equal(fs.readFileSync(path.join(root, 'artifacts', `w1-${index}.txt`), 'utf8'), `w1-output-${index}\n`)
  }
})
