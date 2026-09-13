'use strict'

/**
 * Computer Use Runtime: filesystem mutation verification.
 *
 * Development work creates, edits, renames and deletes files. A command that exits
 * zero does not mean the file result is correct, so every high-value mutation has
 * to be checked against the filesystem itself:
 *
 *   write    the file exists, its mtime moved, and (when the content is known) it
 *            reads back as written
 *   rename   the source is gone and the destination is there
 *   copy     the destination is there with the source's size
 *   delete   the target is absent
 *   mkdir    the directory exists
 *
 * The same function is what makes recovery *resume-safe*: when a runtime
 * exception happens at a step boundary, the first thing the resumed run does is
 * re-observe the effect and ask "already complete, retry, or failed?" — instead of
 * blindly replaying a half-finished write.
 */

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')

const { ACTION_TYPES } = require('./constants.cjs')
const { CODES, ComputerUseError } = require('./errors.cjs')

/** The mutation operations that must be verified. */
const MUTATION_TYPES = Object.freeze([
  ACTION_TYPES.FILE_WRITE,
  ACTION_TYPES.FILE_COPY,
  ACTION_TYPES.FILE_MOVE,
  ACTION_TYPES.FILE_DELETE,
  ACTION_TYPES.FILE_MKDIR
])

/** The resume verdict for a step whose outcome is unknown. */
const RESUME_VERDICT = Object.freeze({
  ALREADY_COMPLETE: 'already_complete',
  RETRY: 'retry',
  FAILED: 'failed'
})

/**
 * @param {object} [options]
 * @param {Function} [options.now]
 * @param {number} [options.clockSkewMs] how far back an mtime may be and still count
 */
function createMutationVerifier(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const skew = Number.isFinite(options.clockSkewMs) ? Number(options.clockSkewMs) : 2000
  const checks = []

  function record(entry) {
    const noted = { at: now(), ...entry }
    checks.push(noted)
    if (checks.length > 200) checks.splice(0, checks.length - 200)
    return noted
  }

  /**
   * Verify one filesystem mutation against the disk.
   *
   * @param {object} input
   * @param {object} input.action the executed action
   * @param {object} [input.receipt] what the controller reported
   * @param {number} [input.beforeMtime] the destination's mtime before the action
   * @returns {Promise<object>} `{ verified, operation, evidence, reason }` — never throws
   */
  async function verify({ action, receipt = null, beforeMtime = null } = {}) {
    const type = action ? String(action.type) : ''
    const params = (action && action.params) || {}
    if (!MUTATION_TYPES.includes(type)) {
      return record({ operation: type || 'unknown', verified: false, skipped: true, reason: `${type || 'the action'} is not a filesystem mutation` })
    }

    try {
      switch (type) {
        case ACTION_TYPES.FILE_WRITE:
          return record(await verifyWrite(params, receipt, beforeMtime))
        case ACTION_TYPES.FILE_COPY:
          return record(await verifyCopy(params, receipt))
        case ACTION_TYPES.FILE_MOVE:
          return record(await verifyMove(params, receipt))
        case ACTION_TYPES.FILE_DELETE:
          return record(await verifyDelete(params))
        case ACTION_TYPES.FILE_MKDIR:
          return record(await verifyMkdir(params))
        default:
          return record({ operation: type, verified: false, reason: `no verifier exists for ${type}` })
      }
    } catch (error) {
      return record({
        operation: type,
        verified: false,
        reason: `the mutation could not be verified: ${error && error.message ? error.message : error}`
      })
    }
  }

  async function verifyWrite(params, receipt, beforeMtime) {
    const target = resolve(params.path)
    const stats = await statOrNull(target)
    const evidence = []
    if (!stats) {
      return { operation: 'write', verified: false, path: target, evidence, reason: `the file was not created: ${target}` }
    }
    evidence.push({ kind: 'exists', ok: true, detail: target })
    if (!stats.isFile()) {
      return { operation: 'write', verified: false, path: target, evidence, reason: `${target} is not a regular file` }
    }
    const expected = params.content !== undefined ? String(params.content) : (params.text !== undefined ? String(params.text) : null)
    if (expected !== null) {
      const actual = await readOrNull(target, params.encoding || 'utf8')
      if (actual === null) {
        return { operation: 'write', verified: false, path: target, evidence, reason: `the written file could not be read back: ${target}` }
      }
      const matches = actual === expected
      evidence.push({ kind: 'content', ok: matches, detail: matches ? `${actual.length} chars match` : `read back ${actual.length} chars, expected ${expected.length}` })
      if (!matches) return { operation: 'write', verified: false, path: target, evidence, reason: 'the file content does not match what was written' }
    }
    if (beforeMtime !== null && beforeMtime !== undefined) {
      const moved = stats.mtimeMs >= Number(beforeMtime) - skew
      evidence.push({ kind: 'mtime', ok: moved, detail: `${beforeMtime} -> ${stats.mtimeMs}` })
      if (!moved) return { operation: 'write', verified: false, path: target, evidence, reason: 'the file mtime did not move, so the write may not have landed' }
    }
    if (receipt && Number.isFinite(receipt.bytes)) {
      const sizeMatches = stats.size === Number(receipt.bytes)
      evidence.push({ kind: 'size', ok: sizeMatches, detail: `${stats.size} bytes on disk, ${receipt.bytes} reported` })
      if (!sizeMatches) return { operation: 'write', verified: false, path: target, evidence, reason: 'the file size on disk differs from what the write reported' }
    }
    return { operation: 'write', verified: true, path: target, evidence, reason: 'the file exists with the expected content' }
  }

  async function verifyCopy(params, receipt) {
    const source = resolve(params.path)
    const destination = resolve(params.to || params.destination)
    const evidence = []
    const sourceStats = await statOrNull(source)
    const destinationStats = await statOrNull(destination)
    if (!destinationStats) {
      return { operation: 'copy', verified: false, path: destination, evidence, reason: `the destination was not created: ${destination}` }
    }
    evidence.push({ kind: 'exists', ok: true, detail: destination })
    if (sourceStats && destinationStats.size !== sourceStats.size) {
      evidence.push({ kind: 'size', ok: false, detail: `${destinationStats.size} != ${sourceStats.size}` })
      return { operation: 'copy', verified: false, path: destination, evidence, reason: 'the copy has a different size than its source' }
    }
    if (sourceStats) evidence.push({ kind: 'size', ok: true, detail: `${destinationStats.size} bytes` })
    if (receipt && receipt.path && resolve(receipt.path) !== destination) {
      evidence.push({ kind: 'path', ok: false, detail: `the controller reported ${receipt.path}` })
      return { operation: 'copy', verified: false, path: destination, evidence, reason: 'the controller copied to a different path than requested' }
    }
    return { operation: 'copy', verified: true, path: destination, evidence, reason: 'the destination exists with the source size' }
  }

  async function verifyMove(params, receipt) {
    const source = resolve(params.path)
    const destination = resolve(params.to || params.destination)
    const evidence = []
    const sourceStats = await statOrNull(source)
    const destinationStats = await statOrNull(destination)
    const sourceGone = !sourceStats
    const destinationThere = Boolean(destinationStats)
    evidence.push({ kind: 'source', ok: sourceGone, detail: sourceGone ? `${source} is gone` : `${source} is still present` })
    evidence.push({ kind: 'destination', ok: destinationThere, detail: destinationThere ? `${destination} exists` : `${destination} is missing` })
    if (!sourceGone || !destinationThere) {
      return {
        operation: 'move',
        verified: false,
        path: destination,
        evidence,
        reason: `a move requires the source to be gone and the destination to exist (source ${sourceGone ? 'gone' : 'present'}, destination ${destinationThere ? 'present' : 'missing'})`
      }
    }
    if (receipt && receipt.path && resolve(receipt.path) !== destination) {
      evidence.push({ kind: 'path', ok: false, detail: `the controller reported ${receipt.path}` })
      return { operation: 'move', verified: false, path: destination, evidence, reason: 'the controller moved to a different path than requested' }
    }
    return { operation: 'move', verified: true, path: destination, evidence, reason: 'the source is gone and the destination exists' }
  }

  async function verifyDelete(params) {
    const target = resolve(params.path)
    const stats = await statOrNull(target)
    const evidence = [{ kind: 'absent', ok: !stats, detail: stats ? `${target} still exists` : `${target} is gone` }]
    if (stats) return { operation: 'delete', verified: false, path: target, evidence, reason: `the target still exists: ${target}` }
    return { operation: 'delete', verified: true, path: target, evidence, reason: 'the target is absent' }
  }

  async function verifyMkdir(params) {
    const target = resolve(params.path)
    const stats = await statOrNull(target)
    const evidence = [{ kind: 'exists', ok: Boolean(stats && stats.isDirectory()), detail: stats ? target : `${target} is missing` }]
    if (!stats || !stats.isDirectory()) return { operation: 'mkdir', verified: false, path: target, evidence, reason: `the directory was not created: ${target}` }
    return { operation: 'mkdir', verified: true, path: target, evidence, reason: 'the directory exists' }
  }

  /**
   * Resume-safe step boundary.
   *
   * Given a mutation step whose outcome was never recorded — the runtime crashed,
   * the controller died mid-write — re-observe the effect and decide. Blindly
   * replaying a write is how a half-written file becomes a corrupted one.
   *
   * @returns {Promise<{verdict:string, verified:boolean, reason:string, evidence:object[]}>}
   */
  async function resume({ action, receipt = null, beforeMtime = null } = {}) {
    const type = action ? String(action.type) : ''
    if (!MUTATION_TYPES.includes(type)) {
      // Nothing to re-observe for a non-mutation: the honest answer is "retry",
      // because no partial effect can be left behind by a click or a keystroke.
      return { verdict: RESUME_VERDICT.RETRY, verified: false, reason: `${type || 'the action'} leaves no partial filesystem effect`, evidence: [] }
    }
    const observed = await verify({ action, receipt, beforeMtime })
    if (observed.verified) {
      return { verdict: RESUME_VERDICT.ALREADY_COMPLETE, verified: true, reason: `the effect is already on disk: ${observed.reason}`, evidence: observed.evidence }
    }
    // A write whose destination exists but does not match cannot be "retried"
    // safely without knowing what is there: report it as failed-with-evidence.
    if (type === ACTION_TYPES.FILE_DELETE || type === ACTION_TYPES.FILE_MOVE) {
      const target = resolve((action.params || {}).path)
      const stats = await statOrNull(target)
      if (stats) {
        return { verdict: RESUME_VERDICT.RETRY, verified: false, reason: `${observed.reason}; the target is still there, so the operation can be retried`, evidence: observed.evidence }
      }
    }
    return { verdict: RESUME_VERDICT.RETRY, verified: false, reason: observed.reason, evidence: observed.evidence }
  }

  /** The typed failure a mutation that cannot be confirmed produces. */
  function unverifiedError(observed) {
    return new ComputerUseError(
      CODES.MUTATION_UNVERIFIED,
      observed && observed.reason ? observed.reason : 'the filesystem mutation could not be verified',
      { operation: observed ? observed.operation : null, path: observed ? observed.path : null, evidence: observed ? observed.evidence : [] }
    )
  }

  function resolve(target) {
    return target === undefined || target === null ? '' : path.resolve(String(target))
  }

  async function statOrNull(target) {
    if (!target) return null
    try {
      return await fsp.stat(target)
    } catch {
      return null
    }
  }

  async function readOrNull(target, encoding) {
    try {
      return await fsp.readFile(target, encoding || 'utf8')
    } catch {
      return null
    }
  }

  /** The pre-action mtime the write verifier compares against. */
  function mtime(target) {
    const resolved = resolve(target)
    if (!resolved) return null
    try {
      return fs.statSync(resolved).mtimeMs
    } catch {
      return null
    }
  }

  return {
    MUTATION_TYPES,
    RESUME_VERDICT,
    verify,
    resume,
    mtime,
    unverifiedError,
    checks() {
      return checks.slice()
    }
  }
}

module.exports = { createMutationVerifier, MUTATION_TYPES, RESUME_VERDICT }
