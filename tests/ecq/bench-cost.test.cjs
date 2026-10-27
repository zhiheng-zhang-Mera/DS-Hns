const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
test('cost campaign archives warmup observations separately from formal rounds',async()=>{
 const {runBenchmark}=require('../../scripts/ecq/bench_cost.cjs');const td=fs.mkdtempSync(path.join(os.tmpdir(),'ecq-cost-'));
 try{await runBenchmark({out:td,gates:[2],sizes:[16],warmups:2,rounds:1,methods:['B0']});const formal=fs.readFileSync(path.join(td,'measurements.jsonl'),'utf8').trim().split('\n').map(JSON.parse),warm=fs.readFileSync(path.join(td,'warmups.jsonl'),'utf8').trim().split('\n').map(JSON.parse);assert.equal(formal.length,1);assert.equal(warm.length,2);assert.deepEqual(warm.map(r=>r.round),[-2,-1]);assert.ok(formal[0].peak_rss_bytes>0);}finally{fs.rmSync(td,{recursive:true,force:true});}
});
