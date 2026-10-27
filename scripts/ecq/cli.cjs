#!/usr/bin/env node
'use strict';
const fs=require('node:fs');const {evaluateQualification}=require('./evaluate.cjs');
function main(argv){
 const args={};for(let i=0;i<argv.length;i+=2){if(!argv[i]?.startsWith('--')||!argv[i+1])throw new Error('Expected --bundle --contract --artifacts --out');args[argv[i].slice(2)]=argv[i+1];}
 for(const key of ['bundle','contract','artifacts','out'])if(!args[key])throw new Error(`Missing --${key}`);
 const bundle=JSON.parse(fs.readFileSync(args.bundle,'utf8')),contract=JSON.parse(fs.readFileSync(args.contract,'utf8'));
 const result=evaluateQualification(bundle,contract,args.artifacts);fs.writeFileSync(args.out,JSON.stringify(result,null,2)+'\n');return result;
}
if(require.main===module){try{main(process.argv.slice(2));}catch(error){process.stderr.write(JSON.stringify({executionStatus:'RUNTIME_ERROR',error:error.message})+'\n');process.exitCode=2;}}
module.exports={main};
