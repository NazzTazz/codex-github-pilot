import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { capacityFromObservation } from './capacity.mjs';
import { codexPolicySummary,policyHash,policyVersion,requiresPremiumProfile } from './codex-policy.mjs';
import { executionFor,profiles } from './core.mjs';
import { incidentState } from './quota-incidents.mjs';
import { requirementsFor,schedulingDecision } from './scheduler.mjs';
import { localCodexTarget } from './scheduling-config.mjs';

const REQUIRED={meta:['key','value'],jobs:['id','issue','role','status','profile','task_class','task_metadata_json','last_schedule_decision_id','deferred_since'],
  worker_runs:['id','job_id','model_requested','reasoning_effort','job_started_at','run_status','scheduling_decision_id'],
  account_observations:['id','account_key','quota_observed_at','quota_json','errors_json','capabilities_json','capacity_scope_id','observation_source_id'],
  scheduling_decisions:['id','job_id','created_at','kind','action','reason_code','decision_json'],
  quota_incidents:['capacity_scope_id','quota_pool','account_key','not_before','cleared_at'],
  scheduling_overrides:['id','job_id','expires_at','consumed_at','revoked_at']};
const iso=now=>(now instanceof Date?now:new Date(now)).toISOString();
const integer=value=>Number.isSafeInteger(value)?value:null;
const invalidData=()=>new Error('Invalid saved scheduling data');
function record(value) {
  if(!value||typeof value!=='object'||Array.isArray(value))throw invalidData();
  return value;
}
function parse(value,fallback=null) {
  if(value===null||value===undefined)return fallback;
  try {return record(JSON.parse(value));} catch {throw invalidData();}
}
function scalar(value,type='string') {
  if(value===null||value===undefined)return null;
  if(type==='number'? !Number.isSafeInteger(value):typeof value!==type)throw invalidData();
  return value;
}
function checkedJob(row) {
  if(row)parse(row.task_metadata_json);
  return row;
}
const columns=(db,table)=>new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row=>row.name));
function schemaAvailable(db) {
  const tables=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>row.name));
  return Object.entries(REQUIRED).every(([table,names])=>tables.has(table)&&names.every(name=>columns(db,table).has(name)));
}
function observation(row) {
  if(!row)return null;
  const {quota_json,usage_json,errors_json,capabilities_json,...rest}=row;
  return {...rest,quota:parse(quota_json),usage:parse(usage_json),errors:parse(errors_json,{}),capabilities:parse(capabilities_json)};
}
class ReadStore {
  constructor(db,enabled) {this.db=db;this.enabled=enabled;}
  get(key) {return this.db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value;}
  job(id) {return checkedJob(this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id));}
  candidates() {return this.db.prepare("SELECT * FROM jobs WHERE status IN ('queued','deferred') ORDER BY id").all().map(checkedJob);}
  latestObservation(source) {return observation(this.db.prepare('SELECT * FROM account_observations WHERE observation_source_id=? ORDER BY id DESC LIMIT 1').get(source));}
  incidents(scope,accountKey) {
    if(!this.enabled)return [];
    return this.db.prepare(`SELECT * FROM quota_incidents WHERE cleared_at IS NULL AND
      ((account_key IS NOT NULL AND account_key=?) OR (account_key IS NULL AND capacity_scope_id=?)) ORDER BY id`).all(accountKey,scope);
  }
  overrides(id) {return this.db.prepare('SELECT * FROM scheduling_overrides WHERE job_id=? ORDER BY id DESC').all(id);}
  activeOverride(id,now) {return this.overrides(id).find(row=>!row.consumed_at&&!row.revoked_at&&Date.parse(row.expires_at)>Date.parse(now))??null;}
  decision(id) {if(!id)return null;const row=this.db.prepare('SELECT * FROM scheduling_decisions WHERE id=?').get(id);return row?{...row,decision:parse(row.decision_json)}:null;}
}
function targetFields(target) {return {targetId:target.id,provider:target.provider,observationSourceId:target.observationSourceId??'local',capacityScopeId:target.capacityScopeId};}
function unavailable(config,reason,now) {
  const target=localCodexTarget(config);
  return {version:1,available:false,enabled:config.scheduling.enabled,serverTime:iso(now),unavailableReason:reason,
    projectionKind:'preview',identityVerification:'not-performed',requiresLiveValidation:true,...targetFields(target),
    policyVersion:config.scheduling.enabled?policyVersion:null,policyHash:config.scheduling.enabled?policyHash(config.scheduling,target):null,
    observationId:null,observedAt:null,quality:'missing',weeklyPhase:null,mode:null,recommendedCeiling:null,exceptions:[],blockingReasons:[],
    counts:null,jobs:[],jobsTotal:null,jobsTruncated:false,runs:[],runsTotal:null,runsTruncated:false};
}
function requested(job) {
  try {const value=executionFor(job),profile=job.profile??Object.entries(profiles).find(([,item])=>item.model===value.model&&item.effort===value.effort)?.[0]??null;
    return {profile,model:value.model,effort:value.effort};} catch {return {profile:job.profile??null,model:null,effort:null};}
}
function publicAssignment(value) {
  if(value===null||value===undefined)return null;
  record(value);
  const keys=['targetId','provider','adapter','observationSourceId','capacityScopeId','requestedProfile','effectiveProfile','requestedModel',
    'requestedEffort','model','effort','sandbox','timeoutMs','quotaPool','policyVersion','policyHash','mode','reason','observationId','decisionId','overrideId'];
  const numeric=new Set(['timeoutMs','observationId','decisionId','overrideId']);
  return Object.fromEntries(keys.map(key=>[key,scalar(value[key],numeric.has(key)?'number':'string')]));
}
function publicDecision(row) {
  if(!row)return null;const value=row.decision??parse(row.decision_json,{});
  return {id:row.id,createdAt:row.created_at,kind:row.kind,action:row.action,reasonCode:row.reason_code,
    weeklyPhase:scalar(value.weeklyPhase),mode:scalar(value.mode),assignment:publicAssignment(value.assignment)};
}
function publicOverride(row,now) {
  if(!row)return null;const state=row.consumed_at?'consumed':row.revoked_at?'revoked':Date.parse(row.expires_at)<=Date.parse(now)?'expired':'active';
  return {id:row.id,state,expiresAt:row.expires_at};
}
function publicJob(store,job,decision,now,{preview=true}={}) {
  const deferredAge=job.deferred_since===null?null:Math.max(0,Math.floor((Date.parse(now)-Date.parse(job.deferred_since))/1000));
  return {id:job.id,issue:job.issue,role:job.role,taskClass:job.task_class??'unclassified',status:job.status,requested:requested(job),
    preview:preview&&decision?{action:decision.action,reasonCode:decision.reasonCode,weeklyPhase:decision.weeklyPhase??null,
      mode:decision.mode??null,assignment:publicAssignment(decision.assignment)}:null,lastDecision:publicDecision(store.decision(job.last_schedule_decision_id)),
    override:publicOverride(store.overrides(job.id)[0]??null,now),deferredSince:job.deferred_since??null,deferredAgeSeconds:Number.isFinite(deferredAge)?deferredAge:null};
}
function publicRun(store,row) {
  const proof=parse(row.spawn_capacity_json,{}),admission=store.decision(row.scheduling_decision_id);
  return {id:row.id,jobId:row.job_id,issue:row.issue,role:row.role,status:row.run_status,jobStartedAt:row.job_started_at,
    workerStartedAt:row.worker_started_at??null,finishedAt:row.finished_at??null,preparationMs:integer(row.preparation_ms),workerMs:integer(row.worker_ms),
    totalMs:integer(row.total_ms),exitCode:integer(row.exit_code),timedOut:row.timed_out===null?null:!!row.timed_out,requestedModel:row.model_requested,
    effectiveModel:row.model_effective??row.model_requested,requestedEffort:row.effort_requested??row.reasoning_effort,effectiveEffort:row.reasoning_effort,
    observedModel:row.model_observed??null,targetId:row.target_id??'legacy-local',provider:row.provider??null,adapter:row.adapter??null,
    capacityScopeId:row.capacity_scope_id??null,quotaPool:row.quota_pool??null,admission:publicDecision(admission),
    spawnProof:row.spawn_capacity_json==null?null:{checkedAt:scalar(proof.checkedAt),observationId:scalar(proof.observationId,'number'),observationAgeMs:scalar(proof.observationAgeMs,'number')},
    inputTokens:integer(row.input_tokens),cachedInputTokens:integer(row.cached_input_tokens),cacheWriteInputTokens:integer(row.cache_write_input_tokens),
    outputTokens:integer(row.output_tokens),reasoningOutputTokens:integer(row.reasoning_output_tokens)};
}
function project(db,config,nowValue) {
  const now=iso(nowValue),store=new ReadStore(db,config.scheduling.enabled),target=localCodexTarget(config),source=target.observationSourceId??'local';
  const row=store.latestObservation(source);
  const capacity=capacityFromObservation(row,new Date(now),config.scheduling.maxObservationAgeSeconds,
    {observationSourceId:source,scopeId:target.capacityScopeId,expectedAccountKey:row?.account_key});
  const incidents=incidentState(store.incidents(target.capacityScopeId,capacity.accountKey),capacity,now).blocking;
  const summary=codexPolicySummary(capacity,target,config.scheduling,{legacyPaused:store.get('quotaPaused')==='yes',incidents});
  const candidateRows=store.candidates();
  const projected=candidateRows.map(job=>{const decision=schedulingDecision({store,config,job,expectedAccountKey:row?.account_key,now,mutate:false}).decision;
    return {job,decision,requirements:requirementsFor(job)};});
  const jobs=projected.slice(0,100).map(item=>publicJob(store,item.job,item.decision,now));
  const runRows=db.prepare('SELECT r.*,j.issue,j.role FROM worker_runs r JOIN jobs j ON j.id=r.job_id ORDER BY r.id DESC LIMIT 20').all();
  const runsTotal=db.prepare('SELECT count(*) n FROM worker_runs').get().n;
  const counts={candidateJobs:candidateRows.length,mechanicalReadyJobs:projected.filter(item=>item.requirements.mechanicalContract).length,
    deferredJobs:projected.filter(item=>item.decision.action==='defer').length,
    deferredPremiumJobs:projected.filter(item=>item.decision.action==='defer'&&item.decision.reasonCode==='premium-work-deferred'&&requiresPremiumProfile(item.requirements)).length};
  return {version:1,available:true,enabled:config.scheduling.enabled,serverTime:now,unavailableReason:null,
    projectionKind:'preview',identityVerification:'not-performed',requiresLiveValidation:true,...targetFields(target),
    policyVersion:config.scheduling.enabled?policyVersion:null,policyHash:config.scheduling.enabled?policyHash(config.scheduling,target):null,
    observationId:capacity.observationId,observedAt:capacity.observedAt,quality:capacity.quality,...summary,counts,jobs,jobsTotal:candidateRows.length,
    jobsTruncated:candidateRows.length>jobs.length,runs:runRows.map(row=>publicRun(store,row)),runsTotal,runsTruncated:runsTotal>runRows.length};
}
function read(stateDirectory,config,now,callback) {
  const file=path.join(stateDirectory,'queue.sqlite');if(!existsSync(file))return callback(null,'database-missing');
  const db=new DatabaseSync(file,{readOnly:true});
  try {db.exec('PRAGMA busy_timeout=2000');db.exec('BEGIN');
    try {const value=callback(db,schemaAvailable(db)?null:'schema-unavailable');db.exec('COMMIT');return value;}catch(error){db.exec('ROLLBACK');throw error;}}
  finally {db.close();}
}
export function readSchedulingView(stateDirectory,config,now=new Date()) {return read(stateDirectory,config,now,(db,reason)=>reason?unavailable(config,reason,now):project(db,config,now));}
export function readSchedulingJob(stateDirectory,config,id,now=new Date()) {
  return read(stateDirectory,config,now,(db,reason)=>{
    if(reason)return {version:1,serverTime:iso(now),available:false,enabled:config.scheduling.enabled,projectionKind:'preview',identityVerification:'not-performed',requiresLiveValidation:true,job:null,runs:[]};
    const store=new ReadStore(db,config.scheduling.enabled),job=store.job(id);if(!job)throw Object.assign(new Error('Unknown job'),{code:'UNKNOWN_JOB'});
    let decision=null;if(['queued','deferred'].includes(job.status)){const target=localCodexTarget(config),row=store.latestObservation(target.observationSourceId??'local');
      decision=schedulingDecision({store,config,job,expectedAccountKey:row?.account_key,now:iso(now),mutate:false}).decision;}
    const rows=db.prepare('SELECT r.*,j.issue,j.role FROM worker_runs r JOIN jobs j ON j.id=r.job_id WHERE r.job_id=? ORDER BY r.id DESC LIMIT 20').all(id);
    return {version:1,serverTime:iso(now),available:true,enabled:config.scheduling.enabled,projectionKind:'preview',identityVerification:'not-performed',requiresLiveValidation:true,
      job:publicJob(store,job,decision,iso(now),{preview:!!decision}),runs:rows.map(row=>publicRun(store,row))};
  });
}
export function readStatusView(stateDirectory,config,now=new Date()) {
  return read(stateDirectory,config,now,(db,reason)=>{
    const jobColumns=db?columns(db,'jobs'):new Set();
    const available=['id','issue','role','status'].every(name=>jobColumns.has(name));
    const jobs=available?db.prepare(`SELECT id,issue,role,status,${jobColumns.has('sha')?'sha':'NULL AS sha'} FROM jobs ORDER BY id`).all():[];
    return {version:1,serverTime:iso(now),available,scheduling:reason?unavailable(config,reason,now):project(db,config,now),jobs};});
}
export function readMetricsView(stateDirectory) {
  const file=path.join(stateDirectory,'queue.sqlite');if(!existsSync(file))return [];const db=new DatabaseSync(file,{readOnly:true});
  try {if(!new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>row.name)).has('worker_runs'))return [];
    db.exec('BEGIN');try {const rows=db.prepare(`SELECT r.*,j.issue,j.role,j.status,j.created AS queued_at,j.sha,j.directory,j.error
      FROM worker_runs r JOIN jobs j ON j.id=r.job_id ORDER BY r.id`).all();db.exec('COMMIT');return rows;}catch(error){db.exec('ROLLBACK');throw error;}}
  finally {db.close();}
}
export function readProjectionIdentity(stateDirectory,config,now=new Date()) {
  return read(stateDirectory,config,now,(db,reason)=>{if(reason)return {available:false,accountKey:null,observationId:null,quality:'missing',catalogueObservedAt:null};
    const target=localCodexTarget(config),store=new ReadStore(db,config.scheduling.enabled),row=store.latestObservation(target.observationSourceId??'local');
    const capacity=capacityFromObservation(row,new Date(now),config.scheduling.maxObservationAgeSeconds,
      {observationSourceId:target.observationSourceId??'local',scopeId:target.capacityScopeId,expectedAccountKey:row?.account_key});
    return {available:true,accountKey:row?.account_key??null,observationId:capacity.observationId,quality:capacity.quality,catalogueObservedAt:capacity.catalogue.observedAt??null};});
}
