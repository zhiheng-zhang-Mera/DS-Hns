# The restart supervisor, and the monitor that must not be able to restart anything

Two plugins, one line between them:

```
  dshns.health-scheduler                    dshns.restart-supervisor
  ─────────────────────────                 ──────────────────────────────
  samples the machine and the runtime       validates, prices and executes a restart
  scores a pressure, holds a state          owns the process, the budget, the
  decides NO_ACTION → THROTTLE →            crash-loop ladder, safe mode, the
  PAUSE_NEW_WORK → REQUEST_RESTART          heartbeat, readiness and recovery
                     │
                     └── restart-control ──►  (the only route between them)
```

`dshns.health-scheduler` holds no command, no signal and no process handle. `dshns.restart-supervisor`
has no opinion about pressure, no sensor and no threshold. Both properties are asserted by scanning the
two sources in `tests/unit/restart-supervisor-authority.test.js`, comments included, because a guarantee
that needs a parser to check is a weaker guarantee than one the source makes impossible.

## Why the split is the whole design

A monitor whose bug can stop the machine is more dangerous than the condition it watches. Concretely:

* the monitor runs *inside* the application and samples every fifteen seconds; a scoring bug that
  escalated one rung too far would reach a restart path on every tick;
* the restart authority runs *outside* the thing it restarts — as its out-of-process companion — because
  a process that has frozen its event loop cannot run the code that would recover it;
* so the decision (which can be wrong) and the execution (which can be catastrophic) are different
  plugins, in different processes, connected by one capability the platform mediates.

Neither can take the other down. Uninstall the monitor and the supervisor still answers a manual
restart; make the supervisor fail and the monitor reports `restart unavailable` and keeps sampling.

## The two halves of the authority

| | in-process (the plugin) | out-of-process (the companion) |
| --- | --- | --- |
| What it is | `app/plugins/restart-supervisor/index.cjs`, mounted by `NativeHnsAdapter` | `app/plugins/restart-supervisor/companion/main.cjs`, a plain Node program |
| What it can do | answer `restart-control`, write the heartbeat, keep the budget | own the child process, read the heartbeat, stop and relaunch |
| What it cannot do | own the process (it *is* the process) | score anything, decide anything, resume anything |
| When it acts | a request arrives through the capability | the child is gone, or its heartbeat went stale |

They agree on **one directory** and nothing else:

```
  $DSH_HOME/state/restart-supervisor/
    companion.pid          who the companion is, so a second one refuses to start
    companion.stop         a person asking the companion to stand down
    app.heartbeat.json     the application's own beat, written by the plugin
    restart.request.json   the plugin asking the companion to execute a restart
    restart.lock           which of the two is executing a restart *right now*
    companion.journal.jsonl  every decision the companion made, appended
    budget.json            the human "reset the budget" marker
```

A file rather than an IPC call, for the same reason the heartbeat is a file: when the thing in between
is hung, neither side can call the other. That is not a workaround; it is the design.

## The restart lifecycle

The order is the contract, and every arrow is an injected function so the *order* is testable without
performing a restart:

```
  restart requested
    → validate the request            (mode, reason, checkpoint requirement)
    → check the restart budget        (maxRestarts inside a rolling window)
    → check the cooldown              (the backoff floor)
    → notify Core continuity          (beforeRestart: park and persist)
    → stop accepting unsafe new work  (the continuity layer's, not this component's)
    → wait for a safe boundary        (bounded: no deadline in this product ends a running task)
    → graceful shutdown               (forced only if the graceful path does not finish)
    → the companion observes the exit and relaunches
    → wait for process readiness
    → wait for network readiness      (bounded retries: a Windows logon can be slower than the app)
    → wait for plugin readiness
    → tell continuity it may resume
    → the previous tasks continue     (Core's job, not this component's)
```

**What the supervisor does not do: resume tasks.** It tells Core continuity that a restart is coming,
executes it, confirms the new process is ready, and tells continuity it may resume. Which tasks
continue, and from which checkpoint, belongs to the task layer, and a second answer here would be a
second source of truth about the user's work.

## The budget, the ladder and safe mode

| Bound | Shipped default | What it prevents |
| --- | --- | --- |
| `budget.maxRestarts` | 3 | more than three restarts in a window |
| `budget.windowMs` | 10 minutes | a slow drip of restarts being treated as fine |
| `budget.cooldownMs` | 60 s | a restart immediately after a restart |
| `budget.backoffMs` → `backoffMaxMs` | 5 s → 300 s, doubled per failure | the backoff never growing, or growing without bound |
| `crashLoop.degradedAt` | 2 failures | restarts continuing to look routine |
| `crashLoop.safeModeAt` | 4 failures | **automatic execution continuing at all** |

The ladder is `NORMAL → DEGRADED → SAFE_MODE`. `DEGRADED` is a *reporting* change. `SAFE_MODE` is a
*behaviour* change, and in safe mode:

* no automatic restart is executed — every mode is refused with `RESTART_SAFE_MODE`;
* the official Harness UI and the official UI's plugin inventory are untouched (this is about restarts,
  not about the product);
* core diagnostics stay up, and the last error is on the surface that shows it;
* high-risk automatic work is not started by anything this component runs;
* a person may **restart by hand** and **reset the budget**. The reset clears the window and the streak
  and *keeps the history*: the audit trail is the evidence somebody is acting on, so deleting it would
  destroy the thing they need.

A restart that never reached an executor — no companion running, the lock held by the other half — is
recorded and **does not spend the budget**: counting it would let a machine whose companion failed to
spawn run out of budget without ever having restarted.

## The heartbeat: a live pid is not a healthy product

Four signals, four separate facts, and two separate clocks:

| Signal | Who reports it | Judged against |
| --- | --- | --- |
| `alive` | the operating system (through `seen()`) | `heartbeat.livenessTimeoutMs` (20 s) |
| `responsive` | the runtime's own beat | `heartbeat.timeoutMs` (30 s) |
| `loop` | the main event loop's own beat | `heartbeat.timeoutMs` |
| `ready` | the application, once it has finished booting | `heartbeat.timeoutMs` |

`livenessTimeoutMs` is deliberately **shorter** than `timeoutMs`, because they answer different
questions: the operating system answers liveness on every check, while the runtime's beat is the
runtime's own. A dead process should be diagnosed as `gone`, not spend six missed beats looking merely
slow. The escalation when the process is alive and the beat is not:

| Silence | Verdict | Action |
| --- | --- | --- |
| inside `gracefulRecoveryMs` | `unresponsive` | `observe` |
| past `gracefulRecoveryMs` | `unresponsive` | `graceful-recovery` |
| past `forcedAfterMs` | `hung` | `forced-restart` — **stop waiting** |
| the pid is gone | `gone` | `recover` |

The last two rows are the component's reason to exist: "the process exists but has not beaten for
ninety seconds" is not a process to keep waiting for, and waiting for ever is exactly the failure a
supervisor is supposed to prevent.

## Readiness, and the Windows logon

After a relaunch the application must pass five gates **in order**: `process`, `runtime`, `network`,
`plugins`, `continuity`. Each gate has its own bounded retry budget with exponential backoff, and the
whole sequence shares one deadline, so a slow network cannot extend the boot past
`readiness.timeoutMs`.

The `network` and `plugins` gates are the reason the retries exist at all: on Windows the network often
comes up *after* the application does, so the first failure of a network probe is not a failed boot.
Only `readiness.required` (shipped: `process`, `runtime`) can fail the sequence — a gate that is merely
not up yet is reported and stepped over, which is the honest answer rather than a failed restart that
was really a slow one.

## One executor, two processes

Two halves watching one application is a fork bomb unless they agree, so they agree with a **lock**:

* a supervisor claims `restart.lock` before executing and releases it afterwards;
* a supervisor that finds a *live* claim defers and records why;
* a claim whose owner is gone, or whose deadline has passed, is stale and may be taken over — because
  the one failure this must not have is a dead process's lock blocking every restart for ever.

The plugin's own path is delegation: it writes `restart.request.json` and returns. The companion picks
it up on its next watch pass, claims the lock and runs the lifecycle. A stale request (older than its
TTL) is discarded rather than executed an hour later.

## Who starts the companion, and the two shapes it runs in

A supervisor that nobody starts is a document, so the start is part of the shell's boot rather than
something a person has to do: `desktop-main.cjs` defers a `restart-supervisor` phase that builds the
plugin world and asks the supervisor to start its own companion (`startCompanions`). It is a
`startup.defer` step on purpose — a companion that will not start is a line in the boot report and a
`degraded` row in the official UI, never a shell that refuses to open.

There are two shapes, because the application can be started in two ways:

| shape | who launched the application | how the companion watches it |
| --- | --- | --- |
| **launcher** (`--app <cmd>`) | the companion | its own child process handle |
| **attached** (`--attach <pid>`) | somebody else — the normal case, because the shell starts the companion from inside a running product | the pid, through the OS |

Everything else is shared: the same budget, cooldown, backoff, crash-loop ladder, safe mode, heartbeat
and journal. An attached companion asks the OS two questions it would otherwise get from a
`ChildProcess` — *is this pid alive* and *stop it, gracefully then forcibly* — and both are answered
through injected hooks (`pidAlive`, `killByPid`) rather than by a second implementation.

Two consequences follow, and both are asserted by tests rather than hoped for:

* **an ordinary quit is not a crash.** From outside, "the pid went away" reads identically either way,
  so `before-quit` writes `companion.stop` **before** the process leaves; the companion sees it on its
  next pass and stands down instead of crash-recovering the application the user just closed;
* **a restart the companion starts is a graceful one.** The companion writes
  `app.stop-request.json`, which the shell watches from boot and answers by leaving through its own exit
  path — checkpoints, managed resources, the harness — and only escalates to `taskkill` if the timeout
  passes. Starting the companion clears a previous run's stand-down file, so one intentional quit
  cannot silence the supervisor for ever.

## What the official UI shows, and what Mega configures

**Official Harness UI** (`settings.section` `mega`, and the `shell.overlay` ball): both plugins appear
as service records — id, name, version, `installed` / `enabled` / `loaded` / `healthy` as four separate
facts, the plugin's health answer, the heartbeat verdict, the capabilities provided, the adapter that
produced it, and the last error. For the monitor: pressure, trend, the five-state model and the
explanation. For the supervisor: supervisor state, restart count against the budget, cooldown, the last
restart reason and safe mode. The actions offered are `check`, `enable`, `disable`, `restart-plugin`,
`diagnostics`, and — for the supervisor only — `manual-restart` and `reset-budget`, the two flagged for
confirmation.

**Mega** is the advanced layer, and it owns the *policy*, not the operation: the thresholds and their
hysteresis exits, the sampling interval, the cooldowns, the maintenance window and its two deadlines,
the debounce and the two `UNKNOWN` floors, the restart budget, window, cooldown and backoff, the
crash-loop thresholds, the heartbeat and liveness timeouts, the graceful and forced stop budgets and the
readiness budget. Every key is a dotted path into the configuration the plugin already reads, validated
by the host that writes it, so the panel cannot offer a value the plugin would refuse.

**None of that is a dependency.** Mega is a panel: stop it and both plugins run, the supervisor keeps
restarting and the official UI keeps showing their state.

## Removing the other authorities

Three overlapping restart paths existed before this work, and there is now one:

| Before | After |
| --- | --- |
| `app/reboot/*` — `shutdown /r` plus an `HKCU\…\Run` relaunch entry | kept, and it is the **machine-level** tier only: the operation the supervisor's maintenance policy escalates to when configuration says so. It is not an application restart executor. |
| `app/plugins/mounted/index.cjs` `dshns.watchdog` — a stall detector | kept, and it is a **reporter**: it notices a task that stopped making progress. It never restarted anything, and it is asserted not to. |
| `app/extensions/mega/updater/update-runner.js` — relaunch after an upgrade | kept, and it is a **release** operation: a detached runner that replaces the installed harness and relaunches once. It is not a restart authority; it does not read a budget, a heartbeat or a crash loop. |
| *(nothing)* | `dshns.restart-supervisor` — the one **application restart** authority, in process or as its companion. |

## Testing it

* `tests/unit/restart-supervisor-authority.test.js` — the authority separation (source scans), the
  budget, the cooldown, the backoff, the crash-loop ladder, safe mode and the reset, the heartbeat's two
  clocks, the lifecycle's order and its refusals, readiness retries, `restart-control` through the
  plugin manager, the lock, a stale request, and the companion's watch loop terminating at its budget.
* `tests/unit/longhost-soak.test.js` and `scripts/longhost-soak.cjs` — the synthetic 6/12/24-hour soaks
  on a virtual clock, plus `--realtime --hours 24` for the real-machine run.
* `tests/unit/installer-optional-plugins.test.js` and `scripts/install-bundled-plugins.ps1` — the
  install, repair and uninstall of both plugins through the Harness CLI, and the uninstaller's scan for
  an orphan companion process and a leftover startup entry.
