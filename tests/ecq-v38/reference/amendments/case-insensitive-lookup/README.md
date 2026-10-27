# Post-evaluation retrospective correction

The pre-amendment source snapshot/hash and first failing regression are retained.
This is an openly versioned repair after the original held-out pass, not a blind
first-pass result. Official GitHub expression Dictionary.get lowercases property
keys, while the Python reference previously used exact dictionary spelling.
With a known-complete event object this could incorrectly establish a false
guard and authorize an empty archive. The regression reproduced that failure.

The revised bounded semantics resolves own ASCII property keys independently of
casing, including top contexts, matrix, inputs and generated needs. Multiple own
keys that collide under ASCII lowercase produce UNKNOWN even for exact spelling.
Missing top-level contexts remain UNKNOWN regardless of completeness flags.
Non-ASCII dictionary keys are outside this bounded resolver and remain UNKNOWN.

Nonidentical string equality involving non-ASCII strings, and Unicode string
numeric coercion, remain UNKNOWN. Identical Unicode strings remain equal.
Unary minus preserves UNKNOWN and refuses Unicode numeric coercion. Additional
independent red tests exposed Python float's acceptance of numeric underscores;
numeric string conversion now uses an explicit ASCII grammar rather than that
broader Python conversion. Object/array matrix values retain all slots but have
no invented implicit names and an explicit unsupported-source obligation.

The official lexer matches lowercase true/false/null keywords exactly. Uppercase
forms are conservatively unresolved names; no keyword grammar was broadened.

Primary sources independently inspected:
https://raw.githubusercontent.com/actions/languageservices/main/expressions/src/data/dictionary.ts
https://raw.githubusercontent.com/actions/languageservices/main/expressions/src/lexer.ts

Eighteen reference test methods pass after the repair. This does not replace the
original evaluation record or prove correctness beyond the stated bounded rules.
