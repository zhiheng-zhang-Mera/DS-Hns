'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  createHighPerformance,
  createBuildCache,
  createWorkerScaler,
  buildFimRequest,
  speculativeDecoding,
  applySpeculative,
  HIGH_PERFORMANCE_FEATURES,
  DEFAULT_POLICY
} = require('../../app/plugins/acceleration/high-performance/index.cjs')
const { createModelDescriptor } = require('../../app/core/contracts/model.cjs')

/**
 * The high-performance module (the plan's P2 list).
 *
 * Every one of these four options is an optimisation over something that already works,
 * which means the interesting behaviour is always the refusal: a speculative request the
 * provider cannot serve, a cache key over an incomplete input set, a scaler that would
 * open more workers than the machine allows, a FIM prompt whose context was cut. Each
 * test is about that boundary rather than about the fast path.
 */

function fakeResources(workers, reason = 'pretend cores') {
  return {
    effectiveWorkers: (input = {}) => ({
      workers: Math.min(workers, Number.isInteger(input.maxWorkers) ? input.maxWorkers : workers),
      bound: 'cores',
      reason,
      pressure: workers > 0 ? 'normal' : 'ceiling'
    })
  }
}

test('speculative decoding happens only when the model descriptor declares it', () => {
  const plain = createModelDescriptor({ provider: 'p', model: 'plain', capabilities: { toolCalling: true } })
  const capable = createModelDescriptor({ provider: 'p', model: 'fast', capabilities: { toolCalling: true, speculativeDecoding: true } })
  const refused = speculativeDecoding(plain)
  assert.equal(refused.supported, false)
  assert.match(refused.reason, /does not declare speculative decoding/)
  assert.equal(speculativeDecoding(null).supported, false)
  assert.match(speculativeDecoding(null).reason, /no model descriptor/)

  const supported = speculativeDecoding(capable)
  assert.equal(supported.supported, true)
  assert.equal(supported.model, 'fast')

  // The hint is added when supported and refused — not silently dropped — when it is not.
  const added = applySpeculative({ messages: [] }, capable)
  assert.deepEqual(added.speculative, { draftModel: null, maxDraftTokens: 8 })
  assert.equal(added.refusedReason, null)
  const withheld = applySpeculative({ messages: [] }, plain)
  assert.equal(withheld.speculative, null)
  assert.match(withheld.refusedReason, /does not declare/)
  // The descriptor is the only thing consulted: no model name appears anywhere.
  assert.equal(/deepseek|flash|coder/i.test(String(speculativeDecoding(capable).reason)), false)
})

test('the build cache is content-addressed and refuses an incomplete input set', () => {
  const cache = createBuildCache({ policy: { cacheMaxBytes: 4096, cacheMaxEntries: 4 } })
  assert.equal(cache.lookup({ command: 'npm run build', hashes: {} }).hit, false)
  assert.match(cache.lookup({ command: 'npm run build', hashes: {} }).reason, /no input hashes/)
  // A file that could not be hashed makes any cached artifact potentially stale.
  const incomplete = cache.lookup({ command: 'build', hashes: { 'src/a.cjs': 'aa', 'src/b.cjs': null } })
  assert.equal(incomplete.hit, false)
  assert.match(incomplete.reason, /hash of src\/b.cjs is missing/)
  // A truncated walk cannot identify a build either.
  assert.match(cache.lookup({ command: 'build', hashes: { 'src/a.cjs': 'aa' }, truncated: true }).reason, /truncated/)

  const inputs = { command: 'npm run build', toolchain: 'node24', hashes: { 'src/a.cjs': 'aa', 'src/b.cjs': 'bb' } }
  assert.equal(cache.lookup(inputs).hit, false, 'nothing is cached yet')
  const stored = cache.record({ ...inputs, ok: true, artifact: { out: 'dist' }, bytes: 128 })
  assert.equal(stored.stored, true)
  const hit = cache.lookup(inputs)
  assert.equal(hit.hit, true)
  assert.deepEqual(hit.artifact, { out: 'dist' })

  // A changed source hash is a different build, and the old entry is not returned.
  const changed = cache.lookup({ ...inputs, hashes: { 'src/a.cjs': 'zz', 'src/b.cjs': 'bb' } })
  assert.equal(changed.hit, false)
  assert.notEqual(changed.key, hit.key)

  // A failed build is never an artifact.
  const failed = cache.record({ ...inputs, ok: false, artifact: null })
  assert.equal(failed.stored, false)
  assert.match(failed.reason, /a failed build is not cached/)
  assert.equal(cache.stats().refused, 1)
})

test('the build cache is bounded and reports what it evicted', () => {
  const cache = createBuildCache({ policy: { cacheMaxBytes: 300, cacheMaxEntries: 2 } })
  for (let index = 0; index < 4; index += 1) {
    cache.record({ command: 'build', hashes: { [`src/${index}.cjs`]: `h${index}` }, ok: true, artifact: index, bytes: 100 })
  }
  const stats = cache.stats()
  assert.ok(stats.entries <= 2, `the entry budget was exceeded (${stats.entries})`)
  assert.ok(stats.bytes <= 300, `the byte budget was exceeded (${stats.bytes})`)
  assert.ok(stats.evictions >= 2, 'evictions must be reported, not silent')
  assert.equal(stats.hitRate, null, 'a cache with no lookups has no hit rate, not a zero one')
  // The newest entry survived and the oldest did not.
  assert.equal(cache.lookup({ command: 'build', hashes: { 'src/3.cjs': 'h3' } }).hit, true)
  assert.equal(cache.lookup({ command: 'build', hashes: { 'src/0.cjs': 'h0' } }).hit, false)
})

test('the scaler never exceeds what the resource manager allows', () => {
  const scaler = createWorkerScaler({ resources: fakeResources(3), policy: { minWorkers: 2, maxWorkers: 8, scaleUpSamples: 2 } })
  assert.equal(scaler.workers, 2)
  // The machine allows 3, so a fourth worker must never appear however deep the queue.
  let decision = null
  for (let index = 0; index < 10; index += 1) decision = scaler.observe({ queueDepth: 50, inFlight: 3, pressure: 'normal' })
  assert.equal(decision.workers, 3, JSON.stringify(decision))
  assert.equal(decision.ceiling.bound, 'cores')
  assert.match(decision.ceiling.reason, /pretend cores/)
})

test('the scaler needs agreeing samples, so it cannot oscillate', () => {
  const scaler = createWorkerScaler({ resources: fakeResources(4), policy: { minWorkers: 2, maxWorkers: 4, scaleUpSamples: 3, scaleDownSamples: 2 } })
  // One busy sample is not a reason to change anything.
  const first = scaler.observe({ queueDepth: 4, inFlight: 2, pressure: 'normal' })
  assert.equal(first.changed, false)
  assert.match(first.reason, /holding: 1\/3 samples/)
  assert.equal(first.workers, 2)
  scaler.observe({ queueDepth: 4, inFlight: 2, pressure: 'normal' })
  const third = scaler.observe({ queueDepth: 4, inFlight: 2, pressure: 'normal' })
  assert.equal(third.changed, true)
  assert.equal(third.workers, 3)
  // Then a quiet sample: pressure drops the count, and the direction streak was reset.
  scaler.observe({ queueDepth: 0, inFlight: 1, pressure: 'normal' })
  const settled = scaler.observe({ queueDepth: 0, inFlight: 0, pressure: 'normal' })
  assert.equal(settled.workers, 2)
  assert.equal(settled.direction, 'down')
})

test('a machine that allows no workers sheds every worker and says why', () => {
  const scaler = createWorkerScaler({ resources: fakeResources(0, 'RAM is exhausted'), policy: { minWorkers: 2, maxWorkers: 4, scaleDownSamples: 1 } })
  const decision = scaler.observe({ queueDepth: 3, inFlight: 2, pressure: 'ceiling' })
  assert.equal(decision.workers, 0, JSON.stringify(decision))
  assert.match(decision.reason, /allows no workers/)
  assert.match(decision.reason, /RAM is exhausted/)
})

test('a FIM request spends its context budget deliberately and declares what it dropped', () => {
  const text = Array.from({ length: 200 }, (_, index) => `const line${index} = ${index}`).join('\n')
  const request = buildFimRequest({ file: 'src/big.cjs', text, anchor: 'line100', symbols: [{ name: 'line100', kind: 'value' }] }, { fimBudgetTokens: 40, charactersPerToken: 4 })
  assert.equal(request.ok, true)
  assert.equal(request.strategy, 'fim')
  assert.ok(request.prefixLines > 0 && request.suffixLines > 0)
  assert.ok(request.prefixTokens + request.suffixTokens <= 40 + 12, `the budget was exceeded (${request.prefixTokens + request.suffixTokens})`)
  assert.ok(request.dropped.length >= 1, 'lines that did not fit must be declared')
  assert.match(request.dropped.join(' '), /did not fit/)
  assert.equal(request.symbols.length, 1)
  // The prefix ends where the suffix begins: the two halves enclose the anchor line.
  assert.equal(request.suffix.split('\n')[0], 'const line100 = 100')

  assert.equal(buildFimRequest({ text: 'x' }).ok, false)
  assert.match(buildFimRequest({ text: 'x' }).reason, /a file is required/)
  assert.equal(buildFimRequest({ file: 'a.cjs' }).ok, false)
  assert.match(buildFimRequest({ file: 'a.cjs' }).reason, /no text to split/)
})

test('the module reports the four options and what they cost', () => {
  const module = createHighPerformance({ resources: fakeResources(4), policy: { minWorkers: 2, maxWorkers: 4 } })
  assert.deepEqual(Object.values(module.FEATURES).sort(), ['advanced-fim', 'auto-scaling', 'build-cache', 'speculative-decoding'].sort())
  module.speculative(createModelDescriptor({ provider: 'p', model: 'm', capabilities: {} }))
  module.fim({ file: 'a.cjs', text: 'let a = 1\nlet b = 2\nlet c = 3\n' })
  module.scale({ queueDepth: 0, inFlight: 0, pressure: 'normal' })
  module.buildCache.record({ command: 'build', hashes: { 'a.cjs': 'aa' }, ok: true, artifact: {}, bytes: 10 })
  const summary = module.summary()
  assert.equal(summary.counters.speculativeRefused, 1)
  assert.equal(summary.counters.speculative, 0)
  assert.equal(summary.counters.fim, 1)
  assert.equal(summary.scaling.decisions, 1)
  assert.equal(summary.cache.entries, 1)
  assert.ok(summary.cache.bytes > 0)
  assert.equal(DEFAULT_POLICY.minWorkers >= 1, true)
  assert.equal(DEFAULT_POLICY.scaleUpSamples > DEFAULT_POLICY.scaleDownSamples || DEFAULT_POLICY.scaleUpSamples > 1, true)
})

test('a switched-off option is a refusal with a reason, never a silent no-op', () => {
  const off = createHighPerformance({ policy: { features: { speculativeDecoding: false, buildCache: false, autoScaling: false, advancedFim: false } } })
  const capable = createModelDescriptor({ provider: 'p', model: 'fast', capabilities: { speculativeDecoding: true } })
  const speculative = off.speculative(capable)
  assert.equal(speculative.supported, false)
  assert.equal(speculative.refused, true)
  assert.match(speculative.reason, /switched off/)
  // Supported by the model, but switched off here: still a refusal, and the request is
  // left untouched rather than carrying a hint nobody will serve.
  assert.equal(off.applySpeculative({ messages: [] }, capable).speculative, null)
  assert.match(off.applySpeculative({ messages: [] }, capable).refusedReason, /switched off/)
  assert.match(off.buildCache.lookup({ command: 'build', hashes: { a: 'h' } }).reason, /switched off/)
  const stored = off.buildCache.record({ command: 'build', hashes: { a: 'h' }, ok: true, artifact: {} })
  assert.equal(stored.stored, false)
  assert.equal(stored.refused, true)
  assert.match(off.fim({ file: 'a.cjs', text: 'one\ntwo\n' }).reason, /switched off/)
  const scaled = off.scale({ queueDepth: 9, inFlight: 2, pressure: 'normal' })
  assert.equal(scaled.changed, false)
  assert.match(scaled.reason, /switched off/)
  // And the off state is reported, so the UI does not show four options as if they ran.
  assert.deepEqual(off.summary().features, { speculativeDecoding: false, buildCache: false, autoScaling: false, advancedFim: false })
  assert.equal(off.summary().counters.speculative, 0)
  assert.ok(off.summary().counters.speculativeRefused >= 2)
  assert.equal(off.summary().counters.scalingRefused, 1)
})

test('the four options are also usable on their own, without the module around them', () => {
  const cache = createBuildCache()
  assert.equal(cache.key({ command: 'x', hashes: { a: 'h' } }).ok, true)
  assert.equal(cache.key({ command: 'x', hashes: { a: 'h' } }).key, cache.key({ command: 'x', hashes: { a: 'h' } }).key, 'the key is stable')
  const scaler = createWorkerScaler()
  assert.equal(scaler.ceiling().bound, 'policy', 'with no resource manager the policy ceiling applies')
  assert.equal(buildFimRequest({ file: 'a.cjs', text: 'one\ntwo\nthree\n' }).strategy, 'fim')
  assert.equal(HIGH_PERFORMANCE_FEATURES.BUILD_CACHE, 'build-cache')
})
