# DS-Hns final qualification report

**Current target-mode status: `HNS_FINALIZATION_BLOCKED`**

The current RC candidate's 17 mandatory machine gates passed. The fresh-profile first-run dock overlap is no longer reproduced on this exact candidate. A one-shot live provider arithmetic smoke returned `1109`, and the conversation was restored after same-process session navigation; this is not a full provider-Journey acceptance. Finalization remains blocked by the earlier task-controlled profile write under `C:\Users\15601\profiles\web`, incomplete full task/checkpoint coverage, and the partial real wall-clock observation. The RC candidate was not merged or tagged. The previously published `hns-production-v1` snapshot remains a separate historical record and is unchanged.

## Current RC2 finalization (2026-09-25)

- Branch: `dev/hns-final-qualification-rc2`; exact source candidate `4ef9c0df149a6cecf1eaa17e50cee4b22271b810`; tree `816f513c98e40831f0e81f8567e72e6fd01adcd4`.
- Source delta: `4ef9c0d fix installer failure on missing required plugins`, limited to `scripts/install.ps1` and `tests/unit/installer-optional-plugins.test.js`. It fixes required-plugin installer fail-open behavior; no UI rewrite was made.
- Branch choices were based on commit/diff/ancestry review, not branch existence: `better-install`, `target-standby`, `dev/hns-integration-visual-rc1`, and documentation-only `codex/hns-final-evidence-docs` = `ALREADY_INCLUDED`; `try-auto`, `dev/runtime-ui-separation-v1`, and current reviewed RC2 source = `INCLUDE`; `SUPERSEDED` = none; `EXCLUDE` = none among reviewed heads. The evidence-docs branch is already an ancestor of fetched main through PR #3. Exact SHAs/bases are in the machine-readable report.
- Run `2026-09-25T04-37-57-947Z-f4caf3b3` was from fresh clone `D:\Hns-Cleanroom-Qualification-20260925-4ef9c0d-r2\repo`, SHA/tree exact, 17/17 mandatory gates, 0 mandatory failures. Unit tests: 2,029 total; 2,027 pass, 0 fail, 2 defined optional sample skips. UI harness: 134/134. Synthetic soak: 120/120. A later targeted `appearance-panel.test.js` regression run passed 18/18; it supplements, but does not alter, the immutable qualification run.
- Production-like package: fresh Standard install from repository-declared Node `v24.14.1` / npm `11.11.0`, 532 packages, installer `-NoLaunch`; official Electron runtime then launched separately. This is not a signed MSI claim.
- Combined acceptance: 52/52; primary Phase C was 17,565 ms baseline / 9,378 ms optimized (1.873x), same-host engineering measurement, not provider latency or comparative research evidence.
- Current remote PR #5 targets `main` and remains open. CI run `36089577284` passed at exact source SHA `4ef9c0d`. Current `main` SHA `8b91228628e9168cabd545f26f1320ba141561e0` and `hns-production-v1` tag object/peeled target (`2d4aeeda…` / `5dcde767…`) were not changed by this work.

## Current visual/UI audit and journey

Codex Computer Use directly launched and visually inspected the exact candidate Electron app, read visible screens, clicked through the native D-drive folder picker, inspected Settings without changing values, and restarted the same isolated `DSH_USER_DATA_DIR`. The `workspace` selection reappeared after restart. A separate fresh r4 profile was then launched with the expanded opt-in dock and first-run disclosure visible together; the disclosure control remained unobscured, Continue was clicked after the UI became ready, and the workbench appeared with the dock still present. The System Orb was visibly clicked, its panel opened, `Healthy`/plugin counts and optional-host warnings were read, and Refresh updated the displayed status time. A later exact-candidate UI session submitted one generic arithmetic request to the visible `DeepSeek-V41-Flash` model, read `1109`, then navigated away and reopened the conversation; the prompt and answer remained. The screenshot is hash-bound on D: in [`RC2_VISIBLE_JOURNEY.md`](RC2_VISIBLE_JOURNEY.md). This verifies only one provider response and same-process session navigation, not the full requested workflow or post-prompt app restart. The current-candidate P2 remains verified not reproduced; the prior-source observation is preserved as historical evidence.

The direct journey remains `PARTIAL_NOT_FULL_ACCEPTANCE`: Settings search showed no `Health Scheduler` or `Plugin Market` matching rows (not evidence those runtime components are absent), and the reused-profile dock aggregate showed 27 loaded, 1 unhealthy, 1 off without identifying the unhealthy plugin. The fresh-profile disclosure replay passes for the exact candidate. The later live smoke verifies one response and same-process navigation restoration only; long-task/checkpoint continuity, post-prompt process restart, plugin/task workflows, and full journey remain `NOT_RUN`. No independent QA or other agent was used, as instructed.

The exact-candidate wall-clock observer began at `2026-09-25T06:59:04.8893045Z` under `D:\qf\realwallclock-4ef9c0d-20260925`, with a one-minute cadence. At the evidence snapshot (`2026-09-25T08:09:04.8920572Z`) it had 71 samples across 4,199.962 seconds; the Runtime Host, Harness, and Electron were attached and ready, with 8 candidate-owned processes. A separate one-shot UI provider smoke occurred during this interval, but was not instrumented or correlated to an observer sample; it is not a soak task. The observer remains partial: no long-running task, checkpoint-continuity sweep, plugin fault/recovery injection, or reboot was performed, and it cannot measure the application's internal event-loop drift. It is not yet 24-hour evidence or full soak acceptance.

## Current blockers and storage

- `STORAGE-C-PROFILE-001` (open blocker): task-controlled profile data was created under `C:\Users\15601\profiles\web` after PowerShell's case-insensitive automatic `$HOME` variable shadowed a lowercase `$home`. After the user's explicit `允许`, one exact-path cleanup attempt was made and rejected by the execution policy (`Rejected(... blocked by policy)`); the path remains present (11 files, 6 subdirectories). No alternate deletion route was attempted, and the parent `C:\Users\15601\profiles` was untouched. All current controlled RC/cache/TEMP/userData/runtime/workspace/build/test/screenshot/observer roots are on D:, but overall D-only compliance remains false until this incident is resolved.
- `FQ-UI-DOCK-OVERLAP-001` is closed for the current candidate as `VERIFIED_CURRENT_CANDIDATE_NO_REPRODUCTION`: its older reproduction is retained in N43, while exact-candidate source/tests and the fresh r4 visible replay show a bounded official surface and unobscured Continue control. No code change or broad UI rewrite was needed. The inventory has 0 open P1/P2/P3 and 2 unconfirmed observations (`FQ-UI-SCHEDULER-COPY-001`, `FQ-PLUGIN-AGGREGATE-001`).
- The single arithmetic provider smoke and same-process conversation navigation restoration passed; full provider/task/checkpoint journey and post-prompt process-restart persistence remain `NOT_RUN`. Real Windows reboot remains `NOT_RUN` because the shipped resume bootstrap requires a C-profile autostart write that is outside the established D-only boundary; this is a D-only prerequisite limitation, not a global host-policy claim. The exact-candidate real wall-clock observation is `IN_PROGRESS_PARTIAL`, not accepted as a full 24-hour/task soak yet. No independent review, merge, or production-tag mutation was performed.
- Full run summary SHA-256: `fefb637055430b9446a0b5cecd87f6aec07b3cd4161f8fe5049460513fbbf557`; run artifact-index SHA-256: `76efc1454e514cca2fb4d6d8181017240b047800ee1bfec82be01affc514aa47`. The current run's scoped post-test audit found 0 process leaks and 0 C project writes; this does not erase the separately recorded earlier C profile incident.
- Paper corpus now has 7 claim rows (6 bounded supported engineering claims, 1 explicitly unsupported comparator), 20 experiment/acceptance rows, 11 metrics, and 46 negative results. The full-ref history snapshot is 379 reachable commits at fixed cutoff `d4d2e87`, including the unchanged 366-commit production-baseline cutoff plus 13 later commits. These are catalog/history counts, not independent samples or research contributions; novelty remains unsupported.
- Qualification/run artifacts are SHA-256 hash-indexed; no digital signature is claimed. The owner specification requires consistent provenance and hashes, not a cryptographic signature.

---

The following retained release sections describe the prior `63eabc9` candidate and tag snapshot only; they are not qualification evidence for current RC candidate `4ef9c0d`.

### Qualified and released identity (historical snapshot)

## Qualified and released identity

- Candidate branch: `dev/hns-final-qualification-rc2`
- Exact qualified candidate: `63eabc9a9341abd2e612bf603e3ce340eaa2cc57`
- Candidate tree: `8e6884e6b25bb3989509bd9d623dca4c0abb2bf1`
- Immutable qualification run: `2026-09-24T06-54-31-334Z-09571b4b`, from a fresh remote clone at `D:\HnsQ24\qualification-rerun-63eabc9\clean-room`
- PR #2: [Final qualify DS-Hns production baseline](https://github.com/zhiheng-zhang-Mera/DS-Hns/pull/2), merged 2026-09-24 07:54:07 UTC
- Product-release merge/main SHA: `5dcde767020161f6f6c7a5fc3330bccaca1d14a3`; its tree `8e6884e6b25bb3989509bd9d623dca4c0abb2bf1` exactly equals the candidate tree
- Production tag: `hns-production-v1`; annotated tag object `2d4aeeda945b410d3e35ad82b456f7b74de922fc`, peeled target `5dcde767020161f6f6c7a5fc3330bccaca1d14a3`
- Candidate CI run `35953056840` and merge/main CI run `35972160064` both completed successfully. The post-merge clone smoke also passed.

This report and the refreshed paper corpus are delivered after the production tag in a documentation-only follow-up. The product release identity remains the candidate/tree above and tag target `5dcde76`; the report does not move the tag. The final evidence index records the distinction between the product release and report publication.

## Branch selection and history disposition

The full fetched project history contained 366 reachable commits at the qualified product baseline. Branch tips were read against their commits/diffs and release ancestry; branch existence alone was not treated as merge evidence.

| Branch | Head | Disposition | Basis |
|---|---|---|---|
| `better-install` | `a5d89b9ae63a8eb996e3cb6be521aadd7cbcc7b6` | `ALREADY_INCLUDED` | Head is an ancestor of release main. |
| `target-standby` | `5efa302acd381d57d44bc87bbdc36f80a21dda9a` | `ALREADY_INCLUDED` | Head is an ancestor of release main. |
| `try-auto` | `432cf431f2b40843ab3ec5287ffd7e5296cb6626` | `INCLUDE` | Reviewed commits contribute to the candidate; head is an ancestor of release main. |
| `dev/runtime-ui-separation-v1` | `923f5293a2ada553cb7f91a4bc1b54e750dfe7c3` | `INCLUDE` | Reviewed commits contribute to the candidate; head is an ancestor of release main. |
| `dev/hns-integration-visual-rc1` | `2ae08a73ee3e7b32b31e7e84a4dfe8ab49ebaa1d` | `ALREADY_INCLUDED` | Head is an ancestor of the candidate/release main. |
| `dev/hns-final-qualification-rc2` | `63eabc9a9341abd2e612bf603e3ce340eaa2cc57` | `INCLUDE` | Qualified candidate was merged through PR #2. |

`SUPERSEDED`: none. `EXCLUDE`: none among the reviewed release branch heads. These labels describe branch disposition, not a claim that every commit on a branch is a distinct contribution. Patch-equivalent commits and merge commits are deduplicated in the paper lineage.

## Machine qualification and package

The single fresh-clone local-host run passed all 17 mandatory gates under one runId, SHA, and tree: 17 passed, 0 failed. It is counted once, not presented as separate local and clean-room replications.

| Gate | Result |
|---|---:|
| Syntax check | PASS |
| Unit suite | 2,004 total: 2,002 passed, 0 failed, 2 defined optional skips |
| Architecture verifier | PASS |
| External fixtures | 3/3 |
| Install pipeline | 46/46 |
| Cordis adapter | 66/66 |
| Process adapter | 33/33 |
| Native HNS adapter | PASS |
| Health/restart continuity | PASS |
| Community installer | PASS |
| Electron UI acceptance | 131/131 |
| Computer Use long-run harness | 96/96 (bounded harness, not a human 24-hour run) |
| Chaos acceptance | 65/65 (injected faults) |
| Synthetic soak | 120/120 (virtual-time synthetic evidence) |
| Combined acceptance | 52/52; primary Phase C ratio 1.897x (17,325 ms / 9,131 ms) |
| Post-test audit | 2/2 guards; 0 candidate process leaks and 0 detected C-drive project writes |
| Evidence consistency | 1/1 |

The two unit skips are repository-defined optional sample-dependent checks; the referenced optional sample packages were absent in this fresh checkout. They did not count as mandatory failures. Their status is not silently converted to a pass.

The production-like package path is the repository-declared Standard PowerShell installer/bootstrap plus unpacked Electron runtime. The exact Standard install transcript is hash-indexed and was run with `-NoLaunch`; it is not itself the Electron launch evidence. Electron was separately launched from the isolated candidate clone. This repository does not declare a signed MSI or electron-builder release artifact, and none is claimed.

Phase C retained the original workload and 1.2 threshold. Three additional sequential exact-candidate repeats were 1.911x, 1.868x, and 1.919x (min 1.868, median 1.911, max 1.919, population variance 0.0005015556); all exceeded threshold. These are single-host engineering measurements, not provider latency or comparative research evidence.

## Visual/UI audit and user journey

Codex Computer Use exercised a real visible Windows Electron application using screenshots, visual reading, and real clicks, including the native Windows directory picker. The exact-candidate Electron acceptance passed 131/131 and verified the selected D-drive workspace on disk. A separately documented complete journey used commit `dafd3bfff8db30f2aaf094e4a15ed41a2c1f9ce6`; direct comparison showed no diff under `app/`, `scripts/`, or `tests/` versus the exact candidate, so it is explicitly `PASS_PRODUCT_CODE_EQUIVALENT`, not exact-commit evidence.

That journey observed: native System Orb click and expansion; visible panel/account-section feedback; Scheduler `DISABLED → LOADED` with `HEALTHY`; four unique Plugin Market identities; optional Computer Use unavailability with Core unaffected; native picker selection of a D-drive workspace; real DeepSeek V41 Flash response `1109` to “37 times 29 plus 36”; and close/reopen using the same `DSH_USER_DATA_DIR`, reattaching to the same runtime and restoring the conversation. Private account screenshots remain local and are not published. Model-assisted theme generation was not run; the theme check used a deterministic interpreter.

## Issues and residual evidence limits

- Resolved RC1 P1/P2 findings: storage/process containment, installer/profile/runtime reconciliation, Phase C noise, canonical plugin rows, optional Computer Use copy, visible orb interaction, supervisor PID handoff, owned-window UIA behavior, and final evidence consistency. Details and evidence are in `artifacts/acceptance/FINAL_UI_ISSUE_INVENTORY.json` and the linked follow-up notes.
- Open P2 `FQ-UI-DOCK-OVERLAP-001`: with opt-in `DSH_MEGA_INTEGRATED_DOCK=1` and expanded dock, the dock covers most of the first-run disclosure Continue control, though an exposed portion remained clickable. Default hidden-dock startup was not implicated. Safely correcting this requires a bounded official-surface layout change and renewed qualification; no speculative CSS/pixel-offset patch was made.
- Two observations remain unconfirmed/unclassified: Scheduler copy said “重启后生效” while loaded, with no proven state mismatch; an aggregate health view showed one unnamed unhealthy plugin. Neither is reported as a confirmed product defect, and the report does not claim all plugins are healthy.
- Real Windows reboot: `NOT_RUN`. The D-only post-boot continuation prerequisite was not established; no C-profile autostart write or reboot was performed. This is not a claim of a global host-policy prohibition.
- Exact-candidate real 24-hour wall-clock run: `NOT_RUN`. A prior-SHA observer remains running and is deliberately not stopped, but it has a different SHA and a process-root mismatch, so it is not accepted as current-candidate evidence. Synthetic soak remains separately labelled.
- No comparative reliability, novelty, accessibility certification, cross-platform behavior, signed installer, universal production suitability, or live-provider theme-generation claim is made.

## Storage compliance

All controlled candidate checkout, npm cache, TEMP, userData, runtimeData, test artifact, and qualification output roots were on D:. The fresh post-merge smoke clone, dependency cache, TEMP, app/local-app data, runtime, test artifact, and userData roots were also on D:. The post-test project audit found zero candidate process leaks and zero detected project-shaped C-drive writes. `C:\Users\15601\.npmrc` was read for npm configuration but not modified. These are scoped project-write audits, not a claim that Windows made no ordinary system writes. The unrelated active observer is disclosed above and remains outside the candidate process-root acceptance.

## Evidence index and review

See [`FINAL_EVIDENCE_INDEX.md`](FINAL_EVIDENCE_INDEX.md) for artifact paths, SHA-256 bindings, CI links, and D/C storage locations. The paper corpus is indexed in [`docs/paper-material/PAPER_MATERIAL_INDEX.md`](../../docs/paper-material/PAPER_MATERIAL_INDEX.md); it retains the unsupported comparator claim and historical negative results rather than inflating the research claim count.

The final report/paper refresh was self-reviewed by the implementing Controller because the user expressly prohibited agents and delegated independent QA. This is not an independent reviewer verdict.
