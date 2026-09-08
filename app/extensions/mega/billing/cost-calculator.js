'use strict'
const { statusAt } = require('./peak-engine')

/**
 * CostCalculator — bills real usage events against PricingRepository rates.
 *
 * Token usage is always taken from real adapter-reported accounting
 * (assistant/message events in dsh session logs). DeepSeek normalized usage:
 *   inputTokens            = uncached input
 *   cacheReadTokens        = cache hit input
 *   cacheWriteTokens       = reported cache write (billed conservatively at miss rate)
 *   outputTokens           = billed output
 */

function billEvent(event, model, schedule) {
  const t = event.time ?? Date.now()
  const rate = statusAt(t, schedule) === 'PEAK' ? 'peak' : 'offPeak'
  const hit = (event.cacheReadTokens || 0) * (model.inputCacheHit?.[rate] || 0)
  const miss =
    ((event.inputTokens || 0) + (event.cacheWriteTokens || 0)) *
    (model.inputCacheMiss?.[rate] || 0)
  const out = (event.outputTokens || 0) * (model.output?.[rate] || 0)
  return {
    timeMs: t,
    period: rate,
    status: statusAt(t, schedule),
    cny: (hit + miss + out) / 1_000_000,
    breakdown: {
      inputTokens: event.inputTokens || 0,
      cacheReadTokens: event.cacheReadTokens || 0,
      cacheWriteTokens: event.cacheWriteTokens || 0,
      outputTokens: event.outputTokens || 0
    }
  }
}

/**
 * Splits cost across price periods at event granularity. A task whose events
 * straddle a period boundary is labelled Estimated because no per-token
 * timestamp exists inside one API stream.
 */
function calculateTaskCost({ events = [], model, schedule }) {
  if (!model || !events.length) {
    return { estimated: false, costCny: 0, lines: [], tokens: {}, reason: model ? 'no usage events' : 'unknown model' }
  }
  const lines = []
  let total = 0
  const tokens = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  const first = events[0]?.time
  const last = events[events.length - 1]?.time
  const nearBoundary = first != null && last != null
    ? (() => {
        const lo = Math.min(first, last)
        const hi = Math.max(first, last)
        if (hi - lo < 120 * 1000) return false
        let previous = statusAt(lo, schedule)
        for (let t = lo + 60 * 1000; t <= hi; t += 60 * 1000) {
          const current = statusAt(t, schedule)
          if (current !== previous) return true
        }
        return false
      })()
    : false

  for (const ev of events) {
    tokens.inputTokens += ev.inputTokens || 0
    tokens.cacheReadTokens += ev.cacheReadTokens || 0
    tokens.cacheWriteTokens += ev.cacheWriteTokens || 0
    tokens.outputTokens += ev.outputTokens || 0
    const line = billEvent(ev, model, schedule)
    lines.push(line)
    total += line.cny
  }
  const used = tokens.inputTokens + tokens.cacheReadTokens + tokens.cacheWriteTokens + tokens.outputTokens
  return {
    estimated: nearBoundary,
    costCny: Number(total.toFixed(6)),
    lines,
    tokens,
    tokenTotal: used
  }
}

module.exports = { billEvent, calculateTaskCost }
