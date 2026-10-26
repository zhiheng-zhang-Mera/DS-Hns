# Independent methods/code/evidence review — 2026-10-26

One separate read-only fresh-context reviewer inspected the frozen drivers, protocols, current manuscript and assessment. No experiments were rerun by the reviewer; this is not independent experimental replication.

Critical: none. Judgment: evidence supports the narrow component conclusions.

Important findings resolved:

1. Reproduction commands now explicitly create isolated checkouts at 85facfa for V1 and ec1c516 for V2. Latest-worker initialization cannot silently be substituted for the earlier treatment.
2. Manuscript, assessment, artifact READMEs and METRIC_ERRATUM.md identify legacy latency as launch-to-terminal-exit, including failed V1 resumes. The legacy causal-permission boolean is explicitly overridden in interpretation. Frozen code, JSON values and raw bytes are preserved.

Reviewer evidence checks: all 1967 V1 and 575 V2 inner file hashes and both ZIP digests; outer/enclosed ledger equality; independent reconstruction of 480 A4 outcomes from effects/specs and 270 A3 decisions from event schedules; six V1 nonzero resume exits, zero V2 nonzero exits and no timeout; no app-source diff from candidate. Counts and behavioral interpretations agree with the published analysis.

Deferred minor validation hardening: enforce exact scheduled scenario/seed/arm membership rather than count+uniqueness alone, and actively verify module identity at runner startup rather than only recording the candidate. Current archives were explicitly checked for intended grid membership and unchanged app files, so this does not invalidate their evidence. Future runner revisions must address the gap before broader campaigns. Two minor editorial wording suggestions were corrected for precision.

Declined to judge: ECQ effectiveness/novelty, full-product reliability, general exactly-once, arbitrary/power-loss/reboot behavior, general statistical reliability/equivalence, venue competitiveness/top-30%, independent replication, remote push chronology and final PDF/package quality. Executor rulings: these remain unproven and out of the admitted claims; push, package and visual checks are separately verified by the executing agent. Costs of overinterpretation are stated in the manuscript and assessment.
