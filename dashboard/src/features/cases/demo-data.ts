export type CaseDetail = { id: string; title: string; desc: string };
export const missions = [
  {id:'CAS-041', title:'Fiabiliser la reprise après interruption',model:'Sol · medium',state:'Terminée',time:'12 min 34 s',desc:'La revue technique est terminée. Les scénarios de reprise ont été vérifiés sur la version examinée.',tokens:'28 420'},
  {id:'CAS-042', title:'Vérifier la provenance des résultats',model:'Sol · high',state:'En cours',time:'08 min 42 s',desc:'Contre-recette en cours : vérification du lien entre la spécification, le commit examiné et les preuves de validation.',tokens:'18 650'},
  {id:'CAS-043', title:'Consolider les métriques par tentative',model:'Sol · medium',state:'En attente',time:'Dans la file',desc:'L’implémentation commencera après la mission actuelle. Objectif : conserver les consommations de chaque tentative.',tokens:'—'}
];
export const decisions = [
  {title:'Lever une ambiguïté de spécification',id:'CAS-038',tag:'Arbitrage métier',desc:'Faut-il rouvrir un cas validé lorsqu’un nouveau commit modifie uniquement la documentation ? Une décision produit est attendue avant la correction.'},
  {title:'Examiner une réserve de contre-recette',id:'CAS-040',tag:'Escalade Sol → Astra',desc:'La contre-recette signale des preuves insuffisantes sur les compteurs en cache. L’examen doit déterminer si une correction ou une nouvelle preuve est nécessaire.'}
];
export const events = [
  {time:'10:42',type:'Revue',title:'Contre-recette démarrée',detail:'Vérifier la provenance des résultats',case:missions[1]},
  {time:'10:38',type:'Décision',title:'Une réserve nécessite un arbitrage',detail:'Compteurs de tokens en cache · CAS-040',case:decisions[1]},
  {time:'10:34',type:'Résultat',title:'Revue technique terminée',detail:'Fiabiliser la reprise après interruption',case:missions[0]},
  {time:'10:29',type:'File',title:'Une nouvelle mission rejoint la file',detail:'Consolider les métriques par tentative',case:missions[2]},
  {time:'10:21',type:'Décision',title:'Clarification de spécification demandée',detail:'Réouverture des cas · CAS-038',case:decisions[0]}
];
