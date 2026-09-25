# Final evidence index

## Current target-mode RC2 snapshot — 2026-09-25

Current terminal status: `HNS_FINALIZATION_BLOCKED`. Exact source candidate `4ef9c0df149a6cecf1eaa17e50cee4b22271b810` / tree `816f513c98e40831f0e81f8567e72e6fd01adcd4`, branch `dev/hns-final-qualification-rc2`. It is not merged or tagged. PR #5 remains open to `main`; source-code CI run `36089577284` succeeded at this candidate. `main` remained `8b91228628e9168cabd545f26f1320ba141561e0`; the existing `hns-production-v1` tag object/target remained `2d4aeeda945b410d3e35ad82b456f7b74de922fc` / `5dcde767020161f6f6c7a5fc3330bccaca1d14a3`.

| Evidence | Path | SHA-256 / result |
|---|---|---|
| Immutable qualification summary | `D:\qf\qualification-4ef9c0d-r4\qualification\qualification-runs\2026-09-25T04-37-57-947Z-f4caf3b3\qualification-summary.json` | `fefb637055430b9446a0b5cecd87f6aec07b3cd4161f8fe5049460513fbbf557`; 17/17 mandatory gates, 0 failures |
| Run artifact index | `D:\qf\qualification-4ef9c0d-r4\qualification\qualification-runs\2026-09-25T04-37-57-947Z-f4caf3b3\artifact-index.json` | `76efc1454e514cca2fb4d6d8181017240b047800ee1bfec82be01affc514aa47` |
| Fresh Standard install | `D:\qf\cleanroom-4ef9c0d-r2\standard-cold-install.transcript.txt` | `cb880d86c3be993497b65ff57eea84775d66582f4f0f717842b2bd9fdc9d1a0e`; 532 packages; Standard install PASS, `-NoLaunch` |
| Electron UI child | `D:\qf\qualification-4ef9c0d-r4\qualification\qualification-runs\2026-09-25T04-37-57-947Z-f4caf3b3\reports\electron-ui-acceptance.json` | `b28dad51ca15f1f66390ee0e562278d7435075fba799618cc04ff30e6f58cf4d`; 134/134 |
| Current-run post-test audit | `D:\qf\qualification-4ef9c0d-r4\qualification\qualification-runs\2026-09-25T04-37-57-947Z-f4caf3b3\reports\post-test-audit.json` | `dcd74c129902de8537801bae9bf06f9d5dd21d5ff5229f27ef4099e6daf19a648`; 0 candidate leaks, 0 C project writes in that run |
| Direct visible journey | `artifacts/qualification/RC2_VISIBLE_JOURNEY.md` | `PARTIAL_NOT_FULL_ACCEPTANCE`; fresh-profile first-run dock replay passes; one live arithmetic request returned `1109` and same-process conversation navigation restored it; full journey remains incomplete |
| Current-candidate provider smoke screenshot | `D:\qf\rc2-current-candidate-visual-journey-4ef9c0d-20260925\01-provider-response-restored-session.jpg` | `30649C3245655FC3DB0F8B7B446E5261653268833FB9CD92D5A20157550DDCF2`; prompt and `1109` response visible after session navigation/reopen |
| Workbench screenshot | `D:\qf\manual-journey-4ef9c0d\08-workbench-after-plugin-search.jpg` | `c1480437dc38c048e50b583f33cf2fec93846338cdeed26c110f287a6d25c82d` |
| Integrated Mega screenshot | `D:\qf\manual-journey-4ef9c0d\09-mega-dock-open-after-shortcut.jpg` | `ffad38ca77717cb268781caac201c5429e2028a9adfee51418f38038df8f6a1f` |
| Fresh first-run + expanded dock | `D:\qf\fresh-dock-probe-4ef9c0d-20260925-r4\screenshots\01-first-run-expanded-dock.jpg` | `2590F19B634248C2E1F8F58025C7BFB87D5DAAFF112A8AB46433580674B3170A`; Continue unobscured |
| Workbench after Continue | `D:\qf\fresh-dock-probe-4ef9c0d-20260925-r4\screenshots\02-workbench-after-continue.jpg` | `658122A29F044D814AB2A0C185FAEC3FA930ECBB0B8A97A8D744B1DA940F1CD2` |
| Orb before click | `D:\qf\fresh-dock-probe-4ef9c0d-20260925-r4\screenshots\03-system-orb-closed.jpg` | `7C8E7C0D9A876171A485F84D7566281CF602B942D1E5E19E52D9C52E4A38AA90` |
| Orb expanded view | `D:\qf\fresh-dock-probe-4ef9c0d-20260925-r4\screenshots\04-system-orb-open-0.jpg` | `EEBCA668229B17ECFD9CD1AA523D7A48427638FD1C4854568607DE3E3723B47B` |
| Orb panel capture | `D:\qf\fresh-dock-probe-4ef9c0d-20260925-r4\screenshots\04-system-orb-open-1.jpg` | `761FB0673B12FD11004C1CB37DD32994EDB06AC9463E64AF51AFB20B88DBDA6BE` |
| Orb after Refresh | `D:\qf\fresh-dock-probe-4ef9c0d-20260925-r4\screenshots\05-system-orb-after-refresh.jpg` | `09442CE1401857139CE190B8F666F5C0147EF8C6EA652B252DE4AFD3C461D741` |
| Targeted appearance-panel tests | `D:\qf\fresh-dock-probe-4ef9c0d-20260925-r4\reports\appearance-panel-test.stdout.txt` | `E92601DBB6E893D97DA98CB3E7848B1856E7545976A882D1044AA0418AC5BCB1`; 18/18 |
| Current UI issue inventory | `artifacts/acceptance/FINAL_UI_ISSUE_INVENTORY.json` | `B08F9724253C0D1011D1D25A3946C48939B24E052900F5CC0B8E7D42FE79169B`; 0 open P1/P2/P3; 2 unconfirmed |
| Exact-candidate 24-hour observation | `artifacts/qualification/REALTIME_24H_SOAK.json` + `D:\qf\realwallclock-4ef9c0d-20260925\real-wallclock-samples.jsonl` | `IN_PROGRESS_PARTIAL`; 71 samples over 4,199.962 seconds at snapshot `2026-09-25T08:09:04.8920572Z`; runtime/Electron/Harness ready; liveness/resources only; separate one-shot smoke was not attributed to observer telemetry |
| Full repository-history snapshot | `docs/paper-material/01-COMMIT-TIMELINE.md` + `docs/paper-material/data/commit-lineage.json` | 379 reachable commits at fixed cutoff `d4d2e875`; 13 after 366-commit production merge, including 2 merges and 11 distinct non-merge patch-ids |

The current-run post-test audit is scoped to the r4 run and does not erase `STORAGE-C-PROFILE-001`: earlier in this task, the controlled profile path `C:\Users\15601\profiles\web` was created due PowerShell's case-insensitive `$HOME` name collision. After the user's explicit `允许`, one exact-path cleanup attempt was rejected by the execution policy (`Rejected(... blocked by policy)`); the path remains (11 files, 6 subdirectories), and no alternate deletion route was used. Overall D-only storage compliance is therefore `false`, despite all other controlled RC roots/artifacts being on D:.

Additional blockers and unrun limits: one generic live provider prompt returned `1109` and same-process session navigation restored it, but full task/checkpoint journey and post-prompt process-restart persistence remain `NOT_RUN`; real reboot `NOT_RUN` because the shipped D-only resume prerequisite is unmet; the exact-candidate wall-clock observer is partial and not accepted as a full 24-hour/task soak; no independent reviewer; no merge or production-tag mutation. Current P2 `FQ-UI-DOCK-OVERLAP-001` is verified not reproduced on exact candidate; two other observations remain unconfirmed. See `FINAL_HNS_QUALIFICATION_REPORT.md` and the current machine-readable report for exact boundaries. The paper catalog contains 20 experiment/acceptance rows and 46 negative results, including the r3 picker timeout and C-path incident.

The remainder of this file retains the previous `63eabc9` release evidence as a historical snapshot. It is not current RC2 evidence.

The machine-readable evidence map is [`FINAL_EVIDENCE_INDEX.json`](FINAL_EVIDENCE_INDEX.json). Candidate identity is `63eabc9a9341abd2e612bf603e3ce340eaa2cc57` / tree `8e6884e6b25bb3989509bd9d623dca4c0abb2bf1`. PR #2 merged it as `5dcde767020161f6f6c7a5fc3330bccaca1d14a3`, preserving exactly the qualified tree; `hns-production-v1` points to that merge commit. The report/paper follow-up is documentation-only and does not move the production tag.

## Candidate run artifacts

All candidate qualification artifacts are under `D:\HQR\qualification-runs\2026-09-24T06-54-31-334Z-09571b4b\`. The run index SHA-256 binds every file in that immutable run.

| Evidence | Path | SHA-256 / result |
|---|---|---|
| Qualification summary | `D:\HQR\qualification-runs\2026-09-24T06-54-31-334Z-09571b4b\qualification-summary.json` | `b0c76898e96cfc6ef1076913114892786090e7c9b2842b63a026943f42f94a99` |
| Run artifact index | `D:\HQR\qualification-runs\2026-09-24T06-54-31-334Z-09571b4b\artifact-index.json` | `8679cd6a04935de4113672c657cdd108c131300c490bdaadb2969780e5e987ea` |
| Unit stdout | `D:\HQR\qualification-runs\2026-09-24T06-54-31-334Z-09571b4b\raw\all-unit-tests.stdout.txt` | `d39684f59e96f63a77ab93dcd93e26e4bdd2762e3b19965562e81c4dc6418174` |
| Combined acceptance | `D:\HQR\qualification-runs\2026-09-24T06-54-31-334Z-09571b4b\reports\combined-acceptance.json` | `d4965d88e3bfc8987c3b8c1aa27c65cc259bdf54493ea60f3983863d4858378b`; 52/52; primary Phase C 1.897x |
| Electron UI acceptance | `D:\HQR\qualification-runs\2026-09-24T06-54-31-334Z-09571b4b\reports\electron-ui-acceptance.json` | `19ecc7f7592371e897927acfcb815242a14bfa39c967a1a379d826201dfe7cbf`; 131/131 |
| Evidence consistency | `D:\HQR\qualification-runs\2026-09-24T06-54-31-334Z-09571b4b\reports\evidence-consistency.json` | `80630c37709d7c183b9690b441eb7eb7b939594e9f33b126028519a0bf77e572`; 1/1 |
| Post-test process/storage audit | `D:\HQR\qualification-runs\2026-09-24T06-54-31-334Z-09571b4b\reports\post-test-audit.json` | `70a3eba5628b7c3f6240e8e02c20135ab720aa9a0dcd2c892288ddfb0023704f`; 0 candidate leaks / 0 detected C project writes |
| Standard installer transcript | `D:\HnsQ24\qualification-rerun-63eabc9\standard-install-valid.log` | `50efd6be62bdef850927add13e508844807a318973686da23c819dd4a95b6d36`; PASS, `-NoLaunch` |
| Three extra Phase C repeats | `artifacts/qualification/FINAL_PHASE_C_RERUNS.json` | `185e8b70e3213b32b1ff451937388421acfe6bfedf2307b2150bbef54786393a` |

The local-host full matrix used one immutable run from a fresh remote clone. It is intentionally not double-counted as two independent replications.

Historical failures remain in the repository and were not promoted to final evidence. In particular, Cleanroom9 is an older candidate (`9900555`) and its initial marker journey was later contaminated by an unsafe global-input helper from a concurrent machine gate; neither that journey nor its failed full run is a final certificate. See `NATIVE_PICKER_SAFETY_FOLLOWUP.md` and the retained qualification history.

## Visual journey and issue evidence

| Evidence | Path | SHA-256 / boundary |
|---|---|---|
| Complete Computer Use journey narrative | `artifacts/qualification/FINAL_JOURNEY_EVIDENCE.md` | `3491c067228e8f270157660001de4bb6de322c5972c46f11495b2c902159b6d3`; journey commit is product-code-equivalent, not exact SHA |
| Journey source observations | `D:\HnsQ24\journey-dafd3bf\JOURNEY_DAFD3BF.md` | `01127ca4c34781b1efe8aaa09d43b5eb48b976f12add48ca4ac39a3067b54d9e` |
| Reopened conversation screenshot | `D:\HnsQ24\journey-dafd3bf\conversation-reopened-main.jpg` | SHA-256 `922bc094dc75502580b8e9bf716e37e00c28fcc00bdff5bba9ed9cea2a8be0d7`; private account screenshots `orb-account-*.jpg` are not published |
| Open integrated-dock P2 triage | `D:\HnsQ24\journey-dafd3bf\OPT_IN_DOCK_P2_TRIAGE.md` | `c7346f3d8b58fc408edfa30b3bf29ce820be0f769e4e2b1e89fbd9c1049f7515` |
| Historical UI issue inventory at prior source snapshot | `artifacts/acceptance/FINAL_UI_ISSUE_INVENTORY.json` as preserved in the earlier report commit | `6c4040a2ef50074b7307bfeba5b8abe7e06a5b3a9ea9e885849820d84cc3e880`; at that snapshot 0 open P1, 1 open P2, 2 unconfirmed; not the current inventory |

Codex Computer Use used the real visible Electron window and native Windows picker, including screenshot inspection, visual reading, and clicks. The precise evidence split is in `FINAL_HNS_QUALIFICATION_REPORT.md`; screenshots containing private account data remain on D: and are excluded from publication.

## Post-merge and enhanced-evidence records

| Evidence | Path | SHA-256 / result |
|---|---|---|
| Fresh-main post-merge smoke JSON | `D:\HQR\post-merge-5dcde76\POST_MERGE_SMOKE.json` | `ca4e92f71b93703371a32116014323f534a3df6d13b993a9ace044a807395972`; clean clone at merge SHA |
| Post-merge syntax output | `D:\HQR\post-merge-5dcde76\post-merge-syntax.log` | `cecd9cd5885175cf71f5fbd3aceb204f7a4e1db028bf0f726885f040fde3258f`; 284/284 |
| Real reboot record | `artifacts/qualification/REAL_REBOOT_ACCEPTANCE.json` | `30985a55cad20213087bb2daaa641c57e15c15648491bfa2428defb1aaf5b9d8`; `NOT_RUN`, no global host ban inferred |
| Real 24-hour record | `artifacts/qualification/REALTIME_24H_SOAK.json` | current exact-candidate observer in progress; one-minute real host sampling, no task/provider/recovery acceptance yet |

## Remote publication evidence

- [PR #2](https://github.com/zhiheng-zhang-Mera/DS-Hns/pull/2): candidate qualification merge.
- [Candidate CI run 35953056840](https://github.com/zhiheng-zhang-Mera/DS-Hns/actions/runs/35953056840): success at exact candidate SHA.
- [Main merge CI run 35972160064](https://github.com/zhiheng-zhang-Mera/DS-Hns/actions/runs/35972160064): success at exact release merge SHA.
- Production tag `hns-production-v1` peels to `5dcde767020161f6f6c7a5fc3330bccaca1d14a3`.

## D/C storage audit

Candidate checkout, run artifacts, npm cache, TEMP, runtimeData, userData, and test roots were placed on D:. Post-merge clone/install/cache/temp/runtime/userData/test outputs were also under `D:\HQR\post-merge-5dcde76`. The named-project C-write gate passed with zero detected writes; `C:\Users\15601\.npmrc` was read-only configuration input. This audit is scoped to project-shaped writes and does not claim zero ordinary OS writes. The active observer PID 13896 is a separate prior-SHA process with a mismatched declared root; it is not candidate acceptance evidence and was not stopped.

The [paper-material index](../../docs/paper-material/PAPER_MATERIAL_INDEX.md) links the historical 366-commit release snapshot, the fixed 379-commit full-history cutoff, separate current RC2 branch/run disposition, bounded claims, 20 experiments/acceptance rows, 11 metrics, and 46 negative results. Historical failures and unsupported comparator claims remain visible.
