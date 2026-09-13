'use strict'

/**
 * DS-Hns acceleration: single-task parallel execution.
 *
 * Phase 10 of the acceleration plan, and the round's P0. The goal is *not* several
 * agents editing files at once; it is one task's dependency graph executing where the
 * graph allows it. Inspecting three subsystems, discovering the tests, and reading the
 * API a patch depends on are independent, and running them one after another is pure
 * wall-clock waste.
 *
 * The module is built around one rule from the plan, and the rule is what makes the
 * rest safe:
 *
 *   parallel writes are allowed only when `writeSet(A) ∩ writeSet(B) = ∅`
 *
 * Two workers writing the same file do not merge, they overwrite; the loser's work
 * disappears with no diff to prove it existed. So overlapping writes are serialized by
 * default, and the only exception is the plan's own: aggressive mode, where each writer
 * gets an isolated worktree — and even then the executor does not pretend the result is
 * integrated. It reports `requiresIntegration` with the conflicting files and the
 * worktree paths, because two isolated writers that touched the same file have two
 * answers and somebody has to choose.
 *
 * Three further boundaries are enforced rather than documented:
 *
 *  * **A read-write pair is a conflict too.** A node that reads a file another node in
 *    the same wave writes may see either version, which turns a deterministic task into
 *    a flaky one. Read-read is free; everything else is ordered.
 *  * **The worker count is derived, never assumed.** `effectiveWorkers` comes from the
 *    resource manager, and when it allocates nothing the run refuses with the bound that
 *    applied instead of starting 32 processes on a 32-core machine.
 *  * **Model calls are a single queue.** Task parallelism is not model parallelism: one
 *    serving runtime, one request queue, whatever the mode. Starting one model instance
 *    per worker to "go faster" is how VRAM is exhausted.
 */

/** Plan section 19. */
const PARALLEL_MODES = Object.freeze({
  OFF: 'off',
  SAFE: 'safe',
  ADAPTIVE: 'adaptive',
  AGGRESSIVE: 'aggressive'
})

/** Plan section 21. */
const RISKS = Object.freeze({ LOW: 'low', MEDIUM: 'medium', HIGH: 'high' })

const CONFLICT_KINDS = Object.freeze({
  WRITE_WRITE: 'write-write',
  READ_WRITE: 'read-write'
})

/**
 * What each mode permits.
 *
 * `overlappingWrites` is the plan's section 22 rule: `serial` everywhere except
 * aggressive mode, where an isolated worktree per writer is the price of overlap.
 */
const MODE_POLICY = Object.freeze({
  [PARALLEL_MODES.OFF]: Object.freeze({
    label: 'Off',
    purpose: 'debug, benchmark, reproduce',
    readsParallel: false,
    disjointWritesParallel: false,
    overlappingWrites: 'serial',
    modelNodesParallel: false,
    isolationRequired: false
  }),
  [PARALLEL_MODES.SAFE]: Object.freeze({
    label: 'Safe',
    purpose: 'parallel inspection, serial mutation',
    readsParallel: true,
    disjointWritesParallel: false,
    overlappingWrites: 'serial',
    modelNodesParallel: false,
    isolationRequired: false
  }),
  [PARALLEL_MODES.ADAPTIVE]: Object.freeze({
    label: 'Adaptive',
    purpose: 'the default: parallel reads, independent write sets in parallel',
    readsParallel: true,
    disjointWritesParallel: true,
    overlappingWrites: 'serial',
    modelNodesParallel: true,
    isolationRequired: false
  }),
  [PARALLEL_MODES.AGGRESSIVE]: Object.freeze({
    label: 'Aggressive',
    purpose: 'parallel coding workers, each in its own worktree',
    readsParallel: true,
    disjointWritesParallel: true,
    overlappingWrites: 'isolated',
    modelNodesParallel: true,
    isolationRequired: true
  })
})

const DEFAULT_POLICY = Object.freeze({
  /** Model requests are served by one runtime; more than one in flight buys nothing. */
  modelConcurrency: 1,
  /** After a failure, stop scheduling and say so, rather than continuing into the dark. */
  stopOnFailure: true,
  /** The hard ceiling on workers, whatever the resource manager says. */
  maxWorkers: 4,
  /** The floor, when the manager is idle. */
  minWorkers: 2
})

/** Windows paths arrive with backslashes; two spellings of one file must not conflict. */
function normalizePath(value) {
  const text = String(value == null ? '' : value).trim().split('\\').join('/')
  if (!text) return text
  return text.startsWith('./') ? text.slice(2) : text
}

function normalizeSet(value) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map(normalizePath).filter(Boolean))].sort()
}

/**
 * Validate and normalize a `TaskNode` (plan section 21).
 *
 * A malformed node is refused rather than defaulted: a node whose write set was meant
 * to be populated but came back empty would be treated as a pure reader, and the
 * scheduler would happily let it run beside a writer of the same file.
 */
function validateNode(node) {
  if (!node || typeof node !== 'object') return { ok: false, reason: 'a task node must be an object' }
  const id = node.id == null ? '' : String(node.id).trim()
  if (!id) return { ok: false, reason: 'a task node must have an id' }
  if (node.readSet !== undefined && !Array.isArray(node.readSet)) return { ok: false, reason: `task "${id}" has a non-array readSet` }
  if (node.writeSet !== undefined && !Array.isArray(node.writeSet)) return { ok: false, reason: `task "${id}" has a non-array writeSet` }
  if (node.dependencies !== undefined && !Array.isArray(node.dependencies)) return { ok: false, reason: `task "${id}" has a non-array dependencies` }
  const risk = node.risk === undefined ? RISKS.LOW : String(node.risk)
  if (!Object.values(RISKS).includes(risk)) return { ok: false, reason: `task "${id}" has an unknown risk "${risk}"` }
  const cpuCost = node.cpuCost === undefined ? 1 : Number(node.cpuCost)
  const memoryCost = node.memoryCost === undefined ? 1 : Number(node.memoryCost)
  if (!Number.isFinite(cpuCost) || cpuCost < 0) return { ok: false, reason: `task "${id}" has a non-numeric cpuCost` }
  if (!Number.isFinite(memoryCost) || memoryCost < 0) return { ok: false, reason: `task "${id}" has a non-numeric memoryCost` }
  return {
    ok: true,
    node: {
      id,
      dependencies: [...new Set((node.dependencies || []).map((dependency) => String(dependency).trim()).filter(Boolean))],
      readSet: normalizeSet(node.readSet),
      writeSet: normalizeSet(node.writeSet),
      cpuCost,
      memoryCost,
      modelRequired: node.modelRequired === true,
      toolRequired: node.toolRequired === true,
      risk
    }
  }
}

function intersect(left, right) {
  const wanted = new Set(right)
  return left.filter((entry) => wanted.has(entry))
}

/**
 * Why two nodes may not run in the same wave.
 *
 * A shared write is the plan's rule. The read-write case is added because it is the
 * same hazard one step removed: a reader that runs beside a writer of the same file
 * returns a result that depends on scheduling, which is a flaky task rather than a
 * parallel one.
 */
function writeConflict(left, right) {
  const writes = intersect(left.writeSet, right.writeSet)
  if (writes.length) return { conflict: true, kind: CONFLICT_KINDS.WRITE_WRITE, files: writes }
  const leftReads = intersect(left.readSet, right.writeSet)
  const rightReads = intersect(right.readSet, left.writeSet)
  const files = [...new Set([...leftReads, ...rightReads])].sort()
  if (files.length) return { conflict: true, kind: CONFLICT_KINDS.READ_WRITE, files }
  return { conflict: false, kind: null, files: [] }
}

/**
 * Layer the graph.
 *
 * `waves` are the topological layers: every node in a wave has all of its dependencies
 * satisfied by earlier waves. A dependency that does not exist, a duplicate id, or a
 * cycle is refused with the offending ids, because a scheduler that guesses at a broken
 * graph will run work in an order the caller did not ask for.
 */
function planGraph(input = {}) {
  const raw = Array.isArray(input.nodes) ? input.nodes : []
  const nodes = []
  const seen = new Set()
  for (const candidate of raw) {
    const validated = validateNode(candidate)
    if (!validated.ok) return { ok: false, reason: validated.reason }
    if (seen.has(validated.node.id)) return { ok: false, reason: `duplicate task id "${validated.node.id}"` }
    seen.add(validated.node.id)
    nodes.push(validated.node)
  }
  const byId = new Map(nodes.map((node) => [node.id, node]))
  for (const node of nodes) {
    for (const dependency of node.dependencies) {
      if (!byId.has(dependency)) return { ok: false, reason: `task "${node.id}" depends on unknown task "${dependency}"` }
      if (dependency === node.id) return { ok: false, reason: `task "${node.id}" depends on itself` }
    }
  }
  const remaining = new Map(nodes.map((node) => [node.id, new Set(node.dependencies)]))
  const waves = []
  const order = []
  while (remaining.size) {
    const ready = [...remaining.entries()].filter(([, dependencies]) => [...dependencies].every((dependency) => !remaining.has(dependency)))
    if (!ready.length) {
      return { ok: false, reason: `the task graph has a cycle through ${[...remaining.keys()].join(', ')}`, cycle: [...remaining.keys()] }
    }
    const wave = ready.map(([id]) => id).sort()
    for (const id of wave) remaining.delete(id)
    waves.push(wave)
    order.push(...wave)
  }
  return { ok: true, nodes, byId, waves, order, reason: null }
}

/**
 * Turn the waves into the lanes that actually run.
 *
 * Each wave becomes an ordered list of lanes; the nodes inside a lane run together, and
 * the lanes run one after another. This is where the mode bites: `off` puts every node
 * in its own lane, `safe` lets only pure readers share one, `adaptive` adds disjoint
 * write sets, and `aggressive` may put overlapping writers in one lane when isolation
 * is available.
 */
function planWaves(input = {}) {
  const mode = MODE_POLICY[input.mode] ? input.mode : PARALLEL_MODES.ADAPTIVE
  const policy = MODE_POLICY[mode]
  const graph = input.graph || planGraph(input)
  if (!graph.ok) return { ok: false, reason: graph.reason, mode, waves: [], conflicts: [] }
  const isolationAvailable = input.isolationAvailable === true
  const conflicts = []
  const waves = []

  for (const ids of graph.waves) {
    const nodes = ids.map((id) => graph.byId.get(id))
    const parallel = []
    const serial = []
    const overlap = []
    for (const node of nodes) {
      if (!policy.readsParallel && !policy.disjointWritesParallel) {
        serial.push(node)
        continue
      }
      const isWriter = node.writeSet.length > 0
      if (!isWriter) {
        // Pure readers may share a lane whenever reads are parallel at all.
        parallel.push(node)
        continue
      }
      if (!policy.disjointWritesParallel) {
        serial.push(node)
        continue
      }
      const clashing = parallel.filter((other) => writeConflict(node, other).conflict)
      if (!clashing.length) {
        parallel.push(node)
        continue
      }
      const kinds = clashing.map((other) => writeConflict(node, other))
      for (const [index, other] of clashing.entries()) {
        conflicts.push({ a: other.id, b: node.id, kind: kinds[index].kind, files: kinds[index].files })
      }
      // The plan's one exception: aggressive mode may run overlapping writers together,
      // but only inside separate worktrees, and never silently. Every clashing writer
      // moves into the isolated lane — including the one that was seen first, because
      // "the earlier writer gets the user's tree" is exactly the race the rule forbids.
      if (policy.overlappingWrites === 'isolated' && isolationAvailable) {
        for (const other of clashing) {
          if (other.writeSet.length === 0) continue
          const position = parallel.indexOf(other)
          if (position !== -1) parallel.splice(position, 1)
          if (!overlap.includes(other)) overlap.push(other)
        }
        overlap.push(node)
      } else {
        serial.push(node)
      }
    }
    const lanes = []
    // Readers (and disjoint writers) share a lane: this is the parallelism that pays.
    if (parallel.length) lanes.push({ kind: 'parallel', ids: parallel.map((node) => node.id) })
    // Writers that overlap each other run together only in isolation.
    if (overlap.length) lanes.push({ kind: 'isolated', ids: overlap.map((node) => node.id) })
    // Everything ordered runs alone, one lane per node.
    for (const node of serial) lanes.push({ kind: 'serial', ids: [node.id] })
    waves.push({
      ids,
      lanes,
      parallel: [...parallel.map((node) => node.id), ...overlap.map((node) => node.id)],
      serial: serial.map((node) => node.id),
      isolated: overlap.map((node) => node.id)
    })
  }
  return { ok: true, mode, policy, graph, waves, conflicts, reason: null }
}

/** One model serving runtime, one queue (plan section 24). */
function createModelQueue(options = {}) {
  const concurrency = Math.max(1, Number.isInteger(options.concurrency) ? options.concurrency : 1)
  const waiting = []
  let inFlight = 0
  let queued = 0
  let completed = 0
  let maxInFlight = 0
  let peakQueued = 0

  function acquire() {
    if (inFlight < concurrency) {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      return Promise.resolve()
    }
    queued += 1
    peakQueued = Math.max(peakQueued, queued)
    return new Promise((resolve) => {
      waiting.push(() => {
        queued -= 1
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        resolve()
      })
    })
  }

  function release() {
    inFlight -= 1
    const next = waiting.shift()
    if (next) next()
  }

  async function submit(fn) {
    await acquire()
    try {
      return await fn()
    } finally {
      completed += 1
      release()
    }
  }

  return {
    concurrency,
    submit,
    stats: () => ({ concurrency, inFlight, queued, peakQueued, completed, maxInFlight })
  }
}

/** Run `items` with at most `limit` in flight, stopping early when `aborted()` says so. */
async function pool(items, limit, worker, aborted) {
  const results = []
  let index = 0
  const width = Math.max(1, Math.min(limit, items.length))
  await Promise.all(
    Array.from({ length: width }, async () => {
      while (index < items.length) {
        if (typeof aborted === 'function' && aborted()) return
        const current = items[index]
        index += 1
        results.push(await worker(current))
      }
    })
  )
  return results
}

/**
 * @param {object} [options]
 * @param {string} [options.mode]
 * @param {object} [options.resources] the resource manager (`effectiveWorkers`)
 * @param {object} [options.isolation] the workspace isolation runtime (`create`/`reclaim`)
 * @param {Function} [options.now]
 * @param {Function} [options.log]
 * @param {object} [options.policy]
 */
function createParallelExecutor(options = {}) {
  const policy = { ...DEFAULT_POLICY, ...(options.policy || {}) }
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const log = typeof options.log === 'function' ? options.log : () => {}
  const resources = options.resources || null
  const isolation = options.isolation || null
  const history = []
  let mode = MODE_POLICY[options.mode] ? options.mode : PARALLEL_MODES.ADAPTIVE

  /** The worker count for a mode, and the reason — never an assumption about cores. */
  function workersFor(requested) {
    if (mode === PARALLEL_MODES.OFF) return { workers: 1, bound: 'off', reason: 'parallel execution is off, so every node runs alone' }
    const cap = Number.isInteger(requested) ? requested : policy.maxWorkers
    if (!resources || typeof resources.effectiveWorkers !== 'function') {
      const workers = Math.max(1, Math.min(cap, policy.minWorkers))
      return { workers, bound: 'default', reason: `no resource manager is attached, so the floor of ${workers} applies` }
    }
    const decision = resources.effectiveWorkers({ maxWorkers: cap, minWorkers: Math.min(policy.minWorkers, cap) })
    return { workers: decision.workers, bound: decision.bound, reason: decision.reason, pressure: decision.pressure }
  }

  /**
   * Run one dependency graph.
   *
   * @param {object} input
   * @param {object[]} input.nodes `TaskNode[]`
   * @param {Function} input.execute `async (node, context) => result`
   * @param {string} [input.mode] overrides the executor's mode for this run
   * @param {number} [input.maxWorkers]
   */
  async function run(input = {}) {
    const runMode = MODE_POLICY[input.mode] ? input.mode : mode
    const previousMode = mode
    mode = runMode
    try {
      const graph = planGraph(input)
      if (!graph.ok) return { ok: false, mode: runMode, reason: graph.reason, completed: [], failed: [], skipped: [] }
      const isolationReady = isolation && typeof isolation.create === 'function' && typeof isolation.available === 'function'
        ? (await isolation.available()).ok === true
        : false
      const planned = planWaves({ graph, mode: runMode, isolationAvailable: isolationReady })
      if (!planned.ok) return { ok: false, mode: runMode, reason: planned.reason, completed: [], failed: [], skipped: [] }
      const allocation = workersFor(input.maxWorkers)
      if (allocation.workers < 1) {
        return {
          ok: false,
          mode: runMode,
          reason: `the resource manager allocated no workers (${allocation.reason})`,
          allocation,
          completed: [],
          failed: [],
          skipped: graph.order.map((id) => ({ id, reason: 'no workers were allocated' }))
        }
      }

      const modelQueue = createModelQueue({ concurrency: policy.modelConcurrency })
      const finished = new Map()
      const completed = []
      const failed = []
      const skipped = []
      const isolationLedger = { created: 0, reclaimed: 0, refused: 0 }
      let maxParallelism = 0
      let aborted = false
      let stopReason = null
      const startedAt = now()

      const failedIds = new Set()
      const markDependentsSkipped = (reason) => {
        for (const node of graph.nodes) {
          if (finished.has(node.id)) continue
          if (!node.dependencies.some((dependency) => failedIds.has(dependency))) continue
          finished.set(node.id, { ok: false, skipped: true })
          skipped.push({ id: node.id, reason: `dependency failed: ${reason}` })
        }
      }

      const runNode = async (id, preset) => {
        const node = graph.byId.get(id)
        const workspace = preset && preset.workspace ? preset.workspace : null
        const nodeStartedAt = now()
        try {
          const value = await input.execute(node, {
            mode: runMode,
            workspace,
            isolated: Boolean(workspace),
            model: (fn) => modelQueue.submit(fn),
            writeConflict: (other) => writeConflict(node, other)
          })
          const entry = { id, ok: true, ms: now() - nodeStartedAt, isolated: Boolean(workspace), value }
          if (value && value.ok === false) {
            return { ...entry, ok: false, reason: value.reason || 'the task reported failure' }
          }
          return entry
        } catch (error) {
          return { id, ok: false, ms: now() - nodeStartedAt, isolated: Boolean(workspace), reason: error && error.message ? error.message : String(error) }
        }
      }

      /**
       * Run one lane.
       *
       * A `parallel` lane runs its nodes up to the derived worker count; a `serial` lane
       * is a single node; an `isolated` lane is the plan's aggressive exception, where
       * every overlapping writer gets its own verified worktree before it starts.
       */
      const runLane = async (lane) => {
        const width = lane.kind === 'serial' ? 1 : Math.max(1, Math.min(allocation.workers, lane.ids.length))
        maxParallelism = Math.max(maxParallelism, Math.min(width, lane.ids.length))
        if (lane.kind !== 'isolated') return pool(lane.ids, width, (id) => runNode(id), () => aborted)
        return pool(
          lane.ids,
          width,
          async (id) => {
            const created = await isolation.create({ label: id })
            if (!created.ok) {
              isolationLedger.refused += 1
              return {
                id,
                ok: false,
                ms: 0,
                isolated: false,
                reason: `isolation is required for overlapping writes and was refused: ${created.reason}`,
                isolatedRefusal: true
              }
            }
            isolationLedger.created += 1
            try {
              return await runNode(id, { workspace: created.path })
            } finally {
              const reclaimed = await isolation.reclaim(created.id)
              if (reclaimed.ok) isolationLedger.reclaimed += 1
              else log(`workspace isolation: could not reclaim ${created.id}: ${reclaimed.reason}`)
            }
          },
          () => aborted
        )
      }

      for (const wave of planned.waves) {
        if (aborted) break
        for (const lane of wave.lanes) {
          if (aborted) break
          const laneResults = await runLane(lane)
          for (const result of laneResults) {
            finished.set(result.id, result)
            if (result.ok) completed.push(result)
            else {
              failed.push(result)
              failedIds.add(result.id)
              if (policy.stopOnFailure) {
                aborted = true
                stopReason = `task "${result.id}" failed: ${result.reason}`
              }
            }
          }
          markDependentsSkipped(stopReason || 'a dependency failed')
        }
      }

      if (aborted) {
        for (const id of graph.order) {
          if (finished.has(id)) continue
          finished.set(id, { ok: false, skipped: true })
          skipped.push({ id, reason: `not started: ${stopReason || 'the run stopped after a failure'}` })
        }
      }

      const wallMs = Math.max(0, now() - startedAt)
      const serialMs = [...completed, ...failed].reduce((total, entry) => total + (entry.ms || 0), 0)
      const isolated = completed.filter((entry) => entry.isolated).length
      const report = {
        ok: failed.length === 0 && skipped.length === 0,
        mode: runMode,
        stopped: aborted,
        reason: stopReason,
        allocation,
        graph: { order: graph.order, waves: graph.waves },
        plan: planned.waves.map((wave) => ({ ids: wave.ids, lanes: wave.lanes, isolated: wave.isolated })),
        completed,
        failed,
        skipped,
        conflicts: planned.conflicts,
        /** Overlapping writers in isolated trees have two answers; the caller must pick. */
        requiresIntegration: enabledOverlap(runMode, planned, isolationReady),
        isolation: { ...isolationLedger, available: isolationReady },
        model: modelQueue.stats(),
        workers: allocation.workers,
        maxParallelism,
        wallMs,
        serialMs,
        speedup: wallMs > 0 ? Number((serialMs / wallMs).toFixed(3)) : null,
        at: now()
      }
      history.push({ at: report.at, mode: runMode, wallMs, serialMs, completed: completed.length, failed: failed.length, maxParallelism })
      if (history.length > 50) history.splice(0, history.length - 50)
      return report
    } finally {
      mode = previousMode
    }
  }

  function enabledOverlap(runMode, planned, isolationReady) {
    return Boolean(
      MODE_POLICY[runMode] &&
        MODE_POLICY[runMode].overlappingWrites === 'isolated' &&
        isolationReady &&
        planned.waves.some((wave) => wave.isolated.length > 0)
    )
  }

  return {
    policy,
    run,
    plan: (input = {}) => planWaves(input),
    get mode() {
      return mode
    },
    setMode(next) {
      if (!MODE_POLICY[next]) return { ok: false, reason: `"${next}" is not a parallel mode` }
      mode = next
      return { ok: true, mode }
    },
    /** What the UI needs: the four modes and what each one permits. */
    modes: () =>
      Object.entries(MODE_POLICY).map(([name, entry]) => ({
        name,
        label: entry.label,
        purpose: entry.purpose,
        readsParallel: entry.readsParallel,
        disjointWritesParallel: entry.disjointWritesParallel,
        overlappingWrites: entry.overlappingWrites,
        modelNodesParallel: entry.modelNodesParallel,
        isolationRequired: entry.isolationRequired
      })),
    history: () => history.slice(),
    workersFor: (requested) => workersFor(requested),
    stats: () => ({
      mode,
      runs: history.length,
      last: history.length ? history[history.length - 1] : null
    })
  }
}

module.exports = {
  createParallelExecutor,
  createModelQueue,
  planGraph,
  planWaves,
  writeConflict,
  validateNode,
  normalizePath,
  PARALLEL_MODES,
  MODE_POLICY,
  RISKS,
  CONFLICT_KINDS,
  DEFAULT_POLICY
}
