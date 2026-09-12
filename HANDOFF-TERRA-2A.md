# Handoff Terra — tranche 2A

## Mission

Implémenter et livrer uniquement [TRANCHE-2A-SPEC.md](TRANCHE-2A-SPEC.md) : classification explicite des tâches, contrat `pilot-task`, persistance minimale et vérification de la spécification figée.

La tranche 1 est terminée et validée par Astra. Lire d’abord [JOURNAL-SOL-IMPLEMENTATION.md](JOURNAL-SOL-IMPLEMENTATION.md), puis la spec 2A. [TRANCHE-2B-SPEC.md](TRANCHE-2B-SPEC.md) décrit la suite mais reste hors scope : ne pas l’implémenter automatiquement.

Ne pas reprendre les discussions OpenHands/ACP, ne pas demander de récapitulatif et ne pas concevoir le scheduler complet. Signaler seulement une contradiction concrète entre la spec 2A et le code.

## État du dépôt

- Dépôt : `C:\Users\trist\PhpstormProjects\codex-github-pilot`.
- Base actuelle constatée avant ce handoff : `8807986`.
- La tranche 1 est présente dans le worktree mais n’est pas encore commitée au moment de la rédaction.
- Fichiers de tranche 1 modifiés : `src/cli.mjs`, `src/observation.mjs`, `src/runner.mjs`, `test/pilot.test.mjs`.
- Fichiers de tranche 1 nouveaux : `src/process.mjs`, `src/executors/codex.mjs`.
- Les documents de conception et handoffs sont non suivis. Les préserver.
- `config.local.json` et `state/` sont locaux et ignorés. Ne pas les lire, modifier ou ajouter.
- Des services locaux peuvent tourner. Ne pas arrêter ou redémarrer worker, observateur ou dashboard.

Refaire `git status` et `git rev-parse --short HEAD` au démarrage : l’état peut avoir évolué depuis la rédaction.

## Résultat fonctionnel attendu

Les commandes existantes continuent à être mises en file et exécutées comme avant, avec `task_class=unclassified`.

Une commande peut désormais commencer sa demande par un bloc strict :

````text
/agent sol-implement sol-medium
```pilot-task
{
  "class": "mechanical",
  "executionContract": {
    "scope": "Modifier un périmètre explicite.",
    "expectedResult": "Décrire le résultat observable.",
    "invariants": ["Préserver le comportement extérieur au périmètre."],
    "areas": ["src/example.mjs"],
    "acceptanceCriteria": ["Le cas demandé est couvert."],
    "validationCommands": ["npm test"]
  }
}
```
Texte complémentaire.
````

Le Pilot persiste la classe et le contrat. Un bloc réservé malformé crée un job `invalid` sans démarrer d’agent. Une modification ultérieure du commentaire ou, lorsqu’un contrat existe, du titre/corps de l’issue annule le job avant auth et checkout.

## Décisions déjà prises

- Quatre classes exactes : `mechanical`, `routine`, `complex`, `exploratory` ; absence = `unclassified`.
- Aucun champ ou alias `luna-ready`.
- JSON strict, 16 Kio UTF-8, champs inconnus refusés, contrat facultatif mais strict lorsqu’il existe.
- Fence réservé seulement lorsqu’il constitue la première ligne non vide de la demande.
- `jobs.request` reste intégral pour la détection des modifications.
- Trois colonnes SQLite seulement dans cette tranche : `task_class`, `task_metadata_json`, `specification_hash`.
- Le hash de spécification est calculé seulement pour un contrat présent.
- `validationCommands` est transmis comme donnée ; le scheduler/runner ne l’exécute jamais.
- Aucun rôle/profil/config scheduling ajouté dans 2A.

## Fichiers à modifier

- Créer `src/task-classification.mjs` avec fonctions pures et JSDoc.
- Modifier `src/core.mjs` pour enrichir `parseCommand` et intégrer la classification dans `poll`.
- Modifier `src/store.mjs` pour la migration minimale et l’enqueue enrichi.
- Modifier `src/runner.mjs` pour la vérification du hash avant auth et pour enrichir l’entrée sérialisable/prompt.
- Adapter et compléter `test/pilot.test.mjs`; créer un fichier de test dédié si cela rend la matrice de validation plus lisible.
- Mettre à jour ce handoff ou créer `JOURNAL-TERRA-2A.md` avec les changements, tests, arbitrages et état Git final.

Ne modifier `src/executors/codex.mjs`, `src/process.mjs`, l’observateur, le dashboard, sa projection ou la configuration que si une régression démontrée de 2A l’exige. Dans ce cas, expliquer précisément pourquoi.

## Invariants de tranche 1 à préserver

- Une seule résolution de profil ; l’executor applique exactement l’affectation.
- Executor sans Store, GitHub, credential ou publication.
- Auth avant préparation Git, environnement filtré et arguments de sécurité inchangés.
- Même contrôle PR/SHA/HEAD/diff suivi et mêmes artifacts.
- Publication séparée, idempotente et jamais suivie d’une seconde exécution ambiguë.
- Même télémétrie et même comportement `quotaPaused`/`quota_wait`.
- Aucune migration ou donnée des lots quota-aware ultérieurs.

## Méthode de livraison

1. Établir la baseline avec `npm test` avant modification.
2. Implémenter les fonctions pures et leurs tests de table.
3. Ajouter la migration Store et les tests de compatibilité/idempotence.
4. Raccorder poll, runner et prompt sans élargir le scope.
5. Exécuter la suite complète et `git diff --check`.
6. Relire le diff contre `TRANCHE-2A-SPEC.md` et consigner le résultat.

Ne lancer aucun Codex réel, `run --once`, appel de publication GitHub ou test dépendant du quota personnel. Utiliser les doubles existants.

## Critères d’arrêt

La tranche est terminée lorsque tous les tests 2A et historiques passent, que les anciennes commandes gardent leur comportement et qu’aucun élément de 2B n’a été introduit.

Pas de commit/push sans demande explicite dans la session d’implémentation. Ne pas utiliser `git add .` : les documents non suivis préexistants ne doivent pas être embarqués machinalement.
