# Native conditional contract evaluator

Run `node scripts/ecq-v38/native/cli.mjs input.json` or import `compile`,
`qualify`, `evaluate` from `index.mjs`. This never executes workflow steps.

Input: `{workflow: "YAML bytes", workflowIdentity: {commit,path}, eventContext:
{github:{event_name:"push"}}, captureInventory:[{id:1,name:"test",runId:9,runAttempt:1,headSha:"abc"}],
sourceJobs:[{id:1,name:"test",type:"job",status:"completed",conclusion:"success",runId:9,runAttempt:1,headSha:"abc"}], runIdentity:{runId:9,runAttempt:1,headSha:"abc"}}`.

`captureInventory` is an independently captured fixed inventory. Erasure may replace
sourceJobs facts with `{"$unknown":true}` or remove fact records, but must never
remove inventory candidates. Inventory names remain fixed. Missing/duplicate IDs,
ambiguous binding, unsupported syntax, unknown applicability and absent identity
block closure. Source identity requires `workflowIdentity.verified === true`;
this is an explicit trust-root assertion supplied by collection, not authentication.
Context objects are partial by default: missing fields are UNKNOWN. Set
`eventContextComplete:true` only for a fully captured context. Matrix rows are complete.
This completeness flag never applies to generated `needs`: ancestor `result` is
computed from captured conclusions and tolerance, while archived job outputs remain
explicitly UNKNOWN. Missing needs fields cannot become known null by this flag.

`captureComplete` can explicitly bind collector pagination completeness: false or
UNKNOWN blocks closure. Omission of this field is permitted only under the controlled
input assumption that captureInventory is independently trusted complete; real
collectors must supply their observed pagination-completeness Boolean.
Captured record IDs must be positive safe integers or nonempty strings; names must
be nonempty strings. Run headers require a valid runId by the same ID rule, a
positive safe-integer runAttempt, and a nonempty headSha string, with matching own
fields on every captured inventory item and payload. Missing/null/Boolean/empty
identities cannot create an anonymous record binding.
`claimScope` is omitted/default workflow-conformity, or exactly workflow-conformity
or test-execution. Other scopes, nulls and misspellings block closure. A present
eventContextComplete must be Boolean; captureComplete and workflowCancelled must
be Boolean or the explicit UNKNOWN marker. Invalid frame types block closure and
do not gain meaning from JavaScript truthiness. These frame assertions are fixed
before observation erasure.

Contract fields: schemaVersion, workflowIdentity, sourceSha256, jobGroups
(`id,needs,guard,instances,unsupported`), instances (`id,groupId,matrix,names,
continueOnError,sourceWitness`), dependencies, sourceWitnesses, unresolvedFeatures.
Witnesses carry source hash and YAML path; the independent checker must reconstruct
the full universe from source, rather than trust these paths or this compiler.
Qualification preserves original conclusions and separates closure, satisfaction,
authorization. This is job-level archive qualification, not proof that every step ran.

Every captured record retains coverage/state/identity obligations, including records
under inactive groups. Inactive groups accept absence or one unexpanded uniquely
attributable skipped placeholder. Extra/unattributed records block closure. Needs
results reduce explicitly tolerated failure to success while retaining raw failure
in outcome witnesses; cancellation is a separate frozen workflowCancelled fact.
`gate` is SAT, UNSAT or UNKNOWN; `closure` is CLOSED or OPEN. Partial operand
expressions conservatively return UNKNOWN when their truth is known but the scalar
operand is not uniquely determined (e.g. UNKNOWN && false). This can block safe
archives but cannot establish a false scalar equality.

Gate outcomes are independent of capture metadata closure checks. A known active
failed job contributes UNSAT unless its failure is explicitly tolerated; unknown
applicability contributes UNKNOWN. A known failure of another active job dominates
UNKNOWN. `satisfied` means gate SAT. Execution non-vacuity is a gate predicate:
at least one established active source leaf makes it true, unknown applicability
with none established makes it UNKNOWN, and zero active leaves makes it false.
Thus a complete all-inactive archive can be CLOSED/UNSAT for test-execution scope.
Authorization requires CLOSED and SAT.
Failure tolerance requires an evaluated Boolean continue-on-error policy; numeric
or string truthiness does not establish explicit permission to accept failure.
Non-Boolean policies remain UNKNOWN. Job-if guards still use expression truthiness.
Whole object/array/function comparisons are outside the scalar comparison profile
and return UNKNOWN before reference identity checks. Null remains a supported scalar;
object truthiness and traversal to supported scalar properties remain available.

The expression profile resolves ASCII context keys case-insensitively using own
properties only (including dotted/bracketed keys and root names). Multiple own keys
with the same ASCII fold are UNKNOWN rather than selecting a conflicting value.
An unavailable top-level named context is always UNKNOWN, even when the independently
captured event context is declared complete. Complete known matrix rows still use
the platform-confirmed null scalar for absent properties; generated needs remains
partial. Keywords are the supported lowercase true/false/null spellings; unsupported
named roots, including other spellings not accepted by this grammar, remain UNKNOWN.

String comparison and string search support the ASCII case-insensitive profile.
Identical Unicode strings compare equal, but nonidentical comparisons involving
non-ASCII text remain UNKNOWN, including cross-type numeric comparisons, rather
than claim complete equivalence to the runner's Unicode case rules. Non-ASCII
property keys are outside this profile. Unicode literal rendering is preserved.
Implicit matrix names with structured object/array values are unresolved with empty
name alternatives; explicit supported scalar name expressions remain available.

Numeric coercion is a bounded profile, rather than a full GitHub-number claim.
Null, Boolean and finite numeric values are supported. String-to-number conversion
supports empty/ASCII whitespace, finite ASCII signed decimal/exponent grammar, and
unsigned lowercase-prefix 0x/0o forms only within 0..2147483647. Other casts remain
UNKNOWN, including malformed text, binary prefixes, uppercase prefixes, infinities,
overflow and non-ASCII text; equality and unary minus propagate that UNKNOWN.
Numeric literals must be finite, and hexadecimal literals use the same small range.
All numeric scalar values additionally have absolute magnitude at most 2^53-1,
including literals, context/YAML matrix facts, coercions, comparisons and truth
operands; out-of-domain values become UNKNOWN before equality identity checks.
Fractions within this magnitude may be compared, while their rendering stays
outside the stable-integer formatting profile.
String rendering of numbers is restricted to safe integers excluding negative zero;
noninteger/unstable numeric formatting and implicit matrix suffixes outside the
string/Boolean/stable-integer profile remain unresolved. Explicit object-property
names that evaluate to supported scalar strings remain supported.

Reusable definitions are supplied independently, never fetched from observed job
names: `reusableDefinitions: {"./.github/workflows/child.yml": {workflow:"YAML",
workflowIdentity:{repository:"owner/repo",path:".github/workflows/child.yml",
commit:"40 hexadecimal digits",verified:true}}}`. Remote keys must contain exact
owner/repository/path@40-hex-commit and match definition identity. Local definitions
must match the caller's pinned source repository and execution-candidate commit.
Depth is bounded at three calls. Typed boolean/number/string inputs and defaults,
caller matrices, callee matrices, names, child needs and nested calls are supported.
Unresolved pins, cycles, unavailable/ill-typed inputs and other unsupported
constructs retain explicit unresolved caller obligations and block qualification.
Source closure is global: unresolved matrix/reusable source features block closure
even when their owning group has a proven false guard. Inactivity discharges expected
execution coverage, while independently reconstructing the source universe remains
an unconditional certificate obligation.

The existing `verified` field has two explicit trust roles: root identity means
the collector established the executed workflow identity; reusable definition
identity means the collector established pinned source bytes at that exact Git
identity. A known immutable root candidate can compile even when root execution
identity is unknown; qualification still blocks on its root identity obligation.
Neither flag is derived from observed job success. The compiler does not authenticate
the collector or GitHub. Nested source witnesses retain deepest definition identity
and an outer-to-inner callerChain. Wrappers retain children and no evidence slots;
only source leaf instances bind observations.

Owned platform run40508078051 confirms reusable caller aggregation: a nonempty all-skipped child set yields skipped; mixed success/skipped yields success. Unknown child applicability or payloads remain unknown. This is a bounded provider conformance observation, not a complete model of platform scheduling.
