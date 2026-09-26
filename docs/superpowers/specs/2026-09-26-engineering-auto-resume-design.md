# Engineering Episode Crash Recovery and Automatic Resume

Status: in-chat design approved; awaiting review of this written specification. No product implementation is authorized by this document alone.

## Purpose

After an unexpected termination of the engineering execution process or host, reopening DS-Hns must automatically continue the same active engineering episode from its newest valid checkpoint, without requiring a button press. The resumed episode must preserve its identity, workspace, original goal, execution contract, and verified progress, while refusing unsafe or ambiguous replay.

This is Phase 1 of a staged delivery. Phase 2 will separately cover Sub-worker task/plan recovery and the Windows schedule/startup surface. The full 24-hour crash-recovery soak is a final cross-phase acceptance run after both phases are implemented.

## Repository facts

The approved branch is dev/crash-resume-recovery-v1, based on 923f5293a2ada553cb7f91a4bc1b54e750dfe7c3.

The checkpoint module in app/engineering/checkpoint.cjs writes atomic JSON checkpoints and provides latest() plus the separate verifyResume() validator. Checkpoints include episode ID, goal, workspace, fingerprint, plan ID/cursor, verified mutations, owned processes, progress, and phase. The saved plan is currently a summary rather than a complete replay descriptor.

The engineering host in app/engineering-host.cjs accepts run(), cancel(), and status() requests, but has no cross-process resume entry point or durable active-request record. The shell/runtime separation already has a single-instance identity and an attach path; recovery must use it and must not create a second runtime host.

The existing reboot coordinator has a separate one-shot intent path for planned restarts. Its target resume must converge on the same idempotent episode-resume operation rather than launching a second independent recovery path.

## Goals

1. Persist enough versioned state to reconstruct a newly started engineering host's active episode and resume from a verified checkpoint cursor.
2. Automatically attempt recovery on startup when the prior episode was interrupted unexpectedly or has an explicit planned-restart intent.
3. Revalidate the current workspace, repository fingerprint, checkpoint integrity, outstanding mutations, and required owned-process state before resuming.
4. Prevent duplicate host creation, duplicate recovery claims, unbounded restart loops, and silent success claims.
5. Keep recovery state, checkpoints, logs, and test evidence under the selected D-drive runtime root. Any unavoidable off-D temporary files created by this phase must be inventoried and removed at completion; persistent OS or user state is not temporary cleanup scope.
6. Produce reproducible, seeded fault-injection evidence in a disposable D-drive candidate.

## Non-goals

- This phase does not implement Sub-worker task/plan recovery; that is Phase 2.
- It does not add or enable random machine shutdowns or reboots.
- It does not persist Windows passwords, API keys, provider credentials, or arbitrary environment variables.
- It does not automatically replay an old checkpoint that lacks a compatible recovery descriptor.
- It does not claim exactly-once semantics for an external side effect whose completion cannot be observed. Such an operation must be verified, idempotent, or reported as ambiguous.
- It does not replace the external restart authority or add a second in-process watchdog.
- It does not simulate physical power loss on the live host. Filesystem and process-boundary failures are tested through controlled failpoints; any real reboot is a separately scheduled, explicit acceptance event.

## Approaches considered

### Replay the original goal from the beginning

This is mechanically simple, but can repeat completed file changes, commands, or external work and does not satisfy “resume from the latest checkpoint.” Rejected.

### Restore from a durable recovery descriptor and the latest checkpoint

Persist the sanitized original request and a complete versioned plan/cursor descriptor alongside each checkpoint. At startup, load the newest readable checkpoint for that episode, validate it against the live workspace, and restore the same episode from the next safe cursor. This requires explicit migration and recovery logic, but preserves progress and enables meaningful tests. Recommended.

### Rely only on process relaunch or the planned-reboot intent

A supervisor can reopen a process, and the existing reboot intent can request a planned resume, but neither by itself restores the active engineering plan after an arbitrary process crash. Retain these as launch/intent mechanisms, but route them through the recommended recovery operation.

## Proposed architecture

### Durable recovery record

Add a focused recovery-store module under app/engineering. It owns an atomic, versioned recovery record under the configured runtime root, adjacent to the existing engineering checkpoints. The record includes:

- schema version, episode ID, lifecycle state, and update timestamp;
- a sanitized, allowlisted original request: workspace, goal, deadline, and the supported execution contract fields;
- original start time and absolute deadline, so a restart does not silently grant a fresh 24-hour budget;
- the complete serializable plan and current safe cursor, not only step IDs and kinds;
- latest checkpoint filename and checkpoint timestamp;
- current host instance ID and process identity for stale-owner detection;
- automatic-resume attempt count and last outcome.

The record must not contain credentials, secrets, full process environments, or provider tokens. The complete recovery descriptor is also embedded in each atomic checkpoint file. The checkpoint file is the source of truth for request, plan, and cursor; the separate record is the lifecycle/owner index. This ordering handles a crash between the checkpoint rename and the index update: startup scans the episode's newest valid checkpoint, validates its embedded descriptor, then repairs the index. Both files use same-directory temporary files followed by atomic replacement. A failed write leaves the previous valid file intact.

### Checkpoint and episode integration

Each accepted engineering episode creates the recovery record before execution begins. Every successful checkpoint atomically stores the current complete recovery descriptor in the checkpoint file, then advances the index's checkpoint reference and serializable cursor. Terminal completion, explicit cancellation, and safe manual stop update the lifecycle state so they are not mistaken for an unexpected crash.

The resume API accepts an episode ID and recovery context, loads the latest readable checkpoint for that episode, reconstructs the same episode and plan, and begins at the next safe cursor. It must re-use existing workspace verification, mutation recovery, and repository-fingerprint logic. A checkpoint acknowledgement is not written until the restored episode has been accepted by the executor.

### Startup and planned-restart flow

At boot, the execution owner first attaches to an existing healthy runtime host when one is present. It never starts a second host for the same instance.

If there is no live owner, the new host inspects the recovery record. An active record whose prior owner is absent is an unclean-exit candidate. A planned-restart intent is treated as another trigger for the same episode-resume API. The coordinator and crash path must share one durable claim keyed by episode ID so they cannot resume the same work twice.

A clean user cancellation or completed episode is not auto-resumed. A compatible, verified recovery candidate is resumed without UI interaction. The application exposes progress and outcome after startup, but no click is required for an eligible episode.

### Fail-closed recovery outcomes

- Resume only when verifyResume returns the safe resume action and the recovery descriptor matches the checkpoint.
- If no readable checkpoint exists, the workspace is missing, the descriptor is corrupt or unsupported, repository drift requires replanning, a mutation outcome is ambiguous, or a required process cannot be safely reconciled, mark the episode recovery-blocked and preserve diagnostics; do not blindly repeat writes.
- Limit automatic startup recovery to three consecutive unsuccessful attempts. Reset the counter after the resumed episode records a newer valid checkpoint. After the limit, leave the application available with a visible recovery-blocked state and actionable evidence.
- Never report a task as complete merely because it restarted or accepted a recovery request.

The user’s no-operation requirement applies to eligible, verified recovery. Unsafe or ambiguous state is an explicit exception: the system must stop and explain rather than risk silent duplicate work.

## Fault-injection and soak design

A D-drive disposable candidate receives a recorded random seed and a bounded fault catalog. Each fault record includes the selected cause, injection point, candidate commit, episode ID, checkpoint before termination, relaunch identity, restored cursor, and duplicate-effect audit.

Initial catalog:

- abrupt termination of the isolated desktop shell, runtime host, renderer, and owned worker process;
- termination before checkpoint temp-file creation, during temp write, after rename, and between checkpoint persistence and recovery-record acknowledgement;
- unreadable/corrupt newest checkpoint with an older valid checkpoint available;
- simulated provider timeout/disconnect and plugin-host failure through injectable test adapters;
- simulated permission denial, stale ownership, and storage-write failure through test adapters rather than altering host-wide permissions or filling the real disk.

Random selection is reproducible from the seed. Fault injection may terminate only processes whose executable path, parent/ownership record, and unique D-drive candidate root match the test run. It may not use broad process-name kills.

Machine shutdown/reboot is not part of the random fault catalog. The later real reboot acceptance is explicit, user-timed, checkpointed, cancellable during its grace period, and resumes through the same recovery API. A true power-loss simulation is NOT_RUN unless a disposable virtual machine or equivalent isolated power-fault environment is available.

The final 24-hour soak runs only after Phase 1 and Phase 2 are complete. It must include multiple seeded unexpected process terminations, automatic reopen/reattach, progress continuity, and at least one separately controlled reboot if a safe test window is approved. Logs, samples, and evidence remain under D:. Final cleanup deletes only task-owned temporary files outside D:, not persistent profiles, user data, or intentionally configured startup/schedule entries.

## Acceptance criteria for Phase 1

1. Unit tests prove atomic recovery-record persistence, schema validation, latest-checkpoint selection, corrupt-newest fallback, bounded retry count, and duplicate-claim refusal.
2. Resume tests prove that a fresh host restores the same episode ID, request, plan, and cursor without replaying a verified prior mutation.
3. A process-level test starts a disposable D-drive candidate, persists progress, forcibly terminates only the verified candidate PID, reopens it, and observes automatic continuation without UI input.
4. Crash-boundary tests cover the catalog above and preserve the distinction between simulated provider/plugin faults and real provider acceptance.
5. An unsafe/mismatched checkpoint produces a visible blocked diagnostic and does not execute a mutation.
6. Runtime single-host identity remains intact: an existing host is attached to, never duplicated.
7. The feature's focused and full repository test suites, syntax checks, and relevant acceptance checks pass before its functional commit is pushed.
8. The functional commit is pushed to dev/crash-resume-recovery-v1 and its remote SHA is verified. No merge to main or production tag is created.

## Delivery sequence

1. Review and approve this written specification.
2. Write and review a bite-sized implementation plan before code changes.
3. Implement the recovery store and checkpoint descriptor with test-first coverage; commit and push that functional slice.
4. Implement startup recovery and the single resume path; commit and push that functional slice.
5. Implement the D-drive seeded process/fault harness and focused acceptance; commit and push that functional slice.
6. Start Phase 2 only after Phase 1's local gates and cloud SHA checks complete.
7. Run the full 24-hour cross-phase soak only after Phase 2's completion; report any unrun host-level event explicitly.

## Security and storage boundaries

The application uses the current interactive Windows account for logon-start behavior in the later phase. This specification does not request or store its password. If a future Windows task requires credentials, entry must occur only through a native OS credential flow and must not be copied to logs or application configuration.

D-drive runtime paths are configurable and must be recorded in the soak manifest. Temporary roots are created under the candidate evidence root. At final cleanup, inventory exact off-D paths first and delete only temporary files proven to belong to this work. Existing C-drive profiles, junction targets, shared Electron data, and other user state are preserved unless separately identified as disposable and verified not to contain user-owned targets.
