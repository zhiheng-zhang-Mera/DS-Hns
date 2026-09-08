'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { decideTask } = require('../../app/extensions/mega/scheduler/gate')
const NOW = Date.UTC(2026, 8, 7, 2, 0, 0)

test('off-peak-only task suspends during peak', () => {
  assert.equal(decideTask({ status: 'PENDING', allowPeak: false, peak: true, now: NOW }), 'suspend-peak')
})

test('allowPeak task may start immediately', () => {
  assert.equal(decideTask({ status: 'PENDING', allowPeak: true, peak: true, now: NOW }), 'ready')
})
