import {readFileSync} from 'node:fs';
import {compile,qualify} from './index.mjs';
try { const input=JSON.parse(readFileSync(process.argv[2],'utf8'));const contract=compile(input);console.log(JSON.stringify({contract,qualification:qualify(input,contract)},null,2)); }
catch(error){console.error(JSON.stringify({error:error.message}));process.exitCode=1;}
