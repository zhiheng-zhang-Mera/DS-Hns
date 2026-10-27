import test from 'node:test';
import assert from 'node:assert/strict';
import {qualify} from '../../../scripts/ecq-v38/native/index.mjs';
function input(id){const identity={id,name:'test',runId:9,runAttempt:1,headSha:'head'};return {workflow:'jobs:\n  test:\n    runs-on: ubuntu-latest',workflowIdentity:{verified:true},runIdentity:{runId:9,runAttempt:1,headSha:'head'},captureInventory:[{...identity}],sourceJobs:[{...identity,type:'job',status:'completed',conclusion:'success'}]};}
test('capture and payload identity cannot be null missing empty or Boolean',()=>{
 for(const id of [null,undefined,'',false,true,0,-1,1.5,9007199254740992]){const i=input(id);if(id===undefined){delete i.captureInventory[0].id;delete i.sourceJobs[0].id;}assert.equal(qualify(i).authorized,false,String(id));}
});
test('positive integer and nonempty string record IDs remain valid',()=>{for(const id of [1,Number.MAX_SAFE_INTEGER,'job-1'])assert.equal(qualify(input(id)).authorized,true);});
test('captured name and immutable run header require typed nonempty schema',()=>{
 for(const [field,value]of [['name',''],['runId',null],['runAttempt',false],['headSha','']]){const i=input(1);i.captureInventory[0][field]=value;i.sourceJobs[0][field]=value;if(field!=='name')i.runIdentity[field]=value;assert.equal(qualify(i).authorized,false,field);}
});
test('fixed valid inventory cannot bind payload whose id was erased',()=>{const i=input(1);delete i.sourceJobs[0].id;assert.equal(qualify(i).authorized,false);});
