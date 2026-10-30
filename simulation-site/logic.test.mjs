import {test} from 'node:test';
import assert from 'node:assert/strict';
import {selfTests} from './dist/logic.mjs';
for(const result of selfTests())test(result.name,()=>assert.equal(result.pass,true,result.error));
