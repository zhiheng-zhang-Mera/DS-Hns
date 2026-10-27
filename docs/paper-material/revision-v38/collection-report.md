# Formal public-source archive: completed collection

Collected 240 selected runs across eight workflow families and six projects under collection-protocol.md: 80 development and 160 evaluation, exactly 15 success and 15 failure per family. No selection deficit. Archived 1,093 completed bounded read-only API responses. The sequential collector was interrupted once to enable concurrent evidence fetching; at most one outstanding request may have reached GitHub without a persisted response, so the conservative total call bound is 1,094, below the 1,500 cap. No source commands or third-party workflows executed; no commits or pushes performed.

| Repository | Workflow | Runs | Complete zero-job archives | Incomplete jobs API |
|---|---|---:|---:|---:|
| pytest-dev/pytest | test.yml | 30 | 10 | 0 |
| fastify/fastify | ci.yml | 30 | 8 | 0 |
| fastify/fastify | integration.yml | 30 | 15 | 0 |
| pallets/flask | tests.yaml | 30 | 0 | 0 |
| nodejs/undici | ci.yml | 30 | 1 | 1 |
| nodejs/undici | nodejs.yml | 30 | 0 | 0 |
| psf/requests | run-tests.yml | 30 | 0 | 0 |
| encode/httpx | test-suite.yml | 30 | 0 | 0 |

All 34 complete zero-job records are retained failures; the archive does not establish why GitHub returned zero jobs. Undici success run 39960286505 attempt 1 returned a JSON Server Error for jobs page 1. It remains selected with incomplete evidence, rather than being replaced. Other 239 selected attempts reached their API total_count. The collector retains each selected run attempt separately from subsequently retrieved detail metadata.

All 240 root execution identities remain UNKNOWN. Immutable head source snapshots and referenced-workflow candidate execution snapshots, pinned reusables and commit-parent consistency witnesses are available, but REST metadata alone did not independently establish a root workflow_sha. Historical full event payloads are also UNKNOWN. These limitations preclude treating this archive as 240 source-closed whole-workflow contracts or using run success as proof of job applicability. Source-snapshot contract experiments must explicitly state this weaker scope; absent identity/context cannot be filled from surviving job outcomes.

The archive includes raw API JSON, hashes/URLs/timestamps in manifest.json, decoded YAML hashes, selection.json, preflight-exclusions.json, records.json, summary.json and offline verification.json under artifacts/paper-revision/ecq-v38/source. Formal runs exclude all run IDs in the preflight cache, including uninspected run-list entries. Selection spans 2026-01-30 through 2026-10-26; source and temporal drift are material. Logical revision grouping is exported alongside workflow/run grouping; related families in one repository must not be counted as independent projects.

Offline verification passed: all 1,093 manifest response hashes and decoded source hashes checked, all selected records match frozen order/split and exclusions, job IDs are unique within attempts, and each collected job binds to the selected run and attempt. Six repository/head revisions occur in both development and evaluation (five Fastify, one Requests), despite disjoint workflow/run groups. Preserve the frozen split and report this dependence; it prevents claiming complete commit-level holdout. Future transformations must stay with their original run, and any uncertainty or sensitivity analysis should additionally cluster the exported logical revision and project groups.

The final verification was strengthened with independent raw-to-derived binding checks before freeze. First, four temporary-fixture tamper tests failed against the old verifier: changing a job name, detail event, selected run event, or source path still passed its hash/binding checks. The revised standalone verifier imports no collector code and reconstructs exact-attempt job pages from manifest endpoints, comparing complete ordered job values, total_count, completeness, page count and error stopping; it compares detail values and both selection/record run values to archived raw run lists. Every decoded YAML file must byte-equal base64 content in its exact repository/path/ref raw response, beyond matching its derived digest. Repeated conflicting endpoint responses fail closed. Eight isolated-fixture tests now pass, including altered pagination/completeness and simultaneous YAML-content/digest tampering. Running the strengthened verifier over the original 1,093 responses and 240 records passes with zero errors; original archive data was neither refetched nor replaced. Root execution identities remain UNKNOWN. This is internal archive consistency verification, not external authenticity certification.
