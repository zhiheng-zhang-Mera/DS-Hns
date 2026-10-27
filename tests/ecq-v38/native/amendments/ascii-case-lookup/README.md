# Post-evaluation ASCII lookup/profile amendment

This is an explicitly retrospective correction, not blinded evaluation evidence.
The pre-change native source bytes, SHA-256 inventory and four failing controls
are preserved here. Earlier frozen and initial evaluation records are unchanged.

The official actions/languageservices Dictionary.get implementation lowercases
context keys. Reading its Dictionary source exposed a native case-sensitive-key
bug: a complete-context guard github.EVENT_NAME == 'push' could be established
false and discharge an active absent job. The new resolver uses ASCII case folding
over own properties, rejects collisions as UNKNOWN, and never completes a missing
top-level context to null. Prototype properties remain inaccessible. Matrix root
completeness and needs partiality are compared case-insensitively.

The same amendment explicitly bounds non-ASCII comparisons instead of claiming
JavaScript lowercasing matches every runner Unicode case rule: identical Unicode
strings remain equal; nonidentical comparisons/searches involving Unicode and
cross-type numeric comparisons involving Unicode remain UNKNOWN. Structured
implicit matrix display values remain unresolved, without synthetic object names.

Primary sources inspected during this amendment:

- https://raw.githubusercontent.com/actions/languageservices/main/expressions/src/data/dictionary.ts
- https://raw.githubusercontent.com/actions/languageservices/main/expressions/src/lexer.ts

The inspected TypeScript lexer uses exact lowercase literal keyword spellings.
No speculative uppercase-literal support or arbitrary functions were added.

Post-change full native test output: 43 passed in post-verification.txt.
