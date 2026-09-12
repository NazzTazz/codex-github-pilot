import { profiles } from './core.mjs';

export const schedulingDefaults=Object.freeze({enabled:false,conserveAtPercent:15,survivalBelowPercent:5,
  maxObservationAgeSeconds:180,quotaErrorCooldownSeconds:300,survivalPlanTimeoutMinutes:10,
  offeredProfiles:Object.freeze(['sol-medium','sol-high','astra-low','terra-medium','luna-medium']),reserveEnabled:false});

export function schedulingConfig(value) {
  const input=value===undefined?{}:value;
  if(!input || typeof input!=='object' || Array.isArray(input))throw new Error('Invalid scheduling configuration');
  const allowed=new Set(Object.keys(schedulingDefaults));
  if(Object.keys(input).some(key=>!allowed.has(key)))throw new Error('Invalid scheduling configuration');
  const offered=Object.hasOwn(input,'offeredProfiles')?input.offeredProfiles:schedulingDefaults.offeredProfiles;
  const result={...schedulingDefaults,...input,offeredProfiles:Array.isArray(offered)?[...offered]:offered};
  if(typeof result.enabled!=='boolean'||typeof result.reserveEnabled!=='boolean'
    || typeof result.survivalBelowPercent!=='number'||typeof result.conserveAtPercent!=='number'
    || !(result.survivalBelowPercent>0&&result.survivalBelowPercent<result.conserveAtPercent&&result.conserveAtPercent<100)
    || !Number.isInteger(result.maxObservationAgeSeconds)||result.maxObservationAgeSeconds<30||result.maxObservationAgeSeconds>900
    || !Number.isInteger(result.quotaErrorCooldownSeconds)||result.quotaErrorCooldownSeconds<30||result.quotaErrorCooldownSeconds>3600
    || !Number.isInteger(result.survivalPlanTimeoutMinutes)||result.survivalPlanTimeoutMinutes<1||result.survivalPlanTimeoutMinutes>120
    || !Array.isArray(result.offeredProfiles)||!result.offeredProfiles.length
    || Array.from(result.offeredProfiles).some(name=>typeof name!=='string'||!Object.hasOwn(profiles,name))
    || new Set(result.offeredProfiles).size!==result.offeredProfiles.length
    || (result.reserveEnabled&&(!result.enabled||!result.offeredProfiles.includes('luna-medium')))) throw new Error('Invalid scheduling configuration');
  return result;
}

export function localCodexTarget(config) {
  return {id:'local-codex',provider:'openai',adapter:'codex-exec',capacityScopeId:'local-codex-account',offeredProfiles:[...config.scheduling.offeredProfiles]};
}
