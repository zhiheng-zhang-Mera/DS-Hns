'use strict';
// Reconstructs three bounded historical mappings. R1 is a static policy
// comparison, R2 an archived whole-run report, R3 a stored measurement report.
// They are distinct evidence units and never enter controlled-case denominators.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const {normalizeDSHns}=require('./dshns.cjs');
const root=path.resolve(__dirname,'../../..'),out=path.join(root,'artifacts/paper-revision/ecq-v37/sources/dshns');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const git=(...args)=>execFileSync('git',args,{cwd:root,windowsHide:true});
const json=(p,obj)=>{fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,JSON.stringify(obj,null,2)+'\n');};
const gates=ids=>ids.map(id=>({id,claimId:`gate:${id}`,scope:`gate:${id}`,required:true}));
function archive(folder,name,bytes){fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(path.join(folder,name),bytes);return{path:name,objectId:`sha256:${hash(bytes)}`,expectedObjectId:`sha256:${hash(bytes)}`,sha256:hash(bytes)};}
function emit(id,record,mapping,notes,metadata){const folder=path.join(out,id);const normalized=normalizeDSHns(record,{...mapping,caseId:id});json(path.join(folder,'bundle.json'),normalized.bundle);json(path.join(folder,'contract.json'),normalized.contract);json(path.join(folder,'mapping-witnesses.json'),{...normalized,notes,metadata});return{id,bundlePath:`${id}/bundle.json`,contractPath:`${id}/contract.json`,artifactRoot:id,notes,metadata};}
function main(){
 const rows=[];
 // R1: inspect which suite assertions are present before the repair against the
 // explicit expanded coverage contract from the repair. PASS here means the
 // assertion is textually present, never that a test process was observed.
 const repair='8808e2f72f9631073f30dee7a1994f1c4541593b',before=git('rev-parse',`${repair}^`).toString().trim();
 const wb=git('show',`${before}:.github/workflows/verify.yml`),wa=git('show',`${repair}:.github/workflows/verify.yml`);
 const extract=buf=>{const match=buf.toString().match(/foreach \(\$suite in @\(([^]*?)\)\)/);if(!match)throw new Error('suite assertion set not found');return [...match[1].matchAll(/'([^']+)'/g)].map(m=>m[1].replace(/\\\./g,'.'));};
 const all=extract(wa),observed=extract(wb),subject={repositoryId:'zhiheng-zhang-Mera/DS-Hns',commit:before,tree:git('show','-s','--format=%T',before).toString().trim()};
 const r1folder=path.join(out,'R1'),r1ref=archive(r1folder,'workflow-before.yml',wb);archive(r1folder,'workflow-after.yml',wa);
 const r1run=`source-inspection:${before}`;
 const r1record={runId:r1run,gitSha:before,gitTree:subject.tree,passed:null,results:observed.map(id=>({id,runId:r1run,gitSha:before,gitTree:subject.tree,passed:true}))};
 const r1mapping={contractId:'historical-suite-coverage-profile',statePolicy:subject,runPolicy:{allowedRunIds:[r1run]},requiredGates:gates(all),evidenceType:'static-source-inspection',requestedClaim:'workflow:suite-assertion-membership',artifacts:Object.fromEntries(observed.map(id=>[id,r1ref])),contractSource:`${repair}:.github/workflows/verify.yml suite assertion list`};
 rows.push(emit('R1',r1record,r1mapping,['Retrospective static coverage comparison; no failed or green CI execution is asserted.','Source-inspection PASS means a suite assertion occurs in the before-workflow text. Missing expanded requirements are coverage diagnostics, not observed production failures.'],{repairCommit:repair,beforeCommit:before,requiredSuites:all.length,presentAssertions:observed.length,missingAssertions:all.filter(id=>!observed.includes(id))}));
 // R2: independent gate contract from the pinned runner definitions plus its
 // unconditional evidence-consistency virtual gate. All original outcomes kept.
 const measured='1a2fa2c4881cb7337f480c770b25337fd55b7654',run='2026-09-23T05-33-13-145Z-0c277af6';
 const original=fs.readFileSync(path.join(root,'artifacts/qualification/history',measured,run,'qualification-summary.json'));
 const summary=JSON.parse(original),runner=git('show',`${measured}:scripts/qualification-runner.cjs`);
 const required=[...runner.toString().matchAll(/\{ id: '([^']+)', mandatory: true/g)].map(m=>m[1]);
 if(!runner.toString().includes("id: 'evidence-consistency'"))throw new Error('virtual gate missing');required.push('evidence-consistency');
 const r2folder=path.join(out,'R2'),r2ref=archive(r2folder,'qualification-summary.json',original);archive(r2folder,'qualification-runner.cjs',runner);
 rows.push(emit('R2',summary,{statePolicy:{repositoryId:'zhiheng-zhang-Mera/DS-Hns',commit:measured,tree:summary.gitTree},runPolicy:{allowedRunIds:[run]},requiredGates:gates(required),artifacts:Object.fromEntries(summary.results.map(r=>[r.id,r2ref])),contractSource:`${measured}:scripts/qualification-runner.cjs definitions and virtual evidence-consistency gate`},['Archived report-level mapping; whole-run passed=false and UI 127/130 remain false.','Archive-object digest checks the stored summary bytes; no claim to rerun historical raw operations.'],{measuredCommit:measured,runId:run,summarySha256:hash(original),originalWholePassed:summary.passed,originalMandatoryFailures:summary.mandatoryFailures,originalEvidenceConsistency:summary.evidenceConsistency.code}));
 // R3: the observed artifact supplies measured code, distinct from the storage
 // commit. The archive-record run ID is explicitly a new record locator, not an
 // invented original experimental run identity.
 const phase=fs.readFileSync(path.join(root,'artifacts/qualification/task4-phase-c-summary.json')),phaseData=JSON.parse(phase),r3folder=path.join(out,'R3');
 const r3ref=archive(r3folder,'phase-c-summary.json',phase);archive(r3folder,'provenance-followup.md',fs.readFileSync(path.join(root,'artifacts/qualification/PAPER_PROVENANCE_FOLLOWUP.md')));
 const tree=git('show','-s','--format=%T',phaseData.gitSha).toString().trim(),recordId='archive-record:task4-phase-c-summary';
 const phaseRecord={runId:recordId,gitSha:phaseData.gitSha,gitTree:tree,passed:phaseData.status==='PASS',results:[{id:'phase-c-report',runId:recordId,gitSha:phaseData.gitSha,gitTree:tree,passed:phaseData.status==='PASS'}]};
 rows.push(emit('R3',phaseRecord,{statePolicy:{repositoryId:'zhiheng-zhang-Mera/DS-Hns',commit:phaseData.gitSha,tree},runPolicy:{allowedRunIds:[recordId]},requiredGates:gates(['phase-c-report']),evidenceType:'archived-measurement-report',requestedClaim:'report:phase-c-measured-state',artifacts:{'phase-c-report':r3ref},contractSource:'explicit report-level qualification of preserved Phase C measured-code metadata'},['This profile maps a stored measurement report to its measured code, not a new timing trial.','Archive-record locator is not claimed as the original measurement run. Historical storage commit 0bbd32e is recorded separately and is not substituted for measured code.'],{measuredCommit:phaseData.gitSha,storageCommit:'0bbd32e',repairCommit:'5afb25ca07c23d5535301d8ad9a504a6d108a80d',sourceReportStatus:phaseData.status,sourceReportRuns:phaseData.runs.length}));
 json(path.join(out,'historical-mappings.json'),{scope:'Three heterogeneous archival mapping cases, not independent new ECQ effectiveness trials.',cases:rows});
 fs.writeFileSync(path.join(out,'manifest.jsonl'),rows.map(r=>JSON.stringify({caseId:r.id,baseId:r.id,sourceGroup:'DS-Hns-history',split:'historical',family:'archival-mapping',bundlePath:r.bundlePath,contractPath:r.contractPath,artifactRoot:r.artifactRoot})).join('\n')+'\n');
 console.log(JSON.stringify(rows.map(r=>({case:r.id,metadata:r.metadata}))));
}
if(require.main===module)main();
module.exports={main};
