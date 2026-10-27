import test from 'node:test';
import assert from 'node:assert/strict';
import {qualify,U} from '../../../scripts/ecq-v38/native/index.mjs';
const fixture=()=>({workflow:'jobs:\n  test:\n    if: false',workflowIdentity:{verified:true},runIdentity:{runId:1,runAttempt:1,headSha:'head'},captureInventory:[],sourceJobs:[]});
test('unrecognized claim scopes cannot silently acquire conformity authorization',()=>{for(const claimScope of [null,'','test-exection','other',false,{}]){const i=fixture();i.claimScope=claimScope;assert.equal(qualify(i).authorized,false,String(claimScope));}});
test('frame flags have explicit Boolean or declared UNKNOWN types',()=>{for(const field of ['eventContextComplete','captureComplete','workflowCancelled'])for(const value of ['false','true',0,1,null,{},[]]){const i=fixture();i[field]=value;assert.equal(qualify(i).authorized,false,field+'/'+String(value));}});
test('supported frame flags and default/conformity scope remain accepted',()=>{for(const claimScope of [undefined,'workflow-conformity']){const i=fixture();i.claimScope=claimScope;i.eventContextComplete=false;i.captureComplete=true;i.workflowCancelled=false;assert.equal(qualify(i).authorized,true);}const i=fixture();i.workflowCancelled=U;assert.equal(qualify(i).authorized,true);i.eventContextComplete=U;assert.equal(qualify(i).authorized,false);});
