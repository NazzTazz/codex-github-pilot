import { ArrowRight,Clock3,Route } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog,DialogContent,DialogDescription,DialogHeader,DialogTitle,DialogTrigger } from '@/components/ui/dialog';
import type { SchedulingResponse } from './types';
import './scheduling.css';

const modes:Record<string,string>={premium:'Premium',conserve:'Conservation',survival:'Survie',reserve:'Réserve',unknown:'Inconnu',blocked:'Bloqué'};
const reasons:Record<string,string>={'legacy-quota-pause':'Pause quota historique','quota-missing':'Quota absent','quota-stale':'Relevé périmé',
  'quota-invalid':'Quota invalide','account-mismatch':'Compte différent','model-unavailable':'Catalogue indisponible','quota-incident':'Incident quota',
  'ordinary-unavailable':'Usage normal indisponible','premium-work-deferred':'Travail premium reporté','profile-incompatible':'Profil insuffisant',
  'profile-not-offered':'Profil non offert','conserve-terra':'Terra en conservation','conserve-sol-medium':'Sol medium en conservation',
  'survival-planning':'Planification bornée','mechanical-contract-luna':'Contrat mécanique vers Luna','requested-compatible':'Profil demandé'};
const label=(value:string|null|undefined,map:Record<string,string>)=>value?map[value]??value:'Indisponible';
const when=(value:string|null)=>value&&Number.isFinite(Date.parse(value))?new Intl.DateTimeFormat('fr-FR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit',timeZoneName:'short'}).format(new Date(value)):'inconnue';

function ObservationReference({data}:{data:SchedulingResponse}) {
  return <small className="scheduling-observation">Relevé de la prévision{data.observationId!==null?` #${data.observationId}`:''} : {when(data.observedAt)} · source {data.observationSourceId}</small>;
}

export function SchedulingBadge({data,networkError}:{data:SchedulingResponse;networkError:boolean}) {
  const blocked=data.blockingReasons[0];
  return <div className={`scheduling-badge scheduling-${networkError||!data.available?'unknown':data.mode??'unknown'}`}>
    <span className="scheduling-kicker"><Route size={12}/>Cible d'exécution · Prévision</span><strong>{data.enabled?label(data.mode,modes):'Policy désactivée'}</strong>
    <small>{networkError?'Données conservées, actualisation indisponible.':!data.available?'Base scheduling indisponible.':blocked?label(blocked,reasons):`Repère : ${data.recommendedCeiling??'aucun'}`}</small>
    <small>{data.counts?`${data.counts.deferredJobs} report(s) prévu(s)`:'Reports non mesurés'}</small>
    <ObservationReference data={data}/>
  </div>;
}
export function SchedulingDialog({data,networkError}:{data:SchedulingResponse|null;networkError:boolean}) {
  return <Dialog><DialogTrigger render={<Button variant="ghost" className="scheduling-trigger"/>}>Voir les décisions <ArrowRight size={13}/></DialogTrigger>
    <DialogContent className="scheduling-dialog"><DialogHeader><DialogTitle>Décisions de scheduling</DialogTitle>
      <DialogDescription>Prévision sur les relevés enregistrés. Identité et demande GitHub seront revalidées avant lancement.</DialogDescription></DialogHeader>
      {data&&<ObservationReference data={data}/>}
      {networkError&&<p className="scheduling-alert">Actualisation indisponible. Les données affichées peuvent être anciennes.</p>}
      {!data?<p className="scheduling-empty">Chargement des décisions…</p>:!data.available?<p className="scheduling-empty">Base scheduling indisponible : {data.unavailableReason}.</p>:<>
        <section><h3>Candidats <span>{data.jobsTotal}{data.jobsTruncated?' · liste limitée':''}</span></h3><div className="scheduling-list">
          {data.jobs.length?data.jobs.map(job=><article key={job.id}><div><strong>#{job.issue} · {job.role}</strong><span>{job.status}</span></div>
            <p>{job.requested.profile??job.requested.model} <ArrowRight size={12}/> {job.preview?.assignment?.effectiveProfile??'reporté'}</p>
            <small>{label(job.preview?.reasonCode,reasons)}{job.deferredAgeSeconds!==null?` · attente ${job.deferredAgeSeconds}s`:''}</small></article>):<p className="scheduling-empty">Aucun candidat.</p>}
        </div></section>
        <section><h3>Dernières tentatives <span>{data.runsTotal}{data.runsTruncated?' · 20 affichées':''}</span></h3><div className="scheduling-list">
          {data.runs.length?data.runs.map(run=><article key={run.id}><div><strong>#{run.issue} · tentative {run.id}</strong><span>{run.status}</span></div>
            <p className="scheduling-run-profiles"><span>Demandé : {run.requestedModel} · {run.requestedEffort??'effort inconnu'}</span><ArrowRight size={12}/><span>Configuré : {run.effectiveModel} · {run.effectiveEffort??'effort inconnu'}</span></p><small><Clock3 size={11}/>{when(run.finishedAt??run.jobStartedAt)} · {run.admission?label(run.admission.mode,modes):'historique legacy'}</small>
          </article>):<p className="scheduling-empty">Aucune tentative.</p>}
        </div></section></>}
    </DialogContent></Dialog>;
}
