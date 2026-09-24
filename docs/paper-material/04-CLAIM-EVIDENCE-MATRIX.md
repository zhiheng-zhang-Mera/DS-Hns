# Claim–evidence matrix

| Claim ID | Claim | Code | Commit | Test | Experiment/artifact | Result | Limitation |
|---|---|---|---|---|---|---|---|
| C1 | capability-separated health and restart authority | `app/plugins/health-scheduler`, `app/plugins/restart-supervisor` | `16d722c`, `572bf52` | `tests/unit/restart-supervisor-authority.test.js` | E-CHAOS, E-SOAK | historical child checks pass | injected faults; one host |
| C2 | heterogeneous plugin adaptation behind one lifecycle | `app/core/plugin-adapters`, `app/core/plugin-install` | `db5ebab`, `d44d835`, `9417ca8`, `1965f33` | `tests/unit/plugin-adapters-framework.test.js`, `tests/unit/plugin-hns-native.test.js` | E-INSTALL, E-CORDIS, E-PROCESS | 46/46, 66/66, 33/33 historical child checks | bounded fixtures, not arbitrary plugins |
| C3 | bounded process failure isolation | `app/core/plugin-adapters/process/supervisor.cjs` | `9417ca8` | `tests/unit/plugin-process-adapter.test.js` | E-PROCESS, E-CHAOS | bounded recovery/safe-mode checks pass | watched app is a stand-in |
| C4 | durable task-continuity checks across runtime restart | `app/core/task-continuity.cjs`, `app/core/work-admission.cjs` | `f009619`, `f90660b` | `tests/unit/longhost-continuity.test.js` | E-CHAOS | controlled cases pass | real reboot `NOT_RUN` |
| C5 | runtime/UI ownership separation | `app/runtime/host.cjs`, `app/desktop-main.cjs` | `d0b02e0`, `5a34f30` | `tests/unit/instance-isolation.test.js`, `tests/unit/runtime-client-contract.test.js` | archived all-unit-tests result/stdout in claims.json | runtime tests included in passing full unit suite | whole-suite count is not a runtime-only count; same-run UI gate failed |
| C6 | evidence-consistent qualification | `scripts/qualification-runner.cjs`, `scripts/evidence-consistency.cjs` | `67b741a`, `be743a7` | `tests/unit/evidence-consistency.test.js`, `tests/unit/qualification-runner.test.js` | E-QUAL | consistency audit passes for an overall failed run | consistency is not success or scientific validity |
| C7 | comparative reliability against other AI harnesses | — | — | — | — | `UNSUPPORTED` | no external baseline |

The canonical IDs/titles, exact repository-relative paths and archived evidence are in `data/claims.json`. Historical child results refer to run `2026-09-23T05-33-13-145Z-0c277af6`, SHA `1a2fa2c4881cb7337f480c770b25337fd55b7654`. That whole run failed its UI gate127/130; none of its passing child results is a final release certificate. `data/experiments.json` binds each child to the preserved summary/report and SHA256 hashes.
