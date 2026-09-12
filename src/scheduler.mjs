import { roles,executionFor,profiles } from './core.mjs';
import { codexCandidates,policyHash,policyVersion,profileDetails } from './codex-policy.mjs';
import { validateExecutionContract } from './task-classification.mjs';

export function requirementsFor(job) {
  const role=roles[job.role];
  if(!role)return {valid:false,requestedRole:job.role,functionalRole:null,taskClass:job.task_class??'unclassified',mechanicalContract:false};
  let metadata=null;
  try {metadata=job.task_metadata_json?JSON.parse(job.task_metadata_json):job.taskMetadata??null;} catch {}
  const taskClass=job.task_class??metadata?.class??'unclassified';
  let mechanicalContract=false;
  if(role.functionalRole==='implementation'&&taskClass==='mechanical'&&metadata?.executionContract) {
    try {validateExecutionContract(metadata.executionContract);mechanicalContract=true;} catch {}
  }
  return {version:1,valid:!job.error&&['unclassified','mechanical','routine','complex','exploratory'].includes(taskClass),
    requestedRole:job.role,functionalRole:role.functionalRole,taskClass,
    mechanicalContract,
    requiresPr:role.requiresPr,mayChangeTrackedFiles:role.mayChangeTrackedFiles,sandbox:role.sandbox};
}

function assignmentFor(job,requirements,candidates,target,config,decisionId=null,observationId=null,overrideId=null) {
  const requested=executionFor(job),effective=profileDetails(candidates.effectiveProfile);
  const timeoutMinutes=candidates.mode==='survival'&&requirements.functionalRole==='specification'
    ?Math.min(config.timeoutMinutes,config.scheduling.survivalPlanTimeoutMinutes):config.timeoutMinutes;
  return {version:1,routing:'quota-aware',targetId:target.id,provider:target.provider,adapter:target.adapter,
    observationSourceId:target.observationSourceId,capacityScopeId:target.capacityScopeId,
    requestedProfile:candidates.requestedProfile,effectiveProfile:candidates.effectiveProfile,
    requestedModel:requested.model,requestedEffort:requested.effort,model:effective.model,effort:effective.effort,
    sandbox:requirements.sandbox,timeoutMs:timeoutMinutes*60000,adapterVersion:null,
    quotaPool:candidates.mode==='reserve'?'reserve':'main',decisionId,observationId,overrideId,
    policyVersion,policyHash:policyHash(config.scheduling,target),mode:candidates.mode,reason:candidates.reasonCode};
}

function staticAssignmentFor(job,requirements,target,config) {
  const requested=executionFor(job);
  const effectiveProfile=job.profile??Object.entries(profiles)
    .find(([,profile])=>profile.model===requested.model&&profile.effort===requested.effort)?.[0]??null;
  return {version:1,routing:'static',targetId:target.id,provider:target.provider,adapter:target.adapter,
    observationSourceId:'local',capacityScopeId:'local-codex-account',requestedProfile:job.profile??null,effectiveProfile,
    requestedModel:requested.model,requestedEffort:requested.effort,model:requested.model,effort:requested.effort,
    sandbox:requirements.sandbox,timeoutMs:config.timeoutMinutes*60000,adapterVersion:null,quotaPool:null,
    decisionId:null,observationId:null,overrideId:null,policyVersion:null,policyHash:null,mode:null,reason:'static-profile'};
}

/** Resolve a serializable preview/admission decision without side effects. */
export function schedule({job,requirements,requested,target,candidates,override=null,config,observationId=null,now=new Date()}) {
  if(!requirements.valid)return {version:1,action:'invalid',reasonCode:'task-unclassified',assignment:null};
  if(!config.scheduling.enabled)return {version:1,action:'execute',reasonCode:'policy-disabled',weeklyPhase:null,mode:null,
    assignment:staticAssignmentFor(job,requirements,target,config),policyVersion:null,policyHash:null};
  let effectiveProfile=candidates.economicProfile,blockingReason=candidates.reasonCode,executionReason=null,overrideId=null;
  const activeOverride=override&&!override.revoked_at&&!override.consumed_at&&Date.parse(override.expires_at)>new Date(now).getTime();
  // overrideProfile is independently checked by the policy against all technical constraints.
  // A refusal of the economic candidate says nothing about the requested candidate.
  if(activeOverride&&candidates.overrideProfile) {
    effectiveProfile=candidates.overrideProfile;blockingReason=null;executionReason='human-override';overrideId=override.id;
  }
  if(blockingReason||!effectiveProfile)return {version:1,action:'defer',reasonCode:blockingReason??'ordinary-unavailable',
    weeklyPhase:candidates.weeklyPhase,mode:candidates.mode,assignment:null,policyVersion,policyHash:policyHash(config.scheduling,target)};
  const requestedProfile=candidates.requestedProfile;
  const action=effectiveProfile===requestedProfile||candidates.routeChanged?'execute':'degrade';
  const selected={...candidates,effectiveProfile,reasonCode:executionReason??(candidates.routeChanged?'reserve-route':action==='degrade'
    ?(candidates.mode==='conserve'&&effectiveProfile==='terra-medium'?'conserve-terra':candidates.mode==='conserve'?'conserve-sol-medium':'survival-planning'):'requested-compatible')};
  return {version:1,action,reasonCode:selected.reasonCode,weeklyPhase:selected.weeklyPhase,mode:selected.mode,
    assignment:assignmentFor(job,requirements,selected,target,config,null,observationId,overrideId),policyVersion,
    policyHash:policyHash(config.scheduling,target)};
}

export function evaluateSchedule({job,target,capacity,config,override=null,now=new Date()}) {
  const requirements=requirementsFor(job),execution=requirements.valid?executionFor(job):null;
  const requestedProfile=job.profile??(execution?Object.entries(profiles).find(([,value])=>value.model===execution.model&&value.effort===execution.effort)?.[0]:null);
  const candidates=requirements.valid?codexCandidates(requirements,{...execution,profile:requestedProfile},target,capacity,config.scheduling,now):null;
  return schedule({job,requirements,requested:execution,target,candidates,override,config,observationId:capacity.observationId,now});
}
