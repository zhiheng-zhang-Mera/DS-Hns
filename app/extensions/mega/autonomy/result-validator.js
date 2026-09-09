'use strict'

/**
 * DS-Hns autonomy: result validator (Owner-Result.md Rev.2 §20–§22, §42).
 *
 * MODEL_DONE ≠ COMPLETED. An episode whose model/session reports “done” only
 * enters VERIFYING; the scheduler may mark it COMPLETED only when the evidence
 * gates for its delivery mode actually pass. Anything missing forces REWORK
 * (bounded retry) — never a silent PASS. Gate plans scale with risk.
 */

const DELIVERY_GATES = Object.freeze({
  headless: ['exit-ok', 'log-nonempty', 'artifacts'],
  'official-session': ['artifacts', 'blank-false', 'seen-running']
})

const RISK_PLANS = Object.freeze({
  low: ['exit-ok'],
  medium: ['exit-ok', 'log-nonempty'],
  high: null, // → full delivery gates
  critical: null
})

function planFor(kind, risk) {
  const base = DELIVERY_GATES[kind] || DELIVERY_GATES.headless
  if (risk === 'high' || risk === 'critical') return [...base]
  const subset = RISK_PLANS[risk] || RISK_PLANS.medium
  return [...subset]
}

/**
 * @param {object} input
 * @param {string} input.kind            'headless' | 'official-session' | ...
 * @param {'low'|'medium'|'high'|'critical'} [input.risk]
 * @param {boolean} [input.modelDoneOnly] model finished but no evidence gathered yet
 * @param {Array<{gate:string, evidence?:string, error?:string}>} input.results
 * @returns {{phase:'VERIFYING'|'PASS'|'REWORK', verdict:'PASS'|'REWORK', plan:string[], ran:string[], missing:string[], passed:string[]}}
 */
function verify({ kind, risk = 'high', modelDoneOnly = false, results = [] }) {
  const plan = planFor(kind, risk)
  if (modelDoneOnly) {
    return { phase: 'VERIFYING', verdict: 'REWORK', plan, ran: [], missing: plan, passed: [] }
  }
  const passedSet = new Set(results.filter((r) => !r.error && r.evidence && String(r.evidence).trim()).map((r) => r.gate))
  const missing = plan.filter((gate) => !passedSet.has(gate))
  const passed = plan.filter((gate) => !missing.includes(gate))
  const ok = missing.length === 0 && plan.length > 0
  return {
    phase: ok ? 'PASS' : 'REWORK',
    verdict: ok ? 'PASS' : 'REWORK',
    plan,
    ran: results.map((r) => r.gate),
    missing,
    passed
  }
}

module.exports = { DELIVERY_GATES, planFor, verify }
