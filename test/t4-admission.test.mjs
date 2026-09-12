import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { parseCommand } from '../src/core.mjs';
import { schedulingConfig,executionEnvironment } from '../src/scheduling-config.mjs';
import { scheduleNext,schedulingDecision } from '../src/scheduler.mjs';
import { readExecutionIdentity,canonicalAccountKey } from '../src/observation.mjs';
import { runClaimedJob } from '../src/cli.mjs';
import { checkAuth,createCodexExecutor } from '../src/executors/codex.mjs';

const at='2026-09-12T12:00:00.000Z';
const contract={scope:'Labels',expectedResult:'New labels',invariants:['Keep logic'],areas:[],acceptanceCriteria:['No old label'],validationCommands:['npm test']};
function fixture(t) {
  const dir=mkdtempSync(path.join(os.tmpdir(),'pilot-t4-'));
  const store=new Store(path.join(dir,'test.sqlite'));
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const observation={mode:'multi',defaultAccountId:'plus',accounts:[{id:'plus',scopeId:'scope-plus',codexHome:path.join(dir,'plus')},
    {id:'lite',scopeId:'scope-lite',codexHome:path.join(dir,'lite')}]};
  const config={repository:'owner/repo',activeLabel:'active',allowedAuthors:['owner'],stateDirectory:dir,checkout:dir,
    codexCommand:['codex'],timeoutMinutes:30,publish:false,observation,
    scheduling:schedulingConfig({enabled:true,observationSourceId:'lite',reserveEnabled:true,quotaErrorCooldownSeconds:30},observation)};
  let now=new Date(at),identity='account-lite';
  const clock=()=>now,readIdentity=async()=>identity;
  const issue={number:1,state:'open',labels:[{name:'active'}],title:'Task',body:'Spec'};
  const comments=new Map();
  const github={issue:async()=>issue,request:async route=>route===''?{default_branch:'main'}:comments.get(Number(route.split('/').at(-1)))};
  const add=(taskClass='routine',profile='sol-high')=>{
    const metadata={class:taskClass,...(taskClass==='mechanical'?{executionContract:contract}:{})};
    const comment={id:comments.size+1,user:{login:'owner',type:'User'},body:`/agent sol-implement ${profile}\n\`\`\`pilot-task\n${JSON.stringify(metadata)}\n\`\`\`\nDo work`};
    const command=parseCommand(comment.body);assert.equal(command.classificationError,null);assert.equal(command.taskClass,taskClass);
    comments.set(comment.id,comment);
    store.enqueue(comment,issue,command.role,command.request,command.profile,{taskClass:command.taskClass,taskMetadata:command.taskMetadata});
    return store.jobs().at(-1);
  };
  const sample=(remaining=90,{source='lite',account='account-lite',ordinary=true,spend=false,observed=now.toISOString(),models=null,
    catalogueObserved=observed,extraWindows=[]}={})=>{
    const reset=Math.floor(now.getTime()/1000)+3600;
    return store.recordObservation({started_at:observed,finished_at:observed,source:'codex-app-server',status:'partial',
      observation_source_id:source,capacity_scope_id:`scope-${source}`,account_key:account,plan_type:null,quota_observed_at:observed,
      usage_observed_at:null,usage:null,errors:{},quota:{ordinary_usage_allowed:ordinary,spend_control_reached:spend,normal_model_slug:'gpt-5.6-luna',
        windows:[{limit_id:'codex',remaining_percent:remaining,window_minutes:10080,resets_at:reset},
          {limit_id:'base_model_inference',remaining_percent:80,window_minutes:10080,resets_at:reset},...extraWindows]},
      capabilities:{account_key:account,observed_at:catalogueObserved,models:models??['gpt-5.6-sol','gpt-5.6-terra','gpt-5.6-luna','gpt-reserve'].map(slug=>({slug,efforts:['medium','high']}))}});
  };
  const next=(options={})=>scheduleNext(config,store,github,{clock,readIdentity,...options});
  return {dir,store,config,github,comments,add,sample,next,clock,readIdentity,
    time:value=>{now=new Date(value);},identity:value=>{identity=value;}};
}

test('T4 skips costly deferred work, deduplicates unchanged reports, and atomically admits one exact profile',async t=>{
  const f=fixture(t),expensive=f.add('exploratory'),routine=f.add();f.sample(9);
  const admission=await f.next();
  assert.equal(admission.job.id,routine.id);assert.equal(admission.assignment.model,'gpt-5.6-terra');
  assert.equal(admission.assignment.observationSourceId,'lite');assert.equal(admission.assignment.accountKey,'account-lite');
  assert.equal(f.store.job(expensive.id).status,'deferred');assert.equal(f.store.job(expensive.id).directory,null);
  assert.equal(f.store.metrics().length,0);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM scheduling_decisions').get().n,2);
  f.store.update(routine.id,{status:'completed'});f.sample(8);assert.equal(await f.next(),null);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM scheduling_decisions').get().n,2);
  f.sample(90);const resumed=await f.next();assert.equal(resumed.job.id,expensive.id);assert.equal(resumed.job.deferred_since,null);
});

test('T4 re-reads observations and identity after GitHub, and cancelled requests never create runs',async t=>{
  for(const change of ['quota','identity','comment']) {
    const f=fixture(t),job=f.add();f.sample();
    const read=f.github.issue;
    f.github.issue=async()=>{
      if(change==='quota')f.sample(0);
      if(change==='identity')f.identity('different');
      if(change==='comment')f.comments.get(job.comment_id).body='Changed request';
      return read();
    };
    assert.equal(await f.next(),null);
    assert.equal(f.store.job(job.id).status,change==='comment'?'cancelled':'deferred');
    assert.equal(f.store.metrics().length,0);assert.equal(f.store.job(job.id).directory,null);
  }
});

test('T4 concurrent contenders using two SQLite connections produce exactly one admission',async t=>{
  const f=fixture(t);f.add();f.add();f.sample();
  const second=new Store(path.join(f.dir,'test.sqlite'));
  let entered=0,unblock;const gate=new Promise(resolve=>{unblock=resolve;});
  const validate=async()=>{if(++entered===2)unblock();await gate;return {valid:true};};
  let results;
  try {results=await Promise.all([f.next({validate}),scheduleNext(f.config,second,f.github,{clock:f.clock,readIdentity:f.readIdentity,validate})]);}
  finally {second.close();}
  assert.equal(results.filter(Boolean).length,1);
  assert.equal(f.store.jobs().filter(job=>job.status==='running').length,1);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM scheduling_decisions WHERE kind='admission'").get().n,1);
});

test('T4 override is consumed once on admission and rollback leaves no partial claim',async t=>{
  const f=fixture(t),job=f.add('exploratory');f.sample(9);
  const id=f.store.createOverride(job.id,'tester','Finish the task',at);
  const original=f.store.saveDecision.bind(f.store);
  f.store.saveDecision=(...args)=>{const result=original(...args);if(args[3]==='admission')throw new Error('injected failure');return result;};
  await assert.rejects(f.next(),/injected/);
  assert.equal(f.store.job(job.id).status,'queued');assert.equal(f.store.overrides(job.id)[0].consumed_at,null);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM scheduling_decisions').get().n,0);
  f.store.saveDecision=original;const admission=await f.next();
  assert.equal(admission.assignment.overrideId,id);assert.equal(admission.assignment.effectiveProfile,'sol-high');
  assert.equal(f.store.overrides(job.id)[0].consumed_at,at);assert.equal(await f.next(),null);
  assert.throws(()=>f.store.createOverride(job.id,'tester','again',at),/queued\/deferred/);
});

test('T4 expired, revoked, or revoked during GitHub overrides cannot admit',async t=>{
  for(const kind of ['expired','revoked','during']) {
    const f=fixture(t),job=f.add('exploratory');f.sample(9);
    f.store.createOverride(job.id,'tester','reason',kind==='expired'?'2026-09-11T12:00:00.000Z':at);
    if(kind==='revoked')f.store.clearOverride(job.id,at);
    if(kind==='during')f.github.issue=async()=>{f.store.clearOverride(job.id,at);return JSON.parse(job.payload).issue;};
    assert.equal(await f.next(),null);assert.equal(f.store.job(job.id).status,'deferred');
  }
});

test('T4 incident recovery needs cooldown AND a later positive proof; null spend cannot recover',async t=>{
  const f=fixture(t);f.add();f.sample(90,{spend:true});assert.equal(await f.next(),null);
  assert.equal(f.store.incidents('scope-lite','account-lite').length,2);
  f.time('2026-09-12T12:00:31.000Z');f.sample(90,{spend:null});assert.equal(await f.next(),null);
  f.sample(90,{spend:false,observed:at});assert.equal(await f.next(),null);
  f.sample(90,{spend:false});assert.ok((await f.next()).assignment);
  assert.equal(f.store.incidents('scope-lite','account-lite').filter(row=>row.quota_pool==='main').length,0);
});

test('T4 incidents follow canonical accounts across sources, without blocking another account or the other pool',async t=>{
  const f=fixture(t),job=f.add('mechanical','luna-medium');f.sample(0,{ordinary:false});
  f.store.openIncident({scope:'renamed-source',accountKey:'account-lite',pool:'main',kind:'quota-suspected',now:at,notBefore:'2026-09-13T00:00:00Z'});
  assert.equal((await f.next()).assignment.quotaPool,'reserve');
  f.store.update(job.id,{status:'completed'});f.add();f.sample(90);
  assert.equal(await f.next(),null);
  f.sample(90,{account:'other'});f.identity('other');assert.ok((await f.next()).assignment);
});

test('T4 a fresh observation on an unrelated source never replaces the selected account',async t=>{
  const f=fixture(t);f.add();f.sample(0);f.sample(100,{source:'plus',account:'account-plus'});
  assert.equal(await f.next(),null);
  f.sample(90);f.sample(0,{source:'plus',account:'account-plus'});
  assert.equal((await f.next()).assignment.observationSourceId,'lite');
});

test('T4 pre-spawn guard rejects account/config/capacity changes, but not a mere economic phase change',async t=>{
  for(const change of ['identity','config','quota','phase']) {
    const f=fixture(t);f.add();f.sample(90);const admission=await f.next();
    if(change==='identity')f.identity('other');
    if(change==='config')f.config.scheduling.observationSourceId='plus';
    if(change==='quota')f.sample(0);
    if(change==='phase')f.sample(3);
    if(change==='phase')assert.ok(await admission.beforeSpawn());
    else await assert.rejects(admission.beforeSpawn(),/before spawn/);
    assert.equal(admission.assignment.model,'gpt-5.6-sol');
  }
});

test('T4 quota failure retains the checkout, consumed override and exact assignment without legacy pause or fallback',async t=>{
  const f=fixture(t),job=f.add('exploratory');f.sample(9);f.store.createOverride(job.id,'tester','reason',at);
  const admission=await f.next();let calls=0;
  const executor={execute:async(input,assignment)=>{
    calls++;assert.equal(assignment.model,'gpt-5.6-sol');assert.equal(assignment.effort,'high');
    return {status:'failed',error:{kind:'quota',message:'quota',incidentKind:'quota-suspected'},workerMs:1,exitCode:1};
  }};
  await runClaimedJob(f.config,f.store,f.github,admission.job,f.dir,{runner:{...admission,executor,authenticate:async()=>{},
    git:async args=>args[0]==='rev-parse'?'abc':''}});
  assert.equal(calls,1);assert.equal(f.store.job(job.id).status,'quota_wait');assert.ok(existsSync(f.store.job(job.id).directory));
  assert.notEqual(f.store.get('quotaPaused'),'yes');assert.equal(f.store.metrics()[0].model_requested,'gpt-5.6-sol');
  assert.equal(f.store.metrics()[0].scheduling_decision_id,admission.assignment.decisionId);
  assert.ok(f.store.metrics()[0].spawn_capacity_json);assert.ok(f.store.overrides(job.id)[0].consumed_at);
  assert.equal(f.store.incidents('scope-lite','account-lite')[0].quota_pool,'main');
  assert.equal(await f.next(),null);
});

test('T4 rejected pre-spawn check never reaches executor and preserves the failed attempt',async t=>{
  const f=fixture(t),job=f.add();f.sample();const admission=await f.next();
  await runClaimedJob(f.config,f.store,f.github,admission.job,f.dir,{runner:{...admission,authenticate:async()=>{},
    git:async args=>{if(args[0]==='checkout')f.identity('changed');return args[0]==='rev-parse'?'abc':'';},
    executor:{execute:async()=>assert.fail('must not generate')}}});
  assert.equal(f.store.job(job.id).status,'failed');assert.equal(f.store.metrics()[0].session_id,null);
  assert.ok(f.store.job(job.id).directory);
});

test('T4 legacy pause survives, disabled policy admits deferred jobs, recover does not restart them',async t=>{
  const f=fixture(t),job=f.add('exploratory');f.sample(3);await f.next();
  f.store.recover();assert.equal(f.store.job(job.id).status,'deferred');
  f.store.set('quotaPaused','yes');f.sample(90);assert.equal(await f.next(),null);
  f.config.scheduling.enabled=false;assert.equal((await f.next()).job,null);
  f.store.set('quotaPaused','no');const admission=await f.next();assert.equal(admission.job.id,job.id);
  assert.equal(admission.assignment,null);assert.equal(admission.job.deferred_since,null);
});

test('T4 identity probe, auth and executor use the explicitly selected home; parent and disabled mode stay unchanged',async t=>{
  const f=fixture(t),parent={CODEX_HOME:'inherited',OPENAI_API_KEY:'secret'};
  const expected=f.config.observation.accounts[1].codexHome;
  assert.equal(executionEnvironment(f.config,parent).CODEX_HOME,expected);assert.equal(parent.CODEX_HOME,'inherited');
  assert.equal(executionEnvironment(f.config,parent).OPENAI_API_KEY,undefined);
  let closed=0;const methods=[];
  const identity=await readExecutionIdentity(f.config,{createClient:env=>{
    assert.equal(env.CODEX_HOME,expected);
    return {initialize:async()=>{},close:async()=>{closed++;},request:async method=>{methods.push(method);
      return method==='account/read'?{account:{type:'chatgpt',email:'x@example.test'}}:{accountId:'provider-id',rateLimits:{},rateLimitsByLimitId:{}};}};
  }});
  assert.equal(identity,canonicalAccountKey({accountId:'provider-id'},'x@example.test'));assert.equal(closed,1);
  assert.deepEqual(methods,['account/read','account/rateLimits/read']);
  await checkAuth(f.config,async(command,args,options)=>{assert.equal(options.env.CODEX_HOME,expected);return {code:0,stdout:'Logged in using ChatGPT',stderr:''};});
  const executor=createCodexExecutor(f.config,{schemaPath:path.join(f.dir,'schema.json'),run:async(command,args,options)=>{
    assert.equal(options.env.CODEX_HOME,expected);return {code:1,stdout:'',stderr:'failure',timedOut:false};
  }});
  await executor.execute({version:1,prompt:'test'},{provider:'openai',adapter:'codex-exec',model:'gpt-5.6-sol',effort:'high',sandbox:'workspace-write',timeoutMs:100},
    {workspacePath:f.dir,outputDirectory:f.dir});
  f.config.scheduling.enabled=false;assert.equal(executionEnvironment(f.config,parent).CODEX_HOME,'inherited');
});

test('T4 Spark cannot substitute for main, and a Plus short limit blocks a positive weekly',async t=>{
  const f=fixture(t);f.add();
  const spark={limit_id:'spark',remaining_percent:100,window_minutes:10080,resets_at:Math.floor(Date.parse(at)/1000)+3600};
  f.sample(0,{extraWindows:[spark]});assert.equal(await f.next(),null);
  f.sample(80,{extraWindows:[{...spark,remaining_percent:0}]});const admission=await f.next();assert.ok(admission);
  f.store.update(admission.job.id,{status:'completed'});f.add();
  f.sample(80,{extraWindows:[{...spark,limit_id:'codex',window_minutes:300,remaining_percent:0}]});
  assert.equal(await f.next(),null);
});

test('T4 missing identity, stale quota, failed latest observation and unavailable catalogue never create a run',async t=>{
  for(const kind of ['identity','stale','error','catalogue']) {
    const f=fixture(t),job=f.add();f.sample();
    if(kind==='identity')f.identity(null);
    if(kind==='stale')f.time('2026-09-12T12:03:00.000Z');
    if(kind==='catalogue')f.sample(90,{models:[]});
    if(kind==='error') {
      const sample=f.store.latestObservation('lite');sample.errors={quota:'unavailable'};sample.quota=null;sample.account_key=null;f.store.recordObservation(sample);
    }
    assert.equal(await f.next(),null);assert.equal(f.store.job(job.id).status,'deferred');assert.equal(f.store.metrics().length,0);
  }
});

test('T4 reserve alias recovery requires a later catalogue, and read-only evaluation never clears incidents',async t=>{
  const f=fixture(t),job=f.add('mechanical','luna-medium');
  f.store.openIncident({scope:'scope-lite',accountKey:'account-lite',pool:'reserve',kind:'alias-unavailable',now:at,notBefore:'2026-09-12T12:00:30.000Z'});
  f.time('2026-09-12T12:00:31.000Z');f.sample(0,{ordinary:false,catalogueObserved:at});
  assert.equal(await f.next(),null);
  f.sample(0,{ordinary:false});
  const preview=schedulingDecision({store:f.store,config:f.config,job:f.store.job(job.id),expectedAccountKey:'account-lite',now:f.clock().toISOString()});
  assert.equal(preview.decision.assignment.quotaPool,'reserve');
  assert.equal(f.store.incidents('scope-lite','account-lite').length,1);
  assert.equal((await f.next()).assignment.quotaPool,'reserve');assert.equal(f.store.incidents('scope-lite','account-lite').length,0);
});

test('T4 a failed identity RPC cannot turn an email into a different account key',async t=>{
  const f=fixture(t);let closed=false;
  const value=await readExecutionIdentity(f.config,{createClient:()=>({initialize:async()=>{},close:async()=>{closed=true;},
    request:async method=>{if(method==='account/read')return {account:{type:'chatgpt',email:'x@example.test'}};throw new Error('offline');}})});
  assert.equal(value,null);assert.equal(closed,true);
});

test('T4 admitted degradation reaches real executor argv unchanged, on the selected account, with no second worker',async t=>{
  const f=fixture(t),job=f.add();f.add();f.sample(9);const admission=await f.next();let calls=0;
  const executor=createCodexExecutor(f.config,{schemaPath:path.join(f.dir,'schema.json'),run:async(command,args,options)=>{
    calls++;assert.equal(args[args.indexOf('--model')+1],'gpt-5.6-terra');
    assert.ok(args.includes('model_reasoning_effort="medium"'));assert.ok(args.includes('--ephemeral'));
    assert.equal(options.env.CODEX_HOME,f.config.observation.accounts[1].codexHome);
    return {code:1,stdout:'',stderr:'quota unavailable',timedOut:false};
  }});
  await runClaimedJob(f.config,f.store,f.github,admission.job,f.dir,{runner:{...admission,executor,authenticate:async()=>{},
    git:async args=>args[0]==='rev-parse'?'abc':''}});
  assert.equal(calls,1);assert.equal(f.store.job(job.id).status,'quota_wait');
  assert.equal(f.store.jobs()[1].status,'queued');
  const run=f.store.metrics()[0];assert.equal(run.model_requested,'gpt-5.6-sol');assert.equal(run.model_effective,'gpt-5.6-terra');
  assert.equal(run.effort_requested,'high');assert.equal(run.reasoning_effort,'medium');
});

test('T4 observes spend-control even with an empty queue, so a later null cannot erase the incident',async t=>{
  const f=fixture(t);f.sample(90,{spend:true});assert.equal(await f.next(),null);
  assert.equal(f.store.incidents('scope-lite','account-lite').length,2);
  f.add();f.time('2026-09-12T12:00:31.000Z');f.sample(90,{spend:null});
  assert.equal(await f.next(),null);assert.equal(f.store.metrics().length,0);
});
