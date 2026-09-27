# Health optional restart capability refresh

Observed candidate: `b3fec709ec52b01a4f7514911a5818bd0c666f11`, tree `b298376476eeea73d67e725694922b4a817b3e28`. This is a failure analysis, not a final qualification certificate.

## Observation and cause

Fresh19 real desktop Journey enabled Health Scheduler and applied sampling interval15000 ->16000. Enabled/loaded stayed true, but Health incorrectly reported DEGRADED: `restart unavailable: no plugin provides restart-control`. The Restart Supervisor itself was loaded and monitoring. Evidence: `D:/Hns-Cleanroom-Qualification-19/visual-journey-b3fec70/08-health-degraded-after-apply.png` and `JOURNEY_OBSERVATIONS.md`.

The real host regression confirmed that the capability registry provided restart-control while the monitor reported it unavailable. Manager ordering guarantees required dependencies, not optional ones. Health retained its earlier load-time capability snapshot for status and sampling. Making restart authority mandatory would change the intended optional contract rather than repair stale observation.

## Scoped correction and evidence

Refresh through the existing capability resolver at sampling/binding, health, diagnostics and restart-request boundaries. No new authority, process control, restart request, load-order requirement or threshold is introduced. Unloaded monitors remain non-sampling.

- Real-host enable/configure regression failed before repair: `D:/Hns-Final-Qualification/health-restart-binding-red.log`.
- Three real manager/monitor cases independently exercise health, diagnostics and sample enrichment after provider registration/removal. All three failed before repair: `health-restart-refresh-red2.log`. The potentially destructive authority request is explicitly a non-acting fixture; low pressure must produce zero requests.
- Focused suite passed24/24,0skip,6603.1782ms: `health-restart-refresh-green.log`.
- Full regression terminated exit0:1989total,1987pass,0fail,2declared optional-sample skips,458625.918ms; `health-restart-refresh-full-r2.log`. Command: repository Node24.14.1 on explicit PATH, repository D-drive environment, `scripts/test-all.ps1` (including its syntax preamble). Earlier full-r1 used the wrong PATH-selected toolchain and was stopped during syntax checks; it is INVALID_TOOLCHAIN, not a passing run. Its evidence remains preserved.
- Skips retain the two absent optional legacy local sample directories under `D:/test-DSH/samples` (dsh-market and wallpaper-engine-dsh); no test/threshold was removed. Post-test process leak and bounded C-drive-write audits both PASS: `D:/Hns-Final-Qualification/health-restart-refresh-post-test-audit.json`. Fresh19 post-Journey audits also PASS/PASS. These are bounded project-name audits, not system-wide filesystem tracing.
- Paper catalog validation returned `passed:true, errors:[]`. Separate author review checked optional-resolution failure handling, disappearance, unloaded behavior and no process-control widening; no independent reviewer was delegated, per the single-agent constraint.

## Prior machine runs remain distinct

Fresh19 first full run `2026-09-23T20-21-58-232Z-946afeb4` failed15/17: native picker timeout and one chaos recovery-reason assertion. Three isolated kill-core diagnostics passed but do not replace that failed full run or establish its ordering cause.

Fresh19 second full run `2026-09-23T20-52-30-838Z-6233f315` passed17/17 with0mandatory failures and consistent evidence. That machine result does not erase the first failure or the subsequently observed real Journey defect. Neither old candidate run validates this new correction.

The old Desktop was closed through actual window input; its Runtime was then gracefully stopped through the product CLI, instance `ab7366edadd270cc`, with `stopped:true`. No fresh19 source was changed. Renewed current-candidate full qualification, real GUI acceptance and CI remain required.
