# Retrospective fixed-frame type validation

The pre-amendment source/hash and failing scope control are retained. Previously
an unrecognized or null claimScope silently selected workflow-conformity, and a
string eventContextComplete flag could be treated as true by Python truthiness.
This repair validates the fixed interpretation frame before evaluating evidence.

The scope may be absent (workflow-conformity default), workflow-conformity or
test-execution exactly. eventContextComplete, if present, must be Boolean.
captureComplete and workflowCancelled accept only Boolean or the explicit
UNKNOWN sentinel; strings and null are rejected. The checks apply to envelope
flags and captured context flags, without adding a GitHub event-schema validator
or new expression features. Invalid frames return OPEN/UNKNOWN/unauthorized.
Legitimate UNKNOWN remains available for missing observations and blocks only
the relevant obligations, with capture completeness always required for closure.

Twenty-two test methods pass. Original held-out evaluations and all earlier
amendment snapshots remain preserved separately.
