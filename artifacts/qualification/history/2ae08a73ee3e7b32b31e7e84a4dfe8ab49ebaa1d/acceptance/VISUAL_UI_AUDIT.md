# DS-Hns Integration RC1 Visual/UI Audit

Date: 2026-09-22 (Australia/Sydney)

Candidate: `dev/hns-integration-visual-rc1`

Profile: `D:\Hns-Integration-RC\data\acceptance-userdata`

## Method

This audit used Codex Computer Use against the real Electron top-level window. Each accepted flow used the sequence capture -> visually read -> click/type -> capture again. UIA/DOM/log output was used only as supporting evidence. The candidate was relaunched after the full regression and inspected again.

## Final visual smoke

- Official DeepSeek Harness home rendered at 1488x920 with no blank page or crash.
- The persisted `repo` workspace and dark appearance survived complete process exits.
- Settings opened from the official sidebar and all five navigation entries were visible.
- Settings -> Mega was clickable and showed `Healthy`, active `5/11`, pending `0`, failing `0`.
- Required dependencies were visibly reported as `dshns.health-scheduler @2.0.1` and `dshns.restart-supervisor @1.0.1`.
- The restart supervisor was separately scrolled into view and visibly reported loaded, healthy, and companion running.
- The refresh control visibly changed the update timestamp.
- The official status entry remained available without the legacy Mega dock: `DS-Hns · Healthy · 5 of 11 plugin(s) active · 0 pending`.

## Surface audit

| Surface | Visible | Understandable | Clickable | Feedback/state | Result |
| --- | --- | --- | --- | --- | --- |
| Official home/navigation | yes | yes | yes | current workspace/session visible | PASS |
| Settings/general | yes | yes | yes | theme and permission state visible | PASS |
| Settings/plugins | yes | yes | yes | plugin rows visible; duplicate rows observed in Plugin Market | PARTIAL |
| Settings/Mega overview | yes | mostly | yes | health, counts, dependencies, retry/repair/refresh visible | PASS |
| Health/restart details | yes | yes | yes | versions and companion health visible | PASS |
| Runtime/task status | yes | yes | yes | running and terminal command states visible | PASS |
| Error state | yes | yes | n/a | exit code and subsequent recovery visible | PASS |
| Long-task observation | yes | yes | yes | processing then completion; settings refresh did not interrupt | PASS |
| System orb | visible | unclear | NOT_RUN | separate untitled top-level window was not targetable by the automation window list | NOT_RUN |

## Reading and layout findings

- The primary hierarchy is understandable to a first-time user: workspace, session list, composer, settings, and DS-Hns status have clear placement.
- Mega's dense dependency/fallback strings wrap but remain readable at the tested 1488x920 size; no clipping or white screen was observed.
- Health uses a strong top-level `Healthy` label, but simultaneously shows `Computer Use degraded`; the distinction between overall and optional-module health is not explained.
- Plugin Market displayed duplicate scheduler/Mega/restart entries during the traversal. This is a visible duplication issue, not inferred from source.
- The optional Wallpaper Engine absence is clearly shown as missing and is not treated as a core failure.

## Evidence

- `artifacts/rc-evidence/final-isolated-mega-health.png`
- `artifacts/rc-evidence/mega-health-overview.png`
- `artifacts/rc-evidence/restart-supervisor-healthy.png`
- `artifacts/rc-evidence/journey-long-task-complete.png`

## Verdict

Visual startup and the exercised controls pass, but the full visual/UI gate is `PARTIAL` because the Plugin Market duplication remains and the system-orb click path is `NOT_RUN` rather than guessed.
