# Frozen external CI and historical mapping sources

The selection plan was written before collection, with cutoff 2026-10-27 07:09:19 UTC. The collector selected the newest 30 eligible runs per declared workflow/event in descending `(created_at, runId)` order, without outcome balancing. `selection-manifest.json` preserves the complete selected list and actual exclusions; candidate API pages are archived per project.

| Source profile | Actual runs | Development / evaluation | Observed original job outcomes |
|---|---:|---:|---|
| `pytest-dev/pytest`, `doc-check-links.yml`, schedule | 30 | 10 / 20 | 30 failure |
| `fastify/fastify`, `md-lint.yml`, push | 30 | 10 / 20 | 30 success |

The claim is the API-reported outcome of one named documentation workflow. Required jobs come from workflow bytes at the measured commit, with the pytest repository-owner condition evaluated from known repository context. No result deletion changes that independently declared requirement set. Dynamic matrices and reusable workflows are excluded by this profile rather than reconstructed from observed jobs.

For each run, retain the original candidate/run API object, jobs response, pinned workflow content response and bytes, commit/tree object, normalization inputs, normalized output, and field mapping witnesses. The integrity target is the collected API job record: its canonical JSON bytes and digest are frozen by the collector, then reused unchanged across controlled variants. This does not authenticate the underlying test execution, recover expired logs, or imply repository-wide release qualification.

`../external-corpus/manifest.jsonl` contains 360 cases: 60 original runs plus five controlled variants per run. `development.jsonl` is the exact 120-case development subset; `evaluation.jsonl` is the exact 240-case evaluation subset. Variants share a source-run grouping and contract. The labels describing variants exist only in the manifest, never in evaluator-visible bundles.

`dshns/` contains three different retrospective mapping units: R1 compares static suite assertions across a historical repair (32 required, 19 present before the repair), R2 maps an actual whole-run FAIL report through the pinned runner's gate contract, and R3 binds a stored Phase C measurement report to its measured code. They are not 3 independent new runtime trials. Their claim scopes, source identities and limits are recorded in `historical-mappings.json`. R2 keeps its child 52/52, UI 127/130, whole FAIL and existing evidence-consistency PASS.

Read-only recollection command: `python scripts/ecq/collect_ci.py` (requires authenticated GitHub CLI and PyYAML 6.0.3; cached API bytes are reused). Historical construction: `node scripts/ecq/adapters/build-historical.cjs`. Audit tests: `node --test tests/ecq/normalizers.test.cjs` and `python -m unittest discover -s tests/ecq -p test_external_integrity.py`.

The development-only YAML loader correction is recorded in `docs/paper-material/revision-v37/collection-development-notes.json`; it changed no selection rule and occurred before qualification methods received the corpus.
