# Engineering Episode Crash Recovery, Automatic Resume, Reboot Continuity, Cross-Volume Workspace, and Evidence Capture

Status: functional implementation is treated as complete for this revision. This specification now governs **implementation freeze, final verification, acceptance, and ICSE evidence collection**. Do not add features during the evidence campaign unless a test exposes a correctness defect.

Priority: strongest defensible evidence with bounded machine time. Reuse the implemented recovery system and existing fault harness. Do not create a second recovery subsystem, production telemetry stack, database, dashboard, watchdog, or time-based soak. Tests terminate on proof events rather than arbitrary elapsed time.

## Purpose

After an unexpected termination of the engineering execution process or host, reopening DS-Hns must automatically continue the same active engineering episode from its newest valid checkpoint without requiring a button press. The resumed episode must preserve its identity, workspace, original goal, execution contract, deadline budget, verified progress, and safe execution cursor while refusing unsafe or ambiguous replay.

The completed implementation must now be evaluated through one reproducible evidence pipeline. Functional acceptance and ICSE data collection share the same fault-injection harness and raw event stream, but **product acceptance, experimental analysis, and paper claims remain distinct layers** so that passing a test is not confused with proving a broader empirical claim.

This is Phase 1 of a staged delivery. Phase 2 separately covers Sub-worker task/plan recovery and the full Windows schedule/startup surface. There is **no duration-based soak requirement**. Recovery is accepted when a terminated episode is automatically relaunched, restores the same safe task state, and reaches at least one newer verified checkpoint without replaying already verified work. A real system-reboot check may later reuse the same proof condition; it does not need to run for 24 hours.

## Repository facts

The approved branch is `dev/crash-resume-recovery-v1`, originally based on `923f5293a2ada553cb7f91a4bc1b54e750dfe7c3`; the written design is already committed on that branch.

The checkpoint module in `app/engineering/checkpoint.cjs` writes atomic JSON checkpoints and provides `latest()` plus the separate `verifyResume()` validator. Checkpoints already include episode ID, goal, workspace, fingerprint, plan ID/cursor, verified mutations, owned processes, progress, and phase. The saved plan is currently a summary rather than a complete replay descriptor.

The engineering host in `app/engineering-host.cjs` accepts `run()`, `cancel()`, and `status()` requests, but has no cross-process resume entry point or durable active-request record. The shell/runtime separation already has a single-instance identity and attach path; recovery must use it and must never create a second runtime host.

The existing reboot coordinator has a separate one-shot intent path for planned restarts. Its target resume must converge on the same idempotent episode-resume operation rather than launching a second independent recovery path.

## Design principles

1. **Checkpoint is the execution truth; recovery index is only an index.** A stale index must be repairable from a valid checkpoint.
2. **Advance only after verification.** A cursor advances only after the corresponding mutation or step has been verified.
3. **Ambiguity is not success.** Unobservable external side effects are blocked or reconciled, never blindly replayed.
4. **One episode, one live claim, one execution owner.** Runtime single-instance identity and durable episode claims are complementary, not competing mechanisms.
5. **Recovery must be deterministic enough to test.** Ordering uses a monotonic checkpoint sequence, not filesystem mtime alone.
6. **Evidence is a by-product of acceptance.** The fault harness records structured evidence; the product does not gain a second analytics stack.
7. **Acceptance is event-based, not time-based.** Once automatic relaunch restores the episode and produces a newer verified checkpoint with no duplicate verified effect, the recovery path has demonstrated continuity; no arbitrary 24-hour wait is required.
8. **Windows identity continuity belongs to the OS boundary.** Reboot recovery defaults to the currently logged-in Windows account. DS-Hns may use an OS-native, protected one-time credential/autologon setup so later reboots require no repeated password entry, but DS-Hns must never read back, log, serialize, or store the plaintext password itself.
9. **The selected work volume is a persistence boundary, not an I/O sandbox.** During an active task, DS-Hns may read from and temporarily write to any accessible local volume when required by tools, capacity, compatibility, or performance.
10. **Cross-volume scratch is disposable and non-authoritative.** No verified progress may depend solely on an off-work-volume temporary file. Durable checkpoints, recovery ownership state, cleanup debt, and experiment truth remain on the selected work volume whenever it is available.
11. **Cleanup is ownership-based, never drive-wide.** At terminal completion, DS-Hns removes only task-owned temporary material outside the selected work volume and must preserve all pre-existing/user-owned data.
12. **Scope is process-crash recovery.** Real power-loss durability is not claimed by Phase 1.

## Goals

1. Persist enough versioned state to reconstruct a newly started engineering host's active episode and resume from a verified checkpoint cursor.
2. Automatically attempt recovery on startup when the prior episode was interrupted unexpectedly or has an explicit planned-restart intent.
3. Revalidate the current workspace, repository fingerprint, checkpoint integrity, outstanding mutations, and required owned-process state before resuming.
4. Prevent duplicate host creation, duplicate recovery claims, duplicate verified mutations, unbounded restart loops, cursor regression, and silent success claims.
5. Let the user select a **work volume/work root** (for example `E:`). Durable task state, checkpoints, recovery index, cleanup debt, and evidence should live there. The active task may still read or temporarily write on `C:`, `D:`, or any other accessible volume.
6. Track task-owned temporary files/directories created outside the selected work volume and remove them when the task reaches a terminal completed/cancelled-abandoned state. Pre-existing sources, user files, shared toolchains, and unrelated caches must never be deleted merely because they are on another drive.
7. Produce reproducible, seeded fault-injection evidence in a disposable candidate rooted on the selected work volume, while allowing controlled cross-volume scratch during the test.
8. Produce paper-ready machine-readable results without adding a separate instrumentation project.

## Non-goals

- This phase does not implement Sub-worker task/plan recovery; that is Phase 2.
- It does not add or enable random machine shutdowns or reboots.
- It does not persist plaintext Windows passwords, API keys, provider credentials, arbitrary environment variables, or full command output in DS-Hns-managed files. A later Windows reboot/startup implementation may rely on a one-time OS-native protected credential/autologon configuration for the current account; the secret remains owned by Windows rather than the project.
- It does not automatically replay an old checkpoint that lacks a compatible recovery descriptor.
- It does not provide migration for every historical checkpoint schema. Legacy checkpoints may be listed and diagnosed but are not auto-resumed unless explicitly compatible.
- It does not claim exactly-once semantics for an external side effect whose completion cannot be observed. Such an operation must be verified, idempotent, reconciled, or reported as ambiguous.
- It does not replace the external restart authority or add a second in-process watchdog.
- It does not simulate destructive physical power loss on the live host. Filesystem, process, IPC, provider, plugin, storage, ownership, startup, and resume-boundary failures are exercised through controlled failpoints. A real reboot is a separately controlled acceptance event using the same resume proof condition.
- It does not build a telemetry database, web dashboard, experiment UI, or long-running metrics service.
- It does not treat non-work volumes as forbidden. Cross-volume reads and temporary writes are allowed.
- It does not recursively clean a whole non-work drive, delete pre-existing source data, or infer ownership from path/location alone.

## Approaches considered

### Replay the original goal from the beginning

Mechanically simple, but it can repeat completed file changes, commands, or external work and does not satisfy “resume from the latest checkpoint.” Rejected for the product path. A harness-only replay-from-start mode may be retained as a lightweight experimental baseline because it requires no production architecture.

### Restore from a durable recovery descriptor and the latest checkpoint

Persist the sanitized original request and a complete versioned plan/cursor descriptor alongside each checkpoint. At startup, load the newest valid checkpoint for that episode, validate it against the live workspace, and restore the same episode from the next safe cursor. This preserves progress and enables meaningful tests. Selected.

### Rely only on process relaunch or the planned-reboot intent

A supervisor can reopen a process, and the existing reboot intent can request a planned resume, but neither by itself restores the active engineering plan after an arbitrary process crash. Retain these only as launch/intent mechanisms and route them through the same recovery operation.


## Storage and cross-volume workspace policy

### Terminology

- **work volume / work root**: the user-selected persistent task location. Example: the user selects `E:` and the project/recovery/evidence roots are under `E:`.
- **source path**: any pre-existing file/directory read by the task, regardless of drive. A source path is never cleanup-owned merely because it was accessed.
- **task-owned temporary path**: a file or directory created, copied, unpacked, cloned, generated, cached, or staged specifically for the current episode outside the selected work volume.
- **shared/system path**: OS state, installed toolchains, package-manager global stores, user profiles, shared caches, credentials, or other paths not exclusively owned by the episode.

The selected work volume is the preferred location for durable and reusable state, **not** a restriction on where the running process may perform I/O.

Example policy:

```text
selected work volume = E:

E:\project\...                         persistent project/workspace
E:\.dshns\recovery\...                 durable checkpoint/recovery truth
E:\.dshns\evidence\...                 durable experiment evidence

C:\DS-Hns-Temp\<episode-id>\...        allowed temporary write; delete at terminal cleanup
D:\datasets\input\...                  allowed read; pre-existing user source; NEVER delete
D:\DS-Hns-Temp\<episode-id>\...        allowed temporary copy/build/cache; delete at terminal cleanup
```

The required end state is: after the E-drive episode is fully completed and cleanup is verified, **no task-owned E-project intermediate engineering material remains on C: or D:**. Pre-existing D-drive input data remains untouched.

### Cross-volume I/O rules

1. Read access may use any path allowed by the current account and task policy.
2. Write access may use any accessible local volume when a tool requires it or when it is materially useful for capacity, compatibility, or performance.
3. Prefer the selected work volume for durable outputs, repository state, checkpoints, evidence, final artifacts, and any state required after reboot.
4. Prefer task-scoped temporary roots for off-work-volume writes:
   - `<volume>:\DS-Hns-Temp\<episode-id>\...`, or
   - an equivalent configured root carrying an episode ownership marker.
5. When spawning tools that honor scratch/cache variables, point task-local `TEMP`, `TMP`, cache, unpack, build-scratch, test-output, and similar locations to a registered task-owned root instead of letting tools scatter task-specific intermediates through user profiles.
6. If a tool unavoidably writes an episode-specific file elsewhere, register the exact canonical path as task-owned as soon as it is known.
7. A pre-existing path that the task merely reads or modifies as an explicit user target is **not** a temporary cleanup path.
8. A task may never claim ownership of an entire drive root, user profile, global package store, system temp directory, or shared cache merely because it wrote something beneath it.

### Off-work-volume temporary registry

Use one small `crossVolumeTemp` section in the durable recovery descriptor/index; do not build a second storage service.

Each registered task-owned entry records only what cleanup needs:

- canonical path;
- episode ID;
- owning work root/work volume;
- entry type: `file` or `directory`;
- purpose class: `clone`, `copy`, `unpack`, `build`, `cache`, `test`, `log`, `download`, `tool-scratch`, or `other`;
- whether DS-Hns created the root itself;
- creation/registration timestamp;
- cleanup state: `ACTIVE`, `DELETE_PENDING`, `DELETED`, or `CLEANUP_BLOCKED`.

For a task-created directory root, place a small ownership marker such as `.dshns-episode-owner.json` inside the root containing the episode ID and work-root identity. Cleanup must verify both the durable registry and marker before recursive deletion.

For an individual file outside a task-created root, cleanup may delete only that exact registered canonical path. It must not widen the deletion to its parent directory.

### Recovery semantics for cross-volume scratch

Cross-volume temporary files may survive a process crash and may be reused after verification, but they are **not execution truth**.

On resume:

- if a registered temporary path still exists and its ownership matches, it may be reused;
- if it is missing, the executor either regenerates it or replans/revalidates the affected unverified step;
- missing scratch must not roll back already verified mutations;
- a verified mutation/result must have enough durable proof on the selected work volume to survive loss of every off-work-volume temporary path;
- if an external tool produced an outcome that cannot be reconstructed or verified without a missing temporary path, treat that specific outcome as ambiguous and fail closed rather than replaying blindly.

Do **not** run terminal cleanup during an unclean exit, planned reboot, or resumable pause. Cleanup is terminal-state work.

### Terminal cleanup contract

A terminal episode is not fully clean until the cross-volume cleanup gate finishes.

Cleanup is required after:

- successful task completion;
- explicit terminal cancellation/abandonment after the executor has reached a safe boundary.

Cleanup is **not** triggered by:

- crash;
- process restart;
- planned reboot;
- temporary pause;
- recoverable provider/plugin/network failure.

Cleanup sequence:

1. freeze new task writes;
2. load the durable cross-volume registry from the selected work volume;
3. canonicalize every candidate path and re-check ownership;
4. reject any candidate that is pre-existing/unowned, outside its registered task-created root, or traverses an unsafe junction/symlink/reparse boundary;
5. delete task-owned individual files and task-created roots;
6. retry bounded transient failures such as file locks;
7. rescan the registered paths;
8. emit a cleanup result containing deleted entries, preserved/unowned entries, and exact residual task-owned paths;
9. mark the episode `CLEAN_COMPLETE` only when the residual task-owned off-work-volume count is zero.

If a task-owned temporary file is locked or cannot be deleted safely, persist a **cleanup debt** on the selected work volume and retry it on the next safe application startup. Do not silently report a clean finish. Use a stable state such as `CLEANUP_BLOCKED` when residual task-owned paths remain after bounded retries.

### What cleanup must never delete

Even when located outside the selected work volume, preserve:

- pre-existing user files/directories;
- input datasets and source repositories that were only read;
- explicit user targets the task intentionally edited;
- Windows/user profiles;
- OS-managed state;
- protected credential state;
- installed runtimes/toolchains;
- global package stores unless the task created an episode-exclusive subdirectory;
- unrelated or shared caches;
- junction/symlink targets not proven to be inside a task-owned root;
- files whose episode ownership cannot be proven.


## Proposed architecture

### 1. Recovery descriptor embedded in checkpoints

Extend the checkpoint format with one versioned `recovery` descriptor. If this changes the checkpoint schema, bump the checkpoint version once; do not add a parallel legacy format.

Minimum fields:

- `recovery.version`;
- `episodeId`;
- sanitized original request: canonical workspace, goal, original start time, absolute deadline, and supported execution-contract fields;
- `plan.version`, complete serializable plan, and stable `planDigest`;
- `cursor.nextStepIndex`, `cursor.lastVerifiedStepId`, and `checkpointSeq`;
- workspace/repository fingerprint required by the existing resume verifier;
- verified mutation identifiers and any unresolved mutation identifiers already maintained by the supervisor;
- owned-process reconciliation data already needed by `verifyResume()`;
- runtime/executor compatibility version sufficient to refuse an incompatible plan after a software upgrade;
- selected work volume/work root identity;
- registered task-owned off-work-volume temporary paths and cleanup state.

`checkpointSeq` is monotonically increasing within an episode and is the primary ordering key. Timestamp remains evidence, not ordering authority. A corrupt or partial higher sequence may be skipped in favor of the next lower valid sequence.

A cursor means **the next step that may safely execute**. It is advanced only after the previous step has been verified. This definition must be used in code, tests, logs, and experiment output to avoid off-by-one replay.

### 2. Durable recovery index

Add one focused recovery-store module under `app/engineering`. It owns a small atomic, versioned index under the configured runtime root, adjacent to engineering checkpoints.

Minimum index fields:

- schema version, episode ID, lifecycle state, and update timestamp;
- latest known valid `checkpointSeq` and filename;
- current execution-owner instance ID and process identity used for stale-owner detection;
- automatic-resume attempt count and last outcome;
- selected work root and cross-volume cleanup-debt summary;
- last blocked reason, if any.

The checkpoint is the source of truth for request, plan, cursor, and verified progress. The recovery index is only the lifecycle/owner index.

Write ordering:

1. write checkpoint temp file in the target directory;
2. finish and close the file;
3. atomically rename/replace it into the checkpoint path;
4. update the recovery index to reference that sequence.

If the process dies between steps 3 and 4, startup scans valid checkpoints, selects the highest valid `checkpointSeq`, and repairs the index. Do not add a multi-file transaction engine.

The guarantee of this phase is atomicity against process interruption. Real power-loss persistence beyond the filesystem guarantees is not claimed. Do not delay Phase 1 to add a custom fsync protocol unless the repository already has a trivial reusable helper.

### 3. Minimal lifecycle state machine

Keep lifecycle states small:

- `ACTIVE` — episode has resumable work;
- `RECOVERY_BLOCKED` — state was found but safe automatic continuation is impossible;
- `COMPLETED` — terminal success;
- `CANCELLED` — explicit user cancellation acknowledged at a safe boundary.

Do not add `RESUMING` as another persistent lifecycle state. A separate durable claim represents in-progress recovery.

Important distinction: an application/process teardown is **not** equivalent to user cancellation. Only the explicit cancel path may persist `CANCELLED`. A killed process, crashed host, app close before explicit cancellation acknowledgement, or planned restart keeps the episode recoverable as `ACTIVE`.

Allowed transitions are intentionally narrow:

- `ACTIVE -> COMPLETED`
- `ACTIVE -> CANCELLED`
- `ACTIVE -> RECOVERY_BLOCKED`
- `RECOVERY_BLOCKED -> ACTIVE` only after an explicit repair/replan path that creates a new verified checkpoint or supported recovery descriptor

Terminal states are never auto-resumed.

### 4. Durable episode claim

The current design requires one durable claim keyed by episode ID; define it concretely so two startup paths cannot race.

Use a small claim file under the recovery root, created with exclusive-create semantics. It contains:

- episode ID;
- owner instance ID;
- PID plus the strongest already-available process identity/start marker;
- claimed checkpoint sequence;
- claim timestamp.

Rules:

1. attach to an existing healthy runtime before examining claims;
2. if an eligible episode has no claim, create it exclusively and continue;
3. if the claim exists and its owner is alive and matches the runtime identity, do not resume again;
4. if the claim owner is absent/stale, archive or replace the stale claim atomically and acquire a new claim;
5. do not use a time-only lease as proof of death;
6. keep the claim for the lifetime of the active resumed episode; terminal completion/cancellation removes it, while a crash naturally leaves it stale for the next owner.

No distributed lock service is required because this phase targets the existing single-machine execution model.

### 5. Mutation and side-effect recovery rule

Reuse the existing mutation verification/recovery path. Do not create a second mutation journal unless the current supervisor lacks enough information to distinguish verified and unresolved work.

For every resumable mutation, the recovery decision must resolve to one of:

- `VERIFIED_DONE` — cursor may remain after it; never replay it;
- `SAFE_TO_RETRY` — operation is idempotent or its absence is verified;
- `RECONCILED` — outcome was inspected and converted into a verified state;
- `AMBIGUOUS` — stop with `RECOVERY_BLOCKED`.

An external action whose success cannot be observed is never silently repeated.

Tests must explicitly prove that a verified mutation before the crash is not executed again after resume.

### 6. Plan compatibility rule

Recovery must not execute a serialized plan under an unknown executor contract.

The checkpoint therefore stores a small compatibility version plus `planDigest`. Startup resumes only when:

- recovery descriptor version is supported;
- plan version is supported;
- serialized plan validates;
- plan digest matches the embedded plan;
- workspace/repository checks pass;
- executor compatibility is explicitly accepted.

For Phase 1, unsupported versions are blocked rather than migrated. This is deliberate scope control.

### 7. Resume API

Add one cross-process resume entry point to the engineering host. Planned restart and crash recovery must both call it.

Suggested semantic contract:

`resume({ episodeId, trigger }) -> { ok, accepted, episode, checkpointSeq, cursor, outcome/code }`

The resume API:

1. refuses when another episode is already active;
2. loads the highest valid checkpoint sequence for the episode;
3. validates descriptor and plan compatibility;
4. calls the existing `verifyResume()` against the live workspace;
5. reconciles required mutations/process state;
6. reconstructs the same episode ID and plan;
7. begins execution at `cursor.nextStepIndex`;
8. does not acknowledge successful recovery until the executor has accepted the restored episode;
9. resets the consecutive recovery-failure counter only after the resumed episode writes a newer valid checkpoint.

An “attempt” is counted only after an eligible candidate has acquired the durable claim and enters recovery validation. Merely attaching to a healthy host, finding no candidate, or reading status does not consume an attempt.

### 8. Startup and planned-restart flow

Startup ordering is fixed:

1. attach to an existing healthy runtime host if present;
2. otherwise create the one execution owner;
3. inspect recovery index and newest valid checkpoint;
4. ignore terminal episodes;
5. acquire the durable episode claim;
6. call the single resume API with trigger `unclean_exit` or `planned_restart`;
7. expose recovery outcome through existing status/UI surfaces.

A compatible, verified recovery candidate resumes without UI interaction. Unsafe or ambiguous state is the only intentional exception.

### 9. Windows reboot/account continuity contract

The Windows reboot path must preserve the same user context without requiring the user to type the password again on every reboot.

Default behavior:

1. before enabling unattended reboot recovery, capture the identity of the current interactive Windows account using stable OS identity information (for example SID + account name);
2. use that same account as the default startup/recovery account;
3. if the machine already has a Windows-native unattended sign-in/startup configuration for that account, reuse it;
4. otherwise, the setup surface may request the account credential **once** through a Windows-native protected credential/autologon flow;
5. after provisioning, later automated reboots must not ask the user to re-enter the password merely so DS-Hns can resume;
6. DS-Hns must never attempt to extract the password from the existing logged-in session—Windows does not expose the current plaintext password for this purpose;
7. plaintext credentials must never be written to repository files, recovery state, evidence files, logs, command lines, environment dumps, or app configuration;
8. after reboot, Windows establishes the session using the OS-owned protected mechanism, the normal DS-Hns startup path runs under the same account, and recovery converges on the same `resume()` API;
9. experiment output records only booleans/coarse facts such as `sameWindowsAccount=true` and `manualCredentialPromptObserved=false`; it does not record account names, SIDs, password material, or credential-store contents.

If protected unattended sign-in cannot be provisioned safely on a host, mark the reboot case `REBOOT_LOGIN_AUTOMATION_UNAVAILABLE` rather than weakening credential handling. Process-crash recovery remains independently valid.

### 10. Fail-closed outcomes and reason taxonomy

Use stable machine-readable reason codes so tests and paper evidence do not parse prose.

Minimum reasons:

- `NO_VALID_CHECKPOINT`
- `LEGACY_CHECKPOINT_NO_DESCRIPTOR`
- `UNSUPPORTED_RECOVERY_VERSION`
- `PLAN_DIGEST_MISMATCH`
- `WORKSPACE_MISSING`
- `REPOSITORY_DRIFT_REPLAN_REQUIRED`
- `AMBIGUOUS_MUTATION`
- `OWNED_PROCESS_UNSAFE`
- `CLAIM_ALREADY_OWNED`
- `RECOVERY_ATTEMPT_LIMIT`
- `STORAGE_ERROR`

Limit automatic startup recovery to three consecutive unsuccessful attempts. After the limit, keep the application available, preserve diagnostics, and expose `RECOVERY_BLOCKED`. Never report an episode as complete merely because the host restarted or accepted a recovery request.


## Post-implementation evidence freeze

The evidence campaign starts only after the implementation under test is frozen.

Create one batch-level `evidence-freeze.json` containing:

- `batchId`;
- exact implementation commit SHA;
- exact fault-harness commit SHA if the harness is not in the same commit;
- evidence schema version and schema hash;
- fault-catalog version and catalog hash;
- workload-suite version and content hash;
- recovery configuration hash;
- branch/ref used to build the tested executable;
- OS build, Node/runtime version, and application build identifier;
- test-host profile IDs containing only non-sensitive hardware/OS facts;
- UTC/local start time;
- statement that pilot runs are excluded from the final batch.

Rules:

1. once the first final-batch run starts, do not modify implementation code, oracle logic, workload definitions, expected outcomes, or metric formulas inside that batch;
2. if a product defect is found, preserve the failed run, fix the defect, increment the batch ID, freeze a new implementation SHA, and rerun the affected campaign; do not merge pre-fix and post-fix results into one empirical population;
3. a harness-only repair that cannot affect product behavior may remain in the same campaign only if the original raw events are preserved and the repair is explicitly versioned; otherwise create a new batch;
4. pilot/tuning runs are stored separately and never counted as final evidence;
5. all final paper tables must identify the batch ID and implementation SHA from which they were generated.

The public/design branch may move independently; the **actual tested implementation SHA** is the only code identity used in the experiment.

## Test workload suite

Do not rely on one toy workload. Use a small deterministic suite that covers the recovery mechanisms without turning the experiment into a benchmark project.

### W0 — recovery micro-workload

Purpose: exhaustive fault-point coverage at minimum cost.

Properties:

- deterministic local repository;
- 8–12 ordered steps;
- at least three file mutations with explicit post-mutation verification;
- at least two non-mutating command/test steps;
- checkpoint after every safe boundary;
- no external network dependency;
- stable expected file hashes and cursor transitions.

Use W0 for the one-pass sweep of the complete implemented fault catalog.

### W1 — representative repository-engineering workload

Purpose: demonstrate that results survive a more realistic multi-file engineering episode.

Properties:

- multiple source/test files;
- discovery/read → edit → test → repair/verify style flow;
- at least five verified mutations;
- multiple checkpoints;
- deterministic local tests;
- workload small enough to finish quickly when run without faults.

### W2 — cross-volume workload

Purpose: validate scratch portability and terminal hygiene.

Properties:

- selected work root on one volume;
- pre-existing read-only/preserved source sentinel on another volume;
- task-owned scratch/build/test material on at least one non-work volume;
- cryptographic hashes for all preserved sentinels before and after the run;
- cleanup registry populated during work;
- terminal cleanup expected to leave zero task-owned residuals off the work volume.

If the host has only one usable volume, mark W2 `NOT_RUN_SINGLE_VOLUME` and exclude cross-volume claims for that host.

### W3 — provider/plugin/IPC boundary workload

Purpose: test restart/recovery decisions around transient adapters without depending on uncontrolled public-provider behavior.

Properties:

- deterministic injectable provider/plugin/IPC adapters;
- success, timeout, disconnect, malformed-response, and delayed-response modes;
- stable expected recovery/block outcome per mode;
- bounded payloads and no real secrets.

### W4 — controlled reboot workload

Purpose: validate the real OS/application relaunch path.

Properties:

- short local deterministic episode;
- at least one verified mutation and valid checkpoint before reboot;
- no dependence on provider availability for the first post-reboot proof checkpoint;
- same-account and no-repeat-credential-prompt observation;
- stop after the first newer verified post-reboot checkpoint unless terminal cleanup is the target.

## Independent test oracles

Paper evidence must not depend on one high-level `PASS` flag emitted by the same code that is being tested. The harness independently derives or verifies the following oracles from checkpoints, repository/file state, process identity, sentinels, and structured events.

### Safety oracles

- **O1 Progress preservation:** `lostVerifiedSteps == 0`.
- **O2 No verified replay:** `verifiedMutationReplayCount == 0`.
- **O3 No duplicate effect:** `duplicateEffectCount == 0`.
- **O4 Cursor monotonicity:** restored cursor never precedes the newest valid verified checkpoint.
- **O5 Fail-closed correctness:** an intentionally unsafe case emits the predeclared stable block code and performs zero post-block mutations.
- **O6 Single execution owner:** at no time are two valid live claims/hosts executing the same episode.
- **O7 Cleanup safety:** only registered/owned temporary paths are deleted; every preserved sentinel remains byte-identical.
- **O8 Cleanup completeness:** terminal successful cleanup leaves zero registered task-owned residuals outside the selected work volume.
- **O9 Reboot autonomy:** when reboot automation is supported, the same Windows account resumes DS-Hns without a repeated credential prompt and reaches a newer verified checkpoint.

Any O1–O7 violation is a **correctness failure**, not a statistical outlier and not an ignorable flaky run.

### Performance/progress oracles

These are measured, not pass/fail safety conditions:

- fault → recovery-candidate latency;
- fault → resume-accepted latency;
- fault → first newer verified checkpoint latency;
- number of steps re-executed;
- verified steps preserved;
- cleanup duration;
- checkpoint write cost if already available;
- end-to-end completion time only for runs intentionally allowed to finish.

Use a monotonic clock for durations. Wall-clock timestamps remain for audit chronology only.


## Fault-injection design

A disposable candidate rooted on the user-selected work volume receives a recorded random seed and a broad but bounded fault catalog. Every injected fault is scoped to the candidate root and exact owned process identity. Broad process-name kills are forbidden.

The catalog should be **broad in causes but cheap in execution**: add many deterministic injectable failure points, but do not run a Cartesian product of every fault × every timing × every seed. Each supported fault point needs at least one acceptance observation; high-risk families receive repeated seeds.

### Process / host termination

1. desktop shell terminated before an engineering request is accepted;
2. desktop shell terminated immediately after request acceptance;
3. runtime host terminated while idle between steps;
4. runtime host terminated immediately after a verified mutation;
5. runtime host terminated immediately before a checkpoint;
6. runtime host terminated immediately after a checkpoint;
7. renderer terminated while the runtime host remains healthy;
8. owned worker process terminated during non-mutating work;
9. owned worker process terminated immediately before reporting completion;
10. plugin host/subprocess exits unexpectedly;
11. provider adapter subprocess/session disconnects unexpectedly;
12. injected unhandled exception at a safe step boundary;
13. injected rejected async operation at a safe step boundary;
14. simulated resource-exhaustion termination of the owned candidate process (without exhausting the real host).

### Checkpoint / recovery-store boundaries

15. failure before checkpoint temp-file creation;
16. failure during checkpoint temp write;
17. truncated checkpoint JSON;
18. syntactically valid but schema-invalid checkpoint;
19. checkpoint with invalid `planDigest`;
20. checkpoint with unsupported recovery/plan version;
21. failure immediately before checkpoint rename;
22. failure immediately after checkpoint rename;
23. failure after checkpoint persistence but before recovery-index acknowledgement;
24. stale recovery index pointing to an older valid checkpoint;
25. corrupt recovery index with valid checkpoints present;
26. missing recovery index with valid checkpoints present;
27. corrupt newest checkpoint with older valid checkpoint available;
28. sequence gap in checkpoint numbering;
29. duplicate/conflicting checkpoint sequence candidate;
30. simulated checkpoint-root permission denial;
31. simulated storage write failure / ENOSPC-like adapter result;
32. simulated rename/replace failure;
33. simulated temporary file already exists / collision;
34. recovery-root temporarily unavailable, then restored before retry.

### Claim / ownership / startup races

35. stale recovery claim whose prior PID is dead;
36. stale claim whose PID was reused but process identity does not match;
37. live valid claim owned by the existing runtime;
38. two app launches racing to recover the same episode;
39. planned-restart trigger racing with unclean-exit detection;
40. crash after claim acquisition but before `verifyResume()`;
41. crash after `verifyResume()` but before executor acceptance;
42. crash after executor acceptance but before first post-resume checkpoint;
43. existing healthy runtime discovered after a second launcher starts;
44. delayed app startup after OS/session startup;
45. startup while network/provider is not yet available.

### Workspace / repository / mutation safety

46. workspace missing;
47. workspace moved/renamed;
48. repository HEAD changed externally;
49. branch changed externally;
50. dirty-tree drift affecting a planned mutation target;
51. verified mutation still present exactly as expected;
52. previously unverified mutation proven absent and safe to retry;
53. mutation outcome reconciled from live repository state;
54. external side effect outcome ambiguous and therefore blocked;
55. required owned process still alive and safely re-attachable;
56. required owned process identity ambiguous/unsafe;
57. execution contract incompatible with restored plan;
58. deadline already expired while the app was down.

### Provider / IPC / plugin / transient environment faults

59. provider timeout;
60. provider connection reset/disconnect;
61. provider temporarily unavailable then recovers;
62. provider authentication failure surfaced as non-resumable until credentials are restored;
63. malformed provider response through a test adapter;
64. plugin invocation timeout;
65. plugin process crash;
66. malformed plugin response;
67. IPC channel disconnect between shell and runtime;
68. IPC response lost after the runtime accepted the action;
69. delayed IPC response arriving after relaunch;
70. transient file lock / sharing violation through an adapter;
71. transient permission denial that clears on retry;
72. test-only clock jump affecting timestamps while checkpoint sequence remains authoritative.

### Reboot/startup acceptance faults

73. controlled Windows reboot after a verified checkpoint;
74. reboot after planned-restart intent is persisted but before it is acknowledged;
75. reboot with delayed network availability;
76. reboot with DS-Hns startup delayed;
77. reboot where the same Windows account is restored automatically;
78. reboot where unattended Windows sign-in is unavailable — expected safe diagnostic, not credential bypass.

### Cross-volume scratch / cleanup faults

79. selected work volume is `E:` while a tool requires task scratch on `C:`;
80. task reads a pre-existing `D:` source while writing a temporary derivative on `C:`; cleanup must preserve the D source;
81. registered off-work-volume scratch is missing after crash; resume regenerates/revalidates without losing verified progress;
82. off-work-volume scratch survives crash and is safely reused after ownership verification;
83. cross-volume temporary root contains an unexpected foreign file; cleanup refuses to delete the foreign entry/root blindly;
84. cleanup encounters a locked task-owned file and retries;
85. cleanup is interrupted mid-delete; next startup resumes cleanup debt idempotently;
86. cleanup registry contains a path whose ownership marker mismatches the episode; deletion is refused;
87. a task-owned directory contains a junction/symlink/reparse point escaping the owned root; cleanup does not traverse/delete the external target;
88. one off-work-volume temp path cannot be deleted after bounded retries; episode reports `CLEANUP_BLOCKED` with the exact residual path;
89. terminal cleanup completes across multiple non-work volumes and verifies zero task-owned residuals outside the selected work volume.

Random selection is reproducible from the seed. Test adapters should simulate destructive or host-wide conditions instead of filling the real disk, revoking real permissions, corrupting the real profile, or killing unrelated processes.

A fault test ends as soon as one of two proof points is reached:

- **resume success proof:** the same episode is automatically accepted after relaunch and writes the first newer verified checkpoint with no lost/replayed verified mutation; or
- **expected block proof:** the correct stable block code is emitted and zero new mutations execute.

The harness does **not** need to wait for the entire engineering task to finish once the relevant proof point is captured.

## ICSE evidence capture — final schema

### Evidence architecture

Do **not** add production analytics. The external fault/recovery harness owns the evidence bundle and observes DS-Hns through stable product interfaces plus independent filesystem/process oracles.

Batch layout:

```text
<selected-work-root>/.dshns/evidence/recovery/<batch-id>/
  evidence-freeze.json
  batch-manifest.json
  runs/
    <run-id>/
      manifest.json
      events.jsonl
      result.json
      oracle.json
      SHA256SUMS.txt
  derived/
    runs.csv
    fault-coverage.csv
    rq1-correctness.csv
    rq2-efficiency.csv
    rq3-robustness.csv
    reboot.csv
    cleanup.csv
    analysis.json
    analysis.md
  SHA256SUMS.txt
```

`runs/` is raw evidence. `derived/` is reproducibly generated and may be deleted/rebuilt at any time.

### `manifest.json`

Record once per run:

- evidence schema version;
- batch ID, run ID, run ordinal, and seed;
- implementation SHA and harness SHA;
- workload ID/version/hash;
- fault catalog version/hash;
- fault family, fault ID, injection point, and expected outcome;
- pair ID when the run is part of a baseline pair;
- episode ID;
- build/runtime/OS versions;
- host profile ID, logical CPU count, memory-size bucket, and storage-volume roles;
- selected work root/work volume;
- volumes used for task-owned scratch;
- candidate root;
- recovery configuration hash;
- whether this is `FINAL`, `PILOT`, or `DIAGNOSTIC`;
- start timestamp.

Do not put secrets, account names, machine serials, full prompts, or unbounded paths in paper-exported manifests.

### `events.jsonl`

Append ordered structured events. Minimum events include:

- `episode_started`;
- `checkpoint_observed`;
- `fault_armed`;
- `fault_injected`;
- `target_exit_observed`;
- `relaunch_started`;
- `windows_session_restored` when applicable;
- `app_relaunched`;
- `recovery_candidate_detected`;
- `recovery_claim_acquired`;
- `recovery_verified`;
- `resume_accepted`;
- `first_post_resume_checkpoint`;
- `recovery_blocked`;
- `cross_volume_temp_registered`;
- `cleanup_started`;
- `cleanup_entry_deleted`;
- `cleanup_entry_preserved_unowned`;
- `cleanup_retry`;
- `cleanup_verified`;
- `episode_completed`;
- `run_stopped`.

Every event contains:

- batch ID and run ID;
- episode ID;
- local monotonic event sequence;
- monotonic timestamp/delta suitable for latency;
- wall-clock timestamp for audit;
- checkpoint sequence/cursor when relevant;
- bounded reason/status code;
- fault ID when relevant.

Do not duplicate full plans, prompts, provider responses, environment dumps, or command logs into the evidence stream.

### `oracle.json`

The harness writes independently derived oracle results:

```text
O1_progress_preservation
O2_no_verified_replay
O3_no_duplicate_effect
O4_cursor_monotonic
O5_fail_closed_correct
O6_single_execution_owner
O7_cleanup_safety
O8_cleanup_completeness
O9_reboot_autonomy
```

Each oracle contains:

- `applicable`;
- `pass`;
- machine-readable observation(s);
- source artifact/event IDs used to derive it;
- failure reason if false.

This file is intentionally separate from product-reported `result.json`.

### `result.json`

Compute one normalized outcome per run:

- `classification`: `PASS`, `EXPECTED_BLOCK`, `FAIL`, or `INVALID`;
- `invalidReason` when invalid;
- `expectedOutcome` and `actualOutcome`;
- `eligibleResume`;
- `resumeSucceeded`;
- `resumeProofReached`;
- `blockedReason`;
- checkpoint/cursor before fault and after recovery;
- `lostVerifiedSteps`;
- `verifiedMutationReplayCount`;
- `duplicateEffectCount`;
- `stepsReexecuted`;
- `verifiedStepsPreserved`;
- `faultToCandidateMs`;
- `faultToResumeAcceptedMs`;
- `faultToFirstNewCheckpointMs`;
- `cleanupDurationMs`;
- `offWorkVolumeTempCreatedCount`;
- `offWorkVolumeTempDeletedCount`;
- `offWorkVolumeResidualCount`;
- `fallbackToOlderCheckpoint`;
- `claimConflictCount`;
- `sameWindowsAccount` when applicable;
- `manualCredentialPromptObserved` when applicable;
- `testStopReason`;
- `totalCompletionMs` only when intentionally measured;
- all applicable oracle pass/fail values.

### Evidence integrity

At run close:

1. flush and close raw files;
2. compute SHA-256 for each raw artifact;
3. write run-level `SHA256SUMS.txt`;
4. append the run ID/classification to `batch-manifest.json`;
5. never rewrite raw evidence after sealing;
6. generate batch-level checksums after the final run.

The summary generator must verify hashes before reading a run. A hash mismatch makes that run `INVALID_EVIDENCE_INTEGRITY`, not a pass or fail.

## ICSE research questions and claim mapping

Keep the paper evaluation compact. Three RQs are sufficient; reboot and cross-volume behavior sit under robustness rather than becoming separate headline questions.

### RQ1 — Recovery safety and correctness

**Question:** Under controlled failures at execution, persistence, ownership, and restart boundaries, does DS-Hns recover without losing verified progress, replaying verified mutations, duplicating effects, or executing unsafe ambiguous work?

Primary evidence:

- O1–O6;
- eligible-resume success;
- expected-block correctness;
- full fault-catalog coverage;
- counts of fallback/reconciliation outcomes.

Permitted claim form:

> Across the tested fault catalog/workloads, recovery preserved verified progress and prevented duplicate verified effects, while unsafe states failed closed.

Do not generalize this into “exactly once for all external side effects.”

### RQ2 — Recovery efficiency and preserved work

**Question:** Compared with replaying the episode from the beginning, how much previously verified work is preserved and how quickly does useful verified work resume?

Primary evidence:

- fault → resume latency;
- fault → first newer verified checkpoint latency;
- steps re-executed;
- verified steps preserved;
- paired replay-from-start baseline.

Permitted claim form:

> Checkpoint recovery reduced re-execution and time to new verified progress relative to the paired replay baseline for the tested workloads.

### RQ3 — Robustness across boundaries and operating conditions

**Question:** Are recovery decisions stable across fault families, representative workloads, reboot/startup boundaries, and cross-volume scratch/cleanup conditions?

Primary evidence:

- per-family/per-workload correctness;
- deterministic seed replay;
- reboot-autonomy observations;
- cross-volume cleanup safety/completeness;
- host/environment stratification where available.

Permitted claim form:

> The same recovery invariants held across the tested process, persistence, adapter, startup, and storage-boundary scenarios.

Do not claim hardware/OS/provider generality beyond the measured environments.

## Final experiment protocol

### E0 — repository regression gate

Run once on the frozen implementation SHA before collecting final evidence:

- full repository unit/integration tests;
- syntax/lint/type gates that exist in the repository;
- focused recovery tests;
- focused cleanup/cross-volume tests;
- evidence-schema validation tests.

If E0 fails, do not start a final evidence batch.

### E1 — pilot/calibration runs

Run a small set only to verify harness timing, fault placement, event completeness, and oracle derivation.

Pilot data is retained for debugging but **excluded from every final aggregate**.

Freeze any necessary harness/config changes after E1, then create a new final batch ID.

### E2 — exhaustive implemented fault-catalog sweep

Use W0 and run every implemented, safe, deterministic fault point once.

For the current catalog, the target is all applicable fault IDs 1–89.

Requirements:

- expected outcome is declared before the run;
- every implemented fault receives exactly one final sweep observation;
- destructive/unavailable cases are `NOT_RUN` with a precise reason;
- `NOT_RUN` cases are excluded from the denominator and from claims about coverage;
- any safety-oracle failure stops acceptance and triggers defect diagnosis.

This stage establishes **breadth**, not statistical reliability.

### E3 — repeated stratified robustness matrix

Use representative workloads W1, W2, and W3.

Select eight predeclared core scenarios spanning:

1. process/host kill after verified mutation;
2. checkpoint/index boundary failure;
3. corrupt-newest-checkpoint fallback;
4. duplicate/stale claim race;
5. crash during resume boundary;
6. mutation ambiguity or repository drift fail-closed case;
7. provider/plugin/IPC interruption;
8. cross-volume cleanup/recovery interruption.

Run each applicable scenario with **10 deterministic seeds per workload**:

```text
8 scenarios × 10 seeds × 3 workloads = up to 240 runs
```

W2 is skipped only on a host without distinct usable volumes; record the reduced denominator.

A successful recovery run stops at the first newer verified checkpoint unless the scenario specifically measures terminal cleanup. A blocked run stops once the expected block code and zero-new-mutation oracle are verified.

This is the main repeated evidence population.

### E4 — paired replay-from-start baseline

Use a predeclared subset of at least **30 matched pairs**.

For each pair, hold constant:

- workload;
- seed;
- pre-fault progress point;
- fault point;
- host/environment profile.

Run:

- A: implemented checkpoint resume;
- B: harness-only replay from original goal/start.

Primary paired outcomes:

- steps re-executed;
- time to first new verified checkpoint;
- total completion time only where both members are intentionally allowed to finish.

Randomize A/B execution order within pairs to reduce warm-cache/order bias.

Baseline runs must not alter production recovery behavior.

### E5 — cross-volume terminal-cleanup campaign

Run at least **20 terminal cleanup observations** when multiple volumes are available, covering:

- preserved pre-existing source on a non-work volume;
- task-owned scratch on one or more other volumes;
- missing scratch after crash;
- surviving scratch after crash;
- locked file retry;
- interrupted cleanup + cleanup-debt resume;
- ownership-marker mismatch;
- junction/symlink escape protection.

Before each run, hash preserved sentinels. After cleanup:

- all preserved sentinel hashes must match;
- `offWorkVolumeResidualCount == 0` for successful cleanup;
- any intentionally undeletable owned residual must produce `CLEANUP_BLOCKED` rather than false success.

### E6 — controlled real reboot campaign

No duration soak.

Minimum final evidence:

- **5 successful controlled reboot repetitions on each host profile used for the reboot claim**, with a minimum of 5 total if only one qualifying host is available.

For each reboot:

1. reach a verified checkpoint;
2. persist planned-restart/recovery state;
3. reboot through the real Windows path;
4. restore the same account without a repeated credential prompt after provisioning;
5. launch/attach DS-Hns automatically;
6. resume the same episode;
7. reach one newer verified checkpoint;
8. verify O1–O6 and O9.

Stop there unless terminal cleanup is part of the run.

A simulated reboot does not count toward E6.

### E7 — reproducibility replay

Select at least **10 final-batch run IDs** across different fault families.

Re-run the same:

- workload version;
- seed;
- fault ID;
- configuration;
- compatible host profile.

Check that the same fault is injected at the intended logical boundary and that the same recovery decision class occurs (`RESUME` vs expected `BLOCK`). Exact millisecond latency need not match.

## Run classification and exclusion rules

Every attempted final run remains in the batch ledger.

Allowed classifications:

- `PASS`: eligible recovery or terminal cleanup satisfied all applicable oracles;
- `EXPECTED_BLOCK`: predeclared unsafe state blocked with the exact expected code and zero unsafe mutation;
- `FAIL`: product behavior violated an applicable oracle or expected outcome;
- `INVALID`: evidence cannot answer the question because the harness/environment failed independently of product behavior.

Predeclare invalid reasons, including:

- fault was never injected;
- candidate process was not the intended owned process;
- host lost power for an unrelated reason;
- evidence file truncated before the product outcome could be observed;
- test fixture/sentinel creation failed;
- disk/volume required by the workload disappeared for reasons outside the injected scenario.

Do **not** classify a product crash, wrong recovery decision, replayed mutation, duplicate effect, cleanup leak, or incorrect block as `INVALID`.

Never delete or hide failures. Diagnostic reruns get new run IDs.

## Statistical analysis plan

### Binary correctness outcomes

For eligible resume success, expected-block correctness, cleanup success, and reboot success:

- report numerator/denominator;
- report Wilson 95% confidence intervals;
- report raw failure counts;
- report per-fault-family and per-workload breakdowns;
- do not combine `NOT_RUN` or `INVALID` cases into the denominator.

If there are zero observed safety violations, state **zero observed violations in N tested runs**, not “zero probability of failure.”

### Latency and work-preservation outcomes

For timing and re-execution metrics:

- median;
- interquartile range;
- p95 when sample size is sufficient;
- bootstrap 95% confidence interval for the median or paired median difference;
- show per-workload distributions, not only one pooled mean.

Use monotonic-clock durations. Do not use wall-clock time for latency calculations.

### Paired baseline

For the ≥30 matched resume/replay pairs:

- report median paired difference;
- report median percent reduction where denominator is non-zero;
- bootstrap 95% CI for paired differences;
- optionally report a Wilcoxon signed-rank test as supplementary evidence, but do not make p-values the primary conclusion;
- preserve pair IDs so every plotted point can be audited.

### Multiple environments

If more than one host profile is used, report each host separately first. A pooled aggregate may be shown only as a secondary summary.

Do not imply that two hosts are a representative sample of all hardware.

## Acceptance gates after implementation completion

The feature is accepted for the evaluated scope only if **all mandatory gates** below pass.

### A1 — regression integrity

- E0 repository gates are green on the frozen implementation SHA.
- No final evidence is collected from a different product SHA under the same batch ID.

### A2 — safety invariants

Across all valid final runs:

- O1 progress-preservation violations = 0;
- O2 verified-replay violations = 0;
- O3 duplicate-effect violations = 0;
- O4 cursor-regression violations = 0;
- O6 simultaneous-valid-owner violations = 0;
- intentionally unsafe cases satisfy O5.

Any violation fails acceptance and requires a new post-fix batch.

### A3 — catalog coverage

- every implemented safe fault ID is exercised in E2;
- every unrun ID has an explicit environmental/scope reason;
- paper coverage claims use only exercised IDs.

### A4 — repeated robustness

- E3 completes the predeclared scenario/workload/seed matrix;
- all valid eligible-resume runs satisfy safety oracles;
- all valid expected-block runs emit the predeclared block class with zero post-block mutation.

### A5 — cross-volume hygiene

Where W2 is applicable:

- preserved non-work-volume source sentinels are unchanged;
- cleanup deletes only proven task-owned paths;
- successful terminal cleanup ends with zero owned off-work-volume residuals;
- interrupted cleanup debt resumes idempotently;
- ownership uncertainty blocks deletion rather than widening scope.

### A6 — real reboot autonomy

Where reboot automation is in scope:

- E6 completes the required real reboot repetitions;
- each valid reboot run restores the same account context without a repeated credential prompt;
- DS-Hns starts/attaches automatically;
- the same episode reaches a newer verified checkpoint;
- safety oracles remain satisfied.

### A7 — evidence integrity

- all raw artifacts parse successfully;
- all recorded checksums verify;
- every derived row maps to a raw run ID;
- derived tables regenerate from raw data without manual editing;
- batch manifest contains every attempted final run, including failures and invalid runs.

### A8 — claim discipline

The acceptance report distinguishes:

- simulated fault evidence;
- real process termination evidence;
- real OS reboot evidence;
- adapter/provider simulation;
- any real-provider observation;
- NOT_RUN boundaries.

Passing simulated cases does not authorize wording that implies untested real power-loss behavior.

## Evidence campaign execution order

Because implementation is complete, do not return to feature construction unless a mandatory gate exposes a defect.

Execute:

1. freeze implementation + evidence protocol;
2. E0 regression gate;
3. E1 pilots;
4. freeze final batch after pilot;
5. E2 full fault sweep;
6. E3 repeated robustness matrix;
7. E4 paired baseline;
8. E5 cross-volume cleanup campaign;
9. E6 real reboot campaign;
10. E7 reproducibility replay;
11. verify checksums and regenerate derived outputs;
12. produce the acceptance/evidence report.

Independent stages that use separate disposable candidates may run in parallel, but never run two fault campaigns against the same candidate/workspace.

No 24-hour wait exists anywhere in the protocol.

## Paper-ready derived outputs

Generate these automatically from sealed raw evidence.

### Table 1 — evaluation configuration

- implementation SHA;
- harness/schema/catalog/workload versions;
- host profile(s);
- workload descriptions;
- number of runs by stage;
- explicit NOT_RUN scope.

### Table 2 — correctness by fault family

Columns:

- fault family;
- exercised cases;
- eligible resumes;
- successful resumes;
- expected blocks;
- correct blocks;
- O1 violations;
- O2 violations;
- O3 violations;
- O6 violations.

### Table 3 — recovery efficiency

Per workload/fault family:

- N;
- median fault→resume;
- median fault→new verified checkpoint;
- p95 where meaningful;
- median steps re-executed;
- median verified steps preserved.

### Table 4 — paired baseline

- N pairs;
- resume median;
- replay-from-start median;
- paired median difference;
- median percent reduction;
- bootstrap 95% CI.

### Table 5 — storage/reboot boundary evidence

- cleanup observations;
- preserved-sentinel violations;
- cleanup-blocked expected cases;
- successful zero-residual cleanups;
- real reboot N;
- successful autonomous resumes;
- repeated credential prompts observed.

### Fault-coverage appendix/data file

For every fault ID 1–89:

- implemented;
- exercised;
- workload;
- expected decision;
- observed decision;
- run ID;
- PASS/EXPECTED_BLOCK/FAIL/INVALID/NOT_RUN;
- reason.

### Failure appendix/data file

List **all** final-batch FAIL and INVALID runs with run IDs and reasons. Do not publish only successes.

## Threats-to-validity record

Maintain a short machine-readable/human-readable record during the campaign so the paper does not invent limitations after seeing results.

At minimum record:

- injected failures approximate many real faults but are not equivalent to destructive physical power loss;
- real reboot evidence covers the tested Windows host profiles, not all OS/hardware combinations;
- deterministic W0–W3 workloads improve repeatability but cannot represent every repository/task;
- provider/plugin adapter faults validate recovery boundaries but do not prove every external service behaves identically;
- seeds repeat injection choices/timing decisions but do not make OS scheduling deterministic;
- an unobservable non-idempotent external side effect remains outside exactly-once guarantees;
- cross-volume claims apply only to exercised filesystem/volume configurations;
- unattended sign-in behavior depends on the tested Windows configuration.

## Final acceptance report

Generate a single `FINAL_EVIDENCE_REPORT.md` from the derived outputs. It must include:

1. frozen code/evidence identities;
2. run counts by E0–E7;
3. acceptance gate A1–A8 status;
4. RQ1–RQ3 tables;
5. correctness invariant counts;
6. latency/work-preservation summaries;
7. baseline paired analysis;
8. cross-volume cleanup evidence;
9. real reboot evidence;
10. all FAIL/INVALID/NOT_RUN counts and reasons;
11. threats to validity;
12. exact raw evidence root and batch checksum.

The report may state `ACCEPTED_FOR_EVALUATED_SCOPE` only when A1–A8 all pass. It must never convert a failed safety oracle into a caveat-only pass.


## Security and storage boundaries

For unattended reboot recovery, the default Windows identity is the **current interactive account** at the time the feature is provisioned. Store only the minimum non-secret identity metadata needed to verify that the post-reboot session is the same account.

The current plaintext Windows password cannot be recovered from an already logged-in session and DS-Hns must not attempt to do so. If unattended sign-in requires credentials, request them only once through a Windows-native protected provisioning flow and leave the secret under OS ownership. Subsequent automated reboots should reuse that OS configuration so the user is not asked to enter the password again.

Do not place plaintext passwords or reusable credential material in project files, app configuration, command arguments, environment dumps, recovery state, crash reports, or experiment evidence. If the OS-native protected path is unavailable, report `REBOOT_LOGIN_AUTOMATION_UNAVAILABLE`; do not fall back to plaintext storage.

The user-selected work volume/work root is recorded in the experiment manifest and is the preferred home for durable task state. DS-Hns may use any accessible local volume for reads and task-scoped temporary writes during execution.

At terminal cleanup, enumerate the durable cross-volume temporary registry and delete only paths whose ownership is proven for the current episode. A path being on `C:`, `D:`, or any other non-work volume is **not** sufficient evidence for deletion. Pre-existing sources, user profiles, junction targets, shared Electron data, installed tools, shared caches, and unrelated user state are preserved.

For example, when `E:` is the selected work volume, the episode may read `D:\dataset`, write `C:\DS-Hns-Temp\<episode>`, and use `D:\DS-Hns-Temp\<episode>` during execution. After terminal cleanup, the two task-owned temp roots must be gone, while `D:\dataset` remains unchanged. Durable checkpoint/evidence state stays on `E:`.

Evidence files must not contain secrets, provider tokens, raw environment dumps, full prompts/plans, or unbounded command output. Paths may be stored only when needed for reproducibility; paper-exported summaries should sanitize user-specific path prefixes if they are not material to the experiment.

## Stop conditions

Stop automatic recovery for the episode, preserve evidence, and continue the application in a usable state when:

- the attempt limit is reached;
- plan/recovery schema is unsupported;
- repository/workspace drift makes the old plan unsafe;
- an external mutation is ambiguous;
- process ownership cannot be proven safely;
- checkpoint/index storage cannot be trusted;
- terminal cleanup cannot prove ownership for a candidate deletion (preserve it);
- task-owned off-work-volume residuals remain after bounded cleanup retries (`CLEANUP_BLOCKED`).

These are correct fail-closed outcomes, not failed implementation, provided the expected block code is emitted and no unsafe mutation executes.

## Final evidence constraint

The implementation is now frozen for evaluation. Do not add convenience features, new fault semantics, or new metrics after final-batch collection starts.

A recovery run demonstrates continuity when the same episode is automatically restored from a verified safe point and reaches a newer verified checkpoint with:

- zero lost verified steps;
- zero replayed verified mutations;
- zero duplicate effects;
- no competing execution owner.

A terminal cross-volume run additionally requires verified safe cleanup, and a reboot run additionally requires same-account autonomous relaunch without repeated credential entry.

These are **event-based proofs**. No fixed-duration soak or 24-hour idle period adds acceptance value.

The ICSE argument must be built from the frozen raw evidence, independent oracles, predeclared fault/workload matrix, paired baseline, repeated runs, real reboot observations, and explicit validity limits. Any product fix after evidence begins creates a new evidence batch rather than silently changing the population.
