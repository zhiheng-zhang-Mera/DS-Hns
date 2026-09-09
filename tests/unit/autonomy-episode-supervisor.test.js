'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const {
  EpisodeSupervisor,
  canTransition,
  nextRecoveryStep,
  isTerminalRecovery,
  stragglerDecision,
  replacementDecision,
  RECOVERY_LADDER
} = require('../../app/extensions/mega/autonomy/episode-supervisor')

test('episode transitions reject illegal moves', () => {
  assert.equal(canTransition('QUEUED', 'DISPATCHING'), true)
  assert.equal(canTransition('ACTIVE', 'QUIET'), true)
  assert.equal(canTransition('COMPLETED', 'ACTIVE'), false)
  assert.equal(canTransition('QUEUED', 'ACTIVE'), false)
})

test('recovery ladder walks R0..R8 and terminates at fresh episode', () => {
  assert.equal(nextRecoveryStep(undefined), 'R0_INSPECT_CURRENT_STATE')
  assert.equal(nextRecoveryStep('R3_RESTEER_SAME_SESSION'), 'R4_RETRY_SAFE_UNSENT_ACTION')
  assert.equal(isTerminalRecovery(nextRecoveryStep('R7_ALTERNATE_PROVIDER')), true)
  assert.equal(RECOVERY_LADDER.length, 9)
})

test('episode supervisor observes stalls, escalates into RECOVERING and walks the ladder', () => {
  const supervisor = new EpisodeSupervisor()
  supervisor.begin({ episodeId: 'ep-1', startedAt: 0, deliveryMode: 'headless' })
  supervisor.transition('ep-1', 'DISPATCHING')
  supervisor.transition('ep-1', 'ACTIVE')
  // Hard stall at t=150s (bounds defaults quiet 20s/hard 90s/fail 15min)
  const observation = supervisor.observe('ep-1', {}, 150_000)
  assert.equal(observation.verdict, 'STALLED')
  assert.equal(supervisor.state('ep-1').lifecycle, 'RECOVERING')
  assert.equal(supervisor.state('ep-1').recoveryStep, 'R0_INSPECT_CURRENT_STATE')
  // Second stall tick advances the ladder.
  supervisor.observe('ep-1', {}, 160_000)
  assert.equal(supervisor.state('ep-1').recoveryStep, 'R1_RECAPTURE_EXISTING_RESPONSE')
})

test('supervisor transitions to COMPLETED/FAILED terminate the episode', () => {
  const supervisor = new EpisodeSupervisor()
  supervisor.begin({ episodeId: 'ep-2', startedAt: 0 })
  supervisor.transition('ep-2', 'DISPATCHING')
  supervisor.transition('ep-2', 'ACTIVE')
  supervisor.transition('ep-2', 'COMPLETED')
  assert.throws(() => supervisor.transition('ep-2', 'ACTIVE'))
})

test('straggler policy (§13): quorum + core roles -> provisional synthesis', () => {
  assert.equal(stragglerDecision({ total: 5, received: 3, coreRolesReturned: true, requireAll: false }), 'PROCEED_PROVISIONAL')
  assert.equal(stragglerDecision({ total: 5, received: 3, coreRolesReturned: false, requireAll: false }), 'WAIT_FOR_CORE')
  assert.equal(stragglerDecision({ total: 5, received: 2, coreRolesReturned: true, requireAll: false }), 'WAIT_FOR_QUORUM')
  assert.equal(stragglerDecision({ total: 5, received: 4, coreRolesReturned: true, requireAll: true }), 'WAIT_FOR_ALL')
  assert.equal(stragglerDecision({ total: 5, received: 5, coreRolesReturned: true, requireAll: true }), 'PROCEED_PROVISIONAL')
  assert.throws(() => stragglerDecision({ total: 0, received: 0, coreRolesReturned: true, requireAll: false }))
})

test('provider replacement (§14) keeps the worker count; brand-locked is never substituted', () => {
  const replaced = replacementDecision({ failedProviderId: 'gemini', candidateProviderIds: ['chatgpt', 'gemini', 'qwen'], targetWorkerCount: 5, brandLocked: false })
  assert.equal(replaced.canReplace, true)
  assert.equal(replaced.replacement, 'chatgpt')
  const locked = replacementDecision({ failedProviderId: 'qwen', candidateProviderIds: ['chatgpt', 'qwen'], targetWorkerCount: 1, brandLocked: true })
  assert.equal(locked.canReplace, false)
  assert.equal(locked.replacement, null)
})
