# Final retrospective numeric magnitude bound

Pre-change source bytes, hashes and the failing large-integer identity control are
retained here. This is a post-evaluation conservative domain refinement; initial
evaluation artifacts and prior amendment records are unchanged.

All supported numeric scalar values now require finiteness and absolute magnitude
at most 2^53-1. This applies before strict equality identity, and to numeric literal
parsing, context/matrix values, string coercions, unary minus and truth operands.
Thus IEEE rounding of distinct out-of-profile integers cannot establish equality
or a false comparison that discharges a job guard. In-domain fractions remain
available for scalar comparison, but not for unverified numeric rendering.

The full post-change native unit run passed 47 tests; output and code SHA-256
inventory are recorded alongside this note.
