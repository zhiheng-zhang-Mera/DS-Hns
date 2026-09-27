# FINAL_EVIDENCE_REPORT

Final status: HNS_INTEGRATION_RC_NOT_READY.

## Frozen identities

- Branch/ref: dev/crash-resume-recovery-v1
- Implementation SHA: 64d2c396b7649452c0858e4915af17e6bbbb2368
- Harness SHA: 64d2c396b7649452c0858e4915af17e6bbbb2368
- Evidence schema SHA-256: f9d0137fdaf1f740b747bc7b2548551dfac82643e9c82d33bb6a45f78687fb7f
- Fault catalog SHA-256: ff6a691d28244a9857eae686b8245b2a5602e4897b3521c5ae7f092faefcbd10
- Workload definitions SHA-256: f729069564ea32de6e061a3b36685c76bc3f872bbe78211fead943cfa8078264
- Bound E0 gate SHA-256: 19e3dfc5f56ecc795caffdf385f7a0608ed0c34445b1aa1e6a4879848db370a9 (4 gates; PASS)
- E0 gate/log evidence root: D:\DS-Hns-V5-CleanAcceptance\runtime\engineering\evidence\recovery\E0-20260927T043444818Z
- Batch ID/phase/seed: E2-E5-final-20260927-02 / FINAL / 20260928
- Raw evidence root: D:\DS-Hns-V5-CleanAcceptance\runtime\engineering\evidence\recovery\E2-E5-final-20260927-02
- Batch SHA256SUMS.txt SHA-256: 0af031ff7e76b743e28bdc9ed6036fef71d3c1c6c6060ae36b76c9ddd823e189 (report excluded from this manifest to avoid self-reference; report is reproducible from the checksummed artifacts)

## E0–E7 run counts

| Stage | Status | Runs/evidence | Scope note |
|---|---|---:|---|
| E0 | PASS | 4 gates | bound to this exact implementation SHA |
| E1 | PILOT_EXCLUDED | 0 final runs | calibration artifacts reside outside this final batch and are excluded |
| E2 | OBSERVED | 1 | safe fault/recovery observations in this batch |
| E3 | NOT_RUN | 0 | repeated stratified robustness matrix |
| E4 | NOT_RUN | 0 pairs | paired replay-from-start baseline |
| E5 | PASS | 20 | cross-volume terminal-cleanup observations; see A5 scope and scenario counts |
| E6 | NOT_RUN | 0 | real Windows reboot; no safe maintenance window was confirmed |
| E7 | NOT_RUN | 0 | sealed-run reproducibility replays |

### E0 gate detail

| Gate | Status | Counts | Duration ms | Log SHA-256 |
|---|---|---|---:|---|
| syntax | PASS | 281/281 source files checked | 273494 | 8827033cdaff370164ef075fbef4215c2f4edb114fbf9196b399c218b077eca6 |
| full-unit | PASS | 1906/1910 passed; 0 failed; 4 skipped | 474940 | c511198f51fe5de5a91134d029629dcad36e34be7042504c6df2e6a3ba2fbc4f |
| focused-recovery | PASS | 102/104 passed; 0 failed; 2 skipped | 27858 | f46126309dbed12435e23dc0497249e70301bb0d1eaa5518be79769b55bbb36d |
| test-all | PASS | 1906/1910 passed; 0 failed; 4 skipped | 512271 | be9b438fc0448fa5c0f9e9d1ef8ac76b4bb8137a3313f0bbd2ea23071058c293 |

## Acceptance gates A1–A8

| Gate | Status | Evidence/reason |
|---|---|---|
| A1 | PASS | the E0 gate is checksummed and matches the exact tested branch and implementation SHA |
| A2 | PASS | all applicable observed safety oracles passed with no invalid or failing run |
| A3 | PASS | every executable safe fault ID has an accepted E2 observation and every other catalog row carries an explicit scope/maintenance reason |
| A4 | NOT_RUN | E3 eight-scenario × ten-seed × W1/W2/W3 robustness matrix was not run |
| A5 | PASS | E5 recorded 20 accepted W2 observations covering fault IDs 80–87; O7/O8 cleanup evidence and D:-work/C:-scratch identities were verified |
| A6 | NOT_RUN | E6 real reboot repetitions were not run; no separately confirmed safe maintenance window was supplied |
| A7 | PASS | raw runs and derived IDs verified; checksum manifest covers freeze, E0, raw-run checksum files and analysis tables |
| A8 | PASS | the report separates simulated/real process/reboot evidence, records NOT_RUN reasons, and limits claims to exercised configurations |

## Correctness invariant counts

| Oracle | Passed / applicable N | Violations | Wilson 95% CI |
|---|---:|---:|---|
| O1_progress_preservation | 1/1 | 0 | [20.7%, 100.0%] |
| O2_no_verified_replay | 1/1 | 0 | [20.7%, 100.0%] |
| O3_no_duplicate_effect | 1/1 | 0 | [20.7%, 100.0%] |
| O4_cursor_monotonic | 1/1 | 0 | [20.7%, 100.0%] |
| O5_fail_closed_correct | 9/9 | 0 | [70.1%, 100.0%] |
| O6_single_execution_owner | 1/1 | 0 | [20.7%, 100.0%] |
| O7_cleanup_safety | 20/20 | 0 | [83.9%, 100.0%] |
| O8_cleanup_completeness | 20/20 | 0 | [83.9%, 100.0%] |
| O9_reboot_autonomy | 0/0 | 0 | NOT_RUN (N=0) |

N=0 means NOT_RUN, not zero defects. O5 requires intentionally unsafe fail-closed observations; it is not inferred from successful resume runs.

## RQ1 — correctness / progress / single owner

| Run | Fault | Class | Lost verified steps | Verified replay | Duplicate effects | O4 | O5 | O6 |
|---|---:|---|---:|---:|---:|---|---|---|
| E2-W0-fault04 | 4 | PASS | 0 | 0 | 0 | PASS | NOT_APPLICABLE | PASS |
| E5-W2-fault81-01 | 81 | PASS | 0 | 0 | 0 | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE |
| E5-W2-fault84-02 | 84 | EXPECTED_BLOCK | 0 | 0 | 0 | NOT_APPLICABLE | PASS | NOT_APPLICABLE |
| E5-W2-fault85-03 | 85 | PASS | 0 | 0 | 0 | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE |
| E5-W2-fault80-04 | 80 | PASS | 0 | 0 | 0 | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE |
| E5-W2-fault87-05 | 87 | EXPECTED_BLOCK | 0 | 0 | 0 | NOT_APPLICABLE | PASS | NOT_APPLICABLE |
| E5-W2-fault83-06 | 83 | EXPECTED_BLOCK | 0 | 0 | 0 | NOT_APPLICABLE | PASS | NOT_APPLICABLE |
| E5-W2-fault83-07 | 83 | EXPECTED_BLOCK | 0 | 0 | 0 | NOT_APPLICABLE | PASS | NOT_APPLICABLE |
| E5-W2-fault82-08 | 82 | PASS | 0 | 0 | 0 | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE |
| E5-W2-fault81-09 | 81 | PASS | 0 | 0 | 0 | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE |
| E5-W2-fault86-10 | 86 | EXPECTED_BLOCK | 0 | 0 | 0 | NOT_APPLICABLE | PASS | NOT_APPLICABLE |
| E5-W2-fault86-11 | 86 | EXPECTED_BLOCK | 0 | 0 | 0 | NOT_APPLICABLE | PASS | NOT_APPLICABLE |
| E5-W2-fault82-12 | 82 | PASS | 0 | 0 | 0 | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE |
| E5-W2-fault80-13 | 80 | PASS | 0 | 0 | 0 | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE |
| E5-W2-fault82-14 | 82 | PASS | 0 | 0 | 0 | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE |
| E5-W2-fault83-15 | 83 | EXPECTED_BLOCK | 0 | 0 | 0 | NOT_APPLICABLE | PASS | NOT_APPLICABLE |
| E5-W2-fault87-16 | 87 | EXPECTED_BLOCK | 0 | 0 | 0 | NOT_APPLICABLE | PASS | NOT_APPLICABLE |
| E5-W2-fault84-17 | 84 | EXPECTED_BLOCK | 0 | 0 | 0 | NOT_APPLICABLE | PASS | NOT_APPLICABLE |
| E5-W2-fault85-18 | 85 | PASS | 0 | 0 | 0 | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE |
| E5-W2-fault80-19 | 80 | PASS | 0 | 0 | 0 | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE |
| E5-W2-fault81-20 | 81 | PASS | 0 | 0 | 0 | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE |

## RQ2 — recovery efficiency / work preservation

| Run | Fault | Fault→candidate ms | Fault→resume accepted ms | Fault→new checkpoint ms | Steps re-executed | Verified steps preserved |
|---|---:|---:|---:|---:|---:|---:|
| E2-W0-fault04 | 4 | 746.5961 | 5751.9078 | 5754.0073 | 0 | 2 |
| E5-W2-fault81-01 | 81 | NOT_RECORDED | NOT_RECORDED | NOT_RECORDED | 0 | 0 |
| E5-W2-fault84-02 | 84 | NOT_RECORDED | NOT_RECORDED | NOT_RECORDED | 0 | 0 |
| E5-W2-fault85-03 | 85 | NOT_RECORDED | NOT_RECORDED | NOT_RECORDED | 0 | 0 |
| E5-W2-fault80-04 | 80 | NOT_RECORDED | NOT_RECORDED | NOT_RECORDED | 0 | 0 |
| E5-W2-fault87-05 | 87 | NOT_RECORDED | NOT_RECORDED | NOT_RECORDED | 0 | 0 |
| E5-W2-fault83-06 | 83 | NOT_RECORDED | NOT_RECORDED | NOT_RECORDED | 0 | 0 |
| E5-W2-fault83-07 | 83 | NOT_RECORDED | NOT_RECORDED | NOT_RECORDED | 0 | 0 |
| E5-W2-fault82-08 | 82 | NOT_RECORDED | NOT_RECORDED | NOT_RECORDED | 0 | 0 |
| E5-W2-fault81-09 | 81 | NOT_RECORDED | NOT_RECORDED | NOT_RECORDED | 0 | 0 |
| E5-W2-fault86-10 | 86 | NOT_RECORDED | NOT_RECORDED | NOT_RECORDED | 0 | 0 |
| E5-W2-fault86-11 | 86 | NOT_RECORDED | NOT_RECORDED | NOT_RECORDED | 0 | 0 |
| E5-W2-fault82-12 | 82 | NOT_RECORDED | NOT_RECORDED | NOT_RECORDED | 0 | 0 |
| E5-W2-fault80-13 | 80 | NOT_RECORDED | NOT_RECORDED | NOT_RECORDED | 0 | 0 |
| E5-W2-fault82-14 | 82 | NOT_RECORDED | NOT_RECORDED | NOT_RECORDED | 0 | 0 |
| E5-W2-fault83-15 | 83 | NOT_RECORDED | NOT_RECORDED | NOT_RECORDED | 0 | 0 |
| E5-W2-fault87-16 | 87 | NOT_RECORDED | NOT_RECORDED | NOT_RECORDED | 0 | 0 |
| E5-W2-fault84-17 | 84 | NOT_RECORDED | NOT_RECORDED | NOT_RECORDED | 0 | 0 |
| E5-W2-fault85-18 | 85 | NOT_RECORDED | NOT_RECORDED | NOT_RECORDED | 0 | 0 |
| E5-W2-fault80-19 | 80 | NOT_RECORDED | NOT_RECORDED | NOT_RECORDED | 0 | 0 |
| E5-W2-fault81-20 | 81 | NOT_RECORDED | NOT_RECORDED | NOT_RECORDED | 0 | 0 |

## RQ3 — robustness / cleanup / reboot boundary

| Run | Fault | Workload | Class | O7 cleanup safety | O8 cleanup completeness | O9 reboot autonomy |
|---|---:|---|---|---|---|---|
| E2-W0-fault04 | 4 | W0 | PASS | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE |
| E5-W2-fault81-01 | 81 | W2 | PASS | PASS | PASS | NOT_APPLICABLE |
| E5-W2-fault84-02 | 84 | W2 | EXPECTED_BLOCK | PASS | PASS | NOT_APPLICABLE |
| E5-W2-fault85-03 | 85 | W2 | PASS | PASS | PASS | NOT_APPLICABLE |
| E5-W2-fault80-04 | 80 | W2 | PASS | PASS | PASS | NOT_APPLICABLE |
| E5-W2-fault87-05 | 87 | W2 | EXPECTED_BLOCK | PASS | PASS | NOT_APPLICABLE |
| E5-W2-fault83-06 | 83 | W2 | EXPECTED_BLOCK | PASS | PASS | NOT_APPLICABLE |
| E5-W2-fault83-07 | 83 | W2 | EXPECTED_BLOCK | PASS | PASS | NOT_APPLICABLE |
| E5-W2-fault82-08 | 82 | W2 | PASS | PASS | PASS | NOT_APPLICABLE |
| E5-W2-fault81-09 | 81 | W2 | PASS | PASS | PASS | NOT_APPLICABLE |
| E5-W2-fault86-10 | 86 | W2 | EXPECTED_BLOCK | PASS | PASS | NOT_APPLICABLE |
| E5-W2-fault86-11 | 86 | W2 | EXPECTED_BLOCK | PASS | PASS | NOT_APPLICABLE |
| E5-W2-fault82-12 | 82 | W2 | PASS | PASS | PASS | NOT_APPLICABLE |
| E5-W2-fault80-13 | 80 | W2 | PASS | PASS | PASS | NOT_APPLICABLE |
| E5-W2-fault82-14 | 82 | W2 | PASS | PASS | PASS | NOT_APPLICABLE |
| E5-W2-fault83-15 | 83 | W2 | EXPECTED_BLOCK | PASS | PASS | NOT_APPLICABLE |
| E5-W2-fault87-16 | 87 | W2 | EXPECTED_BLOCK | PASS | PASS | NOT_APPLICABLE |
| E5-W2-fault84-17 | 84 | W2 | EXPECTED_BLOCK | PASS | PASS | NOT_APPLICABLE |
| E5-W2-fault85-18 | 85 | W2 | PASS | PASS | PASS | NOT_APPLICABLE |
| E5-W2-fault80-19 | 80 | W2 | PASS | PASS | PASS | NOT_APPLICABLE |
| E5-W2-fault81-20 | 81 | W2 | PASS | PASS | PASS | NOT_APPLICABLE |

## Latency and work-preservation summaries

| Metric | N | Median | Q1 | Q3 | IQR | P95 |
|---|---:|---:|---:|---:|---:|---:|
| fault to resume accepted (ms) | 1 | 5751.91 | 5751.91 | 5751.91 | 0.00 | 5751.91 |
| fault to first newer checkpoint (ms) | 1 | 5754.01 | 5754.01 | 5754.01 | 0.00 | 5754.01 |
| steps re-executed | 21 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 |
| verified steps preserved | 21 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 |

## E4 paired replay-from-start analysis

E4 paired baseline: NOT_RUN; N=0 matched pairs; paired-difference bootstrap 95% CI = NOT_RUN. No replay baseline was fabricated.

## Cross-volume cleanup (E5)

E5 status: PASS; observations=20; E5 recorded 20 accepted W2 observations covering fault IDs 80–87; O7/O8 cleanup evidence and D:-work/C:-scratch identities were verified.

| Fault ID | Observations | PASS | EXPECTED_BLOCK | FAIL/INVALID |
|---:|---:|---:|---:|---:|
| 80 | 3 | 3 | 0 | 0 |
| 81 | 3 | 3 | 0 | 0 |
| 82 | 3 | 3 | 0 | 0 |
| 83 | 3 | 0 | 3 | 0 |
| 84 | 2 | 0 | 2 | 0 |
| 85 | 2 | 2 | 0 | 0 |
| 86 | 2 | 0 | 2 | 0 |
| 87 | 2 | 0 | 2 | 0 |

## Real reboot evidence (E6)

E6 NOT_RUN. No real reboot was triggered because no separately confirmed safe maintenance window was supplied. No OS account/sign-in credentials or schedules were changed. Adapter simulation is not represented as a reboot observation.

## FAIL, INVALID and NOT_RUN inventory

- Final classifications: PASS=12, EXPECTED_BLOCK=9, FAIL=0, INVALID=0.
- NOT_RUN catalog IDs: 80/89. Each row and reason is listed below.
| Fault ID | Status | Observations | Reason |
|---:|---|---:|---|
| 1 | NOT_RUN_NO_ADAPTER | 0 | the catalog entry has no executable adapter in this frozen harness; no observation is inferred from its declaration |
| 2 | NOT_RUN_NO_ADAPTER | 0 | the catalog entry has no executable adapter in this frozen harness; no observation is inferred from its declaration |
| 3 | NOT_RUN_NO_ADAPTER | 0 | the catalog entry has no executable adapter in this frozen harness; no observation is inferred from its declaration |
| 4 | OBSERVED | 1 | final raw observation recorded as PASS |
| 5 | NOT_RUN_NO_ADAPTER | 0 | the catalog entry has no executable adapter in this frozen harness; no observation is inferred from its declaration |
| 6 | NOT_RUN_NO_ADAPTER | 0 | the catalog entry has no executable adapter in this frozen harness; no observation is inferred from its declaration |
| 7 | NOT_RUN_NO_ADAPTER | 0 | the catalog entry has no executable adapter in this frozen harness; no observation is inferred from its declaration |
| 8 | NOT_RUN_NO_ADAPTER | 0 | the catalog entry has no executable adapter in this frozen harness; no observation is inferred from its declaration |
| 9 | NOT_RUN_NO_ADAPTER | 0 | the catalog entry has no executable adapter in this frozen harness; no observation is inferred from its declaration |
| 10 | NOT_RUN_NO_ADAPTER | 0 | the catalog entry has no executable adapter in this frozen harness; no observation is inferred from its declaration |
| 11 | NOT_RUN_NO_ADAPTER | 0 | the catalog entry has no executable adapter in this frozen harness; no observation is inferred from its declaration |
| 12 | NOT_RUN_NO_ADAPTER | 0 | the catalog entry has no executable adapter in this frozen harness; no observation is inferred from its declaration |
| 13 | NOT_RUN_NO_ADAPTER | 0 | the catalog entry has no executable adapter in this frozen harness; no observation is inferred from its declaration |
| 14 | NOT_RUN_NO_ADAPTER | 0 | the catalog entry has no executable adapter in this frozen harness; no observation is inferred from its declaration |
| 15 | NOT_RUN_NO_ADAPTER | 0 | the catalog entry has no executable adapter in this frozen harness; no observation is inferred from its declaration |
| 16 | NOT_RUN_NO_ADAPTER | 0 | the catalog entry has no executable adapter in this frozen harness; no observation is inferred from its declaration |
| 17 | NOT_RUN_NO_ADAPTER | 0 | the catalog entry has no executable adapter in this frozen harness; no observation is inferred from its declaration |
| 18 | NOT_RUN_NO_ADAPTER | 0 | the catalog entry has no executable adapter in this frozen harness; no observation is inferred from its declaration |
| 19 | NOT_RUN_NO_ADAPTER | 0 | the catalog entry has no executable adapter in this frozen harness; no observation is inferred from its declaration |
| 20 | NOT_RUN_NO_ADAPTER | 0 | the catalog entry has no executable adapter in this frozen harness; no observation is inferred from its declaration |
| 21 | NOT_RUN_NO_ADAPTER | 0 | the catalog entry has no executable adapter in this frozen harness; no observation is inferred from its declaration |
| 22 | NOT_RUN_NO_ADAPTER | 0 | the catalog entry has no executable adapter in this frozen harness; no observation is inferred from its declaration |
| 23 | NOT_RUN_NO_ADAPTER | 0 | the catalog entry has no executable adapter in this frozen harness; no observation is inferred from its declaration |
| 24 | NOT_RUN_NO_ADAPTER | 0 | the catalog entry has no executable adapter in this frozen harness; no observation is inferred from its declaration |
| 25 | NOT_RUN_NO_ADAPTER | 0 | the catalog entry has no executable adapter in this frozen harness; no observation is inferred from its declaration |
| 26 | NOT_RUN_NO_ADAPTER | 0 | the catalog entry has no executable adapter in this frozen harness; no observation is inferred from its declaration |
| 27 | NOT_RUN_NO_ADAPTER | 0 | the catalog entry has no executable adapter in this frozen harness; no observation is inferred from its declaration |
| 28 | NOT_RUN_NO_ADAPTER | 0 | the catalog entry has no executable adapter in this frozen harness; no observation is inferred from its declaration |
| 29 | NOT_RUN_NO_ADAPTER | 0 | the catalog entry has no executable adapter in this frozen harness; no observation is inferred from its declaration |
| 30 | NOT_RUN_NO_ADAPTER | 0 | the catalog entry has no executable adapter in this frozen harness; no observation is inferred from its declaration |
| 31 | NOT_RUN_NO_ADAPTER | 0 | the catalog entry has no executable adapter in this frozen harness; no observation is inferred from its declaration |
| 32 | NOT_RUN_NO_ADAPTER | 0 | the catalog entry has no executable adapter in this frozen harness; no observation is inferred from its declaration |
| 33 | NOT_RUN_NO_ADAPTER | 0 | the catalog entry has no executable adapter in this frozen harness; no observation is inferred from its declaration |
| 34 | NOT_RUN_NO_ADAPTER | 0 | the catalog entry has no executable adapter in this frozen harness; no observation is inferred from its declaration |
| 35 | NOT_RUN_NO_ADAPTER | 0 | the catalog entry has no executable adapter in this frozen harness; no observation is inferred from its declaration |
| 36 | NOT_RUN_NO_ADAPTER | 0 | the catalog entry has no executable adapter in this frozen harness; no observation is inferred from its declaration |
| 37 | NOT_RUN_NO_ADAPTER | 0 | the catalog entry has no executable adapter in this frozen harness; no observation is inferred from its declaration |
| 38 | NOT_RUN_NO_ADAPTER | 0 | the catalog entry has no executable adapter in this frozen harness; no observation is inferred from its declaration |
| 39 | NOT_RUN_NO_ADAPTER | 0 | the catalog entry has no executable adapter in this frozen harness; no observation is inferred from its declaration |
| 40 | NOT_RUN_NO_ADAPTER | 0 | the catalog entry has no executable adapter in this frozen harness; no observation is inferred from its declaration |
| 41 | NOT_RUN_NO_ADAPTER | 0 | the catalog entry has no executable adapter in this frozen harness; no observation is inferred from its declaration |
| 42 | NOT_RUN_NO_ADAPTER | 0 | the catalog entry has no executable adapter in this frozen harness; no observation is inferred from its declaration |
| 43 | NOT_RUN_NO_ADAPTER | 0 | the catalog entry has no executable adapter in this frozen harness; no observation is inferred from its declaration |
| 44 | NOT_RUN_NO_ADAPTER | 0 | the catalog entry has no executable adapter in this frozen harness; no observation is inferred from its declaration |
| 45 | NOT_RUN_NO_ADAPTER | 0 | the catalog entry has no executable adapter in this frozen harness; no observation is inferred from its declaration |
| 46 | NOT_RUN_NO_ADAPTER | 0 | the catalog entry has no executable adapter in this frozen harness; no observation is inferred from its declaration |
| 47 | NOT_RUN_NO_ADAPTER | 0 | the catalog entry has no executable adapter in this frozen harness; no observation is inferred from its declaration |
| 48 | NOT_RUN_NO_ADAPTER | 0 | the catalog entry has no executable adapter in this frozen harness; no observation is inferred from its declaration |
| 49 | NOT_RUN_NO_ADAPTER | 0 | the catalog entry has no executable adapter in this frozen harness; no observation is inferred from its declaration |
| 50 | NOT_RUN_NO_ADAPTER | 0 | the catalog entry has no executable adapter in this frozen harness; no observation is inferred from its declaration |
| 51 | NOT_RUN_NO_ADAPTER | 0 | the catalog entry has no executable adapter in this frozen harness; no observation is inferred from its declaration |
| 52 | NOT_RUN_NO_ADAPTER | 0 | the catalog entry has no executable adapter in this frozen harness; no observation is inferred from its declaration |
| 53 | NOT_RUN_NO_ADAPTER | 0 | the catalog entry has no executable adapter in this frozen harness; no observation is inferred from its declaration |
| 54 | NOT_RUN_NO_ADAPTER | 0 | the catalog entry has no executable adapter in this frozen harness; no observation is inferred from its declaration |
| 55 | NOT_RUN_NO_ADAPTER | 0 | the catalog entry has no executable adapter in this frozen harness; no observation is inferred from its declaration |
| 56 | NOT_RUN_NO_ADAPTER | 0 | the catalog entry has no executable adapter in this frozen harness; no observation is inferred from its declaration |
| 57 | NOT_RUN_NO_ADAPTER | 0 | the catalog entry has no executable adapter in this frozen harness; no observation is inferred from its declaration |
| 58 | NOT_RUN_NO_ADAPTER | 0 | the catalog entry has no executable adapter in this frozen harness; no observation is inferred from its declaration |
| 59 | NOT_RUN_NO_ADAPTER | 0 | the catalog entry has no executable adapter in this frozen harness; no observation is inferred from its declaration |
| 60 | NOT_RUN_NO_ADAPTER | 0 | the catalog entry has no executable adapter in this frozen harness; no observation is inferred from its declaration |
| 61 | NOT_RUN_NO_ADAPTER | 0 | the catalog entry has no executable adapter in this frozen harness; no observation is inferred from its declaration |
| 62 | NOT_RUN_NO_ADAPTER | 0 | the catalog entry has no executable adapter in this frozen harness; no observation is inferred from its declaration |
| 63 | NOT_RUN_NO_ADAPTER | 0 | the catalog entry has no executable adapter in this frozen harness; no observation is inferred from its declaration |
| 64 | NOT_RUN_NO_ADAPTER | 0 | the catalog entry has no executable adapter in this frozen harness; no observation is inferred from its declaration |
| 65 | NOT_RUN_NO_ADAPTER | 0 | the catalog entry has no executable adapter in this frozen harness; no observation is inferred from its declaration |
| 66 | NOT_RUN_NO_ADAPTER | 0 | the catalog entry has no executable adapter in this frozen harness; no observation is inferred from its declaration |
| 67 | NOT_RUN_NO_ADAPTER | 0 | the catalog entry has no executable adapter in this frozen harness; no observation is inferred from its declaration |
| 68 | NOT_RUN_NO_ADAPTER | 0 | the catalog entry has no executable adapter in this frozen harness; no observation is inferred from its declaration |
| 69 | NOT_RUN_NO_ADAPTER | 0 | the catalog entry has no executable adapter in this frozen harness; no observation is inferred from its declaration |
| 70 | NOT_RUN_NO_ADAPTER | 0 | the catalog entry has no executable adapter in this frozen harness; no observation is inferred from its declaration |
| 71 | NOT_RUN_NO_ADAPTER | 0 | the catalog entry has no executable adapter in this frozen harness; no observation is inferred from its declaration |
| 72 | NOT_RUN_NO_ADAPTER | 0 | the catalog entry has no executable adapter in this frozen harness; no observation is inferred from its declaration |
| 73 | NOT_RUN_MAINTENANCE_WINDOW | 0 | real Windows reboot is not attempted without a separately confirmed safe maintenance window; OS-owned sign-in remains untouched |
| 74 | NOT_RUN_MAINTENANCE_WINDOW | 0 | real Windows reboot is not attempted without a separately confirmed safe maintenance window; OS-owned sign-in remains untouched |
| 75 | NOT_RUN_MAINTENANCE_WINDOW | 0 | real Windows reboot is not attempted without a separately confirmed safe maintenance window; OS-owned sign-in remains untouched |
| 76 | NOT_RUN_MAINTENANCE_WINDOW | 0 | real Windows reboot is not attempted without a separately confirmed safe maintenance window; OS-owned sign-in remains untouched |
| 77 | NOT_RUN_MAINTENANCE_WINDOW | 0 | real Windows reboot is not attempted without a separately confirmed safe maintenance window; OS-owned sign-in remains untouched |
| 78 | NOT_RUN_MAINTENANCE_WINDOW | 0 | real Windows reboot is not attempted without a separately confirmed safe maintenance window; OS-owned sign-in remains untouched |
| 79 | NOT_RUN_NO_ADAPTER | 0 | the catalog entry has no executable adapter in this frozen harness; no observation is inferred from its declaration |
| 80 | OBSERVED | 3 | final raw observation recorded as PASS |
| 81 | OBSERVED | 3 | final raw observation recorded as PASS |
| 82 | OBSERVED | 3 | final raw observation recorded as PASS |
| 83 | OBSERVED | 3 | final raw observation recorded as EXPECTED_BLOCK |
| 84 | OBSERVED | 2 | final raw observation recorded as EXPECTED_BLOCK |
| 85 | OBSERVED | 2 | final raw observation recorded as PASS |
| 86 | OBSERVED | 2 | final raw observation recorded as EXPECTED_BLOCK |
| 87 | OBSERVED | 2 | final raw observation recorded as EXPECTED_BLOCK |
| 88 | NOT_RUN_NO_ADAPTER | 0 | the catalog entry has no executable adapter in this frozen harness; no observation is inferred from its declaration |
| 89 | NOT_RUN_NO_ADAPTER | 0 | the catalog entry has no executable adapter in this frozen harness; no observation is inferred from its declaration |

| Run ID | Status | Reason |
|---|---|---|
| — | FAIL | none observed |
| — | INVALID | none observed |

## Threats to validity and claim boundaries

- The final process evidence in this batch is limited to the executable, exact-handle W0 fault #4 adapter and the tested Windows/Node host profile; one observation does not establish a failure rate.
- Catalog entries marked NOT_RUN_NO_ADAPTER are declarations without an executable harness adapter at this freeze; they contribute no coverage denominator and no robustness claim.
- E3–E7 populations are absent. No paired baseline, multi-volume terminal cleanup campaign, reproducibility replay, provider observation, or real OS reboot result is claimed.
- Controlled owned-process termination is distinct from random host crashes, power loss, OS restart, provider failure, and reboot scheduling.
- Seeds make injected choices reproducible, not Windows scheduling or external provider behavior deterministic.
- Exactly-once guarantees do not extend to non-idempotent external effects that cannot be observed or reconciled.
- Cross-volume cleanup claims apply only to paths/volumes actually exercised; unattended sign-in behavior remains OS-owned and untested here.

## Reproduction and integrity

- Re-derive from immutable raw runs through the exported deriveBatch(batchDir) entry point in scripts/lib/engineering-recovery-evidence.cjs; derivation verifies raw checksums before producing tables.
- Verify batch artifacts with the evidence library verifyBatchIntegrity; the last observed verification result was PASS with 33 checksummed artifacts.
- Raw runs remain immutable under the batch `runs/` directory; pilot/diagnostic material is not mixed into the FINAL batch.

Highest status: HNS_INTEGRATION_RC_NOT_READY. This is an evidence result for the evaluated scope, not a product-release or production-readiness claim.
