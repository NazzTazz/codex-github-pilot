// Independent counter-acceptance regressions, included in npm test.
// Disposable SQLite only; no GitHub, Codex, or personal state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,writeFileSync,existsSync } from 'node:fs';
import { spawnSync,fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { schedulingConfig } from '../src/scheduling-config.mjs';
import { schedulingDecision } from '../src/scheduler.mjs';
import { readSchedulingView,readSchedulingJob,readStatusView,readMetricsView } from '../src/scheduling-view.mjs';
import { createDashboardServer } from '../src/dashboard.mjs';

const at=new Date('2026-09-12T18:00:00.000Z');
const cli=fileURLToPath(new URL('../src/cli.mjs',import.meta.url));
function runCli(f,command) {
  const configFile=path.join(f.dir,'config.json');
  writeFileSync(configFile,JSON.stringify({repository:'fixture/repo',allowedAuthors:['owner'],activeLabel:'active',stateDirectory:'.',checkout:'.',
    timeoutMinutes:30,pollSeconds:60,publish:false,codexCommand:['must-never-be-called'],scheduling:{enabled:true}}));
  return spawnSync(process.execPath,[cli,command,'--json','--config',configFile],{encoding:'utf8',windowsHide:true,timeout:10000});
}
function fixture(t) {
  const dir=mkdtempSync(path.join(os.tmpdir(),'pilot-t5-counter-')),store=new Store(path.join(dir,'queue.sqlite'));
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const observation={mode:'legacy',defaultAccountId:'local',accounts:[{id:'local',label:'Fixture',scopeId:'local-codex-account',codexHome:null}]};
  const config={timeoutMinutes:30,observation,scheduling:schedulingConfig({enabled:true},observation)};
  store.enqueue({id:1},{number:1},'sol-implement','PRIVATE_REQUEST','sol-high',{taskClass:'routine',taskMetadata:{version:1,class:'routine',executionContract:null}});
  const sample=(remaining=90)=>store.recordObservation({started_at:at.toISOString(),finished_at:at.toISOString(),source:'fixture',status:'ok',
    account_key:'PRIVATE_ACCOUNT',plan_type:null,quota_observed_at:at.toISOString(),usage_observed_at:null,usage:null,errors:{},
    quota:{ordinary_usage_allowed:true,spend_control_reached:false,windows:[{limit_id:'codex',remaining_percent:remaining,window_minutes:10080,resets_at:at.getTime()/1000+3600}]},
    capabilities:{account_key:'PRIVATE_ACCOUNT',observed_at:at.toISOString(),models:[{slug:'gpt-5.6-sol',efforts:['medium','high']}]}});
  sample();
  const admit=()=>{
    const job=store.job(1),result=schedulingDecision({store,config,job,expectedAccountKey:'PRIVATE_ACCOUNT',now:at.toISOString()});
    store.transaction(()=>store.saveDecision(job,result.decision,result.fingerprint,'admission',at.toISOString()));
    const run=store.startRun(1,result.decision.assignment);store.telemetry(run,{run_status:'completed'});store.update(1,{status:'completed'});
    return {id:result.decision.assignment.decisionId,run};
  };
  const snapshot=()=>store.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").all().map(table=>
    ({...table,rows:store.db.prepare(`SELECT * FROM ${table.name} ORDER BY rowid`).all()}));
  return {dir,store,config,sample,admit,snapshot};
}

test('control: projections preserve all business rows and historical admission after quota changes',t=>{
  const f=fixture(t),admission=f.admit();f.sample(3);const before=f.snapshot();
  const view=readSchedulingView(f.dir,f.config,at);readStatusView(f.dir,f.config,at);readMetricsView(f.dir);
  assert.deepEqual(f.snapshot(),before);
  assert.equal(view.mode,'survival');assert.equal(view.runs[0].admission.id,admission.id);
  assert.equal(view.runs[0].admission.mode,'premium');assert.equal(view.runs[0].observedModel,null);
  assert.ok(!JSON.stringify(view).includes('PRIVATE_ACCOUNT'));
});

test('status must retain legacy job rows when the scheduling schema is unavailable',t=>{
  const f=fixture(t);f.store.db.exec('DROP TABLE scheduling_decisions');
  const before=f.snapshot(),view=readStatusView(f.dir,f.config,at);
  assert.deepEqual(f.snapshot(),before);assert.equal(view.scheduling.available,false);
  t.diagnostic(JSON.stringify({persistedJobs:f.store.jobs().length,displayedJobs:view.jobs.length}));
  assert.equal(view.jobs.length,1,'A legacy job must not disappear from status solely because scheduling tables are missing');
  assert.equal(view.available,true);
  const result=runCli(f,'status');assert.equal(result.status,0,result.stderr);
  assert.equal(JSON.parse(result.stdout).jobs[0].id,1);assert.deepEqual(f.snapshot(),before);
});

test('malformed task metadata must not become a successful scheduling preview',t=>{
  const f=fixture(t);f.store.db.prepare('UPDATE jobs SET task_metadata_json=? WHERE id=1').run('{broken');
  let view;
  try {view=readSchedulingView(f.dir,f.config,at);} catch {return;}
  t.diagnostic(JSON.stringify({available:view.available,action:view.jobs[0]?.preview?.action}));
  assert.equal(view.available,false,'Corrupt persisted JSON must be reported, not silently ignored');
});

test('HTTP must not expose nested private fields inside persisted public assignment keys',async t=>{
  const f=fixture(t),{id}=f.admit(),decision=f.store.decision(id).decision;
  decision.assignment.model={accountKey:'NESTED_PRIVATE_CANARY',raw:{prompt:'NESTED_PROMPT_CANARY'}};
  f.store.db.prepare('UPDATE scheduling_decisions SET decision_json=? WHERE id=?').run(JSON.stringify(decision),id);
  const server=createDashboardServer({stateDirectory:f.dir,assetDirectory:f.dir,config:f.config,observation:f.config.observation,now:()=>at.getTime()});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const response=await fetch(`http://127.0.0.1:${server.address().port}/api/scheduling`),body=await response.text();
    t.diagnostic(JSON.stringify({status:response.status,nestedCanaryExposed:body.includes('NESTED_PRIVATE_CANARY')}));
    assert.ok(!body.includes('NESTED_PRIVATE_CANARY')&&!body.includes('NESTED_PROMPT_CANARY'),'Public scalar fields must not forward arbitrary nested JSON');
    assert.equal(response.status,503);assert.deepEqual(JSON.parse(body),{error:'scheduling-unavailable'});
  } finally {await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});}
});

test('T5 rejects malformed scalars throughout admission and spawn proof, with closed CLI diagnostics',t=>{
  const mutations=[d=>{d.mode={private:'CANARY_SECRET'};},d=>{d.weeklyPhase=['CANARY_SECRET'];},
    d=>{d.assignment.timeoutMs={private:'CANARY_SECRET'};},d=>{d.assignment.model=['CANARY_SECRET'];}];
  for(const mutate of mutations) {
    const f=fixture(t),{id}=f.admit(),decision=f.store.decision(id).decision;mutate(decision);
    f.store.db.prepare('UPDATE scheduling_decisions SET decision_json=? WHERE id=?').run(JSON.stringify(decision),id);
    assert.throws(()=>readSchedulingView(f.dir,f.config,at),/Invalid saved scheduling data/);
    assert.throws(()=>readSchedulingJob(f.dir,f.config,1,at),/Invalid saved scheduling data/);
    const result=runCli(f,'schedule');assert.equal(result.status,1);assert.equal(result.stdout,'');
    assert.match(result.stderr,/Invalid saved scheduling data/);assert.ok(!result.stderr.includes('CANARY_SECRET'));
  }
  const f=fixture(t),{run}=f.admit();f.store.setSpawnProof(run,{checkedAt:{private:'CANARY_SECRET'}});
  assert.throws(()=>readSchedulingView(f.dir,f.config,at),/Invalid saved scheduling data/);
});

test('T5 corrupt task JSON fails global, detail, status and HTTP without exposing its contents',async t=>{
  const f=fixture(t);f.store.db.prepare('UPDATE jobs SET task_metadata_json=?').run('CANARY_BROKEN_JSON');
  for(const read of [()=>readSchedulingView(f.dir,f.config,at),()=>readSchedulingJob(f.dir,f.config,1,at),()=>readStatusView(f.dir,f.config,at)])
    assert.throws(read,/Invalid saved scheduling data/);
  const cliResult=runCli(f,'schedule');assert.equal(cliResult.status,1);assert.equal(cliResult.stdout,'');assert.ok(!cliResult.stderr.includes('CANARY_BROKEN_JSON'));
  const server=createDashboardServer({stateDirectory:f.dir,assetDirectory:f.dir,config:f.config});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const response=await fetch(`http://127.0.0.1:${server.address().port}/api/scheduling`);
    assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:'scheduling-unavailable'});
  } finally {await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});}
});

test('T5 documented visual fixture starts outside the repository and serves assets plus effort history',async t=>{
  const cwd=mkdtempSync(path.join(os.tmpdir(),'pilot-t5-fixture-launch-'));
  const child=fork(fileURLToPath(new URL('../scripts/t5-dashboard-fixture.mjs',import.meta.url)),['conserve','0'],
    {cwd,windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
  const exited=once(child,'exit');let fixtureDirectory;
  t.after(async()=>{
    if(child.connected)child.send('stop');
    await exited;rmSync(cwd,{recursive:true,force:true});
    if(fixtureDirectory)assert.equal(existsSync(fixtureDirectory),false,'Fixture cleans up its temporary database');
  });
  const ready=await new Promise((resolve,reject)=>{
    let output='',errors='';const timeout=setTimeout(()=>{child.kill();reject(new Error('Fixture startup timed out: '+errors));},10000);
    child.stderr.on('data',data=>{errors+=data;});
    child.once('exit',code=>{clearTimeout(timeout);reject(new Error(`Fixture exited ${code}: ${errors}`));});
    child.stdout.on('data',data=>{output+=data;if(output.includes('\n')){clearTimeout(timeout);try{resolve(JSON.parse(output.split('\n')[0]));}catch(error){reject(error);}}});
  });
  fixtureDirectory=ready.directory;
  // npm test also runs before the optional dashboard build on a fresh checkout.
  if(existsSync(fileURLToPath(new URL('../dashboard/dist/index.html',import.meta.url)))) {
    const page=await fetch(ready.url);assert.equal(page.status,200);const html=await page.text();assert.match(html,/id="root"/);
    const asset=/src="([^"]+\.js)"/.exec(html);assert.ok(asset);assert.equal((await fetch(new URL(asset[1],ready.url))).status,200);
  }
  const view=await (await fetch(new URL('api/scheduling',ready.url))).json();
  assert.equal(view.mode,'conserve');assert.equal(view.observationSourceId,'lite');
  assert.equal(view.runs[0].requestedEffort,'high');assert.equal(view.runs[0].effectiveEffort,'medium');
});
