# Abstract material

## Measured facts

- Three paired Phase C runs achieved 1.875–1.881x improvement after batching the same validation workload.
- Retained chaos evidence contains 65 passing checks across eight injected scenarios.
- Synthetic 6/12/24h horizons contain 120 passing checks; these are virtual-time results.
- Final qualification binds every child result to one run ID, commit SHA, and tree and rejects contradictions.

## Engineering observations

- Health decisions and restart authority can be implemented as separate plugins connected by a declared capability.
- Native, Cordis, and managed-process plugins can traverse one manager lifecycle while keeping format-specific behavior in adapters.
- Moving durable runtime ownership outside Electron permits the UI to act as a reconnectable client.

## Hypotheses

- Authority separation may reduce unsafe restart coupling.
- Process isolation plus bounded budgets may reduce host-wide failure propagation.

## Future work

- real reboot and 24h wall-clock runs;
- comparative/ablation baselines;
- larger plugin corpus and cross-platform replication.

Any final abstract should preserve these epistemic labels rather than converting hypotheses into findings.
