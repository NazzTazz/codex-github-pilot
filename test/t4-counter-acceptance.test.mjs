// Independent T4 acceptance probes, now included in npm test.
// Uses in-memory SQLite and a fake GitHub transport; never starts a worker.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { GitHub,GitHubHttpError } from '../src/github.mjs';
import { parseCommand } from '../src/core.mjs';
import { schedulingConfig } from '../src/scheduling-config.mjs';
import { scheduleNext,schedulingDecision } from '../src/scheduler.mjs';

function fixture(t) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const observation = {mode:'legacy',defaultAccountId:'local',accounts:[
    {id:'local',scopeId:'local-codex-account',codexHome:null}
  ]};
  const config = {repository:'fixture/repository',activeLabel:'active',allowedAuthors:['owner'],
    timeoutMinutes:30,observation,scheduling:schedulingConfig({enabled:true,quotaErrorCooldownSeconds:30},observation)};
  let now = new Date('2026-09-12T15:00:00.000Z');
  let identity = 'canonical-fixture-account';
  const comments = new Map(), deleted = new Set(), failures = new Map();
  const issue = {number:1,state:'open',labels:['active'],title:'Fixture',body:'Independent counter-acceptance'};
  const github = new GitHub(config.repository,undefined,async url => {
    const route = new URL(url).pathname;
    const failure=failures.get(route.slice(`/repos/${config.repository}`.length));
    if(failure instanceof Error)throw failure;
    if(failure)return new Response('{}',{status:failure});
    const match = /\/issues\/comments\/(\d+)$/.exec(route);
    if (match) {
      const id = Number(match[1]);
      return new Response(JSON.stringify(deleted.has(id)?{message:'Not Found'}:comments.get(id)),{status:deleted.has(id)?404:200});
    }
    assert.ok(route.endsWith('/issues/1'),`Unexpected route: ${route}`);
    return new Response(JSON.stringify(issue));
  });
  const add = () => {
    const comment = {id:comments.size+1,user:{login:'owner',type:'User'},
      body:'/agent sol-implement sol-high\n```pilot-task\n{"class":"routine"}\n```\nApply the requested change'};
    comments.set(comment.id,comment);
    const command = parseCommand(comment.body);
    store.enqueue(comment,issue,command.role,command.request,command.profile,
      {taskClass:command.taskClass,taskMetadata:command.taskMetadata});
    return store.jobs().at(-1);
  };
  const observe = (spend,fields={}) => {
    const at = now.toISOString();
    store.recordObservation({started_at:at,finished_at:at,source:'fixture',status:'ok',
      account_key:'canonical-fixture-account',plan_type:null,quota_observed_at:at,usage_observed_at:null,
      usage:null,errors:{},quota:{ordinary_usage_allowed:true,spend_control_reached:spend,
        windows:[{limit_id:'codex',remaining_percent:80,window_minutes:10080,resets_at:now.getTime()/1000+3600}]},
      capabilities:{account_key:'canonical-fixture-account',observed_at:at,
        models:[{slug:'gpt-5.6-sol',efforts:['high','medium']}]},...fields});
  };
  return {store,config,add,observe,deleted,failures,identity:value=>{identity=value;},
    advance:()=>{now=new Date(now.getTime()+31000);},
    next:()=>scheduleNext(config,store,github,{clock:()=>now,readIdentity:async()=>identity})};
}

test('control: healthy evidence admits exactly one job, without a worker run',async t => {
  const f=fixture(t),first=f.add(),second=f.add();f.observe(false);
  const admission=await f.next();
  assert.equal(admission.job.id,first.id);
  assert.equal(f.store.job(second.id).status,'queued');
  assert.equal(f.store.metrics().length,0);
});

test('control: a recorded spend-control true blocks a later null',async t => {
  const f=fixture(t);f.add();f.observe(true);
  assert.equal(await f.next(),null);
  f.advance();f.observe(null);
  assert.equal(await f.next(),null);
});

test('control: explicit false after cooldown recovers the main pool',async t => {
  const f=fixture(t);f.add();f.observe(true);
  assert.equal(await f.next(),null);
  f.advance();f.observe(false);
  assert.ok((await f.next()).assignment);
});

test('P1: a deleted head comment must not indefinitely block the next admissible job',async t => {
  const f=fixture(t),first=f.add(),second=f.add();f.observe(false);f.deleted.add(first.comment_id);
  const admissions=[],errors=[];
  for(let attempt=0;attempt<2;attempt++) {
    try {const result=await f.next();if(result)admissions.push(result.job.id);}
    catch(error) {errors.push(error.message);}
  }
  t.diagnostic(JSON.stringify({admissions,errors,statuses:f.store.jobs().map(j=>[j.id,j.status])}));
  assert.ok(admissions.includes(second.id),'The healthy second job remains blocked behind a permanently deleted comment');
  assert.deepEqual(errors,[]);
  assert.equal(f.store.job(first.id).status,'cancelled');
  assert.match(f.store.job(first.id).error,/comment.*no longer available/);
  assert.equal(f.store.job(first.id).directory,null);
  assert.equal(f.store.metrics().length,0);
});

test('P1: an identity-probe outage must not erase an observed spend-control true',async t => {
  const f=fixture(t);f.add();f.observe(true);f.identity(null);
  assert.equal(await f.next(),null);
  const incidentsAfterTrue=f.store.incidents('local-codex-account','canonical-fixture-account').length;
  f.advance();f.observe(null);f.identity('canonical-fixture-account');
  const admission=await f.next();
  const spawnGuardAccepted=admission?Boolean(await admission.beforeSpawn()):false;
  t.diagnostic(JSON.stringify({incidentsAfterTrue,action:admission?'admitted':'deferred',spawnGuardAccepted,status:f.store.jobs()[0].status}));
  assert.equal(Boolean(admission),false,'Spend control was true; an explicit false is required before admission, even after an identity-probe outage');
  assert.equal(incidentsAfterTrue,2);
});

test('T4 missing issue and gone comment are cancelled without a worker',async t=>{
  for(const [route,status] of [['/issues/1',404],['/issues/comments/1',410]]) {
    const f=fixture(t),job=f.add();f.observe(false);f.failures.set(route,status);
    assert.equal(await f.next(),null);
    assert.equal(f.store.job(job.id).status,'cancelled');
    assert.equal(f.store.metrics().length,0);
  }
});

test('T4 authentication, throttling, server and network failures do not cancel jobs',async t=>{
  for(const failure of [401,403,429,500,new TypeError('Network unavailable')]) {
    const f=fixture(t),job=f.add();f.add();f.observe(false);
    f.failures.set('/issues/comments/1',failure);
    await assert.rejects(f.next(),error=>failure instanceof Error?error===failure:
      error instanceof GitHubHttpError&&error.status===failure);
    assert.deepEqual(f.store.jobs().map(j=>j.status),['queued','queued']);
    assert.equal(f.store.metrics().length,0);
    f.failures.clear();assert.equal((await f.next()).job.id,job.id);
  }
});

test('T4 spend memory during an identity outage is deduplicated and cannot recover without identity',async t=>{
  const f=fixture(t);f.observe(true);f.identity(null);
  assert.equal(await f.next(),null);assert.equal(await f.next(),null);
  assert.equal(f.store.incidents('local-codex-account','canonical-fixture-account').length,2);
  const job=f.add();f.advance();f.observe(false);
  assert.equal(await f.next(),null);
  assert.equal(f.store.incidents('local-codex-account','canonical-fixture-account').length,2);
  f.identity('canonical-fixture-account');assert.equal((await f.next()).job.id,job.id);
  assert.equal(f.store.incidents('local-codex-account','canonical-fixture-account').filter(i=>i.quota_pool==='main').length,0);
});

test('T4 negative evidence remains scoped and valid, and projections never persist it',async t=>{
  for(const fields of [{capacity_scope_id:'wrong-scope'},{observation_source_id:'other'},
    {account_key:null},{errors:{quota:'unavailable'}},{quota_observed_at:'2026-09-12T14:00:00.000Z'}]) {
    const f=fixture(t);f.observe(true,fields);f.identity(null);
    assert.equal(await f.next(),null);
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM quota_incidents').get().n,0);
  }
  const f=fixture(t),job=f.add();f.observe(true);f.identity('different-account');
  schedulingDecision({store:f.store,config:f.config,job,expectedAccountKey:null,now:'2026-09-12T15:00:00.000Z'});
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM quota_incidents').get().n,0);
  assert.equal(await f.next(),null);
  assert.equal(f.store.incidents('local-codex-account','canonical-fixture-account').length,2);
  assert.equal(f.store.incidents('local-codex-account','different-account').length,0);
});
