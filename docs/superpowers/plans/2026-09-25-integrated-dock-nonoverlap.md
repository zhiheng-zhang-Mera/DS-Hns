# Integrated Dock Non-Overlap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. This task is explicitly single-agent; do not spawn or delegate to subagents.

**Goal:** Eliminate expanded-dock overlap with the official DSH viewport while preserving the official UI's minimum responsive width and real user interactions.

**Architecture:** Use a `BaseWindow` for integrated composition, with the inert startup shell, official renderer, and dock as explicit `WebContentsView` children. Load the official renderer before attaching it so the startup skeleton remains visible until the official page is ready. Keep `BrowserWindow` for the non-integrated fallback and auxiliary windows. A pure layout function owns the 1032 px official minimum, 440 px dock minimum, 720 px maximum, and safe refusal when the window is too narrow. Official-renderer consumers use the official child `webContents`; shell IPC stays process-owned and the existing `mainWindow.webContents` compatibility surface maps to the shell view.

**Tech Stack:** Electron `BaseWindow`/`BrowserWindow`/`WebContentsView`, CommonJS, Node test runner, existing `scripts/acceptance.mjs` harness and Codex computer-use UI.

**Spec:** `docs/superpowers/specs/2026-09-25-integrated-dock-nonoverlap-design.md`

## Global Constraints

- Keep the official renderer attached, visible, loaded, and never parked or hidden.
- Do not inject JavaScript or CSS into the official renderer.
- Expanded dock minimum is 440 px; maximum is 720 px; official minimum is 1032 px.
- At insufficient width, give the official view the full width and do not display an overlapping dock.
- Preserve the current wallpaper click-through path, shell-owned IPC channels, and shell `webContents` compatibility for existing main-process consumers.
- Run commands with TEMP, TMP, npm cache, user data, app data, and evidence rooted on D:.
- Do not mutate `main`, create a production tag, delegate QA, or claim unobserved gates passed before every mandatory target-mode gate is satisfied. If and only if all gates pass, follow the target-mode release sequence on its named branch and verify the terminal state.

## Review Focus

- 1472 px exact-fit boundary: test 1032 px official + 440 px dock and zero overlap.
- Width just below the boundary: test dock refusal and full-width official view.
- Dock-hidden and collapsed states: test full official width or a rail that leaves at least 1032 px.
- Resize while expanded: test no stale bounds and no overlay/notch at an unsafe size.
- The integrated host must use `BaseWindow`, not a BrowserWindow-owned page that occludes child views.
- Startup layering: the splash stays visible until the official page loads, then the official page and dock are actually visible in the BaseWindow.
- Child-renderer routing: test Computer Use/focus/keyboard listeners use the official child while dock-state IPC remains shell-owned.

---

### Task 1: Pin safe integrated layout geometry

**Files:**
- Create: `app/extensions/mega/dock/integrated-layout.cjs`
- Modify: `tests/unit/appearance-panel.test.js`
- Test: `tests/unit/appearance-panel.test.js`

**Interfaces:**
- Produces `computeIntegratedLayout({ contentWidth, contentHeight, dockShown, expanded, requestedDockWidth, officialMinWidth, dockMinWidth, dockMaxWidth, collapsedDockWidth })` returning `{ officialBounds, dockBounds, dockVisible, expansionBlocked }`.
- The function is pure and clamps malformed dimensions to safe positive content bounds.

- [ ] Append the `integrated dock layout reserves a readable official viewport and refuses overlap` test to `tests/unit/appearance-panel.test.js`, asserting exact-fit 1032+440 geometry, 560 px at 1592 px, collapsed 48 px rail, hidden dock, and refusal at 1471 px.
- [ ] Run `node --test tests/unit/appearance-panel.test.js`; expect that test to fail with `Cannot find module ... integrated-layout.cjs` before adding production code.
- [ ] Implement only the pure geometry function necessary for the contract.
- [ ] Run `node --test tests/unit/appearance-panel.test.js`; expect all tests in this file to pass, including the new geometry cases.

### Task 2: Route the integrated official renderer through its persistent child view

**Files:**
- Modify: `app/desktop-main.cjs`
- Test: `tests/unit/appearance-panel.test.js`
- Test: `tests/unit/theme-official-surfaces.test.js`
- Test: `tests/unit/desktop-primary-close.test.js`

**Interfaces:**
- Integrated mode loads `readyUrl` in `officialView.webContents`.
- `activeAgentSurface()` and the official-use collapse watcher resolve to `officialView.webContents`.
- Extension initialization receives that same official `webContents`.
- `mainWindow.webContents` remains the sender/receiver for shell-owned dock IPC.

- [ ] Add assertions identifying official renderer versus shell-owned webContents consumers.
- [ ] Run them RED before changing `desktop-main.cjs`.
- [ ] Use `BaseWindow` only in integrated mode and retain `BrowserWindow` for the legacy path.
- [ ] Create the shell splash view first; load the official renderer before attaching it, then place it above the shell view.
- [ ] Preserve the shell `webContents` compatibility surface and route official keyboard/focus consumers to the official child.
- [ ] Size the official child and dock as disjoint siblings from the pure layout result; keep the official view visible and in-bounds on every transition.
- [ ] Preserve the wallpaper click-through window path and avoid creating new topmost hit-target views.
- [ ] Re-run routing and surface unit tests.

### Task 3: Make narrow-window expansion refusal observable

**Files:**
- Modify: `app/desktop-main.cjs`
- Test: `tests/unit/appearance-panel.test.js`

**Interfaces:**
- Expanded requests that cannot fit do not show the dock over the official page.
- The shell logs the minimum required width and presents one concise native informational notice for a direct rejected expansion request.

- [ ] Test a too-narrow explicit expansion and a resize below the fit threshold.
- [ ] Implement the safe refusal, notice deduplication, and geometry update without persisting a false successful expansion.
- [ ] Re-run the focused tests and inspect logs for the exact required-width evidence.

### Task 4: Strengthen machine and real-window acceptance

**Files:**
- Modify: `scripts/acceptance.mjs`
- Modify: `tests/unit/appearance-panel.test.js`
- Evidence: `qualification/p2-nonoverlap-*` under the D: qualification root

- [ ] Require the expanded dock's left edge to be at or beyond the official viewport's right edge, and require Continue bounds to remain inside the official viewport.
- [ ] Add narrow-window refusal evidence without weakening the current acceptance thresholds.
- [ ] Run focused machine gates and the real visible-window acceptance with no keep-alive processes.
- [ ] Use Codex computer-use screenshots to read the actual startup/official/dock UI and perform the official first-run and conversation interaction journey.
- [ ] After any surgical fix, repeat the complete UI journey and every relevant machine gate.

### Task 5: Full qualification and release evidence

**Files:**
- Update: `docs/paper-material/06-NEGATIVE-RESULTS.md`
- Update: current paper catalogs/report using the repository's validator and mining scripts
- Evidence: D:-resident final qualification directory

- [ ] Run the complete machine qualification and production-like package from a clean D: environment.
- [ ] Launch the packaged app in isolated D: user/data/temp directories; verify real boot, dock transitions, official interactions, shutdown, and post-test process/C-drive audits.
- [ ] Mine and classify each remaining branch/commit against this RC without merging branches by existence alone; preserve excluded/superseded rationale.
- [ ] Re-run paper-material structural validation and the complete real UI regression after final source changes.
- [ ] Commit/push only the named RC branch, verify remote SHA and terminal CI, and create no production tag or `main` mutation unless the task's mandatory gates and explicit policy permit it.
- [ ] Publish the final status only as `HNS_PRODUCTION_BASELINE_ESTABLISHED` or `HNS_FINALIZATION_BLOCKED`, with all unobserved gates marked `NOT_RUN`/blocked.
