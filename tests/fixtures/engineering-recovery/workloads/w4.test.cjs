'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')

test('W4 local post-relaunch proof file is present and exact', () => {
  const proofFile = process.env.HNS_REBOOT_PROOF_FILE
  assert.equal(typeof proofFile, 'string')
  assert.equal(fs.readFileSync(proofFile, 'utf8'), 'post-relaunch-proof-v1\n')
})
