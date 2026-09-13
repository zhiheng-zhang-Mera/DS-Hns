'use strict'

/**
 * Engineering Runtime: workspace locking.
 *
 * An episode mutates a repository. Two episodes in the same workspace are two
 * writers over the same files, and the second one's plan is written against a tree
 * the first one is still changing — so the plan says exactly one active writer, and
 * this is how that is enforced rather than hoped for.
 *
 * The lock is a file, because the thing that must be excluded is another *process*:
 * a shell instance restarted after a crash must be able to find the previous
 * episode's lock, and an in-memory flag cannot do that. Three properties make it
 * safe to rely on:
 *
 *  1. **It identifies its owner.** The lock names the episode, the pid and when it
 *     was taken, so a stale lock can be reasoned about instead of merely found.
 *  2. **Staleness is explicit, never assumed.** A lock whose owning process is
 *     gone is *reported* as stale; reclaiming it is a decision the caller makes
 *     (`stealStale`), and the default refuses rather than taking it.
 *  3. **Release is verified.** Releasing checks that the lock is still the one this
 *     holder took, so a stolen lock is never deleted by the process that lost it.
 *
 * Nothing here learns anything: a lock is created for one episode and removed with
 * it.
 */

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const LOCK_VERSION = 1
/** How long a lock may sit untouched before it is *offered* as stale. */
const DEFAULT_STALE_AFTER_MS = 30 * 60_000

/** Why a lock was refused. */
const LOCK_REASONS = Object.freeze({
  HELD: 'held',
  STALE: 'stale',
  UNAVAILABLE: 'unavailable',
  LOST: 'lost'
})

function lockFileFor(root, options = {}) {
  const dir = options.dir || path.join(root, 'runtime', 'engineering')
  return path.join(dir, 'workspace.lock')
}

/**
 * @param {object} input
 * @param {string} input.root the verified workspace
 * @param {string} [input.dir] where the lock lives (default `<root>/runtime/engineering`)
 * @param {Function} [input.now]
 * @param {number} [input.staleAfterMs]
 * @param {boolean} [input.disabled] a caller that knows it is the only writer
 */
function createWorkspaceLock(input = {}) {
  const root = path.resolve(String(input.root || ''))
  const file = lockFileFor(root, input)
  const now = typeof input.now === 'function' ? input.now : () => Date.now()
  const staleAfterMs = Number.isFinite(input.staleAfterMs) ? Number(input.staleAfterMs) : DEFAULT_STALE_AFTER_MS
  const disabled = input.disabled === true
  const token = crypto.randomBytes(8).toString('hex')
  let held = false

  function read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      return parsed && typeof parsed === 'object' ? parsed : null
    } catch {
      return null
    }
  }

  /** Is the process that took this lock still alive? */
  function ownerAlive(lock) {
    if (!lock || !Number.isInteger(lock.pid)) return false
    if (lock.pid === process.pid) return true
    try {
      process.kill(lock.pid, 0)
      return true
    } catch (error) {
      // EPERM means the process exists but is not ours; ESRCH means it is gone.
      return Boolean(error && error.code === 'EPERM')
    }
  }

  /**
   * Inspect the lock without taking it.
   *
   * @returns {{locked:boolean, lock:object|null, stale:boolean, reason:string|null}}
   */
  function inspect() {
    if (disabled) return { locked: false, lock: null, stale: false, reason: null }
    const lock = read()
    if (!lock) return { locked: false, lock: null, stale: false, reason: null }
    const alive = ownerAlive(lock)
    const age = Number.isFinite(lock.at) ? now() - lock.at : null
    const stale = !alive || (age !== null && age > staleAfterMs)
    return {
      locked: true,
      lock,
      stale,
      reason: !alive
        ? `the lock was taken by pid ${lock.pid}, which is no longer running`
        : `the lock has been held for ${Math.round((age || 0) / 1000)}s`
    }
  }

  /**
   * Take the lock for one episode.
   *
   * @param {object} input
   * @param {string} input.episode the episode id that owns it
   * @param {boolean} [input.stealStale] reclaim a lock whose owner is gone
   * @returns {{ok:boolean, reason?:string, code?:string, lock?:object}}
   */
  function acquire(input = {}) {
    if (disabled) {
      held = true
      return { ok: true, lock: null, disabled: true }
    }
    const current = inspect()
    if (current.locked && held && current.lock && current.lock.token === token) {
      return { ok: true, lock: current.lock, reentrant: true }
    }
    if (current.locked) {
      // A live lock is never stolen, however old it is: an episode that is simply
      // taking a long time is not a crashed process.
      if (!current.stale) {
        return { ok: false, code: LOCK_REASONS.HELD, reason: current.reason, lock: current.lock }
      }
      if (input.stealStale !== true) {
        return {
          ok: false,
          code: LOCK_REASONS.STALE,
          reason: `${current.reason}; pass stealStale to reclaim it`,
          lock: current.lock
        }
      }
    }
    const lock = {
      version: LOCK_VERSION,
      episode: String(input.episode || ''),
      pid: process.pid,
      token,
      at: now(),
      workspace: root
    }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      // `wx` is what makes this exclusive: a second writer's create fails rather
      // than overwriting the first one's lock.
      fs.writeFileSync(file, `${JSON.stringify(lock, null, 2)}\n`, { encoding: 'utf8', flag: current.locked ? 'w' : 'wx' })
      held = true
      return { ok: true, lock }
    } catch (error) {
      // A racing writer won the `wx`: report it as held, not as a crash.
      const after = inspect()
      if (after.locked) return { ok: false, code: LOCK_REASONS.HELD, reason: after.reason, lock: after.lock }
      return { ok: false, code: LOCK_REASONS.UNAVAILABLE, reason: String(error && error.message ? error.message : error) }
    }
  }

  /**
   * Release the lock, but only if it is still ours.
   *
   * @returns {{ok:boolean, reason?:string}}
   */
  function release() {
    if (disabled) {
      held = false
      return { ok: true, disabled: true }
    }
    const lock = read()
    if (!lock) {
      held = false
      return { ok: true, missing: true }
    }
    if (lock.token !== token) {
      held = false
      return { ok: false, code: LOCK_REASONS.LOST, reason: 'the lock was taken over by another writer' }
    }
    try {
      fs.rmSync(file, { force: true })
      held = false
      return { ok: true }
    } catch (error) {
      return { ok: false, code: LOCK_REASONS.UNAVAILABLE, reason: String(error && error.message ? error.message : error) }
    }
  }

  /** Refresh the timestamp so a long episode does not look stale. */
  function heartbeat() {
    if (disabled || !held) return { ok: false, reason: 'this process does not hold the lock' }
    const lock = read()
    if (!lock || lock.token !== token) return { ok: false, code: LOCK_REASONS.LOST, reason: 'the lock was taken over' }
    lock.at = now()
    try {
      fs.writeFileSync(file, `${JSON.stringify(lock, null, 2)}\n`, 'utf8')
      return { ok: true, at: lock.at }
    } catch (error) {
      return { ok: false, code: LOCK_REASONS.UNAVAILABLE, reason: String(error && error.message ? error.message : error) }
    }
  }

  return {
    LOCK_REASONS,
    root,
    file,
    disabled,
    token,
    inspect,
    acquire,
    release,
    heartbeat,
    get held() {
      return held
    }
  }
}

module.exports = { createWorkspaceLock, LOCK_REASONS, LOCK_VERSION, DEFAULT_STALE_AFTER_MS }
