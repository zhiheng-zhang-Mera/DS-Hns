'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { PATHS, readJson } = require('../utils/paths')
const {
  TERMINAL_EVENT,
  CANONICAL_TERMINAL,
  terminalState,
  terminalKey,
  taskDisplayName,
  errorSummary,
  statusLabel
} = require('../scheduler/lifecycle')

/**
 * Terminal notification service (MEGA-03).
 *
 * One unified lifecycle capability: every task that the main Harness manages
 * and that reaches a terminal state is announced through this service — no
 * scheduler/task handler sends its own notification.
 *
 * Rules enforced here:
 *   - a single terminal transition notifies at most once (taskId + state + epoch);
 *   - notification is a side effect: a failure is reported as data, never thrown
 *     into the task completion path;
 *   - DESKTOP notifications are separate from the existing ringtone service,
 *     which keeps owning sound.
 *
 * Configuration lives in config\notifications.json:
 *   { enabled, onCompleted, onFailed, onCancelled, silent }
 */

const CONFIG_NAME = 'notifications.json'
const CONFIG_FILE = path.join(PATHS.CONFIG, CONFIG_NAME)
const APP_TITLE = 'DS-Hns'
const DEFAULT_DEDUP_LIMIT = 500

function defaults() {
  return {
    enabled: true,
    onCompleted: true,
    onFailed: true,
    // Cancelled runs keep notifying by default; the switch exists so an
    // operator can silence them without touching the other states.
    onCancelled: true,
    // The ringtone service already plays a completion/failure bell, so the
    // desktop toast itself stays silent unless explicitly turned on.
    silent: true
  }
}

function normalize(raw) {
  const base = defaults()
  if (!raw || typeof raw !== 'object') return base
  const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback)
  return {
    enabled: bool(raw.enabled, base.enabled),
    onCompleted: bool(raw.onCompleted, base.onCompleted),
    onFailed: bool(raw.onFailed, base.onFailed),
    // `notifyOnCancelled` is accepted as a legacy/alternate alias on input.
    onCancelled: bool(raw.onCancelled, bool(raw.notifyOnCancelled, base.onCancelled)),
    silent: bool(raw.silent, base.silent)
  }
}

function loadConfig() {
  return normalize(readJson(CONFIG_NAME, null))
}

function saveConfig(patch = {}) {
  const next = normalize({ ...loadConfig(), ...patch })
  try {
    fs.mkdirSync(PATHS.CONFIG, { recursive: true })
    fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  } catch {
    // Configuration persistence must never break task completion.
  }
  return next
}

function allowedForState(state, config) {
  if (state === CANONICAL_TERMINAL.COMPLETED) return config.onCompleted !== false
  if (state === CANONICAL_TERMINAL.FAILED_FINAL) return config.onFailed !== false
  if (state === CANONICAL_TERMINAL.CANCELLED) return config.onCancelled !== false
  return false
}

/**
 * Pure content builder. Follows the product copy contract:
 *   DS-Hns
 *   Task completed: <task name>
 *
 *   Status: Completed
 *   Finished: 14:32
 */
function buildTerminalNotification(event, now = Date.now()) {
  const name = taskDisplayName(event)
  const state = terminalState(event?.finalStatus || event?.status) || CANONICAL_TERMINAL.CANCELLED
  if (state === CANONICAL_TERMINAL.COMPLETED) {
    const at = Number(event?.completedAt) || now
    const clock = new Date(at).toLocaleTimeString('zh-CN', { hour12: false }).slice(0, 5)
    return {
      title: APP_TITLE,
      body: `Task completed: ${name}\n\nStatus: ${statusLabel(state)}\nFinished: ${clock}`
    }
  }
  if (state === CANONICAL_TERMINAL.FAILED_FINAL) {
    const detail = errorSummary(event?.errorSummary ?? event?.error, 160) || 'no error details recorded'
    return {
      title: APP_TITLE,
      body: `Task failed: ${name}\n\n${detail}`
    }
  }
  return {
    title: APP_TITLE,
    body: `Task cancelled: ${name}\n\nStatus: ${statusLabel(state)}`
  }
}

class NotificationService {
  /**
   * @param {object} options
   * @param {Function} [options.createNotification] Electron `Notification`
   *        constructor-compatible factory. Absent -> desktop notifications are
   *        reported as unsupported instead of throwing.
   * @param {Function} [options.clock]
   * @param {Function} [options.log]
   * @param {Function} [options.onClick]
   */
  constructor({ createNotification = null, clock = () => Date.now(), log = null, onClick = null, dedupLimit = DEFAULT_DEDUP_LIMIT } = {}) {
    this.createNotification = createNotification
    this.clock = clock
    this.log = log
    this.onClick = onClick
    this.dedupLimit = Math.max(1, Number(dedupLimit) || DEFAULT_DEDUP_LIMIT)
    this.notified = new Set()
    this.stats = { attempted: 0, sent: 0, skipped: 0, failed: 0 }
  }

  /** Late-bound Electron binding; keeps this module testable without Electron. */
  setCreateNotification(createNotification) {
    this.createNotification = createNotification || null
  }

  setOnClick(onClick) {
    this.onClick = onClick || null
  }

  supported() {
    const factory = this.createNotification
    if (typeof factory !== 'function') return false
    if (typeof factory.isSupported === 'function') {
      try {
        return Boolean(factory.isSupported())
      } catch {
        return false
      }
    }
    return true
  }

  describe() {
    const config = loadConfig()
    return { ...config, supported: this.supported(), stats: { ...this.stats } }
  }

  updateConfig(patch) {
    return saveConfig(patch || {})
  }

  /** True when this exact terminal transition was already announced. */
  alreadyNotified(key) {
    return Boolean(key) && this.notified.has(String(key))
  }

  remember(key) {
    if (!key) return
    const value = String(key)
    this.notified.add(value)
    if (this.notified.size > this.dedupLimit) {
      const oldest = this.notified.values().next().value
      this.notified.delete(oldest)
    }
  }

  /**
   * Announce one terminal event. Never throws: returns a result object instead.
   *
   * @returns {{sent:boolean, skipped:boolean, reason:string, key:string|null}}
   */
  notifyTerminal(event, { force = false } = {}) {
    const result = { sent: false, skipped: true, reason: 'unknown', key: null }
    try {
      if (!event || (event.type && event.type !== TERMINAL_EVENT)) {
        result.reason = 'not-a-terminal-event'
        return result
      }
      const key = event.terminalKey || terminalKey(event, event.finalStatus || event.status)
      result.key = key
      // Internal continuations (peak pause / stall retry) are not user-visible
      // outcomes; the follow-up attempt announces the logical work instead.
      if (event.silent === true && !force) {
        result.reason = 'silent'
        this.stats.skipped += 1
        return result
      }
      // Bulk cancellation (清空等待) is a user batch action and must not
      // produce one toast per task; single transitions always notify.
      if (event.bulk === true && !force) {
        result.reason = 'bulk-suppressed'
        this.stats.skipped += 1
        return result
      }
      const config = loadConfig()
      if (!config.enabled) {
        result.reason = 'disabled'
        this.stats.skipped += 1
        return result
      }
      const state = terminalState(event.finalStatus || event.status)
      if (!state) {
        result.reason = 'not-terminal'
        this.stats.skipped += 1
        return result
      }
      if (!force && !allowedForState(state, config)) {
        result.reason = `state-disabled:${state}`
        this.stats.skipped += 1
        return result
      }
      if (!force && this.alreadyNotified(key)) {
        result.reason = 'duplicate'
        this.stats.skipped += 1
        return result
      }
      if (!this.supported()) {
        result.reason = 'unsupported'
        this.stats.skipped += 1
        return result
      }

      const content = buildTerminalNotification({ ...event, ...(event.completedAt ? {} : { completedAt: this.clock() }) })
      const notification = new this.createNotification({ title: content.title, body: content.body, silent: config.silent !== false })
      if (notification && typeof notification.on === 'function') {
        notification.on('failed', (_event, error) => {
          this.stats.failed += 1
          this.log?.(`desktop notification failed for ${key}: ${error || 'unknown'}`)
        })
        notification.on('click', () => {
          try {
            this.onClick?.(event)
          } catch (error) {
            this.log?.(`notification click handler failed: ${error?.message || error}`)
          }
        })
      }
      this.remember(key)
      this.stats.attempted += 1
      if (notification && typeof notification.show === 'function') notification.show()
      this.stats.sent += 1
      result.sent = true
      result.skipped = false
      result.reason = 'sent'
      return result
    } catch (error) {
      // A notification must never change an already final task state.
      this.stats.failed += 1
      try {
        this.log?.(`desktop notification threw: ${error?.stack || error}`)
      } catch {}
      result.sent = false
      result.skipped = true
      result.reason = `error:${error?.message || error}`
      return result
    }
  }
}

const singleton = new NotificationService()

module.exports = {
  NotificationService,
  service: singleton,
  defaults,
  normalize,
  loadConfig,
  saveConfig,
  buildTerminalNotification,
  allowedForState,
  CONFIG_FILE,
  APP_TITLE,
  // Convenience delegates used by the extension entry point.
  notifyTerminal: (event, options) => singleton.notifyTerminal(event, options),
  describe: () => singleton.describe(),
  updateConfig: (patch) => singleton.updateConfig(patch),
  setCreateNotification: (factory) => singleton.setCreateNotification(factory),
  setOnClick: (handler) => singleton.setOnClick(handler)
}
