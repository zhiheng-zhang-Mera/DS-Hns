# FQ-PACKAGING-001: installed plugin packages could not load

Fresh cleanroom8 Standard installation on7afe8bc exited0 with113/113 smoke tests, but its real first Electron launch failed. Screenshot D:\Hns-Cleanroom-Qualification-8\visual-evidence\01-startup-failure.png shows a30s Runtime command timeout. The root error in logs/desktop-runtime.log is missing ./contract.cjs in both installed built-in plugins. Restart Supervisor also requires ./status.cjs, which was absent from its package allowlist.

The source files existed, but package.json files lists excluded them. Source junctions initially concealed the defect; optional plugin package-manager reconciliation could replace those links with packed copies. Cleanroom7 retained links and did not expose it. Installation smoke success was therefore not evidence of a successful real launch.

The repair adds only the required contract/status files to the two package allowlists. A regression uses actual npm pack, tar extraction into isolated D scratch, and a fresh process requiring each package without access to the source contract. Both tests failed with MODULE_NOT_FOUND before the repair and passed afterward. Logs: D:\Hns-Final-Qualification\packaged-plugins-red.log and packaged-plugins-green.log. The deterministic packaging checks are now included in the installer smoke tier as well as the complete unit suite.

Full portable-Node24.14.1 unit regression completed with exit0:1922tests,1920pass,0fail,2defined absent-community-sample skips (D:\Hns-Final-Qualification\packaged-plugins-full-unit.log). A separate packed-artifact repair experiment restored real Electron startup and visual task-form interaction; original failed logs were copied first. That repaired installed state is explicitly not a fresh final qualification.

Full immutable candidate qualification and a new fresh remote clone remain required. Construction run2026-09-23T04-04-47-966Z-39abbeb3 was interrupted before editing, after syntax PASS and during units, and remains NOT_COMPLETED. Cleanroom8 failure and controlled repair evidence are both retained.
