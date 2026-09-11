import { ArrowUpRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DecisionsCard } from './DecisionsCard';
import { MissionsCard } from './MissionsCard';
import { QuotaCard } from '../quota/QuotaCard';
import { EventList } from '../activity/EventList';
import type { CaseDetail } from '../cases/demo-data';
import type { Page } from '@/components/Sidebar';
export function OverviewPage({onSelect,onNavigate}:{onSelect:(item:CaseDetail)=>void;onNavigate:(page:Page)=>void}) {
  return <><div className="overview-grid"><DecisionsCard onSelect={onSelect} onShowAll={()=>onNavigate('Escalades')}/><MissionsCard onSelect={onSelect}/><QuotaCard/></div><section className="card recent"><div className="section-title"><div><h2>Derniers événements</h2><p>Démonstration · les étapes qui rythment votre travail.</p></div><Button variant="ghost" onClick={()=>onNavigate('Activité')}>Toute l’activité <ArrowUpRight size={16}/></Button></div><EventList onSelect={onSelect}/></section></>;
}
