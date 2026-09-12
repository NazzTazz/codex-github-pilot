# Garder Pilot ouvert à plusieurs capacités d'exécution

Note d'architecture pour Sol et les futurs mainteneurs — 11 septembre 2026.

**Statut : note prospective historique.** La [spécification quota-aware révisée après comparaison OpenHands/ACP](quota-aware-scheduling-spec.md) prévaut désormais pour l'implémentation immédiate, notamment ses sections 5 et 10. Elle simplifie les identités en une cible locale et un scope, renomme le contrat de tâche et avance l'extraction minimale de l'executor. Les prescriptions « maintenant » et la section 9 ci-dessous ne constituent plus un second contrat à appliquer en parallèle. Les considérations de sécurité et de trajectoire restent du contexte pour les étapes futures.

Base analysée : commit `8807986`, plus la [spécification quota-aware](quota-aware-scheduling-spec.md), encore non implémentée. Cette note précise les frontières à préserver ; elle ne demande pas de construire un hub distribué. Les recommandations « maintenant » concernent le prochain chantier quota-aware, pas une refonte préalable du dépôt.

## Décision

Construire aujourd'hui un scheduler qui sélectionne une **offre locale explicite**, puis un profil concret compatible. Il n'y a qu'un worker, un executor Codex et une offre ; ce sont des valeurs ordinaires du modèle, pas des hypothèses implicites dans les données.

Séparer les exigences du travail, l'offre volontaire, l'état de capacité et l'exécution choisie. Conserver les profils concrets : ils restent nécessaires pour lancer et expliquer une exécution. Ne pas inventer une échelle universelle dans laquelle Luna, Sol et un modèle d'un autre fournisseur seraient automatiquement comparables.

Le passage au distant devra surtout changer le transport, la possession du checkout et les règles de confiance. Il ne doit pas obliger à réinventer l'identité d'une tentative ou le sens d'un résultat.

## 1. Ce que le code actuel rend facile ou difficile

| Point observé | Risque futur | Réponse proportionnée |
| --- | --- | --- |
| `src/core.mjs` associe consigne, sandbox, modèle et effort dans `roles`. | Le rôle devient implicitement un fournisseur ou un modèle. | Distinguer rôle fonctionnel et préférence de profil, en conservant les anciennes commandes comme alias. |
| `executionFor(job)` retourne un objet concret et `codexArgs` le résout à nouveau. | Le choix du scheduler peut être perdu dans le runner. | Une seule décision persistée ; le runner reçoit le profil effectif sans refaire la sélection. Déjà prévu par la spec quota-aware. |
| `src/runner.mjs::runJob` vérifie GitHub, prépare Git, lance Codex, interprète les événements, écrit SQLite et peut publier. | Un executor distant aurait besoin du Store, des credentials GitHub du hub et de son filesystem. | Conserver une fonction d'orchestration locale, mais extraire progressivement l'exécution fournisseur et appeler la publication depuis l'orchestrateur. |
| `src/observation.mjs` lit le compte Codex local ; `quotaPaused` et la sélection du dernier relevé sont globaux. | Un incident d'un compte arrête tous les autres ; plusieurs offres pourraient compter deux fois le même quota. | Nommer la source et le périmètre de capacité ; rattacher les observations/incidents à ce périmètre. |
| `Store.claim()` impose un seul `running`, protégé également par un verrou local. | Ce mécanisme ne constitue pas un lease distribué. | Le garder pour le mono-worker. Ne pas le présenter comme un verrou intermachines. |
| Le dépôt est dans la config globale ; `comment_id` est unique ; `seen` ne contient qu'un ID. | L'identité d'un job dépend implicitement d'une installation et d'un dépôt. | Inclure le dépôt dans le descripteur de travail ; conserver les IDs SQLite locaux. La migration multi-dépôts attend son besoin réel. |
| SHA et contenu de l'issue sont résolus pendant `runJob`. | Deux tentatives éloignées peuvent examiner deux travaux différents. | Distinguer demande mutable à l'entrée et travail préparé figé à l'admission. |
| `jobs.directory` et les journaux désignent des chemins locaux. | Un consommateur distant ne peut pas lire le résultat. | Les chemins deviennent des détails d'hébergement, distincts des références d'artifacts. |
| `result.schema.json` est déjà JSON, mais `needs_astra` nomme un modèle et les validations sont des chaînes. | Une autre famille doit parler le vocabulaire Codex ; un texte peut être pris pour une preuve de validation. | Garder le schéma existant comme rapport legacy ; ajouter une enveloppe de provenance et distinguer déclarations et validations vérifiées. |
| `worker_runs` distingue déjà les tentatives mais n'identifie pas leur worker/provider. | Impossible d'attribuer ou de comparer correctement les contributions futures. | Ajouter ces identifiants aux nouvelles tentatives et décisions. |

Deux bonnes fondations existent : les protections de publication sont explicites et les tentatives interrompues ne sont pas rejouées automatiquement. Les conserver. Le problème n'est pas SQLite, PowerShell ou l'absence d'un bus de messages : c'est le mélange des responsabilités et des identités.

Un détail concret compte avant de transporter les résultats : `git diff --binary HEAD` n'inclut pas les nouveaux fichiers non suivis, bien qu'ils apparaissent dans `changes.txt`. Le checkout conservé permet aujourd'hui de les inspecter ; un patch isolé ne suffit donc pas encore à restituer tout le travail. Corriger l'export complet au chantier artifacts, sans modifier silencieusement l'index du worker.

## 2. Découpage retenu

Le découpage proposé est pertinent, avec deux compléments : la préparation du travail et la validation du résultat. Une offre n'est pas une source de quota, et un résultat n'est pas une décision d'acceptation.

```text
commande GitHub → demande de job → préparation du travail figé
                                      ↓
                  exigences + offres + états de capacité
                                      ↓
                                 scheduler
                                      ↓
                           décision / affectation
                                      ↓
                  admission locale du worker → executor
                                      ↓
                            résultat + artifacts
                                      ↓
                         validation / acceptation
                                      ↓
                                  publisher
```

Ces frontières n'impliquent pas autant de processus, classes ou tables. En phase 1, ce sont quelques objets JSON et fonctions dans le même processus.

| Élément | Responsabilité | Ce qu'il ne décide pas |
| --- | --- | --- |
| Préparation | Autorisation GitHub, copie des données de tâche, résolution de la révision | Choix implicite d'un fournisseur |
| Requirements | Ce qui rend une exécution acceptable pour ce travail | Quota disponible, chemin du checkout |
| Capacity source | Observation d'une ressource avec date, portée et qualité | Part que le propriétaire accepte de donner |
| Worker offer | Sous-ensemble volontaire des possibilités locales et restrictions du propriétaire | Droits d'accès accordés par le projet |
| Scheduler | Filtrage puis choix explicable parmi les offres admissibles | Augmentation des permissions, changement de mission |
| Worker admission | Dernier contrôle local de l'offre, de sa disponibilité et du consentement | Obligation d'accepter parce que le hub l'a demandé |
| Executor | Exécution du profil concret, collecte des sorties et artifacts | Choix alternatif de modèle, publication ou acceptation finale |
| Result / validation | Provenance, résultat déclaré, preuves, décision de validation séparée | Assimilation d'un verdict agent à une approbation humaine |
| Publisher | Publication autorisée et idempotente d'un résultat admissible | Pouvoir de relancer l'agent ou d'élever ses permissions |

Il n'est pas nécessaire de créer un service `worker admission` local aujourd'hui : une validation de la décision au début de l'exécution suffit. Il faut en préserver le sens, car demain le worker pourra refuser indépendamment du hub.

## 3. Changements à faire dans le chantier quota-aware

### A. Donner une identité aux ressources

Créer une identité d'installation persistante, sans information de compte, et utiliser des IDs stables par configuration : `workerId`, `executorId`, `offerId`, `capacityScopeId`. Exemple local : une installation UUID, executor `codex-local`, offre `local-default`, scope `codex-account-local`. Ne pas utiliser l'email, le nom Windows ou un hash de credential comme identité publique.

En phase 1, une seule offre est construite en mémoire depuis la configuration et le registre existants. Pas de table de workers ni d'inscription réseau. Ajouter aux nouvelles décisions et aux `worker_runs` : worker, executor, offer, provider (`openai` ici), modèle demandé/effectif, et version de l'offre. Les anciennes lignes restent identifiées `legacy-local` ou inconnues ; ne pas leur attribuer rétroactivement un contributeur.

Ajouter `capacity_scope_id` aux observations et incidents du chantier quota-aware, et filtrer les lectures par ce scope, même s'il n'y en a qu'un. La liaison scope → compte pseudonyme reste locale et contrôlée. Un changement de compte invalide les observations comme prévu dans la spec précédente.

Un worker peut demain avoir plusieurs executors ; plusieurs offres peuvent partager le même compte et donc le même scope de quota. L'incident et la consommation suivent ce scope, pas seulement `offerId`. La concurrence et le budget d'une offre ajoutent des contraintes ; ils ne créent pas une nouvelle capacité physique. Une installation constante `local-default` ne doit jamais devenir un ID global partagé par plusieurs contributeurs.

### B. Séparer rôle, exigences et profil sans casser les commandes

Les rôles internes sont `implementation`, `review`, `specification` et, si utile aux consignes, `focused-review`. Les commandes historiques restent exactement acceptées :

| Commande actuelle / prévue | Interprétation interne |
| --- | --- |
| `sol-implement` | Rôle implementation, profil préféré Sol |
| `sol-review` | Rôle review, profil préféré Sol |
| `astra-review` | Review ciblée, demande explicite Astra conservée |
| `sol-plan` | Rôle specification, profil préféré Sol |

Ne pas renommer les lignes historiques ni publier un nouveau protocole de commandes maintenant. Conserver `requestedRole` et `requestedProfile` pour l'audit, et dériver `functionalRole` pour les règles. `astra-review` ne devient pas une autorisation implicite d'envoyer la demande à un fournisseur inconnu.

Un petit objet `requirements` dérivé du job regroupe classe, rôle fonctionnel, contrat Luna-ready éventuel et contraintes de résultat/permissions. Il ne remplace pas l'execution profile :

**requirements + restrictions de l'offre + état de capacité + policy → execution profile concret.**

Une exigence de permission distingue « doit pouvoir produire une modification suivie » et « peut écrire des fichiers temporaires ». La review actuelle utilise `workspace-write` et autorise des tests temporaires : un booléen `write=false` serait inexact. Garder les invariants `mayChangeTrackedFiles`, contexte isolé, pas de push, pas de publication par le worker. L'adaptateur traduit ces propriétés en sandbox supporté ; si cette traduction est impossible, il refuse.

Les capacités ne sont pas des permissions. `review` comme aptitude annoncée ne confère ni accès au code ni droit d'approuver une intégration.

### C. Garder la politique OpenAI locale, pas universelle

La matrice Luna/Terra/Sol/Astra de la spec reste appropriée pour la première offre. La placer dans une politique nommée `codex-local-v1`, dont l'entrée est le quota de son scope et dont la sortie est une liste de candidats autorisés accompagnés de leurs motifs.

Le noyau de sélection traite des candidats concrets avec une compatibilité explicite. Il ne doit pas connaître `base_model_inference`, `ordinaryUsageAllowed`, les noms des modèles ou les seuils Codex. Ces connaissances appartiennent à la source/admission Codex et à sa politique locale. On peut conserver `src/quota-state.mjs` et `src/scheduler.mjs`, en isolant la table Codex dans `src/codex-policy.mjs` ; aucun système de plugins n'est nécessaire.

La source peut dire « inconnu », « temporairement indisponible » ou « admissible avec restrictions » ; elle n'a pas à fabriquer un pourcentage pour un fournisseur qui n'en publie pas. Le mode `conserve` devient une explication de l'offre Codex locale, pas le mode global de tous les futurs providers.

Conserver une liste explicite de profils compatibles par classe/rôle dans cette politique. Des tags comme `economical` ou `frontier-review` pourront aider à sélectionner une liste administrée, mais ne prouvent aucune équivalence. Une capacité auto-déclarée par un worker communautaire ne doit pas s'ajouter seule à cette liste.

### D. Stabiliser l'entrée et la sortie, sans transport distant

À l'admission, produire un descripteur de travail JSON versionné : ID local qualifié par l'installation, dépôt, SHA résolu, rôle, classe, snapshot de spécification/demande, exigences et format de rapport attendu. Il ne contient pas de chemin absolu, de secret ou d'objet Store/GitHub. La demande GitHub peut rester mutable avant préparation ; le descripteur d'une tentative est figé avant toute génération.

La résolution du SHA peut rester dans la préparation du runner actuel. Ne pas ajouter un système de bundles pour cela. En revanche, un futur executor ne devra pas résoudre lui-même « la branche courante » et produire un autre SHA sous la même affectation. Une nouvelle révision de code ou de spécification implique un nouveau travail préparé. La vérification GitHub avant publication reste obligatoire.

Ajouter à la décision d'admission le profil concret et les identités. Le runtime garde séparément les chemins locaux nécessaires. Le rapport JSON actuel reste inchangé et peut être entouré d'une enveloppe résultat version 1 : ID de tentative, ID du travail, SHA, identité d'exécution, statut technique, rapport, références d'artifacts et mesures connues. Le résultat peut déclarer `pass` alors que la validation externe n'est pas encore faite.

Une référence d'artifact comprend type, nom relatif, taille et digest ; son emplacement physique est résolu localement. Phase 1 peut simplement référencer les fichiers déjà produits sans mécanisme d'upload, et signaler explicitement qu'un patch existant n'est pas un export complet. Le schéma ne doit pas promettre un artifact complet tant que les nouveaux fichiers ne sont pas inclus.

`needs_astra` reste lisible dans les anciens rapports. L'enveloppe peut le normaliser en demande d'escalade avec profil préféré Astra ; ce n'est pas une commande d'exécution. La refonte du schéma de findings et des preuves attend un besoin réel de revue croisée.

### E. Garder la publication hors de l'executor

Faire appeler `publishJob` par l'orchestrateur après exécution et validations, au lieu de laisser l'adaptateur fournisseur publier. Pas besoin de déplacer toute la classe GitHub aujourd'hui, mais aucun contrat d'executor ne doit recevoir une capacité de publication.

Préserver le comportement `publish=true`, les états `publishing/published`, le marqueur idempotent et la vérification du SHA. Séparer cette responsabilité ne modifie ni les destinataires ni les autorisations existantes.

## 4. Ce qui appartient à chaque objet

| Objet | Informations propres | À exclure |
| --- | --- | --- |
| Job / demande | Origine GitHub, dépôt, auteur autorisé, rôle/profil demandés, classe, spécification, contrat de sortie | Compte fournisseur, quota courant, endpoint worker |
| Travail préparé | Révision immuable, snapshot des entrées, exigences, schéma de résultat, références de provenance | Chemin de checkout partagé, credentials |
| Worker | Identité d'installation et, plus tard, propriétaire authentifié, état de connexion | Une classe universelle de modèle ou un droit implicite sur les dépôts |
| Executor | Adaptateur/version, commande locale, moyens d'isolation, liaison d'auth locale | Politique de priorité du projet, permissions de publication |
| Offer | ID/version, worker/executor, profils volontairement exposés, rôles/classes/dépôts acceptés, limites locales | Quota total supposé offert ; secrets de connexion |
| Capacity state | Scope de ressource, date/expiration, mesures connues, refus et disponibilité | Consentement du propriétaire ou garantie de succès |
| Policy | Compatibilités acceptées, critères d'admission, ordre des candidats, besoin de validation/diversité | Secrets ou chemins locaux ; valeurs de quota manuelles |
| Assignment / tentative | Travail, offre/version, profil exact, raisons, timestamps ; plus tard lease/génération | Mutation des exigences pour satisfaire un worker disponible |
| Result | Provenance, statut technique, rapport déclaré, artifacts, mesures | Approbation implicite ou capacité de publier |

Les futurs délais, priorités et contraintes de fournisseur appartiennent aux exigences du projet ou à une politique référencée par le travail. Les horaires nocturnes, budget personnel et retrait de capacité appartiennent à l'offre et sont appliqués localement. Ils ne sont pas des champs à ajouter tous en phase 1.

La confiance et l'accès aux données sont accordés par le projet envers une identité, jamais auto-déclarés dans l'offre. L'offre peut restreindre davantage ces droits, pas les étendre.

## 5. Sélection future de plusieurs offres

Préserver dès maintenant l'ordre logique suivant, avec une liste d'un seul élément en phase 1 :

1. Vérifier l'accès aux données et les politiques du projet avant de communiquer le contenu du travail.
2. Filtrer dépôt, rôle, classe, compatibilité du profil, permissions et contraintes du propriétaire.
3. Appliquer les restrictions locales de capacité : offre active, état suffisamment récent, quota, budget offert, créneau et concurrence lorsque ces notions existent.
4. Appliquer les exigences d'indépendance lorsqu'elles existent. Une préférence peut avoir un fallback explicite ; une exigence dure doit différer si aucune offre ne convient.
5. Classer les candidats restants selon une liste de préférences administrée et un ordre stable. La décision consigne les exclusions et le candidat retenu.
6. Faire accepter la proposition par le worker, qui peut encore refuser. Un refus n'autorise ni une élévation ni un changement silencieux de fournisseur.

En mono-worker, les étapes qui n'ont pas de données supplémentaires sont triviales. Ne pas créer un solveur ou un score pondéré « qualité × confiance / coût ». Les niveaux de raisonnement et tokens des fournisseurs ne sont pas une monnaie commune. Un ordre de coût relatif peut être renseigné dans une politique spécifique sans prétendre connaître un prix ou une équivalence cognitive.

Une offre expirée cesse d'être candidate ; le hub n'a pas besoin de connaître le quota personnel exact pour cela. Demain il pourra recevoir « accepte encore au plus N jobs de telle classe jusqu'à telle date », avec une explication bornée, tandis que le worker garde les relevés détaillés.

### Offrir 20 % d'un quota : limite importante

Un pourcentage consommé sur un compte partagé avec l'usage personnel ne permet pas d'attribuer précisément cette consommation au hub. Les resets et la mise à jour différée des relevés compliquent aussi les bornes. Ne pas transformer « budget hebdomadaire 20 % » en garantie dure de débit ou en mesure exacte de donation.

Quand les offres auront des budgets, distinguer : arrêt d'admission sur seuil observé, marge personnelle minimale, nombre maximal de tentatives et temps maximal. Les deux derniers sont contrôlables localement, sous réserve d'arrêter réellement les processus ; un pourcentage reste un garde-fou approximatif si le fournisseur n'offre pas de réservation. Les tentatives échouées consomment aussi ces limites. Le hub ne doit pas redistribuer un crédit de budget simplement parce qu'il n'a pas reçu le résultat.

Ne pas implémenter ce comptage de contribution maintenant. Le minimum actuel est de ne pas assimiler quota détecté et capacité offerte ; le mono-worker offre explicitement les profils que sa configuration autorise.

## 6. Sécurité : préserver les protections, reconnaître leurs limites

La règle future est l'intersection entre exigences du travail, autorisation du projet, restrictions de l'offre et capacités d'isolation du worker. Cette intersection peut être vide. Le hub ne peut pas la rendre non vide en demandant un sandbox plus permissif.

Les credentials du fournisseur restent chez le worker ; les credentials de publication restent chez le publisher. La machine qui prépare un dépôt privé doit posséder une autorisation de lecture indépendante. Un worker ne reçoit pas un token de publication pour faciliter un clone.

Le filtrage actuel de `agentEnvironment` enlève des variables connues ; le runner utilise aussi une copie Git isolée et contrôle les fichiers suivis après exécution. Cela ne démontre pas que du code arbitraire ne peut jamais accéder aux fichiers du compte OS, à un helper Git ou à d'autres secrets. Ne pas rebaptiser le checkout actuel « isolation adaptée aux contributeurs non fiables ». Avant le premier worker distant, documenter et tester l'isolation réelle de la machine, de l'authentification et des processus exécutant les tests du dépôt.

Autre limite irréductible : dès qu'un opérateur distant reçoit un dépôt privé, il peut en conserver une copie. La révocation arrête les prochaines distributions, pas la connaissance déjà transmise. Le propriétaire du projet doit autoriser cet opérateur **et** le fournisseur qui recevra les données ; « utilise un autre fournisseur pour diversifier la review » ne suffit pas à autoriser ce transfert.

Les futures catégories `trusted-local`, `trusted-team`, `community` peuvent être des raccourcis d'affichage. Elles ne doivent pas former une échelle qui accorde mécaniquement tous les droits inférieurs : autorisation de voir un dépôt, confiance dans un rapport et droit d'intégration sont des décisions distinctes et contextualisées.

Les artifacts distants seront des entrées non fiables : vérifier travail/SHA/tentative, tailles, digests et format, rejeter chemins absolus, traversées et liens dangereux, puis appliquer dans une copie de validation isolée sans secrets. Un digest prouve l'intégrité du fichier reçu, pas la vérité des tests déclarés. Les scripts de validation du dépôt et les patches peuvent eux-mêmes être malveillants ; ne pas les exécuter dans le processus du hub ou du publisher.

Pas de push par les workers. Même un résultat signé et validé n'accorde pas l'autorité de publier. Ces protections de transport et de validation sont des prérequis au distant, pas des travaux à implémenter intégralement aujourd'hui.

## 7. Revue hétérogène, attribution et volatilité

### Diversité utile, sans preuve automatique d'indépendance

Un changement de fournisseur est un axe de diversité, pas une preuve de décorrélation des erreurs. Deux agents peuvent partager la même spécification erronée, les mêmes tests et les mêmes hypothèses. Deux workers différents peuvent avoir le même propriétaire ; deux identifiants de modèles peuvent désigner la même famille.

Conserver maintenant la provenance qui permettra ces choix : worker, offre, executor/provider, modèle demandé/effectif, travail et SHA. Plus tard, une policy peut exiger un fournisseur différent, un autre opérateur, un contexte de review neuf ou une autre famille connue. Ces contraintes doivent être explicites et vérifiables à partir de données administrées, pas d'une promesse du worker.

Pour une review, figer le **candidat examiné** : révision de base plus patch identifié, ou commit candidat. Examiner seulement le SHA de base manquerait l'implémentation. Les validations et avis se rattachent au digest de ce candidat ; une correction produit un nouveau candidat et ne conserve pas implicitement les anciens votes.

Repousser quorum et arbitrage automatique. Un vote majoritaire ne réfute pas un finding reproductible et la multiplication de comptes ne crée pas autant d'avis indépendants. Avant une telle feature, exiger des findings structurés, un protocole de désaccord et une décision humaine sur les conséquences. Les séquences Sol/Fable/Astra évoquées par la vision sont des exemples de routage futurs, pas une affirmation de disponibilité ou d'équivalence entre produits.

### Pas de promesse exactly-once

Une exécution agentique n'est pas déterministe : code et spécification figés améliorent sa reproductibilité, pas l'identité de ses réponses. Une work unit devrait être répétable sans effet distant implicite ; elle n'est pas pour autant gratuite ou sans doublons.

À l'étape distante seulement, introduire leases, expiration et numéro de génération d'affectation. Un nouveau lease autorise une nouvelle tentative ; un résultat tardif de l'ancienne génération est conservé pour audit mais n'est pas automatiquement accepté. Le hub peut garantir l'unicité de l'acceptation/publication, pas l'absence physique de deux exécutions lors d'une partition réseau. Le worker doit arrêter ou s'abstenir lorsqu'il perd son autorisation locale selon le protocole défini à cette étape.

La révocation d'une offre empêche immédiatement les nouvelles admissions locales ; l'arrêt d'un travail déjà commencé est une opération distincte, avec artifacts partiels préservés. Aucune réattribution distante automatique maintenant. Le comportement actuel `interrupted/quota_wait` et inspection avant nouveau travail reste la règle mono-worker.

### Contribution et mesures

Les identifiants ajoutés maintenant permettent plus tard de compter tentatives, succès techniques, temps d'agent, reviews et findings acceptés. Séparer résultat reçu, résultat validé et intégration : ce ne sont pas trois noms du même succès.

Conserver les tokens inconnus à `null`, les catégories natives avec leur provenance, et éviter un total universel présenté comme effort équivalent. Le quota du compte reste local par défaut. « 42 travaux Luna acceptés » peut être observable ; « 20 % exactement donnés au projet » peut ne pas l'être. Ne créer ni réputation, ni récompense, ni classement communautaire maintenant.

## 8. Trajectoire et conditions de passage

| Étape | Livraison | Ce qui déclenche l'étape suivante |
| --- | --- | --- |
| 1 — local quota-aware | Politique précédente avec les séparations de cette note ; une offre, un executor, un worker, un seul job actif ; identités et données sérialisables | Le routage local est fiable et ses décisions sont explicables |
| 2 — frontière executor locale | Extraire préparation, adaptateur Codex, enveloppe de résultat et export complet d'artifacts ; publisher indépendant ; faux executor de test | Un deuxième runtime concret est réellement demandé |
| 3 — plusieurs executors locaux | Intégrer un deuxième fournisseur authentifié localement ; expliciter les compatibilités et les autorisations de données ; scopes/budgets séparés | Besoin réel d'une autre machine ou d'un autre opérateur |
| 4 — workers distants de confiance | Transport authentifié, worker en pull de préférence, accès aux données, offres révocables, leases/générations, stockage et validation d'artifacts, isolation testée | Fonctionnement éprouvé avec quelques opérateurs connus et un besoin communautaire explicite |
| 5 — communauté, optionnelle | Gouvernance d'accès, résistance aux identités multiples, quotas d'abus, validation renforcée, rétention et attribution des contributions | Décision produit et sécurité distincte ; ce n'est pas une suite automatique |

Faire d'abord fonctionner plusieurs executors **séquentiellement**. Le parallélisme ajoute des réservations de budget, des limites de concurrence et des courses sans être nécessaire pour prouver l'abstraction multi-provider. Un deuxième provider local est un meilleur test de séparation que des interfaces abstraites conçues sans second consommateur.

Ne pas exposer maintenant un endpoint entrant de worker. Un protocole pull peut plus tard limiter les besoins d'ouverture réseau, mais son transport, son format et son déploiement restent à choisir à l'étape 4. SQLite et l'architecture locale peuvent rester jusqu'à ce que leurs limites soient démontrées.

## 9. Articulation précise avec la spécification quota-aware

Cette note amende les **frontières** de la spec précédente sur les points ci-dessous. Elle conserve sa matrice initiale, ses seuils, son parsing `pilot-task`, ses reports, ses overrides locaux et son absence de relance automatique.

| Sujet de la spec précédente | Ajustement à appliquer |
| --- | --- |
| Quota courant et incidents main/reserve | Ajouter leur scope local explicite ; main/reserve sont des pools de ce scope, jamais des ressources globales à tous les providers. |
| `schedule(job, requestedExecution, quotaState, policy, now)` | Faire passer une offre locale et son état de capacité ; la politique Codex produit les candidats. Aucun registre distant ou API d'offres n'est demandé. |
| Ordre Luna < Terra < Sol < Astra | Le garder uniquement dans `codex-local-v1`. Ne pas y insérer un autre fournisseur ni convertir automatiquement ses efforts de raisonnement. |
| Noms de rôles et profils | Conserver les noms publics, dériver un rôle fonctionnel et une préférence explicite. Le profil reste le résultat concret de la sélection. |
| Décision liée au run | Ajouter worker/executor/offer/provider/scope et version d'offre ; séparer des identités de compte. |
| Résultat et publication | Rapport legacy conservé dans une enveloppe sérialisable ; publication appelée par l'orchestrateur. Export d'artifacts complet à l'étape 2. |
| Dashboard « mode courant » | L'afficher comme mode de l'offre Codex locale. Quand plusieurs offres existent, ne pas chercher un unique mode de quota global. |

Ne pas ajouter maintenant tables de leases, heartbeat, discovery, calendrier d'offres, compteur financier, marketplace, graphe de dépendances, quorum, DSL de policy ou mapping automatique de capacités par LLM. Ne pas élargir les droits GitHub ou les règles de données pour préparer un avenir hypothétique.

## 10. Vérification et invariants de maintenance

Dans les tests quota-aware, un faux état de capacité et une offre locale suffisent. Ajouter quelques tests de frontière :

- une décision reste sérialisable et ne contient ni credential ni chemin absolu d'exécution ;
- une offre qui interdit le rôle ou le dépôt n'est jamais retenue, même avec un quota plein ;
- un refus/inconnu de capacité ne devient pas une permission via override ;
- des observations/incidents d'un autre scope n'affectent pas l'offre testée ; deux offres fictives du même scope ne créent pas deux budgets ;
- l'identité et le profil choisis sont ceux enregistrés dans la tentative, sans deuxième résolution dans le runner ;
- un faux executor ne reçoit ni Store ni client de publication ; cette dernière vérification devient obligatoire au moment de son extraction en étape 2 ;
- les commandes historiques, protections de review, publication idempotente et conservation des tentatives restent couvertes.

Invariants à préserver à chaque étape :

1. La demande, les permissions et la capacité disponible sont des choses différentes.
2. Une capacité détectée n'est utilisable que si elle est volontairement offerte et autorisée pour ces données.
3. Les credentials de fournisseur ne traversent pas la frontière worker ; l'autorité de publication n'entre pas dans l'executor.
4. Chaque tentative possède un travail figé, une provenance et une décision explicable.
5. Une offre peut refuser ; le scheduler diffère ou choisit une autre offre compatible sans changer l'objectif.
6. Un résultat est une déclaration et des artifacts à valider, pas une autorité d'intégration.
7. Les politiques spécifiques aux fournisseurs restent locales à leurs adaptateurs et profils ; aucun score universel n'est présumé.
8. L'historique et les artifacts partiels ne sont pas écrasés pour masquer une interruption ou un doublon.

Le résultat recherché pour le prochain chantier reste un Pilot local simple. Quelques identifiants, une offre explicite et des entrées/sorties bien séparées suffisent à éviter les principaux verrouillages ; le réseau, la communauté et les protocoles de consensus peuvent attendre leurs vrais besoins.
