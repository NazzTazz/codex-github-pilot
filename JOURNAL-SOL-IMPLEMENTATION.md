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
