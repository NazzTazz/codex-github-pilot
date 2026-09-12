import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { createHash } from 'node:crypto';
import { codexEnvironment } from './process.mjs';

const readMethods = new Set(['initialize','account/read','account/rateLimits/read','account/usage/read']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const number = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

// This client can only read account data. It never creates a thread or a model turn.
export class ObservationClient {
  constructor(command, {timeoutMs=30000, spawnProcess=spawn}={}) {
    this.pending = new Map(); this.nextId = 0; this.buffer = ''; this.decoder = new StringDecoder('utf8');
    this.timeoutMs = timeoutMs; this.failure = null;
    this.child = spawnProcess(command[0], [...command.slice(1), 'app-server', '--listen', 'stdio://'], {
      env:codexEnvironment(), windowsHide:true, shell:false, detached:process.platform !== 'win32',
      stdio:['pipe','pipe','pipe']
    });
    this.closed = new Promise(resolve=>this.child.once('close',()=>{this.fail(new Error('Codex observation connection closed'));resolve();}));
    this.child.on('error',()=>this.fail(new Error('Cannot start Codex observation process')));
    this.child.stdin.on('error',()=>this.fail(new Error('Codex observation connection unavailable')));
    // Drain stderr without persisting configuration, account details, or credentials.
    this.child.stderr.resume();
    this.child.stdout.on('data',chunk=>{
      if(this.failure)return;
      this.buffer += this.decoder.write(chunk);
      if (this.buffer.length > 8000000) { this.fail(new Error('Codex observation response too large')); return; }
      let index;
      while ((index=this.buffer.indexOf('\n')) >= 0) {
        const line=this.buffer.slice(0,index);this.buffer=this.buffer.slice(index+1);
        if (!line.trim()) continue;
        let message;
        try { message=JSON.parse(line); } catch { this.fail(new Error('Invalid Codex observation JSON')); return; }
        if (!object(message)) { this.fail(new Error('Invalid Codex observation message')); return; }
        if (message.method) {
          if (message.id !== undefined) this.send({id:message.id,error:{code:-32601,message:'Read-only observer does not handle server requests'}});
          continue;
        }
        const request=this.pending.get(message.id);
        if (!request) continue;
        this.pending.delete(message.id);clearTimeout(request.timer);
        if (message.error) request.reject(new Error(`Codex ${request.method} failed (code ${Number.isSafeInteger(message.error.code)?message.error.code:'unknown'})`));
        else if (!Object.hasOwn(message,'result')) request.reject(new Error(`Codex ${request.method} returned no result`));
        else request.resolve(message.result);
      }
    });
  }
  fail(error) {
    this.failure ??= error;
    for (const request of this.pending.values()) { clearTimeout(request.timer);request.reject(error); }
    this.pending.clear();
  }
  send(message) { if (!this.child.stdin.destroyed) this.child.stdin.write(JSON.stringify(message)+'\n'); }
  request(method,params) {
    if (!readMethods.has(method)) return Promise.reject(new Error('Observer only allows account reads'));
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve,reject)=>{
      const id=++this.nextId;
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`Codex ${method} timed out`));},this.timeoutMs);
      this.pending.set(id,{resolve,reject,timer,method});
      this.send({id,method,...(params === undefined?{}:{params})});
    });
  }
  async initialize() {
    const info=await this.request('initialize',{clientInfo:{name:'github_pilot_observer',version:'0.1.0'}});
    this.send({method:'initialized',params:{}});
    return info;
  }
  async close() {
    this.fail(new Error('Codex observer stopped'));
    this.child.stdin.end();
    let timer;
    await Promise.race([this.closed,new Promise(resolve=>{timer=setTimeout(resolve,1500);})]);
    clearTimeout(timer);
    if (this.child.exitCode !== null || this.child.signalCode !== null || !this.child.pid) return;
    if (process.platform === 'win32') {
      await new Promise(resolve=>{
        const killer=spawn('taskkill.exe',['/PID',String(this.child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
        const fallback=setTimeout(()=>{this.child.kill();killer.kill();resolve();},2000);
        const done=()=>{clearTimeout(fallback);resolve();};
        killer.once('error',()=>{this.child.kill();done();});killer.once('close',done);
      });
    } else { try { process.kill(-this.child.pid,'SIGKILL'); } catch { this.child.kill('SIGKILL'); } }
  }
}

export function quotaWindows(result) {
  if (!object(result) || !object(result.rateLimits)) throw new Error('Invalid quota response');
  const multi=object(result.rateLimitsByLimitId) ? Object.entries(result.rateLimitsByLimitId) : [];
  // The legacy view duplicates one multi-bucket entry; never count both.
  const buckets=multi.length ? multi : object(result.rateLimits) ? [[result.rateLimits.limitId ?? 'legacy',result.rateLimits]] : [];
  return buckets.flatMap(([id,bucket])=>{
    if (!object(bucket)) return [];
    return ['primary','secondary'].filter(window=>object(bucket[window])).map(window=>({
      limit_id:id,limit_name:typeof bucket.limitName==='string'?bucket.limitName:null,window,
      used_percent:number(bucket[window].usedPercent),
      remaining_percent:number(bucket[window].usedPercent)===null?null:Math.max(0,100-bucket[window].usedPercent),
      window_minutes:number(bucket[window].windowDurationMins),resets_at:number(bucket[window].resetsAt),
      reached_type:typeof bucket.rateLimitReachedType==='string'?bucket.rateLimitReachedType:null
    }));
  });
}

export function tokenUsage(result) {
  if (!object(result) || !object(result.summary)) throw new Error('Invalid account token response');
  return {lifetime_tokens:number(result.summary.lifetimeTokens),peak_daily_tokens:number(result.summary.peakDailyTokens),
    daily_buckets:Array.isArray(result.dailyUsageBuckets)?result.dailyUsageBuckets.map(bucket=>({
      date:typeof bucket?.startDate==='string'?bucket.startDate:null,tokens:number(bucket?.tokens)
    })):null};
}

export async function collectObservation(config, store, {createClient=()=>new ObservationClient(config.codexCommand)}={}) {
  const sample={started_at:new Date().toISOString(),finished_at:null,account_key:null,plan_type:null,
    quota_observed_at:null,usage_observed_at:null,quota:null,usage:null,errors:{},source:'codex-app-server'};
  let client;
  try {
    client=createClient();
    await client.initialize();
    const auth=await client.request('account/read',{refreshToken:false});
    if (auth?.account?.type !== 'chatgpt') throw new Error('ChatGPT authentication required for observation');
    sample.plan_type=typeof auth.account.planType==='string'?auth.account.planType:null;
    // Only a pseudonymous key is stored, never the account/read response or email.
    const email=auth.account.email;
    if (typeof email==='string' && email) sample.account_key=createHash('sha256').update('chatgpt:'+email.toLowerCase()).digest('hex');
    const results=await Promise.allSettled([
      client.request('account/rateLimits/read',{excludeResetCreditDetails:true}).then(result=>{
        const windows=quotaWindows(result);
        sample.quota_observed_at=new Date().toISOString();
        sample.quota={windows,ordinary_usage_allowed:typeof result.ordinaryUsageAllowed==='boolean'?result.ordinaryUsageAllowed:null,
          raw:result};
        if(typeof result.accountId==='string' && result.accountId) sample.account_key=createHash('sha256').update('account:'+result.accountId).digest('hex');
      }),
      client.request('account/usage/read').then(result=>{
        sample.usage={...tokenUsage(result),raw:result};sample.usage_observed_at=new Date().toISOString();
      })
    ]);
    results.forEach((result,i)=>{if(result.status==='rejected')sample.errors[i===0?'quota':'usage']=result.reason.message;});
  } catch(error) { sample.errors.connection=error.message; }
  finally { if(client)try {await client.close();} catch {sample.errors.shutdown='Codex observer shutdown failed';} }
  sample.finished_at=new Date().toISOString();
  sample.status=sample.quota && sample.usage?'ok':sample.quota || sample.usage?'partial':'error';
  sample.id=store.recordObservation(sample);
  return sample;
}

// Account-wide deltas are observations, never an attribution to the pilot's jobs.
export function observationDelta(previous,current) {
  if (!previous || !previous.account_key || previous.account_key!==current.account_key) return null;
  const before=previous.usage?.lifetime_tokens,after=current.usage?.lifetime_tokens;
  const tokens=number(before)!==null && number(after)!==null && after>=before?after-before:null;
  const windows=(current.quota?.windows ?? []).map(window=>{
    const old=previous.quota?.windows.find(w=>w.limit_id===window.limit_id && w.window===window.window);
    const comparable=old && window.resets_at!==null && old.resets_at===window.resets_at &&
      window.window_minutes!==null && old.window_minutes===window.window_minutes;
    return {...window,window_changed:old?old.resets_at!==window.resets_at || old.window_minutes!==window.window_minutes:null,
      used_percent_delta:comparable && number(old.used_percent)!==null && number(window.used_percent)!==null?window.used_percent-old.used_percent:null};
  });
  return {account_tokens_delta:tokens,windows};
}
