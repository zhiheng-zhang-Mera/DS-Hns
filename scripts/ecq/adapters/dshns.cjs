'use strict';
// The contract is supplied by an independently inspected pinned runner/workflow.
// Result deletion can never delete a requirement. This adapter changes only form.
function normalizeDSHns(record,mappingSpec) {
 const requestedClaim=mappingSpec.requestedClaim||'qualification:whole';
 const gates=mappingSpec.requiredGates;
 if(!Array.isArray(gates))throw new Error('independent requiredGates mapping is mandatory');
 const contract={contractId:mappingSpec.contractId||`dshns:${record.runId}`,statePolicy:mappingSpec.statePolicy,
  runPolicy:mappingSpec.runPolicy,requiredGates:gates,
  claimGraph:{nodes:[requestedClaim,...gates.map(g=>g.claimId)],edges:gates.map(g=>[g.claimId,requestedClaim])},requestedClaim,
  admissibleTypes:{types:[mappingSpec.evidenceType||'archived-qualification-record'],provenance:['repository-archive']}};
 const mappingWitnesses=[{target:'/contract/requiredGates',basis:mappingSpec.contractSource||'explicit independent mapping',
  originalWholePassed:record.passed,originalRunId:record.runId,measuredCode:record.gitSha}];
 const evidence=(record.results||[]).map(r=>{
  const gate=gates.find(g=>g.id===r.id),ref=mappingSpec.artifacts?.[r.id];
  mappingWitnesses.push({target:`/evidence/${r.id}`,source:`results[id=${r.id}]`,originalPassed:r.passed,
   originalRunId:r.runId,originalMeasuredCode:r.gitSha});
  return {id:r.id,subject:{repositoryId:mappingSpec.statePolicy.repositoryId,commit:r.gitSha,tree:r.gitTree},
   runId:r.runId,gateId:r.id,claimId:gate?.claimId||`gate:${r.id}`,scope:gate?.scope||`gate:${r.id}`,
   outcome:r.passed===true?'PASS':r.passed===false?'FAIL':'UNKNOWN',
   evidenceType:mappingSpec.evidenceType||'archived-qualification-record',provenance:'repository-archive',
   artifactRefs:ref?[{id:ref.id||r.id,path:ref.path,objectId:ref.objectId,expectedObjectId:ref.expectedObjectId,sha256:ref.sha256,availability:ref.availability}]:[]};
 });
 return {bundle:{caseId:mappingSpec.caseId||record.runId,evidence},contract,mappingWitnesses};
}
module.exports={normalizeDSHns};
