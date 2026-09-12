import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { parseCommand, active, permitted, poll, validateResult, executionFor } from '../src/core.mjs';
import { GitHub } from '../src/github.mjs';
import { agentEnvironment, codexArgs, execute, executionInput, publishJob, runJob, staticAssignment } from '../src/runner.mjs';
import { lock, runClaimedJob } from '../src/cli.mjs';
import { Telemetry } from '../src/telemetry.mjs';
import { createCodexExecutor } from '../src/executors/codex.mjs';

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
  assert.deepEqual(parseCommand(comment.body),{role:'sol-review',request:'Check hashes',taskClass:'unclassified',taskMetadata:null,classificationError:null});
  for(const body of ['Please /agent sol-review','> /agent sol-review','```\n/agent sol-review\n```','/agent sol-review --unsafe','/agent admin','<!-- codex-pilot:1 -->\n/agent sol-review']) assert.equal(parseCommand(body),null);
});
test('explicit profile survives queueing and selects implementation effort',async t=>{
  const store=fixture(t);
  const selected={...comment,body:'/agent sol-implement sol-high\nImplement spec'};
  assert.deepEqual(parseCommand(selected.body),{role:'sol-implement',profile:'sol-high',request:'Implement spec',taskClass:'unclassified',taskMetadata:null,classificationError:null});
  assert.equal(parseCommand('/agent sol-implement unknown'),null);
  await poll(config,store,{async *pages(){yield selected;},async issue(){return issue;}});
  const job=store.claim();
  assert.equal(job.profile,'sol-high');
  const assignment=staticAssignment(job,executionFor(job),{...config,timeoutMinutes:1});
  const args=codexArgs(config,assignment,'.','out.json','schema.json');
  assert.equal(args[args.indexOf('--model')+1],'gpt-5.6-sol');
  assert.ok(args.includes('model_reasoning_effort="high"'));
  assert.equal(assignment.requestedProfile,'sol-high');assert.equal(assignment.effectiveProfile,'sol-high');
  assert.throws(()=>executionFor({...job,profile:'unknown'}),/Invalid model profile/);
  await runJob(config,store,{issue:async()=>issue,request:async()=>({...selected,body:'/agent sol-implement sol-medium\nImplement spec'})},job,'.',{
    authenticate:()=>assert.fail('changed profile must not execute')
  });
  assert.equal(store.job(job.id).status,'cancelled');
  assert.equal(store.metrics()[0].reasoning_effort,'high');
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
test('invalid reserved task metadata is retained as an invalid job without a worker run',async t=>{
  const store=fixture(t);
  const malformed={...comment,id:87,body:'/agent sol-review\n```pilot-task\nnot json\n```'};
  assert.equal(await poll(config,store,{async *pages(){yield malformed;},async issue(){return issue;}},new Date('2026-09-10T10:02:00Z')),1);
  const job=store.jobs()[0];
  assert.equal(job.status,'invalid');assert.equal(job.error,'pilot-task-json-invalid');assert.equal(job.task_class,'unclassified');
  assert.equal(job.task_metadata_json,null);assert.equal(job.specification_hash,null);assert.equal(store.metrics().length,0);assert.equal(store.seen(malformed.id),true);
});
test('valid task metadata is persisted and a changed specification cancels before authentication',async t=>{
  const store=fixture(t);
  const contract={scope:'Change labels',expectedResult:'Labels changed',invariants:['Keep calculations'],areas:[],acceptanceCriteria:['No old label'],validationCommands:['npm test']};
  const selected={...comment,id:88,body:`/agent sol-review\n\`\`\`pilot-task\n${JSON.stringify({class:'routine',executionContract:contract})}\n\`\`\`\nCheck labels`};
  await poll(config,store,{async *pages(){yield selected;},async issue(){return issue;}},new Date('2026-09-10T10:02:00Z'));
  const job=store.claim();
  assert.equal(job.task_class,'routine');assert.deepEqual(JSON.parse(job.task_metadata_json),{version:1,class:'routine',executionContract:contract});assert.ok(job.specification_hash);
  await runJob(config,store,{issue:async()=>({...issue,title:'Changed'}),request:async()=>selected},job,'.',{authenticate:()=>assert.fail('must not authenticate')});
  assert.equal(store.job(job.id).status,'cancelled');assert.match(store.job(job.id).error,/specification changed/i);
});
test('classification migration is additive for existing SQLite jobs',t=>{
  const directory=mkdtempSync(path.join(os.tmpdir(),'pilot-old-schema-'));const file=path.join(directory,'queue.sqlite');
  const database=new DatabaseSync(file);
  database.exec(`CREATE TABLE jobs (id INTEGER PRIMARY KEY, comment_id INTEGER UNIQUE NOT NULL, issue INTEGER NOT NULL, role TEXT NOT NULL, request TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', payload TEXT NOT NULL, sha TEXT, directory TEXT, result TEXT, error TEXT, created TEXT NOT NULL, updated TEXT NOT NULL, profile TEXT);`);
  database.exec(`INSERT INTO jobs (comment_id,issue,role,request,payload,created,updated) VALUES (1,1,'sol-review','Old','{}','2026-01-01','2026-01-01');`);database.close();
  const store=new Store(file);t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  const job=store.job(1);assert.equal(job.task_class,'unclassified');assert.equal(job.task_metadata_json,null);assert.equal(job.specification_hash,null);
  const again=new Store(file);again.close();
});
test('execution input carries normalized task metadata without local paths',()=>{
  const metadata={version:1,class:'mechanical',executionContract:{scope:'Change labels',expectedResult:'Labels changed',invariants:['Keep calculations'],areas:[],acceptanceCriteria:['No old label'],validationCommands:['npm test']}};
  const input=executionInput(config,{id:1,role:'sol-implement',request:'Task',task_class:'mechanical'},issue,'a'.repeat(40),1,metadata);
  assert.doesNotThrow(()=>structuredClone(input));assert.equal(input.taskClass,'mechanical');assert.deepEqual(input.taskMetadata,metadata);
  assert.deepEqual(input.executionContract,metadata.executionContract);assert.match(input.prompt,/Change labels/);assert.equal(JSON.stringify(input).includes(path.resolve('.')),false);
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
  const job={role:'astra-review'};
  const args=codexArgs(config,staticAssignment(job,executionFor(job),{...config,timeoutMinutes:1}),'C:/space name/repo','out.json','schema.json');
  assert.ok(args.includes('gpt-6-astra'));assert.ok(args.includes('model_reasoning_effort="low"'));
  assert.ok(args.includes('--ephemeral'));assert.ok(args.includes('--ignore-user-config'));
  assert.equal(args[args.indexOf('--sandbox')+1],'workspace-write');
  assert.equal(args[args.indexOf('-a')+1],'never');assert.equal(args.at(-1),'-');
  assert.throws(()=>codexArgs(config,{...staticAssignment(job,executionFor(job),{...config,timeoutMinutes:1}),sandbox:'danger-full-access'},'.','out','schema'),/Invalid Codex execution assignment/);
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
      options.onSpawn(1234);
      options.onStdout(Buffer.from(JSON.stringify({type:'turn.completed',usage:{input_tokens:500,cached_input_tokens:400,output_tokens:20,reasoning_output_tokens:5}})+'\n'));
      writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify({verdict:'pass',summary:'Checked independently',findings:[],validation:['Mutation test']}));
      return {code:0,stdout:'',stderr:'',timedOut:false};
    }
  });
  assert.equal(store.job(job.id).status,'completed');assert.equal(store.job(job.id).sha,'a'.repeat(40));
  assert.ok(calls.some(args=>args[0]==='fetch'&&args.at(-1)==='refs/pull/1/head'));
  assert.ok(store.job(job.id).result.includes('Mutation test'));
  const metric=store.metrics()[0];
  assert.equal(metric.input_tokens,500);assert.equal(metric.cached_input_tokens,400);
  assert.equal(metric.output_tokens,20);assert.equal(metric.reasoning_output_tokens,5);
  assert.equal(metric.cache_write_input_tokens,null);assert.equal(metric.pid,1234);
  assert.equal(metric.run_status,'completed');assert.equal(metric.exit_code,0);
  assert.ok(metric.total_ms>=metric.worker_ms);assert.ok(metric.finished_at);
});
test('runner gives a fake executor serializable input and assignment without orchestration objects',async t=>{
  const store=fixture(t);
  const stateDirectory=mkdtempSync(path.join(os.tmpdir(),'pilot-executor-boundary-'));
  t.after(()=>rmSync(stateDirectory,{recursive:true,force:true}));
  store.enqueue(comment,issue,'sol-review','Check hashes');const job=store.claim();
  const api={issue:async()=>({...issue,pull_request:{}}),request:async p=>p===''?{default_branch:'main'}:comment,
    pr:async()=>({state:'open',head:{sha:'b'.repeat(40),repo:{full_name:'owner/repo'}}})};
  let received;
  const executor={execute:async function(input,assignment,context){
    assert.equal(arguments.length,3);assert.doesNotThrow(()=>structuredClone(input));assert.doesNotThrow(()=>structuredClone(assignment));
    assert.equal(JSON.stringify(input).includes(stateDirectory),false);assert.equal(JSON.stringify(assignment).includes(stateDirectory),false);
    assert.equal(input.repository,'owner/repo');assert.equal(input.revision,'b'.repeat(40));assert.equal(input.functionalRole,'review');
    assert.match(input.instructions,/Independently review/);assert.equal(input.requirements.trackedFilesMustRemainUnchanged,true);
    assert.deepEqual(input.reportSchema,{name:'result.schema.json'});
    assert.equal(assignment.model,'gpt-5.6-sol');assert.equal(assignment.effort,'medium');assert.equal(assignment.routing,'static');
    assert.equal(assignment.requestedProfile,null);assert.equal(assignment.effectiveProfile,'sol-medium');
    assert.equal(assignment.observationId,null);assert.equal(assignment.policyVersion,null);assert.ok(path.isAbsolute(context.workspacePath));
    assert.equal(Object.hasOwn(input,'store'),false);assert.equal(Object.hasOwn(input,'github'),false);
    context.onEvent({type:'worker-started',at:'2026-09-12T00:00:00.000Z'});context.onEvent({type:'spawned',pid:4321});
    received={input,assignment};
    return {status:'completed',error:null,report:{verdict:'pass',summary:'Boundary OK',findings:[],validation:[]},
      sessionId:'fake-session',workerMs:2,exitCode:0,timedOut:false,telemetry:{session_id:'fake-session',completed_turns:1,
        input_tokens:10,cached_input_tokens:5,cache_write_input_tokens:null,output_tokens:2,reasoning_output_tokens:1,
        usage_json:'[]',errors_json:'[]',malformed_lines:0},artifacts:[]};
  }};
  await runJob({...config,stateDirectory,checkout:'source',timeoutMinutes:1},store,api,job,stateDirectory,{
    authenticate:async()=>{},executor,git:async args=>args[0]==='rev-parse'?'b'.repeat(40):''
  });
  assert.ok(received);assert.equal(store.job(job.id).status,'completed');
  const metric=store.metrics()[0];assert.equal(metric.pid,4321);assert.equal(metric.session_id,'fake-session');assert.equal(metric.input_tokens,10);
});
test('Codex executor normalizes quota, timeout and invalid result without choosing another profile',async t=>{
  const directory=mkdtempSync(path.join(os.tmpdir(),'pilot-codex-executor-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const input={version:1,prompt:'Do the bounded task'};
  const assignment=staticAssignment({role:'sol-implement',profile:'sol-high'},
    executionFor({role:'sol-implement',profile:'sol-high'}),{timeoutMinutes:1});
  const outcomes=[];
  for(const behavior of ['quota','timeout','invalid']) {
    const outputDirectory=path.join(directory,behavior);mkdirSync(outputDirectory);
    let seenArgs;
    const executor=createCodexExecutor(config,{schemaPath:path.join(directory,'schema.json'),run:async(_command,args,options)=>{
      seenArgs=args;options.onSpawn(99);
      if(behavior==='invalid')writeFileSync(args[args.indexOf('--output-last-message')+1],'{bad json');
      return behavior==='quota'?{code:1,stdout:'',stderr:'usage limit reached',timedOut:false}:
        behavior==='timeout'?{code:null,stdout:'',stderr:'',timedOut:true}:{code:0,stdout:'',stderr:'',timedOut:false};
    }});
    const outcome=await executor.execute(input,assignment,{workspacePath:directory,outputDirectory,onEvent:()=>{}});
    assert.equal(seenArgs[seenArgs.indexOf('--model')+1],'gpt-5.6-sol');assert.ok(seenArgs.includes('model_reasoning_effort="high"'));
    outcomes.push(outcome);
  }
  assert.equal(outcomes[0].error.kind,'quota');assert.equal(outcomes[0].status,'failed');
  assert.equal(outcomes[1].status,'interrupted');assert.equal(outcomes[1].timedOut,true);
  assert.equal(outcomes[2].error.kind,'invalid-result');assert.equal(outcomes[2].status,'failed');
  for(const behavior of ['quota','timeout','invalid']) {
    assert.equal(existsSync(path.join(directory,behavior,'events.jsonl')),true);
    assert.equal(existsSync(path.join(directory,behavior,'stderr.log')),true);
  }
});
test('worker timing is retained when the Codex subprocess cannot start',async t=>{
  const store=fixture(t);
  const stateDirectory=mkdtempSync(path.join(os.tmpdir(),'pilot-spawn-failure-'));
  t.after(()=>rmSync(stateDirectory,{recursive:true,force:true}));
  store.enqueue(comment,issue,'sol-review','Check hashes');const job=store.claim();
  const api={issue:async()=>({...issue,pull_request:{}}),request:async p=>p===''?{default_branch:'main'}:comment,
    pr:async()=>({state:'open',head:{sha:'c'.repeat(40),repo:{full_name:'owner/repo'}}})};
  await runJob({...config,stateDirectory,checkout:'source',timeoutMinutes:1},store,api,job,stateDirectory,{
    authenticate:async()=>{},git:async args=>args[0]==='rev-parse'?'c'.repeat(40):'',
    execute:async()=>{throw new Error('spawn unavailable');}
  });
  assert.equal(store.job(job.id).status,'failed');assert.match(store.job(job.id).error,/spawn unavailable/);
  const metric=store.metrics()[0];assert.ok(metric.worker_started_at);assert.ok(metric.worker_ms>=0);
  assert.equal(metric.exit_code,null);assert.equal(metric.run_status,'failed');
});
test('publication finalizes the same attempt and never repeats execution after an ambiguous failure',async t=>{
  const store=fixture(t);store.enqueue(comment,issue,'sol-review','Check');const job=store.claim();let executions=0;
  await assert.rejects(runClaimedJob({...config,publish:true},store,{},job,'.',{
    runJob:async()=>{executions++;const runId=store.startRun(job.id,'gpt-5.6-sol','medium');
      store.update(job.id,{status:'completed',result:JSON.stringify({verdict:'pass',summary:'OK',findings:[],validation:[]})});
      return {runId,jobStart:performance.now()-5};},
    publishJob:async()=>{store.update(job.id,{status:'publishing'});throw new Error('ambiguous timeout');}
  }),/ambiguous timeout/);
  assert.equal(executions,1);assert.equal(store.job(job.id).status,'publishing');
  const metric=store.metrics()[0];assert.equal(metric.run_status,'publishing');assert.equal(metric.run_error,'ambiguous timeout');
  assert.ok(metric.finished_at);assert.ok(metric.total_ms>=5);
});
test('request modified after queueing is cancelled before authentication or agent launch',async t=>{
  const store=fixture(t);store.enqueue(comment,issue,'sol-review','Original');
  const job=store.claim();
  await runJob(config,store,{issue:async()=>issue,request:async()=>comment},job,'.',{
    authenticate:()=>assert.fail('must not authenticate')
  });
  assert.equal(store.job(job.id).status,'cancelled');
  assert.equal(store.metrics()[0].input_tokens,null);
  assert.equal(store.metrics()[0].worker_started_at,null);
});
test('telemetry handles split JSONL, UTF-8 and trailing line while preserving raw usage',()=>{
  const telemetry=new Telemetry();
  const text=[{type:'thread.started',thread_id:'session-1'},
    {type:'turn.completed',usage:{input_tokens:100,cached_input_tokens:80,output_tokens:30,reasoning_output_tokens:20,extra:'é'}},
    {type:'turn.completed',usage:{input_tokens:50,cached_input_tokens:30,output_tokens:10,reasoning_output_tokens:5}}].map(JSON.stringify).join('\n');
  const bytes=Buffer.from(text);
  for(let i=0;i<bytes.length;i++)telemetry.feed(bytes.subarray(i,i+1));
  telemetry.end();
  const result=telemetry.snapshot();
  assert.equal(result.input_tokens,150);assert.equal(result.cached_input_tokens,110);
  assert.equal(result.output_tokens,40);assert.equal(result.reasoning_output_tokens,25);
  assert.equal(result.cache_write_input_tokens,null);assert.equal(result.session_id,'session-1');
  assert.equal(JSON.parse(result.usage_json)[0].extra,'é');assert.equal(result.completed_turns,2);
});
test('missing or malformed usage never becomes zero and failed-turn data survives',()=>{
  const telemetry=new Telemetry();
  telemetry.feed('not json\n'+JSON.stringify({type:'turn.failed',error:{message:'quota'}})+'\n');
  telemetry.feed(JSON.stringify({type:'turn.completed',usage:{output_tokens:5}})+'\n');
  telemetry.end();const result=telemetry.snapshot();
  assert.equal(result.input_tokens,null);assert.equal(result.output_tokens,5);
  assert.equal(result.malformed_lines,1);assert.equal(JSON.parse(result.errors_json)[0].error.message,'quota');
});
test('SQLite retains each attempt and crash recovery leaves unknown durations null',t=>{
  const store=fixture(t);store.enqueue(comment,issue,'sol-review','Check');
  const first=store.startRun(1,'gpt-5.6-sol','medium');
  store.telemetry(first,{run_status:'failed',finished_at:new Date().toISOString(),input_tokens:100});
  const second=store.startRun(1,'gpt-5.6-sol','medium');
  store.telemetry(second,{input_tokens:200});store.recover();
  const rows=store.metrics();assert.equal(rows.length,2);
  assert.equal(rows[0].input_tokens,100);assert.equal(rows[0].run_status,'failed');
  assert.equal(rows[1].input_tokens,200);assert.equal(rows[1].run_status,'interrupted');
  assert.equal(rows[1].finished_at,null);assert.equal(rows[1].worker_ms,null);
});
