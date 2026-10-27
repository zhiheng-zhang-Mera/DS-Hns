'use strict';
// MIT. Deterministic controlled packages; oracle labels are stored separately.
const crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
const TEMPLATES=['single','multi','matrix','dependent','reuse','nested'];
const FAMILIES=['pass','fail','unknown','S','R','G','V','E','C','I','T','SR','GV','EI','CT'];
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const value=(seed,label)=>hash(`${seed}\0${label}`);
function buildPlan(){let out=[];for(const [split,start,n] of [['development',100,20],['evaluation',10000,60]])for(let i=0;i<n;i++){const seed=start+i,templateId=TEMPLATES[i%6],baseId=value(seed,'base').slice(0,24);for(const family of FAMILIES)out.push({caseId:value(seed,`case:${family}`).slice(0,24),baseId,seed,templateId,split,sourceGroup:'controlled',family});}return out;}
function buildBaseBundle(seed,templateId){
 if(!TEMPLATES.includes(templateId))throw Error('unknown template');
 const subject={repositoryId:`fixture/${value(seed,'repo').slice(0,12)}`,commit:value(seed,'commit').slice(0,40),tree:value(seed,'tree').slice(0,40),configurationDigest:value(seed,'config'),dependencyLockDigest:value(seed,'lock')};
 const runId=value(seed,'run').slice(0,16),n=({single:1,multi:3,matrix:4,dependent:3,reuse:3,nested:4})[templateId];
 const requestedClaim=value(seed,'whole').slice(0,16),nodes=[requestedClaim],edges=[],requiredGates=[],evidence=[],artifacts={};
 let intermediate;if(templateId==='nested'){intermediate=value(seed,'intermediate').slice(0,16);nodes.push(intermediate);edges.push([intermediate,requestedClaim]);}
 for(let i=0;i<n;i++){const id=value(seed,`gate:${i}`).slice(0,16),claimId=value(seed,`claim:${i}`).slice(0,16),scope=`job:${id}`;nodes.push(claimId);edges.push([claimId,intermediate||requestedClaim]);requiredGates.push({id,claimId,scope,required:true,...(templateId==='dependent'&&i?{dependsOn:[requiredGates[i-1].id]}:{}),...(templateId==='matrix'?{matrix:{os:['linux','windows'][i%2],runtime:[22,24][Math.floor(i/2)]}}:{})});
 const bytes=Buffer.from(`qualified observation ${value(seed,`artifact:${i}`)}\n`),file=`files/${value(seed,`file:${i}`).slice(0,16)}.txt`,objectId=value(seed,`object:${i}`).slice(0,24);artifacts[file]=bytes;
 evidence.push({id:value(seed,`evidence:${i}`).slice(0,16),subject:{...subject},runId:templateId==='reuse'&&i===n-1?`${runId}-prior`:runId,gateId:id,claimId,scope,outcome:'PASS',evidenceType:'execution',provenance:'ci',artifactRefs:[{id:value(seed,`ref:${i}`).slice(0,16),path:file,objectId,expectedObjectId:objectId,sha256:hash(bytes)}]});}
 const contract={contractId:value(seed,'contract').slice(0,24),statePolicy:subject,runPolicy:{allowedRunIds:[runId,...(templateId==='reuse'?[`${runId}-prior`]:[])]},requiredGates,claimGraph:{nodes,edges},requestedClaim,admissibleTypes:{types:['execution'],provenance:['ci']}};
 return {bundle:{caseId:value(seed,'basecase').slice(0,24),evidence},contract,artifacts,constructionFacts:{seed,templateId}};
}
function generate(root){const {applyMutation}=require('./mutations.cjs');fs.mkdirSync(root,{recursive:true});let manifests={development:[],evaluation:[]},privateRows=[];const contentSeen=new Set();
 for(const row of buildPlan()){const base=buildBaseBundle(row.seed,row.templateId),c=applyMutation(base,row.family);c.bundle.caseId=row.caseId;const dest=path.join(root,row.split,row.caseId);fs.mkdirSync(dest,{recursive:true});fs.writeFileSync(path.join(dest,'bundle.json'),JSON.stringify(c.bundle));fs.writeFileSync(path.join(dest,'contract.json'),JSON.stringify(c.contract));for(const [f,b]of Object.entries(c.artifacts)){fs.mkdirSync(path.dirname(path.join(dest,f)),{recursive:true});fs.writeFileSync(path.join(dest,f),b);}
 const signature=hash(JSON.stringify([c.bundle.evidence,c.contract,Object.entries(c.artifacts).map(([k,v])=>[k,hash(v)])]));if(contentSeen.has(signature))throw Error('duplicate full input');contentSeen.add(signature);
 manifests[row.split].push({...row,bundlePath:`${row.caseId}/bundle.json`,contractPath:`${row.caseId}/contract.json`,artifactRoot:row.caseId});privateRows.push({...row,changeLedger:c.changeLedger});}
 for(const split of Object.keys(manifests))fs.writeFileSync(path.join(root,split,'manifest.jsonl'),manifests[split].map(x=>JSON.stringify(x)).join('\n')+'\n');
 fs.mkdirSync(path.join(root,'oracle'),{recursive:true});fs.writeFileSync(path.join(root,'oracle','construction.jsonl'),privateRows.map(x=>JSON.stringify(x)).join('\n')+'\n');return manifests;
}
module.exports={buildPlan,buildBaseBundle,generate,FAMILIES,TEMPLATES};
if(require.main===module){const root=process.argv[2]||'artifacts/paper-revision/ecq-v37/corpus';const m=generate(root);console.log(JSON.stringify(Object.fromEntries(Object.entries(m).map(([k,v])=>[k,v.length]))));}
