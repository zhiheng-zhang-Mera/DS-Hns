# Hns Integration Visual RC1 Design

## Objective

Produce an independently reviewable Integration RC from remote `main` without changing `main` or creating a production tag. Candidate branch contents are admitted only after commit and diff review, and the result is accepted only through machine gates, a production-like package, a real isolated launch, visual interaction, user journeys, persistence, fault isolation, and task-observation checks.

## Isolation contract

The only repository is the clean clone at `D:\Hns-Integration-RC\repo`. All controllable temporary data, package caches, Electron caches, browser caches, build outputs, logs, screenshots, test artifacts, user data, runtime data, crash dumps, and downloads must remain beneath `D:\Hns-Integration-RC`. Environment redirection is process-scoped. Existing Hns installations, user configuration, Boss, Quant, and other workspaces are out of scope. A required project-level write to C: stops that step as `BLOCKED_BY_C_DRIVE_WRITE_POLICY`.

## Integration policy

Remote branches and tags are fetched before selection. Each candidate is classified as `INCLUDE`, `ALREADY_INCLUDED`, `SUPERSEDED`, or `EXCLUDE` from its actual commit graph and diff. Ancestor branches are not merged twice. Conflicts are resolved by preserving both compatible intents at the smallest semantic boundary; whole-file ours/theirs resolution is prohibited. The RC branch is `dev/hns-integration-visual-rc1` from remote `main` at `59d816b734bea1c20ff2fbd6244395fc715304fe`.

## Verification design

Repository-declared Node, Electron, package-management, and CI commands govern. Tests may not be skipped or weakened. A packaged or production-like build is preferred over a development launch. Runtime state uses dedicated D-drive paths and may not touch the installed product profile.

Visual acceptance uses real Windows UI interaction: capture, read, click/type, capture again, and judge the visible result. Coverage includes main navigation, official fallback surfaces, Mega, plugins, health, restart, account/status refresh, task state, settings, dialogs, errors, loading, empty states, resizing, and the six requested journeys. Source, DOM, accessibility data, and logs are supporting evidence, not substitutes for visible operation.

## Repair policy

Only evidenced, bounded repairs are allowed: dead controls, missing entries, state synchronization, feedback, crash isolation, layout, and plainly confusing copy. Each production-code repair begins with a failing automated regression test, then the minimal fix and full regression. Broad redesign is backlog-only.

## Deliverables and stop condition

Evidence is stored under `artifacts/acceptance`, including `VISUAL_UI_AUDIT.md`, `INTERACTION_ACCEPTANCE_REPORT.md`, `INTEGRATION_RC_REPORT.md`, `ui-issue-inventory.json`, screenshots, logs, and command results. The final RC commit is pushed to the RC branch. Work then stops without merging `main`; the only allowed overall conclusions are `HNS_INTEGRATION_RC_READY` and `HNS_INTEGRATION_RC_NOT_READY`.
