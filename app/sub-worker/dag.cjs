'use strict'

/**
 * Task DAG and the Dependency Manager (plan §15, §16, §24, §42).
 *
 * A plan is a set of nodes; the scheduler may only dispatch nodes whose
 * dependencies are satisfied. This module owns:
 *   - validation (a cycle is a plan error, never a runtime hang),
 *   - the runnable set,
 *   - the critical path, and the priority formula of §24:
 *       priority = critical_path_score + dependent_task_count
 *                + failure_blocking_weight + manual_priority
 *
 * It never touches processes or the filesystem.
 */

const NODE_STATUS = Object.freeze({
  PENDING: 'pending',
  READY: 'ready',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  BLOCKED: 'blocked',
  CANCELLED: 'cancelled',
  SKIPPED: 'skipped'
})

const TERMINAL_NODE_STATUS = Object.freeze([
  NODE_STATUS.COMPLETED,
  NODE_STATUS.FAILED,
  NODE_STATUS.BLOCKED,
  NODE_STATUS.CANCELLED,
  NODE_STATUS.SKIPPED
])

/** Nodes whose failure must stop the whole plan even if nothing depends on them. */
const DEFAULT_FAILURE_BLOCKING_WEIGHT = 1

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isTerminal(status) {
  return TERMINAL_NODE_STATUS.includes(String(status))
}

function normalizePath(value) {
  return String(value == null ? '' : value).trim().replaceAll('\\', '/')
}

/**
 * Build a plan from a Controller submission.
 *
 * @returns {{ok: boolean, errors: string[], plan: object|null}}
 */
function createPlan(raw, { planId = null, createdAt = new Date().toISOString() } = {}) {
  const errors = []
  const source = isPlainObject(raw) ? raw : {}
  const nodesRaw = Array.isArray(source.nodes) ? source.nodes : []
  if (!nodesRaw.length) errors.push('a plan must contain at least one node')

  const planIdValue = String(source.plan_id || planId || `plan-${Date.now().toString(36)}`)
  const nodes = []
  const seen = new Set()

  for (const entry of nodesRaw) {
    if (!isPlainObject(entry)) {
      errors.push('every node must be an object')
      continue
    }
    const nodeId = String(entry.node_id || entry.id || '').trim()
    if (!nodeId) {
      errors.push('every node needs a node_id')
      continue
    }
    if (seen.has(nodeId)) {
      errors.push(`duplicate node_id: ${nodeId}`)
      continue
    }
    seen.add(nodeId)
    const dependsOn = (Array.isArray(entry.depends_on) ? entry.depends_on : []).map((value) => String(value).trim()).filter(Boolean)
    nodes.push({
      node_id: nodeId,
      objective: String(entry.objective || entry.goal || nodeId),
      role: String(entry.role || 'generic'),
      resource_profile: entry.resource_profile ? String(entry.resource_profile) : null,
      capability: entry.capability ? String(entry.capability) : null,
      depends_on: dependsOn,
      task: isPlainObject(entry.task) ? { ...entry.task } : null,
      file_scope: Array.isArray(entry.file_scope) ? entry.file_scope.map(normalizePath).filter(Boolean) : null,
      write_scope: Array.isArray(entry.write_scope) ? entry.write_scope.map(normalizePath).filter(Boolean) : null,
      read_only_files: Array.isArray(entry.read_only_files) ? entry.read_only_files.map(normalizePath).filter(Boolean) : [],
      relevant_files: Array.isArray(entry.relevant_files) ? entry.relevant_files.map(normalizePath).filter(Boolean) : [],
      acceptance_tests: Array.isArray(entry.acceptance_tests) ? entry.acceptance_tests.map((value) => String(value)) : [],
      constraints: Array.isArray(entry.constraints) ? entry.constraints.map((value) => String(value)) : [],
      timeout: Number(entry.timeout) > 0 ? Math.floor(Number(entry.timeout)) : null,
      priority: Number(entry.priority) || 0,
      failure_blocking_weight: Number.isFinite(Number(entry.failure_blocking_weight))
        ? Number(entry.failure_blocking_weight)
        : DEFAULT_FAILURE_BLOCKING_WEIGHT,
      speculative: entry.speculative === true,
      // Speculative duplication is only ever allowed on a node the Controller
      // explicitly marked as uncertain (plan §25).
      //
      // Two attempts by default: an infrastructure failure (a worker crash, a
      // timeout) is retried once, while a policy refusal is never retried
      // (`retryable()`). The Controller can raise or lower this per node.
      max_attempts: Number(entry.max_attempts) > 0 ? Math.floor(Number(entry.max_attempts)) : 2,
      requires_network: entry.requires_network === true,
      requires_gpu: entry.requires_gpu === true,
      status: NODE_STATUS.PENDING,
      attempts: 0,
      worker_id: null,
      result: null,
      started_at: null,
      finished_at: null
    })
  }

  for (const node of nodes) {
    for (const dependency of node.depends_on) {
      if (!seen.has(dependency)) errors.push(`node ${node.node_id} depends on unknown node ${dependency}`)
      if (dependency === node.node_id) errors.push(`node ${node.node_id} depends on itself`)
    }
  }
  const cycle = errors.length ? null : findCycle(nodes)
  if (cycle) errors.push(`dependency cycle: ${cycle.join(' -> ')}`)

  if (errors.length) return { ok: false, errors, plan: null }

  const plan = {
    plan_id: planIdValue,
    created_at: String(source.created_at || createdAt),
    objective: String(source.objective || nodes[0].objective),
    acceptance: Array.isArray(source.acceptance) ? source.acceptance.map((value) => String(value)) : [],
    acceptance_commands: Array.isArray(source.acceptance_commands) ? source.acceptance_commands.map((value) => String(value)) : [],
    target_repo: source.target_repo ? String(source.target_repo) : null,
    workspace_mode: source.workspace_mode ? String(source.workspace_mode) : null,
    nodes
  }
  annotateCriticalPaths(plan)
  return { ok: true, errors: [], plan }
}

/** Depth-first cycle detection with a readable path in the error message. */
function findCycle(nodes) {
  const byId = new Map(nodes.map((node) => [node.node_id, node]))
  const state = new Map() // 0 = unvisited, 1 = on stack, 2 = done
  let cycle = null

  const visit = (nodeId, stack) => {
    if (cycle) return
    const status = state.get(nodeId) || 0
    if (status === 2) return
    if (status === 1) {
      const from = stack.indexOf(nodeId)
      cycle = [...stack.slice(from), nodeId]
      return
    }
    state.set(nodeId, 1)
    stack.push(nodeId)
    for (const dependency of byId.get(nodeId)?.depends_on || []) {
      visit(dependency, stack)
      if (cycle) break
    }
    stack.pop()
    state.set(nodeId, 2)
  }

  for (const node of nodes) {
    visit(node.node_id, [])
    if (cycle) break
  }
  return cycle
}

/**
 * Longest path to a sink, counted in nodes, plus the transitive dependent count.
 * A node on (or feeding) the critical path must be scheduled first because
 * everything else is waiting on it (§24).
 */
function annotateCriticalPaths(plan) {
  const byId = new Map(plan.nodes.map((node) => [node.node_id, node]))
  for (const node of plan.nodes) {
    node.dependent_count = 0
    node.depth_to_sink = 1
    node.critical_path_score = 0
  }
  // Transitive dependents.
  for (const node of plan.nodes) {
    const stack = [...node.depends_on]
    const seen = new Set()
    while (stack.length) {
      const current = stack.pop()
      if (seen.has(current)) continue
      seen.add(current)
      const target = byId.get(current)
      if (!target) continue
      target.dependent_count += 1
      stack.push(...target.depends_on)
    }
  }
  // Depth to sink, computed in topological order (children before parents).
  const order = topologicalOrder(plan.nodes)
  for (const node of order) {
    const dependents = plan.nodes.filter((candidate) => candidate.depends_on.includes(node.node_id))
    node.depth_to_sink = dependents.length
      ? 1 + Math.max(...dependents.map((dependent) => dependent.depth_to_sink))
      : 1
    node.critical_path_score = node.depth_to_sink * 10
  }
  return plan
}

/** Kahn topological order; returns a partial order for a cyclic graph. */
function topologicalOrder(nodes) {
  const byId = new Map(nodes.map((node) => [node.node_id, node]))
  const indegree = new Map(nodes.map((node) => [node.node_id, node.depends_on.filter((id) => byId.has(id)).length]))
  const queue = nodes.filter((node) => indegree.get(node.node_id) === 0).map((node) => node.node_id)
  const order = []
  while (queue.length) {
    const id = queue.shift()
    order.push(byId.get(id))
    for (const node of nodes) {
      if (!node.depends_on.includes(id)) continue
      indegree.set(node.node_id, indegree.get(node.node_id) - 1)
      if (indegree.get(node.node_id) === 0) queue.push(node.node_id)
    }
  }
  return order.filter(Boolean)
}

/** §24: the documented priority formula. */
function priorityOf(node) {
  return (Number(node.critical_path_score) || 0)
    + (Number(node.dependent_count) || 0)
    + (Number(node.failure_blocking_weight) || 0) * 5
    + (Number(node.priority) || 0)
}

/**
 * A plan's live view over its nodes: runnable set, blocked set and ordering.
 */
class TaskGraph {
  constructor(plan) {
    this.plan = plan
    this.nodes = plan.nodes
    this.byId = new Map(this.nodes.map((node) => [node.node_id, node]))
  }

  static from(raw, options = {}) {
    const created = createPlan(raw, options)
    if (!created.ok) return { ok: false, errors: created.errors, graph: null }
    return { ok: true, errors: [], graph: new TaskGraph(created.plan) }
  }

  get status() {
    if (this.nodes.every((node) => node.status === NODE_STATUS.COMPLETED)) return 'completed'
    if (this.nodes.some((node) => node.status === NODE_STATUS.RUNNING)) return 'running'
    if (this.nodes.some((node) => [NODE_STATUS.FAILED, NODE_STATUS.BLOCKED].includes(node.status))) return 'failed'
    if (this.nodes.every((node) => isTerminal(node.status))) return 'finished'
    return 'pending'
  }

  /** Dependencies satisfied and not yet started/terminal. */
  runnable() {
    return this.nodes
      .filter((node) => node.status === NODE_STATUS.PENDING || node.status === NODE_STATUS.READY)
      .filter((node) => node.depends_on.every((id) => this.byId.get(id)?.status === NODE_STATUS.COMPLETED))
      .sort((a, b) => priorityOf(b) - priorityOf(a) || b.depth_to_sink - a.depth_to_sink || a.node_id.localeCompare(b.node_id))
  }

  running() {
    return this.nodes.filter((node) => node.status === NODE_STATUS.RUNNING)
  }

  /** Nodes that can never run because a dependency failed or was skipped. */
  blockedByDependency() {
    const blocked = []
    for (const node of this.nodes) {
      if (node.status !== NODE_STATUS.PENDING && node.status !== NODE_STATUS.READY) continue
      const failed = node.depends_on.find((id) => {
        const target = this.byId.get(id)
        return target && [NODE_STATUS.FAILED, NODE_STATUS.BLOCKED, NODE_STATUS.CANCELLED, NODE_STATUS.SKIPPED].includes(target.status)
      })
      if (failed) blocked.push({ node, failed_dependency: failed })
    }
    return blocked
  }

  markRunning(nodeId, workerId) {
    const node = this.byId.get(nodeId)
    if (!node) return null
    node.status = NODE_STATUS.RUNNING
    node.worker_id = workerId || null
    node.started_at = new Date().toISOString()
    node.attempts += 1
    return node
  }

  markTerminal(nodeId, status, result = null) {
    const node = this.byId.get(nodeId)
    if (!node) return null
    node.status = status
    node.result = result
    node.finished_at = new Date().toISOString()
    return node
  }

  /**
   * Retry policy: a failed node is retried while attempts remain, but only if
   * the failure looks recoverable (a crash, a timeout, an infrastructure
   * problem) — a policy refusal or a rejected task is a Controller decision.
   */
  retryable(nodeId, result = null) {
    const node = this.byId.get(nodeId)
    if (!node) return { retry: false, reason: 'unknown node' }
    if (node.attempts >= node.max_attempts) return { retry: false, reason: `attempts exhausted (${node.attempts}/${node.max_attempts})` }
    const code = result?.code || null
    const finalCodes = ['TASK_REJECTED', 'REQUIRES_CONTROLLER', 'UNSUPPORTED_CAPABILITY', 'PERMISSION_DENIED', 'PATH_FORBIDDEN', 'MISSING_SPECIFICATION', 'NO_EXECUTABLE_OPERATION']
    if (code && finalCodes.includes(code)) return { retry: false, reason: `a ${code} result is a Controller decision, not a retry` }
    return { retry: true, reason: 'retrying a recoverable failure' }
  }

  describe() {
    return {
      plan_id: this.plan.plan_id,
      objective: this.plan.objective,
      status: this.status,
      node_count: this.nodes.length,
      counts: this.nodes.reduce((acc, node) => {
        acc[node.status] = (acc[node.status] || 0) + 1
        return acc
      }, {}),
      runnable: this.runnable().map((node) => ({
        node_id: node.node_id,
        objective: node.objective,
        role: node.role,
        priority: priorityOf(node),
        critical_path_score: node.critical_path_score,
        dependent_count: node.dependent_count,
        depends_on: node.depends_on,
        speculative: node.speculative,
        requires_network: node.requires_network,
        requires_gpu: node.requires_gpu
      })),
      nodes: this.nodes.map((node) => ({
        node_id: node.node_id,
        objective: node.objective,
        role: node.role,
        status: node.status,
        depends_on: node.depends_on,
        attempts: node.attempts,
        worker_id: node.worker_id,
        priority: priorityOf(node),
        started_at: node.started_at,
        finished_at: node.finished_at,
        result: node.result
          ? { status: node.result.status, code: node.result.code, summary: node.result.summary, changed_files: node.result.changed_files }
          : null,
        write_scope: node.write_scope || node.file_scope || null
      })),
      critical_path: this.criticalPath().map((node) => node.node_id)
    }
  }

  /** The longest dependency chain — the sequence the plan cannot parallelise. */
  criticalPath() {
    const sinks = this.nodes.filter((node) => !this.nodes.some((candidate) => candidate.depends_on.includes(node.node_id)))
    let best = []
    for (const sink of sinks) {
      const chain = []
      let current = sink
      while (current) {
        chain.unshift(current)
        const parents = current.depends_on.map((id) => this.byId.get(id)).filter(Boolean)
        current = parents.sort((a, b) => b.depth_to_sink - a.depth_to_sink)[0] || null
      }
      if (chain.length > best.length) best = chain
    }
    return best
  }

  toJSON() {
    return {
      plan: {
        plan_id: this.plan.plan_id,
        created_at: this.plan.created_at,
        objective: this.plan.objective,
        acceptance: this.plan.acceptance,
        acceptance_commands: this.plan.acceptance_commands,
        target_repo: this.plan.target_repo,
        workspace_mode: this.plan.workspace_mode
      },
      nodes: this.nodes
    }
  }

  static restore(serialized) {
    const source = isPlainObject(serialized) ? serialized : {}
    const created = createPlan({ ...(source.plan || {}), nodes: source.nodes || [] })
    if (!created.ok) return { ok: false, errors: created.errors, graph: null }
    const graph = new TaskGraph(created.plan)
    for (const saved of source.nodes || []) {
      const node = graph.byId.get(String(saved.node_id))
      if (!node) continue
      node.status = saved.status || node.status
      node.attempts = Number(saved.attempts) || 0
      node.worker_id = saved.worker_id || null
      node.result = saved.result || null
      node.started_at = saved.started_at || null
      node.finished_at = saved.finished_at || null
    }
    return { ok: true, errors: [], graph }
  }
}

module.exports = {
  NODE_STATUS,
  TERMINAL_NODE_STATUS,
  DEFAULT_FAILURE_BLOCKING_WEIGHT,
  createPlan,
  findCycle,
  topologicalOrder,
  annotateCriticalPaths,
  priorityOf,
  isTerminal,
  TaskGraph
}
