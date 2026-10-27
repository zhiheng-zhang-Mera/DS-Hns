import {readFileSync,writeFileSync} from 'node:fs';
import {compile,qualify} from '../native/index.mjs';
const input=JSON.parse(readFileSync(process.argv[2],'utf8'));
const contract=compile(input),original=qualify(input,contract);
const rows=[];
if(input.sourceJobs.length!==12)throw new Error('Expected frozen 12-record erasure domain');
for(let mask=0;mask<4096;mask++){
  const x={...input,sourceJobs:input.sourceJobs.filter((_,i)=>(mask&(1<<i))===0)};
  const q=qualify(x,contract);
  rows.push({mask,retained:x.sourceJobs.length,closure:q.closure,gate:q.gate,authorized:q.authorized,gain:q.authorized&&!original.authorized});
}
writeFileSync(process.argv[3],JSON.stringify({contract,original,rows},null,2)+'\n');
