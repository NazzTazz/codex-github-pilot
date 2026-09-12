# Handoff Sol — première tranche du scheduler quota-aware

## Mission

Implémenter et livrer **uniquement la tranche 1 : extraction de l'executor Codex local**, avec les tests correspondants. Il s'agit d'un refactoring à comportement constant qui prépare le scheduler, pas de l'implémentation complète du scheduling.

Prendre les décisions d'architecture ci-dessous comme acquises. Ne pas recommencer une étude OpenHands/ACP, relire les discussions ou demander un récapitulatif. Signaler seulement un blocage concret ou une contradiction démontrée par le code.

## Où nous en sommes

- Dépôt : `C:\Users\trist\PhpstormProjects\codex-github-pilot`.
- Base inspectée : `8807986` — `Add local dashboard and account usage observation`.
- Node >= 24, modules `.mjs`, SQLite via `node:sqlite`, tests `node:test`. Backend sans dépendance npm d'exécution actuellement.
- Dashboard React/Vite local dans `dashboard/`. Aucun travail Sites ni déploiement cloud demandé.
- Une machine, une instance Pilot, un dépôt GitHub configuré à la fois, un seul worker actif.
- Le scheduling quota-aware n'existe pas encore dans le code.
- Au moment de ce handoff, `quota-aware-scheduling-spec.md` et `distributed-capacity-architecture-note.md` sont présents mais non suivis par Git. Les préserver, ainsi que ce handoff. Refaire `git status` au démarrage : cet état peut avoir évolué.
- `config.local.json` et `state/` sont locaux et ignorés. Ne pas les ajouter à Git. Des processus worker/observateur/dashboard peuvent être actifs : ne pas les arrêter ou les redémarrer pour valider ce refactoring.

## Document faisant autorité

Lire [la spécification révisée](quota-aware-scheduling-spec.md), principalement les sections **1, 4, 5, 10.1, 10.7 et 10.10**. Parcourir le reste pour comprendre la destination, sans en implémenter les lots suivants.

La [note distribuée](distributed-capacity-architecture-note.md) est prospective/historique. Elle ne constitue pas une deuxième liste de travaux. Le futur distant, les offres communautaires et ACP sont hors scope.

Décisions essentielles :

- Le rôle fonctionnel, le profil demandé et l'exécution effective sont distincts.
- Le scheduler futur décidera ; l'executor exécutera exactement l'affectation reçue.
- Le quota sera une observation scoped et la phase une décision de policy. Aucun de ces mécanismes n'est à coder dans cette tranche.
- Les credentials Codex restent dans l'environnement local. L'executor ne reçoit ni client GitHub ni Store ni droit de publication.
- Une session fournisseur n'est pas une tentative Pilot. Garder leurs identifiants distincts.

## Carte du code à lire

| Fichier | Rôle actuel et point d'attention |
| --- | --- |
| `src/core.mjs` | Rôles/profils, `executionFor`, parsing, poll, prompt et validation du rapport. Les profils publics actuels sont sol-medium, sol-high, astra-low. |
| `src/runner.mjs` | Mélange subprocess, auth, Git, préparation, lancement Codex, télémétrie, persistance et publication. `runJob` et `codexArgs` résolvent chacun le profil : supprimer cette redondance. |
| `src/cli.mjs` | Config, verrous locaux, commandes, boucle run et publication en attente. C'est le point de composition de l'executor et de la publication. |
| `src/store.mjs` | Jobs, worker_runs, observations. Claim exclusif, récupération et conservation des travaux interrompus. |
| `src/telemetry.mjs` | Parser JSONL Codex avec événements fragmentés, tokens et erreurs. Conserver ce parser spécialisé. |
| `src/observation.mjs` | Observateur indépendant, RPC de compte en lecture ; importe actuellement le filtre d'environnement depuis runner. Attention aux cycles d'import pendant extraction. |
| `src/github.mjs` | Accès GitHub, publication idempotente par marqueur. |
| `result.schema.json` | Rapport agent actuel : verdict, summary, findings, validation. Ne pas le modifier. |
| `test/pilot.test.mjs` | Tests runner, profils, isolation, publication, subprocess, télémétrie et Store. |
| `test/observation.test.mjs` | Transport simulé, auth/quotas, lifecycle et verrou observateur. |
| `test/dashboard.test.mjs` | Projection en lecture seule et protections HTTP. |

## Tranche 1 — périmètre exact

1. Créer `src/process.mjs` en déplaçant le helper subprocess `execute` sans changer sa sémantique. Déplacer le filtre d'environnement et le nommer `codexEnvironment` ; adapter ses consommateurs. Réexporter les anciens noms si nécessaire pour maintenir la compatibilité des imports existants.
2. Créer `src/executors/codex.mjs`. Extraire auth Codex, construction des arguments, lancement, journalisation brute, parsing télémétrie et lecture du rapport. L'adaptateur possède la configuration locale de commande, pas la policy.
3. Exposer une fonction/objet simple avec `execute(input, assignment, context) -> Promise<outcome>`, conformément à 10.7. Pas de classe abstraite ni registre d'executors.
4. Garder dans runner la préparation Git et les vérifications de commande, PR, SHA, HEAD et fichiers suivis, ainsi que l'écriture des états en base. Injecter l'executor pour les tests ; ne pas lui passer Store ou GitHub.
5. Résoudre `executionFor(job)` une seule fois avant lancement. Construire une affectation **statique en mémoire** et la transmettre jusqu'à `codexArgs`, qui ne choisit plus de profil.
6. Déplacer l'appel à `publishJob` hors de l'executor/du corps d'exécution de `runJob`, vers l'orchestration CLI. La fonction de publication peut rester exportée de runner ; pas de nouvelle abstraction Publisher.
7. Préserver la finalisation de chaque `worker_run`, y compris durée totale et état final après publication. Une publication ambiguë reste publishing et n'entraîne jamais une nouvelle exécution.

### Adaptation de la spec à cette tranche isolée

La section 10.7 décrit le contrat final. Pour cette première tranche :

- `input` contient déjà la demande et le SHA figés après préparation, et le schéma/les consignes nécessaires. Il est sérialisable, sans objet Store/GitHub, callback, credential ou chemin absolu.
- `assignment` contient le profil concret actuel, modèle/effort/sandbox/timeout et l'identité locale statique. Les références de décision quota, observation et override sont null ; marquer le routage `static`. Ne pas inventer une ligne de décision ou une phase premium.
- Le contexte local contient les chemins et callbacks ; il n'est pas destiné à être sérialisé.
- **Aucune migration SQLite ni persistance de nouveaux champs dans cette tranche.** Conserver les colonnes et métriques actuelles. Le stockage de l'entrée figée et de l'affectation structurée sera ajouté avec les décisions de scheduling dans la tranche suivante.
- Préserver le comportement actuel de `quotaPaused` et `quota_wait`. La détection technique peut être renvoyée par l'adaptateur ; le runner/orchestrateur réalise les écritures historiques. Ne pas créer d'incidents scoped maintenant.
- Aucun nouveau rôle, profil, bloc `pilot-task`, paramètre de configuration ou commande CLI. Le découplage utilise les rôles/profils existants ; les extensions fonctionnelles attendent le lot correspondant.

Ces restrictions évitent de livrer un demi-scheduler sous couvert de refactoring.

## Invariants de livraison

- Même modèle/effort/sandbox pour chaque commande actuelle, y compris profil explicitement surchargé.
- Mêmes arguments de sécurité : `-a never`, `--ignore-user-config`, `--ephemeral`, fournisseur openai, shell false ; aucune auth API de secours.
- Auth vérifiée avant préparation comme aujourd'hui ; pas d'appel supplémentaire générant des tokens.
- Même isolation Git, même rejet d'une commande modifiée ou PR déplacée, aucun changement de HEAD accepté.
- Reviews : fichiers temporaires permis, modification d'un fichier suivi refusée.
- Mêmes artifacts et conservation des échecs/timeouts. Le défaut connu du patch omettant les fichiers non suivis est hors scope : le checkout reste conservé et aucune promesse d'export complet n'est ajoutée.
- Un verdict agent `blocked` dans un rapport valide reste un résultat de job completed comme aujourd'hui ; ne pas le confondre avec une panne technique.
- Arrêt normal après l'opération courante ; timeout avec nettoyage de l'arbre de processus.
- Publication optionnelle, marqueurs et vérification du SHA inchangés ; résultat ambigu récupérable sans relance.
- Observateur indépendant, mêmes verrous/arrêts, mêmes données du dashboard.

## Tests et validation

Exécuter d'abord `npm test` pour établir le résultat de base. Ne pas supposer les tests déjà verts dans ce nouvel environnement.

Adapter les tests affectés et ajouter des tests de frontière significatifs :

1. Un faux executor reçoit l'entrée préparée et l'affectation exacte, sans Store/client GitHub ; les chemins sont uniquement dans context.
2. Les arguments Codex correspondent à l'affectation reçue, y compris sol-high et astra-low ; aucune seconde résolution depuis le job.
3. Succès, erreur quota, timeout, rapport invalide et télémétrie fragmentée conservent leurs états/mesures/artifacts.
4. La publication se produit seulement après validations ; son échec ambigu n'appelle pas une seconde fois l'executor et laisse le bon statut de run.
5. Les tests existants d'auth, environnement, intégrité de review et observateur restent verts.

Validation finale : `npm test`. Pas de build dashboard requis si ses fichiers et dépendances restent inchangés. Aucun worker Codex réel, aucun `run --once`, aucune publication GitHub, aucune consommation de quota pour tester. Utiliser les doubles de transport/subprocess existants.

## Fin de tranche attendue

Livrer le code et les tests, puis un compte rendu court : changements, tests réellement exécutés, éventuels risques et état Git. Ne pas se limiter à proposer un plan.

Pas de commit/push sans demande explicite dans la session de réalisation. Ne pas embarquer les documents non suivis par un `git add .` machinal. Si la base a changé, adapter le refactoring à l'état constaté sans écraser le travail existant.

La tranche est terminée lorsque la frontière executor est testable et le comportement historique conservé. Ne pas poursuivre automatiquement vers la classification, les migrations quota ou le dashboard.
