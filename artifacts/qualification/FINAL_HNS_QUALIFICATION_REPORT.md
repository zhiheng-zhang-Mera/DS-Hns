# DS-Hns final qualification report

**Current target-mode status: `HNS_FINALIZATION_BLOCKED`**

The current RC product candidate's 17 mandatory machine gates passed. The fresh-profile first-run dock overlap is no longer reproduced on this exact candidate. Two bounded live provider requests returned their expected visible answers, a separate bounded UI task wrote and read back a checkpoint and result, and the visible conversations/results restored after same-process navigation; this is not full task/recovery acceptance. An acceptance CLI guard now prevents the earlier unsupported-flag fall-through, and exact RC branch commit `965ca619a2fa32d927af922e13103403e8cfe0a4` passed terminal CI. Finalization remains blocked by three historical task-controlled C-drive write incidents (`C:\Users\15601\profiles\web`, `C:\Users\15601\AppData\Roaming\Electron`, and the default TEMP used by the unintended combined-acceptance invocation), incomplete restart/failure-retry/plugin journey, real reboot `NOT_RUN`, and the partial real wall-clock observation. The RC remains unmerged and untagged. The previously published `hns-production-v1` snapshot remains a separate historical record and is unchanged.

## Continuation evidence (2026-09-25)

- Product source remains `4ef9c0df149a6cecf1eaa17e50cee4b22271b810` / tree `816f513c98e40831f0e81f8567e72e6fd01adcd4`; latest CI-verified code/tooling commit on the RC is `965ca619a2fa32d927af922e13103403e8cfe0a4`. The only code/test change after the product candidate adds early help handling, invalid-argument rejection, and CLI regression tests; Electron app/product code is unchanged. This report/paper publication is documentation/evidence only and may advance the branch HEAD without changing that product identity.
- Local full-unit regression `2026-09-25T11-04-13-434Z-2f1e28d2` reported 2,031 tests, 2,029 passed, 0 failed, 2 defined optional skips; evidence consistency 1/1. This run was launched with `--allow-dirty` before commit, so its summary binds parent HEAD `7918812302e6173f7377f0575394d842526f0aa3` and not the patch. The exact committed tree then passed GitHub Actions run `36128669905` (3m48s); targeted CLI/Phase-C contract tests passed 4/4. Details and hashes: [`RC2_CLI_GUARD_REGRESSION_20260925.md`](RC2_CLI_GUARD_REGRESSION_20260925.md).
- A real visible UI task/checkpoint journey passed its bounded criteria: 5 tool calls wrote and read back D-rooted checkpoint/result files, and same-process navigation restored the UI cards. It does not establish long-task continuity, app restart/reboot, provider retry, or plugin workflow. Screenshots, file hashes and precise boundaries are in [`RC2_TASK_CHECKPOINT_JOURNEY_FOLLOWUP.md`](RC2_TASK_CHECKPOINT_JOURNEY_FOLLOWUP.md).
- The D-rooted wall-clock observer had 276 samples from `2026-09-25T06:59:04.9297139Z` through `2026-09-25T11:34:04.8947518Z` (4:34:59.965 by ISO timestamp subtraction), maximum gap 60.024 seconds, and no runtime-down, Electron-detached, Harness-not-ready, or status-error samples. However, every `elapsedSeconds` field is incorrectly zero: the encoded observer called `.NET Stopwatch.GetElapsedTime`, unavailable in Windows PowerShell `5.1.26100.9444`. The observer's DateTimeOffset stop condition and timestamps remain usable; disregard its `elapsedSeconds` field, derive duration from `atUtc`, and keep the run `IN_PROGRESS_PARTIAL` pending a full 24 hours and terminal audit. This newly found evidence-format defect is recorded as N48.
- Remote verification after push: RC branch head matched `965ca619...`; PR #5 remained open to `main`; `main` remained `8b91228628e9168cabd545f26f1320ba141561e0`; annotated tag object/peeled target remained `2d4aeeda945b410d3e35ad82b456f7b74de922fc` / `5dcde767020161f6f6c7a5fc3330bccaca1d14a3`.
- Paper lineage: the fixed history cutoff remains `e30d196` / 381 commits; audit at code/tooling head `965ca61` found 384 reachable commits, with two documentation refreshes and one CLI guard/test patch after the fixed cutoff. Stable patch IDs and classifications are in `docs/paper-material/data/commit-lineage.json`; none adds a research contribution.

## Current RC2 finalization (2026-09-25)

- Branch: `dev/hns-final-qualification-rc2`; exact source candidate `4ef9c0df149a6cecf1eaa17e50cee4b22271b810`; tree `816f513c98e40831f0e81f8567e72e6fd01adcd4`.
- Source delta: `4ef9c0d fix installer failure on missing required plugins`, limited to `scripts/install.ps1` and `tests/unit/installer-optional-plugins.test.js`. It fixes required-plugin installer fail-open behavior; no UI rewrite was made.
- Branch choices were based on commit/diff/ancestry review, not branch existence: `better-install`, `target-standby`, `dev/hns-integration-visual-rc1`, and documentation-only `codex/hns-final-evidence-docs` = `ALREADY_INCLUDED`; `try-auto`, `dev/runtime-ui-separation-v1`, and current reviewed RC2 source = `INCLUDE`; `SUPERSEDED` = none; `EXCLUDE` = none among reviewed heads. The evidence-docs branch is already an ancestor of fetched main through PR #3. Exact SHAs/bases are in the machine-readable report.
- Run `2026-09-25T04-37-57-947Z-f4caf3b3` was from fresh clone `D:\Hns-Cleanroom-Qualification-20260925-4ef9c0d-r2\repo`, SHA/tree exact, 17/17 mandatory gates, 0 mandatory failures. Unit tests: 2,029 total; 2,027 pass, 0 fail, 2 defined optional sample skips. UI harness: 134/134. Synthetic soak: 120/120. A later targeted `appearance-panel.test.js` regression run passed 18/18; it supplements, but does not alter, the immutable qualification run. The separate exact-candidate Phase C repeats were 1.902x, 1.887x, and 1.882x (min 1.882, median 1.887, max 1.902; population variance 0.0000722222), all above the unchanged 1.2 threshold. These are distinct from the historical `63eabc9` repeats and from the 1.873x primary combined-run measurement.
- Production-like package: fresh Standard install from repository-declared Node `v24.14.1` / npm `11.11.0`, 532 packages, installer `-NoLaunch`; official Electron runtime then launched separately. This is not a signed MSI claim.
- Combined acceptance: 52/52; primary Phase C was 17,565 ms baseline / 9,378 ms optimized (1.873x), same-host engineering measurement, not provider latency or comparative research evidence.
- Current remote PR #5 targets `main` and remains open. Earlier CI run `36120978009` passed at docs/evidence head `f59f0f1`; latest CI run `36128669905` passed at exact RC branch head `965ca619a2fa32d927af922e13103403e8cfe0a4`. Current `main` SHA `8b91228628e9168cabd545f26f1320ba141561e0` and `hns-production-v1` tag object/peeled target (`2d4aeeda…` / `5dcde767…`) were verified unchanged.

## Current visual/UI audit and journey

The exact-text exchange's visible Trace tab was opened and visually read with Codex Computer Use; the user prompt, D-rooted runtime-context workspace, request row, and exact assistant answer were visible. The screenshot is retained at `D:\qf\manual-journey-4ef9c0d\11-provider-trace-visible.jpg` with SHA-256 `8a4c3f97dc2ebeb12899078eff8f97e8d2e41a2d93c736aa066b0681e7a6cc4a`. This is supplementary trace rendering, not full Journey acceptance.

Codex Computer Use directly launched and visually inspected the exact candidate Electron app, read visible screens, clicked through the native D-drive folder picker, inspected Settings without changing values, and restarted the same isolated `DSH_USER_DATA_DIR`. The `workspace` selection reappeared after restart. A separate fresh r4 profile was then launched with the expanded opt-in dock and first-run disclosure visible together; the disclosure control remained unobscured, Continue was clicked after the UI became ready, and the workbench appeared with the dock still present. The System Orb was visibly clicked, its panel opened, `Healthy`/plugin counts and optional-host warnings were read, and Refresh updated the displayed status time. Two exact-candidate UI sessions submitted bounded non-sensitive requests to visible `DeepSeek-V41-Flash`: arithmetic returned `1109`, and an exact-text request returned `DS-Hns provider UI acceptance passed.`. Both conversations restored after same-process navigation, and the right-side Files panel showed the D-rooted isolated workspace. The additional screenshot is hash-bound on D: in [`RC2_VISIBLE_JOURNEY.md`](RC2_VISIBLE_JOURNEY.md). This does not verify a long task, durable checkpoint, plugin fault/recovery, provider failure/retry, or post-prompt app restart. During Computer Use recovery, a bare Electron launch also opened the bundled default-app shell; the shell was visibly closed, but it touched the existing shared C-drive Electron profile (recorded as a new storage blocker below). The current-candidate P2 remains verified not reproduced; the prior-source observation is preserved as historical evidence.

The direct journey remains `PARTIAL_NOT_FULL_ACCEPTANCE`: Settings search showed no `Health Scheduler` or `Plugin Market` matching rows (not evidence those runtime components are absent), and the reused-profile dock aggregate showed 27 loaded, 1 unhealthy, 1 off without identifying the unhealthy plugin. The fresh-profile disclosure replay passes for the exact candidate. Two visible live requests and same-process conversation navigation restoration passed. A third bounded task/checkpoint UI flow visibly persisted and read back one small result/checkpoint pair; session navigation restored its cards. Long-task continuity, post-prompt process restart, provider failure/retry, plugin workflows, and full journey remain `NOT_RUN`. No independent QA or other agent was used, as instructed.

A fourth bounded task phase was resumed in a **new conversation** in the same live candidate process. Codex Computer Use visibly read the second conversation's result, opened the session-2 Markdown in the app's side preview, and observed the checkpoint/report checks and narrow scope statement. Independent read-only disk verification found checkpoint `COMPLETE` with `next_step: null`, the prior report still has exactly four named phase rows, and the new session-2 note contains the observed pre-resume `PAUSED_FOR_RESUME` values. Hashes and exact limits are in [`RC2_TASK_CHECKPOINT_JOURNEY_FOLLOWUP.md`](RC2_TASK_CHECKPOINT_JOURNEY_FOLLOWUP.md). This raises only file-based cross-conversation continuity to a bounded pass; the candidate process was not restarted and provider identity remains unverified.

The exact-candidate wall-clock observer began at `2026-09-25T06:59:04.9297139Z` under `D:\qf\realwallclock-4ef9c0d-20260925`, with a one-minute cadence. At the earlier continuation audit (`2026-09-25T11:34:04.8947518Z`) it had 276 samples over 4:34:59.965 by timestamp subtraction; this is a historical report snapshot. A later audit at `2026-09-25T12:32:04.8994615Z` found 334 samples over 19,979.969748 seconds (5.55 hours), maximum sample gap 60.024453 seconds, and no runtime-down, Electron-detached, Harness-not-ready, or status-error samples. The latest process count was 8 and the observed count peak was 14; working set ranged from 733,114,368 to 1,392,148,480 bytes, private bytes from 665,014,272 to 1,077,383,168 bytes, and handles from 3,413 to 5,671. Peaks include transient test/UI processes and are not attributable solely to DS-Hns. **Telemetry limitation:** every `elapsedSeconds` field is 0 because this Windows PowerShell 5.1 observer called unavailable `.NET Stopwatch.GetElapsedTime`; derive time only from ISO-8601 sample timestamps. The observer's actual stop condition uses `DateTimeOffset`. Two provider UI requests and two short task/checkpoint journeys were not instrumented/correlated to samples. No long task, restart-persistence sweep, provider retry, plugin fault/recovery injection, reboot, or internal event-loop drift was measured. This remains partial, not 24-hour or full-soak acceptance.

Continuation audit at `2026-09-25T12:32:04.8994615Z` found observer PID 45664 still running. The cross-conversation checkpoint journey completed while the same candidate process remained live; it does not substitute for task persistence across process restart.

## Current blockers and storage

- `STORAGE-C-ELECTRON-DEFAULT-001` (open blocker): the raw clean-room `electron.exe` was invoked by Computer Use without the required app-directory argument while recovering the target window. It opened the bundled `default_app.asar` welcome page as PID 52872 (parent Computer Use PID 16060) and defaulted to `C:\Users\15601\AppData\Roaming\Electron`; the process had three Electron children and visibly displayed the default profile. The shared C directory pre-existed, but its files were written during the shell's lifetime (latest observed writes around `2026-09-25T08:47:48Z`). The shell was closed by its visible window control. No cleanup was attempted because the directory contains pre-existing shared/unrelated Electron data. This is a separate failed D-only audit event; the actual DS-Hns product window continued using the D-rooted configuration. Do not launch bare Electron again.

- `STORAGE-C-PROFILE-001` (open blocker): task-controlled profile data was created under `C:\Users\15601\profiles\web` after PowerShell's case-insensitive automatic `$HOME` variable shadowed a lowercase `$home`. After the user's explicit `允许`, one exact-path cleanup attempt was made and rejected by the execution policy (`Rejected(... blocked by policy)`); the path remains present (11 files, 6 subdirectories and 3 junctions targeting another D-drive workspace). No recursive deletion was retried because it could cross those junctions; the parent `C:\Users\15601\profiles` was untouched. All current controlled RC/cache/TEMP/userData/runtime/workspace/build/test/screenshot/observer roots are on D:, but overall D-only compliance remains false.
- `STORAGE-C-COMBINED-ACCEPTANCE-TEMP-001` (historical open D-only blocker): an unsupported `--help` argument fell through to the combined acceptance script's default A–E run while inherited `TEMP/TMP` pointed to `C:\Users\15601\AppData\Local\Temp`. The fixture used `os.tmpdir()` and created then removed its scratch during normal teardown; a later read-only check found no matching directories. The C-drive write event remains recorded (report SHA-256 `ce9856b380eec58846295b31fb31ab6d70dc19072bea7416ad010c66e802eba5`); the acceptance report is retained on D: and is not used as D-compliant qualification. Commit `965ca61` adds working `--help` and rejects unsupported/malformed flags before side effects; this prevents that misuse from recurring but cannot clear the old write or replace the required D-rooted TEMP/TMP setup for full A–E runs.
- `FQ-UI-DOCK-OVERLAP-001` is closed for the current candidate as `VERIFIED_CURRENT_CANDIDATE_NO_REPRODUCTION`: its older reproduction is retained in N43, while exact-candidate source/tests and the fresh r4 visible replay show a bounded official surface and unobscured Continue control. No code change or broad UI rewrite was needed. The inventory has 0 open P1/P2/P3 and 2 unconfirmed observations (`FQ-UI-SCHEDULER-COPY-001`, `FQ-PLUGIN-AGGREGATE-001`).
- Two bounded provider requests and one bounded task/checkpoint UI flow passed with same-process navigation restore. Full provider/task/recovery acceptance, long-task continuity, provider failure/retry, plugin workflow, and post-prompt process-restart persistence remain incomplete/`NOT_RUN`. Real Windows reboot remains `NOT_RUN` because the shipped resume bootstrap requires a C-profile autostart write outside the established D-only boundary; this is a D-only prerequisite limitation, not a global host-policy claim. The exact-candidate real wall-clock observation is `IN_PROGRESS_PARTIAL`, not accepted as a full 24-hour/task soak yet. No independent review, merge, or production-tag mutation was performed.
- Full run summary SHA-256: `fefb637055430b9446a0b5cecd87f6aec07b3cd4161f8fe5049460513fbbf557`; run artifact-index SHA-256: `76efc1454e514cca2fb4d6d8181017240b047800ee1bfec82be01affc514aa47`. The immutable r4 run's scoped post-test audit found 0 process leaks and 0 C project writes; three separately observed task-controlled C incidents remain open and are not erased by that narrower audit.
- Paper corpus now has 7 claim rows (6 bounded supported engineering claims, 1 explicitly unsupported comparator), 23 experiment/acceptance rows, 11 metrics, and 49 negative results. N49 records the shared Electron default-profile write that was already listed in this report but previously missing from the negative-result catalog. The preserved fixed history cutoff is 379 reachable commits at `d4d2e87`; the reviewed report-history extension at `e30d196` contains 381 reachable commits, 15 beyond the unchanged 366-commit production baseline (2 merges and 13 patch-distinct non-merges, including two documentation-only refreshes). These are catalog/history counts, not independent samples or research contributions; novelty remains unsupported.
- Qualification/run artifacts are SHA-256 hash-indexed; no digital signature is claimed. The owner specification requires consistent provenance and hashes, not a cryptographic signature.

## Structured blocker register

Each open blocker below records the observed fact, cause, code-fixability, why it remains open, exact evidence, and next executable action. A code fix that prevents recurrence does not erase a historical storage event.

### `STORAGE-C-PROFILE-001`

- **Observed fact:** `C:\Users\15601\profiles\web` remains with 11 files, 6 directories, and 3 junctions into another D-drive workspace. One exact-path cleanup attempt after explicit approval was rejected by execution policy.
- **Root cause:** PowerShell's case-insensitive automatic `$HOME` shadowed a lowercase task-scoped `$home`, so profile data landed on C:.
- **Code-fixable:** No for the historical write or policy-rejected cleanup; the variable-collision cause is understood, but the incident cannot be cleared by a product-code change.
- **Why it remains:** the OS rejected the one exact-path removal and the target contains junctions; no alternate shell/UI/move route was attempted. Overall D-only compliance is false.
- **Exact evidence:** `storageCompliance.cDriveControlledWriteIncident` in this report; `docs/paper-material/data/negative-results.json` N45–N46; C path above.
- **Next executable action:** the host execution-policy owner must provide an authorized removal mechanism or policy change. Then re-inventory that exact path and its junctions before any exact-target cleanup; do not route around the rejection.

### `STORAGE-C-ELECTRON-DEFAULT-001`

- **Observed fact:** raw candidate `electron.exe` opened `default_app.asar` as PID 52872 and updated the pre-existing shared `C:\Users\15601\AppData\Roaming\Electron` profile. The visible shell was closed; shared files were preserved.
- **Root cause:** UI recovery launched the Electron binary without its app-directory argument, so Chromium selected its default C-profile userData.
- **Code-fixable:** No for the historical writes or safe cleanup; this was a launch-procedure error, not a product-code change.
- **Why it remains:** the directory predates this run and contains unrelated/shared data, so deleting or restoring it would be unsafe. Global D-only compliance remains false.
- **Exact evidence:** `storageCompliance.cDriveAdditionalWriteIncident` in this report; `docs/paper-material/data/negative-results.json` N49; shared path above.
- **Next executable action:** retain the shared data and do not launch bare Electron again. Any future recovery must select the exact app/window from the visible app list and use its configured D-rooted app directories.

### `STORAGE-C-COMBINED-ACCEPTANCE-TEMP-001`

- **Observed fact:** the unintended default combined run created fixture scratch under inherited `C:\Users\15601\AppData\Local\Temp`; normal teardown removed it, but the historical C write remains.
- **Root cause:** an unsupported `--help` argument fell through to the A–E default and the process inherited C-rooted TEMP/TMP; the fixture uses `os.tmpdir()`.
- **Code-fixable:** recurrence is fixed by commit `965ca61` (help returns before side effects; unknown flags fail fast). The historical incident is not code-remediable.
- **Why it remains:** teardown/no-residue does not negate the recorded C write; that 52/52 run is excluded from D-only qualification.
- **Exact evidence:** `storageCompliance.cDriveCombinedAcceptanceTempIncident`; `runtime/acceptance/combined-acceptance.json` SHA-256 `ce9856b380eec58846295b31fb31ab6d70dc19072bea7416ad010c66e802eba5`; `docs/paper-material/data/negative-results.json` N47.
- **Next executable action:** only if rerunning full A–E, set and assert D-rooted `TEMP`/`TMP` before process launch; retain the old report as excluded historical evidence.

### `REAL_PROVIDER_FULL_JOURNEY_INCOMPLETE`

- **Observed fact:** two bounded visible provider requests, one same-process checkpoint task, and a separate-conversation file-checkpoint resume passed. Process-restart persistence, provider failure/retry, plugin workflow/fault recovery, and long-task continuity remain `NOT_RUN`.
- **Root cause:** prior runs exercised successful short tasks and file state, not the missing failure/restart scenarios; the 24-hour observer does not attribute app tasks or provider calls.
- **Code-fixable:** No source defect is currently identified; this is an acceptance-evidence gap.
- **Why it remains:** the exact app process remains attached to the active observer; no restart or injected provider/plugin fault has been run.
- **Exact evidence:** `RC2_TASK_CHECKPOINT_JOURNEY_FOLLOWUP.md`; D-drive files `rc2-task-resume.md`, `rc2-task-resume.checkpoint.json`, and `rc2-task-resume-session-2.md`; current Journey limitations in this report.
- **Next executable action:** after the observer's terminal sample/audit, run separate exact-candidate UI cases for multi-step task persistence across app restart, controlled provider failure/retry, and plugin fault/recovery, using D-only state and visible evidence. Keep each case `NOT_RUN` until executed.

### `REAL_REBOOT_NOT_RUN`

- **Observed fact:** no Windows reboot was performed; `REAL_REBOOT_ACCEPTANCE.json` remains `NOT_RUN`.
- **Root cause:** the shipped automatic-resume bootstrap writes `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`; its Startup alternative is inside the C-drive user profile. Neither is an established D-only mechanism.
- **Code-fixable:** No within the current D-only boundary; a compliant host-managed mechanism or an explicit exception for the named C-profile write is required.
- **Why it remains:** no registry/Startup mutation or reboot was made, and no global host-policy prohibition is inferred.
- **Exact evidence:** `artifacts/qualification/REAL_REBOOT_ACCEPTANCE.md` and `.json`; `enhancedQualification.realWindowsReboot` in this report.
- **Next executable action:** establish a host-managed D-compliant startup/resumption mechanism, or obtain explicit authorization for the exact C-profile autostart write; then run the durable checkpoint/reboot/exactly-once ceremony.

### `REALTIME_24H_SOAK_IN_PROGRESS_PARTIAL`

- **Observed fact:** exact-candidate observer PID 45664 has 342 samples from `2026-09-25T06:59:04.9297139Z` through `2026-09-25T12:40:04.8911002Z` (20,459.961386 seconds / 5.6833 hours by timestamps); no runtime-down, Electron-detached, Harness-not-ready, or status-error samples were recorded. It has not reached 24 hours. `elapsedSeconds` fields are all zero.
- **Root cause:** the observer's Windows PowerShell 5.1 runtime lacks `Stopwatch.GetElapsedTime`; its interval stop logic independently uses `DateTimeOffset`, and ISO timestamps remain usable.
- **Code-fixable:** the telemetry formatter is fixable for a future run, but the current observer instance cannot be retrofitted; do not restart or replace it mid-window.
- **Why it remains:** only 5.6833 hours are observed at this snapshot, and full task/provider/plugin soak, event-loop drift, and terminal audits are not covered by this liveness observer.
- **Exact evidence:** `D:\qf\realwallclock-4ef9c0d-20260925\real-wall-clock-samples.jsonl`; current snapshot in `continuation.realWallClock` in the JSON report; N48 in `docs/paper-material/data/negative-results.json`.
- **Next executable action:** leave PID 45664 untouched through its 24-hour stop boundary (`2026-09-26T06:59:04Z`), then independently verify the final sample and terminal process/storage audit using ISO-8601 timestamps. Report only liveness/resources as measured; run missing task/fault recovery cases separately.

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

On historical production candidate `63eabc9`, Phase C retained the original workload and 1.2 threshold. Three sequential repeats were 1.911x, 1.868x, and 1.919x (min 1.868, median 1.911, max 1.919; population variance 0.0005015556). The separate historical primary combined-run ratio was 1.897x. These single-host engineering measurements are not provider latency or comparative research evidence. Current candidate `4ef9c0d` repeats are reported separately in the current RC2 section above and in `artifacts/qualification/FINAL_PHASE_C_RERUNS_4EF9C0D.json`.

## Visual/UI audit and user journey

Codex Computer Use exercised a real visible Windows Electron application using screenshots, visual reading, and real clicks, including the native Windows directory picker. Historical candidate `63eabc9` Electron acceptance passed 131/131 and verified the selected D-drive workspace on disk. A separately documented complete journey used commit `dafd3bfff8db30f2aaf094e4a15ed41a2c1f9ce6`; direct comparison showed no diff under `app/`, `scripts/`, or `tests/` versus that historical candidate, so it is explicitly `PASS_PRODUCT_CODE_EQUIVALENT`, not exact-commit evidence for current candidate `4ef9c0d`.

That journey observed: native System Orb click and expansion; visible panel/account-section feedback; Scheduler `DISABLED → LOADED` with `HEALTHY`; four unique Plugin Market identities; optional Computer Use unavailability with Core unaffected; native picker selection of a D-drive workspace; real DeepSeek V41 Flash response `1109` to “37 times 29 plus 36”; and close/reopen using the same `DSH_USER_DATA_DIR`, reattaching to the same runtime and restoring the conversation. Private account screenshots remain local and are not published. Model-assisted theme generation was not run; the theme check used a deterministic interpreter.

## Issues and residual evidence limits

- Resolved RC1 P1/P2 findings: storage/process containment, installer/profile/runtime reconciliation, Phase C noise, canonical plugin rows, optional Computer Use copy, visible orb interaction, supervisor PID handoff, owned-window UIA behavior, and final evidence consistency. Details and evidence are in `artifacts/acceptance/FINAL_UI_ISSUE_INVENTORY.json` and the linked follow-up notes.
- Historical P2 `FQ-UI-DOCK-OVERLAP-001` reproduced on prior candidate `63eabc9`: with opt-in `DSH_MEGA_INTEGRATED_DOCK=1` and expanded dock, the dock covered most of the first-run disclosure Continue control, though an exposed portion remained clickable. Exact current candidate `4ef9c0d` was rechecked in a fresh profile and did not reproduce it; the current issue inventory has no open P1/P2/P3.
- Two observations remain unconfirmed/unclassified: Scheduler copy said “重启后生效” while loaded, with no proven state mismatch; an aggregate health view showed one unnamed unhealthy plugin. Neither is reported as a confirmed product defect, and the report does not claim all plugins are healthy.
- Real Windows reboot: `NOT_RUN`. The D-only post-boot continuation prerequisite was not established; no C-profile autostart write or reboot was performed. This is not a claim of a global host-policy prohibition.
- Historical `63eabc9` exact-candidate real 24-hour wall-clock run: `NOT_RUN`; its prior-SHA observer is not accepted for current RC2. Current candidate `4ef9c0d` has a separate real observer `IN_PROGRESS_PARTIAL` (latest audit: 342 samples through `2026-09-25T12:40:04.8911002Z`; elapsed time is derived from timestamps because the per-sample elapsed field is invalid); it has not completed 24 hours or the required task/recovery scenarios. Synthetic soak remains separately labelled.
- No comparative reliability, novelty, accessibility certification, cross-platform behavior, signed installer, universal production suitability, or live-provider theme-generation claim is made.

## Storage compliance

All controlled candidate checkout, npm cache, TEMP, userData, runtimeData, test artifact, and qualification output roots were on D:. The fresh post-merge smoke clone, dependency cache, TEMP, app/local-app data, runtime, test artifact, and userData roots were also on D:. The post-test project audit found zero candidate process leaks and zero detected project-shaped C-drive writes. `C:\Users\15601\.npmrc` was read for npm configuration but not modified. These are scoped project-write audits, not a claim that Windows made no ordinary system writes. The unrelated active observer is disclosed above and remains outside the candidate process-root acceptance.

## Evidence index and review

See [`FINAL_EVIDENCE_INDEX.md`](FINAL_EVIDENCE_INDEX.md) for artifact paths, SHA-256 bindings, CI links, and D/C storage locations. The paper corpus is indexed in [`docs/paper-material/PAPER_MATERIAL_INDEX.md`](../../docs/paper-material/PAPER_MATERIAL_INDEX.md); it retains the unsupported comparator claim and historical negative results rather than inflating the research claim count.

The final report/paper refresh was self-reviewed by the implementing Controller because the user expressly prohibited agents and delegated independent QA. This is not an independent reviewer verdict.
