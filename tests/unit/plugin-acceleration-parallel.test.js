'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  createParallelExecutor,
  createModelQueue,
  planGraph,
  planWaves,
  writeConflict,
  validateNode,
  PARALLEL_MODES,
  MODE_POLICY,
  RISKS
} = require('../../app/plugins/acceleration/parallel-executor/index.cjs')
const {
  createWorkspaceIsolation,
  ISOLATION_KINDS
} = require('../../app/plugins/acceleration/workspace-isolation/index.cjs')

/**
 * Single-task parallel execution and workspace isolation
 * (Update-Plan/accleration.md phases 10, sections 19-24).
 *
 * The plan is explicit that the goal is not several agents editing files at once but
 * one task's dependency graph running where the graph allows it. Everything dangerous
 * therefore lives in the boundaries, and so do these tests: a write folded into a
 * reader wave, two writers of one file in one tree, a worktree that is believed to
 * exist because git exited zero, an isolation refusal that gets treated as success, a
 * model instance per worker, and a run that keeps scheduling after a failure.
 */

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** A resource manager stand-in: the executor only needs the derived worker count. */
function fakeResources(workers, reason = 'pretend cores') {
  return {
    effectiveWorkers: (input = {}) => ({
      workers: Math.min(workers, Number.isInteger(input.maxWorkers) ? input.maxWorkers : workers),
      bound: 'cores',
      reason,
      pressure: workers > 0 ? 'normal' : 'ceiling',
      requested: input.maxWorkers
    })
  }
}

/** An isolation stand-in that records what the executor asked for. */
function fakeIsolation(options = {}) {
  const events = { created: [], reclaimed: [] }
  let nextId = 1
  return {
    events,
    available: async () => (options.available === false
      ? { ok: false, kind: 'shared', reason: options.reason || 'no worktree support' }
      : { ok: true, kind: 'worktree', reason: null }),
    create: async (input = {}) => {
      const id = `iso-${nextId}`
      nextId += 1
      events.created.push({ id, label: input.label })
      return { ok: true, id, kind: 'worktree', path: `/isolated/${id}`, branch: null, detached: true }
    },
    reclaim: async (id) => {
      events.reclaimed.push(id)
      return { ok: true, id }
    }
  }
}

/** A git runner that behaves, without touching a real repository. */
function fakeGit(root, options = {}) {
  const calls = []
  const worktrees = new Set(options.worktrees || [])
  const removed = []
  const run = async (args, callOptions = {}) => {
    const verb = args.join(' ')
    calls.push({ verb, cwd: callOptions.cwd || null })
    if (typeof options.onCall === 'function') {
      const custom = options.onCall({ args, verb, cwd: callOptions.cwd || null, worktrees })
      if (custom) return custom
    }
    if (verb === 'rev-parse --show-toplevel') return { ok: true, stdout: callOptions.cwd || root, stderr: '' }
    if (verb === 'rev-parse --verify HEAD') return options.noHead === true ? { ok: false, reason: 'no HEAD' } : { ok: true, stdout: 'abc123', stderr: '' }
    if (verb === 'worktree list --porcelain') return { ok: true, stdout: [...worktrees].map((entry) => `worktree ${entry}`).join('\n'), stderr: '' }
    if (args[0] === 'worktree' && args[1] === 'add') {
      const target = args.find((entry) => path.isAbsolute(entry))
      worktrees.add(target)
      return { ok: true, stdout: '', stderr: '' }
    }
    if (args[0] === 'worktree' && args[1] === 'remove') {
      const target = args[args.length - 1]
      if (options.removeFails === true) return { ok: false, reason: 'the worktree is locked' }
      worktrees.delete(target)
      removed.push(target)
      return { ok: true, stdout: '', stderr: '' }
    }
    if (verb === 'worktree prune') return { ok: true, stdout: '', stderr: '' }
    return { ok: true, stdout: '', stderr: '' }
  }
  return { run, calls, worktrees, removed }
}

// ---------------------------------------------------------------------------
// Workspace isolation.
// ---------------------------------------------------------------------------

test('isolation refuses honestly when it cannot be provided, so the caller runs serially', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshns-iso-'))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshns-iso-dir-'))
  try {
    const git = fakeGit(root, { noHead: true })
    const isolation = createWorkspaceIsolation({ root, git: git.run, policy: { dir } })
    const verdict = await isolation.available()
    assert.equal(verdict.ok, false)
    assert.equal(verdict.kind, ISOLATION_KINDS.SHARED)
    assert.match(verdict.reason, /no commit/)
    const created = await isolation.create({ label: 'writer' })
    assert.equal(created.ok, false)
    assert.equal(created.kind, ISOLATION_KINDS.SHARED, 'a refusal must never look like an isolated tree')
    assert.match(created.reason, /no commit/)
    assert.equal(isolation.status().refused, 1)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a worktree is created outside the working tree, verified, and reclaimed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshns-iso-'))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshns-iso-dir-'))
  try {
    const git = fakeGit(root)
    const isolation = createWorkspaceIsolation({ root, git: git.run, policy: { dir } })
    const created = await isolation.create({ label: 'patch-a' })
    assert.equal(created.ok, true)
    assert.equal(created.kind, ISOLATION_KINDS.WORKTREE)
    assert.equal(created.detached, true, 'the runtime must not create branches in the user repository')
    assert.equal(created.path.startsWith(root), false, 'a worktree inside the working tree pollutes git status')
    assert.equal(path.relative(dir, created.path).startsWith('..'), false)
    // The tree was probed, not assumed, before it was handed over.
    assert.ok(git.calls.some((call) => call.verb === 'rev-parse --show-toplevel' && call.cwd === created.path))
    assert.equal(isolation.size, 1)
    const reclaimed = await isolation.reclaim(created.id)
    assert.equal(reclaimed.ok, true)
    assert.equal(isolation.size, 0)
    assert.equal(isolation.status().reclaimed, 1)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a worktree that git creates but cannot use is refused and cleaned up', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshns-iso-'))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshns-iso-dir-'))
  try {
    const git = fakeGit(root, {
      // `worktree add` succeeds, then the probe inside the new tree fails.
      onCall: ({ verb, cwd }) => (verb === 'rev-parse --show-toplevel' && cwd ? { ok: false, reason: 'not a git repository' } : null)
    })
    const isolation = createWorkspaceIsolation({ root, git: git.run, policy: { dir } })
    const created = await isolation.create({ label: 'broken' })
    assert.equal(created.ok, false)
    assert.match(created.reason, /is not usable/)
    assert.equal(isolation.size, 0, 'a half-made tree must not be handed out')
    assert.ok(git.calls.some((call) => call.verb.startsWith('worktree remove')), 'the half-made tree is cleaned up')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a failed reclaim stays visible instead of being forgotten', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshns-iso-'))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshns-iso-dir-'))
  try {
    const git = fakeGit(root, { removeFails: true })
    const isolation = createWorkspaceIsolation({ root, git: git.run, policy: { dir } })
    const created = await isolation.create({ label: 'stuck' })
    const outcome = await isolation.reclaim(created.id)
    assert.equal(outcome.ok, false)
    assert.match(outcome.reason, /worktree remove failed/)
    const status = isolation.status()
    assert.equal(status.live, 1, 'the record is kept while the tree still exists')
    assert.equal(status.failed, 1)
    assert.equal(status.leaked.length, 1)
    assert.match(status.leaked[0].reason, /locked/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('sweep adopts the worktrees a crashed run left behind, and only its own', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshns-iso-'))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshns-iso-dir-'))
  try {
    const mine = path.join(dir, 'iso-99')
    const foreign = path.join(os.tmpdir(), 'somebody-elses-worktree')
    const git = fakeGit(root, { worktrees: [mine, foreign] })
    const isolation = createWorkspaceIsolation({ root, git: git.run, policy: { dir } })
    const swept = await isolation.sweep()
    assert.deepEqual(swept.removed, [mine], 'the leftovers under our own directory are reclaimed')
    assert.deepEqual(swept.kept, [], 'a foreign worktree is never touched')
    assert.equal(git.worktrees.has(foreign), true)
    assert.equal(git.worktrees.has(mine), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('isolation capacity is bounded and dispose reclaims everything', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshns-iso-'))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshns-iso-dir-'))
  try {
    const git = fakeGit(root)
    const isolation = createWorkspaceIsolation({ root, git: git.run, policy: { dir, maxWorktrees: 2 } })
    await isolation.create({ label: 'a' })
    await isolation.create({ label: 'b' })
    const refused = await isolation.create({ label: 'c' })
    assert.equal(refused.ok, false)
    assert.match(refused.reason, /no isolation capacity/)
    const disposed = await isolation.dispose()
    assert.equal(disposed.ok, true)
    assert.equal(disposed.reclaimed.length, 2)
    assert.equal(isolation.size, 0)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// The graph, the write rules, and the modes.
// ---------------------------------------------------------------------------

test('a malformed task node is refused rather than defaulted into safety', () => {
  assert.equal(validateNode(null).ok, false)
  assert.equal(validateNode({}).ok, false)
  assert.match(validateNode({}).reason, /must have an id/)
  assert.equal(validateNode({ id: 'a', writeSet: 'src/a.cjs' }).ok, false)
  assert.match(validateNode({ id: 'a', writeSet: 'src/a.cjs' }).reason, /non-array writeSet/)
  assert.match(validateNode({ id: 'a', risk: 'catastrophic' }).reason, /unknown risk/)
  assert.match(validateNode({ id: 'a', cpuCost: -1 }).reason, /non-numeric cpuCost/)
  // A node whose write set was meant to be populated but came back empty must not be
  // silently treated as a pure reader: that is what the validation is for.
  const normalized = validateNode({ id: 'a', writeSet: ['src\\a.cjs', './src/b.cjs'], readSet: ['src/a.cjs'] }).node
  assert.deepEqual(normalized.writeSet, ['src/a.cjs', 'src/b.cjs'], 'paths are normalized across separators')
  assert.deepEqual(normalized.readSet, ['src/a.cjs'])
})

test('the write rules are the plan\'s rule, plus the hazard it implies', () => {
  const a = validateNode({ id: 'a', writeSet: ['src/a.cjs'] }).node
  const b = validateNode({ id: 'b', writeSet: ['src/a.cjs'] }).node
  const c = validateNode({ id: 'c', writeSet: ['src/c.cjs'] }).node
  const reader = validateNode({ id: 'r', readSet: ['src/a.cjs'] }).node
  assert.equal(writeConflict(a, b).conflict, true)
  assert.equal(writeConflict(a, b).kind, 'write-write', 'two writers of one file may not share a wave')
  assert.deepEqual(writeConflict(a, b).files, ['src/a.cjs'])
  assert.equal(writeConflict(a, c).conflict, false)
  // A reader beside a writer of the same file is the same hazard one step removed.
  assert.equal(writeConflict(a, reader).conflict, true)
  assert.equal(writeConflict(a, reader).kind, 'read-write')
  assert.equal(writeConflict(reader, reader).conflict, false)
  // Two spellings of one Windows path are one file.
  const windows = validateNode({ id: 'w', writeSet: ['src\\a.cjs'] }).node
  assert.equal(writeConflict(a, windows).conflict, true)
})

test('a broken dependency graph is refused with the offending ids', () => {
  const cycle = planGraph({
    nodes: [
      { id: 'a', dependencies: ['b'] },
      { id: 'b', dependencies: ['a'] }
    ]
  })
  assert.equal(cycle.ok, false)
  assert.match(cycle.reason, /cycle/)
  assert.deepEqual(cycle.cycle.sort(), ['a', 'b'])
  assert.match(planGraph({ nodes: [{ id: 'a', dependencies: ['ghost'] }] }).reason, /unknown task "ghost"/)
  assert.match(planGraph({ nodes: [{ id: 'a' }, { id: 'a' }] }).reason, /duplicate task id/)
  assert.match(planGraph({ nodes: [{ id: 'a', dependencies: ['a'] }] }).reason, /depends on itself/)
  const layered = planGraph({
    nodes: [
      { id: 'patch', dependencies: ['inspect-core', 'find-tests'] },
      { id: 'inspect-core' },
      { id: 'find-tests' },
      { id: 'accept', dependencies: ['patch'] }
    ]
  })
  assert.equal(layered.ok, true)
  assert.deepEqual(layered.waves, [['find-tests', 'inspect-core'], ['patch'], ['accept']])
  assert.deepEqual(layered.order, ['find-tests', 'inspect-core', 'patch', 'accept'])
})

test('each mode plans the parallelism the plan section 19 describes', () => {
  const nodes = [
    { id: 'r1', readSet: ['src/a.cjs'] },
    { id: 'r2', readSet: ['src/b.cjs'] },
    { id: 'w1', writeSet: ['src/one.cjs'] },
    { id: 'w2', writeSet: ['src/two.cjs'] }
  ]
  // Off: everything alone.
  const off = planWaves({ nodes, mode: PARALLEL_MODES.OFF })
  assert.deepEqual(off.waves[0].lanes.map((lane) => lane.kind), ['serial', 'serial', 'serial', 'serial'])
  assert.equal(off.waves[0].parallel.length, 0)
  // Safe: readers together, writers alone.
  const safe = planWaves({ nodes, mode: PARALLEL_MODES.SAFE })
  assert.deepEqual(safe.waves[0].lanes.map((lane) => lane.kind), ['parallel', 'serial', 'serial'])
  assert.deepEqual(safe.waves[0].lanes[0].ids, ['r1', 'r2'])
  // Adaptive: disjoint writes join the parallel lane.
  const adaptive = planWaves({ nodes, mode: PARALLEL_MODES.ADAPTIVE })
  assert.deepEqual(adaptive.waves[0].lanes.map((lane) => lane.kind), ['parallel'])
  assert.deepEqual(adaptive.waves[0].lanes[0].ids, ['r1', 'r2', 'w1', 'w2'])
  // The same nodes, but with overlapping writes: serialized by default.
  const overlapping = [
    { id: 'w1', writeSet: ['src/executor.cjs'] },
    { id: 'w2', writeSet: ['src/executor.cjs'] }
  ]
  const serialized = planWaves({ nodes: overlapping, mode: PARALLEL_MODES.ADAPTIVE })
  assert.deepEqual(serialized.waves[0].lanes.map((lane) => lane.kind), ['parallel', 'serial'])
  assert.equal(serialized.conflicts.length, 1)
  assert.deepEqual(serialized.conflicts[0].files, ['src/executor.cjs'])
  assert.deepEqual(serialized.waves[0].serial, ['w2'])
  // Without isolation, aggressive mode is the same as adaptive: no shared-tree overlap.
  const noIsolation = planWaves({ nodes: overlapping, mode: PARALLEL_MODES.AGGRESSIVE, isolationAvailable: false })
  assert.deepEqual(noIsolation.waves[0].lanes.map((lane) => lane.kind), ['parallel', 'serial'])
  // With isolation, aggressive mode may run them together — in separate trees.
  const isolated = planWaves({ nodes: overlapping, mode: PARALLEL_MODES.AGGRESSIVE, isolationAvailable: true })
  assert.deepEqual(isolated.waves[0].lanes.map((lane) => lane.kind), ['isolated'])
  assert.deepEqual(isolated.waves[0].isolated, ['w1', 'w2'])
})

// ---------------------------------------------------------------------------
// Execution.
// ---------------------------------------------------------------------------

test('mode off runs strictly one node at a time, and adaptive runs the readers together', async () => {
  const nodes = [
    { id: 'r1', readSet: ['a'], cpuCost: 40 },
    { id: 'r2', readSet: ['b'], cpuCost: 40 },
    { id: 'r3', readSet: ['c'], cpuCost: 40 }
  ]
  const observe = async (node) => {
    observation.active += 1
    observation.peak = Math.max(observation.peak, observation.active)
    observation.atStart[node.id] = observation.active
    try {
      await delay(node.cpuCost)
      return { ok: true }
    } finally {
      observation.active -= 1
    }
  }
  let observation = { active: 0, peak: 0, atStart: {} }
  const off = createParallelExecutor({ mode: PARALLEL_MODES.OFF, resources: fakeResources(4) })
  const offRun = await off.run({ nodes, execute: observe })
  assert.equal(observation.peak, 1, 'off is completely serial')
  assert.equal(offRun.maxParallelism, 1)
  assert.equal(offRun.ok, true)
  assert.equal(offRun.completed.length, 3)

  observation = { active: 0, peak: 0, atStart: {} }
  const adaptive = createParallelExecutor({ mode: PARALLEL_MODES.ADAPTIVE, resources: fakeResources(4) })
  const adaptiveRun = await adaptive.run({ nodes, execute: observe })
  assert.equal(observation.peak, 3, 'independent readers must actually overlap')
  assert.equal(adaptiveRun.maxParallelism, 3)
  // The measurable claim of the whole plan, in miniature: parallel is faster than serial.
  assert.ok(adaptiveRun.speedup > 1.5, `expected a real speedup, got ${adaptiveRun.speedup}`)
  assert.ok(adaptiveRun.wallMs < offRun.wallMs)
})

test('a writer is never put in a wave beside another node that touches its files', async () => {
  const nodes = [
    { id: 'reader', readSet: ['src/executor.cjs'], cpuCost: 40 },
    { id: 'writer', writeSet: ['src/executor.cjs'], cpuCost: 40 }
  ]
  const seen = []
  let active = 0
  const executor = createParallelExecutor({ mode: PARALLEL_MODES.ADAPTIVE, resources: fakeResources(4) })
  const result = await executor.run({
    nodes,
    execute: async (node) => {
      active += 1
      seen.push({ id: node.id, active })
      try {
        await delay(node.cpuCost)
        return { ok: true }
      } finally {
        active -= 1
      }
    }
  })
  assert.equal(result.ok, true)
  assert.equal(seen.every((entry) => entry.active === 1), true, `the write hazard was not serialized: ${JSON.stringify(seen)}`)
  assert.equal(result.maxParallelism, 1)
  assert.equal(result.conflicts.length, 1)
  assert.equal(result.conflicts[0].kind, 'read-write')
})

test('dependencies are respected, and a failure stops the run instead of continuing into the dark', async () => {
  const order = []
  const nodes = [
    { id: 'inspect' },
    { id: 'patch', dependencies: ['inspect'] },
    { id: 'test', dependencies: ['patch'] },
    { id: 'docs', dependencies: ['patch'] }
  ]
  const executor = createParallelExecutor({ mode: PARALLEL_MODES.ADAPTIVE, resources: fakeResources(4) })
  const failed = await executor.run({
    nodes,
    execute: async (node) => {
      order.push(node.id)
      if (node.id === 'patch') throw new Error('the patch did not apply')
      return { ok: true }
    }
  })
  assert.deepEqual(order, ['inspect', 'patch'], 'nothing after the failure is started')
  assert.equal(failed.ok, false)
  assert.equal(failed.stopped, true)
  assert.match(failed.reason, /the patch did not apply/)
  assert.equal(failed.failed.length, 1)
  const skipped = new Map(failed.skipped.map((entry) => [entry.id, entry.reason]))
  assert.match(skipped.get('test'), /dependency failed/)
  assert.match(skipped.get('docs'), /dependency failed/)
  assert.equal(failed.completed.length, 1)

  // A node that reports failure rather than throwing is a failure too.
  const reported = await executor.run({ nodes, execute: async () => ({ ok: false, reason: 'the command exited 1' }) })
  assert.equal(reported.ok, false)
  assert.match(reported.failed[0].reason, /the command exited 1/)
})

test('independent work in an earlier wave still completes before the stop', async () => {
  const nodes = [
    { id: 'a' },
    { id: 'b' },
    { id: 'after', dependencies: ['a'] }
  ]
  const done = []
  const executor = createParallelExecutor({ mode: PARALLEL_MODES.ADAPTIVE, resources: fakeResources(2) })
  const result = await executor.run({
    nodes,
    execute: async (node) => {
      await delay(10)
      done.push(node.id)
      if (node.id === 'a') throw new Error('a failed')
      return { ok: true }
    }
  })
  assert.equal(result.ok, false)
  assert.deepEqual(done.sort(), ['a', 'b'], 'a node already in flight is not abandoned')
  assert.deepEqual(result.skipped.map((entry) => entry.id), ['after'])
})

test('no workers allocated is a refusal with the bound that applied, not a silent serial run', async () => {
  let executed = 0
  const executor = createParallelExecutor({ mode: PARALLEL_MODES.ADAPTIVE, resources: fakeResources(0, 'CPU is at 95%') })
  const result = await executor.run({
    nodes: [{ id: 'a' }, { id: 'b' }],
    execute: async () => {
      executed += 1
      return { ok: true }
    }
  })
  assert.equal(result.ok, false)
  assert.match(result.reason, /allocated no workers/)
  assert.match(result.reason, /CPU is at 95%/)
  assert.equal(executed, 0)
  assert.equal(result.skipped.length, 2)
  assert.match(result.skipped[0].reason, /no workers were allocated/)
})

test('task parallelism funnels through one model queue, never one model instance per worker', async () => {
  const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]
  const executor = createParallelExecutor({ mode: PARALLEL_MODES.ADAPTIVE, resources: fakeResources(4) })
  const result = await executor.run({
    nodes,
    execute: async (node, context) => {
      const answer = await context.model(async () => {
        await delay(15)
        return `answer for ${node.id}`
      })
      return { ok: true, answer }
    }
  })
  assert.equal(result.ok, true)
  assert.equal(result.model.maxInFlight, 1, 'plan section 24: a single model serving runtime')
  assert.ok(result.model.peakQueued >= 2, `the queue should have held requests (${JSON.stringify(result.model)})`)
  assert.equal(result.model.completed, 4)
  assert.equal(result.completed.every((entry) => entry.value.answer.startsWith('answer for')), true)
})

test('the model queue is a real queue', async () => {
  const queue = createModelQueue({ concurrency: 1 })
  const seen = []
  await Promise.all([
    queue.submit(async () => {
      seen.push('first-in')
      await delay(10)
      seen.push('first-out')
    }),
    queue.submit(async () => {
      seen.push('second-in')
    })
  ])
  assert.deepEqual(seen, ['first-in', 'first-out', 'second-in'])
  assert.equal(queue.stats().completed, 2)
  assert.equal(queue.stats().maxInFlight, 1)
})

test('aggressive mode isolates overlapping writers and declares that integration is owed', async () => {
  const nodes = [
    { id: 'w1', writeSet: ['src/executor.cjs'] },
    { id: 'w2', writeSet: ['src/executor.cjs'] }
  ]
  const isolation = fakeIsolation()
  const workspaces = []
  const executor = createParallelExecutor({
    mode: PARALLEL_MODES.AGGRESSIVE,
    resources: fakeResources(2),
    isolation
  })
  const result = await executor.run({
    nodes,
    execute: async (node, context) => {
      workspaces.push({ id: node.id, workspace: context.workspace, isolated: context.isolated })
      await delay(20)
      return { ok: true }
    }
  })
  assert.equal(result.ok, true)
  assert.equal(result.maxParallelism, 2, 'aggressive mode is the one place overlapping writes may overlap')
  assert.equal(workspaces.length, 2)
  assert.equal(workspaces.every((entry) => entry.isolated === true), true)
  assert.notEqual(workspaces[0].workspace, workspaces[1].workspace, 'each writer gets its own tree')
  assert.equal(result.requiresIntegration, true, 'two isolated writers of one file have two answers')
  assert.equal(result.conflicts.length, 1)
  assert.equal(result.isolation.created, 2)
  assert.equal(result.isolation.reclaimed, 2, 'no worktree may leak')
  assert.deepEqual(isolation.events.reclaimed.length, 2)
})

test('aggressive mode without usable isolation degrades to serial writes rather than sharing a tree', async () => {
  const nodes = [
    { id: 'w1', writeSet: ['src/executor.cjs'] },
    { id: 'w2', writeSet: ['src/executor.cjs'] }
  ]
  const isolation = fakeIsolation({ available: false })
  const executor = createParallelExecutor({
    mode: PARALLEL_MODES.AGGRESSIVE,
    resources: fakeResources(2),
    isolation
  })
  let active = 0
  let peak = 0
  const result = await executor.run({
    nodes,
    execute: async (node, context) => {
      assert.equal(context.isolated, false, 'a shared tree must never be presented as isolated')
      active += 1
      peak = Math.max(peak, active)
      await delay(15)
      active -= 1
      return { ok: true }
    }
  })
  assert.equal(result.ok, true)
  assert.equal(peak, 1, 'without isolation the overlapping writes are serialized')
  assert.equal(result.maxParallelism, 1)
  assert.equal(result.requiresIntegration, false)
  assert.equal(isolation.events.created.length, 0)
})

test('an isolation refusal during an isolated wave fails that task loudly and stops the run', async () => {
  const nodes = [
    { id: 'w1', writeSet: ['src/executor.cjs'] },
    { id: 'w2', writeSet: ['src/executor.cjs'] },
    { id: 'after', dependencies: ['w1'] }
  ]
  const isolation = fakeIsolation()
  isolation.create = async () => ({ ok: false, kind: 'shared', reason: 'no isolation capacity: 8 of 8 worktrees are live' })
  const executor = createParallelExecutor({ mode: PARALLEL_MODES.AGGRESSIVE, resources: fakeResources(2), isolation })
  let executed = 0
  const result = await executor.run({
    nodes,
    execute: async () => {
      executed += 1
      return { ok: true }
    }
  })
  assert.equal(result.ok, false)
  // Both writers were already in flight when the first refusal landed, and both are
  // reported — but neither wrote anything, because neither got a tree.
  assert.equal(result.failed.length, 2)
  assert.match(result.failed[0].reason, /isolation is required for overlapping writes and was refused/)
  assert.match(result.failed[0].reason, /no isolation capacity/)
  assert.equal(result.isolation.refused, 2)
  assert.equal(executed, 0, 'a writer with no tree must not run at all')
  // A wave that cannot be isolated is never partially attempted in the shared tree: the
  // run stops, and what it did not start says why. Quietly degrading to a shared-tree
  // write here is the failure this mode exists to prevent.
  assert.equal(result.stopped, true)
  assert.deepEqual(result.skipped.map((entry) => entry.id), ['after'])
  assert.match(result.skipped[0].reason, /dependency failed/)
  assert.equal(isolation.events.created.length, 0)
})

test('the six modes, the worker derivation and the mode table are inspectable for the UI', () => {
  const executor = createParallelExecutor({ mode: PARALLEL_MODES.SAFE, resources: fakeResources(3) })
  const modes = executor.modes()
  assert.deepEqual(modes.map((entry) => entry.name), ['off', 'safe', 'adaptive', 'aggressive'])
  assert.deepEqual(modes.map((entry) => entry.label), ['Off', 'Safe', 'Adaptive', 'Aggressive'])
  assert.equal(modes.find((entry) => entry.name === 'off').readsParallel, false)
  assert.equal(modes.find((entry) => entry.name === 'safe').disjointWritesParallel, false)
  assert.equal(modes.find((entry) => entry.name === 'adaptive').overlappingWrites, 'serial')
  assert.equal(modes.find((entry) => entry.name === 'aggressive').isolationRequired, true)
  assert.equal(executor.mode, PARALLEL_MODES.SAFE)
  assert.equal(executor.setMode(PARALLEL_MODES.OFF).ok, true)
  assert.equal(executor.setMode('turbo').ok, false)
  assert.match(executor.setMode('turbo').reason, /not a parallel mode/)
  // Off is one worker whatever the machine has.
  executor.setMode(PARALLEL_MODES.OFF)
  assert.equal(executor.workersFor().workers, 1)
  executor.setMode(PARALLEL_MODES.ADAPTIVE)
  assert.equal(executor.workersFor().workers, 3)
  assert.equal(executor.workersFor(2).workers, 2, 'the caller cap is honoured')
  assert.equal(MODE_POLICY[PARALLEL_MODES.OFF].purpose.includes('debug'), true)
  assert.equal(RISKS.HIGH, 'high')
})
