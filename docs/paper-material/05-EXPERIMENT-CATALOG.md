# Experiment catalog

| ID | Goal and workload | Treatment/baseline | Metric and threshold | Result | Repeats | Artifact | Limitation |
|---|---|---|---|---|---|---|---|
| E-PHASE-C | Time to accepted patch over the same six validation files | six process starts vs one batched process | optimized ratio ≥1.2 | 1.881, 1.875, 1.879; median 1.879 | 3 | `artifacts/qualification/task4-phase-c-*.json` | local host/startup-sensitive |
| E-COMBINED | full engineering acceptance A–D | repository-defined | all checks pass | 52/52 on repaired candidate | repeated during qualification | run-local combined report | synthetic/model simulation components |
| E-CU-LONG | sustained Computer Use state machine | injected controller/runtime events | failures=0 | 96 checks, 0 failures | 1 retained run | `computer-use-longrun.json` | not a human desktop session |
| E-CHAOS | eight fault/recovery scenarios | kill, timeout, network loss, restart, interruption | every scenario passes | 65/65 | 1 retained run | `longhost-chaos.json` | faults injected; reboot path simulated |
| E-SOAK | 6/12/24h scheduler and restart behavior | virtual clock | failures=0 | 120/120 | 3 horizons | `longhost-soak.json` | synthetic virtual time |
| E-INSTALL | unified install for repository/native/process/refusal/lifecycle | real GitHub fetch plus pinned source fixture | failures=0 | 39 checks in qualification | per final run | run-local install report | network availability |
| E-CORDIS | two published bundles and a generated stranger | same adapter without plugin-specific code | routes/lifecycle/teardown pass | pass after locked dependency materialization | per final run | run-local Cordis report | browser halves not served |
| E-PROCESS | external restart supervisor behind JSONL bridge | real supervisor, stand-in watched app | bounded restart and safe mode | pass | per final run | run-local process report | watched app is stand-in |
| E-UI | visible Electron Journey, skills, GitHub, theme, official page input | real renderer and CDP/OS input | all mandatory checks pass | pass | per final run | run-local Electron report + screenshots | not accessibility certification |
| E-QUAL | reject mixed-run or contradictory qualification evidence | immutable run and child reports | consistency errors = 0 | pass in focused construction run | per final run | run-local `evidence-consistency.json` | structural consistency, not scientific validity |
| E-REBOOT | real Windows reboot | none | exact-once resume | `NOT_RUN` | 0 | planned `REAL_REBOOT_ACCEPTANCE` | host policy/session continuity |
| E-24H | real 24h wall-clock run | none | resource and continuity guardrails | `NOT_RUN` | 0 | planned `REALTIME_24H_SOAK` | synthetic soak is not substitute |
