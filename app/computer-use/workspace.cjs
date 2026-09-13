'use strict'

/**
 * Computer Use Runtime: workspace continuity
 * (Update-Plan/24h.md Task 11, §13 of the plan).
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
   * so no correct action exists (24h.md Task 20).
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

module.exports = { createWorkspaceGuard }
