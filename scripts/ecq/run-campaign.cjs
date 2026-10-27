'use strict';
// MIT. Finite offline runner. Verdict rejection is not an execution failure.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawn}=require('node:child_process'),readline=require('node:readline');
const {evaluateQualification,capabilities:full}=require('./evaluate.cjs');
const b0=require('./baselines/outcome-only.cjs'),b1=require('./baselines/manifest.cjs');
const sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function verifyFreeze(file,root=path.resolve(__dirname,'../..')){const f=JSON.parse(fs.readFileSync(file));for(const [p,h]of Object.entries(f.files)){if(sha(path.resolve(root,p))!==h)throw Error('Frozen file mismatch: '+p);}return f;}
function pythonService(python){
 const child=spawn(python,[path.join(__dirname,'baselines/shacl/run.py'),'--service'],{stdio:['pipe','pipe','pipe'],windowsHide:true});let queue=[],stderr='';child.stderr.on('data',x=>{stderr+=x});
 readline.createInterface({input:child.stdout}).on('line',line=>{const q=queue.shift();if(q){clearTimeout(q.timer);try{q.resolve({data:JSON.parse(line),stdout:line,stderr});stderr='';}catch(e){q.reject(e);}}});child.on('error',e=>{for(const q of queue)q.reject(e);queue=[]});child.on('exit',code=>{for(const q of queue)q.reject(Error('SHACL worker exit '+code+': '+stderr));queue=[]});
 return {call(req){return new Promise((resolve,reject)=>{let q={resolve,reject};q.timer=setTimeout(()=>{child.kill();reject(Error('SHACL 60-second timeout'));},60000);queue.push(q);child.stdin.write(JSON.stringify(req)+'\n');});},close(){child.stdin.end();}};
}
async function runCampaign({freeze,dataset='challenge',mode,methods=['B0','B1','B2','ECQ'],out,python=process.env.ECQ_PYTHON||'python',manifest:override}){
 const root=path.resolve(__dirname,'../..'),f=verifyFreeze(freeze,root),manifest=override?path.resolve(override):path.resolve(root,f.datasets[dataset]),rows=fs.readFileSync(manifest,'utf8').trim().split('\n').map(JSON.parse);
 if(fs.existsSync(path.join(out,'attempts.jsonl')))throw Error('Refusing overwrite of campaign');fs.mkdirSync(path.join(out,'raw'),{recursive:true});
 if(mode==='ablation')methods=['I_S','I_R','I_G','I_V','I_E','I_C','I_I','I_T'].map(x=>'ECQ-no-'+x);
 const campaignId=path.basename(path.resolve(out)),revision=f.methodRevision;
 fs.writeFileSync(path.join(out,'campaign.json'),JSON.stringify({campaignId,methodRevision:revision,methods,manifestPath:path.relative(out,manifest).replaceAll('\\','/'),manifestSha256:sha(manifest),freezeSha256:sha(freeze),startedAt:new Date().toISOString(),dataset,mode:mode||'primary',registeredCases:rows.length},null,2));
 const py=methods.includes('B2')?pythonService(python):null;let n=0;
 try{for(const row of rows){const bundle=JSON.parse(fs.readFileSync(path.resolve(path.dirname(manifest),row.bundlePath))),contract=JSON.parse(fs.readFileSync(path.resolve(path.dirname(manifest),row.contractPath))),artifactRoot=path.resolve(path.dirname(manifest),row.artifactRoot);
  // No family/template/oracle is passed to any method.
  for(const methodId of methods){let executionStatus='COMPLETED',exitCode=0,result=null,stdout='',stderr='',timings={},capabilities=methodId==='B0'?b0.capabilities:methodId==='B1'?b1.capabilities:full;const t=performance.now();
   try{if(methodId==='B2'){const r=await py.call({bundle,contract,artifacts:artifactRoot});({executionStatus,exitCode,result,timings}=r.data);stdout=r.stdout;stderr=r.stderr;}
    else{result=methodId==='B0'?b0(bundle,contract,artifactRoot):methodId==='B1'?b1(bundle,contract,artifactRoot):evaluateQualification(bundle,contract,artifactRoot,{disabledInvariants:methodId.startsWith('ECQ-no-')?[methodId.slice(7)]:[]});timings={end_to_end_ms:performance.now()-t};stdout=JSON.stringify(result);}
   }catch(e){executionStatus=/timeout/.test(e.message)?'TIMEOUT':'RUNTIME_ERROR';exitCode=2;stderr=e.stack;result=null;timings={end_to_end_ms:performance.now()-t};}
   const basename=`${row.caseId}-${methodId}-1`,stdoutPath=`raw/${basename}.stdout.json`,stderrPath=`raw/${basename}.stderr.txt`;fs.writeFileSync(path.join(out,stdoutPath),stdout);fs.writeFileSync(path.join(out,stderrPath),stderr);
   const attempt={campaignId,caseId:row.caseId,methodId,methodRevision:revision,attemptId:1,executionStatus,exitCode,capabilities,result,timings,stdoutPath,stderrPath};fs.appendFileSync(path.join(out,'attempts.jsonl'),JSON.stringify(attempt)+'\n');n++;
  }if(n%100===0)console.log(`${campaignId}: ${n} method outputs`);
 }}finally{py?.close();}fs.writeFileSync(path.join(out,'completion.json'),JSON.stringify({methodOutputs:n,completedAt:new Date().toISOString()},null,2));return n;
}
module.exports={verifyFreeze,runCampaign};
if(require.main===module){let a={};for(let i=2;i<process.argv.length;i+=2)a[process.argv[i].slice(2)]=process.argv[i+1];if(a.methods)a.methods=a.methods.split(',');runCampaign(a).then(n=>console.log('Completed '+n)).catch(e=>{console.error(e);process.exitCode=2});}
