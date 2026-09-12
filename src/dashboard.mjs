import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

const staleAfterMs=180000;
const safeNumber=value=>Number.isSafeInteger(value) && value>=0?value:null;
const safeString=value=>typeof value==='string'?value:null;
const isStale=(timestamp,now)=>!Number.isFinite(Date.parse(timestamp)) || now-Date.parse(timestamp)>staleAfterMs;

// Deliberately whitelist the browser payload: no raw provider response or account identity.
export function quotaPayload(row, now=Date.now()) {
  const base={serverTime:new Date(now).toISOString(),staleAfterMs,collectionStatus:row?.status ?? 'empty',
    collectedAt:row?.finished_at ?? null,quota:null,usage:null,errors:[]};
  if(!row)return base;
  const quota=row.quota_json===null?null:JSON.parse(row.quota_json);
  const usage=row.usage_json===null?null:JSON.parse(row.usage_json);
  const errors=JSON.parse(row.errors_json);
  return {...base,
    errors:Object.keys(errors).filter(key=>['connection','quota','usage','shutdown'].includes(key)),
    quota:quota?{
      observedAt:row.quota_observed_at,stale:isStale(row.quota_observed_at,now),
      ordinaryUsageAllowed:typeof quota.ordinary_usage_allowed==='boolean'?quota.ordinary_usage_allowed:null,
      windows:(Array.isArray(quota.windows)?quota.windows:[]).map(w=>({
        limitId:safeString(w.limit_id),limitName:safeString(w.limit_name),window:safeString(w.window),
        usedPercent:safeNumber(w.used_percent),remainingPercent:safeNumber(w.remaining_percent),
        windowMinutes:safeNumber(w.window_minutes),resetsAt:safeNumber(w.resets_at),reachedType:safeString(w.reached_type)
      }))
    }:null,
    usage:usage?{
      observedAt:row.usage_observed_at,stale:isStale(row.usage_observed_at,now),
      lifetimeTokens:safeNumber(usage.lifetime_tokens),peakDailyTokens:safeNumber(usage.peak_daily_tokens),
      dailyBuckets:Array.isArray(usage.daily_buckets)?usage.daily_buckets.map(day=>({date:safeString(day.date),tokens:safeNumber(day.tokens)})):null
    }:null
  };
}

export function readQuota(stateDirectory, now=Date.now()) {
  const account=readAccountsQuota(stateDirectory,undefined,now).accounts[0];
  const {id,label,planType,identityStatus,sharedQuotaWith,observationId,...payload}=account;
  return payload;
}

const legacyObservation=()=>({mode:'legacy',defaultAccountId:'local',accounts:[{id:'local',label:'Codex',codexHome:null,scopeId:'local-codex-account'}]});
export function readAccountsQuota(stateDirectory,observation=legacyObservation(),now=Date.now()) {
  const file=path.join(stateDirectory,'queue.sqlite');
  const empty=()=>({serverTime:new Date(now).toISOString(),defaultAccountId:observation.defaultAccountId,
    accounts:observation.accounts.map(account=>({id:account.id,label:account.label,planType:null,identityStatus:'unknown',sharedQuotaWith:[],
      observationId:null,...quotaPayload(null,now)}))});
  if(!existsSync(file))return empty();
  const db=new DatabaseSync(file,{readOnly:true});
  try {
    db.exec('PRAGMA busy_timeout=2000');
    if(!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='account_observations'").get())return empty();
    const hasSource=db.prepare('PRAGMA table_info(account_observations)').all().some(column=>column.name==='observation_source_id');
    const latest=observation.accounts.map(account=>{
      const row=hasSource?db.prepare('SELECT * FROM account_observations WHERE observation_source_id=? ORDER BY id DESC LIMIT 1').get(account.id)
        :account.id==='local'?db.prepare('SELECT *,\'local\' AS observation_source_id FROM account_observations ORDER BY id DESC LIMIT 1').get():null;
      const identities=row?.account_key?(hasSource?db.prepare('SELECT account_key FROM account_observations WHERE observation_source_id=? AND account_key IS NOT NULL ORDER BY id DESC LIMIT 2').all(account.id)
        :db.prepare('SELECT account_key FROM account_observations WHERE account_key IS NOT NULL ORDER BY id DESC LIMIT 2').all()):[];
      const freshIdentity=!!row?.account_key&&!isStale(row.finished_at,now);
      return {account,row,identityStatus:!row?.account_key?'unknown':identities[1]&&identities[1].account_key!==row.account_key?'changed':'observed',freshIdentity};
    });
    return {serverTime:new Date(now).toISOString(),defaultAccountId:observation.defaultAccountId,accounts:latest.map(current=>{
      const payload=quotaPayload(current.row,now);
      const sharedQuotaWith=current.freshIdentity?latest.filter(other=>other!==current&&other.freshIdentity&&other.row.account_key===current.row.account_key).map(other=>other.account.id):[];
      return {id:current.account.id,label:current.account.label,planType:current.row?.plan_type??null,identityStatus:current.identityStatus,
        sharedQuotaWith,observationId:current.row?.id??null,...payload};
    })};
  } finally { db.close(); }
}

export function createDashboardServer({stateDirectory,assetDirectory,observation=legacyObservation(),now=Date.now}) {
  const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8',
    '.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.woff2':'font/woff2'};
  const server=createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    const send=(status,body,type='application/json; charset=utf-8')=>{res.writeHead(status,{'Content-Type':type});res.end(body);};
    const port=server.address()?.port;
    const allowedHosts=new Set([`127.0.0.1:${port}`,`localhost:${port}`]);
    if(!allowedHosts.has(req.headers.host) ||
      (req.headers.origin && !allowedHosts.has(req.headers.origin.replace(/^http:\/\//,''))) ||
      (req.headers['sec-fetch-site']==='cross-site' &&
        !(req.url==='/' && req.headers['sec-fetch-mode']==='navigate' && req.headers['sec-fetch-dest']==='document'))) {
      send(403,JSON.stringify({error:'Local requests only'}));return;
    }
    if(!['GET','HEAD'].includes(req.method)) {res.setHeader('Allow','GET, HEAD');send(405,JSON.stringify({error:'Read-only dashboard'}));return;}
    try {
      const url=new URL(req.url,`http://${req.headers.host}`);
      if(url.pathname==='/api/quota') {
        const all=readAccountsQuota(stateDirectory,observation,now());
        const selected=all.accounts.find(account=>account.id===all.defaultAccountId)??all.accounts[0];
        const {id,label,planType,identityStatus,sharedQuotaWith,observationId,...payload}=selected;
        send(200,req.method==='HEAD'?'':JSON.stringify(payload));return;
      }
      if(url.pathname==='/api/accounts/quota') {
        const payload=readAccountsQuota(stateDirectory,observation,now());
        send(200,req.method==='HEAD'?'':JSON.stringify(payload));return;
      }
      if(url.pathname.startsWith('/api/')) {send(404,JSON.stringify({error:'Not found'}));return;}
      const pathname=decodeURIComponent(url.pathname);
      // Only compiled public assets are served. Repository files and SQLite are outside this root.
      if(pathname!=='/' && pathname!=='/favicon.svg' && !pathname.startsWith('/assets/')) {send(404,'Not found','text/plain');return;}
      const root=await realpath(assetDirectory);
      const requested=path.resolve(root,pathname==='/'?'index.html':'.'+pathname);
      if(!requested.startsWith(root+path.sep)) {send(404,'Not found','text/plain');return;}
      const file=await realpath(requested);
      if(!file.startsWith(root+path.sep) || !(await stat(file)).isFile()) {send(404,'Not found','text/plain');return;}
      res.writeHead(200,{'Content-Type':mime[path.extname(file)] ?? 'application/octet-stream'});
      if(req.method==='HEAD') {res.end();return;}
      const stream=createReadStream(file);
      stream.on('error',()=>res.destroy());stream.pipe(res);
    } catch(error) {
      if(error.code==='ENOENT')send(404,'Dashboard not built or asset missing. Run npm run dashboard:build.','text/plain');
      else if(error instanceof URIError)send(400,'Invalid path','text/plain');
      else send(503,JSON.stringify({error:'Local observation unavailable'}));
    }
  });
  server.requestTimeout=10000;server.headersTimeout=10000;
  return server;
}
