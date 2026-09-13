'use strict'

/**
 * DS-Hns: a restart the user schedules, and the rules that make it safe to act on.
 *
 * Restarting the machine is the one thing this product can do that no later apology can undo, so
 * the model is deliberately narrow and everything about it is decided *before* the moment it fires:
 *
 *   * **when** — a wall-clock time, or a countdown; both become one absolute `dueAt`, so nothing
 *     downstream has to reinterpret "in twenty minutes" after a reload;
 *   * **what it is for** — no target (just restart), the sub-worker, or an engineering episode;
 *   * **whether it waits** — a long task must not be interrupted mid-stage; the restart is held
 *     until the target reports a boundary it can be parked at, and only then released;
 *   * **what happens afterwards** — the target is parked, an intent is written, the machine and the
 *     application come back, and the intent is what continues the task.
 *
 * A plan is state, not a closure: it is written to disk, it survives the application reloading, it
 * can be edited or deleted while it is still waiting, and it is *not* editable once it has fired.
 * This module owns that lifecycle and nothing else — it never touches the OS, the clock's passage
 * is the caller's `now`, and every function is pure enough to argue about in a test.
 */

const PLAN_STATES = Object.freeze({
  /** Waiting for its moment. This is the state a plan spends almost all of its life in. */
  PENDING: 'pending',
  /** Its moment arrived, but the target task has not reached a boundary it can be parked at. */
  WAITING_BOUNDARY: 'waiting-boundary',
  /** The restart has been issued: parked, intent written, `shutdown` asked for. */
  EXECUTING: 'executing',
  /** The application came back and the intent was acted on. A plan never returns from this. */
  DONE: 'done',
  /** The restart could not be issued at all, with the reason kept. */
  FAILED: 'failed',
  /** The user removed it, or cancelled the countdown before it fired. */
  CANCELLED: 'cancelled'
})

/** The states a plan may still be changed in. Anything else is history. */
const EDITABLE_STATES = Object.freeze([PLAN_STATES.PENDING, PLAN_STATES.WAITING_BOUNDARY])

const TARGET_KINDS = Object.freeze({
  NONE: 'none',
  SUB_WORKER: 'sub-worker',
  ENGINEERING: 'engineering'
})

const PLAN_MODES = Object.freeze({ AT: 'at', AFTER: 'after' })

const REBOOT_REASONS = Object.freeze({
  BAD_MODE: 'REBOOT_BAD_MODE',
  BAD_TIME: 'REBOOT_BAD_TIME',
  BAD_COUNTDOWN: 'REBOOT_BAD_COUNTDOWN',
  BAD_TARGET: 'REBOOT_BAD_TARGET',
  NOT_FOUND: 'REBOOT_PLAN_NOT_FOUND',
  NOT_EDITABLE: 'REBOOT_PLAN_NOT_EDITABLE',
  UNSUPPORTED: 'REBOOT_UNSUPPORTED_PLATFORM',
  COMMAND_FAILED: 'REBOOT_COMMAND_FAILED',
  NOT_ARMED: 'REBOOT_RELAUNCH_NOT_ARMED'
})

/** A label is shown on the dashboard, so it is bounded and single-line. */
const LABEL_LIMIT = 120
const REASON_LIMIT = 400
/** An hour is plenty for a countdown; longer belongs on a calendar, not in a dock. */
const MAX_COUNTDOWN_MS = 24 * 60 * 60 * 1000

function text(value, limit) {
  return String(value === undefined || value === null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, limit)
}

function number(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * `HH:MM` on the clock, today or tomorrow.
 *
 * A time that has already passed today means tomorrow: a user who types `07:00` at 09:00 is
 * scheduling tomorrow morning, not asking for a restart in the past.
 */
function clockTimeToMs(value, now) {
  const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/)
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  const seconds = match[3] === undefined ? 0 : Number(match[3])
  if (hours > 23 || minutes > 59 || seconds > 59) return null
  const at = new Date(now)
  at.setHours(hours, minutes, seconds, 0)
  if (at.getTime() <= now) at.setDate(at.getDate() + 1)
  return at.getTime()
}

/** An ISO timestamp, or `HH:MM`, or nothing. */
function resolveDueAt(input, now) {
  if (input.at !== undefined && input.at !== null && String(input.at).trim()) {
    const raw = String(input.at).trim()
    if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
      const parsed = Date.parse(raw)
      return Number.isFinite(parsed) ? parsed : null
    }
    return clockTimeToMs(raw, now)
  }
  const minutes = number(input.afterMinutes)
  const seconds = number(input.afterSeconds)
  if (minutes === null && seconds === null) return null
  const ms = (minutes === null ? 0 : minutes * 60_000) + (seconds === null ? 0 : seconds * 1000)
  if (ms <= 0 || ms > MAX_COUNTDOWN_MS) return null
  return now + ms
}

/**
 * Build a plan, or refuse it with a reason.
 *
 * @param {object} input `{ mode, at, afterMinutes, afterSeconds, target, targetId, waitForBoundary,
 *   resumeAfterRestart, label, reason, graceSeconds }`
 * @param {object} [context] `{ now, id }`
 */
function createPlan(input = {}, context = {}) {
  const now = Number.isFinite(context.now) ? context.now : Date.now()
  const mode = String(input.mode || (input.afterMinutes || input.afterSeconds ? PLAN_MODES.AFTER : PLAN_MODES.AT)).toLowerCase()
  if (![PLAN_MODES.AT, PLAN_MODES.AFTER].includes(mode)) {
    return { ok: false, code: REBOOT_REASONS.BAD_MODE, reason: `mode must be "at" or "after", got "${input.mode}"` }
  }
  const dueAt = resolveDueAt(input, now)
  if (dueAt === null) {
    const code = mode === PLAN_MODES.AT ? REBOOT_REASONS.BAD_TIME : REBOOT_REASONS.BAD_COUNTDOWN
    const reason = mode === PLAN_MODES.AT
      ? `"${input.at || ''}" is not a time this can be scheduled for (use HH:MM or an ISO timestamp)`
      : 'a countdown needs afterMinutes or afterSeconds, between zero and 24 hours'
    return { ok: false, code, reason }
  }
  if (dueAt <= now) return { ok: false, code: REBOOT_REASONS.BAD_TIME, reason: 'that moment has already passed' }

  const kind = String(input.target && input.target.kind ? input.target.kind : input.targetKind || TARGET_KINDS.NONE).toLowerCase()
  if (!Object.values(TARGET_KINDS).includes(kind)) {
    return { ok: false, code: REBOOT_REASONS.BAD_TARGET, reason: `unknown target "${kind}"` }
  }
  const target = { kind, id: input.target && input.target.id ? String(input.target.id) : input.targetId ? String(input.targetId) : null }
  const hasTarget = kind !== TARGET_KINDS.NONE
  const graceSeconds = number(input.graceSeconds)

  return {
    ok: true,
    plan: {
      id: String(context.id || `rb${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`),
      mode,
      dueAt,
      requestedAt: now,
      createdAt: now,
      updatedAt: now,
      target,
      // Waiting for a boundary only means something when a task is the reason for the restart.
      waitForBoundary: typeof input.waitForBoundary === 'boolean' ? input.waitForBoundary : hasTarget,
      resumeAfterRestart: typeof input.resumeAfterRestart === 'boolean' ? input.resumeAfterRestart : hasTarget,
      graceSeconds: graceSeconds === null ? 60 : Math.max(0, Math.min(600, Math.round(graceSeconds))),
      label: text(input.label, LABEL_LIMIT) || (hasTarget ? '重启以继续任务' : '定时重启'),
      reason: text(input.reason, REASON_LIMIT) || 'scheduled from the Mega dock',
      state: PLAN_STATES.PENDING,
      detail: null,
      stateChangedAt: now,
      firedAt: null
    }
  }
}

/** May this plan still be changed? */
function isEditable(plan) {
  return Boolean(plan) && EDITABLE_STATES.includes(String(plan.state))
}

/**
 * Apply an edit to a plan that has not fired.
 *
 * Editing re-derives the schedule through the same validation as creation: a patched plan must be
 * as valid as a new one, or the edit is refused and the plan keeps the values it had.
 */
function updatePlan(plan, patch = {}, context = {}) {
  const now = Number.isFinite(context.now) ? context.now : Date.now()
  if (!plan) return { ok: false, code: REBOOT_REASONS.NOT_FOUND, reason: 'no such restart plan' }
  if (!isEditable(plan)) {
    return { ok: false, code: REBOOT_REASONS.NOT_EDITABLE, reason: `a plan in state "${plan.state}" can no longer be changed` }
  }
  // Only the fields an edit may touch reach `createPlan`, so an edit cannot smuggle in a new id or
  // a state.
  const merged = {
    mode: patch.mode === undefined ? plan.mode : patch.mode,
    at: patch.at,
    afterMinutes: patch.afterMinutes,
    afterSeconds: patch.afterSeconds,
    targetKind: patch.target && patch.target.kind ? patch.target.kind : patch.targetKind === undefined ? plan.target.kind : patch.targetKind,
    targetId: patch.target && 'id' in patch.target ? patch.target.id : patch.targetId === undefined ? plan.target.id : patch.targetId,
    waitForBoundary: patch.waitForBoundary === undefined ? plan.waitForBoundary : patch.waitForBoundary,
    resumeAfterRestart: patch.resumeAfterRestart === undefined ? plan.resumeAfterRestart : patch.resumeAfterRestart,
    graceSeconds: patch.graceSeconds === undefined ? plan.graceSeconds : patch.graceSeconds,
    label: patch.label === undefined ? plan.label : patch.label,
    reason: patch.reason === undefined ? plan.reason : patch.reason
  }
  // A time-only plan edited with a countdown (or the reverse) has to be re-derived; when the patch
  // does not carry a new schedule, the plan's own timing is pushed forward by re-using `dueAt`.
  if (merged.mode === PLAN_MODES.AT && merged.at === undefined) merged.at = plan.dueAt
  if (merged.mode === PLAN_MODES.AFTER && merged.afterMinutes === undefined && merged.afterSeconds === undefined) {
    merged.afterMinutes = Math.max(1 / 60, (plan.dueAt - now) / 60_000)
  }
  const created = createPlan(merged, { now, id: plan.id })
  if (!created.ok) return created
  const next = {
    ...created.plan,
    createdAt: plan.createdAt,
    requestedAt: plan.requestedAt,
    updatedAt: now,
    state: plan.state === PLAN_STATES.WAITING_BOUNDARY ? PLAN_STATES.PENDING : plan.state,
    detail: null,
    stateChangedAt: now
  }
  return { ok: true, plan: next, changed: changedFields(plan, next) }
}

function changedFields(before, after) {
  const fields = []
  for (const key of ['mode', 'dueAt', 'waitForBoundary', 'resumeAfterRestart', 'graceSeconds', 'label', 'reason']) {
    if (before[key] !== after[key]) fields.push(key)
  }
  if ((before.target && before.target.kind) !== (after.target && after.target.kind)) fields.push('target.kind')
  if ((before.target && before.target.id) !== (after.target && after.target.id)) fields.push('target.id')
  return fields
}

/** Milliseconds until the plan's moment; negative once it has passed. */
function remainingMs(plan, now = Date.now()) {
  return Number(plan && plan.dueAt) - now
}

function isDue(plan, now = Date.now()) {
  return Boolean(plan) && remainingMs(plan, now) <= 0
}

/** Everything the dashboard and the panel need about one plan. */
function describePlan(plan, now = Date.now()) {
  if (!plan) return null
  const remaining = remainingMs(plan, now)
  return {
    id: plan.id,
    mode: plan.mode,
    state: plan.state,
    dueAt: plan.dueAt,
    requestedAt: plan.requestedAt,
    updatedAt: plan.updatedAt,
    target: { ...plan.target },
    waitForBoundary: plan.waitForBoundary === true,
    resumeAfterRestart: plan.resumeAfterRestart === true,
    graceSeconds: plan.graceSeconds,
    label: plan.label,
    reason: plan.reason,
    detail: plan.detail || null,
    remainingMs: remaining,
    due: remaining <= 0,
    editable: isEditable(plan),
    /** True while the dashboard should draw a countdown rather than a wall-clock time. */
    counting: remaining > 0 && remaining <= 24 * 60 * 60 * 1000,
    summary: summarize(plan, remaining)
  }
}

/** One bilingual line per plan, for the dashboard card. */
function summarize(plan, remaining) {
  const target = plan.target && plan.target.kind !== TARGET_KINDS.NONE ? plan.target.kind : null
  const wait = plan.waitForBoundary && target ? '，等当前阶段完成' : ''
  const resume = plan.resumeAfterRestart && target ? '，重启后继续' : ''
  const when = remaining > 0 ? `${formatDuration(remaining)} 后` : '即将'
  const cn = `${when}重启${target ? `（${target}${wait}${resume}）` : ''}`
  const en = `restart in ${formatDuration(remaining)}${target ? ` (${target}${plan.waitForBoundary ? ', after the current stage' : ''}${plan.resumeAfterRestart ? ', then continue' : ''})` : ''}`
  return { cn, en }
}

/** `3h 12m`, `12m 05s`, `45s` — short enough for a dashboard card. */
function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours) return `${hours}h ${String(minutes).padStart(2, '0')}m`
  if (minutes) return `${minutes}m ${String(seconds).padStart(2, '0')}s`
  return `${seconds}s`
}

module.exports = {
  PLAN_STATES,
  PLAN_MODES,
  TARGET_KINDS,
  EDITABLE_STATES,
  REBOOT_REASONS,
  LABEL_LIMIT,
  REASON_LIMIT,
  MAX_COUNTDOWN_MS,
  clockTimeToMs,
  resolveDueAt,
  createPlan,
  updatePlan,
  isEditable,
  isDue,
  remainingMs,
  describePlan,
  formatDuration
}
