# Claim–evidence matrix

| Claim ID | Claim | Code | Commit | Test | Experiment/artifact | Result | Limitation |
|---|---|---|---|---|---|---|---|
| C1 | Health and restart authority are separated | `app/plugins/health-scheduler`, `app/plugins/restart-supervisor` | `16d722c`, `572bf52` | `restart-supervisor-authority.test.js` | `artifacts/acceptance/longhost-chaos.json` | 65/65 chaos checks | injected faults; one host |
| C2 | Three plugin forms share one lifecycle | `app/core/plugin-adapters`, `app/core/plugin-install` | `db5ebab`, `d44d835`, `9417ca8`, `1965f33` | adapter/install suites | qualification `install-pipeline`, `cordis-adapter`, `process-adapter` | mandatory gates pass | two external Cordis samples |
| C3 | Process-plugin failure is bounded | `process/supervisor.cjs` | `9417ca8` | `plugin-process-adapter.test.js` | process acceptance; chaos plugin-crash/timeout | safe mode; timeout 503 ms | stand-in application |
| C4 | Continuity prevents false success/duplication | `task-continuity.cjs`, `work-admission.cjs` | `f009619` | `longhost-continuity.test.js` | chaos host-restart, git-interruption, false-success | cases pass | real reboot `NOT_RUN` |
| C5 | Runtime and UI have distinct ownership | `app/runtime/*`, `desktop-main.cjs` | `d0b02e0`, `5a34f30` | runtime instance/host tests | isolated real Electron launch | one instance/host identity | named pipe/Windows only |
| C6 | Evidence contradictions fail closed | `qualification-runner.cjs`, `evidence-consistency.cjs` | `67b741a`, `be743a7` | consistency/runner tests | immutable qualification runs | contradiction rejected | runner itself is project-specific |
| C7 | DS-Hns is more reliable than alternatives | — | — | — | — | `UNSUPPORTED` | no external baseline |
