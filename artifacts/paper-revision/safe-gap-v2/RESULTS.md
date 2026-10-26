# Safe mechanism campaign results

120 arm observations; 0 infrastructure errors; 0 ECQ episodes.

| Experiment | Stratum | Arm | n | Main outcome |
|---|---|---|---:|---|
| A4 | gap | checkpoint | 30 | exactly-once 0/30; complete 30/30; duplicate episodes 30 |
| A4 | gap | langgraph-sqlite | 30 | exactly-once 0/30; complete 30/30; duplicate episodes 30 |
| A4 | gap | replay | 30 | exactly-once 0/30; complete 30/30; duplicate episodes 30 |
| A4 | gap | simple-journal | 30 | exactly-once 0/30; complete 30/30; duplicate episodes 30 |

## Interpretation

- One Windows host; component adapters, not desktop product workflow.
- A3 is deterministic virtual-time policy testing, three fixed schedule families; no physical restart.
- A4 uses 30 generated seeds in each fixed fault stratum; four arms paired, not independent populations.
- Wilson and bootstrap intervals conditional on sampled fixture seeds; structural outcomes are not general reliability estimates.
- Effect and checkpoint are not one transaction; gap duplicates are counterevidence retained.
- Cross-runtime launch/import latency not an algorithmic speed comparison.
