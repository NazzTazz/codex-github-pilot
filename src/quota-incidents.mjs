import { capacityFromObservation } from './capacity.mjs';
import { localCodexTarget } from './scheduling-config.mjs';

/** Pure recovery proof. A reset or a null permission is never proof of recovery. */
export function incidentRecovered(incident,capacity,now) {
  const after=Date.parse(incident.not_before),observed=Date.parse(capacity.observedAt);
  if(capacity.quality!=='fresh'||!capacity.accountKey||incident.account_key&&incident.account_key!==capacity.accountKey
    ||Date.parse(now)<after||!(observed>after)||capacity.spendControlReached===true)return false;
  if(incident.kind==='spend-control'&&capacity.spendControlReached!==false)return false;
  if(incident.quota_pool==='main')return capacity.ordinaryUsageAllowed===true&&capacity.main.available===true;
  const alias=capacity.catalogue.available&&capacity.catalogue.models.some(model=>model.slug==='gpt-reserve'&&model.efforts.includes('medium'));
  return capacity.ordinaryUsageAllowed===false&&capacity.reserve.available===true&&capacity.normalModelSlug==='gpt-5.6-luna'
    &&alias&&(incident.kind!=='alias-unavailable'||Date.parse(capacity.catalogue.observedAt)>after);
}

export function incidentState(incidents,capacity,now) {
  const recovered=incidents.filter(incident=>incidentRecovered(incident,capacity,now));
  return {recovered,blocking:incidents.filter(incident=>!recovered.includes(incident))};
}

export function reconcileIncidents(store,capacity,config,now) {
  const target=localCodexTarget(config),source=target.observationSourceId??'local';
  const row=store.latestObservation(source);
  // Negative evidence belongs to the observed account even when the execution identity probe fails.
  // This self-bound snapshot may only open incidents; admission and recovery still use `capacity`.
  const observed=capacityFromObservation(row,new Date(now),config.scheduling.maxObservationAgeSeconds,
    {observationSourceId:source,scopeId:target.capacityScopeId,expectedAccountKey:row?.account_key});
  if(observed.quality==='fresh'&&observed.spendControlReached===true&&observed.accountKey) {
    for(const pool of ['main','reserve'])store.openIncident({scope:observed.scopeId,accountKey:observed.accountKey,pool,
      kind:'spend-control',now,observedAt:observed.observedAt,
      notBefore:new Date(Date.parse(now)+config.scheduling.quotaErrorCooldownSeconds*1000).toISOString()});
  }
  const state=incidentState(store.incidents(capacity.scopeId,capacity.accountKey),capacity,now);
  for(const incident of state.recovered)store.clearIncident(incident.id,now);
  return state.blocking;
}

export function recordQuotaIncident(store,assignment,error,config,jobId,runId,now=new Date().toISOString()) {
  if(!config.scheduling?.enabled||assignment.routing!=='quota-aware'||error?.kind!=='quota')return;
  store.transaction(()=>store.openIncident({scope:assignment.capacityScopeId,accountKey:assignment.accountKey,pool:assignment.quotaPool,
    kind:['quota','spend-control','alias-unavailable'].includes(error.incidentKind)?error.incidentKind:'quota-suspected',now,observedAt:assignment.observedAt,jobId,runId,
    notBefore:new Date(Date.parse(now)+config.scheduling.quotaErrorCooldownSeconds*1000).toISOString()}));
}
