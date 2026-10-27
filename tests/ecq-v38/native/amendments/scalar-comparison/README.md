# Retrospective scalar comparison boundary

Pre-change source/hash inventory and the red structure-self-identity control are
preserved here. Initial evaluation artifacts and earlier amendment records are
unchanged.

Whole object, array and function comparison operands now yield UNKNOWN before
identity checks. Their provider/YAML alias reference identity is outside the joint
scalar profile. Null, scalar string comparison, object truthiness and traversal to
supported scalar properties retain their previous behavior. This is a narrowing
of unsupported comparisons, with no new predicates or language features.

The full native post-change suite passed 57 tests; output and source hashes are
saved alongside this note.
