# Safe mechanism campaign results

630 arm observations; 0 infrastructure errors; 0 ECQ episodes.

| Experiment | Stratum | Arm | n | Main outcome |
|---|---|---|---:|---|
| A3 | burst | bounded | 30 | over-budget episodes 0; oracle disagreement episodes 0 |
| A3 | burst | cap-off | 30 | over-budget episodes 30; oracle disagreement episodes 30 |
| A3 | burst | simple-window | 30 | over-budget episodes 0; oracle disagreement episodes 0 |
| A3 | spaced | bounded | 30 | over-budget episodes 0; oracle disagreement episodes 0 |
| A3 | spaced | cap-off | 30 | over-budget episodes 0; oracle disagreement episodes 0 |
| A3 | spaced | simple-window | 30 | over-budget episodes 0; oracle disagreement episodes 0 |
| A3 | window-edge | bounded | 30 | over-budget episodes 0; oracle disagreement episodes 0 |
| A3 | window-edge | cap-off | 30 | over-budget episodes 30; oracle disagreement episodes 30 |
| A3 | window-edge | simple-window | 30 | over-budget episodes 0; oracle disagreement episodes 0 |
| A4 | boundary | checkpoint | 30 | exactly-once 30/30; complete 30/30; duplicate episodes 0 |
| A4 | boundary | langgraph-sqlite | 30 | exactly-once 30/30; complete 30/30; duplicate episodes 0 |
| A4 | boundary | replay | 30 | exactly-once 0/30; complete 30/30; duplicate episodes 30 |
| A4 | boundary | simple-journal | 30 | exactly-once 30/30; complete 30/30; duplicate episodes 0 |
| A4 | gap | checkpoint | 30 | exactly-once 0/30; complete 27/30; duplicate episodes 27 |
| A4 | gap | langgraph-sqlite | 30 | exactly-once 0/30; complete 30/30; duplicate episodes 30 |
| A4 | gap | replay | 30 | exactly-once 0/30; complete 30/30; duplicate episodes 30 |
| A4 | gap | simple-journal | 30 | exactly-once 0/30; complete 27/30; duplicate episodes 27 |
| A4 | no-fault | checkpoint | 30 | exactly-once 30/30; complete 30/30; duplicate episodes 0 |
| A4 | no-fault | langgraph-sqlite | 30 | exactly-once 30/30; complete 30/30; duplicate episodes 0 |
| A4 | no-fault | replay | 30 | exactly-once 30/30; complete 30/30; duplicate episodes 0 |
| A4 | no-fault | simple-journal | 30 | exactly-once 30/30; complete 30/30; duplicate episodes 0 |

## Interpretation

- One Windows host; component adapters, not desktop product workflow.
- A3 is deterministic virtual-time policy testing, three fixed schedule families; no physical restart.
- A4 uses 30 generated seeds in each fixed fault stratum; four arms paired, not independent populations.
- Wilson and bootstrap intervals conditional on sampled fixture seeds; structural outcomes are not general reliability estimates.
- Effect and checkpoint are not one transaction; gap duplicates are counterevidence retained.
- Cross-runtime launch/import latency not an algorithmic speed comparison.
