# Task 5 P2 visual and interaction acceptance

Status: `PASS_WITH_NEGATIVE_EXPERIMENT_RETAINED`

This is construction-phase evidence, not the final clean-room certificate. The final qualification must repeat the visual journey against its own committed SHA.

## Observed journeys

- Fresh production-like profile: Plugin Market opened through a real foreground-window click. Its Installed tab showed four logical packages and no repeated Scheduler, Mega, or Restart Supervisor row.
- Settings and Mega opened through visible clicks.
- Mega initially reproduced the bare `Computer Use degraded` defect. After the tested repair, the real Orb displayed `Computer Use unavailable — no host runtime attached; core unaffected`; overall core status remained `Healthy`.
- The System Orb was clicked with real Win32 pointer input. The panel expanded. A second click expanded the Price section and displayed its schedule, source, countdown, and next change, providing visible interaction feedback.
- A duplicate-profile probe added a second profile with the same package declarations. The first attempted junction isolation produced `0` installed rows because the upstream scanner ignores junction `Dirent` entries. That screenshot is retained as a negative result and the implementation was removed.
- The replacement, version/signature-gated canonical-row patch was exercised with the duplicate profile still present. The official Installed tab showed four logical rows rather than eight; each visible row retained its `profile` provider.

## Evidence

- `visual/task5-mega.png` — defect reproduction.
- `visual/task5-orb-expanded.png` — real click, expanded panel, repaired Computer Use explanation.
- `visual/task5-orb-price-expanded.png` — real second interaction and expanded Price feedback.
- `visual/task5-installed.png` — fresh-profile Installed list without duplicates.
- `visual/task5-installed-canonical-with-duplicate-profile.png` — rejected junction experiment (`0` rows).
- `visual/task5-installed-canonical-patched-duplicate-profile.png` — final canonical identity behavior with the duplicate-profile probe active.

## Automated regression

- `tests/unit/mega-core-view.test.js`: optional host absence is `UNAVAILABLE`, reports no core impact, and does not downgrade overall health.
- `tests/unit/plugin-market-identity.test.js`: alias convergence, provider retention, idempotent materialized patching, and fail-closed version drift.
- Focused affected suites passed after the Electron instance was stopped; the two tests that assume no companion were re-run isolated and passed 39/39.

## Boundaries

- The rejected `0`-row experiment is not a pass.
- Coordinate clicks and screenshots are real-machine interaction evidence, not a claim of accessibility conformance.
- Final clean-room visual acceptance remains required on the final candidate SHA.
