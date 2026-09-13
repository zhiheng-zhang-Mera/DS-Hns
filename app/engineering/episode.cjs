'use strict'

/**
 * Engineering Runtime: the episode state machine.
 *
 * One 24-hour maintenance task is one *episode*. An episode is not a chat and not
 * a plan: it is a bounded piece of engineering work with a deadline, a verified
 * progress trail and a resumable cursor, and this module is the only place that
 * says which phase follows which.
 *
 * The phases exist to make "what is the runtime doing, and is it allowed to stop
 * here?" answerable without reading a transcript:
 *
 *   INITIALIZING       establishing the workspace and the repository snapshot
 *   DISCOVERING        reading the project and its instructions
 *   PLANNING           turning the goal into bounded steps
 *   EDITING            mutating files
 *   BUILDING           running the build
 *   TESTING            running tests
 *   INSPECTING_FAILURE reading a real failure
 *   REPAIRING          changing the code because of one
 *   VERIFYING          re-running the evidence the completion gate needs
 *   RECOVERING         a transient fault, not a code failure
 *   WAITING_PROCESS    an owned process is still running
 *   WAITING_RETRY      parked until a bounded backoff expires
 *   STALLED            repeated rounds with no new evidence
 *   COMPLETED          criteria satisfied with fresh evidence
 *   BLOCKED            an external condition is missing (credential, approval)
 *   FAILED             not completable inside this contract and budget
 *   CANCELLED          the caller stopped it
 *
 * Nothing here decides *whether* the work is good — that is the result validator's
 * job — and nothing here remembers anything across episodes.
 */

/** The complete phase vocabulary. A phase outside this list cannot be reported. */
const EPISODE_PHASES = Object.freeze({
  INITIALIZING: 'INITIALIZING',
  DISCOVERING: 'DISCOVERING',
  PLANNING: 'PLANNING',
  EDITING: 'EDITING',
  BUILDING: 'BUILDING',
  TESTING: 'TESTING',
  INSPECTING_FAILURE: 'INSPECTING_FAILURE',
  REPAIRING: 'REPAIRING',
  VERIFYING: 'VERIFYING',
  RECOVERING: 'RECOVERING',
  WAITING_PROCESS: 'WAITING_PROCESS',
  WAITING_RETRY: 'WAITING_RETRY',
  STALLED: 'STALLED',
  COMPLETED: 'COMPLETED',
  BLOCKED: 'BLOCKED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED'
})

/** Phases that end an episode: nothing may leave them. */
const TERMINAL_PHASES = Object.freeze([
  EPISODE_PHASES.COMPLETED,
  EPISODE_PHASES.BLOCKED,
  EPISODE_PHASES.FAILED,
  EPISODE_PHASES.CANCELLED
])

/**
 * The legal moves. The work phases form the loop the plan describes — discover,
 * plan, edit, build, test, inspect, repair, verify — and the waiting/recovery
 * phases are reachable from anywhere because a process can overrun or a transport
 * can die at any point. Teardown (`CANCELLED`, `FAILED`, `BLOCKED`) is always
 * reachable: an episode must never be unable to stop.
 */
const EPISODE_TRANSITIONS = Object.freeze({
  INITIALIZING: ['DISCOVERING', 'BLOCKED', 'FAILED', 'CANCELLED'],
  DISCOVERING: ['PLANNING', 'BLOCKED', 'FAILED', 'CANCELLED', 'RECOVERING'],
  PLANNING: ['EDITING', 'BUILDING', 'TESTING', 'VERIFYING', 'COMPLETED', 'BLOCKED', 'FAILED', 'CANCELLED'],
  EDITING: ['BUILDING', 'TESTING', 'VERIFYING', 'EDITING', 'INSPECTING_FAILURE', 'RECOVERING', 'WAITING_PROCESS', 'FAILED', 'BLOCKED', 'CANCELLED'],
  BUILDING: ['TESTING', 'VERIFYING', 'EDITING', 'REPAIRING', 'INSPECTING_FAILURE', 'RECOVERING', 'WAITING_PROCESS', 'FAILED', 'BLOCKED', 'CANCELLED'],
  TESTING: ['VERIFYING', 'EDITING', 'REPAIRING', 'INSPECTING_FAILURE', 'RECOVERING', 'WAITING_PROCESS', 'FAILED', 'BLOCKED', 'CANCELLED'],
  INSPECTING_FAILURE: ['REPAIRING', 'EDITING', 'PLANNING', 'BLOCKED', 'FAILED', 'RECOVERING', 'WAITING_RETRY', 'STALLED', 'CANCELLED'],
  REPAIRING: ['EDITING', 'BUILDING', 'TESTING', 'VERIFYING', 'INSPECTING_FAILURE', 'WAITING_RETRY', 'STALLED', 'FAILED', 'BLOCKED', 'CANCELLED'],
  VERIFYING: ['COMPLETED', 'EDITING', 'REPAIRING', 'INSPECTING_FAILURE', 'PLANNING', 'BLOCKED', 'FAILED', 'STALLED', 'CANCELLED'],
  RECOVERING: ['DISCOVERING', 'PLANNING', 'EDITING', 'BUILDING', 'TESTING', 'VERIFYING', 'WAITING_RETRY', 'INSPECTING_FAILURE', 'FAILED', 'BLOCKED', 'CANCELLED'],
  WAITING_PROCESS: ['BUILDING', 'TESTING', 'VERIFYING', 'EDITING', 'RECOVERING', 'INSPECTING_FAILURE', 'FAILED', 'BLOCKED', 'CANCELLED'],
  WAITING_RETRY: ['DISCOVERING', 'PLANNING', 'EDITING', 'BUILDING', 'TESTING', 'INSPECTING_FAILURE', 'REPAIRING', 'VERIFYING', 'FAILED', 'BLOCKED', 'CANCELLED'],
  STALLED: ['PLANNING', 'INSPECTING_FAILURE', 'VERIFYING', 'BLOCKED', 'FAILED', 'CANCELLED'],
  COMPLETED: [],
  BLOCKED: [],
  FAILED: [],
  CANCELLED: []
})

/** The work phases, in the order the engineering loop visits them. */
const WORK_PHASES = Object.freeze([
  EPISODE_PHASES.DISCOVERING,
  EPISODE_PHASES.PLANNING,
  EPISODE_PHASES.EDITING,
  EPISODE_PHASES.BUILDING,
  EPISODE_PHASES.TESTING,
  EPISODE_PHASES.INSPECTING_FAILURE,
  EPISODE_PHASES.REPAIRING,
  EPISODE_PHASES.VERIFYING
])

/** Phases that are waiting rather than working: an episode may park in these. */
const PARKABLE_PHASES = Object.freeze([EPISODE_PHASES.WAITING_PROCESS, EPISODE_PHASES.WAITING_RETRY])

function isTerminalPhase(phase) {
  return TERMINAL_PHASES.includes(String(phase))
}

function isParkablePhase(phase) {
  return PARKABLE_PHASES.includes(String(phase))
}

/**
 * @param {object} [options]
 * @param {string} [options.initial] the starting phase
 * @param {Function} [options.now]
 * @param {number} [options.ringSize] how many transitions to keep
 */
function createEpisodeStateMachine(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const ringSize = Number.isInteger(options.ringSize) && options.ringSize > 0 ? options.ringSize : 200
  let phase = options.initial || EPISODE_PHASES.INITIALIZING
  const history = []

  if (!EPISODE_PHASES[phase]) throw new Error(`unknown initial phase: ${phase}`)

  function canTransition(next) {
    return (EPISODE_TRANSITIONS[phase] || []).includes(next)
  }

  /**
   * Move to a phase. An illegal move is refused rather than corrected: silently
   * jumping from INITIALIZING to COMPLETED would be the runtime inventing a
   * result, which is exactly what this machine exists to prevent.
   */
  function transition(next, detail = {}) {
    const target = String(next)
    if (!EPISODE_PHASES[target]) return { ok: false, reason: `unknown phase: ${target}`, phase }
    if (isTerminalPhase(phase) && phase !== target) {
      return { ok: false, reason: `the episode already ended in ${phase}`, phase }
    }
    if (!canTransition(target)) {
      return { ok: false, reason: `${phase} cannot move to ${target}`, phase, allowed: EPISODE_TRANSITIONS[phase] }
    }
    const previous = phase
    phase = target
    const entry = { at: now(), from: previous, to: target, ...detail }
    history.push(entry)
    if (history.length > ringSize) history.splice(0, history.length - ringSize)
    return { ok: true, phase, previous, entry }
  }

  /** Force a terminal phase (teardown): the one move legality does not gate. */
  function force(next, reason = 'teardown') {
    const target = String(next)
    if (!EPISODE_PHASES[target]) return { ok: false, reason: `unknown phase: ${target}`, phase }
    const previous = phase
    phase = target
    const entry = { at: now(), from: previous, to: target, reason, forced: true }
    history.push(entry)
    if (history.length > ringSize) history.splice(0, history.length - ringSize)
    return { ok: true, phase, previous, entry }
  }

  return {
    EPISODE_PHASES,
    get phase() {
      return phase
    },
    get terminal() {
      return isTerminalPhase(phase)
    },
    get parkable() {
      return isParkablePhase(phase)
    },
    canTransition,
    allowedFrom() {
      return (EPISODE_TRANSITIONS[phase] || []).slice()
    },
    transition,
    force,
    history() {
      return history.slice()
    }
  }
}

module.exports = {
  EPISODE_PHASES,
  EPISODE_TRANSITIONS,
  TERMINAL_PHASES,
  WORK_PHASES,
  PARKABLE_PHASES,
  createEpisodeStateMachine,
  isTerminalPhase,
  isParkablePhase
}
