'use strict';
function pointerId(x){return String(x).replace(/~/g,'~0').replace(/\//g,'~1');}
function enumerateObligations(bundle,contract){
 const result=[];
 function add(invariant,suffix,evidenceId,artifactRef,gateId,witnessRefs){result.push({obligationId:`${invariant}:${suffix}`,invariant,subjectRefs:[evidenceId,gateId,artifactRef?.id].filter(x=>x!==undefined),evidenceId,artifactRef,gateId,witnessRefs:witnessRefs.sort()});}
 for(const gate of contract.requiredGates.filter(g=>g.required!==false))add('I_G',`g:${gate.id}`,undefined,undefined,gate.id,[`/contract/requiredGates/${pointerId(gate.id)}`]);
 for(const e of bundle.evidence){const ep=`/evidence/${pointerId(e.id)}`;
  for(const [inv,contractField,evidenceField] of [['I_S','statePolicy','subject'],['I_R','runPolicy','runId'],['I_V','claimGraph','claimId'],['I_C','requiredGates','binding'],['I_T','admissibleTypes','type']])add(inv,`e:${e.id}`,e.id,undefined,undefined,[inv==='I_C'?`/contract/requiredGates/${pointerId(e.gateId)}`:`/contract/${contractField}`,`${ep}/${evidenceField}`]);
  const refs=Array.isArray(e.artifactRefs)&&e.artifactRefs.length?e.artifactRefs:[{id:'required',syntheticRequired:true}];
  for(const ref of refs)for(const inv of ['I_E','I_I'])add(inv,`a:${e.id}:${ref.id}`,e.id,ref,undefined,[`${ep}/artifacts/${pointerId(ref.id)}`]);
 }
 return result.sort((a,b)=>a.obligationId.localeCompare(b.obligationId,'en'));
}
module.exports={enumerateObligations};
