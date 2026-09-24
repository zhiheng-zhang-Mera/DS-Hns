# Paper material index

- History: `01-COMMIT-TIMELINE.md`, `02-ARCHITECTURE-EVOLUTION.md`
- Claims: `03-CONTRIBUTION-CLAIMS.md`, `04-CLAIM-EVIDENCE-MATRIX.md`
- Experiments: `05-EXPERIMENT-CATALOG.md`, `08-METRICS-CATALOG.md`, `17-EVALUATION-MATERIAL.md`
- Failures/validity: `06-NEGATIVE-RESULTS.md`, `07-ABLATION-CANDIDATES.md`, `09-THREATS-TO-VALIDITY.md`, `18-LIMITATIONS-MATERIAL.md`
- Reproduction/provenance: `10-REPRODUCTION-PROTOCOL.md`, `20-DATA-PROVENANCE.md`
- Paper construction: `11-FIGURE-PLAN.md` through `16-METHODS-MATERIAL.md`, plus `19-RELATED-WORK-SEARCH-TERMS.md`
- Machine-readable: `data/commit-lineage.json`, `claims.json`, `experiments.json`, `metrics.json`, `negative-results.json`, `artifact-index.json`

Current inventory: 7 claim rows (6 bounded engineering claims, 1 explicitly unsupported comparator claim), 13 experiment rows including a retained failed UI experiment, two `NOT_RUN` and one pending final cleanroom record, and 41 negative-result rows. Counts describe catalog entries, not statistical samples. Null experiment fields mean unrecorded or unexecuted; consult the hash-bound historical run before using a value as a measurement. A passing child from an overall failed run is not final qualification. Fresh17 follow-up repairs extend engineering lineage, not the research-claim count; see `artifacts/qualification/FRESH17_VISUAL_FOLLOWUP.md` at repository root.

Run `node scripts/validate-paper-material.cjs` from the repository root to check claim identity alignment, actual source/test paths, and bound historical SHA/run/verdict/count/hash consistency. The same validation is included in the full unit suite and CI.
