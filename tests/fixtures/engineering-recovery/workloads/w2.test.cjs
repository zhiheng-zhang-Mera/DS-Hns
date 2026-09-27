'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')

test('W2 preserves the pre-existing source sentinel byte-for-byte', () => {
  const source = process.env.HNS_SOURCE_SENTINEL
  const expected = process.env.HNS_SOURCE_SENTINEL_SHA256
  assert.equal(typeof source, 'string')
  assert.equal(typeof expected, 'string')
  const crypto = require('node:crypto')
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex'), expected)
})
