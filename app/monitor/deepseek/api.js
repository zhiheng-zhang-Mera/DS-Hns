'use strict'

/**
 * BalanceService — thin, isolated DeepSeek API client.
 * Failures are returned as data and never thrown into the harness.
 */

const DEFAULT_BASE = 'https://api.deepseek.com'

async function requestJson(path, { baseUrl = DEFAULT_BASE, apiKey, timeoutMs = 15000 } = {}) {
  const key = apiKey ?? process.env.DEEPSEEK_API_KEY
  if (!key) {
    return { ok: false, status: 0, error: { code: 'MISSING_CREDENTIAL', message: 'DEEPSEEK_API_KEY is not set' } }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: controller.signal
    })
    const body = await res.json().catch(() => null)
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: { code: 'HTTP_' + res.status, message: body?.error?.message || body?.message || `HTTP ${res.status}` }
      }
    }
    return { ok: true, status: res.status, data: body }
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: { code: err.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK', message: String(err?.message || err) }
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * GET /user/balance -> DeepSeek platform account state.
 * Shape: { is_available, balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }] }
 */
async function fetchBalance(opts = {}) {
  const out = await requestJson('/user/balance', opts)
  if (!out.ok) {
    return { ok: false, fetchedAt: Date.now(), isAvailable: false, balances: [], error: out.error }
  }
  const infos = Array.isArray(out.data?.balance_infos) ? out.data.balance_infos : []
  return {
    ok: true,
    fetchedAt: Date.now(),
    isAvailable: out.data.is_available !== false,
    balances: infos.map((b) => ({
      currency: b.currency || 'CNY',
      total: Number(b.total_balance ?? 0),
      toppedUp: Number(b.topped_up_balance ?? 0),
      granted: Number(b.granted_balance ?? 0)
    })),
    error: null
  }
}

module.exports = { fetchBalance, requestJson, DEFAULT_BASE }
