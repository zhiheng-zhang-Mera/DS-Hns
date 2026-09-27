'use strict'

/**
 * DS-Hns: the restart supervisor's closed vocabulary.
 *
 * This module holds the *words* the supervisor and its callers agree on — the modes, the states, the
 * fault codes, the reasons a restart is refused, and the shipped configuration — so that no two
 * parts of the product invent two spellings of "safe mode". It contains no behaviour, which is what
 * makes it the right place for the defaults to be read from a panel, a test and a log line.
 *
 * ## The one rule this file exists to make structural
 *
 * A **restart request** is not a restart. `restart-control` accepts a *request*; the supervisor
 * validates it, prices it against a budget, waits for a safe boundary and only then executes. The
 * vocabulary keeps those apart by name: `RestartModes` describe what was asked for, `REFUSAL_CODES`
 * describe why the supervisor said no, and nothing here can stop a process.
 */

/** The plugin id and the capability name, in one place, because three layers refer to them. */
const SUPERVISOR_PLUGIN_ID = 'dshns.restart-supervisor'
const RESTART_CONTROL_CAPABILITY = 'restart-control'

/**
 * What a caller may ask for.
 *
 * | Mode | What it means | Who may ask |
 * | --- | --- | --- |
 * | `application` | stop this application and bring it back | anyone holding `restart-control` |
 * | `graceful` | the same, but the caller accepts waiting for a boundary | a maintenance window, a person |
 * | `emergency` | stop now, accept losing in-flight work | only a fault path, and only with the budget to spare |
 * | `system` | reboot the machine | **nobody through this capability**: it is an escalation tier |
 *
 * `system` is deliberately *not* reachable from `requestRestart()`. A monitor with a bug that can
 * reboot the machine is more dangerous than the condition it watches, so the machine-level tier is
 * the maintenance window's escalation and never a reaction to load. See `docs/restart-supervisor.md`.
 */
const RESTART_MODES = Object.freeze({
  APPLICATION: 'application',
  GRACEFUL: 'graceful',
  EMERGENCY: 'emergency',
  SYSTEM: 'system'
})

/** The modes `restart-control` accepts, in escalating order of disruption. */
const REQUESTABLE_MODES = Object.freeze([RESTART_MODES.GRACEFUL, RESTART_MODES.APPLICATION, RESTART_MODES.EMERGENCY])

/** The supervisor's own states: what it is doing, not what the application is doing. */
const SUPERVISOR_STATES = Object.freeze({
  IDLE: 'IDLE',
  MONITORING: 'MONITORING',
  REQUESTED: 'REQUESTED',
  DRAINING: 'DRAINING',
  STOPPING: 'STOPPING',
  RELAUNCHING: 'RELAUNCHING',
  WAITING_READY: 'WAITING_READY',
  COOLDOWN: 'COOLDOWN',
  DEGRADED: 'DEGRADED',
  SAFE_MODE: 'SAFE_MODE',
  DISABLED: 'DISABLED'
})

/** The three health tiers of the crash-loop ladder. */
const SUPERVISOR_HEALTH = Object.freeze({
  NORMAL: 'NORMAL',
  DEGRADED: 'DEGRADED',
  SAFE_MODE: 'SAFE_MODE'
})

/** The readiness gates a relaunched application must pass, in order. */
const READINESS_GATES = Object.freeze([
  { id: 'process', label: 'the process is running' },
  { id: 'runtime', label: 'the runtime answered' },
  { id: 'network', label: 'the network is reachable' },
  { id: 'plugins', label: 'the plugin host is up' },
  { id: 'continuity', label: 'the continuity layer can resume' }
])

/** Why a request was refused. Every one of them is a *reported* refusal, never a silent drop. */
const REFUSAL_CODES = Object.freeze({
  DISABLED: 'RESTART_DISABLED',
  SAFE_MODE: 'RESTART_SAFE_MODE',
  BUDGET_EXHAUSTED: 'RESTART_BUDGET_EXHAUSTED',
  COOLDOWN: 'RESTART_COOLDOWN',
  ALREADY_PENDING: 'RESTART_ALREADY_PENDING',
  BAD_REQUEST: 'RESTART_BAD_REQUEST',
  MODE_NOT_REQUESTABLE: 'RESTART_MODE_NOT_REQUESTABLE',
  UNSAFE_BOUNDARY: 'RESTART_UNSAFE_BOUNDARY',
  NO_EXECUTOR: 'RESTART_NO_EXECUTOR',
  DEADLINE_PASSED: 'RESTART_MAINTENANCE_DEADLINE_PASSED'
})

/** The fault codes the supervisor records. */
const SUPERVISOR_FAULT_CODES = Object.freeze({
  COMPANION_SPAWN_FAILED: 'SUPERVISOR_COMPANION_SPAWN_FAILED',
  COMPANION_EXITED: 'SUPERVISOR_COMPANION_EXITED',
  COMPANION_UNRESPONSIVE: 'SUPERVISOR_COMPANION_UNRESPONSIVE',
  HEARTBEAT_STALE: 'SUPERVISOR_HEARTBEAT_STALE',
  EXECUTION_FAILED: 'SUPERVISOR_EXECUTION_FAILED',
  READINESS_FAILED: 'SUPERVISOR_READINESS_FAILED',
  READINESS_TIMEOUT: 'SUPERVISOR_READINESS_TIMEOUT',
  GRACEFUL_TIMEOUT: 'SUPERVISOR_GRACEFUL_TIMEOUT',
  CRASH_LOOP: 'SUPERVISOR_CRASH_LOOP',
  CANCEL_FAILED: 'SUPERVISOR_CANCEL_FAILED'
})

/**
 * Why a restart happened, as a closed list.
 *
 * A restart with no recorded reason is a restart nobody can audit, and the history is the only place
 * that says whether the product is restarting because it is sick or because a schedule said so.
 */
const RESTART_REASONS = Object.freeze({
  HEALTH_PRESSURE: 'HEALTH_PRESSURE',
  MAINTENANCE_WINDOW: 'MAINTENANCE_WINDOW',
  MANUAL: 'MANUAL',
  HEARTBEAT_STALE: 'HEARTBEAT_STALE',
  PROCESS_EXITED: 'PROCESS_EXITED',
  CRASH_RECOVERY: 'CRASH_RECOVERY',
  UNKNOWN: 'UNKNOWN'
})

/** The shutdown shapes the executor may be asked for. */
const SHUTDOWN_KINDS = Object.freeze({
  GRACEFUL: 'graceful',
  FORCED: 'forced'
})

/**
 * The shipped configuration.
 *
 * Every number here is a bound on something that could otherwise loop forever, and each was chosen
 * against this product's own measurements rather than copied:
 *
 *   * `budget.maxRestarts: 3` in a `windowMs` of ten minutes — a healthy product does not restart
 *     three times in ten minutes, so the fourth attempt inside the window is a crash loop by
 *     definition rather than a judgement call.
 *   * `crashLoop.degradedAt: 2` — two failures is enough to stop treating restarts as routine and
 *     start reporting them (the tier is *visibility*, not a behaviour change).
 *   * `crashLoop.safeModeAt: 4` — the tier that stops automatic execution. It is above
 *     `maxRestarts` on purpose: the budget refuses, safe mode changes what the product *is*.
 *   * `heartbeat.forcedAfterMs: 90_000` — three missed heartbeat intervals plus slack. A process
 *     that is alive but has not beaten for ninety seconds is not healthy, and waiting forever is how
 *     a hung application becomes a silent one.
 *   * `readiness.*` — bounded retries, because a Windows logon can bring the network up after the
 *     application starts. The first failure is not a failed boot.
 */
const DEFAULT_RESTART_CONFIG = Object.freeze({
  enabled: true,
  /**
   * Whether a companion process should own the supervisor's execution when one is available.
   *
   * `startOnLoad` is **false**, and that is a deliberate reversal of the first shape. A plugin that
   * spawns a process when it loads makes *enabling a plugin* an act with a side effect nobody asked
   * for: a suite that mounts the shipped set forks a supervisor per test file, and a user who switched
   * the plugin on to read its diagnostics gets a background process. The delegation path does not need
   * one running — a request written to `restart.request.json` is executed by the next companion that
   * starts — so the companion is started when configuration asks (`startOnLoad: true`) or when the
   * shell calls `ensureCompanion()` because the product is actually booting.
   */
  companion: { enabled: true, mode: 'out-of-process', startOnLoad: false },
  budget: {
    maxRestarts: 3,
    windowMs: 600_000,
    /** The floor between two restarts, whatever the backoff says. */
    cooldownMs: 60_000,
    backoffMs: 5_000,
    backoffMaxMs: 300_000,
    /** Whether a success after a failure resets the streak that drives the backoff. */
    resetOnSuccess: true
  },
  crashLoop: { degradedAt: 2, safeModeAt: 4, safeModeOnLoop: true },
  heartbeat: {
    intervalMs: 5_000,
    /** A heartbeat older than this is stale: the process exists but is not answering. */
    timeoutMs: 30_000,
    /**
     * How long the *process* may go unseen before it is treated as gone.
     *
     * Four intervals, and deliberately shorter than `timeoutMs`, because process liveness and
     * heartbeat freshness are different questions: the operating system answers the first on every
     * check, while the second is the runtime's own beat. A dead process should be diagnosed as gone
     * rather than spend six missed beats looking merely slow.
     */
    livenessTimeoutMs: 20_000,
    /** Stale for this long and the supervisor stops waiting and forces the restart. */
    forcedAfterMs: 90_000,
    /** How long a graceful recovery is attempted before the forced path is taken. */
    gracefulRecoveryMs: 30_000
  },
  lifecycle: {
    /** How long a graceful stop may take before the executor is told to force it. */
    gracefulTimeoutMs: 45_000,
    /** How long a forced stop may take before the attempt is reported as failed. */
    forcedTimeoutMs: 15_000,
    /** How long the application has to reach a safe boundary before the deferral is re-evaluated. */
    boundaryTimeoutMs: 300_000
  },
  readiness: {
    /** The budget for the whole readiness sequence, not per gate. */
    timeoutMs: 180_000,
    /** Retries per gate, with `backoffMs` doubling between them. */
    maxAttempts: 8,
    backoffMs: 1_000,
    backoffMaxMs: 20_000,
    /** A gate that is not required may be reported unavailable without failing the boot. */
    required: ['process', 'runtime']
  },
  /** The maintenance window: when a *planned* restart is allowed to happen at all. */
  maintenance: {
    enabled: false,
    windowStart: '03:00',
    windowEnd: '05:00',
    /** How long a restart may be deferred waiting for a safe moment. Never unbounded. */
    maxDeferMs: 3_600_000,
    /** The hard deadline: past it, the request is refused with a reason rather than deferred again. */
    deadlineMs: 7_200_000,
    /** Whether a system reboot is the escalation tier once the deadline is close. */
    allowSystemEscalation: false
  },
  history: { maxEntries: 50 }
})

module.exports = {
  SUPERVISOR_PLUGIN_ID,
  RESTART_CONTROL_CAPABILITY,
  RESTART_MODES,
  REQUESTABLE_MODES,
  SUPERVISOR_STATES,
  SUPERVISOR_HEALTH,
  READINESS_GATES,
  REFUSAL_CODES,
  SUPERVISOR_FAULT_CODES,
  RESTART_REASONS,
  SHUTDOWN_KINDS,
  DEFAULT_RESTART_CONFIG
}
