# V5 Interrupt Recovery — Paper Evidence Index

- **Snapshot:** 2026-09-27
- **Cloud branch:** `dev/crash-resume-recovery-v1`
- **Evaluated code and harness SHA:** `7d2967c2534f05952a2ddaf7e1ab2db50914eab1`
- **Disposition:** `HNS_INTEGRATION_RC_NOT_READY`

This index links the frozen E0 gate, FINAL batch metadata, checksums, and generated report. The published report normalizes machine-local absolute paths to checkout-relative paths. The original report, E0 logs, raw run files, and derived tables remain in the local ignored evidence root at `runtime/engineering/evidence/recovery/`; raw run bundles are not copied into Git.

## Published artifacts

- [FINAL_EVIDENCE_REPORT.md](FINAL_EVIDENCE_REPORT.md) — generated from the FINAL batch's derived outputs; reports all gates, observations, missing coverage, and validity limits.
- [e0-gate.json](e0-gate.json) — passing E0 gate bound to the exact code and harness SHA above.
- [evidence-freeze.json](evidence-freeze.json) and [batch-manifest.json](batch-manifest.json) — frozen FINAL identities and run ledger.
- [SHA256SUMS.txt](SHA256SUMS.txt) — batch checksum manifest for the local immutable batch; its SHA-256 is `a05644f0d6e6a0defc61ddaf980c3ea1c26a0f0e4446bf617f113ce35b55ec56`.

The full local batch is `runtime/engineering/evidence/recovery/E2-W0-final-20260927-01/`. Its raw run is `runs/E2-W0-fault04/`. The full E0 logs are under `runtime/engineering/evidence/recovery/E0-20260927T014857685Z/logs/`. The raw and derived files were verified locally before preparing this publication copy; their hashes are represented in the committed checksum metadata.

The committed LF report copy's SHA-256 is `f55dc8189f03f89f602e27193d3de5a9d3a35c7494a4be56c961ca0270f5d4aa`.

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

The recovery path is: desktop startup or planned restart calls the engineering host's resume entry point; the host discovers the latest valid checkpoint, obtains the episode claim, validates/reconciles mutations and cursor state, then delegates execution to the supervisor. Checkpoint files remain execution truth; the recovery index is repairable metadata. Cross-volume paths are registry-owned and terminal cleanup is gated by persisted terminal intent. The FINAL W0 row directly observes one controlled worker termination and the returned resume API result; the source map and unit tests do not expand that one-run denominator.

## Remaining campaign status

The frozen CLI at the evaluated harness SHA accepts only `pilot` and `final-w0-fault04`; it does not implement the E3 stratified matrix, E4 paired replay, E5 terminal-cleanup campaign, or E7 sealed replay runner. E2 therefore remains one W0/fault-4 final observation. Although the host currently has distinct healthy C: and D: NTFS volumes, volume availability and the focused cleanup tests do not count as an E5 campaign. E3, E4, E5, and E7 remain `NOT_RUN` until a campaign runner is implemented, qualified on a fresh E0 freeze, and its observations are generated and verified. E6 remains `NOT_RUN` because the required controlled reboot needs a separately safe maintenance window and OS-owned same-account sign-in; no credential or sign-in configuration was changed.

Accordingly, the engineering implementation and E0 candidate are frozen for this evaluated scope, while the broader paper campaign continues. The integration evidence disposition remains `HNS_INTEGRATION_RC_NOT_READY`; this index does not upgrade it to acceptance.

## Frozen acceptance

E0 passed on branch `dev/crash-resume-recovery-v1`, implementation SHA `7d2967c2534f05952a2ddaf7e1ab2db50914eab1`, Node `v24.19.0`, Windows `10.0.26200 x64`. Run ID: `E0-20260927T014857685Z`. All four log SHA-256 values matched the E0 gate.

| E0 gate | Result | Counts |
|---|---|---:|
| Syntax | PASS | 278/278 files checked |
| Full unit | PASS | 1,897 passed; 0 failed; 2 skipped of 1,899 |
| Focused recovery | PASS | 93/93 passed |
| `test-all.ps1` | PASS | 1,897 passed; 0 failed; 2 skipped of 1,899 |

GitHub Actions run [36286547640](https://github.com/zhiheng-zhang-Mera/DS-Hns/actions/runs/36286547640) also passed on the same SHA.

## FINAL W0 observation

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

## E0–E7 and A1–A8 status

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

On a checkout containing the local raw batch, regenerate derived outputs with `deriveBatch(batchDir)` from `scripts/lib/engineering-recovery-evidence.cjs`, then verify the batch with `verifyBatchIntegrity(batchDir)` and the run with `verifyRunIntegrity(runDir)`. The report's batch checksum excludes the report itself to avoid self-reference; the published report contains no changed metric or gate values.
