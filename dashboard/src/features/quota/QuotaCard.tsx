import { AlertCircle, RefreshCw, ShieldCheck, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { useQuota } from './useQuota';
import type { QuotaWindow } from './types';
import './quota.css';

const formatNumber=(value:number|null|undefined)=>value==null?'Indisponible':new Intl.NumberFormat('fr-FR').format(value);
function dateTime(value:string|number|null|undefined) {
  if(value==null)return 'inconnue';
  const date=new Date(typeof value==='number'?value*1000:value);
  return Number.isFinite(date.getTime())?new Intl.DateTimeFormat('fr-FR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}).format(date):'inconnue';
}
function duration(minutes:number|null) {
  if(minutes===null)return 'durée inconnue';
  if(minutes%1440===0)return `${minutes/1440} jours`;
  if(minutes%60===0)return `${minutes/60} heures`;
  return `${minutes} minutes`;
}
function windowName(window:QuotaWindow) {
  const envelope=window.limitName || (window.limitId==='codex'?'Codex':window.limitId) || 'Enveloppe inconnue';
  return `${envelope} · ${window.window==='secondary'?'secondaire':'principale'}`;
}
function WindowSummary({window}:{window:QuotaWindow}) {
  return <div className="window-summary">
    <span className="window-summary-name" title={windowName(window)}>{windowName(window)}</span>
    <strong className={window.remainingPercent!==null && window.remainingPercent<=20?'quota-low':''}>{window.remainingPercent??'—'}{window.remainingPercent!==null&&<span>%</span>}</strong>
    <small>{duration(window.windowMinutes)}</small>
  </div>;
}
function WindowMeter({window}:{window:QuotaWindow}) {
  return <div className="real-window">
    <div className="meter-heading"><span title={windowName(window)}>{windowName(window)}</span><strong>{window.remainingPercent===null?'—':`${window.remainingPercent} % restants`}</strong></div>
    {window.remainingPercent!==null&&<Progress value={Math.min(100,window.remainingPercent)} aria-label={`${window.remainingPercent} % du quota restants sur ${duration(window.windowMinutes)}`}/>}
    <div className="quota-caption"><span>Fenêtre de {duration(window.windowMinutes)}</span><span>Reset : {dateTime(window.resetsAt)}</span></div>
  </div>;
}

export function QuotaCard() {
  const {data,loading,networkError,refresh}=useQuota();
  const quota=data?.quota,usage=data?.usage;
  const windows=[...(quota?.windows??[])].sort((a,b)=>{
    const aCodex=a.limitId==='codex'?0:1,bCodex=b.limitId==='codex'?0:1;
    return aCodex-bCodex || (a.limitId??'').localeCompare(b.limitId??'') || (a.window??'').localeCompare(b.window??'');
  });
  const stale=quota?.stale||usage?.stale;
  const unavailable=data?.collectionStatus==='error' || data?.collectionStatus==='partial';
  const badge=networkError?'Hors connexion':!data?'Chargement':data.collectionStatus==='empty'?'À connecter':unavailable?'Lecture incomplète':stale?'Ancien relevé':'Relevé réel';
  const days=[...(usage?.dailyBuckets??[])].filter(d=>d.date!==null).sort((a,b)=>a.date!.localeCompare(b.date!));
  const lastDay=days.at(-1);
  return <section className="card quota quota-live" aria-labelledby="quota-title">
    <div className="card-title"><span id="quota-title"><Zap size={18}/>Quota & tokens</span><span className={'soft-badge '+(stale||unavailable||networkError?'warning-badge':'')}>{badge}</span></div>
    <p className="card-sub">Usage Codex.</p>
    {networkError&&<p className="quota-message" role="status"><AlertCircle size={15}/>Le serveur local ne répond pas. Les valeurs conservées ne sont plus actualisées.</p>}
    {!data&&!networkError&&<p className="quota-empty" role="status">Lecture des derniers relevés…</p>}
    {data?.collectionStatus==='empty'&&<p className="quota-empty">Aucun relevé enregistré. Démarrez l’observateur local pour alimenter cette carte.</p>}
    {unavailable&&<p className="quota-message" role="status"><AlertCircle size={15}/>La dernière collecte n’a pas obtenu toutes les données. Aucune valeur manquante n’est remplacée par zéro.</p>}
    {stale&&!networkError&&<p className="quota-message" role="status"><AlertCircle size={15}/>Dernière mesure reçue il y a plus de 3 minutes. Vérifiez que l’observateur est actif.</p>}
    {windows.length>0&&<div className="quota-summaries" aria-label="Quotas restants">{windows.map((window,index)=><WindowSummary key={`${window.limitId}-${window.window}-${index}`} window={window}/>)}</div>}
    {windows.length>0&&<div className="quota-meters" aria-label="Jauges de quota restant">{windows.map((window,index)=><WindowMeter key={`${window.limitId}-${window.window}-${index}`} window={window}/>)}</div>}
    {data&&data.collectionStatus!=='empty'&&!windows.length&&<p className="quota-empty">Fenêtres de quota indisponibles.</p>}
    {quota && <div className={'quota-health ' + (quota.stale || networkError ? 'quota-health-unknown' : '')}><ShieldCheck size={19} /><span>{quota.stale || networkError ? 'État à revalider' : quota.ordinaryUsageAllowed === true ? 'Usage autorisé au dernier relevé' : quota.ordinaryUsageAllowed === false ? 'Usage ordinaire indisponible' : 'Disponibilité non renseignée'}<small>Quota relevé le {dateTime(quota.observedAt)}</small></span></div>}
    <div className="account-tokens"><span className="eyebrow">TOKENS · CUMUL</span><strong>{formatNumber(usage?.lifetimeTokens)}</strong>{usage&&<small>Relevé le {dateTime(usage.observedAt)}</small>}
      {usage&&<details><summary>Voir les totaux journaliers</summary><p>Dernier jour disponible : {lastDay?.date??'inconnu'}. Un jour absent n’indique pas une consommation nulle.</p>{days.length>0?<dl>{days.slice(-7).map(day=><div key={day.date}><dt>{day.date}</dt><dd>{formatNumber(day.tokens)}</dd></div>)}</dl>:<p>Aucun total journalier disponible.</p>}</details>}
    </div>
    <div className="quota-refresh"><small>{data?.collectedAt?`Dernière tentative : ${dateTime(data.collectedAt)}`:'En attente de la première collecte'}</small><Button variant="ghost" size="icon-sm" onClick={()=>{void refresh();}} disabled={loading} aria-label="Actualiser l’affichage du quota"><RefreshCw size={14}/></Button></div>
    <p className="quota-note">Compte entier, y compris l’activité hors du pilote.<br/>Lecture locale toutes les 15 s. Aucun appel de modèle.</p>
  </section>;
}
