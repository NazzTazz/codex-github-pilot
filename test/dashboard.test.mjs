import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { request } from 'node:http';
import { Store } from '../src/store.mjs';
import { createDashboardServer, readQuota } from '../src/dashboard.mjs';
import { schedulingConfig } from '../src/scheduling-config.mjs';

function fixture(t) {
  const directory=mkdtempSync(path.join(os.tmpdir(),'pilot-dashboard-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const assets=path.join(directory,'public');mkdirSync(assets);mkdirSync(path.join(assets,'assets'));
  writeFileSync(path.join(assets,'index.html'),'<!doctype html><title>Pilot local</title>');
  writeFileSync(path.join(assets,'assets','app.js'),'console.log("local")');
  writeFileSync(path.join(directory,'private.txt'),'must not be served');
  return {directory,assets};
}
function save(directory,overrides={}) {
  const store=new Store(path.join(directory,'queue.sqlite'));
  try {store.recordObservation({started_at:'2026-09-11T10:00:00Z',finished_at:'2026-09-11T10:00:02Z',
    quota_observed_at:'2026-09-11T10:00:01Z',usage_observed_at:'2026-09-11T10:00:02Z',account_key:'private-fingerprint',
    plan_type:'pro',source:'codex-app-server',status:'ok',errors:{},
    quota:{ordinary_usage_allowed:true,windows:[{limit_id:'codex',limit_name:null,window:'primary',used_percent:88,
      remaining_percent:12,window_minutes:10080,resets_at:1789465818,reached_type:null}],raw:{accountId:'secret-account-id'}},
    usage:{lifetime_tokens:539552906,peak_daily_tokens:204787999,daily_buckets:[{date:'2026-09-10',tokens:10504383}],raw:{secret:'not-for-browser'}},
    ...overrides});} finally {store.close();}
}
test('quota API projection preserves exact values and strips account identity and raw responses',t=>{
  const {directory}=fixture(t);save(directory);
  const payload=readQuota(directory,Date.parse('2026-09-11T10:01:00Z'));
  assert.equal(payload.quota.windows[0].remainingPercent,12);
  assert.equal(payload.quota.windows[0].windowMinutes,10080);
  assert.equal(payload.usage.lifetimeTokens,539552906);assert.equal(payload.quota.stale,false);
  assert.equal(payload.observationId,1);
  const serialized=JSON.stringify(payload);
  for(const secret of ['secret-account-id','private-fingerprint','not-for-browser','"raw"'])assert.equal(serialized.includes(secret),false);
});
test('missing, stale, unknown, zero and failed observations remain distinct',t=>{
  const {directory}=fixture(t);
  assert.equal(readQuota(directory).collectionStatus,'empty');
  save(directory,{usage:{lifetime_tokens:0,peak_daily_tokens:null,daily_buckets:null,raw:{}}});
  let result=readQuota(directory,Date.parse('2026-09-11T10:04:00Z'));
  assert.equal(result.quota.stale,true);assert.equal(result.usage.lifetimeTokens,0);assert.equal(result.usage.dailyBuckets,null);
  save(directory,{status:'error',quota:null,usage:null,quota_observed_at:null,usage_observed_at:null,errors:{connection:'sensitive error details'}});
  result=readQuota(directory);assert.equal(result.collectionStatus,'error');assert.equal(result.quota,null);
  assert.deepEqual(result.errors,['connection']);assert.equal(JSON.stringify(result).includes('sensitive error details'),false);
});
test('HTTP dashboard serves built assets and refreshed SQLite data, rejecting external origins and file traversal',async t=>{
  const {directory,assets}=fixture(t);save(directory);
  const server=createDashboardServer({stateDirectory:directory,assetDirectory:assets,now:()=>Date.parse('2026-09-11T10:01:00Z')});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const url=`http://127.0.0.1:${server.address().port}`;
  let response=await fetch(url);assert.equal(response.status,200);assert.match(await response.text(),/Pilot local/);
  assert.match(response.headers.get('content-security-policy'),/connect-src 'self'/);
  response=await fetch(url+'/api/quota');assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
  const legacy=await response.json();assert.equal(legacy.quota.windows[0].remainingPercent,12);assert.equal(legacy.observationId,1);
  save(directory,{usage:{lifetime_tokens:539552999,peak_daily_tokens:null,daily_buckets:[]}});
  assert.equal((await (await fetch(url+'/api/quota')).json()).usage.lifetimeTokens,539552999);
  assert.equal((await fetch(url+'/api/quota',{headers:{Origin:'https://untrusted.example'}})).status,403);
  const invalidHostStatus=await new Promise((resolve,reject)=>{
    const req=request(url+'/api/quota',{headers:{Host:'untrusted.example'}},response=>{response.resume();resolve(response.statusCode);});
    req.on('error',reject);req.end();
  });
  assert.equal(invalidHostStatus,403);
  const navigationStatus=await new Promise((resolve,reject)=>{
    const req=request(url,{headers:{'Sec-Fetch-Site':'cross-site','Sec-Fetch-Mode':'navigate','Sec-Fetch-Dest':'document'}},response=>{response.resume();resolve(response.statusCode);});
    req.on('error',reject);req.end();
  });
  assert.equal(navigationStatus,200);
  assert.equal((await fetch(url+'/api/quota',{method:'POST'})).status,405);
  for(const pathname of ['/state/queue.sqlite','/config.local.json','/.git/config','/assets/../../private.txt','/assets/..%5c..%5cprivate.txt']) {
    const denied=await fetch(url+pathname);assert.equal(denied.status,404);assert.equal((await denied.text()).includes('must not be served'),false);
  }
  assert.equal((await fetch(url+'/assets/app.js')).status,200);
  assert.equal((await fetch(url+'/api/unknown')).status,404);
});
test('HTTP scheduling is read-only, versioned, HEAD-compatible and filters identity',async t=>{
  const {directory,assets}=fixture(t);save(directory,{capabilities:{account_key:'private-fingerprint',observed_at:'2026-09-11T10:00:01Z',models:[{slug:'gpt-5.6-sol',efforts:['medium']}]}});
  const observation={mode:'legacy',defaultAccountId:'local',accounts:[{id:'local',label:'Codex',codexHome:null,scopeId:'local-codex-account'}]};
  const scheduling=schedulingConfig({enabled:true},observation),config={timeoutMinutes:30,observation,scheduling};
  const server=createDashboardServer({stateDirectory:directory,assetDirectory:assets,observation,scheduling,config,now:()=>Date.parse('2026-09-11T10:01:00Z')});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const url=`http://127.0.0.1:${server.address().port}/api/scheduling`;let response=await fetch(url);assert.equal(response.status,200);
  const payload=await response.json();assert.equal(payload.version,1);assert.equal(payload.projectionKind,'preview');assert.equal(JSON.stringify(payload).includes('private-fingerprint'),false);
  response=await fetch(url,{method:'HEAD'});assert.equal(response.status,200);assert.equal(await response.text(),'');assert.equal((await fetch(url,{method:'POST'})).status,405);
});
