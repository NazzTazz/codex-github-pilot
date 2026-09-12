# Pilot quota-aware — révision après comparaison OpenHands / ACP

Lot final CLI/API/dashboard après T4 : [TRANCHE-5-SPEC.md](TRANCHE-5-SPEC.md), base `074a03d`. Il précise la projection read-only hypothétique, le DTO public, les compatibilités legacy et la recette ; implémentation Sol high, contre-recette Astra high. Aucun changement des règles d'admission ni extension au double worker.

Suite immédiate après recette T5 : [TRANCHE-6-SPEC.md](TRANCHE-6-SPEC.md), métadonnées GitHub repliées, notice utilisateur et préparation d'un premier essai sur **waar-micro-combat**. Le branchement réel reste une opération explicite avec l'utilisateur, pas une autorisation donnée au rédacteur/implémenteur.

Révision 2 — 11 septembre 2026. Destinataires : Sol et les mainteneurs.

Amendement normatif du 12 septembre 2026 après T2.5 : les sections 10.3, 10.4, 10.8 et 10.9 ci-dessous intègrent l'observation multi-compte livrée et la vue compacte demandée. Les mentions de périmètre mono-compte désignent désormais une seule cible d'exécution, pas une seule source observée. La section 10.11 fixe les contrôles supplémentaires avant livraison de T3/T4. Ne pas réimplémenter T2.5.

Extension demandée le 12 septembre : [deux workers Codex CLI avec comptes locaux isolés](local-multi-account-workers-spec.md). Elle spécifie les jauges par worker et le relais Lite → Plus après alerte sous 10 % et décision utilisateur. Le périmètre mono-worker ci-dessous reste celui des tranches en cours ; l'extension précise ses propres règles de priorité et critères de livraison.

Base du code inspecté : `8807986`. Le scheduler quota-aware n'est pas encore implémenté. Ce document remplace la première spécification et prévaut sur les recommandations immédiates de [la note distribuée](distributed-capacity-architecture-note.md). La section 10 est le contrat d'implémentation ; les sections précédentes expliquent les arbitrages.

Périmètre : une machine, un Pilot, un environnement Codex authentifié localement, un dépôt GitHub à la fois, SQLite et un worker actif. Aucun déploiement OpenHands, aucune intégration ACP ni protocole distant dans cette livraison.

## 1. Conclusion exécutive

OpenHands et ACP résolvent des frontières d'exécution et de conversation dont Pilot doit s'inspirer. Ils ne remplacent pas notre politique d'admission sur quota. Conserver une petite politique métier Pilot sans inventer un protocole de dialogue avec les agents.

Décision : **requirements → sélection d'un profil sur une cible locale → assignment → executor → résultat → publication séparée**. Le quota est une entrée observée et scoped, jamais une propriété globale du scheduler. Les exigences sont des données, pas une hiérarchie de classes abstraites. Un profil concret reste nécessaire : le supprimer ne rendrait pas l'exécution indépendante des fournisseurs.

| Catégorie | Décisions |
| --- | --- |
| **KEEP** | Policy déterministe, seuils configurables, classe explicite, execute/degrade/defer, absence de promotion automatique, contexte frais, artifacts locaux, publication séparée, aucune reprise automatique d'un travail partiel. |
| **CHANGE NOW** | Séparer observation et interprétation économique ; extraire l'executor Codex ; dériver le rôle fonctionnel ; remplacer le champ proposé `lunaReady` par `executionContract` ; identifier cible et scope de capacité ; persister l'affectation exacte. |
| **KEEP POSSIBLE** | Adaptateur ACP, autre provider local, offres volontaires, worker distant autorisé, contraintes de diversité, résultats transportables. Pas d'intégration aujourd'hui. |
| **DO NOT DESIGN YET** | Pool communautaire, leases, réseau, découverte, IAM, quorum, réputation, budget financier universel, orchestration de sous-jobs. |

Corrections explicites de ma proposition précédente :

- `quotaStateFor` ne doit pas décider que 9 % signifie conserve : c'est une policy, pas un fait fournisseur.
- `luna-ready` est un bon raccourci utilisateur, mais un mauvais nom de contrat interne durable.
- Worker, offer, executor et scope n'ont pas besoin chacun d'une identité persistante indépendante dès cette livraison. Une cible locale et un scope suffisent.
- Un cache de catalogue avec sa propre cadence et son cycle d'invalidation apporte trop d'état. Lire le catalogue avec les observations lorsque la policy est activée suffit.
- Reporter toute abstraction d'executor était excessif : extraire la portion Codex de `runJob` élimine déjà une double résolution et facilite les tests. Une API distante universelle serait, elle, prématurée.
- Ni `capability=balanced` ni une capability ACP ne prouvent l'adéquation d'un modèle. Garder une compatibilité administrée explicite.

## 2. Enseignements d'OpenHands

### Correspondances utiles

Le SDK distingue agent, conversation, LLM, outils et workspace. L'agent porte la boucle de raisonnement ; les applications utilisent ces composants ou Agent Server. Pilot délègue déjà cette boucle à Codex : il n'a pas besoin de reconstruire l'agent ou d'intégrer un SDK LLM. Retenir la séparation orchestration applicative / exécution agentique. [Architecture du SDK](https://docs.openhands.dev/sdk/arch/overview).

`Conversation` gère cycle de vie, événements et état ; ses variantes locale et distante cachent les détails de transport à l'appelant. C'est un précédent utile pour la tentative Pilot, mais une conversation persistante n'est pas un job GitHub : conserver `jobId`, `runId` et `sessionId` distincts. [Conversation](https://docs.openhands.dev/sdk/arch/conversation).

`Workspace` encapsule environnement, opérations de fichiers/commandes et cycle de vie local ou distant. Pilot doit séparer le descripteur logique du travail de son chemin local. Il n'a pas besoin maintenant d'une interface universelle upload/download/terminal ou d'une factory Docker/remote. Un chemin de checkout reste légitime dans le contexte local de l'executor. [Workspace](https://docs.openhands.dev/sdk/arch/workspace).

Agent Server expose conversations et workspaces par HTTP/WebSocket, authentifie l'accès au serveur et peut conserver des secrets de conversations chiffrés. Cette architecture ne signifie pas automatiquement « le hub ne connaît jamais les credentials ». Pour Pilot, l'autorité du propriétaire du worker reste une contrainte supplémentaire. Ne déployer aucun serveur dans ce chantier. [Agent Server](https://docs.openhands.dev/sdk/arch/agent-server).

### Agent externe : bonne frontière, valeurs par défaut incompatibles

`ACPAgent` délègue à un sous-processus ACP qui gère son modèle, ses outils et son contexte. Certains réglages de l'agent OpenHands ordinaire sont explicitement non supportés. Cela confirme qu'un adaptateur doit refuser une capacité qu'il ne peut pas garantir.

Le guide documente toutefois l'approbation automatique des demandes de permission et permet l'injection de secrets dans le sous-processus. Pilot ne doit reprendre ni cette approbation générale ni ces flux de secrets comme contrat du hub. Retenir la délégation, pas copier aveuglément le wrapper. [Guide ACPAgent](https://docs.openhands.dev/sdk/guides/agent-acp).

Le workflow de code review distingue backend SDK et backend ACP expérimental, permet de comparer des modèles et publie des commentaires GitHub. Son exemple Codex restaure une authentification depuis un secret GitHub. Ces choix ne respectent pas le futur invariant Pilot de credentials du contributeur exclusivement locaux. Ne copier ni le transfert d'authentification ni le workflow de publication. La forme des findings pourra servir de référence ultérieure. [Code review OpenHands](https://docs.openhands.dev/openhands/usage/use-cases/code-review).

### Réutilisation choisie

Réutilisation conceptuelle maintenant : tentative distincte de session, état sérialisable, backend encapsulé, refus des capacités non supportées, résultats séparés des opérations du workspace. Réutilisation logicielle possible plus tard : bibliothèque ACP existante pour un agent concret.

Ne pas importer OpenHands pour remplacer quelques fonctions Node : runtime, outils, conversations persistantes, mémoire et serveur ajouteraient une deuxième orchestration autour de Codex sans résoudre notre règle de quota. C'est un arbitrage sur le scope de Pilot, pas une critique générale d'OpenHands.

## 3. Enseignements d'Agent Client Protocol

Références : le [projet Agent Client Protocol](https://github.com/agentclientprotocol/agent-client-protocol) et sa documentation, pas un autre protocole nommé ACP. Le dépôt indique une version de protocole stable 1 ; la v2 est documentée comme draft. Ne pas mélanger les méthodes de ces versions. [Statut v2](https://agentclientprotocol.com/announcements/acp-v2-draft).

### Une frontière pertinente sous le scheduler

ACP négocie version, fonctions client/agent, informations d'implémentation et méthodes d'authentification. Ses capabilities concernent contenus, sessions et opérations de dialogue ; elles ne mesurent pas la qualité d'une review. `agentInfo` identifie l'implémentation, pas à lui seul le fournisseur effectif ou le propriétaire du worker. [Initialisation](https://agentclientprotocol.com/protocol/v1/initialization).

Une session reçoit un `cwd` absolu et une configuration, puis des prompts. Son ID désigne une conversation ; ce n'est ni une révision Git, ni une unité de travail, ni un lease. Un adaptateur Pilot préparera le workspace avant la session et liera cet ID à une tentative. [Sessions](https://agentclientprotocol.com/protocol/v1/session-setup).

Le client reçoit des mises à jour puis une raison d'arrêt. `end_turn` ne signifie pas que les critères du job sont satisfaits. Le rapport JSON Pilot et la validation des artifacts restent nécessaires. [Cycle de prompt](https://agentclientprotocol.com/protocol/v1/prompt-turn).

Les options de session peuvent exposer modèle, réflexion et autres réglages via des identifiants annoncés par l'agent. Elles ne garantissent pas une correspondance universelle avec modèle/effort Codex. L'adaptateur doit sélectionner des valeurs supportées et refuser une affectation qu'il ne peut pas faire respecter ; écrire un nom de modèle dans le prompt ne remplace pas un réglage. [Options de session](https://agentclientprotocol.com/protocol/v1/session-config-options).

```text
Pilot scheduler → assignment → adaptateur ACP client → agent ACP
                                  ↑
                     workspace / permissions / rapport
```

Cette intégration convient à un deuxième agent qui expose ACP. Elle serait artificielle pour remplacer maintenant `codex exec`, dont Pilot maîtrise arguments, schéma de sortie et erreurs. JSONL Codex et app-server Codex ne deviennent pas ACP parce qu'ils utilisent aussi JSON.

### Limites à respecter

Le transport v1 documenté privilégie stdio ; Streamable HTTP y est encore une proposition. Un transport custom est possible, mais n'apporte pas automatiquement authentification du hub, leases ou distribution de code. Ne pas concevoir le hub autour d'un ACP distant supposé finalisé. [Transports](https://agentclientprotocol.com/protocol/v1/transports).

ACP prévoit des méthodes de fichiers/terminaux servies par le client. Ne pas annoncer une capability interdit ces appels protocolaires ; cela ne constitue pas un sandbox OS empêchant l'agent d'utiliser ses propres outils. Un adaptateur futur servira ces opérations dans le workspace isolé ou exigera un agent fonctionnant sans elles. Jamais les rediriger vers le filesystem du hub. [Fichiers](https://agentclientprotocol.com/protocol/v1/file-system), [outils et permissions](https://agentclientprotocol.com/protocol/v1/tool-calls).

L'authentification peut être gérée par l'agent, via des modes négociés éventuellement interactifs. Pilot headless exigera une authentification préexistante ou rendra un résultat bloqué, sans interaction cachée ni remontée de secrets au scheduler. [Authentification](https://agentclientprotocol.com/protocol/v1/authentication).

Les textes examinés ne définissent pas nos classes de tâche, budgets de contribution, scopes de quota, règles de confiance ou acceptation de patch. Conclusion de cette revue : ces données restent au-dessus d'ACP. Ne pas les enfouir dans des extensions `_meta` avant qu'un échange distant soit nécessaire.

## 4. Revue des abstractions actuelles

| Code / hypothèse | Corriger maintenant | Peut attendre |
| --- | --- | --- |
| `core.mjs::roles` mêle modèle, consigne et sandbox | Dériver rôle fonctionnel et profil demandé, contraintes de rôle séparées | Renommer les commandes publiques |
| `executionFor` appelé par runner et `codexArgs` | Résolution demandée une fois ; argv depuis assignment | Catalogue universel de modèles |
| `runJob` connaît GitHub, clone, spawn, rapport, Store, publication | Extraire exécution Codex ; publier depuis l'orchestrateur | Runtime/workspace abstrait, réseau |
| `quotaPaused` et dernier relevé globaux | Scope explicite pour observations/incidents nouveaux | Plusieurs comptes et réservation concurrente |
| Chemins de checkout, schéma et résultat locaux | Les réserver au contexte local ; entrée logique sérialisable | Bundles privés, stockage distant |
| `claim()` et verrou localhost | Admission atomique et saut des différés | Leases, heartbeat, plusieurs workers |
| Auth Codex et environnement OS | Auth locale à l'adaptateur, jamais dans assignment | Autres fournisseurs |
| Télémétrie sans backend | Cible/provider/adaptateur/scope sur les nouvelles tentatives | Identité fédérée de contributeur |
| `session_id` JSONL | ID opaque distinct du run | Reprise de session |
| Rapport JSON et patch | Statut technique séparé du verdict | Transport d'un artifact complet |

Le patch `git diff --binary HEAD` actuel omet les fichiers non suivis. Le checkout reste l'artifact complet inspectable. Ne pas annoncer un export transportable complet avant de traiter ajouts, suppressions, binaires et liens ; ce n'est pas un prérequis au scheduling local.

Le worker actuel est local et autorisé. Environnement filtré et copie Git ne démontrent pas l'inaccessibilité des fichiers d'auth OS à du code hostile. Ne pas étendre ce modèle aux contributeurs non fiables sans chantier d'isolation spécifique.

## 5. Changements minimaux

Quatre objets JSON, sans hiérarchie de classes :

| Objet | Contenu |
| --- | --- |
| `ExecutionRequirements` | Rôle fonctionnel, classe, contrat, exigences de mutation/validation. Pas de quota ni de chemin local. |
| `ExecutionTarget` | Une cible configurée : ID, provider, adapter, profils offerts et scope. Ni secret ni état de session. |
| `CapacitySnapshot` | Faits horodatés sur le scope : fenêtres, autorisations tri-état, catalogue, qualité. Aucune phase économique. |
| `ExecutionAssignment` | Affectation persistée : cible, profil exact, effort, sandbox/permissions, timeout, policy et relevé. Null si différé. |

`ExecutionProfile` reste une entrée modèle/effort du registre. Le sandbox n'est pas un niveau cognitif : il découle du rôle et doit être honoré par l'adaptateur. Une review peut écrire des tests temporaires sans modifier les fichiers suivis ; un seul booléen `workspace_write` serait insuffisant.

La cible est le précurseur d'une offre, pas une plateforme d'offres. Sa liste de profils volontairement exposés peut restreindre le catalogue détecté. Ne pas créer trois tables worker/offer/executor. Ces relations pourront entourer l'identité de cible lorsqu'elles auront un usage réel.

Pas de `min_capability=balanced` en V1 : cela donnerait l'apparence d'un standard sans évaluation commune. Une classe décrit le travail ; un modèle économique est un choix possible, pas une exigence de qualité. Garder les compatibilités explicites dans la policy Codex.

## 6. Design révisé du scheduler

| Question | Responsable |
| --- | --- |
| Comment lire les quotas Codex ? | `observation.mjs`, RPC en lecture |
| Quel scope a 9 %, quelle fraîcheur, quelle permission serveur ? | `capacity.mjs`, faits normalisés |
| Pourquoi 9 % signifie conserve ? | `codex-policy.mjs`, seuils configurés |
| Pourquoi mechanical bien spécifié peut utiliser Luna ? | Compatibilité et économie dans `codex-policy.mjs` |
| Quel candidat et quelle décision retenir ? | `scheduler.mjs`, sélection pure |
| Quel job réclamer atomiquement ? | `scheduleNext` + Store |
| Comment lancer exactement cette affectation ? | `executors/codex.mjs` |
| Qui possède les credentials ? | Environnement local de l'executor, jamais policy/assignment |

`job → requirements` et `observation → capacity` sont indépendants. Le quota ne reclassifie pas une tâche ; il change l'affectation admissible. La policy combine requirements, capacité et profils offerts en candidats motivés. La sélection retourne execute/degrade/defer sans langage de règles ni score qualité/coût/confiance.

Bornes : premium `>15`, conserve `5..15`, survival `0<r<5`, épuisé `r=0`. Reserve exige une interdiction ordinaire explicite et une réserve candidate ; blocked/unknown sont distincts des phases économiques.

| Travail | Premium | Conserve | Survival | Reserve |
| --- | --- | --- | --- | --- |
| Implementation mechanical avec contrat valide | Luna medium | Luna medium | Luna medium | Alias Reserve medium |
| Mechanical sans contrat / routine | Demandé, minimum Terra | Terra medium | Différer | Différer |
| Complex hors préparation | Demandé, minimum Sol | Sol medium | Différer | Différer |
| Exploratory | Demandé, minimum Sol | Différer | Différer | Différer |
| `sol-plan`, complex | Demandé, minimum Sol | Sol medium | Sol medium, timeout réduit | Différer |
| `astra-review` | Astra demandé | Différer | Différer | Différer |
| Unclassified | Profil historique sans dégradation | Différer | Différer | Différer |

Une review garde un plancher Terra et n'utilise pas Luna automatiquement en V1. `astra-review` prime sur la classe. L'exception `sol-plan` exige une demande de préparation explicite et bornée : aucune transformation silencieuse d'implémentation en planification.

Aucune hausse automatique de modèle, effort, permissions ou timeout. Un override économique ne dispense pas des planchers de qualité ni des disponibilités techniques.

## 7. Compatibilité future et analogie BOINC

Un futur adaptateur ACP devra prouver sélection du profil, permissions, arrêt effectif, rapport et provenance. Utiliser alors les types/bibliothèques ACP existants, pas recopier le protocole. Ne déclarer aucune conformité ACP aujourd'hui.

Une offre distante exposera sa disponibilité volontaire, pas forcément le quota personnel. Plusieurs offres d'un compte partageront un scope : elles ne multiplient pas le budget. Un incident chez Tristan ne bloque pas Alice ; conserve n'est pas un mode global cross-provider.

La diversité pourra utiliser cible/provider/modèle enregistrés, puis famille administrée et propriétaire quand ces notions existent. Les liens entre jobs attendent la review croisée. Celle-ci doit viser le candidat implémenté immuable (base + digest de patch ou commit candidat), pas seulement le SHA avant modification. Un provider différent ne prouve pas l'indépendance : contexte et spécification erronée peuvent corréler les erreurs.

L'accès aux données précède la sélection : un dépôt privé ne part pas vers un opérateur ou fournisseur non autorisé. La confiance dans une review et le droit de voir le code sont distincts. Le worker peut refuser après révocation de son offre ; le hub n'obtient ni ses credentials ni le droit d'élever ses permissions. Révoquer n'efface pas le code déjà reçu.

Les artifacts distants seront des entrées non fiables : vérifier identité du travail/tentative, SHA, taille/digest, chemins et liens avant application isolée. Un digest prouve l'intégrité, pas la vérité des tests. Ni scripts de validation ni patchs distants ne s'exécutent dans le processus du publisher/hub. Ce sont des prérequis au distant, pas des mécanismes à coder maintenant.

L'analogie SETI/BOINC aide pour contribution volontaire, hétérogénéité, disponibilité intermittente, unités de travail, résultats et attribution. Elle trompe si on suppose des calculs interchangeables et faciles à vérifier : coût variable, résultats non équivalents, confidentialité, tests hostiles et validation humaine comptent ici.

Une entrée figée ne rend pas l'agent déterministe ; une majorité d'avis ne réfute pas un finding reproductible. Le hub futur pourra éviter plusieurs acceptations/publications, pas garantir l'absence physique de deux consommations pendant une partition réseau. Un pourcentage de compte partagé ne mesure pas exactement une donation : limites de tentatives/temps et marge personnelle seront des garde-fous locaux, pas une monnaie de tokens commune.

## 8. Architecture explicitement différée

**Voici les problèmes futurs que Pilot ne doit PAS essayer de résoudre aujourd'hui :**

- registre réseau, discovery, heartbeat, transport distant, leases, réattribution, fencing ;
- identité fédérée, réputation, faux contributeurs, pool communautaire ;
- quorum, arbitrage autonome, graphe de jobs, sous-tâches créées automatiquement ;
- coût garanti par tâche, monnaie de tokens, facturation, donation mesurée exactement ;
- classes universelles de modèles, mapping automatique d'efforts, classification LLM ;
- stockage distribué, bundles privés, sandbox communautaire, conteneurs imposés ;
- moteur de règles, bus de messages, consensus, Kubernetes, service mesh ;
- remplacement de SQLite, multi-dépôts simultané, concurrence de workers.

Pas d'endpoint réseau d'exécution ni de dépendance OpenHands/ACP. Pas de configuration promettant une feature distante non supportée.

## 9. Migration

1. Livrer la section 10 : scheduler local, executor Codex extrait et faux executor de test. Policy activée explicitement, historique préservé par défaut.
2. À la demande effective d'un deuxième agent, ajouter son adaptateur local, éventuellement ACP ; vérifier capacités et droits sur les données. Garder les exécutions séquentielles pour éprouver les frontières sans problème de concurrence supplémentaire.
3. Avant un worker distant de confiance : artifacts complets, travail figé, transport authentifié, leases/générations, validation indépendante. Credentials au worker, publication au hub.
4. Le pool communautaire est une décision produit/sécurité autonome, pas une suite automatique.

## 10. Spécification d'implémentation pour Sol

Section normative autonome. Fonctions/objets JavaScript avec JSDoc ; aucune classe de base Worker, Agent, Runtime ou QuotaSource.

### 10.1 Fichiers

| Fichier | Modification exacte |
| --- | --- |
| `src/core.mjs` | Garder commandes, allowlist, activation. Ajouter profils et sol-plan ; executionFor résout seulement la demande. Dériver rôle fonctionnel/contraintes ; promptFor consomme l'entrée figée. |
| **`src/task-classification.mjs`** | Bloc pilot-task, validation et requirements ; fonctions pures. |
| `src/observation.mjs` | Faits et catalogue si policy activée, scope ; aucun mode ni écriture de file/incidents. |
| **`src/capacity.mjs`** | Dernière observation scoped, normalisation/fraîcheur ; remplace le quota-state.mjs précédemment proposé. |
| **`src/codex-policy.mjs`** | Seuils, phases, compatibilités, matrice et candidats/motifs. |
| **`src/scheduler.mjs`** | schedule pure et scheduleNext pour file/validation/admission ; pas de RPC quota ni argv Codex. |
| **`src/executors/codex.mjs`** | Auth Codex, codexArgs, spawn, parsing télémétrie/rapport et outcome ; pas de Store/GitHub/seuils. |
| **`src/process.mjs`** | Déplacer le helper subprocess execute sans refonte ; déplacer et nommer le filtre codexEnvironment. Évite le cycle observation → runner → executor. |
| `src/runner.mjs` | Garder préparation Git, intégrité commande/PR/HEAD/diff, artifacts/persistance. Recevoir assignment et executor injecté ; retirer sélection et appel de publication. |
| `src/store.mjs` | Migrations, lectures scoped, décisions/overrides/incidents, claim par ID atomique ; aucune policy SQL. |
| `src/cli.mjs` | Config, cible locale, composition policy/executor et commandes ; publication après runner. |
| `src/telemetry.mjs` | Parser Codex conservé, utilisé par l'adaptateur ; ne pas l'imposer aux futurs providers. |
| `src/dashboard.mjs`, `dashboard/src/features/quota/` | Projection/affichage 10.9, sans seconde policy TypeScript. |
| `README.md`, `config.example.json`, `test/` | Documentation, fixtures anonymisées et tests 10.10. |

`publishJob` peut rester exporté du runner, appelé uniquement par le CLI. Réexporter les helpers déplacés si nécessaire pour préserver les imports pendant ce chantier. Pas de nouvelle classe Publisher.

### 10.2 Classification et rôles

Classes : mechanical, routine, complex, exploratory ; unclassified calculé pour une commande sans bloc. Ne pas ajouter standard/architectural comme synonymes.

Première ligne `/agent ROLE [PROFILE]` inchangée. Si la première ligne non vide du corps ouvre exactement un fence pilot-task, parser son JSON jusqu'à fermeture. Ailleurs, ce bloc est du texte de tâche. Maximum 16 Kio UTF-8 ; JSON.parse + validation d'objet, champs permis class et executionContract uniquement. Ne pas écrire un parseur JSON maison ni introduire YAML.

````text
/agent sol-implement sol-medium
```pilot-task
{
  "class": "mechanical",
  "executionContract": {
    "scope": "Modifier les libellés de la carte quota.",
    "expectedResult": "Les jauges indiquent Quota restant.",
    "invariants": ["Ne modifier ni calcul ni sens des jauges."],
    "areas": ["dashboard/src/features/quota/QuotaCard.tsx"],
    "acceptanceCriteria": ["Aucun ancien libellé dans cette carte."],
    "validationCommands": ["npm run dashboard:build"]
  }
}
```
Appliquer ce contrat et rapporter la validation.
````

Contrat : scope/expectedResult chaînes non vides ; invariants/acceptanceCriteria/validationCommands tableaux non vides de chaînes non vides ; areas tableau de chaînes facultatif, éventuellement vide. Refuser champs inconnus, types incorrects et chaînes d'espaces. Contrat permis sur toute classe explicite, sans changer cette classe : complex avec contrat reste complex.

Luna est autorisée seulement pour implementation + mechanical + contrat complet attesté par l'auteur autorisé. Aucun champ lunaReady : il n'a jamais été implémenté, donc aucun alias/migration à maintenir. L'UI peut conserver ce libellé comme conséquence de la policy Codex. La validation structurelle ne prouve pas la qualité sémantique du contrat.

Les commandes de validation sont des données pour l'agent, jamais exécutées par le scheduler. Garder jobs.request intégral pour la comparaison de modification et stocker les métadonnées normalisées séparément. Pour toute commande avec contrat, figer hash du titre/corps de l'issue à l'enqueue ; changement avant exécution → annulation. Si le code ne satisfait pas les préconditions, l'agent doit rendre blocked.

Bloc réservé malformé → job terminal invalid sans worker ; poll marque vu et continue, sans commentaire automatique. Auteur/bot non autorisé reste ignoré.

| Alias public | Rôle fonctionnel | Contraintes |
| --- | --- | --- |
| sol-implement | implementation | Issue/PR, diff suivi permis, Luna selon règle précédente |
| sol-review | review | PR, aucun diff suivi, minimum Terra avec policy activée |
| astra-review | review | PR, consigne ciblée actuelle, demande Astra explicite, aucune dégradation automatique |
| sol-plan | specification | Issue/PR, aucun diff suivi, défaut Sol medium, classes explicites complex/exploratory seulement |

Porter requiresPr, mayChangeTrackedFiles et consignes sur les rôles ; tous utilisent workspace-write aujourd'hui. sol-plan sans bloc est unclassified ; il produit découpage/contrats proposés dans summary, sans créer de jobs. result.schema.json reste inchangé, y compris needs_astra : demande humaine, pas trigger.

### 10.3 Profils, cible et config

Registre : sol-medium = gpt-5.6-sol/medium ; sol-high = gpt-5.6-sol/high ; astra-low = gpt-6-astra/low ; terra-medium = gpt-5.6-terra/medium ; luna-medium = gpt-5.6-luna/medium. Profil interne luna-reserve-medium = gpt-reserve/medium, interdit en commande GitHub.

Cible construite depuis config : id local-codex, provider openai, adapter codex-exec, capacityScopeId local-codex-account, offeredProfiles configurés. IDs locaux à la base, pas identifiants globaux de contributeur. Pas de worker UUID, offer ID indépendant ou endpoint. Modèle détecté mais non offert ≠ candidat.

Après T2.5, cette valeur de scope reste le défaut historique seulement. Ajouter `scheduling.observationSourceId` optionnel : omission en mode observation legacy résout `local` ; avec observation multi-compte et scheduling activé, une source explicite configurée est obligatoire. Valeur présente non chaîne, vide ou inconnue rejetée. Ne jamais déduire la cible de `observation.defaultAccountId`, du plan, de l'ordre des cartes ou du dernier relevé global.

Ce choix est une liaison statique explicite de la cible d'exécution à une source. Scheduling activé : auth, contrôle d'identité, catalogue et executor doivent utiliser le `CODEX_HOME` de cette source dans leur environnement enfant filtré. Source legacy : environnement hérité. Scheduling désactivé : conserver exactement l'environnement d'exécution historique, même si plusieurs sources sont observées. Documenter cet effet avant activation ; ne pas modifier la configuration personnelle pendant l'implémentation. Aucun relais automatique ni sélection de plusieurs cibles dans T3/T4.

Séparer `observationSourceId` (provenance de collecte), scope de source T2.5 (`codex-observation:<id>`) et identité canonique du quota fournisseur. Les requêtes de relevés filtrent source et scope configurés. Les incidents sont associés au compte pseudonyme canonique et au pool : renommer une source ou viser le même compte depuis un autre dossier ne doit pas contourner un incident. Plusieurs sources du même compte ne multiplient jamais la capacité. Garder les scopes historiques lisibles sans réattribuer les anciennes tentatives.

Bloc optionnel, valeurs par défaut :

```json
{
  "scheduling": {
    "enabled": false,
    "conserveAtPercent": 15,
    "survivalBelowPercent": 5,
    "maxObservationAgeSeconds": 180,
    "quotaErrorCooldownSeconds": 300,
    "survivalPlanTimeoutMinutes": 10,
    "offeredProfiles": ["sol-medium", "sol-high", "astra-low", "terra-medium", "luna-medium"],
    "reserveEnabled": false
  }
}
```

Validation : booléens stricts ; 0 < survivalBelowPercent < conserveAtPercent < 100 ; âge entier 30..900 secondes ; cooldown entier 30..3600 ; timeout plan entier 1..120 minutes ; profils publics connus, liste non vide sans doublon. Reserve exige scheduling activé et luna-medium offert ; elle ajoute le profil interne conditionnellement à la disponibilité. Timeout effectif du plan en survival = min(timeout global, timeout plan).

Buckets/alias sont des constantes de l'adaptateur testées : main codex, semaine 10080 minutes, réserve base_model_inference, alias gpt-reserve, modèle normal gpt-5.6-luna. Pas de configuration générique pour des adaptateurs non implémentés ; la première spec exposait inutilement ces détails.

### 10.4 Observation, capacité, Reserve

`readCapacity(store, scopeId, now)` lit la dernière observation du scope ; `capacityFromObservation(row, now, maxAge)` est pure. Résultat : observationId/scopeId/observedAt/validUntil, quality fresh/missing/stale/invalid/account-mismatch, permission ordinaire tri-état, fenêtres main/reserve, contrôle de dépense, catalogue et identité pseudonyme locale. Aucun mode.

Adapter le contrat à T2.5 : `readCapacity(store, {observationSourceId, scopeId, expectedAccountKey}, now)`. Il lit le dernier relevé de la source et vérifie son scope et son identité ; il ne cherche pas un ancien succès pour masquer une erreur récente. `expectedAccountKey` provient d'une lecture fraîche en lecture seule de l'identité du compte d'exécution, dans le même environnement que l'executor, avant admission ; aucune comparaison de hash email avec hash d'ID fournisseur. Employer le même schéma canonique des deux côtés, sinon qualité inconnue et report. Une panne de quota produit une identité inconnue comme dans T2.5, pas un changement de compte déduit de l'email. Identité explicitement différente → `account-mismatch` ; identité manquante → capacité non admissible.

Revalider cette liaison après les lectures GitHub et avant lancement, avec les contrôles atomiques de 10.6. Changement de source/configuration pendant la préparation → réévaluation, jamais mutation d'un assignment commencé. Cette protection n'est pas une garantie contre une modification externe des credentials après le dernier contrôle ; conserver la limite documentée et les artifacts en cas d'échec.

Règles :

1. Map multi-bucket préférée au legacy dupliqué. Legacy admis seulement si limitId identifie main. Jamais le premier bucket par défaut.
2. Semaine principale par durée 10080 dans primary ou secondary du seul bucket main `codex` ; absence/ambiguïté → inconnu/invalide. Ne pas sélectionner une weekly Reserve/Spark à sa place. Restant = max(0,100-usedPercent) si entier non négatif, sinon null.
3. Fenêtre présente inconnue empêche de déclarer le pool disponible ; zéro le bloque. Secondary absente n'est pas une erreur.
4. Validité jusqu'au minimum âge maximal/reset des fenêtres concernées ; âge égal au maximum périmé. Date future de plus de 5 s/invalide → invalide. Reset passé exige nouvelle lecture, pas calcul de récupération.
5. Dernier quota en erreur interdit de recycler un succès antérieur. Panne des seuls tokens n'invalide pas le quota réussi.
6. Admission main exige ordinaryUsageAllowed=true, fenêtres main positives et aucun signal explicite de limite/dépense atteint. Contradictions → defer. Null ne prouve jamais une récupération.
7. spendControlReached null initial n'est pas bloquant à lui seul avec permission vraie ; après true, garder l'incident jusqu'à false explicite.
8. Catalogue et quota associés au même compte ; ne pas combiner différents comptes. Worker/observateur utilisent le même environnement Codex. Changer de connexion hors Pilot impose arrêt/redémarrage et nouvelles observations ; V1 ne verrouille pas cette opération externe.

Plus expose actuellement main 5 h + weekly ; Pro Lite expose main weekly, réserve Luna, Spark 5 h et Spark globale. L'absence de main 5 h sur Lite est normale, pas une preuve manquante. Les fenêtres Spark restent visibles mais n'entrent ni dans l'admission Sol/Terra/Astra, ni dans la phase économique main. Une réserve Luna positive ne rend pas Sol disponible. Durées et resets viennent des relevés, jamais du seul libellé de plan.

Si scheduling activé, ajouter model/list paginé avec includeHidden=true dans chaque collecte. Auth d'abord ; quota/usage/catalogue ensuite parallèles. Projection limitée aux modèles/efforts, date, compte et version d'implémentation connue dans capabilities_json. Aucun cache indépendant ni thread/turn. Catalogue en erreur : admissions activées attendent la preuve de disponibilité du profil candidat. Désactivé : collecte actuelle inchangée.

« Chaque collecte » concerne ici la source liée à la cible d'exécution. Réutiliser le cycle multi-source T2.5 et ses clients isolés ; les autres sources continuent leur observation sans catalogue requis et leurs erreurs ne bloquent pas la cible choisie. Ne pas remplacer le collecteur par une boucle mono-compte ni démarrer un observateur supplémentaire dans le worker.

Reserve candidate seulement si option activée, relevé frais, bucket positif sans limite atteinte, normalModelSlug=gpt-5.6-luna, alias gpt-reserve et medium au catalogue du même compte, aucun incident Reserve et aucun contrôle de dépense main explicitement atteint. Spark hors policy. Sélection Reserve exige ordinaryUsageAllowed=false ; zéro main avec permission true est contradictoire, pas un feu vert.

Évidence locale antérieure : schémas state/quota-protocol/v2 et observation 289 du 11 septembre associaient ce bucket à cet alias/modèle. Ils ne prouvent pas une exécution headless réussie après épuisement. Reserve reste opt-in expérimentale, refus sans fallback ; fixtures anonymisées versionnées, pas de dépendance des tests à state/.

Correction de la première spec : continuer à omettre supportsLunaReserve. Le schéma local le décrit comme signal de fallback automatique/exposition à une expérimentation, pas comme permission. Pilot sélectionne explicitement un alias et n'implémente pas ce fallback transparent. Si l'accès nécessite un protocole supplémentaire non établi, garder la route indisponible plutôt qu'annoncer une capacité non vérifiée. Vérification réelle ultérieure sur une tâche utile naturellement éligible ; aucun épuisement artificiel ni appel modèle dans les tests.

L'observateur conserve verrou et cadence actuels, sans modifier la file. Le worker ne démarre pas un second observateur implicitement. Doctor peut lire auth/capacités sans génération ni mutation de jobs/incidents.

### 10.5 Policy et résolution

Fonctions : requirementsFor(job), codexCandidates(requirements, requested, target, capacity, config, now), schedule({job, requirements, requested, target, candidates, override, now}). La composition choisit la policy Codex hors runner. Une cible en V1 ; pas de moteur multi-offres.

Policy calcule weeklyPhase selon section 6. Main admissible → mode identique à phase ; sinon main false + Reserve candidate → reserve ; preuves manquantes → unknown ; indisponibilité démontrée → blocked. Une limite courte peut donc rendre Reserve pertinente avant épuisement hebdomadaire. Aucun mode manuel.

Ordre :

1. Syntaxe invalide → invalid. Désactivé → comportement historique, sans nouvelles contraintes de plancher/catalogue/offre ; verrou quota historique respecté.
2. Activé : profil demandé insuffisant pour classe/rôle → defer/profile-incompatible, jamais promotion. Planchers Luna uniquement mécanique implementation attestée ; Terra routine/mécanique autrement ; Sol complex/exploratory/specification ; Astra rôle ciblé. Unclassified garde profil historique en premium sauf contrainte Astra du rôle.
3. Vérifier capacité/incidents ; aucun override ne les contourne.
4. Appliquer override valide ou matrice. Intersecter candidat avec profils offerts, catalogue, permissions et pool. Candidat imposé absent/non offert → defer, sans cascade de fallback.
5. Sans override, choisir exactement le profil de la matrice. Ordre Luna<Terra<Sol<Astra uniquement dans cette policy pour interdire les promotions. Une préférence explicite ne contourne pas l'économie.
6. Execute si capacité/effort conservés ; degrade si abaissés ; Luna normal→alias Reserve seul = execute avec routeChanged=true. Toujours indiquer pool. Defer → assignment null.

Override reçoit un candidat distinct conservant le demandé, construit par codexCandidates avec les mêmes contraintes techniques mais sans restrictions d'économie. Il ne réutilise pas une liste où le demandé a déjà été supprimé par le mode ; pas de seconde policy contradictoire dans schedule.

Exemples testés : 9 % routine Sol high → Terra medium ; 9 % complex Sol high → Sol medium ; 3 % architecture → defer ; 3 % sol-plan complex → Sol medium ; 90 % mécanique attestée Sol → Luna ; Luna demandé pour complex → defer ; 0 % + main false + Reserve validée + mécanique attestée → alias. astra-review sol-medium reste historique désactivé, incompatible activé.

### 10.6 Admission, reports, incidents, overrides

scheduleNext sous verrou worker actuel : lire queued/deferred par ID, évaluer les reports, prendre premier admissible sans bloquer derrière un travail coûteux. Revalider commande GitHub/activation/auteur et hash de contrat avant claim ; modification/fermeture → annuler et continuer. Un deferred non sélectionné reste une prévision locale dont la validité GitHub sera vérifiée au départ.

Après lectures GitHub, relire/recalculer capacité. Transaction courte BEGIN IMMEDIATE : job toujours candidat, aucun running, mêmes dernier relevé scoped et versions override/incidents ; décision + running atomiques. Si contexte changé, rollback/réévaluer. Aucun réseau en transaction.

Deferred n'a ni checkout ni worker_run. Réévaluer à chaque boucle pollSeconds, sans timer par job ni date de réveil. Run --once peut différer plusieurs jobs mais lance au plus un worker. Reset seul ne réactive rien ; report inchangé ne crée pas de ligne.

Admission ≠ réservation. Ne pas interrompre au changement de phase ; tracer âge du relevé à admission/spawn. Course avec consommation externe et préparation acceptée, échec conservé sans réessai automatique.

Incidents : scope + pool main/reserve, compte pseudonyme, timestamp, run/job nullable, kind, notBefore, clearedAt/reason. Sur erreur quota, runner conserve quota_wait/artifacts ; orchestrateur ouvre incident du pool affecté. Code structuré fiable prioritaire ; regex actuelle seulement suspicion, sans inventer reset. Aucun fallback dans le même job.

Reprise du pool : cooldown puis relevé postérieur au délai et permission établie à nouveau. Évaluer cette preuve sans le blocage de l'incident examiné, mais avec les autres restrictions. Spend-control exige false explicite ; alias non supporté exige aussi catalogue postérieur annonçant alias/effort. Incident main n'empêche pas Reserve admissible avec main false, et inversement. Scope/compte distinct n'hérite pas d'incident.

Observation spend-control true → incident unique du type par scope/compte/pool, ouvert par scheduleNext, jamais l'observateur. Projections read-only simulent les levées possibles sans persister.

QuotaPaused : historique inchangé désactivé. Activé, ne plus l'écrire sur nouvelle erreur ; ancien yes reste verrou global de migration jusqu'à resume-quota. Cette commande retire seulement ce verrou, pas incidents/restrictions. Retry refuse directory existant et ne concerne pas deferred. Recover garde deferred, interrompt tentatives commencées. Désactiver ensuite la policy rend deferred candidat au routage historique : documenter cet effet.

Override : `schedule override ID --reason "..."`, queued/deferred, 24 h, sous verrou worker. Demande profil original contre économie seulement, pas contre plancher/offre/auth/catalogue/permissions. Consommé à l'admission même si échec ; `schedule clear-override ID` révoque. Raison obligatoire et auteur OS local ; pas de mutation commentaire/profil. En Reserve demandé non-Luna reste indisponible. Timeout plan réduit conservé. Pas d'override GitHub/HTTP ni priorité automatique.

### 10.7 Executor minimal et résultat

Interface locale : `codexExecutor.execute(input, assignment, context) -> Promise<outcome>`.

- Input JSON versionné : jobId, runId, repository, revision SHA, requestedRole, functionalRole, titre/spécification/demande figés, requirements, consignes et schéma de rapport. Produit après préparation Git, sauvegardé avant génération. Aucun secret, callback ou chemin absolu.
- Assignment JSON : décision, targetId/provider/adapter/scope, profils demandé/effectif, modèle/effort, sandbox imposé, timeout, policyVersion/hash, mode/motif, observationId, overrideId nullable.
- Context local : workspacePath, outputDirectory, onEvent. Commande/auth Codex dans l'instance locale d'adaptateur, pas assignment. Chemins schéma/résultat construits par l'adaptateur. Context n'est pas sérialisable ni destiné au réseau.
- Outcome JSON : statut technique completed/failed/interrupted/blocked, rapport parsé ou null, erreur normalisée, code sortie/timeout, sessionId nullable, mesures et artifacts à noms relatifs. Runner valide rapport, HEAD et diff avant job completed.

OnEvent : started (PID/date), telemetry (snapshot actuel), fin locale si nécessaire. Garder JSONL brut ; pas de bus universel ni conversion des tool calls vers OpenHands/ACP. Auth, nettoyage et timeout dans adaptateur/helpers ; erreur attendue → outcome, exception inattendue capturée par runner avec finalisation du run. Garder checkAuth exporté par l'adaptateur et appelé avant préparation comme aujourd'hui ; ce diagnostic local n'est pas une méthode distante à généraliser. Pas de reprise de session. Stop termine l'opération courante comme aujourd'hui ; timeout tue l'arbre de processus.

L'adaptateur vérifie modèle/effort/sandbox supportés puis les passe exactement à codexArgs, sans executionFor. Garder -a never, --ignore-user-config, --ephemeral, provider openai, shell false, environnement filtré, aucune fallback API. Ni Store ni client GitHub ni publication. Runner reste orchestrateur checkout/persistance avec Git injectable.

Mapping outcome → job : timeout/interruption → interrupted ; erreur reconnue ou suspectée de quota → quota_wait ; autre erreur technique/auth/rapport invalide → failed ; succès technique et rapport valide et invariants respectés → completed. Un verdict de rapport blocked reste un résultat completed comme aujourd'hui, distinct d'un blocage technique. Aucune tentative commencée ne revient automatiquement en deferred.

RunJob retourne au CLI au minimum runId et statut courant pour la finalisation. CLI publie après validation si configuré. Conserver durée totale et run_status actuels jusqu'à fin de publication : compléter les champs de finalisation après publish, y compris en erreur. Publication ambiguë reste publishing, jamais motif de nouvelle exécution. Marqueurs et vérification SHA conservés. Le rapport reste une déclaration de l'agent, pas une validation indépendante.

### 10.8 Persistance et audit

Migrations additives/idempotentes, aucune réécriture des anciennes demandes :

| Table | Ajouts |
| --- | --- |
| jobs | task_class default unclassified, task_metadata_json, specification_hash, last_schedule_decision_id, deferred_since ; états deferred/invalid |
| account_observations | capacity_scope_id default local-codex-account, capabilities_json nullable ; normal_model_slug/spend_control_reached dans quota JSON |
| scheduling_decisions | id, job_id, created_at, kind evaluation/admission, action, reason_code, fingerprint, decision_json |
| quota_incidents | Champs 10.6, scope obligatoire |
| scheduling_overrides | job_id, created_at, expires_at, actor, reason, consumed_at, revoked_at ; un actif par job |
| worker_runs | scheduling_decision_id, target_id, provider, adapter, adapter_version nullable, capacity_scope_id, model_effective, effort_requested, sandbox_effective, quota_pool, model_observed nullable, execution_input_json nullable |

Model_requested signifie demandé ; reasoning_effort garde le sens historique effort envoyé. Anciennes lectures : effectif=model_effective ?? model_requested ; effort demandé=effort_requested ?? reasoning_effort. Identités anciennes null/legacy-local. Model_observed reste null sans événement fiable ; effectif veut dire configuré, pas prouvé à distance.

La colonne `account_observations.observation_source_id` est déjà livrée par T2.5 : la conserver et réutiliser ses lectures. Inclure l'ID de source et le scope dans les nouvelles décisions/assignments et leur fingerprint ; persister la liaison canonique au compte dans l'audit local pour les incidents. Ni chemin d'authentification ni clé de compte dans les projections HTTP. Ne pas fabriquer ces identités pour l'historique.

Decision JSON version 1 : demande/rôle fonctionnel/classe/source, demandé résolu, cible/profils offerts, policyVersion codex-local-v1, hash config canonique, scope/relevé, phase/mode, faits utiles/motifs, override, assignment ou null. Aucun compte brut, email, credential ou prompt intégral. Entrée détaillée du run locale, jamais HTTP.

Fingerprint de report : demande/classification, action/motif, mode, hash policy/offre, override et nature des restrictions ; exclure horloge/ID observation/fluctuations sans effet. Admission toujours nouvelle ligne avec relevé exact. Aucun worker_run pour invalid/deferred ; préparation échouée reste visible avec session null. Remettre deferred_since à null à l'admission ; historique conservé.

Codes fermés : policy-disabled, requested-compatible, mechanical-contract-luna, conserve-terra, conserve-sol-medium, survival-planning, premium-work-deferred, task-unclassified, profile-incompatible, profile-not-offered, quota-missing, quota-stale, quota-invalid, account-mismatch, ordinary-unavailable, reserve-route, reserve-unavailable, model-unavailable, quota-incident, legacy-quota-pause, human-override. Un motif principal selon ordre de résolution + détails factuels ; traductions hors policy.

### 10.9 CLI et dashboard

Schedule [ID] [--json] : projection read-only sans GitHub/modèle ; avertir que GitHub sera revalidé au départ. Overrides selon 10.6. Status ajoute mode/fraîcheur/reports ; metrics demandé/effectif/provider/cible/décision ; doctor diagnostic auth/capacités sans génération. Pas de set-quota/set-mode ou faux quota dans run ; injection de tests seulement.

API quota conservée avec observationId ajouté. `/api/scheduling` utilise le même évaluateur pur et transaction SQLite read-only, config reçue du CLI ; aucune migration HTTP. Ancienne base sans tables → available=false, aucune décision historique fabriquée.

Projection : enabled, targetId/provider, serverTime, policyVersion/hash, observationId/observedAt/quality, weeklyPhase/mode, recommendedCeiling, exceptions, blockingReasons, compteurs, 100 jobs queued/deferred max par ID avec total/truncated, 20 derniers runs. Jobs : issue, rôle, classe, demandé, assignment prévisionnel nullable, dernière décision persistée, motif/âge. Runs : décision d'admission liée, pas recalcul courant. Distinguer prévision et exécution.

Compteurs avant troncature : mechanicalReadyJobs = implementation mechanical + contrat valide ; deferredJobs = reports prévisionnels ; deferredPremiumJobs = reports économiques de travaux nécessitant Sol/Astra, hors erreurs/unclassified. « Luna-ready » peut rester libellé Codex du premier.

Conserver la vue compacte livrée après T2.5 : quotas dans la colonne de la vue d'ensemble, toutes les cartes de comptes visibles, jauges dynamiques sans blocs de pourcentages redondants, détails et tokens repliés par défaut sous « Voir les détails ». Carte normale si disponible, orange si dégradée/incertaine, rouge lorsque les pools observés sont épuisés ; conserver un libellé accessible. Cette couleur est un résumé des quotas observés, pas une autorisation d'exécution ni un mode de scheduling calculé côté React.

Ajouter le mode de scheduling uniquement à la cible liée explicitement : premium/conserve/survival/reserve ou inconnu/bloqué, plafond et exceptions issus de `/api/scheduling`. Distinguer compte observé et compte utilisé par l'exécution. Ne pas afficher un mode global qui semblerait s'appliquer à toutes les cartes. Ne pas réintroduire la pleine largeur ou les blocs de pourcentages supprimés.

Réutiliser `/api/accounts/quota` et le contrat legacy `/api/quota` de T2.5. `/api/scheduling` fournit `observationSourceId` et `observationId` de sa propre cible : `/api/quota` peut montrer un autre compte par défaut et ne doit pas servir à valider ses décisions. Comparer les dates/IDs uniquement à la carte de la source correspondante. Aucun endpoint existant ne change de forme implicitement.

Disabled, unknown, stale et réserve observée non activée distincts. Si observationId des deux API diffère, afficher leurs dates respectives. Tokens indépendants. Cartes métier de démonstration inchangées.

GET/HEAD localhost, Host/Origin et whitelist conservés. Ne pas exposer accountKey, entrée figée, chemins, brut fournisseur, raison libre d'override ou credentials. Rapport publié peut ajouter demandé → configuré et mode/motif ; jamais de commentaire à chaque report.

### 10.10 Tests, compatibilités et livraison

Node:test, faux GitHub/executor, transport app-server simulé, SQLite temporaire et horloge injectée. Aucun modèle réel, quota personnel ou dépendance à state/.

| Groupe | Cas obligatoires |
| --- | --- |
| Classification | Syntaxes anciennes/nouvelles ; bloc valide/invalide/trop gros ; contrat complex ne rend pas Luna ; bloc ailleurs ignoré ; bot/auteur interdit ; modification commentaire/spécification annulée |
| Capacité | 16/15/5/4/1/0 %, seuils custom ; semaine primary/secondary ; absent/ambigu ; legacy dedup ; Spark ignoré ; null/zéro/dépassement ; expiration/reset/futur ; panne tokens isolée ; mauvais compte/scope |
| Policy | Chaque cellule ; planchers/Astra ; Sol high→Terra et →Sol medium ; mécanique Luna en premium ; aucune promotion ; profil non offert ; source sans mode ; override sans élévation |
| Reserve | Liaison exacte ; option désactivée ; catalogue absent ; main false vs null ; spend-control ; aucun supportsLunaReserve ajouté ; rejet sans fallback |
| File | Deferred ancien puis admissible ; claim concurrent unique ; nouveau relevé pendant GitHub ; --once un worker ; report sans spam ; reprise deferred sur observation ; jamais retry checkout existant |
| Incidents/override | Cooldown/preuve postérieure ; true→null sans recovery ; main n'arrête pas Reserve valide ; scope séparé ; legacy pause ; expiration/révocation/consommation unique |
| Executor | Assignment exact dans argv ; aucune seconde résolution ; sans Store/GitHub ; timeout/nettoyage ; JSONL fragmenté ; rapport invalide ; auth échouée ; pas de fallback/élévation ; session inconnue null |
| Intégrité/publication | Plan sur issue ; reviewers/plan sans diff suivi ni HEAD modifié ; marqueurs/idempotence ; publication ambiguë sans relance ; métriques de fin cohérentes |
| Données/UI | Migration répétée ; historique lisible ; input/assignment sérialisables sans secret/chemin ; aucun run pour defer ; demandé/effectif distincts ; compteurs avant troncature ; ancienne base/protections HTTP |

Validation : npm test, npm run dashboard:build, contrôle visuel avec fixtures conserve/survival/reserve/unknown. Pas de suite ACP avant l'adaptateur réel.

Compatibilités : allowlist humaine, activation explicite, polling/déduplication, profils historiques, policy désactivée par défaut, auth ChatGPT sans API fallback, reviewer frais, checkout conservé, publication optionnelle/idempotente, aucun push/fusion par worker, erreurs et consommation des tentatives conservées. Aucun reclassement rétroactif.

Ordre : extraction mécanique executor et tests existants ; métadonnées/profils/migrations ; capacité/policy pures ; admission/incidents/overrides ; dashboard/docs. L'extraction seule ne change pas le comportement. Livraison complète = ces cinq lots ; ACP et distribué n'en sont pas des critères d'acceptation.

### 10.11 Recette supplémentaire après T2.5 — T3/T4

Les fondations et l'observation multi-compte sont déjà livrées. Construire les prochains lots sur ces interfaces ; les specs de tranche dérivées doivent citer cet amendement.

- Configuration multi-compte, source d'exécution absente ou inconnue : activation refusée ; changement de `defaultAccountId` sans effet sur la cible choisie.
- Source Lite sélectionnée, carte Plus par défaut : capacité/catalogue/auth/executor utilisent tous Lite. Capturer les environnements enfants pour le prouver ; aucune mutation de l'environnement parent.
- Compte attendu différent ou inconnu, relevé périmé, panne quota suivie de récupération : report sans génération ; aucun faux changement d'identité ni reprise sur ancienne observation.
- Plus 5 h épuisée mais weekly positive : main bloqué. Lite main weekly positive sans main 5 h : admissible si les autres preuves sont présentes. Spark épuisé ne bloque pas Sol ; réserve positive ne débloque pas Sol.
- Source observée non sélectionnée en panne : la cible saine continue. Deux sources du même compte ne doublent pas le quota et ne permettent pas de contourner un incident existant.
- Changement de source ou identité avant spawn : affectation réévaluée/refusée, aucun lancement sur l'ancien relevé. Une tentative commencée conserve sa provenance.
- UI : le mode du scheduler se rattache à la bonne carte ; cartes compactes et détails repliés conservés ; API legacy inchangée.
- Mutations en copie isolée : utiliser le compte par défaut au lieu de la source d'exécution, enlever le contrôle d'identité, prendre la weekly Spark pour main. Les tests doivent échouer sur ces défauts, puis passer avec le code correct.

La sélection automatique de compte, l'alerte de relais sous 10 % et la reprise inter-compte restent hors de T3/T4. Ils nécessiteront leur propre chantier ; aucune contrainte de continuité multi-compte ne doit être annoncée comme déjà implémentée.
