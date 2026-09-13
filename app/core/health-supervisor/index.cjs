'use strict'

/**
 * DS-Hns Core: the health supervisor.
 *
 * The plugin manager can tell you whether a plugin is *loaded*. That is not the
 * same question as whether it *works*: a computer-use plugin that cannot attach to
 * the browser is loaded and useless. The health supervisor asks the second
 * question on a schedule, aggregates the answers, and — the part that matters for
 * availability — restarts one plugin instead of the whole runtime.
 *
 * Fault levels decide the response, exactly as the plan states:
 *
 *   SOFT       telemetry, caches: record it and carry on
 *   DEGRADED   repo map, computer use: report degraded, the task falls back
 *   FATAL      workspace corruption, contract mismatch: the task stops
 *
 * A restart is bounded: two attempts, then the plugin stays unhealthy and the
 * runtime reports why. An unbounded restart loop on a plugin that is broken by
 * construction is just a slower failure.
 */

const { HEALTH_STATUS, FAULT_LEVELS } = require('../contracts/plugin.cjs')

const DEFAULT_MAX_RESTARTS = 2
const DEFAULT_INTERVAL_MS = 30_000

/**
 * @param {object} input
 * @param {object} input.manager the plugin manager
 * @param {object} [input.bus]
 * @param {Function} [input.now]
 * @param {number} [input.intervalMs]
 * @param {number} [input.maxRestarts]
 * @param {Function} [input.log]
 */
function createHealthSupervisor(input = {}) {
  const manager = input.manager
  if (!manager) throw new Error('the health supervisor needs a plugin manager')
  const bus = input.bus || manager.bus
  const now = typeof input.now === 'function' ? input.now : () => Date.now()
  const intervalMs = Number.isInteger(input.intervalMs) ? input.intervalMs : DEFAULT_INTERVAL_MS
  const maxRestarts = Number.isInteger(input.maxRestarts) ? input.maxRestarts : DEFAULT_MAX_RESTARTS
  const log = typeof input.log === 'function' ? input.log : () => {}
  const restarts = new Map()
  const history = []
  let timer = null

  function remember(entry) {
    history.push(entry)
    if (history.length > 200) history.splice(0, history.length - 200)
    return entry
  }

  /**
   * How the runtime should react to one plugin's health.
   *
   * The fault level is the plugin's own declaration: a cache failing must not be
   * treated like a corrupt workspace, and vice versa.
   */
  function reactionTo(plugin, health) {
    const level = (manager.entry(plugin) && manager.entry(plugin).fault_level) || FAULT_LEVELS.DEGRADED
    if (health.status === HEALTH_STATUS.HEALTHY) return { action: 'none', level, reason: 'the plugin reports healthy' }
    if (health.status === HEALTH_STATUS.UNKNOWN) return { action: 'none', level, reason: health.reason || 'the plugin reports no health' }
    const attempts = restarts.get(plugin) || 0
    if (level === FAULT_LEVELS.FATAL) {
      return { action: 'stop', level, reason: `a fatal plugin fault: ${health.reason || 'unhealthy'}` }
    }
    if (level === FAULT_LEVELS.SOFT) {
      return { action: 'ignore', level, reason: `a soft failure, continuing: ${health.reason || 'unhealthy'}` }
    }
    if (attempts >= maxRestarts) {
      return { action: 'degrade', level, reason: `${plugin} is still unhealthy after ${attempts} restart(s): ${health.reason || 'unhealthy'}` }
    }
    return { action: 'restart', level, reason: `restarting ${plugin} (attempt ${attempts + 1}/${maxRestarts})` }
  }

  /**
   * Check one plugin and act on the answer.
   *
   * @param {string} id
   * @param {object} [options] `{ restart: true }` to allow a restart
   */
  async function check(id, options = {}) {
    const health = await manager.checkHealth(id)
    const reaction = reactionTo(id, health)
    let restarted = false
    if (reaction.action === 'restart' && options.restart !== false) {
      restarts.set(id, (restarts.get(id) || 0) + 1)
      const result = await manager.reload(id)
      restarted = result.ok === true
      if (restarted) {
        // A restarted plugin gets one fresh health check: reporting the stale
        // failure would be a lie, and reporting healthy without asking would be
        // another one.
        const after = await manager.checkHealth(id)
        health.status = after.status
        health.reason = after.reason
      }
    }
    const entry = remember({
      at: now(),
      plugin: id,
      status: health.status,
      reason: health.reason,
      action: restarted ? 'restarted' : reaction.action,
      level: reaction.level,
      detail: reaction.reason
    })
    if (reaction.action === 'restart') bus.emit('plugin.fault', { plugin: id, code: 'PLUGIN_RESTART', reason: reaction.reason, level: reaction.level, restarted })
    log({ kind: 'health', plugin: id, status: health.status, action: entry.action })
    return { health, reaction, restarted, entry }
  }

  /** Check every installed plugin. */
  async function checkAll(options = {}) {
    const out = []
    for (const plugin of manager.list()) out.push(await check(plugin.id, options))
    return out
  }

  /**
   * The aggregate verdict for the *runtime*.
   *
   * `blocked` means a fatal fault, `degraded` means at least one plugin is not
   * healthy but the runtime can continue, and `healthy` means every loaded plugin
   * that reports is healthy.
   */
  function status() {
    const plugins = manager.list()
    const unhealthy = plugins.filter((plugin) => plugin.healthy === false)
    const fatal = unhealthy.filter((plugin) => plugin.faultLevel === FAULT_LEVELS.FATAL)
    const loaded = plugins.filter((plugin) => plugin.loaded)
    const unknown = loaded.filter((plugin) => plugin.healthy === null)
    return {
      at: now(),
      status: fatal.length ? 'blocked' : unhealthy.length ? 'degraded' : 'healthy',
      plugins: plugins.length,
      loaded: loaded.length,
      unhealthy: unhealthy.map((plugin) => ({ id: plugin.id, level: plugin.faultLevel, reason: plugin.health ? plugin.health.reason : null })),
      fatal: fatal.map((plugin) => plugin.id),
      unknown: unknown.map((plugin) => plugin.id),
      restarts: [...restarts.entries()].map(([id, count]) => ({ id, count })),
      recent: history.slice(-10)
    }
  }

  /** Start the periodic check. Bounded: it is a timer, not a loop. */
  function start() {
    if (timer) return { ok: true, already: true }
    timer = setInterval(() => {
      checkAll({ restart: true }).catch((error) => log({ kind: 'health-check-failed', reason: String(error && error.message ? error.message : error) }))
    }, intervalMs)
    timer.unref?.()
    return { ok: true, intervalMs }
  }

  function stop() {
    if (!timer) return { ok: true, already: true }
    clearInterval(timer)
    timer = null
    return { ok: true }
  }

  return {
    HEALTH_STATUS,
    FAULT_LEVELS,
    check,
    checkAll,
    status,
    reactionTo,
    start,
    stop,
    intervalMs,
    maxRestarts,
    history() {
      return history.slice()
    },
    restartCount(id) {
      return restarts.get(String(id)) || 0
    }
  }
}

module.exports = { createHealthSupervisor, DEFAULT_MAX_RESTARTS, DEFAULT_INTERVAL_MS }
