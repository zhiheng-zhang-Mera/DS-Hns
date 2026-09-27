'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const outcomes = Object.freeze({
  success: 'accepted',
  timeout: 'bounded_timeout',
  disconnect: 'retryable_disconnect',
  'malformed-response': 'blocked_invalid_response',
  'delayed-response': 'stale_response_ignored'
})

test('W3 adapter mode has a predeclared bounded outcome', () => {
  const mode = process.env.HNS_ADAPTER_MODE
  assert.equal(Object.hasOwn(outcomes, mode), true)
  assert.equal(outcomes[mode].length <= 40, true)
})
