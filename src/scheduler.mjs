import { roles,executionFor,profiles } from './core.mjs';
import { codexCandidates,policyHash,policyVersion,profileDetails } from './codex-policy.mjs';
import { validateExecutionContract } from './task-classification.mjs';
import { createHash } from 'node:crypto';
import { readCapacity } from './capacity.mjs';
import { localCodexTarget,executionSource } from './scheduling-config.mjs';
import { readExecutionIdentity } from './observation.mjs';
import { validateQueuedJob } from './job-validation.mjs';
import { incidentState,reconcileIncidents } from './quota-incidents.mjs';

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

const iso=clock=>clock().toISOString();
const binding=config=>JSON.stringify({target:localCodexTarget(config),source:executionSource(config),scheduling:config.scheduling,timeout:config.timeoutMinutes});
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function schedulingDecision({store,config,job,expectedAccountKey,now,mutate=false}) {
  const target=localCodexTarget(config);
  const capacity=readCapacity(store,{observationSourceId:target.observationSourceId??'local',scopeId:target.capacityScopeId,expectedAccountKey},
    new Date(now),config.scheduling.maxObservationAgeSeconds);
  const incidents=mutate?reconcileIncidents(store,capacity,config,now)
    :incidentState(store.incidents(target.capacityScopeId,capacity.accountKey),capacity,now).blocking;
  const override=store.activeOverride(job.id,now);
  let decision=evaluateSchedule({job,target,capacity,config,override,now:new Date(now)});
  const blocked=incidents.filter(row=>row.quota_pool===(decision.assignment?.quotaPool??(decision.mode==='reserve'?'reserve':'main')));
  if(decision.action!=='invalid'&&(store.get('quotaPaused')==='yes'||blocked.length))decision={...decision,action:'defer',assignment:null,
    reasonCode:store.get('quotaPaused')==='yes'?'legacy-quota-pause':'quota-incident'};
  if(decision.assignment)Object.assign(decision.assignment,{accountKey:capacity.accountKey,observedAt:capacity.observedAt,
    admittedAt:now,observationAgeAtAdmissionMs:Date.parse(now)-Date.parse(capacity.observedAt)});
  const audit={...decision,requirements:requirementsFor(job),requested:{profile:job.profile??null,role:job.role},target,
    observationSourceId:target.observationSourceId??'local',capacityScopeId:target.capacityScopeId,observationId:capacity.observationId,
    accountKey:capacity.accountKey,capacity,override:override?{id:override.id,expiresAt:override.expires_at}:null,
    restrictions:blocked.map(row=>({pool:row.quota_pool,kind:row.kind}))};
  const fingerprint=digest({request:job.request,classification:[job.task_class,job.task_metadata_json,job.specification_hash],
    role:job.role,profile:job.profile,action:audit.action,reason:audit.reasonCode,mode:audit.mode,policy:audit.policyHash,
    source:audit.observationSourceId,scope:audit.capacityScopeId,account:audit.accountKey,override:audit.override?.id??null,
    restrictions:audit.restrictions,facts:{quality:capacity.quality,ordinary:capacity.ordinaryUsageAllowed,
      spend:capacity.spendControlReached,main:capacity.main.available,reserve:capacity.reserve.available,catalogue:capacity.catalogue.available}});
  return {decision:audit,fingerprint,capacity};
}

/** Called under the worker lock; the database transaction also protects against competing claims. */
export async function scheduleNext(config,store,github,{clock=()=>new Date(),readIdentity=readExecutionIdentity,validate=validateQueuedJob}={}) {
  if(!config.scheduling?.enabled)return {job:store.get('quotaPaused')==='yes'?null:store.claim(),assignment:null};
  const initialBinding=binding(config);
  let identity=await readIdentity(config);
  if(binding(config)!==initialBinding)return null;
  // Remember a spend-control observation even when no job is currently queued.
  store.transaction(()=>{
    const target=localCodexTarget(config),now=iso(clock);
    const capacity=readCapacity(store,{observationSourceId:target.observationSourceId??'local',scopeId:target.capacityScopeId,expectedAccountKey:identity},
      new Date(now),config.scheduling.maxObservationAgeSeconds);
    reconcileIncidents(store,capacity,config,now);
  });
  for(const candidate of store.candidates()) {
    if(binding(config)!==initialBinding)return null;
    const preview=store.transaction(()=>{
      const job=store.job(candidate.id);
      if(store.hasRunning()||!['queued','deferred'].includes(job?.status))return null;
      const result=schedulingDecision({store,config,job,expectedAccountKey:identity,now:iso(clock),mutate:true});
      if(!result.decision.assignment)store.saveDecision(job,result.decision,result.fingerprint,'evaluation',iso(clock));
      return result;
    });
    if(!preview?.decision.assignment)continue;
    const validation=await validate(config,github,candidate);
    if(!validation.valid) {
      store.transaction(()=>{
        const job=store.job(candidate.id);
        if(['queued','deferred'].includes(job?.status))store.update(job.id,{status:'cancelled',error:validation.error});
      });
      continue;
    }
    identity=await readIdentity(config);
    if(binding(config)!==initialBinding)return null;
    const admitted=store.transaction(()=>{
      const job=store.job(candidate.id);
      if(store.hasRunning()||!['queued','deferred'].includes(job?.status))return null;
      // Nothing asynchronous between this fresh read, evaluation and the claim.
      const now=iso(clock),result=schedulingDecision({store,config,job,expectedAccountKey:identity,now,mutate:true});
      store.saveDecision(job,result.decision,result.fingerprint,result.decision.assignment?'admission':'evaluation',now);
      return result.decision.assignment?{job:store.job(job.id),assignment:result.decision.assignment}:null;
    });
    if(admitted)return {...admitted,beforeSpawn:()=>validateAssignmentBeforeSpawn(config,store,admitted.assignment,
      {clock,readIdentity,initialBinding})};
  }
  return null;
}

/** Keep the admitted profile: economic phase changes do not rewrite a started attempt. */
export async function validateAssignmentBeforeSpawn(config,store,assignment,{clock=()=>new Date(),readIdentity=readExecutionIdentity,initialBinding=binding(config)}={}) {
  if(binding(config)!==initialBinding)throw new Error('Execution source/configuration changed before spawn');
  const identity=await readIdentity(config);
  if(binding(config)!==initialBinding||!identity||identity!==assignment.accountKey)throw new Error('Execution account changed or is unknown before spawn');
  const now=iso(clock),target=localCodexTarget(config);
  const {capacity,incidents}=store.transaction(()=>{
    const capacity=readCapacity(store,{observationSourceId:target.observationSourceId??'local',scopeId:target.capacityScopeId,expectedAccountKey:identity},
      new Date(now),config.scheduling.maxObservationAgeSeconds);
    return {capacity,incidents:reconcileIncidents(store,capacity,config,now)};
  });
  const reserve=assignment.quotaPool==='reserve';
  const offered=target.offeredProfiles.includes(reserve?'luna-medium':assignment.effectiveProfile);
  if(capacity.quality!=='fresh'||capacity.spendControlReached===true||capacity[assignment.quotaPool]?.available!==true
    ||capacity.ordinaryUsageAllowed!==(reserve?false:true)||!offered||!capacity.catalogue.available
    ||!capacity.catalogue.models.some(model=>model.slug===assignment.model&&model.efforts.includes(assignment.effort))
    ||reserve&&(!config.scheduling.reserveEnabled||capacity.normalModelSlug!=='gpt-5.6-luna')
    ||incidents.some(row=>row.quota_pool===assignment.quotaPool)||store.get('quotaPaused')==='yes')
    throw new Error('Execution capacity no longer valid before spawn; no automatic retry');
  return {observationId:capacity.observationId,observationAgeMs:Date.parse(now)-Date.parse(capacity.observedAt),checkedAt:now};
}
