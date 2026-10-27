import {readFileSync} from 'node:fs';
import {compile,qualify} from '../native/index.mjs';
const inputs=JSON.parse(readFileSync(process.argv[2],'utf8'));
const outputs=inputs.map(c=>{try {const contract=compile(c.input);return {id:c.id,contract,qualification:qualify(c.input,contract)};}catch(e){return{id:c.id,error:e.message};}});
process.stdout.write(JSON.stringify(outputs));
