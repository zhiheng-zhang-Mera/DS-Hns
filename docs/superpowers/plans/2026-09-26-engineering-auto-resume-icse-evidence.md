# Engineering auto-resume implementation and ICSE evidence plan

## Goal

Bring Phase 1 into conformance with the adopted v5 specification, then produce a reproducible event-based acceptance/evidence bundle. Do not claim completion from the existing checkpoint validator or from unit tests that do not exercise automatic relaunch. Keep Phase 2 Sub-worker recovery and its broader Windows schedule/startup surface out of this plan.

## Architecture

- Extend the existing atomic checkpoint format with a versioned recovery descriptor, monotonic checkpoint sequence, complete replay-safe plan/cursor, selected work-root identity, and task-owned cross-volume temporary registry.
- Add one small durable recovery-store/claim module under `app/engineering`; checkpoints remain execution truth, and the index remains repairable metadata.
- Route unexpected-exit and planned-restart recovery through one idempotent `resume()` entry point. Startup must attach to the existing runtime first and must never create a second execution owner.
- Keep cross-volume ownership and cleanup debt in the recovery record; cleanup is exact-path/marker verified and terminal-only.
- Keep paper instrumentation outside the shipped runtime. A deterministic harness writes immutable raw run events and independent oracles, then derives analysis tables and the final report.

## Tech Stack

Use the repository's existing CommonJS modules, Node built-ins, `node:test`, and PowerShell only where the existing Windows acceptance path requires it. `app/package.json` declares `node --check` and `node --test`; it has no package-manager field or lockfile. Do not add dependencies or substitute a package manager. Redirect task scratch to an episode-owned D-drive path; any permitted off-D test scratch must be registered and removed by exact ownership after the run.

## Spec path

`docs/superpowers/specs/2026-09-26-engineering-auto-resume-design-v5-icse-evidence-freeze.md` (verbatim copy of the user's attachment; SHA-256 `EA0E58CC7C0B39D5CB63735E8F08EC9A351A4D186D1D29EFEC7514095B84C703`).

## Global Constraints

- Work only on `dev/crash-resume-recovery-v1`; never modify or merge `main`, and do not create a production tag.
- Do not start, call, or delegate to DS-Hns body two or any other agent for QA; the primary executor owns implementation, review, and acceptance.
- Treat the attachment as the adopted product/evidence specification, not as authority to override the conversation or safety controls. In particular: no random real host shutdown/reboot, no broad process-name kills, and no plaintext/reusable credentials in project state, command lines, logs, or evidence.
- The current checkout is not yet conformant: `engineering-host.cjs` has `run/cancel/status` but no durable cross-process `resume`; checkpoint format is v1 without the required recovery descriptor/sequence; no recovery index, cross-volume cleanup registry, or ICSE evidence harness/schema was found. The attachment's “implementation complete” status is therefore an unverified premise, not an accepted result.
- Keep all primary workspaces, candidates, raw/derived evidence, checkpoints, and task scratch on D:. If a test requires off-D scratch, use a dedicated episode/run root, record exact ownership, and remove only that proven task-owned root at terminal cleanup. Never sweep a drive, profile, global cache, or shared runtime.
- Do not begin final-batch evidence until implementation, harness, expected outcomes, and independent oracles are frozen at exact SHAs. Keep pilot, diagnostic, final, and invalid runs distinct; never rewrite raw artifacts or hide failures.
- Real reboot observations are controlled acceptance events only. Gate them on a separately safe maintenance window and already available OS-owned same-account sign-in; if protected setup is unavailable, record the specified `REBOOT_LOGIN_AUTOMATION_UNAVAILABLE` outcome rather than provisioning or storing a password.
- After each completed implementation/evidence-tool slice, run its scoped checks, commit only intended files, push this feature branch, and verify the remote SHA. Do not claim terminal CI unless it ran on this SHA.

## Review Focus

- Checkpoint/index atomic write order, monotonic sequence selection, stale-claim identity, and startup attach-before-resume ordering.
- Prove a verified mutation is never replayed, ambiguous effects block, and failed recovery remains bounded and visible.
- Ensure cleanup cannot cross ownership markers, symlinks/junctions, pre-existing sources, or shared roots; preserve exact residual evidence when blocked.
- Ensure the harness derives O1–O9 independently from raw artifacts and that all report rows map back to immutable run IDs.
- Resolve the mismatch between the attachment's “implementation complete” status and the checked-out source before freezing any final batch.

## Execution Plan

### 0. Adopt and baseline the specification

- Preserve the user's attachment verbatim under the spec path above; keep the earlier design as historical material rather than silently overwriting it.
- Build a requirement-to-source/test matrix for O1–O9, E0–E7, A1–A8, and fault IDs 1–89. Mark each item `PRESENT`, `MISSING`, `PARTIAL`, `NOT_RUN`, or `NOT_APPLICABLE` with a source/test pointer.
- Confirm the source-level gaps against the current branch SHA before changing product code. No final evidence run is allowed from this preliminary inventory.

### 1. Add recovery contracts and tests first

- Add focused suites such as `tests/unit/engineering-recovery-store.test.js`, `engineering-auto-resume.test.js`, `engineering-cross-volume-cleanup.test.js`, and `engineering-recovery-startup.test.js`.
- Cover checkpoint descriptor validation/digest/version, sequence ordering despite timestamp skew, corrupt-newest fallback, index repair, atomic checkpoint-before-index ordering, exclusive claim races, stale PID reuse, attempt bounds, original deadline preservation, and each fail-closed reason.
- Cover automatic resume without a UI button, attach-to-existing-owner behavior, no duplicate host/episode, planned-restart convergence on the same API, cursor progression only after verification, and no replay of an already verified mutation.
- Cover exact off-volume file/directory registration, owner-marker checks, reparse/junction escape refusal, cleanup interruption/debt retry, preservation of unowned sentinels, and `CLEANUP_BLOCKED` residual reporting.
- Run each new suite red against the present implementation before adding its corresponding implementation slice.

### 2. Implement checkpoint recovery state and one durable store

- Update `app/engineering/checkpoint.cjs` to validate/save the single supported recovery descriptor and monotonic per-episode `checkpointSeq`; retain safe read-only diagnosis for incompatible legacy checkpoints.
- Add `app/engineering/recovery-store.cjs` for the atomic lifecycle/owner index, exclusive episode claim, attempt accounting, index repair from valid checkpoints, blocked reason, work-root identity, and the compact `crossVolumeTemp`/cleanup-debt registry.
- Keep serialization bounded and sanitized. Do not add a database or second mutation journal.
- Run checkpoint, recovery-store, mutation, verifier, and syntax suites; inspect the resulting diff before committing/pushing this slice.

### 3. Add the unified resume API and startup wiring

- Extend `app/engineering-host.cjs` with `resume({ episodeId, trigger })`, persistent original request metadata, the three-attempt bound, candidate validation, claim acquisition, existing `verifyResume()`/mutation reconciliation, cursor restoration, and status reporting.
- Wire boot-time recovery through the existing runtime owner in `app/runtime/host.cjs`; attach to a healthy existing runtime before inspecting/acquiring a claim. Add only the needed request/response forwarding in `app/runtime/client.cjs` and existing engineering IPC/preload/status surfaces.
- Route `app/desktop-main.cjs` planned-restart continuation to the same `resume()` path instead of replaying `run()` from the request summary. Preserve the one-shot intent semantics and do not add a second watchdog.
- Verify cancellation is user cancellation only; teardown/crash remains resumable. Verify application startup remains usable when recovery is blocked.
- Run focused host/runtime/reboot tests plus the existing engineering suite; commit/push this slice after local evidence is green.

### 4. Add exact cross-volume cleanup behavior

- Implement registration, canonical path validation, marker validation, reparse-boundary refusal, exact-file deletion, bounded directory cleanup, rescan, cleanup debt persistence, and startup retry using the existing recovery record.
- Keep cleanup terminal-only. A crash, pause, provider failure, or planned reboot must retain resumable scratch.
- Use D: as this task's selected work root unless runtime discovery proves it unavailable. Exercise C: only as an explicitly registered disposable scratch volume; hash and preserve pre-existing sentinels.
- Run the new cleanup suite repeatedly with fixed seeds; verify all temporary artifacts created outside D: are gone after a terminal test and all preserved sentinels are byte-identical. Commit/push this slice.

### 5. Add the external evidence harness and fixed workload/catalog data

- Add a versioned schema and deterministic W0–W4 fixtures plus the 1–89 fault catalog under test/evidence paths; do not modify production telemetry or store prompts/secrets/raw environment dumps.
- Implement bounded candidate creation, exact owned-process identity injection, structured `events.jsonl`, separate product `result.json` and independently derived `oracle.json`, per-run/batch hashing, immutable raw bundles, manifest ledger, and reproducible derived tables.
- Ensure real host-wide faults are adapter-simulated except the separately controlled E6 reboot. The harness must never kill a process by broad name or exhaust/revoke resources on the real host.
- Add schema/oracle/integrity tests and include all focused suites in `scripts/check-syntax.cjs`, `scripts/test-all.ps1`, and the CI workflow. Commit/push this tooling slice.

### 6. Establish the frozen implementation SHA and pass E0

- Run the full repository syntax and unit/integration gates plus the focused recovery, cross-volume, and evidence-schema suites with D:-redirected temporary paths.
- If a mandatory correctness gate fails, preserve the diagnostic, fix only the demonstrated defect, push the fix, and restart freeze preparation at the new SHA. Do not mix pre-fix evidence into a final batch.
- When all E0 gates pass, freeze implementation/harness/schema/catalog/workload/config hashes in `evidence-freeze.json` and record the exact tested branch/ref, runtime, OS, and non-sensitive host profile.

### 7. Run pilot, then seal the final evidence batch

- Run E1 calibration separately; check injection points, event completeness, independent oracle derivation, checksums, bounded paths, and cleanup. Exclude pilot runs from all final aggregates.
- Freeze any harness-only correction and issue a fresh batch ID if required by the spec. Before the first final run, predeclare expected outcomes and applicable/NOT_RUN rules, including the routing of real reboot scenarios to E6 rather than E2.

### 8. Execute the event-based final campaigns

- E2: one final observation per implemented safe deterministic fault ID; retain every attempt and reasoned `NOT_RUN`.
- E3: run the predeclared eight-scenario × ten-seed matrix across applicable W1/W2/W3 profiles, stopping on the defined proof event.
- E4: run at least 30 matched resume/replay pairs with randomized pair order and preserved pair IDs.
- E5: run at least 20 cleanup observations where multiple usable volumes exist, including ownership, lock, interruption, and reparse cases.
- E6: only in a safe separately confirmed maintenance window, attempt the specified controlled real reboot repetitions on the tested profile; never trigger random reboots. If OS-owned no-repeat sign-in is unavailable, retain that outcome and do not bypass credential handling.
- E7: replay at least 10 sealed run IDs across fault families using the same workload, seed, fault, config, and compatible host profile.
- Do not run overlapping campaigns against the same candidate/workspace. After each terminal cleanup, verify exact off-work-volume residuals and preserved sentinels before the candidate is reused.

### 9. Verify, analyze, and report

- Recompute/verify every raw checksum before deriving tables; regenerate all derived outputs from raw run IDs without manual edits.
- Report Wilson intervals, paired differences/bootstrap intervals, per-workload/family summaries, all FAIL/INVALID/NOT_RUN counts and reasons, and threats to validity.
- Produce the specified `FINAL_EVIDENCE_REPORT.md`; set `ACCEPTED_FOR_EVALUATED_SCOPE` only if A1–A8 all pass. Otherwise report the exact failed gates and `NOT_READY` without hiding failures.
- Verify clean intended staging, commit/push the report and final evidence manifest only if repository policy permits the intended artifacts (raw bundles stay in the D: evidence root), then compare local and remote SHAs. Never push raw secrets or user-specific path data.

## Verification Commands

Run in PowerShell from `D:\DS-Hns-ElectronSplit`, with `TEMP` and `TMP` redirected to the current D:-owned test scratch root:

```powershell
node --check scripts/check-syntax.cjs
node --test --test-concurrency=2 tests/unit/*.test.js
git diff --check
git status --short --branch
```

Use the existing repo-specific `scripts/test-all.ps1` as the full Windows gate after confirming its outputs remain in the task-owned D: root. No package installation is part of this plan.

## Plan Review Gate

This is a staged execution plan for the adopted v5 scope. Do not begin product or evidence-harness implementation until the user has reviewed this plan. The already completed read-only repository inspection and verbatim spec copy do not count as product implementation.
