import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync,mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const mutations=[
  {name:'counts calculated after LIMIT 100',from:'const candidateRows=store.candidates();',to:'const candidateRows=store.candidates().slice(0,100);',test:'counts precede truncation'},
  {name:'default account substituted for scheduling source',from:'const row=store.latestObservation(source);',to:'const row=store.latestObservation(config.observation.defaultAccountId);',test:'uses selected Lite'},
  {name:'internal assignment returned without whitelist',from:'assignment:publicAssignment(decision.assignment)',to:'assignment:decision.assignment',test:'recursively excludes'}
];
for(const mutation of mutations)test(`T5 mutation is detected: ${mutation.name}`,t=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'pilot-t5-mutation-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  cpSync(path.join(root,'src'),path.join(dir,'src'),{recursive:true});mkdirSync(path.join(dir,'test'));cpSync(path.join(root,'test','t5-scheduling-view.test.mjs'),path.join(dir,'test','t5-scheduling-view.test.mjs'));
  const file=path.join(dir,'src','scheduling-view.mjs'),source=readFileSync(file,'utf8');assert.ok(source.includes(mutation.from));writeFileSync(file,source.replace(mutation.from,mutation.to));
  const env={...process.env};delete env.NODE_TEST_CONTEXT;const result=spawnSync(process.execPath,['--test',`--test-name-pattern=${mutation.test}`,'test/t5-scheduling-view.test.mjs'],{cwd:dir,env,encoding:'utf8',windowsHide:true,timeout:30000});
  assert.equal(result.error,undefined);assert.equal(result.status,1,result.stdout+result.stderr);assert.match(result.stdout,/AssertionError|TypeError/);assert.doesNotMatch(result.stderr,/ERR_MODULE_NOT_FOUND|SyntaxError/);
});
