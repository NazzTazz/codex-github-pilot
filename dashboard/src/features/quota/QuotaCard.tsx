import { AlertCircle, RefreshCw, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { useQuota } from './useQuota';
import { useScheduling } from '../scheduling/useScheduling';
import { SchedulingBadge,SchedulingDialog } from '../scheduling/SchedulingPanel';
import type { SchedulingResponse } from '../scheduling/types';
import type { AccountQuota, QuotaWindow } from './types';
import './quota.css';
import './accounts.css';

const formatNumber=(value:number|null|undefined)=>value==null?'Indisponible':new Intl.NumberFormat('fr-FR').format(value);
function dateTime(value:string|number|null|undefined) {
  if(value==null)return 'inconnue';
  const date=new Date(typeof value==='number'?value*1000:value);
  return Number.isFinite(date.getTime())?new Intl.DateTimeFormat('fr-FR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit',timeZoneName:'short'}).format(date):'inconnue';
}
function duration(minutes:number|null) {
  if(minutes===null)return 'durée inconnue';
  if(minutes===10080)return 'hebdomadaire';
  if(minutes%1440===0)return `${minutes/1440} jours`;
  if(minutes%60===0)return `${minutes/60} h`;
  return `${minutes} min`;
}
function windowName(value:QuotaWindow) {
  const envelope=value.limitId==='codex'?'Principal':value.limitId==='base_model_inference'?'Luna Reserve':value.limitId==='codex_bengalfox'?'Spark':value.limitName||value.limitId||'Quota';
  return `${envelope} · ${duration(value.windowMinutes)}`;
}
function accountState(account:AccountQuota,networkError:boolean) {
  const quota=account.quota,windows=quota?.windows??[];
  if(networkError||!quota||quota.stale||account.identityStatus==='changed'||!windows.length)
    return {tone:'degraded',label:'À vérifier'};
  // A zero short window blocks its bucket even when its weekly window is positive.
  const buckets=new Map<string,QuotaWindow[]>();
  for(const window of windows) {
    const key=window.limitId??'unknown';
    buckets.set(key,[...(buckets.get(key)??[]),window]);
  }
  if([...buckets.values()].every(group=>group.some(window=>window.remainingPercent===0)))
    return {tone:'exhausted',label:'Quotas épuisés'};
  if(quota.ordinaryUsageAllowed!==true||windows.some(window=>window.remainingPercent===0||window.remainingPercent===null))
    return {tone:'degraded',label:quota.ordinaryUsageAllowed===false?'Usage normal indisponible':'Mode dégradé'};
  return {tone:'normal',label:'Usage normal'};
}
function WindowMeter({window}:{window:QuotaWindow}) {
  return <div className="real-window">
    <div className="meter-heading"><span title={windowName(window)}>{windowName(window)}</span><strong>{window.remainingPercent===null?'—':`${window.remainingPercent} %`}</strong></div>
    {window.remainingPercent!==null&&<Progress value={Math.min(100,window.remainingPercent)} aria-label={`${windowName(window)} : ${window.remainingPercent} % restants`}/>}
    <div className="quota-caption"><span>Reset : {dateTime(window.resetsAt)}</span></div>
  </div>;
}
function AccountPanel({account,networkError,scheduling,schedulingError}:{account:AccountQuota;networkError:boolean;scheduling:SchedulingResponse|null;schedulingError:boolean}) {
  const quota=account.quota,usage=account.usage,state=accountState(account,networkError);
  const windows=[...(quota?.windows??[])].sort((a,b)=>Number(b.limitId==='codex')-Number(a.limitId==='codex')||(a.limitId??'').localeCompare(b.limitId??'')||(a.window??'').localeCompare(b.window??''));
  const days=[...(usage?.dailyBuckets??[])].filter(day=>day.date!==null).sort((a,b)=>a.date!.localeCompare(b.date!));
  return <article className={`account-quota account-${state.tone}`} aria-labelledby={`quota-${account.id}`}>
    <div className="account-heading"><h3 id={`quota-${account.id}`}>{account.label}</h3><span className="account-state">{state.label}</span></div>
    {scheduling?.enabled&&scheduling.observationSourceId===account.id&&<SchedulingBadge data={scheduling} networkError={schedulingError}/>}
    {windows.length>0?<div className="quota-meters">{windows.map((window,index)=><WindowMeter key={`${window.limitId}-${window.window}-${index}`} window={window}/>)}</div>:<p className="quota-empty">{account.collectionStatus==='empty'?'En attente du premier relevé.':'Quotas indisponibles.'}</p>}
    <details className="account-details">
      <summary>Voir les détails</summary>
      <p>Plan observé : {account.planType??'inconnu'}. Collecte : {account.collectionStatus}.</p>
      {account.identityStatus==='changed'&&<p>Compte connecté changé.</p>}
      {account.sharedQuotaWith.length>0&&<p>Quota partagé avec {account.sharedQuotaWith.join(', ')}.</p>}
      {(quota?.stale||usage?.stale)&&<p>Relevé périmé : valeurs à revalider.</p>}
      {account.errors.length>0&&<p>Lecture incomplète : {account.errors.join(', ')}.</p>}
      <p>Quotas relevés le {dateTime(quota?.observedAt)}.</p>
      <div className="account-tokens"><span className="eyebrow">TOKENS · CUMUL</span><strong>{formatNumber(usage?.lifetimeTokens)}</strong><small>Relevés le {dateTime(usage?.observedAt)}</small>
        {days.length>0&&<dl>{days.slice(-7).map(day=><div key={day.date}><dt>{day.date}</dt><dd>{formatNumber(day.tokens)}</dd></div>)}</dl>}
      </div>
      <p>Dernière tentative : {dateTime(account.collectedAt)}.</p>
    </details>
  </article>;
}
export function QuotaCard() {
  const {data,loading,networkError,refresh}=useQuota();
  const scheduling=useScheduling();
  const refreshAll=()=>{void refresh();void scheduling.refresh();};
  return <section className="card quota quota-live quota-accounts" aria-labelledby="quota-title">
    <div className="card-title"><span id="quota-title"><Zap size={18}/>Quotas</span><Button variant="ghost" size="icon-sm" onClick={refreshAll} disabled={loading||scheduling.loading} aria-label="Actualiser les quotas et décisions"><RefreshCw size={14}/></Button></div>
    {!data&&!networkError&&<p className="quota-empty">Lecture des relevés…</p>}
    {networkError&&<p className="quota-message"><AlertCircle size={15}/>Lecture indisponible.</p>}
    <div className="accounts-quota-grid">{data?.accounts.map(account=><AccountPanel key={account.id} account={account} networkError={networkError} scheduling={scheduling.data} schedulingError={scheduling.networkError}/>)}</div>
    <SchedulingDialog data={scheduling.data} networkError={scheduling.networkError}/>
  </section>;
}
