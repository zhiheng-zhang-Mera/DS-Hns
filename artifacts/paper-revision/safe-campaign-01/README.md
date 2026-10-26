# Safe A3/A4 campaign — 2026-10-26

**V1 initialization limitation:** gap seeds 14, 15 and 30 interrupt after the FIRST effect. The file-checkpoint and simple-cursor adapters have no initial progress record, whereas LangGraph automatically checkpoints initial state. Consequently each file adapter completes only 27/30 gap tasks and has three nonzero resume exits. These are retained adverse adapter outcomes (six exits), not excluded or replaced. The ledger's zero infrastructure-error flag does not mean zero worker errors. Completion comparisons in this stratum are confounded by initialization. A separately frozen equal-initialization v2 gap campaign reruns ALL 30 seeds and all four arms; it must not overwrite or pool these records.

Read RESULTS.md and analysis.json for outcomes and paired estimates. This is a single-host component study, not full product qualification or ECQ evaluation. Production modules: 6ae4dbc083efff0c4c611ca4e7a1f69823c2ccb6. Protocol/driver/analysis freeze: 85facfad02d995f4327fb99c9f4614612a7c41e5, committed and pushed before the campaign. No product app code was modified.

630 arm observations = 270 virtual-time policy trace arms + 360 process-fixture arms. A4 uses 30 seeds × 3 fault strata × 4 paired arms. These are not 630 independent reliability trials. Pilot seeds 1001/1002 (42 observations) are separate and excluded. Original historical recovery and ECQ denominators are unchanged.

## Inspect and independently reconstruct

raw-evidence.zip contains all episode directories: per-arm input spec, append effects, actual checkpoint JSON/SQLite database, full attempt records, stdout/stderr, first/resumed child PIDs, signals and timeouts. RAW_CHECKSUMS.sha256 covers every enclosed file. pilot-excluded.zip retains the excluded pilot. No credentials, model prompts, user workspace files or external library source are included. Absolute D-drive fixture paths may appear inside authentic checkpoint records; they are source locators, not portable rerun destinations.

Extract the raw archive into a NEW directory. From the DS-Hns repository:

~~~
python scripts/paper-revision/analyze_safe.py D:/paper-replay/campaign
~~~

This Python-standard-library analysis verifies raw record hashes and independently reconstructs fixture outcomes from effects. It retains negative outcomes. It is a reanalysis of the same data, not independent experimental replication. analysis.json includes paired 10,000-resample intervals and descriptive launch-to-completion timings. No cross-runtime speed superiority is claimed.

## Rerun new observations

Use Windows x64, Node 24.14.0 and Python 3.14. Install the exact external package set in docs/paper-material/revision-2026-10/EXTERNAL_REQUIREMENTS.txt into a dedicated environment. Installed package versions, MIT licenses and source-tree digests are in EXTERNAL_BASELINE_IDENTITY.json. The library source is https://github.com/langchain-ai/langgraph and persistence documentation is https://docs.langchain.com/oss/python/langgraph/persistence .

Run V1 from its exact isolated source revision, not the latest working tree:

~~~
git clone https://github.com/zhiheng-zhang-Mera/DS-Hns.git D:/paper-v1-source
git -C D:/paper-v1-source checkout --detach 85facfad02d995f4327fb99c9f4614612a7c41e5
cd D:/paper-v1-source
node --test tests/paper-revision/safe-experiments.test.cjs
node scripts/paper-revision/safe-experiments.cjs campaign D:/paper-env/Scripts/python.exe D:/paper-new-v1-campaign
python scripts/paper-revision/analyze_safe.py D:/paper-new-v1-campaign
~~~

The latest worker implements V2 initialization. Calling its legacy campaign mode would not reproduce V1, even if the mode label says safe-v1. For V2 use a separate checkout at ec1c516 and the gap-v2 command in that artifact's README.

Timing dictionary: the historical recoveryMs, recovery_ms_median and paired latency keys actually measure launch-to-terminal-exit, including the six failed V1 resume exits. They are not confirmed-recovery latency, and no same-runtime or cross-runtime recovery-speed inference is justified from those mixed exits. The original values and names are retained for byte-level provenance.

The target output directory must not already exist. Keep scratch/venv/cache on D when following the experiment storage convention. Run serially with no unrelated workload for comparable timings. Expected runtime on the recorded host is in environment.json (several minutes; budget 30 minutes). No paid model or network task is used. The LangGraph worker denies outgoing socket connections and tracing is disabled. Only owned child handles are terminated; no reboot or existing service is touched.

All arms use the same sequential append task and fault handshake. LangGraph uses synchronous SQLite persistence; the production adapter uses createCheckpointStore and verifyResume with a fixed fixture fingerprint. It does not exercise the complete runtime mutation log, fencing, task scheduler or restart supervisor. An uncommitted effect is deliberately outside the checkpoint transaction in every arm, so the retained single-step replay is an adapter-level boundary, not a demonstrated full-product bug.

A3 cap removal leaves eight finite requests as a hard bound, disables cooldown/backoff/safe-mode in both production arms, and never restarts a process. Its three schedule families are constructive policy tests. A1/A2, ECQ evaluator comparisons, Phase C, resource peaks, second environment, real 24h task and physical reboot remain unrun.

Metric-field erratum: see docs/paper-material/revision-2026-10/METRIC_ERRATUM.md. The legacy cross_runtime_latency_causal_claim_allowed flag is not permission for a same-runtime causal speed claim; all latency fields are descriptive launch-to-terminal-exit. Frozen source/data remain unchanged.
