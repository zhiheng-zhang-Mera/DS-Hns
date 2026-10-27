import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluate,U} from '../../../scripts/ecq-v38/native/index.mjs';
test('whole structures remain outside scalar comparison while properties and null work',()=>{const object={name:'linux'},array=[1,2],context={matrix:{object,other:{name:'linux'},array,fn:()=>true}};for(const expression of ['matrix.object == matrix.object','matrix.object != matrix.other','matrix.array == matrix.array','matrix.fn == matrix.fn'])assert.deepEqual(evaluate(expression,context),U,expression);assert.equal(evaluate("matrix.object.name == 'LINUX'",context),true);assert.equal(evaluate('null == null'),true);assert.equal(evaluate("'same' == 'same'"),true);});
