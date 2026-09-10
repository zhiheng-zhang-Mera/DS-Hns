'use strict'
const { TERMINAL_EVENT, terminalKey, terminalState } = require('../scheduler/lifecycle')

/**
 * Unified terminal alert dispatcher (refix.md §8).
 *
 * Every terminal event — whichever observer produced it — passes through this
 * single dispatcher so one terminal state can only ever ring once and notify
 * once:
 *
 *   ordinary official Harness session ─┐
 *   scheduler official session ────────┼─> TASK_TERMINATED ─> dispatcher ─┬─> ringtone
 *   headless task ─────────────────────┘                                  └─> desktop notification
 *
 * Both side effects are individually isolated: a ringtone or notification
 * failure is reported as data and can never change the task's final state.
 */

const DEFAULT_DEDUP_LIMIT = 500

function keyFor(event) {
  if (!event || typeof event !== 'object') return null
  if (event.terminalKey) return String(event.terminalKey)
  const state = terminalState(event.finalStatus || event.status)
  if (!state) return null
  return terminalKey(event, state)
}

function createTerminalDispatcher({
  ring = null,
  notify = null,
  log = null,
  dedupLimit = DEFAULT_DEDUP_LIMIT
} = {}) {
  const delivered = new Set()
  const stats = { delivered: 0, rung: 0, notified: 0, duplicates: 0, ringFailures: 0, notifyFailures: 0 }

  function remember(key) {
    delivered.add(key)
    if (delivered.size > Math.max(1, Number(dedupLimit) || DEFAULT_DEDUP_LIMIT)) {
      const oldest = delivered.values().next().value
      delivered.delete(oldest)
    }
  }

  /** @returns {{key:string|null, delivered:boolean, rung:boolean, notified:boolean, reason:string}} */
  function dispatch(event) {
    const result = { key: null, delivered: false, rung: false, notified: false, reason: 'not-terminal' }
    try {
      if (!event || (event.type && event.type !== TERMINAL_EVENT)) return result
      const key = keyFor(event)
      if (!key) return result
      result.key = key

      // One terminal state, one alert - no matter how many observers saw it.
      if (delivered.has(key)) {
        stats.duplicates += 1
        result.reason = 'duplicate'
        return result
      }
      remember(key)
      stats.delivered += 1
      result.delivered = true
      result.reason = 'delivered'

      if (typeof ring === 'function') {
        try {
          ring(event)
          result.rung = true
          stats.rung += 1
        } catch (error) {
          stats.ringFailures += 1
          log?.(`ringtone failed for ${event.taskId || key}: ${error?.message || error}`)
        }
      }
      if (typeof notify === 'function') {
        try {
          const outcome = notify(event)
          result.notified = Boolean(outcome?.sent)
          stats.notified += result.notified ? 1 : 0
          const reason = String(outcome?.reason || '')
          if (!result.notified && reason.startsWith('error:')) {
            stats.notifyFailures += 1
            log?.(`desktop notification failed for ${event.taskId || key}: ${reason}`)
          }
        } catch (error) {
          stats.notifyFailures += 1
          log?.(`desktop notification threw for ${event.taskId || key}: ${error?.message || error}`)
        }
      }
      return result
    } catch (error) {
      log?.(`terminal dispatch failed: ${error?.stack || error}`)
      result.reason = `error:${error?.message || error}`
      return result
    }
  }

  return {
    dispatch,
    describe: () => ({ ...stats, delivered: delivered.size, dedupLimit: Math.max(1, Number(dedupLimit) || DEFAULT_DEDUP_LIMIT) }),
    /** Test/diagnostics helper. */
    reset: () => { delivered.clear() },
    has: (key) => delivered.has(String(key))
  }
}

module.exports = { createTerminalDispatcher, keyFor, DEFAULT_DEDUP_LIMIT }
