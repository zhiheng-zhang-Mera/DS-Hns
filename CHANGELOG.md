# Changelog

All notable changes to DS-Hns. Newest first. Each entry names the user-visible
behaviour that changed, not the files that were touched.

## Theme-Cover — the theme system becomes a full visual theme generator

The theme engine could already restyle the HNS dock from a prompt, but it could
only change colours and parameters: the "official UI" was a read-only palette
hint, characters were abstract procedural avatars, and there was nowhere to put a
real figure or a skin. It now generates and places real visual assets on four
surfaces, and the official renderer is still never touched.

**Four surfaces instead of one dock.** `hns_native`, `official_shell`,
`official_overlay` and `official_renderer` are now a single model
(`app/extensions/mega/theme/surface.js`) with per-surface permissions: `full`,
`full`, `visual-only`, `protected`. Every writer goes through one gate
(`assertWritable`), and the protected renderer is refused for every write kind and
every asset kind — including from a hand-written or imported package whose own
surface plan claims a write into it.

**The official area is now themable without being modified.** The shell draws a
frame *behind* the official view (only its outer band is visible) and a
transparent overlay *above* it. Both are separate `WebContentsView`s owned by the
shell: no preload, no script, no CSS injected into the official renderer and no
access to its DOM. The overlay is created with `setIgnoreMouseEvents(true)` and
`focusable: false`, and its document has `pointer-events: none` and no focusable
element, so clicks, keys and scrolling keep going to the official UI. The overlay
tracks the official view's bounds exactly, and the acceptance run proves it by
dispatching real input through the overlay's own area and asking the official
renderer whether it arrived.

**Real assets, not just colours.** A split asset pipeline — planner, generator,
processor, validator, fallback — produces characters in five framings (avatar,
bust, half body, full body, silhouette), an official skin, an overlay texture,
HUD and frame decorations, and a wallpaper, all with genuine transparency where
it is required. The generator calls an image capability when one is configured,
retries, then falls back to the procedural renderer, then disables that one asset;
a theme whose image generation fails completely still installs. Every produced
artifact is decoded and measured — real dimensions, real alpha, real visible
content — so an empty or flat buffer cannot pass as an asset.

**Design is observation-driven.** A prompt no longer goes straight to a theme: the
engine observes the HNS/Dock/Official bounds, the window size, the live slot
geometry, the available character regions and the critical interaction regions,
and only then produces a surface plan, an overlay plan and an asset plan. Each
plan is compiled into the package, so an approved theme documents what it writes,
where every asset came from and what the validator measured.

**The overlay cannot make the official UI unusable.** An Overlay Layout Engine
places the character and decorations against the safe region (viewport minus the
critical regions: input, send, core body, primary controls), and an Overlay Safety
validator enforces the engineering ceilings numerically — overlay opacity 0.22,
vignette 0.15, scanline 0.05, character coverage 22%, critical overlap 8% — plus
brightness, contrast loss, asset size and layout overflow. Over-strength designs
are downgraded and the character is shrunk; if no allowed strength can clear a
critical region, the overlay is disabled and the theme still installs.

**Preview and revision.** Approving still installs, and nothing installs before
it: the package now carries an HNS preview, an official shell preview, an official
overlay preview and a composite preview, and the panel shows all four. A
revision is scoped rather than a re-roll — "人物小一点" keeps the wallpaper, the
official skin and the texture byte-for-byte and only regenerates the character,
which the acceptance run verifies by comparing hashes. Deleting a theme leaves no
overlay, no character and no cache reference behind.

Also fixed while building this:

- `inspector.buildSnapshotPackage()` wrote `pages[].screenshot` from the raw
  screenshot **buffer** map, so the snapshot JSON contained a mojibake "path"
  built from binary instead of `snapshot/<page>.png`. The per-page field now uses
  the same file map the package publishes.
- `color.flatten()` returned `null` channels for an already-parsed
  `{r,g,b,a}` colour, so `shade()`/`toHex()` produced `#NaNNaNNaN` for every
  parsed palette colour and the panel, decoration and official-skin renderers
  silently fell back to a flat grey. `flatten`/`toHex` now normalise both a CSS
  string and a parsed colour.
- The asset renderers called `color.toHex(color.shade(...))`, double-converting an
  already-hex value into `#NaNNaNNaN`; they now use one correct helper.
- A character asset's planned height came from the HNS character's aspect ratio
  for every surface, so an official bust was planned at the wrong height.

## merging — GitHub CI gate repaired

The repository's `verify` workflow (Windows, Node 22) failed on every push. Two
independent causes, both real product bugs rather than CI configuration:

- **The balance module could strand a refresh on a hanging provider.** The
  per-provider deadline timer was created with `unref()`, so it did nothing to
  keep the event loop alive. When a provider never answered and the wait for it
  was the only pending work, the process could exit with the timeout still
  unsettled — Node reports that as *"Promise resolution is still pending but the
  event loop has already resolved"*. The timer is now referenced, so the race
  always settles within the provider deadline; the shell's explicit exit paths
  still decide when DS-Harness goes away.
- **A sub-worker teardown could wait out its whole timeout.** `stop()` polled the
  pool for a drain with `unref()`-ed timers while the supervisor tick could still
  respawn a worker (or while the worker's own `exit` event had simply not been
  observed yet), so it either polled for the full 5 s or never settled at all.
  The pool now notifies waiters when a worker exits, `stop()` latches the pool as
  stopping before it waits, and `tick()` refuses to act during a teardown — the
  drain completes in milliseconds, and the timeout remains only as a safety net.

The tests are also repaired, so the gate measures the product rather than the
machine:

- `tests/unit/multi-supervisor.test.js` had a missing `})`: everything from the
  integration test down was parsed as a nested subtest of the pressure test,
  which is why Node 22 reported them cancelled. The file now parses as 13 tests.
- The same file pins a synthetic hardware profile in its rig, so the pool ceiling
  is no longer 1 on a 2-vCPU CI runner; the ceiling *derivation* against real and
  synthetic facts stays covered by `multi-profiler.test.js`.
- The workflow documentation now states why the Node version is pinned instead of
  floating (the suite is verified on 22 and 24).

## merging — Sub-worker execution layer merged in

`merging` now carries every line of development that is not `main`:
the Sub-worker / adaptive multi-worker layer (`Sub-worker`), on top of the theme,
skills, updater and acceptance work that `UI-theme`, `auto-update` and `skills`
had already contributed. Nothing was dropped: the whole merge was resolved by
keeping both features where they collided, and the merged tree passes the syntax
gate, the unit/architecture suite, the real Electron acceptance and the
Sub-worker's own end-to-end acceptance.

Fixed while integrating (both features were individually correct, only the
combination was not):

- The Sub-worker **Live View** push read `dockWindow.webContents` directly, so the
  integrated dock never received it and the "no direct dockWindow reads"
  architecture check failed. It now goes through the dock target adapter.
- `scripts/sub-worker-acceptance.cjs` copied `app/` recursively and hit `EPERM` on
  the `node_modules` link; it now skips `node_modules` and `data` (it links the
  dependency tree and starts from a fresh data directory anyway), and it copies the
  repository-level `assets/` too — without the tray icon its scratch shell ran in a
  degraded state that has nothing to do with what those scenarios verify.
- Its integration-merge check waited for the integration worktree *directory*
  while the merged files land a moment later, which made it flaky. It now waits
  for the files themselves.
- `scripts/verify.ps1` and the Sub-worker regression test asserted the old
  `HARNESS_PORT` expression; both now assert the shipped
  `normalizeHarnessPort()` / `DSH_LAUNCH_ARGS` behaviour.

## merging — stabilization pass

Fixes the confirmed design and implementation gaps on `merging` before it can be
merged to `main`. No new user-facing features; the theme, dock, updater, skills
and acceptance surfaces are made to actually close their loops.

### Self-update rollback (P0)

- **Upgrade and rollback are now two operations.** The rollback no longer reuses
  the upgrade command, so it can never re-install the version that just failed:
  it restores `app/package.json` and `app/package-lock.json` and runs
  `npm ci --no-audit --no-fund` (falling back to a plain `npm install` only when
  there is no lockfile to restore — and never with the target version).
- **The previous installation is identified from disk.**
  `app/node_modules/@deepseek-ai/dsh/package.json` decides what "the old version"
  is; the manifest pin is only a fallback. Every update records a transaction
  (`fromVersion`, `targetVersion`, `installedVersion`, manifests, `startedAt`).
- **Three outcomes instead of two.** `data/state/mega-update.json` now reports
  `succeeded`, `failed_rolled_back` or `failed_rollback_failed`, with the rollback
  result and its error code. The dock shows a distinct, high-visibility
  "回滚未完成，当前安装可能已损坏" state instead of a generic update failure.
- **Verification is real.** The upgrade is verified by installed version, CLI
  entry *and* a `node lib/bin.js --help` boot check; the rollback is verified by
  the restored version.

### Integrated Dock target adapter (P1)

- New `app/extensions/mega/dock/target.js`: one adapter
  (`getWebContents`, `getBounds`, `getSize`, `getVisible`, `capturePage`, `send`,
  `getState`) over the integrated `WebContentsView` and the legacy companion
  `BrowserWindow`. Theme repaint, change pushes, skills pushes, region probes and
  screenshots all go through it; the extension no longer reads `dockWindow` for
  any of them.
- The shell hands the extension a `dockAdapter` instead of a bare webContents, and
  reports dock-ready through `ctx.onDockReady`, which closes the boot gap where
  the first theme paint had no target yet (the view is created after extensions
  start). The callback is re-run when the dock renderer reloads.
- Dock state now carries `mode` (`integrated` / `window` / `detached`) and real
  view geometry, so the theme system never has to infer the UI from a null window.
- Dock toggles push their layout decision to the shell, so the reserved strip is
  actually re-laid out when the dock expands or collapses.

### Theme visual observation (P1)

- New `app/extensions/mega/theme/visual-artifact.js` validates captures: PNG
  signature, IHDR dimensions, and a size floor scaled to the image. A returned
  buffer that is not a usable image is rejected, not counted.
- The snapshot package now records `visual`, `degraded`, `visual_expected`,
  `visual_reason`, `capture_problems` and per-file verdicts. A structure-only
  design is still allowed, but it can no longer be silent: the theme create
  result, the log and the acceptance run all see the degraded state and its
  reason.
- `snapshot.screenshots` is now a page → file-name map (the previous shape mixed
  buffers into the package and broke persistence).
- The live slot-geometry probe is actually invoked before an observation, so the
  observer gets real bounding boxes instead of the last pushed cache.

### Acceptance and tests (P1)

- Acceptance asserts the visual observation: `snapshot.visual === true`,
  `degraded === false`, a real PNG per claimed file (>5 KB, valid header,
  non-zero dimensions), observed slot count > 0 with real bounding boxes, and the
  updater rollback suite. The report now carries `commit`, `branch`, `warnings`
  and per-`modules` counts.
- New tests: `dock-target` (integrated and legacy backends, destroyed targets,
  throwing adapters), `theme-visual-observation` (real capture, empty capture,
  junk buffer, capture exception, allowed degradations),
  `theme-model-adapter`, `encoding-integrity` (guards against a lossy
  encode/decode round-trip), and the rewritten `update-runner` A–E suite whose npm
  stub really rewrites `package.json` on `--save-exact`.
- `npm run check` is now `scripts/check-syntax.cjs`, which checks every shipped
  source file instead of a hand-maintained command list.

### Tooling

- `.github/workflows/verify.yml` runs the syntax gate and the test suite on
  Windows and Linux for pushes and pull requests to `main` and `merging`.
- `scripts/verify.ps1` gained architecture checks for the dock adapter, the
  absence of direct `dockWindow` reads, the split upgrade/rollback operations and
  the distinct rollback outcomes.
- Optional `app/extensions/mega/theme/model-adapter.js` prepares the AI designer
  layer: disabled by default, always falling back to the deterministic
  interpreter, reported in the theme status.
