# DS-Hns paper material

This directory is an evidence map, not a publication claim. It reconstructs 326 reachable commits across all fetched refs as of 2026-09-22, groups patch-equivalent cherry-picks into one logical change, and links proposed claims to code, tests, experiments, and limitations.

The most coherent current paper direction is a capability-separated, fault-bounded runtime for a long-running AI harness. Plugin adaptation and runtime/UI separation are supporting mechanisms; neither is presently backed by comparative external-system evidence.

Evidence labels used throughout:

- `MEASURED`: produced by a named executable experiment and retained artifact.
- `OBSERVED`: real process, UI, filesystem, or network behavior, but not a controlled comparative experiment.
- `SYNTHETIC`: real implementation under virtual time, injected faults, or a stand-in application.
- `NOT_RUN`: no result; never interpreted as a pass.
- `UNSUPPORTED`: a useful claim candidate with insufficient evidence.

Start with [PAPER_MATERIAL_INDEX.md](PAPER_MATERIAL_INDEX.md), then the claim matrix and experiment catalog. Machine-readable records live under `data/`.
