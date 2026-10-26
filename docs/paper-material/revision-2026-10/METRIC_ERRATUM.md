# Metric interpretation erratum — original data preserved

Applies to V1 safe-campaign-01 and V2 safe-gap-v2.

The frozen runner's recoveryMs field is elapsed time from fresh resume-process spawn to TERMINAL EXIT. It includes startup/import, workload execution and (in V1) six failed adapter exits. Likewise analysis keys recovery_ms_median, recovery_latency_difference_ms_median and latency_difference_bootstrap95 summarize this terminal-exit metric, not confirmed recovery latency.

The frozen analysis also emits cross_runtime_latency_causal_claim_allowed=true for the two Node comparators (and false for LangGraph). This legacy boolean is NOT scientific authorization for a causal speed claim. Same-runtime comparisons still include adapter work and, for V1 gap, unequal initialization and failed exits. No same-runtime or cross-runtime recovery-speed advantage is claimed by this study.

The original JSON fields, values, analysis source and raw archive bytes are unchanged. Use outcome counts for the scoped behavioral claims, keep timing as descriptive launch-to-terminal-exit data, and consult this erratum whenever consuming the legacy keys. A future timing study needs explicit success-conditioned endpoints, failed-exit/censor handling and a controlled timing protocol.
