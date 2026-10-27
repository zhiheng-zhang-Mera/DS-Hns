# Retrospective reusable aggregate correction

The pre-change code bytes, SHA-256 inventory and failing mixed-child control are
retained here. Initial evaluation artifacts and frozen control labels are unchanged.

Owned GitHub Actions run 40508078051 at commit 55bfd87 measured an active reusable
caller with all skipped children as skipped, and one successful plus one skipped
child as success. Raw observed results are preserved separately at
D:/temp/ecq-v38-reuse-result-40508078051/reusable-results.json.

The native reusable-wrapper result now follows these observed cases after its
existing UNKNOWN/failure/cancellation checks: a successful child establishes success
among otherwise skipped children; all skipped children retain skipped. The change
is limited to wrappers with children. Ordinary job/matrix reduction is unchanged.
Unknown child facts or applicability still yield UNKNOWN, and existing failure and
cancellation behavior remains covered by controls.

The regression also checks that mixed success/skipped activates a downstream
default-needs job and blocks authorization when that active job's evidence is absent.
Full post-change native verification: 60 tests passed; output and hashes are saved
alongside this note.
