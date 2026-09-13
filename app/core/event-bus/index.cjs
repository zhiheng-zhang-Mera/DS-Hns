'use strict'

/**
 * DS-Hns Core: the event bus.
 *
 * The bus is why a plugin can be observed without being imported. Telemetry
 * subscribes to it; the watchdog subscribes to it; the health supervisor
 * subscribes to it. None of them knows the plugins that emit, and no emitter knows
 * who is listening — which is exactly the property that makes a plugin removable.
 *
 * Three rules keep it from becoming a hidden coupling of its own:
 *
 *  * **A listener failure is isolated.** One throwing subscriber must not stop the
 *    others, and must not stop the emitter: the emitter is a plugin whose work is
 *    more important than an observer's.
 *  * **Delivery is bounded.** Every subscription can be limited (an unlimited
 *    high-frequency subscription is a memory leak with extra steps), and the
 *    per-subscription delivery counts are readable so a leak is measurable.
 *  * **History is a bounded ring**, and it is off by default: the bus is not a
 *    log, and a plugin that wants a log subscribes to it.
 */

/** The core event vocabulary. A plugin may emit its own namespaced events too. */
const CORE_EVENTS = Object.freeze({
  PLUGIN_INSTALLED: 'plugin.installed',
  PLUGIN_ENABLED: 'plugin.enabled',
  PLUGIN_DISABLED: 'plugin.disabled',
  PLUGIN_LOADED: 'plugin.loaded',
  PLUGIN_UNLOADED: 'plugin.unloaded',
  PLUGIN_HEALTH: 'plugin.health',
  PLUGIN_FAULT: 'plugin.fault',
  CAPABILITY_REGISTERED: 'capability.registered',
  CAPABILITY_REVOKED: 'capability.revoked',
  CAPABILITY_MISSING: 'capability.missing',
  TASK_CREATED: 'task.created',
  TASK_STARTED: 'task.started',
  TASK_ACCEPTED: 'task.accepted',
  TASK_FAILED: 'task.failed',
  MODEL_REQUEST: 'model.request',
  MODEL_RESPONSE: 'model.response',
  TOOL_STARTED: 'tool.started',
  TOOL_COMPLETED: 'tool.completed',
  WORKSPACE_CHANGED: 'workspace.changed',
  VALIDATION_STARTED: 'validation.started',
  VALIDATION_COMPLETED: 'validation.completed',
  METRIC_RECORDED: 'metric.recorded'
})

const DEFAULT_HISTORY = 200

/**
 * @param {object} [options]
 * @param {Function} [options.now]
 * @param {number} [options.historySize] retained events (0 disables the ring)
 * @param {number} [options.maxSubscriptions] the ceiling on concurrent listeners
 * @param {Function} [options.onListenerError] `(error, event, subscription) => void`
 */
function createEventBus(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const historySize = Number.isInteger(options.historySize) ? Math.max(0, options.historySize) : DEFAULT_HISTORY
  const maxSubscriptions = Number.isInteger(options.maxSubscriptions) ? options.maxSubscriptions : 512
  const onListenerError = typeof options.onListenerError === 'function' ? options.onListenerError : null
  const subscriptions = new Set()
  const history = []
  const counters = { emitted: 0, delivered: 0, failed: 0, dropped: 0 }

  function record(entry) {
    if (historySize > 0) {
      history.push(entry)
      if (history.length > historySize) history.splice(0, history.length - historySize)
    }
    return entry
  }

  /**
   * Subscribe to one event type, or to every type with `'*'`.
   *
   * @param {string} type
   * @param {Function} handler `(payload, event) => void`
   * @param {object} [options]
   * @param {string} [options.source] the subscribing plugin, for the audit
   * @param {number} [options.limit] deliver at most this many times, then drop
   * @returns {Function} unsubscribe
   */
  function on(type, handler, options_ = {}) {
    if (typeof handler !== 'function') return () => {}
    if (subscriptions.size >= maxSubscriptions) {
      counters.dropped += 1
      return () => {}
    }
    const subscription = {
      type: String(type || '*'),
      handler,
      source: options_.source || null,
      limit: Number.isInteger(options_.limit) && options_.limit > 0 ? options_.limit : null,
      delivered: 0,
      failures: 0,
      at: now(),
      active: true
    }
    subscriptions.add(subscription)
    return () => {
      subscription.active = false
      subscriptions.delete(subscription)
    }
  }

  /** Subscribe to every event. The telemetry plugin's whole interface. */
  function onAny(handler, options_ = {}) {
    return on('*', handler, options_)
  }

  /** Subscribe once: the subscription removes itself after the first delivery. */
  function once(type, handler, options_ = {}) {
    return on(type, handler, { ...options_, limit: 1 })
  }

  /**
   * Emit one event.
   *
   * Delivery is synchronous and ordered by subscription, because a plugin that
   * needs ordering must be able to rely on it; a listener that throws is recorded
   * and skipped, never propagated to the emitter.
   *
   * @returns {{ok:boolean, event:object, delivered:number, failed:number}}
   */
  function emit(type, payload = {}, meta = {}) {
    const event = {
      type: String(type),
      payload: payload && typeof payload === 'object' ? payload : { value: payload },
      source: meta.source || null,
      at: now(),
      id: counters.emitted + 1
    }
    counters.emitted += 1
    let delivered = 0
    let failed = 0
    // A snapshot: a listener that subscribes or unsubscribes during delivery must
    // not change the set being delivered to.
    for (const subscription of [...subscriptions]) {
      if (!subscription.active) continue
      if (subscription.type !== '*' && subscription.type !== event.type) continue
      if (subscription.limit !== null && subscription.delivered >= subscription.limit) {
        subscription.active = false
        subscriptions.delete(subscription)
        continue
      }
      subscription.delivered += 1
      delivered += 1
      counters.delivered += 1
      try {
        subscription.handler(event.payload, event)
      } catch (error) {
        failed += 1
        counters.failed += 1
        subscription.failures += 1
        if (onListenerError) {
          try {
            onListenerError(error, event, subscription)
          } catch {
            /* the error reporter itself must not break the bus */
          }
        }
      }
      if (subscription.limit !== null && subscription.delivered >= subscription.limit) {
        subscription.active = false
        subscriptions.delete(subscription)
      }
    }
    record(event)
    return { ok: true, event, delivered, failed }
  }

  /** Wait for one event of a type, bounded. Used by the acceptance harness. */
  function waitFor(type, waitOptions = {}) {
    const timeoutMs = Number.isFinite(waitOptions.timeoutMs) ? Number(waitOptions.timeoutMs) : 5_000
    return new Promise((resolve) => {
      let done = false
      const unsubscribe = once(type, (payload, event) => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve({ ok: true, payload, event })
      })
      const timer = setTimeout(() => {
        if (done) return
        done = true
        unsubscribe()
        resolve({ ok: false, payload: null, event: null, reason: `no ${type} event within ${timeoutMs}ms` })
      }, timeoutMs)
      timer.unref?.()
    })
  }

  return {
    CORE_EVENTS,
    emit,
    on,
    onAny,
    once,
    waitFor,
    /** The bounded history, newest last. */
    history(count) {
      if (!Number.isInteger(count) || count <= 0) return history.slice()
      return history.slice(-count)
    },
    /** Types seen, with counts: what the telemetry plugin summarises. */
    counts() {
      const byType = {}
      for (const event of history) byType[event.type] = (byType[event.type] || 0) + 1
      return byType
    },
    /** Every live subscription, for the leak audit. */
    subscriptions() {
      return [...subscriptions].map((subscription) => ({
        type: subscription.type,
        source: subscription.source,
        delivered: subscription.delivered,
        failures: subscription.failures,
        at: subscription.at
      }))
    },
    /** How many subscriptions one plugin still holds. */
    subscriptionCount(source = null) {
      if (source === null) return subscriptions.size
      return [...subscriptions].filter((subscription) => subscription.source === source).length
    },
    stats() {
      return { ...counters, subscriptions: subscriptions.size, history: history.length }
    }
  }
}

module.exports = { createEventBus, CORE_EVENTS, DEFAULT_HISTORY }
