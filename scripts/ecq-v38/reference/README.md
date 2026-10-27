# Independent Python reference

Run with the isolated environment (Python 3.14.3 on this machine):

```
D:/temp/ecq-v38-python/Scripts/python.exe scripts/ecq-v38/reference/reference.py envelope.json
D:/temp/ecq-v38-python/Scripts/python.exe -m unittest discover -s tests/ecq-v38/reference -v
```

`requirements.txt` pins ruamel.yaml 0.18.16. Its safe loader explicitly uses YAML
1.2 and rejects duplicate keys. No native compiler module or checking predicate
is imported. Interface field names were coordinated with the native author.

The compiler independently reads YAML and enumerates static Cartesian matrices,
exclude filters and ordered include augmentation. Includes compare original
axis values; augmentation metadata does not change implicit display suffixes.
It rejects cyclic or missing needs dependencies. Expressions support literals,
dotted/bracketed paths, parentheses, unary !/minus, ==/!=, operand-returning
&&/||, and zero-argument status functions. Equality includes case folding and
numeric coercion (including hexadecimal numeric strings). Missing partial event
properties are unknown; missing complete matrix properties are null. Ancestor
failure traverses the full DAG. Tolerated raw failure still requires observation,
but contributes success to the dependent needs result.
`continueOnError` retains the source policy expression in the certificate, as
`guard` does. Qualification evaluates that policy independently with current
context and the fixed matrix row. `gate` combines uniquely bound local raw
outcomes with strong Kleene conjunction: a known rejection dominates unknowns.
It is independent of source/run metadata closure, so OPEN/SAT and OPEN/UNSAT
are meaningful outcomes. Authorization requires CLOSED/SAT.

`freeze_inventory` is a capture-time operation, never an erasure-time operation.
Qualification requires `captureInventory` and independently supplied verified
workflow/run identities. Inventory names and source-generated alternatives fix
candidate bindings. Fact deletion cannot remove expected slots, remove surplus
inventory obligations, or resolve ambiguous candidates. Unknown cancellation is
independent of job conclusions. Source completeness checking re-enumerates the
whole YAML-derived contract and checks names, needs, matrix rows, tolerance and
source-path/hash witnesses; deleting a producer witness cannot hide its slot.
An explicitly false, null or unknown `captureComplete` blocks closure, including
all-inactive workflows. Omitting this optional field asserts complete capture
under the controlled-input interface; real archive adapters must supply the
actual pagination-completeness value.

Pinned reusable definitions use a map from the exact `uses` value to
`{workflow,workflowIdentity:{repository,path,commit,verified:true}}`. Remote refs
require an exact 40-hex commit and matching repository/path. Local refs require
the caller repository and execution commit. A root whose execution identity is
unverified still has its callee universe enumerated, but cannot authorize.
Depth is bounded to three.
The reference recursively enumerates every callee group and leaf, resolves typed
workflow_call inputs/defaults, preserves needs aliases, derives caller/callee
display names separately, and propagates parent applicability. Missing or invalid
definitions remain explicit unsupported obligations. Matrices are bounded to 256
Cartesian cells before allocation. The source checker validates identities,
hierarchy, leaf source hashes and caller witness bindings independently.

Limitations are substantive. This implementation does not expand dynamic
matrices, functions with arguments, expression interpolation
inside matrix values, or step execution. These features cannot close applicable
qualification. It conservatively retains a synthetic unknown slot for unsupported
dynamic matrices. It does not validate artifact digests/reference relationships,
producer signatures, or collection authenticity. The verified identity flag is
a supplied trust assertion. Unsupported scalar objects and malformed schema
inputs can raise an error rather than return an authorization decision.
`UNKNOWN && false` retains unknown scalar value; unlike a richer abstract domain
this can block a guard whose truthiness is already false. Skipped pre-matrix
placeholders require a unique source group, skipped conclusion, matching name,
type/status and fixed run identity. Erased placeholder facts block closure.
The source checker normalizes the native contract to a semantic projection.
`sourceRange` offsets and unsupported diagnostic wording are non-authoritative
convenience fields, deliberately excluded from certificate validity. Operational
placeholder names, complete sourceWitnesses, source identities, deepest leaf
identity and outer-to-inner callerChain are authoritative and checked.

Sixteen test methods include 64 exhaustive fact erasure subsets, ambiguity and
surplus-deletion counterexamples, missing predecessor/tolerance, YAML 1.2 matrix
enumeration, DAG cycles, unknown guards and zero-active scope, scalar controls
corroborated by the owned Actions platform probe, and source certificate attacks
on omitted instances/groups, forged names/paths and tolerance policy. These are
bounded control results, not an evaluation on a frozen real-workflow cohort.
Additional reusable controls cover pinned remote matrices and typed inputs,
two-level local source closure, missing callee records, pin mismatch, native
certificate checking and forged identity/caller metadata. The owned platform
probe corroborates scalar and placeholder rules; it does not yet establish all
nested reusable aggregate-outcome edge cases.


