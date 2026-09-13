'use strict'

/**
 * Computer Use Runtime: focus trust.
 *
 *   attempted focus  ≠  verified focus
 *
 * Typing goes to whatever has focus, not to what the runtime intended to focus.
 * The old shape kept one `verifiedFocusRef` that was written when a focus action
 * was *issued*, which means a focus that silently failed could authorize an
 * unbounded number of later keystrokes — the exact class of error that makes a
 * long run type a token into the wrong window.
 *
 * So there are two fields and they are never conflated:
 *
 *   attemptedFocusRef   what the runtime just tried to focus (evidence of an
 *                       intention, useful in a log, authorizing nothing)
 *   verifiedFocusRef    what a *verification* confirmed is focused
 *
 * and the verified reference is dropped the moment it stops being trustworthy:
 * the window changed, the page navigated, the target detached, the verification
 * failed, or the verification could not be performed at all. Re-establishing it
 * costs one FOCUS step; guessing costs the task.
 */

/** Why a verified focus was dropped. Every reason is a real invalidation. */
const FOCUS_INVALIDATION = Object.freeze({
  WINDOW_CHANGED: 'window_changed',
  NAVIGATION: 'navigation',
  TARGET_DETACHED: 'target_detached',
  VERIFICATION_FAILED: 'verification_failed',
  VERIFICATION_UNKNOWN: 'verification_unknown',
  STEP_RESET: 'step_reset'
})

/**
 * The reasons that always invalidate: nothing can keep a focus across these.
 *
 * `STEP_RESET` belongs here. A reference that outlives the step that verified it
 * is a stale reference, and a long run cannot afford them.
 */
const HARD_INVALIDATIONS = Object.freeze([
  FOCUS_INVALIDATION.WINDOW_CHANGED,
  FOCUS_INVALIDATION.NAVIGATION,
  FOCUS_INVALIDATION.TARGET_DETACHED,
  FOCUS_INVALIDATION.VERIFICATION_FAILED,
  FOCUS_INVALIDATION.VERIFICATION_UNKNOWN,
  FOCUS_INVALIDATION.STEP_RESET
])

/**
 * @param {object} [options]
 * @param {Function} [options.now]
 */
function createFocusTrust(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const history = []

  let attemptedRef = null
  let attemptedAt = null
  let verifiedRef = null
  let verifiedAt = null
  let lastInvalidation = null
  let windowSignature = null
  let navigationSignature = null

  function note(entry) {
    const record = { at: now(), ...entry }
    history.push(record)
    if (history.length > 100) history.splice(0, history.length - 100)
    return record
  }

  /**
   * Record an attempt. This authorizes **nothing**: it exists so the log can show
   * "we tried to focus X and then verified Y", which is what makes a focus bug
   * diagnosable instead of mysterious.
   */
  function attempt(ref, detail = {}) {
    attemptedRef = ref || null
    attemptedAt = now()
    return note({ kind: 'attempt', ref: attemptedRef, ...detail })
  }

  /**
   * Record a verification outcome for the focus that was attempted.
   *
   * Only `success` promotes the reference. `failure` and `unknown` both clear it:
   * "we could not tell" is not permission to type.
   *
   * @param {string} verdict `success` | `failure` | `unknown`
   * @param {string|null} ref the element that is actually focused, when known
   * @returns {{verified:boolean, ref:string|null, reason:string}}
   */
  function verified(verdict, ref = null) {
    if (verdict === 'success' && ref) {
      verifiedRef = ref
      verifiedAt = now()
      note({ kind: 'verified', ref, verdict })
      return { verified: true, ref, reason: 'the focus was verified' }
    }
    const reason = verdict === 'unknown'
      ? FOCUS_INVALIDATION.VERIFICATION_UNKNOWN
      : FOCUS_INVALIDATION.VERIFICATION_FAILED
    invalidate(reason, { verdict, ref: ref || null })
    return { verified: false, ref: null, reason }
  }

  /**
   * Drop the verified reference.
   *
   * @param {string} reason one of FOCUS_INVALIDATION
   */
  function invalidate(reason, detail = {}) {
    const had = verifiedRef !== null
    if (had) lastInvalidation = { reason, at: now(), previous: verifiedRef, ...detail }
    verifiedRef = null
    verifiedAt = null
    note({ kind: 'invalidate', reason, had, ...detail })
    return { invalidated: had, reason }
  }

  /**
   * Observe the world's context and invalidate the verified focus when it no
   * longer applies. Called once per step, before the focus gate is consulted.
   *
   * @param {object} world the current world state
   * @returns {{invalidated:boolean, reasons:string[]}}
   */
  function observeContext(world) {
    if (!world) return { invalidated: false, reasons: [] }
    const reasons = []
    const nextWindow = world.windowSignature === undefined ? null : world.windowSignature
    const nextNavigation = `${world.url === undefined ? '' : world.url}|${world.title === undefined ? '' : world.title}`
    if (windowSignature !== null && nextWindow !== null && windowSignature !== nextWindow) {
      reasons.push(FOCUS_INVALIDATION.WINDOW_CHANGED)
    }
    if (navigationSignature !== null && sessionChanged(navigationSignature, nextNavigation)) {
      reasons.push(FOCUS_INVALIDATION.NAVIGATION)
    }
    windowSignature = nextWindow
    navigationSignature = nextNavigation

    // A verified reference whose element is gone from the world is detached.
    if (verifiedRef) {
      const present = Array.isArray(world.controls) && world.controls.some((control) => control && control.ref === verifiedRef)
      const isFocused = world.focusedRef === verifiedRef
      if (!present && !isFocused) reasons.push(FOCUS_INVALIDATION.TARGET_DETACHED)
    }

    const unique = [...new Set(reasons)]
    for (const reason of unique) invalidate(reason, { source: 'context' })
    return { invalidated: unique.length > 0, reasons: unique }
  }

  function sessionChanged(previous, next) {
    const [previousUrl, previousTitle] = String(previous).split('|')
    const [nextUrl, nextTitle] = String(next).split('|')
    // A title change alone is not a navigation (a page can retitle itself while
    // the same document stays focused); the URL is what identifies the document.
    return previousUrl !== nextUrl && (previousTitle === nextTitle || previousUrl === '' || nextUrl === '')
  }

  /** May the runtime type right now? */
  function trust() {
    return {
      trusted: verifiedRef !== null,
      ref: verifiedRef,
      verifiedAt,
      attemptedRef,
      attemptedAt,
      ageMs: verifiedAt === null ? null : now() - verifiedAt,
      lastInvalidation
    }
  }

  /**
   * Start a step.
   *
   * A verified focus reference belongs to the step that verified it. Carrying it
   * across a step boundary is exactly how a stale reference accumulates over a
   * long run — the element may be gone, the dialog may have been replaced, the
   * page may have re-rendered — so the token is *dropped* here and re-established
   * by the next step's own verification (the resume-safe step boundary).
   *
   * `reset` defaults to true and exists so a caller that deliberately holds a
   * focus across a step (a modal pause that resumes the same step) can say so.
   *
   * @param {object} [options]
   * @param {boolean} [options.reset] drop the verified reference (default true)
   * @returns {object} the trust state *after* the boundary
   */
  function beginStep({ reset = true } = {}) {
    if (reset) invalidate(FOCUS_INVALIDATION.STEP_RESET, { source: 'step boundary' })
    return trust()
  }

  function snapshot() {
    return {
      attemptedFocusRef: attemptedRef,
      attemptedAt,
      verifiedFocusRef: verifiedRef,
      verifiedAt,
      lastInvalidation,
      windowSignature,
      navigationSignature
    }
  }

  return {
    FOCUS_INVALIDATION,
    HARD_INVALIDATIONS,
    attempt,
    verified,
    invalidate,
    observeContext,
    trust,
    beginStep,
    snapshot,
    history() {
      return history.slice()
    },
    get verifiedFocusRef() {
      return verifiedRef
    },
    get attemptedFocusRef() {
      return attemptedRef
    }
  }
}

module.exports = { createFocusTrust, FOCUS_INVALIDATION, HARD_INVALIDATIONS }
