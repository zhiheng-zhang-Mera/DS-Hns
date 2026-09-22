# Paper split candidates

## A — Long-running AI harness with bounded recovery

- Research question: how can an interactive AI harness preserve task truth while recovering from bounded failures?
- Existing evidence: health/restart separation, continuity, chaos, synthetic soak.
- Missing: real reboot, real 24h, workload diversity, comparative baseline.
- Required: repeated wall-clock workloads and a coupled-authority ablation.
- Overlap: absorbs most of C; uses B as mechanism.

## B — Heterogeneous plugin adaptation and capability mediation

- Research question: can native, Cordis, and process plugins share lifecycle semantics without embedding format knowledge in the manager?
- Existing evidence: three adapters, real routes, real external supervisor, common installer.
- Missing: larger corpus, compatibility success/failure rates, overhead measurement.
- Required: stratified public-plugin corpus and adapter-ablation study.
- Overlap: can be an A subsystem today; independent paper evidence is incomplete.

## C — Health monitoring with separated restart authority

- Research question: does separating observation/decision from restart execution reduce unsafe restart behavior?
- Existing evidence: formal capability boundary and injected policy tests.
- Missing: coupled comparator and trace-based evaluation.
- Required: replayed traces with fixed policy inputs.
- Overlap: strongest conceptual core of A, likely not independent yet.

## D — Runtime/UI separation and non-interrupting operator console

- Research question: does moving durable services out of Electron improve continuity and observability?
- Existing evidence: single-host identity, reconnect tests, real UI journeys.
- Missing: before/after downtime, memory/startup costs, user study.
- Required: controlled crash/reconnect and operator-task study.
- Overlap: supporting architecture for A.

Recommendation: one primary A paper with C as central design principle and B/D as implementation mechanisms. Preserve B as a future standalone direction after corpus evaluation.
