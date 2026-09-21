# Hns Integration Visual RC1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build, verify, visually accept, and push a selective Integration RC without modifying main.

**Architecture:** Start with the common ancestor lineage, integrate only the latest non-redundant candidate heads, and resolve their small overlap semantically. Treat machine verification, packaged runtime verification, visual journeys, and reports as successive fail-closed gates.

**Tech Stack:** Windows PowerShell, Git/GitHub Actions, Node.js 22-compatible CommonJS, Electron 43.4.0, Node test runner, native Windows UI automation.

**Spec:** `docs/superpowers/specs/2026-09-21-hns-integration-visual-rc1-design.md`

## Global Constraints

- Work only in `D:\Hns-Integration-RC`; use a clean remote clone.
- Redirect all controllable cache, TEMP, userData, runtimeData, logs, build, and evidence to D: for the task process tree.
- Do not modify or merge `main`; do not create a production tag.
- Do not use another agent or DS-Hns second body; independent QA occurs later.
- Do not skip tests, lower thresholds, or weaken acceptance semantics.
- Use real visual capture and interaction; code or DOM inspection is not visual acceptance.
- Push only `dev/hns-integration-visual-rc1` and stop at the RC.

## Review Focus

- A runtime-host singleton conflict must fail safely without corrupting another instance.
- A failed plugin or injected local fault must remain isolated and visible in the official UI.
- A status/account refresh must visibly transition through loading and terminal feedback without stale-state confusion.
- A safe setting must survive a complete process exit and restart using only the isolated profile.
- A long-running task status query must not cancel, restart, or mutate the task.

---

### Task 1: Inventory and selective integration

**Files:**
- Create: `artifacts/acceptance/branch-inventory.json`
- Modify only if conflicts require it: `.gitignore`, `app/desktop-main.cjs`, `scripts/install.ps1`, `scripts/verify.ps1`, `tests/unit/installer-contract.test.js`

**Interfaces:**
- Consumes: remote refs rooted at main `59d816b734bea1c20ff2fbd6244395fc715304fe`
- Produces: one conflict-free RC history and a machine-readable branch decision record

- [ ] Record branch heads, ancestry, commits, changed paths, CI status, purpose, dependencies, and decision.
- [ ] Merge the highest admitted ancestor-complete branch; run `git status --short` and inspect every conflict.
- [ ] Merge the second admitted branch and resolve each overlap by comparing base, both sides, tests, and documented contracts.
- [ ] Run `powershell -ExecutionPolicy Bypass -File scripts\verify.ps1` with task-local D-drive environment redirection; expect exit 0.
- [ ] Commit the inventory and any semantic conflict resolution with a message naming the integration result.

### Task 2: Machine gates and production-like package

**Files:**
- Create: `artifacts/acceptance/logs/*`
- Create: `artifacts/acceptance/package/*`

**Interfaces:**
- Consumes: Task 1 conflict-free RC tree
- Produces: install, syntax, unit, integration, acceptance, package, and installer evidence with exact exit status

- [ ] Select the repository-declared Node/package-manager path and install dependencies with D-drive cache/TEMP settings; expect exit 0.
- [ ] Run repository syntax, unit, integration, acceptance, plugin, and CI-equivalent gates; expect every applicable command to exit 0.
- [ ] Build or assemble the repository-supported production-like candidate; expect launchable output under D:.
- [ ] Validate installer/package contracts without modifying the installed Hns or real user profile; expect all applicable checks to pass.
- [ ] Record every command, version, elapsed time, result, and unrun/not-applicable reason in the RC report evidence.

### Task 3: Real startup and visual baseline

**Files:**
- Create: `artifacts/acceptance/screenshots/*`
- Create: `artifacts/acceptance/VISUAL_UI_AUDIT.md`
- Create: `artifacts/acceptance/ui-issue-inventory.json`

**Interfaces:**
- Consumes: Task 2 launchable candidate and isolated D-drive profile
- Produces: screenshots and issue records tied to actual controls and observed states

- [ ] Launch the production-like candidate with D-drive userData/runtime/log/crash paths and capture the initial visible window.
- [ ] Traverse navigation, cards, buttons, dropdowns, settings, task/runtime status, plugin, health/restart, logs, Mega, dialogs, context menus, and advanced panels.
- [ ] For each surface record visible, understandable, clickable, connected action, feedback, state, and expected persistence.
- [ ] Resize and scroll through empty/error/loading states; record clipping, overflow, truncation, duplicated labels, terminology, and hierarchy findings.
- [ ] Classify each finding P0-P3 with reproduction, expected/actual, before screenshot, suspected cause, and status.

### Task 4: User journeys, fault isolation, and surgical repairs

**Files:**
- Modify: only production and test files directly required by reproduced P0-P2 findings
- Create: `artifacts/acceptance/INTERACTION_ACCEPTANCE_REPORT.md`
- Update: `artifacts/acceptance/ui-issue-inventory.json`

**Interfaces:**
- Consumes: Task 3 observed UI and issue inventory
- Produces: completed Journeys A-F and test-backed bounded fixes

- [ ] Execute Journeys A-F with before/action/after screenshots and visible outcomes.
- [ ] Verify official UI fallback with Mega unavailable, including health, task progress, plugins, restart/error/runtime status, settings, and safe controls.
- [ ] For every repair, add one automated test that reproduces the finding and run it to observe the expected failure.
- [ ] Implement the minimal repair, rerun the focused test to green, then run the entire repository suite.
- [ ] Repeat the affected visual flow and update the issue record with root cause, changed files, test, after screenshot, and final status.

### Task 5: Full regression, reports, self-review, and RC publication

**Files:**
- Create: `artifacts/acceptance/INTEGRATION_RC_REPORT.md`
- Update: `artifacts/acceptance/VISUAL_UI_AUDIT.md`
- Update: `artifacts/acceptance/INTERACTION_ACCEPTANCE_REPORT.md`
- Update: `artifacts/acceptance/ui-issue-inventory.json`

**Interfaces:**
- Consumes: Tasks 1-4 evidence and fixes
- Produces: a pushed RC head and final ready/not-ready decision

- [ ] Re-run all machine gates and package/build checks from a clean process environment; expect all applicable commands to pass.
- [ ] Re-launch the candidate and repeat visual smoke, Journeys A-F, official fallback, plugin behavior, persistence, fault isolation, and task observation.
- [ ] Review the complete main-to-RC diff against the spec, record all rulings and deferred minor issues, and confirm no unrelated generated data or secrets are tracked.
- [ ] Commit the final reports and evidence, push `dev/hns-integration-visual-rc1`, and verify remote SHA equals local HEAD.
- [ ] Verify terminal GitHub CI for the pushed RC when a workflow runs; otherwise report `NOT_RUN` with the exact workflow-trigger reason.
- [ ] Stop without changing main or creating a production tag and emit the required `HNS_INTEGRATION_RC_STATUS` block.
