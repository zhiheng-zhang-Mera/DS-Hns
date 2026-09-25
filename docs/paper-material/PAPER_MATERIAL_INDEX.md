# Paper material index

- History: `01-COMMIT-TIMELINE.md`, `02-ARCHITECTURE-EVOLUTION.md`
- Claims: `03-CONTRIBUTION-CLAIMS.md`, `04-CLAIM-EVIDENCE-MATRIX.md`
- Experiments: `05-EXPERIMENT-CATALOG.md`, `08-METRICS-CATALOG.md`, `17-EVALUATION-MATERIAL.md`
- Failures/validity: `06-NEGATIVE-RESULTS.md`, `07-ABLATION-CANDIDATES.md`, `09-THREATS-TO-VALIDITY.md`, `18-LIMITATIONS-MATERIAL.md`
- Reproduction/provenance: `10-REPRODUCTION-PROTOCOL.md`, `20-DATA-PROVENANCE.md`
- Paper construction: `11-FIGURE-PLAN.md` through `16-METHODS-MATERIAL.md`, plus `19-RELATED-WORK-SEARCH-TERMS.md`
- Machine-readable: `data/commit-lineage.json`, `claims.json`, `experiments.json`, `metrics.json`, `negative-results.json`, `artifact-index.json`

Current inventory: 7 claim rows (6 bounded engineering claims, 1 explicitly unsupported comparator claim), 19 experiment/acceptance rows, 11 metrics, and 45 negative-result rows. It retains a historical failed UI experiment, current enhanced-qualification `NOT_RUN` records (real reboot and real 24-hour wall-clock soak), the passing exact RC machine qualification, and a partial direct visual journey as distinct evidence states. Counts describe catalog entries, not independent samples or research contributions. Null experiment fields mean unrecorded or unexecuted; consult the hash-bound evidence before using a value as a measurement. A passing child from an overall failed historical run is not final qualification. Fresh17 follow-up repairs extend engineering lineage, not the research-claim count; see `artifacts/qualification/FRESH17_VISUAL_FOLLOWUP.md` at repository root.

The historical production baseline remains candidate `63eabc9a9341abd2e612bf603e3ce340eaa2cc57` (tree `8e6884e6b25bb3989509bd9d623dca4c0abb2bf1`), merged as `5dcde767020161f6f6c7a5fc3330bccaca1d14a3`, and tagged `hns-production-v1`. It is not the current RC candidate. The 2026-09-25 RC2 candidate is `4ef9c0df149a6cecf1eaa17e50cee4b22271b810` / tree `816f513c98e40831f0e81f8567e72e6fd01adcd4`; it passed machine qualification but remains unmerged/untagged and overall finalization is `HNS_FINALIZATION_BLOCKED` due the documented C-drive controlled-profile incident and open P2. See `01-COMMIT-TIMELINE.md`, `data/commit-lineage.json`, and `artifacts/qualification/FINAL_HNS_QUALIFICATION_REPORT.md`. This corpus refresh does not move the production tag.

Run `node scripts/validate-paper-material.cjs` from the repository root to check claim identity alignment, actual source/test paths, and bound historical SHA/run/verdict/count/hash consistency. The same validation is included in the full unit suite and CI.
