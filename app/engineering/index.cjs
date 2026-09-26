'use strict'

/**
 * Engineering Runtime: the public entry point.
 *
 * One call, one episode: give it a repository and a goal, and it establishes the
 * workspace, discovers the project, captures a baseline, plans bounded work,
 * executes it, verifies it with fresh evidence and reports what happened.
 *
 * This module is the *only* seam a host needs, and it is deliberately narrow so
 * that the runtime can be embedded anywhere — the Electron shell, a CLI, a
 * service, a test harness — without the host knowing how the loop works. It also
 * re-exports the pieces a host may legitimately want to inspect (the phase
 * vocabulary, the failure classes, the adapters) without exposing the mutable
 * internals of a running episode.
 */

const { createEngineeringSupervisor, runEpisode, STEP_OUTCOMES, EPISODE_DEFAULTS } = require('./supervisor.cjs')
const { EPISODE_PHASES, EPISODE_TRANSITIONS, isTerminalPhase } = require('./episode.cjs')
const { FAILURE_CLASSES, CLASS_POLICY, classify } = require('./failure.cjs')
const { VERIFICATION_LEVELS } = require('./verifier.cjs')
const { PLAN_KINDS } = require('./plan.cjs')
const { WAKE_REASONS, deadlineState } = require('./scheduler.cjs')
const { OPERATIONS, CONFIDENCE, defaultAdapters } = require('./adapters/index.cjs')
const { verifyWorkspace, gitState, fingerprint, diffFingerprint } = require('./repository.cjs')
const { detectProject, discoverCommands, discover } = require('./discovery.cjs')
const { createCheckpointStore, verifyResume, truncateOutput, summarizeTestOutput } = require('./checkpoint.cjs')
const { createRecoveryStore, RECOVERY_INDEX_VERSION, RECOVERY_STATES } = require('./recovery-store.cjs')
const { createResultValidator, collectLeaks } = require('./result.cjs')
const { createMutationLog, MUTATION_RESULTS } = require('./mutation.cjs')
const { createProcessSupervisor, PROCESS_CLASS, READINESS } = require('./process.cjs')
const { createGitController } = require('./git.cjs')
const { createEpisodeContext } = require('./context.cjs')

/**
 * Run one engineering episode.
 *
 * @param {object} input
 * @param {string} input.workspace the repository the episode is confined to
 * @param {string} input.goal what the episode is for
 * @param {object} [input.contract] commands, tests, patches, policies and bounds
 * @param {number} [input.deadlineMs] how long the episode may run (default 24h)
 * @param {Function} [input.now]
 * @param {Function} [input.sleep]
 * @param {object} [input.processes] a shared Computer Use process registry
 * @param {Function} [input.log]
 * @returns {Promise<object>} the episode report
 */
function run(input = {}) {
  return runEpisode(input)
}

module.exports = {
  run,
  createEngineeringSupervisor,
  runEpisode,
  /** The vocabularies a host may switch on. */
  EPISODE_PHASES,
  EPISODE_TRANSITIONS,
  FAILURE_CLASSES,
  CLASS_POLICY,
  VERIFICATION_LEVELS,
  PLAN_KINDS,
  WAKE_REASONS,
  OPERATIONS,
  CONFIDENCE,
  PROCESS_CLASS,
  READINESS,
  MUTATION_RESULTS,
  STEP_OUTCOMES,
  EPISODE_DEFAULTS,
  /** The read-only inspectors and helpers. */
  isTerminalPhase,
  classify,
  deadlineState,
  defaultAdapters,
  verifyWorkspace,
  gitState,
  fingerprint,
  diffFingerprint,
  detectProject,
  discoverCommands,
  discover,
  createCheckpointStore,
  createRecoveryStore,
  RECOVERY_INDEX_VERSION,
  RECOVERY_STATES,
  verifyResume,
  truncateOutput,
  summarizeTestOutput,
  createResultValidator,
  collectLeaks,
  createMutationLog,
  createProcessSupervisor,
  createGitController,
  createEpisodeContext
}
