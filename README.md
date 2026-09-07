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
                       isolated tools window only
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

## One-click install

On Windows, clone/download the repository and double-click:

```text
Install-DS-Harness.cmd
```

The installer is idempotent and reuse-first:

1. creates missing runtime/data/cache/workspace directories;
2. reuses a compatible bundled Node.js if present;
3. otherwise reuses a compatible Node.js already on `PATH`;
4. otherwise reuses a previously downloaded portable Node archive;
5. downloads portable Node only when no compatible local copy exists;
6. checks the exact local versions of `@deepseek-ai/dsh` and Electron;
7. skips `npm ci` completely when both installed versions already match `app/package.json`;
8. when repair/install is needed, uses `npm ci --prefer-offline` and reuses existing npm/Electron caches when available;
9. generates built-in sounds only when they are missing;
10. runs unit + architecture tests and repository verification;
11. creates Desktop and Start Menu shortcuts (Windows logon autostart is **not** enabled automatically);
12. launches DS-Harness when installation succeeds.

### API key flow

The installer never requires an API key in order to finish installation.

Priority is:

```text
Process/inherited environment
        -> User environment
        -> Machine environment
        -> existing project config\.env
        -> interactive choice
```

If `DEEPSEEK_API_KEY` already exists in the environment, it is reused and is **not copied or printed** by the installer.

If no environment key and no existing project key are found, the installer asks:

- **Configure now** — enter the key securely; it is stored only in `config\.env`.
- **Configure later** — installation continues normally; open Mega Extensions with `Ctrl+Shift+M` and enter the key under **Harness / 提醒**.

The default `.env.example` intentionally contains a blank API-key field, so a placeholder can never be mistaken for a configured credential.

For scripted installs:

```powershell
# Do not prompt for API key; leave it for the settings page
powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -ApiKeyMode Later

# Install without launching or creating shortcuts
powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -ApiKeyMode Later -NoLaunch -NoShortcuts
```

## Mega-derived features retained

- scheduled / off-peak task queue
- dynamic local concurrency
- peak/off-peak pricing engine and task-cost calculation
- DeepSeek account balance lookup
- session JSONL tracking and recent task history
- model / permission / telemetry settings helpers
- configurable completion / failure / interruption sounds
- selectable headless-task workspace

These features live under `app/extensions/mega/` and are opened via the isolated tools window (`Ctrl+Shift+M`).

## Repository layout

```text
Install-DS-Harness.cmd           double-click one-click installer
Start-DeepSeek-Harness.cmd       normal launcher after installation
app/
  desktop-main.cjs              Alien-derived shell; owns official dsh UI
  extensions/
    manager.cjs                 optional extension lifecycle
    mega/
      index.cjs                 Mega adapter, IPC and tools-window lifecycle
      billing/
      scheduler/
      tracker/
      settings/
      notifications/
      deepseek/
      utils/
      ui/                       isolated extension-only renderer
  package.json
config/
data/
assets/
scripts/
  install.ps1                   one-click install orchestration
  install-deps.ps1              exact-version dependency reuse/repair
  ensure-node.ps1               Node detection/cache reuse/bootstrap
  verify.ps1
tests/
```

## Black-screen protection rules

1. `app/desktop-main.cjs#createWindow()` must not contain a `preload` entry.
2. Mega code must never inject JavaScript/CSS into the official renderer.
3. Mega UI must never replace the official main window.
4. Extensions load only after `mainWindow.loadURL(officialDshUrl)` succeeds.
5. `DSH_DISABLE_MEGA=1` must boot the product without loading Mega code.
6. An extension crash must be logged and isolated from the official UI.

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

Mega tools: `Ctrl+Shift+M`.

## Verification

```powershell
powershell -ExecutionPolicy Bypass -File scripts\verify.ps1
```

The verification checks both the Mega-derived feature logic and the Alien architectural contract.
