'use strict'

/**
 * DS-Hns Computer Use Runtime.
 *
 * One runtime, assembled from independently faulted controllers, that takes an
 * execution contract and drives it to a verified finish:
 *
 *   Goal → Observe → Act → Verify → Recover if needed → Continue → Finish
 *
 * It is deliberately *not* a planner and *not* a learner. Long-term planning,
 * user profiles and application models belong to the calling orchestration layer
 * or another upper layer; this runtime adapts to the current state of the machine
 * and discards what it observed when the task ends.
 *
 * The host injects ports — a browser page, a desktop driver, an accessibility
 * driver, a screenshot driver — and everything else is assembled here. A port
 * that is missing simply degrades its own controller.
 */

const path = require('node:path')
const fs = require('node:fs')

const { ACTION_TYPES, ACTION_CAPABILITY, CAPABILITIES, CU_STATES, RUN_STATUS, resolveComputerUseOptions } = require('./constants.cjs')
const { createContract, describeContract } = require('./contract.cjs')
const { createObserver } = require('./observer.cjs')
const { createExecutor } = require('./executor.cjs')
const { createExecutionLog } = require('./log.cjs')
const { createAutonomy } = require('./autonomy.cjs')
const { isolateController, unavailableController } = require('./isolation.cjs')
const { createBrowserController } = require('./controllers/browser.cjs')
const { createDesktopController } = require('./controllers/desktop.cjs')
const { createVisionController } = require('./controllers/vision.cjs')
const { createShellController } = require('./controllers/shell.cjs')
const { createFileController } = require('./controllers/file.cjs')
const { createClock } = require('./ports.cjs')
const { CODES, ComputerUseError } = require('./errors.cjs')
// Long-running execution: the runtime owns its processes,
// bounds its resources, keeps a workspace boundary and reports its own health.
const { createProcessRegistry } = require('./processes.cjs')
const { createResourceBudget } = require('./resources.cjs')
const { createWorkspaceGuard } = require('./workspace.cjs')
const { buildHealthSnapshot, HEALTH_STATUS, capabilityVerdict } = require('./health.cjs')

const VERSION = '1.0.0'

/**
 * @param {object} [options]
 * @param {object} [options.host]
 * @param {object} [options.host.page] browser page adapter (CDP in production)
 * @param {object} [options.host.desktop] desktop driver port
 * @param {object} [options.host.accessibility] accessibility driver port
 * @param {object} [options.host.screenshot] screenshot driver port
 * @param {object} [options.host.planner] async ({world, contract, history}) => action
 * @param {function} [options.host.confirm] destructive-action confirmation
 * @param {object} [options.options] runtime options (see constants.resolveComputerUseOptions)
 * @param {object} [options.log] logging overrides ({dir, mode, retention})
 * @param {object} [options.clock] injectable clock (tests)
 */
function createComputerUseRuntime(options = {}) {
  const host = options.host || {}
  const clock = options.clock || createClock(host.clock)
  const runtimeOptions = resolveComputerUseOptions(options.options || {})
  const log = options.log === null
    ? null
    : createExecutionLog({ now: clock.now, dir: options.log ? options.log.dir : undefined, mode: options.log ? options.log.mode : 'normal', retention: runtimeOptions.screenshotRetention, runId: options.runId })
  const faults = []

  // The runtime's long-running infrastructure. Each piece is
  // created once and shared with the executor and the shell controller, so there
  // is exactly one registry, one resource budget and one workspace verdict.
  // The mutable objects stay in this scope and never leave it: `processes()` and
  // `resources()` below are the read-only snapshots the upper layer gets, so a
  // report can never be used to settle, kill or re-policy the runtime.
  const processRegistry = options.processes || createProcessRegistry({ now: clock.now, maxOwned: runtimeOptions.maxOwnedProcesses })
  const resourceBudget = options.resources || createResourceBudget({ now: clock.now, maxScreenshots: runtimeOptions.maxScreenshots })
  /**
   * The workspace boundary.
   *
   * A contract may name one; a host may name one. When neither does, the runtime
   * still refuses to inherit `process.cwd()` — it uses a directory it owns inside
   * the DS-Hns data root instead (`<ROOT>/workspace/computer-use`). That keeps
   * "every shell action carries a verified cwd" true for a shell-only host while
   * never pointing a command at an arbitrary directory.
   */
  const declaredWorkspace = host.workspace || options.defaultWorkspace || runtimeOptions.workspace || defaultRuntimeWorkspace()
  const workspace = options.workspaceGuard || createWorkspaceGuard({
    now: clock.now,
    workspace: declaredWorkspace,
    // Both escape hatches are explicit opt-ins; neither is inferred from a
    // missing workspace argument.
    allowOutside: host.allowOutsideWorkspace === true || runtimeOptions.allowOutsideWorkspace === true,
    unscopedFilesystem: runtimeOptions.unscopedFilesystem === true
  })

  function guard(name, factory) {
    try {
      return factory()
    } catch (error) {
      const message = error && error.message ? error.message : String(error)
      faults.push({ at: clock.now(), controller: name, error: message })
      return unavailableController(name, null, `${name} failed to initialise: ${message}`)
    }
  }

  /**
   * The same fault discipline as `guard()`, for the read-only readers.
   *
   * "Can this executor keep working right now?" is exactly the question that must
   * never be answered with a thrown exception: a probe that fails degrades the
   * reader to a reported reason, records a fault, and lets the caller decide.
   */
  function readThrough(name, factory, fallback) {
    try {
      return factory()
    } catch (error) {
      const message = error && error.message ? error.message : String(error)
      faults.push({ at: clock.now(), controller: name, error: message })
      return fallback(message)
    }
  }

  function initialPage() {
    if (host.page) return host.page
    if (typeof host.getPage === 'function') {
      try {
        return host.getPage() || null
      } catch {
        return null
      }
    }
    return null
  }

  const controllers = {
    browser: isolateController('browser', 'browser', () => createBrowserController({ page: initialPage(), clock, config: runtimeOptions })),
    desktop: isolateController('desktop', 'desktop', () => createDesktopController({ driver: host.desktop || null, accessibility: host.accessibility || null, clock, config: runtimeOptions })),
    vision: isolateController('vision', 'vision', () => createVisionController({ driver: host.screenshot || null, clock, config: host.visionConfig || {} })),
    shell: isolateController('shell', 'shell', () => createShellController({
      clock,
      // Every command runs inside the verified workspace. The guard below is the
      // authority; this is the same directory it resolves, passed so the
      // controller's own default can never disagree with the runtime's boundary.
      cwd: host.cwd ? path.resolve(String(host.cwd)) : declaredWorkspace,
      env: host.env,
      shellEnabled: host.shellEnabled,
      // The registry is what makes "kill only what we own" enforceable, and the
      // workspace guard is what stops a command from running in an unverified
      // directory. The registry is handed over under the key the controller reads
      // (`processes`), never under its local name here.
      processes: processRegistry,
      workspace: () => workspace
    })),
    file: guard('file', () => createFileController({
      clock,
      // The *same* guard the shell controller and the health snapshot use: a
      // filesystem action must not be able to resolve a path through a second,
      // weaker opinion about where the workspace is.
      workspace: workspace,
      allowOutsideWorkspace: host.allowOutsideWorkspace === true
    }))
  }

  /**
   * Re-attaches the browser page before each run: the shell's visible surface
   * changes (Daily view vs Work view), and the runtime must observe the page the
   * user is actually looking at rather than a stale view.
   */
  function syncPage() {
    if (typeof host.getPage !== 'function') return
    try {
      const page = host.getPage()
      if (page) controllers.browser.setPage(page)
    } catch {
      /* a page that cannot be attached degrades the browser controller only */
    }
  }

  const observer = createObserver({ clock, browser: controllers.browser, desktop: controllers.desktop, file: controllers.file })
  const autonomy = createAutonomy({ enabled: runtimeOptions.autonomyEnabled, limits: host.autonomyLimits })
  const executor = createExecutor({
    clock,
    log,
    observer,
    controllers,
    planner: host.planner,
    confirm: host.confirm,
    // Extra facts for success criteria, supplied by the host (a virtual
    // filesystem in acceptance, an application API in production).
    hostFacts: host.facts || null,
    options: runtimeOptions,
    // The shared long-running infrastructure, so the executor supervises the very
    // processes the shell controller starts, reports the same resource state, and
    // resolves paths against the same workspace boundary the health snapshot
    // reports. Passing the guard explicitly is what keeps those four views from
    // drifting apart: health workspace = shell workspace = executor workspace.
    processes: processRegistry,
    resources: resourceBudget,
    workspaceGuard: workspace
  })

  let activeRun = null

  /**
   * The runtime's own health.
   *
   * The snapshot answers one question — can this executor keep working right
   * now? — and answers `blocked` (rather than `degraded`) when continuing would
   * mean acting on a state the runtime cannot vouch for: no workspace, no usable
   * capability, no safety channel, a resource ceiling, or an uncertain state.
   *
   * A single failed controller is *not* a block: it degrades and the rest
   * continues.
   */
  function health() {
    // A reader must never throw at its caller: if even the snapshot
    // cannot be built, the answer is a reported degraded state, not an exception.
    return readThrough('health', () => {
      // The page is attached before probing, otherwise a health report taken
      // before the first run would claim the browser controller is unavailable.
      syncPage()
      const contract = executor.currentRun ? executor.currentRun.contract : null
      const snapshot = buildHealthSnapshot({
        now: clock.now(),
        // The live probe, keyed by controller id. `health.cjs` owns the one
        // capability-to-controller mapping (`filesystem` is carried by `file`),
        // so the snapshot must speak controller ids: feeding it an array-keyed
        // view made every run with allowed capabilities look blocked.
        controllers: probeControllersNow(),
        allowedCapabilities: contract ? contract.capabilities : null,
        workspace: workspace.status(),
        resources: resourceBudget.snapshot(),
        processes: processRegistry.snapshot(),
        progress: executor.currentRun ? executor.currentRun.progress.status() : null,
        stallLevel: executor.currentRun ? executor.currentRun.stallRecoveries : 0,
        step: executor.currentRun ? { id: executor.currentRun.currentStepId || null, index: executor.currentRun.steps } : null,
        safetyAvailable: Boolean(host.confirm) || !contract || contract.safety.destructiveActions !== 'confirm'
      })
      return {
        version: VERSION,
        state: executor.currentRun ? executor.currentRun.stateMachine.state : CU_STATES.IDLE,
        running: executor.running,
        // The documented top-level shape alongside the detail.
        status: healthStatus(snapshot.status),
        capabilities: snapshot.capabilities,
        lastProgressAt: snapshot.lastProgressAt,
        activeOwnedProcesses: snapshot.activeOwnedProcesses,
        currentStep: snapshot.currentStep,
        controllers: executor.health(),
        faults: faults.slice(),
        blockReasons: Array.isArray(snapshot.blockedReasons) ? snapshot.blockedReasons.slice() : [],
        workspace: snapshot.workspace,
        resourcePressure: snapshot.resourcePressure,
        stallLevel: snapshot.stallLevel,
        degradedCapabilities: Array.isArray(snapshot.degradedCapabilities) ? snapshot.degradedCapabilities.slice() : [],
        sinceProgressMs: snapshot.sinceProgressMs,
        autonomy: { enabled: autonomy.enabled, limits: autonomy.limits, decisions: autonomy.decisions().slice(-5) }
      }
    }, degradedHealthSnapshot)
  }

  /** Only the three documented values may ever be reported. */
  function healthStatus(value) {
    return value === HEALTH_STATUS.BLOCKED || value === HEALTH_STATUS.DEGRADED || value === HEALTH_STATUS.HEALTHY
      ? value
      : HEALTH_STATUS.DEGRADED
  }

  /**
   * The answer when the health reader itself failed: degraded, with the reason,
   * and never a fabricated `healthy`.
   */
  function degradedHealthSnapshot(message) {
    return {
      version: VERSION,
      state: CU_STATES.IDLE,
      running: false,
      status: HEALTH_STATUS.DEGRADED,
      capabilities: {},
      lastProgressAt: null,
      activeOwnedProcesses: 0,
      currentStep: null,
      controllers: [],
      faults: faults.slice(),
      blockReasons: [],
      workspace: null,
      resourcePressure: null,
      stallLevel: 0,
      degradedCapabilities: [],
      sinceProgressMs: null,
      reason: message,
      autonomy: { enabled: autonomy.enabled, limits: autonomy.limits, decisions: [] }
    }
  }

  /**
   * Can this runtime carry an action that needs `capability` right now?
   *
   * A missing capability is reported as `CAPABILITY_UNAVAILABLE` for *that
   * action* instead of a runtime failure.
   */
  function canExecute(actionType) {
    return readThrough('canExecute', () => {
      const capability = capabilityOfAction(actionType)
      const snapshot = buildHealthSnapshot({
        now: clock.now(),
        controllers: probeControllersNow(),
        allowedCapabilities: executor.currentRun ? executor.currentRun.contract.capabilities : null
      })
      return capabilityVerdict(snapshot, capability)
    }, (message) => ({ ok: false, reason: `the capability verdict could not be taken: ${message}` }))
  }

  /**
   * Per-capability availability, with the reason a capability is unavailable.
   *
   * It reuses the frozen `ACTION_CAPABILITY` map and the very `capabilityVerdict`
   * the runtime consults before acting, so a capability report and an actual
   * `canExecute()` can never disagree. Read-only: the caller gets a snapshot,
   * never a controller.
   */
  function capabilities() {
    return readThrough('capabilities', () => {
      const snapshot = buildHealthSnapshot({
        now: clock.now(),
        controllers: probeControllersNow(),
        allowedCapabilities: executor.currentRun ? executor.currentRun.contract.capabilities : null
      })
      const reported = {}
      // The contract's capabilities, each answered through the same verdict the
      // runtime consults before acting — never a second opinion that could drift.
      for (const capability of CAPABILITIES) {
        const verdict = capabilityVerdict(snapshot, capability)
        const controllers = Array.isArray(verdict.controllers) ? verdict.controllers.slice() : []
        const carrying = controllers.map((id) => snapshot.capabilities[id]).filter(Boolean)
        const degraded = verdict.ok && carrying.length > 0 && carrying.every((entry) => entry.degraded)
        const reason = carrying.find((entry) => entry.reason)
        reported[capability] = {
          // `unavailable` is deliberately not a HEALTH_STATUS value: it is an
          // availability, not the runtime's status.
          status: verdict.ok ? (degraded ? HEALTH_STATUS.DEGRADED : HEALTH_STATUS.HEALTHY) : 'unavailable',
          available: verdict.ok,
          degraded,
          controllers,
          reason: verdict.ok ? (reason ? reason.reason : null) : verdict.reason
        }
      }
      const actions = {}
      for (const [actionType, capability] of Object.entries(ACTION_CAPABILITY)) {
        const verdict = capabilityVerdict(snapshot, capability)
        actions[actionType] = { capability, ok: verdict.ok, reason: verdict.reason, controllers: Array.isArray(verdict.controllers) ? verdict.controllers.slice() : [] }
      }
      return {
        at: clock.now(),
        status: healthStatus(snapshot.status),
        capabilities: reported,
        available: snapshot.usableCapabilities.slice(),
        degraded: snapshot.degradedCapabilities.slice(),
        unavailable: snapshot.unavailableCapabilities.slice(),
        actions
      }
    }, (message) => ({
      at: clock.now(),
      status: HEALTH_STATUS.DEGRADED,
      capabilities: {},
      available: [],
      degraded: [],
      unavailable: [],
      actions: {},
      reason: message
    }))
  }

  /**
   * What this runtime owns right now.
   *
   * A snapshot, never the registry: a report cannot settle, kill or detach a
   * process, so reading the runtime's health can never change it.
   */
  function processes() {
    return readThrough('processes', () => {
      const snapshot = processRegistry.snapshot()
      return {
        at: clock.now(),
        owned: snapshot.owned.slice(),
        ownedCount: snapshot.ownedCount,
        ceiling: snapshot.ceiling,
        atCapacity: snapshot.atCapacity,
        hungSuspected: snapshot.hungSuspected.slice(),
        finished: snapshot.finished.slice()
      }
    }, (message) => ({
      at: clock.now(),
      owned: [],
      ownedCount: 0,
      ceiling: null,
      atCapacity: false,
      hungSuspected: [],
      finished: [],
      reason: message
    }))
  }

  /**
   * The resource budget as a snapshot.
   *
   * The budget object itself is never handed out, so a reader can neither raise
   * a ceiling nor force an eviction. `level` distinguishes "holding captures"
   * from the pressure the health snapshot blocks on: the budget reports
   * `atCeiling` once it has had to evict captures and the retained evidence is at
   * its own bound.
   */
  function resources() {
    return readThrough('resources', () => {
      const snapshot = resourceBudget.snapshot()
      const ceiling = snapshot.limits.maxScreenshots
      const atCeiling = snapshot.atCeiling === true
      const elevated = snapshot.droppedScreenshots > 0 && (
        snapshot.screenshots >= ceiling || snapshot.evidenceBytes >= snapshot.limits.maxEvidenceBytes * 0.9
      )
      return {
        at: clock.now(),
        limits: { ...snapshot.limits },
        screenshots: snapshot.screenshots,
        retainedScreenshots: snapshot.retainedScreenshots,
        droppedScreenshots: snapshot.droppedScreenshots,
        evidenceBytes: snapshot.evidenceBytes,
        atCeiling,
        pressure: snapshot.pressure.slice(),
        level: atCeiling ? 'ceiling' : (elevated ? 'elevated' : 'normal')
      }
    }, (message) => ({
      at: clock.now(),
      limits: null,
      screenshots: 0,
      retainedScreenshots: 0,
      droppedScreenshots: 0,
      evidenceBytes: 0,
      atCeiling: false,
      pressure: [],
      level: 'unknown',
      reason: message
    }))
  }

  /**
   * `processes()` and `resources()` are read-only handles: a caller that already
   * used `processes.ownedCount`,
   * `processes.snapshot()` or `resources.snapshot()` keeps working, while the
   * mutating half of each component (`register`, `settle`, `kill`, `dispose`,
   * `release`, `enforce`) is unreachable from the runtime object.
   */
  Object.defineProperties(processes, {
    ownedCount: { get: () => processRegistry.ownedCount },
    ceiling: { get: () => processRegistry.ceiling },
    atCapacity: { get: () => processRegistry.atCapacity() },
    snapshot: { value: () => processRegistry.snapshot() },
    finished: { value: () => processRegistry.finished() }
  })
  Object.defineProperties(resources, {
    limits: { get: () => ({ ...resourceBudget.limits }) },
    screenshotCount: { get: () => resourceBudget.screenshotCount },
    dropped: { get: () => resourceBudget.dropped },
    snapshot: { value: () => resourceBudget.snapshot() }
  })

  /**
   * The active run's progress heartbeat.
   *
   * With no run in flight the honest answer is "nothing is running" rather than
   * the best case: `active: false` and null timings. Only meaningful progress
   * (a verified effect, a finished owned process, a confirmed mutation) moves
   * `lastProgressAt`, so `sinceProgressMs` is how long the executor has been
   * busy without moving the world forward.
   */
  function progress() {
    return readThrough('progress', () => {
      const run_ = executor.currentRun
      if (!run_ || !run_.progress || typeof run_.progress.status !== 'function') {
        return {
          at: clock.now(),
          active: false,
          running: executor.running,
          state: null,
          goal: null,
          step: null,
          steps: 0,
          lastProgressAt: null,
          lastActionAt: null,
          lastVerifiedEffectAt: null,
          sinceProgressMs: null,
          sinceActionMs: null,
          noOpStreak: 0,
          stallLevel: 0,
          lastProgress: null
        }
      }
      const status = run_.progress.status()
      return {
        at: clock.now(),
        active: true,
        running: executor.running,
        state: run_.stateMachine ? run_.stateMachine.state : null,
        goal: run_.contract ? run_.contract.goal : null,
        step: run_.currentStepId || null,
        steps: run_.steps,
        lastProgressAt: status.lastProgressAt,
        lastActionAt: status.lastActionAt,
        lastVerifiedEffectAt: status.lastVerifiedEffectAt,
        sinceProgressMs: status.sinceProgressMs,
        sinceActionMs: status.sinceActionMs,
        noOpStreak: status.noOpStreak,
        stallLevel: run_.stallRecoveries,
        // The last progress record is copied, not handed over: the tracker's own
        // ring stays private.
        lastProgress: status.lastProgress ? { kind: status.lastProgress.kind, at: status.lastProgress.at } : null
      }
    }, (message) => ({
      at: clock.now(),
      active: false,
      running: false,
      state: null,
      goal: null,
      step: null,
      steps: 0,
      lastProgressAt: null,
      lastActionAt: null,
      lastVerifiedEffectAt: null,
      sinceProgressMs: null,
      sinceActionMs: null,
      noOpStreak: 0,
      stallLevel: 0,
      lastProgress: null,
      reason: message
    }))
  }

  /**
   * Stop one process this runtime owns.
   *
   * This is the *supervised* half of process ownership, and it is deliberately a
   * separate call from the `processes()` report: reading what the runtime owns can
   * never change it, while stopping a long-running process the runtime started (a
   * dev server, a watcher, a build that must not outlive its task) is a real
   * operation an upper layer has to be able to perform.
   *
   * It is never a general process killer: the registry refuses anything it does
   * not own, and "not owned" is reported rather than escalated.
   *
   * @param {string} processId a handle from `processes().owned[].id`
   * @param {string} [reason] recorded with the outcome
   * @returns {Promise<{ok:boolean, id:string, reason:string}>}
   */
  async function killOwned(processId, reason = 'runtime request') {
    try {
      return await processRegistry.kill(processId, String(reason))
    } catch (error) {
      const message = error && error.message ? error.message : String(error)
      faults.push({ at: clock.now(), controller: 'processes', error: message })
      return { ok: false, id: processId === undefined || processId === null ? null : String(processId), reason: message }
    }
  }

  /**
   * Runs one task, optionally continuing autonomously until the criteria hold
   * or a bounded stop condition is reached.
   */
  async function run(contractInput, runOptions = {}) {
    let contract
    try {
      contract = contractInput && contractInput.goal && contractInput.limits
        ? contractInput
        : createContract(contractInput, runtimeOptions)
    } catch (error) {
      // An invalid contract is a *result*, not a crash: the caller (a panel, an
      // IPC handler, a host agent) gets the same report shape as any other run.
      return {
        id: null,
        status: RUN_STATUS.FAILED,
        goal: contractInput && contractInput.goal ? String(contractInput.goal) : null,
        criteria: { satisfied: false, unknown: false, results: [] },
        steps: 0,
        outcomes: [],
        recoveryDecisions: [],
        stallRecoveries: 0,
        states: [],
        world: null,
        error: { code: error && error.code ? error.code : CODES.CONTRACT_INVALID, message: error && error.message ? error.message : String(error), details: error && error.details ? error.details : null },
        health: health(),
        startedAt: clock.now(),
        finishedAt: clock.now()
      }
    }
    const autonomous = runOptions.autonomous === undefined ? contract.autonomyEnabled : Boolean(runOptions.autonomous)
    const rounds = []
    let totalSteps = 0
    let round = 0
    let resume = runOptions.resume || null

    for (;;) {
      activeRun = { contract, round }
      syncPage()
      const report = await executor.run(contract, { resume })
      activeRun = null
      totalSteps += report.steps
      rounds.push(report)
      const decision = autonomy.decide({ report, round, totalSteps })
      if (!autonomous || !decision.continue) {
        return {
          ...report,
          rounds: rounds.length,
          roundReports: rounds.length > 1 ? rounds.map((entry) => ({ status: entry.status, steps: entry.steps })) : undefined,
          autonomy: { autonomous, decision: decision.reason, decisions: autonomy.decisions().slice(-5) },
          health: health()
        }
      }
      round += 1
      resume = { ...(decision.resume || {}), ...(runOptions.resume || {}) }
    }
  }

  /** Acceptance: direct action execution through the executor. */
  async function executeAction(action, actionOptions = {}) {
    syncPage()
    // No contract is synthesized here: the executor wraps the single action into
    // a one-step contract itself, so there is exactly one code path.
    return executor.executeAction(action, actionOptions)
  }

  function cancel(reason) {
    return executor.cancel(reason)
  }

  function attachPage(page) {
    controllers.browser.setPage?.(page)
    return Boolean(page)
  }

  /** The capability an action type needs, from the frozen contract table. */
  function capabilityOfAction(actionType) {
    return ACTION_CAPABILITY[actionType] || null
  }

  /**
   * The workspace the runtime uses when neither the contract nor the host names
   * one.
   *
   * A host that declared `cwd` means it, so that is used. Otherwise the runtime
   * uses a directory it *owns* — `<data root>/workspace/computer-use`, created on
   * demand — rather than the directory it happened to be started in: defaulting to
   * `process.cwd()` would make the boundary depend on where a launcher ran the
   * process, so the same contract would be confined in one deployment and
   * unconfined in another. Either way the directory is verified before it is used,
   * and it is the single value the shell controller, the file controller, the
   * executor's gate and the health snapshot all see.
   */
  function defaultRuntimeWorkspace() {
    if (host.cwd) {
      try {
        const resolved = path.resolve(String(host.cwd))
        if (fs.statSync(resolved).isDirectory()) return resolved
      } catch {
        /* a host cwd that is not usable is not a workspace */
      }
    }
    try {
      const root = process.env.DSH_ROOT ? path.resolve(process.env.DSH_ROOT) : path.resolve(__dirname, '..', '..')
      const dir = path.join(root, 'workspace', 'computer-use')
      fs.mkdirSync(dir, { recursive: true })
      return dir
    } catch {
      return null
    }
  }

  /** A fresh controller probe, used by the on-demand capability verdict. */
  function probeControllersNow() {    const entry = (controller) => {
      if (!controller || typeof controller.probe !== 'function') return { available: false, reason: 'controller is not attached' }
      try {
        const verdict = controller.probe()
        return { available: verdict.available !== false, reason: verdict.reason || null, detail: verdict.detail || null }
      } catch (error) {
        return { available: false, reason: error && error.message ? error.message : String(error) }
      }
    }
    return {
      browser: entry(controllers.browser),
      desktop: entry(controllers.desktop),
      vision: entry(controllers.vision),
      shell: entry(controllers.shell),
      file: entry(controllers.file)
    }
  }

  function dispose() {
    try {
      controllers.file.unwatchAll?.()
    } catch {
      /* nothing to release */
    }
    // The runtime disposes of every process it owns. A disposable child
    // must not survive the runtime that started it.
    try {
      const disposed = processRegistry.dispose('runtime dispose')
      if (disposed.attempted) faults.push({ at: clock.now(), controller: 'processes', error: `disposed ${disposed.disposed}/${disposed.attempted} owned processes` })
    } catch (error) {
      faults.push({ at: clock.now(), controller: 'processes', error: String(error && error.message ? error.message : error) })
    }
    if (log) log.close()
    return true
  }

  return {
    id: 'computer-use',
    version: VERSION,
    contract: (input) => createContract(input, runtimeOptions),
    describeContract,
    run,
    executeAction,
    cancel,
    attachPage,
    health,
    canExecute,
    /**
     * The long-running state readers. All
     * four are bounded snapshots, and none of them can throw: a failure is a
     * reported reason plus a fault. The mutable registry and budget stay private.
     */
    capabilities,
    processes,
    resources,
    progress,
    // The supervised half of ownership: reading can never change the
    // runtime, killing what it owns is an explicit, refused-if-not-owned call.
    killOwned,
    dispose,
    controllers,
    observer,
    executor,
    autonomy,
    workspace,
    options: runtimeOptions,
    log: log
      ? {
          path: log.path,
          tail: (count) => log.tail(count),
          steps: () => log.steps(),
          screenshots: () => log.screenshots()
        }
      : null,
    /** Compact snapshot for the dock panel. */
    snapshot() {
      const run_ = executor.currentRun
      return {
        version: VERSION,
        state: run_ ? run_.stateMachine.state : CU_STATES.IDLE,
        running: executor.running,
        goal: run_ ? run_.contract.goal : null,
        steps: run_ ? run_.steps : 0,
        health: health(),
        recentSteps: log ? log.tail(12) : [],
        screenshots: log ? log.screenshots().slice(-5) : []
      }
    },
    /** The actions the runtime is able to carry, used by the UI and the docs. */
    actionTypes: Object.values(ACTION_TYPES),
    RUN_STATUS,
    CODES,
    ComputerUseError
  }
}

module.exports = { createComputerUseRuntime, VERSION, ACTION_TYPES, RUN_STATUS, CU_STATES, path }
