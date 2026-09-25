# Real wall-clock 24-hour soak

Status for exact candidate `4ef9c0df149a6cecf1eaa17e50cee4b22271b810` / tree `816f513c98e40831f0e81f8567e72e6fd01adcd4`: `IN_PROGRESS_PARTIAL`; `passed: null`.

A new observer was bound before sampling to the exact candidate clone, runtime process roots, and D-drive evidence root. At this report snapshot (`2026-09-25T08:09:04.8920572Z`) it had recorded 71 one-minute samples across 4,199.962 seconds (`2026-09-25T06:59:04.9297139Z` through the snapshot). The runtime, Electron attachment, and Harness readiness were true at the latest sample; 8 owned processes were observed. This is real host/runtime liveness and resource evidence only, not a completed soak.

A separate one-shot generic arithmetic provider smoke was performed through the visible exact-candidate UI during this observer window: `DeepSeek-V41-Flash` returned `1109`, and the conversation remained visible after in-app navigation/reopen. Its app clock showed `17:43`, but no exact UTC event timestamp was bound to a particular raw observer sample. The raw sample `providerTask: NOT_RUN` field represents the observer's lack of provider-task attribution; it does not negate that separately observed UI smoke. The smoke is not a long task and does not establish process-restart continuity or full soak acceptance. No task-continuity checkpoint sweep, plugin fault/recovery scenario, or Windows reboot was performed. Application event-loop drift is not exposed by this candidate. The 24-hour interval and terminal process/storage audit are still incomplete, so this record is neither `PASS` nor full-task acceptance. The 120/120 virtual-time synthetic soak remains a separate result.

The older observer for `dafd3bfff8db30f2aaf094e4a15ed41a2c1f9ce6` remains running by design but is not accepted: its SHA and declared project root do not match the current candidate/runtime. Do not stop or combine it with this run.

Continue the exact-candidate observer through the requested 24-hour boundary, then perform terminal process/storage audits. Even a completed liveness window alone will not fill the unrun provider-task, continuity, or plugin-recovery scenarios.
