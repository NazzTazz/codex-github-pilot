import { useEffect, useState } from 'react';
import { ChevronRight, Clock3, GitBranch } from 'lucide-react';
import { Sidebar, type Page } from './components/Sidebar';
import { OverviewPage } from './features/overview/OverviewPage';
import { ActivityPage } from './features/activity/ActivityPage';
import { CasesPage, EscaladesPage } from './features/cases/CasesPage';
import { CaseDialog } from './features/cases/CaseDialog';
import type { CaseDetail } from './features/cases/demo-data';

const paths:Record<Page,string>={'Vue d’ensemble':'overview','Activité':'activity','Historique':'history','Escalades':'escalades','Parcours':'parcours'};
const currentPage=():Page=>(Object.entries(paths).find(([,value])=>value===window.location.hash.slice(1))?.[0] as Page)??'Vue d’ensemble';
const descriptions:Record<Page,string>={
  'Vue d’ensemble':'Les bonnes informations, au bon moment.',
  'Activité':'Suivez le travail des agents et les événements de la file.',
  'Historique':'Retrouvez les exécutions et leurs résultats.',
  'Escalades':'Comprenez ce qui nécessite un arbitrage.',
  'Parcours':'Du besoin initial à la validation, gardez le fil.'
};
export default function App() {
  const [page,setPage]=useState<Page>(currentPage);
  const [detail,setDetail]=useState<CaseDetail|null>(null);
  useEffect(()=>{const change=()=>setPage(currentPage());window.addEventListener('hashchange',change);return()=>window.removeEventListener('hashchange',change);},[]);
  useEffect(()=>{document.title=`Pilot — ${page}`;},[page]);
  const navigate=(next:Page)=>{window.location.hash=paths[next];setPage(next);};
  return <div className="shell"><Sidebar page={page} onNavigate={navigate}/><div className="main-wrap">
    <header className="topbar"><div>Espace local <ChevronRight size={14}/><strong>{page}</strong></div><span className="demo-badge">Quota réel · autres données de démonstration</span></header>
    <main><div className="page-heading"><div><p className="eyebrow">VOTRE POSTE DE PILOTAGE</p><h1>{page}</h1><p>{descriptions[page]}</p></div><div className="date"><Clock3 size={15}/>{new Intl.DateTimeFormat('fr-FR',{day:'numeric',month:'long',year:'numeric'}).format(new Date())}<small>Dashboard sur cet ordinateur</small></div></div>
      {page==='Vue d’ensemble'?<OverviewPage onSelect={setDetail} onNavigate={navigate}/>:page==='Activité'?<ActivityPage onSelect={setDetail}/>:page==='Escalades'?<EscaladesPage onSelect={setDetail}/>:<CasesPage history={page==='Historique'} onSelect={setDetail}/>}
      <footer className="page-footer"><span><GitBranch size={13}/>GitHub Pilot</span><span>Données du compte consultées localement</span></footer>
    </main></div><CaseDialog item={detail} onClose={()=>setDetail(null)} onParcours={()=>navigate('Parcours')}/></div>;
}
