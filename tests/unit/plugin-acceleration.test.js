'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createReasoningGovernor, TASK_KINDS } = require('../../app/plugins/acceleration/reasoning-governor/index.cjs')
const { createDirtyContext, LAYERS } = require('../../app/plugins/acceleration/dirty-context/index.cjs')
const { planBatch, executeBatch, classifyOperation } = require('../../app/plugins/acceleration/tool-batcher/index.cjs')
const {
  TIERS,
  requiredTier,
  decideTier,
  canApproveCompletion,
  createValidationTracker
} = require('../../app/plugins/acceleration/incremental-validation/index.cjs')
const { createRepoMap, parseFile } = require('../../app/plugins/acceleration/repo-map/index.cjs')

/**
 * The acceleration set (Update-Plan/accleration.md phases 5-13).
 *
 * Each of these makes the runtime faster, and each therefore has a way to be
 * *wrong* that is worse than being slow: a governor that never comes back down, a
 * context that silently drops the error it was built for, a batch that folds a write
 * into a read, a validation tier that approves completion, a map that is confident
 * about a stale repository. The tests are about those failure modes.
 */
const ROOT = path.resolve(__dirname, '..', '..')

test('the reasoning governor matches the level to the work', () => {
  const governor = createReasoningGovernor({ defaultLevel: 'low', ceiling: 'medium' })
  // Search, read, rename and format need no reasoning at all.
  for (const action of ['search', 'read', 'rename', 'format']) {
    assert.equal(governor.decide({ action }).level, 'none', action)
  }
  // A small patch, a lint and a type error get low.
  assert.equal(governor.decide({ action: 'patch', files: ['a.cjs'] }).level, 'low')
  assert.equal(governor.decide({ operation: 'lint' }).level, 'low')
  assert.equal(governor.decide({ operation: 'typecheck' }).level, 'low')
  // A test run needs no reasoning: it is mechanical.
  assert.equal(governor.decide({ operation: 'test' }).level, 'none')
  // A cross-module change escalates to medium.
  assert.equal(governor.decide({ action: 'patch', files: ['a', 'b', 'c', 'd'] }).level, 'medium')
  assert.equal(governor.decide({ action: 'patch', files: ['a'], crossModule: true }).level, 'medium')
  assert.equal(governor.decide({ action: 'patch', files: ['a'], unknown: true }).level, 'medium')
  // Architecture and a repeated failure ask for high, which the ceiling reduces.
  const architecture = governor.decide({ action: 'architecture-refactor' })
  assert.equal(architecture.base, 'high')
  assert.equal(architecture.level, 'medium', 'the ceiling narrows the request')
  assert.equal(architecture.clamped, true)
  assert.match(architecture.reason, /caps the level|ceiling/i)
})

test('the reasoning governor comes back down after the problem is solved', () => {
  const governor = createReasoningGovernor({ defaultLevel: 'low', ceiling: 'high', deescalateAfter: 2 })
  // Two consecutive failures escalate the next decision.
  governor.observe({ ok: false })
  governor.observe({ ok: false })
  const escalated = governor.decide({ action: 'patch', files: ['a.cjs'] })
  assert.equal(escalated.kind, TASK_KINDS.REPEATED_FAILURE)
  assert.equal(escalated.level, 'high')
  assert.equal(governor.escalated, true)
  // One clean step is not enough: the level holds.
  governor.observe({ ok: true })
  assert.equal(governor.level, 'high')
  assert.equal(governor.escalated, true)
  // The second clean step drops it back to the default — the plan's rule that one
  // hard task must not leave the whole session at maximum reasoning.
  const downgrade = governor.observe({ ok: true })
  assert.equal(downgrade.kind, 'deescalation')
  assert.equal(governor.level, 'low')
  assert.equal(governor.escalated, false)
  // And nothing about it survives into another task.
  governor.decide({ action: 'architecture-refactor' })
  assert.equal(governor.reset().level, 'low')
  assert.equal(governor.consecutiveFailures, 0)
})

test('dirty context is stable-first, bounded, and declares what it dropped', () => {
  const context = createDirtyContext({ budget: { stable: 50, task: 40, symbols: 60, diff: 100, failure: 40, total: 250 } })
  const built = context.build({
    stable: 'RULES: never force push. '.repeat(10),
    task: { goal: 'fix the failing test', kind: 'patch' },
    symbols: [{ name: 'add', kind: 'function', file: 'src/math.cjs', line: 3 }],
    diff: '--- a\n+++ b\n-old\n+new\n',
    failure: { class: 'unit-test', message: 'expected 5', output: 'AssertionError: expected 1 to be 5' }
  })
  // The cacheable prefix is the stable layer and contains nothing dynamic.
  assert.match(built.cacheablePrefix, /RULES:/)
  assert.equal(built.cacheablePrefix.includes('expected 5'), false, 'the prefix must not carry the failure')
  assert.match(built.cacheKey, /^ctx[0-9a-z]+$/)
  // Stable comes first, so a changed diff does not invalidate the prefix.
  assert.equal(built.layers[0].name, LAYERS.STABLE)
  assert.deepEqual(built.layers.map((layer) => layer.name), [LAYERS.STABLE, LAYERS.TASK, LAYERS.SYMBOLS, LAYERS.DIFF, LAYERS.FAILURE])
  // An over-long layer is cut and *declared*, not silently dropped.
  assert.ok(built.dropped.length >= 1, JSON.stringify(built.dropped))
  assert.ok(built.layers.some((layer) => layer.truncated === true))
  assert.ok(built.text.length <= 250, `the total budget must hold (${built.text.length})`)
  // A change to a dynamic layer does not invalidate the cacheable prefix.
  assert.equal(context.invalidates([LAYERS.DIFF]).cacheablePrefix, false)
  assert.equal(context.invalidates([LAYERS.STABLE]).cacheablePrefix, true)
  assert.ok(context.summary().calls >= 1)
})

test('tool batching folds reads and refuses writes', async () => {
  assert.equal(classifyOperation('read'), 'read')
  assert.equal(classifyOperation('patch'), 'write')
  assert.equal(classifyOperation('nonsense'), 'unknown')
  const planned = planBatch({
    calls: [
      { operation: 'search', detail: 'add' },
      { operation: 'read', detail: 'src/math.cjs' },
      { operation: 'diff', detail: 'HEAD' },
      { operation: 'patch', detail: 'src/math.cjs' },
      { operation: 'nonsense', detail: 'x' }
    ]
  })
  // The three reads are one batch; the write and the unknown are refused with the
  // reason, never folded in.
  assert.equal(planned.batches.length, 1)
  assert.equal(planned.batched, 3)
  assert.equal(planned.refused.length, 2)
  assert.match(planned.refused[0].reason, /is a write and writes are not batched/)
  assert.match(planned.refused[1].reason, /not a known batched operation/)
  // A batch stops at its first failure, so a partial batch is visible.
  const executed = await executeBatch({
    calls: [{ operation: 'read', detail: 'a' }, { operation: 'read', detail: 'b' }],
    execute: async (call) => {
      if (call.detail === 'b') throw new Error('b is gone')
      return { ok: true }
    }
  })
  assert.equal(executed.ok, false)
  assert.equal(executed.executed[0].results.length, 2)
  // Every recorded result restates the call it belongs to, so a partial batch is
  // attributable without indexing back into the request.
  assert.equal(executed.executed[0].results[0].detail, 'a')
  assert.equal(executed.executed[0].results[0].ok, true)
  assert.equal(executed.executed[0].stopped.detail, 'b')
  assert.equal(executed.executed[0].stopped.operation, 'read')
  // A batch that would exceed its call ceiling is split, not silently truncated.
  const many = planBatch({ calls: Array.from({ length: 25 }, (_, index) => ({ operation: 'read', detail: `f${index}` })), limits: { maxCalls: 10 } })
  assert.equal(many.batches.length, 3)
  assert.equal(many.batched, 25, 'every call is still accounted for')
})

test('incremental validation derives the tier and only the full tier approves', () => {
  // A one-file change earns tier 1; four files earn tier 2; a manifest earns tier 3.
  assert.equal(requiredTier({ files: ['src/a.cjs'] }).tier, TIERS.TIER1)
  assert.equal(requiredTier({ files: ['a', 'b', 'c', 'd'] }).tier, TIERS.TIER2)
  assert.equal(requiredTier({ files: ['package.json'] }).tier, TIERS.TIER3)
  assert.equal(requiredTier({ files: ['tsconfig.json'] }).tier, TIERS.TIER3)
  // The stricter of "what the change warrants" and "what the moment allows" wins.
  const decided = decideTier({ files: ['package.json'], moment: 'after-patch', policy: { afterPatch: TIERS.TIER1 } })
  assert.equal(decided.tier, TIERS.TIER3, 'a manifest change cannot be a tier-1 validation')
  assert.equal(decided.escalated, true)
  const patch = decideTier({ files: ['src/a.cjs'], moment: 'after-patch', policy: { afterPatch: TIERS.TIER1, afterTask: TIERS.TIER2 } })
  assert.equal(patch.tier, TIERS.TIER1)
  // Only the full tier may approve completion, whatever the profile says.
  assert.equal(canApproveCompletion(TIERS.TIER1), false)
  assert.equal(canApproveCompletion(TIERS.TIER2), false)
  assert.equal(canApproveCompletion(TIERS.TIER3), true)

  // The tracker refuses an approval whose evidence predates the last change.
  let clock = 1000
  const tracker = createValidationTracker({ now: () => clock })
  tracker.completed(TIERS.TIER3, { ok: true, command: 'npm test' })
  assert.equal(tracker.approval().ok, true)
  clock += 10
  tracker.changed({ files: ['src/a.cjs'] })
  assert.equal(tracker.approval().ok, false, 'a change invalidates the evidence that came before it')
  assert.match(tracker.approval().reason, /ran before the last change/)
  clock += 10
  tracker.completed(TIERS.TIER3, { ok: false, command: 'npm test' })
  assert.equal(tracker.approval().ok, false)
  assert.match(tracker.approval().reason, /did not pass/)
})

test('the repo map answers the five questions and invalidates honestly', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshns-map-'))
  try {
    fs.mkdirSync(path.join(dir, 'src'))
    fs.mkdirSync(path.join(dir, 'tests'))
    fs.writeFileSync(path.join(dir, 'src', 'token.cjs'), 'function mint() { return 1 }\nmodule.exports = { mint }\n', 'utf8')
    fs.writeFileSync(path.join(dir, 'src', 'index.cjs'), "const { mint } = require('./token.cjs')\nmodule.exports = { mint }\n", 'utf8')
    fs.writeFileSync(path.join(dir, 'tests', 'token.test.cjs'), "const { mint } = require('../src/token.cjs')\ntest('mint', () => {})\n", 'utf8')
    fs.writeFileSync(path.join(dir, 'tests', 'index.test.cjs'), "require('../src/index.cjs')\ntest('index', () => {})\n", 'utf8')
    fs.writeFileSync(path.join(dir, 'package.json'), '{}\n', 'utf8')

    const map = createRepoMap({ root: dir })
    const snapshot = map.build()
    assert.ok(snapshot.files >= 4, JSON.stringify(snapshot))
    assert.equal(snapshot.tests, 2, 'both test files are recognised')
    // findSymbol: the definition, and the barrel that re-exports it. A file that only
    // re-exports the name is reported with its own kind, never as a definition.
    assert.deepEqual(map.findSymbol('mint').map((entry) => entry.file).sort(), ['src/index.cjs', 'src/token.cjs'])
    assert.deepEqual(
      map.findSymbol('mint').map((entry) => `${entry.file}:${entry.kind}`).sort(),
      ['src/index.cjs:export', 'src/token.cjs:function']
    )
    assert.equal(map.findSymbol('mint').find((entry) => entry.file === 'src/token.cjs').line, 1)
    // getDependencies, through the destructured `const { mint } = require(…)` form.
    assert.deepEqual(map.getDependencies('src/index.cjs'), ['src/token.cjs'])
    // getDependents, including the bare side-effect `require(…)` form.
    assert.deepEqual(map.getDependents('src/token.cjs').sort(), ['src/index.cjs', 'tests/token.test.cjs'])
    assert.deepEqual(map.getDependents('src/index.cjs'), ['tests/index.test.cjs'])
    // getRelevantTests: the direct test and the transitive one through index.cjs
    const relevant = map.getRelevantTests('src/token.cjs')
    assert.ok(relevant.includes('tests/token.test.cjs'), JSON.stringify(relevant))
    assert.ok(relevant.includes('tests/index.test.cjs'), `the transitive test must be found (${JSON.stringify(relevant)})`)
    // findReferences
    assert.ok(map.findReferences('mint').length >= 3)
    // The scan is cached until it is invalidated.
    const second = map.build()
    assert.equal(second.scans, 1, 'a second build reuses the map')
    // A changed file drops its own entry; a manifest change drops everything.
    const partial = map.invalidate({ files: ['src/token.cjs'] })
    assert.deepEqual(partial, { full: false, removed: 1 })
    const full = map.invalidate({ files: ['package.json'] })
    assert.equal(full.full, true)
    assert.equal(map.size, 0, 'a manifest change invalidates the whole map')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the repo map scans this repository and stays bounded', () => {
  const map = createRepoMap({ root: path.join(ROOT, 'app', 'core') })
  const snapshot = map.build()
  assert.ok(snapshot.files > 0)
  assert.ok(map.status().files <= map.limits.maxFiles)
  // A symbol in the plugin manager is findable, and a module that imports it is a
  // dependent.
  assert.ok(map.findSymbol('createPluginManager').length >= 1)
  const parsed = parseFile("const a = require('./b.cjs')\nfunction f() {}\nmodule.exports = { f }\n", 'javascript')
  assert.deepEqual(parsed.imports, ['./b.cjs'])
  // Symbols come back in source order, with the line they were found on.
  assert.deepEqual(parsed.symbols.map((symbol) => symbol.name), ['a', 'f'])
  assert.deepEqual(parsed.symbols.map((symbol) => symbol.line), [1, 2])
  assert.deepEqual(parsed.exports, ['f'])
  // Both require forms the repository actually uses are dependency edges.
  const forms = parseFile("const { mint } = require('./token.cjs')\nrequire('./side-effect.cjs')\n", 'javascript')
  assert.deepEqual(forms.imports, ['./token.cjs', './side-effect.cjs'])
})
