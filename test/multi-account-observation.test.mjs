import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { observationConfig } from '../src/observation-config.mjs';
const { collectObservation, collectObservations, observationDelta }=await import(process.env.PILOT_OBSERVATION_MODULE??'../src/observation.mjs');
const { createDashboardServer, readAccountsQuota }=await import(process.env.PILOT_DASHBOARD_MODULE??'../src/dashboard.mjs');
import { Store } from '../src/store.mjs';
import { execute } from '../src/process.mjs';

const temporary=()=>mkdtempSync(path.join(os.tmpdir(),'pilot-accounts-'));
const configured=directory=>observationConfig({defaultAccountId:'plus',accounts:[
  {id:'plus',label:'Plus',codexHome:path.join(directory,'plus')},{id:'lite',label:'Pro Lite',codexHome:path.join(directory,'lite')}]});
const quota=(id,used=10)=>({accountId:id,rateLimits:{},rateLimitsByLimitId:{[id]:{limitName:id,primary:{usedPercent:used,windowDurationMins:10080,resetsAt:1900000000}}},ordinaryUsageAllowed:true});
const usage=tokens=>({summary:{lifetimeTokens:tokens,peakDailyTokens:tokens},dailyUsageBuckets:[]});
const client=(id,delay=0,failure=null)=>({initialize:async()=>{},close:async()=>{},request:async method=>{
  if(method==='account/read')return {account:{type:'chatgpt',email:`${id}@fixture.test`,planType:id}};
  await new Promise(resolve=>setTimeout(resolve,delay));
  if(failure&&method==='account/rateLimits/read')throw new Error(failure);
  return method==='account/rateLimits/read'?quota(id):usage(id==='plus'?100:200);
}});

test('multi-account configuration is strict and legacy mode remains explicit',()=>{
  assert.deepEqual(observationConfig(),{mode:'legacy',defaultAccountId:'local',accounts:[{id:'local',label:'Codex',codexHome:null,scopeId:'local-codex-account'}]});
  const directory=path.resolve('profiles'),value=configured(directory);assert.equal(value.accounts[1].scopeId,'codex-observation:lite');
  const bad=[null,{}, {defaultAccountId:'plus',accounts:null},{defaultAccountId:'x',accounts:[{id:'plus',label:'Plus',codexHome:path.join(directory,'a')}]},
    {defaultAccountId:'Plus',accounts:[{id:'Plus',label:'Plus',codexHome:path.join(directory,'a')}]},
    {defaultAccountId:'plus',accounts:[{id:'plus',label:'',codexHome:path.join(directory,'a')}]},
    {defaultAccountId:'plus',accounts:[{id:'plus',label:'Plus',codexHome:'relative'}]},
    {defaultAccountId:'plus',accounts:[{id:'plus',label:'Plus',codexHome:path.join(directory,'a')},{id:'plus',label:'Other',codexHome:path.join(directory,'b')}]},
    {defaultAccountId:'plus',accounts:[{id:'plus',label:'Plus',codexHome:path.join(directory,'a')},{id:'lite',label:'Lite',codexHome:path.join(directory,'a')}]},
    {defaultAccountId:'plus',accounts:[{id:'plus',label:'Plus',codexHome:path.join(directory,'a'),extra:true}]}];
  for(const input of bad)assert.throws(()=>observationConfig(input),/Invalid observation configuration/);
});

test('two sources collect independently with isolated filtered environments and reverse completion',async t=>{
  const directory=temporary(),store=new Store(path.join(directory,'queue.sqlite'));t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  const observation=configured(directory),seen=[],environments=[],closed=[],parent=process.env.CODEX_HOME;
  const samples=await collectObservations({codexCommand:['codex'],observation},store,{createClient:(source,env)=>{
    environments.push(env);seen.push({id:source.id,home:env.CODEX_HOME,openai:env.OPENAI_API_KEY,github:env.GITHUB_TOKEN});
    const result=client(source.id,source.id==='plus'?30:1,source.id==='plus'?'quota offline':null);result.close=async()=>{closed.push(source.id);};return result;
  }});
  assert.deepEqual(samples.map(sample=>sample.observation_source_id),['plus','lite']);assert.equal(samples[0].status,'partial');assert.equal(samples[1].status,'ok');
  assert.deepEqual(store.latestObservations(['plus','lite']).map(row=>row.observation_source_id),['plus','lite']);
  assert.deepEqual(seen.map(row=>row.home).sort(),observation.accounts.map(row=>row.codexHome).sort());
  assert.notEqual(environments[0],environments[1]);
  assert.deepEqual(closed.sort(),['lite','plus']);
  assert.ok(seen.every(row=>row.openai===undefined&&row.github===undefined));assert.equal(process.env.CODEX_HOME,parent);
  assert.equal(store.jobs().length,0);assert.equal(store.get('quotaPaused'),undefined);
});

test('interleaved histories and deltas stay within source and real identity',t=>{
  const directory=temporary(),store=new Store(path.join(directory,'queue.sqlite'));t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  const save=(source,key,tokens,id)=>store.recordObservation({started_at:'2026-09-12',finished_at:`2026-09-12T00:00:0${id}Z`,account_key:key,plan_type:'fixture',source:'test',status:'ok',
    quota_observed_at:'2026-09-12',usage_observed_at:'2026-09-12',quota:{windows:[],ordinary_usage_allowed:true},usage:{lifetime_tokens:tokens},errors:{},observation_source_id:source,capacity_scope_id:`codex-observation:${source}`});
  save('plus','a',100,1);save('lite','b',900,2);save('plus','a',125,3);save('lite','c',800,4);
  const plus=store.observationsBySource('plus'),lite=store.observationsBySource('lite');
  assert.equal(observationDelta(plus[0],plus[1]).account_tokens_delta,25);assert.equal(observationDelta(plus[1],lite[1]),null);
  assert.equal(observationDelta({...plus[0],account_key:'same'},{...lite[0],account_key:'same'}),null);
  assert.equal(observationDelta(lite[0],lite[1]),null);assert.deepEqual(store.latestObservations(['plus','lite']).map(row=>row.id),[3,4]);
});

test('accounts quota projection keeps default stable, detects changed/shared identity, and hides identity',t=>{
  const directory=temporary(),store=new Store(path.join(directory,'queue.sqlite')),observation=configured(directory);t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  const save=(source,key,id,finished='2026-09-12T10:00:00Z')=>store.recordObservation({started_at:finished,finished_at:finished,account_key:key,plan_type:source,
    source:'test',status:'ok',quota_observed_at:finished,usage_observed_at:finished,quota:{windows:[],ordinary_usage_allowed:true},usage:{lifetime_tokens:id},errors:{},observation_source_id:source});
  save('plus','identity-secret-old',1,'2026-09-12T09:59:00Z');save('plus','identity-secret-current',2);save('lite','identity-secret-current',3);
  const payload=readAccountsQuota(directory,observation,Date.parse('2026-09-12T10:01:00Z'));
  assert.equal(payload.defaultAccountId,'plus');assert.deepEqual(payload.accounts.map(account=>account.id),['plus','lite']);
  assert.deepEqual(payload.accounts.map(account=>account.observationId),[2,3]);assert.deepEqual(payload.accounts.map(account=>account.planType),['plus','lite']);
  assert.equal(payload.accounts[0].identityStatus,'changed');assert.deepEqual(payload.accounts[0].sharedQuotaWith,['lite']);assert.deepEqual(payload.accounts[1].sharedQuotaWith,['plus']);
  for(const secret of ['identity-secret-current','identity-secret-old',observation.accounts[0].codexHome])assert.equal(JSON.stringify(payload).includes(secret),false);
  const stale=readAccountsQuota(directory,observation,Date.parse('2026-09-12T11:00:00Z'));assert.deepEqual(stale.accounts[0].sharedQuotaWith,[]);
});

test('a transient quota failure leaves identity unknown and recovery does not invent an account change',async t=>{
  const directory=temporary(),store=new Store(path.join(directory,'queue.sqlite')),observation=configured(directory);t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  const plus=observation.accounts[0],lite=observation.accounts[1],createClient=value=>()=>value;
  const first=await collectObservation({codexCommand:['codex']},store,plus,{createClient:createClient(client('shared'))});
  const failed=await collectObservation({codexCommand:['codex']},store,plus,{createClient:createClient(client('shared',0,'quota offline'))});
  assert.equal(failed.account_key,null);assert.equal(observationDelta(first,failed),null);
  assert.equal(readAccountsQuota(directory,observation).accounts[0].identityStatus,'unknown');
  const recovered=await collectObservation({codexCommand:['codex']},store,plus,{createClient:createClient(client('shared'))});
  assert.equal(observationDelta(failed,recovered),null);
  assert.equal(readAccountsQuota(directory,observation).accounts[0].identityStatus,'observed');
  await collectObservation({codexCommand:['codex']},store,lite,{createClient:createClient(client('shared'))});
  assert.deepEqual(readAccountsQuota(directory,observation).accounts.map(account=>account.sharedQuotaWith),[['lite'],['plus']]);
});

test('source migration is additive and legacy rows remain local',t=>{
  const directory=temporary();t.after(()=>rmSync(directory,{recursive:true,force:true}));const file=path.join(directory,'queue.sqlite'),db=new DatabaseSync(file);
  db.exec(`CREATE TABLE account_observations(id INTEGER PRIMARY KEY,started_at TEXT NOT NULL,finished_at TEXT NOT NULL,account_key TEXT,plan_type TEXT,source TEXT NOT NULL,status TEXT NOT NULL,quota_observed_at TEXT,usage_observed_at TEXT,quota_json TEXT,usage_json TEXT,errors_json TEXT NOT NULL);
    INSERT INTO account_observations(started_at,finished_at,source,status,errors_json) VALUES('x','x','old','error','{}');`);db.close();
  assert.equal(readAccountsQuota(directory,undefined,Date.now()).accounts[0].collectionStatus,'error');
  const readOnlyCheck=new DatabaseSync(file,{readOnly:true});assert.equal(readOnlyCheck.prepare('PRAGMA table_info(account_observations)').all().some(column=>column.name==='observation_source_id'),false);readOnlyCheck.close();
  const store=new Store(file);assert.equal(store.observations()[0].observation_source_id,'local');store.close();new Store(file).close();
});

test('one-off CLI saves every account, exits nonzero after a partial source, and watch stays alive',{timeout:15000},async t=>{
  const directory=temporary();t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const script=path.join(directory,'multi-account-server.mjs');
  writeFileSync(script,`import readline from 'node:readline';
    const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
    const source=(process.env.CODEX_HOME||'').endsWith('plus')?'plus':'lite';
    readline.createInterface({input:process.stdin}).on('line',line=>{const message=JSON.parse(line);if(!message.id)return;
      if(message.method==='initialize')return send({id:message.id,result:{}});
      if(message.method==='account/read')return send({id:message.id,result:{account:{type:'chatgpt',email:source+'@fixture.test',planType:source}}});
      if(message.method==='account/rateLimits/read'&&source==='plus')return send({id:message.id,error:{code:-32001,message:'fixture failure'}});
      if(message.method==='account/rateLimits/read')return send({id:message.id,result:${JSON.stringify(quota('lite'))}});
      if(message.method==='account/usage/read')return send({id:message.id,result:${JSON.stringify(usage(42))}});
    });`);
  const configFile=path.join(directory,'config.json'),observation=configured(directory);
  writeFileSync(configFile,JSON.stringify({repository:'owner/repo',allowedAuthors:['owner'],activeLabel:'agent:active',
    codexCommand:[process.execPath,script],stateDirectory:directory,checkout:directory,pollSeconds:60,timeoutMinutes:1,publish:false,
    observation:{defaultAccountId:observation.defaultAccountId,accounts:observation.accounts.map(({id,label,codexHome})=>({id,label,codexHome}))}}));
  const cli=fileURLToPath(new URL('../src/cli.mjs',import.meta.url));
  const result=await execute(process.execPath,[cli,'observe','--once','--json','--config',configFile],{timeoutMs:10000});
  assert.equal(result.code,1,result.stderr);assert.deepEqual(JSON.parse(result.stdout).map(sample=>[sample.observation_source_id,sample.status]),[['plus','partial'],['lite','ok']]);
  const store=new Store(path.join(directory,'queue.sqlite'));
  assert.deepEqual(store.latestObservations(['plus','lite']).map(sample=>[sample.observation_source_id,sample.status]),[['plus','partial'],['lite','ok']]);
  const watcher=spawn(process.execPath,[cli,'observe','--watch','--config',configFile],{windowsHide:true,stdio:'ignore'});t.after(()=>watcher.kill());
  const watcherClosed=new Promise(resolve=>watcher.once('close',resolve));
  for(let attempt=0;attempt<70&&store.observations().length<4;attempt++)await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(store.observations().length,4);assert.equal(watcher.exitCode,null);
  const stop=await execute(process.execPath,[cli,'stop-observe','--config',configFile],{timeoutMs:5000});assert.equal(stop.code,0,stop.stderr);
  assert.equal(await watcherClosed,0);store.close();
});

test('multi-account HTTP API exposes every configured source and keeps compatibility on the default',async t=>{
  const directory=temporary(),assets=path.join(directory,'assets'),store=new Store(path.join(directory,'queue.sqlite')),observation=configured(directory);
  mkdirSync(assets);writeFileSync(path.join(assets,'index.html'),'ok');
  const save=(source,key,windows)=>store.recordObservation({started_at:'2026-09-12T10:00:00Z',finished_at:'2026-09-12T10:00:00Z',account_key:key,plan_type:source,
    source:'test',status:'ok',quota_observed_at:'2026-09-12T10:00:00Z',usage_observed_at:'2026-09-12T10:00:00Z',quota:{windows,ordinary_usage_allowed:true},usage:{lifetime_tokens:1},errors:{},observation_source_id:source});
  const window=(limit_id,window,minutes)=>({limit_id,limit_name:null,window,used_percent:10,remaining_percent:90,window_minutes:minutes,resets_at:1900000000,reached_type:null});
  save('plus','plus-secret',[window('codex','primary',300),window('codex','secondary',10080)]);
  save('lite','lite-secret',[window('codex','secondary',10080),window('luna','primary',null),window('spark','primary',300),window('spark','secondary',null)]);store.close();
  const server=createDashboardServer({stateDirectory:directory,assetDirectory:assets,observation,now:()=>Date.parse('2026-09-12T10:01:00Z')});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();rmSync(directory,{recursive:true,force:true});}));
  const base=`http://127.0.0.1:${server.address().port}`,all=await (await fetch(base+'/api/accounts/quota')).json();
  assert.deepEqual(all.accounts.map(account=>[account.id,account.quota.windows.length]),[['plus',2],['lite',4]]);assert.equal(all.defaultAccountId,'plus');
  const compatible=await (await fetch(base+'/api/quota')).json();assert.equal(compatible.quota.windows.length,2);
  assert.equal((await fetch(base+'/api/accounts/quota',{method:'HEAD'})).status,200);assert.equal((await fetch(base+'/api/accounts/quota',{method:'POST'})).status,405);
  for(const secret of ['plus-secret','lite-secret',observation.accounts[0].codexHome])assert.equal(JSON.stringify(all).includes(secret),false);
});

test('documented profile setup preserves an existing Codex config file',{skip:process.platform!=='win32'},async t=>{
  const readme=readFileSync(fileURLToPath(new URL('../README.md',import.meta.url)),'utf8');
  const start=readme.indexOf('  $configPath ='),end=readme.indexOf('  $previousCodexHome =',start);
  assert.ok(start>=0&&end>start,'Documented configuration block must exist');
  const snippet=readme.slice(start,end).replaceAll('$profile.Home','$reviewProfile.Home');
  const directory=temporary();t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const file=path.join(directory,'config.toml');
  const script=`$ErrorActionPreference = 'Stop'\n$reviewProfile = @{ Home = $env:PILOT_TEST_PROFILE }\ntry {\n${snippet}\n} catch { Write-Output $_.Exception.Message; exit 1 }`;
  const run=()=>execute('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],
    {env:{...process.env,PILOT_TEST_PROFILE:directory},timeoutMs:10000});
  for(const content of ['model = "fixture"\r\n\r\n[mcp_servers.fixture]\r\ncommand = "fixture"\r\n',
    'cli_auth_credentials_store = "keyring"\n[mcp_servers.fixture]\ncommand = "fixture"']) {
    const original=Buffer.from(content);writeFileSync(file,original);
    const result=await run();assert.equal(result.code,1,'Existing configuration must be refused');
    assert.match(result.stdout,/already exists/);assert.deepEqual(readFileSync(file),original,'Existing TOML must remain byte-for-byte unchanged');
  }
  const fresh=path.join(directory,'fresh');mkdirSync(fresh);
  const result=await execute('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],
    {env:{...process.env,PILOT_TEST_PROFILE:fresh},timeoutMs:10000});
  assert.equal(result.code,0,result.stderr);
  assert.equal(readFileSync(path.join(fresh,'config.toml'),'utf8').trim(),'cli_auth_credentials_store = "file"');
});
