'use strict'

/**
 * Computer Use Runtime: the Execution Contract (plan §35).
 *
 * Everything a run is allowed to do arrives in one document: the goal, the
 * success criteria, the capabilities that may be used, the safety posture for
 * destructive actions and the hard limits. The runtime has no API to widen its
 * own contract — the same discipline the Sub-worker permission guard follows —
 * so "the agent decided it was allowed to" is not a reachable state.
 */

const {
  CAPABILITIES,
  CONTRACT_DEFAULTS,
  DESTRUCTIVE_KINDS,
  DESTRUCTIVE_MODES,
  SCREENSHOT_RETENTION,
  resolveComputerUseOptions
} = require('./constants.cjs')
const { CODES, ComputerUseError } = require('./errors.cjs')
const { normalizeCriteria } = require('./criteria.cjs')
const { normalizeAction } = require('./action.cjs')
const { normalizeTarget } = require('./target.cjs')

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function contractError(message, details) {
  return new ComputerUseError(CODES.CONTRACT_INVALID, message, details)
}

/**
 * Builds the validated contract.
 *
 * @param {object} input raw contract, as handed over by a user, Boss or an
 *   external agent
 * @param {object} [options] runtime options (limits and safety defaults)
 */
function createContract(input = {}, options = {}) {
  if (!isPlainObject(input)) throw contractError('an execution contract must be an object', { received: typeof input })
  const effective = resolveComputerUseOptions(options)

  const goal = String(input.goal || input.objective || '').trim()
  if (!goal) throw new ComputerUseError(CODES.CONTRACT_GOAL_MISSING, 'an execution contract needs a goal')

  const limits = isPlainObject(input.limits) ? input.limits : {}
  const safety = isPlainObject(input.safety) ? input.safety : {}
  const vision = isPlainObject(input.vision) ? input.vision : {}

  const allowedCapabilities = normalizeCapabilities(input.allowed_capabilities || input.allowedCapabilities, effective.allowedCapabilities)
  const destructive = normalizeDestructiveMode(safety.destructive_actions ?? safety.destructiveActions ?? input.destructive_actions, effective.destructiveActions)

  const contract = {
    id: input.id ? String(input.id) : null,
    goal,
    successCriteria: normalizeCriteria(input.success_criteria || input.successCriteria || []),
    allowedCapabilities,
    safety: {
      destructiveActions: destructive,
      // Plan §34: an explicit confirmation callback is the only way a
      // "confirm" contract can proceed; without one the action is refused.
      confirm: typeof input.confirm === 'function' ? input.confirm : typeof safety.confirm === 'function' ? safety.confirm : null,
      requireForegroundWindow: safety.require_foreground_window === undefined ? true : Boolean(safety.require_foreground_window),
      requireFocusForTyping: safety.require_focus_for_typing === undefined ? true : Boolean(safety.require_focus_for_typing),
      forbiddenTargets: Array.isArray(safety.forbidden_targets) ? safety.forbidden_targets.map((entry) => normalizeTarget(entry)) : [],
      allowedCommands: Array.isArray(safety.allowed_commands) ? safety.allowed_commands.map(String) : null,
      forbiddenCommands: Array.isArray(safety.forbidden_commands) ? safety.forbidden_commands.map(String) : []
    },
    limits: {
      maxSteps: positiveInt(limits.max_steps ?? limits.maxSteps, effective.maxSteps),
      maxRetriesPerAction: clampInt(limits.max_retries_per_action ?? limits.maxRetriesPerAction, 0, 5, effective.maxRetriesPerAction),
      maxStallRecoveries: clampInt(limits.max_stall_recoveries ?? limits.maxStallRecoveries, 0, 10, effective.maxStallRecoveries),
      stepTimeoutMs: positiveInt(limits.step_timeout_ms ?? limits.stepTimeoutMs, effective.stepTimeoutMs),
      runTimeoutMs: positiveInt(limits.run_timeout_ms ?? limits.runTimeoutMs, effective.runTimeoutMs)
    },
    vision: {
      retention: normalizeRetention(vision.retention ?? input.screenshot_retention ?? input.screenshotRetention, effective.screenshotRetention),
      allowFullScreenFallback: vision.allow_full_screen_fallback === undefined
        ? effective.allowFullScreenFallback
        : Boolean(vision.allow_full_screen_fallback),
      maxScreenshots: positiveInt(vision.max_screenshots ?? vision.maxScreenshots, 200)
    },
    plan: normalizePlan(input.plan || input.steps || []),
    // Plan §49: autonomous continuation is opt-in per contract; the runtime can
    // be told to keep going through recovery without handing it the wheel.
    autonomyEnabled: input.autonomy_enabled === undefined && input.autonomyEnabled === undefined
      ? effective.autonomyEnabled
      : Boolean(input.autonomy_enabled ?? input.autonomyEnabled),
    workspace: input.workspace ? String(input.workspace) : effective.workspace || null,
    metadata: isPlainObject(input.metadata) ? { ...input.metadata } : {},
    source: input.source ? String(input.source) : 'unknown'
  }
  return contract
}

function normalizeCapabilities(input, fallback) {
  if (input === undefined || input === null) return [...fallback]
  if (!Array.isArray(input)) throw contractError('allowed_capabilities must be an array')
  const unknown = input.filter((capability) => !CAPABILITIES.includes(String(capability)))
  if (unknown.length) throw contractError(`unknown capabilities: ${unknown.join(', ')}`, { supported: CAPABILITIES })
  return [...new Set(input.map(String))]
}

function normalizeDestructiveMode(input, fallback) {
  if (input === undefined || input === null) return fallback
  const mode = String(input).toLowerCase()
  if (!Object.values(DESTRUCTIVE_MODES).includes(mode)) {
    throw contractError(`destructive_actions must be one of: ${Object.values(DESTRUCTIVE_MODES).join(', ')}`, { received: input })
  }
  return mode
}

function normalizeRetention(input, fallback) {
  if (input === undefined || input === null) return fallback
  const mode = String(input).toLowerCase()
  if (!Object.values(SCREENSHOT_RETENTION).includes(mode)) {
    throw contractError(`screenshot retention must be one of: ${Object.values(SCREENSHOT_RETENTION).join(', ')}`, { received: input })
  }
  return mode
}

/**
 * Plan steps. A step is either a raw action contract or a small envelope:
 *   { id, description, action, repeat, maxAttempts, optional }
 * `optional` steps may fail without failing the run (plan §37 local failure
 * isolation), which is what makes a "best effort" hint expressible safely.
 */
function normalizePlan(input) {
  if (input === undefined || input === null) return []
  if (!Array.isArray(input)) throw contractError('plan must be an array of steps')
  return input.map((step, index) => {
    if (step === null || step === undefined) throw contractError(`plan step #${index} is empty`)
    const envelope = isPlainObject(step) && (step.action || step.actions) ? step : { action: step }
    const actions = envelope.actions
      ? envelope.actions.map((entry, position) => wrapAction(entry, `${index}.${position}`))
      : [wrapAction(envelope.action, String(index))]
    return {
      id: envelope.id ? String(envelope.id) : `step-${index + 1}`,
      description: envelope.description ? String(envelope.description) : null,
      actions,
      optional: Boolean(envelope.optional),
      maxAttempts: clampInt(envelope.max_attempts ?? envelope.maxAttempts, 0, 5, null),
      expectedEffect: envelope.expected_effect || envelope.expectedEffect || null,
      when: envelope.when ? String(envelope.when) : null
    }
  })
}

function wrapAction(input, position) {
  try {
    return normalizeAction(input)
  } catch (error) {
    throw new ComputerUseError(CODES.PLAN_INVALID, `plan step ${position} is not a valid action: ${error.message}`, {
      step: position,
      cause: error.code || null
    })
  }
}

function hasCapability(contract, capability) {
  return contract.allowedCapabilities.includes(capability)
}

/** Throws when a contract does not allow the capability an action needs. */
function assertCapability(contract, capability, details = {}) {
  if (!contract) throw contractError('no execution contract is active')
  if (!hasCapability(contract, capability)) {
    throw new ComputerUseError(CODES.CAPABILITY_NOT_ALLOWED, `capability "${capability}" is not allowed by this contract`, {
      capability,
      allowed: contract.allowedCapabilities,
      ...details
    })
  }
  return true
}

/** The destructive families this contract explicitly names (for the log). */
function declaredDestructiveKinds(contract) {
  const declared = contract && contract.metadata ? contract.metadata.destructive_kinds : null
  if (!Array.isArray(declared)) return []
  return declared.map(String).map((kind) => kind.toUpperCase()).filter((kind) => DESTRUCTIVE_KINDS.includes(kind))
}

function positiveInt(value, fallback) {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : fallback
}

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isInteger(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** A log-safe summary: never the full plan payload. */
function describeContract(contract) {
  return {
    id: contract.id,
    goal: contract.goal,
    capabilities: contract.allowedCapabilities,
    destructiveActions: contract.safety.destructiveActions,
    steps: contract.plan.length,
    criteria: contract.successCriteria.map((criterion) => criterion.description),
    limits: contract.limits,
    autonomyEnabled: contract.autonomyEnabled
  }
}

module.exports = {
  createContract,
  normalizePlan,
  hasCapability,
  assertCapability,
  declaredDestructiveKinds,
  describeContract,
  CONTRACT_DEFAULTS
}
