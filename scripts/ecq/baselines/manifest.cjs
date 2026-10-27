'use strict';
// Conventional manifest checks implemented independently of ECQ predicates.
const {resolveArtifact}=require('../resolver.cjs');
const capabilities=Object.freeze({authorization:true,closure:false,gateSatisfaction:false,relationDiagnostics:false,witnesses:false});
function evaluate(bundle,contract,resolver){
 if(!Array.isArray(bundle?.evidence)||!Array.isArray(contract?.requiredGates))throw new TypeError('Expected evidence and gate arrays');
 const read=typeof resolver==='function'?resolver:r=>resolveArtifact(r,resolver);
 const required=contract.requiredGates.filter(g=>g.required!==false);
 let pass=bundle.evidence.length>0&&required.length>0&&contract.statePolicy&&Object.keys(contract.statePolicy).length>0&&Array.isArray(contract.runPolicy?.allowedRunIds);
 for(const gate of required){const matched=bundle.evidence.filter(e=>e.gateId===gate.id);if(!matched.length||matched.some(e=>e.outcome!=='PASS'))pass=false;}
 for(const e of bundle.evidence){
  for(const [key,value]of Object.entries(contract.statePolicy||{}))if(value==null||e.subject?.[key]==null||e.subject[key]!==value)pass=false;
  if(e.runId==null||!contract.runPolicy?.allowedRunIds?.includes(e.runId))pass=false;
  if(!Array.isArray(e.artifactRefs)||!e.artifactRefs.length){pass=false;continue;}
  for(const ref of e.artifactRefs){const r=read(ref);if(r.status!=='FOUND'||ref.objectId==null||ref.expectedObjectId==null||ref.objectId!==ref.expectedObjectId||ref.sha256==null||r.actualSha256!==ref.sha256)pass=false;}
 }
 return {authorizePass:Boolean(pass),closureStatus:null,gateSatisfaction:null,relations:null,capabilities,methodIdentity:'conventional-manifest-v1'};
}
module.exports=evaluate;module.exports.evaluate=evaluate;module.exports.capabilities=capabilities;
