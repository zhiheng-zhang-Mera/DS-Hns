'use strict'

/**
 * Computer Use Runtime: file controller.
 *
 * Filesystem work is structured: it has a path, an operation and a checkable
 * outcome, so it needs no pixels and no GUI — the cheapest
 * channel that can carry the task. This controller also *watches* files, which
 * is how a "did the save actually happen?" question is answered with an event
 * instead of a polled sleep.
 *
 * The workspace boundary is enforced, not advised: a contract that names a
 * workspace confines writes to it, and a delete outside it is refused.
 */

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')

const { ACTION_TYPES } = require('../constants.cjs')
const { CODES, ComputerUseError } = require('../errors.cjs')

function createFileController(options = {}) {
  const clock = options.clock || { now: () => Date.now() }
  /**
   * The workspace boundary comes in one of two shapes:
   *
   *  - the runtime's shared guard (`{ resolvePath, verify, ... }`), which is the
   *    production path: the *same* verdict the shell controller and the health
   *    snapshot use;
   *  - a bare workspace path, for a standalone controller in a test or a probe.
   *
   * A controller given neither confines nothing — and says so in `probe()` — so a
   * caller can never mistake "unconfined" for "confined".
   */
  const guard = options.workspace && typeof options.workspace.resolvePath === 'function' ? options.workspace : null
  const workspace = guard ? guard.root : (options.workspace ? path.resolve(String(options.workspace)) : null)
  const allowOutsideWorkspace = Boolean(options.allowOutsideWorkspace)
  const watchers = new Map()
  const events = []
  let lastResult = null

  function probe() {
    return { available: true, reason: null, detail: { backend: 'node:fs', workspace, allowOutsideWorkspace, confined: Boolean(guard || workspace) } }
  }

  function supports(actionType) {
    return String(actionType).startsWith('FILE_')
  }

  /**
   * Resolve one path for one operation.
   *
   * With the shared guard this is the guard's own verdict: fail-closed when the
   * workspace cannot be verified, a drift report when the path leaves it. Without
   * a guard the controller falls back to its own boundary check, and an absolute
   * path with *no* workspace at all is allowed only because the caller explicitly
   * asked for an unconfined controller (`allowOutsideWorkspace`).
   */
  function resolvePath(inputPath, { step = null, unscoped = null } = {}) {
    if (!inputPath) throw new ComputerUseError(CODES.ACTION_INVALID, 'a file action needs a path')
    if (guard) {
      const verdict = guard.resolvePath(inputPath, { step, unscoped })
      if (!verdict.ok) {
        const unverified = verdict.source === 'unverified'
        const error = new ComputerUseError(
          unverified ? CODES.WORKSPACE_UNAVAILABLE : CODES.SAFETY_REFUSED,
          verdict.reason,
          { path: String(inputPath), workspace: workspace, source: verdict.source }
        )
        error.retryable = false
        throw error
      }
      return verdict.path
    }
    const resolved = path.resolve(String(inputPath))
    if (workspace && !allowOutsideWorkspace && !isInside(resolved, workspace)) {
      const error = new ComputerUseError(CODES.SAFETY_REFUSED, `path is outside the contract workspace: ${resolved}`, {
        path: resolved,
        workspace
      })
      error.retryable = false
      throw error
    }
    return resolved
  }

  function isInside(target, root) {
    const relative = path.relative(root, target)
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
  }

  async function perform(action, context = {}) {
    const params = action.params || {}
    const target = resolvePath(params.path)
    switch (action.type) {
      case ACTION_TYPES.FILE_READ: {
        const content = await fsp.readFile(target, params.encoding || 'utf8')
        return finish(action, { ok: true, path: target, content, value: content, changed: true, bytes: Buffer.byteLength(content) })
      }
      case ACTION_TYPES.FILE_WRITE: {
        const content = params.content !== undefined ? params.content : params.text
        if (params.overwrite === false) {
          const exists = await exists(target)
          if (exists) {
            const error = new ComputerUseError(CODES.SAFETY_REFUSED, `refusing to overwrite an existing file: ${target}`, { path: target })
            error.retryable = false
            throw error
          }
        }
        await fsp.mkdir(path.dirname(target), { recursive: true })
        await fsp.writeFile(target, String(content === undefined ? '' : content), params.encoding || 'utf8')
        return finish(action, { ok: true, path: target, changed: true, bytes: Buffer.byteLength(String(content === undefined ? '' : content)), mtimeMs: (await statOrNull(target))?.mtimeMs ?? null })
      }
      case ACTION_TYPES.FILE_COPY: {
        const destination = resolvePath(params.to || params.destination)
        await fsp.mkdir(path.dirname(destination), { recursive: true })
        await fsp.copyFile(target, destination)
        return finish(action, { ok: true, path: destination, source: target, changed: true })
      }
      case ACTION_TYPES.FILE_MOVE: {
        const destination = resolvePath(params.to || params.destination)
        await fsp.mkdir(path.dirname(destination), { recursive: true })
        await fsp.rename(target, destination)
        return finish(action, { ok: true, path: destination, source: target, changed: true })
      }
      case ACTION_TYPES.FILE_DELETE: {
        const recursive = params.recursive === true
        const stats = await statOrNull(target)
        if (!stats) return finish(action, { ok: true, path: target, changed: false, detail: 'already absent' })
        if (stats.isDirectory() && !recursive) {
          const error = new ComputerUseError(CODES.SAFETY_REFUSED, `refusing to delete a directory without recursive: true: ${target}`, { path: target })
          error.retryable = false
          throw error
        }
        // The workspace boundary above already refused anything outside the
        // contract's area; this is the second half of the same guard.
        if (isProtectedPath(target)) {
          const error = new ComputerUseError(CODES.SAFETY_REFUSED, `refusing to delete a protected system path: ${target}`, { path: target })
          error.retryable = false
          throw error
        }
        await fsp.rm(target, { recursive, force: true })
        return finish(action, { ok: true, path: target, changed: true })
      }
      case ACTION_TYPES.FILE_MKDIR: {
        await fsp.mkdir(target, { recursive: params.recursive !== false })
        return finish(action, { ok: true, path: target, changed: true })
      }
      case ACTION_TYPES.FILE_EXISTS: {
        const present = await exists(target)
        return finish(action, { ok: true, path: target, exists: present, changed: false, value: present })
      }
      default:
        throw new ComputerUseError(CODES.ACTION_UNSUPPORTED, `the file controller cannot run ${action.type}`)
    }
  }

  function finish(action, receipt) {
    const record = { ...receipt, actionType: action.type, at: clock.now() }
    lastResult = record
    events.push({ type: 'file_event', name: `${action.type}`, path: receipt.path, at: record.at })
    if (events.length > 500) events.splice(0, events.length - 500)
    return record
  }

  /** System events: "file created / file modified" as real watches. */
  function watch(target, onEvent) {
    const resolved = path.resolve(String(target))
    if (watchers.has(resolved)) return watchers.get(resolved)
    let watcher
    try {
      watcher = fs.watch(resolved, { persistent: false }, (eventType, filename) => {
        const payload = { type: 'file_event', name: eventType === 'rename' ? 'file_created_or_removed' : 'file_modified', path: resolved, file: filename ? String(filename) : null, at: clock.now() }
        events.push(payload)
        if (events.length > 500) events.splice(0, events.length - 500)
        if (typeof onEvent === 'function') onEvent(payload)
      })
      // A watch that errors is *released*, not merely forgotten: leaving a dead
      // watcher in the map would keep the handle (and the entry) alive for the
      // rest of a long run, and a later watch of the same path would be told the
      // dead one is still fine.
      watcher.on('error', () => {
        release(resolved)
      })
    } catch {
      return null
    }
    watchers.set(resolved, watcher)
    return watcher
  }

  /** Close and forget one watch. */
  function release(resolved) {
    const watcher = watchers.get(resolved)
    if (!watcher) return false
    watchers.delete(resolved)
    try {
      watcher.close()
    } catch {
      /* already closed */
    }
    return true
  }

  function unwatchAll() {
    for (const resolved of [...watchers.keys()]) release(resolved)
    watchers.clear()
  }

  /**
   * Facts for verification and success criteria. `fileModifiedSince` answers the
   * "did the save land?" question without a fixed sleep.
   */
  function facts() {
    return {
      fileExists: async (target) => exists(path.resolve(String(target))),
      fileContains: async (target, text) => {
        try {
          const content = await fsp.readFile(path.resolve(String(target)), 'utf8')
          return content.includes(String(text))
        } catch {
          return false
        }
      },
      fileModifiedSince: async (target, since) => {
        if (!target) return null
        const stats = await statOrNull(path.resolve(String(target)))
        if (!stats) return null
        const reference = Number.isFinite(Number(since)) ? Number(since) : null
        if (reference === null) return true
        return stats.mtimeMs >= reference
      },
      fileRead: async (target) => {
        try {
          return await fsp.readFile(path.resolve(String(target)), 'utf8')
        } catch {
          return null
        }
      },
      fileStats: async (target) => statOrNull(path.resolve(String(target))),
      events: () => events.slice(),
      lastResult: () => lastResult
    }
  }

  async function exists(target) {
    try {
      await fsp.access(target)
      return true
    } catch {
      return false
    }
  }

  async function statOrNull(target) {
    try {
      return await fsp.stat(target)
    } catch {
      return null
    }
  }

  return {
    id: 'file',
    capability: 'filesystem',
    probe,
    supports,
    perform,
    facts,
    watch,
    unwatchAll,
    /** Close and forget one watch; the handle count is observable for the audit. */
    unwatch: (target) => release(path.resolve(String(target))),
    /** How many watches this controller is currently holding. */
    watchCount: () => watchers.size
  }
}

function isProtectedPath(target) {
  const normalized = path.resolve(target).toLowerCase()
  const root = path.parse(normalized).root.toLowerCase()
  if (normalized === root) return true
  const protectedRoots = ['windows', 'program files', 'program files (x86)', 'programdata', 'users']
  const relative = normalized.slice(root.length)
  const first = relative.split(path.sep)[0]
  if (!first) return true
  if (protectedRoots.includes(first) && relative.split(path.sep).length <= 2) return true
  return false
}

module.exports = { createFileController, isProtectedPath }
