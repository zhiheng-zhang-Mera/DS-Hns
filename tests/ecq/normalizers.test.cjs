const test = require('node:test');
const assert = require('node:assert/strict');
const {normalizeActions, requiredJobs} = require('../../scripts/ecq/adapters/github-actions.cjs');
const {normalizeDSHns}=require('../../scripts/ecq/adapters/dshns.cjs');
const workflow={jobs:{build:{name:'Lint Markdown','runs-on':'ubuntu-latest'}}};
const spec={repositoryId:'owner/project',tree:'tree',configurationDigest:'workflow-hash',artifacts:{'123':{path:'job.json',sha256:'abc'}}};
const record={run:{id:99,head_sha:'commit'},jobs:[{id:123,name:'Lint Markdown',conclusion:'failure'}]};
test('normalizationPreservesSourceIdentity',()=>{
 const {bundle,contract,mappingWitnesses}=normalizeActions(record,workflow,{repository_owner:'owner'},spec);
 assert.equal(bundle.evidence[0].subject.commit,'commit'); assert.equal(bundle.evidence[0].runId,'99');
 assert.equal(contract.statePolicy.tree,'tree'); assert.equal(mappingWitnesses.length>0,true);
});
test('normalizationPreservesOriginalFailure',()=>{
 const {bundle}=normalizeActions(record,workflow,{repository_owner:'owner'},spec);
 assert.equal(bundle.evidence[0].outcome,'FAIL');
});
test('conditionalJobsFollowWorkflowContext',()=>{
 const w={jobs:{a:{if:"github.repository_owner == 'pytest-dev'"},b:{}}};
 assert.deepEqual(requiredJobs(w,{repository_owner:'pytest-dev'}).map(x=>x.id),['a','b']);
 assert.deepEqual(requiredJobs(w,{repository_owner:'other'}).map(x=>x.id),['b']);
 assert.throws(()=>requiredJobs({jobs:{a:{if:'unknown()'}}},{}),/unsupported/i);
});
test('deletingResultsDoesNotAlterRequiredGateSet',()=>{
 const complete=normalizeActions(record,workflow,{},spec);
 const missing=normalizeActions({...record,jobs:[]},workflow,{},spec);
 assert.deepEqual(complete.contract.requiredGates,missing.contract.requiredGates);
 assert.equal(missing.bundle.evidence.length,0);
});
test('dynamicMatricesAreExcludedRatherThanInferred',()=>{
 assert.throws(()=>requiredJobs({jobs:{a:{strategy:{matrix:{node:[20,22]}}}}},{}),/unsupported/i);
});
test('historicalWholeFailureIsPreservedWithoutInferringRequirements',()=>{
 const source={runId:'original-run',gitSha:'measured',gitTree:'tree',passed:false,
  results:[{id:'ui',passed:false,runId:'original-run',gitSha:'measured',gitTree:'tree'}]};
 const mapping={statePolicy:{repositoryId:'DS-Hns',commit:'measured',tree:'tree'},runPolicy:{allowedRunIds:['original-run']},
  requiredGates:[{id:'ui',claimId:'gate:ui',scope:'gate:ui',required:true},{id:'not-in-results',claimId:'gate:x',scope:'gate:x',required:true}],artifacts:{}};
 const result=normalizeDSHns(source,mapping);
 assert.equal(result.bundle.evidence[0].outcome,'FAIL');
 assert.equal(result.contract.requiredGates.length,2);
 assert.equal(result.mappingWitnesses[0].originalWholePassed,false);
});
