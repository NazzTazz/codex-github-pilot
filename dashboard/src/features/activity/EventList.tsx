import { Check, ChevronRight, GitBranch, ListChecks, Radio } from 'lucide-react';
import { events, type CaseDetail } from '../cases/demo-data';
export function EventList({filter='Tous',onSelect}:{filter?:string;onSelect:(item:CaseDetail)=>void}) {
  return <div className="event-list">{events.filter(e=>filter==='Tous'||e.type===filter).map((e,i)=>{
    const Icon=e.type==='Revue'?Radio:e.type==='Décision'?GitBranch:e.type==='File'?ListChecks:Check;
    return <button className="event" key={e.title} onClick={()=>onSelect(e.case)}><span className="event-time">{e.time}</span><span className={'event-icon tone-'+i}><Icon size={17}/></span><span className="event-copy"><strong>{e.title}</strong><small>{e.detail}</small></span><span className="event-type">{e.type}</span><ChevronRight size={16}/></button>;
  })}</div>;
}
