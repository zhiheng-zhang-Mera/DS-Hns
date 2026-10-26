# V2 equal-initialization gap protocol — before v2 measurement

V1 remains fully retained (630 arm observations), with six adapter resume errors at gap seeds 14, 15, 30. These interrupt the FIRST effect before any step checkpoint. LangGraph automatically stores initial state, while our two file adapters omitted it. Thus V1 gap completion is 27/30 for each file adapter versus 30/30 for LangGraph; this is not a valid completion-superiority claim because initialization differs. Exactly-once remains 0/30 in every arm, including failures. No V1 row or unfavorable result is removed.

Root cause was traced to createCheckpointStore.latest returning null and simple-cursor ENOENT, versus LangGraph's checkpoint at next=0. This is an adapter initialization defect, not a new product source defect. A regression with seed 14 first failed before the change; v2 initializes a step-zero progress record for BOTH file persistence arms before any effect, matching LangGraph's behavior. Mechanism-off replay still stores no progress.

V2 reruns the ENTIRE gap stratum with seeds 1–30 and ALL four arms in the same forward/reverse order, workload, terminal oracle and timeout contract. No selective rerun of only failed seeds. A3 and other A4 strata are not rerun; their unchanged v1 results retain v1 identities. V2 is reported separately, never pooled into a single SHA/campaign denominator or substituted for v1. All comparisons of completion in this gap stratum use v2; v1 defect remains disclosed.

The v2 worker/runner/analysis revision is committed and pushed BEFORE v2 measurements. Command: node scripts/paper-revision/safe-experiments.cjs gap-v2 <python> <new-directory>. Expected 120 arm observations, 30 paired seed blocks, real owned-child termination, no new ECQ observations. Safe-v1 reconstruction/rerun must use the original 85facfa driver; the current adapter now implements initialization v2.

All other v1 safety, error retention, raw archiving and conditional-statistics requirements remain unchanged. V2 is a post-v1 exploratory follow-up, not a prospectively untouched confirmatory sample.
