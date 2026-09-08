'use strict'

/**
 * Pure price/schedule gate shared by the queue loop and unit tests.
 * Returns 'ready' | 'suspend-peak' | 'suspend-schedule' | 'running' | 'terminal'.
 */
function decideTask({ status, startAtMs, allowPeak, peak, now }) {
  if (status === 'RUNNING') return 'running'
  if (status !== 'PENDING' && status !== 'SUSPENDED') return 'terminal'
  if (!allowPeak && peak) return 'suspend-peak'
  if (startAtMs && now < startAtMs) return 'suspend-schedule'
  return 'ready'
}

module.exports = { decideTask }
