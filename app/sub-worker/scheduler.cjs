'use strict'

/**
 * Dispatch Scheduler and Integration Manager (plan §15, §16, §22, §23, §24, §25,
 * §42).
 *
 * The default loop of plan §42, expressed as pure policy:
 *
 *   update_runtime_metrics()
 *   system_limit = calculate_runtime_worker_limit()
 *   runnable     = dag.get_runnable_tasks()
 *   safe_tasks   = filter_conflicts(runnable)
 *   desired      = min(system_limit, len(safe_tasks), config.hard_max)
 *   scale_worker_pool(desired)
 *   dispatch_by_priority(safe_tasks)
 *
 * Nothing here spawns processes or writes files: it decides, and the supervisor
 * executes. That separation is what makes the policy testable without a machine
 * under load.
 */

const { NODE_STATUS, priorityOf } = require('./dag.cjs')
const { scopeOf, filterConflicts } = require('./ownership.cjs')

/** A worker role per node role, so specialized workers can be introduced later (§14). */
const ROLE_TO_WORKER_ROLE = Object.freeze({
  code: 'code',
  generic: 'generic',
  explorer: 'explorer',
  review: 'review',
  test: 'test',
  build: 'build',
  integration: 'integration'
})

function workerRoleFor(node) {
  return ROLE_TO_WORKER_ROLE[node?.role] || 'generic'
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

class DispatchScheduler {
  constructor({ config = {}, log = () => {} } = {}) {
    this.config = config
    this.log = log
    this.speculation = new Map() // node_id -> { primary: workerId, duplicates: [workerId] }
    this.stats = {
      dispatched: 0,
      skipped_conflict: 0,
      skipped_capability: 0,
      skipped_limit: 0,
      speculative_dispatches: 0
    }
  }

  /** §16: how many workers are justified by the *work*, not the hardware. */
  workloadDemand(graph) {
    return {
      runnable: graph.runnable().length,
      running: graph.running().length,
      pending: graph.nodes.filter((node) => node.status === NODE_STATUS.PENDING).length
    }
  }

  /**
   * Choose what to start right now.
   *
   * @returns {{dispatch: Array<{node:object, workerId:string, taskPackage:object|null, reason:string}>,
   *            skipped: Array<{node_id:string, reason:string}>,
   *            blocked: Array<{node:object, failed_dependency:string}>,
   *            demand: object, reasons: string[]}}
   */
  selectDispatch({
    graph,
    idleWorkers = [],
    registry = null,
    performanceState = 'NORMAL',
    onlineSlots = 0,
    gpuSlots = 0,
    onlineInUse = 0,
    gpuInUse = 0,
    maxDispatch = Infinity
  } = {}) {
    const dispatch = []
    const skipped = []
    const reasons = []
    if (!graph) return { dispatch, skipped, blocked: [], demand: { runnable: 0, running: 0, pending: 0 }, reasons: ['no plan'] }

    // §35: when the supervisor is in an emergency state it starts nothing new;
    // it only lets what already runs finish.
    const blockedByState = ['CRITICAL', 'SAFE_MODE', 'THROTTLED'].includes(String(performanceState))
    if (blockedByState) {
      reasons.push(`${performanceState}: no new tasks are started`)
      return { dispatch, skipped, blocked: graph.blockedByDependency().map((entry) => ({ node: entry.node, failed_dependency: entry.failed_dependency })), demand: this.workloadDemand(graph), reasons }
    }

    const runningNodes = graph.running()
    const available = [...idleWorkers]
    if (graph.blockedByDependency().length) {
      for (const entry of graph.blockedByDependency()) {
        graph.markTerminal(entry.node.node_id, NODE_STATUS.BLOCKED, {
          status: 'blocked',
          summary: `dependency ${entry.failed_dependency} did not complete`,
          code: 'BLOCKED'
        })
      }
    }

    let onlineRemaining = Math.max(0, Number(onlineSlots) - Number(onlineInUse))
    let gpuRemaining = Math.max(0, Number(gpuSlots) - Number(gpuInUse))

    for (const node of graph.runnable()) {
      if (dispatch.length >= available.length || dispatch.length >= maxDispatch) break

      // Capability routing (§23, §31): an online task needs an external-service
      // slot, and a GPU task needs a free VRAM slot - CPU headroom is irrelevant.
      if (node.requires_network && onlineRemaining <= 0) {
        skipped.push({ node_id: node.node_id, reason: 'no external-service slot is free' })
        this.stats.skipped_capability += 1
        continue
      }
      if (node.requires_gpu && gpuRemaining <= 0) {
        skipped.push({ node_id: node.node_id, reason: 'no GPU/VRAM slot is free' })
        this.stats.skipped_capability += 1
        continue
      }

      // §17: never let two workers write the same files at the same time.
      const active = [...runningNodes, ...dispatch.map((entry) => ({ ...entry.node, worker_id: entry.workerId }))]
      const conflict = filterConflicts({ ...node, worker_id: available[0]?.worker_id || null }, active, { registry })
      if (!conflict.ok) {
        skipped.push({ node_id: node.node_id, reason: conflict.reason })
        this.stats.skipped_conflict += 1
        continue
      }

      // Role preference: use a worker that already has the role, else any idle.
      const preferred = available.findIndex((worker) => worker.role === workerRoleFor(node))
      const index = preferred >= 0 ? preferred : 0
      const [worker] = available.splice(index, 1)
      if (!worker) break

      if (node.requires_network) onlineRemaining -= 1
      if (node.requires_gpu) gpuRemaining -= 1
      dispatch.push({ node, workerId: worker.worker_id, worker, taskPackage: null, reason: `priority ${priorityOf(node)}` })
    }

    this.stats.dispatched += dispatch.length
    if (skipped.length) {
      reasons.push(`${skipped.length} node(s) waiting: ${skipped.map((entry) => `${entry.node_id} (${entry.reason})`).join(', ')}`)
    }
    return {
      dispatch,
      skipped,
      blocked: [],
      demand: this.workloadDemand(graph),
      reasons
    }
  }

  /**
   * Speculative execution (plan §25): duplicate an uncertain node onto a second
   * worker. Only in NORMAL/BOOST, only for nodes the Controller marked as
   * speculative, and only while real resources are free.
   */
  selectSpeculative({ graph, idleWorkers = [], performanceState = 'NORMAL', onlineSlots = 0, onlineInUse = 0 } = {}) {
    const out = []
    if (!graph) return out
    const enabled = this.config?.speculativeExecution?.enabled !== false
    const maxDuplicates = Math.max(2, Number(this.config?.speculativeExecution?.maxDuplicates) || 2)
    if (!enabled) return out
    if (!['NORMAL', 'BOOST'].includes(String(performanceState))) {
      this.log('[scheduler] speculative execution is disabled while throttled or critical')
      return out
    }
    // One idle worker is enough for a duplicate: the node itself already holds
    // another worker.
    if (!idleWorkers.length) return out

    const running = graph.running()
    for (const node of running) {
      if (!node.speculative) continue
      const entry = this.speculation.get(node.node_id) || { primary: node.worker_id, duplicates: [] }
      if (entry.duplicates.length >= maxDuplicates - 1) continue
      if (node.requires_network && Number(onlineInUse) + entry.duplicates.length >= Number(onlineSlots)) continue
      const worker = idleWorkers.find((candidate) => candidate.worker_id !== node.worker_id && !entry.duplicates.includes(candidate.worker_id))
      if (!worker) continue
      entry.duplicates.push(worker.worker_id)
      this.speculation.set(node.node_id, entry)
      out.push({ node, workerId: worker.worker_id, worker, reason: `speculative duplicate of ${node.worker_id}`, duplicate: true })
      this.stats.speculative_dispatches += 1
    }
    return out
  }

  /** Forget speculation bookkeeping for a finished node. */
  clearSpeculation(nodeId) {
    return this.speculation.delete(nodeId)
  }

  speculationFor(nodeId) {
    return this.speculation.get(nodeId) || null
  }

  /**
   * §22/§23: the nodes that are *not* allowed to run the full suite. A code
   * worker runs lint and its target tests; only the integration node runs the
   * full suite, the build and the acceptance commands.
   */
  localAcceptanceFor(node, plan) {
    if (node.role === 'integration' || node.role === 'test') {
      return { scope: 'full', commands: [...(plan?.acceptance_commands || []), ...(node.acceptance_tests || [])] }
    }
    return { scope: 'targeted', commands: (node.acceptance_tests || []).slice(0, 3) }
  }

  /**
   * The Integration Manager's job list after the DAG drains: the plan is only
   * "done" once the integration node and the full validation have passed.
   */
  integrationPlan(graph) {
    if (!graph) return { needed: false, reason: 'no plan' }
    const integration = graph.nodes.find((node) => node.role === 'integration')
    if (integration) return { needed: false, node: integration, reason: 'the plan declares an integration node' }
    const leaves = graph.nodes.filter((node) => !graph.nodes.some((candidate) => candidate.depends_on.includes(node.node_id)))
    return {
      needed: true,
      reason: 'no integration node was declared; the supervisor adds a validation pass',
      candidates: leaves.map((node) => node.node_id)
    }
  }

  describe() {
    return {
      ...this.stats,
      speculation: [...this.speculation].map(([nodeId, entry]) => ({ node_id: nodeId, ...entry }))
    }
  }
}

module.exports = {
  ROLE_TO_WORKER_ROLE,
  workerRoleFor,
  DispatchScheduler,
  isPlainObject,
  scopeOf
}
