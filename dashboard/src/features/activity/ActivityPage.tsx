import { useState } from 'react';
import { ArrowUpRight, Radio } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { missions, type CaseDetail } from '../cases/demo-data';
import { EventList } from './EventList';
export function ActivityPage({onSelect}:{onSelect:(item:CaseDetail)=>void}) {
  const [filter,setFilter]=useState('Tous');
  return <><div className="activity-banner"><Radio/><div><span className="eyebrow">MISSION SIMULÉE · SOL HIGH</span><h2>{missions[1].title}</h2><p>Contre-recette · 08 min 42 s écoulées</p></div><Button variant="outline" onClick={()=>onSelect(missions[1])}>Voir le parcours <ArrowUpRight size={16}/></Button></div>
    <section className="card recent"><div className="section-title"><h2>Fil d’activité · démo</h2><div className="filters">{['Tous','Revue','Décision','Résultat','File'].map(f=><Button variant={f===filter?'default':'ghost'} key={f} onClick={()=>setFilter(f)}>{f}</Button>)}</div></div><EventList filter={filter} onSelect={onSelect}/></section></>;
}
