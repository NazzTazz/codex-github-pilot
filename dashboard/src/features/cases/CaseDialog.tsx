import { ArrowUpRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import type { CaseDetail } from './demo-data';
export function CaseDialog({item,onClose,onParcours}:{item:CaseDetail|null;onClose:()=>void;onParcours:()=>void}) {
  return <Dialog open={item!==null} onOpenChange={open=>{if(!open)onClose();}}><DialogContent className="detail-dialog"><span className="eyebrow">{item?.id} · CAS DE DÉMONSTRATION</span><DialogTitle className="dialog-title">{item?.title}</DialogTitle><DialogDescription className="dialog-description">{item?.desc}</DialogDescription><p className="muted">Ces exemples seront remplacés lorsque les données de cette vue auront été définies.</p><Button onClick={()=>{onClose();onParcours();}}>Ouvrir les parcours <ArrowUpRight size={16}/></Button></DialogContent></Dialog>;
}
