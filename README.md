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
- extension status module: installed vs official harness version, with one click to align the main harness with the official latest release

### Mega right-side dock

After the official Alien/DSH UI loads, Mega appears as a visually attached right-side dock.

```text
Collapsed                              Expanded
+----------------------+----+          +----------------------+-----------------------+
| official DSH UI      | M  |          | official DSH UI      | Mega              ⚙ ›  |
|                      | E  |          |                      | Queue / reorder       |
|                      | G  |          |                      | Hardware auto         |
|                      | A  |          |                      | Balance               |
|                      |RUN |          |                      | Extension status      |
|                      |Q/HW|          |                      | Mega settings overlay |
+----------------------+----+          +----------------------+-----------------------+
```

- **Collapsed rail** — 48 px vertical strip with MEGA identity, running count, queued count, hardware worker state and peak/off-peak state.
- **Expanded dock** — 560 px by default: manual task creation with real queue ordering controls, hardware-adaptive concurrency, the account balance module, the extension status module and the settings layer.
- **One dock target adapter** — the current build renders the dock as a `WebContentsView` inside the main window (`app\desktop-main.cjs`), while the legacy companion `BrowserWindow` remains a second backend. Both are reached through `app\extensions\mega\dock\target.js`, which owns the webContents, the bounds, the visibility and the screenshot for whichever generation is running. No theme, skills or IPC path reads `dockWindow` directly, so "apply succeeded but the dock never repainted" cannot come back through a second code path.
- **State memory** — collapsed/expanded state and dock width are stored in `data/state/mega-dock.json`.
- **Integrated layout** — the official dsh view and the dock are sibling `WebContentsView`s inside one native window, so the dock reserves its own strip and never sits on top of the official UI. `DSH_MEGA_INTEGRATED_DOCK=0` falls back to the legacy companion `BrowserWindow` (positioned outside the official window, or overlaying its right edge when the screen has no room); the theme system is unaware of the difference because both go through the dock target adapter above.
- **One product window** — there is no separate Mega management window or page. Every Mega capability lives in the dock; the settings layer (⚙ in the dock header) is an in-dock overlay that reuses the existing IPC backend.
- **Ctrl+Shift+M** — toggles the right dock between collapsed and expanded states.
- **System tray** — double-click restores/focuses the main window; right-click offers only **Exit DS-Harness** and **Force Exit DS-Harness**.
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

### Unified theme system (Appearance)

The dock carries a complete, autonomous theme subsystem. The user supplies **only natural
language** — never a slot, token, manifest or file path.

```text
Appearance · 主题皮肤
├── Current theme (Dark)
├── Describe what you want  →  [ Generate ]
├── Preview: validation verdict + checklist
│     [ Looks Good ]  [ Modify → "What would you like changed?" ]
└── Themes: Dark 🔒  Light 🔒  Minimal Neutral  Anime Persona Demo  Cyber HUD Demo
```

```text
Prompt → UI inspection → capability manifest → design intent → live preview
       → validation → user revision / approval → theme compilation
       → package validation → registration → installation
```

- **Preview-first** — generating a theme stops at a live preview applied to the real dock.
  Nothing is registered or installed until **Looks Good**.
- **It observes before it designs** — the pipeline starts with a real UI observation:
  a screenshot of the running dock plus a geometry probe that measures the live slot
  bounding boxes. When no picture is possible (the dock is hidden, the renderer is gone, a
  headless run) the design still proceeds from structure alone, but the result is marked
  `degraded` with a reason and logged — it is never silently structure-only. Accepted
  screenshots must be real PNGs (signature, IHDR dimensions, sane size); an empty buffer or a
  0x0 capture is rejected rather than counted as a visual observation.
- **Self-contained packages** — `data/themes/user/<theme-id>/` holds its own
  `manifest.json`, `tokens.json`, `components.json`, `persona.json`, `preview.png`,
  `preview.html` and `assets/`. Compiled assets are embedded as inline data URIs at
  runtime, so painting a theme never reads the filesystem.
- **No runtime theme dependencies** — `derived_from` is history metadata only; deleting any
  theme can never affect another one.
- **Protected** — `Dark` and `Light` are `protected`, `deletable: false`, `editable: false`.
  `Dark` is also the global recovery target; a broken package, missing asset or failed
  compatibility check degrades to Dark instead of breaking the dock.
- **HNS state legibility is protected** — all ten canonical worker states get their own
  token, and a theme whose states become perceptually indistinguishable is rejected.
- **Lightweight persona only** — small operator avatar / status avatar / corner widget /
  light banner, prominence capped at `0.4`; a large character overlay is rejected.
- **Load-aware** — the runtime samples load every 15 s and down-grades effects (blur,
  decoration, animation, heavy assets) without ever editing the installed theme package or
  touching the scheduler.
- **Official UI is untouched** — DS-Hns may not inject CSS/JS into the official renderer, so
  the capability manifest declares `can_theme_official_ui: false` and exposes only a
  `light`/`dark` palette hint. The theme system styles the HNS dock surface only.

See [`docs/theme-system.md`](docs/theme-system.md) for the full implementation note,
the slot/permission model, the validation checklist and the recovery rules.

### Skills management

The dock also manages the agent's **skills**, because a skill is live agent
configuration and installing one should not mean hand-editing `data\skills\`.

```text
Skills · 技能管理
├── [ GitHub 链接或 owner/repo ]            → [安装]
├── 快速搜索技能…                            ☐ 同时搜索 GitHub
├── 标签筛选
├── [发现] [已安装]        全选  已选 N/M  [批量删除]
└── 技能卡片：名称 · 来源 · 描述 · 标签 ·  [i] [⧉ 合集] [🗑]
```

- **Five ways in, two ways out** — search the catalog, paste a GitHub link
  (`owner/repo`, `/tree/`, `/blob/`, raw, `git@…`), pick a local folder, install a
  bundled starter skill, or install a whole collection; delete one skill, delete a
  whole collection, or select many and delete in bulk.
- **It is the harness's format, not ours** — the panel accepts exactly what
  `@deepseek-ai/dsh-skill-filesystem` loads (kebab-case name, required `name` and
  `description`, `SKILL.md` bundle or `<name>.md`, invocation flags). Anything the
  dock reports as installed is something the running harness will actually load.
- **Staged and validated** — nothing reaches the skill root until the staged copy has
  been validated, so a failed install cannot leave a half-written skill behind.
- **No restart** — `data\skills` is a watched first-party DSH root, so an install or a
  delete takes effect on the next catalog read.
- **Nothing escapes** — archive extraction refuses `..`, absolute paths, symlinks and
  devices, and caps entry count and bytes; deletion is confined to the skill root.
- **Honest results** — renames, skipped skills and per-item batch failures are all
  reported instead of being swallowed.

See [`docs/skills-management.md`](docs/skills-management.md) for the format contract,
source resolution, security rules and the theme integration.

### Extension status and harness alignment

The dock's **拓展状态** module reports what the Mega extension is doing and which harness is
actually installed, and it owns the single sanctioned way to align the main harness with the
official latest release of `@deepseek-ai/dsh`.

```text
拓展状态
├── Mega 扩展          已加载 · mega (optional feature extension)
├── 主 Harness 当前     installed version (read from app\node_modules)
├── 官方最新            official dist-tag "latest" from registry.npmjs.org
└── [检查更新] [更新并重启]
```

- **Check** — one read-only HTTPS request for the official `dist-tags` document; nothing is
  installed, nothing is written. A registry failure is reported in the panel, never thrown.
- **Update** — pins `app\package.json`, hands the install to a detached runner and lets the
  shell exit gracefully. The runner then waits for DS-Harness to disappear (a real exit is
  required: Windows will not let npm replace a running harness), runs
  `npm install --save-exact @deepseek-ai/dsh@<latest>`, verifies the installed version, the CLI
  entry and a real `node lib/bin.js --help` boot, and relaunches DS-Harness.
- **Upgrade and rollback are separate operations** — the rollback restores the previous
  `package.json` / `package-lock.json` and then runs `npm ci --no-audit --no-fund` (the exact
  lockfile reinstall), never the upgrade command again. The previous version is read from
  `app\node_modules\@deepseek-ai\dsh\package.json`, not from the manifest pin, so the
  installation that comes back is the one that was actually running.
- **Three outcomes, not two** — `data\state\mega-update.json` records `succeeded`,
  `failed_rolled_back` or `failed_rollback_failed`. The dock reports which one happened, and a
  failed rollback is shown as *回滚未完成，当前安装可能已损坏* instead of a generic "更新失败".
- **Pin matters** — `scripts\install-deps.ps1` runs `npm ci` whenever the installed version
  differs from `app\package.json`, so the pin is what stops an update from being silently
  reverted on the next start.
- **No official-renderer contact** — the button lives in the dock, the update runs in its own
  process, and nothing is ever injected into the official dsh page.

Update progress is logged to `logs\mega-update.log`.

### Launcher icon

`icon.jpg` in the repository root is the only icon source. `scripts\ensure-icon.ps1`
regenerates `assets\icon\ds-harness.ico` from it whenever the source is newer, and the
launcher shortcuts, the Electron window and the tray all read that generated artifact.
A missing or broken icon can only degrade the icon — never the launcher or the Harness start.

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
      theme/                     HNS unified theme system (engine)
        contract.js              Theme API version, slot table, permissions, tokens
        color.js                 colour parsing, WCAG contrast, perceptual distance
        png.js                   dependency-free PNG encoder
        asset-factory.js         procedural wallpapers/panels/persona/icons
        validator.js             package validator (manifest/assets/API/readability/states)
        registry.js              theme registry, active theme, built-in tombstones
        recovery.js              load guard; any failure degrades to Dark
        designer.js              intent interpretation, incremental revision, token synthesis
        builder.js               approved design -> self-contained package
        capability.js            Theme Capability Manifest
        inspector.js             UI inspector + UI snapshot package
        preview.js               preview payload + preview validation checklist
        runtime.js               active theme, preview state, load-aware degradation
        lifecycle.js             install / delete / duplicate / restore / import
        orchestrator.js          prompt -> ... -> install pipeline
        index.js                 engine assembly (createThemeEngine)
        builtin/                 committed self-contained packages
          system/{dark,light}/   protected system themes
          demo/{minimal-neutral,anime-persona,cyber-hud}/
          generate.cjs           regenerates the system themes
          generate-demos.cjs     rebuilds the demos through the real builder pipeline
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
      updater/
        harness-updater.js       official version check + update hand-off
        update-runner.js         detached install/verify/rollback/relaunch runner
      notifications/
        notification-service.js  terminal desktop notifications (dedup + isolation)
        terminal-dispatch.js     single alert pipeline: ringtone + notification
        sound-service.js         ringtones
      deepseek/
      skills/                    HNS skills management (backend)
        skill-format.js          harness-compatible skill file format + validation
        tar.js                   dependency-free tar reader (traversal-safe)
        skill-source.js          GitHub / local source resolution
        skill-catalog.js         bundled + curated catalog, optional GitHub search
        skill-service.js         list / install / delete / collections / surfaces
      utils/
      ui/
        dock.html                collapsible right-side dock + settings overlay
        dock.js
        dock.css                 dock palette bridged to the Theme API tokens
        theme-bridge.js          shared theme integration for dock UI modules
        theme-panel.js           Appearance panel (theme creation / preview / list)
        skills-panel.js          Skills panel (search / install / delete)
        apply-theme-css.cjs      regenerates the dock.css token bridge
        apply-skills-css.cjs     appends the Skills panel stylesheet
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
│       ├── Appearance (unified theme system)
│       ├── Skills (search / install / delete)
│       ├── Queue
│       ├── Hardware
│       ├── Balance
│       ├── Extension status (harness update)
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
Theme-system behavior is enforced by `tests/unit/theme-validator.test.js`,
`tests/unit/theme-designer.test.js`, `tests/unit/theme-engine.test.js`,
`tests/unit/theme-panel.test.js` and `tests/unit/theme-bridge.test.js`.
Skills management is enforced by `tests/unit/skills-service.test.js` and
`tests/unit/skills-panel.test.js`.

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
Themes: the **Appearance** panel — type a description, preview it on the dock, then
**Looks Good** to install or **Modify** to refine it in natural language.
Skills: the **Skills** panel — search, paste a GitHub link, or pick a local folder to
install; delete one skill, a whole collection, or a multi-selection.
Exit: tray right-click → **Exit DS-Harness** (graceful) or **Force Exit DS-Harness**.

## Verification

```powershell
powershell -ExecutionPolicy Bypass -File scripts\verify.ps1
```

The verification checks both the Mega-derived feature logic and the Alien architectural contract.
It runs three gates in order: `npm run check` (syntax for every shipped source file,
`scripts\check-syntax.cjs`), `npm test` (unit + architecture tests, `node --test
tests\unit\*.test.js`) and the architecture assertions in `scripts\verify.ps1` itself.
`-SkipTests` runs only the architecture assertions. The same first two gates run in
`.github\workflows\verify.yml` on every push and pull request to `main` and `merging`.

The **release acceptance** — the real Electron shell, CDP attach, screenshots, theme
switching, prompt-theme create/preview/approve/delete, system-theme protection, skills and
the updater rollback — is a separate, longer run:

```powershell
node scripts\acceptance.mjs --root <checkout> --port 3091 --cdp 9331 --skills --report <file.json>
```

Add `--github` for the live repository install. It writes a JSON report
(`commit`, `branch`, `passed`, `failed`, `warnings`, per-`modules` counts, `checks`, `notes`)
and exits non-zero on any failure. It is not part of CI because it needs a real Windows
desktop session; run it before merging to `main`.
