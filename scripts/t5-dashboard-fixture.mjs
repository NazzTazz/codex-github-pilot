import { mkdtempSync,rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.mjs';
import { createDashboardServer } from '../src/dashboard.mjs';
import { schedulingConfig } from '../src/scheduling-config.mjs';
import { schedulingDecision } from '../src/scheduler.mjs';

const root=fileURLToPath(new URL('../',import.meta.url)),mode=process.argv[2]??'conserve',port=Number(process.argv[3]??43175);
const directory=mkdtempSync(path.join(os.tmpdir(),`pilot-t5-visual-${mode}-`)),now=new Date('2026-09-12T18:00:00.000Z');
const observation={mode:'multi',defaultAccountId:'plus',accounts:[{id:'plus',label:'Plus',codexHome:path.join(directory,'plus'),scopeId:'scope-plus'},
  {id:'lite',label:'Pro Lite',codexHome:path.join(directory,'lite'),scopeId:'scope-lite'}]};
const enabled=mode!=='disabled',scheduling=schedulingConfig(enabled?{enabled:true,observationSourceId:'lite',reserveEnabled:mode==='reserve'}:undefined,observation);
const config={timeoutMinutes:30,observation,scheduling},store=new Store(path.join(directory,'queue.sqlite'));
const remaining=mode==='survival'?3:mode==='premium'?82:9,ordinary=mode==='reserve'?false:true,account=mode==='unknown'?null:'fixture-lite';
const record=(source,labelRemaining,key='fixture-plus')=>store.recordObservation({started_at:now.toISOString(),finished_at:now.toISOString(),account_key:key,
  plan_type:source==='plus'?'plus':'lite',source:'visual-fixture',status:'partial',quota_observed_at:now.toISOString(),usage_observed_at:now.toISOString(),errors:{},
  observation_source_id:source,capacity_scope_id:`scope-${source}`,quota:{ordinary_usage_allowed:source==='lite'?ordinary:true,spend_control_reached:false,
    normal_model_slug:'gpt-5.6-luna',windows:[{limit_id:'codex',limit_name:'Codex',window:'primary',remaining_percent:labelRemaining,used_percent:100-labelRemaining,
      window_minutes:10080,resets_at:Math.floor(now.getTime()/1000)+86400},...(source==='lite'?[{limit_id:'base_model_inference',limit_name:'Luna',window:'primary',remaining_percent:72,used_percent:28,
      window_minutes:10080,resets_at:Math.floor(now.getTime()/1000)+86400}]:[])]},usage:{lifetime_tokens:123456,peak_daily_tokens:42000,daily_buckets:[]},
  capabilities:key?{account_key:key,observed_at:now.toISOString(),models:['gpt-5.6-sol','gpt-5.6-terra','gpt-5.6-luna','gpt-reserve'].map(slug=>({slug,efforts:['medium','high']}))}:null});
record('plus',64);record('lite',remaining,account);
for(const [index,taskClass] of ['routine','complex','mechanical'].entries())store.enqueue({id:index+1},{number:index+41},'sol-implement',`visual-${index}`,'sol-high',
  {taskClass,taskMetadata:{version:1,class:taskClass,executionContract:taskClass==='mechanical'?{scope:'Labels',expectedResult:'Labels',invariants:['Logic'],areas:[],acceptanceCriteria:['Visible'],validationCommands:['npm test']}:null}});
// A real persisted admission with simulated completion, never an executor call.
if(mode==='conserve') {
  store.enqueue({id:4},{number:44},'sol-implement','visual-history','sol-high',{taskClass:'complex'});
  const job=store.job(4),result=schedulingDecision({store,config,job,expectedAccountKey:'fixture-lite',now:now.toISOString()});
  store.transaction(()=>store.saveDecision(job,result.decision,result.fingerprint,'admission',now.toISOString()));
  const run=store.startRun(job.id,result.decision.assignment);
  store.telemetry(run,{run_status:'completed',finished_at:now.toISOString()});store.update(job.id,{status:'completed'});
}
store.close();
const server=createDashboardServer({stateDirectory:directory,assetDirectory:path.join(root,'dashboard','dist'),observation,scheduling,config,now:()=>now.getTime()});
const close=()=>{server.close(()=>{rmSync(directory,{recursive:true,force:true});process.exit(0);});server.closeAllConnections();};
process.on('SIGINT',close);process.on('SIGTERM',close);
process.on('message',message=>{if(message==='stop')close();});
server.listen(port,'127.0.0.1',()=>console.log(JSON.stringify({url:`http://127.0.0.1:${server.address().port}/`,mode,directory})));
