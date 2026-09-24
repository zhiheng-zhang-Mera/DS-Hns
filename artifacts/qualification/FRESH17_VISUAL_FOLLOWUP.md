# Fresh17 observed failures and bounded repairs

This is historical follow-up evidence, not a final certificate. Actual fresh17 GUI ran `174318dbca4cbac9998a5010d31d1aa10b6e4eed`; construction repairs culminated in `e9d82329edd458a918109b05829c4932aff77068` (tree `96d01a598c54cff2ce07b5df8d49a5f7a199dcb2`). The repaired tree has not yet repeated the complete cleanroom Journey.

## Actual observations

Evidence root: `D:/Hns-Cleanroom-Qualification-17/visual-journey-174318d/`. Screenshots01–22 and JOURNEY_OBSERVATIONS.md retain context. Health enable/sampling succeeded; one harmless scheduled task completed with the exact requested marker; session and font15 survived actual Desktop close/reopen. Running phase and completion notification were not captured. No claim of a complete Journey.

- Reopen retained Runtime21992/Harness29396 but replaced instance.json with a false32101 port and erased ownership metadata. IPC still attached to32100. Raw `reopen-ownership-observed.json`; this is not an observed duplicate Runtime/task.
- Advanced Apply failed with `an advanced write needs a key`; valid16000 did not replace15000. Screenshot09.
- Diagnostics acknowledged success but displayed no report near the service. Screenshot08.
- Restart IDLE/history0 displayed epoch1970 for absent times.
- PureAlien retained a dead right MEGA rail. Screenshots20/21; exclusive click produced no expansion.
- Native Orb was visible and exposed button10 in its accessibility tree, but two fresh-state Sky clicks returned `element 10 is not available in cached app state for electron.exe`. Screenshot22 and `native-orb-input-observation.json`. Expansion/feedback remain NOT_RUN. No private IPC, global input or alternate automation bypass. This is a tool failure, not a product PASS/failure inference.
- `bundled:*` protection records and plugin-host services are distinct state machines. Registering protection leaves DISABLED; installed/enabled/loaded service state is separately reported. Do not make protection HEALTHY to imitate plugin state.

## Logical repairs and limits

| Change | Commit | Mechanism | Bounded evidence |
| --- | --- | --- | --- |
| Live Host authority | 1f901d0 | Verify live IPC identity before TCP allocation; no authority-record rewrite on attach; preserve isolated paths | Real Host IPC + stand-in TCP listener; focused37/37; full1959/1957pass/2skip/0fail |
| Advanced write chain | 545462a | Preserve key/value through bridge; object patch setter; concrete validator refusal | Real HTTP proxy/bridge/shipped callback/setter/host config; two RED boundaries; focused28/28; full1960/1958pass/2skip/0fail |
| Absent restart dates | 4a823ae | Distinguish absence from numeric0; reject invalid Date range | Eleven literal cases, five original failures; view24/24 |
| Diagnostic report | 42b48b9 | Preserve result; service-local pending/error/literal-text report; visible16384-character truncation | Existing React stand-in, not browser evidence; client/view52/52 |
| PureAlien dock | e9d8232 | Disable switch overrides integrated dock preference | Shipped policy/entrypoint with Electron-view stand-in; focused14/14; does not uninstall profile plugins |

Shared final combined source tree full test:1977 total,1975pass,2existing skips,0fail,exit0,454816.8924ms on Node24.14.1. Raw `D:/Hns-Final-Qualification/visual-followups-full-unit.log`; started2026-09-23T17:41:52Z. Post-test process leak and bounded C-drive project-shaped-entry audits PASS in `visual-followups-post-test-audit.json`. Intermediate timestamps/diagnostics commits did not each receive a separate full-suite run. Original structural parallel warning9.614s vs8.5s remains a pre-existing non-gating warning, not modified policy. Skips are absent optional local community samples under D:/test-DSH, not substitutes for final fresh installation.

## CI negative evidence

1f901d0 CI35895228197 succeeded. 545462a CI35896701251 attempt1 failed: ownedUIA returned2 matches instead of5; crash-recovery test timed out30s before dispatch. Raw `D:/Hns-Final-Qualification/ci-545462a-failed.log` preserved. Same-SHA full attempt2 succeeded. Root cause remains unproven; no relaxed assertion/budget/retry policy. Additional failure diagnostics and explicit start/admission assertions are separate follow-up, not a claimed fix of intermittent behavior.

No final qualification, current-candidate cleanroom, real24h, realreboot, merge, tag or production baseline is certified here. These failures inform ownership, contract and observability rationale; they do not establish novelty or statistical reliability.
