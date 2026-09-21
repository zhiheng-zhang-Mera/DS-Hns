# DS-Hns Integration Visual RC1 Report

Date: 2026-09-22 (Australia/Sydney)

## Identity and scope

- Remote: `https://github.com/zhiheng-zhang-Mera/DS-Hns.git`
- Remote main: `59d816b734bea1c20ff2fbd6244395fc715304fe`
- RC branch: `dev/hns-integration-visual-rc1`
- Clean-clone root: `D:\Hns-Integration-RC\repo`
- Package manager: npm from `app/package-lock.json`; no package-manager substitution.
- Toolchain: portable Node 24.14.1, npm 11.11.0, Electron 43.4.0, dsh 0.1.5-rc.1.
- Main was not modified or merged. No production tag was created.

## Selective integration decisions

The exact commit graph, paths, CI observations, and semantic conflict resolutions are recorded in `branch-inventory.json`.

| Candidate | Head | Decision | Evidence/rationale |
| --- | --- | --- | --- |
| `origin/better-install` | `a5d89b9` | ALREADY_INCLUDED | Ancestor of both admitted lineages; a separate merge would duplicate history. |
| `origin/target-standby` | `5efa302` | ALREADY_INCLUDED | Ancestor of `try-auto`; required health/restart work arrives through that head. |
| `origin/try-auto` | `432cf43` | INCLUDE | Ancestor-complete long-host, fault-isolation, restart-status, and official-fallback work. |
| `origin/dev/runtime-ui-separation-v1` | `923f529` | INCLUDE | Independent runtime ownership/isolation work; three conflicts were resolved semantically and tested. |

No remote candidate branch was marked SUPERSEDED or EXCLUDE: only four non-main remote branches existed, two were included and two were already ancestors of included heads. The seven fetched checkpoint/review tags are ancestors of both included lineages and were inventory only, not merge candidates.

## Surgical repairs in this RC

1. Clean Node bootstrap requires npm beside a reusable Node runtime.
2. Real UIA top-level window lookup no longer waits for an unrelated descendant provider.
3. Restart Supervisor uses portable Node/shared state, covers the pid-file race, and refreshes first visible health.
4. Built-in `file:` dependencies are compared by their materialized package versions.
5. Command TEMP is same-volume but disjoint from the protected repository workspace.

Every current production repair has focused automated coverage. The second complete Qualification run passed after the last test-contract update.

## Machine gates

| Gate | Result | Evidence |
| --- | --- | --- |
| Qualification suite | PASS | 1892 tests; 1890 pass; 0 fail; 2 repository-defined skip; 578.2s |
| Architecture verifier | PASS | `VERIFY: ALL CHECKS PASSED` |
| Standard production-like installer | PASS WITH WARNING | 113/113 smoke tests; verifier pass; official UI/runtime and required plugins OK; optional Plugin Market contradiction remains |
| Computer Use long-run | PASS | 20/20 cases; 96 checks; 0 failures |
| Long-host chaos | PASS | 8 scenarios; 65 checks; 0 failures; real reboot explicitly NOT_RUN |
| Synthetic long-host soak | PASS | 6h/12h/24h; 120 checks; 0 failures |
| Combined acceptance final | FAIL | 50/51; Phase C 1.189x below 1.2x; all correctness/fault/section-150 checks otherwise pass |
| Isolated Phase C rerun | PASS, informational | 4/4; 1.212x; does not override the later failed full run |

Thresholds were not reduced and failed evidence was retained. The final machine gate is therefore FAIL.

## Production-like candidate and real startup

The repository declares no electron-builder/packager output. Its supported production-like candidate is the installed source checkout plus pinned Electron and portable runtime. The Standard installer reused only the new clone's D-drive dependencies, installed/verified required profile plugins, ran its deterministic test tier and verifier, and exited 0. The final candidate then launched as a real Electron process with isolated D-drive userData/runtime/log paths.

Final real process paths were under `D:\Hns-Integration-RC` for Electron and project Node processes. The official home and Settings -> Mega were captured after the final regression. Overall UI health was visible as Healthy with 0 pending/0 failing; required plugin versions were correct.

## Visual and interaction acceptance

- Real screenshots, clicking, typing, dialogs, restart persistence, failure isolation, and long-task observation were performed with Codex Computer Use.
- Journeys A, C, D, E, and F: PASS.
- Journey B: PARTIAL because Plugin Market showed duplicate rows.
- Official fallback: PARTIAL; core state and safe controls are reachable, but Computer Use is degraded and system-orb interaction is NOT_RUN.
- Detailed records: `VISUAL_UI_AUDIT.md`, `INTERACTION_ACCEPTANCE_REPORT.md`, and `ui-issue-inventory.json`.

## Storage compliance

- Repository, node_modules, portable Node, npm/Electron caches, task TEMP, app data, runtime state, logs, screenshots, tests, and reports are under `D:\Hns-Integration-RC`.
- Final command TEMP is `D:\Hns-Integration-RC\temp`, outside the Git workspace but on the same volume; this is required by the command sandbox.
- No project writes were found under the default Electron roaming/local profiles and `C:\Users\15601\.dsh` is absent.
- Final process auditing nevertheless found project test artifacts under `C:\Users\15601\AppData\Local\Temp`: runtime-bootstrap scratch roots, restart-supervisor scratch roots, and a `dsh-sub-worker-tests` path that explicitly derives from `LOCALAPPDATA`. One leaked runtime Host (PID 54124) used the D-drive portable Node with a C-drive test checkout/data root. It was stopped; its three generated files were removed, while empty directories remain because host policy rejected directory deletion.
- Codex's own PowerShell/UI automation runtime executes from C: as an uncontrollable orchestration/system component. It was not used as project workspace, cache, userData, or runtimeData.
- C-drive policy result: `BLOCKED_BY_C_DRIVE_WRITE_POLICY`. Cleanup does not retroactively convert the violation into a pass.

## Remaining issues and blockers

- P1 `RC1-GATE-001`: full combined acceptance failed the unchanged 1.2x performance threshold at 1.189x.
- P1 `RC1-INSTALL-002`: Standard installer says Plugin Market failed while the same profile UI says installed @0.4.7.
- P1 `RC1-STORAGE-001`: repository tests created controllable scratch/runtime data in the default C-drive Temp tree and leaked one host process.
- P2 `RC1-UI-002`: duplicate Plugin Market rows.
- P2 `RC1-UI-003`: Computer Use remains degraded without a host runtime.
- P3 `RC1-UI-004`: real system-orb expansion is NOT_RUN because the window was not targetable; no product failure is asserted.
- Real Windows reboot, cross-machine performance stability, and independent QA are NOT_RUN.

## Publication

The branch `dev/hns-integration-visual-rc1` was pushed and its remote SHA was compared with the local SHA. GitHub Actions is `NOT_RUN`: `.github/workflows/verify.yml` limits `push.branches` to `main`, `merging`, `better-install`, `target-standby`, `Theme-Cover`, `computer-use`, `long-term-work`, and `test-reboot`; the RC branch is not in that trigger list. No PR was created to manufacture a run.

## Final decision

The RC is suitable for owner review and independent QA, but it is not gate-ready because a mandatory machine threshold and an installer/UI state contradiction remain open.

`HNS_INTEGRATION_RC_NOT_READY`
