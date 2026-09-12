# Journal Sol — implémentation de la tranche 1

## Consigne permanente pour les agents

Ce fichier est l’équivalent d’un `AGENTS.md` propre à cette étape du projet. **Tout agent qui intervient sur l’extraction de l’executor Codex local, sa validation, sa contre-revue ou une correction issue de cette contre-revue doit toujours commencer par lire ce journal et s’en servir comme contexte opérationnel de référence.**

L’agent doit :

1. vérifier l’état réel du dépôt avant d’agir ;
2. conserver les arbitrages, limites de périmètre et invariants consignés ici ;
3. éviter de demander un récapitulatif des discussions antérieures lorsque ce journal apporte déjà la réponse ;
4. mettre ce journal à jour à la fin de son intervention avec les changements réalisés, les validations exécutées, les constats encore ouverts et l’état Git pertinent.

Les instructions explicites les plus récentes de l’utilisateur et les faits observés dans le code prévalent en cas de contradiction. Hors de ces cas, ce journal doit accompagner toute intervention sur cette tranche jusqu’à sa clôture définitive.

## Mission

Contre-relire **uniquement la tranche 1 : extraction de l’executor Codex local**. Vérifier que le refactoring respecte le contrat de `HANDOFF-SOL.md`, conserve les comportements historiques et prépare proprement le futur scheduler sans en implémenter une partie prématurée.

Ne pas reprendre les discussions OpenHands/ACP et ne pas redessiner l’architecture générale. Ne pas modifier les fichiers suivis. Des tests temporaires dans le checkout sont permis si une hypothèse doit être démontrée. Produire des constats reproductibles avec fichier et ligne ; distinguer défaut démontré, risque résiduel et préférence de conception.

## État de départ

- Dépôt : `C:\Users\trist\PhpstormProjects\codex-github-pilot`.
- Base de la tranche : `8807986` — `Add local dashboard and account usage observation`.
- Les changements ne sont ni commités ni poussés.
- `HANDOFF-SOL.md`, `quota-aware-scheduling-spec.md` et `distributed-capacity-architecture-note.md` étaient déjà non suivis et ont été préservés.
- `JOURNAL-SOL-IMPLEMENTATION.md`, `src/process.mjs` et `src/executors/codex.mjs` sont également non suivis tant que la tranche n’est pas commitée.
- `config.local.json` et `state/` sont locaux et ignorés. Ne pas les lire, modifier ou ajouter.
- Ne pas lancer de worker Codex réel, `run --once`, publication GitHub ou processus de dashboard/observateur.

## Contrat à vérifier

`HANDOFF-SOL.md` est le contrat principal. Pour la destination architecturale, consulter seulement les sections 1, 4, 5, 10.1, 10.7 et 10.10 de `quota-aware-scheduling-spec.md`.

La tranche doit rester un refactoring à comportement constant : aucun scheduler quota-aware, aucune classification, aucune migration SQLite, aucun nouveau rôle/profil, aucune nouvelle commande/configuration et aucun changement du dashboard.

## Changements réalisés

### Processus local

- `src/process.mjs` contient désormais le helper subprocess `execute` déplacé sans changement intentionnel de sémantique.
- Le filtre de credentials est renommé `codexEnvironment`.
- `agentEnvironment` reste réexporté comme alias de transition.
- `src/observation.mjs` importe directement `codexEnvironment`, ce qui évite de dépendre du runner.

### Adaptateur Codex

- `src/executors/codex.mjs` expose `createCodexExecutor(config, options)` puis `execute(input, assignment, context)`.
- L’adaptateur possède la commande Codex, l’auth locale, les arguments, les logs `events.jsonl`/`stderr.log`, le parsing de télémétrie et la lecture de `result.json`.
- `codexArgs` consomme exclusivement l’affectation reçue. Il ne connaît ni job, ni rôle, ni `executionFor`.
- L’affectation doit être OpenAI/`codex-exec`, employer un effort supporté et rester limitée aux sandboxes `read-only` ou `workspace-write`.
- Les erreurs attendues sont normalisées en outcomes : succès, quota, timeout/interruption, échec processus ou résultat invalide.
- Une exception inattendue remonte au runner, mais l’événement de fin worker et les fichiers de logs doivent être conservés.
- L’adaptateur ne reçoit jamais Store, client GitHub, credential ou pouvoir de publication.

### Runner et affectation statique

- `src/runner.mjs` résout `executionFor(job)` une seule fois.
- `staticAssignment` produit une affectation sérialisable avec identité locale, profil demandé/effectif, modèle, effort, sandbox et timeout exacts. Les références policy/quota/observation/override restent null et le routage est `static`.
- `executionInput` produit après préparation Git un objet sérialisable avec demande figée, SHA, rôle, exigences, consignes et schéma. Les chemins et callbacks restent uniquement dans `context`.
- Le runner conserve les validations GitHub, PR, SHA, HEAD et fichiers suivis, ainsi que les transitions Store et le comportement historique `quotaPaused`/`quota_wait`.
- Un verdict agent `blocked` valide doit toujours conduire à un job `completed`.
- Le runner accepte un faux executor injectable. Le fallback de création locale existe pour préserver les appels/tests directs existants.

### Composition et publication

- `src/cli.mjs` compose l’executor Codex local pour le chemin de production.
- `runJob` ne publie plus.
- `runClaimedJob` publie seulement après un statut `completed`, puis met à jour la même tentative avec l’état final et la durée totale.
- En cas de publication ambiguë après passage à `publishing`, le job et la tentative restent `publishing` et l’executor n’est jamais rappelé.
- Aucune abstraction `Publisher`, aucun registre d’executors et aucune classe abstraite n’ont été ajoutés.

## Points de contre-revue prioritaires

1. Vérifier qu’aucun chemin ne résout une seconde fois le profil après la création de l’affectation et que `sol-high` comme `astra-low` arrivent inchangés dans les arguments Codex.
2. Comparer précisément les arguments de sécurité historiques : `-a never`, `--ignore-user-config`, `--ephemeral`, `model_provider="openai"`, sandbox reçu, stdin et `shell:false`.
3. Vérifier que l’auth reste effectuée avant la préparation du checkout et qu’aucun appel fournisseur supplémentaire consommant des tokens n’a été ajouté.
4. Vérifier la frontière de données : `input` et `assignment` sérialisables, sans chemin absolu, callback, Store, GitHub ou credential ; chemins et `onEvent` uniquement dans `context`.
5. Vérifier le cycle complet de télémétrie, notamment subprocess impossible à lancer, JSONL fragmenté, timeout, code non nul, quota et rapport JSON invalide.
6. Vérifier les invariants Git : SHA de PR figé, HEAD inchangé, changement suivi refusé pour une review, checkout et artifacts conservés lors des échecs.
7. Vérifier la séparation publication/exécution et l’état final du même `worker_run`, surtout après une erreur ambiguë.
8. Rechercher une régression de compatibilité sur les imports historiques `execute`, `agentEnvironment`, `checkAuth` et `codexArgs`.
9. Signaler toute abstraction relevant déjà de la tranche suivante : persistance de décision, policy quota, worker offers, remote executor ou dashboard scheduling.

Deux choix méritent une attention particulière sans être présumés fautifs :

- `runJob` finalise d’abord la tentative à la fin de l’exécution locale ; `runClaimedJob` réécrit ensuite cette même ligne après publication avec le statut et la durée finaux.
- Le profil effectif implicite est dérivé du couple modèle/effort parmi les profils publics actuels. Ces couples sont uniques dans l’état présent du dépôt.

## Validation déjà exécutée

- Baseline avant modification : `npm test`, 36 tests réussis.
- Après implémentation : `npm test`, 40 tests réussis.
- `node --check` sur `src/process.mjs`, `src/executors/codex.mjs`, `src/runner.mjs`, `src/cli.mjs` et `src/observation.mjs` : réussi.
- `git diff --check` : réussi ; seuls les avertissements de conversion LF/CRLF de Git apparaissent.
- Aucun build dashboard n’a été exécuté, conformément au handoff puisque ses fichiers sont inchangés.

Les tests ajoutés couvrent la frontière du faux executor, les affectations Sol/Astra, le refus d’une sandbox dangereuse, les outcomes quota/timeout/résultat invalide, la conservation des logs, l’échec de spawn et la publication ambiguë sans seconde exécution.

## Résultat attendu

Rendre un verdict ciblé :

- `pass` si aucun défaut matériel n’est démontré ;
- `changes_requested` avec constats ordonnés par sévérité si une régression ou violation du handoff est reproductible ;
- `needs_astra` n’a pas de sens dans cette contre-revue Astra ; utiliser `blocked` uniquement si une information indispensable manque réellement.

Pour chaque constat : expliquer le scénario, citer le fichier et la ligne, décrire l’impact, puis proposer la correction minimale. Ne pas demander l’implémentation des tranches suivantes.

## Contre-recette légère — 12 septembre 2026

Verdict : **pass dans le périmètre de cette contre-recette**. Aucun défaut matériel démontré sur le chemin actuel mono-executor. Ce résultat ne vaut pas audit exhaustif ni validation d’un executor distant.

Vérifications réalisées :

- Relecture du handoff, de ce journal, du runner, de l’adaptateur Codex, du helper processus, du parser de télémétrie et du raccord CLI/observateur.
- `npm test` relancé : **40/40 réussis**.
- `git diff --check` : réussi, avertissements habituels LF/CRLF seulement.
- Six scénarios supplémentaires exécutés via Node sur le vrai `runClaimedJob` et le vrai `runJob`, avec executor, Git, GitHub et Store simulés : HEAD modifié, fichier suivi modifié en review, verdict agent blocked, erreur quota, timeout et publication ambiguë. Tous réussis : publication empêchée après échec de validation, statut final de tentative cohérent, quotaPaused conservé, une seule exécution dans chaque scénario. Les fichiers temporaires ont été supprimés.

Le découpage respecte la tranche : affectation statique transmise à Codex, validations Git et persistance dans runner, publication dans CLI, aucune migration ou policy quota ajoutée. La finalisation en deux temps conserve l’état final attendu après publication dans les scénarios vérifiés. Le test supplémentaire de publication utilise un double du publisher ; les tests existants couvrent séparément les marqueurs et la vérification du SHA.

Constats ouverts : aucun bloquant trouvé. Les six scénarios supplémentaires sont des sondes ponctuelles, pas des tests ajoutés au dépôt. Le défaut connu d’export des fichiers non suivis reste hors scope, conformément au handoff.

État Git : HEAD `8807986`, modifications d’implémentation toujours non commitées. Aucun fichier source ou test modifié pendant cette contre-recette ; seul ce journal est complété. Aucun worker Codex réel ni publication GitHub lancé.

## Validation Astra

La tranche 1 a ensuite été recettée et validée indépendamment par Astra, selon le retour de l’utilisateur. Aucun correctif supplémentaire n’a été demandé à l’issue de cette recette. La tranche peut donc être considérée comme validée sur le plan fonctionnel et architectural dans le périmètre défini par `HANDOFF-SOL.md`.

## Préparation des tranches 2A et 2B

Le lot suivant a été séparé pour limiter la consommation du quota principal :

- [TRANCHE-2A-SPEC.md](TRANCHE-2A-SPEC.md) couvre la classification déterministe, le contrat `pilot-task`, trois colonnes additives dans `jobs` et la vérification de la spécification figée. La migration minimale est nécessaire pour ne pas accepter puis perdre silencieusement les métadonnées.
- [TRANCHE-2B-SPEC.md](TRANCHE-2B-SPEC.md) couvre ensuite rôles/contraintes, profils Terra/Luna, cible locale, configuration désactivée par défaut et reste de la persistance d’audit. Elle n’implémente toujours pas la policy quota.
- [HANDOFF-TERRA-2A.md](HANDOFF-TERRA-2A.md) demande à Terra de livrer uniquement 2A et de s’arrêter après validation.

Ces documents ont été ajoutés sans modifier le code de la tranche 1. L’état Git demeure non commité au moment de leur rédaction.

## Livraison Terra — tranche 2A

La tranche 2A est implémentée dans le même worktree, sans élément de 2B :

- `src/task-classification.mjs` ajoute le parseur strict du bloc `pilot-task`, la validation du contrat et le hash canonique titre/corps de l’issue.
- `parseCommand` enrichit les commandes reconnues avec classe, métadonnées normalisées et erreur de classification éventuelle ; les commandes historiques sont `unclassified`.
- `poll` enregistre un bloc réservé invalide comme job terminal `invalid`, sans worker, et persiste les métadonnées valides ainsi que le hash lorsqu’un contrat est présent.
- `Store` migre `jobs` de façon additive avec `task_class`, `task_metadata_json` et `specification_hash`.
- `runJob` annule avant authentification et checkout si la spécification ayant un contrat a changé ; l’entrée et le prompt de l’executor reçoivent les métadonnées normalisées comme données de tâche.

Validation : `npm test` est vert avec **47 tests**. Les nouveaux tests couvrent classes explicites, contrat, fence réservé, JSON/schéma/taille UTF-8 invalides, hash titre/corps, job invalid sans worker, migration d’une base ancienne, métadonnées sérialisables et annulation avant authentification. `node --check` et `git diff --check` sont verts ; Git affiche seulement ses avertissements LF/CRLF connus.

Le code reste non commité. Aucun worker Codex réel, `run --once`, publication GitHub, build dashboard ou consommation de quota n’a été effectué. La tranche 2B reste à venir après recette de 2A.

## Contre-recette légère — tranche 2A — 12 septembre 2026

Verdict final : **pass après correction mineure**.

La relecture ciblée du handoff, de la spécification 2A, du parseur, de la migration, du raccord au polling et du contrôle avant exécution n'a révélé aucun défaut architectural ou fonctionnel matériel. Une faiblesse locale a toutefois été reproduite dans l'API exportée `validateExecutionContract` : un tableau JavaScript creux était accepté, car `Array.prototype.every` ignore ses emplacements vides. Même si un tel tableau ne peut pas provenir directement du JSON du bloc `pilot-task`, cela contredisait la validation stricte promise par cette fonction.

Correction appliquée : la normalisation des tableaux utilise désormais `Array.from(value, text)`, ce qui matérialise chaque emplacement et rejette correctement les valeurs absentes. Une assertion de régression a été ajoutée à `test/task-classification.test.mjs`.

Sondes de bord complémentaires réussies : charge JSON valide à exactement 16 384 octets, rejet à 16 385 octets, ouverture de fence non exacte ignorée, CRLF accepté et texte après le bloc préservé.

Validation après correction :

- `npm test` : **47/47 réussis** ;
- `node --check src/task-classification.mjs` et `node --check test/task-classification.test.mjs` : réussis ;
- `git diff --check` : réussi, avec seulement les avertissements LF/CRLF connus.

Aucun worker Codex réel, appel GitHub, publication, build dashboard ou consommation de quota n'a été déclenché. Le correctif et le reste de la tranche 2A demeurent non commités.

## Handoff de reprise — tranche 2B

[HANDOFF-SOL-2B.md](HANDOFF-SOL-2B.md) a été préparé pour reprendre après changement de compte Codex. Il désigne la spec 2B comme unique périmètre, rappelle la baseline 47/47, l'état non commité des tranches précédentes, les invariants d'exécution et de sécurité, l'ordre d'implémentation, les tests obligatoires et les exclusions explicites. Le changement de compte ne requiert aucune modification du dépôt ou de la configuration Codex par l'agent.

## Livraison Sol — tranche 2B

La tranche 2B est implémentée et validée dans le même worktree. La policy quota-aware reste désactivée et absente : aucun choix automatique, report, incident ou override n'est effectué.

Changements réalisés :

- `src/core.mjs` décrit désormais chaque alias avec `functionalRole`, `requiresPr` et `mayChangeTrackedFiles`. `astra-review` porte aussi le plancher explicite `neverDegrade`. Le nouveau rôle `sol-plan` accepte issue ou PR, interdit les modifications suivies et n'accepte une classe explicite que si elle vaut `complex` ou `exploratory`.
- Le registre public comprend `terra-medium` et `luna-medium`. `luna-reserve-medium` vit dans un registre interne séparé et reste impossible à demander dans une commande GitHub.
- `src/scheduling-config.mjs` matérialise et valide strictement le bloc optionnel `scheduling`, puis construit la cible sérialisable unique `local-codex`. Aucun registre de workers, provider générique ou découverte n'a été ajouté.
- `loadConfig` applique les valeurs par défaut lorsque le bloc est absent. `config.example.json` et le README documentent le bloc désactivé, les nouveaux profils et `sol-plan`.
- Le runner applique les contraintes du rôle pour l'exigence de PR et l'intégrité des fichiers suivis. `executionInput` transporte le rôle fonctionnel et les exigences. `staticAssignment` reste l'unique affectation, identique au comportement historique, avec les identités de la cible locale.
- `Store` ajoute de façon idempotente les champs d'audit de `jobs`, `account_observations` et `worker_runs`, ainsi que les tables vides `scheduling_decisions`, `quota_incidents` et `scheduling_overrides`. Aucune ligne historique n'est complétée artificiellement par une décision.
- `startRun` accepte l'affectation structurée et une entrée figée, tout en gardant sa signature historique pour compatibilité. Le modèle demandé, le modèle effectif, l'effort demandé, la sandbox, la cible, le provider, l'adaptateur, le scope, le pool et l'entrée restent distincts. La session fournisseur reste dans son champ historique séparé.
- Les observations acceptent désormais un `capacity_scope_id` et des capacités structurées facultatives ; l'absence conserve le scope local par défaut.

Tests ajoutés dans `test/tranche-2b.test.mjs` : matrice des rôles, classes admises pour `sol-plan`, profils publics/interne, configuration par défaut/valide/invalide, cible locale, migration répétée d'une ancienne base, observation scopée, séparation demandé/effectif, sérialisation de l'entrée et refus d'un diff suivi produit par `sol-plan`. Les tests vérifient aussi que les trois tables futures restent vides lorsque la policy est désactivée.

Validation finale :

- `npm test` : **54/54 réussis** ;
- `node --check` sur tous les modules et tests créés ou modifiés des tranches 1, 2A et 2B : réussi ;
- `git diff --check` : réussi, avec seulement les avertissements LF/CRLF connus ;
- relecture de périmètre : aucun module scheduler/capacity/policy, aucune phase quota, aucun appel `model/list`, aucune API ou vue dashboard scheduling.

Le dashboard n'a pas été reconstruit puisque ses sources sont inchangées. Aucun worker Codex réel, `run --once`, appel GitHub, publication ou consommation de quota n'a été déclenché.

État Git final : HEAD `8807986`; les tranches 1, 2A et 2B et leurs documents restent non commités. Aucun fichier local ignoré (`config.local.json`, `state/`) n'a été lu ou modifié.

## Corrections après contre-revue Astra — tranches 2A/2B

Astra a demandé trois corrections délimitées. Les régressions ont été écrites et exécutées avant de modifier le code. Résultat rouge initial de `node --test test/tranche-2b.test.mjs` : **6 réussis, 3 échoués**.

Échecs reproduits avant correction :

1. Une ouverture `pilot-task` indentée devenait exacte à cause du `trim()` de `parseCommand`, et une fermeture suffixée d'espaces en fin de commentaire devenait également exacte à cause du trim global.
2. `offeredProfiles:null` était silencieusement remplacé par la valeur par défaut à cause d'un test de vérité ; le même problème concernait `false`, `0` et la chaîne vide.
3. `executionInput.requirements.workspaceWrite` était faux pour review/plan alors que ces rôles conservent volontairement une sandbox `workspace-write` afin d'autoriser dépendances, fichiers temporaires et tests. La permission de modifier les fichiers suivis était confondue avec l'accès en écriture au workspace.

Corrections minimales appliquées :

- `parseCommand` sépare désormais la ligne de commande du texte brut qui la suit. La ligne conserve sa normalisation historique extérieure, mais `parseTaskMetadata` reçoit le texte non rogné. La demande persistée reste normalisée comme auparavant.
- Le défaut `offeredProfiles` ne s'applique que lorsque la propriété est réellement absente (`Object.hasOwn`). Toute valeur présente qui n'est pas un tableau public valide est rejetée.
- Les exigences d'entrée exposent séparément `workspaceWrite`, dérivé de la sandbox, et `mayChangeTrackedFiles`, dérivé de la contrainte du rôle. Review et plan ont donc `workspaceWrite:true`, `mayChangeTrackedFiles:false` et `trackedFilesMustRemainUnchanged:true`; leur sandbox reste inchangée.

Les tests de fence passent par le chemin complet `parseCommand → poll → SQLite` et vérifient statut, classe, erreur et absence de métadonnées persistées. Les tests de configuration couvrent explicitement `null`, `false`, `0` et `""`. Les tests d'écriture couvrent `sol-review`, `astra-review` et `sol-plan`.

Preuves vertes après correction :

- fichier ciblé 2B : **9/9 réussis** ;
- suite complète : **56/56 réussis** ;
- `node --check` sur les quatre fichiers concernés : réussi ;
- `git diff --check` : réussi, avertissements LF/CRLF connus uniquement.

Aucun élargissement au scheduler, au multi-compte, au dashboard ou à la policy. Aucun worker réel ni appel GitHub exécuté. Les changements restent non commités sur HEAD `8807986`.

## Correction P2 après seconde passe Astra — revalidation avant exécution

Astra a identifié une incohérence restante dans `runJob` : la relecture du commentaire comparait le rôle, le profil et la demande normalisée, mais ignorait `classificationError`, `taskClass` et `taskMetadata`. Ajouter des espaces après le fence final rendait le bloc strict invalide tout en produisant la même demande après `trim()`, ce qui permettait d'atteindre l'authentification.

La régression demandée a été ajoutée avant le correctif sur le chemin complet : mise en file d'un bloc valide, modification exclusive des espaces après le fence, relecture par `runJob` et faux authentificateur. Preuve rouge ciblée : **0/1, échec confirmé car le faux authentificateur était appelé**.

Correction appliquée dans `src/runner.mjs` : la revalidation annule désormais le job si la classification relue est invalide, si sa classe diffère de `jobs.task_class`, ou si le JSON normalisé des métadonnées diffère de `jobs.task_metadata_json`. Ces comparaisons complètent les contrôles historiques du rôle, profil et texte normalisé. L'annulation intervient avant auth, checkout et executor.

Preuves vertes :

- régression ciblée : **1/1 réussie** ;
- suite complète : **57/57 réussis** ;
- `node --check src/runner.mjs` et `node --check test/tranche-2b.test.mjs` : réussis ;
- `git diff --check` : réussi, avertissements LF/CRLF connus uniquement.

Aucun autre périmètre n'a été modifié. Aucun worker réel, appel GitHub, scheduler ou multi-compte introduit. Changements toujours non commités sur HEAD `8807986`.

## Tranche 2.5 — observation multi-compte locale

La tranche `TRANCHE-2.5-SPEC.md` est implémentée dans son périmètre d'observation. Le mode historique sans bloc `observation` conserve la source `local`, le scope `local-codex-account`, l'environnement hérité et `/api/quota`. Le nouveau mode explicite valide strictement `defaultAccountId` et les comptes, impose des identifiants et chemins absolus uniques, puis attribue le scope stable `codex-observation:<id>` à chaque source.

La collecte lance au maximum deux clients app-server indépendants. Chaque processus enfant reçoit un environnement filtré propre et son seul `CODEX_HOME`; `process.env` n'est jamais modifié. Les résultats restent ordonnés selon la configuration et sont persistés indépendamment, y compris en cas d'échec ou de succès partiel. `observe --once` sauvegarde et affiche toutes les sources avant de retourner un code non nul si l'une d'elles n'est pas `ok`. Le mode watch conserve son verrou, son signal d'arrêt et ses cycles non superposés.

La table `account_observations` reçoit la colonne additive `observation_source_id TEXT NOT NULL DEFAULT 'local'`. Les lectures par source sont paramétrées, les deltas exigent désormais la même source et le même `account_key`, et la projection dashboard prend le dernier relevé de chaque source configurée. Une ancienne base dépourvue de la colonne reste lisible comme `local` depuis l'API en lecture seule, sans migration HTTP. Les clés de compte restent privées; l'API n'expose que `identityStatus` et les IDs des autres sources partageant une identité fraîche.

Le CLI ajoute `usage --account ID`. L'API ajoute `GET/HEAD /api/accounts/quota`; `/api/quota` continue de servir la source historique ou `defaultAccountId`. Le dashboard affiche toutes les cartes simultanément et rend toutes les enveloppes reçues par `limitId` et fenêtre, sans inventer de durée. Les quotas, tokens, erreurs, dates, changements d'identité et quotas partagés restent séparés par compte. Une réserve observée n'est jamais présentée comme une route d'exécution.

Le README et `config.example.json` documentent deux profils Codex locaux. La procédure PowerShell limite `CODEX_HOME` à chaque connexion, configure `cli_auth_credentials_store = "file"`, utilise `codex login` puis `codex login status`, et restaure l'environnement dans `finally`. `codex login --help` a été exécuté avec la CLI installée : commande disponible, sans effectuer de connexion ni lire de credential.

Preuves de validation réellement exécutées :

- baseline avant T2.5 : `npm test`, **57/57 réussis** ;
- recette ciblée multi-compte finale : **6/6 réussis**, incluant environnements isolés et fermeture des clients, historique entrelacé, projection, ancienne base en lecture seule, CLI ponctuel partiel, maintien du watch après erreur, arrêt propre et API HTTP ;
- suite finale : `npm test`, **64/64 réussis** ;
- `node --check` sur `src/observation-config.mjs`, `src/observation.mjs`, `src/store.mjs`, `src/cli.mjs`, `src/dashboard.mjs` et `test/multi-account-observation.test.mjs` : réussi ;
- `npm run dashboard:build` : réussi, TypeScript et Vite verts ;
- `git diff --check` : réussi, avec uniquement les avertissements de conversion LF/CRLF connus ;
- contrôle visuel via `agent-browser` sur un serveur fixture temporaire distinct : cartes Plus et Pro Lite visibles simultanément, respectivement deux et quatre jauges, durées inconnues conservées, aucune erreur d'accessibilité détectée (**0 violation, 0 résultat incomplet**). Le serveur fixture et ses fichiers temporaires ont été arrêtés et supprimés.

Les trois protections centrales ont aussi été éprouvées par mutations de copies temporaires, puis les copies ont été supprimées :

1. environnement partagé entre sources : le test `two sources collect independently with isolated filtered environments and reverse completion` échoue, les deux clients recevant le même home ;
2. suppression du contrôle de source dans les deltas : `interleaved histories and deltas stay within source and real identity` échoue avec un delta inter-compte de 800 tokens au lieu de `null` ;
3. dernier relevé global utilisé pour chaque carte : `accounts quota projection keeps default stable, detects changed/shared identity, and hides identity` échoue avec les IDs `[3,3]` au lieu de `[2,3]`.

L'immutabilité opérationnelle est couverte : aucun job, incident, override, `quotaPaused`, assignment ou environnement parent n'est modifié par la collecte. Aucun thread, génération, login/logout, catalogue de modèles, worker réel ou appel GitHub n'a été lancé. Le runner, l'admission et le scheduler n'ont pas été étendus.

Limite de livraison : **implémentation validée avec fixtures** ne signifie pas **deux comptes personnels connectés**. `config.local.json`, `state/` et les credentials personnels n'ont pas été lus ou modifiés. La connexion réelle des deux profils reste l'étape utilisateur documentée. État Git : HEAD `8807986`, changements non commités conformément à la spec.

## Corrections après contre-revue T2.5

La contre-revue a identifié trois écarts de compatibilité et de robustesse. Les trois régressions ont été ajoutées avant les correctifs et exécutées ensemble. Preuve rouge initiale : **0/3 réussi, 3/3 échoués**.

1. Lorsqu'une lecture quota échouait après `account/read`, l'observation persistait temporairement le hash de l'email alors que les succès utilisaient le hash de `accountId`. La source paraissait donc changer de compte pendant la panne puis au rétablissement. L'identité canonique est désormais attribuée uniquement après une réponse quota valide : `accountId` reste prioritaire, l'email pseudonymisé ne sert de repli que pour une réponse quota réussie sans identifiant fournisseur. Pendant la panne, l'identité vaut `null`/`unknown`; elle ne produit ni changement, ni partage certain, ni delta. Après rétablissement sur le même compte, l'état redevient `observed` et le partage entre sources réapparaît.
2. `observe --once --json` sérialisait toujours le tableau interne. Le mode historique sans bloc `observation` renvoie de nouveau l'objet unique exact; seul le mode multi-compte renvoie un tableau.
3. La procédure PowerShell remplaçait intégralement `config.toml`. Elle crée maintenant le fichier seulement s'il est absent. S'il existe, elle remplace uniquement la ligne `cli_auth_credentials_store` ou l'ajoute lorsqu'elle manque, en conservant toutes les autres options.

Preuves après correction :

- régressions ciblées `transient quota failure`, `documented profile setup` et `CLI observer has...` : **3/3 réussies** ;
- suite complète : `npm test`, **66/66 réussis** ;
- `node --check` sur les modules et tests corrigés : réussi ;
- `npm run dashboard:build` : réussi ;
- `git diff --check` : réussi, avertissements LF/CRLF connus uniquement.

Ces corrections restent dans T2.5. Aucun changement du runner, du scheduler, de l'admission, de `quotaPaused` ou du compte d'exécution. Aucun compte personnel, credential ou service local n'a été manipulé.

## Dernière correction T2.5 — configuration TOML et recette exécutée

La modification documentaire précédente ajoutait le réglage en fin de fichier, donc dans la dernière section TOML éventuelle. Le README refuse désormais explicitement tout `config.toml` existant avant la connexion du profil et explique le réglage manuel à la racine. Seuls les profils neufs sont initialisés automatiquement.

Le test textuel a été remplacé par l'exécution du bloc documentaire réel dans PowerShell, sur des dossiers temporaires. Deux configurations existantes (section MCP, réglage keyring, fins de ligne différentes) doivent être refusées et conservées octet pour octet. Un profil neuf doit recevoir exactement le réglage racine attendu. Aucune commande de connexion n'est exécutée par ce test. Il est explicitement ignoré hors Windows.

Preuves exécutées : test ciblé rouge avant correction (0/1, configuration existante acceptée), vert après correction (1/1) ; suite complète 66/66, syntaxe du test et `git diff --check` réussis. Aucun compte personnel ni service modifié ; changements non commités.

## Corrections directes après contre-recette T3 — 12 septembre 2026

Les deux P2 restants ont été corrigés à la demande de l'utilisateur :

- Le scheduler accepte un override valide sur son propre profil, déjà contrôlé par la policy. L'absence de Terra dans l'offre ou le catalogue ne bloque plus un override Sol valide. Les contraintes techniques et les états expiré, révoqué ou consommé restent bloquants.
- La fraîcheur globale décrit l'âge du relevé ; les resets invalident séparément main et réserve. Un reset main dépassé ne rend plus une réserve fraîche inutilisable. Chaque pool expose son `validUntil` (minimum âge/reset), distinct de celui du relevé et du catalogue. L'admission T4 reste hors périmètre.

Preuve rouge avant modification du code : les deux nouvelles régressions échouaient (0/2). Après correction : suite complète **75/75**, tests T3 **8/8**, dont les refus supplémentaires pour override inactif et catalogue périmé en réserve. Syntaxe des deux modules corrigés et `git diff --check` réussis (avertissements LF/CRLF habituels). Aucun worker réel, compte personnel ou service modifié. Changements non commités.

## Livraison T4 — admission, incidents et overrides — 12 septembre 2026

Base : `f3c3b77`, branche `feat/quota-aware-foundations`. Implémentation demandée directement par l'utilisateur après la recette T3. Contrat : sections 10.3–10.8 et amendement 10.11 de `quota-aware-scheduling-spec.md`. Le dashboard scheduling, ses projections CLI/HTTP et la recette visuelle sont le lot suivant ; aucun relais multi-worker ajouté.

Changements :

- `scheduleNext` examine queued/deferred par ID, conserve les reports sans checkout ni worker_run, revalide GitHub via `job-validation.mjs`, puis relit identité et capacité avant décision/claim atomiques. Transactions `BEGIN IMMEDIATE` synchrones, aucun réseau en transaction ; pas d'admission concurrente avec un running.
- `Store` persiste les décisions versionnées, déduplique les reports par fingerprint stable, remet `deferred_since` à null à l'admission et consomme l'override dans la même transaction. Une exception annule décision, claim et consommation ensemble.
- `quota-incidents.mjs` gère les incidents par compte canonique et pool, y compris entre sources renommées ou dupliquées. Cooldown et preuve ultérieure positive obligatoires ; spend-control exige false explicite après true ; récupération d'un alias indisponible exige aussi un catalogue ultérieur. Une observation spend-control est prise en compte même lorsque la file est vide. Les évaluations read-only simulent la récupération sans la persister.
- La sonde d'identité utilise seulement account/read et rateLimits/read, avec le même schéma canonique que l'observateur. Elle ne persiste rien et ne lance ni catalogue, ni usage, ni thread/turn. Auth et executor utilisent également l'environnement de la source explicitement sélectionnée. Mode désactivé : environnement historique hérité, aucun routage multi-compte implicite.
- Le runner reçoit l'affectation admise et refuse un appel quota-aware sans garde avant lancement. La garde revérifie compte, liaison de configuration, permission, pool, catalogue et incidents après préparation ; elle ne réécrit pas le profil au seul changement de phase économique. La preuve avant lancement est enregistrée dans la colonne additive `worker_runs.spawn_capacity_json` ; l'âge à l'admission est conservé dans l'audit.
- L'orchestrateur ouvre l'incident après un outcome quota, sans remettre le verrou historique global. Les erreurs détectées uniquement par la regex de l'adaptateur restent explicitement `quota-suspected`, sans reset inventé. Les tentatives échouées, checkouts et overrides consommés restent conservés ; aucun fallback ou retry automatique.
- `schedule override ID --reason "..."` et `schedule clear-override ID` sont locaux, sous verrou worker. Durée 24 h, auteur OS, un override actif par job. `resume-quota` ne retire que le verrou historique. `recover` conserve deferred ; désactiver la policy permet leur admission historique. Ces effets et les limites sont documentés dans README.

Validation réellement exécutée :

- Suite complète : **97/97 réussis**, dont 19 tests fonctionnels T4 et 3 tests de mutations isolées.
- Deux connexions SQLite concurrentes : une seule admission. Rollback injecté après écriture de décision : aucun claim ni override consommé résiduel.
- Relevé, identité ou override modifiés pendant GitHub : aucune admission périmée. Compte modifié pendant préparation : aucun appel executor, tentative failed conservée.
- Parcours admission → runner → vrai adaptateur avec processus simulé : argv Terra/medium, demande auditée Sol/high, home Lite sélectionné, un seul appel et aucun fallback.
- Trois mutations en copies temporaires détectées : source par défaut substituée à la source sélectionnée ; contrôle d'identité retiré ; weekly Spark substituée à main. Leurs tests attendent l'échec réel des scénarios ciblés, pas seulement la présence d'un morceau de texte.
- Régression supplémentaire trouvée en auto-relecture : spend-control avec file vide, rouge 0/1 puis vert 1/1 après correction.
- Syntaxe des 13 modules/tests concernés : réussie. `git diff --check` : réussi, avertissements LF/CRLF habituels seulement.

Limites : validation sur fixtures et faux processus, pas une recette indépendante ni une preuve de génération réelle en réserve. Aucun compte personnel, `config.local.json`, état opérationnel ou service local manipulé ; aucun appel modèle ou GitHub réel. Les sources du dashboard sont inchangées, donc pas de build/recette visuelle à cette tranche. Les copies temporaires de test ont été supprimées. Changements **non commités**, prêts pour une contre-recette indépendante avant commit/push.

## Contre-recette indépendante T4 — 12 septembre 2026

Verdict : **changes_requested**. Deux défauts P1 reproduits sur les changements non commités au-dessus de `f3c3b77`. Contrat examiné : admission/incidents/overrides et audit des sections 10.3–10.8, avec l'amendement 10.11 de `quota-aware-scheduling-spec.md`. Les projections scheduling et leur recette visuelle restent dans le lot suivant.

### P1 — Un commentaire supprimé bloque durablement les jobs suivants

Localisation : `src/scheduler.mjs:133`, appel de validation avant admission ; lecture du commentaire dans `src/job-validation.mjs:6`.

Reproduction : deux jobs routine admissibles, quota et catalogue valides, commentaire du premier supprimé sur GitHub. Le vrai client GitHub est utilisé avec un transport HTTP simulé renvoyant 404 uniquement pour ce commentaire. Deux appels successifs à `scheduleNext` lèvent `GitHub HTTP 404; retry-after=unspecified`. Les deux jobs restent `queued`, aucune admission n'est produite. Le second commentaire reste pourtant disponible et valide.

Cause : l'exception de validation sort de la boucle avant toute transition du candidat et avant l'examen du suivant. Le catch du CLI journalise l'erreur puis réessaie la même tête de file au prochain cycle. L'ancien chemin faisait cette validation après claim, dans le try/catch du runner, et ne conservait donc pas indéfiniment ce job en tête des candidats.

Correction minimale : traiter explicitement la disparition du commentaire/job lors de la validation, conserver un état/motif local terminal approprié et continuer vers le candidat suivant. Distinguer cette disparition des pannes réseau ou erreurs d'authentification ; ne pas transformer toute exception GitHub en suppression. Ajouter une régression passant par le client GitHub et son 404 réel simulé.

### P1 — Une panne de sonde d'identité efface la mémoire de spend-control

Localisation : `src/scheduler.mjs:119` et `src/quota-incidents.mjs:19` ; retour anticipé de `src/capacity.mjs:31`.

Reproduction : un relevé récent du bon scope et du compte canonique contient `spend_control_reached=true`, mais la sonde d'identité échoue et renvoie null pendant `scheduleNext`. Le job est différé, toutefois aucun incident n'est ouvert. Après 31 secondes, la sonde reconnaît de nouveau le même compte et le nouveau relevé contient `spend_control_reached=null`, quota positif et permission true. Le job passe alors `running` et sa garde `beforeSpawn` réussit. Aucun false explicite n'a été observé.

Cause : la capacité utilisée pour mémoriser le signal négatif est déjà filtrée par l'identité d'exécution. L'identité momentanément inconnue produit une qualité invalid et masque le booléen du relevé ; `reconcileIncidents` n'enregistre donc rien. Le prochain relevé remplace le true et l'obligation de récupération explicite est perdue. Cela viole 10.4/10.6 (true → null ne constitue pas une récupération).

Correction minimale : séparer la mémorisation du signal négatif fournisseur et la preuve positive nécessaire à l'admission. Persister le true du relevé valide et scoped sous son compte canonique même lorsque la sonde d'exécution est indisponible ; conserver le refus d'admission tant que l'identité est inconnue et exiger ensuite false explicite et cooldown pour lever l'incident. Ne pas supprimer le contrôle d'identité de l'admission.

### Preuves et état du dépôt

- `npm test` : **97/97 réussis**, mutations T4 comprises.
- `node --test review/t4-counter-acceptance.mjs` : **3 témoins réussis, 2 régressions échouées**. Les témoins vérifient une admission saine, le blocage true → null avec identité disponible et la récupération après false explicite. Les deux échecs démontrent les P1 ci-dessus ; le second vérifie aussi la garde avant lancement. Le fichier est conservé comme sonde de contre-recette exécutable explicitement, hors des fichiers de tests livrés.
- `node --check` : **14 fichiers réussis**, modules/tests T4 et sonde indépendante.
- `npm run dashboard:build` : réussi (TypeScript et Vite). Vérification de compilation uniquement, sans recette visuelle ni serveur dashboard.
- `git diff --check` : réussi, avertissements LF/CRLF habituels seulement.

Aucun correctif applicatif réalisé. Seuls ce journal et `review/t4-counter-acceptance.mjs` sont ajoutés/modifiés par cette contre-recette. Aucun compte personnel, credential, `config.local.json` ou état opérationnel lu/modifié ; aucune requête GitHub réelle, génération, publication, commit ou push. Les sondes utilisent SQLite en mémoire et un transport GitHub simulé. La T4 reste à corriger puis à recetter de nouveau avant validation.

## Corrections des deux P1 T4 — 12 septembre 2026

Corrections réalisées à la demande explicite de l'utilisateur. Les deux reproductions ont été réexécutées avant modification applicative : **3 témoins verts, 2 régressions rouges**, avec blocage de file sur 404 et admission/garde avant lancement acceptées après perte de spend-control.

- `src/github.mjs` expose désormais `GitHubHttpError` avec le statut HTTP, en conservant le message existant. `src/job-validation.mjs` transforme uniquement les réponses 404/410 des lectures issue/commentaire/PR en validation négative avec motif de ressource indisponible. Le scheduler annule ce candidat et continue vers le suivant. Les erreurs 401/403/429/500 et réseau remontent sans annuler les jobs.
- `src/quota-incidents.mjs` mémorise le true à partir du dernier relevé valide et frais de la source/scope sélectionnés, sous l'identité canonique de ce relevé. Cette preuve négative peut uniquement ouvrir des incidents. L'admission et leur récupération continuent d'utiliser la capacité liée à la sonde d'identité d'exécution : une identité inconnue ou différente reste bloquante, null ne remplace pas false, et le cooldown reste obligatoire. Aucune écriture n'est ajoutée aux projections read-only ni à l'observateur.
- Les sondes ont été déplacées de `review/t4-counter-acceptance.mjs` vers `test/t4-counter-acceptance.test.mjs`, pour être exécutées automatiquement par `npm test`. Quatre tests supplémentaires couvrent les ressources disparues, les erreurs transitoires/auth, la déduplication et la récupération avec identité rétablie, ainsi que les mauvais scopes/sources, relevés invalides/périmés, comptes distincts et projections sans mutation.

Validation : tests ciblés de contre-recette **9/9 réussis** ; suite complète **106/106 réussis**, dont les trois mutations isolées T4 ; syntaxe des quatre fichiers modifiés/ajoutés et `git diff --check` réussis (avertissements LF/CRLF habituels seulement). Le build dashboard avait réussi pendant la contre-recette et ses sources ne changent pas dans ce correctif.

Les deux P1 démontrés sont corrigés et leurs reproductions intégrées à la suite. Vérification sur fixtures, SQLite en mémoire et transport GitHub simulé ; aucun worker réel ni accès aux comptes personnels ou à l'état opérationnel. Base Git toujours `f3c3b77`, changements non commités, aucun push.

## Vérification ciblée après corrections P1 T4 — 12 septembre 2026

Verdict : **pass sur les deux correctifs examinés**, sans nouveau défaut matériel trouvé dans cette passe ciblée. Relecture du traitement HTTP typé, de la validation partagée et de la séparation entre preuve négative observée et identité exigée pour admission/récupération.

Preuves réexécutées : tests de contre-recette **9/9**, suite complète **106/106**, syntaxe des quatre fichiers corrigés et `git diff --check` réussis. Les tests distinguent bien 404/410 des erreurs auth/réseau et exigent une identité rétablie ainsi qu'un false explicite après cooldown.

Vérification supplémentaire indépendante en copie temporaire : retrait du traitement 404/410 → régression du commentaire supprimé rouge ; rétablissement → verte. Remplacement de la condition d'ouverture sur preuve observée par l'ancienne condition sur capacité liée à l'identité → régression spend-control rouge ; rétablissement → verte. La baseline corrigée passe les deux scénarios. Le script ponctuel et toutes ses copies temporaires ont été supprimés ; aucun code applicatif ou test livré modifié pendant cette passe.

Cette vérification ciblée complète la contre-recette précédente, sans prétendre constituer un nouvel audit exhaustif. Aucun worker, modèle, GitHub réel ou compte personnel utilisé. Seul ce journal est complété ; aucune opération de commit/push.

## Spécification T5 — CLI/API/dashboard — 12 septembre 2026

T4 a été commitée et poussée dans `074a03d` sur `feat/quota-aware-foundations`. À la demande de l'utilisateur, `TRANCHE-5-SPEC.md` définit le dernier lot V1 pour Sol high, avec contre-recette Astra high en contexte neuf. La spec générale référence ce document.

Décisions précisées : lecteur SQLite distinct du Store qui migre, prévision sans sonde réseau explicitement hypothétique et sans pouvoir d'admission, whitelist publique récursive distincte de l'audit interne, compteurs avant troncature, tentatives jointes à leur vraie admission historique, ajout observationId explicitement compatible à l'API quota legacy, diagnostic doctor read-only, panneau scheduling replié et badge uniquement sur la carte cible. Les cartes existantes, le mono-worker et les corrections P1 restent des invariants.

Le document inclut les contrats CLI/HTTP, états d'indisponibilité, plan de tests/mutations, recette visuelle sur fixtures, règle d'escalade et arrêt sans commit avant contre-recette. Seuls les documents sont modifiés ; aucune implémentation T5, génération, manipulation de compte/service ou exécution de suite applicative. Vérification documentaire et `git diff --check` uniquement. Documents non commités.

## Livraison Sol - T5 CLI/API/dashboard - 12 septembre 2026

La tranche 5 expose désormais une projection de scheduling locale, versionnée et strictement en lecture seule. `src/scheduling-view.mjs` ouvre SQLite avec `readOnly: true`, vérifie le schéma sans migration, réalise chaque projection dans un snapshot explicite et partage le même DTO public entre `pilot schedule --json` et `GET /api/scheduling`.

La projection conserve l'identité de l'observation sélectionnée sans exposer de clé de compte, de prompt, de chemin local, d'erreur brute ni de prose d'override. Les totaux sont calculés avant la limite de 100 jobs, les 20 exécutions les plus récentes restent reliées à leur admission persistée, et la prévisualisation annonce explicitement qu'elle est hypothétique et non réservante.

Les commandes `schedule`, `status` et `metrics` passent avant toute création de répertoire, ouverture du Store mutable ou acquisition du verrou worker. `doctor` rapporte la configuration, l'identité réelle et l'identité enregistrée sans fuite de secret. Les commandes mutantes d'override restent sous le chemin verrouillé existant.

Le dashboard ajoute `observationId` à `/api/quota`, expose `/api/scheduling` avec les protections HTTP existantes et affiche le badge uniquement sur le compte réellement sélectionné. Le dialogue compact « Voir les décisions » couvre les modes conservation, survie, réserve, inconnu et désactivé sans modifier la carte quota historique.

Recette exécutée :

- `npm test` : 115 tests réussis sur 115 ;
- trois contre-mutations isolées détectées : comptage après limite, substitution du compte par défaut, fuite de l'assignment interne ;
- `npm run dashboard:build` : build Vite réussi ;
- vérifications syntaxiques Node : réussies ;
- `git diff --check` : réussi, hors avertissements de normalisation LF/CRLF ;
- recette navigateur locale sur les modes `conserve`, `survival`, `reserve`, `unknown` et `disabled`, avec ouverture/fermeture clavier du dialogue et contrôle mobile à 390 px.

Les captures sont conservées dans `artifacts/t5-visual/`. La fixture reproductible est `scripts/t5-dashboard-fixture.mjs` ; elle est placée hors de `test/` afin de ne pas être découverte comme test par `node --test`. Aucun service personnel, appel modèle ou appel GitHub n'a été utilisé. Aucun commit ni push n'a été effectué.

## Spécification de la suite immédiate T6 — 12 septembre 2026

À la demande de l'utilisateur, `TRANCHE-6-SPEC.md` place après livraison/recette de T5 un lot distinct : enveloppe details/summary canonique pour replier le JSON pilot-task, compatibilité du fence nu et revalidation stricte ; notice utilisateur de branchement sur dépôt existant ; checklist de première utilisation sur **waar-micro-combat**, nom confirmé le plus récemment. La spec générale référence T6.

Le lot ne comprend aucun branchement réel, publication GitHub ou consommation de quota. Propriétaire, chemin et validation métier du dépôt pilote restent à confirmer avec l'utilisateur. Les changements T5 présents ont été préservés ; seuls ces documents ont été ajoutés/complétés. Aucun test applicatif exécuté pour la rédaction ; `git diff --check` effectué. Pas de commit/push.

## Contre-recette indépendante T5 — 12 septembre 2026

Verdict : **changes_requested**, six écarts P2 à traiter. Base inspectée : `074a03d`, changements T5 non commités. Contrat : `TRANCHE-5-SPEC.md` et sections applicables de la spec générale. La rédaction T6 apparue pendant cette passe a été préservée et n'est pas recettée ici. Aucun correctif applicatif T5 effectué.

### 1. P2 — Le filtre public accepte des objets arbitraires à la place de scalaires

Localisation : `src/scheduling-view.mjs:58`, particulièrement ligne 62. `publicAssignment` filtre les noms de clés mais recopie leurs valeurs sans validation de type ni filtrage récursif. Dans une décision persistée malformée, remplacer assignment.model par `{accountKey:"NESTED_PRIVATE_CANARY",raw:{prompt:"NESTED_PROMPT_CANARY"}}` fait ressortir les deux canaris dans `GET /api/scheduling`, statut 200. La reproduction passe par une vraie admission sauvegardée, un worker_run local simulé et le serveur HTTP réel sur un port temporaire.

La démonstration suppose une valeur persistée de forme incorrecte ; aucune fuite n'est démontrée sur les assignments valides produits par T4. Elle contredit néanmoins la whitelist récursive et la recette des canaris imbriqués imposées en sections 4/8. Correction minimale : projeter des scalaires typés, refuser les objets/tableaux inattendus et appliquer la même validation aux autres valeurs issues de decision_json. Une erreur filtrée est préférable à la transmission de données internes.

### 2. P2 — status masque les jobs d'une base sans schéma scheduling

Localisation : `src/scheduling-view.mjs:133–135`. Le lecteur générique refuse tout le schéma avant de rendre les lignes historiques de status. Sur une base contenant un job et dépourvue de scheduling_decisions, la projection annonce bien scheduling.available=false mais retourne jobs=[] : un job persisté, zéro affiché. Le témoin confirme que la base n'a pas été modifiée.

Correction minimale : lire les colonnes historiques de jobs indépendamment de la disponibilité du schéma scheduling, dans une transaction read-only. Conserver l'indisponibilité du résumé sans fabriquer une file vide. Cela rétablit le contrat de compatibilité de status, sans migration de consultation.

### 3. P2 — Une métadonnée JSON illisible produit une prévision exécutable

Localisation : `src/scheduling-view.mjs:100`, passage des candidats à schedulingDecision sans validation préalable du JSON persisté. Mettre task_metadata_json à `{broken` sur un job routine produit available=true et preview.action=execute. Le catch permissif de requirementsFor est utile ailleurs mais ne satisfait pas le contrat T5 d'indisponibilité explicite pour JSON illisible.

Correction minimale : vérifier les JSON nécessaires à la projection sur la voie de lecture T5 ; signaler proprement la corruption (503 filtrée côté HTTP, erreur CLI) sans changer les règles d'admission T4 ni assimiler ce cas à un quota absent.

### 4. P2 — L'historique visuel cache une dégradation d'effort

Localisation : `dashboard/src/features/scheduling/SchedulingPanel.tsx:37`. Une tentative enregistrée demandée en Sol high et configurée en Sol medium est rendue comme `gpt-5.6-sol → gpt-5.6-sol`. Les champs requestedEffort/effectiveEffort existent dans le DTO mais ne sont jamais affichés. Reproduit dans le Chrome connecté par l'utilisateur, avec une tentative simulée ajoutée exclusivement à la base temporaire de recette ; aucun executor appelé.

Correction minimale : montrer modèle et effort des deux côtés, ou les profils équivalents. La date de fin et le mode Conservation actuellement affichés ne permettent pas de connaître l'effort réellement configuré.

### 5. P2 — La prévision affichée n'identifie pas son relevé

Localisation : `dashboard/src/features/scheduling/SchedulingPanel.tsx:16–27`. Ni badge ni dialogue n'affichent observationId/observedAt/serverTime de la projection. Les dates visibles dans la carte sont celles des quotas/reset, et celles du dialogue concernent seulement les tentatives. Deux lectures indépendantes quota/scheduling peuvent donc être affichées ensemble sans moyen de distinguer leurs relevés, contrairement à la section 6 de T5.

Correction minimale : afficher au moins la date avec fuseau du relevé utilisé par scheduling, séparément des dates de quota ; indiquer clairement la provenance ou un décalage d'ID lorsque pertinent. Aucun recalcul de policy dans React n'est nécessaire.

### 6. P2 — La fixture livrée ne démarre pas depuis scripts/

Localisation : `scripts/t5-dashboard-fixture.mjs:7` et `:9`. `node scripts/t5-dashboard-fixture.mjs conserve 43179` échoue immédiatement avec ERR_MODULE_NOT_FOUND : l'import ../../src/scheduling-config.mjs vise le parent du dépôt. Le root calculé avec ../../ pointe également au mauvais endroit pour dashboard/dist.

Correction minimale : adapter les deux chemins au déplacement du fichier dans scripts/ et rejouer réellement la commande documentée. Pour poursuivre cette contre-recette, seule une copie jetable dans review/ a reçu ces deux corrections de chemin ; le script livré est resté inchangé.

### Preuves exécutées et limites

- Suite livrée : **115/115 réussis**, y compris les trois mutations T5 et les régressions/mutations T4.
- `node --test review/t5-counter-acceptance.mjs` : **1 témoin vert, 3 régressions rouges** (écarts backend 1–3). Le témoin compare schéma et toutes les lignes métier avant/après les lectures schedule/status/metrics et vérifie qu'une admission premium reste premium après passage du quota courant en survival. Modèle observé absent toujours null. Le fichier de sondes reste disponible, hors découverte automatique de npm test.
- `npm run dashboard:build` : réussi ; `node --check` sur les huit modules/tests/scripts concernés : réussi ; `git diff --check` : réussi, avertissements LF/CRLF seulement. Le contrôle syntaxique ne détecte pas l'import cassé de la fixture ; son exécution l'a révélé.
- Chrome fourni par l'utilisateur, onglet de recette dédié via extension : conservation, survie, réserve, inconnu et routage désactivé examinés. Badge unique sur Pro Lite, jauges simultanées, détails initialement repliés, dialogue ouvert/fermé au clavier, largeur de page sans débordement à 1440 et 390 px. Le mode désactivé ne marque pas Plus comme cible ; son motif est encore le code brut policy-disabled dans les lignes.
- Panne de /api/scheduling simulée par blocage réseau limité à l'onglet temporaire : trois jauges conservées, message « Données conservées, actualisation indisponible. » affiché. Blocage réseau retiré ensuite. Les captures du dialogue et de la tentative dégradée sont visibles dans l'échange de contre-recette ; les captures Sol de artifacts/t5-visual/ sont préservées.

L'onglet créé a été fermé et l'override de viewport supprimé. Les cinq processus de fixture (ports 43179–43183), leurs bases temporaires et la copie visuelle ont été supprimés ; absence de listeners sur ces ports vérifiée. Aucun onglet personnel, dashboard/observateur personnel, compte, credential, config.local.json ou état opérationnel manipulé. Aucun appel GitHub/modèle réel, commit ou push. Seuls ce journal et la sonde indépendante sont ajoutés/modifiés par cette passe. Ce verdict n'est pas une validation exhaustive de doctor ou de tous les états de panne UI.

## Corrections des six écarts T5 — 12 septembre 2026

Corrections réalisées à la demande explicite de l'utilisateur. Les sondes de contre-recette ont été rejouées avant modification applicative : **1 témoin vert, 3 régressions backend rouges**. Elles sont maintenant dans `test/t5-counter-acceptance.test.mjs` et exécutées par `npm test`.

1. `src/scheduling-view.mjs` valide les objets JSON et les types des scalaires publics d'assignment, des phases/modes persistés et de la preuve avant spawn. Un objet/tableau inattendu ne traverse plus le DTO. Les erreurs de parsing/type ont un message fermé, sans extrait de JSON : HTTP 503 filtrée et CLI en échec sans fuite des canaris. Les propriétés internes non autorisées restent exclues.
2. Le snapshot read-only englobe désormais aussi la vérification du schéma. `status` lit les colonnes historiques des jobs même lorsque le schéma scheduling manque ; `available` décrit cette lecture et `scheduling.available` reste indépendant. Aucun fichier, table ou ligne métier n'est créé/modifié par la consultation.
3. Les candidats et le détail d'un job valident task_metadata_json avant toute prévision. Le JSON illisible produit une erreur explicite plutôt qu'un faux execute. Les règles d'admission et requirementsFor de T4 restent inchangés.
4. `SchedulingPanel.tsx` affiche modèle **et effort** demandé/configuré pour chaque tentative. La dégradation Sol high → Sol medium est lisible même avec un modèle identique.
5. Badge et dialogue partagent une référence au relevé de prévision : source, ID et date avec fuseau, distincte des dates des jauges. Les dates absentes ou invalides restent inconnues. La présentation conserve le badge sur la seule carte cible.
6. Les chemins d'import et de racine de `scripts/t5-dashboard-fixture.mjs` sont corrigés. Le mode conserve inclut maintenant une admission historique simulée high → medium, sans appel executor. La fixture accepte un port éphémère pour les tests et un arrêt IPC permettant la vérification de son nettoyage. Le lancement depuis un autre répertoire, le service des assets compilés et le contenu historique de l'API sont testés.

README et documentation dashboard complétés pour les états de disponibilité, les erreurs filtrées, les efforts/provenance visibles et la commande de fixture.

Validation exécutée :

- Régressions ciblées enrichies : **7/7 réussies** (lecture seule/historique, compatibilité status y compris CLI, corruption metadata, canaris HTTP, types imbriqués/diagnostics CLI, erreurs HTTP de corruption, lancement/nettoyage réel de fixture).
- Suite finale `npm test` : **122/122 réussis**, mutations T4/T5 comprises. La première suite avait donné 121/122 à cause d'un EACCES sur le port du test historique de verrou OS ; ce test est passé en relance ciblée puis dans la suite complète finale, sans modification de son code ni des réglages système.
- `npm run dashboard:build` : réussi (TypeScript/Vite) ; `node --check` des trois modules/tests JS corrigés et `git diff --check` : réussis, avertissements LF/CRLF habituels.
- Chrome connecté par l'utilisateur, fixture corrigée lancée directement depuis scripts/ : badge avec « Relevé de la prévision #2 : 12/09 20:00 UTC+2 · source lite », historique avec « Demandé : gpt-5.6-sol · high » et « Configuré : gpt-5.6-sol · medium ». Inspection desktop 1440 px et mobile 390 px ; dialogue/page sans débordement horizontal, contenu lisible. Capture mobile visible dans cet échange.

Les six écarts de cette contre-recette sont corrigés dans leur périmètre. Fixture manuelle et base temporaire nettoyées, port 43179 libéré, onglet de validation fermé et viewport rétabli. Aucun service personnel, compte, credential, config.local.json ou état opérationnel utilisé ; aucune génération ou requête GitHub réelle. T6 préservée sans implémentation. Base toujours `074a03d`, changements non commités, aucun push.

## Livraison Git T5 — 12 septembre 2026

Commit et push demandés explicitement par l'utilisateur après correction. Branche retenue : `feat/quota-aware-foundations`, qui porte déjà T4 ; synchronisation avec origin vérifiée avant livraison, sans divergence. Le lot comprend T5, les six corrections et leurs tests, la fixture et les captures de recette, ainsi que la documentation T5/T6 déjà préparée. T6 reste une spécification sans implémentation. Validation de référence : suite finale 122/122, build dashboard et contre-recette Chrome réussis ci-dessus. Aucun fichier de configuration personnelle ni état opérationnel inclus.
