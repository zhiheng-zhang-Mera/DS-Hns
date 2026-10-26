'use strict'
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const os = require('node:os')
const { spawn, execFileSync } = require('node:child_process')
const ROOT = path.resolve(__dirname, '../..')
const CANDIDATE = '6ae4dbc083efff0c4c611ca4e7a1f69823c2ccb6'
const hash = b => crypto.createHash('sha256').update(b).digest('hex')
const json = p => JSON.parse(fs.readFileSync(p, 'utf8'))
function write(p, x) { fs.mkdirSync(path.dirname(p), { recursive:true }); fs.writeFileSync(p, JSON.stringify(x, null, 2)+'\n') }
function workload(seed) {
  let state = seed >>> 0
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state }
  const n = 8 + next()%9
  const faultStep = 1 + next()%(n-2)
  return { seed, faultStep, steps: Array.from({length:n}, (_,i) => ({id:i, payload: next().toString(16).padStart(8,'0')})) }
}
function oracle(w, effects) {
  const seen = new Set(effects.map(x=>x.id))
  const complete = w.steps.every(s=>effects.some(e=>e.id===s.id && e.payload===s.payload))
  const duplicateCount = effects.length-seen.size
  const ordered = effects.length===w.steps.length && effects.every((e,i)=>e.id===i && e.payload===w.steps[i].payload)
  return { complete, duplicateCount, duplicateFree: complete && ordered && duplicateCount===0, effectCount:effects.length }
}
function validateRows(rows, root, expected) {
  const ids = new Set(); const cells = new Set()
  for (const r of rows) {
    if(ids.has(r.episodeId)) throw Error('duplicate episode identity')
    ids.add(r.episodeId)
    const cell = `${r.experiment}/${r.scenario}/${r.seed}/${r.arm}`
    if(cells.has(cell))throw Error('duplicate seed/scenario/arm cell');cells.add(cell)
    if(!root)continue
    if(r.candidateSha!==CANDIDATE)throw Error('candidate mismatch')
    if(!r.driverSha || !r.configHash || !r.candidateTree)throw Error('missing provenance')
    if(!/^\d{4}-.*Z$/.test(r.startedAt) || !/^\d{4}-.*Z$/.test(r.endedAt) || Date.parse(r.endedAt)<Date.parse(r.startedAt))throw Error('invalid UTC timestamp')
    if(r.rawPath){ const p=path.resolve(root,r.rawPath); if(!p.startsWith(path.resolve(root)+path.sep))throw Error('unsafe raw path');if(!fs.existsSync(p)||hash(fs.readFileSync(p))!==r.rawHash)throw Error('raw digest mismatch') }
  }
  if(expected && rows.length!==expected)throw Error(`expected ${expected} rows, got ${rows.length}`)
  return true
}
function schedule(seed, scenario) {
  const jitter = seed%23
  if(scenario==='burst')return Array.from({length:8},(_,i)=>jitter+i*(7+seed%11))
  if(scenario==='spaced')return Array.from({length:8},(_,i)=>jitter+i*(1001+seed%19))
  return [0,1,2,999,1000,1001,1002,2003].map(x=>x+jitter)
}
function budgetEpisode(seed, scenario, arm) {
  const {createRestartBudget}=require('../../app/plugins/restart-supervisor/budget.cjs')
  let time = 0
  const base={budget:{maxRestarts:arm==='cap-off'?1000000:3,windowMs:1000,cooldownMs:0,backoffMs:0,backoffMaxMs:0},crashLoop:{safeModeOnLoop:false},history:{maxEntries:1000}}
  const b=createRestartBudget({config:base, now:()=>time})
  let accepted=[];const expected=[];const events=[]
  for(time of schedule(seed,scenario)){
    const oracleAllowed = expected.filter(t=>t>=time-1000).length<3
    if(oracleAllowed)expected.push(time)
    let allowed, code=null
    if(arm==='simple-window'){ allowed=accepted.filter(t=>time-t<=1000).length<3 }
    else {const r=b.evaluate({mode:'application'},time);allowed=r.ok;code=r.code||null;if(allowed){b.accept({mode:'application'},time);b.record({at:time,ok:false,counted:true})}}
    const overBudget=allowed&&accepted.filter(t=>t>=time-1000).length>=3
    if(allowed)accepted.push(time)
    events.push({atVirtualMs:time,allowed,code,oracleAllowed,overBudget})
  }
  return {config:base,events,accepted:accepted.length,overBudget:events.some(e=>e.overBudget),disagreements:events.filter(e=>e.allowed!==e.oracleAllowed).length}
}
async function childAttempt(dir, spec, arm, phase, python, fault) {
  const node=arm!=='langgraph-sqlite'
  const executable=node?process.execPath:python
  const args=[path.join(__dirname,node?'checkpoint-worker.cjs':'langgraph_worker.py'),path.join(dir,'spec.json'),dir,arm,phase,fault]
  const started=performance.now();const stdout=[];const stderr=[];let killedAt=null;let timeout=false;let handshake=null
  return await new Promise(resolve=>{
    const c=spawn(executable,args,{cwd:ROOT,windowsHide:true,env:{...process.env,TEMP:dir,TMP:dir,TMPDIR:dir,PYTHONUNBUFFERED:'1',LANGSMITH_TRACING:'false',LANGCHAIN_TRACING_V2:'false',LANGGRAPH_STRICT_MSGPACK:'true'}})
    let buffer=''
    const timer=setTimeout(()=>{timeout=true;c.kill('SIGKILL')},15000)
    c.stdout.on('data',data=>{const s=data.toString();stdout.push(s);buffer+=s;let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);try{const e=JSON.parse(line);if(e.event==='fault-ready'&&phase==='first'&&!handshake){handshake=e;killedAt=performance.now();c.kill('SIGKILL')}}catch{}}})
    c.stderr.on('data',d=>stderr.push(d.toString()))
    c.on('error',e=>stderr.push(String(e)))
    c.on('close',(code,signal)=>{clearTimeout(timer);resolve({phase,code,signal,timeout,handshake,ownedPid:c.pid,killedByRunner:killedAt!==null,elapsedMs:performance.now()-started,startedAt:new Date(Date.now()-(performance.now()-started)).toISOString(),endedAt:new Date().toISOString(),stdout:stdout.join(''),stderr:stderr.join('')})})
  })
}
async function checkpointEpisode(seed, scenario, arm, dir, python) {
  fs.mkdirSync(dir,{recursive:true}); const spec=workload(seed);write(path.join(dir,'spec.json'),spec)
  const attempts=[]
  attempts.push(await childAttempt(dir,spec,arm,'first',python,scenario))
  if(scenario!=='no-fault')attempts.push(await childAttempt(dir,spec,arm,'resume',python,scenario))
  const effectsFile=path.join(dir,'effects.jsonl');let effects=[];let parseError=null
  try{effects=fs.readFileSync(effectsFile,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)}catch(e){parseError=String(e)}
  const last=attempts.at(-1);const plannedKill=scenario==='no-fault'||attempts[0].handshake?.step===spec.faultStep
  const infrastructureError=parseError||(!plannedKill?'fault handshake missing':null)||attempts.some(a=>a.timeout)?'timeout/protocol/error':null
  const outcome=oracle(spec,effects)
  return {spec,attempts,effects,outcome,infrastructureError,completeProcessExit:last.code===0,recoveryMs:scenario==='no-fault'?null:last.elapsedMs,totalMs:attempts.reduce((a,b)=>a+b.elapsedMs,0)}
}
async function main(argv) {
  const mode=argv[0]||'pilot';const python=argv[1];if(!python)throw Error('usage: node safe-experiments.cjs pilot|campaign <python> <new-output-directory>')
  const out=path.resolve(argv[2]);if(fs.existsSync(out))throw Error('output directory exists; never overwrite a campaign')
  fs.mkdirSync(out,{recursive:true});const driverSha=execFileSync('git',['rev-parse','HEAD'],{cwd:ROOT,encoding:'utf8'}).trim()
  const candidateTree=execFileSync('git',['rev-parse',CANDIDATE+'^{tree}'],{cwd:ROOT,encoding:'utf8'}).trim()
  const count=mode==='pilot'?2:30;const seeds=Array.from({length:count},(_,i)=>mode==='pilot'?1001+i:1+i)
  const gapV2=mode==='gap-v2'
  const config={protocol:gapV2?'safe-v2-equal-initialization':'safe-v1',mode,seeds,budgetScenarios:gapV2?[]:['burst','spaced','window-edge'],checkpointScenarios:gapV2?['gap']:['no-fault','boundary','gap'],checkpointArms:['checkpoint','replay','simple-journal','langgraph-sqlite'],candidateSha:CANDIDATE,candidateTree,driverSha}
  const configHash=hash(JSON.stringify(config));write(path.join(out,'config.json'),config)
  const rows=[];const begin=Date.now();const append=(r)=>{rows.push(r);fs.appendFileSync(path.join(out,'attempts.jsonl'),JSON.stringify(r)+'\n')}
  for(const scenario of config.budgetScenarios)for(const seed of seeds){for(const arm of seed%2?['bounded','cap-off','simple-window']:['simple-window','cap-off','bounded']){
    const episodeId=`a3-${scenario}-${seed}-${arm}`;const startedAt=new Date().toISOString();const r=budgetEpisode(seed,scenario,arm);const rawPath=`raw/${episodeId}.json`;write(path.join(out,rawPath),r)
    append({episodeId,experiment:'A3',scenario,seed,arm,candidateSha:CANDIDATE,candidateTree,driverSha,configHash,startedAt,endedAt:new Date().toISOString(),rawPath,rawHash:hash(fs.readFileSync(path.join(out,rawPath))),accepted:r.accepted,overBudget:r.overBudget,disagreements:r.disagreements,status:'OBSERVED'})
  }}
  for(const scenario of config.checkpointScenarios)for(const seed of seeds){for(const arm of seed%2?config.checkpointArms:[...config.checkpointArms].reverse()){
    if(Date.now()-begin>30*60*1000)throw Error('campaign hard time budget reached')
    const episodeId=`a4-${scenario}-${seed}-${arm}`;const startedAt=new Date().toISOString();const dir=path.join(out,'episodes',episodeId)
    const r=await checkpointEpisode(seed,scenario,arm,dir,python);write(path.join(dir,'attempt.json'),r);const rawPath=`episodes/${episodeId}/attempt.json`
    append({episodeId,experiment:'A4',scenario,seed,arm,candidateSha:CANDIDATE,candidateTree,driverSha,configHash,startedAt,endedAt:new Date().toISOString(),rawPath,rawHash:hash(fs.readFileSync(path.join(out,rawPath))),...r.outcome,completeProcessExit:r.completeProcessExit,recoveryMs:r.recoveryMs,totalMs:r.totalMs,status:r.infrastructureError?'INFRASTRUCTURE_ERROR':'OBSERVED',infrastructureError:r.infrastructureError})
  }process.stdout.write(`completed ${scenario} seed ${seed}\n`) }
  validateRows(rows,out,seeds.length*(config.budgetScenarios.length*3+config.checkpointScenarios.length*4))
  write(path.join(out,'environment.json'),{node:process.version,python:execFileSync(python,['--version'],{encoding:'utf8'}).trim(),platform:process.platform,arch:process.arch,osRelease:os.release(),cpu:os.cpus()[0]?.model,cpuCount:os.cpus().length,driverSha,candidateSha:CANDIDATE,candidateTree,startedAt:new Date(begin).toISOString(),endedAt:new Date().toISOString(),newRows:rows.length})
  console.log(JSON.stringify({out,rows:rows.length,infrastructureErrors:rows.filter(r=>r.status!=='OBSERVED').length}))
}
module.exports={workload,oracle,validateRows,schedule,budgetEpisode,checkpointEpisode}
if(require.main===module)main(process.argv.slice(2)).catch(e=>{console.error(e);process.exitCode=1})
