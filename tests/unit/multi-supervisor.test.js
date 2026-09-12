'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const { WorkerManager, WorktreeManager } = require('../../app/sub-worker/manager.cjs')
const runtimeProcess = require('../../app/runtime-process.cjs')
const { DispatchScheduler } = require('../../app/sub-worker/scheduler.cjs')
const { TaskGraph, NODE_STATUS } = require('../../app/sub-worker/dag.cjs')
const integrationHelper = require('../../app/sub-worker/integration.cjs')
const profiler = require('../../app/sub-worker/profiler.cjs')

/**
 * Injected hardware facts for every adaptive rig.
 *
 * The pool ceiling is `min(configured hardMax, hardware ceiling)`, so on a small
 * CI runner (2 vCPU / 7 GB) the real ceiling is 1 and every multi-worker
 * scenario here would wait forever for a second worker. These facts describe a
 * machine the scenarios are written for; the ceiling *derivation* itself is
 * covered against real and synthetic facts in `multi-profiler.test.js`, and the
 * adaptive behaviour (grow one step at a time, throttle, SAFE MODE, recover) is
 * what these tests are actually about. Deterministic > host-dependent.
 */
const SYNTHETIC_HARDWARE_FACTS = {
  cpu: { model: 'Injected CPU (multi-supervisor rig)', physicalCores: 8, logicalCores: 16, maxClockMhz: 3600 },
  ram_total_gb: 32,
  storage_class: 'nvme',
  gpus: [],
  gpu_vram_gb: 0
}

/**
 * Adaptive multi-process framework, end to end with real worker processes
 * (Update-Plan/multi-sub.md §16, §18, §25, §34, §42, §46).
 *
 * The acceptance criteria of §46 are exercised here:
 *   安装验收  hardware ceiling → pool ceiling
 *   运行验收  injected pressure lowers concurrency
 *   恢复验收  the pool grows back one step at a time
 *   故障验收  a killed worker is retried, the supervisor survives
 *   并行验收  N workers reduce wall-clock time
 *   冲突验收  two writers of one file are never concurrent
 *   低资源    the pool degrades to a single worker / SAFE MODE
 */

const ROOTS = []
const MANAGERS = new Set()

test.after(() => {
  for (const manager of MANAGERS) {
    try {
      manager.forceStop('test teardown')
    } catch {}
  }
  for (const root of ROOTS) {
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {}
  }
})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate, { timeoutMs = 40_000, intervalMs = 60, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(intervalMs)
  }
  throw new Error(`timed out waiting for ${label}`)
}

/**
 * Drive the supervisor's own loop without waiting for its timer.
 *
 * The timeout is generous because a hosted CI runner spawns each worker process
 * several times slower than a developer machine; the assertion is about the pool
 * *reaching* a size, not about how quickly it does so. A timeout reports the
 * pool and the scheduler decision, so a failure says why growth stopped instead
 * of only that it did.
 */
async function pump(manager, predicate, { timeoutMs = 120_000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    manager.tick({ force: true })
    if (predicate()) return true
    const described = manager.describe()
    last = {
      pool: described.pool,
      state: described.resource_state,
      decision: described.decision,
      ceiling: described.max_workers,
      hardwareMax: described.hardware ? described.hardware.max_recommended_workers : null
    }
    await sleep(120)
  }
  throw new Error(`timed out pumping for ${label}: ${JSON.stringify(last)}`)
}

function git(args, cwd) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
}

function makeRepo(parent, name = 'TargetRepo') {
  const target = path.join(parent, name)
  fs.mkdirSync(target, { recursive: true })
  git(['init', '-q'], target)
  git(['config', 'core.autocrlf', 'false'], target)
  git(['config', 'user.email', 'worker@example.com'], target)
  git(['config', 'user.name', 'multi worker test'], target)
  fs.writeFileSync(path.join(target, 'README.md'), '# target\n')
  fs.writeFileSync(path.join(target, 'app.js'), 'module.exports = 1\n')
  git(['add', '-A'], target)
  git(['commit', '-qm', 'init'], target)
  return target
}

/**
 * A supervisor configured for a small, fast adaptive pool: one worker minimum,
 * three maximum, no hysteresis delay.
 */
async function rig(name, { adaptive = true, resources = {}, start = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `hns-multi-${name}-`))
  fs.mkdirSync(path.join(root, 'config'), { recursive: true })
  ROOTS.push(root)
  const target = makeRepo(root)
  const logs = []
  // Pin the hardware ceiling before the manager reads it, so the rig behaves the
  // same on a developer machine and on a 2-vCPU CI runner.
  profiler.writeHardwareProfile(root, profiler.buildHardwareProfile({ facts: SYNTHETIC_HARDWARE_FACTS }))
  const manager = new WorkerManager({
    root,
    nodeExe: process.execPath,
    runtimeProcess,
    log: (message) => logs.push(String(message)),
    notify: () => {}
  })
  MANAGERS.add(manager)
  manager.updateConfig({
    adaptiveWorkers: adaptive,
    showNotifications: false,
    resources: {
      workers: { min: 1, softMax: 3, hardMax: 3 },
      scaling: { enabled: true, scaleUpDelaySeconds: 1, scaleDownDelaySeconds: 1, idleDownGraceSeconds: 1, scaleUpStep: 1, scaleDownStep: 1 },
      runtime: { heartbeatSeconds: 1, hangDetectionSeconds: 30, sampleIntervalSeconds: 1 },
      resources: { ramReserveMinGb: 2, cpuReservePercent: 10, ramReservePercent: 10 },
      ...resources
    }
  })
  // Feed the scheduler a healthy sample from the start. Growth must not depend on
  // how busy the *host* is: on a hosted runner the real sample reports a loaded
  // machine, the scheduler correctly refuses to scale up, and every multi-worker
  // scenario here would time out. The pressure/recovery test overrides this
  // injection with the states it is actually asserting on.
  manager.setResourceInjection(() => healthySample())
  if (start) await manager.start({ reason: 'test' })
  return { root, target, manager, logs }
}

function planFor(target, nodes, overrides = {}) {
  return {
    plan_id: overrides.plan_id || `plan-${Math.random().toString(36).slice(2, 7)}`,
    objective: overrides.objective || 'multi worker plan',
    target_repo: target,
    workspace_mode: 'isolated_worktree',
    ...overrides,
    nodes
  }
}

function writeNode(nodeId, { dependsOn = [], scope, file, content, role = 'code' }) {
  return {
    node_id: nodeId,
    objective: `write ${file}`,
    role,
    depends_on: dependsOn,
    write_scope: scope || [file],
    task: {
      risk_level: 'L2',
      permissions: { read: true, write: true, shell: false },
      operations: [{ op: 'write_file', path: file, content: content ?? `${nodeId}\n` }]
    }
  }
}

function sleepNode(nodeId, { dependsOn = [], ms = 1500, scope = ['marker.txt'], role = 'code' }) {
  return {
    node_id: nodeId,
    objective: `sleep ${ms} ms`,
    role,
    depends_on: dependsOn,
    write_scope: scope,
    task: {
      risk_level: 'L0',
      permissions: { read: true, shell: true },
      operations: [{ op: 'run_command', command: `node -e "setTimeout(()=>{},${ms})"` }]
    }
  }
}

/** A synthetic runtime sample, so pressure can be driven deterministically. */
function healthySample(overrides = {}) {
  return {
    at: Date.now(),
    cpu: { available: true, usage_percent: 20, logical_cores: 24 },
    memory: { available: true, total_gb: 32, available_gb: 24, used_percent: 25 },
    disk: { available: true, free_gb: 200, free_percent: 60, storage_class: 'nvme', latency: { available: true, write_ms: 1 } },
    gpu: { available: false },
    power: { available: false },
    temperature: { available: false },
    ...overrides
  }
}

// ---------------------------------------------------------------- installation

test('安装验收: the hardware ceiling sizes the pool and a DAG grows it step by step', async (t) => {
  const { manager, target } = await rig('install')
  t.after(() => manager.forceStop('cleanup'))

  const described = manager.describe()
  assert.equal(described.adaptive_workers, true)
  assert.ok(described.hardware, 'the installation profiler must produce a hardware ceiling')
  assert.ok(described.hardware.max_recommended_workers >= 1)
  assert.equal(described.max_workers, 3, 'the configured hard maximum bounds the pool')
  assert.deepEqual(described.pool.roles, { generic: 1 }, 'compatibility start: exactly one worker')

  const plan = planFor(target, [
    sleepNode('a', { ms: 2500, scope: ['a.txt'] }),
    sleepNode('b', { ms: 2500, scope: ['b.txt'] }),
    sleepNode('c', { ms: 2500, scope: ['c.txt'] })
  ])
  const submitted = manager.submitPlan(plan)
  assert.equal(submitted.ok, true, JSON.stringify(submitted.errors || []))
  assert.equal(submitted.node_count, 3)

  // §11: progressive growth, never a jump to the maximum.
  const sizes = [manager.describe().pool.size]
  await pump(manager, () => {
    const size = manager.describe().pool.size
    if (size !== sizes[sizes.length - 1]) sizes.push(size)
    return size >= 3
  }, { label: 'the pool to reach three workers' })
  for (let index = 1; index < sizes.length; index += 1) {
    assert.ok(sizes[index] - sizes[index - 1] <= 1, `the pool must grow one step at a time, saw ${sizes.join(' → ')}`)
  }

  await pump(manager, () => manager.describe().plans[0]?.status === 'completed', { label: 'the plan to complete' })
  const summary = manager.describe().plans[0]
  assert.deepEqual(summary.nodes.map((node) => node.status), ['completed', 'completed', 'completed'])
  // §14: the pool is persistent, not spawn-per-task, and the metrics survive a
  // worker being retired after the work drained.
  assert.ok(manager.describe().pool.size >= 1)
  assert.ok(manager.describe().metrics.tasks >= 3, `expected 3 recorded tasks, got ${manager.describe().metrics.tasks}`)
  assert.ok(manager.describe().metrics.throughput.completed >= 3)
})

// ------------------------------------------------------------------ parallelism

test('并行验收: independent nodes really run at the same time on N workers', async (t) => {
  const { manager, target } = await rig('parallel')
  t.after(() => manager.forceStop('cleanup'))

  const startedAt = Date.now()
  manager.submitPlan(planFor(target, [
    sleepNode('s1', { ms: 5000, scope: ['s1.txt'] }),
    sleepNode('s2', { ms: 5000, scope: ['s2.txt'] })
  ]))
  let maxConcurrent = 0
  await pump(manager, () => {
    maxConcurrent = Math.max(maxConcurrent, manager.describe().pool.busy)
    return manager.describe().plans[0]?.status === 'completed'
  }, { label: 'the parallel plan', timeoutMs: 60_000 })
  const parallelMs = Date.now() - startedAt

  assert.equal(maxConcurrent, 2, 'both nodes must be in flight at once')
  assert.equal(manager.describe().plans[0].status, 'completed')
  // Two 5 s tasks on two workers beat one-after-the-other (≈10 s) even though the
  // pool has to grow first (progressive scaling, §11).
  assert.ok(parallelMs < 8500, `expected a real speed-up, took ${parallelMs} ms`)
  assert.ok(manager.describe().metrics.tasks >= 2)
})

test('DAG 依赖: a node only starts once its dependencies completed', async (t) => {
  const { manager, target } = await rig('dag')
  t.after(() => manager.forceStop('cleanup'))

  manager.submitPlan(planFor(target, [
    writeNode('root', { file: 'src/root.txt' }),
    writeNode('after', { dependsOn: ['root'], file: 'src/after.txt' })
  ]))
  const order = []
  await pump(manager, () => {
    const nodes = manager.describe().plans[0]?.nodes || []
    for (const node of nodes) {
      if (node.status !== 'pending' && order[order.length - 1] !== node.node_id) order.push(node.node_id)
    }
    return manager.describe().plans[0]?.status === 'completed'
  }, { label: 'the dependent plan' })
  assert.equal(order[0], 'root', `the root must start first, saw ${order.join(' → ')}`)
  assert.ok(order.indexOf('after') > 0)
  assert.match(manager.describe().plans[0].critical_path.join(' → '), /root → after/)
})

// -------------------------------------------------------------------- conflicts

test('冲突验收: two nodes writing the same file are never concurrent', async (t) => {
  const { manager, target } = await rig('conflict')
  t.after(() => manager.forceStop('cleanup'))

  // Both nodes declare the same scope, so the scheduler must serialise them.
  manager.submitPlan(planFor(target, [
    { ...writeNode('w1', { file: 'shared.txt', content: 'one\n' }), write_scope: ['shared.txt'] },
    { ...writeNode('w2', { file: 'shared.txt', content: 'two\n' }), write_scope: ['shared.txt'] }
  ]))

  let overlapping = 0
  const running = new Set()
  const observed = []
  await pump(manager, () => {
    const nodes = manager.describe().plans[0]?.nodes || []
    const nowRunning = nodes.filter((node) => node.status === 'running').map((node) => node.node_id)
    for (const node of nowRunning) {
      if (!running.has(node)) running.add(node)
    }
    for (const node of [...running]) {
      if (!nowRunning.includes(node)) running.delete(node)
    }
    if (nowRunning.length > 1) overlapping += 1
    observed.push(nowRunning.length)
    return manager.describe().plans[0]?.status === 'completed'
  }, { label: 'the conflicting plan' })

  assert.equal(overlapping, 0, `two writers of one file overlapped (max concurrent ${Math.max(...observed)})`)
  // Serialised work still completes, and the registry is clean afterwards.
  assert.deepEqual(manager.describe().plans[0].nodes.map((node) => node.status), ['completed', 'completed'])
  assert.deepEqual(manager.describe().file_ownership, [], 'every ownership claim is released')
})

test('冲突验收: the conflict filter refuses an overlapping scope and allows a disjoint one', () => {
  const scheduler = new DispatchScheduler({ config: { speculativeExecution: { enabled: true } } })
  const graph = TaskGraph.from({
    plan_id: 'g',
    target_repo: 'X:\\repo',
    nodes: [
      { node_id: 'a', objective: 'a', write_scope: ['src/**'], task: { risk_level: 'L2', permissions: { read: true } } },
      { node_id: 'b', objective: 'b', write_scope: ['src/core/**'], task: { risk_level: 'L2', permissions: { read: true } } },
      { node_id: 'c', objective: 'c', write_scope: ['tests/**'], task: { risk_level: 'L2', permissions: { read: true } } }
    ]
  }).graph
  graph.markRunning('a', 'sub-1')
  const workers = [
    { worker_id: 'sub-2', role: 'code' },
    { worker_id: 'sub-3', role: 'code' }
  ]
  const selection = scheduler.selectDispatch({ graph, idleWorkers: workers, performanceState: 'BOOST', onlineSlots: 3, gpuSlots: 0 })
  const dispatched = selection.dispatch.map((entry) => entry.node.node_id)
  assert.deepEqual(dispatched, ['c'], 'only the disjoint node may start')
  assert.ok(selection.skipped.some((entry) => entry.node_id === 'b' && /overlaps/.test(entry.reason)))
})

// ------------------------------------------------------------------ test split

test('§22/§23: workers run targeted tests, only the integration node runs the full suite', () => {
  const scheduler = new DispatchScheduler({ config: {} })
  const plan = { acceptance_commands: ['npm test'], acceptance: [] }
  const code = { node_id: 'code', role: 'code', acceptance_tests: ['npm test -- src/x', 'npm test -- src/y', 'npm run lint', 'npm run build'] }
  const integrationNode = { node_id: 'integration', role: 'integration', acceptance_tests: [] }
  const local = scheduler.localAcceptanceFor(code, plan)
  assert.equal(local.scope, 'targeted')
  assert.equal(local.commands.length, 3, 'a code worker never runs the full suite')
  assert.equal(local.commands.includes('npm test'), false)
  const full = scheduler.localAcceptanceFor(integrationNode, plan)
  assert.equal(full.scope, 'full')
  assert.ok(full.commands.includes('npm test'))
})

// ---------------------------------------------------------------------- faults

test('故障验收: killing a worker mid-task retries the node and the supervisor survives', async (t) => {
  const { manager, target } = await rig('fault')
  t.after(() => manager.forceStop('cleanup'))

  manager.submitPlan(planFor(target, [sleepNode('slow', { ms: 20_000, scope: ['slow.txt'] })]))
  await waitFor(() => manager.describe().pool.busy >= 1, { label: 'the task to start' })

  const victim = manager.pool.busy[0]
  assert.ok(victim?.pid, 'a worker must be running the task')
  manager.killTree(victim.pid)

  // The supervisor must survive and retry the interrupted node (§34).
  await pump(manager, () => (manager.describe().plans[0]?.nodes[0]?.attempts || 0) >= 2, { label: 'the node retry' })
  const node = manager.describe().plans[0].nodes[0]
  assert.ok(node.attempts >= 2, `expected a retry, attempts=${node.attempts}`)
  assert.equal(manager.describe().enabled, true, 'the supervisor keeps running')
  assert.equal(manager.describe().available, true)

  // Either the retry finished the node or it is still running: both are recovery.
  assert.ok(['running', 'completed'].includes(node.status), `unexpected node status ${node.status}`)
  // A replacement worker exists and the crashed one is gone.
  await pump(manager, () => manager.describe().pool.running >= 1, { label: 'a replacement worker' })
  assert.equal(manager.describe().pool.workers.some((worker) => worker.worker_id === victim.worker_id && worker.state === 'CRASHED'), false)
})

// ------------------------------------------------------- pressure and recovery

test('运行验收 + 低资源验收: injected pressure lowers concurrency down to SAFE MODE', async (t) => {
  const { manager, target } = await rig('pressure')
  t.after(() => manager.forceStop('cleanup'))

  manager.submitPlan(planFor(target, [
    sleepNode('p1', { ms: 3000, scope: ['p1.txt'] }),
    sleepNode('p2', { ms: 3000, scope: ['p2.txt'] }),
    sleepNode('p3', { ms: 3000, scope: ['p3.txt'] })
  ]))
  await pump(manager, () => manager.describe().pool.size >= 2, { label: 'a wider pool' })

  // High RAM: THROTTLED, no new workers, one step down per decision.
  manager.setResourceInjection(() => ({
    at: Date.now(),
    cpu: { available: true, usage_percent: 40, logical_cores: 24 },
    memory: { available: true, total_gb: 32, available_gb: 3.2, used_percent: 90 },
    disk: { available: true, free_gb: 100, free_percent: 40, storage_class: 'nvme', latency: { available: true, write_ms: 2 } },
    gpu: { available: false },
    power: { available: false },
    temperature: { available: false }
  }))
  manager.tick({ force: true })
  assert.equal(manager.describe().resource_state, 'THROTTLED')
  const throttledDecision = manager.describe().decision
  assert.equal(throttledDecision.state, 'THROTTLED')
  const sizeBefore = manager.describe().pool.size
  await pump(manager, () => manager.describe().pool.size < sizeBefore, { label: 'a throttled scale-down' })
  await pump(manager, () => manager.describe().pool.size === 1, { label: 'the pool to fall back to one worker' })
  assert.equal(manager.describe().pool.size, 1, 'graceful degradation reaches Main + 1 Worker')

  // Extreme RAM: SAFE MODE parks the pool entirely while the supervisor lives.
  manager.setResourceInjection(() => ({
    at: Date.now(),
    cpu: { available: true, usage_percent: 30, logical_cores: 24 },
    memory: { available: true, total_gb: 32, available_gb: 0.4, used_percent: 98 },
    disk: { available: true, free_gb: 100, free_percent: 40, storage_class: 'nvme', latency: { available: true, write_ms: 2 } },
    gpu: { available: false },
    power: { available: false },
    temperature: { available: false }
  }))
  await pump(manager, () => manager.describe().resource_state === 'SAFE_MODE', { label: 'SAFE MODE' })
  await pump(manager, () => manager.describe().pool.size === 0, { label: 'the pool to park' })
  assert.equal(manager.describe().enabled, false, 'no worker process is left running')
  assert.equal(manager.describe().available, true, 'the supervisor is still alive and reports itself')

  // §46 恢复验收: the pool comes back one step at a time, never all at once.
  manager.setResourceInjection(() => healthySample())
  const recoverySizes = [manager.describe().pool.size]
  await pump(manager, () => {
    const size = manager.describe().pool.size
    if (recoverySizes[recoverySizes.length - 1] !== size) recoverySizes.push(size)
    return size >= 1 && manager.describe().resource_state !== 'SAFE_MODE'
  }, { label: 'the pool to recover' })
  for (let index = 1; index < recoverySizes.length; index += 1) {
    assert.ok(recoverySizes[index] - recoverySizes[index - 1] <= 1, `recovery must be gradual, saw ${recoverySizes.join(' → ')}`)
  }
  // The work that SAFE MODE cancelled is still known to the supervisor: the plan
  // is retained and replays rather than disappearing.
  assert.ok(manager.describe().plans.length >= 1)
  assert.ok(['BOOST', 'NORMAL'].includes(manager.describe().resource_state))
})

// ----------------------------------------------------------------- integration

test('§18/§42: per-node worktrees merge into an integration worktree, conflicts are reported', async (t) => {
  const { manager, target } = await rig('integration')
  t.after(() => manager.forceStop('cleanup'))

  const planId = 'merge-plan'
  manager.submitPlan(planFor(target, [
    writeNode('left', { file: 'src/left.txt', content: 'left\n' }),
    writeNode('right', { file: 'src/right.txt', content: 'right\n' })
  ], { plan_id: planId }))

  await pump(manager, () => manager.describe().plans[0]?.status === 'completed', { label: 'the merged plan' })
  const summary = manager.describe().plans[0]
  assert.equal(summary.integration.ok, true, JSON.stringify(summary.integration))
  assert.equal(summary.integration.conflicts, 0)

  const integrationWorktree = integrationHelper.integrationWorktreePath(target, planId)
  assert.equal(fs.existsSync(path.join(integrationWorktree, 'src', 'left.txt')), true, 'the merged tree carries every node change')
  assert.equal(fs.existsSync(path.join(integrationWorktree, 'src', 'right.txt')), true)
  // The Controller's own working tree is never touched (§18).
  assert.equal(git(['status', '--porcelain'], target).stdout.trim(), '')
  assert.equal(fs.existsSync(path.join(target, 'src', 'left.txt')), false)

  // Two nodes claiming the same file produce a reported conflict, not a guess.
  const conflictPlan = planFor(target, [
    writeNode('c1', { file: 'src/same.txt', content: 'one\n' }),
    writeNode('c2', { file: 'src/same.txt', content: 'two\n' })
  ], { plan_id: 'conflict-plan' })
  const result = manager.submitPlan(conflictPlan)
  assert.equal(result.ok, true)
  await pump(manager, () => manager.describe().plans.some((plan) => plan.plan_id === 'conflict-plan' && plan.status !== 'active' && plan.status !== 'pending' && plan.status !== 'running'), { label: 'the conflicting plan to finish' })
  const conflicting = manager.describe().plans.find((plan) => plan.plan_id === 'conflict-plan')
  assert.equal(conflicting.integration.ok, false)
  assert.ok(conflicting.integration.conflicts >= 1, 'a same-file edit by two nodes must be reported as a conflict')
  assert.ok(manager.describe().metrics.merge_conflict_rate > 0)
})

test('§25: a speculative node is duplicated while healthy and deduplicated on success', async (t) => {
  const { manager, target } = await rig('speculative')
  t.after(() => manager.forceStop('cleanup'))

  manager.submitPlan(planFor(target, [
    {
      ...sleepNode('uncertain', { ms: 2500, scope: ['spec.txt'] }),
      speculative: true,
      max_attempts: 2
    }
  ]))
  await pump(manager, () => manager.describe().pool.size >= 2, { label: 'a second worker for the duplicate' })
  await waitFor(() => manager.describe().scheduler.speculative_dispatches >= 1 || manager.describe().pool.busy >= 2, { label: 'the speculative duplicate', timeoutMs: 30_000 })
  const schedulerState = manager.describe().scheduler
  assert.ok(schedulerState.speculative_dispatches >= 1 || manager.describe().pool.busy >= 2)
  await pump(manager, () => manager.describe().plans[0]?.status === 'completed', { label: 'the speculative plan' })
  assert.equal(manager.describe().plans[0].nodes[0].status, 'completed')
})

test('兼容模式: with adaptiveWorkers off the pool never exceeds one worker (§36)', async (t) => {
  const { manager, target } = await rig('compat', { adaptive: false })
  t.after(() => manager.forceStop('cleanup'))

  manager.submitPlan(planFor(target, [
    sleepNode('x1', { ms: 800 }),
    sleepNode('x2', { ms: 800 })
  ]))
  let maxSize = 0
  await pump(manager, () => {
    maxSize = Math.max(maxSize, manager.describe().pool.size)
    return manager.describe().plans[0]?.status === 'completed'
  }, { label: 'the compatibility plan' })
  assert.equal(maxSize, 1, 'compatibility mode is dynamic multi-process with N = 1')
  assert.equal(manager.describe().max_workers, 1)
  assert.equal(manager.describe().plans[0].status, 'completed')
  // The same code path ran both nodes, one after the other.
  assert.equal(manager.describe().plans[0].nodes.length, 2)
})

test('a legacy worktree path is preserved in compatibility mode', async (t) => {
  const { manager, target } = await rig('legacy-worktree', { adaptive: false })
  t.after(() => manager.forceStop('cleanup'))

  manager.assignTask({
    version: 1,
    task_id: 'legacy-1',
    objective: 'write a file',
    target_repo: target,
    allowed_paths: ['**'],
    forbidden_paths: [],
    risk_level: 'L1',
    permissions: { read: true, write: true },
    operations: [{ op: 'write_file', path: 'legacy.txt', content: 'x\n' }]
  })
  await pump(manager, () => manager.describe().history.length > 0, { label: 'the legacy task' })
  const worktree = WorktreeManager.worktreePathFor(target)
  assert.equal(worktree, path.join(path.dirname(target), 'TargetRepo-worktrees', 'hns-sub-worker'))
  assert.equal(fs.existsSync(path.join(worktree, 'legacy.txt')), true)
})

test('§34: a supervisor crash record is recoverable and replayable', async (t) => {
  const { manager, root, target } = await rig('recover')
  t.after(() => manager.forceStop('cleanup'))

  manager.submitPlan(planFor(target, [sleepNode('interrupted', { ms: 20_000, scope: ['interrupted.txt'] })], { plan_id: 'recover-plan' }))
  await waitFor(() => manager.describe().pool.busy >= 1, { label: 'the task to start' })
  manager.pool.killAll({ reason: 'simulated supervisor loss', expected: false })
  await waitFor(() => manager.describe().history.length > 0, { timeoutMs: 30_000, label: 'the crash record' })

  // The plan and its nodes are persisted, so a fresh supervisor can replay it.
  const saved = manager.store.loadPlan('recover-plan')
  assert.ok(saved, 'the plan must be persisted for recovery')
  assert.equal(saved.plan.plan_id, 'recover-plan')

  const second = new WorkerManager({ root, nodeExe: process.execPath, runtimeProcess, log: () => {}, notify: () => {} })
  MANAGERS.add(second)
  t.after(() => second.forceStop('cleanup'))
  second.hydrate()
  const snapshot = second.describe()
  assert.equal(snapshot.plans.length >= 1, true, 'the active plan is restored on hydrate')
  assert.equal(snapshot.plans[0].plan_id, 'recover-plan')
  // The restored plan is dispatchable: the node tasks came back with it.
  const restoredNodes = second.plans[0].tasks
  assert.ok(restoredNodes.size >= 1, 'a restored plan must carry its node specifications')
  const restoredTask = [...restoredNodes.values()][0]
  assert.equal(restoredTask.task_id, 'recover-plan-interrupted')
  assert.ok(Array.isArray(restoredTask.operations) && restoredTask.operations.length > 0)
})
