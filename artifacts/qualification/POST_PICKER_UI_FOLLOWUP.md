# UI observation scope after real native input

Local full run `2026-09-23T05-33-13-145Z-0c277af6` on `1a2fa2c4881cb7337f480c770b25337fd55b7654` failed its mandatory UI gate:127/130. Skills11/11 passed through actual targeted native input. All other gates, including combined52/52, process/storage audits and evidence consistency, passed; none overrides the UI failure.

The native dialog returned focus to the official page at05:57:51.671Z, triggering the documented automatic dock collapse. Its width became0 before the local skill installation completed. The later wallpaper check required a visible dock cut without restoring its visible-dock precondition. The corrected flow reopens the dock through its existing control and adds an explicit readiness assertion before theme measurements. No wallpaper geometry assertion is removed.

The focus probe captured descendant control blur/focus events as renderer focus changes. A behavioral regression failed with1instead of0 for a descendant blur. It now counts only events whose target iswindow; an actual window loss and recovery remain counted. The existing focused=true and focus>=blur predicates are unchanged.

Focused picker/readiness/focus tests6/6PASS. Diagnostic real Electron run `2026-09-23T06-02-13-322Z-8711f8dd` passed131/131, with a newly observed native directory selection and the additional dock-precondition check. It was run with `--allow-dirty --only electron-ui-acceptance`; it is not immutable final candidate qualification and cannot replace the failed full run. Screenshots and raw outputs remain under `D:\Hns-Final-Qualification\diagnostic-ui-runs`.

The diagnostic stderr also exposed real Debugger listener warnings, tracked separately in `ELECTRON_LISTENER_FOLLOWUP.md`. The deterministic theme interpreter is not an AI designer; that limitation remains explicit. Full regression and new committed-candidate local/cleanroom qualification are still required.

Subsequent combined repair regression: pinnedNode24.14.1 fullsuite1932total1930passed0failed2definedexternal-sample skips (`listener-release-full-regression.log`). Real Electron dirty/UI-only run `2026-09-23T06-36-53-021Z-743ee342` passed131/131 with another targeted native directory selection. Exact committed-candidate local/cleanroom runs remain required.
