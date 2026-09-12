import test from 'node:test';
import assert from 'node:assert/strict';
import { schedulingConfig,localCodexTarget } from '../src/scheduling-config.mjs';
import { capacityFromObservation } from '../src/capacity.mjs';
import { evaluateSchedule } from '../src/scheduler.mjs';

const observation={mode:'multi',defaultAccountId:'plus',accounts:[
  {id:'plus',scopeId:'codex-observation:plus',codexHome:'C:/codex-plus'},
  {id:'lite',scopeId:'codex-observation:lite',codexHome:'C:/codex-lite'}
]};
const enabled=()=>schedulingConfig({enabled:true,observationSourceId:'lite'},observation);
const at=new Date('2026-09-12T12:00:00.000Z');
const reset=Math.floor(at.getTime()/1000)+3600;
const contract={scope:'Change labels',expectedResult:'Labels changed',invariants:['Keep calculations'],areas:[],
  acceptanceCriteria:['No old label'],validationCommands:['npm test']};
const models=['gpt-5.6-luna','gpt-5.6-terra','gpt-5.6-sol','gpt-6-astra','gpt-reserve']
  .map(slug=>({slug,efforts:slug==='gpt-6-astra'?['low']:['medium','high']}));

function row(windows,{source='lite',scope='codex-observation:lite',account='account-lite',ordinary=true}={}) {
  return {id:7,observation_source_id:source,capacity_scope_id:scope,account_key:account,
    quota_observed_at:'2026-09-12T11:59:30.000Z',errors:{},quota:{windows,ordinary_usage_allowed:ordinary,
      normal_model_slug:'gpt-5.6-luna',spend_control_reached:false},capabilities:{observed_at:'2026-09-12T11:59:30.000Z',account_key:account,models}};
}
const window=(limit_id,remaining_percent,window_minutes=10080)=>({limit_id,window:'primary',remaining_percent,
  window_minutes,resets_at:reset,reached_type:null});
const config=scheduling=>({timeoutMinutes:30,scheduling});

test('override uses its own offered profile and catalogue while preserving technical refusals',()=>{
  const scheduling=enabled(),target={...localCodexTarget({scheduling,observation}),offeredProfiles:['sol-high']};
  const expected={expectedAccountKey:'account-lite'};
  const job={id:20,role:'sol-implement',profile:'sol-high',task_class:'routine'};
  const override={id:20,expires_at:'2026-09-13T00:00:00Z'};
  const sample=row([window('codex',9)]);
  sample.capabilities.models=sample.capabilities.models.filter(model=>model.slug==='gpt-5.6-sol');
  const decide=(value,offer=target,chosenOverride=override)=>evaluateSchedule({job,target:offer,
    capacity:capacityFromObservation(value,at,180,expected),config:config(scheduling),override:chosenOverride,now:at});
  assert.equal(decide(sample).assignment?.effectiveProfile,'sol-high');
  assert.equal(decide(sample).reasonCode,'human-override');
  assert.equal(decide(sample,target,null).action,'defer');
  for(const inactive of [{...override,expires_at:at.toISOString()},{...override,revoked_at:at.toISOString()},
    {...override,consumed_at:at.toISOString()}])assert.equal(decide(sample,target,inactive).assignment,null);
  // Offering Terra without its catalogue entry must not poison a valid Sol override either.
  assert.equal(decide(sample,{...target,offeredProfiles:['sol-high','terra-medium']}).action,'execute');
  for(const change of [value=>{value.account_key='other';},value=>{value.quota.spend_control_reached=true;},
    value=>{value.quota.windows[0].remaining_percent=0;},value=>{value.capabilities.models=[];},
    value=>{value.capabilities.observed_at='2020-01-01';}]) {
    const blocked=structuredClone(sample);change(blocked);assert.equal(decide(blocked).assignment,null);
  }
  assert.equal(decide(sample,{...target,offeredProfiles:['terra-medium']}).assignment,null);
});

test('pool expiry is independent while stale observations and catalogues still block reserve',()=>{
  const scheduling={...enabled(),reserveEnabled:true},target=localCodexTarget({scheduling,observation});
  const expected={expectedAccountKey:'account-lite'};
  const expired=Math.floor(at.getTime()/1000)-1,next=Math.floor(at.getTime()/1000)+20;
  const sample=row([{...window('codex',0),resets_at:expired},{...window('base_model_inference',80),resets_at:next}],{ordinary:false});
  const capacity=capacityFromObservation(sample,at,180,expected);
  const job={id:21,role:'sol-implement',profile:'luna-medium',task_class:'mechanical',task_metadata_json:JSON.stringify({version:1,class:'mechanical',executionContract:contract})};
  const decide=value=>evaluateSchedule({job,target,capacity:value,config:config(scheduling),now:at});
  assert.equal(capacity.quality,'fresh');assert.equal(capacity.main.available,null);
  assert.equal(decide(capacity).assignment?.quotaPool,'reserve');
  assert.equal(capacity.reserve.validUntil,new Date(next*1000).toISOString());
  const expiredBoth=structuredClone(sample);expiredBoth.quota.windows[1].resets_at=expired;
  assert.equal(decide(capacityFromObservation(expiredBoth,at,180,expected)).assignment,null);
  const stale=structuredClone(sample);stale.quota_observed_at='2020-01-01';
  assert.equal(decide(capacityFromObservation(stale,at,180,expected)).assignment,null);
  const staleCatalogue=structuredClone(sample);staleCatalogue.capabilities.observed_at='2020-01-01';
  assert.equal(decide(capacityFromObservation(staleCatalogue,at,180,expected)).assignment,null);
});

test('T3 binds an enabled scheduler to an explicit observation source, never the default account',()=>{
  assert.throws(()=>schedulingConfig({enabled:true},observation),/explicit observation source/);
  assert.throws(()=>schedulingConfig({enabled:true,observationSourceId:'missing'},observation),/Unknown scheduling observation source/);
  const scheduling=enabled();
  const target=localCodexTarget({scheduling,observation});
  assert.equal(target.observationSourceId,'lite');
  assert.equal(target.capacityScopeId,'codex-observation:lite');
  assert.equal(observation.defaultAccountId,'plus');
});

test('capacity rejects account/scope mismatch and never substitutes Spark for Codex main',()=>{
  const expected={observationSourceId:'lite',scopeId:'codex-observation:lite',expectedAccountKey:'account-lite'};
  const sparkOnly=capacityFromObservation(row([window('spark',90)]),at,180,expected);
  assert.equal(sparkOnly.quality,'invalid');
  const wrongAccount=capacityFromObservation(row([window('codex',80)],{account:'other'}),at,180,expected);
  assert.equal(wrongAccount.quality,'account-mismatch');
  const wrongScope=capacityFromObservation(row([window('codex',80)],{scope:'codex-observation:plus'}),at,180,expected);
  assert.equal(wrongScope.quality,'invalid');
  const unknownExpected=capacityFromObservation(row([window('codex',80)]),at,180,{...expected,expectedAccountKey:null});
  assert.equal(unknownExpected.quality,'invalid');
});

test('unknown execution identity and a stale catalogue cannot produce assignments',()=>{
  const scheduling=enabled(),target=localCodexTarget({scheduling,observation});
  const job={id:1,role:'sol-implement',profile:'sol-medium',task_class:'routine',task_metadata_json:JSON.stringify({version:1,class:'routine',executionContract:null})};
  const unknown=capacityFromObservation(row([window('codex',80)]),at,180,
    {observationSourceId:'lite',scopeId:target.capacityScopeId,expectedAccountKey:null});
  const unknownDecision=evaluateSchedule({job,target,capacity:unknown,config:config(scheduling),now:at});
  assert.equal(unknownDecision.action,'defer');assert.equal(unknownDecision.assignment,null);
  const staleCatalogue=row([window('codex',80)]);staleCatalogue.capabilities.observed_at='2020-01-01T00:00:00.000Z';
  const stale=capacityFromObservation(staleCatalogue,at,180,
    {observationSourceId:'lite',scopeId:target.capacityScopeId,expectedAccountKey:'account-lite'});
  assert.equal(stale.quality,'fresh');assert.equal(stale.catalogue.available,false);
  const staleDecision=evaluateSchedule({job,target,capacity:stale,config:config(scheduling),now:at});
  assert.equal(staleDecision.action,'defer');assert.equal(staleDecision.reasonCode,'model-unavailable');
});

test('a depleted Codex short window blocks main while Lite weekly alone is sufficient',()=>{
  const expected={observationSourceId:'lite',scopeId:'codex-observation:lite',expectedAccountKey:'account-lite'};
  const plus=capacityFromObservation(row([window('codex',75),window('codex',0,300)]),at,180,expected);
  assert.equal(plus.quality,'fresh');assert.equal(plus.main.available,false);
  const lite=capacityFromObservation(row([window('codex',9),window('spark',0,300),window('base_model_inference',100)]),at,180,expected);
  assert.equal(lite.quality,'fresh');assert.equal(lite.main.available,true);assert.equal(lite.main.weeklyRemainingPercent,9);
  const expiredReserve={...window('base_model_inference',100),resets_at:Math.floor(at.getTime()/1000)-1};
  const independent=capacityFromObservation(row([window('codex',80),expiredReserve]),at,180,expected);
  assert.equal(independent.quality,'fresh');assert.equal(independent.main.available,true);assert.equal(independent.reserve.available,null);
  const scheduling=enabled(),target=localCodexTarget({scheduling,observation});
  const job={id:6,role:'sol-implement',profile:'sol-medium',task_class:'routine',task_metadata_json:JSON.stringify({version:1,class:'routine',executionContract:null})};
  assert.notEqual(evaluateSchedule({job,target,capacity:independent,config:config(scheduling),now:at}).assignment,null);
});

test('policy applies conserve, survival planning, mechanical Luna, and preserves disabled static assignment',()=>{
  const scheduling=enabled(),target=localCodexTarget({scheduling,observation});
  const expected={observationSourceId:'lite',scopeId:target.capacityScopeId,expectedAccountKey:'account-lite'};
  const capacity=remaining=>capacityFromObservation(row([window('codex',remaining)]),at,180,expected);
  const routine={id:1,role:'sol-implement',profile:'sol-high',task_class:'routine',task_metadata_json:JSON.stringify({version:1,class:'routine',executionContract:null})};
  const conserve=evaluateSchedule({job:routine,target,capacity:capacity(9),config:config(scheduling),now:at});
  assert.equal(conserve.action,'degrade');assert.equal(conserve.assignment.effectiveProfile,'terra-medium');
  const plan={...routine,id:2,role:'sol-plan',profile:'sol-high',task_class:'complex',task_metadata_json:JSON.stringify({version:1,class:'complex',executionContract:null})};
  const survival=evaluateSchedule({job:plan,target,capacity:capacity(3),config:config(scheduling),now:at});
  assert.equal(survival.action,'degrade');assert.equal(survival.assignment.effectiveProfile,'sol-medium');assert.equal(survival.assignment.timeoutMs,600000);
  const mechanical={...routine,id:3,profile:'sol-medium',task_class:'mechanical',task_metadata_json:JSON.stringify({version:1,class:'mechanical',executionContract:contract})};
  const premium=evaluateSchedule({job:mechanical,target,capacity:capacity(90),config:config(scheduling),now:at});
  assert.equal(premium.assignment.effectiveProfile,'luna-medium');
  const invalidContract={...mechanical,id:4,task_metadata_json:JSON.stringify({version:1,class:'mechanical',executionContract:{scope:'x'}})};
  const invalid=evaluateSchedule({job:invalidContract,target,capacity:capacity(90),config:config(scheduling),now:at});
  assert.equal(invalid.action,'execute');assert.equal(invalid.assignment.effectiveProfile,'sol-medium');
  const disabled=schedulingConfig(undefined,observation),legacyTarget=localCodexTarget({scheduling:disabled,observation});
  const historical=evaluateSchedule({job:routine,target:legacyTarget,capacity:capacity(90),config:config(disabled),now:at});
  assert.equal(historical.action,'execute');assert.equal(historical.assignment.routing,'static');
  assert.equal(historical.assignment.model,'gpt-5.6-sol');assert.equal(historical.assignment.policyVersion,null);
});

test('a valid human override executes the requested profile instead of becoming a blocking reason',()=>{
  const scheduling=enabled(),target=localCodexTarget({scheduling,observation});
  const expected={observationSourceId:'lite',scopeId:target.capacityScopeId,expectedAccountKey:'account-lite'};
  const capacity=capacityFromObservation(row([window('codex',3)]),at,180,expected);
  const job={id:5,role:'sol-implement',profile:'sol-high',task_class:'complex',task_metadata_json:JSON.stringify({version:1,class:'complex',executionContract:null})};
  const override={id:12,expires_at:'2026-09-13T12:00:00.000Z',revoked_at:null,consumed_at:null};
  const decision=evaluateSchedule({job,target,capacity,config:config(scheduling),override,now:at});
  assert.equal(decision.action,'execute');assert.equal(decision.reasonCode,'human-override');
  assert.equal(decision.assignment.effectiveProfile,'sol-high');assert.equal(decision.assignment.overrideId,12);
});
