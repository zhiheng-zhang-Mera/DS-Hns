# Hns Final Qualification and Paper Material Mining Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair all code-fixable RC1 P1/P2 defects, qualify the result from a clean room, conditionally establish the production baseline, and build a provenance-linked paper-material corpus from the complete repository history.

**Architecture:** RC2 starts from the verified remote RC1 head. A single qualification runner owns immutable run directories and derives summaries only from same-run child results. Runtime/test storage roots, plugin identity/state, performance measurement, and UI health semantics are repaired at their owning boundaries; publication is gated on local, clean-room, and GitHub evidence.

**Tech Stack:** Windows PowerShell, Git/GitHub CLI, Node.js CommonJS and `node:test`, Electron 43, npm lockfile install, Windows UI Automation/Computer Use, Markdown/JSON evidence.

**Spec:** Owner request `DS-Hns FINAL QUALIFICATION + PAPER MATERIAL MINING`, received 2026-09-22.

## Global Constraints

- Work only in fresh roots `D:\Hns-Final-Qualification` and later `D:\Hns-Cleanroom-Qualification`.
- Preserve RC1 evidence append-only under `artifacts/qualification/history/<source-sha>`.
- Never lower the 1.2x Phase C threshold, shorten its workload, or replace a failed full run with an isolated rerun.
- Every production fix follows RED -> GREEN and is committed independently where practical.
- Final evidence has one runId, gitSha/tree, timestamps, host/toolchain, command, exit code, and raw source per run.
- Do not merge main or create a production tag until every mandatory local, clean-room, and GitHub gate is green.
- Real reboot and 24h wall-clock soak stay `NOT_RUN` if host/session policy cannot guarantee safe continuation; synthetic evidence is labelled synthetic.
- No subagent or second DS-Hns body participates; the Controller owns implementation, review, Git, and visual acceptance.

## Review Focus

- A test subprocess must inherit the D-drive root even when code historically used `LOCALAPPDATA` or `os.tmpdir()`.
- An installed plugin with stale transient failure history must resolve to one canonical terminal state without hiding genuine materialization failure.
- Benchmark stabilization must remove unrelated noise while preserving workload, correctness, threshold, and measured semantic.
- Canonical plugin identity must merge aliases/sources without losing provider provenance or concealing version conflict.
- Qualification evidence must fail when any child report, exit code, SHA, runId, time ordering, or aggregate count disagrees.

---

### Task 1: Preserve and reconstruct the starting state

**Files:**
- Create: `artifacts/qualification/history/2ae08a73.../ARCHIVE-MANIFEST.json`
- Create: `artifacts/qualification/repository-state.json`

**Interfaces:**
- Consumes: fetched remote refs, GitHub PR/run/protection APIs, RC1 evidence trees.
- Produces: immutable RC1 archive and current ancestry/publication baseline.

- [ ] Archive acceptance, docs acceptance, and visual evidence before production edits.
- [ ] Record main/RC heads, tree, branches/tags, ancestry, open PRs, CI, protection, and rulesets.
- [ ] Commit preservation metadata without reclassifying old evidence as current.

### Task 2: Enforce D-drive storage and process teardown

**Files:**
- Create: `app/runtime/storage-roots.cjs`
- Modify: `scripts/env.ps1`, runtime/test scratch owners, qualification entry points.
- Test: storage-owner tests plus process-leak and C-drive audit tests.

**Interfaces:**
- Consumes: `DSH_TEMP_ROOT`, `DSH_RUNTIME_ROOT`, `DSH_TEST_ROOT`.
- Produces: `resolveStorageRoots(root, env)` and fail-closed post-test audit commands.

- [ ] Add tests that fail for `LOCALAPPDATA`/default-temp scratch and unreaped shutdown children.
- [ ] Trace every current scratch/process owner and document the exact leakage chain.
- [ ] Implement one root resolver and pass its values through all project/test children.
- [ ] Add `POST_TEST_PROCESS_LEAK_GATE` and `C_DRIVE_WRITE_AUDIT`; watch focused tests turn green.
- [ ] Commit the bounded storage/process repair.

### Task 3: Reconcile installer, profile, runtime, and UI plugin state

**Files:**
- Modify: optional installer state, profile adapter, bundled manager, Mega status/UI modules.
- Test: installer optional/plugin manager/control-center tests.

**Interfaces:**
- Consumes: materialized package manifest, profile declaration/lock, registry discovery, transient transaction record.
- Produces: canonical logical plugin state with source provenance and deterministic precedence.

- [ ] Write a failing regression reproducing `installer failed` versus `runtime installed @0.4.7`.
- [ ] Trace source -> materialization -> profile -> registry -> runtime -> UI -> summary.
- [ ] Implement minimal reconciliation where installed materialized truth outranks stale transient failure, but missing/broken materialization remains failed.
- [ ] Run Standard install and visually verify installer/UI agreement.
- [ ] Commit the reconciler and evidence.

### Task 4: Stabilize Phase C without changing semantics

**Files:**
- Modify only the benchmark/runtime code proven to add unrelated noise or optimized-path work.
- Test: combined acceptance and benchmark contract tests.

**Interfaces:**
- Consumes: identical patch/workload, fixed model latency, baseline/optimized execution traces.
- Produces: three mandatory full measurements with baseline ms, optimized ms, improvement, min/median/max/variance.

- [ ] Instrument warm/cold initialization, startup, ordering, filesystem, and scheduler components.
- [ ] Reproduce threshold-edge variance and state one root-cause hypothesis.
- [ ] Add a failing contract/performance regression without changing threshold or workload.
- [ ] Implement the smallest real optimization or measurement-noise exclusion consistent with the original metric.
- [ ] Run full combined acceptance three consecutive times and require every run >=1.2x.
- [ ] Commit code and raw measurements.

### Task 5: Repair canonical plugin rows and optional health semantics

**Files:**
- Modify: Plugin Market registry/view and Mega control-center health copy/model.
- Test: plugin UI, manager, control-center, and view tests.

**Interfaces:**
- Consumes: canonical plugin id plus source/provider records and capability availability reason.
- Produces: one row per logical plugin and explicit optional-unavailable status.

- [ ] Add failing tests for duplicate aliases and unexplained Computer Use degraded state.
- [ ] Implement canonical identity with source provenance, not CSS hiding.
- [ ] Render `Unavailable — no host runtime attached; core unaffected` separately from actual failure.
- [ ] Commit and visually verify official Plugin Market and Mega.

### Task 6: Build same-run qualification evidence orchestration

**Files:**
- Create: `scripts/final-qualification.cjs`, `scripts/evidence-consistency.cjs`.
- Test: `tests/unit/final-qualification-evidence.test.js`.

**Interfaces:**
- Produces immutable `artifacts/qualification/runs/<runId>/raw/*`, `summary.json`, and consistency verdict.

- [ ] Write failing tests for mixed runId/SHA, impossible timestamps, exit/pass disagreement, stale references, and count mismatch.
- [ ] Implement immutable run metadata and child command recording.
- [ ] Derive the summary only from current-run raw results and fail with `QUALIFICATION_EVIDENCE_INCONSISTENT`.
- [ ] Commit the runner and consistency checker.

### Task 7: Full local qualification and real visual acceptance

**Files:**
- Create: current run evidence and UI screenshots/reports.

**Interfaces:**
- Consumes: RC2 candidate SHA/tree and Tasks 2-6 gates.
- Produces: one internally consistent local qualification run.

- [ ] Run syntax, all units, architecture, installer/adapter/plugin/health/restart/continuity, Computer Use long-run, chaos, synthetic soak, combined acceptance, leak, storage, and evidence gates.
- [ ] Explain every repository-defined skip and fail on unexpected skips.
- [ ] Launch isolated Electron; visually re-run official fallback, plugins, persistence, error isolation, long observation, and orb click -> expansion -> feedback.
- [ ] Fix newly reproduced defects with separate RED -> GREEN loops and rerun affected/full gates.

### Task 8: Clean-room qualification

**Files:**
- Create only evidence under the candidate repository; clean-room checkout remains external at `D:\Hns-Cleanroom-Qualification`.

**Interfaces:**
- Consumes: pushed RC2 branch.
- Produces: fresh-clone/bootstrap/dependency/profile/plugin/Electron/qualification results with no reused state.

- [ ] Verify the clean-room root is absent/empty and clone RC2 from remote.
- [ ] Bootstrap with repository-declared npm/lockfile and D-drive roots only.
- [ ] Execute the complete mandatory matrix and real launch from blank state.
- [ ] Import only signed run metadata/evidence references, never caches or live state.

### Task 9: Enhanced real-host qualification

**Files:**
- Create: `REAL_REBOOT_ACCEPTANCE.*`, `REALTIME_24H_SOAK.*` or explicit NOT_RUN records.

**Interfaces:**
- Produces: real-host evidence clearly distinguished from synthetic/stand-in evidence.

- [ ] Determine whether the Codex host/session can safely reboot and automatically resume this exact task; if not, record `REAL_REBOOT_NOT_RUN_BY_HOST_POLICY`.
- [ ] If safe, execute the durable checkpoint/reboot/resume ceremony and prove exactly-once continuation.
- [ ] Determine whether an uninterrupted 24h task can legally complete; if not, record NOT_RUN and continue.
- [ ] If safe, run real wall-clock telemetry and bounded fault/reconnect scenarios for 24h.

### Task 10: Publish RC2, PR, CI, and conditional baseline

**Files:**
- Modify CI only if deterministic coverage is missing, never to exclude failures.

**Interfaces:**
- Consumes: green local and clean-room mandatory gates.
- Produces: PR/CI; only if green, main/tree/tag equality evidence.

- [ ] Push RC2, create PR to main, and wait for terminal required checks.
- [ ] If any mandatory gate or CI is red, retain PR/branch and do not merge/tag.
- [ ] If all mandatory gates are green, merge PR, verify main tree equals qualified tree, run post-merge smoke, create next non-conflicting production baseline tag, and verify tag SHA.

### Task 11: Mine complete Git history into paper material

**Files:**
- Create: `docs/paper-material/README.md`, numbered 01-20 documents, `PAPER_MATERIAL_INDEX.md`, and `data/*.json`.

**Interfaces:**
- Consumes: `git log/show/diff/merge-base/tag`, patch-id lineages, committed tests/evidence.
- Produces: deduplicated logical change lineage, claims, experiments, metrics, negative results, provenance, figures/tables, paper split, and primary outline.

- [ ] Enumerate every commit/ref and compute patch-id-assisted logical lineages.
- [ ] Reconstruct the required architectural phases with representative SHAs and negative results.
- [ ] Build claim-evidence and experiment catalogs; mark unsupported claims rather than deleting them.
- [ ] Create Mermaid/Graphviz-friendly figure sources and performance/failure data.
- [ ] Create all numbered documents and machine-readable datasets, then validate links/JSON.
- [ ] Commit the paper-material corpus independently of qualification verdicts.

### Task 12: Final evidence index and status

**Files:**
- Create: `artifacts/qualification/FINAL_HNS_QUALIFICATION_REPORT.{md,json}` and `FINAL_EVIDENCE_INDEX.{md,json}`.

**Interfaces:**
- Consumes: exact tested/merged SHAs, current-run evidence, PR/CI/tag status, paper corpus.
- Produces: one fail-closed final status.

- [ ] Generate reports distinguishing pass/fail/NOT_RUN, synthetic/real/mock, tested/merged commit.
- [ ] Verify repository cleanliness, remote SHA, process/storage audits, JSON validity, and evidence consistency.
- [ ] Emit only `HNS_PRODUCTION_BASELINE_ESTABLISHED` when every mandatory condition and merge/tag relation is proven; otherwise emit `HNS_FINALIZATION_BLOCKED` with executable blockers.
