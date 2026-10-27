import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluate,compile,U} from '../../../scripts/ecq-v38/native/index.mjs';
import {render} from '../../../scripts/ecq-v38/native/expressions.mjs';
test('loose numeric casts outside bounded intersection remain UNKNOWN',()=>{
 for(const e of ["'0b10' == 2","'0b10' != 2","'0Xff' == 255","'0xffffffff' == 4294967295","'0xffffffff' == -1","'Infinity' == 0","'bad' == 0","'1_0' == 10","0xffffffff == -1","1e999 == 0","-'bad' == 0"]){assert.deepEqual(evaluate(e),U,e);}
});
test('bounded decimal, lowercase small hex/octal, null and Boolean casts remain supported',()=>{
 for(const e of ["' ' == 0","'' == 0","'1.25e2' == 125","'-2.5' == -2.5","'0xff' == 255","'0o17' == 15","'0x7fffffff' == 2147483647","false == 0","null == 0"]){assert.equal(evaluate(e),true,e);}
});
test('noninteger and unstable numeric rendering remain unresolved',()=>{
 assert.deepEqual(render('${{ matrix.x }}',{matrix:{x:1.5}}),U);
 assert.deepEqual(evaluate("format('{0}', matrix.x)",{matrix:{x:1.5}}),U);
 for(const source of ['jobs:\n  test:\n    strategy:\n      matrix:\n        x: [1.5]','jobs:\n  test:\n    name: Value ${{ matrix.x }}\n    strategy:\n      matrix:\n        x: [1.5]']){assert.deepEqual(compile({workflow:source}).instances[0].names,[]);}
});
test('all numeric scalar facts are bounded before comparison and truth identity',()=>{
 assert.deepEqual(evaluate('matrix.x',{matrix:{x:9007199254740992}}),U);
 for(const e of ['9007199254740992 == 9007199254740993','9007199254740992 != 9007199254740993',"'9007199254740992' == 9007199254740992",'matrix.x == 1','matrix.x != 1','matrix.x == matrix.x','!matrix.x']){assert.deepEqual(evaluate(e,{matrix:{x:9007199254740992}}),U,e);}
 assert.equal(evaluate('9007199254740991 == 9007199254740991'),true);
 assert.equal(evaluate('1.5 == 1.5'),true);
});
