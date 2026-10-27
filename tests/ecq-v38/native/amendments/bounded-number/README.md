# Post-evaluation bounded numeric profile amendment

This is a retrospective conservative profile amendment. Pre-change source bytes,
SHA-256 inventory and failing controls are retained here; original evaluation
artifacts are not overwritten.

Primary source inspected:
https://raw.githubusercontent.com/actions/runner/main/src/Sdk/DTExpressions2/Expressions2/Sdk/ExpressionUtility.cs

Runner numeric conversion and the JavaScript SDK Number-based implementation do
not have identical edge-format behavior. This implementation now supports only a
bounded reliable intersection: empty/ASCII whitespace, finite ASCII decimal
grammar, and unsigned lowercase 0x/0o values no larger than 2147483647. Boolean/null
and finite numeric values remain supported. Other string casts and out-of-profile
numeric literals yield UNKNOWN, propagated through equality and unary minus.

Rendering numeric values uses only safe integers other than negative zero. Default
matrix suffixes outside strings, Booleans and those stable integers retain unknown
names and unresolved source obligations. Explicit supported scalar-string property
names remain available. This avoids claiming JavaScript/Python numeric formatting
is the complete runner display policy.

The initial red controls observed unsupported binary comparison becoming true and
noninteger rendering becoming a known string. Post-change full native unit output
is retained separately in post-verification.txt.
