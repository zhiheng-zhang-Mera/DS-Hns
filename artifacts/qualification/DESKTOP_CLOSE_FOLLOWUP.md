# FQ-DESKTOP-CLOSE-001: primary-window exit ownership

On candidate `cc3d9097c4d8b07ee7f8a97a6f9e2c94dbb5a28c`, cleanroom13's real installed-profile Journey completed a provider task and visually displayed `HNS_RC_JOURNEY_OK`. Closing the primary window through targeted native Alt+F4 removed all targetable project windows but left Desktop PID4428 and its companion alive. No before-quit entry appeared. This is a failed Journey, despite the candidate's passing machine qualification.

The primary `closed` callback only cleared view references. `window-all-closed` cannot express primary-window closure while auxiliaries remain; `second-instance` also returns when the primary reference is null. Repair explicitly requests the existing quit/teardown path when the primary closes, unless shutdown already owns the transition. The Runtime is detached, not stopped. Separately, an unsuccessful single-instance lock now returns from CommonJS entry evaluation after requesting quit, preventing further startup registration.

Three behavioral source-execution tests first failed (missing primary quit in integrated/legacy modes and continued initialization after lock rejection). Five focused tests then passed, including explicit-shutdown and acquired-lock controls. These use an Electron boundary stand-in, not native certification. Full declared unit regression:1943 tests,1941 pass,0 fail,2 existing absent-external-sample skips,446114.1813ms. Raw log: `D:/Hns-Final-Qualification/desktop-primary-close-full-regression.log`.

## Separate qualification launcher failure

Historical relaunch attempts2/3 produced native snapshot_data assertions. Those assertions are **not established consequences of the product lock handling**. The external launcher used `[Environment]::SetEnvironmentVariable(name, $null, 'Process')`; a live PowerShell7.6.5 probe showed ELECTRON_RUN_AS_NODE remained present with an empty value. A construction diagnostic reproduced the native crash before product logging. Changing only launcher clearing to `Remove-Item Env:<name>` produced a visible main window with identical product source/executable. Preserve this instrumentation failure separately from the primary-window defect.

## Bounded real diagnostic

With corrected launcher, own D-drive userData and port32110, no acceptance flag, CDP or observer preload: PID22044 rendered the real primary window. A duplicate launch PID11100 disappeared with empty stderr (exit code not captured). Native Alt+F4 exited Desktop and companion; before/after process snapshots retained original Runtime27580 and Harness23492 with unchanged creation times. Same-profile launch PID14392 visibly restored the main window. It was closed natively, then Runtime explicitly stopped through the canonical CLI. No force kill was used in this diagnostic.

Evidence: `D:/Hns-Final-Qualification/desktop-close-diagnostic/`, including launch metadata, stderr, before/after process snapshots,01-main.png,03-reopened.png and explicit-runtime-stop.log. This construction-profile diagnostic is not a fresh cleanroom, notification-after-task regression, final visual PASS, native SystemOrb acceptance or wall-clock soak. Its inherited test appearance is visibly distorted when expanded and needs fresh-profile comparison before attribution. Renewed immutable-candidate qualification and complete actual Journey remain required.

Historical subset: `history/cc3d9097c4d8b07ee7f8a97a6f9e2c94dbb5a28c/desktop-close-20260923/`. Original failed checkout and screenshots remain intact. No cleanup changes the failure verdict. Author review only; no independent QA agent was used.
