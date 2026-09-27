'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const expected = new Map([
  ['one.txt', 'verified-mutation-one\n'],
  ['two.txt', 'verified-mutation-two\n'],
  ['three.txt', 'verified-mutation-three\n']
])

test('W0 verifies all three deterministic post-mutation file hashes', () => {
  const root = process.env.HNS_CANDIDATE_ROOT
  assert.equal(typeof root, 'string')
  for (const [name, content] of expected) {
    const bytes = fs.readFileSync(path.join(root, 'artifacts', name))
    assert.equal(bytes.toString('utf8'), content)
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), crypto.createHash('sha256').update(content).digest('hex'))
  }
})
