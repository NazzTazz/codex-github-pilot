import { ArrowUpRight, ChevronRight, ListChecks } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { decisions, type CaseDetail } from '../cases/demo-data';
export function DecisionsCard({onSelect,onShowAll}:{onSelect:(item:CaseDetail)=>void;onShowAll:()=>void}) {
  return <section className="card decisions"><div className="card-title"><span><ListChecks size={18}/>Décisions à prendre</span><span className="count amber">02</span></div><p className="card-sub">Démonstration · votre regard fait avancer les missions.</p>
    {decisions.map((d,i)=><button className="decision" key={d.id} onClick={()=>onSelect(d)}><span className="decision-meta">{d.id}<span>{i===0?'Depuis 21 min':'Depuis 4 min'}</span></span><h3>{d.title}</h3><span className="decision-tag">{d.tag}</span><ArrowUpRight className="decision-arrow" size={17}/></button>)}
    <Button variant="ghost" className="card-footer-link" onClick={onShowAll}>Voir les arbitrages <ChevronRight size={15}/></Button>
  </section>;
}
