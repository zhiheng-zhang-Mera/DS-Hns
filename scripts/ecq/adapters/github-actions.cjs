'use strict';
// Maps only declared, reconstructable workflow profiles. Never derives required
// jobs from the observed result array. Unknown workflow syntax fails explicitly.
function requiredJobs(workflow,context={}) {
  if (!workflow || !workflow.jobs || !Object.keys(workflow.jobs).length) throw new Error('workflow has no declared jobs');
  const required=[];
  for (const [id,job] of Object.entries(workflow.jobs)) {
    if (job.strategy || job.uses) throw new Error('unsupported dynamic matrix/reusable workflow');
    let enabled=true;
    if (job.if) {
      const expr=String(job.if).trim().replace(/^\$\{\{\s*|\s*\}\}$/g,'');
      const m=/^github\.repository_owner\s*==\s*['"]([^'"]+)['"]$/.exec(expr);
      if(!m) throw new Error(`unsupported conditional expression for ${id}`);
      if (!context.repository_owner) throw new Error('missing repository_owner context');
      enabled=context.repository_owner===m[1];
    }
    if (enabled) required.push({id,name:job.name||id,claimId:`job:${id}`,scope:`job:${id}`,required:true});
  }
  return required;
}
function normalizeActions(record,workflowAtCommit,eventContext,mappingSpec) {
  const gates=requiredJobs(workflowAtCommit,eventContext);
  const state={repositoryId:mappingSpec.repositoryId,commit:record.run.head_sha,
    tree:mappingSpec.tree,configurationDigest:mappingSpec.configurationDigest};
  const requestedClaim='workflow:recorded-outcome';
  const contract={contractId:`actions:${mappingSpec.repositoryId}:${record.run.id}`,
    statePolicy:state,runPolicy:{allowedRunIds:[String(record.run.id)]},
    requiredGates:gates.map(({name,...g})=>g),
    claimGraph:{nodes:[requestedClaim,...gates.map(g=>g.claimId)],edges:gates.map(g=>[g.claimId,requestedClaim])},
    requestedClaim,admissibleTypes:{types:['github-actions-job-api-record'],provenance:['github-rest-api-collected']}};
  const mappingWitnesses=[{target:'/contract/requiredGates',source:'workflow.jobs',basis:'pinned workflow declarations and supported event conditions',expected:gates}];
  const evidence=[];
  for(const job of record.jobs||[]) {
    const gate=gates.find(g=>g.name===job.name);
    if(!gate) throw new Error(`observed job ${job.name} not in independently declared gate profile`);
    const ref=mappingSpec.artifacts?.[String(job.id)];
    const id=String(job.id);
    evidence.push({id:`job-${id}`,subject:{...state},runId:String(record.run.id),
      gateId:gate.id,claimId:gate.claimId,scope:gate.scope,
      outcome:job.conclusion==='success'?'PASS':job.conclusion==='failure'?'FAIL':'UNKNOWN',
      evidenceType:'github-actions-job-api-record',provenance:'github-rest-api-collected',
      artifactRefs:ref?[{id:`record-${id}`,path:ref.path,objectId:`github-job:${id}`,
        expectedObjectId:`github-job:${id}`,sha256:ref.sha256}]:[]});
    mappingWitnesses.push({target:`/evidence/job-${id}`,source:{jobId:job.id,runId:record.run.id,
      commit:record.run.head_sha,workflowJob:gate.id,rawConclusion:job.conclusion},basis:'direct API-field mapping; job name matched to workflow declaration'});
  }
  return {bundle:{caseId:mappingSpec.caseId||String(record.run.id),evidence},contract,mappingWitnesses};
}
module.exports={normalizeActions,requiredJobs};
