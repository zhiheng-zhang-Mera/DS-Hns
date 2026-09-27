# Metrics catalog

| Metric | Definition | Unit | Source | Interpretation boundary |
|---|---|---|---|---|
| Phase C improvement | baseline elapsed / optimized elapsed for same six files | ratio | combined acceptance | host/process-start dependent |
| accepted-patch latency | elapsed validation path to accepted result | ms | Phase C raw report | simulated engineering loop |
| gate checks/failures | explicit assertions and false assertions | count | child reports | different suites have different grain |
| restart attempts/refusals | requested relaunches allowed/refused by budget | count | soak/chaos | injected schedule |
| recovery level | continuity classification after restart | categorical | chaos report | project-defined semantics |
| process leaks | live Node/Electron commands naming checkout after gates | count | post-test audit | does not cover unrelated processes |
| C-drive writes | project-shaped LocalAppData entries modified after start | count | post-test audit | detects named project entries, not arbitrary OS writes |
| evidence consistency errors | identity/time/verdict/total/path contradictions | count | consistency report | structural consistency, not scientific validity |
| UI Journey checks | renderer/interaction assertions | count | Electron acceptance | not usability/accessibility score |

Phase C retained measurements: baseline 17198/17218/17381 ms; optimized 9141/9184/9248 ms; ratio min 1.875, median 1.879, max 1.881, population variance 0.0000062222.

Historical production-candidate Phase C repeats (candidate `63eabc9a9341abd2e612bf603e3ce340eaa2cc57`, unchanged workload and 1.2 threshold): baseline 17582/17303/17471 ms; optimized 9202/9265/9106 ms; ratio 1.911/1.868/1.919; min 1.868, median 1.911, max 1.919, mean 1.8993333, population variance 0.0005015556. Its primary combined qualification measurement is a separate single-run ratio of 1.897 (17325/9131 ms), not one of the three repeats. These values remain historical and are not attributed to current candidate `4ef9c0d`.

The later RC2 engineering qualification on candidate `4ef9c0df149a6cecf1eaa17e50cee4b22271b810` reports a separate primary combined Phase C ratio of 1.873 (17,565/9,378 ms). This is one same-host run of the declared engineering workload; it is not pooled with the three historical repeats above, is not a provider measurement, and does not create a comparative research claim.

Three additional unchanged-workload Phase C repeats on exact candidate `4ef9c0df149a6cecf1eaa17e50cee4b22271b810` measured baseline 16909/16830/16736 ms and optimized 8890/8918/8894 ms; ratios 1.902/1.887/1.882; min 1.882, median 1.887, max 1.902, mean 1.8903333, population variance 0.0000722222. All exceeded the unchanged 1.2 threshold. Raw run hashes and D-rooted evidence paths are in `artifacts/qualification/FINAL_PHASE_C_RERUNS_4EF9C0D.json`.

The current exact RC2 same-run qualification (`4ef9c0d`) had 17 mandatory gates and zero mandatory failures. Its unit result was 2,027/2,029 passed, zero failed, two optional sample-dependent skips. Exact-candidate UI acceptance was 134/134. The earlier `63eabc9` release run separately recorded 2,002/2,004 and 131/131. These are engineering acceptance counts with different grains, not user-study scores or independent samples. The immutable current r4 run's scoped post-test audit detected zero candidate process leaks and zero project-shaped C-drive writes; three separately observed task-controlled C write incidents remain open, so this narrow audit does not establish overall D-only compliance or a whole-OS write monitor.
