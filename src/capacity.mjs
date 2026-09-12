const WEEK_MINUTES=10080;
const MAIN_LIMIT='codex';
const RESERVE_LIMIT='base_model_inference';

const timestamp=value=>Number.isFinite(Date.parse(value))?Date.parse(value):null;
const percent=value=>Number.isSafeInteger(value)&&value>=0?Math.max(0,Math.min(100,value)):null;

function pool(windows,nowMs,ageLimit) {
  if(!windows.length)return {present:false,available:null,windows:[],validUntil:null};
  const normalized=windows.map(window=>({...window,remainingPercent:percent(window.remaining_percent)}));
  const explicitlyBlocked=normalized.some(window=>window.remainingPercent===0||window.reached_type!==null&&window.reached_type!==undefined);
  const unknown=normalized.some(window=>window.remainingPercent===null);
  const resetExpired=normalized.some(window=>Number.isSafeInteger(window.resets_at)&&window.resets_at*1000<=nowMs);
  const resets=normalized.filter(window=>Number.isSafeInteger(window.resets_at)).map(window=>window.resets_at*1000);
  return {present:true,available:resetExpired?null:explicitlyBlocked?false:unknown?null:true,windows:normalized,
    validUntil:new Date(Math.min(ageLimit,...resets)).toISOString()};
}

/** Normalize provider facts without applying economic scheduling policy. */
export function capacityFromObservation(row,now=new Date(),maxAgeSeconds=180,expected={}) {
  const nowMs=now instanceof Date?now.getTime():Number(now);
  const missing={observationId:null,observationSourceId:expected.observationSourceId??null,scopeId:expected.scopeId??null,
    accountKey:null,observedAt:null,validUntil:null,quality:'missing',ordinaryUsageAllowed:null,spendControlReached:null,
    main:{present:false,available:null,windows:[],weeklyRemainingPercent:null},reserve:{present:false,available:null,windows:[]},
    catalogue:{available:false,models:[]}};
  if(!row)return missing;
  const base={...missing,observationId:row.id??null,observationSourceId:row.observation_source_id??'local',
    scopeId:row.capacity_scope_id??'local-codex-account',accountKey:row.account_key??null,observedAt:row.quota_observed_at??null};
  if(expected.observationSourceId&&base.observationSourceId!==expected.observationSourceId)return {...base,quality:'invalid'};
  if(expected.scopeId&&base.scopeId!==expected.scopeId)return {...base,quality:'invalid'};
  if(typeof expected.expectedAccountKey!=='string'||!expected.expectedAccountKey)return {...base,quality:'invalid'};
  if(base.accountKey&&base.accountKey!==expected.expectedAccountKey)return {...base,quality:'account-mismatch'};
  if(!base.accountKey||!row.quota||row.errors?.quota)return {...base,quality:'invalid'};
  const observedMs=timestamp(row.quota_observed_at);
  if(observedMs===null||observedMs>nowMs+5000)return {...base,quality:'invalid'};
  const windows=Array.isArray(row.quota.windows)?row.quota.windows:[];
  const mainWindows=windows.filter(window=>window?.limit_id===MAIN_LIMIT);
  const weekly=mainWindows.filter(window=>window.window_minutes===WEEK_MINUTES);
  if(weekly.length!==1)return {...base,quality:'invalid'};
  const ageLimit=observedMs+maxAgeSeconds*1000;
  const main={...pool(mainWindows,nowMs,ageLimit),weeklyRemainingPercent:percent(weekly[0].remaining_percent)};
  const reserve=pool(windows.filter(window=>window?.limit_id===RESERVE_LIMIT),nowMs,ageLimit);
  const stale=nowMs>=ageLimit;
  const capabilities=row.capabilities;
  const catalogueModels=Array.isArray(capabilities?.models)?capabilities.models.filter(model=>typeof model?.slug==='string').map(model=>({slug:model.slug,
    efforts:Array.isArray(model.efforts)?model.efforts.filter(effort=>typeof effort==='string'):[]})):[];
  const catalogueObservedMs=timestamp(capabilities?.observed_at);
  const catalogueFresh=catalogueObservedMs!==null&&catalogueObservedMs<=nowMs+5000
    &&nowMs<catalogueObservedMs+maxAgeSeconds*1000&&!row.errors?.catalogue;
  const catalogueAccountMatches=capabilities?.account_key===base.accountKey;
  const catalogueAvailable=catalogueAccountMatches&&catalogueFresh&&catalogueModels.length>0;
  return {...base,quality:stale?'stale':'fresh',validUntil:new Date(ageLimit).toISOString(),
    ordinaryUsageAllowed:typeof row.quota.ordinary_usage_allowed==='boolean'?row.quota.ordinary_usage_allowed:null,
    spendControlReached:typeof row.quota.spend_control_reached==='boolean'?row.quota.spend_control_reached:null,
    normalModelSlug:typeof row.quota.normal_model_slug==='string'?row.quota.normal_model_slug:null,
    main,reserve,catalogue:{available:catalogueAvailable,models:catalogueAvailable?catalogueModels:[],observedAt:capabilities?.observed_at??null,
      validUntil:catalogueObservedMs===null?null:new Date(catalogueObservedMs+maxAgeSeconds*1000).toISOString()}};
}

export function readCapacity(store,{observationSourceId,scopeId,expectedAccountKey},now=new Date(),maxAgeSeconds=180) {
  const row=store.latestObservation(observationSourceId);
  return capacityFromObservation(row,now,maxAgeSeconds,{observationSourceId,scopeId,expectedAccountKey});
}

export const codexCapacityConstants=Object.freeze({mainLimitId:MAIN_LIMIT,reserveLimitId:RESERVE_LIMIT,weeklyMinutes:WEEK_MINUTES,
  reserveAlias:'gpt-reserve',normalLunaModel:'gpt-5.6-luna'});
