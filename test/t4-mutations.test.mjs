import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync,mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const mutations=[
  {name:'default account substituted for execution source',file:'scheduling-config.mjs',
    from:'account.id===scheduling.observationSourceId',to:'account.id===config.observation.defaultAccountId',
    test:'T4 a fresh observation on an unrelated source'},
  {name:'account mismatch check removed',file:'capacity.mjs',
    from:"if(base.accountKey&&base.accountKey!==expected.expectedAccountKey)return {...base,quality:'account-mismatch'};",to:'',
    test:'T4 re-reads observations and identity'},
  {name:'Spark weekly substituted for Codex main',file:'capacity.mjs',from:"const MAIN_LIMIT='codex';",to:"const MAIN_LIMIT='spark';",
    test:'T4 Spark cannot substitute'}
];
for(const mutation of mutations)test(`T4 mutation is detected: ${mutation.name}`,t=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'pilot-t4-mutation-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  cpSync(path.join(root,'src'),path.join(dir,'src'),{recursive:true});
  mkdirSync(path.join(dir,'test'));
  cpSync(path.join(root,'test','t4-admission.test.mjs'),path.join(dir,'test','t4-admission.test.mjs'));
  const file=path.join(dir,'src',mutation.file),source=readFileSync(file,'utf8');
  assert.ok(source.includes(mutation.from),'mutation anchor must exist');
  // Only the isolated disposable copy is mutated; the working sources remain untouched.
  writeFileSync(file,source.replace(mutation.from,mutation.to));
  const env={...process.env};delete env.NODE_TEST_CONTEXT;
  const result=spawnSync(process.execPath,['--test',`--test-name-pattern=${mutation.test}`,'test/t4-admission.test.mjs'],
    {cwd:dir,env,encoding:'utf8',windowsHide:true,timeout:30000});
  assert.equal(result.error,undefined);assert.equal(result.status,1,result.stdout+result.stderr);
  assert.match(result.stdout,/AssertionError|TypeError/);
  assert.doesNotMatch(result.stderr,/ERR_MODULE_NOT_FOUND|SyntaxError/);
});
