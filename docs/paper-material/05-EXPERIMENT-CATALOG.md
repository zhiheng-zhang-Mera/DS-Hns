# Experiment catalog

| ID | Goal and workload | Treatment/baseline | Metric and threshold | Result | Repeats | Artifact | Limitation |
|---|---|---|---|---|---|---|---|
| E-PHASE-C | Time to accepted patch over the same six validation files | six process starts vs one batched process | optimized ratio ≥1.2 | 1.881, 1.875, 1.879; median 1.879 | 3 | `artifacts/qualification/task4-phase-c-*.json` | local host/startup-sensitive |
| E-COMBINED | full engineering acceptance A–D | repository-defined | all checks pass | 52/52 historical child checks | 1 bound run | archived combined report | synthetic/model simulation components; overall run failed |
| E-CU-LONG | sustained Computer Use state machine | injected controller/runtime events | failures=0 | 96 checks, 0 failures | 1 retained run | `computer-use-longrun.json` | not a human desktop session |
| E-CHAOS | eight fault/recovery scenarios | kill, timeout, network loss, restart, interruption | every scenario passes | 65/65 | 1 retained run | `longhost-chaos.json` | faults injected; reboot path simulated |
| E-SOAK | 6/12/24h scheduler and restart behavior | virtual clock | failures=0 | 120/120 | 3 horizons | `longhost-soak.json` | synthetic virtual time |
| E-INSTALL | unified install for repository/native/process/refusal/lifecycle | real GitHub fetch plus pinned source fixture | failures=0 | 46/46 historical child checks | 1 bound run | archived install report | network availability; not fresh full product installation |
| E-CORDIS | two published bundles and a generated stranger | same adapter without plugin-specific code | routes/lifecycle/teardown pass | 66/66 historical child checks | 1 bound run | archived Cordis report | browser halves not served |
| E-PROCESS | external restart supervisor behind JSONL bridge | real supervisor, stand-in watched app | bounded restart and safe mode | 33/33 historical child checks | 1 bound run | archived process report | watched app is stand-in |
| E-UI | visible Electron, skills, GitHub, theme, official page input | real renderer and CDP/OS input | all mandatory checks pass | FAIL127/130;3failed | 1 bound run | archived Electron report | native-input precondition/focus failure retained; not full human Journey |
| E-QUAL | audit same-run evidence identity and verdict consistency | immutable run and child reports | consistency errors = 0 | 1/1 consistency check; overall qualificationFAIL | 1 bound run | archived `evidence-consistency.json` | structural consistency, not success or scientific validity |
| E-REBOOT | real Windows reboot | none | exact-once resume | `NOT_RUN` | 0 | planned `REAL_REBOOT_ACCEPTANCE` | D-only automatic-resumption prerequisite unmet; no global host ban established |
| E-24H | real 24h wall-clock run | none | resource and continuity guardrails | `NOT_RUN` | 0 | planned `REALTIME_24H_SOAK` | synthetic soak is not substitute |
| E-CLEANROOM | fresh clone, Standard install, full matrix and real Journey | no reused dependencies/profile/cache | all mandatory gates pass | PENDING_FINAL_CANDIDATE | 0 final runs | final evidence index | older installation passes do not qualify newer candidates |

Except Phase C and the explicit unexecuted/pending rows, numeric results are bound to historical run `2026-09-23T05-33-13-145Z-0c277af6`, SHA `1a2fa2c4881cb7337f480c770b25337fd55b7654`; its overall verdict isFAIL. Exact archive paths, per-child commands and report hashes are in `data/experiments.json`. Phase C measured codeSHA is `9cecd68`; `0bbd32e` is the later evidence commit, not the tested code identity. The three synthetic-soak horizons are one invocation, not three independent replications.
