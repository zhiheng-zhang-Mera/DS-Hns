'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')

const { BalanceService, STATUS } = require('../../app/extensions/mega/billing/balance-service')

/**
 * MEGA-04: one refresh implementation, coalesced requests, isolated providers
 * and retention of the last successful balance.
 */

const BALANCE = { currency: 'CNY', total: 12.5, toppedUp: 10, granted: 2.5 }

function okProvider(id, label, { balances = [BALANCE], delayMs = 0 } = {}) {
  const state = { calls: 0 }
  return {
    id,
    label,
    state,
    async fetch() {
      state.calls += 1
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs))
      return { ok: true, fetchedAt: Date.now(), isAvailable: true, balances, error: null }
    }
  }
}

function failingProvider(id, label, error) {
  const state = { calls: 0 }
  return {
    id,
    label,
    state,
    async fetch() {
      state.calls += 1
      return { ok: false, fetchedAt: Date.now(), isAvailable: false, balances: [], error }
    }
  }
}

function throwingProvider(id, label, error) {
  const state = { calls: 0 }
  return {
    id,
    label,
    state,
    async fetch() {
      state.calls += 1
      throw error
    }
  }
}

function hangingProvider(id, label) {
  const state = { calls: 0 }
  return {
    id,
    label,
    state,
    async fetch() {
      state.calls += 1
      return new Promise(() => {})
    }
  }
}

test('one refresh implementation serves module-open, manual and retry', async () => {
  const provider = okProvider('A', 'Provider A')
  const service = new BalanceService({ providers: [provider] })

  const opened = await service.refreshBalances('module-open')
  assert.equal(opened.trigger, 'module-open')
  assert.equal(provider.state.calls, 1)

  const manual = await service.refreshBalances('manual')
  assert.equal(manual.trigger, 'manual')
  assert.equal(provider.state.calls, 2)

  const retried = await service.refreshBalances('retry')
  assert.equal(retried.trigger, 'retry')
  assert.equal(provider.state.calls, 3)

  // Every trigger returns the same shape and the same behaviour.
  for (const result of [opened, manual, retried]) {
    assert.equal(result.ok, true)
    assert.equal(result.balances.length, 1)
    assert.equal(result.balances[0].total, 12.5)
  }

  const unknown = await service.refreshBalances('not-a-trigger')
  assert.equal(unknown.trigger, 'manual', 'unknown triggers fall back to the manual path')
})

test('startup is a trigger like any other, and drawing never starts a read', async () => {
  /**
   * DS-Hns reads the account once as it comes up (`scheduleStartupBalanceRead`), because the dashboard would
   * otherwise say 未刷新 until somebody clicked something. Two properties make that safe and both are asserted
   * here: the read goes through the same coalescing path as every other trigger, and every *other* way of asking
   * for the state — `describe`, `describeCached` — answers from memory without calling a provider.
   */
  const provider = okProvider('A', 'Provider A')
  const service = new BalanceService({ providers: [provider] })

  // Before the startup read, the state is honest about having nothing: no data, no timestamp.
  assert.equal(service.describeCached().hasData, false)
  assert.equal(service.describeCached().lastUpdatedAt, null)
  assert.equal(provider.state.calls, 0, 'describing the account called a provider')

  const startup = await service.refreshBalances('startup')
  assert.equal(startup.trigger, 'startup')
  assert.equal(provider.state.calls, 1)
  assert.equal(startup.balances[0].total, 12.5)
  assert.equal(service.describe().stats.lastTrigger, 'startup')

  // Drawing the account afterwards is still free, and it is the *same* answer.
  const drawn = service.describeCached()
  assert.equal(provider.state.calls, 1, 'drawing the account called a provider')
  assert.equal(drawn.hasData, true)
  assert.equal(drawn.balances[0].total, 12.5)
  assert.deepEqual(drawn, service.describe())
})

test('a startup read with no credential is data, not a thrown error', async () => {
  // A machine with no DeepSeek key at all still starts: the read fails as data, the service keeps saying so, and
  // nothing about it is fatal. (The Control Center turns this state into an ordinary 未配置密钥 row rather than a
  // warning, which is why the code has to arrive intact.)
  const provider = failingProvider('A', 'Provider A', { code: 'MISSING_CREDENTIAL', message: 'DEEPSEEK_API_KEY is not set' })
  const service = new BalanceService({ providers: [provider] })
  const result = await service.refreshBalances('startup')
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'MISSING_CREDENTIAL')
  assert.equal(result.hasData, false)
  assert.equal(service.describeCached().error.code, 'MISSING_CREDENTIAL')
})

test('concurrent refresh requests are coalesced instead of fanning out', async () => {
  const provider = okProvider('A', 'Provider A', { delayMs: 30 })
  const service = new BalanceService({ providers: [provider] })

  const [first, second, third] = await Promise.all([
    service.refreshBalances('manual'),
    service.refreshBalances('manual'),
    service.refreshBalances('module-open')
  ])

  assert.equal(provider.state.calls, 1, 'a duplicate click must not start a second provider call')
  assert.equal(second.coalesced, true)
  assert.equal(third.coalesced, true)
  assert.equal(first.coalesced, false)
  assert.equal(service.describe().stats.coalesced, 2)

  // Once settled, a new request is a real refresh again.
  await service.refreshBalances('manual')
  assert.equal(provider.state.calls, 2)
})

test('provider failures are isolated and never fail the whole module', async () => {
  const providerA = okProvider('A', 'Provider A')
  const providerB = throwingProvider('B', 'Provider B', Object.assign(new Error('timed out'), { code: 'TIMEOUT' }))
  const providerC = failingProvider('C', 'Provider C', { code: 'MISSING_CREDENTIAL', message: 'DEEPSEEK_API_KEY is not set' })
  const service = new BalanceService({ providers: [providerA, providerB, providerC] })

  const result = await service.refreshBalances('module-open')

  assert.equal(result.ok, true, 'provider A succeeding keeps the module usable')
  assert.equal(result.partial, true)
  assert.deepEqual(result.failedProviders, ['B', 'C'])
  assert.equal(result.balances[0].total, 12.5, 'A: latest balance is shown')

  const byId = Object.fromEntries(result.providers.map((p) => [p.id, p]))
  assert.equal(byId.A.status, STATUS.OK)
  assert.equal(byId.B.status, STATUS.TIMEOUT)
  assert.equal(byId.C.status, STATUS.UNAVAILABLE)
  assert.match(byId.B.error.message, /timed out/)
  assert.match(byId.C.error.message, /DEEPSEEK_API_KEY/)
  assert.equal(byId.A.stale, false)
})

test('a hanging provider is reported as timeout and cannot block the module', async () => {
  const providerA = okProvider('A', 'Provider A')
  const providerHang = hangingProvider('hang', 'Hanging')
  const service = new BalanceService({ providers: [providerA, providerHang], timeoutMs: 25 })

  const result = await service.refreshBalances('manual')
  const byId = Object.fromEntries(result.providers.map((p) => [p.id, p]))
  assert.equal(byId.A.status, STATUS.OK)
  assert.equal(byId.hang.status, STATUS.TIMEOUT)
  assert.equal(result.ok, true)
})

test('the last successful balance is retained on refresh failure', async () => {
  let failing = false
  const state = { calls: 0 }
  const provider = {
    id: 'A',
    label: 'Provider A',
    async fetch() {
      state.calls += 1
      if (failing) {
        return { ok: false, fetchedAt: Date.now(), isAvailable: false, balances: [], error: { code: 'NETWORK', message: 'network unreachable' } }
      }
      return { ok: true, fetchedAt: Date.now(), isAvailable: true, balances: [{ currency: 'CNY', total: 88, toppedUp: 80, granted: 8 }], error: null }
    }
  }
  const service = new BalanceService({ providers: [provider] })

  const good = await service.refreshBalances('module-open')
  const goodUpdatedAt = good.lastUpdatedAt
  assert.equal(good.balances[0].total, 88)

  failing = true
  const bad = await service.refreshBalances('manual')

  assert.equal(bad.ok, false)
  assert.equal(bad.hasData, true, 'the retained value stays renderable')
  assert.equal(bad.balances[0].total, 88, 'a failed refresh must not blank the balance to 0/null/--')
  assert.equal(bad.stale, true)
  assert.equal(bad.lastUpdatedAt, goodUpdatedAt, 'last updated only moves on a valid payload')
  assert.ok(bad.lastAttemptAt > 0, 'the failed attempt is still recorded')
  assert.match(bad.error.message, /network unreachable/)
})

test('a never-succeeded provider reports no data and no timestamp', async () => {
  const service = new BalanceService({ providers: [throwingProvider('A', 'Provider A', new Error('offline'))] })
  const result = await service.refreshBalances('module-open')
  assert.equal(result.ok, false)
  assert.equal(result.hasData, false)
  assert.equal(result.lastUpdatedAt, null)
  assert.equal(result.stale, false)
  assert.deepEqual(result.balances, [])
})

test('retry refetches only the providers that failed', async () => {
  const providerA = okProvider('A', 'Provider A')
  const providerB = throwingProvider('B', 'Provider B', new Error('down'))
  const service = new BalanceService({ providers: [providerA, providerB] })

  await service.refreshBalances('module-open')
  assert.equal(providerA.state.calls, 1)
  assert.equal(providerB.state.calls, 1)

  const before = service.describe()
  const retried = await service.refreshBalances('retry', { only: before.failedProviders })

  assert.deepEqual(before.failedProviders, ['B'])
  assert.equal(providerA.state.calls, 1, 'the healthy provider is untouched by a retry')
  assert.equal(providerB.state.calls, 2)
  assert.equal(retried.trigger, 'retry')
  assert.equal(retried.providers.find((p) => p.id === 'A').status, STATUS.OK)
})

test('a provider without an id or fetch function is rejected loudly at registration', () => {
  assert.throws(() => new BalanceService({ providers: [{ label: 'no id' }] }), /provider id is required/)
  assert.throws(() => new BalanceService({ providers: [{ id: 'x' }] }), /requires a fetch function/)
})
