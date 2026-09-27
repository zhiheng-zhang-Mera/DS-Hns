# Saved policy versus effective engine policy

Observed on `27eea591bfae6b404f3eba2475094060ec9a9587`, tree `8708026c145f72fa8672151274b426f00fbb8e8f`, during a real construction-GUI diagnostic, not a cleanroom acceptance.

## Actual observation

The operator used the visible Settings/Mega controls to enable Health, type16000 and Apply. The settings surface reported effective16000 and the persisted plugin file contained intervalMs16000. Health correctly remained loaded/healthy after the earlier optional-authority repair, but an explicit actual Check still reported `sampling every 15000ms`.

Evidence: `D:/Hns-Final-Qualification/visual-diagnostic-27eea59/01-health-disabled.png` through `05-health-check-interval-mismatch.png`, `launch.json`, and `persisted-health-policy.json`. The launcher used a new isolated userData, app name and port32200, but the construction profile was reused (including its missing optional wallpaper); this is not fresh installation evidence. No CDP, acceptance flag or observer preload was used. Desktop was closed via actual input, followed by graceful product Runtime stop of instance49cd90f48771f8cc.

## Root cause and scope

The host rebuilt the plugin manager with resolved configuration, but the shipped Health and Restart engines already captured defaults in their constructors. They do not consume manager context configuration at load. Health additionally exposes a flat public intervalMs while its engine expects sampling.intervalMs. Updating a settings readback therefore did not prove effective policy.

Pass only each owner's existing resolved configuration through the shipped mounted factory path. Translate Health's existing public interval spelling at its factory boundary; preserve nested sampling options and the engines' existing default merges. Plugins still pass through the same native adapter and manager; no new loader, config store, authority or process-control path is added. The continuity host remains restricted to Restart Supervisor.

## Reproduction and validation

- `health-effective-policy-red.log`: real host test failed15000 versus16000.
- `health-restart-effective-policy-red.log`: two real host tests failed Health15000 versus17000 and Restart budget3 versus2. They now assert actual engine diagnostics after configure and reopen, including nested policy and default siblings, rather than only saved settings.
- Focused `health-restart-effective-policy-green-r3.log`:71/71PASS,0skip,15869.1392ms. Earlier focused runs69/71 and70/71 are preserved: source-exact wiring assertions expected the old parameter list. The same unique authority, continuity host, portable Node and stateDir assertions now match the added config arguments; no test was removed.
- Complete regression `effective-policy-full-r1.log` terminated exit0:1991total,1989pass,0fail,2declared optional-sample skips,460442.5193ms. Repository Node24.14.1, explicit PATH and D-drive environment, `scripts/test-all.ps1` including syntax preamble. The skips are the absent legacy dsh-market and wallpaper-engine-dsh sample directories under `D:/test-DSH/samples`; no threshold changed.
- `effective-policy-post-test-audit.json` covers the diagnostic start through full-test completion: process-leak PASS and bounded project-name C-drive-write PASS, not system-wide filesystem tracing. Paper validator passed with no errors. Separate author diff review verified owner-specific policy routing, retained partial/default merges and unchanged adapter/continuity authority boundaries; no delegated QA.

The prior27eea59 CI35924007091 passed. It does not certify this repair. Current-source visual repeat, full frozen-candidate qualification, cleanroom and CI remain required.
