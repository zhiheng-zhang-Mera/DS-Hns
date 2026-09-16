'use strict'

/**
 * DS-Hns Core: the managed-process supervisor.
 *
 * This is the half of `ProcessPluginAdapter` that understands processes and nothing else. It starts
 * one, talks to it over a transport, watches its heartbeat, records how it left, restarts it within
 * declared bounds, keeps its logs and never lets any of it reach the host.
 *
 * ## The two loops this module exists to prevent
 *
 * A supervisor that restarts things is a loop, and a loop with no bound is an outage. Two are
 * possible here and both are bounded by construction rather than by hope:
 *
 *   * **The restart loop.** `maxRestarts` inside `windowMs`, with a doubling backoff capped at
 *     `backoffMaxMs`. When the budget is spent the process is *not* restarted again: it enters
 *     `safe-mode`, which is terminal, and the reason names the exit codes that caused it. This
 *     holds even under `policy: always`, which is the setting that would otherwise loop forever.
 *   * **The handshake loop.** A process that starts and immediately dies never reaches `ready`; the
 *     start attempt fails with a coded reason instead of being retried inline. Every start is one
 *     attempt, and retrying is the restart policy's decision — which is bounded.
 *
 * ## Fault isolation
 *
 * Nothing in this file throws. A spawn that fails, a frame that cannot be written, a heartbeat that
 * stops, a plugin that exits mid-invocation — each is a coded value recorded on the supervisor and
 * reported. The caller is the plugin manager, and a managed process that misbehaves must be a
 * plugin with a bad status, never an exception in the shell.
 */

const path = require('node:path')
const { spawn: defaultSpawn } = require('node:child_process')

const {
  PROCESS_FRAMES,
  PROCESS_FAULT_CODES,
  PROCESS_STATES,
  EXIT_KINDS,
  processFault,
  classifyExit,
  policyWantsRestart,
  environmentFor
} = require('./contract.cjs')
const { createTransport } = require('./transport.cjs')

/**
 * @param {object} input
 * @param {object} input.manifest a validated, normalized process manifest
 * @param {string} input.dir the plugin directory (the child's working directory by default)
 * @param {Function} [input.spawn] injectable, for tests
 * @param {string} [input.nodeExe] used when the command's first element is a script rather than a binary
 * @param {Function} [input.log]
 * @param {Function} [input.now]
 */
function createProcessSupervisor(input = {}) {
  const manifest = input.manifest
  const dir = path.resolve(String(input.dir || '.'))
  const log = typeof input.log === 'function' ? input.log : () => {}
  const now = typeof input.now === 'function' ? input.now : () => Date.now()
  const spawn = typeof input.spawn === 'function' ? input.spawn : defaultSpawn

  const restart = manifest.restart
  const heartbeat = manifest.heartbeat
  const limits = manifest.limits

  let state = PROCESS_STATES.STOPPED
  let child = null
  let transport = null
  let startedAt = null
  let stoppedAt = null
  let intentionalStop = false
  let disposed = false
  let restartTimer = null
  let currentBackoffMs = restart.backoffMs

  let lastHeartbeatAt = null
  let heartbeatCount = 0
  let heartbeatStale = false

  const exitHistory = []
  const restartTimes = []
  const faults = []
  const logs = []
  let stderrCarry = ''
  const invocationHistory = []

  /**
   * The surface the *manifest* declares. This is the authoritative one.
   *
   * A process also announces what it offers in its `ready` frame, and the two are not the same
   * thing: the manifest is what the host validated, what the permission decision was made against
   * and what the user enabled. If a process could widen its own surface at handshake, a plugin
   * could ship a one-method manifest and then offer ten, and everything the platform showed about
   * it before it started would have been decoration. So the manifest wins, the announcement is
   * treated as a *confirmation* of it, and anything claimed beyond it is refused and recorded.
   */
  const allowed = new Map(
    manifest.provides.capabilities.map((capability) => [capability.name, new Set(capability.methods)])
  )
  /** capability name → methods the process has actually confirmed it implements. */
  const confirmed = new Map()
  /** invoke id → `{ resolve, timer }` */
  const pending = new Map()
  let invokeCounter = 0
  let readySettler = null

  function record(fault, context = {}) {
    const entry = { ...fault, at: now(), ...context }
    faults.push(entry)
    if (faults.length > 100) faults.shift()
    log({ kind: 'process-fault', process: manifest.id, code: entry.code, reason: entry.reason, ...context })
    return entry
  }

  function rememberLog(stream, line) {
    const text = String(line).slice(0, limits.maxLogLineBytes)
    logs.push({ stream, line: text, at: now() })
    if (logs.length > limits.maxLogLines) logs.shift()
  }

  /**
   * Record what the process says it offers, and refuse anything the manifest did not declare.
   *
   * A claim outside the manifest is not silently dropped: it is recorded as a fault, because a
   * process offering a method nobody approved is exactly the thing worth knowing about.
   */
  function noteDeclaration(frame) {
    const list = Array.isArray(frame.capabilities) ? frame.capabilities : []
    for (const capability of list) {
      if (!capability || typeof capability !== 'object') continue
      const name = String(capability.name || '')
      if (!name) continue
      const methods = Array.isArray(capability.methods) ? capability.methods.map(String) : []
      if (!allowed.has(name)) {
        record(processFault(
          PROCESS_FAULT_CODES.UNDECLARED_CAPABILITY,
          `the process offers ${name}, which its manifest does not declare`,
          { declared: [...allowed.keys()] }
        ))
        continue
      }
      const permitted = allowed.get(name)
      const existing = confirmed.get(name) || new Set()
      for (const method of methods) {
        if (!permitted.has(method)) {
          record(processFault(
            PROCESS_FAULT_CODES.UNDECLARED_CAPABILITY,
            `the process offers ${name}.${method}, which its manifest does not declare`,
            { declared: [...permitted] }
          ))
          continue
        }
        existing.add(method)
      }
      confirmed.set(name, existing)
    }
  }

  function onFrame(frame) {
    if (!frame || typeof frame !== 'object') return
    const kind = frame.kind
    if (kind === PROCESS_FRAMES.HEARTBEAT) {
      lastHeartbeatAt = now()
      heartbeatCount += 1
      if (heartbeatStale) {
        heartbeatStale = false
        if (state === PROCESS_STATES.DEGRADED) state = PROCESS_STATES.RUNNING
      }
      return
    }
    if (kind === PROCESS_FRAMES.LOG) {
      rememberLog(frame.stream === 'stderr' ? 'stderr' : 'stdout', frame.line === undefined ? '' : frame.line)
      return
    }
    if (kind === PROCESS_FRAMES.PROVIDE) {
      noteDeclaration(frame)
      return
    }
    if (kind === PROCESS_FRAMES.READY) {
      noteDeclaration(frame)
      // The first beat is implied by being ready: a process that says it is up should not be
      // declared stale before its own interval has elapsed even once.
      if (lastHeartbeatAt === null) {
        lastHeartbeatAt = now()
        heartbeatCount += 1
      }
      if (readySettler) readySettler({ ok: true, frame })
      return
    }
    if (kind === PROCESS_FRAMES.RESULT) {
      const entry = pending.get(String(frame.id))
      if (!entry) return
      pending.delete(String(frame.id))
      clearTimeout(entry.timer)
      if (frame.ok === true) entry.resolve({ ok: true, result: frame.result === undefined ? null : frame.result })
      else {
        entry.resolve(processFault(PROCESS_FAULT_CODES.INVOKE_FAILED, String(frame.reason || 'the plugin reported a failure'), {
          capability: entry.capability,
          method: entry.method
        }))
      }
      return
    }
    if (kind === PROCESS_FRAMES.BYE) {
      rememberLog('protocol', `the plugin said goodbye: ${frame.reason || 'no reason given'}`)
      return
    }
    if (kind === PROCESS_FRAMES.FAULT) {
      record(processFault(frame.code || PROCESS_FAULT_CODES.MALFORMED_FRAME, String(frame.reason || 'the plugin reported a fault')))
    }
  }

  function onFault(fault) {
    record(fault)
  }

  /** Stop waiting on any in-flight invocation: the process it was addressed to is gone. */
  function failPending(reason, code) {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer)
      entry.resolve(processFault(code, reason, { capability: entry.capability, method: entry.method }))
      pending.delete(id)
    }
  }

  function onChildExit(code, signal) {
    const classification = classifyExit(code, signal)
    // A process that dies before it handshakes must not leave the start attempt waiting out the
    // whole handshake budget: the answer is already known, and the caller is blocked on it.
    if (readySettler) {
      readySettler(processFault(
        PROCESS_FAULT_CODES.EXITED,
        `the process exited with ${signal ? `signal ${signal}` : `code ${code}`} before reporting ready`
      ))
    }
    const uptimeMs = startedAt === null ? 0 : now() - startedAt
    const entry = { ...classification, at: now(), uptimeMs, intentional: intentionalStop }
    exitHistory.push(entry)
    if (exitHistory.length > limits.maxExitHistory) exitHistory.shift()

    const leaving = child
    child = null
    stoppedAt = now()
    failPending('the process exited before answering', PROCESS_FAULT_CODES.EXITED)
    if (transport) {
      transport.close()
      transport = null
    }
    void leaving

    if (intentionalStop) {
      state = PROCESS_STATES.STOPPED
      log({ kind: 'process-stopped', process: manifest.id, code: classification.code, signal: classification.signal })
      return
    }

    if (classification.kind === EXIT_KINDS.CLEAN) {
      // A clean exit with no shutdown request is a plugin that finished. It is not a crash, and it
      // is not restarted on `on-failure`.
      state = PROCESS_STATES.STOPPED
      record(processFault(PROCESS_FAULT_CODES.EXITED, 'the process exited cleanly without being asked to'), { code: classification.code })
      return
    }

    record(
      processFault(
        classification.kind === EXIT_KINDS.SIGNAL ? PROCESS_FAULT_CODES.KILLED : PROCESS_FAULT_CODES.EXIT_NONZERO,
        `the process exited with ${classification.signal ? `signal ${classification.signal}` : `code ${classification.code}`} after ${uptimeMs}ms`
      ),
      { uptimeMs }
    )
    scheduleRestart(classification)
  }

  /**
   * Decide whether this exit earns another start.
   *
   * The order is the contract: policy first (does anybody want a restart at all), then the rolling
   * budget, then the backoff. The budget is what makes `always` safe, so it is checked before the
   * restart is scheduled rather than after it happens.
   */
  function scheduleRestart(classification) {
    if (disposed || state === PROCESS_STATES.SAFE_MODE) return
    if (!policyWantsRestart(restart.policy, classification.kind)) {
      state = PROCESS_STATES.STOPPED
      log({ kind: 'process-no-restart', process: manifest.id, policy: restart.policy, exit: classification.kind })
      return
    }

    const cutoff = now() - restart.windowMs
    while (restartTimes.length && restartTimes[0] < cutoff) restartTimes.shift()
    if (restartTimes.length >= restart.maxRestarts) {
      const fault = record(
        processFault(
          PROCESS_FAULT_CODES.CRASH_LOOP,
          `${restartTimes.length} restarts inside ${restart.windowMs}ms reached the limit of ${restart.maxRestarts}; ` +
            `${restart.safeModeOnLoop ? 'entering safe mode and stopping' : 'no further restarts will be attempted'}`
        ),
        { window: restart.windowMs, limit: restart.maxRestarts, exits: exitHistory.slice(-restart.maxRestarts).map((exit) => exit.code) }
      )
      state = restart.safeModeOnLoop ? PROCESS_STATES.SAFE_MODE : PROCESS_STATES.FAILED
      void fault
      return
    }

    restartTimes.push(now())
    const delay = currentBackoffMs
    currentBackoffMs = Math.min(currentBackoffMs * 2, restart.backoffMaxMs)
    state = PROCESS_STATES.RESTARTING
    log({ kind: 'process-restart-scheduled', process: manifest.id, inMs: delay, attempt: restartTimes.length })
    // Deliberately *not* unref'd. A pending restart is a commitment the supervisor has made: the
    // plugin crashed and the policy says it gets another start. Unref'ing the timer means an
    // otherwise-idle host simply exits instead of performing it -- the restart silently does not
    // happen, and whether it happens at all depends on what else the host's event loop is doing.
    // Holding the loop for a bounded backoff is the honest trade. The same rule applies to every
    // other timer in this module: each one belongs to an operation a caller is awaiting, and
    // unref'ing one turns "the host is idle" into "the operation never completes".
    restartTimer = setTimeout(function attempt() {
      restartTimer = null
      if (disposed || state === PROCESS_STATES.SAFE_MODE) return
      // A start whose handshake has not settled yet must not be raced by a second one. In practice
      // the handshake resolves the moment the child exits, so this is a guard rather than a path --
      // but a supervisor that can run two children for one plugin is not one to leave to timing.
      if (state === PROCESS_STATES.STARTING) {
        restartTimer = setTimeout(attempt, delay)
        return
      }
      start({ reason: 'restart' })
    }, delay)
  }

  /** The argv, with a relative script made absolute against the plugin directory. */
  function commandLine() {
    return manifest.command.map((part, index) => {
      if (index === 0 && !part.startsWith('.') && !path.isAbsolute(part)) return part
      if (!part.startsWith('.')) return part
      return path.resolve(dir, part)
    })
  }

  /**
   * Start the process and wait for it to say it is ready.
   *
   * One attempt, one outcome. A start that does not reach `ready` inside the handshake budget is a
   * failed start with a coded reason, never an inline retry — retrying is the restart policy's job
   * and the policy is bounded.
   */
  async function start(options = {}) {
    if (disposed) return processFault(PROCESS_FAULT_CODES.DISPOSED, 'the supervisor was disposed')
    if (child) return { ok: true, already: true, pid: child.pid }

    const built = createTransport(manifest, { log })
    if (built.ok !== true) {
      state = PROCESS_STATES.FAILED
      return record(built)
    }
    transport = built.transport

    let envExtra = {}
    try {
      envExtra = await transport.prepare()
    } catch (error) {
      state = PROCESS_STATES.FAILED
      return record(processFault(PROCESS_FAULT_CODES.SPAWN_FAILED, `the transport could not be prepared: ${error && error.message ? error.message : error}`))
    }

    const argv = commandLine()
    state = PROCESS_STATES.STARTING
    intentionalStop = false
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd: manifest.cwd ? path.resolve(dir, manifest.cwd) : dir,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...environmentFor(manifest, { token: transport.token }), ...envExtra }
      })
    } catch (error) {
      state = PROCESS_STATES.FAILED
      transport.close()
      transport = null
      return record(processFault(PROCESS_FAULT_CODES.SPAWN_FAILED, `the process could not be started: ${error && error.message ? error.message : error}`))
    }

    startedAt = now()
    transport.attach(child)
    transport.onFrame(onFrame)
    transport.onFault(onFault)
    // The child's own stderr is a log channel on the stdio transport; on the socket transport the
    // plugin keeps its streams and logs arrive as frames instead.
    if (transport.kind === 'stdio-jsonl' && child.stderr) {
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk) => {
        stderrCarry += chunk
        let index = stderrCarry.indexOf('\n')
        while (index !== -1) {
          const line = stderrCarry.slice(0, index)
          stderrCarry = stderrCarry.slice(index + 1)
          if (line.trim()) rememberLog('stderr', line)
          index = stderrCarry.indexOf('\n')
        }
      })
    }
    child.once('error', (error) => {
      record(processFault(PROCESS_FAULT_CODES.SPAWN_FAILED, String(error && error.message ? error.message : error)))
    })
    child.once('exit', onChildExit)

    const ready = await waitForReady(heartbeat.handshakeTimeoutMs)
    if (ready.ok !== true) {
      if (child) {
        // Still alive but it never said it was ready. That is an unusable child rather than a
        // crash, so it is stopped here: leaving an un-handshaken process running would leak one
        // the host cannot talk to.
        await stop({ reason: 'handshake failed' })
        state = PROCESS_STATES.FAILED
      } else {
        // It exited before it was ready. `onChildExit` has already classified that exit and either
        // scheduled a bounded restart or tripped the breaker -- so the restart is *not* cancelled
        // here. Cancelling it was a real defect: it meant the restart policy applied only to
        // processes that had managed to start, which is exactly backwards for a crash loop.
        if (state !== PROCESS_STATES.RESTARTING && state !== PROCESS_STATES.SAFE_MODE) state = PROCESS_STATES.FAILED
      }
      return record(ready)
    }

    state = PROCESS_STATES.RUNNING
    currentBackoffMs = restart.backoffMs
    log({ kind: 'process-started', process: manifest.id, pid: child.pid, reason: options.reason || 'start', ms: ready.ms })
    return { ok: true, pid: child.pid, capabilities: declaredReport(), ms: ready.ms }
  }

  function waitForReady(timeoutMs) {
    return new Promise((resolve) => {
      const started = now()
      let settled = false
      const finish = (outcome) => {
        if (settled) return
        settled = true
        readySettler = null
        if (timer) clearTimeout(timer)
        resolve(outcome)
      }
      readySettler = (outcome) => finish({ ...outcome, ms: now() - started })
      const timer = setTimeout(() => {
        finish(processFault(PROCESS_FAULT_CODES.HANDSHAKE_TIMEOUT, `the plugin did not report ready within ${timeoutMs}ms`))
      }, timeoutMs)
    })
  }

  /**
   * Ask the process to stop, and make sure it does.
   *
   * Three stages, each bounded: ask politely and wait, then terminate, then wait again. A process
   * that ignores all three is reported as such — the host does not wait forever for a plugin.
   */
  async function stop(options = {}) {
    if (restartTimer) {
      clearTimeout(restartTimer)
      restartTimer = null
    }
    if (!child) {
      state = state === PROCESS_STATES.SAFE_MODE ? PROCESS_STATES.SAFE_MODE : PROCESS_STATES.STOPPED
      return { ok: true, already: true }
    }
    intentionalStop = true
    const target = child
    const pid = target.pid
    const budget = limits.stopTimeoutMs
    if (transport) transport.send({ kind: PROCESS_FRAMES.SHUTDOWN, reason: String(options.reason || 'host request') })

    const gone = await raceExit(target, budget)
    if (gone) {
      log({ kind: 'process-stopped', process: manifest.id, pid, stage: 'graceful' })
      return { ok: true, pid, stage: 'graceful' }
    }

    try {
      target.kill()
    } catch {
      /* already gone */
    }
    const killed = await raceExit(target, 3_000)
    if (!killed) {
      try {
        if (process.platform === 'win32') {
          require('node:child_process').spawnSync('taskkill.exe', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
        } else {
          target.kill('SIGKILL')
        }
      } catch {
        /* nothing left to kill */
      }
    }
    record(processFault(PROCESS_FAULT_CODES.STOP_TIMEOUT, `the process did not stop within ${budget}ms and was terminated`), { pid })
    state = PROCESS_STATES.STOPPED
    return { ok: true, pid, stage: 'terminated', forced: true }
  }

  function raceExit(target, timeoutMs) {
    if (target.exitCode !== null || target.signalCode !== null) return Promise.resolve(true)
    return new Promise((resolve) => {
      let settled = false
      const done = (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      }
      const timer = setTimeout(() => done(false), timeoutMs)
      target.once('exit', () => done(true))
    })
  }

  /** A deliberate restart: an intentional stop, then one start. Counted like any other restart. */
  async function restartNow(reason = 'host request') {
    await stop({ reason })
    restartTimes.push(now())
    return start({ reason })
  }

  /**
   * Invoke a capability the process declared.
   *
   * The supervisor checks the *declaration* and forwards the call; it does not know what the
   * capability means, what arguments are sensible or what the answer signifies. That is the whole
   * separation: `restart-control.request` and `model.predict` are the same thing from here.
   */
  function invoke(capability, method, args = []) {
    if (disposed) return Promise.resolve(processFault(PROCESS_FAULT_CODES.DISPOSED, 'the supervisor was disposed'))
    if (!child || state === PROCESS_STATES.STOPPED || state === PROCESS_STATES.FAILED || state === PROCESS_STATES.SAFE_MODE) {
      return Promise.resolve(processFault(PROCESS_FAULT_CODES.NOT_RUNNING, `the process is ${state}`))
    }
    const methods = allowed.get(String(capability))
    if (!methods || !methods.has(String(method))) {
      return Promise.resolve(processFault(
        PROCESS_FAULT_CODES.NO_SUCH_CAPABILITY,
        `the manifest does not declare ${capability}.${method}`,
        { declared: declaredReport() }
      ))
    }
    invokeCounter += 1
    const id = `inv-${invokeCounter}`
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        resolve(processFault(PROCESS_FAULT_CODES.INVOKE_TIMEOUT, `${capability}.${method} did not answer within ${limits.invokeTimeoutMs}ms`))
      }, limits.invokeTimeoutMs)
      pending.set(id, { resolve, timer, capability, method })
      const sent = transport ? transport.send({ kind: PROCESS_FRAMES.INVOKE, id, capability, method, args }) : processFault(PROCESS_FAULT_CODES.NOT_RUNNING, 'no transport')
      if (sent.ok !== true) {
        pending.delete(id)
        clearTimeout(timer)
        resolve(sent)
        return
      }
      invocationHistory.push({ capability, method, at: now() })
      if (invocationHistory.length > 100) invocationHistory.shift()
    })
  }

  /** The surface as a report: what the manifest allows, and whether the process confirmed it. */
  function declaredReport() {
    return [...allowed.entries()].map(([name, methods]) => ({
      name,
      methods: [...methods].sort(),
      confirmed: [...(confirmed.get(name) || new Set())].sort()
    }))
  }

  /**
   * Whether the heartbeat is still fresh, checked when it is asked rather than on a timer.
   *
   * Computed on read for the same reason the bridge computes uptime on read: a stored answer is the
   * age of the snapshot, and the question is always "how is it *now*".
   */
  function heartbeatReport() {
    if (lastHeartbeatAt === null) {
      return { fresh: false, lastAt: null, ageMs: null, count: heartbeatCount, timeoutMs: heartbeat.timeoutMs }
    }
    const ageMs = now() - lastHeartbeatAt
    return { fresh: ageMs <= heartbeat.timeoutMs, lastAt: lastHeartbeatAt, ageMs, count: heartbeatCount, timeoutMs: heartbeat.timeoutMs }
  }

  /** Note staleness once per episode, and degrade rather than fail: a missed beat is not an exit. */
  function checkHeartbeat() {
    if (state !== PROCESS_STATES.RUNNING && state !== PROCESS_STATES.DEGRADED) return heartbeatReport()
    const report = heartbeatReport()
    if (!report.fresh && !heartbeatStale) {
      heartbeatStale = true
      state = PROCESS_STATES.DEGRADED
      record(processFault(PROCESS_FAULT_CODES.HEARTBEAT_STALE, `no heartbeat for ${report.ageMs}ms, which is past the declared ${heartbeat.timeoutMs}ms`), { ageMs: report.ageMs })
    }
    return heartbeatReport()
  }

  function status() {
    const heartbeatState = checkHeartbeat()
    return {
      id: manifest.id,
      state,
      running: Boolean(child && child.exitCode === null),
      pid: child ? child.pid : null,
      transport: transport ? transport.describe() : null,
      startedAt,
      stoppedAt,
      uptimeMs: startedAt !== null && child ? now() - startedAt : 0,
      heartbeat: heartbeatState,
      capabilities: declaredReport(),
      restarts: {
        policy: restart.policy,
        attempts: restartTimes.length,
        maxRestarts: restart.maxRestarts,
        windowMs: restart.windowMs,
        backoffMs: currentBackoffMs,
        safeMode: state === PROCESS_STATES.SAFE_MODE
      },
      exits: exitHistory.slice(-5),
      lastExit: exitHistory.length ? exitHistory[exitHistory.length - 1] : null,
      faults: faults.length,
      lastFault: faults.length ? faults[faults.length - 1] : null,
      logLines: logs.length
    }
  }

  /** Dispose: stop, cancel everything scheduled, and refuse to restart anything. */
  async function dispose(reason = 'teardown') {
    disposed = true
    if (restartTimer) {
      clearTimeout(restartTimer)
      restartTimer = null
    }
    await stop({ reason })
    failPending('the supervisor was disposed', PROCESS_FAULT_CODES.DISPOSED)
    return { ok: true }
  }

  return {
    id: manifest.id,
    manifest,
    start,
    stop,
    restart: restartNow,
    invoke,
    status,
    checkHeartbeat,
    heartbeatReport,
    declared: declaredReport,
    logs: () => logs.slice(),
    exits: () => exitHistory.slice(),
    faults: () => faults.slice(),
    invocations: () => invocationHistory.slice(),
    dispose,
    /** The live child, for tests and for a host that must observe its own process table. */
    get process() {
      return child
    },
    get state() {
      return state
    },
    get pid() {
      return child ? child.pid : null
    },
    /** True once the breaker has stopped it: nothing will restart it without a human. */
    get isSafeMode() {
      return state === PROCESS_STATES.SAFE_MODE
    }
  }
}

module.exports = { createProcessSupervisor }
