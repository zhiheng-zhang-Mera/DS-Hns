'use strict'

/**
 * Computer Use Runtime: meaningful progress heartbeat.
 *
 * A long-running executor has to answer one question continuously:
 *
 *   is this still working, or has it quietly stopped making progress?
 *
 * The trap is answering it with something that is always true. A timer ticking,
 * a log line being written, an action being *issued* — all of those happen even
 * when the task is stuck, so treating any of them as progress makes a stall
 * undetectable. This module therefore accepts only progress that is **evidence
 * that the world changed in a way the task cares about**:
 *
 *   verified-effect      a verification observed the intended effect
 *   subprocess-exit      an owned process finished (with its exit code)
 *   file-operation       a filesystem mutation was verified on disk
 *   state-transition     the run moved to a new state it had not reached
 *   criteria-satisfied   a success criterion became true
 *
 * and explicitly refuses:
 *
 *   a heartbeat that only ticks
 *   a repeated no-op (the same action, the same unchanged world)
 *   the runtime's own bookkeeping going round
 *
 * Nothing here is remembered across tasks (no application learning, no
 * business-level knowledge): the tracker is constructed per run and
 * discarded with the world state.
 */

/** The only progress kinds that count. */
const PROGRESS_KINDS = Object.freeze({
  VERIFIED_EFFECT: 'verified-effect',
  SUBPROCESS_EXIT: 'subprocess-exit',
  FILE_OPERATION: 'file-operation',
  STATE_TRANSITION: 'state-transition',
  CRITERIA_SATISFIED: 'criteria-satisfied'
})

const PROGRESS_KIND_LIST = Object.freeze(Object.values(PROGRESS_KINDS))

/**
 * Verification kinds that prove an effect landed. A "direct" world-change
 * inference is deliberately excluded: it is evidence that *something* happened,
 * which is exactly what a spinner does forever.
 */
const EVIDENCE_KINDS = Object.freeze(['file', 'process', 'navigation', 'state', 'focus', 'event', 'visual'])

/**
 * @param {object} [options]
 * @param {Function} [options.now]
 * @param {number} [options.ringSize] how many progress records to keep in memory
 * @param {number} [options.repeatWindow] how many identical no-ops count as repetition
 */
function createProgressTracker(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const ringSize = Number.isInteger(options.ringSize) && options.ringSize > 0 ? options.ringSize : 200
  const repeatWindow = Number.isInteger(options.repeatWindow) && options.repeatWindow > 0 ? options.repeatWindow : 3

  const ring = []
  let lastProgressAt = null
  let lastActionAt = null
  let lastVerifiedEffectAt = null
  let lastProgress = null
  let noOpStreak = 0
  let lastNoOpSignature = null
  let heartbeats = 0

  function push(entry) {
    ring.push(entry)
    if (ring.length > ringSize) ring.splice(0, ring.length - ringSize)
    return entry
  }

  /**
   * Record a heartbeat: the runtime is alive and this call is the proof that it
   * is *not* progress.
   */
  function heartbeat(detail = {}) {
    heartbeats += 1
    return {
      alive: true,
      at: now(),
      heartbeats,
      lastProgressAt,
      lastActionAt,
      sinceProgressMs: lastProgressAt === null ? null : now() - lastProgressAt,
      ...detail
    }
  }

  /**
   * Record that an action was *issued*.
   *
   * Issuing an action is not progress: a repeated no-op does not update
   * progress. It only moves `lastActionAt`, which is what the stall detector
   * compares against `lastProgressAt` to distinguish "busy" from "making progress".
   */
  function action(detail = {}) {
    lastActionAt = now()
    return { at: lastActionAt, ...detail }
  }

  /**
   * Record a no-op: the action ran and the world did not change in a meaningful
   * way. Repeated identical no-ops are the signature of a loop, so the streak is
   * counted and exposed rather than smoothed away.
   *
   * @returns {{repeated:boolean, streak:number, signature:string|null}}
   */
  function noOp(signature = null) {
    const key = signature === null || signature === undefined ? null : String(signature)
    if (key !== null && key === lastNoOpSignature) noOpStreak += 1
    else noOpStreak = 1
    lastNoOpSignature = key
    return { repeated: noOpStreak >= repeatWindow, streak: noOpStreak, signature: key }
  }

  /**
   * Record meaningful progress. This is the only function that moves
   * `lastProgressAt`.
   *
   * @param {string} kind one of PROGRESS_KINDS
   * @param {object} [detail]
   * @returns {object|null} the recorded progress, or null when the claim was refused
   */
  function progress(kind, detail = {}) {
    const verdict = accept(kind, detail)
    if (!verdict.ok) return null
    const at = now()
    lastProgressAt = at
    if (kind === PROGRESS_KINDS.VERIFIED_EFFECT) lastVerifiedEffectAt = at
    noOpStreak = 0
    lastNoOpSignature = null
    lastProgress = { kind, at, detail }
    return push({ kind, at, step: detail.step === undefined ? null : detail.step, detail })
  }

  /**
   * Justify a progress claim. Kept separate from `progress()` so the *policy* is
   * testable without a tracker, and so a caller can ask "would this count?"
   * before it acts on the answer.
   *
   * @returns {{ok:boolean, kind:string, reason:string}}
   */
  function accept(kind, detail = {}) {
    const name = String(kind || '')
    if (!PROGRESS_KIND_LIST.includes(name)) {
      return { ok: false, kind: name, reason: `"${name}" is not a meaningful progress kind` }
    }
    if (name === PROGRESS_KINDS.VERIFIED_EFFECT) {
      const verdict = detail.verdict ? String(detail.verdict) : null
      const evidenceKind = detail.kind ? String(detail.kind) : null
      if (verdict !== 'success') {
        return { ok: false, kind: name, reason: `a verification verdict of "${verdict || 'none'}" is not progress` }
      }
      if (evidenceKind && !EVIDENCE_KINDS.includes(evidenceKind)) {
        return { ok: false, kind: name, reason: `verification kind "${evidenceKind}" only proves something changed, not that the effect landed` }
      }
      return { ok: true, kind: name, reason: 'a verification observed the intended effect' }
    }
    if (name === PROGRESS_KINDS.SUBPROCESS_EXIT) {
      if (detail.exited === false) return { ok: false, kind: name, reason: 'the process has not exited yet' }
      if (detail.exitCode === undefined || detail.exitCode === null) {
        // An exit without a code is still a real event (a killed process), but it
        // is only progress when the caller says so explicitly.
        if (detail.signalled !== true) return { ok: false, kind: name, reason: 'the process exit carries no exit code' }
      }
      return { ok: true, kind: name, reason: `an owned process finished (exit ${detail.exitCode === undefined || detail.exitCode === null ? 'signal' : detail.exitCode})` }
    }
    if (name === PROGRESS_KINDS.FILE_OPERATION) {
      if (detail.verified !== true) return { ok: false, kind: name, reason: 'the filesystem operation was not verified on disk' }
      return { ok: true, kind: name, reason: `a filesystem mutation was verified (${detail.operation || 'operation'})` }
    }
    if (name === PROGRESS_KINDS.STATE_TRANSITION) {
      const state = detail.state ? String(detail.state) : null
      if (!state) return { ok: false, kind: name, reason: 'a state transition needs the state it moved to' }
      if (detail.repeat === true) return { ok: false, kind: name, reason: `the run was already in ${state}` }
      return { ok: true, kind: name, reason: `the run moved to ${state}` }
    }
    // CRITERIA_SATISFIED
    if (detail.satisfied !== true) return { ok: false, kind: name, reason: 'the criterion is not satisfied' }
    return { ok: true, kind: name, reason: `a success criterion became true (${detail.criterion || 'criterion'})` }
  }

  /**
   * The stall-facing view: how long the runtime has been working without moving
   * the world forward.
   */
  function status() {
    const at = now()
    return {
      lastProgressAt,
      lastActionAt,
      lastVerifiedEffectAt,
      sinceProgressMs: lastProgressAt === null ? (lastActionAt === null ? null : at - lastActionAt) : at - lastProgressAt,
      sinceActionMs: lastActionAt === null ? null : at - lastActionAt,
      sinceVerifiedEffectMs: lastVerifiedEffectAt === null ? null : at - lastVerifiedEffectAt,
      noOpStreak,
      heartbeats,
      lastProgress: lastProgress
    }
  }

  /** Was there *any* meaningful progress at all? A run with none is a stall. */
  function hasProgress() {
    return lastProgressAt !== null
  }

  return {
    PROGRESS_KINDS,
    heartbeat,
    action,
    noOp,
    progress,
    status,
    hasProgress,
    /** Bounded: the ring keeps the most recent `ringSize` records only. */
    history() {
      return ring.slice()
    },
    get lastProgressAt() {
      return lastProgressAt
    },
    get noOpStreak() {
      return noOpStreak
    }
  }
}

module.exports = { createProgressTracker, PROGRESS_KINDS, PROGRESS_KIND_LIST, EVIDENCE_KINDS }
