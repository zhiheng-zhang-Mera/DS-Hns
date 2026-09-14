'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { createProtectionLayer, MODULE_STATE, withTimeout } = require('../../app/extensions/mega/protection/index.cjs')

/**
 * The MEGA Protection Layer (`updateplan/startup2.md` §12-§18).
 *
 * The behaviour: an enhancement module that fails is a degraded module and nothing else. The plan names
 * the failures that must be impossible — a plugin failure blanking the application, a wallpaper failure
 * taking the input box, a market failure stopping the Harness — and all three are prevented by the same
 * property, which is what these tests measure: `start()` answers, it never throws, and every failure
 * lands in a state the MEGA panel can show with its fallback already running.
 */

/** A layer whose retries are immediate, so the ladder is tested without waiting for it. */
function layer() {
  return createProtectionLayer({ log: () => {}, setTimeout: (fn) => fn(), retryDelayMs: 5 })
}

test('a module that starts and is healthy is HEALTHY, with its time recorded', async () => {
  const created = layer()
  created.register({ id: 'simple-wallpaper', version: '1.0.0', start: async () => 'painted', healthCheck: () => true })
  assert.equal((await created.start('simple-wallpaper')).ok, true)
  const described = created.describe().modules[0]
  assert.equal(described.state, MODULE_STATE.HEALTHY)
  assert.equal(described.version, '1.0.0')
  assert.equal(typeof described.startMs, 'number')
  assert.equal(described.lastError, null)
  assert.deepEqual(created.describe().healthy, ['simple-wallpaper'])
})

test('a timeout degrades the module and starts its fallback instead of throwing', async () => {
  const created = layer()
  let fallbackRan = false
  created.register({
    id: 'dsh-wallpaper-engine',
    timeoutMs: 20,
    start: () => new Promise(() => {}),
    fallback: [{ id: 'simple-wallpaper', run: () => { fallbackRan = true; return 'painted' } }]
  })
  const result = await created.start('dsh-wallpaper-engine')
  assert.equal(result.ok, false)
  assert.match(result.reason, /did not answer within 20ms/)
  assert.equal(fallbackRan, true, 'the fallback never ran')
  const described = created.describe()
  assert.equal(described.modules[0].state, MODULE_STATE.DEGRADED, 'a timeout was reported as anything but degraded')
  assert.equal(described.modules[0].fallback, 'simple-wallpaper')
  assert.deepEqual(described.degraded, ['dsh-wallpaper-engine'])
  assert.equal(described.failed.length, 0, 'an optional module was reported as a product failure')
})

test('the retry ladder is one quick retry, one delayed retry, and then it stops', async () => {
  const created = layer()
  let attempts = 0
  created.register({
    id: 'market',
    timeoutMs: 50,
    start: () => { attempts += 1; throw new Error(`attempt ${attempts} failed`) },
    fallback: [{ id: 'unavailable', run: () => 'hidden' }]
  })
  const result = await created.start('market')
  assert.equal(attempts, 3, `the ladder ran ${attempts} attempts; the plan allows three`)
  assert.equal(result.ok, false)
  assert.equal(result.retries, 2)
  const described = created.describe().modules[0]
  assert.equal(described.state, MODULE_STATE.DEGRADED)
  assert.equal(described.retries, 2)
  // The *last* error, because that is the one an operator needs: the earlier attempts are in the log.
  assert.match(described.lastError, /attempt 3 failed/)
  assert.equal(described.fallback, 'unavailable')
})

test('a module that comes up unhealthy is degraded, and health is re-readable later', async () => {
  const created = layer()
  let healthy = false
  let fellBack = false
  created.register({
    id: 'appearance',
    start: () => 'up',
    healthCheck: () => (healthy ? true : { healthy: false, reason: 'no surface found' }),
    fallback: [{ id: 'official', run: () => { fellBack = true; return 'default' } }]
  })
  // Answering is not the same as being well: a module that reports itself unhealthy is degraded, its
  // fallback takes over, and the product keeps working on the official background.
  assert.equal((await created.start('appearance')).ok, false)
  assert.equal(fellBack, true)
  assert.equal(created.describe().modules[0].state, MODULE_STATE.DEGRADED)
  healthy = true
  assert.equal((await created.check('appearance')).ok, true)
  // Recovery is visible, or the panel keeps reporting a state the module has already left.
  const recovered = created.describe().modules[0]
  assert.equal(recovered.state, MODULE_STATE.HEALTHY)
  assert.equal(recovered.lastError, null)
  assert.equal(recovered.fallback, 'idle')
})

test('a required module fails louder than an optional one, and stopping is safe', async () => {
  const created = layer()
  created.register({ id: 'harness-bridge', optional: false, timeoutMs: 30, start: () => { throw new Error('no harness') } })
  await created.start('harness-bridge')
  assert.equal(created.describe().modules[0].state, MODULE_STATE.FAILED)
  assert.deepEqual(created.describe().failed, ['harness-bridge'])
  assert.deepEqual(await created.stop(), ['harness-bridge'])
  assert.equal(created.describe().modules[0].state, MODULE_STATE.DISABLED)
  assert.equal((await created.start('nothing-registered')).reason, 'unknown_module')
})

test('the layer logs in the vocabulary the plan greps for (§57)', async () => {
  const lines = []
  const created = createProtectionLayer({ log: (line) => lines.push(line), setTimeout: (fn) => fn(), retryDelayMs: 1 })
  assert.ok(lines.includes('[MEGA] protection-ready'), 'the layer does not announce that it is up')
  created.register({ id: 'wallpaper-layer', optional: true, start: () => 'ok' })
  await created.start('wallpaper-layer')
  assert.ok(lines.some((line) => /^\[MEGA\] module healthy: wallpaper-layer$/.test(line)), lines.join('\n'))
  created.register({ id: 'market', optional: true, timeoutMs: 20, start: () => { throw new Error('the clone failed') }, fallback: [{ id: 'store-hidden', run: () => 'hidden' }] })
  await created.start('market')
  assert.ok(lines.some((line) => /^\[MEGA\] module degraded: market — the clone failed$/.test(line)), lines.join('\n'))
  assert.ok(lines.some((line) => /^\[MEGA\] fallback: market → store-hidden \(the clone failed\)$/.test(line)), lines.join('\n'))
})

test('withTimeout answers instead of hanging, in both directions', async () => {
  assert.deepEqual(await withTimeout(Promise.resolve('done'), 50), { ok: true, value: 'done', timedOut: false })
  const rejected = await withTimeout(Promise.reject(new Error('nope')), 50)
  assert.equal(rejected.ok, false)
  assert.equal(rejected.timedOut, false)
  assert.match(rejected.reason, /nope/)
  assert.equal((await withTimeout(new Promise(() => {}), 20)).timedOut, true)
})
