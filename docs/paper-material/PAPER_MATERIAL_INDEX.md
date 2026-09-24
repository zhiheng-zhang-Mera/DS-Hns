# Paper material index

- History: `01-COMMIT-TIMELINE.md`, `02-ARCHITECTURE-EVOLUTION.md`
- Claims: `03-CONTRIBUTION-CLAIMS.md`, `04-CLAIM-EVIDENCE-MATRIX.md`
- Experiments: `05-EXPERIMENT-CATALOG.md`, `08-METRICS-CATALOG.md`, `17-EVALUATION-MATERIAL.md`
- Failures/validity: `06-NEGATIVE-RESULTS.md`, `07-ABLATION-CANDIDATES.md`, `09-THREATS-TO-VALIDITY.md`, `18-LIMITATIONS-MATERIAL.md`
- Reproduction/provenance: `10-REPRODUCTION-PROTOCOL.md`, `20-DATA-PROVENANCE.md`
- Paper construction: `11-FIGURE-PLAN.md` through `16-METHODS-MATERIAL.md`, plus `19-RELATED-WORK-SEARCH-TERMS.md`
- Machine-readable: `data/commit-lineage.json`, `claims.json`, `experiments.json`, `metrics.json`, `negative-results.json`, `artifact-index.json`

Current inventory at the qualified production baseline: 7 claim rows (6 bounded engineering claims, 1 explicitly unsupported comparator claim), 17 experiment rows, 11 metrics, and 43 negative-result rows. The catalog retains a historical failed UI experiment, two current enhanced-qualification `NOT_RUN` rows (real reboot and real 24-hour wall-clock soak), and the passing final-candidate evidence separately. Counts describe catalog entries, not independent samples or research contributions. Null experiment fields mean unrecorded or unexecuted; consult the hash-bound evidence before using a value as a measurement. A passing child from an overall failed historical run is not final qualification. Fresh17 follow-up repairs extend engineering lineage, not the research-claim count; see `artifacts/qualification/FRESH17_VISUAL_FOLLOWUP.md` at repository root.

The production baseline was qualified at candidate `63eabc9a9341abd2e612bf603e3ce340eaa2cc57` (tree `8e6884e6b25bb3989509bd9d623dca4c0abb2bf1`), merged as `5dcde767020161f6f6c7a5fc3330bccaca1d14a3`, and tagged `hns-production-v1`. The release snapshot covers 366 reachable commits. See `01-COMMIT-TIMELINE.md`, `data/commit-lineage.json`, and `artifacts/qualification/FINAL_HNS_QUALIFICATION_REPORT.md`. This report/corpus refresh is documentation-only and does not move the production tag.

Run `node scripts/validate-paper-material.cjs` from the repository root to check claim identity alignment, actual source/test paths, and bound historical SHA/run/verdict/count/hash consistency. The same validation is included in the full unit suite and CI.
