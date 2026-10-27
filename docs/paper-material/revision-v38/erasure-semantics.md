# Fixed-universe omission safety

## Trust boundary and information order

Fix a workflow source closure W, immutable context roots K, claim scope S, source-derived slot universe J, capture inventory I, and capture/source assertions A. A includes captureComplete, eventContextComplete, source pin/execution identity flags and their documented defaults; K includes any supplied cancellation snapshot. I contains all captured record identities and all binding alternatives, including unmatched and duplicate records. These are trusted inputs to qualification, not facts inferred from the surviving payloads. A capture identity assertion is not producer authentication. A PR head source alone does not establish execution source identity. Removing an explicit incomplete flag to obtain the trusted-control default is a boundary amendment, not observation erasure.

Each observation coordinate is either a concrete typed fact or unknown bottom. Define x <= y when every concrete coordinate of x is identical in y. An erasure e satisfies e(x) <= x. It may withdraw payload records or individual facts, but must retain I (or equivalent independently verifiable tombstones), J, W, K and S. Deleting a binding candidate from I, editing a value, changing a workflow or narrowing scope is an input amendment, not an erasure covered by this result.

## Qualification obligations

Each source slot has a partial guard. Applicability uses sound partial evaluation: a reported concrete value agrees with every concrete completion consistent with the available facts. Unsupported syntax remains unknown. Logical operators return operands in concrete GitHub semantics; knowing a result is falsey does not necessarily determine its scalar value. In particular unknown && false must not be replaced by the known scalar false when its operand can also be an erased empty string.

For an active slot, coverage, unique binding, identity, completed state and accepted outcome are required. A tolerated failure changes accepted outcome and downstream needs aggregation; it never waives coverage. A false guard discharges execution coverage, but every captured record still has a consistency obligation. An inactive record must be an attributable skipped placeholder; a contradictory executed record or erased placeholder outcome cannot disappear from qualification. Unknown applicability blocks authorization. Ambiguous binding remains ambiguous after payload erasure because its candidate set is fixed in I.

Source and capture obligations hold independently of target presence: source closure is resolved or explicitly unknown; supplied certificates enumerate every source requirement and candidate; extra captured records cannot be omitted. Non-vacuous execution claims additionally require at least one established active slot. Whole-workflow conformity and actual test execution are distinct claim scopes.

## Proposition

Assume (1) fixed W,K,S,J,I,A, (2) source enumeration and binding completeness are independently checked, (3) every primitive obligation and guard evaluator is sound under partial observations and preserves established judgments when information increases, (4) unknown obligations cannot authorize, and (5) no evidence-dependent scope narrowing. Then authorization is upward closed in information: if e(x) <= x and authorize(e(x)), then authorize(x). Soundness alone does not imply that an implementation retains an established judgment: a sound but needlessly imprecise evaluator could return TRUE on less information and UNKNOWN on more. The explicit persistence premise excludes that counterexample.

Proof. Every obligation discharged at e(x) holds for every consistent concrete completion. Any completion of x is also a completion of e(x), since e(x) <= x. Such judgments remain semantically valid, and the persistence premise ensures the implementation retains their established status. A guard established false at e(x) is false in every completion of x; a guard established true remains true. A non-vacuity witness remains an active slot. All conjunctions required by authorization therefore remain established at x. This is a qualification safety result under a fixed trust boundary; it does not authenticate the workflow producer or prove arbitrary workflow program behavior. QED.

## Necessary counterexamples

Survivor-derived requirements: source requires A; captured A passes and an unmatched conflicting B fails qualification. Delete B and rederive inventory from survivors: qualification can pass. Fixed I preserves B's obligation.

Survivor-derived binding: two captured records share one expected display name. Delete one payload and rematch survivors: ambiguity becomes uniqueness. Fixed candidate inventory preserves both candidates.

Unknown-as-inactive: required A has an unavailable condition; discarding A as inactive permits authorization without deciding applicability. Conservative unknown blocking prevents that authorization.

Inactive contradiction: guard is false but captured record reports success. A checker that ignores all records of inactive groups can authorize both the contradiction and its erased payload. Persistent capture consistency rejects or leaves open both cases.

## Validation status

The argument states the method's required invariant. Implementation tests, differential checks and real-archive findings are reported separately after execution; this document itself is not empirical evidence that either implementation satisfies all assumptions. A conservative implementation may lose precision and block more archives without violating this proposition.
