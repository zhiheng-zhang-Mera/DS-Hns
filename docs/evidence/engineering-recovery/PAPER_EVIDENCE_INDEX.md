# V5 Interrupt Recovery — Paper Evidence Index

- **Snapshot:** 2026-09-27
- **Cloud branch:** `dev/crash-resume-recovery-v1`
- **Latest evaluated code and harness SHA:** `64d2c396b7649452c0858e4915af17e6bbbb2368`
- **Frozen root-report code and harness SHA:** `7d2967c2534f05952a2ddaf7e1ab2db50914eab1`
- **Disposition:** `HNS_INTEGRATION_RC_NOT_READY`

The root-level report and metadata remain the immutable 7d2967c snapshot. The latest exact-SHA E0 and combined W0+E5 FINAL package is published under [`candidate-64d2c39`](candidate-64d2c39/FINAL_EVIDENCE_REPORT.md). Each package report normalizes machine-local absolute paths to checkout-relative paths. E0 logs and raw run files remain in the local ignored evidence root at `runtime/engineering/evidence/recovery/`; committed package checksums preserve their identities without adding raw run bundles to Git.

## Frozen root-level artifacts

- [FINAL_EVIDENCE_REPORT.md](FINAL_EVIDENCE_REPORT.md) — generated from the FINAL batch's derived outputs; reports all gates, observations, missing coverage, and validity limits.
- [e0-gate.json](e0-gate.json) — passing E0 gate bound to the frozen root-report code and harness SHA `7d2967c2534f05952a2ddaf7e1ab2db50914eab1`.
- [evidence-freeze.json](evidence-freeze.json) and [batch-manifest.json](batch-manifest.json) — frozen FINAL identities and run ledger.
- [SHA256SUMS.txt](SHA256SUMS.txt) — batch checksum manifest for the local immutable batch; its SHA-256 is `a05644f0d6e6a0defc61ddaf980c3ea1c26a0f0e4446bf617f113ce35b55ec56`.

The full local batch is `runtime/engineering/evidence/recovery/E2-W0-final-20260927-01/`. Its raw run is `runs/E2-W0-fault04/`. The full E0 logs are under `runtime/engineering/evidence/recovery/E0-20260927T014857685Z/logs/`. The raw and derived files were verified locally before preparing this publication copy; their hashes are represented in the committed checksum metadata.

The committed LF report copy's SHA-256 is `f55dc8189f03f89f602e27193d3de5a9d3a35c7494a4be56c961ca0270f5d4aa`.

## Latest FINAL candidate: 64d2c39

- **Implementation and harness SHA:** `64d2c396b7649452c0858e4915af17e6bbbb2368`
- **Cloud branch:** `dev/crash-resume-recovery-v1`
- **E0 run:** `E0-20260927T043444818Z`; all four gates PASS, and all recorded log SHA-256 values were independently recomputed and matched.
- **Environment:** Node `v24.19.0`, Windows `10.0.26200 x64`.

| E0 gate | Result | Counts | Duration ms | Log SHA-256 |
|---|---|---:|---:|---|
| Syntax | PASS | 281/281 files checked | 273494 | `8827033cdaff370164ef075fbef4215c2f4edb114fbf9196b399c218b077eca6` |
| Full unit | PASS | 1,906 passed; 0 failed; 4 skipped of 1,910 | 474940 | `c511198f51fe5de5a91134d029629dcad36e34be7042504c6df2e6a3ba2fbc4f` |
| Focused recovery | PASS | 102 passed; 0 failed; 2 skipped of 104 | 27858 | `f46126309dbed12435e23dc0497249e70301bb0d1eaa5518be79769b55bbb36d` |
| `test-all.ps1` | PASS | 1,906 passed; 0 failed; 4 skipped of 1,910 | 512271 | `be9b438fc0448fa5c0f9e9d1ef8ac76b4bb8137a3313f0bbd2ea23071058c293` |

GitHub Actions [36294679188](https://github.com/zhiheng-zhang-Mera/DS-Hns/actions/runs/36294679188) also passed on the same code SHA. Its unit/architecture gate reported 1,908 passed, 0 failed, 2 skipped of 1,910; all surface/evidence gates and combined acceptance passed.

FINAL batch `E2-E5-final-20260927-02`, batch seed `20260928`, contains one W0 fault-04 observation and 20 E5 W2 terminal-cleanup observations (E5 plan seed `4201`). Batch and all 21 run checksums verify. Combined classifications are 12 PASS (including W0), 9 EXPECTED_BLOCK, 0 FAIL, and 0 INVALID. Acceptance gates A1, A2, A3, A5, A7, and A8 PASS; A4 and A6 remain NOT_RUN. Overall status remains `HNS_INTEGRATION_RC_NOT_READY` with 9/89 fault IDs observed and 80 explicitly NOT_RUN.

| Measure | FINAL observation |
|---|---:|
| W0 checkpoint sequence | 9 → 10 |
| W0 verified steps preserved | 2 |
| W0 lost steps / verified mutation replays / duplicate effects / re-executed steps | 0 / 0 / 0 / 0 |
| W0 fault to recovery candidate | 746.5961 ms |
| W0 fault to resume API acceptance | 5,751.9078 ms |
| W0 fault to first newer checkpoint | 5,754.0073 ms |
| E5 observations | 20: 11 PASS, 9 EXPECTED_BLOCK |
| E5 fault coverage | IDs 80–87 |
| E5 created / deleted / residual scratch registrations | 2 / 2 / 0 on each run |
| E5 cleanup oracles | O7 PASS and O8 PASS on all 20 runs |
| E5 volume binding | work D:, scratch C: |

The W0 `product_result_observed` event records `RESUME_ACCEPTED` from the actual resume API return. `result.json` uses that observation; `oracle.json` remains independently derived from the raw event stream. FINAL preflight also rejects modified, staged, or untracked worktrees before evidence creation, covered by the [evidence-harness regression tests](../../../tests/unit/engineering-evidence-harness.test.js). The Windows volume-GUID alias path used by CI is accepted only when the checked route contains no reparse points and both spellings resolve to the same filesystem object. The copied report, E0 gate, freeze, batch manifest, derived tables, and batch checksum list are under [`candidate-64d2c39`](candidate-64d2c39/FINAL_EVIDENCE_REPORT.md). `PUBLISHED_SHA256SUMS.txt` covers the 14 published package files; its SHA-256 is `ec111d53945577617d43cf1fdbe79cff203c3e5af27142444bfd493330f6a869`. The report SHA-256 is `17d7b3f3f00fcae66c6550e06543da397644dbb77c09257a4ed9f8e6854a14ba`.

The preceding candidate batch `E2-E5-final-20260927-01` is retained locally and excluded from this FINAL package: all 20 E5 observations and integrity checks passed, but A5 rejected the `scratch:C:` volume-role label. Commit `64d2c39` corrected the label to `scratch:C`; the accepted `-02` batch was generated against a fresh exact-SHA E0 gate.

## System model and source map

This source map identifies where the implemented contracts live. It is implementation documentation; the runtime evidence and claim limits remain those in the frozen report above.

| System area | Implementation source | Focused regression evidence |
|---|---|---|
| Architecture and failure isolation | [`engineering-host.cjs`](../../../app/engineering-host.cjs), [`supervisor.cjs`](../../../app/engineering/supervisor.cjs), [`process-identity.cjs`](../../../app/engineering/process-identity.cjs) | [`engineering-host-resume.test.js`](../../../tests/unit/engineering-host-resume.test.js), [`engineering-process-identity.test.js`](../../../tests/unit/engineering-process-identity.test.js) |
| Checkpoint truth and monotonic cursor | [`checkpoint.cjs`](../../../app/engineering/checkpoint.cjs), [`recovery-schema.cjs`](../../../app/engineering/recovery-schema.cjs) | [`engineering-checkpoint.test.js`](../../../tests/unit/engineering-checkpoint.test.js), [`engineering-recovery-schema.test.js`](../../../tests/unit/engineering-recovery-schema.test.js) |
| Durable lifecycle, exclusive claim, and bounded resume | [`recovery-store.cjs`](../../../app/engineering/recovery-store.cjs), [`engineering-host.cjs`](../../../app/engineering-host.cjs), [`desktop-main.cjs`](../../../app/desktop-main.cjs) | [`engineering-recovery-store.test.js`](../../../tests/unit/engineering-recovery-store.test.js), [`engineering-host-resume.test.js`](../../../tests/unit/engineering-host-resume.test.js) |
| Mutation verification and replay reconciliation | [`mutation.cjs`](../../../app/engineering/mutation.cjs), [`checkpoint.cjs`](../../../app/engineering/checkpoint.cjs), [`supervisor.cjs`](../../../app/engineering/supervisor.cjs) | [`engineering-recovery-journal.test.js`](../../../tests/unit/engineering-recovery-journal.test.js), [`engineering-scenarios.test.js`](../../../tests/unit/engineering-scenarios.test.js) |
| Cross-volume ownership and terminal cleanup | [`cross-volume-cleanup.cjs`](../../../app/engineering/cross-volume-cleanup.cjs), [`supervisor.cjs`](../../../app/engineering/supervisor.cjs) | [`engineering-cross-volume-cleanup.test.js`](../../../tests/unit/engineering-cross-volume-cleanup.test.js) |
| Evidence schema, independent oracle, and integrity | [`engineering-recovery-evidence.cjs`](../../../scripts/lib/engineering-recovery-evidence.cjs), [`engineering-recovery-evidence.cjs` CLI](../../../scripts/engineering-recovery-evidence.cjs) | [`engineering-evidence-harness.test.js`](../../../tests/unit/engineering-evidence-harness.test.js), [`schema-v1.json`](../../../tests/evidence/engineering-recovery/schema-v1.json) |
| Cross-volume campaign plan and terminal cleanup observations | [`engineering-recovery-e5.cjs` CLI](../../../scripts/engineering-recovery-e5.cjs), [`engineering-recovery-e5.cjs` library](../../../scripts/lib/engineering-recovery-e5.cjs) | [`engineering-recovery-e5-campaign.test.js`](../../../tests/unit/engineering-recovery-e5-campaign.test.js), [`engineering-cross-volume-cleanup.test.js`](../../../tests/unit/engineering-cross-volume-cleanup.test.js) |

The recovery path is: desktop startup or planned restart calls the engineering host's resume entry point; the host discovers the latest valid checkpoint, obtains the episode claim, validates/reconciles mutations and cursor state, then delegates execution to the supervisor. Checkpoint files remain execution truth; the recovery index is repairable metadata. Cross-volume paths are registry-owned and terminal cleanup is gated by persisted terminal intent. The FINAL W0 row directly observes one controlled worker termination and the returned resume API result; the source map and unit tests do not expand that one-run denominator.

## Campaign tooling added after the frozen report

The root-level report above remains an immutable snapshot of code and harness SHA `7d2967c2534f05952a2ddaf7e1ab2db50914eab1`. Candidate `b8fe9473c221e15ab4a5c344117f15dcc7a1a9af` added the E5 W2 runner, explicit syntax/focused/full-test coverage, and a production cleanup repair that processes registered descendants before parent directories and preserves owner markers while a registered child is blocked. A 20-observation E5 PILOT on b8fe947 completed with 11 PASS, 9 EXPECTED_BLOCK, 0 FAIL, 0 INVALID, and zero final residuals. Its post-run audit found blank oracle fields in derived CSVs and an undercount of files deleted before a parent block. Candidate `7b1ae69be02501fed53c00174e7cbf85ef3dbf6e` fixes both export defects; a second 20-observation PILOT on that exact code SHA again produced 11 PASS, 9 EXPECTED_BLOCK, 0 FAIL, 0 INVALID, zero residuals, and complete PASS labels and deletion counts for all blocked scenarios. Candidate `1d5bb1004d018de4ac92ab7ede9d6ac0469bd123` lets the E5 FINAL runner append to the matching, integrity-checked E2 W0 batch, so the available campaigns share one frozen E0 gate and one combined report. These pilot batches are excluded from FINAL aggregates. Latest source SHA `64d2c396b7649452c0858e4915af17e6bbbb2368` now has a matching passing E0 and accepted 20-observation E5 FINAL in [`candidate-64d2c39`](candidate-64d2c39/FINAL_EVIDENCE_REPORT.md). The earlier `E2-E5-final-20260927-01` attempt remains excluded because its volume-role label did not satisfy A5; its checksummed raw files were not rewritten.

## Remaining campaign status

The latest package observes E2 W0/fault-4 once and completes E5 with 20 accepted W2 observations. E3's stratified robustness matrix, E4's matched replay pairs, and E7's sealed reproducibility replays remain `NOT_RUN`. E6 remains `NOT_RUN_MAINTENANCE_WINDOW`: real reboot requires a separately safe window and OS-owned same-account sign-in; no credential or sign-in configuration was changed. Those gaps keep the overall status at `HNS_INTEGRATION_RC_NOT_READY`.

The root-level 7d2967c report remains immutable as the earlier evaluated snapshot. The supplemental `candidate-64d2c39` package records later exact-SHA evidence without upgrading the limited campaign to full integration acceptance.

## Frozen acceptance (root report SHA 7d2967c)

E0 passed on branch `dev/crash-resume-recovery-v1`, implementation SHA `7d2967c2534f05952a2ddaf7e1ab2db50914eab1`, Node `v24.19.0`, Windows `10.0.26200 x64`. Run ID: `E0-20260927T014857685Z`. All four log SHA-256 values matched the E0 gate.

| E0 gate | Result | Counts |
|---|---|---:|
| Syntax | PASS | 278/278 files checked |
| Full unit | PASS | 1,897 passed; 0 failed; 2 skipped of 1,899 |
| Focused recovery | PASS | 93/93 passed |
| `test-all.ps1` | PASS | 1,897 passed; 0 failed; 2 skipped of 1,899 |

GitHub Actions run [36286547640](https://github.com/zhiheng-zhang-Mera/DS-Hns/actions/runs/36286547640) also passed on the same SHA.

## Frozen FINAL W0 observation (SHA 7d2967c)

Batch `E2-W0-final-20260927-01`, seed `20261001`, contains one final observation: W0, fault ID 4, controlled termination of the exact owned worker process. The result was `PASS`; `product_result_observed` records `RESUME_ACCEPTED` from the actual `resumeLatest()` return. Batch integrity and run integrity both passed. The candidate workspace was removed after the observation.

| Measure | Observed value |
|---|---:|
| Checkpoint sequence | 9 → 10 |
| Verified steps preserved | 2 |
| Lost verified steps | 0 |
| Verified mutation replays | 0 |
| Duplicate effects | 0 |
| Steps re-executed | 0 |
| Fault to recovery candidate | 728.5049 ms |
| Fault to API acceptance | 5,683.3774 ms |
| Fault to first newer checkpoint | 5,685.4850 ms |

Applicable observations O1, O2, O3, O4, and O6 passed. O5 has no intentionally unsafe fail-closed observation in this batch. O7 and O8 do not apply to this single-volume fault-4 observation; O9 reboot autonomy was not exercised. The N=1 latency and Wilson interval in the generated report are descriptive only and do not establish a failure rate.

## Pilot and invalid-run disposition

Pilot runs are excluded from the FINAL aggregates. All artifacts below remain immutable in their original local batches.

| Batch | Code SHA | Disposition |
|---|---|---|
| `E1-W0-pilot-20260926-01` through `-10` | `6e8ec68f...` | 4 recorded PASS and 6 INVALID across ten one-run batches; older batch schemas are incomplete (01–09 lack `evidence-freeze.json`, 10 has an invalid freeze). Raw checksum references were checked; these are not FINAL evidence. |
| `E1-W0-pilot-c7676ef` | `c7676ef...` | One PASS; the only schema-valid batch in that historical set. Its analysis explicitly remains `HNS_INTEGRATION_RC_NOT_READY`, with the other 88 fault IDs marked pilot-scope NOT_RUN. |
| `E1-W0-pilot-recovery-product-20260927` | `42ab1d6e...` | INVALID: the product result was not observable before the worker-event timeout. Checksums pass; no PASS is inferred. |
| `E1-W0-pilot-product-return-20260927-r3` | `6b67737e...` | Excluded despite `result.json` saying PASS: the CLI exited 1 after owner verification failed. A later regression test fixed `invalidReason` precedence; the original artifact was not rewritten. |
| `E1-W0-pilot-product-return-20260927-r4` | `7d2967c...` | One PASS pilot with a recorded product return and preserved live-owner observation; checksum-valid, but still calibration-only. |
| `E2-E5-final-20260927-01` | `64d2c39...` | Excluded because A5 rejected the runner's `scratch:C:` role label; 20 E5 observations, checksummed and preserved. Fixed by `64d2c39` and superseded by accepted batch `E2-E5-final-20260927-02`. |

## Frozen E0–E7 and A1–A8 status (root report SHA 7d2967c)

| Stage or gate | Status | Evidence boundary |
|---|---|---|
| E0 | PASS | Four gates on the exact frozen code/harness SHA. |
| E1 | PILOT_EXCLUDED | Calibration observations are not included in FINAL aggregates. |
| E2 | OBSERVED, limited | One W0 fault-4 observation only; 88/89 catalog IDs have no final observation. |
| E3 | NOT_RUN | No eight-scenario × ten-seed W1/W2/W3 robustness matrix. |
| E4 | NOT_RUN | No 30 matched resume/replay pairs. |
| E5 | NOT_RUN | No 20-observation cross-volume terminal-cleanup campaign. |
| E6 | NOT_RUN | No real reboot; no separately confirmed maintenance window was available. No OS sign-in settings or credentials were changed. |
| E7 | NOT_RUN | No ten-run sealed reproducibility replay set. |
| A1 | PASS | E0 checksum and branch/SHA match. |
| A2 | NOT_READY | No intentionally unsafe fail-closed O5 scenario. |
| A3 | PASS | The only executable safe fault (ID 4) was observed; every other catalog row has an explicit reason. |
| A4–A6 | NOT_RUN | Robustness, cross-volume cleanup, and real reboot gates were not run. |
| A7–A8 | PASS | Local raw/derived integrity verified; unrun scopes and claim boundaries are explicit. |

The overall result remains `HNS_INTEGRATION_RC_NOT_READY`. The 88 NOT_RUN catalog rows do not mean zero defects. This evidence does not establish 24-hour soak behavior, real reboot continuity, power-loss durability, Phase 2 Sub-worker recovery, multi-volume cleanup, production readiness, or a general recovery success rate.

## Reproduction and integrity

For the latest candidate, verify the committed package files against `candidate-64d2c39/PUBLISHED_SHA256SUMS.txt`. On a checkout containing the local raw batch, regenerate derived outputs with `deriveBatch(batchDir)` from `scripts/lib/engineering-recovery-evidence.cjs`, then verify the batch with `verifyBatchIntegrity(batchDir)` and each run with `verifyRunIntegrity(runDir)`. The batch checksum excludes its generated report to avoid self-reference; the published report and derived tables were copied from the checksummed batch without metric edits. Full raw runs and E0 logs remain in the local ignored `runtime/engineering/evidence/recovery/` tree.
