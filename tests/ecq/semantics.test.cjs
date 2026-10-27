const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const cp=require('node:child_process');
let evaluateQualification;try { ({evaluateQualification}=require('../../scripts/ecq/evaluate.cjs')); } catch(e) { if(e.code!=='MODULE_NOT_FOUND')throw e; evaluateQualification=()=>({}); }
function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ecq-native-'));
 fs.writeFileSync(path.join(root,'e.bin'),'observed bytes');
 const subject={repositoryId:'owner/repo',commit:'abc',tree:'tree',configurationDigest:'config',dependencyLockDigest:'lock'};
 const contract={contractId:'c',statePolicy:subject,runPolicy:{allowedRunIds:['r1']},requiredGates:[{id:'g',claimId:'test',scope:'component',required:true}],claimGraph:{nodes:['test','whole'],edges:[['test','whole']]},requestedClaim:'whole',admissibleTypes:{types:['execution'],provenance:['ci']}};
 const evidence={id:'e',subject:{...subject},runId:'r1',gateId:'g',claimId:'test',scope:'component',outcome:'PASS',evidenceType:'execution',provenance:'ci',artifactRefs:[{id:'a',path:'e.bin',objectId:'blob1',expectedObjectId:'blob1',sha256:crypto.createHash('sha256').update('observed bytes').digest('hex')}]};
 return {root,contract,bundle:{caseId:'opaque',evidence:[evidence]},e:evidence};
}
function run(f,options){return evaluateQualification(f.bundle,f.contract,f.root,options);}
function status(r,key){return r.relations?.find(x=>x.invariant===key)?.status;}
test('valid complete PASS authorizes',()=>{const f=fixture();assert.equal(run(f).authorizePass,true);});
test('honestFailRemainsClosed',()=>{const f=fixture();f.e.outcome='FAIL';const r=run(f);assert.equal(r.closureStatus,'CLOSED');assert.equal(r.gateSatisfaction,'UNSATISFIED');assert.equal(r.authorizePass,false);});
test('authorizedReuseIsAccepted',()=>{const f=fixture();f.e.runId='old';f.contract.runPolicy.allowedRunIds.push('old');assert.equal(run(f).authorizePass,true);});
test('unauthorizedRunMixIsViolated',()=>{const f=fixture();f.e.runId='old';assert.equal(status(run(f),'I_R'),'VIOLATED');});
test('sameCommitDifferentConfiguration',()=>{const f=fixture();f.e.subject.configurationDigest='other';assert.equal(status(run(f),'I_S'),'VIOLATED');});
test('missingArtifactLeavesIntegrityUnresolved',()=>{const f=fixture();fs.unlinkSync(path.join(f.root,'e.bin'));const r=run(f);assert.equal(status(r,'I_E'),'VIOLATED');assert.equal(status(r,'I_I'),'UNRESOLVED');});
test('unavailable differs from confirmed absent',()=>{const f=fixture();f.e.artifactRefs[0].availability='UNAVAILABLE';const r=run(f);assert.equal(status(r,'I_E'),'UNRESOLVED');assert.equal(r.closureStatus,'UNRESOLVED');});
test('missing expected digest remains unresolved',()=>{const f=fixture();delete f.e.artifactRefs[0].sha256;assert.equal(status(run(f),'I_I'),'UNRESOLVED');});
test('wrong bytes violate integrity',()=>{const f=fixture();fs.writeFileSync(path.join(f.root,'e.bin'),'changed');assert.equal(status(run(f),'I_I'),'VIOLATED');});
test('wrong object identity violates reference even if bytes agree',()=>{const f=fixture();f.e.artifactRefs[0].objectId='other';assert.equal(status(run(f),'I_E'),'VIOLATED');assert.equal(status(run(f),'I_I'),'ESTABLISHED');});
test('known object mismatch dominates unavailable bytes',()=>{const f=fixture();f.e.artifactRefs[0].objectId='other';f.e.artifactRefs[0].availability='UNAVAILABLE';assert.equal(status(run(f),'I_E'),'VIOLATED');assert.equal(status(run(f),'I_I'),'UNRESOLVED');});
test('compoundDiagnosticsPreserveAllInstances',()=>{const f=fixture();f.e.runId='wrong';f.e.evidenceType='simulation';f.e.artifactRefs[0].availability='UNAVAILABLE';const r=run(f);assert.equal(status(r,'I_R'),'VIOLATED');assert.equal(status(r,'I_T'),'VIOLATED');assert.equal(status(r,'I_I'),'UNRESOLVED');assert.equal(r.relations.length,8);});
test('reorderingPreservesDecision and relation IDs',()=>{const f=fixture();f.bundle.evidence.push({...structuredClone(f.e),id:'e2'});const before=run(f);f.bundle.evidence.reverse();f.contract.claimGraph.nodes.reverse();assert.deepEqual(run(f),before);});
test('scopeUsesDeclaredSupportGraph not prefix',()=>{const f=fixture();f.contract.claimGraph.edges=[];f.contract.requestedClaim='test.whole';assert.equal(status(run(f),'I_V'),'VIOLATED');});
test('binding checks scope separately from graph support',()=>{const f=fixture();f.e.scope='whole';assert.equal(status(run(f),'I_C'),'VIOLATED');assert.equal(status(run(f),'I_V'),'ESTABLISHED');});
test('missing refs cannot disappear obligations',()=>{const f=fixture();f.e.artifactRefs=[];const r=run(f);assert.equal(status(r,'I_E'),'UNRESOLVED');assert.equal(status(r,'I_I'),'UNRESOLVED');assert.equal(r.authorizePass,false);});
test('gate contract persists without results',()=>{const f=fixture();f.bundle.evidence=[];const r=run(f);assert.equal(status(r,'I_G'),'VIOLATED');assert.equal(r.gateSatisfaction,'UNRESOLVED');});
test('FAIL dominates another missing gate outcome',()=>{const f=fixture();f.e.outcome='FAIL';f.contract.requiredGates.push({id:'absent',claimId:'test',scope:'component',required:true});assert.equal(run(f).gateSatisfaction,'UNSATISFIED');});
test('ablation removes only chosen invariant family',()=>{const f=fixture();f.e.evidenceType='mock';const r=run(f,{disabledInvariants:['I_T']});assert.equal(r.authorizePass,true);assert.equal(r.relations.some(x=>x.invariant==='I_T'),false);});
test('CLI ordinary rejection exit zero; malformed execution exit two',()=>{const f=fixture();f.e.outcome='FAIL';const b=path.join(f.root,'b.json'),c=path.join(f.root,'c.json'),out=path.join(f.root,'out.json');fs.writeFileSync(b,JSON.stringify(f.bundle));fs.writeFileSync(c,JSON.stringify(f.contract));const cli=path.resolve(__dirname,'../../scripts/ecq/cli.cjs');let p=cp.spawnSync(process.execPath,[cli,'--bundle',b,'--contract',c,'--artifacts',f.root,'--out',out]);assert.equal(p.status,0);assert.equal(JSON.parse(fs.readFileSync(out)).authorizePass,false);p=cp.spawnSync(process.execPath,[cli,'--bundle',b+'.missing','--contract',c,'--artifacts',f.root,'--out',out]);assert.equal(p.status,2);});
