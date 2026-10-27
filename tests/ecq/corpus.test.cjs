'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
test('grid exact membership and source-group split',()=>{
 const {buildPlan,FAMILIES}=require('../../scripts/ecq/corpus/build.cjs');
 const p=buildPlan(); assert.equal(p.filter(x=>x.split==='development').length,300);
 assert.equal(p.filter(x=>x.split==='evaluation').length,900);assert.equal(new Set(p.map(x=>x.caseId)).size,1200);
 for(const baseId of new Set(p.map(x=>x.baseId))){const rr=p.filter(x=>x.baseId===baseId);assert.equal(rr.length,15);assert.deepEqual(rr.map(x=>x.family).sort(),[...FAMILIES].sort());assert.equal(new Set(rr.map(x=>x.split)).size,1);}
 const counts=Object.groupBy(p.filter(x=>x.split==='evaluation'&&x.family==='pass'),x=>x.templateId);assert.deepEqual(Object.values(counts).map(x=>x.length),[10,10,10,10,10,10]);
});
test('mutation preserves contract requirements and opaque input identities',()=>{
 const {buildBaseBundle}=require('../../scripts/ecq/corpus/build.cjs');const {applyMutation}=require('../../scripts/ecq/corpus/mutations.cjs');
 const b=buildBaseBundle(100,'reuse');assert.equal(b.contract.runPolicy.allowedRunIds.length,2);
 const missing=applyMutation(b,'G');assert.deepEqual(missing.contract,b.contract);assert.equal(missing.bundle.evidence.length,b.bundle.evidence.length-1);
 const fail=applyMutation(b,'fail');assert.equal(fail.bundle.evidence[0].outcome,'FAIL');
 const er=applyMutation(b,'E');assert.equal(er.bundle.evidence[0].artifactRefs[0].availability,'MISSING');
 assert.ok(!JSON.stringify(er.bundle).includes('changeLedger'));assert.equal(er.bundle.evidence[0].artifactRefs[0].sha256,b.bundle.evidence[0].artifactRefs[0].sha256);
});
