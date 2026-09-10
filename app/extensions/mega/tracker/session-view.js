'use strict'

/**
 * Renderer projection for tracked DSH sessions.
 *
 * Presentation is not the historical record: the session reader stays the full
 * source of truth, while this projection narrows a session summary down to the
 * fields the Mega UI actually renders.
 *
 * MEGA-02 removed the "Recent Session Cost" UI feature. The session token
 * events and the per-session cost figure existed only to feed that widget, so
 * they are no longer projected. The billing layer itself
 * (pricing-repository / peak-engine / cost-calculator) is untouched and stays
 * available for accounting, telemetry and future surfaces.
 *
 * Legacy records that still carry cost fields are ignored safely: unknown or
 * removed keys are dropped instead of being forwarded, so an old
 * `recentSessionCost`, `sessionCost`, `recent_cost`, `costCny` or `cost`
 * object can never reach a renderer binding and can never raise.
 */

const LEGACY_COST_KEYS = Object.freeze([
  'cost',
  'sessionCost',
  'recentSessionCost',
  'recent_cost',
  'recentSessionCosts',
  'costCny',
  'estimatedCost',
  'costLines'
])

function numberOrNull(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function finiteNumber(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function tokenUsage(usage) {
  const u = usage && typeof usage === 'object' ? usage : {}
  const out = {
    inputTokens: finiteNumber(u.inputTokens),
    outputTokens: finiteNumber(u.outputTokens),
    cacheReadTokens: finiteNumber(u.cacheReadTokens),
    cacheWriteTokens: finiteNumber(u.cacheWriteTokens),
    reasoningTokens: finiteNumber(u.reasoningTokens)
  }
  out.totalTokens = out.inputTokens + out.outputTokens + out.reasoningTokens
  return out
}

function normalizeError(error) {
  if (!error) return null
  if (typeof error === 'string') return { code: 'ERROR', message: error }
  return { code: error.code || 'ERROR', message: String(error.message || '') }
}

/** Drops every legacy/removed presentation key from a raw session record. */
function withoutLegacyCostFields(session) {
  const source = session && typeof session === 'object' ? session : {}
  const clean = {}
  for (const [key, value] of Object.entries(source)) {
    if (LEGACY_COST_KEYS.some((legacy) => legacy.toLowerCase() === key.toLowerCase())) continue
    clean[key] = value
  }
  return clean
}

function toSessionView(session) {
  const raw = withoutLegacyCostFields(session)
  return {
    id: raw.id ?? null,
    group: raw.group ?? null,
    cwd: raw.cwd ?? null,
    status: raw.status || 'UNKNOWN',
    model: raw.model ?? null,
    provider: raw.provider ?? null,
    createdAt: numberOrNull(raw.createdAt),
    updatedAt: numberOrNull(raw.updatedAt ?? raw.lastEventAt),
    fileMtimeMs: numberOrNull(raw.fileMtimeMs),
    lastSeq: numberOrNull(raw.lastSeq),
    error: normalizeError(raw.error),
    usage: tokenUsage(raw.usage)
  }
}

function toSessionViews(list, { limit = 40 } = {}) {
  if (!Array.isArray(list)) return []
  const views = list.filter((item) => item && typeof item === 'object').map(toSessionView)
  return limit ? views.slice(0, limit) : views
}

module.exports = { toSessionView, toSessionViews, withoutLegacyCostFields, tokenUsage, LEGACY_COST_KEYS }
