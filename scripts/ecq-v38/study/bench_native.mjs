import {performance} from 'node:perf_hooks';
import {compile,qualify} from '../native/index.mjs';
const rounds=30,warmups=5,budgetMs=180000,rows=[];
for(const size of [1,10,100,256]){
 const axes=Array.from({length:size},(_,i)=>i);
 const workflow=`jobs:\n  test:\n    strategy:\n      matrix:\n        axis: [${axes.join(', ')}]\n`;
 const jobs=axes.map(i=>({id:i+1,name:`test (${i})`,conclusion:'success',status:'completed',type:'job',runId:19,runAttempt:1,headSha:'controlled-source'}));
 const input={workflow,workflowIdentity:{commit:'controlled-source',path:'workflow.yml',verified:true},runIdentity:{runId:19,runAttempt:1,headSha:'controlled-source'},captureInventory:jobs.map(({id,name,runId,runAttempt,headSha})=>({id,name,runId,runAttempt,headSha})),sourceJobs:jobs};
 const start=performance.now();let completed=0;
 for(let i=-warmups;i<rounds;i++){
  if(performance.now()-start>budgetMs)break;
  const t0=performance.now(),contract=compile(input),t1=performance.now(),decision=qualify(input,contract),t2=performance.now();
  if(!decision.authorized)throw Error('cost fixture unexpectedly rejected');
  if(i>=0){rows.push({size,round:i,compileMs:t1-t0,qualifyIncludingRecompileMs:t2-t1,totalMs:t2-t0,processRssBytes:process.memoryUsage().rss});completed++;}
 }
 if(completed!==rounds)rows.push({size,censored:true,completed,target:rounds,budgetMs});
}
process.stdout.write(JSON.stringify({runtime:process.version,platform:process.platform,warmups,rounds,budgetMs,rows}));
