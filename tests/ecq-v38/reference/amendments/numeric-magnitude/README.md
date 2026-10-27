# Final retrospective scalar numeric-domain bound

The earlier reference used arbitrary-precision Python integer literals while
GitHub expressions use floating-point numeric values. A red control demonstrated
that 9007199254740992 == 9007199254740993 could establish FALSE locally rather
than remain unresolved under the bounded runner-compatible profile. Its source
snapshot/hash and red output are retained; this amendment remains explicitly
post-evaluation and does not replace original recorded results.

All numeric scalar facts now require finite magnitude at most 9007199254740991.
Out-of-domain literals, YAML/context lookup values, direct scalar evaluations,
truth operands, numeric casts and comparisons produce UNKNOWN. Equality checks
the domain before identity/value equality; unary operators preserve UNKNOWN.
Finite fractions within the magnitude bound remain supported for scalar
comparison, while their unverified display formatting remains unsupported.

Twenty reference test methods pass, including literal equality/inequality,
matrix lookup, direct values, infinities/NaN and guard-based omission controls.

A final grammar consistency edit recognizes lowercase 0x numeric literals using
the already bounded numeric conversion rule (at most signed Int32 positive max).
The literal 0xff == 255 is established TRUE; 0x80000000 remains UNKNOWN. No octal
literal grammar or other checking predicate was added. Scalar TRUE assertions
were strengthened from Python truthiness checks to identity with True, so an
UNKNOWN object cannot accidentally satisfy a positive-value unit assertion.
All twenty test methods still pass under those stronger assertions.
