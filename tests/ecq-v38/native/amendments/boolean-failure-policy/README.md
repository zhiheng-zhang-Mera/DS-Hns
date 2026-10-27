# Retrospective typed Boolean failure-policy consistency

Pre-change source/hash inventory and failing controls are preserved here; original
evaluation artifacts and earlier amendment records remain unchanged.

Failure tolerance previously applied general expression truthiness to evaluated
continue-on-error values. This could authorize an observed failure under numeric
one or a nonempty string despite the declared Boolean policy profile. The single
evaluator change accepts only actual Boolean policy values; all other values yield
UNKNOWN and cannot authorize failure. Job applicability truthiness is unchanged.

Post-change full native verification: 56 tests passed, with output and source
SHA-256 inventory saved alongside this note.

The first post-edit run was 55/56: a tentative quoted YAML false control was
parsed as the existing Boolean expression false, so its expected UNKNOWN was
incorrect for that fixture. The final control uses the explicit expression
`${{ 'false' }}`, which unambiguously evaluates to a string; the null control
likewise uses `${{ null }}`. This test-fixture refinement made no additional
core change. The original confirmed red case was `${{ 'yes' }}` authorizing failure.
