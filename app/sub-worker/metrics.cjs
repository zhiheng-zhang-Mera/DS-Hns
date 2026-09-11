'use strict'

/**
 * Performance metrics and the self-learning resource profile (plan §38, §39,
 * §40).
 *
 * The headline metric is Effective Throughput — completed work units divided by
 * wall-clock time — not CPU usage (§38). The learning part is deliberately
 * simple: an EWMA over observed RAM/CPU cost per role, which is what §40 asks
 * for ("第一版不需要机器学习 … rolling average / EWMA 即可").
 */

const EWMA_ALPHA = 0.3
const DEFAULT_WINDOW = 200

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function round(value, digits = 3) {
  const factor = 10 ** digits
  return Math.round(Number(value) * factor) / factor
}

function ewma(previous, sample, alpha = EWMA_ALPHA) {
  const value = Number(sample)
  if (!Number.isFinite(value)) return Number.isFinite(Number(previous)) ? Number(previous) : null
  const prior = Number(previous)
  if (!Number.isFinite(prior)) return value
  return prior + alpha * (value - prior)
}

class MetricsCollector {
  constructor({ file = null, log = () => {}, window = DEFAULT_WINDOW, now = () => Date.now() } = {}) {
    this.file = file
    this.log = log
    this.window = window
    this.now = now
    this.records = []
    this.workers = new Map() // workerId -> counters
    this.roleProfiles = {} // learned (plan §40)
    this.merges = { attempts: 0, conflicts: 0 }
    this.scaleEvents = []
    this.startedAt = this.now()
  }

  load(serialized) {
    const source = isPlainObject(serialized) ? serialized : {}
    this.records = Array.isArray(source.records) ? source.records.slice(-this.window) : []
    this.roleProfiles = isPlainObject(source.roleProfiles) ? { ...source.roleProfiles } : {}
    this.merges = isPlainObject(source.merges) ? { ...source.merges, attempts: Number(source.merges.attempts) || 0, conflicts: Number(source.merges.conflicts) || 0 } : this.merges
    this.scaleEvents = Array.isArray(source.scaleEvents) ? source.scaleEvents.slice(-50) : []
    return this.records.length
  }

  serialize() {
    return {
      version: 1,
      savedAt: new Date().toISOString(),
      records: this.records.slice(-this.window),
      roleProfiles: this.roleProfiles,
      merges: this.merges,
      scaleEvents: this.scaleEvents.slice(-50)
    }
  }

  /**
   * One finished task.
   *
   * @param {{task_id:string, node_id?:string, plan_id?:string, worker_id:string,
   *          role?:string, status:string, started_at?:string, finished_at?:string,
   *          duration_ms?:number, wall_ms?:number, tests?:object, code?:string,
   *          resource_usage?:{rss_mb?:number, cpu_ms?:number, peak_rss_mb?:number}}} entry
   */
  recordTask(entry = {}) {
    const at = this.now()
    const startedAt = entry.started_at ? Date.parse(entry.started_at) : null
    const finishedAt = entry.finished_at ? Date.parse(entry.finished_at) : at
    const durationMs = Number.isFinite(Number(entry.duration_ms))
      ? Number(entry.duration_ms)
      : (Number.isFinite(startedAt) ? Math.max(0, finishedAt - startedAt) : null)
    const usage = isPlainObject(entry.resource_usage) ? entry.resource_usage : {}
    const record = {
      at,
      task_id: entry.task_id || null,
      node_id: entry.node_id || null,
      plan_id: entry.plan_id || null,
      worker_id: entry.worker_id || null,
      role: String(entry.role || 'generic'),
      status: String(entry.status || 'unknown'),
      code: entry.code || null,
      duration_ms: durationMs,
      rss_mb: Number.isFinite(Number(usage.peak_rss_mb ?? usage.rss_mb)) ? Number(usage.peak_rss_mb ?? usage.rss_mb) : null,
      cpu_ms: Number.isFinite(Number(usage.cpu_ms)) ? Number(usage.cpu_ms) : null,
      tests: isPlainObject(entry.tests) ? entry.tests : null,
      retried: entry.retried === true,
      speculative: entry.speculative === true
    }
    this.records.push(record)
    if (this.records.length > this.window) this.records.splice(0, this.records.length - this.window)
    this.learnRole(record)
    return record
  }

  /** §40: keep a rolling, EWMA-smoothed cost estimate per role. */
  learnRole(record) {
    const role = record.role || 'generic'
    const previous = isPlainObject(this.roleProfiles[role]) ? this.roleProfiles[role] : {
      ramEstimateMb: null,
      cpuWeight: null,
      samples: 0,
      successes: 0,
      averageDurationMs: null,
      failureRate: null
    }
    const next = { ...previous }
    next.samples = (Number(previous.samples) || 0) + 1
    if (record.status === 'completed') next.successes = (Number(previous.successes) || 0) + 1
    next.failureRate = round(1 - (next.successes || 0) / next.samples, 3)
    if (record.rss_mb !== null) next.ramEstimateMb = Math.round(ewma(previous.ramEstimateMb, record.rss_mb) || record.rss_mb)
    if (record.cpu_ms !== null && record.duration_ms) {
      // CPU weight: how much of a core the role used while it ran.
      const cores = Math.max(1, Number(record.duration_ms))
      const weight = Math.max(0.25, round(record.cpu_ms / cores, 2))
      next.cpuWeight = round(ewma(previous.cpuWeight, weight) || weight, 2)
    }
    if (record.duration_ms !== null) next.averageDurationMs = Math.round(ewma(previous.averageDurationMs, record.duration_ms) || record.duration_ms)
    this.roleProfiles[role] = next
    return next
  }

  /** Worker activity, for the idle/active split of §38. */
  recordWorkerActivity(workerId, { activeMs = 0, idleMs = 0, status = null } = {}) {
    const current = this.workers.get(workerId) || { active_ms: 0, idle_ms: 0, tasks: 0, restarts: 0, crashes: 0, last_status: null }
    current.active_ms += Number(activeMs) || 0
    current.idle_ms += Number(idleMs) || 0
    if (status) current.last_status = status
    this.workers.set(workerId, current)
    return current
  }

  recordWorkerEvent(workerId, kind) {
    const current = this.workers.get(workerId) || { active_ms: 0, idle_ms: 0, tasks: 0, restarts: 0, crashes: 0, last_status: null }
    if (kind === 'restart') current.restarts += 1
    if (kind === 'crash') current.crashes += 1
    if (kind === 'task') current.tasks += 1
    this.workers.set(workerId, current)
    return current
  }

  recordScaleEvent(event = {}) {
    this.scaleEvents.push({ at: new Date(this.now()).toISOString(), ...event })
    if (this.scaleEvents.length > 50) this.scaleEvents.shift()
    return this.scaleEvents.at(-1)
  }

  recordMerge({ conflicts = 0, files = 0, plan_id = null, node_id = null } = {}) {
    this.merges.attempts += 1
    this.merges.conflicts += Number(conflicts) || 0
    this.merges.last = { at: new Date(this.now()).toISOString(), files, conflicts, plan_id, node_id }
    return this.merges
  }

  /** §38: successful work units per wall-clock second. */
  effectiveThroughput({ sinceMs = null } = {}) {
    const relevant = sinceMs ? this.records.filter((record) => record.at >= sinceMs) : this.records
    const completed = relevant.filter((record) => record.status === 'completed').length
    const startedAt = sinceMs || relevant[0]?.at || this.startedAt
    const wallSeconds = Math.max(0.001, (this.now() - startedAt) / 1000)
    return {
      completed,
      attempted: relevant.length,
      wall_seconds: round(wallSeconds, 2),
      per_second: round(completed / wallSeconds, 4),
      per_minute: round((completed / wallSeconds) * 60, 3)
    }
  }

  /**
   * §39 parallel efficiency: single-worker estimate over (multi-worker time ×
   * workers). A low value means adding workers to this kind of work does not
   * help, and the scheduler should stop doing it.
   */
  parallelEfficiency({ singleWorkerMs = null, multiWorkerMs = null, workers = 1, planId = null } = {}) {
    const records = planId ? this.records.filter((record) => record.plan_id === planId) : this.records
    const durations = records.map((record) => record.duration_ms).filter((value) => Number.isFinite(value))
    const single = Number.isFinite(Number(singleWorkerMs))
      ? Number(singleWorkerMs)
      : (durations.length ? durations.reduce((sum, value) => sum + value, 0) : null)
    const multi = Number.isFinite(Number(multiWorkerMs))
      ? Number(multiWorkerMs)
      : (durations.length ? Math.max(...durations) : null)
    const count = Math.max(1, Number(workers) || 1)
    if (!single || !multi || multi <= 0) {
      return { available: false, reason: 'not enough timing data yet' }
    }
    const efficiency = single / (multi * count)
    return {
      available: true,
      efficiency: round(efficiency, 3),
      single_worker_ms: Math.round(single),
      multi_worker_ms: Math.round(multi),
      workers: count
    }
  }

  summary({ planId = null } = {}) {
    const records = planId ? this.records.filter((record) => record.plan_id === planId) : this.records
    const byStatus = records.reduce((acc, record) => {
      acc[record.status] = (acc[record.status] || 0) + 1
      return acc
    }, {})
    const durations = records.map((record) => record.duration_ms).filter((value) => Number.isFinite(value))
    const retries = records.filter((record) => record.retried).length
    const rssValues = records.map((record) => record.rss_mb).filter((value) => Number.isFinite(value))
    return {
      tasks: records.length,
      by_status: byStatus,
      completed: byStatus.completed || 0,
      failed: (byStatus.failed || 0) + (byStatus.crashed || 0),
      wall_time_ms: durations.length ? durations.reduce((sum, value) => sum + value, 0) : 0,
      average_task_ms: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : null,
      max_task_ms: durations.length ? Math.max(...durations) : null,
      retry_count: retries,
      peak_worker_ram_mb: rssValues.length ? Math.max(...rssValues) : null,
      merge_conflict_rate: this.merges.attempts ? round(this.merges.conflicts / this.merges.attempts, 3) : 0,
      throughput: this.effectiveThroughput(),
      workers: [...this.workers].map(([workerId, counters]) => ({ worker_id: workerId, ...counters })),
      role_profiles: this.roleProfiles,
      scale_events: this.scaleEvents.slice(-10)
    }
  }
}

module.exports = {
  EWMA_ALPHA,
  DEFAULT_WINDOW,
  ewma,
  MetricsCollector
}
