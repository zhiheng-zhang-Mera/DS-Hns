'use strict'
const fs=require('node:fs'),path=require('node:path')
const {createCheckpointStore,verifyResume}=require('../../app/engineering/checkpoint.cjs')
const {computePlanDigest}=require('../../app/engineering/recovery-schema.cjs')
const [file,dir,arm,phase,fault]=process.argv.slice(2);const spec=JSON.parse(fs.readFileSync(file));const episodeId='safe-episode'
const emit=e=>process.stdout.write(JSON.stringify(e)+'\n')
async function ready(step,kind){emit({event:'fault-ready',step,kind});await new Promise(()=>setInterval(()=>{},1000))}
const store=createCheckpointStore({dir:path.join(dir,'checkpoints'),maxFiles:5})
const cursorFile=path.join(dir,'completion.json')
const plan={version:1,id:'safe-plan',goal:'ordered reversible append workload',intent:'contract',createdAt:1700000000000,steps:spec.steps.map(s=>({id:`step-${s.id}`,kind:'test',command:'fixture-append',args:[s.payload],source:'contract'})),budget:{maxSteps:32},reasons:[]}
function descriptor(next){return {version:1,episodeId,request:{workspace:dir,goal:plan.goal,startedAt:1700000000000,deadlineAt:1700086400000,contract:{maxSteps:32}},plan,planDigest:computePlanDigest(plan),cursor:{nextStepIndex:next,lastVerifiedStepId:next?`step-${next-1}`:null,verifiedStepIds:spec.steps.slice(0,next).map(s=>`step-${s.id}`),skippedStepIds:[]},fingerprint:{head:'fixed-fixture'},verifiedMutationIds:[],unresolvedMutationIds:[],executorCompatibility:'engineering-v1',workRoot:path.parse(dir).root,crossVolumeTemp:[],lifecycleState:'ACTIVE'}}
async function main(){
  let start=0
  if(phase==='first'&&arm==='checkpoint'){
    const saved=store.save({episodeId,workspace:dir,fingerprint:{head:'fixed-fixture'},cursor:{nextStepIndex:0},recovery:descriptor(0)})
    emit({event:'initial-checkpoint',step:0,ok:saved.ok});if(!saved.ok)throw Error(saved.reason)
  }else if(phase==='first'&&arm==='simple-journal'){
    fs.writeFileSync(cursorFile+'.tmp',JSON.stringify({next:0}));fs.renameSync(cursorFile+'.tmp',cursorFile)
    emit({event:'initial-checkpoint',step:0,ok:true})
  }
  if(phase==='resume'&&arm==='checkpoint'){
    const c=store.latest(episodeId);const gate=verifyResume({checkpoint:c,workspace:dir,fingerprint:{head:'fixed-fixture'}});emit({event:'resume-gate',...gate})
    if(!gate.ok)throw Error('production resume gate refused checkpoint')
    start=c.recovery.cursor.nextStepIndex
  }else if(phase==='resume'&&arm==='simple-journal')start=JSON.parse(fs.readFileSync(cursorFile)).next
  for(let i=start;i<spec.steps.length;i++){
    fs.appendFileSync(path.join(dir,'effects.jsonl'),JSON.stringify(spec.steps[i])+'\n');emit({event:'effect',step:i+1})
    if(phase==='first'&&fault==='gap'&&i+1===spec.faultStep)await ready(i+1,'effect-before-checkpoint')
    if(arm==='checkpoint'){
      const saved=store.save({episodeId,workspace:dir,fingerprint:{head:'fixed-fixture'},cursor:{nextStepIndex:i+1},recovery:descriptor(i+1)})
      emit({event:'checkpoint',step:i+1,ok:saved.ok,reason:saved.reason,bytes:saved.bytes});if(!saved.ok)throw Error(saved.reason)
    }else if(arm==='simple-journal'){fs.writeFileSync(cursorFile+'.tmp',JSON.stringify({next:i+1}));fs.renameSync(cursorFile+'.tmp',cursorFile)}
    if(phase==='first'&&fault==='boundary'&&i+1===spec.faultStep)await ready(i+1,'after-progress-persisted')
  }
  emit({event:'complete',step:spec.steps.length})
}
main().catch(e=>{console.error(e.stack);process.exitCode=1})
