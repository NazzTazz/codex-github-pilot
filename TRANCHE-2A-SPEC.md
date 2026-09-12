# Tranche 2A — classification explicite et contrat d’exécution

## Objectif

Ajouter au Pilot une représentation déterministe et persistée de la nature d’une tâche, sans introduire de décision de scheduling, de lecture de quota ou de nouveau modèle.

À la fin de la tranche, les commandes historiques restent valides et deviennent `unclassified`. Une commande peut fournir un bloc `pilot-task` strict. Le Pilot conserve sa classe et son contrat, rejette le bloc réservé malformé sans lancer de worker, et annule l’exécution si la spécification GitHub figée a changé.

## Périmètre

### Nouveau module `src/task-classification.mjs`

Exposer des fonctions pures avec JSDoc, sans classe abstraite :

- `parseTaskMetadata(request)` retourne une structure discriminée `absent`, `valid` ou `invalid` ;
- `validateExecutionContract(value)` retourne un objet normalisé ou produit une erreur de validation stable ;
- `specificationHash(issue)` calcule le SHA-256 hexadécimal UTF-8 de `JSON.stringify({version:1,title:issue.title ?? '',body:issue.body ?? null})`, avec cet ordre de propriétés exact.

Classes exactes : `mechanical`, `routine`, `complex`, `exploratory`. `unclassified` est la valeur persistée lorsqu’aucun bloc réservé n’est présent. Ne pas accepter d’alias comme `standard`, `architectural` ou `luna-ready`.

### Syntaxe `pilot-task`

La première ligne `/agent ROLE [PROFILE]` reste inchangée. Dans le texte qui suit, ignorer les lignes vides initiales. Un bloc réservé existe seulement si la première ligne non vide est le fence d’ouverture `pilot-task` montré dans l’exemple normatif ci-dessous. Parser le contenu jusqu’à une ligne composée d’exactement trois accents graves. Aucun espace initial ou final n’est accepté sur les deux fences.

````text
```pilot-task
{"class":"routine"}
```
````

- Taille maximale du contenu JSON : 16 Kio mesurés avec `Buffer.byteLength(value, 'utf8')`.
- JSON standard via `JSON.parse`, sans YAML ni parseur maison.
- Objet racine uniquement ; champs autorisés : `class`, `executionContract`.
- `class` est obligatoire et doit appartenir aux quatre classes exactes.
- `executionContract` est facultatif. Sa présence ne modifie jamais la classe déclarée.
- Après la fermeture, le texte restant demeure dans la demande.
- Un fence situé après du texte ordinaire n’est pas réservé et reste du texte de tâche.
- Fence d’ouverture reconnu mais fermeture absente, JSON invalide, contenu trop gros ou schéma invalide : classification `invalid`.

Le contrat accepte exactement :

- `scope` et `expectedResult` : chaînes non vides après trim ;
- `invariants`, `acceptanceCriteria`, `validationCommands` : tableaux non vides de chaînes non vides ;
- `areas` : tableau facultatif de chaînes non vides, éventuellement vide.

Refuser les champs inconnus à tous les niveaux, les objets avec tableau à la place d’un objet, les mauvais types et les chaînes composées d’espaces. Normaliser les chaînes par trim. Les commandes de validation restent des données destinées à l’agent ; Pilot ne les exécute pas.

### Intégration dans `src/core.mjs`

`parseCommand` doit continuer à retourner `null` pour un texte qui n’est pas une commande reconnue. Pour une commande reconnue, conserver `role`, `profile` éventuel et `request` intégral, puis ajouter :

- `taskClass` : classe explicite ou `unclassified` ;
- `taskMetadata` : objet normalisé version 1 ou `null` ;
- `classificationError` : code fermé ou `null`.

La forme normalisée exacte de `taskMetadata` est `{version:1,class,executionContract}`, avec `executionContract:null` lorsqu’il est absent. `task_metadata_json` contient `JSON.stringify(taskMetadata)` pour un bloc valide et reste null pour une commande historique ou invalide.

Codes d’erreur minimum : `pilot-task-unclosed`, `pilot-task-too-large`, `pilot-task-json-invalid`, `pilot-task-schema-invalid`.

Les propriétés historiques attendues par les tests peuvent évoluer vers cette forme enrichie dans la même tranche ; les consommateurs doivent toutefois conserver le même comportement pour les commandes anciennes.

Dans `poll` :

- effectuer les contrôles d’auteur et d’activation existants avant toute mise en file ;
- pour une classification valide ou absente, enregistrer le job avec son `taskClass` et ses métadonnées ;
- pour un bloc réservé invalide, enregistrer un job terminal `invalid`, avec `task_class='unclassified'`, métadonnées/hash null et le code fermé dans `jobs.error`, sans worker run et sans commentaire automatique ;
- toujours marquer le commentaire comme vu selon la sémantique actuelle ;
- calculer `specificationHash` seulement lorsqu’un `executionContract` est présent.

Conserver dans `jobs.request` l’intégralité du texte situé après la ligne de commande selon la normalisation historique de `parseCommand` ; ne pas en retirer le fence ou le JSON. Cela maintient la vérification exacte lors de la relecture du commentaire.

### Migration minimale dans `src/store.mjs`

Ajouter de façon idempotente :

- `jobs.task_class TEXT NOT NULL DEFAULT 'unclassified'` ;
- `jobs.task_metadata_json TEXT` ;
- `jobs.specification_hash TEXT`.

Étendre `enqueue` pour accepter ces valeurs et un statut initial `queued` ou `invalid`. Ne modifier aucune ligne historique : la valeur par défaut suffit. Aucun autre champ ou table de la section 10.8 n’appartient à 2A.

### Vérification avant exécution

Dans `runJob`, conserver les vérifications actuelles du commentaire. Lorsqu’un job possède `specification_hash`, recalculer le hash depuis l’issue relue juste avant authentification et préparation Git. Une différence annule le job avec un message explicite et ne lance ni auth ni executor.

Faire entrer `taskClass`, `taskMetadata` et le contrat normalisé dans l’`executionInput` sérialisable. Aucun Store, client GitHub, callback, credential ou chemin absolu ne doit apparaître.

Le prompt doit présenter le contrat comme données de tâche et demander à l’agent de rapporter les validations. Il ne doit pas exécuter automatiquement `validationCommands` depuis le scheduler ou le runner.

## Tests obligatoires

- Commandes historiques sans bloc, avec et sans profil.
- Chacune des quatre classes.
- Contrat complet valide et contrat absent.
- `complex` avec contrat reste `complex`.
- Fence après du texte ordinaire ignoré.
- JSON invalide, fermeture absente, taille supérieure à 16 Kio, champs inconnus, tableaux vides, chaînes vides et mauvais types.
- UTF-8 compté en octets à la limite de taille.
- Auteur interdit et bot ignorés comme aujourd’hui.
- Bloc invalide persisté `invalid`, commentaire vu, aucun `worker_run`.
- Migration répétée et lecture d’une ancienne base : lignes historiques `unclassified`.
- Métadonnées sérialisées puis relues sans perte.
- Changement du commentaire, du titre ou du corps avec contrat : annulation avant auth/executor.
- `executionInput` sérialisable et sans chemin/secret.
- Toute la suite existante reste verte.

## Hors périmètre

Aucun nouveau rôle ou profil, aucune configuration `scheduling`, aucune cible/offre, aucune observation de catalogue, aucune phase premium/conserve/survival/reserve, aucun choix de modèle, aucun état `deferred`, aucune décision/incident/override, aucun changement du dashboard.

## Validation

Exécuter `npm test`, les vérifications syntaxiques des fichiers touchés et `git diff --check`. Aucun worker Codex réel, aucune commande `run --once`, aucune publication GitHub et aucune consommation de quota.
