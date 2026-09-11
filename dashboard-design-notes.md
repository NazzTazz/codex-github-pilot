# Dashboard — cas, parcours et escalades

Note de reprise du 10 septembre 2026. Conception uniquement, non implémentée.

## Intention

Observer le parcours complet d'un cas jusqu'à sa validation : consommation par
modèle, temps de travail et d'attente, corrections et escalades. Comparer ensuite
les stratégies de routage sur des familles de tâches comparables.

## Existant

Le pilote conserve en SQLite les jobs et la télémétrie de chaque tentative dans
`worker_runs` : modèle demandé, effort, session, PID, dates, durées, compteurs de
tokens fournis par Codex, usage brut, erreurs et statut. Les journaux restent sur
disque. `node src/cli.mjs metrics --json` expose ces données.

Il n'existe encore ni dashboard, ni modèle de cas/escalade, ni enchaînement
automatique du cycle. Les implémentations restent dans des copies Git locales.

## Entités à ajouter

- **Cas** : dépôt, issue de référence, famille de tâche, spec versionnée,
  critères de clôture et décision finale. Un cas peut traverser plusieurs PR.
- **Étape** : spécification, implémentation, contre-recette, correction ou
  examen Astra ; liens vers cas, étape précédente, jobs et commits examinés.
- **Escalade** : question précise, origine, auteur de la demande, étape
  déclenchante, preuves et résolution. Trois appels Astra pour la même réserve
  constituent une escalade et trois exécutions.
- **Événement de parcours** : transition horodatée, auteur humain/agent/pilote,
  références GitHub et motif. Conserver l'historique plutôt qu'écraser le verdict.

Origines d'escalade à distinguer : prévue dans la spec, demandée volontairement
par le PO, ou provoquée par la contre-recette Sol. Séparer l'origine du motif :
ambiguïté de spec, défaut suspecté, preuves insuffisantes, provenance, arithmétique,
désaccord persistant, etc. Ne pas déduire une cause certaine du seul modèle choisi.

Résolutions possibles : défaut confirmé, réserve levée, correction nécessaire,
décision PO attendue. Une validation porte sur une version de spec et un SHA ;
un nouveau commit ne conserve pas implicitement le verdict précédent. Distinguer
validation technique et approbation produit/gameplay.

## Quatre vues utiles

1. **Vue des cas** : état, famille, âge, nombre de reprises, consommation et délai
   cumulés ; accès au thread GitHub et aux preuves.
2. **Parcours d'un cas** : chronologie des étapes, commits, verdicts et branches
   d'escalade ; courbes cumulées de tokens et durées jusqu'à validation.
3. **Escalades** : regroupement par origine et motif, résultat, consommation
   directe Astra et coût complet incluant correction puis nouvelle recette.
4. **Comparaison des stratégies** : Sol puis escalade éventuelle versus Astra
   directement, par famille de tâches ; fréquence d'escalade, consommation médiane
   et délai jusqu'à validation, avec taille des échantillons.

## Mesures et interprétation

Afficher séparément tokens par modèle, temps d'exécution, attente en file,
attente de quota et attente humaine. Ne pas confondre somme du temps des workers
et délai calendaire du cas, surtout si des étapes deviennent parallèles.

Les tokens en cache sont inclus dans l'entrée ; le raisonnement est inclus dans
la sortie. Éviter les doubles comptes et garder les champs inconnus à `null`.
Les tentatives échouées ou interrompues comptent dans la consommation observée.

L'abonnement ne fournit pas une facture API par cas. Un équivalent API éventuel
doit être une simulation distincte, avec tarifs datés et hypothèses explicites,
jamais une dépense réelle ni une mesure directe du quota restant.

Les cas escaladés sont souvent plus difficiles : comparer les stratégies sans
contrôler la famille, la difficulté et les critères de validation serait biaisé.
Afficher aussi les cas encore ouverts ; ne pas calculer le succès uniquement sur
les cas terminés. La matrice de routage restera descriptive avant d'être prescriptive.

## Première tranche proposée

Ajouter les identifiants de cas, étapes et escalades et leurs événements, puis
les relier à la télémétrie existante. Permettre une qualification explicite des
escalades sans dépendre d'une interprétation automatique des commentaires.
Ensuite seulement, construire une vue locale en lecture seule : liste des cas,
chronologie d'un cas et consommation par modèle. Le dashboard affiche les
décisions enregistrées ; il ne déclenche ni agent, ni validation, ni fusion.

À décider lors de la reprise : taxonomie minimale des familles et motifs,
autorité de clôture technique, traitement d'une réouverture et définition exacte
du périmètre d'un cas. Aucune migration historique ni nouvelle automatisation
n'est autorisée par cette note seule.
