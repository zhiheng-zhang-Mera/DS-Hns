# Retrospective numeric-cast boundary amendment

This amendment follows, and does not replace, the original held-out results and
the earlier case-lookup amendment. Its before-source/hash and failing control are
retained. The prior Python conversion accepted binary and uppercase hexadecimal
strings as JavaScript Number does, but the runner's ExpressionUtility.ParseNumber
uses distinct rules, including signed Int32 handling for large hexadecimal
values. SDK similarity is not evidence of runner equivalence.

The reference now supports only the conservative shared numeric-string subset:
empty/ASCII whitespace, finite ASCII decimal syntax, and unsigned lowercase 0x
or 0o values no larger than 2147483647. All other string numeric casts are UNKNOWN,
including binary, uppercase prefixes, Infinity, overflow, malformed text and
Unicode. Equality and unary minus propagate that uncertainty. Known finite
numeric values, booleans and null retain their ordinary conversions.

Implicit matrix suffixes permit strings, booleans and stable safe-integer numeric
renderings. Null, structured values, negative zero and noninteger/unsafe numeric
renderings retain their slots but have no guessed display names and an explicit
unsupported-source obligation. An explicit name that extracts an object's known
string property remains supported.

Nineteen test methods pass. Primary runner source independently inspected:
https://raw.githubusercontent.com/actions/runner/main/src/Sdk/DTExpressions2/Expressions2/Sdk/ExpressionUtility.cs

This is a documented post-evaluation profile restriction, not a replacement
blind evaluation or a claim to support every GitHub expression numeric form.
