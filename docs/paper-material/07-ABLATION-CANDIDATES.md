# Ablation candidates

| Ablation | Question | Existing evidence | Required controlled experiment | Stop condition |
|---|---|---|---|---|
| remove restart authority separation | Does coupling health to restart increase unsafe actions? | architecture tests only | replay identical telemetry traces in coupled/separated variants | policy semantics cannot be held constant |
| remove process isolation | Does a crashing plugin affect host availability? | injected crash shows isolated survival | matched in-process implementation and repeated crash workload | no safe in-process variant |
| disable restart budget | Does bounding prevent infinite churn? | terminal safe-mode checks | fixed crash schedule with/without budget; count relaunches/resources | risk to host cannot be contained |
| remove checkpoints | Are duplicates/lost work prevented by continuity store? | interruption tests | identical tasks with checkpointing disabled | irreversible external side effects |
| per-test processes vs batching | Which Phase C gain is startup removal? | three paired timings | alternate order, cold/warm strata, ≥20 pairs | host load cannot be stabilized |
| direct page vs sibling overlay | Does direct official UI reduce input obstruction? | real click-through Journey | negative control with mouse transparency disabled | legacy surface unavailable |
| immutable vs mutable evidence directory | Does run binding detect stale evidence? | unit contradiction case | seed stale child report in controlled run | none |
