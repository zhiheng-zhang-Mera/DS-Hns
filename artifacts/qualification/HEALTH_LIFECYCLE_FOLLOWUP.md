# Health lifecycle continuity follow-up

Observed on candidate `08900a8b6a5ba92ea09e8c68f3a9157e99470d2a` in the independent fresh18 checkout; this document does not certify a subsequent candidate.

## Actual failure and cause

Real UI enabled Health Scheduler at 2026-09-23T19:09:29.544Z. Applying sampling interval16000 at19:14:09Z returned the correct value but unloaded the service and left it DISABLED. No disable input intervened. Screens05/09/14 and desktop-runtime.log lines501/515/600 preserve the transition under `D:/Hns-Cleanroom-Qualification-18/visual-journey-08900a8` and its sibling `repo/logs`.

`setEnabled` changed only manager memory. Advanced configuration rebuilt the manager from persisted config and manifest defaults; the explicit choice disappeared. A store-installed plugin had the inverse problem: store presence overrode a later explicit disable.

## Scoped correction

Persist the explicit lifecycle choice in existing per-plugin configuration, preserving other settings. Refuse malformed/non-object or unwritable configuration before live-state mutation. An explicit plugin-file decision outranks the store-install default. Fresh profiles retain default-off Health behavior. Existing load/refusal results remain authoritative; persisting intent does not declare successful loading.

## Observed regression evidence

- Three real-host continuity cases first failed (enable/configure, disable/configure/reopen, enable/reopen); raw `D:/Hns-Final-Qualification/health-enable-continuity-red-r2.log`.
- Those cases passed after correction; focused related suite36/36 passed.
- Five additional actual-filesystem/store boundary cases passed and were promoted into repository coverage. Both new files together8/8 passed.
- Full run1:1981total,1979pass,0fail,2declared skips;560020.0102ms. Full run2 after all8 regressions:1986total,1984pass,0fail,2declared skips;571902.1244ms, exit0. Raw files `health-enable-continuity-full-unit.log` and `health-lifecycle-full-unit-r2.log` under the same D-drive qualification root; neither overwritten.
- Skips: absent optional local sample directories `D:/test-DSH/samples/dsh-web/packages/dsh-market` and `D:/test-DSH/samples/wallpaper-engine-dsh`; no test removed or threshold reduced.
- Syntax284/284. Both post-test audits report process-leak PASS and bounded C-drive-write PASS. These are bounded audits, not system-wide filesystem tracing.

Tests: `tests/unit/plugin-host-enable-continuity.test.js` and `tests/unit/plugin-host-lifecycle-boundaries.test.js`.

## Qualification boundary

Old089 had two full17-gate machine runs PASS, but actual Journey exposed this defect: machine PASS alone did not qualify the product. Fresh18 subsequently preserved font15, interval16000 and Runtime authority across real Desktop close/reopen; these observations do not validate the uncommitted lifecycle correction. Native Orb and PureAlien were not completed on fresh18. Corrected candidate still requires frozen-SHA full qualification, remote fresh installation, real GUI enable/configure/reopen verification, CI, remaining enhanced experiments and final evidence consistency before any production claim.
