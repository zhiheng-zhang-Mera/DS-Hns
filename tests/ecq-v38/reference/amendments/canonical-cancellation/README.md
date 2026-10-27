# Retrospective canonical cancellation-field correction

The reference read cancellation from eventContext while the declared interface
uses envelope.workflowCancelled. The preserved red test demonstrates the
valid-frame disagreement when the envelope freezes false and !cancelled() is
active. The correction changes only that lookup to the canonical envelope field;
absence and the explicit UNKNOWN sentinel remain unresolved.

Tests cover both Boolean values with the same captured successful job, unknown
and absent canonical facts, and a conflicting legacy eventContext field. Legacy
context values are not status-function evidence. Twenty-three test methods pass.

The cancellation fact must cover the guard-evaluation context and be fixed in K.
An arbitrary final run conclusion/header or observed job presence is not evidence
for that historical fact. Original public archives continue to supply UNKNOWN
where no suitable immutable cancellation fact was captured. This correction is
versioned after the original evaluation; those results are not overwritten.
