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

Rôles : `sol-implement` (Sol medium, écriture dans la copie isolée), `sol-review`
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
