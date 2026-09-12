'use strict'

/**
 * DS-Hns Computer Use Runtime (plan §1, §38, §54).
 *
 * One runtime, assembled from independently faulted controllers, that takes an
 * execution contract and drives it to a verified finish:
 *
 *   Goal → Observe → Act → Verify → Recover if needed → Continue → Finish
 *
 * It is deliberately *not* a planner and *not* a learner. Long-term planning,
 * user profiles and application models belong to Boss or another upper agent
 * (plan §1/§42); this runtime adapts to the current state of the machine and
 * discards what it observed when the task ends (plan §5).
 *
 * The host injects ports — a browser page, a desktop driver, an accessibility
 * driver, a screenshot driver — and everything else is assembled here. A port
 * that is missing simply degrades its own controller (plan §37).
 */

const path = require('node:path')

const { ACTION_TYPES, CU_STATES, RUN_STATUS, resolveComputerUseOptions } = require('./constants.cjs')
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
    : createExecutionLog({ now: clock.now, dir: options.log ? options.log.dir : undefined, mode: options.log ? options.log.mode : 'normal', retention: runtimeOptions.screenshotRetention })
  const faults = []

  function guard(name, factory) {
    try {
      return factory()
    } catch (error) {
      const message = error && error.message ? error.message : String(error)
      faults.push({ at: clock.now(), controller: name, error: message })
      return unavailableController(name, null, `${name} failed to initialise: ${message}`)
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
    shell: isolateController('shell', 'shell', () => createShellController({ clock, cwd: host.cwd, env: host.env, shellEnabled: host.shellEnabled })),
    file: guard('file', () => createFileController({ clock, workspace: host.workspace || null, allowOutsideWorkspace: host.allowOutsideWorkspace === true }))
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
    options: runtimeOptions
  })

  let activeRun = null

  /** Plan §38: the runtime's own health, controller by controller. */
  function health() {
    // The page is attached before probing, otherwise a health report taken
    // before the first run would claim the browser controller is unavailable.
    syncPage()
    return {
      version: VERSION,
      state: executor.currentRun ? executor.currentRun.stateMachine.state : CU_STATES.IDLE,
      running: executor.running,
      controllers: executor.health(),
      faults: faults.slice(),
      autonomy: { enabled: autonomy.enabled, limits: autonomy.limits, decisions: autonomy.decisions().slice(-5) }
    }
  }

  /**
   * Runs one task, optionally continuing autonomously until the criteria hold
   * or a bounded stop condition is reached (plan §49).
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

  /** Phase 1 acceptance (plan §43): direct action execution through the executor. */
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

  function dispose() {
    try {
      controllers.file.unwatchAll?.()
    } catch {
      /* nothing to release */
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
    dispose,
    controllers,
    observer,
    executor,
    autonomy,
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
