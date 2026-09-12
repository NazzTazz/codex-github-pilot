# T2.5 — Observation multi-compte locale

Contrat d'implémentation pour Sol — 12 septembre 2026.

## Objectif et périmètre

Afficher simultanément dans Pilot les quotas des comptes Plus et Pro Lite, sans logout/login du terminal de travail. Une seule installation Codex CLI suffit ; chaque compte observé utilise un `CODEX_HOME` distinct et une connexion initiale propre.

Cette tranche précède T3/T4 et extrait uniquement la partie observation de la [spec multi-compte](local-multi-account-workers-spec.md). Elle ne crée pas deux workers d'exécution : elle configure plusieurs sources de quotas pour les futurs workers. Elle prévaut sur les prescriptions de relais de cette spec pour son périmètre limité.

Hors périmètre : changement de compte d'exécution, relais, alerte décisionnelle sous 10 %, scheduler, catalogue `model/list`, sélection de modèle, activation Luna Reserve/Spark, reprise de tâche, concurrence de jobs, API de mutation et authentification depuis le dashboard. Ne modifier ni l'admission, ni `quotaPaused`, ni les assignments du runner.

## État de départ et précautions

Branche de travail : `feat/quota-aware-foundations`. Fondations 1/2A/2B validées avec 57 tests ; refaire la baseline et inspecter les modifications présentes. Lire le journal et préserver le travail existant. Les commits `6ec127a` et `eb25ce7` constituent la base connue.

Ne pas lire/copier les credentials, modifier `config.local.json`, ni arrêter ou redémarrer les services personnels pour développer. Les tests utilisent des transports simulés et des bases temporaires. Ne pas lancer de génération réelle. La configuration et les connexions réelles sont une étape utilisateur distincte, documentée à la livraison.

## 1. Configuration d'observation

Ajouter un bloc optionnel `observation`, indépendant de `scheduling` :

```json
{
  "observation": {
    "defaultAccountId": "plus",
    "accounts": [
      {"id": "plus", "label": "Plus", "codexHome": "C:/Users/trist/.codex-plus"},
      {"id": "lite", "label": "Pro Lite", "codexHome": "C:/Users/trist/.codex-pro-lite"}
    ]
  }
}
```

Les comptes partagent `codexCommand` existant. Ne pas introduire de commande shell libre ou d'executor par compte dans cette tranche.

Validation stricte : bloc objet ; seules les clés documentées sont admises ; `accounts` tableau non vide ; IDs uniques correspondant à `[a-z0-9][a-z0-9_-]{0,63}` ; libellés non vides de 80 caractères maximum ; `codexHome` chemin absolu non vide ; `defaultAccountId` désigne un compte configuré. Rejeter types invalides et valeurs nulles explicites, sans appliquer silencieusement les valeurs par défaut. Résoudre les chemins localement, sans expansion implicite de `~` ou de variables dans une chaîne.

Sans bloc, conserver exactement le mode historique : une source `local`, scope `local-codex-account`, environnement Codex hérité, mêmes commandes et même connexion. Le chemin explicite est obligatoire seulement pour les nouvelles entrées multi-compte. Plusieurs entrées ayant le même dossier résolu doivent être refusées, avec comparaison adaptée à Windows ; deux dossiers différents connectés au même compte sont traités comme quota partagé, voir section 3.

Le compte par défaut sert uniquement aux lectures de compatibilité ; il ne sélectionne jamais le compte d'exécution.

## 2. Environnement et collecte

Passer un environnement propre au constructeur `ObservationClient` et à sa fabrique de test. Pour une source explicite, injecter son `CODEX_HOME` uniquement dans l'environnement de son processus enfant, après le filtrage existant. Ne jamais modifier `process.env` ou l'environnement Windows global. Ne pas réutiliser un client app-server entre deux sources.

`collectObservation` reçoit la source explicite et persiste son identité même si initialize/auth/lecture échoue. Conserver le protocole en lecture seule et les protections contre les réponses trop grosses, erreurs et processus orphelins. Aucun login/logout automatique ; le rafraîchissement normal des credentials par Codex reste celui du fournisseur.

Un seul observateur Pilot possède le verrou existant et collecte toutes les sources configurées à chaque cycle. Jusqu'à deux collectes concurrentes, résultats indépendants et timeouts bornés ; une erreur Plus n'annule pas la collecte Lite. Cette concurrence concerne seulement les observations. Les insertions SQLite restent courtes, après les réponses, sans transaction réseau. Conserver cadence minimale, arrêt gracieux et absence de cycles superposés.

`observe` réalise un cycle complet ; `observe --watch --interval 60` répète les cycles. En mode ponctuel, retourner un code non nul si une source échoue ou est partielle, après avoir sauvegardé et affiché tous les résultats. En mode watch, poursuivre les cycles malgré les erreurs. `stop-observe` arrête l'ensemble des collectes du processus après les opérations bornées en cours ; ne touche pas au worker. `start-observer.ps1` doit continuer à fonctionner sans lancer un processus par compte.

## 3. Persistance et identité réelle

Migration additive/idempotente de `account_observations` : `observation_source_id TEXT NOT NULL DEFAULT 'local'`. Les anciennes lignes gardent leur scope historique et ne sont pas réattribuées à `plus` ou `lite` selon leur plan.

Chaque source explicite utilise un scope stable `codex-observation:<id>` pour retrouver ses propres séries, indépendamment de l'ordre de configuration. Ce scope de source n'est pas la preuve d'un quota distinct : le compte réel est identifié par `account_key`, pseudonyme déjà produit par l'observateur. Ne pas dériver l'identité réelle du libellé ou du nom commercial du plan.

Deux sources authentifiées au même compte affichent « quota partagé » et la liste des autres sources concernées. Elles ne créent aucun total additionné. La liaison de leurs futurs scopes d'admission au compte canonique appartient au scheduler, hors T2.5 ; ne pas prétendre que le scope de source représente une capacité indépendante.

Un changement d'identité réelle observé sous la même source indique « compte connecté changé » : la nouvelle identité n'hérite ni des tokens ni des jauges de l'ancienne. Une erreur de connexion ne prouve pas un changement d'identité. Les états inconnus restent inconnus.

Calculer les deltas uniquement entre relevés de la même source ET du même compte pseudonyme, jamais entre lignes adjacentes de comptes différents. Pour chaque enveloppe, conserver les contrôles de fenêtre/reset existants. Aucun delta de tokens si compteur absent ou décroissant. La collecte ne change aucun job, incident, override ou sélection.

Étendre les lectures Store par source sans casser `observations(limit)` historique. Les filtres SQL sont paramétrés. Pour la projection dashboard, obtenir le dernier relevé de chaque source configurée, même si une autre source a produit toutes les observations les plus récentes. Ne pas choisir les sources à partir d'un historique global tronqué.

## 4. CLI et API de lecture

`usage --account ID [--json] [--limit N]` filtre une source ; ID inconnu rejeté. Sans filtre, conserver le format historique en mode mono-compte ; en mode multi-compte, identifier explicitement chaque source et afficher le dernier état de chacune. Les deltas restent scoped malgré l'ordre entrelacé des relevés.

Ajouter `GET/HEAD /api/accounts/quota` :

```text
{ serverTime, defaultAccountId, accounts: [
  { id, label, planType, identityStatus, sharedQuotaWith: [sourceId],
    observationId, collectionStatus, collectedAt, quota, usage, errors }
] }
```

Réutiliser la projection sûre de `quotaPayload` pour `quota`, `usage`, erreurs et fraîcheur. `identityStatus` vaut `unknown`, `observed` ou `changed` ; le changement compare le compte du relevé courant au précédent relevé authentifié de la source. `sharedQuotaWith` contient uniquement des IDs de sources, jamais `account_key`. N'affirmer un partage actuel qu'avec des observations d'identité suffisamment fraîches ; sinon l'état reste inconnu.

Le serveur reçoit la configuration d'observation normalisée depuis le CLI. Toutes les sources configurées sont présentes, même sans relevé. Une ancienne base sans colonne de source reste lisible comme `local` ; aucune migration depuis HTTP. Base absente : cartes vides connues via config, sans fausses mesures.

Conserver `/api/quota` pour les clients existants : source historique en mode mono-compte, source `defaultAccountId` en mode multi-compte. Jamais le dernier relevé global d'un compte arbitraire.

Conserver GET/HEAD uniquement, localhost, Host/Origin, CSP et whitelist des assets. Ne pas exposer email, compte brut ou pseudonyme, chemin Codex, credential, données fournisseur brutes ou message d'erreur libre. Les erreurs publiques sont des codes fermés ; les labels configurés sont rendus comme texte.

## 5. Dashboard et enveloppes

Afficher toutes les cartes de comptes simultanément, sans sélection obligatoire pour voir les jauges. Chaque carte montre libellé, plan observé, fraîcheur/date, état de collecte, identité changée éventuelle et quota partagé. Le libellé utilisateur ne vaut pas preuve du plan retourné.

Enveloppes signalées par l'utilisateur, à reproduire dans les fixtures :

| Compte | Jauges |
| --- | --- |
| Plus | Principale 5 h ; principale hebdomadaire |
| Pro Lite | Principale hebdomadaire ; réserve Luna ; Spark 5 h ; Spark globale |

Rendre dynamiquement toutes les enveloppes réellement retournées : pas de nombre fixe, pas de 5 h principale inventée pour Lite, pas de durée présumée pour réserve Luna ou Spark globale. Identifier par `limitId` + fenêtre, jamais par position. Employer les libellés/métadonnées établis ; si une enveloppe n'est pas reconnue, afficher son identifiant et sa durée connue sans lui inventer une fonction. Conserver la déduplication de la vue legacy et de `rateLimitsByLimitId`.

Chaque jauge affiche restant et reset avec fuseau explicite. Distinguer zéro, inconnu, absence, erreur et relevé périmé. Une réussite récente de l'endpoint tokens ne rajeunit pas un quota ancien. Après un échec, ne pas présenter une ancienne valeur comme fraîche ; afficher l'indisponibilité du dernier relevé, ou une ancienne valeur explicitement datée et périmée.

Les tokens restent séparés des pourcentages, propres au compte, sans total multi-compte ou conversion en coût. Une réserve affichée ne devient pas une route exécutable. Aucune mention « worker actif » ou bouton de bascule tant qu'il n'existe pas de liaison opérationnelle au runner. Garder les autres fonctions du dashboard hors de ce chantier.

## 6. Connexion initiale documentée

Documenter une procédure PowerShell pour créer deux dossiers de profil hors dépôt, configurer le stockage d'authentification `file` dans chacun, puis lancer `codex login` et `codex login status` avec l'environnement propre au processus concerné. Sélectionner le bon compte dans le navigateur, au besoin dans deux profils navigateur distincts. Une seule installation CLI, deux sessions persistées.

Le lanceur de connexion doit limiter `CODEX_HOME` au processus enfant, ou restaurer l'environnement précédent via `finally`, y compris après échec. Ne pas utiliser `setx` ni écraser la connexion du terminal actif. Ne pas déplacer ou copier `auth.json` existant. Les deux connexions initiales peuvent être faites séquentiellement ; ensuite aucune permutation de login n'est nécessaire pour surveiller les jauges.

Références : [authentification Codex](https://learn.chatgpt.com/docs/auth), [état local CODEX_HOME](https://learn.chatgpt.com/docs/config-file/config-advanced). Vérifier la procédure avec l'aide de la CLI installée, sans effectuer les connexions personnelles pendant l'implémentation. Livrer un exemple de configuration, jamais les comptes réels ni leurs credentials.

## 7. Recette obligatoire

Utiliser Node:test, transports et horloge injectés, SQLite temporaire, fixtures anonymisées. Les assertions portent sur argv/environnement capturés, lignes persistées et réponses HTTP, pas seulement sur les helpers.

1. Sans configuration : commandes, environnement, scope historique et `/api/quota` compatibles ; suite des 57 tests toujours verte.
2. Configuration : absence valide, chaque mauvais type rejeté, IDs/default invalides, chemins relatifs ou doublons rejetés ; aucune liste invalide remplacée silencieusement par un défaut.
3. Deux sources concurrentes : environnements capturés distincts, aucune fuite de `CODEX_HOME` dans le parent ; clés API/GitHub toujours filtrées ; chaque réponse enregistrée sous la bonne source même si l'ordre de retour est inversé.
4. Timeout/auth absente/erreur d'une source : l'autre persiste et s'affiche normalement ; code CLI ponctuel non nul ; watch continue ; arrêt ferme tous les clients sans processus orphelin.
5. Historique entrelacé : dernier relevé exact de chaque source, deltas de la bonne source/identité ; changement de compte ou compteur décroissant donne delta null ; migration répétée et base ancienne lisibles.
6. Même compte dans deux dossiers : indicateur quota partagé, aucun total doublé ; identités périmées/absentes ne produisent pas de certitude de partage.
7. API : toutes les sources configurées, source par défaut stable, vide/partiel/stale/zéro distincts, dates quota/tokens distinctes, aucun secret/chemin/identité brute dans le JSON ; protections GET/HEAD/Host/Origin maintenues.
8. UI : Plus deux jauges et Lite quatre simultanément ; changement d'ordre des buckets sans changement de sens ; ajout/retrait d'enveloppe ; Spark seule à 5 h sur Lite ; durée inconnue non fabriquée ; panne d'une carte sans disparition de l'autre.
9. Immutabilité opérationnelle : après un cycle multi-compte, jobs, incidents, overrides, `quotaPaused`, configuration d'exécution et environnement parent inchangés. Aucun appel de création de thread, génération, login/logout ou catalogue pendant la collecte.

Pour les protections centrales, démontrer que des mutants échouent : partager l'environnement des deux sources ; prendre le dernier relevé global pour les deux cartes ; calculer les deltas entre comptes. Faire ces mutations uniquement dans une copie temporaire, puis rejouer la version correcte. Consigner le test précis et l'échec observé, sans affirmer un rouge non exécuté.

Validation finale : suite complète, syntaxe des modules touchés, `npm run dashboard:build`, `git diff --check`, contrôle visuel avec fixtures sur un serveur temporaire distinct des services personnels. Ne pas lancer de worker réel ni consommer de quota modèle pour la recette.

## Livraison

Mettre à jour README, exemple de configuration et `JOURNAL-SOL-IMPLEMENTATION.md` : changements, contrats publics, tests réellement exécutés, limites et procédure des connexions initiales. Signaler explicitement si les comptes réels ne sont pas encore configurés : « implémentation validée avec fixtures » n'est pas « deux comptes personnels connectés ».

Critère de succès utilisateur après configuration : ouvrir Pilot, voir les deux comptes et leurs jauges actualisées, continuer la session CLI en cours sans logout/login. Aucun commit/push supplémentaire sans demande ; aucun élargissement à T3/T4 ou au relais.
