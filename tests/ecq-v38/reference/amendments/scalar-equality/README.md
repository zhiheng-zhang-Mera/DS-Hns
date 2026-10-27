# Final declared scalar-equality boundary

The pre-amendment source/hash and red control are retained. Structured object
identity and alias semantics were outside the jointly verified scalar fragment,
but the reference could previously establish object-self equality from Python
identity. Equality now rejects dict/list/other non-scalar operands as UNKNOWN
before any identity or value comparison. Null remains a supported scalar.

Object traversal and known object truthiness are unchanged; an explicit extracted
string property remains comparable. Tests cover object self/distinct objects,
array self/distinct arrays, mixed structured/scalar operands, arbitrary objects,
null, strings and nested string-property lookup. Twenty-five tests pass.

This is a final retrospective domain restriction, not a new expression feature
or a replacement blind evaluation. Original evaluations remain preserved.
