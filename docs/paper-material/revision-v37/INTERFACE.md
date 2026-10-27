# Frozen implementation interface, v37 profile 1

Authoritative research specification: Essay-Book/DS-Hns-H/arxiv/v37/RESEARCH_SPEC.md.
All functions are synchronous unless explicitly stated. No evaluators receive family/oracle labels.

Bundle `{caseId, evidence:[EvidenceItem]}`. EvidenceItem has `id, subject, runId,
gateId, claimId, scope, outcome, evidenceType, provenance, artifactRefs`.
Subject fields: repositoryId, commit, tree, configurationDigest, dependencyLockDigest.
Contract `{contractId,statePolicy,runPolicy,requiredGates,claimGraph,requestedClaim,admissibleTypes}`.
statePolicy is expected subject fields; every listed field required and equal.
runPolicy `{allowedRunIds:[string]}` explicitly permits all listed runs.
requiredGates is array `{id,claimId,scope,required:true}`. Ignore entries required=false.
claimGraph `{nodes:[string],edges:[[supportingClaim,supportedClaim]]}`; reflexive reachability.
admissibleTypes `{types:[string],provenance:[string]}`.
ArtifactRef `{id,path,objectId,expectedObjectId,sha256,availability?}`; availability
UNAVAILABLE explicitly means inaccessible, MISSING confirms absent; ordinary files read at artifactRoot.
Integrity digest is trusted contract/construction expectation, not recomputed from received content.
Unknown scalar means missing/null; empty array is a known empty set.

Relation IDs `I_S:e:<evidenceId>`, I_R/I_V/I_C/I_T same pattern;
`I_G:g:<gateId>`; `I_E:a:<evidenceId>:<refId>`, I_I same suffix.
One relation per evidence per S/R/V/C/T; one per required gate G; one per ref E/I.
Each relation `{obligationId,invariant,status,witnessRefs,reasonCode}`.
witnessRefs are sorted stable JSON pointers: `/contract/statePolicy`,
`/contract/runPolicy`, `/contract/requiredGates/<gateId>`, `/contract/claimGraph`,
`/contract/admissibleTypes`, `/evidence/<id>/subject`, `/evidence/<id>/runId`,
`/evidence/<id>/claimId`, `/evidence/<id>/binding`, `/evidence/<id>/type`,
`/evidence/<id>/artifacts/<refId>`. These identify evidence by ID, not array position.
reasonCode equals `<invariant>_<status>`; finer findings optional separate fields.

S: expected fields all known and equal => established; any known unequal => violated;
otherwise unresolved. R: known run in allowed set E; other known V; missing U.
G: any evidence with gateId equals required gate => E; otherwise V.
V: each evidence claimId has graph path to requestedClaim => E; known no path V;
missing claim or requested/graph U.
C: gate known required, claimId/scope equal that gate's contract => E;
known mismatch or unknown gate V; missing gate/claim/scope U. S handles state binding.
E: FOUND and objectId=expectedObjectId => E; MISSING or known unequal object => V;
known unequal object identity dominates UNAVAILABLE bytes. Otherwise UNAVAILABLE
or missing object identity => U.
I: FOUND and trusted sha256 equals computed digest => E; known unequal => V;
no bytes or no expected digest => U (even when E violated).
T: type and provenance each allowed => E; known disallowed => V; missing U.
Within multi-field relations known violation dominates unknown.
Every evidence must have artifactRefs nonempty; empty/missing refs creates synthetic
ref id `required`, with E=U and I=U, rather than silently passing.

GateSatisfaction: per required gate, any FAIL => UNSATISFIED; otherwise every gate
has evidence and all its outcomes PASS => SATISFIED; else UNRESOLVED.
Any required gate FAIL dominates unknown other gates. Empty required gates unresolved.
Closure: any V => VIOLATED, else any U => UNRESOLVED, else CLOSED.
authorizePass exactly CLOSED and SATISFIED. Empty evidence with required gates => VIOLATED.

Native exports evaluateQualification(bundle,contract,resolver,{disabledInvariants:[]}={})
from scripts/ecq/evaluate.cjs, enumerateObligations from obligations.cjs,
resolveArtifact(ref,root) from resolver.cjs returning status, actualSha256, optional bytes.
Resolver can be function(ref) or root string. methodIdentity string native-ecq-v1.
B0/B1 separate outcome-only.cjs/manifest.cjs default export evaluate + named evaluate.
B2 Python run.py CLI --bundle --contract --artifacts --out and JSONL service optional.
Independent oracle reference_labels.py evaluate(bundle,contract,artifact_root) and
label_case(construction_facts,change_ledger,contract): facts carry bundle and artifactRoot.
All complete results include closureStatus/gateSatisfaction/authorizePass/relations/methodIdentity.
B0/B1 unsupported axes null; capabilities explicit. Node methods capabilities global runner.
