'use strict'

/**
 * Engineering Runtime: mutations and their ownership.
 *
 * Every change the runtime makes to a repository is a *mutation*: a bounded set of
 * file writes with a reason, a before-hash and an after-hash. Two things depend on
 * this being recorded rather than remembered.
 *
 *  * **Ownership.** The episode snapshot records what was already dirty before it
 *    started. A mutation may only touch files that were clean, or files the
 *    episode itself has already changed — never a file the user had modified. That
 *    is how "do not overwrite the user's work" becomes an enforced rule instead of
 *    a good intention.
 *  * **Resume.** A mutation whose verification never happened is re-checked against
 *    the file on disk, not replayed. `pending()` exists for exactly that: after a
 *    crash, the runtime asks "is this already true?" before it writes anything.
 *
 * A mutation is verified by re-reading the file and comparing content, never by
 * trusting that `writeFile` returned.
 */

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

/** The kinds of change a mutation may make. */
const MUTATION_KINDS = Object.freeze({
  WRITE: 'write',
  CREATE: 'create',
  DELETE: 'delete',
  MOVE: 'move',
  MKDIR: 'mkdir'
})

/** How a mutation ended. */
const MUTATION_RESULTS = Object.freeze({
  PENDING: 'pending',
  APPLIED: 'applied',
  FAILED: 'failed',
  REFUSED: 'refused',
  ALREADY_COMPLETE: 'already_complete'
})

function hashContent(value) {
  if (value === null || value === undefined) return null
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16)
}

/** Hash a file's bytes, or null when it is absent. */
function hashFile(file) {
  try {
    return hashContent(fs.readFileSync(file))
  } catch {
    return null
  }
}

/**
 * @param {object} [options]
 * @param {Function} [options.now]
 * @param {string[]} [options.protectedFiles] files the episode must never touch
 * @param {number} [options.ringSize]
 */
function createMutationLog(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const ringSize = Number.isInteger(options.ringSize) && options.ringSize > 0 ? options.ringSize : 500
  /**
   * Files that were already dirty when the episode started, or that the caller
   * declared off limits. The set is the *only* thing standing between a repair
   * loop and somebody's uncommitted work.
   */
  const protectedFiles = new Set((options.protectedFiles || []).map((file) => path.resolve(String(file))))
  /** Files this episode has already mutated: it may change its own work again. */
  const owned = new Set()
  const mutations = []
  let sequence = 0
  const onChange = typeof options.onChange === 'function' ? options.onChange : null

  function record(entry) {
    const existing = mutations.findIndex((candidate) => candidate.id === entry.id)
    if (existing < 0) mutations.push(entry)
    else mutations[existing] = entry
    if (mutations.length > ringSize) mutations.splice(0, mutations.length - ringSize)
    return entry
  }

  function notifyChange(entry, phase) {
    if (!onChange) return { ok: true }
    try {
      const result = onChange(JSON.parse(JSON.stringify(entry)), phase)
      return result && result.ok === false
        ? { ok: false, reason: String(result.reason || 'the mutation journal did not persist') }
        : { ok: true }
    } catch (error) {
      return { ok: false, reason: String(error && error.message ? error.message : error) }
    }
  }

  /** Is this path inside the repository the episode was given? */
  function insideRoot(target, root) {
    if (!root) return true
    const relative = path.relative(root, target)
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
  }

  /**
   * May the episode write to this path?
   *
   * @returns {{ok:boolean, reason:string|null, owned:boolean, preExisting:boolean}}
   */
  function mayWrite(target, root = null) {
    const resolved = path.resolve(String(target))
    if (root && !insideRoot(resolved, path.resolve(root))) {
      return { ok: false, reason: `the path is outside the episode workspace: ${resolved}`, owned: false, preExisting: false }
    }
    if (protectedFiles.has(resolved) && !owned.has(resolved)) {
      return { ok: false, reason: `the file had uncommitted changes before the episode started: ${resolved}`, owned: false, preExisting: true }
    }
    return { ok: true, reason: null, owned: owned.has(resolved), preExisting: false }
  }

  /**
   * Apply one mutation.
   *
   * The write is followed by a re-read: `writeFile` returning successfully is not
   * evidence that the file now holds what was intended, and this module exists to
   * stop the runtime from acting on that assumption.
   *
   * @param {object} input
   * @param {string} input.kind one of MUTATION_KINDS
   * @param {string} input.path the target path
   * @param {string} [input.content] the intended content, for write/create
   * @param {string} [input.to] the destination, for move
   * @param {string} input.reason why the runtime is making this change
   * @param {string} [input.root] the episode workspace
   * @param {string} [input.step] the plan step this belongs to
   * @param {boolean} [input.dryRun] plan the mutation without applying it
   */
  function apply(input = {}) {
    const kind = String(input.kind || MUTATION_KINDS.WRITE)
    const target = path.resolve(String(input.path || ''))
    const root = input.root || null
    const startedAt = now()
    const before = hashFile(target)
    const entry = {
      id: `m${++sequence}`,
      at: startedAt,
      kind,
      path: target,
      relative: root ? path.relative(path.resolve(root), target) : target,
      to: input.to ? path.resolve(String(input.to)) : null,
      reason: String(input.reason || ''),
      step: input.step === undefined ? null : input.step,
      before,
      after: null,
      result: MUTATION_RESULTS.PENDING,
      verification: null,
      dryRun: input.dryRun === true
    }

    const encoding = input.encoding || 'utf8'
    entry.encoding = encoding
    switch (kind) {
      case MUTATION_KINDS.WRITE:
      case MUTATION_KINDS.CREATE: {
        const content = input.content === undefined || input.content === null ? '' : String(input.content)
        const bytes = Buffer.from(content, encoding)
        entry.intended = { bytes: bytes.length, hash: hashContent(bytes) }
        break
      }
      case MUTATION_KINDS.DELETE:
        entry.intended = { absent: true }
        break
      case MUTATION_KINDS.MKDIR:
        entry.intended = { directory: true }
        break
      case MUTATION_KINDS.MOVE:
        entry.intended = input.to ? { movedTo: path.resolve(String(input.to)) } : null
        break
      default:
        entry.intended = null
    }

    if (!target) {
      entry.result = MUTATION_RESULTS.FAILED
      entry.verification = { ok: false, reason: 'the mutation names no path' }
      return record(entry)
    }
    const permission = mayWrite(target, root)
    if (!permission.ok) {
      entry.result = MUTATION_RESULTS.REFUSED
      entry.verification = { ok: false, reason: permission.reason, preExisting: permission.preExisting }
      return record(entry)
    }
    if (entry.dryRun) return record(entry)

    // Persist the intended postcondition before touching disk. If the process is
    // killed during the operation, a new runtime can compare this hash/path intent
    // with the world and reconcile it instead of blindly repeating the write.
    record(entry)
    const journaled = notifyChange(entry, 'before')
    if (!journaled.ok) {
      entry.result = MUTATION_RESULTS.FAILED
      entry.verification = { ok: false, reason: `the mutation was not applied because its intent could not be checkpointed: ${journaled.reason}` }
      return record(entry)
    }

    try {
      switch (kind) {
        case MUTATION_KINDS.WRITE:
        case MUTATION_KINDS.CREATE: {
          const content = input.content === undefined || input.content === null ? '' : String(input.content)
          fs.mkdirSync(path.dirname(target), { recursive: true })
          fs.writeFileSync(target, content, encoding)
          break
        }
        case MUTATION_KINDS.DELETE: {
          fs.rmSync(target, { recursive: input.recursive === true, force: true })
          break
        }
        case MUTATION_KINDS.MKDIR: {
          fs.mkdirSync(target, { recursive: true })
          break
        }
        case MUTATION_KINDS.MOVE: {
          const destination = entry.to
          if (!destination) throw new Error('a move needs a destination')
          const destinationPermission = mayWrite(destination, root)
          if (!destinationPermission.ok) {
            entry.result = MUTATION_RESULTS.REFUSED
            entry.verification = { ok: false, reason: destinationPermission.reason }
            return record(entry)
          }
          fs.mkdirSync(path.dirname(destination), { recursive: true })
          fs.renameSync(target, destination)
          break
        }
        default:
          throw new Error(`unknown mutation kind: ${kind}`)
      }
    } catch (error) {
      entry.result = MUTATION_RESULTS.FAILED
      entry.verification = { ok: false, reason: String(error && error.message ? error.message : error) }
      return record(entry)
    }

    // Re-read: the file has to hold what was intended, or the mutation did not
    // happen in any sense the runtime is willing to act on.
    const verification = verify(entry)
    entry.verification = verification
    entry.after = kind === MUTATION_KINDS.MOVE ? hashFile(entry.to) : hashFile(target)
    if (verification.ok) {
      entry.result = MUTATION_RESULTS.APPLIED
      owned.add(target)
      if (entry.to) owned.add(entry.to)
    } else if (verification.alreadyComplete) {
      entry.result = MUTATION_RESULTS.ALREADY_COMPLETE
      owned.add(target)
    } else {
      entry.result = MUTATION_RESULTS.FAILED
    }
    entry.durationMs = now() - startedAt
    record(entry)
    const settled = notifyChange(entry, 'after')
    if (!settled.ok) entry.journalWarning = settled.reason
    return entry
  }

  /**
   * Check one applied (or interrupted) mutation against the disk.
   *
   * This is also the resume primitive: after a crash, the runtime calls this on
   * the pending mutation and only writes again when the answer is "not there yet".
   */
  function verify(entry) {
    if (!entry) return { ok: false, reason: 'no mutation to verify' }
    try {
      switch (entry.kind) {
        case MUTATION_KINDS.WRITE:
        case MUTATION_KINDS.CREATE: {
          if (!fs.existsSync(entry.path)) return { ok: false, reason: `the file was not created: ${entry.path}` }
          const actual = fs.readFileSync(entry.path, entry.encoding || 'utf8')
          const actualHash = hashContent(Buffer.from(actual, entry.encoding || 'utf8'))
          if (entry.intended && entry.intended.hash && actualHash !== entry.intended.hash) {
            return {
              ok: false,
              reason: 'the file does not hold the intended content',
              expected: entry.intended.hash,
              actual: actualHash
            }
          }
          return { ok: true, reason: 'the file holds the intended content', hash: actualHash }
        }
        case MUTATION_KINDS.DELETE: {
          if (fs.existsSync(entry.path)) return { ok: false, reason: `the path still exists: ${entry.path}` }
          return { ok: true, reason: 'the path is gone' }
        }
        case MUTATION_KINDS.MKDIR: {
          if (!fs.existsSync(entry.path) || !fs.statSync(entry.path).isDirectory()) {
            return { ok: false, reason: `the directory was not created: ${entry.path}` }
          }
          return { ok: true, reason: 'the directory exists' }
        }
        case MUTATION_KINDS.MOVE: {
          const sourceThere = fs.existsSync(entry.path)
          const destinationThere = Boolean(entry.to) && fs.existsSync(entry.to)
          if (destinationThere && !sourceThere) return { ok: true, reason: 'the source is gone and the destination exists' }
          if (destinationThere && sourceThere) return { ok: false, reason: 'the destination exists but the source is still there' }
          return { ok: false, reason: 'the destination was not created' }
        }
        default:
          return { ok: false, reason: `unknown mutation kind: ${entry.kind}` }
      }
    } catch (error) {
      return { ok: false, reason: String(error && error.message ? error.message : error) }
    }
  }

  /**
   * Re-check an interrupted mutation.
   *
   * @returns {{verdict:string, verified:boolean, reason:string}}
   */
  function resume(entry) {
    if (!entry) return { verdict: 'retry', verified: false, reason: 'no mutation to resume' }
    const tracked = mutations.find((candidate) => candidate.id === entry.id) || entry
    const observed = verify(entry)
    if (observed.ok) {
      tracked.result = MUTATION_RESULTS.ALREADY_COMPLETE
      tracked.verification = observed
      tracked.after = tracked.kind === MUTATION_KINDS.MOVE ? hashFile(tracked.to) : hashFile(tracked.path)
      owned.add(path.resolve(tracked.path))
      if (tracked.to) owned.add(path.resolve(tracked.to))
      record(tracked)
      const journaled = notifyChange(tracked, 'after')
      if (!journaled.ok) tracked.journalWarning = journaled.reason
      return { verdict: MUTATION_RESULTS.ALREADY_COMPLETE, verified: true, reason: `the effect is already on disk: ${observed.reason}`, observed }
    }
    if (entry.kind === MUTATION_KINDS.WRITE || entry.kind === MUTATION_KINDS.CREATE) {
      // A file that exists with *different* content is not "not done" — writing
      // over it blindly is how a crash turns into a lost edit.
      if (fs.existsSync(entry.path) && entry.before !== null && hashFile(entry.path) !== entry.before) {
        return { verdict: 'failed', verified: false, reason: 'the file changed since the mutation was planned and does not match either version', observed }
      }
    }
    return { verdict: 'retry', verified: false, reason: observed.reason, observed }
  }

  /** The mutations this episode made, unchanged, in order. */
  function all() {
    return mutations.slice()
  }

  /** Only the ones that landed. */
  function applied() {
    return mutations.filter((entry) => entry.result === MUTATION_RESULTS.APPLIED)
  }

  /** Mutations whose result was never settled: the resume candidates. */
  function pending() {
    return mutations.filter((entry) => entry.result === MUTATION_RESULTS.PENDING)
  }

  /** Restore a checkpointed mutation journal without applying any operation. */
  function restore(entries) {
    if (!Array.isArray(entries)) return { ok: false, code: 'MUTATION_JOURNAL_INVALID', reason: 'saved mutations must be an array' }
    const restored = []
    const seen = new Set()
    const validKinds = new Set(Object.values(MUTATION_KINDS))
    const validResults = new Set(Object.values(MUTATION_RESULTS))
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
        typeof entry.id !== 'string' || !/^m[1-9]\d*$/.test(entry.id) || seen.has(entry.id) ||
        !validKinds.has(entry.kind) || typeof entry.path !== 'string' || !path.isAbsolute(entry.path) ||
        !validResults.has(entry.result)) {
        return { ok: false, code: 'MUTATION_JOURNAL_INVALID', reason: 'a saved mutation entry is malformed or duplicated' }
      }
      seen.add(entry.id)
      restored.push(JSON.parse(JSON.stringify(entry)))
    }
    for (const entry of restored) {
      record(entry)
      sequence = Math.max(sequence, Number(entry.id.slice(1)))
      if (entry.result === MUTATION_RESULTS.APPLIED || entry.result === MUTATION_RESULTS.ALREADY_COMPLETE) {
        owned.add(path.resolve(entry.path))
        if (entry.to) owned.add(path.resolve(entry.to))
      }
    }
    return { ok: true, restored: restored.length }
  }

  /** Files the episode changed, relative to the workspace when one is known. */
  function changedFiles(root = null) {
    const files = new Set()
    for (const entry of mutations) {
      if (entry.result !== MUTATION_RESULTS.APPLIED && entry.result !== MUTATION_RESULTS.ALREADY_COMPLETE) continue
      // Repository-relative paths are reported with forward slashes whatever the
      // platform: a manifest of changed files is compared, diffed and reported,
      // and a Windows-only separator would make two identical episodes look
      // different.
      files.add(relativePath(root, entry.path))
      if (entry.to) files.add(relativePath(root, entry.to))
    }
    return [...files].sort()
  }

  /** A repository-relative path with platform-independent separators. */
  function relativePath(root, target) {
    const relative = root ? path.relative(path.resolve(root), target) : target
    return String(relative).split(path.sep).join('/')
  }

  return {
    MUTATION_KINDS,
    MUTATION_RESULTS,
    protectedFiles,
    /** Declare one more file off limits (the episode's baseline additions). */
    protect(target) {
      protectedFiles.add(path.resolve(String(target)))
      return protectedFiles.size
    },
    mayWrite,
    apply,
    verify,
    resume,
    restore,
    all,
    applied,
    pending,
    changedFiles,
    get count() {
      return mutations.length
    },
    get ownedFiles() {
      return [...owned].sort()
    },
    /** A bounded summary for the episode report. */
    summary(root = null) {
      return {
        mutations: mutations.length,
        applied: applied().length,
        refused: mutations.filter((entry) => entry.result === MUTATION_RESULTS.REFUSED).length,
        failed: mutations.filter((entry) => entry.result === MUTATION_RESULTS.FAILED).length,
        pending: pending().length,
        filesChanged: changedFiles(root)
      }
    }
  }
}

module.exports = { createMutationLog, MUTATION_KINDS, MUTATION_RESULTS, hashContent, hashFile }
