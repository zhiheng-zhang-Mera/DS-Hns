'use strict';
const {known,aggregate,combine,equality,membership,reachable,gateSatisfaction,validateInput,capabilities}=require('./model.cjs');
const {enumerateObligations}=require('./obligations.cjs');
const {resolveArtifact}=require('./resolver.cjs');
function evaluateQualification(bundle,contract,resolver,options={}){
 validateInput(bundle,contract);
 const resolve=typeof resolver==='function'?resolver:r=>resolveArtifact(r,resolver);
 const disabled=new Set(options.disabledInvariants||[]),evidenceById=new Map(bundle.evidence.map(e=>[e.id,e]));
 const cache=new Map();
 function resolved(e,ref){const key=JSON.stringify([e.id,ref.id]);if(!cache.has(key))cache.set(key,ref.syntheticRequired?{status:'UNAVAILABLE'}:resolve(ref));return cache.get(key);}
 const relations=enumerateObligations(bundle,contract).filter(o=>!disabled.has(o.invariant)).map(o=>{
  const e=evidenceById.get(o.evidenceId),ref=o.artifactRef;let status;
  switch(o.invariant){
   case 'I_S':status=!contract.statePolicy||!Object.keys(contract.statePolicy).length?'UNRESOLVED':combine(Object.entries(contract.statePolicy).map(([k,v])=>equality(e.subject?.[k],v)));break;
   case 'I_R':status=membership(e.runId,contract.runPolicy?.allowedRunIds);break;
   case 'I_G':status=bundle.evidence.some(x=>x.gateId===o.gateId)?'ESTABLISHED':'VIOLATED';break;
   case 'I_V':status=reachable(e.claimId,contract.requestedClaim,contract.claimGraph);break;
   case 'I_C':{
    const gate=contract.requiredGates.find(g=>g.required!==false&&g.id===e.gateId);
    if(!known(e.gateId))status='UNRESOLVED';else if(!gate)status='VIOLATED';else status=combine([equality(e.claimId,gate.claimId),equality(e.scope,gate.scope)]);break;
   }
   case 'I_E':{
    const r=resolved(e,ref),identity=equality(ref.objectId,ref.expectedObjectId);status=r.status==='MISSING'||identity==='VIOLATED'?'VIOLATED':r.status!=='FOUND'?'UNRESOLVED':identity;break;
   }
   case 'I_I':{
    const r=resolved(e,ref);status=r.status==='FOUND'?equality(ref.sha256,r.actualSha256):'UNRESOLVED';break;
   }
   case 'I_T':status=combine([membership(e.evidenceType,contract.admissibleTypes?.types),membership(e.provenance,contract.admissibleTypes?.provenance)]);break;
  }
  return {obligationId:o.obligationId,invariant:o.invariant,status,witnessRefs:o.witnessRefs,reasonCode:`${o.invariant}_${status}`};
 });
 const closureStatus=aggregate(relations.map(x=>x.status)),satisfaction=gateSatisfaction(bundle,contract);
 return {closureStatus,gateSatisfaction:satisfaction,authorizePass:closureStatus==='CLOSED'&&satisfaction==='SATISFIED',relations,methodIdentity:'native-ecq-v1'};
}
module.exports={evaluateQualification,capabilities};
