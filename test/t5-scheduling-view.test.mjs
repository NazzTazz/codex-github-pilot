import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync,mkdtempSync,rmSync,writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { schedulingConfig } from '../src/scheduling-config.mjs';
import { readSchedulingJob,readSchedulingView } from '../src/scheduling-view.mjs';
import { lock } from '../src/cli.mjs';

const at=new Date('2026-09-12T18:00:00.000Z');
const contract={scope:'x',expectedResult:'y',invariants:['z'],areas:[],acceptanceCriteria:['a'],validationCommands:['npm test']};
function fixture(t,{enabled=true}={}) {
  const dir=mkdtempSync(path.join(os.tmpdir(),'pilot-t5-')),file=path.join(dir,'queue.sqlite');
  const observation={mode:'multi',defaultAccountId:'plus',accounts:[{id:'plus',scopeId:'scope-plus',codexHome:path.join(dir,'plus')},{id:'lite',scopeId:'scope-lite',codexHome:path.join(dir,'lite')}]};
  const config={timeoutMinutes:30,observation,scheduling:schedulingConfig(enabled?{enabled:true,observationSourceId:'lite'}:undefined,observation)};
  const store=new Store(file);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const add=(taskClass='routine',profile='sol-high')=>{const id=store.jobs().length+1,metadata={version:1,class:taskClass,executionContract:taskClass==='mechanical'?contract:null};
    store.enqueue({id,user:{login:'owner'}},{number:id},'sol-implement','request-'+id,profile,{taskClass,taskMetadata:metadata});return store.jobs().at(-1);};
  const observe=(remaining=9,{source='lite',account='account-lite',spend=false}={})=>store.recordObservation({started_at:at.toISOString(),finished_at:at.toISOString(),
    account_key:account,plan_type:'lite',source:'fixture',status:'partial',quota_observed_at:at.toISOString(),usage_observed_at:null,usage:null,errors:{},
    observation_source_id:source,capacity_scope_id:`scope-${source}`,quota:{ordinary_usage_allowed:true,spend_control_reached:spend,normal_model_slug:'gpt-5.6-luna',
      windows:[{limit_id:'codex',remaining_percent:remaining,window_minutes:10080,resets_at:Math.floor(at.getTime()/1000)+3600}]},
    capabilities:{account_key:account,observed_at:at.toISOString(),models:['gpt-5.6-sol','gpt-5.6-terra','gpt-5.6-luna'].map(slug=>({slug,efforts:['medium','high']}))}});
  return {dir,file,store,config,add,observe};
}
test('T5 missing databases remain absent and readable schemas expose preview disclaimers',t=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'pilot-t5-missing-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const observation={mode:'legacy',defaultAccountId:'local',accounts:[{id:'local',scopeId:'local-codex-account',codexHome:null}]};
  const config={timeoutMinutes:30,observation,scheduling:schedulingConfig(undefined,observation)};
  const missing=readSchedulingView(dir,config,at);assert.equal(missing.available,false);assert.equal(missing.unavailableReason,'database-missing');
  assert.equal(missing.counts,null);assert.equal(existsSync(path.join(dir,'queue.sqlite')),false);
  const f=fixture(t);f.add();f.observe();const view=readSchedulingView(f.dir,f.config,at);
  assert.equal(view.projectionKind,'preview');assert.equal(view.identityVerification,'not-performed');assert.equal(view.requiresLiveValidation,true);
  assert.equal(view.observationSourceId,'lite');assert.equal(view.jobs[0].preview.assignment.decisionId,null);
});
test('T5 counts precede truncation, detail bypasses it, and malformed mechanical contracts are not ready',t=>{
  const f=fixture(t);for(let i=0;i<104;i++)f.add(i===103?'mechanical':'routine');
  f.store.enqueue({id:105,user:{login:'owner'}},{number:105},'sol-implement','bad','sol-medium',{taskClass:'mechanical',taskMetadata:{version:1,class:'mechanical',executionContract:{scope:'bad'}}});
  f.observe();const view=readSchedulingView(f.dir,f.config,at);
  assert.equal(view.jobs.length,100);assert.equal(view.jobsTotal,105);assert.equal(view.counts.candidateJobs,105);assert.equal(view.counts.mechanicalReadyJobs,1);assert.equal(view.jobsTruncated,true);
  const detail=readSchedulingJob(f.dir,f.config,104,at);assert.equal(detail.job.id,104);
});
test('T5 public DTO recursively excludes account, request, path, raw errors and override prose',t=>{
  const f=fixture(t),job=f.add('exploratory');f.observe();f.store.createOverride(job.id,'CANARY_ACTOR','CANARY_REASON',at.toISOString());
  const view=readSchedulingView(f.dir,f.config,at),serialized=JSON.stringify(view);
  for(const canary of ['account-lite','request-1','CANARY_ACTOR','CANARY_REASON',f.dir,'executionContract','decision_json'])assert.equal(serialized.includes(canary),false,canary);
  assert.equal(view.jobs[0].override.state,'active');assert.equal(view.jobs[0].preview.assignment?.decisionId??null,null);
});
test('T5 uses selected Lite despite default Plus and keeps disabled routing historical',t=>{
  const f=fixture(t);f.add();f.observe(90,{source:'plus',account:'account-plus',spend:true});f.observe(9);
  let view=readSchedulingView(f.dir,f.config,at);assert.equal(view.observationSourceId,'lite');assert.equal(view.mode,'conserve');assert.equal(view.jobs[0].preview.assignment.effectiveProfile,'terra-medium');
  f.config.scheduling=schedulingConfig(undefined,f.config.observation);view=readSchedulingView(f.dir,f.config,at);
  assert.equal(view.enabled,false);assert.equal(view.mode,null);assert.equal(view.jobs[0].preview.assignment.model,'gpt-5.6-sol');
});
test('T5 CLI emits one JSON document, accepts option order, rejects invalid IDs, and ignores the worker lock',async t=>{
  const f=fixture(t);f.add();f.observe();const configFile=path.join(f.dir,'config.json');
  writeFileSync(configFile,JSON.stringify({repository:'owner/repo',checkout:'.',allowedAuthors:['owner'],activeLabel:'active',pollSeconds:60,
    timeoutMinutes:30,stateDirectory:'.',publish:false,codexCommand:['codex'],observation:{defaultAccountId:'plus',accounts:[
      {id:'plus',label:'Plus',codexHome:path.join(f.dir,'plus')},{id:'lite',label:'Lite',codexHome:path.join(f.dir,'lite')}]},
    scheduling:{enabled:true,observationSourceId:'lite'}}));
  const release=await lock(f.dir);t.after(release);
  const run=args=>spawnSync(process.execPath,[path.resolve('src/cli.mjs'),'schedule',...args,'--config',configFile],{encoding:'utf8',windowsHide:true,timeout:10000});
  for(const args of [['--json'],['--json','1'],['1','--json']]){const result=run(args);assert.equal(result.status,0,result.stderr);assert.doesNotThrow(()=>JSON.parse(result.stdout));}
  for(const id of ['0','-1','1.5','missing'])assert.notEqual(run(['--json',id]).status,0);
  assert.notEqual(run(['--json','999']).status,0);
});
