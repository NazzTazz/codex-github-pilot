import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { parseCommand, active, permitted, poll, validateResult } from '../src/core.mjs';
import { GitHub } from '../src/github.mjs';
import { agentEnvironment, codexArgs, execute, publishJob, runJob } from '../src/runner.mjs';
import { lock } from '../src/cli.mjs';

const config = {repository:'owner/repo',allowedAuthors:['Owner'],activeLabel:'agent:active',codexCommand:['node','codex.js']};
const issue = {number:1,state:'open',labels:[{name:'agent:active'}],title:'Task',body:'Spec'};
const comment = {id:12,created_at:'2026-09-10T10:01:00Z',body:'/agent sol-review\nCheck hashes',issue_url:'https://api.github.com/repos/owner/repo/issues/1',user:{login:'owner',type:'User'}};
function fixture(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(),'pilot-test-'));
  const store = new Store(path.join(directory,'queue.sqlite'));
  store.set('firstStarted','2026-09-10T10:00:00Z');
  store.set('since','2026-09-10T10:00:00Z');
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  return store;
}
test('only standalone role commands are executable; quoted mentions and bot reports cannot loop',()=>{
  assert.deepEqual(parseCommand(comment.body),{role:'sol-review',request:'Check hashes'});
  for(const body of ['Please /agent sol-review','> /agent sol-review','```\n/agent sol-review\n```','/agent sol-review --unsafe','/agent admin','<!-- codex-pilot:1 -->\n/agent sol-review']) assert.equal(parseCommand(body),null);
});
test('requires allowed human author and open active thread',()=>{
  assert.equal(permitted(comment,config),true);
  assert.equal(permitted({...comment,user:{login:'intruder',type:'User'}},config),false);
  assert.equal(permitted({...comment,user:{login:'owner',type:'Bot'}},config),false);
  assert.equal(active(issue,config),true);
  assert.equal(active({...issue,state:'closed'},config),false);
  assert.equal(active({...issue,labels:[]},config),false);
});
test('poll is idempotent, ignores edits and requests older than activation',async t=>{
  const store=fixture(t);
  const api={async *pages(){yield comment;yield {...comment,id:10,created_at:'2020-01-01T00:00:00Z'};},async issue(){return issue;}};
  assert.equal(await poll(config,store,api,new Date('2026-09-10T10:02:00Z')),1);
  assert.equal(await poll(config,store,api,new Date('2026-09-10T10:03:00Z')),0);
  assert.equal(store.jobs().length,1);
});
test('a failed later page does not advance cursor or duplicate committed earlier jobs',async t=>{
  const store=fixture(t);
  const api={async *pages(){yield comment;throw new Error('offline');},async issue(){return issue;}};
  await assert.rejects(poll(config,store,api),/offline/);
  assert.equal(store.get('since'),'2026-09-10T10:00:00Z');
  assert.equal(store.jobs().length,1);
  await assert.rejects(poll(config,store,api),/offline/);
  assert.equal(store.jobs().length,1);
});
test('a new installation starts now, never backfills old commands',async t=>{
  const store=fixture(t);store.db.exec("DELETE FROM meta WHERE key='since'");
  assert.equal(await poll(config,store,{pages(){throw new Error('should not fetch');}},new Date('2026-09-10T10:05:00Z')),0);
  assert.equal(store.get('since'),'2026-09-10T10:05:00.000Z');
});
test('atomic claim prevents concurrent workers and recovery never silently reruns work',t=>{
  const store=fixture(t);store.enqueue(comment,issue,'sol-review','Check hashes');
  store.enqueue({...comment,id:13},issue,'sol-review','Again');
  assert.equal(store.claim().id,1);assert.equal(store.claim(),undefined);
  store.recover();assert.equal(store.job(1).status,'interrupted');
  assert.equal(store.claim().id,2);
});
test('GitHub pagination handles more than 100 comments',async()=>{
  let calls=0;
  const api=new GitHub('owner/repo',undefined,async()=>({ok:true,json:async()=>++calls===1?Array.from({length:100},(_,id)=>({id})):[{id:100}]}));
  const rows=[];for await(const row of api.pages('/issues/1/comments'))rows.push(row);
  assert.equal(rows.length,101);assert.equal(calls,2);
});
test('ambiguous publication is recovered by marker before issuing another POST',async()=>{
  const api=new GitHub('owner/repo','fake');let posts=0;
  api.pages=async function*(){yield {id:99,body:'<!-- marker -->\nreport'};};
  api.request=async()=>{posts++;};
  assert.equal((await api.publish(1,'<!-- marker -->','report')).id,99);assert.equal(posts,0);
});
test('PR head changes invalidate result before publication',async t=>{
  const store=fixture(t);store.enqueue(comment,issue,'sol-review','Check');
  store.update(1,{status:'completed',sha:'abc',result:JSON.stringify({verdict:'pass',summary:'OK',findings:[],validation:[]})});
  await publishJob(config,store,{issue:async()=>({...issue,pull_request:{}}),pr:async()=>({head:{sha:'def'}}),publish:()=>assert.fail('must not publish')},store.job(1));
  assert.equal(store.job(1).status,'stale');
});
test('publication failure remains retryable without re-running model',async t=>{
  const store=fixture(t);store.enqueue(comment,issue,'sol-review','Check');
  store.update(1,{status:'completed',sha:'abc',result:JSON.stringify({verdict:'pass',summary:'OK',findings:[],validation:[]})});
  await assert.rejects(publishJob(config,store,{issue:async()=>issue,publish:async()=>{throw new Error('timeout');}},store.job(1)),/timeout/);
  assert.equal(store.job(1).status,'publishing');assert.ok(store.job(1).result);
});
test('agent does not inherit API or GitHub environment credentials',()=>{
  assert.deepEqual(agentEnvironment({PATH:'safe',OPENAI_API_KEY:'secret',CODEX_API_KEY:'secret',GITHUB_TOKEN:'secret',gh_token:'secret'}),{PATH:'safe'});
});
test('review command fixes model, effort, fresh context, no approvals and sandbox',()=>{
  const args=codexArgs(config,{role:'astra-review'},'C:/space name/repo','out.json','schema.json');
  assert.ok(args.includes('gpt-6-astra'));assert.ok(args.includes('model_reasoning_effort="low"'));
  assert.ok(args.includes('--ephemeral'));assert.ok(args.includes('--ignore-user-config'));
  assert.equal(args[args.indexOf('--sandbox')+1],'workspace-write');
  assert.equal(args[args.indexOf('-a')+1],'never');assert.equal(args.at(-1),'-');
});
test('bad structured results are rejected',()=>{
  for(const value of [null,{verdict:'approved'},{verdict:'pass',summary:'',findings:[],validation:[]}])assert.throws(()=>validateResult(value));
});
test('process invocation preserves prompt as stdin, never shell syntax',async()=>{
  const payload='$(do-not-execute) `literal` ; spaces\nsecond line';
  const result=await execute(process.execPath,['-e','process.stdin.pipe(process.stdout)'],{input:payload});
  assert.equal(result.code,0);assert.equal(result.stdout,payload);
});
test('process timeout terminates a stuck worker',async()=>{
  const result=await execute(process.execPath,['-e','setInterval(()=>{},1000)'],{timeoutMs:100});
  assert.equal(result.timedOut,true);assert.notEqual(result.code,0);
});
test('OS lock prevents a second worker and is reusable after release',async t=>{
  const directory=mkdtempSync(path.join(os.tmpdir(),'pilot-lock-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const release=await lock(directory);
  try { await assert.rejects(lock(directory),/lock unavailable/); } finally { await release(); }
  const again=await lock(directory);await again();
});
test('worker lifecycle binds PR SHA and persists structured result with isolated artifacts',async t=>{
  const store=fixture(t);
  const stateDirectory=mkdtempSync(path.join(os.tmpdir(),'pilot-run-'));
  t.after(()=>rmSync(stateDirectory,{recursive:true,force:true}));
  store.enqueue(comment,issue,'sol-review','Check hashes');const job=store.claim();
  const calls=[];
  const api={issue:async()=>({...issue,pull_request:{}}),request:async p=>p===''?{default_branch:'main'}:comment,
    pr:async()=>({state:'open',head:{sha:'a'.repeat(40),repo:{full_name:'owner/repo'}}})};
  await runJob({...config,stateDirectory,checkout:'source',timeoutMinutes:1},store,api,job,stateDirectory,{
    authenticate:async()=>{},
    git:async args=>{calls.push(args);return args[0]==='rev-parse'?'a'.repeat(40):'';},
    execute:async (cmd,args,options)=>{
      assert.ok(options.input.includes('Check hashes'));
      writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify({verdict:'pass',summary:'Checked independently',findings:[],validation:['Mutation test']}));
      return {code:0,stdout:'',stderr:'',timedOut:false};
    }
  });
  assert.equal(store.job(job.id).status,'completed');assert.equal(store.job(job.id).sha,'a'.repeat(40));
  assert.ok(calls.some(args=>args[0]==='fetch'&&args.at(-1)==='refs/pull/1/head'));
  assert.ok(store.job(job.id).result.includes('Mutation test'));
});
test('request modified after queueing is cancelled before authentication or agent launch',async t=>{
  const store=fixture(t);store.enqueue(comment,issue,'sol-review','Original');
  const job=store.claim();
  await runJob(config,store,{issue:async()=>issue,request:async()=>comment},job,'.',{
    authenticate:()=>assert.fail('must not authenticate')
  });
  assert.equal(store.job(job.id).status,'cancelled');
});
