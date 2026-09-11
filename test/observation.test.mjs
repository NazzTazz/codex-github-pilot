import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../src/store.mjs';
import { ObservationClient, collectObservation, quotaWindows, tokenUsage, observationDelta } from '../src/observation.mjs';
import { spawn } from 'node:child_process';
import { execute } from '../src/runner.mjs';
import { fileURLToPath } from 'node:url';

function fixture(t) {
  const directory=mkdtempSync(path.join(os.tmpdir(),'pilot-observation-'));
  const store=new Store(path.join(directory,'queue.sqlite'));
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  return {store,directory};
}
const quota={accountId:'account-fixture',rateLimits:{limitId:'codex',primary:{usedPercent:88,windowDurationMins:10080,resetsAt:1790000000}},
  rateLimitsByLimitId:{codex:{primary:{usedPercent:88,windowDurationMins:10080,resetsAt:1790000000}},other:{secondary:{usedPercent:0,resetsAt:null}}},
  ordinaryUsageAllowed:true};
const usage={summary:{lifetimeTokens:1200,peakDailyTokens:800},dailyUsageBuckets:[{startDate:'2026-09-10',tokens:800}]};
function fakeClient(overrides={}) {
  return {initialize:async()=>({}),close:async()=>{},request:async method=>{
    if(Object.hasOwn(overrides,method))return overrides[method]();
    if(method==='account/read')return {account:{type:'chatgpt',email:'private@example.test',planType:'pro'}};
    if(method==='account/rateLimits/read')return quota;
    if(method==='account/usage/read')return usage;
    assert.fail('Unexpected method: '+method);
  }};
}
test('quota preserves all buckets, zero and unknown windows, without duplicating the legacy view',()=>{
  const rows=quotaWindows(quota);
  assert.equal(rows.length,2);assert.equal(rows[0].remaining_percent,12);
  assert.equal(rows[1].remaining_percent,100);assert.equal(rows[1].window_minutes,null);assert.equal(rows[1].resets_at,null);
  assert.equal(quotaWindows({rateLimits:{primary:{usedPercent:-1}}})[0].remaining_percent,null);
  assert.throws(()=>quotaWindows({}),/Invalid quota/);
});
test('account token values retain missing days and unknown values instead of inventing zero',()=>{
  assert.deepEqual(tokenUsage({summary:{}}),{lifetime_tokens:null,peak_daily_tokens:null,daily_buckets:null});
  assert.deepEqual(tokenUsage({...usage,dailyUsageBuckets:[]}).daily_buckets,[]);
  assert.equal(tokenUsage(usage).daily_buckets.length,1);
  assert.equal(tokenUsage({summary:{lifetimeTokens:Number.MAX_SAFE_INTEGER+1}}).lifetime_tokens,null);
});
test('successful snapshots are append-only and do not resume quota or modify jobs',async t=>{
  const {store}=fixture(t);store.set('quotaPaused','yes');
  const first=await collectObservation({},store,{createClient:()=>fakeClient()});
  const second=await collectObservation({},store,{createClient:()=>fakeClient()});
  assert.equal(first.status,'ok');assert.equal(second.id,first.id+1);
  assert.equal(first.account_key.length,64);assert.equal(first.quota.raw.ordinaryUsageAllowed,true);
  assert.equal(JSON.stringify(store.observations()).includes('private@example.test'),false);
  assert.equal(store.get('quotaPaused'),'yes');assert.deepEqual(store.jobs(),[]);
  assert.equal(observationDelta(first,second).account_tokens_delta,0);
  assert.equal(store.observations(1)[0].id,second.id);
  assert.throws(()=>store.observations(-1),/limit/);
});
test('an unavailable usage endpoint preserves successful quota; failures remain separate observations',async t=>{
  const {store}=fixture(t);
  const sample=await collectObservation({},store,{createClient:()=>fakeClient({'account/usage/read':()=>{throw new Error('Method unavailable');}})});
  assert.equal(sample.status,'partial');assert.ok(sample.quota);assert.equal(sample.usage,null);
  assert.equal(sample.usage_observed_at,null);assert.equal(sample.errors.usage,'Method unavailable');
  const failed=await collectObservation({},store,{createClient:()=>({...fakeClient(),initialize:async()=>{throw new Error('Offline');}})});
  assert.equal(failed.status,'error');assert.equal(failed.quota,null);assert.equal(store.observations().length,2);
});
test('no account usage reads are issued for API authentication',async t=>{
  const {store}=fixture(t);const methods=[];let closed=false;
  const sample=await collectObservation({},store,{createClient:()=>({initialize:async()=>{},close:async()=>{closed=true;},
    request:async method=>{methods.push(method);return {account:{type:'apiKey'}};}})});
  assert.equal(sample.status,'error');assert.deepEqual(methods,['account/read']);assert.ok(closed);
});
test('quota window changes and account switches cannot become spurious consumption',()=>{
  const previous={account_key:'a',usage:{lifetime_tokens:100},quota:{windows:quotaWindows(quota)}};
  const current=structuredClone(previous);current.usage.lifetime_tokens=125;current.quota.windows[0].used_percent=90;
  assert.equal(observationDelta(previous,current).account_tokens_delta,25);
  assert.equal(observationDelta(previous,current).windows[0].used_percent_delta,2);
  current.quota.windows[0].resets_at++;
  assert.equal(observationDelta(previous,current).windows[0].used_percent_delta,null);
  assert.equal(observationDelta(previous,current).windows[0].window_changed,true);
  current.usage.lifetime_tokens=80;
  assert.equal(observationDelta(previous,current).account_tokens_delta,null);
  current.account_key='b';assert.equal(observationDelta(previous,current),null);
});

function server(t,body) {
  const {directory}=fixture(t);
  const script=path.join(directory,'fake-codex.mjs');
  writeFileSync(script,`import readline from 'node:readline';
    const send = value=>process.stdout.write(JSON.stringify(value)+'\\n');
    let initialized=false;
    readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);${body}});
    process.stdin.on('end',()=>process.exit(0));`);
  const client=new ObservationClient([process.execPath,script],{timeoutMs:5000});
  t.after(()=>client.close());return client;
}
test('headless transport honors initialization, fragmented UTF-8 and out-of-order replies, and rejects model turns',async t=>{
  const client=server(t,`
    if(m.method==='initialize'){send({id:m.id,result:{userAgent:'fixture'}});return;}
    if(m.method==='initialized'){initialized=true;return;}
    if(!initialized){send({id:m.id,error:{code:-32000}});return;}
    if(m.method==='account/read'){
      const bytes=Buffer.from(JSON.stringify({id:m.id,result:{label:'Français'}})+'\\n');
      const split=bytes.indexOf(Buffer.from('ç'))+1;
      process.stdout.write(bytes.subarray(0,split));setTimeout(()=>process.stdout.write(bytes.subarray(split)),10);return;
    }
    if(m.method==='account/usage/read')setTimeout(()=>send({id:m.id,result:{kind:'usage'}}),30);
    else send({id:m.id,result:{kind:'quota'}});
  `);
  await client.initialize();
  assert.equal((await client.request('account/read')).label,'Français');
  const [a,b]=await Promise.all([client.request('account/usage/read'),client.request('account/rateLimits/read')]);
  assert.equal(a.kind,'usage');assert.equal(b.kind,'quota');
  await assert.rejects(client.request('turn/start',{}),/only allows/);
});
test('headless timeout is bounded and child exits on cleanup',async t=>{
  const client=server(t,`if(m.method==='initialize')send({id:m.id,result:{}});`);
  await client.initialize();client.timeoutMs=50;
  await assert.rejects(client.request('account/read'),/timed out/);
  await client.close();await client.closed;assert.equal(client.pending.size,0);
});
test('malformed JSON and process exit reject pending reads instead of hanging',async t=>{
  const malformed=server(t,`process.stdout.write('not-json\\n');`);
  await assert.rejects(malformed.initialize(),/Invalid Codex observation JSON/);
  const crashed=server(t,`process.exit(1);`);
  await assert.rejects(crashed.initialize(),/closed/);
});
test('RPC errors do not expose server messages in saved diagnostics',async t=>{
  const client=server(t,`send({id:m.id,error:{code:-32601,message:'secret=do-not-log'}});`);
  await assert.rejects(client.initialize(),error=>error.message.includes('-32601') && !error.message.includes('secret'));
});

test('CLI observer has its own lock and stop signal, and leaves the job queue untouched',{timeout:15000},async t=>{
  const {directory,store}=fixture(t);
  const script=path.join(directory,'account-server.mjs');
  writeFileSync(script,`import readline from 'node:readline';
    const replies=${JSON.stringify({'initialize':{},'account/read':{account:{type:'chatgpt',email:'fixture@example.test',planType:'pro'}},
      'account/rateLimits/read':quota,'account/usage/read':usage})};
    readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
      if(m.id)process.stdout.write(JSON.stringify({id:m.id,result:replies[m.method]})+'\\n');});
    process.stdin.on('end',()=>process.exit());`);
  const configFile=path.join(directory,'config.json');
  writeFileSync(configFile,JSON.stringify({repository:'owner/repo',allowedAuthors:['owner'],activeLabel:'agent:active',
    codexCommand:[process.execPath,script],stateDirectory:directory,checkout:directory,pollSeconds:60,timeoutMinutes:1,publish:false}));
  const cli=fileURLToPath(new URL('../src/cli.mjs',import.meta.url));
  const watcher=spawn(process.execPath,[cli,'observe','--watch','--config',configFile],{windowsHide:true,stdio:'ignore'});
  t.after(()=>watcher.kill());
  const closed=new Promise(resolve=>watcher.once('close',resolve));
  for(let i=0;i<70 && !store.observations(1).length;i++)await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(store.observations(1)[0]?.status,'ok');
  const duplicate=await execute(process.execPath,[cli,'observe','--once','--config',configFile]);
  assert.notEqual(duplicate.code,0);assert.match(duplicate.stderr,/lock unavailable/);
  const stop=await execute(process.execPath,[cli,'stop-observe','--config',configFile]);
  assert.equal(stop.code,0);assert.equal(await closed,0);
  assert.deepEqual(store.jobs(),[]);assert.equal(store.get('firstStarted'),undefined);assert.equal(store.get('quotaPaused'),undefined);
});
