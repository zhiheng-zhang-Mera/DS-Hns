'use strict'

/**
 * DS-Hns: the out-of-process companion — the half of the restart authority that survives a hung app.
 *
 * The companion is a small Node program (`main.cjs`) that owns one child: the application. It reads
 * the application's heartbeat from a file the supervisor writes, and when the process is gone or the
 * heartbeat has gone stale it stops waiting and restarts it. That is the whole reason it exists — a
 * process that has frozen its event loop cannot run the code that would recover it, and an in-process
 * supervisor would be frozen with it.
 *
 * ## What is shared with the plugin, and what is not
 *
 * Everything that is *policy* is shared: this module builds the same `createRestartBudget` and the
 * same `createRestartLifecycle` the in-process plugin uses. Only the six environment-specific things
 * are supplied here:
 *
 * | Injected here | Why it cannot be shared |
 * | --- | --- |
 * | `spawn` / `kill` | the companion owns a real child process; the plugin talks to the shell |
 * | `alive` | process liveness is an OS fact |
 * | `heartbeat` | the beat crosses a process boundary, so it is a file, not an object |
 * | `readiness.process` | "the child is up" means something different from "this process is up" |
 * | `stateDir` | the file the watchdog writes so nobody starts a second one |
 * | `now` / `sleep` | the companion runs on wall-clock time, a test does not |
 *
 * ## The loop, and why it is safe to run unattended
 *
 * ```
 *   start the child → watch → (exit or stale heartbeat) → cool down → restart → watch → …
 * ```
 *
 * Every iteration passes through the budget, so the sequence terminates in `SAFE_MODE` rather than
 * forever: the companion stops restarting, records why, and leaves the last error where a person can
 * read it. It never restarts itself, and it never touches the task layer — resuming is Core's.
 */

const fs = require('node:fs')
const path = require('node:path')

const { createRestartBudget } = require('./budget.cjs')
const { createRestartLifecycle } = require('./lifecycle.cjs')
const { createHeartbeatMonitor } = require('./heartbeat.cjs')
const { createRestartStatus } = require('./status.cjs')
const { RESTART_REASONS, SUPERVISOR_STATES, SUPERVISOR_HEALTH, REFUSAL_CODES } = require('./policy.cjs')

/** Where the companion keeps its own state: the pid file, the stop file and the journal. */
function companionPaths(stateDir) {
  const dir = path.resolve(String(stateDir || path.join(process.cwd(), 'data', 'state', 'restart-supervisor')))
  return {
    dir,
    pidFile: path.join(dir, 'companion.pid'),
    stopFile: path.join(dir, 'companion.stop'),
    heartbeatFile: path.join(dir, 'app.heartbeat.json'),
    journalFile: path.join(dir, 'companion.journal.jsonl'),
    configFile: path.join(dir, 'companion.config.json'),
    budgetFile: path.join(dir, 'budget.json'),
    /** The lock two supervisors use to agree who is executing a restart right now. */
    lockFile: path.join(dir, 'restart.lock'),
    /**
     * Where the **in-process plugin** asks the companion to execute a restart.
     *
     * It is a file for the same reason the heartbeat is one: the two halves are different processes
     * and a hung application cannot answer an IPC call. The plugin writes a request; the companion
     * picks it up on its next watch pass, claims the lock and runs the lifecycle. The plugin never
     * holds a handle on the child, and the companion never scores a pressure — each side does only
     * what it can do when the other is frozen.
     */
    requestFile: path.join(dir, 'restart.request.json')
  }
}

/**
 * The restart lock: **one executor at a time**.
 *
 * Two supervisors watch this application — the in-process plugin (which holds `restart-control`, so a
 * request from the health scheduler reaches it directly) and the out-of-process companion (which owns
 * process launch, so it is the only thing that can recover a frozen app). Both are needed, and two
 * executors for one restart is a fork bomb.
 *
 * The rule is therefore a file either of them can claim, with the claimant's pid and a deadline:
 *
 *   * a supervisor claims the lock before executing and releases it afterwards;
 *   * a supervisor that finds a *live* claim backs off and lets the other one work;
 *   * a claim whose owner is gone, or whose deadline has passed, is stale and may be taken over —
 *     because the failure mode this must not have is a dead process's lock blocking every restart.
 */
function claimRestartLock(stateDir, { owner = 'supervisor', ttlMs = 120_000, now = () => Date.now() } = {}) {
  const paths = companionPaths(stateDir)
  ensureDir(paths.dir)
  const existing = readJson(paths.lockFile)
  if (existing && Number.isFinite(Number(existing.pid))) {
    const age = now() - Number(existing.at || 0)
    if (age < Number(existing.ttlMs || ttlMs)) {
      let holderAlive = false
      try {
        process.kill(Number(existing.pid), 0)
        holderAlive = true
      } catch {
        holderAlive = false
      }
      if (holderAlive) {
        return { ok: false, code: 'RESTART_LOCK_HELD', reason: `a restart is being executed by pid ${existing.pid} (${existing.owner || 'unknown'})`, holder: existing }
      }
    }
  }
  const claim = { pid: process.pid, owner, at: now(), ttlMs }
  if (!writeJson(paths.lockFile, claim)) {
    return { ok: false, code: 'RESTART_LOCK_UNWRITABLE', reason: `the restart lock could not be written (${paths.lockFile})` }
  }
  return { ok: true, claim, file: paths.lockFile }
}

/** Release the lock, and only if this process owns it. */
function releaseRestartLock(stateDir, { now = () => Date.now() } = {}) {
  const paths = companionPaths(stateDir)
  const existing = readJson(paths.lockFile)
  if (!existing) return { ok: true, released: false }
  if (Number(existing.pid) !== process.pid) return { ok: true, released: false, reason: `the lock belongs to pid ${existing.pid}` }
  try {
    fs.rmSync(paths.lockFile, { force: true })
    return { ok: true, released: true, at: now() }
  } catch (error) {
    return { ok: false, reason: String(error && error.message ? error.message : error) }
  }
}

/** Whether somebody else is executing a restart right now. */
function restartLockHeldByOther(stateDir, { ttlMs = 120_000, now = () => Date.now() } = {}) {
  const paths = companionPaths(stateDir)
  const existing = readJson(paths.lockFile)
  if (!existing || !Number.isFinite(Number(existing.pid))) return { held: false }
  if (Number(existing.pid) === process.pid) return { held: false, self: true }
  if (now() - Number(existing.at || 0) >= Number(existing.ttlMs || ttlMs)) return { held: false, stale: existing }
  try {
    process.kill(Number(existing.pid), 0)
    return { held: true, holder: existing }
  } catch {
    return { held: false, dead: existing }
  }
}

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true })
    return true
  } catch {
    return false
  }
}

function readJson(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function writeJson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * @param {object} input
 * @param {string} input.stateDir where the companion's own files live
 * @param {Function} input.spawn `(spec) => child` — start one application process
 * @param {Function} input.kill `(child, kind, timeoutMs) => Promise<{ok, detail}>`
 * @param {Function} input.alive `(child) => boolean`
 * @param {Function} [input.readHeartbeat] `() => { at, ready, responsive, loop } | null`
 * @param {object} [input.config] the supervisor configuration (the same shape the plugin uses)
 * @param {object} [input.readiness] extra probes for the relaunched child
 * @param {Function} [input.now]
 * @param {Function} [input.sleep]
 * @param {Function} [input.log]
 */
function createRestartCompanion(input = {}) {
  const stateDir = input.stateDir
  const paths = companionPaths(stateDir)
  ensureDir(paths.dir)
  const now = typeof input.now === 'function' ? input.now : () => Date.now()
  const wait = typeof input.sleep === 'function' ? input.sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const log = typeof input.log === 'function' ? input.log : () => {}

  const budget = createRestartBudget({ config: input.config, now })
  const config = budget.config
  const heartbeat = createHeartbeatMonitor({ config: config.heartbeat, now })
  /**
   * The formal, persisted record of the restarts this companion performs.
   *
   * Injected (`input.status`) so the caller owns where it lives — the plugin and the companion share
   * one state directory and therefore one `restart_status.json` — and created here when it was not,
   * so a companion started by hand still leaves an answer behind.
   */
  const status = input.status || createRestartStatus({ stateDir, now, log, config: { historyLimit: config.history && config.history.maxEntries }, writer: `companion:${process.pid}` })

  /** The child the companion owns, and the facts about it that only the OS knows. */
  let child = null
  let childPid = null
  /**
   * Whether the application was already running when this companion started.
   *
   * The companion is normally the *launcher*: it starts the application and watches its child. That is
   * the only shape available when the supervisor owns the boot, and it is not available when the
   * product is already up — which is the case for the shell's own boot path, because the shell is the
   * running application. In that shape the companion **attaches**: it adopts the running pid, watches
   * the same heartbeat, and can stop and relaunch through the same lifecycle. The two differ in exactly
   * one place — who started the process — so everything else (budget, cooldown, backoff, crash loop,
   * safe mode, journal) is shared rather than duplicated.
   */
  let attached = false
  let state = SUPERVISOR_STATES.IDLE
  let lastError = null
  let stopping = false
  let restartsAttempted = 0
  const journal = []

  /** Is a pid still there? The one OS question an attached companion can ask about a process it does not own. */
  function pidAlive(pid) {
    if (typeof input.pidAlive === 'function') return input.pidAlive(pid)
    if (!Number.isFinite(Number(pid)) || Number(pid) <= 0) return false
    try {
      process.kill(Number(pid), 0)
      return true
    } catch {
      return false
    }
  }

  function record(entry) {
    const line = { at: now(), state, ...entry }
    journal.push(line)
    if (journal.length > 200) journal.shift()
    try {
      fs.appendFileSync(paths.journalFile, `${JSON.stringify(line)}\n`, 'utf8')
    } catch {
      // A journal that cannot be written must not stop the restart: the restart is the job.
    }
    return line
  }

  /** The heartbeat, from outside. A missing or unreadable file is *unknown*, never healthy. */
  function readBeat() {
    const raw = typeof input.readHeartbeat === 'function' ? input.readHeartbeat() : readJson(paths.heartbeatFile)
    if (!raw || !Number.isFinite(Number(raw.at))) return null
    return { at: Number(raw.at), ready: raw.ready === true, responsive: raw.responsive !== false, loop: raw.loop !== false }
  }

  /**
   * Fold the application's own beat into the monitor.
   *
   * `ready` is not implied by the beat existing: a launch that has not finished booting writes a beat
   * with `ready: false`, and treating that as ready is how a supervisor starts restarting an
   * application that is still starting. A beat flagged `responsive: false` is recorded as a *failed*
   * signal rather than a stale one — the application is telling us it is unwell, which is different
   * from it having gone quiet.
   */
  function absorbBeat(atMs) {
    const beat = readBeat()
    if (!beat) return heartbeat.report(atMs)
    heartbeat.seen(childPid, beat.at)
    if (beat.responsive) heartbeat.beatResponsive(null, beat.at)
    else heartbeat.fail('responsive', 'the application reported itself unresponsive', beat.at)
    if (beat.loop) heartbeat.beatLoop(null, beat.at)
    else heartbeat.fail('loop', 'the application reported a frozen event loop', beat.at)
    if (beat.ready) heartbeat.beatReady(null, beat.at)
    return heartbeat.report(atMs)
  }

  /**
   * Adopt a running application instead of starting one.
   *
   * This is the shell's boot path: DS-Hns is already up (it is the process asking), so a companion that
   * insisted on launching would start a *second* application. Attaching keeps the supervision real —
   * the heartbeat, the budget and the forced restart are the same code — while leaving the process the
   * shell started where it is.
   *
   * A refused attach is reported rather than guessed at: a companion that attached to nothing would
   * watch a pid of `null` and call it healthy.
   */
  function attach(pid) {
    const target = Number(pid)
    if (!Number.isFinite(target) || target <= 0) return { ok: false, reason: `attach needs a pid, not ${JSON.stringify(pid)}` }
    if (!pidAlive(target)) return { ok: false, reason: `pid ${target} is not running, so there is nothing to supervise` }
    attached = true
    child = null
    childPid = target
    heartbeat.reset()
    heartbeat.seen(childPid, now())
    state = SUPERVISOR_STATES.MONITORING
    record({ kind: 'attached', pid: childPid })
    return { ok: true, pid: childPid, mode: 'attached' }
  }

  /** Start the application once. Returns `{ ok, pid }` or a coded failure. */
  function launchChild(reasonCode) {
    state = SUPERVISOR_STATES.RELAUNCHING
    let started = null
    try {
      started = input.spawn({ reasonCode, at: now() })
    } catch (error) {
      const reason = String(error && error.message ? error.message : error)
      lastError = { at: now(), code: 'SUPERVISOR_SPAWN_THREW', reason }
      record({ kind: 'spawn-failed', reasonCode, reason })
      return { ok: false, reason }
    }
    if (!started || started.ok === false) {
      const reason = (started && started.reason) || 'the spawn returned nothing'
      lastError = { at: now(), code: 'SUPERVISOR_SPAWN_FAILED', reason }
      record({ kind: 'spawn-failed', reasonCode, reason })
      return { ok: false, reason }
    }
    child = started.child || started
    childPid = child && child.pid ? child.pid : null
    // From here on the companion owns the process it started: the pid it adopted before is gone.
    attached = false
    heartbeat.reset()
    heartbeat.seen(childPid, now())
    state = SUPERVISOR_STATES.MONITORING
    record({ kind: 'launched', reasonCode, pid: childPid })
    return { ok: true, pid: childPid }
  }

  /**
   * The lifecycle's executor: stop and start, in this process's own terms.
   *
   * The lifecycle owns the *order*; this owns the mechanism. A graceful stop asks the child to leave
   * and waits; a forced stop kills the tree. Both are bounded, and both report why when they fail.
   */
  const executor = {
    stop: async ({ kind, timeoutMs }) => {
      /**
       * An attached application is stopped by pid rather than through a child handle: the companion did
       * not start it, so it has no `ChildProcess` to signal. The mechanism is the same one the killer
       * uses — ask first, terminate the tree only if the answer does not arrive — and the injection
       * point is separate so the difference is visible rather than hidden inside one function.
       */
      if (attached && childPid) {
        state = SUPERVISOR_STATES.STOPPING
        const stopped = typeof input.killByPid === 'function'
          ? await input.killByPid(childPid, kind, timeoutMs)
          : { ok: false, reason: 'this companion attached to the application and has no way to stop it' }
        if (stopped && stopped.ok === true) childPid = null
        return stopped
      }
      if (!child) return { ok: true, detail: 'there is no child to stop' }
      state = SUPERVISOR_STATES.STOPPING
      const stopped = await input.kill(child, kind, timeoutMs)
      child = null
      childPid = null
      return stopped
    },
    launch: async () => launchChild(RESTART_REASONS.CRASH_RECOVERY),
    /** The child's exit is observed by the watch loop; the lifecycle only needs to know it may. */
    waitForExit: async () => ({ ok: true, detail: 'the watch loop observes the exit' })
  }

  /** The continuity hooks, as seen from outside: a file the application leaves for us, and nothing else. */
  const continuity = {
    beforeRestart: async () => {
      const intent = readJson(path.join(paths.dir, 'resume-intent.json'))
      return { ok: true, detail: intent ? `the application left a resume intent for ${intent.planId || 'a task'}` : 'the application left no resume intent' }
    },
    afterRestart: async () => ({ ok: true, detail: 'the application resumes its own work; the companion does not' }),
    pendingWork: async () => {
      // From outside, "is a task in flight" is a fact the application publishes, not one we can see.
      // Known-unknown is reported as unknown, and the lifecycle continues without a boundary promise.
      const beat = readBeat()
      if (!beat) return { ok: false, reason: 'the application publishes no work telemetry' }
      return { ok: true, active: beat.active === true, nearCheckpoint: beat.nearCheckpoint === true, uninterruptible: beat.uninterruptible === true }
    }
  }

  const readiness = {
    process: async () => {
      if (attached && childPid) {
        const up = pidAlive(childPid)
        return up ? { ok: true, detail: `pid ${childPid} is up (attached)` } : { ok: false, reason: `pid ${childPid} is gone` }
      }
      if (!child) return { ok: false, reason: 'no child process' }
      const up = input.alive(child)
      return up ? { ok: true, detail: `pid ${childPid} is up` } : { ok: false, reason: `pid ${childPid} is gone` }
    },
    runtime: async () => {
      const beat = readBeat()
      if (!beat) return { ok: false, reason: 'no heartbeat has been written yet' }
      return beat.ready ? { ok: true, detail: `the application reported ready at ${beat.at}` } : { ok: false, reason: 'the application has not reported ready' }
    },
    ...(input.readiness && typeof input.readiness === 'object' ? input.readiness : {})
  }

  const lifecycle = createRestartLifecycle({
    budget,
    config,
    now,
    sleep: wait,
    log,
    executor,
    continuity,
    readiness,
    /**
     * The companion is usually the executor in the deployed shape, so it is usually the half that
     * writes `restart_status.json`. Every stage is reported as it happens: the process that runs the
     * shutdown is the one that will not be there to describe it afterwards.
     */
    onPhase: (phase, detail) => {
      if (status && typeof status.phase === 'function') status.phase(phase, detail)
    }
  })

  /**
   * One restart, requested for a reason the companion observed itself.
   *
   * A refusal (safe mode, budget, cooldown) is *not* an error: it is the policy working. The
   * companion reports it and goes back to watching, and in safe mode it stops restarting entirely
   * and waits for a human — the file `companion.stop` is how that human asks it to stand down.
   */
  async function requestRestart(reasonCode, reasonSummary) {
    restartsAttempted += 1
    // One executor at a time. The in-process plugin holds `restart-control`, so a request from the
    // health scheduler reaches it first; when it is already executing, this companion must not run a
    // second restart for the same event. It waits, and the next iteration reports the truth.
    const held = restartLockHeldByOther(paths.dir, { now })
    if (held.held) {
      record({ kind: 'restart-deferred', reasonCode, detail: `pid ${held.holder.pid} is already executing a restart` })
      status.refuse({ request: { mode: input.mode || 'application', reasonCode, reasonSummary, requestedBy: input.requestedBy || 'companion' }, code: 'RESTART_LOCK_HELD', reason: `pid ${held.holder.pid} is already executing a restart` })
      return { ok: false, code: 'RESTART_LOCK_HELD', reason: `pid ${held.holder.pid} is already executing a restart`, deferred: true }
    }
    const claimed = claimRestartLock(paths.dir, { owner: 'companion', now })
    if (claimed.ok !== true) {
      record({ kind: 'restart-deferred', reasonCode, code: claimed.code, detail: claimed.reason })
      status.refuse({ request: { mode: input.mode || 'application', reasonCode, reasonSummary, requestedBy: input.requestedBy || 'companion' }, code: claimed.code, reason: claimed.reason })
      return { ok: false, code: claimed.code, reason: claimed.reason, deferred: true }
    }
    try {
      /**
       * The formal status starts before the restart does, and it is written *by this process*.
       *
       * The companion owns the child, so it also owns the only account of what happened to it: the
       * plugin's status file would be written by a process that is about to be stopped.
       */
      status.begin({ request: { mode: input.mode || 'application', reasonCode, reasonSummary, requestedBy: input.requestedBy || 'companion', checkpointRequired: true }, executor: attached ? 'companion-attached' : 'companion' })
      const outcome = await lifecycle.run({
        mode: input.mode || 'application',
        reasonCode,
        reasonSummary,
        checkpointRequired: true
      })
      if (outcome.counted === false) {
        // A refusal spends nothing and stops nothing: it is recorded as a refusal rather than as a
        // restart that failed, because those are different events to a person reading the history.
        status.refuse({ request: { mode: input.mode || 'application', reasonCode, reasonSummary, requestedBy: input.requestedBy || 'companion' }, code: outcome.code, reason: outcome.reason })
      } else {
        status.complete({
          ok: outcome.ok === true,
          code: outcome.code || null,
          detail: (outcome.record && outcome.record.detail) || outcome.reason || null,
          process: outcome.readiness || null,
          task: outcome.resume || null,
          semantic: outcome.resume && outcome.resume.semantic ? outcome.resume.semantic : null,
          counted: true,
          ms: outcome.ms
        })
      }
      if (outcome.ok === true) {
        state = SUPERVISOR_STATES.MONITORING
        record({ kind: 'restart-complete', reasonCode, detail: outcome.record ? outcome.record.detail : null, ms: outcome.ms })
        return outcome
      }
      lastError = { at: now(), code: outcome.code, reason: outcome.reason }
      record({ kind: 'restart-refused', reasonCode, code: outcome.code, reason: outcome.reason })
      if (outcome.code === REFUSAL_CODES.SAFE_MODE) state = SUPERVISOR_STATES.SAFE_MODE
      else if (outcome.code === REFUSAL_CODES.BUDGET_EXHAUSTED) state = SUPERVISOR_STATES.SAFE_MODE
      else state = SUPERVISOR_STATES.DEGRADED
      return outcome
    } finally {
      releaseRestartLock(paths.dir, { now })
    }
  }

  /** Whether a person has asked the companion to stand down. */
  function stopRequested() {
    return fs.existsSync(paths.stopFile)
  }

  /**
   * The restart the in-process plugin asked for, if there is one waiting.
   *
   * A stale request — older than `ttlMs` — is discarded and reported: a request written before a
   * crash must not restart the application again an hour later, and a request that was already
   * served is removed by the caller.
   */
  function pendingRequest({ ttlMs = 300_000, now: at = now() } = {}) {
    const request = readJson(paths.requestFile)
    if (!request) return { ok: true, pending: false }
    const age = at - Number(request.at || 0)
    if (!Number.isFinite(age) || age > ttlMs) {
      try {
        fs.rmSync(paths.requestFile, { force: true })
      } catch {
        // Nothing to remove is the normal case.
      }
      return { ok: true, pending: false, stale: true, ageMs: Number.isFinite(age) ? age : null, request }
    }
    return { ok: true, pending: true, request }
  }

  /** Consume a request: it has been executed (or refused) and must not be seen again. */
  function clearRequest() {
    try {
      fs.rmSync(paths.requestFile, { force: true })
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: String(error && error.message ? error.message : error) }
    }
  }

  /** Write the watchdog files, and refuse to run a second companion for the same application. */
  function claim() {
    const existing = readJson(paths.pidFile)
    if (existing && Number.isFinite(Number(existing.pid))) {
      try {
        process.kill(Number(existing.pid), 0)
        return { ok: false, code: 'SUPERVISOR_ALREADY_RUNNING', reason: `another companion is running as pid ${existing.pid}`, pid: existing.pid }
      } catch {
        // The pid file is stale; claiming it is the repair.
      }
    }
    writeJson(paths.pidFile, { pid: process.pid, at: now(), startedBy: 'dsh-restart-supervisor' })
    try {
      fs.rmSync(paths.stopFile, { force: true })
    } catch {
      // A stop file that cannot be removed is reported by the first iteration of the loop.
    }
    return { ok: true, pid: process.pid, paths }
  }

  function release() {
    try {
      const existing = readJson(paths.pidFile)
      if (existing && Number(existing.pid) === process.pid) fs.rmSync(paths.pidFile, { force: true })
    } catch {
      // Leaving a stale pid file is worse than leaving none, but it is also recoverable by `claim`.
    }
    state = SUPERVISOR_STATES.IDLE
    return { ok: true }
  }

  /**
   * The watch loop.
   *
   * Bounded by `iterations` (a test passes a small number; production passes `Infinity` and stops on
   * the stop file). One iteration is: absorb the beat, decide, and act — restart, or wait.
   */
  async function watch(options = {}) {
    const intervalMs = Number.isFinite(options.intervalMs) ? options.intervalMs : Math.max(1_000, Math.floor(config.heartbeat.intervalMs / 2))
    const maxIterations = Number.isFinite(options.iterations) ? options.iterations : Infinity
    let iterations = 0
    const trace = []
    let probe = typeof options.probe === 'function' ? options.probe : null

    while (iterations < maxIterations) {
      iterations += 1
      if (stopping || stopRequested()) {
        state = SUPERVISOR_STATES.IDLE
        trace.push({ iteration: iterations, verdict: 'stopped', detail: 'the companion was asked to stand down' })
        break
      }
      // A test drives the world through `probe`; production reads the OS and the heartbeat file.
      const observed = probe ? probe({ iteration: iterations, at: now() }) : null

      /**
       * A restart the plugin asked for comes first.
       *
       * The plugin holds `restart-control`, so a request from the health scheduler lands there; what
       * it cannot do is own the child process. So it writes the request, and this loop executes it —
       * the one executor that can survive the application being gone.
       */
      const delegated = pendingRequest({ now: now() })
      if (delegated.pending) {
        trace.push({ iteration: iterations, verdict: 'delegated', reasonCode: delegated.request.reasonCode, detail: delegated.request.reasonSummary || null, at: now() })
        const outcome = await requestRestart(delegated.request.reasonCode || RESTART_REASONS.MANUAL, delegated.request.reasonSummary || 'requested through restart-control')
        clearRequest()
        trace.push({ iteration: iterations, verdict: outcome.ok === true ? 'delegated-restarted' : 'delegated-refused', code: outcome.code || null, reason: outcome.reason || null })
        if (iterations < maxIterations) await wait(intervalMs)
        continue
      }
      if (observed && Number.isFinite(observed.pid)) {
        childPid = Number(observed.pid)
        heartbeat.seen(childPid, now())
      }
      if (observed && observed.responsive === false) heartbeat.fail('responsive', 'the probe reported the application unresponsive')
      if (observed && observed.ready === true) heartbeat.beatReady('the probe reported the application ready')
      const report = absorbBeat(now())
      const exitCode = observed && Number.isFinite(observed.exitCode) ? observed.exitCode : null
      /**
       * Whether the application is gone.
       *
       * Three shapes, because the companion can be in three: a test drives the world through `probe`
       * and says so itself; an attached companion asks the OS about a pid it did not start; a launcher
       * companion asks its own child handle. The attached shape is why this is not just
       * `input.alive(child)` — with no child, that expression is how a supervisor reports a healthy
       * application that left ten minutes ago.
       */
      const gone = observed
        ? observed.alive === false
        : attached
          ? childPid === null || !pidAlive(childPid)
          : child !== null && !input.alive(child)

      if (report.action === 'none' && !gone && exitCode === null) {
        state = SUPERVISOR_STATES.MONITORING
        trace.push({ iteration: iterations, verdict: 'healthy', detail: report.reason })
      } else {
        const reasonCode = gone
          ? (exitCode !== null && exitCode !== 0 ? RESTART_REASONS.PROCESS_EXITED : RESTART_REASONS.CRASH_RECOVERY)
          : report.action === 'forced-restart'
            ? RESTART_REASONS.HEARTBEAT_STALE
            : RESTART_REASONS.HEARTBEAT_STALE
        const summary = gone
          ? `the application left (${exitCode === null ? 'no exit code observed' : `exit ${exitCode}`})`
          : report.reason
        trace.push({ iteration: iterations, verdict: report.action === 'none' ? 'gone' : report.action, reasonCode, detail: summary, at: now() })
        if (state === SUPERVISOR_STATES.SAFE_MODE) {
          trace.push({ iteration: iterations, verdict: 'safe-mode', detail: 'no automatic restart will be attempted; a person has to reset the budget' })
        } else {
          const outcome = await requestRestart(reasonCode, summary)
          trace.push({ iteration: iterations, verdict: outcome.ok === true ? 'restarted' : 'refused', code: outcome.code || null, reason: outcome.reason || null })
          if (outcome.ok !== true && !gone) heartbeat.reset()
        }
      }
      if (iterations < maxIterations) await wait(intervalMs)
    }
    return { ok: true, iterations, state, trace, health: budget.report().health, lastError, journal: journal.slice(-25) }
  }

  function describe(atMs = now()) {
    return {
      pid: process.pid,
      /** `attached` or `launcher`: which of the two shapes this companion is running in. */
      mode: attached ? 'attached' : 'launcher',
      state,
      health: budget.report(atMs).health,
      budget: budget.report(atMs),
      heartbeat: heartbeat.report(atMs),
      childPid,
      restartsAttempted,
      lastError,
      paths,
      /** The formal record of the restarts this companion performed, from the file a person reads. */
      restartStatus: status.describe(atMs),
      config: {
        heartbeat: config.heartbeat,
        budget: config.budget,
        crashLoop: config.crashLoop,
        lifecycle: config.lifecycle,
        readiness: config.readiness
      },
      lastJournal: journal.slice(-10)
    }
  }

  /** Ask the watch loop to finish its current iteration and leave. */
  function stop(reason = 'stopped') {
    stopping = true
    record({ kind: 'stopping', reason })
    return { ok: true, reason }
  }

  return {
    paths,
    claim,
    release,
    attach,
    watch,
    stop,
    describe,
    launchChild,
    requestRestart,
    pendingRequest,
    clearRequest,
    budget,
    heartbeat,
    lifecycle,
    /** The formal status the companion writes: a person, the installer and the panel all read this. */
    status,
    get state() { return state },
    setState: (next) => { state = next; return state },
    journal: () => journal.slice(),
    /** For a test: what the companion would do with a report, without running the loop. */
    decide: (atMs) => absorbBeat(atMs)
  }
}

module.exports = {
  createRestartCompanion,
  companionPaths,
  claimRestartLock,
  releaseRestartLock,
  restartLockHeldByOther,
  readJson,
  writeJson,
  SUPERVISOR_STATES,
  SUPERVISOR_HEALTH
}
