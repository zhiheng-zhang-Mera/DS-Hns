import test from 'node:test';
import assert from 'node:assert/strict';
import {qualify,U} from '../../../scripts/ecq-v38/native/index.mjs';
const fixture=policy=>({workflow:`jobs:\n  test:\n    continue-on-error: ${policy}`,workflowIdentity:{verified:true},runIdentity:{runId:1,runAttempt:1,headSha:'head'},captureInventory:[{id:1,name:'test',runId:1,runAttempt:1,headSha:'head'}],sourceJobs:[{id:1,name:'test',runId:1,runAttempt:1,headSha:'head',type:'job',status:'completed',conclusion:'failure'}]});
test('failure tolerance requires a typed Boolean policy, not truthiness',()=>{for(const policy of ["${{ 'yes' }}",'1',"${{ 1 }}","${{ 'false' }}","${{ null }}"]){const q=qualify(fixture(policy));assert.equal(q.gate,'UNKNOWN',policy);assert.equal(q.authorized,false,policy);assert.deepEqual(q.results.test,U);}});
test('Boolean failure tolerance remains supported',()=>{assert.equal(qualify(fixture('true')).authorized,true);assert.equal(qualify(fixture('${{ true }}')).authorized,true);assert.equal(qualify(fixture('false')).gate,'UNSAT');});
