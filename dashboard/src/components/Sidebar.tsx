import { Activity, GitBranch, History, LayoutDashboard, Route } from 'lucide-react';
import { Button } from './ui/button';
export const navigation = [
  {name:'Vue d’ensemble',icon:LayoutDashboard}, {name:'Activité',icon:Activity},
  {name:'Historique',icon:History}, {name:'Escalades',icon:GitBranch}, {name:'Parcours',icon:Route}
] as const;
export type Page = typeof navigation[number]['name'];
export function Sidebar({page,onNavigate}:{page:Page;onNavigate:(page:Page)=>void}) {
  return <aside className="sidebar">
    <a className="brand" href="#overview" onClick={e=>{e.preventDefault();onNavigate('Vue d’ensemble');}}><span className="brand-icon"><Route size={24}/></span><span>Pilot<span className="brand-sub">CODEX × GITHUB</span></span></a>
    <div className="workspace"><span className="repo-icon"><GitBranch size={17}/></span><span>GitHub Pilot<small>Espace local</small></span></div>
    <nav aria-label="Navigation principale">{navigation.map((item,i)=><div key={item.name}>
      {i===3&&<p className="nav-label">MÉTIER</p>}
      <Button variant="ghost" className={'nav-item '+(page===item.name?'selected':'')} onClick={()=>onNavigate(item.name)} aria-current={page===item.name?'page':undefined}><item.icon size={18}/>{item.name}</Button>
    </div>)}</nav>
    <div className="sidebar-bottom"><div className="pilot-status">Dashboard local<small>Quota connecté · autres vues démo</small></div><div className="profile"><span className="avatar">P</span><span>Mon espace<small>Pilot · v0.2</small></span></div></div>
  </aside>;
}
