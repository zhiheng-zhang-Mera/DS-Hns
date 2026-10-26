# Safe gap V2 — equal initialization, separate follow-up

This 120-arm follow-up uses 30 seeds × four arms for the ENTIRE gap stratum. Driver/protocol ec1c5169d25dfc0c7b6d4313b1202db5c6143d80 was committed and pushed before v2 measurement. It initializes progress=0 for both file persistence adapters, matching LangGraph's automatic initial checkpoint. No product app source is changed.

V1 artifacts/paper-revision/safe-campaign-01 remains unchanged in its scientific observations: six adapter resume errors at first-effect seeds 14, 15, 30 are retained. V2 is post-v1 exploratory work; no denominator is pooled across revisions, no unfavorable attempt is silently replaced, and only rerunning those three seeds was deliberately avoided.

Read RESULTS.md and analysis.json for complete and duplicate-free outcomes, including the retained effect/checkpoint-gap replay. raw-evidence.zip contains ALL actual task/attempt/effect/checkpoint/database files and a per-file RAW_CHECKSUMS.sha256. Outer CHECKSUMS.sha256 and RECEIPT.json bind the archive. No external library code or credentials are included.

Reanalysis (standard Python only):

~~~
python scripts/paper-revision/analyze_safe.py D:/extracted-v2
~~~

New measurements, with Node 24.14.0, Python 3.14.3 and the locked external dependency environment:

~~~
git clone https://github.com/zhiheng-zhang-Mera/DS-Hns.git D:/paper-v2-source
git -C D:/paper-v2-source checkout --detach ec1c5169d25dfc0c7b6d4313b1202db5c6143d80
cd D:/paper-v2-source
node scripts/paper-revision/safe-experiments.cjs gap-v2 D:/env/Scripts/python.exe D:/new-v2-output
~~~

Legacy recoveryMs/latency fields mean process launch-to-terminal-exit. Although V2 resume exits are successful, these values include startup/import and workload completion; they do not isolate recovery efficiency and no same-runtime or cross-runtime recovery-speed advantage is claimed.

Use a fresh D-drive directory, not an existing result directory. The full protocol and requirements are in docs/paper-material/revision-2026-10/. Workload, arm ordering, local-only resource bounds and independent oracle are the same as V1, except the explicit initialization change. CPU/import launch timings remain descriptive; no cross-runtime speed or full-product reliability claim. See the v1 README for raw field descriptions and scope limits.

Metric-field erratum: see docs/paper-material/revision-2026-10/METRIC_ERRATUM.md. The legacy cross_runtime_latency_causal_claim_allowed flag is not permission for a same-runtime causal speed claim; all latency fields are descriptive launch-to-terminal-exit. Frozen source/data remain unchanged.
