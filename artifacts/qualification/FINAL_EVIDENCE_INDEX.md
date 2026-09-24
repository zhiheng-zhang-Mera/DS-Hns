# Final evidence index

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
| Reopened conversation screenshot | `D:\HnsQ24\journey-dafd3bf\conversation-reopened-main.jpg` | retained locally; private account screenshots `orb-account-*.jpg` are not published |
| Open integrated-dock P2 triage | `D:\HnsQ24\journey-dafd3bf\OPT_IN_DOCK_P2_TRIAGE.md` | `c7346f3d8b58fc408edfa30b3bf29ce820be0f769e4e2b1e89fbd9c1049f7515` |
| Current UI issue inventory | `artifacts/acceptance/FINAL_UI_ISSUE_INVENTORY.json` | `6c4040a2ef50074b7307bfeba5b8abe7e06a5b3a9ea9e885849820d84cc3e880`; 0 open P1, 1 open P2, 2 unconfirmed |

Codex Computer Use used the real visible Electron window and native Windows picker, including screenshot inspection, visual reading, and clicks. The precise evidence split is in `FINAL_HNS_QUALIFICATION_REPORT.md`; screenshots containing private account data remain on D: and are excluded from publication.

## Post-merge and enhanced-evidence records

| Evidence | Path | SHA-256 / result |
|---|---|---|
| Fresh-main post-merge smoke JSON | `D:\HQR\post-merge-5dcde76\POST_MERGE_SMOKE.json` | `ca4e92f71b93703371a32116014323f534a3df6d13b993a9ace044a807395972`; clean clone at merge SHA |
| Post-merge syntax output | `D:\HQR\post-merge-5dcde76\post-merge-syntax.log` | `cecd9cd5885175cf71f5fbd3aceb204f7a4e1db028bf0f726885f040fde3258f`; 284/284 |
| Real reboot record | `artifacts/qualification/REAL_REBOOT_ACCEPTANCE.json` | `30985a55cad20213087bb2daaa641c57e15c15648491bfa2428defb1aaf5b9d8`; `NOT_RUN`, no global host ban inferred |
| Real 24-hour record | `artifacts/qualification/REALTIME_24H_SOAK.json` | `8cd0d83d337b4967c9aef59cb8bb2abf813342bdfb39045e163d3b7294b7a641`; `NOT_RUN`; prior-SHA observer not accepted and deliberately left running |

## Remote publication evidence

- [PR #2](https://github.com/zhiheng-zhang-Mera/DS-Hns/pull/2): candidate qualification merge.
- [Candidate CI run 35953056840](https://github.com/zhiheng-zhang-Mera/DS-Hns/actions/runs/35953056840): success at exact candidate SHA.
- [Main merge CI run 35972160064](https://github.com/zhiheng-zhang-Mera/DS-Hns/actions/runs/35972160064): success at exact release merge SHA.
- Production tag `hns-production-v1` peels to `5dcde767020161f6f6c7a5fc3330bccaca1d14a3`.

## D/C storage audit

Candidate checkout, run artifacts, npm cache, TEMP, runtimeData, userData, and test roots were placed on D:. Post-merge clone/install/cache/temp/runtime/userData/test outputs were also under `D:\HQR\post-merge-5dcde76`. The named-project C-write gate passed with zero detected writes; `C:\Users\15601\.npmrc` was read-only configuration input. This audit is scoped to project-shaped writes and does not claim zero ordinary OS writes. The active observer PID 13896 is a separate prior-SHA process with a mismatched declared root; it is not candidate acceptance evidence and was not stopped.

The [paper-material index](../../docs/paper-material/PAPER_MATERIAL_INDEX.md) links the 366-commit release snapshot, branch disposition, bounded claims, 17 experiments, 11 metrics, and 43 negative results. Historical failures and unsupported comparator claims remain visible.
