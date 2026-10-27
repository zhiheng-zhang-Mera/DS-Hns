#!/usr/bin/env node
'use strict';
// Workers isolate each method/configuration's RSS high-water mark. The parent
// rotates persistent workers per round; no worker is restarted for a rule sample.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {fork}=require('node:child_process');
const {performance}=require('node:perf_hooks');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function buildFixture(root,gates,totalBytes){
 if(!Number.isSafeInteger(gates)||gates<1||!Number.isSafeInteger(totalBytes)||totalBytes<gates)throw new Error('Invalid benchmark scale');
 const artifactRoot=path.join(root,'artifacts');fs.mkdirSync(artifactRoot,{recursive:true});
 const subject={repositoryId:'benchmark/fixture',commit:'b'.repeat(40),tree:'c'.repeat(40),configurationDigest:'configuration',dependencyLockDigest:'lock'};
 const contract={contractId:`scale-${gates}-${totalBytes}`,statePolicy:subject,runPolicy:{allowedRunIds:['scale-run']},requiredGates:[],claimGraph:{nodes:['whole'],edges:[]},requestedClaim:'whole',admissibleTypes:{types:['execution'],provenance:['fixture']}};
 const bundle={caseId:'scale-fixture',evidence:[]};
 for(let i=0;i<gates;i++){
  const id=`gate-${i}`,length=Math.floor(totalBytes/gates)+(i<totalBytes%gates?1:0),bytes=Buffer.alloc(length,i%251),file=`${id}.bin`,digest=hash(bytes);
  fs.writeFileSync(path.join(artifactRoot,file),bytes);
  contract.requiredGates.push({id,claimId:id,scope:'component',required:true});contract.claimGraph.nodes.push(id);contract.claimGraph.edges.push([id,'whole']);
  bundle.evidence.push({id:`e-${i}`,subject:{...subject},runId:'scale-run',gateId:id,claimId:id,scope:'component',outcome:'PASS',evidenceType:'execution',provenance:'fixture',artifactRefs:[{id:'a',path:file,objectId:id,expectedObjectId:id,sha256:digest}]});
 }
 const bundlePath=path.join(root,'bundle.json'),contractPath=path.join(root,'contract.json');fs.writeFileSync(bundlePath,JSON.stringify(bundle));fs.writeFileSync(contractPath,JSON.stringify(contract));
 return {bundle,contract,artifactRoot,bundlePath,contractPath,totalBytes,gates};
}
const methods={B0:()=>require('./baselines/outcome-only.cjs'),B1:()=>require('./baselines/manifest.cjs'),ECQ:()=>require('./evaluate.cjs').evaluateQualification};
function worker(){
 const [methodId,bundlePath,contractPath,artifactRoot]=process.argv.slice(3),evaluate=methods[methodId]();
 const {resolveArtifact}=require('./resolver.cjs');
 const bundleText=fs.readFileSync(bundlePath,'utf8'),contractText=fs.readFileSync(contractPath,'utf8');
 process.on('message',message=>{
  if(message.command==='close'){process.disconnect();return;}
  try{
   let start=performance.now();const bundle=JSON.parse(bundleText),contract=JSON.parse(contractText),normalize_ms=performance.now()-start;
   // Shared resolver facts are prepared outside the rule-only timing interval.
   const facts=new Map();for(const e of bundle.evidence)for(const ref of e.artifactRefs)facts.set(ref.path,resolveArtifact(ref,artifactRoot));
   start=performance.now();const ruleResult=evaluate(bundle,contract,ref=>facts.get(ref.path)),rule_ms=performance.now()-start;
   // E2E includes decoding and, for methods that inspect them, real reads/hashes.
   start=performance.now();const endResult=evaluate(JSON.parse(bundleText),JSON.parse(contractText),ref=>resolveArtifact(ref,artifactRoot)),end_to_end_ms=performance.now()-start;
   process.send({id:message.id,normalize_ms,rule_ms,end_to_end_ms,peak_rss_bytes:process.resourceUsage().maxRSS*1024,authorizePass:endResult.authorizePass,ruleAuthorizePass:ruleResult.authorizePass});
  }catch(error){process.send({id:message.id,error:error.stack});}
 });
 process.send({ready:true});
}
function startWorker(methodId,fixture){return new Promise((resolve,reject)=>{
 const start=performance.now(),child=fork(__filename,['--worker',methodId,fixture.bundlePath,fixture.contractPath,fixture.artifactRoot],{windowsHide:true,stdio:['ignore','ignore','pipe','ipc']});let error='';child.stderr.on('data',b=>{error+=b;});
 const timeout=setTimeout(()=>{child.kill();reject(new Error('Benchmark worker startup timeout'));},30000);
 child.once('error',reject);child.once('exit',code=>{if(code)reject(new Error(`Worker ${methodId} exit ${code}: ${error}`));});
 child.once('message',message=>{clearTimeout(timeout);if(!message.ready)return reject(new Error('Unexpected benchmark handshake'));let next=0;resolve({child,startup_ms:performance.now()-start,measure:()=>new Promise((done,fail)=>{const id=next++;const timer=setTimeout(()=>{child.kill();fail(new Error('Measurement timeout'));},120000);child.once('message',value=>{clearTimeout(timer);value.error?fail(new Error(value.error)):done(value);});child.send({id,command:'measure'});})});});
 });}
async function runBenchmark(options={}){
 const {out,gates=[10,100,1000],sizes=[1048576,67108864],warmups=5,rounds=30,methods:methodIds=['B0','B1','ECQ']}=options;
 if(!out)throw new Error('Output directory required');if(fs.existsSync(path.join(out,'measurements.jsonl')))throw new Error('Refusing benchmark overwrite');fs.mkdirSync(out,{recursive:true});
 const rows=[],startups=[],warmupRows=[];
 const config={gates,sizes,warmups,rounds,methods:methodIds,cachePolicy:'OS cache uncontrolled; 5 warmups by default; resolver facts rebuilt each sample; E2E reopens and hashes all inspected artifacts',normalizationDefinition:'JSON decoding of the normalized bundle and contract, not source adaptation',rssDefinition:'OS-reported cumulative process peak RSS, isolated method/configuration worker, sampled after both timed stages',startupDefinition:'parent fork to IPC ready; separate from persistent-process rule/E2E samples',environment:{platform:process.platform,arch:process.arch,node:process.version,cpus:os.cpus()[0]?.model,logicalCpus:os.cpus().length,totalMemoryBytes:os.totalmem()}};
 fs.writeFileSync(path.join(out,'config.json'),JSON.stringify(config,null,2)+'\n');
 for(const gateCount of gates)for(const byteCount of sizes){
  const fixtureDir=path.join(out,`fixture-${gateCount}-${byteCount}`),fixture=buildFixture(fixtureDir,gateCount,byteCount),workers={};
  try{
   for(const methodId of methodIds){if(!methods[methodId])throw new Error(`Unsupported method ${methodId}`);workers[methodId]=await startWorker(methodId,fixture);startups.push({methodId,gates:gateCount,artifact_bytes:byteCount,startup_ms:workers[methodId].startup_ms});}
   for(let index=-warmups;index<rounds;index++){
    const rotation=((index+warmups)%methodIds.length),ordered=methodIds.slice(rotation).concat(methodIds.slice(0,rotation));
    // Formal rounds always begin at canonical order; then rotate each round.
    const order=index>=0?methodIds.slice(index%methodIds.length).concat(methodIds.slice(0,index%methodIds.length)):ordered;
    for(const methodId of order){const value=await workers[methodId].measure();delete value.id;const sample={methodId,gates:gateCount,artifact_bytes:byteCount,round:index,...value};if(index>=0)rows.push(sample);else warmupRows.push(sample);}
   }
  }finally{for(const value of Object.values(workers)){value.child.send({command:'close'});await new Promise(resolve=>value.child.once('exit',resolve));}}
 }
 fs.writeFileSync(path.join(out,'warmups.jsonl'),warmupRows.map(r=>JSON.stringify(r)).join('\n')+'\n');fs.writeFileSync(path.join(out,'measurements.jsonl'),rows.map(r=>JSON.stringify(r)).join('\n')+'\n');fs.writeFileSync(path.join(out,'startup.json'),JSON.stringify(startups,null,2)+'\n');
 return {rows,startups,config};
}
if(require.main===module){if(process.argv[2]==='--worker')worker();else{const i=process.argv.indexOf('--out');runBenchmark({out:i<0?null:process.argv[i+1]}).then(r=>process.stdout.write(JSON.stringify({measurements:r.rows.length,startups:r.startups.length})+'\n')).catch(e=>{console.error(e);process.exitCode=2;});}}
module.exports={buildFixture,runBenchmark};
