'use strict'

/**
 * Computer Use Runtime: workspace continuity.
 *
 * A development executor writes files and runs commands. The single worst silent
 * failure available to it is a command that lands somewhere else than intended —
 * a `cd` that did not take, an inherited `process.cwd()`, a relative path resolved
 * against the wrong root — because the run keeps succeeding while the work goes to
 * `C:\Users\...`.
 *
 * The rule this module enforces:
 *
 *   every filesystem/shell operation carries a resolved cwd and a normalized path
 *   that was checked against the verified workspace boundary
 *
 * and, when there is no verified workspace:
 *
 *   BLOCK — never silently fall back to the system's current directory
 *
 * The workspace is *verified*, not assumed: it must exist and be a directory
 * before it can be used, and it is re-verified on every call so a workspace that
 * disappears mid-run is detected at the next action instead of at the next
 * mystery.
 */

const fs = require('node:fs')
const path = require('node:path')

const { CODES, ComputerUseError } = require('./errors.cjs')

/**
 * @param {object} [options]
 * @param {string} [options.workspace] the verified workspace root (absolute or resolvable)
 * @param {Function} [options.now]
 * @param {boolean} [options.allowOutside] force-allow absolute paths outside the root
 *   (the same escape hatch the file controller has; the contract decides it, and it
 *   is reported, never silent)
 */
function createWorkspaceGuard(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const allowOutside = options.allowOutside === true
  /**
   * The explicit escape hatch for a contract that really has no workspace.
   *
   * It is opt-in, named, and reported per operation, so "unscoped filesystem
   * access" is always a decision somebody made rather than the behaviour that
   * happens when a workspace argument is missing.
   */
  const unscopedFilesystem = options.unscopedFilesystem === true
  let root = null
  let rootReason = null
  let lastVerifiedAt = null
  const drifts = []

  if (options.workspace !== undefined && options.workspace !== null && String(options.workspace).trim() !== '') {
    const candidate = path.resolve(String(options.workspace))
    root = candidate
  } else {
    rootReason = 'no workspace was provided by the contract'
  }

  /** Does the workspace exist right now? Re-checked, never cached as a boolean. */
  function verify() {
    if (!root) return { ok: false, cwd: null, reason: rootReason || 'no workspace is configured' }
    try {
      const stats = fs.statSync(root)
      if (!stats.isDirectory()) return { ok: false, cwd: root, reason: `the workspace is not a directory: ${root}` }
      lastVerifiedAt = now()
      return { ok: true, cwd: root, reason: null }
    } catch (error) {
      return { ok: false, cwd: root, reason: `the workspace is not accessible: ${error && error.message ? error.message : error}` }
    }
  }

  function isInside(target, parent = root) {
    if (!parent) return false
    const relative = path.relative(parent, target)
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
  }

  /**
   * Resolve the working directory for one operation.
   *
   * @param {object} [input]
   * @param {string} [input.cwd] an explicit cwd from the action
   * @param {string} [input.step] a label for the drift log
   * @returns {{ok:boolean, cwd:string|null, source:string, reason:string|null}}
   */
  function resolveCwd({ cwd = null, step = null } = {}) {
    const verified = verify()
    if (!verified.ok) return { ok: false, cwd: null, source: 'none', reason: verified.reason }

    if (cwd === null || cwd === undefined || String(cwd).trim() === '') {
      // No cwd given: the *verified workspace* is inherited. This is the rule the
      // plan states explicitly — never `process.cwd()`.
      return { ok: true, cwd: verified.cwd, source: 'workspace', reason: null }
    }

    const requested = path.isAbsolute(String(cwd)) ? path.resolve(String(cwd)) : path.resolve(verified.cwd, String(cwd))
    if (!isInside(requested, verified.cwd)) {
      if (allowOutside) return { ok: true, cwd: requested, source: 'explicit-outside', reason: null }
      drift({ step, requested, root: verified.cwd, kind: 'cwd_outside_workspace' })
      return {
        ok: false,
        cwd: null,
        source: 'explicit',
        reason: `the requested working directory is outside the workspace: ${requested}`
      }
    }
    // A cwd inside the workspace must exist: a `cd` that failed is exactly how a
    // later command ends up somewhere unexpected.
    try {
      const stats = fs.statSync(requested)
      if (!stats.isDirectory()) {
        return { ok: false, cwd: null, source: 'explicit', reason: `the requested working directory is not a directory: ${requested}` }
      }
    } catch {
      return { ok: false, cwd: null, source: 'explicit', reason: `the requested working directory does not exist: ${requested}` }
    }
    return { ok: true, cwd: requested, source: 'explicit', reason: null }
  }

  /**
   * Normalize a path for a filesystem operation and check it against the boundary.
   *
   * **No verified workspace means no filesystem mutation.** The check is
   * fail-closed: without a workspace that exists right now, *nothing* is
   * resolved — not a relative path (which has no base without one) and not an
   * absolute path (which would otherwise be the way an unscoped write slips
   * through). A contract that genuinely operates without a workspace has to say
   * so explicitly with `unscopedFilesystem`, and then it is the caller that owns
   * the risk rather than a silent default.
   *
   * @param {string} target the path the action names
   * @param {object} [options]
   * @param {string} [options.step] a label for the drift log
   * @param {boolean} [options.unscoped] per-operation override of `unscopedFilesystem`
   * @param {boolean} [options.absolute] require the result to be absolute
   * @returns {{ok:boolean, path:string|null, reason:string|null, source:string}}
   */
  function resolvePath(target, { step = null, absolute = false, unscoped = null } = {}) {
    if (target === null || target === undefined || String(target).trim() === '') {
      return { ok: false, path: null, source: 'none', reason: 'the operation names no path' }
    }
    const requested = String(target)
    const unscopedAllowed = unscoped === null ? unscopedFilesystem : unscoped === true
    const verified = verify()
    if (!verified.ok && !unscopedAllowed) {
      return {
        ok: false,
        path: null,
        source: 'unverified',
        reason: `no filesystem path can be resolved without a verified workspace: ${verified.reason || 'no workspace is configured'}`
      }
    }
    const resolved = requested && path.isAbsolute(requested)
      ? path.resolve(requested)
      : (verified.ok ? path.resolve(verified.cwd, requested) : null)
    if (resolved === null) {
      return { ok: false, path: null, source: 'unverified', reason: `a relative path cannot be resolved without a verified workspace: ${requested}` }
    }
    if (verified.ok && !isInside(resolved, verified.cwd) && !allowOutside && !unscopedAllowed) {
      drift({ step, requested: resolved, root: verified.cwd, kind: 'path_outside_workspace' })
      return { ok: false, path: null, source: 'explicit', reason: `the path is outside the workspace: ${resolved}` }
    }
    if (absolute && !path.isAbsolute(resolved)) return { ok: false, path: null, source: 'unverified', reason: `the path could not be resolved: ${target}` }
    return { ok: true, path: resolved, source: verified.ok ? (isInside(resolved, verified.cwd) ? 'workspace' : 'explicit-outside') : 'unscoped', reason: null }
  }

  /**
   * The typed failure for a workspace that cannot be used.
   *
   * `WORKSPACE_UNAVAILABLE` is a *block*: there is no safe directory to work in,
   * so no correct action exists.
   */
  function unavailableError(verdict, details = {}) {
    return new ComputerUseError(
      CODES.WORKSPACE_UNAVAILABLE,
      verdict && verdict.reason ? verdict.reason : 'no verified workspace is available',
      { workspace: root, ...details }
    )
  }

  /** The typed failure for a path that drifted out of the workspace. */
  function mismatchError(verdict, details = {}) {
    return new ComputerUseError(
      CODES.WORKSPACE_MISMATCH,
      verdict && verdict.reason ? verdict.reason : 'the operation would land outside the workspace',
      { workspace: root, ...details }
    )
  }

  function drift(entry) {
    drifts.push({ at: now(), ...entry })
    if (drifts.length > 50) drifts.splice(0, drifts.length - 50)
  }

  /**
   * The health-facing view. `ok:false` is what turns the runtime's health into
   * `blocked` rather than `degraded`.
   */
  function status() {
    const verified = verify()
    return {
      ok: verified.ok,
      cwd: verified.cwd,
      reason: verified.reason,
      verifiedAt: lastVerifiedAt,
      unscoped: unscopedFilesystem,
      drifts: drifts.slice(-5)
    }
  }

  return {
    root,
    allowOutside,
    unscopedFilesystem,
    verify,
    isInside,
    resolveCwd,
    resolvePath,
    unavailableError,
    mismatchError,
    status,
    drifts() {
      return drifts.slice()
    }
  }
}

/**
 * The run-level gate a shell or filesystem action passes before anything moves.
 *
 * This is *policy*, not mechanism, which is why it lives beside the boundary it
 * enforces rather than in the executor: an action whose command cannot be bounded,
 * or whose cwd/path cannot be placed in a verified workspace, is refused here —
 * before a controller is asked to do anything — and the *kind* of refusal is
 * distinguished:
 *
 *   WORKSPACE_MISMATCH      the caller named a directory or path outside the
 *                           boundary (a decision somebody made)
 *   WORKSPACE_UNAVAILABLE   there is no verified workspace to work in at all
 *
 * A shell action is always normalized into its bounded command contract here,
 * whether or not a workspace exists: an unbounded command must never reach a
 * controller just because no workspace was declared.
 *
 * @param {object} input
 * @param {object} input.action the normalized action
 * @param {object|null} input.guard the workspace guard, when the runtime has one
 * @param {number} [input.step] the step number, for the record
 * @param {Function} [input.boundCommand] `(params, context) => {ok, contract, issues}`
 * @param {Function} [input.invalidCommandError] `(issues) => Error`
 * @returns {{blocked:boolean, error?:Error, contract?:object}}
 */
function planWorkspaceGate(input = {}) {
  const action = input.action || {}
  const guard = input.guard || null
  const params = action.params || {}
  const step = input.step === undefined ? null : input.step

  if (action.capability === 'shell') {
    if (typeof input.boundCommand !== 'function') {
      return { blocked: false, contract: null }
    }
    const inherited = guard ? guard.verify() : { ok: false, cwd: null }
    const normalized = input.boundCommand(params, {
      cwd: params.cwd || (inherited.ok ? inherited.cwd : null)
    })
    if (!normalized.ok) {
      const makeError = typeof input.invalidCommandError === 'function' ? input.invalidCommandError : null
      return { blocked: true, error: makeError ? makeError(normalized.issues) : null, contract: null }
    }
    if (!guard) return { blocked: false, contract: normalized.contract }
    const verdict = guard.resolveCwd({ cwd: normalized.contract.cwd || params.cwd, step })
    if (verdict.ok) return { blocked: false, contract: normalized.contract }
    return { blocked: true, error: refusalError(guard, verdict, { action: action.type, step }), contract: normalized.contract }
  }

  if (action.capability !== 'filesystem') return { blocked: false, contract: null }
  if (!guard) return { blocked: false, contract: null }
  const verdict = guard.resolvePath(params.path, { step })
  if (verdict.ok) return { blocked: false, contract: null }
  return { blocked: true, error: refusalError(guard, verdict, { action: action.type, step }), contract: null }
}

/**
 * The typed failure for a refused boundary check.
 *
 * "The caller named something outside the boundary" is a different failure from
 * "there is no workspace to work in": the first is a mismatch somebody can fix,
 * the second is a block.
 */
function refusalError(guard, verdict, details = {}) {
  return verdict && verdict.source === 'explicit'
    ? guard.mismatchError(verdict, details)
    : guard.unavailableError(verdict, details)
}

module.exports = { createWorkspaceGuard, planWorkspaceGate, refusalError }
