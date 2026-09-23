# Contribution claim candidates

## Supported engineering claims

1. **C1 — capability-separated health and restart authority.** The Health Scheduler can observe and recommend without owning restart execution; a separately provided `restart-control` capability enforces restart policy. Evidence: `16d722c`, `572bf52`, authority tests, chaos acceptance. Scope: this implementation only.
2. **C2 — heterogeneous plugin adaptation behind one lifecycle.** Native HNS, Cordis bundles, and managed processes reach one manager/install contract through ordered adapters. Evidence: `db5ebab`–`1965f33`, three adapter acceptances and install pipeline.
3. **C3 — bounded process failure isolation.** A plugin companion can crash repeatedly without crashing the host; restart attempts terminate in safe mode. Evidence: process adapter and longhost chaos.
4. **C4 — durable task-continuity checks across runtime restart.** Checkpoints, resume discovery, and false-success prevention are exercised under injected host/process restarts. Evidence: `f009619`, continuity tests, chaos cases. Scope: simulated restart path, not real Windows reboot.
5. **C5 — runtime/UI ownership separation.** A per-instance Runtime Host owns durable services while Electron attaches as a client, preventing a second host for the same identity. Evidence: `d0b02e0`, `5a34f30`, runtime tests.
6. **C6 — evidence-consistent qualification.** Final gates are bound to one SHA/tree/run and reject exit/report contradictions and stale external reports. Evidence: `67b741a`, `be743a7`, consistency tests.

## Unsupported or future claims

- **C7 — comparative reliability against other AI harnesses.** `UNSUPPORTED`: no comparative baseline exists.
- `UNSUPPORTED`: the design is novel or first; no literature review establishes novelty.
- `UNSUPPORTED`: production reliability over 24 hours; synthetic virtual-time soak is not wall-clock evidence.
- `UNSUPPORTED`: cross-platform behavior; qualification is Windows-only.
- `UNSUPPORTED`: accessibility conformance; screenshots and pointer journeys are not an accessibility audit.
