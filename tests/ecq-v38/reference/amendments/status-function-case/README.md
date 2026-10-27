# Retrospective status-function case consistency correction

The pre-amendment source/hash and reproduced false authorization are retained.
With a skipped predecessor, uppercase CANCELLED() was not recognized as an
explicit status function. An implicit success guard could therefore establish
FALSE and waive a required missing cleanup job, even when the frozen canonical
cancellation fact was true. This was a supported-fragment implementation error.

Dispatch and quoted-string-stripped status-presence detection now recognize the
same four status names without ASCII case sensitivity. Unknown functions and
nonzero-argument status calls remain UNKNOWN; no function family was added.
Tests cover the actual missing-cleanup counterexample, uppercase !SUCCESS()
after a skipped predecessor, uppercase ALWAYS(), each known function directly,
and rejection of nonzero arguments. Twenty-four test methods pass.

This repair is explicitly retrospective. Existing lowercase public-source cases
and original held-out records remain preserved, and are not renamed blind runs.
