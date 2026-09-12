import { createHash } from 'node:crypto';
import { profiles,internalProfiles } from './core.mjs';
import { codexCapacityConstants } from './capacity.mjs';

export const policyVersion='codex-local-v1';
const rank={"luna-medium":0,"terra-medium":1,"sol-medium":2,"sol-high":2,"astra-low":3};

export function policyHash(config,target) {
  const value={version:policyVersion,conserveAtPercent:config.conserveAtPercent,survivalBelowPercent:config.survivalBelowPercent,
    maxObservationAgeSeconds:config.maxObservationAgeSeconds,quotaErrorCooldownSeconds:config.quotaErrorCooldownSeconds,
    survivalPlanTimeoutMinutes:config.survivalPlanTimeoutMinutes,reserveEnabled:config.reserveEnabled,
    observationSourceId:target.observationSourceId,scopeId:target.capacityScopeId,offeredProfiles:[...target.offeredProfiles].sort()};
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function phaseFor(remaining,config) {
  if(!Number.isSafeInteger(remaining))return null;
  if(remaining>config.conserveAtPercent)return 'premium';
  if(remaining>=config.survivalBelowPercent)return 'conserve';
  if(remaining>0)return 'survival';
  return 'exhausted';
}

function hasModel(capacity,profile) {
  const concrete=profiles[profile]??internalProfiles[profile];
  return !!concrete&&capacity.catalogue.models.some(model=>model.slug===concrete.model&&model.efforts.includes(concrete.effort));
}

function requestedProfileOf(requested) {
  if(typeof requested==='string')return requested;
  if(requested?.profile&&profiles[requested.profile])return requested.profile;
  return Object.entries(profiles).find(([,profile])=>profile.model===requested?.model&&profile.effort===requested?.effort)?.[0]??null;
}

export function minimumCompatible(requirements,requestedProfile) {
  if(requirements.requestedRole==='astra-review')return requestedProfile==='astra-low';
  const minimum=requirements.functionalRole==='specification'||['complex','exploratory'].includes(requirements.taskClass)?2
    :requirements.functionalRole==='review'||requirements.taskClass==='routine'||requirements.taskClass==='mechanical'&&!requirements.mechanicalContract?1:0;
  return rank[requestedProfile]!==undefined&&rank[requestedProfile]>=minimum;
}

export function requiresPremiumProfile(requirements) {
  return requirements.requestedRole==='astra-review'||requirements.functionalRole==='specification'
    ||requirements.taskClass==='complex'||requirements.taskClass==='exploratory';
}

export function codexPolicySummary(capacity,target,config,{legacyPaused=false,incidents=[]}={}) {
  if(!config.enabled)return {weeklyPhase:null,mode:null,recommendedCeiling:null,exceptions:[],blockingReasons:legacyPaused?['legacy-quota-pause']:[]};
  const weeklyPhase=phaseFor(capacity.main.weeklyRemainingPercent,config);
  const mainIncident=incidents.some(row=>row.quota_pool==='main'),reserveIncident=incidents.some(row=>row.quota_pool==='reserve');
  const mainAvailable=capacity.quality==='fresh'&&capacity.ordinaryUsageAllowed===true&&capacity.spendControlReached!==true
    &&capacity.main.available===true&&!mainIncident;
  const reserveAvailable=config.reserveEnabled&&capacity.quality==='fresh'&&capacity.ordinaryUsageAllowed===false
    &&capacity.spendControlReached!==true&&capacity.reserve.available===true&&!reserveIncident
    &&capacity.normalModelSlug===codexCapacityConstants.normalLunaModel&&target.offeredProfiles.includes('luna-medium')
    &&hasModel(capacity,'luna-reserve-medium');
  const blockingReasons=[];
  if(legacyPaused)blockingReasons.push('legacy-quota-pause');
  if(capacity.quality==='missing')blockingReasons.push('quota-missing');
  else if(capacity.quality==='stale')blockingReasons.push('quota-stale');
  else if(capacity.quality==='account-mismatch')blockingReasons.push('account-mismatch');
  else if(capacity.quality!=='fresh')blockingReasons.push('quota-invalid');
  if(capacity.quality==='fresh'&&!capacity.catalogue.available)blockingReasons.push('model-unavailable');
  if(capacity.spendControlReached===true)blockingReasons.push('spend-control');
  if(mainIncident&&capacity.ordinaryUsageAllowed===true||reserveIncident&&capacity.ordinaryUsageAllowed===false)blockingReasons.push('quota-incident');
  let mode=mainAvailable?weeklyPhase:reserveAvailable?'reserve':capacity.quality==='fresh'&&capacity.catalogue.available?'blocked':'unknown';
  if(capacity.quality==='fresh'&&!capacity.catalogue.available)mode='unknown';
  if(legacyPaused)mode='blocked';
  if(mode==='blocked'&&!blockingReasons.length)blockingReasons.push(capacity.ordinaryUsageAllowed===false?'ordinary-unavailable':'reserve-unavailable');
  const technicallyBlocked=blockingReasons.length>0||!['premium','conserve','survival','reserve'].includes(mode);
  const recommendedCeiling=technicallyBlocked?null:mode==='premium'?'requested':mode==='conserve'?'sol-medium'
    :mode==='survival'?'luna-medium':'luna-reserve-medium';
  const exceptions=mode==='premium'?['mechanical-contract-luna']
    :mode==='conserve'?['routine-terra','mechanical-contract-luna','exploratory-deferred','astra-deferred']
    :mode==='survival'?['sol-plan-sol-medium']
    :mode==='reserve'?['mechanical-contract-only']:[];
  return {weeklyPhase,mode,recommendedCeiling,exceptions,blockingReasons:[...new Set(blockingReasons)]};
}

function economicProfile(requirements,requestedProfile,mode) {
  if(mode==='premium') {
    if(requirements.requestedRole==='astra-review')return 'astra-low';
    if(requirements.mechanicalContract)return 'luna-medium';
    return requestedProfile;
  }
  if(mode==='conserve') {
    if(requirements.requestedRole==='astra-review'||requirements.taskClass==='exploratory')return null;
    if(requirements.mechanicalContract)return 'luna-medium';
    if(requirements.functionalRole==='specification'||requirements.taskClass==='complex')return 'sol-medium';
    if(['mechanical','routine'].includes(requirements.taskClass))return 'terra-medium';
    return null;
  }
  if(mode==='survival') {
    if(requirements.mechanicalContract)return 'luna-medium';
    if(requirements.functionalRole==='specification')return 'sol-medium';
    return null;
  }
  if(mode==='reserve')return requirements.mechanicalContract?'luna-reserve-medium':null;
  return null;
}

/** Produce Codex-specific candidates and facts; no Store or queue mutation. */
export function codexCandidates(requirements,requested,target,capacity,config,now=new Date()) {
  const requestedProfile=requestedProfileOf(requested);
  const weeklyPhase=phaseFor(capacity.main.weeklyRemainingPercent,config);
  const mainAvailable=capacity.quality==='fresh'&&capacity.ordinaryUsageAllowed===true&&capacity.spendControlReached!==true&&capacity.main.available===true;
  const reserveAvailable=config.reserveEnabled&&capacity.quality==='fresh'&&capacity.ordinaryUsageAllowed===false
    &&capacity.spendControlReached!==true&&capacity.reserve.available===true&&capacity.normalModelSlug===codexCapacityConstants.normalLunaModel
    &&target.offeredProfiles.includes('luna-medium')&&hasModel(capacity,'luna-reserve-medium');
  const unknown=capacity.quality!=='fresh'||capacity.ordinaryUsageAllowed===null||capacity.main.available===null;
  const mode=mainAvailable?weeklyPhase:reserveAvailable?'reserve':unknown?'unknown':'blocked';
  let reasonCode=null;
  if(!requestedProfile||!minimumCompatible(requirements,requestedProfile))reasonCode='profile-incompatible';
  else if(capacity.quality==='missing')reasonCode='quota-missing';
  else if(capacity.quality==='stale')reasonCode='quota-stale';
  else if(capacity.quality==='account-mismatch')reasonCode='account-mismatch';
  else if(capacity.quality!=='fresh')reasonCode='quota-invalid';
  const economic=economicProfile(requirements,requestedProfile,mode);
  if(!reasonCode&&!economic)reasonCode=mode==='blocked'?'ordinary-unavailable':requirements.taskClass==='unclassified'?'task-unclassified':'premium-work-deferred';
  if(!reasonCode&&economic!=='luna-reserve-medium'&&!target.offeredProfiles.includes(economic))reasonCode='profile-not-offered';
  if(!reasonCode&&!capacity.catalogue.available)reasonCode='model-unavailable';
  if(!reasonCode&&!hasModel(capacity,economic))reasonCode='model-unavailable';
  const override=requestedProfile&&minimumCompatible(requirements,requestedProfile)&&target.offeredProfiles.includes(requestedProfile)
    &&capacity.catalogue.available&&hasModel(capacity,requestedProfile)&&mainAvailable?requestedProfile:null;
  return {requestedProfile,weeklyPhase,mode,economicProfile:economic,overrideProfile:override,reasonCode,
    routeChanged:economic==='luna-reserve-medium',evaluatedAt:(now instanceof Date?now:new Date(now)).toISOString()};
}

export function profileDetails(name) { return profiles[name]??internalProfiles[name]??null; }
