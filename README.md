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
- peak/off-peak pricing engine and task-cost calculation
- DeepSeek account balance lookup
- session JSONL tracking and recent task history
- model / permission / telemetry settings helpers
- configurable completion / failure / interruption sounds
- selectable headless-task workspace

### Mega right-side dock

After the official Alien/DSH UI loads, Mega appears as a visually attached right-side dock.

```text
Collapsed                              Expanded
+----------------------+----+          +----------------------+-----------------------+
| official DSH UI      | M  |          | official DSH UI      | Mega                  |
|                      | E  |          |                      | Queue / reorder       |
|                      | G  |          |                      | Hardware auto         |
|                      | A  |          |                      | Peak / cost / balance |
|                      |RUN |          |                      | Recent sessions       |
|                      |Q/HW|          |                      |                       |
+----------------------+----+          +----------------------+-----------------------+
```

- **Collapsed rail** — 48 px vertical strip with MEGA identity, running count, queued count, hardware worker state and peak/off-peak state.
- **Expanded dock** — 560 px by default, with manual task creation, real queue ordering controls, hardware-adaptive concurrency controls, balance and recent sessions.
- **State memory** — collapsed/expanded state and dock width are stored in `data/state/mega-dock.json`.
- **No official viewport resize** — the official DSH BrowserWindow keeps its original size. If there is room on the right, the dock sits outside it; if not (for example a maximized window), the dock overlays the right edge as a separate BrowserWindow instead of shrinking the official renderer.
- **Full Mega tools** — the original larger management window remains available for low-frequency/advanced settings.
- **Ctrl+Shift+M** — toggles the right dock between collapsed and expanded states.
- **System tray** — Official Harness, Expand/Collapse Mega Dock, Show/Hide Mega Dock, Full Mega Tools, Exit.

Disable only the dock without disabling Mega background features:

```cmd
set DSH_MEGA_DOCK=0
```

`DSH_MEGA_WIDGET=0` is also honored as a compatibility alias for older installations.

Disable the tray separately:

```cmd
set DSH_MEGA_TRAY=0
```

## Repository layout

```text
Install-DS-Harness.cmd           double-click one-click installer
Start-DeepSeek-Harness.cmd       normal launcher after installation
app/
  desktop-main.cjs               Alien-derived shell; owns official dsh UI
  runtime-process.cjs            DSH child ownership/recovery
  extensions/
    manager.cjs                  optional extension lifecycle
    mega/
      index.cjs                  Mega adapter, dock/tray/tools lifecycle
      billing/
      scheduler/
      tracker/
      settings/
      notifications/
      deepseek/
      utils/
      ui/
        dock.html                 collapsible right-side dock
        dock.js
        dock.css
        index.html                full Mega tools window
        renderer.js
        preload.cjs
  package.json
config/
data/
assets/
scripts/
  install.ps1
  install-deps.ps1
  ensure-node.ps1
  cleanup-runtime.ps1
  verify.ps1
tests/
```

## Black-screen protection rules

1. `app/desktop-main.cjs#createWindow()` must not contain a `preload` entry.
2. Mega code must never inject JavaScript/CSS into the official renderer.
3. Mega UI must never replace the official main window.
4. Dock/tools UI must live in separate `BrowserWindow` instances.
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

Mega dock: `Ctrl+Shift+M`.
Full Mega tools: use the expanded dock or tray entry.

## Verification

```powershell
powershell -ExecutionPolicy Bypass -File scripts\verify.ps1
```

The verification checks both the Mega-derived feature logic and the Alien architectural contract.
