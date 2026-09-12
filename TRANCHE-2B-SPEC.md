# Tranche 2B — rôles, profils, cible locale et persistance d’audit

## Prérequis

La tranche 2A doit être intégrée et validée. Adapter cette spécification à son état final sans réimplémenter son parseur ou ses migrations.

## Objectif

Faire évoluer les données historiques rôle/profil vers les objets nécessaires au futur scheduler et préparer leur audit SQLite. La policy reste désactivée et aucun choix quota-aware n’est encore effectué.

À la fin de 2B, Pilot sait décrire la demande, les capacités volontairement offertes par sa cible Codex locale et l’affectation effective. Avec `scheduling.enabled: false`, les commandes historiques conservent exactement leur exécution actuelle.

## Rôles et contraintes

Dans `src/core.mjs`, chaque rôle porte explicitement :

- `functionalRole` ;
- `requiresPr` ;
- `mayChangeTrackedFiles` ;
- `instruction` ;
- profil par défaut ou modèle/effort historique nécessaire à `executionFor`.

Conserver les alias existants :

| Alias | Rôle fonctionnel | Contraintes |
| --- | --- | --- |
| `sol-implement` | `implementation` | issue ou PR ; diff suivi permis |
| `sol-review` | `review` | PR obligatoire ; aucun diff suivi |
| `astra-review` | `review` | PR obligatoire ; aucun diff suivi ; Astra explicite jamais dégradé automatiquement |

Ajouter `sol-plan` : rôle `specification`, issue ou PR, aucun diff suivi, Sol medium par défaut. Avec un bloc explicite, seules `complex` et `exploratory` sont admises ; sans bloc, la classe reste `unclassified`. Il produit un rapport de découpage dans le schéma existant et ne crée aucun sous-job.

Remplacer dans le runner les comparaisons répétées aux noms de rôles par ces contraintes. Conserver tous les contrôles Git et de publication existants.

## Profils

Registre public :

- `sol-medium` → `gpt-5.6-sol`, medium ;
- `sol-high` → `gpt-5.6-sol`, high ;
- `astra-low` → `gpt-6-astra`, low ;
- `terra-medium` → `gpt-5.6-terra`, medium ;
- `luna-medium` → `gpt-5.6-luna`, medium.

Profil interne : `luna-reserve-medium` → `gpt-reserve`, medium. Il ne doit jamais être accepté dans une commande GitHub.

`executionFor(job)` résout uniquement la demande historique et explicite. Il ne lit ni quota, ni observation, ni Store et ne choisit aucune dégradation.

## Configuration et cible locale

Ajouter un bloc optionnel `scheduling` à `loadConfig`. En son absence, matérialiser les valeurs par défaut suivantes :

```json
{
  "enabled": false,
  "conserveAtPercent": 15,
  "survivalBelowPercent": 5,
  "maxObservationAgeSeconds": 180,
  "quotaErrorCooldownSeconds": 300,
  "survivalPlanTimeoutMinutes": 10,
  "offeredProfiles": ["sol-medium", "sol-high", "astra-low", "terra-medium", "luna-medium"],
  "reserveEnabled": false
}
```

Validation stricte : booléens ; `0 < survivalBelowPercent < conserveAtPercent < 100` ; âge entier 30..900 ; cooldown entier 30..3600 ; timeout entier 1..120 ; liste non vide, sans doublon, composée de profils publics. Reserve exige `enabled: true` et `luna-medium` offert.

Créer une simple fonction de construction de cible, sans classe ni registre :

```text
id: local-codex
provider: openai
adapter: codex-exec
capacityScopeId: local-codex-account
offeredProfiles: configuration validée
```

Ne pas ajouter worker UUID, offer ID séparé, endpoint, découverte réseau ou configuration générique de provider.

## Persistance d’audit

Migrations additives et idempotentes :

- compléter `jobs` avec `last_schedule_decision_id` et `deferred_since` ;
- compléter `account_observations` avec `capacity_scope_id DEFAULT 'local-codex-account'` et `capabilities_json` ;
- créer `scheduling_decisions`, `quota_incidents` et `scheduling_overrides` selon la section 10.8 de la spec principale, avec clés, index et contraintes utiles ;
- compléter `worker_runs` avec les identités et valeurs effectives prévues par 10.8 : décision, cible, provider, adapter/version, scope, modèle effectif, effort demandé, sandbox effective, pool quota, modèle observé et `execution_input_json`.

Les anciennes lignes restent lisibles avec les règles : effectif = `model_effective ?? model_requested`, cible/provider/adaptateur historiques = null ou `legacy-local`. Ne fabriquer aucune décision pour l’historique.

Étendre `startRun` afin de recevoir l’affectation structurée et l’entrée figée, puis persister les champs correspondants. Conserver l’identifiant de session fournisseur distinct de l’identifiant `worker_run`.

La tranche peut fournir les opérations Store minimales nécessaires aux futurs lots, mais ne doit pas écrire de fausses décisions, ouvrir d’incident ou appliquer d’override.

## Comportement lorsque la policy est désactivée

- Affectation statique identique à la tranche 1.
- Même modèle, effort, sandbox et timeout pour chaque commande historique.
- `quotaPaused` et `quota_wait` conservent leur comportement historique.
- Aucun job n’est automatiquement `deferred`.
- Aucune observation supplémentaire, aucun appel `model/list` et aucun changement du dashboard.
- Les nouveaux profils explicites sont soumis aux mêmes validations de sécurité de l’adaptateur Codex.

## Tests obligatoires

- Matrice des rôles et contraintes, dont `sol-plan` sur issue et refus de diff suivi.
- Profils historiques inchangés ; Terra/Luna publics acceptés ; Reserve refusé depuis GitHub.
- Config absente, config valide et chaque famille d’erreurs de validation.
- Construction déterministe et sérialisable de la cible locale.
- Migrations répétées, ancienne base lisible, aucune décision historique inventée.
- `worker_runs` distingue demandé/effectif et persiste cible/provider/adapter/scope/input sans secret ni chemin absolu.
- Policy désactivée : exécution historique identique, aucun report/defer/incident/override.
- Suite complète de 2A et de la tranche 1 toujours verte.

## Hors périmètre

Pas de `capacity.mjs`, `codex-policy.mjs` ou `scheduler.mjs`. Pas de phases quota, de matrice de routage, de catalogue `model/list`, d’admission par décision, de reprise de jobs différés, de commandes override, d’API scheduling ou de dashboard scheduling. Aucun ACP, executor distant ou concurrence supplémentaire.

## Validation

Exécuter `npm test`, les vérifications syntaxiques et `git diff --check`. Le dashboard n’a pas besoin d’être construit si ses fichiers restent inchangés. Aucun worker réel ni consommation de quota.
