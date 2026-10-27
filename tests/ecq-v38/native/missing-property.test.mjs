import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluate,qualify,U} from '../../../scripts/ecq-v38/native/index.mjs';
import {render} from '../../../scripts/ecq-v38/native/expressions.mjs';
test('owned platform probes confirm missing scalar null and empty rendering',()=>{
  assert.equal(evaluate('matrix.absent',{matrix:{}}),null);
  assert.equal(evaluate("matrix.absent == '0'",{matrix:{}}),true);
  assert.equal(evaluate("matrix.absent == ''",{matrix:{}}),true);
  assert.equal(evaluate("github.absent == '0'",{github:{}},{complete:true}),true);
  assert.equal(evaluate("'' == '0'"),false);
  assert.equal(render('${{ matrix.absent }}',{matrix:{}}),'');
  assert.deepEqual(evaluate('github.absent',{github:{}}),U);
  assert.equal(evaluate('null'),null);
  assert.equal(evaluate("null == '0'"),true);
});
test('owned matrix probe confirms missing-null zero-string equality tolerates raw failure',()=>{
  const input={workflow:"jobs:\n  test:\n    strategy:\n      matrix:\n        x: [1]\n    continue-on-error: ${{ matrix.absent == '0' }}",workflowIdentity:{verified:true},runIdentity:{runId:9,runAttempt:1,headSha:'head'},captureInventory:[{id:1,name:'test (1)',runId:9,runAttempt:1,headSha:'head'}],sourceJobs:[{id:1,name:'test (1)',runId:9,runAttempt:1,headSha:'head',status:'completed',type:'job',conclusion:'failure'}]};
  const q=qualify(input);assert.equal(q.gate,'SAT');assert.equal(q.authorized,true);
  assert.equal(q.obligations.find(o=>o.slot==='test[0]'&&o.kind==='outcome').originalConclusion,'failure');
});
