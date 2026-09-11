# Codex GitHub Pilot

Pilote local pour GitHub → file SQLite → Codex CLI connecté à ChatGPT.
Node 24+, Git et Codex CLI sont requis. Aucune dépendance npm, aucun appel API
OpenAI direct, aucun credential copié depuis Codex. Projet indépendant du moteur
de combat ; sa base SQLite contient uniquement l'état de l'orchestration.

## Démarrage Windows

1. Copier `config.example.json` vers `config.local.json`, puis adapter les chemins.
   `codexCommand` est un tableau de programme et arguments, jamais une commande shell.
   L'exemple lance directement le script npm Codex via Node pour éviter les wrappers
   `.ps1` / `.cmd`. Vérifier le chemin si Codex a été installé autrement.
2. Dans le même compte Windows que Codex : `codex login status` doit indiquer
   `Logged in using ChatGPT`.
3. Pour un fonctionnement continu, fournir `GITHUB_TOKEN` dans l'environnement du
   pilote : token GitHub limité à ce dépôt, Issues et Pull requests en lecture,
   et en écriture seulement pour publier les rapports. Ne jamais mettre ce token
   dans le JSON de configuration ou un commentaire. La lecture du dépôt public
   fonctionne sans token, mais le quota anonyme ne convient pas au polling continu.
   Alternative : `githubAuth: "git-credential"` réutilise la connexion GitHub déjà
   enregistrée par Git Credential Manager. Le secret est demandé au helper sans
   interaction, gardé en mémoire et jamais affiché ou sauvegardé par le pilote.
4. Exécuter `node src/cli.mjs doctor`.
   `node src/cli.mjs setup` crée le label d'activation s'il manque (permission
   Issues en écriture), sans activer d'issue ni lancer d'agent.
5. Exécuter une fois `node src/cli.mjs poll` pour fixer le début de collecte.
6. Ajouter le label `agent:active` à une issue ou PR ouverte et poster une commande
   avec un auteur présent dans `allowedAuthors`.
7. `node src/cli.mjs poll` collecte sans lancer Codex ; `node src/cli.mjs status`
   affiche la file. `node src/cli.mjs run --once` collecte et exécute au plus un job.
8. `node src/cli.mjs run` lance la boucle. Ctrl+C demande un arrêt après l'opération
   en cours. Les exécutions Codex ont une limite de durée et leurs processus enfants
   sont terminés en cas de timeout.
   Sous Windows, `./start.ps1` démarre la boucle sans fenêtre, avec journaux dans
   `state/service-logs/`. `node src/cli.mjs stop` demande son arrêt propre après
   l'opération courante. Aucun service Windows ni tâche planifiée n'est installé.

Commandes GitHub : une commande exacte en première ligne, suivie de la demande.
Elles sont locales au protocole du pilote, sans compte GitHub bot à créer.

```text
/agent sol-review
Vérifie la chaîne de provenance plan/résultat et les tests de mutation.
La spécification normative est docs/mon-issue.md.
```

Chaque tâche peut choisir explicitement son profil modèle/effort en première ligne :

```text
/agent sol-implement sol-high
Implémente la spécification et vérifie les cas limites.
```

Profils disponibles pour chacun des rôles : `sol-medium`, `sol-high`, `astra-low`.
Le profil remplace le modèle et l'effort par défaut, sans changer les consignes du
rôle. Il est conservé dans la file ; les métriques enregistrent le modèle et
l'effort demandés. Modifier le profil du commentaire après sa mise en file annule
le job : poster une nouvelle commande pour demander un autre profil.

Rôles et valeurs par défaut : `sol-implement` (Sol medium, écriture dans la copie isolée), `sol-review`
(Sol medium), `astra-review` (Astra low). Les trois rôles utilisent le sandbox
`workspace-write` dans une copie isolée. Les reviewers peuvent installer les
dépendances et écrire des tests temporaires ; tout changement de fichier suivi
ou de HEAD invalide leur résultat. Ils ne corrigent pas la branche examinée. Les deux
revues exigent une PR du même dépôt, pour examiner un SHA sans ambiguïté. Une
implémentation sur issue part de la branche par défaut distante ; sur PR, de sa tête.
Le corps de l'issue/PR porte la spec ou son chemin. Le pilote ne transmet pas
l'historique de conversation de l'implémenteur au reviewer.

## Résultats et publication

Par défaut `publish: false` : résultats locaux uniquement. Une publication se
demande par `node src/cli.mjs publish ID` ; `publish: true` la rend automatique.
Le token reste dans le processus du pilote, retiré de l'environnement enfant.
Une publication interrompue reste en `publishing` : réessayer la même publication
recherche d'abord son marqueur pour éviter un doublon. Le head de PR est revérifié
avant publication ; s'il a changé, le résultat est `stale` et reste local.

Chaque job conserve `task.txt`, `events.jsonl`, `stderr.log`, `result.json`,
`changes.txt`, `changes.patch` et sa copie Git sous `state/runs/ID/`.
Les fichiers non suivis restent dans la copie Git (ils ne figurent pas dans le
patch). Les journaux peuvent contenir du code privé : ne pas publier `state/`.

## Télémétrie SQLite

`node src/cli.mjs metrics` affiche les compteurs par tentative ;
`node src/cli.mjs metrics --json` exporte toutes les colonnes. La table
`worker_runs` conserve chaque tentative séparément, même après un échec :

- modèle demandé, effort, PID et identifiant de session renvoyé par Codex ;
- date de mise en file (via `jobs`), début de traitement, début du worker et fin ;
- préparation, exécution du worker et traitement total en millisecondes ;
- tokens d'entrée, entrée en cache, écriture de cache, sortie et raisonnement,
  agrégés depuis les événements `turn.completed` de Codex ;
- objets `usage` originaux, erreurs JSON du worker, code de sortie et timeout.

Les tokens en cache font partie de l'entrée ; le raisonnement fait partie de la
sortie. Ne pas additionner ces sous-compteurs une deuxième fois. Un champ absent
reste `null`, y compris lorsqu'un worker échoue avant de publier son usage.
Les compteurs sont persistés pendant l'exécution ; les journaux JSONL complets
restent sur disque. Un crash laisse les durées finales inconnues et conserve
l'usage déjà reçu. Aucune estimation de facture API n'est déduite de ces compteurs
d'abonnement. Les anciens jobs sans télémétrie ne sont pas artificiellement remplis.

## Observation du quota et des tokens du compte

`node src/cli.mjs observe` collecte un relevé réel via le protocole local
`codex app-server`, avec l'authentification ChatGPT du même compte Windows.
Il ne crée ni conversation, ni tour de modèle, ni mission GitHub. Aucun credential
n'est copié : le processus Codex utilise sa connexion existante.

- `node src/cli.mjs observe --watch --interval 60` répète les lectures, avec
  60 secondes d'attente après chaque collecte ; les appels ne se chevauchent pas.
- `./start-observer.ps1` lance cette observation sans fenêtre sous Windows,
  avec journaux dans `stateDirectory/observation-logs/`.
- `node src/cli.mjs stop-observe` arrête uniquement l'observateur, après la
  lecture en cours. Il possède un verrou séparé et fonctionne pendant les jobs
  longs ou une pause de quota. Aucun démarrage automatique Windows n'est installé.
- `node src/cli.mjs usage` lit les relevés enregistrés ; `usage --json --limit 100`
  expose les 100 derniers relevés et leurs variations, du plus ancien au plus récent.
- `node src/cli.mjs metrics` reste consacré aux tokens des tentatives du pilote.

SQLite conserve les relevés successifs dans `account_observations`, y compris
les erreurs et succès partiels, avec les heures de collecte distinctes du quota
et des tokens. `account/rateLimits/read` fournit les enveloppes, fenêtres,
pourcentages utilisés et dates de réinitialisation. La vue historique simple
n'est pas additionnée à la vue multi-enveloppes qui la contient déjà.
`account/usage/read` fournit les tokens cumulés du compte et les totaux journaliers
lorsqu'ils sont disponibles. Les réponses de ces deux lectures sont conservées
pour inspection locale ; la réponse d'identité et l'email ne sont pas sauvegardés.
Une empreinte de compte sépare les comparaisons entre comptes.

Un jour absent ou un champ inconnu reste inconnu. Les totaux journaliers peuvent
arriver en retard : ils ne sont jamais additionnés d'un relevé à l'autre.
La variation des tokens cumulés couvre **tout le compte**, pas seulement ce pilote.
Une baisse du cumul n'est pas transformée en consommation négative. Une variation
de quota n'est calculée que pour une même enveloppe, durée et date de reset ;
un changement de fenêtre est signalé séparément. Ces observations ne permettent
pas de convertir les tokens en pourcentage de quota ou en facture API.

Le booléen `ordinaryUsageAllowed` est conservé tel que renvoyé par le serveur.
Les pourcentages ou une date de reset dépassée ne déclenchent aucune reprise de
la file. Les erreurs de collecte ne mettent pas non plus les jobs en pause.
Le dashboard hébergé reste un prototype fictif ; aucune donnée de compte n'y
est publiée par l'observateur.

Protocole : [Codex App Server](https://learn.chatgpt.com/docs/app-server),
vérifié sur le schéma généré par Codex CLI 0.154.0 le 11 septembre 2026.

## Dashboard local

L'interface modulaire se trouve dans [`dashboard/`](dashboard/README.md), au sein
de ce dépôt. Elle fonctionne avec un serveur Node local, sans infrastructure
ChatGPT Sites.

```powershell
npm --prefix dashboard ci
npm run dashboard:build
npm run dashboard
```

Ouvrir http://127.0.0.1:4173/. `./start-dashboard.ps1` lance le serveur sans
fenêtre ; `node src/cli.mjs stop-dashboard` l'arrête. L'observateur reste un
processus indépendant : `./start-observer.ps1` pour collecter, `stop-observe`
pour arrêter la collecte.

La carte **Quota & tokens** lit les relevés locaux toutes les 15 secondes :
enveloppes, fenêtres, pourcentages restants, reset, tokens cumulés et jours
disponibles. Elle indique les erreurs et les relevés de plus de trois minutes.
Les autres vues utilisent encore les exemples du prototype, explicitement
identifiés. Aucune donnée réelle n'est envoyée à l'ancien site hébergé.

## Reprise et limites de la première version

- Un seul worker global, protégé contre deux lancements simultanés. SQLite rend
  la collecte idempotente : un commentaire n'est exécuté qu'une fois, même édité.
  Les anciens commentaires ne sont pas rejoués au premier démarrage. Poster une
  nouvelle commande après activation du label ; éditer une commande ne la relance pas.
  Le verrou utilise un port TCP localhost dérivé du chemin d'état ; aucun service
  HTTP n'y est exposé. Le système libère ce verrou si le pilote meurt. Une collision
  de port bloque le lancement plutôt que d'autoriser deux workers.
- Le label et la commande sont revérifiés avant l'exécution. Retirer le label met
  les demandes en attente hors jeu, mais n'interrompt pas un agent déjà lancé.
- Un run interrompu devient `interrupted`. Aucun redémarrage silencieux d'une
  implémentation partielle. `retry ID` est disponible seulement avant création de
  sa copie ; sinon inspecter la copie et poster une nouvelle demande ciblée.
- Un manque de quota devient `quota_wait`, sans repli payant. La reprise est
  explicite dans cette version : la file entière est suspendue, aucun sondage du
  quota par appels modèle. Après disponibilité du quota, arrêter le pilote puis
  lancer `node src/cli.mjs resume-quota`. Inspecter les copies partielles avant de
  poster de nouvelles demandes ; les anciens jobs ne sont pas rejoués.
- Les changements d'implémentation restent locaux : pas de commit, push, PR,
  fusion, enchaînement automatique ou approbation produit. Le protocole couvre
  d'abord un trajet fiable ; les transitions du cycle seront ajoutées ensuite.
- Les commentaires de revue inline, mentions dans du texte libre, forks et
  modifications de commandes déjà vues ne déclenchent pas de travail.
- GitHub est interrogé entre les jobs ; un job long retarde la collecte suivante,
  sans perdre les commentaires grâce au curseur et à la pagination.
- Les profils personnels Codex sont ignorés pour ne pas charger leurs MCP locaux.
  L'authentification sauvegardée est réutilisée. Le sandbox ne remplace pas une VM :
  réserver ce pilote à tes dépôts et auteurs de confiance. Ne jamais le brancher
  sur des commandes publiques arbitraires ni exporter auth.json dans GitHub CI.
- Aucun démarrage automatique à la connexion Windows n'est installé par défaut.

## Vérification

`node --test` vérifie le protocole, la file, les reprises et la publication avec
GitHub simulé et processus Node locaux. Ces tests ne lancent aucun modèle, ne
publient rien et ne relancent pas les tests du dépôt de combat.

Sources : [Codex non interactif](https://learn.chatgpt.com/docs/non-interactive-mode),
[commentaires GitHub](https://docs.github.com/en/rest/issues/comments),
[SQLite Node](https://nodejs.org/api/sqlite.html).
