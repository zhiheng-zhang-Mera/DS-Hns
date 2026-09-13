'use strict'

/**
 * DS-Hns acceleration: tool batching.
 *
 * A model round trip per file read is the single largest avoidable cost in an
 * inspection step: `search → read → read → diff → read` is five round trips that
 * were one question. Batching turns them into one *program* of read-side tools and
 * one round trip.
 *
 * The rule that makes it safe, and the reason this is a module rather than a flag,
 * is the boundary:
 *
 *   **high-risk writes are never batched.** A patch, a delete, a publish or a
 *   commit is a mutation with its own verification and its own recovery; folding it
 *   into a batch would mean the batch's failure is ambiguous and a partial write
 *   has no owner. Only read-side and independent operations are batched.
 *
 * A batch is also bounded: a maximum number of calls, a maximum total cost, and a
 * maximum output size. A plan that exceeds them is split, and the split is
 * reported, because "the batch silently dropped half the reads" is how a model ends
 * up reasoning about a file it never saw.
 */

/** Which operations may be batched, and how they are classified. */
const OPERATION_CLASS = Object.freeze({
  search: 'read',
  read: 'read',
  inspect: 'read',
  list: 'read',
  glob: 'read',
  grep: 'read',
  diff: 'read',
  'repo-map': 'read',
  'test-discovery': 'read',
  'dependency-lookup': 'read',
  write: 'write',
  patch: 'write',
  delete: 'write',
  mkdir: 'write',
  move: 'write',
  rename: 'write',
  commit: 'write',
  push: 'write',
  publish: 'write',
  install: 'write'
})

const DEFAULT_LIMITS = Object.freeze({
  maxCalls: 12,
  maxOutputBytes: 256 * 1024,
  /** Independent writes *may* be batched only when they cannot interact. */
  allowIndependentWrites: false
})

function classifyOperation(name) {
  return OPERATION_CLASS[String(name)] || 'unknown'
}

/**
 * Plan a batch.
 *
 * @param {object} input
 * @param {object[]} input.calls `[{ operation, detail, cost }]`
 * @param {Function} [input.independent] `(a, b) => boolean`, for write batching
 * @param {object} [input.limits]
 * @returns {{batches:object[][], refused:object[], reason:string}}
 */
function planBatch(input = {}) {
  const limits = { ...DEFAULT_LIMITS, ...(input.limits || {}) }
  const calls = Array.isArray(input.calls) ? input.calls.filter(Boolean) : []
  const independent = typeof input.independent === 'function' ? input.independent : () => false
  const batches = []
  const refused = []
  let current = []
  let cost = 0

  const flush = () => {
    if (current.length) batches.push(current)
    current = []
    cost = 0
  }

  for (const call of calls) {
    const operation = String(call.operation || '')
    const classification = classifyOperation(operation)
    if (classification === 'write' && limits.allowIndependentWrites !== true) {
      // The boundary: a write is never folded into a read batch, whatever its size.
      refused.push({ ...call, reason: `"${operation}" is a write and writes are not batched` })
      continue
    }
    if (classification === 'write' && current.some((entry) => !independent(entry, call))) {
      refused.push({ ...call, reason: `"${operation}" is not independent of the batch` })
      continue
    }
    if (classification === 'unknown') {
      refused.push({ ...call, reason: `"${operation}" is not a known batched operation` })
      continue
    }
    const callCost = Number.isFinite(call.cost) ? Number(call.cost) : 1
    if (current.length >= limits.maxCalls || cost + callCost > limits.maxOutputBytes) flush()
    current.push({ ...call, classification })
    cost += callCost
  }
  flush()
  return {
    batches,
    refused,
    batches_: batches.length,
    calls: calls.length,
    batched: batches.reduce((total, batch) => total + batch.length, 0),
    reason: `${batches.length} batch(es) for ${calls.length} call(s)`
  }
}

/**
 * Execute a batch.
 *
 * A batch stops at its first failure rather than continuing into a state the caller
 * cannot reason about, and every call's outcome is recorded so a partial batch is
 * visible instead of being reported as a single opaque result. Each recorded result
 * restates the call it belongs to (`operation`, `detail`, …), so a partial batch is
 * attributable from the result alone rather than by index into the request.
 *
 * @param {object} input
 * @param {object[]} input.calls
 * @param {Function} input.execute `async (call) => result`
 * @param {object} [input.limits]
 */
async function executeBatch(input = {}) {
  const planned = planBatch(input)
  const executed = []
  for (const batch of planned.batches) {
    const results = []
    let failed = null
    for (const call of batch) {
      try {
        const result = await input.execute(call)
        results.push({ ...call, ok: true, result })
      } catch (error) {
        failed = { ...call, ok: false, reason: String(error && error.message ? error.message : error) }
        results.push(failed)
        break
      }
    }
    executed.push({ calls: batch.length, results, stopped: failed })
    if (failed) break
  }
  return {
    ...planned,
    executed,
    ok: executed.every((batch) => !batch.stopped),
    /** What the caller would have paid in round trips without batching. */
    roundTripsSaved: Math.max(0, planned.batched - executed.length)
  }
}

module.exports = { planBatch, executeBatch, classifyOperation, OPERATION_CLASS, DEFAULT_LIMITS }
