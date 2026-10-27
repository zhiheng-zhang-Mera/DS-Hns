import {parseDocument} from 'yaml';
import {createHash} from 'node:crypto';
import {evaluate,render,truth,unknown,U} from './expressions.mjs';
export {evaluate,U};
const hash=s=>createHash('sha256').update(s).digest('hex');
const arr=x=>x===undefined?[]:Array.isArray(x)?x:[x];
export function expandMatrix(matrix){
  if(matrix===undefined)return {rows:[{}],keys:[]};
  if(!matrix||typeof matrix!=='object'||Array.isArray(matrix))throw Error('dynamic/invalid matrix');
  const dynamic=value=>typeof value==='string'?value.includes('${{'):value&&typeof value==='object'?Object.values(value).some(dynamic):false;
  if(dynamic(matrix))throw Error('dynamic matrix value unsupported');
  const keys=Object.keys(matrix).filter(k=>!['include','exclude'].includes(k));
  let rows=keys.length?[{}]:[];
  for(const k of keys){if(!Array.isArray(matrix[k])||!matrix[k].length)throw Error('matrix dimension must be nonempty static array');if(rows.length*matrix[k].length>256)throw Error('matrix bound');rows=rows.flatMap(r=>matrix[k].map(v=>({...r,[k]:v})));}
  if(matrix.exclude!==undefined&&!Array.isArray(matrix.exclude))throw Error('exclude array required');
  rows=rows.filter(r=>!arr(matrix.exclude).some(e=>Object.entries(e).every(([k,v])=>JSON.stringify(r[k])===JSON.stringify(v))));
  const originals=rows.map(r=>({...r}));
  if(matrix.include!==undefined&&!Array.isArray(matrix.include))throw Error('include array required');
  for(const inc of arr(matrix.include)){if(!inc||typeof inc!=='object'||Array.isArray(inc))throw Error('include object required');let merged=false;originals.forEach((base,i)=>{if(keys.every(k=>!Object.hasOwn(inc,k)||JSON.stringify(inc[k])===JSON.stringify(base[k]))){Object.assign(rows[i],inc);merged=true;}});if(!merged){if(rows.length>=256)throw Error('matrix bound');rows.push({...inc});}}
  if(rows.length>256)throw Error('matrix bound');return {rows,keys};
}
export function compile(input,internal={depth:0,ancestors:[]}){
  const source=typeof input.workflow==='string'?input.workflow:input.workflow?.content;
  if(typeof source!=='string')throw Error('workflow YAML string required');
  const doc=parseDocument(source,{version:'1.2',uniqueKeys:true});if(doc.errors.length)throw Error(doc.errors.map(e=>e.message).join('; '));
  const workflow=doc.toJS();const digest=hash(source);const jobGroups=[],instances=[],unresolvedFeatures=[],sourceIdentities=[input.workflowIdentity??{}];
  if(!workflow?.jobs||typeof workflow.jobs!=='object'||Array.isArray(workflow.jobs))throw Error('jobs mapping required');
  for(const [id,job] of Object.entries(workflow.jobs)){
    if(!job||typeof job!=='object'||Array.isArray(job))throw Error(`job ${id} mapping required`);
    const group={id,needs:arr(job.needs),guard:job.if??true,instances:[],unsupported:[],placeholderName:job.name??id};jobGroups.push(group);
    let expansion,matrixUnknown=false;try{expansion=expandMatrix(job.strategy?.matrix);}catch(e){group.unsupported.push(e.message);matrixUnknown=true;expansion={rows:[{}],keys:[]};}
    if(job.strategy?.['fail-fast']!==undefined&&typeof job.strategy['fail-fast']!=='boolean')group.unsupported.push('dynamic fail-fast');
    expansion.rows.forEach((matrix,i)=>{const ctx={...input.eventContext,matrix};let name=render(job.name??id,ctx,{complete:input.eventContextComplete,partialRoots:['needs']});
      if(!unknown(name)&&job.strategy?.matrix&&!String(job.name??'').includes('${{')){const vals=expansion.keys.length?expansion.keys.map(k=>matrix[k]):Object.values(matrix);name+=` (${vals.map(String).join(', ')})`;}
      const instance={id:`${id}[${i}]`,groupId:id,matrix,names:matrixUnknown||unknown(name)?[]:[name],continueOnError:job['continue-on-error']??false,sourceWitness:{path:['jobs',id],matrixIndex:i,sourceSha256:digest,sourceRange:doc.getIn(['jobs',id],true)?.range??null}};instances.push(instance);group.instances.push(instance.id);
    });
    if(job.uses){
      try{
        if(internal.depth>=3)throw Error('reusable depth bound');
        const def=input.reusableDefinitions?.[job.uses];if(!def)throw Error('reusable definition unavailable');
        const identity=def.workflowIdentity??{},caller=input.workflowIdentity??{};
        if(identity.verified!==true)throw Error('reusable source pin unknown');
        const local=job.uses.startsWith('./');const remote=/^([^/]+\/[^/]+)\/(.+)@([0-9a-f]{40})$/i.exec(job.uses);
        if(local){if(!/^[0-9a-f]{40}$/i.test(caller.commit??'')||identity.commit!==caller.commit||identity.repository!==caller.repository||identity.path!==job.uses.slice(2))throw Error('local reusable execution identity mismatch');}
        else if(!remote||identity.repository!==remote[1]||identity.path!==remote[2]||identity.commit.toLowerCase()!==remote[3].toLowerCase())throw Error('remote reusable must match pinned source identity');
        const key=`${identity.repository}/${identity.path}@${identity.commit}`;if(internal.ancestors.includes(key))throw Error('reusable cycle');
        const childSource=typeof def.workflow==='string'?def.workflow:def.workflow?.content;
        const childDoc=parseDocument(childSource,{version:'1.2',uniqueKeys:true});if(childDoc.errors.length)throw Error('invalid reusable YAML');const childWorkflow=childDoc.toJS();
        const call=childWorkflow.on?.workflow_call;if(call===undefined)throw Error('definition lacks workflow_call');
        const declarations=call?.inputs??{};for(const k of Object.keys(job.with??{}))if(!Object.hasOwn(declarations,k))throw Error(`undeclared reusable input ${k}`);
        const callers=instances.filter(i=>i.groupId===id);const pendingGroups=[],pendingInstances=[],pendingUnresolved=[],pendingIdentities=[];const rootChildren=[];
        for(const callerInstance of callers){
          const inputs=Object.create(null);for(const [name,declaration]of Object.entries(declarations)){
            let value=Object.hasOwn(job.with??{},name)?job.with[name]:declaration.default;
            if(value===undefined)value=declaration.required?U:declaration.type==='boolean'?false:declaration.type==='number'?0:'';
            if(typeof value==='string'&&value.includes('${{'))value=/^\s*\$\{\{[\s\S]*\}\}\s*$/.test(value)?evaluate(value,{...input.eventContext,matrix:callerInstance.matrix,inputs:input.eventContext?.inputs},{complete:input.eventContextComplete,partialRoots:['needs']}):render(value,{...input.eventContext,matrix:callerInstance.matrix},{complete:input.eventContextComplete,partialRoots:['needs']});
            if(!['boolean','number','string'].includes(declaration.type)||unknown(value)||typeof value!==declaration.type){const reason=`unknown or ill-typed reusable input ${name}`;if(!group.unsupported.includes(reason))group.unsupported.push(reason);value=U;}inputs[name]=value;
          }
          if(callerInstance.names.length!==1){const reason='unknown reusable caller name';if(!group.unsupported.includes(reason))group.unsupported.push(reason);}
          const child=compile({...input,workflow:childSource,workflowIdentity:identity,eventContext:{...input.eventContext,inputs}}, {depth:internal.depth+1,ancestors:[...internal.ancestors,key]});
          const prefix=callerInstance.id+'/';const rename=x=>prefix+x;
          for(const cg of child.jobGroups){const namespaced={...cg,id:rename(cg.id),needs:cg.needs.map(rename),instances:cg.instances.map(rename),inputs:cg.inputs??inputs,
            parentGroup:cg.parentGroup?rename(cg.parentGroup):id,needsAliases:cg.needsAliases?Object.fromEntries(Object.entries(cg.needsAliases).map(([alias,target])=>[alias,rename(target)])):Object.fromEntries(cg.needs.map(n=>[n,rename(n)])),
            placeholderName:callerInstance.names.length===1&&typeof cg.placeholderName==='string'?callerInstance.names[0]+' / '+cg.placeholderName:U};
            if(cg.children)namespaced.children=cg.children.map(rename);pendingGroups.push(namespaced);if(!cg.parentGroup)rootChildren.push(namespaced.id);
          }
          for(const ci of child.instances)pendingInstances.push({...ci,id:rename(ci.id),groupId:rename(ci.groupId),names:callerInstance.names.length===1?ci.names.map(n=>callerInstance.names[0]+' / '+n):[],sourceWitness:{...ci.sourceWitness,workflowIdentity:ci.sourceWitness.workflowIdentity??identity,callerPath:['jobs',id],callerMatrixIndex:callerInstance.sourceWitness.matrixIndex,callerChain:[{workflowIdentity:input.workflowIdentity,path:['jobs',id],matrixIndex:callerInstance.sourceWitness.matrixIndex},...ci.sourceWitness.callerChain??[]]}});
          pendingUnresolved.push(...child.unresolvedFeatures.map(f=>({...f,groupId:rename(f.groupId)})));pendingIdentities.push(...child.sourceIdentities);
        }
        for(let n=instances.length-1;n>=0;n--)if(instances[n].groupId===id)instances.splice(n,1);
        group.instances=[];group.children=rootChildren;group.reusableIdentity=identity;jobGroups.push(...pendingGroups);instances.push(...pendingInstances);unresolvedFeatures.push(...pendingUnresolved);sourceIdentities.push(...pendingIdentities);
      }catch(error){group.unsupported.push(error.message);}
    }
    group.unsupported.forEach(reason=>unresolvedFeatures.push({groupId:id,reason}));
  }
  const visiting=new Set(),done=new Set(),byId=new Map(jobGroups.map(g=>[g.id,g]));
  function visit(id){if(visiting.has(id))throw Error('needs cycle');if(done.has(id))return;if(!byId.has(id))throw Error(`unknown needs ${id}`);visiting.add(id);byId.get(id).needs.forEach(visit);visiting.delete(id);done.add(id);}
  jobGroups.forEach(g=>visit(g.id));
  return {schemaVersion:'ecq-v38/1',workflowIdentity:input.workflowIdentity??{},sourceSha256:digest,sourceIdentities,jobGroups,instances,dependencies:jobGroups.flatMap(g=>g.needs.map(n=>({from:n,to:g.id}))),sourceWitnesses:instances.map(i=>i.sourceWitness),unresolvedFeatures};
}
export function qualify(input,contract=compile(input)){
  const reconstructed=compile(input);const contractMatches=JSON.stringify(contract)===JSON.stringify(reconstructed);contract=reconstructed;
  const obligations=[],gateValues=[],inventory=input.captureInventory??[],facts=new Map(arr(input.sourceJobs).map(r=>[r.id,r])),results=Object.create(null),states=Object.create(null),attributed=new Set(),byId=new Map(contract.jobGroups.map(g=>[g.id,g]));
  const add=(slot,kind,value,detail={})=>obligations.push({slot,kind,value:unknown(value)?'UNKNOWN':value?'TRUE':'FALSE',...detail});
  add('$workflow','contractSourceReconstruction',contractMatches);
  add('$workflow','sourceClosure',contract.unresolvedFeatures.length===0?true:U,{unresolvedFeatures:contract.unresolvedFeatures});
  add('$workflow','sourceIdentity',input.workflowIdentity?.verified===true);
  add('$workflow','fixedInventory',Array.isArray(input.captureInventory));
  add('$workflow','captureComplete',input.captureComplete===undefined?true:unknown(input.captureComplete)?U:input.captureComplete===true);
  add('$workflow','inventoryUnique',new Set(inventory.map(r=>r.id)).size===inventory.length);
  add('$workflow','factIdsUnique',new Set(arr(input.sourceJobs).map(r=>r.id)).size===arr(input.sourceJobs).length);
  add('$workflow','factsWithinInventory',arr(input.sourceJobs).every(r=>inventory.some(i=>i.id===r.id)));
  add('$workflow','runIdentity',input.runIdentity?.runId!==undefined&&input.runIdentity?.runAttempt!==undefined&&typeof input.runIdentity?.headSha==='string');
  for(const captured of inventory){const record=facts.get(captured.id);add(`capture:${captured.id}`,'recordCoverage',record?true:U);if(record){
    add(`capture:${captured.id}`,'inventoryIdentity',['runId','runAttempt','headSha'].some(k=>unknown(captured[k]))?U:['runId','runAttempt','headSha'].every(k=>captured[k]===input.runIdentity?.[k]));
    add(`capture:${captured.id}`,'recordIdentity',['runId','runAttempt','headSha'].some(k=>unknown(record[k]))?U:['runId','runAttempt','headSha'].every(k=>record[k]===input.runIdentity?.[k]));
    add(`capture:${captured.id}`,'recordName',unknown(record.name)?U:record.name===captured.name);
    add(`capture:${captured.id}`,'recordType',unknown(record.type)?U:record.type==='job');
    add(`capture:${captured.id}`,'recordStatus',unknown(record.status)?U:record.status==='completed');
    add(`capture:${captured.id}`,'recordState',['success','failure','cancelled','skipped','timed_out','action_required','neutral','startup_failure'].includes(record.conclusion)?true:U);
  }}
  function group(id){if(Object.hasOwn(states,id))return;const g=byId.get(id);if(g.parentGroup){group(g.parentGroup);if(Object.hasOwn(states,id))return;if(states[g.parentGroup]==='FALSE'){states[id]='FALSE';results[id]='skipped';return;}}g.needs.forEach(group);
    const ancestors=new Set();function ancestorsOf(n){for(const x of byId.get(n).needs){ancestors.add(x);ancestorsOf(x);}}ancestorsOf(id);
    const success=g.needs.every(n=>results[n]==='success')?true:g.needs.some(n=>['failure','cancelled','skipped'].includes(results[n]))?false:U;
    const failure=[...ancestors].some(n=>results[n]==='failure')?true:[...ancestors].some(n=>unknown(results[n]))?U:false;
    const status={success,failure,cancelled:input.workflowCancelled??U};const needs=Object.fromEntries(Object.entries(g.needsAliases??Object.fromEntries(g.needs.map(n=>[n,n]))).map(([alias,n])=>[alias,{result:results[n],outputs:U}]));
    const ctx={...input.eventContext,...(g.inputs?{inputs:g.inputs}:{}),needs};let active=evaluate(g.guard,ctx,{complete:input.eventContextComplete,partialRoots:['needs'],status});
    const expressionCode=typeof g.guard==='string'?g.guard.replace(/'(?:[^']|'')*'/g,"''"):'';
    if(typeof g.guard!=='string'||! /\b(success|failure|cancelled|always)\s*\(/i.test(expressionCode)){const t=truth(active);active=t===false||success===false?false:unknown(t)||unknown(success)?U:true;}
    active=truth(active);if(g.parentGroup&&states[g.parentGroup]==='UNKNOWN'&&active!==false)active=U;states[id]=unknown(active)?'UNKNOWN':active?'TRUE':'FALSE';add(id,'applicabilityResolved',unknown(active)?U:true,{applicability:states[id]});
    if(unknown(active))gateValues.push(U);
    if(active===false){const placeholder=render(g.placeholderName,ctx,{complete:input.eventContextComplete,partialRoots:['needs'],status});const matches=unknown(placeholder)?[]:inventory.filter(r=>r.name===placeholder);matches.forEach(r=>attributed.add(r.id));
      const owners=new Set(contract.instances.filter(i=>i.names.includes(placeholder)).map(i=>i.groupId));let uncertainOwner=false;
      for(const candidate of contract.jobGroups){const name=render(candidate.placeholderName,{...input.eventContext,...(candidate.inputs?{inputs:candidate.inputs}:{}),needs:{}},{complete:input.eventContextComplete,partialRoots:['needs']});if(unknown(name))uncertainOwner=true;else if(name===placeholder)owners.add(candidate.id);}
      const unique=owners.size===1&&owners.has(id)&&!uncertainOwner;
      add(id,'inactivePlaceholder',matches.length===0?true:matches.length===1&&unique?(unknown(facts.get(matches[0].id)?.conclusion)?U:facts.get(matches[0].id)?.conclusion==='skipped'):U);results[id]='skipped';return;}
    if(g.unsupported.length){add(id,'supported',U,{reasons:g.unsupported});if(active===true)gateValues.push(U);}
    let outcomes=[];
    if(g.children){g.children.forEach(group);outcomes.push(...g.children.map(child=>results[child]));}
    for(const instance of contract.instances.filter(i=>i.groupId===id)){
      const candidates=inventory.filter(r=>instance.names.includes(r.name));
      candidates.forEach(r=>attributed.add(r.id));
      const competing=contract.instances.filter(i=>i.names.some(n=>instance.names.includes(n)));
      const binding=candidates.length===1&&competing.length===1;add(instance.id,'binding',binding?true:U,{candidateIds:candidates.map(r=>r.id),expectedNames:instance.names});
      if(!binding){outcomes.push(U);if(active===true)gateValues.push(U);continue;}
      const record=facts.get(candidates[0].id);add(instance.id,'coverage',record?true:U);
      if(!record){outcomes.push(U);if(active===true)gateValues.push(U);continue;}
      add(instance.id,'runBinding',record.runId===undefined||record.runAttempt===undefined?U:record.runId===input.runIdentity?.runId&&record.runAttempt===input.runIdentity?.runAttempt);
      const c=record.conclusion;const known=['success','failure','cancelled','skipped','timed_out','action_required','neutral','startup_failure'].includes(c);add(instance.id,'state',known?true:U,{originalConclusion:unknown(c)?null:c});
      const tolerated=truth(evaluate(instance.continueOnError,{...ctx,matrix:instance.matrix},{complete:input.eventContextComplete,partialRoots:['needs'],status}));
      let accepted=c==='success'?true:c==='failure'?(unknown(tolerated)?U:tolerated):known?false:U;
      if(active===true)gateValues.push(accepted);
      add(instance.id,'outcome',accepted,{originalConclusion:unknown(c)?null:c,tolerated:unknown(tolerated)?'UNKNOWN':tolerated});outcomes.push(!known||c==='failure'&&unknown(tolerated)?U:c==='failure'&&tolerated===true?'success':c);
    }
    results[id]=outcomes.some(unknown)?U:outcomes.some(c=>['failure','timed_out','action_required','startup_failure'].includes(c))?'failure':outcomes.includes('cancelled')?'cancelled':outcomes.every(c=>c==='success')?'success':'skipped';
  }
  contract.jobGroups.forEach(g=>group(g.id));
  for(const captured of inventory)add(`capture:${captured.id}`,'sourceAttribution',attributed.has(captured.id)?true:U);
  const nonVacuity=input.claimScope==='test-execution'?(contract.instances.some(i=>states[i.groupId]==='TRUE')?true:contract.instances.some(i=>states[i.groupId]==='UNKNOWN')?U:false):true;
  add('$claim','outcome',nonVacuity,{predicate:'nonVacuity'});gateValues.push(nonVacuity);
  const structural=obligations.filter(o=>o.kind!=='outcome');const closure=structural.every(o=>o.value==='TRUE')?'CLOSED':'OPEN';
  const gate=gateValues.includes(false)?'UNSAT':gateValues.some(unknown)?'UNKNOWN':'SAT';const satisfied=gate==='SAT';
  return {closure,gate,satisfied,authorized:closure==='CLOSED'&&satisfied,nonVacuity,applicability:states,results,obligations};
}
