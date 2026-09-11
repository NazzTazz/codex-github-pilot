import { ArrowUpRight, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { decisions, missions, type CaseDetail } from './demo-data';
export function EscaladesPage({onSelect}:{onSelect:(item:CaseDetail)=>void}) {
  return <div className="detail-grid">{decisions.map(d=><section className="card business-card" key={d.id}><span className="decision-tag">Décision attendue · démo</span><p className="eyebrow">{d.id} · {d.tag}</p><h2>{d.title}</h2><p>{d.desc}</p><Button variant="outline" onClick={()=>onSelect(d)}>Examiner le contexte <ArrowUpRight size={16}/></Button></section>)}</div>;
}
export function CasesPage({history=false,onSelect}:{history?:boolean;onSelect:(item:CaseDetail)=>void}) {
  return <section className="card recent"><div className="section-title"><div><h2>{history?'Exécutions récentes':'Parcours des cas'}</h2><p>{history?'Une ligne par tentative, y compris celles en attente.':'Une demande métier, toutes ses étapes.'}</p></div><span className="soft-badge">Démonstration</span></div>
    {missions.map(m=><button className="case-row" key={m.id} onClick={()=>onSelect(m)}><span className="case-id">{m.id}</span><span><strong>{m.title}</strong><small>{m.model} · {history?m.tokens+' tokens simulés':'Spécification → Implémentation → Revue'}</small></span><span className="soft-badge">{m.state}</span><ChevronRight size={17}/></button>)}
  </section>;
}
