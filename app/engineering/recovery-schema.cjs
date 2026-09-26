'use strict'

/** Versioned, replay-safe on-disk contract for engineering recovery. */

const crypto = require('node:crypto')
const path = require('node:path')

const RECOVERY_DESCRIPTOR_VERSION = 1
const RECOVERY_PLAN_VERSION = 1
const EXECUTOR_COMPATIBILITY = 'engineering-v1'
const RECOVERY_STATES = Object.freeze(['ACTIVE', 'RECOVERY_BLOCKED', 'COMPLETED', 'CANCELLED'])
const STEP_ID = /^[A-Za-z0-9][A-Za-z0-9:._#-]{0,255}$/
const EPISODE_ID_MAX = 512

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isAbsolutePath(value) {
  return typeof value === 'string' && (path.isAbsolute(value) || path.win32.isAbsolute(value))
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!isRecord(value)) return value
  const output = {}
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined && typeof value[key] !== 'function') output[key] = canonicalize(value[key])
  }
  return output
}

function computePlanDigest(plan) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(canonicalize(plan)), 'utf8').digest('hex')}`
}

function fail(code, reason) {
  return { ok: false, code, reason }
}

function uniqueKnownIds(value, stepIds, label) {
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || !stepIds.has(id))) {
    return { ok: false, reason: `${label} must contain only known step identifiers` }
  }
  if (new Set(value).size !== value.length) return { ok: false, reason: `${label} must not contain duplicate identifiers` }
  return { ok: true, values: value }
}

function validateRecoveryDescriptor(input, options = {}) {
  if (!isRecord(input)) return fail('RECOVERY_DESCRIPTOR_INVALID', 'the recovery descriptor must be an object')
  if (input.version !== RECOVERY_DESCRIPTOR_VERSION) {
    return fail('RECOVERY_VERSION_UNSUPPORTED', `recovery descriptor version ${String(input.version)} is not supported`)
  }
  if (typeof input.episodeId !== 'string' || !input.episodeId.trim() || input.episodeId.length > EPISODE_ID_MAX) {
    return fail('EPISODE_ID_INVALID', 'the recovery descriptor needs a bounded episode id')
  }
  if (options.episodeId !== undefined && input.episodeId !== String(options.episodeId)) {
    return fail('EPISODE_ID_MISMATCH', 'the recovery descriptor episode id does not match its checkpoint')
  }

  const request = input.request
  if (!isRecord(request) || !isAbsolutePath(request.workspace) || typeof request.goal !== 'string' || !request.goal.trim() ||
    !isRecord(request.contract)) {
    return fail('REQUEST_INVALID', 'the original request must contain an absolute workspace, goal, time budget, and object contract')
  }
  if (!Number.isFinite(request.startedAt) || !Number.isFinite(request.deadlineAt) || request.deadlineAt <= request.startedAt) {
    return fail('REQUEST_DEADLINE_INVALID', 'the original absolute deadline must be after the original start time')
  }

  const plan = input.plan
  if (!isRecord(plan) || plan.version !== RECOVERY_PLAN_VERSION) {
    return fail('PLAN_VERSION_UNSUPPORTED', `plan version ${String(plan && plan.version)} is not supported`)
  }
  if (typeof plan.id !== 'string' || !plan.id || typeof plan.goal !== 'string' ||
    typeof plan.intent !== 'string' || !Number.isFinite(plan.createdAt) || !Array.isArray(plan.steps) ||
    plan.steps.length > 1000 || !isRecord(plan.budget) || !Number.isInteger(plan.budget.maxSteps) ||
    plan.budget.maxSteps < plan.steps.length || !Array.isArray(plan.reasons) || plan.reasons.some((reason) => typeof reason !== 'string')) {
    return fail('PLAN_INVALID', 'the serialized plan is incomplete or outside the supported bounds')
  }
  if (plan.goal !== request.goal) return fail('PLAN_GOAL_MISMATCH', 'the serialized plan goal does not match the original request')
  const stepIds = new Set()
  for (const step of plan.steps) {
    if (!isRecord(step) || typeof step.id !== 'string' || !STEP_ID.test(step.id) || stepIds.has(step.id) ||
      typeof step.kind !== 'string' || (step.args !== undefined && (!Array.isArray(step.args) || step.args.some((arg) => typeof arg !== 'string')))) {
      return fail('PLAN_STEP_INVALID', 'every plan step must have a unique id, kind, and serializable argument list')
    }
    stepIds.add(step.id)
  }
  if (typeof input.planDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(input.planDigest) || computePlanDigest(plan) !== input.planDigest) {
    return fail('PLAN_DIGEST_MISMATCH', 'the saved plan digest does not match the complete embedded plan')
  }

  const cursor = input.cursor
  if (!isRecord(cursor) || !Number.isInteger(cursor.nextStepIndex) || cursor.nextStepIndex < 0 || cursor.nextStepIndex > plan.steps.length ||
    !Number.isSafeInteger(cursor.checkpointSeq) || cursor.checkpointSeq < 1) {
    return fail('CURSOR_INVALID', 'the recovery cursor needs a bounded next-step index and positive checkpoint sequence')
  }
  const verified = uniqueKnownIds(cursor.verifiedStepIds, stepIds, 'verifiedStepIds')
  if (!verified.ok) return fail('CURSOR_INVALID', verified.reason)
  const skipped = uniqueKnownIds(cursor.skippedStepIds, stepIds, 'skippedStepIds')
  if (!skipped.ok) return fail('CURSOR_INVALID', skipped.reason)
  const verifiedIds = new Set(verified.values)
  const skippedIds = new Set(skipped.values)
  if ([...verifiedIds].some((id) => skippedIds.has(id))) return fail('CURSOR_INVALID', 'a step cannot be both verified and skipped')
  if ([...skippedIds].some((id) => plan.steps.find((step) => step.id === id).optional !== true)) {
    return fail('CURSOR_INVALID', 'only optional plan steps may be restored as skipped')
  }
  let safeNext = 0
  while (safeNext < plan.steps.length) {
    const id = plan.steps[safeNext].id
    if (!verifiedIds.has(id) && !skippedIds.has(id)) break
    safeNext += 1
  }
  if (cursor.nextStepIndex !== safeNext) return fail('CURSOR_UNVERIFIED', 'the cursor moves beyond the contiguous verified or intentionally skipped prefix')
  const lastVerified = cursor.lastVerifiedStepId
  const expectedLastVerified = plan.steps.slice(0, safeNext).map((step) => step.id).reverse().find((id) => verifiedIds.has(id)) || null
  if (lastVerified !== expectedLastVerified) {
    return fail('CURSOR_INVALID', 'lastVerifiedStepId must name a verified step before the next-step cursor')
  }

  if (input.fingerprint !== null && input.fingerprint !== undefined && !isRecord(input.fingerprint)) {
    return fail('FINGERPRINT_INVALID', 'the repository fingerprint must be an object when supplied')
  }
  for (const field of ['verifiedMutationIds', 'unresolvedMutationIds']) {
    if (!Array.isArray(input[field]) || input[field].some((id) => typeof id !== 'string' || !id)) {
      return fail('MUTATION_IDS_INVALID', `${field} must be an array of non-empty mutation identifiers`)
    }
    if (new Set(input[field]).size !== input[field].length) return fail('MUTATION_IDS_INVALID', `${field} must not contain duplicate identifiers`)
  }
  if (input.verifiedMutationIds.some((id) => input.unresolvedMutationIds.includes(id))) {
    return fail('MUTATION_IDS_INVALID', 'a mutation cannot be both verified and unresolved')
  }
  if (typeof input.executorCompatibility !== 'string' || !input.executorCompatibility.trim()) {
    return fail('EXECUTOR_COMPATIBILITY_INVALID', 'an explicit executor compatibility version is required')
  }
  if (options.executorCompatibility && input.executorCompatibility !== options.executorCompatibility) {
    return fail('EXECUTOR_COMPATIBILITY_MISMATCH', 'the saved episode belongs to a different executor compatibility version')
  }
  if (!isAbsolutePath(input.workRoot)) return fail('WORK_ROOT_INVALID', 'the selected work root must be an absolute path')
  if (!Array.isArray(input.crossVolumeTemp)) return fail('CROSS_VOLUME_REGISTRY_INVALID', 'crossVolumeTemp must be an array')
  if (input.crossVolumeTemp.length > 1000) return fail('CROSS_VOLUME_REGISTRY_INVALID', 'crossVolumeTemp exceeds the supported entry limit')
  if (!RECOVERY_STATES.includes(input.lifecycleState === undefined ? 'ACTIVE' : input.lifecycleState)) {
    return fail('LIFECYCLE_STATE_UNSUPPORTED', `lifecycle state ${String(input.lifecycleState)} is not supported`)
  }
  if (input.lifecycleState === 'RECOVERY_BLOCKED' && input.blockedReason !== undefined && typeof input.blockedReason !== 'string') {
    return fail('BLOCKED_REASON_INVALID', 'blockedReason must be text when supplied')
  }
  if (input.repairAuthorized !== undefined && typeof input.repairAuthorized !== 'boolean') {
    return fail('REPAIR_AUTHORIZATION_INVALID', 'repairAuthorized must be a boolean when supplied')
  }

  const descriptor = JSON.parse(JSON.stringify(input))
  if (descriptor.lifecycleState === undefined) descriptor.lifecycleState = 'ACTIVE'
  return { ok: true, descriptor }
}

module.exports = {
  RECOVERY_DESCRIPTOR_VERSION,
  RECOVERY_PLAN_VERSION,
  EXECUTOR_COMPATIBILITY,
  RECOVERY_STATES,
  computePlanDigest,
  validateRecoveryDescriptor
}
