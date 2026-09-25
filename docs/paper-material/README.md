# DS-Hns paper material

This directory is an evidence map, not a publication claim. Its immutable mining snapshots began with 326 reachable commits across fetched refs as of 2026-09-22, then recorded finite refreshes at 340, 342, and 364 commits. The historical production baseline snapshot reaches 366 commits at candidate `63eabc9a9341abd2e612bf603e3ce340eaa2cc57` / merge `5dcde767020161f6f6c7a5fc3330bccaca1d14a3`, tagged `hns-production-v1`. The distinct 2026-09-25 RC2 candidate `4ef9c0df149a6cecf1eaa17e50cee4b22271b810` passed 17/17 machine gates but remains unmerged and untagged; overall finalization is `HNS_FINALIZATION_BLOCKED` because of a task-controlled C-drive profile write and remaining acceptance gaps. Patch-equivalent cherry-picks are grouped as one logical change; merge commits are not counted as additional research contributions. See `01-COMMIT-TIMELINE.md` and `data/commit-lineage.json` for the exact cutoffs and branch dispositions.

The most coherent current paper direction is a capability-separated, fault-bounded runtime for a long-running AI harness. Plugin adaptation and runtime/UI separation are supporting mechanisms; neither is presently backed by comparative external-system evidence.

Evidence labels used throughout:

- `MEASURED`: produced by a named executable experiment and retained artifact.
- `OBSERVED`: real process, UI, filesystem, or network behavior, but not a controlled comparative experiment.
- `SYNTHETIC`: real implementation under virtual time, injected faults, or a stand-in application.
- `NOT_RUN`: no result; never interpreted as a pass.
- `UNSUPPORTED`: a useful claim candidate with insufficient evidence.

Start with [PAPER_MATERIAL_INDEX.md](PAPER_MATERIAL_INDEX.md), then the claim matrix and experiment catalog. Machine-readable records live under `data/`.
