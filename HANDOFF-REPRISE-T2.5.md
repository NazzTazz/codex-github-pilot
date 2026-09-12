# Handoff de reprise — T2.5 et comptes Codex

État constaté le 12 septembre 2026, avant fermeture de session et changement du compte CLI habituel.

## Lire en premier

- Branche : `feat/quota-aware-foundations`, suit `origin/feat/quota-aware-foundations`.
- Commits poussés : `6ec127a` (fondations executor/classification/audit 1/2A/2B) et `eb25ce7` (specs et handoffs).
- T2.5 et ses corrections sont dans le worktree, **non commitées et non poussées**. Préserver les fichiers modifiés/non suivis. Ne pas réimplémenter les travaux déjà livrés.
- Références : `TRANCHE-2.5-SPEC.md`, `JOURNAL-SOL-IMPLEMENTATION.md`, `local-multi-account-workers-spec.md`, `quota-aware-scheduling-spec.md`.
- Certaines entrées du journal écrites par Sol annoncent encore HEAD `8807986` : cette indication est périmée. Le HEAD vérifié est `eb25ce7`.

## Objectif utilisateur et limites

L'utilisateur veut surveiller simultanément ses comptes sans logout/login permanent. T2.5 fournit l'observation multi-compte, avant T3/T4. Elle ne sélectionne pas le compte d'exécution, ne fait pas de relais, n'active pas Luna/Spark et ne modifie pas le scheduler ou les jobs.

Le relais futur prévu dans la spec multi-compte est distinct : alerte sous 10 % de weekly principale Lite, décision explicite de l'utilisateur pour consommer Plus, conservation du modèle/effort demandés. Ne pas le confondre avec les comptes simplement observés aujourd'hui.

L'utilisateur souhaite limiter les appels et s'arrêter après configuration : son quota court Plus était épuisé et il signalait consommer des crédits de secours. Ne pas relancer des vérifications coûteuses déjà terminées sans changement qui les justifie. Aucun goal actif demandé.

## Corrections déjà vérifiées

### 2A/2B — dans les commits poussés

- Fences `pilot-task` analysés sur le texte brut, demande persistée conservant la normalisation historique.
- Revalidation du runner : classification invalide, classe ou métadonnées différentes annulent avant authentification/préparation/executor, même si seuls les espaces du fence ont changé.
- `offeredProfiles` : défaut uniquement si propriété absente ; null/false/0/chaîne vide rejetés.
- Exigences : `workspaceWrite` distinct de `mayChangeTrackedFiles`. Review/plan autorisent l'écriture temporaire sans modification des fichiers suivis.
- Contre-recette : 57 tests verts ; retrait du contrôle de classification dans une copie temporaire a bien fait échouer le test d'authentification, rétablissement vert.

### T2.5 — non commitée

- `observation-config.mjs`, sources avec `CODEX_HOME` et IDs distincts ; deux lectures concurrentes maximum, environnement filtré par enfant sans mutation de `process.env`.
- Colonne `observation_source_id`, lectures/deltas par source et identité, API `/api/accounts/quota`, compatibilité `/api/quota` sur source par défaut.
- Dashboard affiche simultanément les sources et leurs enveloppes dynamiques, dates, erreurs, partage éventuel et tokens séparés.
- Les trois mutations centrales ont été reproduites en contre-recette : environnement partagé, delta inter-source, dernier relevé global utilisé pour toutes les cartes. Trois tests rouges sur les copies mutées, trois verts sur le dépôt.
- Correction identité : une panne quota ne remplace plus le hash d'ID fournisseur par celui de l'email. Pendant la panne, identité unknown/null ; après récupération, même compte observed. Test intégré.
- Correction CLI : `observe --json` en mode legacy retourne l'objet historique, multi-compte retourne un tableau.
- Dernière correction faite par cet assistant : la procédure README refuse un `config.toml` déjà présent sans le modifier. L'ajout naïf en fin de TOML plaçait le réglage dans une section MCP. Les profils neufs sont initialisés ; profils existants : configuration manuelle à la racine, documentée.
- Le faux test de présence de mots dans le README a été remplacé par un test exécutant réellement son bloc de configuration PowerShell. Vérifie refus et préservation octet pour octet de deux fichiers existants, puis création correcte d'un fichier neuf. Rouge observé avant correction, vert après. Test ignoré explicitement hors Windows.
- Dernière validation exécutée : **66/66 tests**, syntaxe du test et `git diff --check` verts. Build dashboard réussi pendant la contre-recette ; pas reconstruit après la dernière modification limitée à README/test/journal.
- Le contrôle visuel avec fixtures est consigné par Sol ; cet assistant ne l'a pas répété. Il a vérifié les API réelles après configuration.

## Mise en service réelle terminée

L'utilisateur a créé et connecté deux profils, puis cet assistant a vérifié `codex login status` dans chaque environnement enfant : les deux retournent `Logged in using ChatGPT`.

| Source | Libellé | Dossier local |
| --- | --- | --- |
| `plus` | Plus | `C:/Users/trist/.codex-plus` |
| `lite` | Pro Lite | `C:/Users/trist/.codex-pro-lite` |

Les credentials n'ont pas été lus ou copiés. Les dossiers contiennent leur configuration de stockage `file`, initialisée par l'utilisateur.

`config.local.json` (ignoré par Git) a été modifié avec autorisation utilisateur pour ajouter `observation.defaultAccountId = "plus"` et ces deux sources. Les autres réglages, notamment ceux d'exécution et de publication, sont conservés. Ne pas ajouter ce fichier ni `state/` à Git.

L'observateur et le dashboard ont été arrêtés via leurs commandes dédiées puis relancés via `start-observer.ps1` et `start-dashboard.ps1`. Le worker d'exécution n'a pas été redémarré. Au lancement, PIDs 24372 et 6472 respectivement, mais ce sont des indications historiques à revérifier si nécessaire.

Le dashboard est sur `http://127.0.0.1:4173/`. Avant cette configuration, un ancien serveur servait le frontend reconstruit mais répondait 404 sur la nouvelle API : redémarrage du dashboard a résolu le problème. Si cela revient après une modification serveur, vérifier le statut HTTP avant de conclure à un problème d'authentification.

Dernière lecture réelle du 12 septembre à 12:21:58 UTC (14:21:58 Paris), HTTP 200, les deux sources `ok`, plans retournés `plus` et `prolite`, aucune indication de quota partagé :

| Compte | Enveloppes restantes |
| --- | --- |
| Plus | Principale 5 h : 0 % ; weekly : 84 % |
| Pro Lite | Weekly principale : 100 % ; réserve Luna : 100 % ; Spark 5 h : 100 % ; Spark weekly : 100 % |

Lite retournait quatre fenêtres : `codex/primary` 10080 min, `base_model_inference/primary` nommé `gpt-reserve` 10080 min, `codex_bengalfox/primary` nommé `GPT-5.3-Codex-Spark` 300 min et sa secondary 10080 min. C'est un relevé historique, pas une garantie de quota courant. L'utilisateur avait auparavant signalé Lite épuisé jusqu'au 15 ; le relevé réel à 100 % a été signalé sans en inventer l'explication.

## Changement de compte de la session principale

L'utilisateur ferme cette session pour se connecter à l'autre compte dans son CLI habituel. Conseil donné : nouveau terminal sans `CODEX_HOME` personnalisé, puis `codex logout`, `codex login`, `codex login status`. Les deux profils explicites de l'observateur restent indépendants. Ne pas lancer logout dans l'un de ces profils par erreur.

## Prochaine reprise

Commencer par lire ce handoff et vérifier `git status`. Attendre la demande utilisateur pour la suite : éventuellement commit/push de T2.5, puis T3/T4. Ne pas considérer l'ancien accord de push des fondations comme une demande de publier automatiquement les travaux T2.5.

Si l'utilisateur demande seulement les quotas, utiliser l'API locale ou `usage`, pas une recherche documentaire ni une génération. Les deux comptes sont déjà configurés : ne pas recommencer les connexions. Les futures jauges doivent être déterminées par leurs enveloppes, jamais par un nombre fixe ou une 5 h principale supposée pour Lite.
