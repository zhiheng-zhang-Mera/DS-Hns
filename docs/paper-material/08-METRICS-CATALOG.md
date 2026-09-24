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
