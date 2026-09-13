'use strict'

/**
 * DS-Hns acceleration: the persistent tool runtime.
 *
 * Phase 9 of the acceleration plan. A long episode runs thousands of steps, and the
 * naive shape of every one of them is:
 *
 *   start a shell -> initialise it -> load dependencies -> run one command -> exit
 *
 * The start, the initialisation and the dependency load are the same work every time,
 * and they dominate the cost of a step that is otherwise instant. Keeping the tool
 * alive across steps is the difference between paying that cost once and paying it
 * a thousand times.
 *
 * The module owns the *lifecycle*, not the processes: `start`, `stop` and `check` are
 * injected, so the shell is the existing process supervision, the browser is the
 * existing Computer Use session, and the model server is the existing provider. This
 * is deliberate — the plan forbids reimplementing the subsystems, and a second process
 * registry would be a second thing to get wrong.
 *
 * Three properties make persistence safe rather than merely fast, and each is a
 * failure this module exists to prevent:
 *
 *  * **A handle is never reused on faith.** A session that died quietly still looks
 *    alive from the outside, so `check` is a real probe and a handle that fails it is
 *    discarded before the next step can be handed a corpse.
 *  * **A handle does not live forever.** Sessions leak memory, drift in state and
 *    accumulate side effects; a bounded reuse count and an idle TTL retire them
 *    before that becomes a mystery bug in step 4000.
 *  * **Capacity is refused, never silently dropped.** At the ceiling the runtime says
 *    so, after reaping what is legitimately idle; it never closes a session that a
 *    running step is using, and it never quietly opens one handle too many.
 */

/** The tools the plan keeps alive across steps. */
const TOOL_KINDS = Object.freeze({
  SHELL: 'shell',
  LSP: 'lsp',
  BROWSER: 'browser',
  COMPUTER_USE: 'computer-use',
  MODEL_SERVER: 'model-server'
})

const HANDLE_STATES = Object.freeze({
  STARTING: 'starting',
  READY: 'ready',
  BUSY: 'busy',
  DEAD: 'dead',
  STOPPED: 'stopped'
})

const DEFAULT_POLICY = Object.freeze({
  /** Hard ceiling on live handles, whatever the caller asks for. */
  maxHandles: 8,
  /** An unclaimed handle older than this is retired. */
  idleTtlMs: 10 * 60 * 1000,
  /** A handle is recycled after this many uses even if it never failed. */
  maxReusesBeforeRecycle: 200,
  /** Consecutive failed uses that condemn a handle. */
  failuresBeforeRecycle: 2
})

const KNOWN_KINDS = new Set(Object.values(TOOL_KINDS))

/**
 * @param {object} [options]
 * @param {Function} [options.start] `async (kind, key) => resource`
 * @param {Function} [options.stop] `async (resource) => void`
 * @param {Function} [options.check] `async (resource) => boolean` — a real probe
 * @param {Function} [options.now]
 * @param {Function} [options.log]
 * @param {object} [options.policy]
 */
function createPersistentTools(options = {}) {
  const policy = { ...DEFAULT_POLICY, ...(options.policy || {}) }
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const log = typeof options.log === 'function' ? options.log : () => {}
  const start = typeof options.start === 'function' ? options.start : async () => ({})
  const stop = typeof options.stop === 'function' ? options.stop : async () => {}
  const check = typeof options.check === 'function' ? options.check : async () => true

  const handles = new Map()
  /** A start already in flight, so two concurrent acquires share one session. */
  const starting = new Map()
  let nextId = 1
  let starts = 0
  let reuses = 0
  let recycled = 0
  let retired = 0
  let refused = 0
  let disposed = false

  const keyOf = (kind, key) => `${kind}:${key === undefined || key === null ? 'default' : String(key)}`

  function findLive(kind, key) {
    const wanted = keyOf(kind, key)
    for (const handle of handles.values()) {
      if (handle.keyOf === wanted && (handle.state === HANDLE_STATES.READY || handle.state === HANDLE_STATES.BUSY)) return handle
    }
    return null
  }

  function describeHandle(handle) {
    return {
      id: handle.id,
      kind: handle.kind,
      key: handle.key,
      state: handle.state,
      uses: handle.uses,
      failures: handle.failures,
      ageMs: now() - handle.createdAt,
      idleMs: now() - handle.lastUsedAt
    }
  }

  /** Retire a handle for good: stop the resource, then forget it. */
  async function discard(handle, reason) {
    handle.state = HANDLE_STATES.DEAD
    handles.delete(handle.id)
    recycled += 1
    log(`persistent tool "${handle.kind}" (${handle.id}) discarded: ${reason}`)
    try {
      await stop(handle.resource)
    } catch (error) {
      // A failed stop must not trap the handle in the map; the process is gone from
      // the runtime's point of view either way, and the caller is told.
      log(`persistent tool "${handle.kind}" (${handle.id}) failed to stop: ${error && error.message ? error.message : error}`)
    }
    return { id: handle.id, kind: handle.kind, reason }
  }

  /**
   * Idle handles past their TTL, retired in place.
   *
   * Only idle handles are candidates: a handle a step is holding must never have its
   * session closed underneath it.
   */
  async function reap() {
    const stopped = []
    for (const handle of [...handles.values()]) {
      if (handle.state !== HANDLE_STATES.READY) continue
      const idleMs = now() - handle.lastUsedAt
      if (idleMs < policy.idleTtlMs) continue
      handle.state = HANDLE_STATES.STOPPED
      handles.delete(handle.id)
      retired += 1
      stopped.push({ id: handle.id, kind: handle.kind, idleMs })
      try {
        await stop(handle.resource)
      } catch (error) {
        log(`persistent tool "${handle.kind}" (${handle.id}) failed to stop while reaping: ${error && error.message ? error.message : error}`)
      }
    }
    return { stopped, kept: handles.size }
  }

  async function startHandle(kind, key) {
    if (handles.size >= policy.maxHandles) await reap()
    if (handles.size >= policy.maxHandles) {
      refused += 1
      return { ok: false, reason: `no capacity: ${handles.size} of ${policy.maxHandles} persistent ${kind} handles are live` }
    }
    const handle = {
      id: `${kind}-${nextId}`,
      kind,
      key: key === undefined || key === null ? null : key,
      keyOf: keyOf(kind, key),
      state: HANDLE_STATES.STARTING,
      createdAt: now(),
      lastUsedAt: now(),
      uses: 0,
      failures: 0,
      resource: null
    }
    nextId += 1
    handles.set(handle.id, handle)
    starts += 1
    try {
      handle.resource = await start(kind, handle.key)
    } catch (error) {
      handles.delete(handle.id)
      return { ok: false, reason: `failed to start ${kind}: ${error && error.message ? error.message : error}` }
    }
    handle.state = HANDLE_STATES.READY
    return { ok: true, handle }
  }

  /**
   * Take a handle for `kind`/`key`, starting one only when there is none to reuse.
   *
   * Two concurrent acquires of the same tool share one start rather than racing to
   * create two sessions — the second would leak, because only one of them would ever
   * be released by a caller that believes it owns the only handle.
   */
  async function acquire(kind, key) {
    if (disposed) {
      refused += 1
      return { ok: false, reason: 'the persistent tool runtime is disposed' }
    }
    if (!KNOWN_KINDS.has(kind)) {
      refused += 1
      return { ok: false, reason: `"${kind}" is not a known persistent tool kind` }
    }
    const wanted = keyOf(kind, key)
    const live = findLive(kind, key)
    if (live) {
      live.uses += 1
      live.lastUsedAt = now()
      live.state = HANDLE_STATES.BUSY
      reuses += 1
      return { ok: true, handle: describeHandle(live), resource: live.resource, reused: true }
    }
    const pending = starting.get(wanted)
    if (pending) {
      const outcome = await pending
      if (!outcome.ok) return outcome
      return acquire(kind, key)
    }
    const promise = startHandle(kind, key)
    starting.set(wanted, promise)
    let outcome
    try {
      outcome = await promise
    } finally {
      starting.delete(wanted)
    }
    if (!outcome.ok) return outcome
    const handle = outcome.handle
    handle.uses += 1
    handle.lastUsedAt = now()
    handle.state = HANDLE_STATES.BUSY
    return { ok: true, handle: describeHandle(handle), resource: handle.resource, reused: false }
  }

  /**
   * Return a handle.
   *
   * A failed use is counted, and enough consecutive failures condemn the handle: a
   * session that keeps failing is restarted rather than retried forever, which is the
   * difference between a recoverable step and a stuck episode.
   */
  async function release(id, outcome = {}) {
    const handle = handles.get(id)
    if (!handle) return { ok: false, reason: `unknown persistent handle "${id}"` }
    handle.lastUsedAt = now()
    if (outcome.ok === false) {
      handle.failures += 1
      if (handle.failures >= policy.failuresBeforeRecycle) {
        const discarded = await discard(handle, `${handle.failures} consecutive failed uses`)
        return { ok: true, released: true, recycled: true, reason: discarded.reason }
      }
    } else {
      handle.failures = 0
    }
    if (handle.uses >= policy.maxReusesBeforeRecycle) {
      const discarded = await discard(handle, `reused ${handle.uses} times, past the recycling limit`)
      return { ok: true, released: true, recycled: true, reason: discarded.reason }
    }
    handle.state = HANDLE_STATES.READY
    return { ok: true, released: true, recycled: false }
  }

  /**
   * Acquire, use, release — the shape every step actually wants.
   *
   * The release happens on both paths, so a throwing step cannot leak a handle that
   * then counts against capacity for the rest of the episode.
   */
  async function run(kind, key, fn) {
    const acquired = await acquire(kind, key)
    if (!acquired.ok) return { ok: false, reason: acquired.reason, reused: false }
    try {
      const value = await fn(acquired.resource, acquired.handle)
      await release(acquired.handle.id, { ok: true })
      return { ok: true, value, reused: acquired.reused, id: acquired.handle.id }
    } catch (error) {
      const released = await release(acquired.handle.id, { ok: false })
      return {
        ok: false,
        reason: error && error.message ? error.message : String(error),
        reused: acquired.reused,
        id: acquired.handle.id,
        recycled: released.recycled === true
      }
    }
  }

  /**
   * Probe every live handle and discard the ones that are not really there.
   *
   * This is the check that makes reuse honest: `check` is a real probe against the
   * resource, and a handle that fails it is retired so the next step starts a fresh
   * session instead of being handed a process that died quietly.
   */
  async function healthAll() {
    const dead = []
    for (const handle of [...handles.values()]) {
      if (handle.state === HANDLE_STATES.STARTING) continue
      let alive = false
      try {
        alive = (await check(handle.resource, { id: handle.id, kind: handle.kind })) !== false
      } catch (error) {
        alive = false
        log(`persistent tool "${handle.kind}" (${handle.id}) probe threw: ${error && error.message ? error.message : error}`)
      }
      if (alive) continue
      dead.push(await discard(handle, 'the health probe found it dead'))
    }
    return { ok: dead.length === 0, dead, live: handles.size }
  }

  /** Stop everything. After this the runtime refuses to hand out a handle. */
  async function dispose() {
    const stoppedIds = []
    for (const handle of [...handles.values()]) {
      handle.state = HANDLE_STATES.STOPPED
      handles.delete(handle.id)
      retired += 1
      stoppedIds.push(handle.id)
      try {
        await stop(handle.resource)
      } catch (error) {
        log(`persistent tool "${handle.kind}" (${handle.id}) failed to stop during dispose: ${error && error.message ? error.message : error}`)
      }
    }
    disposed = true
    return { stopped: stoppedIds }
  }

  return {
    policy,
    acquire,
    release,
    run,
    reap,
    healthAll,
    discard,
    dispose,
    list: () => [...handles.values()].map(describeHandle),
    get size() {
      return handles.size
    },
    get disposed() {
      return disposed
    },
    /** The accounting that shows persistence is actually doing something. */
    stats() {
      const byKind = {}
      for (const handle of handles.values()) byKind[handle.kind] = (byKind[handle.kind] || 0) + 1
      const total = starts + reuses
      return {
        handles: handles.size,
        byKind,
        starts,
        /** Every reuse is one start, init, dependency load and exit that did not happen. */
        avoidedStarts: reuses,
        reuses,
        reuseRatio: total === 0 ? 0 : Number((reuses / total).toFixed(4)),
        recycled,
        retired,
        refused,
        disposed
      }
    }
  }
}

module.exports = {
  createPersistentTools,
  TOOL_KINDS,
  HANDLE_STATES,
  DEFAULT_POLICY
}
