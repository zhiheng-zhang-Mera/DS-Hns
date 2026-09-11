# DS-Hns — Alien-derived DeepSeek Harness with optional Mega extensions

## Architecture contract

DS-Hns is **not** a Mega-based hybrid. `Harness-Alien` is the canonical shell/runtime/UI baseline; `Harness-Mega` is a feature donor only.

The primary window is the official `@deepseek-ai/dsh` Web UI. It is launched and embedded using the Alien model and intentionally receives **no custom preload, no DOM injection, no navigation bridge and no dependency on the Mega extension**.

If all Mega features are disabled, DS-Hns must remain functionally and architecturally equivalent to Harness-Alien.

```text
Alien-derived Electron shell
        |
        +--> official dsh web --no-open (primary UI, port 3080)
        |
        +--> optional extension manager
                 |
                 +--> Mega feature extension
                       scheduler / peak billing / tracker / settings / sounds
                       right-side dock / tray / isolated full tools window
```

### Pure Alien regression mode

```powershell
powershell -ExecutionPolicy Bypass -File scripts\run.ps1 -PureAlien
```

or set:

```cmd
set DSH_DISABLE_MEGA=1
Start-DeepSeek-Harness.cmd
```

In this mode the Mega extension is not loaded at all.

## Why the previous DS-Hns was rebuilt

The previous integration retained Mega as a second application core under `app/monitor`, ran a separate 3300 control-plane UI and attached a shared Electron preload to the official dsh renderer. That violated the intended architecture and created a plausible failure path for the reported all-black official UI.

The rebuild removes the legacy `app/monitor` application and shared preload entirely. Optional functionality now starts only **after** the official dsh page has loaded. Extension failure is logged but must not terminate or mutate the official UI.

Mega shell entrances are restored as **separate Electron windows/tray UI**. The right-side dock is a child `BrowserWindow`; it is visually attached to the official window but is never injected into the official dsh page.

## One-click install

On Windows, clone/download the repository and double-click:

```text
Install-DS-Harness.cmd
```

The installer is idempotent and reuse-first:

1. checks/cleans stale DS-Harness-owned runtime processes;
2. creates missing runtime/data/cache/workspace directories;
3. reuses a compatible bundled Node.js if present;
4. otherwise reuses a compatible Node.js already on `PATH`;
5. otherwise reuses a previously downloaded portable Node archive;
6. downloads portable Node only when no compatible local copy exists;
7. checks the exact local versions of `@deepseek-ai/dsh` and Electron;
8. skips `npm ci` completely when both installed versions already match `app/package.json`;
9. repairs only the Electron binary when the npm package is correct but `dist\electron.exe` is missing;
10. when package repair/install is needed, uses `npm ci --prefer-offline` and reuses existing npm/Electron caches when available;
11. generates built-in sounds only when they are missing;
12. runs unit + architecture tests and repository verification;
13. creates Desktop and Start Menu shortcuts (Windows logon autostart is **not** enabled automatically);
14. launches DS-Harness when installation succeeds.

## API key flow

The installer never requires an API key in order to finish installation.

Supported environment names:

```text
DEEPSEEK_API_KEY   canonical name
DeepSeek_API       compatibility alias
```

Priority is:

```text
DEEPSEEK_API_KEY: Process -> User -> Machine
        -> DeepSeek_API: Process -> User -> Machine
        -> existing project config\.env
        -> interactive choice
```

When `DeepSeek_API` is found, DS-Hns maps it to `DEEPSEEK_API_KEY` **inside the current process only**. It does not rename or rewrite the user's Windows environment variable.

If an environment key already exists, it is reused and is **not copied or printed** by the installer.

If no environment key and no existing project key are found, the installer asks:

- **Configure now** — enter the key securely; it is stored only in `config\.env`.
- **Configure later** — installation continues normally; open Mega Extensions and enter the key under **Harness / 提醒**.

## Mega-derived features retained

- manual ordered queue with top/up/down/bottom controls
- scheduled / off-peak task queue
- hardware-adaptive local concurrency
- peak/off-peak pricing engine and task-cost calculation (billing/accounting layer, no longer a UI metric)
- DeepSeek account balance lookup, refreshed automatically when the Balance module opens
- session JSONL tracking plus a queryable terminal task history
- one desktop notification per terminal task state (completed / failed / cancelled)
- model / permission / telemetry / notification settings helpers
- configurable completion / failure / interruption sounds
- selectable headless-task workspace

### Mega right-side dock

After the official Alien/DSH UI loads, Mega appears as a visually attached right-side dock.

```text
Collapsed                              Expanded
+----------------------+----+          +----------------------+-----------------------+
| official DSH UI      | M  |          | official DSH UI      | Mega              ⚙ ›  |
|                      | E  |          |                      | Queue / reorder       |
|                      | G  |          |                      | Hardware auto         |
|                      | A  |          |                      | Balance               |
|                      |RUN |          |                      | Mega settings overlay |
|                      |Q/HW|          |                      |                       |
+----------------------+----+          +----------------------+-----------------------+
```

- **Collapsed rail** — 48 px vertical strip with MEGA identity, running count, queued count, hardware worker state and peak/off-peak state.
- **Expanded dock** — 560 px by default: manual task creation with real queue ordering controls, hardware-adaptive concurrency, the account balance module and the settings layer.
- **State memory** — collapsed/expanded state and dock width are stored in `data/state/mega-dock.json`.
- **No official viewport resize** — the official DSH BrowserWindow keeps its original size. If there is room on the right, the dock sits outside it; if not (for example a maximized window), the dock overlays the right edge as a separate BrowserWindow instead of shrinking the official renderer.
- **One product window** — there is no separate Mega management window or page. Every Mega capability lives in the dock; the settings layer (⚙ in the dock header) is an in-dock overlay that reuses the existing IPC backend.
- **Ctrl+Shift+M** — toggles the right dock between collapsed and expanded states.
- **System tray** — double-click restores/focuses the main window; right-click offers **Show**, **Mega**, the optional **Sub-worker** submenu, **Exit DS-Harness** and **Force Exit DS-Harness**.
  - *Exit* stops the scheduler, flushes/persists state, stops the managed Harness, destroys windows/tray and quits gracefully.
  - *Force Exit* performs a best-effort flush, kills the managed child process tree (`taskkill /T /F`), destroys extension/runtime resources and calls `app.exit()`; no cleanup step can block the final exit.

Disable only the dock without disabling Mega background features:

```cmd
set DSH_MEGA_DOCK=0
```

`DSH_MEGA_WIDGET=0` is also honored as a compatibility alias for older installations.

Disable the tray separately:

```cmd
set DSH_MEGA_TRAY=0
```

## Task lifecycle, notifications and the balance module

Task lifecycle is a single shared capability rather than per-task-type code:

```text
QUEUED -> RUNNING -> SUSPENDED -> RUNNING -> TERMINAL
TERMINAL = COMPLETED | FAILED_FINAL | CANCELLED
```

- **Terminal cleanup** — a task that reaches a terminal state is finalized, written to
  `data\task-history\recent.json`, and removed from the active queue/worker slot in one
  idempotent step (`removeIfPresent`, never `removeOrThrow`). Terminal tasks are never
  reloaded into the active queue at startup, so they cannot resurrect after a restart.
- **One terminal event** — the scheduler emits `TASK_TERMINATED`
  (taskId, taskName, finalStatus, completedAt, shortResult/errorSummary) exactly once per
  lifecycle. The notification layer deduplicates on `taskId + finalStatus + terminal epoch`.
- **Unified terminal alerts** — every task path converges on one pipeline:
  an ordinary official Harness session (observed from the DSH session store by
  `tracker\terminal-observer.js`), a scheduler-dispatched official session and a headless
  task all produce the same `TASK_TERMINATED` payload into
  `notifications\terminal-dispatch.js`, which rings the ringtone and sends the desktop
  notification at most once per terminal state. The observer is primed at startup, so
  pre-existing history never alerts; sessions Mega launched itself are filtered out because
  the scheduler already reports them.
- **Desktop notifications** — one notification per terminal state, dispatched as a side
  effect: a notification failure never changes an already-final task state and never blocks
  the renderer. Configuration lives in `config\notifications.json` and is editable in the
  dock's ⚙ Settings → Notifications group (system notifications, cancelled-task notifications).
- **Balance module** — opening the module refreshes automatically through the same
  `refreshBalances(trigger)` implementation used by the manual button
  (`module-open` / `manual` / `retry`). Concurrent requests are coalesced, providers are
  isolated (one provider failing never fails the page), and the last successful balance is
  retained and labelled as stale instead of being blanked out.
- **No session mirror** — Mega does not repeat the official Harness session history: the
  "Recent Session" panel was removed. The official UI remains the single owner of session
  history; Mega only watches it for terminal alerts.

### Launcher icon

`icon.jpg` in the repository root is the only icon source. `scripts\ensure-icon.ps1`
regenerates `assets\icon\ds-harness.ico` from it whenever the source is newer, and the
launcher shortcuts, the Electron window and the tray all read that generated artifact.
A missing or broken icon can only degrade the icon — never the launcher or the Harness start.

## Optional Sub-worker execution layer

An optional executor layer that is **off by default**. With `subWorker.enabledOnStartup=false`
the shell spawns no worker process, binds no extra port, opens no extra window and does not even
create `data\sub-worker\`: the default DS-Harness experience is unchanged, and the worker has no
Electron window of its own (its only visuals are the existing Mega panel and Live View).

Enable or disable it from the Mega dock's **Sub-worker** panel (Enable / Start / Stop / Restart,
plus Pause, Resume, Cancel Task, Take Over, Open Live View, and a *Release worktree* action for the
isolated checkout that holds a reviewed deliverable) or from the tray's **Sub-worker**
submenu: a busy-aware header (`Sub-worker: OFF`, `Sub-worker: BUSY (RUNNING)`) with
`Task: <id>`, then Start / Stop / Restart, Pause / Resume / Cancel Current Task / Open Live View
and Restart Worker or Take Over Workspace, sitting between **Mega** and **Exit DS-Harness**.
`⚙ Settings → Sub-worker` holds the persisted options.

The worker is an **executor only** — it never decides direction, architecture or the next task.
The Controller (the main Harness, or an external Codex through it) dispatches a versioned,
validated Task Object (`task_id`, `objective`, `target_repo`, `workspace`, `workspace_mode`,
`allowed_paths`, `forbidden_paths`, `acceptance`, `acceptance_commands`, `permissions`,
`risk_level`, `requires_vision`, `operations`) and receives a structured Result Object
(`status`, `code`, `summary`, `changed_files`, `changed_file_details`, `tests`, `git`,
`warnings`, `acceptance`, `stage_log`). Only risk levels `L0`–`L2` are accepted; `L3`/`L4` are
refused with `REQUIRES_CONTROLLER`, a `requires_vision` task with `UNSUPPORTED_CAPABILITY`, and a
task without executable `operations` rather than improvised.

Every run is inspectable: the Live View shows Task, Status, Execution Summary, Changed Files,
Tests, Terminal, Warnings / Errors, Result, Events and Task History — the auditable execution
summary only, never model hidden reasoning. Durable state lives in `data\sub-worker\` (config /
state / queue / history / tasks / workspace-lock) and `logs\sub-worker.log` plus
`logs\sub-worker\<task_id>.log`; all of it is git-ignored, and the worker edits a target
repository through `isolated_worktree` (`<repo>-worktrees\hns-sub-worker`) by default.

Phase 1 is deliberately small: single worker (`maxWorkers=1`), local only, no worker-to-worker
communication, and **Auto Delegate OFF** by default — even when enabled it can only auto-dispatch
a task that already carries a complete executable specification and whose objective matches an
allowed category, never architecture redesign, security-sensitive work, deployment, large
deletion, research direction or high-risk migrations.

Full reference: [docs/sub-worker.md](docs/sub-worker.md).

## Adaptive multi-process execution

The same layer can grow into an adaptive parallel executor, **off by default**. Turning on
*Adaptive multi-process* in the Sub-worker panel keeps the executor contract and changes only who
decides how many workers exist:

- **Hardware ceiling** (detected once at installation and stored in
  `data\sub-worker\hardware-profile.json`) × **runtime ceiling** (sampled CPU, RAM, disk latency,
  VRAM, battery, thermal) × **task parallelism** × **file-conflict ceiling** ×
  **external-service limit** = the effective worker count. `min(...)` over every dimension, never a
  hardware-only guess, and the pool grows one worker at a time after a sustained-healthy window
  (hysteresis) instead of jumping to the maximum.
- **Performance states** `NORMAL / BOOST / THROTTLED / CRITICAL / SAFE_MODE` drive dispatch: no new
  tasks while throttled, immediate scale-down when critical, and a parked pool with a live
  supervisor if the machine cannot host even one worker.
- **Task DAGs**: submit a plan of nodes with `depends_on`, `write_scope` and `acceptance_tests`;
  the scheduler runs only dependency-satisfied nodes, orders them by critical path + dependents,
  and never starts two writers of the same file at once (file-scope conflicts plus a file-ownership
  registry). Each node gets its own git worktree; the results are merged into an integration
  worktree and validated there, and a same-file conflict is reported rather than resolved.
- **Worker pool**: persistent processes (not spawn-per-task) with heartbeats and multi-signal hang
  detection, crash isolation, one automatic retry for infrastructure failures, and optional
  `speculative` duplication while healthy.
- **Learning**: per-role memory/CPU estimates are refined with an EWMA from real runs, clamped to a
  documented band around the seeded profile.
- Control and configuration: the Mega panel's pool/resource/DAG/metrics sections,
  `config\hns-resource.yaml` (a documented, zero-dependency YAML subset), and
  `subWorker.adaptiveWorkers` / `subWorker.resources` in `config\app.json`.

With adaptive mode off, the supervisor runs **exactly one worker on the same code path** — the
two-process behaviour of the previous phase, not a second architecture.

Full reference: [docs/multi-worker.md](docs/multi-worker.md).

## Repository layout

```text
Install-DS-Harness.cmd           double-click one-click installer
Start-DeepSeek-Harness.cmd       normal launcher after installation (canonical boot entry)
icon.jpg                         launcher icon source asset (single source of truth)
app/
  desktop-main.cjs               Alien-derived shell; owns official dsh UI
  runtime-process.cjs            DSH child ownership/recovery
  extensions/
    manager.cjs                  optional extension lifecycle
    mega/
      index.cjs                  Mega adapter, dock/tray lifecycle, IPC, exit routing
      billing/
        balance-service.js       balance refresh: coalescing + provider isolation
      scheduler/
        lifecycle.js             canonical task lifecycle vocabulary/events
        scheduler.js             queue, concurrency, terminal transitions
      tracker/
        session-reader.js        DSH session store reader (tracker)
        terminal-observer.js     unified terminal observer for official sessions
      settings/
        settings-service.js      env/app/sound/notification settings backend
      notifications/
        notification-service.js  terminal desktop notifications (dedup + isolation)
        terminal-dispatch.js     single alert pipeline: ringtone + notification
        sound-service.js         ringtones
      deepseek/
      utils/
      ui/
        dock.html                collapsible right-side dock + settings overlay
        dock.js
        dock.css
        balance-module.js        shared Balance module open detection
        preload.cjs
  package.json
config/
data/
assets/
  icon/ds-harness.ico            generated from icon.jpg (never hand-edited)
scripts/
  install.ps1
  ensure-icon.ps1
  install-deps.ps1
  ensure-node.ps1
  cleanup-runtime.ps1
  shortcuts.ps1
  verify.ps1
tests/
```

## Product surface

```text
Windows
│
├── DS-Harness Main Window
│   ├── Official Harness
│   └── Mega Dock
│       ├── Queue
│       ├── Hardware
│       ├── Balance
│       └── ⚙ Settings popup (in-dock overlay)
│
└── Tray
    ├── double click -> focus main window
    └── right click
        ├── Exit DS-Harness
        └── Force Exit DS-Harness
```

There is no Full Mega Tools window, no secondary Mega control window and no duplicate
Recent Session panel.

## Black-screen protection rules

1. `app/desktop-main.cjs#createWindow()` must not contain a `preload` entry.
2. Mega code must never inject JavaScript/CSS into the official renderer.
3. Mega UI must never replace the official main window.
4. Dock UI must live in separate `BrowserWindow` instances.
5. Expanding the Mega dock must not resize the official DSH BrowserWindow or its renderer viewport.
6. Extensions load only after `mainWindow.loadURL(officialDshUrl)` succeeds.
7. `DSH_DISABLE_MEGA=1` must boot the product without loading Mega code.
8. An extension crash must be logged and isolated from the official UI.

These rules are enforced by `tests/unit/architecture-contract.test.js`.
Installer/reuse/API-key behavior is enforced by `tests/unit/installer-contract.test.js`.

## Normal start

After installation:

```cmd
Start-DeepSeek-Harness.cmd
```

Optional PowerShell launcher:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\run.ps1
```

Mega dock: `Ctrl+Shift+M`. Mega settings: ⚙ in the dock header.
Exit: tray right-click → **Exit DS-Harness** (graceful) or **Force Exit DS-Harness**.

## Verification

```powershell
powershell -ExecutionPolicy Bypass -File scripts\verify.ps1
```

The verification checks both the Mega-derived feature logic and the Alien architectural contract.
