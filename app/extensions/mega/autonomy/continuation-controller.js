'use strict'

/**
 * DS-Hns autonomy: continuation controller (Owner-Result.md Rev.2 §17/§7, §13,
 * §40). Decides what the scheduler should do with an episode given the latest
 * progress verdict — without ever blocking a scheduler tick on a provider.
 *
 * Every decision is bounded: retries are capped (maxAttempts), recovery
 * backoff grows and is capped, and a hard deadline terminates the episode.
 * `PARK_AWAITING_RETRY` releases the scheduler slot (the waiting episode does
 * not occupy concurrency), so sibling tasks keep running while one episode
 * waits. MODEL_DONE still requires evidence: completed episodes whose result
 * fails the validator come back as REWORK (bounded retry) instead of PASS.
 */

const MAX_ATTEMPTS = 3
const BACKOFF_BASE_MS = 30_000
const BACKOFF_CAP_MS = 5 * 60_000
const HARD_DEADLINE_MS = 6 * 60 * 60_000

function backoffDelayMs(attempt, baseMs = BACKOFF_BASE_MS, capMs = BACKOFF_CAP_MS) {
  if (!Number.isInteger(attempt) || attempt < 0) throw new Error('backoffDelayMs: attempt must be a non-negative integer')
  const delay = baseMs * 2 ** attempt
  return Math.min(capMs, delay)
}

/**
 * @param {object} input
 * @param {'WORKING'|'SLOW'|'STALLED'|'FAILED'} input.verdict  latest progress verdict
 * @param {boolean} [input.completed]    model reported done (needs verification)
 * @param {boolean} [input.verified]     result validator passed
 * @param {number}  [input.attempts]     attempts already spent (0-based)
 * @param {number}  [input.startedAt]    episode start, for the hard deadline
 * @param {number}  [input.now]          current time
 * @param {boolean} [input.retryable]    whether a bounded retry is allowed
 * @param {number}  [input.maxAttempts]  retry cap (default 3)
 * @param {number}  [input.hardDeadlineMs] absolute run bound
 * @returns {{action:string, retryAtMs?:number, reason:string, attempts:number}}
 */
function decideContinuation(input = {}) {
  const {
    verdict,
    completed = false,
    verified = false,
    attempts = 0,
    startedAt = 0,
    now = Date.now(),
    retryable = true,
    maxAttempts = MAX_ATTEMPTS,
    hardDeadlineMs = HARD_DEADLINE_MS
  } = input
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) throw new Error('decideContinuation: maxAttempts must be 1..10')
  const attemptsLeft = attempts < maxAttempts

  if (completed) {
    if (verified) return { action: 'COMPLETE', reason: 'model done and result verified', attempts }
    if (retryable && attemptsLeft) return { action: 'REWORK', reason: 'model done but verification failed — bounded rework', attempts }
    return { action: 'FAIL', reason: 'model done but verification failed and retry budget exhausted', attempts }
  }

  const startedAtGiven = startedAt !== undefined && startedAt !== null && Number.isFinite(startedAt)
  if (startedAtGiven && now - startedAt > hardDeadlineMs) {
    return { action: 'FAIL', reason: `hard deadline exceeded (${hardDeadlineMs}ms)`, attempts }
  }

  if (verdict === 'FAILED') {
    return { action: 'FAIL', reason: 'progress observer reported FAILED', attempts }
  }
  if (verdict === 'STALLED') {
    if (retryable && attemptsLeft) {
      const delayMs = backoffDelayMs(attempts)
      return {
        action: 'PARK_AWAITING_RETRY',
        retryAtMs: now + delayMs,
        reason: `hard stall — bounded retry ${attempts + 1}/${maxAttempts} at +${delayMs}ms (slot released)`,
        attempts
      }
    }
    return { action: 'FAIL', reason: `hard stall and retry budget exhausted (${attempts}/${maxAttempts})`, attempts }
  }
  if (verdict === 'SLOW') {
    return { action: 'PROBE', reason: 'soft deadline — probe provider without blocking the tick', attempts }
  }
  return { action: 'KEEP_RUNNING', reason: 'episode shows working evidence', attempts }
}

module.exports = { MAX_ATTEMPTS, BACKOFF_BASE_MS, BACKOFF_CAP_MS, HARD_DEADLINE_MS, backoffDelayMs, decideContinuation }
