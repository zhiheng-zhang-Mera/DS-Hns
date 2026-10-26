'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const target = path.resolve(__dirname, '../../scripts/paper-revision/safe-experiments.cjs')
test('safe experiment runner exposes seeded workload, independent oracle, and ledger validator', () => {
  assert.equal(fs.existsSync(target), true, 'missing experiment runner')
  const x = require(target)
  const a = x.workload(12)
  assert.deepEqual(a, x.workload(12))
  assert.ok(a.steps.length >= 8 && a.steps.length <= 16)
  assert.ok(a.faultStep > 0 && a.faultStep < a.steps.length)
  assert.equal(x.oracle(a, a.steps).duplicateFree, true)
  assert.equal(x.oracle(a, [a.steps[0], ...a.steps]).duplicateFree, false)
  assert.equal(x.oracle(a, a.steps.slice(1)).complete, false)
  assert.throws(() => x.validateRows([{episodeId:'x'}, {episodeId:'x'}]), /duplicate/)
})
test('bounded production budget and independent rolling-window baseline match across fixed schedules',()=>{
  const x=require(target)
  for(const scenario of ['burst','spaced','window-edge'])for(let seed=1;seed<=30;seed++){
    const a=x.budgetEpisode(seed,scenario,'bounded'),b=x.budgetEpisode(seed,scenario,'simple-window')
    assert.equal(a.disagreements,0);assert.equal(b.disagreements,0)
    assert.deepEqual(a.events.map(e=>e.allowed),b.events.map(e=>e.allowed))
  }
  assert.equal(x.budgetEpisode(1,'burst','cap-off').overBudget,true)
  assert.equal(x.budgetEpisode(1,'spaced','cap-off').overBudget,false)
})
test('ledger rejects provenance errors but retains scientifically negative observations',()=>{
  const x=require(target);const os=require('node:os'),crypto=require('node:crypto')
  const root=fs.mkdtempSync(path.join(process.env.TEMP||os.tmpdir(),'safe-ledger-'))
  try{
    fs.writeFileSync(path.join(root,'raw.json'),'{}')
    const r={episodeId:'x',experiment:'A4',scenario:'gap',seed:1,arm:'checkpoint',candidateSha:'6ae4dbc083efff0c4c611ca4e7a1f69823c2ccb6',driverSha:'a'.repeat(40),candidateTree:'b'.repeat(40),configHash:'c'.repeat(64),startedAt:'2026-10-26T10:00:00.000Z',endedAt:'2026-10-26T10:00:01.000Z',rawPath:'raw.json',rawHash:crypto.createHash('sha256').update('{}').digest('hex'),duplicateFree:false}
    assert.equal(x.validateRows([r],root,1),true)
    assert.throws(()=>x.validateRows([{...r,candidateSha:'wrong'}],root,1),/candidate/)
    assert.throws(()=>x.validateRows([{...r,startedAt:'localtime'}],root,1),/timestamp/)
    assert.throws(()=>x.validateRows([{...r,rawHash:'wrong'}],root,1),/digest/)
    assert.throws(()=>x.validateRows([{...r,rawPath:'absent.json'}],root,1),/digest/)
    assert.throws(()=>x.validateRows([r],root,2),/expected/)
  }finally{fs.rmSync(root,{recursive:true,force:true})}
})
