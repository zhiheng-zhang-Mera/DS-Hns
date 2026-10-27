import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluate,qualify,compile,U} from '../../../scripts/ecq-v38/native/index.mjs';
test('ASCII context keys are case insensitive and absent top roots stay unknown',()=>{
 assert.equal(evaluate("GITHUB.EVENT_NAME == 'push'",{github:{event_name:'push'}},{complete:true}),true);
 assert.equal(evaluate("github['EVENT_NAME'] == 'push'",{github:{event_name:'push'}}),true);
 assert.deepEqual(evaluate('absent.flag',{github:{}},{complete:true}),U);
 assert.equal(evaluate('MATRIX.absent',{matrix:{}}),null);
 assert.deepEqual(evaluate('NEEDS.first.outputs.flag',{needs:{first:{outputs:U}}},{complete:true,partialRoots:['needs']}),U);
 assert.deepEqual(evaluate('github.event_name',{github:{event_name:'push',EVENT_NAME:'pull_request'}},{complete:true}),U);
});
test('mixed-case active guard cannot authorize absent evidence',()=>{
 const input={workflow:"jobs:\n  test:\n    if: github.EVENT_NAME == 'push'",workflowIdentity:{verified:true},eventContext:{github:{event_name:'push'}},eventContextComplete:true,runIdentity:{runId:1,runAttempt:1,headSha:'head'},captureInventory:[],sourceJobs:[]};
 assert.equal(qualify(input).applicability.test,'TRUE');assert.equal(qualify(input).authorized,false);
});
test('bounded string comparisons refuse uncertain non-ASCII case rules',()=>{
 assert.equal(evaluate("'é' == 'é'"),true);
 assert.deepEqual(evaluate("'é' == 'É'"),U);
 assert.deepEqual(evaluate("'ı' == 'I'"),U);
 assert.deepEqual(evaluate("'０' == 0"),U);
 assert.deepEqual(evaluate("contains('é','É')"),U);
 assert.deepEqual(evaluate("startsWith('é','É')"),U);
});
test('implicit structured matrix display names remain unresolved',()=>{
 const c=compile({workflow:'jobs:\n  test:\n    strategy:\n      matrix:\n        os: [{name: linux}]'});
 assert.deepEqual(c.instances[0].names,[]);assert.ok(c.unresolvedFeatures.length>0);
});
