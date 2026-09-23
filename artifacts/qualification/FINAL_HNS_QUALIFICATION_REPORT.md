# DS-Hns final qualification report

This report defines the final evidence contract for `dev/hns-final-qualification-rc2`. Exact candidate, tree, merge, and tag identities are resolved from immutable qualification summaries and final Git refs; they are not hard-coded into the commit that contains this report, which would create a false self-reference.

## Required release gates

Production baseline establishment requires all of the following on one candidate tree: complete local qualification, fresh remote-clone install and qualification, GitHub required checks, `main` tree equality after merge, and post-merge smoke. Any failure keeps the release fail-closed.

The production-like package for this repository is its pinned fresh Standard installer/bootstrap plus unpacked Electron runtime; the repository does not declare an electron-builder/MSI artifact contract. This must not be described as a signed native installer package.

## Resolved issue inventory

- `RC1-INSTALL-002`: reconciled installer/profile/runtime plugin truth, including materialized `file:` versions and stale transient failures.
- `RC1-STORAGE-001`: introduced D-drive qualification roots plus fail-closed process-leak and C-drive write audits.
- `RC1-GATE-001`: removed unrelated optimized-path process startup without changing workload or the 1.2x threshold. Three full Phase C repeats were 1.881x, 1.875x, and 1.879x.
- `RC1-UI-002`: canonical logical identity now yields one row per plugin while preserving source/provider information.
- `RC1-UI-003`: optional Computer Use absence is labelled unavailable and explicitly says Core is unaffected.
- `RC1-UI-004`: construction evidence records real pointer click, expansion, visible panel, and subsequent interaction feedback.
- `FQ-SUPERVISOR-001`: a newly spawned live companion now outranks the previous run's stale PID file during the publish hand-off; a regression test reproduces the original race.

## Evidence boundaries

- Real Windows reboot: `NOT_RUN`; automatic post-boot qualification resumption is unverified, not an established host-policy prohibition.
- Real 24-hour wall-clock soak: `NOT_RUN`.
- Synthetic soak remains labelled synthetic.
- Automated Electron interaction, real Codex visual inspection, and cleanroom visual inspection are reported as distinct evidence sources.
- No claim of novelty, state of the art, universal production suitability, or accessibility certification is made.

See [`FINAL_EVIDENCE_INDEX.md`](FINAL_EVIDENCE_INDEX.md) and [`docs/paper-material/PAPER_MATERIAL_INDEX.md`](../../docs/paper-material/PAPER_MATERIAL_INDEX.md).
