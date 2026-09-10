'use strict'
const api = require('../deepseek/api')

/**
 * BalanceService (MEGA-04).
 *
 * One refresh implementation serves every trigger:
 *
 *     refreshBalances(trigger)        trigger = module-open | manual | retry
 *
 * - auto and manual refresh share this code path;
 * - concurrent requests are coalesced instead of fanning out a second set of
 *   provider calls;
 * - providers are isolated: A ok / B timeout / C unavailable never turns the
 *   whole Balance module into a failure;
 * - the last successful value is retained on failure and marked stale instead
 *   of being blanked to 0/null/--;
 * - last-updated only moves when a refresh actually returned valid data.
 *
 * Failures are returned as data and never thrown into the harness.
 */

const TRIGGERS = Object.freeze(['module-open', 'manual', 'retry'])
const STATUS = Object.freeze({
  IDLE: 'idle',
  OK: 'ok',
  FAILED: 'failed',
  TIMEOUT: 'timeout',
  UNAVAILABLE: 'unavailable',
  PENDING: 'pending'
})

function timeoutError(ms) {
  const error = new Error(`provider timed out after ${ms}ms`)
  error.code = 'TIMEOUT'
  return error
}

function withTimeout(promise, ms) {
  if (!ms || ms <= 0) return Promise.resolve(promise)
  let timer = null
  return Promise.race([
    Promise.resolve(promise).finally(() => { if (timer) clearTimeout(timer) }),
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(timeoutError(ms)), ms)
      if (typeof timer.unref === 'function') timer.unref()
    })
  ])
}

function classifyFailure(error) {
  const code = String(error?.code || '').toUpperCase()
  if (code === 'TIMEOUT' || code === 'ABORT_ERR') return STATUS.TIMEOUT
  if (code === 'MISSING_CREDENTIAL' || code === 'UNCONFIGURED' || code === 'UNAVAILABLE') return STATUS.UNAVAILABLE
  return STATUS.FAILED
}

function normalizeBalances(value) {
  if (!Array.isArray(value)) return []
  return value
    .filter((row) => row && typeof row === 'object')
    .map((row) => ({
      currency: row.currency || 'CNY',
      total: Number(row.total ?? 0),
      toppedUp: Number(row.toppedUp ?? 0),
      granted: Number(row.granted ?? 0)
    }))
}

function defaultProviders() {
  return [
    {
      id: 'deepseek-official',
      label: 'DeepSeek 官方',
      fetch: (options) => api.fetchBalance(options)
    }
  ]
}

class BalanceService {
  /**
   * @param {object} [options]
   * @param {Array} [options.providers] provider definitions
   * @param {number} [options.timeoutMs] per-provider hard timeout
   * @param {Function} [options.now]
   * @param {Function} [options.log]
   */
  constructor({ providers = null, timeoutMs = 20_000, now = () => Date.now(), log = null } = {}) {
    this.now = now
    this.log = log
    this.timeoutMs = Math.max(1, Number(timeoutMs) || 20_000)
    this.providers = new Map()
    this.inFlight = null
    this.refreshing = false
    this.stats = { refreshes: 0, coalesced: 0, providerFailures: 0, lastTrigger: null, lastStartedAt: null, lastFinishedAt: null }
    for (const provider of providers || defaultProviders()) this.registerProvider(provider)
  }

  registerProvider({ id, label, fetch, timeoutMs = null } = {}) {
    const key = String(id || '').trim()
    if (!key) throw new Error('balance provider id is required')
    if (typeof fetch !== 'function') throw new Error(`balance provider ${key} requires a fetch function`)
    this.providers.set(key, {
      id: key,
      label: label || key,
      fetch,
      timeoutMs: Number(timeoutMs) > 0 ? Number(timeoutMs) : this.timeoutMs,
      status: STATUS.IDLE,
      balances: [],
      isAvailable: null,
      error: null,
      lastSuccessAt: null,
      lastAttemptAt: null,
      stale: false,
      attempts: 0,
      failures: 0
    })
    return this.providers.get(key)
  }

  listProviders() {
    return [...this.providers.values()]
  }

  primary() {
    return this.providers.values().next().value || null
  }

  /**
   * The single refresh implementation. Auto (module-open) and manual share it
   * and behave identically apart from the recorded trigger.
   */
  async refreshBalances(trigger = 'manual', { only = null } = {}) {
    const normalized = TRIGGERS.includes(trigger) ? trigger : 'manual'
    if (this.inFlight) {
      // Coalesce: a second request while refreshing reuses the in-flight call
      // instead of starting a parallel provider fan-out.
      this.stats.coalesced += 1
      const result = await this.inFlight
      return { ...result, coalesced: true, trigger: normalized }
    }
    const run = this.runRefresh(normalized, { only })
    this.inFlight = run
    this.refreshing = true
    try {
      return await run
    } finally {
      this.inFlight = null
      this.refreshing = false
    }
  }

  async runRefresh(trigger, { only = null } = {}) {
    const startedAt = this.now()
    this.stats.refreshes += 1
    this.stats.lastTrigger = trigger
    this.stats.lastStartedAt = startedAt
    const scoped = Array.isArray(only) && only.length ? only.map(String) : null
    const targets = this.listProviders().filter((p) => (scoped ? scoped.includes(p.id) : true))
    for (const provider of targets) {
      if (provider.status !== STATUS.OK) provider.status = STATUS.PENDING
    }

    const results = await Promise.all(targets.map((provider) => this.refreshProvider(provider, trigger)))
    this.stats.lastFinishedAt = this.now()
    // This run has just finished: it reports a settled (non-coalesced) state.
    return { ...this.describe(), trigger, refreshing: false, coalesced: false, results }
  }

  async refreshProvider(provider, trigger) {
    const attemptAt = this.now()
    provider.lastAttemptAt = attemptAt
    provider.attempts += 1
    try {
      const result = await withTimeout(
        Promise.resolve().then(() => provider.fetch({ timeoutMs: provider.timeoutMs, trigger })),
        provider.timeoutMs
      )
      if (!result || result.ok !== true) {
        const error = result?.error || { code: 'NO_RESULT', message: 'provider returned no result' }
        return this.failProvider(provider, classifyFailure(error), error)
      }
      const balances = normalizeBalances(result.balances)
      provider.balances = balances
      provider.isAvailable = result.isAvailable !== false
      provider.error = null
      provider.stale = false
      // Only a valid payload moves the last-updated marker.
      provider.lastSuccessAt = attemptAt
      provider.status = balances.length ? STATUS.OK : STATUS.UNAVAILABLE
      return { id: provider.id, ok: provider.status === STATUS.OK, status: provider.status }
    } catch (error) {
      return this.failProvider(provider, classifyFailure(error), error)
    }
  }

  failProvider(provider, status, error) {
    provider.status = status
    provider.error = { code: error?.code || 'ERROR', message: String(error?.message || error) }
    // Keep the last successful balance visible and label it as stale.
    provider.stale = provider.balances.length > 0
    provider.failures += 1
    this.stats.providerFailures += 1
    this.log?.(`balance provider ${provider.id} failed (${status}): ${provider.error.message}`)
    return { id: provider.id, ok: false, status, error: provider.error }
  }

  /**
   * Public, renderer-safe state. The primary provider result is flattened onto
   * the top level so existing renderer bindings keep working.
   */
  describe() {
    const primary = this.primary()
    const providers = this.listProviders().map((p) => ({
      id: p.id,
      label: p.label,
      status: p.status,
      balances: p.balances.map((b) => ({ ...b })),
      isAvailable: p.isAvailable,
      stale: p.stale,
      lastUpdatedAt: p.lastSuccessAt,
      lastAttemptAt: p.lastAttemptAt,
      attempts: p.attempts,
      failures: p.failures,
      error: p.error ? { ...p.error } : null
    }))
    const failed = providers.filter((p) =>
      p.status === STATUS.FAILED || p.status === STATUS.TIMEOUT || p.status === STATUS.UNAVAILABLE)
    const okCount = providers.filter((p) => p.status === STATUS.OK).length
    const lastUpdatedAt = primary?.lastSuccessAt || null
    return {
      refreshing: this.refreshing,
      trigger: this.stats.lastTrigger,
      stats: { ...this.stats },
      providers,
      providerCount: providers.length,
      failedProviders: failed.map((p) => p.id),
      partial: okCount > 0 && failed.length > 0,
      ok: okCount > 0,
      hasData: providers.some((p) => p.balances.length > 0),
      // Flattened primary-provider result (backward compatible shape).
      fetchedAt: lastUpdatedAt,
      lastUpdatedAt,
      lastAttemptAt: primary?.lastAttemptAt || null,
      isAvailable: primary?.isAvailable ?? false,
      balances: primary ? primary.balances.map((b) => ({ ...b })) : [],
      stale: Boolean(primary?.stale),
      error: primary?.error ? { ...primary.error } : null
    }
  }
}

module.exports = {
  BalanceService,
  TRIGGERS,
  STATUS,
  defaultProviders
}
