# T5 — CLI, API et dashboard scheduling

12 septembre 2026. Implémentation : **Sol high**, sur tout le lot. Contre-recette : **Astra high en contexte neuf**. Base inspectée : `074a03d`, branche `feat/quota-aware-foundations`, T4 commitée/poussée, baseline **106 tests**.

## 1. Mission et priorité des contrats

Terminer la V1 quota-aware mono-worker en rendant ses décisions compréhensibles dans le CLI et le dashboard. T1, T2A/B, T2.5, T3 et T4 sont livrées : ne pas les réimplémenter.

Référence normative : `quota-aware-scheduling-spec.md`, sections 10.3–10.11, particulièrement 10.8/10.9 et l'amendement multi-compte 10.11. Lire aussi les entrées T4 et ses deux P1 dans `JOURNAL-SOL-IMPLEMENTATION.md`. Cette spec précise le dernier lot : identité hypothétique des projections sans réseau, schéma public filtré, compatibilité legacy et critères de recette. Elle ne change pas les règles d'admission T4.

Résultat attendu : l'utilisateur voit quel compte est la cible, ce que Pilot prévoirait pour chaque tâche, pourquoi une tâche attend, et ce qui a réellement été configuré lors des tentatives passées. Aucun affichage ne doit annoncer une autorisation de lancement ni une génération vérifiée à distance.

Hors périmètre : deuxième worker, sélection/relais de compte, reprise de session, automatisation d'escalade, nouveaux profils, nouvelle matrice économique, ACP/distribué, refonte visuelle générale, publication GitHub enrichie. Pas de nouvel endpoint d'écriture ni de bouton d'override HTTP. Les commandes d'override T4 existent déjà.

## 2. Architecture minimale et surfaces existantes

| Surface | Travail attendu |
| --- | --- |
| Nouveau `src/scheduling-view.mjs` | Lecture SQLite réellement read-only, projection commune CLI/HTTP et whitelist publique. Fonctions simples, horloge injectable. |
| `src/scheduler.mjs`, `src/codex-policy.mjs`, `src/quota-incidents.mjs` | Réutiliser l'évaluation et la récupération simulée. Extraction minimale de helpers purs autorisée si nécessaire, sans changer les décisions ni les chemins d'écriture. |
| `src/cli.mjs` | `schedule [ID]`, enrichissement status/metrics/doctor, séparation précoce des commandes read-only et des commandes sous verrou. Transmettre la config au serveur dashboard. |
| `src/dashboard.mjs` | `/api/scheduling`, ajout compatible d'observationId à `/api/quota`, protections HTTP existantes. |
| `dashboard/src/features/quota/` et nouveau `features/scheduling/` | Chargement, types DTO et rendu ; aucune policy en TypeScript. Intégration compacte à la vue d'ensemble. |
| README, tests, journal | Procédures, schémas/exemples, fixtures, preuve de recette et limites. |

Ne pas introduire de framework d'accès aux données, de nouvelle dépendance runtime ou de migration pour ce lot sans besoin démontré et arbitrage. Une petite façade de lecture peut fournir les méthodes requises par `schedulingDecision` ; toutes ses méthodes mutantes doivent être absentes. Ne pas appeler `scheduleNext`, `reconcileIncidents`, `recover`, `claim` ou `saveDecision` depuis une projection.

Le constructeur `Store` actuel exécute DDL/migrations : **ne pas l'utiliser pour lire depuis HTTP, schedule, status ou metrics**. Lire avec `DatabaseSync(...,{readOnly:true})`, transaction de lecture unique par projection (`BEGIN`/`COMMIT`, pas `BEGIN IMMEDIATE`), fermeture en finally. Pas de création de répertoire, fichier, base, verrou worker ou méta `firstStarted` sur ces chemins. Les fichiers techniques SQLite de coordination ne sont pas des mutations métier ; vérifier avant tout schéma, lignes et contenu logique, pas la seule mtime.

## 3. Identité et nature de la prévision

`schedule`, `status`, `metrics` et `/api/scheduling` n'appellent ni GitHub ni Codex, pas même login status. Ils ne peuvent donc pas établir l'identité **actuelle** de l'executor.

Pour une prévision utile, prendre exclusivement le dernier relevé de la source configurée et son compte pseudonyme comme hypothèse d'identité. Il est permis de construire la capacité de projection avec `expectedAccountKey=row.account_key`, **uniquement sur cette voie de lecture** et après vérification source/scope/fraîcheur. Cela signifie « si le compte d'exécution correspond encore au relevé ». Une identité observée manquante ne doit pas être inventée. Ne pas prendre un ancien succès pour masquer le dernier échec.

Exposer systématiquement `projectionKind:"preview"`, `identityVerification:"not-performed"` et `requiresLiveValidation:true`. Afficher : « Prévision sur les relevés enregistrés. Identité et demande GitHub seront revalidées avant lancement. » Une projection saine peut donc avoir un assignment prévisionnel sans constituer une admission. Ne jamais passer cette identité hypothétique au chemin d'exécution ni affaiblir les contrôles T4.

Les incidents sont lus par identité canonique (y compris autre nom de source du même compte), et leur récupération possible est simulée avec les preuves disponibles, sans effacer de ligne. Une preuve true actuelle interdit la prévision exécutable même sans incident encore persisté. Le true précédemment mémorisé pendant une panne de sonde reste bloquant après null. Les fixtures P1 T4 doivent rester vertes.

Le `doctor` est l'exception explicitement diagnostique : il peut vérifier auth et identité en lecture seule dans le bon environnement. Son résultat ne transforme pas les autres projections en autorisations persistées.

## 4. Contrat public versionné

Même DTO version 1 pour `schedule --json` et `GET /api/scheduling`, à horloge/config/base identiques. Les noms ci-dessous sont normatifs ; les champs publics supplémentaires doivent être explicitement documentés et testés, jamais propagés par spread d'un objet interne.

| Champs racine | Sens |
| --- | --- |
| `version:1`, `available`, `enabled`, `serverTime` | available décrit la lisibilité du schéma, enabled la configuration. Ils sont indépendants. |
| `unavailableReason` | null, `database-missing` ou `schema-unavailable`. Une corruption/panne de lecture est une erreur, pas une file vide. |
| `projectionKind`, `identityVerification`, `requiresLiveValidation` | Valeurs définies en section 3. |
| `targetId`, `provider`, `observationSourceId`, `capacityScopeId` | Liaison de la cible ; jamais celle du compte par défaut en remplacement. |
| `policyVersion`, `policyHash` | Policy effective ; null quand désactivée. |
| `observationId`, `observedAt`, `quality` | Relevé de la source cible ; quality du normaliseur, pas celle des tokens. |
| `weeklyPhase`, `mode` | Valeurs métier de la policy ; null quand désactivée. Les motifs de blocage restent distincts de la phase hebdomadaire. |
| `recommendedCeiling`, `exceptions`, `blockingReasons` | Résumé explicatif backend défini ci-dessous. Pas une offre garantie. |
| `counts` | `candidateJobs`, `mechanicalReadyJobs`, `deferredJobs`, `deferredPremiumJobs`, entiers calculés avant toute limite. |
| `jobs`, `jobsTotal`, `jobsTruncated` | Au plus 100 candidats queued/deferred, ordre ID croissant ; total avant limite. |
| `runs`, `runsTotal`, `runsTruncated` | Au plus 20 dernières tentatives, ordre ID décroissant. |

`recommendedCeiling` est un **repère économique**, enum `requested`, `sol-medium`, `luna-medium`, `luna-reserve-medium` ou null. Premium → requested ; conserve → sol-medium ; survival → luna-medium avec exception explicite sol-plan/sol-medium ; reserve → luna-reserve-medium. Désactivé, inconnu, ou blocage technique global établi → null. Conserve doit également annoncer les exceptions routine→Terra, mécanique attestée→Luna, exploratory/Astra différés. Premium rappelle la mécanique attestée→Luna. Un override valide est une exception par job, pas un relèvement du repère global.

Lorsque available=false, conserver l'enveloppe : tableaux vides, counts et totaux null (non mesurés), indicateurs de troncature false, faits/relevé/mode null ou quality missing selon le champ. Zéro est réservé à une base lisible dont la requête retourne réellement zéro. Enabled reste la valeur de configuration. Lorsque la policy est désactivée, les prévisions suivent le routage historique et son verrou quotaPaused, sans appliquer les incidents/paliers T4 ; la cible est l'environnement hérité, jamais defaultAccountId présenté comme une identité vérifiée.

Ce résumé s'obtient dans la policy backend en partageant ses helpers, indépendamment de la présence d'un job. Ne pas créer de job synthétique, ni déduire un plafond du premier job ou des 100 jobs affichés. `exceptions` et `blockingReasons` sont des tableaux de codes documentés/traduits dans le rendu, pas du texte fournisseur. Distinguer blocage global (ex. pause legacy, quota invalide, catalogue absent, incident empêchant la route) et refus lié à une tâche ; les refus économiques de jobs ne rendent pas tout le compte techniquement bloqué. Ajouter des tests sans aucun job.

### Jobs

Whitelist : `id`, `issue`, `role`, `taskClass`, `status`, `requested` (profil/modèle/effort), `preview` (action, reasonCode, weeklyPhase, mode, assignment filtré ou null), `lastDecision` (id, date, kind, action, reasonCode), `deferredSince`, `deferredAgeSeconds`.

Assignment public : targetId, provider, adapter, observationSourceId, capacityScopeId, requestedProfile, effectiveProfile, requestedModel, requestedEffort, model, effort, sandbox, timeoutMs, quotaPool, policyVersion, policyHash, mode, reason, observationId, decisionId, overrideId. Dans une **prévision**, decisionId vaut null ; ne pas le remplacer par l'ID de la dernière décision persistée. Un override public peut ajouter uniquement son état, ID et expiration, pas son auteur ni sa raison libre.

L'âge persisted deferred est basé sur deferred_since ; null si absent. Ne pas inventer un début d'attente pour un queued que la prévision différerait. Afficher séparément statut persisté et action prévue.

### Compteurs

- `candidateJobs` = nombre de queued/deferred ; égal à jobsTotal.
- `mechanicalReadyJobs` = implementation, classe mechanical et contrat réellement validé par le code existant, même si le quota empêche le départ. Ce compteur mesure la préparation, pas la disponibilité de Luna.
- `deferredJobs` = prévisions action defer, indépendamment du statut persisté.
- `deferredPremiumJobs` = sous-ensemble précédent, refus **économique** `premium-work-deferred` de tâches nécessitant Sol/Astra selon les exigences de la policy. Exclure erreurs techniques, quota/incident, unclassified, routine simplement demandée sur Sol et profils insuffisants. Réutiliser/extraire la logique de plancher dans la policy, sans recopier les rangs dans le DTO ou React.

### Tentatives réelles et historique

Whitelist : id, jobId, issue, role, status technique, dates/durées, requestedModel, requestedEffort, effectiveModel, effectiveEffort, observedModel, targetId, provider, adapter, capacityScopeId, quotaPool, admission (décision persistée filtrée ou null), compteurs numériques de tokens, preuve avant spawn filtrée (date, ID relevé, âge).

Les décisions d'admission viennent de scheduling_decision_id, **jamais** d'un recalcul avec le quota actuel ou la dernière décision du job. Un worker lancé en premium reste affiché comme tel après passage en survival. Plusieurs tentatives d'un job restent distinctes. Modèle effectif signifie configuré ; observedModel reste null sans événement probant.

Anciennes lignes : effectiveModel = model_effective ?? model_requested ; requestedEffort = effort_requested ?? reasoning_effort ; effectiveEffort = reasoning_effort. Pas de décision, source ou compte réattribué à l'historique ; indiquer legacy lorsque nécessaire.

### Confidentialité et erreurs

Ne jamais sérialiser directement `decision_json`, `capacity`, un row Store ou un `assignment` interne. Ils contiennent notamment accountKey. Interdits dans HTTP et dans le nouveau DTO schedule : identité/hash de compte, email, payload commentaire, request/prompt, contrat détaillé, entrée figée, chemin local/home, credential, brut fournisseur, journaux, erreurs libres et raison/auteur d'override. Utiliser des champs autorisés récursivement. Ne pas masquer les valeurs interdites avec une simple liste noire.

Une JSON persistée illisible ou un schéma incompatible doit produire une indisponibilité explicite, jamais un faux succès/compteur zéro présenté comme réel. Réponse HTTP 503 avec code fermé sans message SQL ou chemin. CLI : erreur propre et exit non nul pour panne réelle.

## 5. CLI

| Commande | Contrat |
| --- | --- |
| `schedule [--json]` | DTO global ; en texte, cible/source, fraîcheur, mode/repère, compteurs et table bornée. Avertissement de prévision obligatoire. |
| `schedule ID [--json]` | ID entier positif strict ; chercher indépendamment de la limite 100. Enveloppe versionnée `{version,serverTime,available,enabled,projectionKind,identityVerification,requiresLiveValidation,job,runs}` avec même DTO job. Un job terminal/running n'est pas réévalué : preview null, audit et tentatives conservés (20 dernières de ce job). ID inexistant : erreur/exit non nul. |
| `schedule override ID --reason ...`, `schedule clear-override ID` | Garder exactement la voie mutante T4 sous verrou. Ne pas la faire transiter par le lecteur read-only. |
| `status [--json]` | Garder la lecture des statuts existants ; ajouter résumé scheduling et reports. Nouveau JSON versionné documenté, pas d'objets internes. |
| `metrics [--json]` | Texte : demandé/configuré, efforts, provider/cible/décision en plus des tokens/durées. Garder le format tableau et les colonnes historiques du JSON local existant ; ajouts uniquement. Ce dump local historique n'est pas le DTO HTTP et ne doit pas y être réutilisé. |
| `doctor [--json]` | Auth, identité réelle et comparaison avec relevé/catalogue enregistré, mode diagnostic sans génération ni écriture de base. Activé : home source explicite ; désactivé : environnement historique. Conserver diagnostic GitHub read existant, publication off/on. Sortie JSON filtrée, sans identité, credential ou chemin. |

Parser les arguments avant tout effet de bord : `--config`/`--json` ne sont pas des IDs ; rejeter ID manquant, zéro, négatif, décimal ou surplus ambigu. En mode JSON : un seul document JSON sur stdout ; diagnostics sur stderr. Les projections restent utilisables pendant que le verrou worker est détenu.

Sans base/schéma scheduling : schedule/status déclarent available=false sans créer de base ; status/metrics peuvent continuer à lire les colonnes historiques disponibles. Schema absent ≠ policy disabled. Pas de migration implicite à la consultation. Doctor ne collecte/persiste pas d'observation et ne démarre pas de watch ; réutiliser les sondes read-only existantes et le catalogue enregistré, annoncer son âge.

## 6. API et cohérence de lecture

- `GET /api/scheduling` : DTO global section 4. `HEAD` : même statut, corps vide. Pas de paramètres de mutation ; pas d'API job détail obligatoire dans ce lot.
- Config normalisée transmise depuis CLI à `createDashboardServer` ; ne pas relire config.local ni env à chaque requête. Paramètres par défaut préservant les tests/appels historiques (policy disabled).
- `/api/accounts/quota` conserve sa forme. `/api/quota` conserve tous ses champs/valeurs et reçoit **uniquement l'ajout autorisé `observationId`** à la racine, celui du compte defaultAccountId. Actualiser aussi le helper `readQuota` et les tests exacts concernés. Cette précision résout « observationId ajouté » versus « contrat legacy inchangé » de la spec générale : extension additive explicite, pas rupture.
- La projection scheduling lit config cible, jobs, incidents, overrides, observations et runs dans **un même snapshot SQLite**. Des appels quota/scheduling distincts peuvent légitimement voir deux IDs différents : afficher les dates respectives, ne pas assembler un quota plus récent avec une décision plus ancienne comme s'ils étaient simultanés.
- Serveur toujours localhost, Host/Origin/Sec-Fetch-Site vérifiés, GET/HEAD seulement, CSP/no-store et whitelist assets inchangés. POST override, traversée de chemins et origine externe restent refusés. Aucun secret dans une 503.

## 7. Interface attendue

Conserver `overview-grid`, la carte Quotas à sa place et la présentation compacte de T2.5. Les jauges observées de chaque compte restent visibles ; aucun retour à une carte pleine largeur sous la ligne de flottaison, aucun bloc de pourcentages dupliquant les jauges. « Voir les détails » reste replié par défaut et accessible au clavier.

Sur **la seule carte dont account.id === observationSourceId**, ajouter un petit bloc « Cible d'exécution · Prévision » : mode, repère économique, éventuel blocage, nombre de reports. Pas de mode global sur les autres comptes. Le résumé coloré des quotas reste celui de l'observation, indépendant de l'autorisation scheduling ; conserver ses libellés accessibles. En mode disabled, ne pas prétendre que defaultAccountId est le compte d'exécution hérité.

Un contrôle secondaire « Voir les décisions » ouvre un panneau/dialogue accessible, fermé par défaut, contenant les candidats (demandé → prévu, motif et âge) et les 20 dernières tentatives (demandé → configuré, admission historique). Utiliser les composants déjà présents. Ne pas remplacer les cartes de démonstration Missions/Décisions/Activité ni les mélanger avec des données réelles sans libellé. Préférer ce panneau à une nouvelle navigation générale.

Gestion des états obligatoire : chargement initial, disabled, base absente/ancienne, unknown, stale, blocked, reserve active, réserve seulement observée/non activée, erreur réseau scheduling, erreur réseau quota. Une panne scheduling ne fait pas disparaître les jauges ; une réponse conservée après erreur est marquée ancienne/indisponible, jamais saine. Pas de faux zéro pour une donnée absente. Rafraîchissement borné, sans chevauchement, nettoyage/unmount/AbortController ; réponse ancienne tardive ne remplace pas une réponse récente.

Labels français, dates lisibles avec fuseau, données longues sans déborder. À largeur desktop 1440×900 et mobile 390 px : pas de scroll horizontal de page, maintien de la carte dans la grille existante, dialogue consultable et fermeture clavier. Pas de condition `quota < 15` ou de classement de modèles dans React : seules la traduction, la mise en forme et la présentation des faits déjà projetés lui appartiennent.

## 8. Recette obligatoire et preuves

Tests Node, SQLite temporaires, faux transport GitHub/app-server, horloge injectable. Les tests existants T4/P1/mutations doivent rester exécutés et verts. Aucune consommation personnelle, aucun login/logout ou appel modèle réel.

| Groupe | Scénarios discriminants |
| --- | --- |
| Lecture seule | Base absente non créée ; ancienne base inchangée ; hash/schema/lignes métier identiques après plusieurs lectures schedule/status/metrics/HTTP/doctor simulé ; aucun appel mutateur, worker lock, GitHub/Codex pour les projections. |
| Hypothèse d'identité | Prévision saine avec disclaimer sans sonde ; identité observée absente → refus ; aucun changement des garde-fous live T4 ; source Lite ≠ default Plus, panne de Plus sans effet sur Lite. |
| Incidents/overrides | true → null maintenu ; levée possible simulée sans clear ; override affiché mais non consommé ; expiration/révocation visibles ; compte partagé ne contourne pas l'incident. |
| Compteurs | >100 candidats mélangés, dont éligibles uniquement après le 100e ; compteurs globaux exacts, ordre/truncated corrects ; >20 runs ; schedule ID au-delà de la limite ; mechanical malformé/unclassified non comptés à tort. |
| Historique | Run admis premium puis quota survival : admission inchangée ; plusieurs runs par job ; lignes legacy sans champs nouveaux ; modèle observé absent reste null. |
| Confidentialité | Injecter des canaris distincts dans accountKey, chemins, prompts, raw, erreur libre et raison/acteur d'override, y compris imbriqués dans decision_json ; aucun canari dans HTTP ni nouveau JSON schedule/status/doctor. Tester les corps d'erreur aussi. |
| Résumé backend | Matrice premium/conserve/survival/reserve, offre/catalogue restreints, pause/incident et aucun job ; exceptions sol-plan explicites ; aucun plafond assimilé à une garantie. |
| CLI | Vrais sous-processus sur config/base fixtures, options avant/après ID, JSON parsable seul, IDs invalides/inexistants, lecture possible sous verrou worker ; override conserve son verrou et ses règles. |
| HTTP | Snapshot cohérent, GET/HEAD, ancienne base available=false, 503 filtrée, POST et origine/Host externes rejetés, endpoints quota compatibles sauf ajout observationId documenté. |
| UI | Fixtures conserve/survival/reserve/unknown, disabled et pannes séparées ; badge sur seule carte cible, détails repliés, tableaux tronqués annoncés, desktop/mobile/clavier. |

Au moins trois mutations **en copie isolée** : calculer les compteurs après LIMIT 100 ; utiliser defaultAccountId pour scheduling ; retourner une décision/assignment interne sans whitelist. Les tests ciblés doivent échouer pour la bonne raison puis passer avec le code restauré. Ne pas compter un import cassé ou une erreur de syntaxe comme preuve. Les assertions textuelles sur le source ne remplacent pas l'exécution du comportement.

Commandes de validation : `npm test`, `npm run dashboard:build`, `node --check` des fichiers JS touchés, `git diff --check`. Recette visuelle avec fixtures sur serveur/port temporaire distinct, en utilisant le skill navigateur disponible ; ne pas arrêter/reconfigurer le dashboard ou l'observateur personnels. Conserver les captures utiles et leur emplacement dans le journal, puis nettoyer les processus et données temporaires.

## 9. Ordre de travail et livraison

1. Vérifier branche/worktree, lire les contrats et relancer baseline. Écrire les fixtures et tests du lecteur/DTO.
2. Implémenter projection read-only, whitelist, résumé partagé et CLI/API. Vérifier absence d'effets de bord avant l'UI.
3. Brancher le panneau et le badge sur la bonne carte, préserver la grille et les détails.
4. Exécuter tests, mutations, build et recette visuelle. Documenter schéma, commandes, limites et journal.
5. Livrer la liste des fichiers, les preuves exécutées et limites restantes ; **s'arrêter sans commit/push** pour la contre-recette Astra high.

Sol high doit demander une escalade si un invariant reste ambigu après lecture des contrats, si une correction répétée échoue encore sur le même invariant, ou s'il ne peut produire un test discriminant. Fournir alors scénario minimal, preuve et arbitrage demandé ; ne pas augmenter seul le périmètre ou déclarer la réussite à partir du seul nombre de tests.

Contre-recette Astra high : contexte neuf, cette spec et la spec générale comme contrats, diff réel et preuves de Sol comme pièces à vérifier, pas comme conclusions. Refaire en priorité absence d'écriture, identité hypothétique versus auth réelle, whitelist récursive, calcul avant troncature, admission historique et placement UI. Aucun commit avant traitement des constats puis validation ciblée des corrections.
