'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { decideTask } = require('../../app/scheduler/gate')

const NOW = Date.UTC(2026, 8, 7, 2, 0, 0) // Beijing 10:00 Monday (peak)

test('off-peak-only task suspends during Beijing peak and is ready off-peak', () => {
  assert.equal(decideTask({ status: 'PENDING', allowPeak: false, peak: true, now: NOW }), 'suspend-peak')
  assert.equal(decideTask({ status: 'SUSPENDED', allowPeak: false, peak: false, now: NOW }), 'ready')
})

test('allowPeak task may start immediately even at peak', () => {
  assert.equal(decideTask({ status: 'PENDING', allowPeak: true, peak: true, now: NOW }), 'ready')
})

test('scheduled future start keeps a task suspended until its time', () => {
  const future = NOW + 60 * 60 * 1000
  assert.equal(decideTask({ status: 'PENDING', allowPeak: true, peak: false, now: NOW, startAtMs: future }), 'suspend-schedule')
  assert.equal(decideTask({ status: 'SUSPENDED', allowPeak: true, peak: false, now: future, startAtMs: future }), 'ready')
})

test('running and terminal states pass through', () => {
  assert.equal(decideTask({ status: 'RUNNING', allowPeak: false, peak: true, now: NOW }), 'running')
  assert.equal(decideTask({ status: 'COMPLETED', allowPeak: false, peak: true, now: NOW }), 'terminal')
})
