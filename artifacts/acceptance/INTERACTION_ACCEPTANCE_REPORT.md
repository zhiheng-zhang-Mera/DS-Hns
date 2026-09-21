# DS-Hns Integration RC1 Interaction Acceptance

Date: 2026-09-22 (Australia/Sydney)

Execution: one controller only; no DS-Hns second body or QA agent was used.

## Journeys

### Journey A — startup, health, task status, return

PASS. The real isolated Electron candidate opened the official home. The DS-Hns status entry reported Healthy with 5/11 active and no pending work. Existing task/session state was visible in the official sidebar, a task could be opened, and navigation returned to the home composer.

### Journey B — plugins, health/restart, settings

PARTIAL. Settings -> Plugins and Settings -> Mega were found and operated. Health Scheduler @2.0.1 and Restart Supervisor @1.0.1 were visible; the latter showed loaded/healthy/companion running after the repair. Plugin Market contained duplicate entries, so discoverability passes but presentation consistency does not.

### Journey C — status refresh

PASS. Mega's Refresh control was clicked. The visible `updated at` timestamp changed, with terminal health feedback and no stale pending/error count.

### Journey D — safe setting persistence

PASS. Dark appearance and the selected `D:\Hns-Integration-RC\repo` workspace were set through the real UI, the complete process tree exited, and both states survived multiple isolated relaunches.

### Journey E — recoverable local failure

PASS. A safe Node command intentionally exited 7 using explicit PowerShell exit propagation. The official task surface showed `[exit code: 7]`; a following command returned `ALIVE_AFTER_ERROR`. The application remained responsive and reported zero file changes. A bare PowerShell `-Command` normalizes an external program's non-zero result to 1 unless `exit $LASTEXITCODE` is used; this shell semantic is recorded and was not misreported as product exit-code preservation.

### Journey F — observe a long task without interruption

PASS. A safe 15-second Node task was started. While it visibly remained in processing state, Settings -> Mega opened and Refresh was clicked. The task completed once with `LONG_TASK_OK`, status completed, exit code 0, and zero file changes. Observation did not cancel, restart, or mutate it.

## Official fallback

PARTIAL. The official page independently exposes overall DS-Hns health, sessions/tasks, the Plugin Market, Settings, and the Mega supervision panel even while the legacy Mega dock is absent. Health/restart/error/runtime information and safe refresh/repair controls are reachable. Computer Use remains visibly degraded because no host runtime is attached to that module, and the system-orb interaction was not targetable by the automation API; those paths are not claimed as accepted.

## Fault isolation and persistence

- Local command failure did not take down Electron, the Harness, or later commands: PASS.
- Restart companion startup now uses portable Node and refreshes health after launch: PASS visually and by tests.
- Long-task status inspection did not interrupt work: PASS.
- Workspace/theme persistence after full exit/restart: PASS.
- Real Windows reboot: NOT_RUN; only the repository's bounded resume-path chaos scenario passed.

## Interaction verdict

Journeys A, C, D, E, and F pass. Journey B and official fallback are partial because of visible duplicate plugin rows and the remaining degraded/untargetable surfaces. Overall interaction acceptance is `PARTIAL`, not promoted to a full pass.
