import { ArrowUpRight, Check, Clock3, Radio, Route } from 'lucide-react';
import { missions, type CaseDetail } from '../cases/demo-data';
export function MissionsCard({onSelect}:{onSelect:(item:CaseDetail)=>void}) {
  return <section className="card missions"><div className="card-title"><span><Route size={18}/>Missions</span><span className="soft-badge">Démonstration</span></div><p className="card-sub">Le relais entre vos agents.</p>
    {missions.map((m,i)=><button key={m.id} className={'mission mission-'+i} onClick={()=>onSelect(m)}><span className="mission-marker">{i===0?<Check size={15}/>:i===1?<Radio size={16}/>:<Clock3 size={15}/>}</span><span className="mission-content"><span className="mission-label">{['PRÉCÉDENTE','ACTUELLE','SUIVANTE'][i]}<span>{m.id}</span></span><h3>{m.title}</h3><span className="mission-bottom"><span>{m.model}</span><span>{i===0?'Terminée · ':''}{m.time}</span></span>{i===1&&<span className="running-label"><span className="live-dot"/>Contre-recette en cours<ArrowUpRight size={15}/></span>}</span></button>)}
  </section>;
}
