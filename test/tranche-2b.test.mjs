import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/cli.mjs';
import { executionFor, internalProfiles, parseCommand, poll, profiles, roles } from '../src/core.mjs';
import { executionInput, runJob, staticAssignment } from '../src/runner.mjs';
import { localCodexTarget, schedulingConfig, schedulingDefaults } from '../src/scheduling-config.mjs';
import { Store } from '../src/store.mjs';

const baseConfig={repository:'owner/repo',checkout:'.',stateDirectory:'state',allowedAuthors:['owner'],activeLabel:'agent:active',
  codexCommand:['codex'],pollSeconds:60,timeoutMinutes:30,publish:false};
const issue={number:1,state:'open',labels:[{name:'agent:active'}],title:'Task',body:'Specification'};
const human={login:'owner',type:'User'};
const command=(body,id=1)=>({id,created_at:'2026-09-12T00:00:00Z',body,issue_url:'https://api.github.com/repos/owner/repo/issues/1',user:human});
const temp=()=>mkdtempSync(path.join(os.tmpdir(),'pilot-2b-'));

test('roles expose functional constraints and sol-plan accepts only planning classes when explicit',()=>{
  assert.deepEqual(Object.fromEntries(Object.entries(roles).map(([name,r])=>[name,[r.functionalRole,r.requiresPr,r.mayChangeTrackedFiles]])),{
    'sol-implement':['implementation',false,true],'sol-review':['review',true,false],
    'astra-review':['review',true,false],'sol-plan':['specification',false,false]});
  assert.equal(roles['astra-review'].neverDegrade,true);
  assert.equal(parseCommand('/agent sol-plan\nPlan this').classificationError,null);
  for(const taskClass of ['complex','exploratory'])assert.equal(parseCommand(`/agent sol-plan\n\`\`\`pilot-task\n{"class":"${taskClass}"}\n\`\`\``).classificationError,null);
  for(const taskClass of ['mechanical','routine'])assert.equal(parseCommand(`/agent sol-plan\n\`\`\`pilot-task\n{"class":"${taskClass}"}\n\`\`\``).classificationError,'pilot-task-role-incompatible');
});

test('pilot-task fences remain exact through parseCommand, polling, and SQLite persistence',async t=>{
  const directory=temp(),store=new Store(path.join(directory,'queue.sqlite'));t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  store.set('firstStarted','2026-09-12T00:00:00Z');store.set('since','2026-09-12T00:00:00Z');
  const indented=command('/agent sol-implement\n  ```pilot-task\n{"class":"mechanical"}\n```',21);
  const paddedClose=command('/agent sol-implement\n```pilot-task\n{"class":"mechanical"}\n```   ',22);
  assert.equal(parseCommand(indented.body).taskClass,'unclassified');
  assert.equal(parseCommand(paddedClose.body).classificationError,'pilot-task-unclosed');
  await poll(baseConfig,store,{async *pages(){yield indented;yield paddedClose;},async issue(){return issue;}},new Date('2026-09-12T00:01:00Z'));
  const rows=store.jobs();assert.equal(rows[0].task_class,'unclassified');assert.equal(rows[0].status,'queued');
  assert.equal(rows[1].task_class,'unclassified');assert.equal(rows[1].status,'invalid');assert.equal(rows[1].error,'pilot-task-unclosed');
  assert.equal(rows[0].task_metadata_json,null);assert.equal(rows[1].task_metadata_json,null);
});

test('changing only closing-fence spaces after queueing cancels before authentication',async t=>{
  const directory=temp(),store=new Store(path.join(directory,'queue.sqlite'));t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  store.set('firstStarted','2026-09-12T00:00:00Z');store.set('since','2026-09-12T00:00:00Z');
  const original=command('/agent sol-implement\n```pilot-task\n{"class":"mechanical"}\n```',31);
  await poll(baseConfig,store,{async *pages(){yield original;},async issue(){return issue;}},new Date('2026-09-12T00:01:00Z'));
  const job=store.claim(),edited={...original,body:`${original.body}   `};let authenticated=false;
  await runJob({...baseConfig,stateDirectory:directory,checkout:'source'},store,{issue:async()=>issue,request:async()=>edited},job,directory,{
    authenticate:async()=>{authenticated=true;throw new Error('authentication must not be reached');}
  });
  assert.equal(authenticated,false);assert.equal(store.job(job.id).status,'cancelled');
  assert.match(store.job(job.id).error,/classification|metadata|request changed/i);
});

test('public Terra and Luna profiles resolve while the reserve profile remains internal',()=>{
  assert.deepEqual(executionFor({role:'sol-implement',profile:'terra-medium'}),{...roles['sol-implement'],...profiles['terra-medium']});
  assert.equal(executionFor({role:'sol-implement',profile:'luna-medium'}).model,'gpt-5.6-luna');
  assert.equal(parseCommand('/agent sol-implement luna-reserve-medium\nTask'),null);
  assert.throws(()=>executionFor({role:'sol-implement',profile:'luna-reserve-medium'}),/Invalid model profile/);
  assert.equal(internalProfiles['luna-reserve-medium'].model,'gpt-reserve');
});

test('scheduling configuration is materialized, strict, and builds one serializable local target',()=>{
  const defaults=schedulingConfig();assert.deepEqual(defaults,{...schedulingDefaults,offeredProfiles:[...schedulingDefaults.offeredProfiles]});
  const enabled=schedulingConfig({enabled:true,reserveEnabled:true,conserveAtPercent:20,survivalBelowPercent:4,
    maxObservationAgeSeconds:30,quotaErrorCooldownSeconds:3600,survivalPlanTimeoutMinutes:120,offeredProfiles:['luna-medium']});
  const target=localCodexTarget({scheduling:enabled});assert.doesNotThrow(()=>structuredClone(target));
  assert.deepEqual(target,{id:'local-codex',provider:'openai',adapter:'codex-exec',capacityScopeId:'local-codex-account',offeredProfiles:['luna-medium']});
  const invalid=[null,{extra:true},{enabled:'yes'},{conserveAtPercent:'15'},{survivalBelowPercent:0},{survivalBelowPercent:15},
    {maxObservationAgeSeconds:29},{maxObservationAgeSeconds:30.5},{quotaErrorCooldownSeconds:29},{survivalPlanTimeoutMinutes:121},
    {offeredProfiles:null},{offeredProfiles:false},{offeredProfiles:0},{offeredProfiles:''},{offeredProfiles:[]},
    {offeredProfiles:['sol-medium','sol-medium']},{offeredProfiles:['luna-reserve-medium']},
    {reserveEnabled:true},{enabled:true,reserveEnabled:true,offeredProfiles:['sol-medium']}];
  for(const value of invalid)assert.throws(()=>schedulingConfig(value),/Invalid scheduling configuration/);
});

test('loadConfig defaults scheduling without changing historical execution settings',async t=>{
  const directory=temp();t.after(()=>rmSync(directory,{recursive:true,force:true}));const file=path.join(directory,'config.json');writeFileSync(file,JSON.stringify(baseConfig));
  const loaded=await loadConfig(file);assert.deepEqual(loaded.scheduling,schedulingConfig());
  assert.equal(loaded.timeoutMinutes,30);assert.equal(loaded.publish,false);
});

test('audit migrations are repeatable and preserve legacy rows without invented decisions',t=>{
  const directory=temp();t.after(()=>rmSync(directory,{recursive:true,force:true}));const file=path.join(directory,'queue.sqlite'),db=new DatabaseSync(file);
  db.exec(`CREATE TABLE jobs (id INTEGER PRIMARY KEY,comment_id INTEGER UNIQUE NOT NULL,issue INTEGER NOT NULL,role TEXT NOT NULL,request TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',payload TEXT NOT NULL,sha TEXT,directory TEXT,result TEXT,error TEXT,created TEXT NOT NULL,updated TEXT NOT NULL,profile TEXT);
    CREATE TABLE worker_runs (id INTEGER PRIMARY KEY,job_id INTEGER NOT NULL,model_requested TEXT NOT NULL,reasoning_effort TEXT NOT NULL,job_started_at TEXT NOT NULL,worker_started_at TEXT,finished_at TEXT,preparation_ms INTEGER,worker_ms INTEGER,total_ms INTEGER,pid INTEGER,exit_code INTEGER,timed_out INTEGER,session_id TEXT,completed_turns INTEGER DEFAULT 0,input_tokens INTEGER,cached_input_tokens INTEGER,cache_write_input_tokens INTEGER,output_tokens INTEGER,reasoning_output_tokens INTEGER,usage_json TEXT NOT NULL DEFAULT '[]',errors_json TEXT NOT NULL DEFAULT '[]',malformed_lines INTEGER NOT NULL DEFAULT 0,run_status TEXT NOT NULL DEFAULT 'running',run_error TEXT);
    INSERT INTO jobs(comment_id,issue,role,request,payload,created,updated) VALUES(1,1,'sol-review','old','{}','2026-01-01','2026-01-01');
    INSERT INTO worker_runs(job_id,model_requested,reasoning_effort,job_started_at) VALUES(1,'gpt-5.6-sol','medium','2026-01-01');`);db.close();
  const store=new Store(file);assert.equal(store.job(1).last_schedule_decision_id,null);assert.equal(store.metrics()[0].model_effective,null);
  store.recordObservation({started_at:'2026-01-02',finished_at:'2026-01-02',account_key:null,plan_type:null,source:'test',status:'ok',
    quota_observed_at:null,usage_observed_at:null,quota:null,usage:null,errors:[],capacity_scope_id:'scope-1',capabilities:{models:['terra-medium']}});
  assert.equal(store.observations()[0].capacity_scope_id,'scope-1');assert.deepEqual(store.observations()[0].capabilities,{models:['terra-medium']});
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM scheduling_decisions').get().n,0);store.close();new Store(file).close();
});

test('structured assignment and frozen input are persisted distinctly without local paths',t=>{
  const directory=temp(),store=new Store(path.join(directory,'queue.sqlite'));t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  store.enqueue(command('/agent sol-implement terra-medium\nTask'),issue,'sol-implement','Task','terra-medium');const job=store.job(1);
  const execution=executionFor(job),assignment=staticAssignment(job,execution,{timeoutMinutes:30});
  assert.equal(assignment.requestedModel,'gpt-5.6-terra');assert.equal(assignment.requestedEffort,'medium');assert.equal(assignment.quotaPool,null);
  const input=executionInput(baseConfig,job,issue,'a'.repeat(40),7,null),runId=store.startRun(1,assignment,input);
  store.telemetry(runId,{model_observed:'gpt-5.6-terra'});const row=store.metrics()[0];
  assert.equal(row.model_requested,'gpt-5.6-terra');assert.equal(row.model_effective,'gpt-5.6-terra');assert.equal(row.effort_requested,'medium');
  assert.equal(row.target_id,'local-codex');assert.equal(row.provider,'openai');assert.equal(row.adapter,'codex-exec');assert.equal(row.capacity_scope_id,'local-codex-account');
  assert.equal(row.model_observed,'gpt-5.6-terra');assert.equal(JSON.parse(row.execution_input_json).functionalRole,'implementation');
  assert.equal(row.execution_input_json.includes(directory),false);assert.equal(row.scheduling_decision_id,null);
  const routed=store.startRun(1,{...assignment,model:'gpt-5.6-luna',effort:'medium'},input),routedRow=store.metrics().find(value=>value.id===routed);
  assert.equal(routedRow.model_requested,'gpt-5.6-terra');assert.equal(routedRow.model_effective,'gpt-5.6-luna');assert.equal(routedRow.effort_requested,'medium');
});

test('review and plan may write in their workspace but may not change tracked files',()=>{
  for(const role of ['sol-review','astra-review','sol-plan']) {
    const input=executionInput(baseConfig,{id:1,role,request:'Task',task_class:'unclassified'},issue,'a'.repeat(40),1,null);
    assert.equal(input.requirements.workspaceWrite,true);
    assert.equal(input.requirements.mayChangeTrackedFiles,false);
    assert.equal(input.requirements.trackedFilesMustRemainUnchanged,true);
    assert.equal(executionFor({role}).sandbox,'workspace-write');
  }
});

test('sol-plan runs on an issue but rejects tracked changes and creates no scheduling records',async t=>{
  const directory=temp(),store=new Store(path.join(directory,'queue.sqlite'));t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  const body='/agent sol-plan\nPlan this',source=command(body);store.enqueue(source,issue,'sol-plan','Plan this');const job=store.claim();
  const api={issue:async()=>issue,request:async value=>value===''?{default_branch:'main'}:source};
  await runJob({...baseConfig,stateDirectory:directory,checkout:'source'},store,api,job,directory,{authenticate:async()=>{},
    git:async args=>args[0]==='rev-parse'?'b'.repeat(40):args[0]==='status'?' M src/file.mjs':'',
    executor:{execute:async()=>({status:'completed',report:{verdict:'pass',summary:'Plan',findings:[],validation:[]},workerMs:1,exitCode:0,timedOut:false,telemetry:{}})}});
  assert.equal(store.job(1).status,'failed');assert.match(store.job(1).error,/changed tracked files/);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM scheduling_decisions').get().n,0);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM quota_incidents').get().n,0);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM scheduling_overrides').get().n,0);
});
