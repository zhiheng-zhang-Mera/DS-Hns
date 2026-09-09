'use strict'

/**
 * DS-Hns autonomy: episode supervisor (Owner-Result.md Rev.2 §7–§8, §12–§14).
 *
 * One running scheduler task = one episode. The supervisor owns the episode
 * lifecycle (QUEUED → DISPATCHING → ACTIVE → QUIET → PROBING → RECOVERING →
 * COMPLETED/FAILED), consults the progress observer / stall detector on every
 * tick, and walks the R0–R8 recovery ladder when the stall detector reports a
 * hard stall. §13 straggler policy and §14 provider replacement live here as
 * pure helpers so councils never wait on the slowest member forever and a
 * failed non-essential worker is replaced to keep the target worker count.
 */

const { StallDetector } = require('./stall-detector')

const EPISODE_STATES = Object.freeze([
  'QUEUED', 'DISPATCHING', 'ACTIVE', 'QUIET', 'PROBING', 'RECOVERING', 'COMPLETED', 'FAILED'
])

const EPISODE_TRANSITIONS = Object.freeze({
  QUEUED: ['DISPATCHING', 'FAILED', 'COMPLETED'],
  DISPATCHING: ['ACTIVE', 'QUIET', 'FAILED', 'COMPLETED'],
  ACTIVE: ['QUIET', 'PROBING', 'RECOVERING', 'COMPLETED', 'FAILED'],
  QUIET: ['ACTIVE', 'PROBING', 'RECOVERING', 'COMPLETED', 'FAILED'],
  PROBING: ['ACTIVE', 'QUIET', 'RECOVERING', 'COMPLETED', 'FAILED'],
  RECOVERING: ['ACTIVE', 'QUIET', 'PROBING', 'COMPLETED', 'FAILED'],
  COMPLETED: [],
  FAILED: []
})

function canTransition(from, to) {
  return from === to || (EPISODE_TRANSITIONS[from] || []).includes(to)
}

const RECOVERY_LADDER = Object.freeze([
  'R0_INSPECT_CURRENT_STATE',
  'R1_RECAPTURE_EXISTING_RESPONSE',
  'R2_REMONITOR',
  'R3_RESTEER_SAME_SESSION',
  'R4_RETRY_SAFE_UNSENT_ACTION',
  'R5_REOPEN_RECOVER_SESSION',
  'R6_COMPUTER_USE_REPAIR',
  'R7_ALTERNATE_PROVIDER',
  'R8_FRESH_EPISODE'
])

function nextRecoveryStep(current) {
  if (!current) return RECOVERY_LADDER[0]
  const index = RECOVERY_LADDER.indexOf(current)
  if (index < 0) throw new Error(`unknown recovery ladder step: ${current}`)
  return RECOVERY_LADDER[Math.min(RECOVERY_LADDER.length - 1, index + 1)]
}

function isTerminalRecovery(step) {
  return step === 'R8_FRESH_EPISODE'
}

/** §13 straggler policy. */
function stragglerDecision({ total, received, coreRolesReturned, requireAll, quorum }) {
  if (!Number.isInteger(total) || total < 1 || !Number.isInteger(received) || received < 0 || received > total) {
    throw new Error('stragglerDecision: invalid counts')
  }
  if (requireAll) return received >= total ? 'PROCEED_PROVISIONAL' : coreRolesReturned ? 'WAIT_FOR_ALL' : 'WAIT_FOR_CORE'
  const target = Math.max(1, quorum === undefined ? Math.floor(total / 2) + 1 : quorum)
  if (received >= Math.min(total, target) && coreRolesReturned) return 'PROCEED_PROVISIONAL'
  if (received >= Math.min(total, target)) return 'WAIT_FOR_CORE'
  return 'WAIT_FOR_QUORUM'
}

/** §14 provider replacement; brand-locked tests are never substituted. */
function replacementDecision({ failedProviderId, candidateProviderIds, targetWorkerCount, brandLocked }) {
  if (!Number.isInteger(targetWorkerCount) || targetWorkerCount < 1) throw new Error('replacementDecision: targetWorkerCount must be >= 1')
  if (brandLocked) {
    return { replacement: null, workerCount: targetWorkerCount, canReplace: false, reason: `brand-locked: ${failedProviderId} must be repaired in place` }
  }
  const replacement = (candidateProviderIds || []).find((candidate) => candidate !== failedProviderId)
  if (!replacement) return { replacement: null, workerCount: targetWorkerCount, canReplace: false, reason: 'no replacement candidate remains' }
  return { replacement, workerCount: targetWorkerCount, canReplace: true, reason: `${failedProviderId} replaced by ${replacement}` }
}

class EpisodeSupervisor {
  constructor(options = {}) {
    this.stallDetector = options.stallDetector || new StallDetector({ bounds: options.bounds, now: options.now })
    this.now = options.now || (() => Date.now())
    this.episodes = new Map()
  }

  begin({ episodeId, startedAt = this.now(), deliveryMode = 'headless' }) {
    const existing = this.episodes.get(episodeId)
    if (existing) return existing
    const record = {
      episodeId,
      deliveryMode,
      lifecycle: 'QUEUED',
      recoveryStep: null,
      startedAt,
      completedAt: null,
      stalls: 0
    }
    this.episodes.set(episodeId, record)
    this.stallDetector.start(episodeId, startedAt)
    return record
  }

  transition(episodeId, to) {
    const record = this.episodes.get(episodeId)
    if (!record) throw new Error(`unknown episode: ${episodeId}`)
    if (!canTransition(record.lifecycle, to)) throw new Error(`invalid episode transition: ${record.lifecycle} -> ${to}`)
    record.lifecycle = to
    if (to === 'COMPLETED' || to === 'FAILED') {
      record.completedAt = this.now()
      this.stallDetector.drop(episodeId)
    }
    return record.lifecycle
  }

  /** Tick observation: returns verdict + lifecycle + recovery advice. */
  observe(episodeId, heartbeatUpdate = {}, now = this.now()) {
    const record = this.begin({ episodeId, startedAt: heartbeatUpdate.startedAt || now })
    const observation = this.stallDetector.observe(episodeId, heartbeatUpdate, now)
    if (observation.verdict === 'STALLED' || observation.verdict === 'FAILED') {
      if (record.lifecycle !== 'RECOVERING' && record.lifecycle !== 'FAILED') record.lifecycle = 'RECOVERING'
      record.stalls += 1
      record.recoveryStep = nextRecoveryStep(record.recoveryStep)
      observation.recoveryStep = record.recoveryStep
    } else if (observation.verdict === 'SLOW') {
      if (record.lifecycle === 'ACTIVE' || record.lifecycle === 'QUIET') record.lifecycle = 'PROBING'
    } else if (observation.verdict === 'WORKING' && (record.lifecycle === 'PROBING' || record.lifecycle === 'RECOVERING')) {
      record.lifecycle = 'ACTIVE'
    }
    observation.lifecycle = record.lifecycle
    return observation
  }

  markProbe(episodeId, probe) {
    return this.stallDetector.markProbe(episodeId, probe)
  }

  reset(episodeId) {
    const record = this.episodes.get(episodeId)
    if (!record) return
    record.recoveryStep = null
    record.stalls = 0
    record.lifecycle = 'ACTIVE'
    this.stallDetector.reset(episodeId)
  }

  state(episodeId) {
    const record = this.episodes.get(episodeId)
    if (!record) return null
    return {
      episodeId: record.episodeId,
      deliveryMode: record.deliveryMode,
      lifecycle: record.lifecycle,
      recoveryStep: record.recoveryStep,
      stalls: record.stalls,
      startedAt: record.startedAt
    }
  }
}

module.exports = {
  EPISODE_STATES,
  EPISODE_TRANSITIONS,
  canTransition,
  RECOVERY_LADDER,
  nextRecoveryStep,
  isTerminalRecovery,
  stragglerDecision,
  replacementDecision,
  EpisodeSupervisor
}
