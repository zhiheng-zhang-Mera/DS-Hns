# Final visible user-journey evidence

The complete interactive product journey was exercised through Codex Computer Use on the real Windows desktop. The retained narrative is `D:\HnsQ24\journey-dafd3bf\JOURNEY_DAFD3BF.md` (SHA-256 `01127ca4c34781b1efe8aaa09d43b5eb48b976f12add48ca4ac39a3067b54d9e`). This run used product commit `dafd3bfff8db30f2aaf094e4a15ed41a2c1f9ce6`, not the exact final candidate commit. A direct Git comparison found no changes under `app/`, `scripts/`, or `tests/` between that commit and qualified candidate `63eabc9a9341abd2e612bf603e3ce340eaa2cc57`; the only intervening candidate changes were documentation. The journey is therefore product-code-equivalent evidence, not an exact-commit run.

Observed interaction sequence:

1. Clicked the separate native System Orb; it expanded the Mega window and showed the panel. Clicking its account section produced visible interaction feedback. Account screenshots remain local because they contain private balance information.
2. Opened Mega settings and clicked Health Scheduler from DISABLED to LOADED. Its live check displayed `healthy yes`, a 15-second sampling interval, `HEALTHY`, and pressure `12`.
3. Read Plugin Market's installed view: four distinct logical plugin identities appeared without duplicate rows. The optional Computer Use module was described as unavailable because no host runtime was attached, while the core was explicitly unaffected.
4. Opened the real Windows native directory picker, visually read the dialog, entered and verified the D-drive workspace, clicked `Choose Folder`, and confirmed installation/use on disk.
5. Submitted `37 times 29 plus 36` to the real DeepSeek V41 Flash-backed product UI; it returned `1109`.
6. Closed and reopened the desktop with the same explicit `DSH_USER_DATA_DIR` identity. It reattached to runtime PID `26412` on port `32101` and displayed the persisted conversation and answer.

Exact-candidate visual evidence is separately bound to `D:\HQR\qualification-runs\2026-09-24T06-54-31-334Z-09571b4b\reports\electron-ui-acceptance.json`: real Electron UI acceptance passed `131/131`, including the native picker flow and disk verification. The live Codex visual session read and clicked the native dialog; this is not inferred from DOM state alone. The same report warns that the AI model adapter was disabled for theme generation and the deterministic interpreter designed the themes; model-assisted theme generation is not claimed as run.

Open observations from the visible journey are retained, not hidden: the explicit opt-in integrated dock can cover most of the first-run disclosure's Continue control; and Plugin Market's Scheduler verification text said `重启后生效` while the Scheduler was already LOADED. The former is a P2; the latter remains unconfirmed because no source-level cause or state mismatch was established. See `D:\HnsQ24\journey-dafd3bf\OPT_IN_DOCK_P2_TRIAGE.md` (SHA-256 `c7346f3d8b58fc408edfa30b3bf29ce820be0f769e4e2b1e89fbd9c1049f7515`).
