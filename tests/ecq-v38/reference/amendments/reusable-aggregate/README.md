# Reusable aggregate result correction from owned platform evidence

Owned GitHub Actions run 40508078051 at workflow revision 55bfd87 measured a
parent-enabled reusable call with all child jobs skipped as needs.result skipped;
one successful child plus one skipped child produced success. Default dependent
jobs correspondingly skipped or succeeded. The raw reusable-results.json is
copied here with its SHA-256; original evidence remains at
D:/temp/ecq-v38-reuse-result-40508078051/reusable-results.json.

The reference previously reduced both child-result sets to success. The retained
red test reproduces incorrect blocking of an all-skipped call's absent downstream
job. A single aggregate branch now returns skipped for a nonempty all-skipped
child set; mixed successful/skipped children still yield success. Existing
failure, cancellation, UNKNOWN and empty-child behavior are unchanged.

The new test also rejects contradictory downstream success after an all-skipped
call, requires downstream coverage after mixed success/skipped, and accepts the
complete mixed case. Twenty-six test methods pass. Frozen 45-control gold and
all original evaluation records are unchanged. This correction is retrospective,
with pre-source/hash, red/green outputs and final source hash preserved here.
