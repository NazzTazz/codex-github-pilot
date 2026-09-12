import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { createHash } from 'node:crypto';
import { codexEnvironment } from './process.mjs';

const readMethods = new Set(['initialize','account/read','account/rateLimits/read','account/usage/read','model/list']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const number = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const MAIN_LIMIT = 'codex';
const RESERVE_LIMIT = 'base_model_inference';

// This client can only read account data. It never creates a thread or a model turn.
export class ObservationClient {
  constructor(command, {timeoutMs=30000, spawnProcess=spawn,env=codexEnvironment()}={}) {
    this.pending = new Map(); this.nextId = 0; this.buffer = ''; this.decoder = new StringDecoder('utf8');
    this.timeoutMs = timeoutMs; this.failure = null;
    this.child = spawnProcess(command[0], [...command.slice(1), 'app-server', '--listen', 'stdio://'], {
      env:codexEnvironment(env), windowsHide:true, shell:false, detached:process.platform !== 'win32',
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

function quotaBucket(result,limitId) {
  if(object(result.rateLimitsByLimitId))return object(result.rateLimitsByLimitId[limitId])?result.rateLimitsByLimitId[limitId]:null;
  return object(result.rateLimits)&&result.rateLimits.limitId===limitId?result.rateLimits:null;
}

export function tokenUsage(result) {
  if (!object(result) || !object(result.summary)) throw new Error('Invalid account token response');
  return {lifetime_tokens:number(result.summary.lifetimeTokens),peak_daily_tokens:number(result.summary.peakDailyTokens),
    daily_buckets:Array.isArray(result.dailyUsageBuckets)?result.dailyUsageBuckets.map(bucket=>({
      date:typeof bucket?.startDate==='string'?bucket.startDate:null,tokens:number(bucket?.tokens)
    })):null};
}

export function observationEnvironment(source,parent=process.env) {
  const env=codexEnvironment(parent);
  if(source?.codexHome)env.CODEX_HOME=source.codexHome;
  return env;
}

function catalogueModels(result) {
  const values=Array.isArray(result?.data)?result.data:Array.isArray(result?.models)?result.models:null;
  if(!values)throw new Error('Invalid Codex model catalogue');
  return values.map(model=>{
    const slug=model?.slug??model?.model??model?.id;
    const rawEfforts=model?.supportedReasoningEfforts??model?.reasoningEfforts??[];
    const efforts=Array.isArray(rawEfforts)?rawEfforts.map(value=>typeof value==='string'?value:value?.effort).filter(value=>typeof value==='string'):[];
    return typeof slug==='string'&&slug?{slug,efforts:[...new Set(efforts)]}:null;
  }).filter(Boolean);
}

async function readCatalogue(client,implementation) {
  const models=[];let cursor;const seen=new Set();
  do {
    const result=await client.request('model/list',{includeHidden:true,...(cursor?{cursor}:{})});
    models.push(...catalogueModels(result));
    const next=typeof result.nextCursor==='string'&&result.nextCursor?result.nextCursor:null;
    if(next&&seen.has(next))throw new Error('Invalid Codex model catalogue pagination');
    if(next)seen.add(next);cursor=next;
  } while(cursor&&seen.size<100);
  if(cursor)throw new Error('Codex model catalogue has too many pages');
  const unique=new Map(models.map(model=>[model.slug,model]));
  return {observed_at:new Date().toISOString(),account_key:null,models:[...unique.values()],
    implementation:implementation?{name:implementation.name??null,version:implementation.version??null}:null};
}

export async function collectObservation(config, store, source=null, options={}) {
  if(source?.createClient){options=source;source=null;}
  source??={id:'local',label:'Codex',codexHome:null,scopeId:'local-codex-account'};
  const env=observationEnvironment(source);
  const createClient=options.createClient??(()=>new ObservationClient(config.codexCommand,{env}));
  const sample={started_at:new Date().toISOString(),finished_at:null,account_key:null,plan_type:null,
    quota_observed_at:null,usage_observed_at:null,quota:null,usage:null,errors:{},source:'codex-app-server',
    observation_source_id:source.id,capacity_scope_id:source.scopeId};
  let client;
  try {
    client=createClient(source,env);
    const initialized=await client.initialize();
    const auth=await client.request('account/read',{refreshToken:false});
    if (auth?.account?.type !== 'chatgpt') throw new Error('ChatGPT authentication required for observation');
    sample.plan_type=typeof auth.account.planType==='string'?auth.account.planType:null;
    // Keep the auth identity only in memory until quota confirms the account snapshot.
    // A failed quota read must not replace the canonical provider key with an email key.
    const email=auth.account.email;
    const emailKey=typeof email==='string'&&email?createHash('sha256').update('chatgpt:'+email.toLowerCase()).digest('hex'):null;
    const catalogueEnabled=config.scheduling?.enabled&&config.scheduling.observationSourceId===source.id;
    const requests=[
      client.request('account/rateLimits/read',{excludeResetCreditDetails:true}).then(result=>{
        const windows=quotaWindows(result);
        const main=quotaBucket(result,MAIN_LIMIT),reserve=quotaBucket(result,RESERVE_LIMIT);
        sample.quota_observed_at=new Date().toISOString();
        sample.quota={windows,ordinary_usage_allowed:typeof result.ordinaryUsageAllowed==='boolean'?result.ordinaryUsageAllowed:null,
          normal_model_slug:typeof reserve?.normalModelSlug==='string'?reserve.normalModelSlug:null,
          spend_control_reached:typeof main?.spendControlReached==='boolean'?main.spendControlReached:null,
          raw:result};
        sample.account_key=typeof result.accountId==='string'&&result.accountId
          ?createHash('sha256').update('account:'+result.accountId).digest('hex'):emailKey;
      }),
      client.request('account/usage/read').then(result=>{
        sample.usage={...tokenUsage(result),raw:result};sample.usage_observed_at=new Date().toISOString();
      })
    ];
    if(catalogueEnabled)requests.push(readCatalogue(client,initialized?.serverInfo??initialized?.agentInfo??null).then(value=>{sample.capabilities=value;}));
    const results=await Promise.allSettled(requests);
    results.forEach((result,i)=>{if(result.status==='rejected')sample.errors[i===0?'quota':i===1?'usage':'catalogue']=result.reason.message;});
    if(sample.capabilities)sample.capabilities.account_key=sample.account_key;
  } catch(error) { sample.errors.connection=error.message; }
  finally { if(client)try {await client.close();} catch {sample.errors.shutdown='Codex observer shutdown failed';} }
  sample.finished_at=new Date().toISOString();
  sample.status=sample.quota && sample.usage?'ok':sample.quota || sample.usage?'partial':'error';
  sample.id=store.recordObservation(sample);
  return sample;
}

export async function collectObservations(config,store,{createClient}={}) {
  const sources=config.observation?.accounts??[{id:'local',label:'Codex',codexHome:null,scopeId:'local-codex-account'}];
  const results=new Array(sources.length);let next=0;
  const worker=async()=>{while(true){const index=next++;if(index>=sources.length)return;results[index]=await collectObservation(config,store,sources[index],{createClient});}};
  await Promise.all(Array.from({length:Math.min(2,sources.length)},worker));
  return results;
}

// Account-wide deltas are observations, never an attribution to the pilot's jobs.
export function observationDelta(previous,current) {
  if (!previous || (previous.observation_source_id??'local')!==(current.observation_source_id??'local')
    || !previous.account_key || previous.account_key!==current.account_key) return null;
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
