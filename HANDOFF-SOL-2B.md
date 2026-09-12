# Handoff Sol — tranche 2B

## Mission

Implémenter et valider uniquement [TRANCHE-2B-SPEC.md](TRANCHE-2B-SPEC.md). La tranche 1 et la tranche 2A sont déjà présentes dans le worktree ; 2A a passé une contre-recette légère après un correctif mineur.

Lire d'abord [JOURNAL-SOL-IMPLEMENTATION.md](JOURNAL-SOL-IMPLEMENTATION.md), puis la spec 2B. Le journal fait office de mémoire de travail permanente pour cette étape : le consulter au démarrage et le mettre à jour avant de rendre la main avec les changements, arbitrages, validations et état Git.

Ne pas reprendre les discussions OpenHands, ACP ou architecture distribuée. Les arbitrages utiles sont déjà incorporés dans la spec. Ne pas concevoir ni implémenter le scheduler quota-aware : 2B prépare ses données et ses frontières, policy désactivée.

## État de départ

- Dépôt : `C:\Users\trist\PhpstormProjects\codex-github-pilot`.
- HEAD constaté lors de la rédaction : `8807986` (`Add local dashboard and account usage observation`).
- Tranches 1 et 2A présentes mais non commitées.
- Baseline après contre-recette 2A : `npm test`, **47/47 réussis** ; vérifications syntaxiques et `git diff --check` réussies.
- Correctif final de 2A : `validateExecutionContract` rejette aussi les tableaux JavaScript creux via `Array.from` ; test de régression inclus.
- Les documents de conception et handoffs sont non suivis. Les préserver.
- `config.local.json` et `state/` sont locaux et ignorés : ne pas les lire, modifier ou ajouter.
- Des services locaux peuvent tourner : ne pas arrêter ou redémarrer worker, observateur ou dashboard.

Au démarrage, refaire `git status --short`, `git rev-parse --short HEAD` et la baseline `npm test`. Un logout/login Codex aura eu lieu entre la rédaction et la reprise ; cela ne justifie aucune modification de configuration ou test réel du compte.

## Résultat attendu

Pilot doit disposer, sans policy active :

- de rôles fonctionnels et de contraintes explicites au lieu de comparaisons de noms dispersées ;
- du nouveau rôle `sol-plan` ;
- des profils publics Terra et Luna, plus un profil Reserve interne inaccessible aux commandes GitHub ;
- d'une configuration `scheduling` strictement validée et désactivée par défaut ;
- d'une cible locale simple et sérialisable ;
- des colonnes et tables d'audit nécessaires aux lots suivants ;
- d'un `worker_run` enregistrant clairement demande, affectation effective, cible et entrée figée.

Avec `scheduling.enabled: false`, le comportement historique doit rester identique : aucun modèle automatiquement remplacé, aucun job différé, aucun incident ou override créé, aucun appel fournisseur supplémentaire.

## Ordre d'implémentation recommandé

1. Établir la baseline et examiner les objets actuels `roles`, profils, `executionFor`, `loadConfig`, migrations et `startRun`.
2. Refactorer les rôles vers les contraintes explicites, puis remplacer dans le runner les comparaisons aux alias. Ajouter `sol-plan` et sa validation de classe.
3. Étendre le registre de profils et verrouiller la distinction public/interne. Vérifier que l'affectation reste résolue une seule fois et que l'executor ne choisit rien.
4. Ajouter et tester la configuration `scheduling`, puis la fonction pure de construction de la cible locale. Ne pas créer de classe, registre ou abstraction générique de worker.
5. Ajouter les migrations d'audit, idempotentes et compatibles avec les anciennes bases. Adapter `startRun` et ses appels pour persister l'affectation et l'entrée sérialisable.
6. Ajouter les tests de non-régression policy désactivée et exécuter la validation complète.
7. Relire le diff contre la spec et compléter le journal.

## Invariants à préserver

- Une seule résolution de profil avant l'appel à l'executor ; modèle, effort, sandbox et timeout de l'affectation arrivent inchangés dans Codex.
- L'executor reste sans Store, GitHub, credential, publication ni logique de quota.
- L'authentification précède le checkout ; environnement filtré et arguments de sécurité inchangés.
- Les protections PR/SHA/HEAD/diff suivi et la séparation publication/exécution restent intactes.
- L'entrée et l'affectation persistées sont sérialisables et ne contiennent ni secret, callback, objet Store/GitHub, ni chemin absolu local.
- L'identifiant de session fournisseur reste distinct de l'identifiant `worker_run`.
- `quotaPaused` et `quota_wait` gardent exactement leur comportement historique.
- Aucune ancienne ligne ne reçoit une fausse décision de scheduling.

## Hors périmètre strict

Ne pas introduire :

- `scheduler.mjs`, `capacity.mjs` ou `codex-policy.mjs` ;
- phases premium/conserve/survival/reserve ou matrice de routage ;
- lecture de quota dans `executionFor` ou dans l'executor ;
- admission, report/reprise automatique, override actif ou incident écrit ;
- modification de l'API ou du dashboard scheduling ;
- catalogue dynamique `model/list` ;
- worker distant, ACP, multi-provider, registry, endpoint ou concurrence supplémentaire ;
- sous-jobs automatiques produits par `sol-plan`.

Une contradiction concrète entre la spec et le code doit être résolue par le changement minimal et documentée dans le journal. Ne pas élargir le scope pour anticiper un futur hypothétique.

## Tests obligatoires

Suivre la matrice de [TRANCHE-2B-SPEC.md](TRANCHE-2B-SPEC.md), avec au minimum :

- rôles, contraintes et `sol-plan` sur issue/PR, y compris refus des classes inadmissibles et du diff suivi ;
- profils historiques strictement inchangés, Terra/Luna publics acceptés et Reserve interne refusé depuis GitHub ;
- configuration absente, valide et toutes les familles d'erreurs de validation ;
- cible locale déterministe et sérialisable ;
- migrations répétées et lecture d'une ancienne base sans décision historique inventée ;
- audit demandé/effectif et identités cible/provider/adapter/scope/input, sans secret ni chemin absolu ;
- policy désactivée : aucune dégradation, aucun defer, incident ou override ;
- suite complète des tranches précédentes verte.

Validation finale : `npm test`, `node --check` sur chaque module/test créé ou modifié, puis `git diff --check`. Le dashboard ne nécessite aucun build si ses fichiers restent inchangés. Ne lancer aucun worker Codex réel, `run --once`, appel GitHub de publication ou test consommant du quota.

## Livraison

La tranche est terminée lorsque la suite est verte, que la compatibilité historique est démontrée et que le journal décrit précisément le diff final et les limites restantes.

Ne pas commit ni push sans demande explicite dans la nouvelle session. Ne pas utiliser `git add .` : le worktree contient plusieurs documents non suivis préexistants.
