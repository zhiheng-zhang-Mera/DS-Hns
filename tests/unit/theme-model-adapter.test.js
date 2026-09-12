'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')

const { createModelAdapter, DEFAULT_STATE } = require('../../app/extensions/mega/theme/model-adapter')

/**
 * The optional AI designer layer.
 *
 * The deterministic engine must be able to run the whole theme pipeline with no
 * model at all, and a model must never be able to break it: these tests pin both
 * the "off" state and every failure path back to `null` (which the orchestrator
 * reads as "use the deterministic intent").
 */

test('the adapter is disabled unless a worker is provided', async () => {
  const adapter = createModelAdapter()
  assert.equal(adapter.describe().enabled, false)
  assert.equal(adapter.describe().available, false)
  assert.equal(adapter.describe().reason, DEFAULT_STATE.reason)
  assert.equal(await adapter.interpreter({ prompt: 'anything' }), null, 'a disabled adapter answers nothing')
})

test('a configured worker refines the intent and is reported as enabled', async () => {
  const seen = []
  const adapter = createModelAdapter({
    interpret: async (input) => {
      seen.push(input)
      return { palette_label: '赛博科研', density: 'compact' }
    }
  })
  assert.equal(adapter.describe().enabled, true)
  assert.equal(typeof adapter.interpreter, 'function')

  const refined = await adapter.worker({ prompt: '赛博科研工作站', localIntent: { density: 'comfortable' } })
  assert.deepEqual(refined, { palette_label: '赛博科研', density: 'compact' })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].prompt, '赛博科研工作站')
  assert.equal(adapter.describe().calls, 1)
  assert.equal(adapter.describe().failures, 0)
})

test('a failing worker falls back to the deterministic path instead of throwing', async () => {
  const logged = []
  const adapter = createModelAdapter({
    interpret: async () => { throw new Error('model endpoint unreachable') },
    log: (message) => logged.push(message)
  })
  assert.equal(await adapter.worker({ prompt: 'x' }), null, 'the caller must see "no model answer", not an exception')
  assert.equal(adapter.describe().failures, 1)
  assert.ok(logged.some((line) => /model designer unavailable/.test(line)), JSON.stringify(logged))
})

test('a worker that returns junk is treated as unavailable', async () => {
  for (const value of [null, undefined, 'a string', 42]) {
    const adapter = createModelAdapter({ interpret: async () => value })
    assert.equal(await adapter.worker({ prompt: 'x' }), null, `returned ${String(value)}`)
    assert.equal(adapter.describe().failures, 1)
  }
})

test('the adapter can be turned off and on again without losing the worker', async () => {
  const adapter = createModelAdapter({ interpret: async () => ({ density: 'compact' }) })
  assert.equal(adapter.enable(false), false)
  assert.equal(adapter.describe().enabled, false)
  assert.equal(adapter.describe().reason, 'disabled by configuration')
  assert.equal(await adapter.interpreter({ prompt: 'x' }), null, 'a disabled adapter stays quiet')
  assert.equal(adapter.enable(true), true)
  assert.equal(adapter.describe().enabled, true)
  assert.deepEqual(await adapter.interpreter({ prompt: 'x' }), { density: 'compact' })
})

test('enabling an adapter with no worker keeps it unavailable', () => {
  const adapter = createModelAdapter({ interpret: null })
  assert.equal(adapter.enable(true), false)
  assert.equal(adapter.describe().enabled, false)
  assert.equal(adapter.describe().available, false)
})
