'use strict'

/**
 * Computer Use Runtime: vocabulary.
 *
 * Every constant that another module, the UI, the execution log or the
 * acceptance harness has to agree on lives here, so a name is changed in one
 * place instead of drifting between the executor and its tests.
 *
 * The vocabulary is deliberately closed:
 *  - `ACTION_TYPES` is the whole action surface (plan §6). Nothing else may be
 *    executed by the Action Executor.
 *  - `CU_STATES` is the whole state machine (plan §51/§52). A state that is not
 *    in this list cannot be reported, so a caller can never invent progress.
 *  - `VERIFICATION_KINDS` is the whole verification surface (plan §15).
 *
 * Reference: Update-Plan/computer-use.md.
 */

const fs = require('node:fs')
const path = require('node:path')

/**
 * Plan §6 — the first-phase action surface, grouped by the capability that
 * actually carries the action out.
 */
const ACTION_TYPES = Object.freeze({
  MOVE: 'MOVE',
  CLICK: 'CLICK',
  DOUBLE_CLICK: 'DOUBLE_CLICK',
  RIGHT_CLICK: 'RIGHT_CLICK',
  TYPE: 'TYPE',
  KEY_PRESS: 'KEY_PRESS',
  HOTKEY: 'HOTKEY',
  SCROLL: 'SCROLL',
  DRAG: 'DRAG',
  FOCUS: 'FOCUS',
  SELECT: 'SELECT',
  OPEN_APP: 'OPEN_APP',
  CLOSE_WINDOW: 'CLOSE_WINDOW',
  SWITCH_WINDOW: 'SWITCH_WINDOW',
  BROWSER_NAVIGATE: 'BROWSER_NAVIGATE',
  BROWSER_BACK: 'BROWSER_BACK',
  BROWSER_FORWARD: 'BROWSER_FORWARD',
  BROWSER_REFRESH: 'BROWSER_REFRESH',
  DOM_CLICK: 'DOM_CLICK',
  DOM_TYPE: 'DOM_TYPE',
  DOM_SELECT: 'DOM_SELECT',
  ACCESSIBILITY_INVOKE: 'ACCESSIBILITY_INVOKE',
  ACCESSIBILITY_SET_VALUE: 'ACCESSIBILITY_SET_VALUE',
  SHELL_EXEC: 'SHELL_EXEC',
  // File capability. The plan's first-phase list is a floor, not a ceiling: a
  // filesystem operation stays inside the Action Executor instead of becoming a
  // side channel the runtime cannot verify (plan §43).
  FILE_READ: 'FILE_READ',
  FILE_WRITE: 'FILE_WRITE',
  FILE_COPY: 'FILE_COPY',
  FILE_MOVE: 'FILE_MOVE',
  FILE_DELETE: 'FILE_DELETE',
  FILE_MKDIR: 'FILE_MKDIR',
  FILE_EXISTS: 'FILE_EXISTS',
  WAIT_EVENT: 'WAIT_EVENT',
  WAIT_STATE: 'WAIT_STATE',
  SCREENSHOT_REGION: 'SCREENSHOT_REGION',
  SCREENSHOT_WINDOW: 'SCREENSHOT_WINDOW',
  SCREENSHOT_FULL: 'SCREENSHOT_FULL'
})

const ACTION_TYPE_LIST = Object.freeze(Object.values(ACTION_TYPES))

/** Which capability owns an action (plan §29 capability routing). */
const ACTION_CAPABILITY = Object.freeze({
  MOVE: 'desktop',
  CLICK: 'desktop',
  DOUBLE_CLICK: 'desktop',
  RIGHT_CLICK: 'desktop',
  TYPE: 'desktop',
  KEY_PRESS: 'desktop',
  HOTKEY: 'desktop',
  SCROLL: 'desktop',
  DRAG: 'desktop',
  FOCUS: 'desktop',
  SELECT: 'desktop',
  OPEN_APP: 'desktop',
  CLOSE_WINDOW: 'desktop',
  SWITCH_WINDOW: 'desktop',
  BROWSER_NAVIGATE: 'browser',
  BROWSER_BACK: 'browser',
  BROWSER_FORWARD: 'browser',
  BROWSER_REFRESH: 'browser',
  DOM_CLICK: 'browser',
  DOM_TYPE: 'browser',
  DOM_SELECT: 'browser',
  ACCESSIBILITY_INVOKE: 'desktop',
  ACCESSIBILITY_SET_VALUE: 'desktop',
  SHELL_EXEC: 'shell',
  FILE_READ: 'filesystem',
  FILE_WRITE: 'filesystem',
  FILE_COPY: 'filesystem',
  FILE_MOVE: 'filesystem',
  FILE_DELETE: 'filesystem',
  FILE_MKDIR: 'filesystem',
  FILE_EXISTS: 'filesystem',
  WAIT_EVENT: 'desktop',
  WAIT_STATE: 'desktop',
  SCREENSHOT_REGION: 'vision',
  SCREENSHOT_WINDOW: 'vision',
  SCREENSHOT_FULL: 'vision'
})

/**
 * Plan §29 — the cost ladder. The router prefers the cheapest channel that can
 * actually carry the action: an API/shell path beats a DOM path, a DOM path
 * beats a GUI path, and "behave like a human" is the last resort.
 */
const ROUTE_CHANNELS = Object.freeze(['api', 'file', 'shell', 'dom', 'accessibility', 'gui', 'vision'])

/** Plan §51 — the complete state machine. */
const CU_STATES = Object.freeze({
  IDLE: 'IDLE',
  RECEIVING_TASK: 'RECEIVING_TASK',
  OBSERVING: 'OBSERVING',
  PLANNING_ACTION: 'PLANNING_ACTION',
  STABILIZING: 'STABILIZING',
  REVALIDATING: 'REVALIDATING',
  ACTING: 'ACTING',
  POST_ACTION_GRACE: 'POST_ACTION_GRACE',
  VERIFYING: 'VERIFYING',
  RETRYING: 'RETRYING',
  RECOVERING: 'RECOVERING',
  REPLANNING: 'REPLANNING',
  STALLED: 'STALLED',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED'
})

/**
 * Plan §51/§52 — the legal transitions. `COMPLETED` and `FAILED` are terminal:
 * a task that ended cannot silently re-enter the loop, it has to be re-issued
 * as a new task (the runtime drops the previous world state instead).
 */
const CU_TRANSITIONS = Object.freeze({
  IDLE: ['RECEIVING_TASK'],
  RECEIVING_TASK: ['OBSERVING', 'FAILED'],
  OBSERVING: ['PLANNING_ACTION', 'COMPLETED', 'FAILED'],
  PLANNING_ACTION: ['STABILIZING', 'COMPLETED', 'REPLANNING', 'FAILED'],
  // Plan §52: a step can fail while settling, while revalidating or after
  // acting, so every step state may fall through to RETRYING.
  STABILIZING: ['REVALIDATING', 'OBSERVING', 'RETRYING', 'RECOVERING', 'FAILED'],
  REVALIDATING: ['ACTING', 'OBSERVING', 'RETRYING', 'RECOVERING', 'FAILED'],
  ACTING: ['POST_ACTION_GRACE', 'RETRYING', 'RECOVERING', 'FAILED'],
  POST_ACTION_GRACE: ['VERIFYING', 'RETRYING', 'FAILED'],
  VERIFYING: ['OBSERVING', 'RETRYING', 'RECOVERING', 'REPLANNING', 'STALLED', 'COMPLETED', 'FAILED'],
  RETRYING: ['STABILIZING', 'RECOVERING', 'REPLANNING', 'OBSERVING', 'PLANNING_ACTION', 'FAILED'],
  RECOVERING: ['OBSERVING', 'STABILIZING', 'RETRYING', 'REPLANNING', 'PLANNING_ACTION', 'STALLED', 'FAILED'],
  REPLANNING: ['OBSERVING', 'PLANNING_ACTION', 'FAILED'],
  STALLED: ['OBSERVING', 'STABILIZING', 'PLANNING_ACTION', 'RECOVERING', 'REPLANNING', 'FAILED'],
  COMPLETED: [],
  FAILED: []
})

const TERMINAL_STATES = Object.freeze([CU_STATES.COMPLETED, CU_STATES.FAILED])

/** Plan §15 — verification kinds. */
const VERIFICATION_KINDS = Object.freeze({
  DIRECT: 'direct',
  STATE: 'state',
  NAVIGATION: 'navigation',
  FILE: 'file',
  PROCESS: 'process',
  VISUAL: 'visual',
  FOCUS: 'focus',
  EVENT: 'event',
  NONE: 'none'
})

/**
 * Plan §46 — every action returns exactly one of these. There is no fourth
 * value and no boolean shorthand: "unknown" is what keeps the runtime from
 * silently assuming success.
 */
const VERDICTS = Object.freeze({ SUCCESS: 'success', FAILURE: 'failure', UNKNOWN: 'unknown' })

/** Plan §4.2 — screenshot levels, cheapest first. */
const SCREENSHOT_LEVELS = Object.freeze({ NONE: 0, REGION: 1, WINDOW: 2, FULL: 3 })

/** Plan §35 — capabilities a contract may hand out. */
const CAPABILITIES = Object.freeze(['browser', 'desktop', 'shell', 'filesystem', 'vision'])

/** Plan §34 — destructive action families and the gate that guards them. */
const DESTRUCTIVE_KINDS = Object.freeze([
  'DELETE',
  'PURCHASE',
  'SEND',
  'PUBLISH',
  'INSTALL',
  'UNINSTALL',
  'FORMAT',
  'ACCOUNT_CHANGE'
])

/** Plan §34 — how the contract treats a destructive action. */
const DESTRUCTIVE_MODES = Object.freeze({
  ALLOWED: 'allowed',
  CONFIRM: 'confirm',
  FORBIDDEN: 'forbidden'
})

/** Plan §40 — when a screenshot may be written to disk. */
const SCREENSHOT_RETENTION = Object.freeze({
  DEBUG: 'debug',
  AUDIT: 'audit',
  FAILURE: 'failure',
  REQUESTED: 'requested',
  NEVER: 'never'
})

/** Outcome of one step, as it lands in the execution log (plan §39). */
const STEP_RESULTS = Object.freeze({
  SUCCESS: 'success',
  FAILURE: 'failure',
  UNKNOWN: 'unknown',
  SKIPPED: 'skipped',
  REFUSED: 'refused'
})

/** Why a run stopped (plan §21 not-blocking: never an unbounded retry loop). */
const RUN_STATUS = Object.freeze({
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  BLOCKED: 'blocked'
})

/**
 * Plan §10 / §54 — the "stable target" thresholds, in CSS pixels.
 * `movement < stablePx` → the target is where it was;
 * `stablePx <= movement <= updatePx` → act on the refreshed coordinate;
 * `movement > updatePx` → the target is stale, re-observe instead of clicking.
 */
const TARGET_MOVEMENT = Object.freeze({ stablePx: 3, updatePx: 10 })

/**
 * Plan §9/§11/§24/§25 — timing policy. These are *ceilings*, not sleeps: the
 * executor always prefers an event wait and only ever spends a bounded forced
 * delay. `hardCapMs` is what stops the "add another 80 ms" ladder from turning
 * into a sleep loop.
 */
const TIMING = Object.freeze({
  settleMinMs: 50,
  settlePreferredMs: 100,
  settleComplexMs: 200,
  settleMaxMs: 300,
  graceMinMs: 80,
  gracePreferredMs: 150,
  graceMaxMs: 250,
  cooldownBaseMs: 80,
  cooldownStepMs: 80,
  cooldownSoftMaxMs: 400,
  cooldownHardMaxMs: 500,
  navigationCooldownMs: 800,
  navigationCooldownMaxMs: 1000,
  eventPollMs: 40,
  defaultActionTimeoutMs: 3000,
  defaultWaitTimeoutMs: 5000,
  appStartTimeoutMs: 20000
})

/**
 * Plan §20 — a stall is N consecutive actions with no meaningful state change.
 * Plan §21 — the recovery ladder is bounded, so an unresponsive page ends in
 * FAIL_WITH_CONTEXT instead of an infinite retry loop.
 */
const STALL = Object.freeze({ consecutiveActions: 3, maxRecoveries: 2 })

/** Plan §18 — retry policy per action. */
const RETRY = Object.freeze({ maxAttempts: 2, alternateAtAttempt: 2 })

/**
 * Plan §35 — execution contract defaults. `max_steps` bounds a run even when
 * the planner keeps proposing work; the retry/stall numbers bound the recovery
 * ladder inside one step.
 */
const CONTRACT_DEFAULTS = Object.freeze({
  maxSteps: 200,
  maxRetriesPerAction: RETRY.maxAttempts,
  maxStallRecoveries: STALL.maxRecoveries,
  destructiveActions: DESTRUCTIVE_MODES.CONFIRM,
  allowedCapabilities: CAPABILITIES,
  stepTimeoutMs: 30_000,
  runTimeoutMs: 30 * 60_000,
  screenshotRetention: SCREENSHOT_RETENTION.FAILURE,
  allowFullScreenFallback: true,
  autonomyEnabled: false
})

const ROOT = path.resolve(__dirname, '..', '..')

/**
 * Runtime defaults may be overridden by `config/app.json` (`computerUse`), the
 * same way the Sub-worker reads its own block. A missing or damaged config file
 * must never take the runtime down: the defaults above stay authoritative.
 */
function readComputerUseConfig(root = ROOT) {
  try {
    const raw = fs.readFileSync(path.join(root, 'config', 'app.json'), 'utf8')
    const parsed = JSON.parse(raw)
    const block = parsed && typeof parsed.computerUse === 'object' && parsed.computerUse !== null ? parsed.computerUse : {}
    return block
  } catch {
    return {}
  }
}

function positiveInt(value, fallback) {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : fallback
}

function clampMs(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

/**
 * Resolves the effective runtime options: built-in defaults, then the shipped
 * config block, then the caller's explicit overrides.
 */
function resolveComputerUseOptions(overrides = {}, configBlock = readComputerUseConfig()) {
  const limits = (configBlock && configBlock.limits) || {}
  const timing = (configBlock && configBlock.timing) || {}
  const safety = (configBlock && configBlock.safety) || {}
  const vision = (configBlock && configBlock.vision) || {}
  const merged = {
    maxSteps: positiveInt(overrides.maxSteps ?? limits.maxSteps, CONTRACT_DEFAULTS.maxSteps),
    maxRetriesPerAction: positiveInt(overrides.maxRetriesPerAction ?? limits.maxRetriesPerAction, CONTRACT_DEFAULTS.maxRetriesPerAction),
    maxStallRecoveries: positiveInt(overrides.maxStallRecoveries ?? limits.maxStallRecoveries, CONTRACT_DEFAULTS.maxStallRecoveries),
    stepTimeoutMs: positiveInt(overrides.stepTimeoutMs ?? limits.stepTimeoutMs, CONTRACT_DEFAULTS.stepTimeoutMs),
    runTimeoutMs: positiveInt(overrides.runTimeoutMs ?? limits.runTimeoutMs, CONTRACT_DEFAULTS.runTimeoutMs),
    destructiveActions: overrides.destructiveActions ?? safety.destructiveActions ?? CONTRACT_DEFAULTS.destructiveActions,
    allowedCapabilities: overrides.allowedCapabilities ?? configBlock.allowedCapabilities ?? CONTRACT_DEFAULTS.allowedCapabilities,
    screenshotRetention: overrides.screenshotRetention ?? vision.retention ?? CONTRACT_DEFAULTS.screenshotRetention,
    allowFullScreenFallback: overrides.allowFullScreenFallback ?? vision.allowFullScreenFallback ?? CONTRACT_DEFAULTS.allowFullScreenFallback,
    autonomyEnabled: overrides.autonomyEnabled ?? configBlock.autonomyEnabled ?? CONTRACT_DEFAULTS.autonomyEnabled,
    timing: {
      settleMinMs: clampMs(overrides.settleMinMs ?? timing.settleMinMs, 0, TIMING.settleMaxMs, TIMING.settleMinMs),
      settlePreferredMs: clampMs(overrides.settlePreferredMs ?? timing.settlePreferredMs, 0, TIMING.settleMaxMs, TIMING.settlePreferredMs),
      gracePreferredMs: clampMs(overrides.gracePreferredMs ?? timing.gracePreferredMs, 0, TIMING.graceMaxMs, TIMING.gracePreferredMs),
      cooldownSoftMaxMs: clampMs(overrides.cooldownSoftMaxMs ?? timing.cooldownSoftMaxMs, TIMING.cooldownBaseMs, TIMING.cooldownHardMaxMs, TIMING.cooldownSoftMaxMs),
      navigationCooldownMs: clampMs(overrides.navigationCooldownMs ?? timing.navigationCooldownMs, TIMING.cooldownBaseMs, TIMING.navigationCooldownMaxMs, TIMING.navigationCooldownMs),
      eventPollMs: clampMs(overrides.eventPollMs ?? timing.eventPollMs, 10, 1000, TIMING.eventPollMs)
    },
    targetMovement: {
      stablePx: Number.isFinite(Number(overrides.stablePx)) ? Number(overrides.stablePx) : TARGET_MOVEMENT.stablePx,
      updatePx: Number.isFinite(Number(overrides.updatePx)) ? Number(overrides.updatePx) : TARGET_MOVEMENT.updatePx
    },
    stall: {
      consecutiveActions: positiveInt(overrides.stallConsecutiveActions ?? (configBlock.stall && configBlock.stall.consecutiveActions), STALL.consecutiveActions)
    }
  }
  // An unknown mode is not "allowed by accident": it falls back to the shipped
  // default (confirm) instead of widening the gate.
  const destructiveMode = String(merged.destructiveActions || '').toLowerCase()
  merged.destructiveActions = Object.values(DESTRUCTIVE_MODES).includes(destructiveMode)
    ? destructiveMode
    : CONTRACT_DEFAULTS.destructiveActions
  merged.allowedCapabilities = Array.isArray(merged.allowedCapabilities)
    ? merged.allowedCapabilities.filter((capability) => CAPABILITIES.includes(capability))
    : CONTRACT_DEFAULTS.allowedCapabilities
  return merged
}

module.exports = {
  ACTION_TYPES,
  ACTION_TYPE_LIST,
  ACTION_CAPABILITY,
  ROUTE_CHANNELS,
  CU_STATES,
  CU_TRANSITIONS,
  TERMINAL_STATES,
  VERIFICATION_KINDS,
  VERDICTS,
  SCREENSHOT_LEVELS,
  CAPABILITIES,
  DESTRUCTIVE_KINDS,
  DESTRUCTIVE_MODES,
  SCREENSHOT_RETENTION,
  STEP_RESULTS,
  RUN_STATUS,
  TARGET_MOVEMENT,
  TIMING,
  STALL,
  RETRY,
  CONTRACT_DEFAULTS,
  ROOT,
  readComputerUseConfig,
  resolveComputerUseOptions
}
