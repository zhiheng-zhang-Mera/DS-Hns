'use strict'

/**
 * DS-Hns: `dshns.restart-supervisor` — the **one** restart authority.
 *
 * ## What it is, and what it refuses to be
 *
 * It is a `dshns.plugin/v1` plugin, mounted through the same adapter as everything else, and it is
 * the only thing in this product allowed to stop the application. It provides exactly one capability,
 * `restart-control`, and that capability is how the health scheduler asks for a restart:
 *
 * ```
 *   the monitor                   this plugin
 *   ── samples, scores, decides   ── validates, budgets, waits for a boundary, delegates, waits for ready
 *   ── emits REQUEST_RESTART  ──►  restart-control.requestRestart(...)
 * ```
 *
 * Neither half knows the other's internals. The health plugin never imports this file, never sees a
 * pid, and holds nothing that can stop anything; this plugin never scores a pressure, never reads a
 * temperature and has no opinion about when a restart is *warranted*. That split is asserted in the
 * suites — `restart-supervisor-authority.test.js` scans both sources — because it is the property
 * that makes a monitor's bug survivable.
 *
 * ## Two executors, one authority
 *
 * The plugin executes a restart in-process when it can (the shell hands it a stop/launch pair), and
 * the **companion** (`companion/main.cjs`) executes it out of process when the application is hung or
 * gone, because a frozen process cannot run the code that recovers it. Two executors for one authority
 * is only safe because of the lock in `companion.cjs`: whichever claims it first runs the restart,
 * and the other defers and says so. There is no third path — the legacy reboot coordinator and the
 * watchdog were folded into this one, which is why `app/reboot/*` is now *called* by this plugin
 * rather than by the shell.
 *
 * ## Failing closed, but only for itself
 *
 * Every host hook is optional. With no shell hooks the plugin still provides a working
 * `restart-control` — it answers, budgets, records and reports, and its executor is the companion.
 * With no companion either, a request is still accepted and *reported* as unexecutable rather than
 * silently dropped. What it never does is take the application down as a side effect of being
 * misconfigured: `default_enabled` is false, a request is refused unless a policy allows it, and the
 * budget is what stops a loop.
 */

const fs = require('node:fs')
const path = require('node:path')

const { PLUGIN_API_VERSION, FAULT_LEVELS, HEALTH_STATUS } = require('../../core/contracts/plugin.cjs')
const {
  SUPERVISOR_PLUGIN_ID,
  RESTART_CONTROL_CAPABILITY,
  RESTART_MODES,
  REQUESTABLE_MODES,
  SUPERVISOR_STATES,
  SUPERVISOR_HEALTH,
  RESTART_REASONS,
  REFUSAL_CODES,
  SHUTDOWN_KINDS,
  DEFAULT_RESTART_CONFIG
} = require('./policy.cjs')
const { createRestartBudget, mergeConfig } = require('./budget.cjs')
const { createHeartbeatMonitor } = require('./heartbeat.cjs')
const { createRestartLifecycle } = require('./lifecycle.cjs')
const { companionPaths, readJson, writeJson, claimRestartLock, releaseRestartLock } = require('./companion.cjs')

const API = PLUGIN_API_VERSION

/** The capabilities this plugin provides. One, and that is the point. */
const PROVIDES = Object.freeze([RESTART_CONTROL_CAPABILITY])

/** It consumes none: the restart authority must not depend on the thing that asks it to restart. */
const REQUIRED_CAPABILITIES = Object.freeze([])

/**
 * @param {object} [options]
 * @param {object} [options.config] overrides merged over the shipped defaults
 * @param {string} [options.stateDir] where the companion's files and the heartbeat live
 * @param {object} [options.host] the shell hooks, all optional
 * @param {Function} [options.host.stopApp] `({ kind, timeoutMs }) => { ok, detail }`
 * @param {Function} [options.host.launchApp] `() => { ok, pid }`
 * @param {Function} [options.host.spawnCompanion] `(spec) => { ok, pid }`
 * @param {Function} [options.host.readiness] the readiness probes `{ network, plugins, runtime }`
 * @param {Function} [options.host.pendingWork] Core continuity's answer about in-flight tasks
 * @param {Function} [options.host.beforeRestart] Core continuity's park hook
 * @param {Function} [options.host.afterRestart] Core continuity's resume hook
 * @param {Function} [options.now]
 * @param {Function} [options.log]
 */
function createRestartSupervisorPlugin(options = {}) {
  const config = mergeConfig(DEFAULT_RESTART_CONFIG, options.config)
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const log = typeof options.log === 'function' ? options.log : () => {}
  const host = options.host && typeof options.host === 'object' ? options.host : {}
  const stateDir = path.resolve(String(options.stateDir || process.env.DSHNS_SUPERVISOR_STATE_DIR || path.join(process.cwd(), 'data', 'state', 'restart-supervisor')))
  const paths = companionPaths(stateDir)

  const budget = createRestartBudget({ config, now })
  const heartbeat = createHeartbeatMonitor({ config: config.heartbeat, now })

  let context = null
  let timer = null
  let loaded = false
  /** The requests we answered, newest first, so `getRestartHistory()` is the *supervisor's* view. */
  const requests = []
  let lastRefusal = null
  let lastOutcome = null
  let cooldownUntil = null

  function note(type, detail) {
    const entry = { type, at: now(), ...detail }
    requests.push(entry)
    if (requests.length > 100) requests.shift()
    if (context && typeof context.emit === 'function') context.emit(`restart-supervisor.${type}`, entry)
    if (type === 'request-refused') lastRefusal = entry
    return entry
  }

  /** Write the heartbeat the companion reads. A failed write is reported, never fatal. */
  function writeHeartbeat(extra = {}) {
    const beat = {
      at: now(),
      pid: process.pid,
      ready: extra.ready === true,
      responsive: extra.responsive !== false,
      loop: extra.loop !== false,
      active: extra.active === true,
      nearCheckpoint: extra.nearCheckpoint === true,
      uninterruptible: extra.uninterruptible === true,
      state: extra.state || null
    }
    try {
      fs.mkdirSync(paths.dir, { recursive: true })
      fs.writeFileSync(paths.heartbeatFile, `${JSON.stringify(beat)}\n`, 'utf8')
    } catch (error) {
      note('heartbeat-write-failed', { reason: String(error && error.message ? error.message : error) })
    }
    return beat
  }

  /**
   * The executor the lifecycle drives.
   *
   * `stop` and `launch` are the shell's if it offered them, and the companion's otherwise. Neither is
   * required for `restart-control` to answer: a request on a build with no executor is *accepted and
   * refused at execution* with `RESTART_NO_EXECUTOR`, which is a far more useful answer than a
   * capability that reports itself unavailable.
   */
  const executor = {
    stop: async ({ kind, timeoutMs, reason }) => {
      if (typeof host.stopApp !== 'function') {
        return { ok: false, code: REFUSAL_CODES.NO_EXECUTOR, reason: 'this build has no way to stop the application; the out-of-process companion is the executor' }
      }
      try {
        const outcome = await host.stopApp({ kind, timeoutMs, reason })
        return outcome && typeof outcome === 'object' ? outcome : { ok: true }
      } catch (error) {
        return { ok: false, reason: String(error && error.message ? error.message : error) }
      }
    },
    launch: async () => {
      if (typeof host.launchApp !== 'function') {
        return { ok: false, code: REFUSAL_CODES.NO_EXECUTOR, reason: 'this build has no way to relaunch the application' }
      }
      try {
        const outcome = await host.launchApp()
        return outcome && typeof outcome === 'object' ? outcome : { ok: true }
      } catch (error) {
        return { ok: false, reason: String(error && error.message ? error.message : error) }
      }
    },
    waitForExit: async () => ({ ok: true, detail: 'the shell observes the exit' })
  }

  /** Core continuity, as the plugin sees it: three hooks, all optional, none implemented here. */
  const continuity = {
    beforeRestart: async (payload) => {
      if (typeof host.beforeRestart !== 'function') return { ok: true, skipped: true, detail: 'no continuity layer is wired' }
      return host.beforeRestart(payload)
    },
    afterRestart: async (payload) => {
      if (typeof host.afterRestart !== 'function') return { ok: true, skipped: true, detail: 'no continuity layer is wired' }
      return host.afterRestart(payload)
    },
    pendingWork: async () => {
      if (typeof host.pendingWork !== 'function') return { ok: false, reason: 'no continuity layer is wired to report pending work' }
      return host.pendingWork()
    }
  }

  const readiness = {
    process: async () => ({ ok: true, detail: 'the process is running this code' }),
    runtime: async () => {
      const report = heartbeat.report()
      const fresh = report.signals.responsive.state === 'fresh' && report.signals.loop.state === 'fresh'
      return fresh ? { ok: true, detail: 'the runtime and the event loop are beating' } : { ok: false, reason: report.reason || 'the runtime has not reported yet' }
    },
    ...(host.readiness && typeof host.readiness === 'object' ? host.readiness : {})
  }

  const lifecycle = createRestartLifecycle({
    budget,
    config,
    now,
    log: (message) => log(message),
    executor,
    continuity,
    readiness
  })

  /**
   * The only entry point a caller has.
   *
   * It answers with a value and never throws — a capability that throws into a caller's sampling loop
   * is a capability that takes the monitor down with it — and every answer says whether it was
   * accepted, refused, or deferred, with the code that says why.
   */
  async function requestRestart(request = {}) {
    const mode = String(request.mode || RESTART_MODES.APPLICATION)
    const wanted = {
      mode,
      reasonCode: String(request.reasonCode || RESTART_REASONS.UNKNOWN),
      reasonSummary: request.reasonSummary ? String(request.reasonSummary) : null,
      checkpointRequired: request.checkpointRequired !== false,
      requestedBy: request.requestedBy ? String(request.requestedBy) : 'unknown'
    }
    const decision = budget.evaluate(wanted, now())
    if (decision.ok !== true) {
      cooldownUntil = decision.code === REFUSAL_CODES.COOLDOWN ? now() + (decision.retryAfterMs || 0) : cooldownUntil
      note('request-refused', { code: decision.code, reason: decision.reason, request: wanted })
      return { ...decision, accepted: false, refused: true }
    }

    // One executor at a time, across both processes.
    const lock = claimRestartLock(stateDir, { owner: 'plugin', ttlMs: Math.max(60_000, lifecycle.config.gracefulTimeoutMs + lifecycle.config.readinessTimeoutMs), now })
    if (lock.ok !== true) {
      note('request-deferred', { code: lock.code, reason: lock.reason, request: wanted })
      return { ok: false, accepted: false, deferred: true, code: lock.code, reason: lock.reason }
    }

    note('request-accepted', { request: wanted, remaining: decision.remaining })
    try {
      /**
       * **The restart is executed out of process, by the companion.**
       *
       * This is the design decision the requirement is built on: if the application is hung, this
       * code is hung with it, and a process that has frozen its event loop cannot run the code that
       * would recover it. So the plugin's job at this point is to *ask* — it writes a request file
       * the companion reads on its next watch pass — and then to report what it asked for.
       *
       * What it deliberately does not do is stop the application itself. There is one executor, it
       * owns the child process, and a second path that called `app.quit()` would be a second answer
       * to "who restarts this product".
       *
       * The in-process executor hooks remain for a deployment that supplies them (a test, or a shell
       * that has deliberately taken ownership), and they are the *only* way this plugin would ever
       * stop anything.
       */
      const delegate = typeof host.delegateRestart === 'function'
        ? await host.delegateRestart({ request: wanted, stateDir, paths })
        : await delegateToCompanion({ request: wanted })
      if (delegate && delegate.ok === true) {
        const outcome = {
          ok: true,
          accepted: true,
          delegated: true,
          executor: delegate.executor || 'companion',
          request: wanted,
          detail: delegate.detail || 'the out-of-process companion will execute the restart',
          state: stateOf(),
          budget: budget.report()
        }
        lastOutcome = { ok: true, at: now(), code: null, reason: null, delegated: true, record: null, readiness: null, resumed: false }
        note('restart-delegated', { request: wanted, executor: outcome.executor })
        return outcome
      }

      const outcome = await lifecycle.run(wanted)
      lastOutcome = {
        ok: outcome.ok === true,
        at: now(),
        code: outcome.code || null,
        reason: outcome.reason || null,
        record: outcome.record || null,
        readiness: outcome.readiness || null,
        resumed: outcome.resumed === true
      }
      note(outcome.ok === true ? 'restart-completed' : 'restart-failed', { request: wanted, code: lastOutcome.code, reason: lastOutcome.reason })
      return {
        ...outcome,
        accepted: true,
        refused: false,
        /** What a caller should show: the supervisor's own state at the end of the attempt. */
        state: stateOf(),
        budget: budget.report()
      }
    } finally {
      releaseRestartLock(stateDir, { now })
    }
  }

  /** `requestGracefulRestart`: the same, with the caller saying it can wait for a boundary. */
  function requestGracefulRestart(request = {}) {
    return requestRestart({ ...request, mode: RESTART_MODES.GRACEFUL })
  }

  /**
   * `requestEmergencyRestart`: the fault path.
   *
   * It is deliberately *not* a way around the budget, the cooldown or safe mode: an emergency restart
   * that ignored the loop protection would be the loop. What it adds is that the caller is saying it
   * accepts losing in-flight work, which the lifecycle records — and the mode is refused outright when
   * safe mode is in force, because at that point only a person may restart.
   */
  function requestEmergencyRestart(request = {}) {
    if (config.crashLoop.safeModeOnLoop && budget.report().health.safeMode) {
      const refusal = {
        ok: false,
        accepted: false,
        refused: true,
        code: REFUSAL_CODES.SAFE_MODE,
        reason: 'safe mode is in force; an emergency restart has to be requested by a person'
      }
      note('request-refused', { code: refusal.code, reason: refusal.reason, request: { mode: RESTART_MODES.EMERGENCY } })
      return Promise.resolve(refusal)
    }
    return requestRestart({ ...request, mode: RESTART_MODES.EMERGENCY })
  }

  function getRestartState() {
    const at = now()
    const report = budget.report(at)
    return {
      state: stateOf(),
      health: report.health,
      budget: report,
      heartbeat: heartbeat.report(at),
      pending: budget.report(at).pending,
      pendingLifecycle: lifecycle.pending(),
      cooldownUntil,
      lastError: lastOutcome && lastOutcome.ok === false ? lastOutcome : null,
      lastOutcome,
      lastRefusal,
      support: {
        /** Whether the out-of-process companion is running, which is what recovers a frozen app. */
        companion: companionStatus(),
        executor: typeof host.stopApp === 'function' ? 'in-process' : 'companion-only'
      },
      config: {
        budget: config.budget,
        crashLoop: config.crashLoop,
        heartbeat: config.heartbeat,
        lifecycle: config.lifecycle,
        readiness: config.readiness,
        maintenance: config.maintenance
      }
    }
  }

  /** Is a companion process alive for this state directory? A file plus a liveness probe. */
  function companionStatus() {
    const record = readJson(paths.pidFile)
    if (!record || !Number.isFinite(Number(record.pid))) return { running: false, pid: null, reason: 'no companion pid file' }
    try {
      process.kill(Number(record.pid), 0)
      /**
       * On its way out is not running.
       *
       * A companion that has been asked to stand down still has a pid for another beat or two. Reporting
       * that as "the supervisor is up" is how the next start would skip spawning one and leave the
       * product unsupervised — the precise failure a supervisor exists to prevent.
       */
      if (fs.existsSync(paths.stopFile)) {
        return { running: false, pid: Number(record.pid), stopping: true, reason: `pid ${record.pid} was asked to stand down and is leaving` }
      }
      return { running: true, pid: Number(record.pid), since: record.at || null, file: paths.pidFile }
    } catch {
      return { running: false, pid: Number(record.pid), stale: true, reason: `pid ${record.pid} is gone; the pid file is stale` }
    }
  }

  /**
   * The default delegation: write the request where the companion reads it.
   *
   * It is the plugin's own implementation rather than a required host hook, so a `restart-control`
   * that has a companion (or will have one after the next start) can execute a restart without the
   * shell wiring anything. The file is the message, exactly as the heartbeat is: neither side can
   * call into the other when the thing in between is hung, so they agree on a directory.
   */
  async function delegateToCompanion({ request }) {
    const file = paths.requestFile
    try {
      fs.mkdirSync(paths.dir, { recursive: true })
      fs.writeFileSync(file, `${JSON.stringify({ ...request, at: now(), requestedBy: request.requestedBy || 'restart-control' }, null, 2)}\n`, 'utf8')
    } catch (error) {
      return { ok: false, code: REFUSAL_CODES.NO_EXECUTOR, reason: `the restart request could not be written for the companion: ${error && error.message ? error.message : error}`, file }
    }
    const status = companionStatus()
    return {
      ok: true,
      executor: status.running ? 'companion' : 'companion-on-next-start',
      detail: status.running
        ? `pid ${status.pid} will execute the restart on its next watch pass`
        : 'no companion is running; the request is recorded and the next companion start will execute it',
      file,
      companion: status
    }
  }

  /**
   * The default way to start the companion: spawn its program detached.
   *
   * The shell may override this (`host.spawnCompanion`) when it wants to own the process — the desktop
   * shell does, because it is the thing that knows the application's own argv. When it does not, this
   * is enough: the companion is a plain Node program next to this file, it is started detached so it
   * outlives the application (which is the whole point), and it is given the state directory and the
   * application command from the environment the plugin already has.
   */
  function defaultSpawnCompanion(spec = {}) {
    const { spawn } = require('node:child_process')
    const entry = path.join(__dirname, 'companion', 'main.cjs')
    /**
     * Two facts the companion cannot work out for itself.
     *
     * **What to relaunch.** `DSH_SUPERVISED_COMMAND` is the shell's own account of how this application
     * was started; when the shell did not say, the command that is running this code is the honest
     * answer — the same executable with the same arguments, from the same directory.
     *
     * **Who is already running.** The companion is started *by* the application, so the application is
     * already up and the companion must adopt it (`--attach`) rather than start a second copy. A
     * companion that launched its own child here would be a second DS-Hns, and two of those sharing one
     * data directory is a defect, not supervision.
     */
    let appCommand = null
    try {
      appCommand = process.env.DSH_SUPERVISED_COMMAND ? JSON.parse(process.env.DSH_SUPERVISED_COMMAND) : null
    } catch {
      appCommand = null
    }
    if (!Array.isArray(appCommand) || !appCommand.length) appCommand = [process.execPath, ...process.argv.slice(1)]
    const args = [entry, `--state-dir=${spec.stateDir || stateDir}`, `--attach=${process.pid}`]
    if (appCommand.length) args.push('--app', ...appCommand.map(String))
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, DSHNS_SUPERVISOR_STATE_DIR: spec.stateDir || stateDir }
    })
    child.unref()
    return { ok: true, pid: child.pid, entry, attached: process.pid }
  }

  /**
   * Ask the companion to stand down, because this application is leaving on purpose.
   *
   * The companion cannot tell a normal quit from a crash by watching the process table — both are "the
   * pid went away" — so the difference has to be written down *before* the process leaves, which is
   * what this is. Without it, closing DS-Hns would look exactly like a crash and the supervisor would
   * dutifully bring it back.
   */
  function stopCompanion(reason = 'the application is exiting normally') {
    try {
      fs.mkdirSync(paths.dir, { recursive: true })
      fs.writeFileSync(paths.stopFile, `${JSON.stringify({ at: now(), by: 'shell', reason })}\n`, 'utf8')
      return { ok: true, file: paths.stopFile }
    } catch (error) {
      return { ok: false, reason: String(error && error.message ? error.message : error) }
    }
  }

  /**
   * Start the companion when the shell has told us how, and never twice.
   *
   * **Not on load by default.** Loading a plugin is not a reason to start a process: a plugin mounted
   * by a test, by a panel's diagnostics read or by a suite that builds the shipped set must not fork a
   * supervisor per mount, and the delegation path does not need one running — a request written to
   * `restart.request.json` is executed by the next companion that starts. The shell starts it when the
   * product boots, by setting `companion.startOnLoad` or by calling this with `{ force: true }`.
   */
  function ensureCompanion(options = {}) {
    if (config.companion.enabled !== true) return { ok: false, skipped: true, reason: 'the companion is disabled by configuration' }
    if (options.force !== true && config.companion.startOnLoad !== true) {
      return { ok: false, skipped: true, reason: 'the companion is not started on load; it starts when the product boots' }
    }
    const status = companionStatus()
    if (status.running) return { ok: true, already: true, pid: status.pid }
    const spawnCompanion = typeof host.spawnCompanion === 'function' ? host.spawnCompanion : defaultSpawnCompanion
    try {
      /**
       * A stand-down from the previous run is cleared before this one starts.
       *
       * `companion.stop` is how a normal exit is recorded, and it is deliberately not removed by the
       * companion that honours it — so without this line the first *intentional* quit would silence the
       * supervisor for every run after it. Starting a companion is exactly the statement that this run
       * has not been asked to stand down.
       */
      fs.rmSync(paths.stopFile, { force: true })
      const outcome = spawnCompanion({ stateDir, heartbeatFile: paths.heartbeatFile, configFile: paths.configFile })
      if (outcome && outcome.ok === false) {
        note('companion-spawn-failed', { reason: outcome.reason })
        return { ok: false, reason: outcome.reason || 'the companion could not be started' }
      }
      note('companion-started', { pid: outcome && outcome.pid ? outcome.pid : null })
      return { ok: true, started: true, pid: outcome && outcome.pid ? outcome.pid : null }
    } catch (error) {
      const reason = String(error && error.message ? error.message : error)
      note('companion-spawn-failed', { reason })
      return { ok: false, reason }
    }
  }

  function stateOf() {
    if (!loaded) return SUPERVISOR_STATES.DISABLED
    const health = budget.health(now())
    if (health.safeMode) return SUPERVISOR_STATES.SAFE_MODE
    const pending = lifecycle.pending()
    if (pending) return SUPERVISOR_STATES.REQUESTED
    if (health.degraded) return SUPERVISOR_STATES.DEGRADED
    return SUPERVISOR_STATES.MONITORING
  }

  /** The capability surface, as provided to the registry. */
  const surface = {
    requestRestart,
    requestGracefulRestart,
    requestEmergencyRestart,
    getRestartState,
    getRestartHistory: () => ({
      /** The supervisor's own audit trail: every attempt, including the ones that did not execute. */
      attempts: budget.history(),
      requests: requests.slice(-50),
      journal: readJournal(paths.journalFile),
      config: { maxEntries: config.history.maxEntries }
    }),
    getRestartBudget: () => budget.report(),
    cancelPendingRestart: (reason) => {
      const cancelled = lifecycle.cancel(reason)
      note('cancel', { ok: cancelled.ok === true, phase: cancelled.phase || null, reason: cancelled.reason || null })
      return cancelled
    },
    /** The two operations safe mode leaves a person: restart by hand, and reset the budget. */
    resetRestartBudget: (by = 'official-ui') => {
      const reset = budget.reset(now(), by)
      cooldownUntil = null
      note('budget-reset', { by, cleared: reset.cleared })
      return reset
    },
    /** Manual restart: it is an `application` request *from a person*, so it outranks no policy. */
    manualRestart: (request = {}) => requestRestart({ ...request, reasonCode: RESTART_REASONS.MANUAL, requestedBy: 'official-ui' })
  }

  function readJournal(file) {
    try {
      const text = fs.readFileSync(file, 'utf8')
      return text.trim().split('\n').filter(Boolean).slice(-40).map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return { unparsed: true }
        }
      })
    } catch {
      return []
    }
  }

  return {
    manifest: {
      api_version: API,
      id: SUPERVISOR_PLUGIN_ID,
      name: 'Restart Supervisor',
      version: '1.0.0',
      description: 'the only restart authority: validates and prices a restart request, waits for a safe boundary, stops the application, relaunches it and waits for readiness — in process, or out of process through its companion when the application is hung',
      provides: [...PROVIDES],
      /**
       * Nothing is required.
       *
       * The restart authority is the *provider* of `restart-control`, so requiring anything would
       * make the thing that keeps the product alive depend on the thing it is there to recover — and
       * the requirement is explicit that the supervisor and the monitor must not be able to take
       * each other down. Both consume nothing and provide their own half.
       */
      requires_capabilities: [],
      optional_capabilities: [],
      conflicts: [],
      /**
       * The authority is *not* opt-in in the way the monitor is.
       *
       * The monitor samples the machine, which is a decision a user makes. The restart authority is
       * what makes a restart *possible at all* — without it a request is reported unavailable — so it
       * ships enabled, and the budget is what keeps that from being dangerous.
       */
      default_enabled: true,
      hot_reload: false,
      model_specific: false,
      fault_level: FAULT_LEVELS.SOFT,
      entry: 'app/plugins/restart-supervisor/index.cjs',
      config: {
        budget: config.budget,
        crashLoop: config.crashLoop,
        heartbeat: config.heartbeat,
        lifecycle: config.lifecycle,
        readiness: config.readiness,
        maintenance: config.maintenance,
        companion: config.companion
      }
    },

    install() {
      return { ok: true }
    },

    load(loadContext) {
      context = loadContext
      loaded = true
      const provided = []
      for (const capability of PROVIDES) {
        const result = context && typeof context.provide === 'function'
          ? context.provide(capability, surface, { detail: { from: SUPERVISOR_PLUGIN_ID } })
          : { ok: false, reason: 'the context cannot provide capabilities' }
        provided.push({ capability, ok: result && result.ok !== false, reason: result && result.reason ? result.reason : null })
      }

      // The companion is started behind the boot, and a failure to start it is a *degradation the
      // status reports* rather than a reason to refuse the capability: an in-process executor that
      // works is better than no authority at all.
      const companion = ensureCompanion()
      writeHeartbeat({ ready: false, state: stateOf() })
      const interval = Math.max(1_000, Math.floor(config.heartbeat.intervalMs / 2))
      timer = setInterval(() => {
        // The plugin's own beat: it is the code that would be frozen if the loop froze, and it says
        // so by *not* writing. The companion reads the file, not our intentions.
        heartbeat.beatAlive(process.pid)
        heartbeat.beatResponsive(null)
        heartbeat.beatLoop(null)
        writeHeartbeat({ ready: true, state: stateOf() })
      }, interval)
      if (timer && typeof timer.unref === 'function') timer.unref()

      note('loaded', { intervalMs: interval, companion: companion.ok === true, state: stateOf() })
      return { ok: true, provides: provided, companion, config: { heartbeat: config.heartbeat, budget: config.budget } }
    },

    unload() {
      if (timer) clearInterval(timer)
      timer = null
      loaded = false
      context = null
      heartbeat.reset()
      return { ok: true }
    },

    /**
     * The supervisor's own health.
     *
     * `degraded` for safe mode and for a missing companion, because both mean "a restart would not be
     * recoverable by this process alone" — which is exactly what a health surface is for. `unknown`
     * when it is not loaded, because a disabled supervisor is not a healthy one.
     */
    healthCheck() {
      if (!loaded) return { status: HEALTH_STATUS.UNKNOWN, reason: 'the restart supervisor is not loaded' }
      const health = budget.health(now())
      const companion = companionStatus()
      const detail = {
        state: stateOf(),
        health: health.tier,
        budget: budget.report(),
        companion,
        heartbeat: heartbeat.report().verdict
      }
      if (health.safeMode) {
        return { status: HEALTH_STATUS.DEGRADED, reason: health.reason, detail }
      }
      if (!companion.running) {
        return {
          status: HEALTH_STATUS.DEGRADED,
          reason: `no out-of-process companion is running (${companion.reason || 'unknown'}), so a hung application could not be recovered by it`,
          detail
        }
      }
      return { status: HEALTH_STATUS.HEALTHY, reason: `state ${detail.state}; ${health.tier}`, detail }
    },

    diagnostics() {
      return {
        ...getRestartState(),
        companion: companionStatus(),
        paths,
        heartbeatSignals: heartbeat.signals(),
        requests: requests.slice(-20),
        journal: readJournal(paths.journalFile).slice(-20)
      }
    },

    /** Everything a caller needs without going through the capability registry, for tests and the shell. */
    requestRestart,
    requestGracefulRestart,
    requestEmergencyRestart,
    getRestartState,
    getRestartHistory: surface.getRestartHistory,
    getRestartBudget: surface.getRestartBudget,
    cancelPendingRestart: surface.cancelPendingRestart,
    resetRestartBudget: surface.resetRestartBudget,
    manualRestart: surface.manualRestart,
    surface,
    budget,
    heartbeat,
    lifecycle,
    ensureCompanion,
    writeHeartbeat,
    delegateToCompanion,
    companionStatus,
    stopCompanion,
    /** For a test: one heartbeat tick, rather than a timer. */
    beat: (extra) => {
      heartbeat.beatAlive(process.pid)
      heartbeat.beatResponsive(null)
      heartbeat.beatLoop(null)
      return writeHeartbeat({ ready: true, ...extra })
    },
    paths,
    get loaded() { return loaded }
  }
}

/** The plugin object the platform loads. */
function restartSupervisorPlugin() {
  return createRestartSupervisorPlugin()
}

module.exports = {
  restartSupervisorPlugin,
  createRestartSupervisorPlugin,
  PROVIDES,
  REQUIRED_CAPABILITIES,
  SUPERVISOR_PLUGIN_ID,
  RESTART_CONTROL_CAPABILITY,
  RESTART_MODES,
  REQUESTABLE_MODES,
  SUPERVISOR_STATES,
  SUPERVISOR_HEALTH,
  REFUSAL_CODES,
  RESTART_REASONS,
  SHUTDOWN_KINDS,
  DEFAULT_RESTART_CONFIG
}
