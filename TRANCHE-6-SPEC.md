# T6 — GitHub lisible, métadonnées repliées et notice utilisateur

12 septembre 2026. **À implémenter immédiatement après livraison et contre-recette de T5**, avant le premier essai métier accompagné. T5 reste le lot CLI/API/dashboard ; ne pas glisser cette évolution de parsing dans ses corrections. Le dépôt pilote retenu par l'utilisateur est **waar-micro-combat**. Il remplace les exemples précédemment évoqués ; son propriétaire GitHub, son chemin et ses commandes de validation ne sont pas présumés connus.

## 1. Objectif et limites

Garder les issues, PR et commentaires agréables à lire : description métier visible, JSON technique replié par défaut dans le commentaire de commande CGPilot. Le JSON reste visible en développant la section et dans le Markdown brut : ce n'est pas une protection de confidentialité.

Livrer : support strict d'une enveloppe Markdown déterminée, compatibilité avec le fence `pilot-task` existant, notice utilisateur pour brancher CGPilot sur un dépôt existant et checklist de premier essai sur waar-micro-combat. Ne pas ajouter générateur de formulaire, classification par LLM, nouvelle policy, nouveau rôle, second worker ou nouvelle commande de mutation GitHub.

Cette spec autorise seulement l'implémentation dans CGPilot et ses tests sur fixtures. Elle **n'autorise pas** à modifier waar-micro-combat, poster/éditer une issue ou une PR, ajouter un label, connecter un compte, activer un worker ou consommer du quota réel. L'utilisateur branchera personnellement le dépôt ; toute assistance active ultérieure requiert sa demande explicite.

Références : `TRANCHE-5-SPEC.md`, `quota-aware-scheduling-spec.md`, `TRANCHE-2A-SPEC.md`, `src/task-classification.mjs`, `src/core.mjs::parseCommand`, `src/job-validation.mjs` et journal des régressions de fence T2A/T4. Le format repliable repose sur [les sections details/summary documentées par GitHub](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/organizing-information-with-collapsed-sections).

## 2. Format canonique à copier

Le **commentaire de commande**, pas la description métier de l'issue/PR, contient :

````markdown
/agent sol-implement sol-high
<details>
<summary>Métadonnées CGPilot</summary>

```pilot-task
{"class":"routine"}
```

</details>

Réaliser la modification décrite dans l'issue, en conservant les invariants indiqués.
````

La ligne de commande reste visible. La description humaine suit la section repliée ; le corps de l'issue/PR reste libre, sans JSON imposé. L'enveloppe reste au début de la demande pour conserver une lecture déterministe : pas de recherche de métadonnées au milieu d'un texte, d'une citation ou d'un exemple. Ne pas ajouter l'attribut `open`.

Conserver exactement le JSON actuel : class et executionContract éventuel, mêmes clés, classes, contraintes et limites. Le wrapper ne confère aucune permission et ne rend pas un travail éligible à Luna sans contrat valide. Le langage du fence est **pilot-task**, pas json. Ne pas mettre de credentials, chemins d'authentification ou données privées dans cette section.

## 3. Grammaire et compatibilité

Deux formats admis au premier emplacement non vide de la demande après `/agent` :

1. Le fence nu existant : comportement historique inchangé.
2. L'enveloppe canonique : ligne exacte `<details>`, ligne exacte `<summary>Métadonnées CGPilot</summary>`, zéro ou plusieurs lignes vides, fence d'ouverture exact portant le langage `pilot-task` comme dans l'exemple, JSON, fermeture exacte du fence, zéro ou plusieurs lignes vides, ligne exacte `</details>`. Puis le texte humain normal.

LF et CRLF acceptés. Une ligne vide au sens de l'enveloppe est vide ou composée d'espaces/tabulations ; cette tolérance ne s'applique **pas** aux lignes de balises ou de fences. Pas de normalisation HTML, DOM parser, casse alternative, indentation, attribut, balise sur une ligne combinée ou fermeture suffixée d'espaces.

Reconnaissance réservée : le préfixe constitué des deux premières lignes exactes details/summary engage le parsing du format CGPilot. Après ce préfixe, tout fence/JSON/fermeture manquant ou incorrect est **invalid**, jamais un repli silencieux en unclassified. Pas de texte, seconde section ou balise HTML entre le fence et `</details>`. Une chaîne JSON contenant une balise n'est pas une balise structurelle : analyser par lignes/fence, pas par recherche d'une sous-chaîne de fermeture.

Une section details ordinaire avec un autre summary, une enveloppe non canonique avant reconnaissance, une citation ou un bloc situé plus loin reste du texte sans métadonnées, comme aujourd'hui. Documenter cette frontière : seule l'enveloppe canonique est supportée, pas un HTML approximatif. Modifier l'une des deux lignes du préfixe d'un **job déjà classifié** doit être détecté à la revalidation et annuler le job (il ne doit pas être exécuté comme unclassified).

Ne pas rechercher un second bloc dans le texte après le premier : la règle existante « seul le premier emplacement réservé compte » reste inchangée. Une enveloppe imbriquée à l'intérieur de la région structurelle est invalide ; du texte humain après la fermeture n'est pas interprété comme une nouvelle source de métadonnées.

Réutiliser un seul validateur JSON/contrat. Limite existante de **16 384 octets UTF-8 du JSON**, exactement la même pour les deux formats ; ne pas élargir la limite pour compenser le wrapper. Éviter une regex susceptible de backtracking non borné. La taille du texte humain reste régie par les contraintes existantes.

Résultat normalisé identique pour un même JSON dans les deux formats : classe, version interne, contrat et erreurs de schéma. Aucun champ de présentation ajouté aux métadonnées persistées, aucune migration. Ne pas retirer le wrapper de la demande persistée pour « simplifier » les comparaisons : conserver les garanties actuelles de revalidation du texte/classification. La représentation normalisée identique n'autorise pas la modification après mise en file.

## 4. Revalidation de bout en bout

Conserver le parsing du texte **brut** avant trim de la demande. Les défauts passés liés au trim global et aux espaces de fermeture ne doivent pas réapparaître.

Le même parseur doit être utilisé au polling, avant admission et à la validation du runner. Pour une demande devenue invalide, ou dont classe/contrat/demande ont changé : annulation avant auth, checkout et executor au premier contrôle applicable. Une tâche invalide dès le polling reste invalid sans tentative.

Tester explicitement le remplacement nu → replié (et inversement) après mise en file : même JSON mais demande modifiée, donc annulation, pas mise à jour silencieuse. Le hash de spécification de l'issue/PR et sa sémantique actuelle ne changent pas. Ne pas reclassifier les jobs historiques lors de la migration/démarrage.

## 5. Notice utilisateur obligatoire

Créer `docs/NOTICE-UTILISATEUR.md`, en français, liée depuis le README. Ce n'est pas un duplicata du contrat développeur : c'est un parcours exécutable « utiliser CGPilot sur un repository existant ». Utiliser les commandes réellement livrées à la fin de T5 ; vérifier les exemples contre le CLI et le parseur, pas seulement par relecture du texte.

Chapitres minimum :

1. Prérequis réels (versions supportées, Git, Codex CLI, droits GitHub) et distinction des dossiers CGPilot, checkout source et state/runs isolés.
2. Préparer une configuration dédiée, dépôt `OWNER/waar-micro-combat` et chemins en placeholders explicites, authors/label/publication. Ne pas supposer le propriétaire d'après celui de CGPilot. Ne jamais faire copier un secret dans un fichier suivi.
3. Distinguer observation des comptes et source d'exécution ; choix explicite, auth préexistante, vérification par doctor, limites des prévisions schedule et du dashboard. Ne pas présenter le compte par défaut des cartes comme le compte d'exécution.
4. Installer/créer le label d'activation si nécessaire, l'appliquer uniquement au thread choisi ; expliquer exactement ce que setup et poll modifient. Avertir que les commandes anciennes ne sont pas automatiquement rejouées : poster une nouvelle commande au moment approprié.
5. Choisir rôle/profil/classe, avec exemples copiables : commande historique sans métadonnées, routine repliée, mechanical avec contrat complet valide, préparation sol-plan complex. Pour les validations métier inconnues, écrire des placeholders à remplacer, ne pas inventer un `npm test` pour waar-micro-combat.
6. Lancer observe, consulter usage/status/schedule, puis un `run --once` contrôlé ; expliquer queued/deferred/running/quota_wait/completed et différence entre préparation, génération et publication.
7. Lire la prévision et l'admission réelle, localiser les résultats et le checkout, inspecter diff et fichiers non suivis, valider le travail avant transfert manuel. Aucun commit/push/merge automatique par le worker ; ne pas proposer de copie écrasant les modifications locales du dépôt source.
8. Overrides économiques avec raison, incidents/cooldown, limites de resume-quota, retry/recover et arrêt ; aucune reprise automatique d'une implémentation partielle. Expliquer la réserve expérimentale et opt-in.
9. Désactivation/retour au mode historique : les deferred peuvent redevenir candidats hors économie T4, donc arrêt et inspection de la file avant changement. Dépannage : serveur absent, identité/catalogue inconnus, mauvais scope, commentaire supprimé, absence de tâche admissible.

La notice doit montrer la version repliée comme format recommandé et préciser la compatibilité du fence nu. Ajouter une capture ou illustration de rendu contrôlé si utile, sans faux résultat d'exécution réelle.

## 6. Préparation du premier essai métier : waar-micro-combat

Créer `docs/RECETTE-WAAR-MICRO-COMBAT.md` : checklist avec cases et preuves à remplir par l'utilisateur, pas un compte rendu prérempli de succès.

- Confirmer propriétaire/URL, chemin local, branche de travail, état Git, droits, commandes de validation et absence de données que l'utilisateur ne veut pas transmettre au modèle. Ne rien découvrir/modifier automatiquement dans ce dépôt à cette tranche.
- Choisir stateDirectory dédié, publication false, réserve false initialement, une cible d'exécution explicite, une seule tâche active. Vérifier qu'aucun ancien job du state réutilisé ne peut partir : préférer un nouvel état dédié sans effacer l'ancien.
- Choisir avec l'utilisateur une petite tâche utile, bornée et vérifiable, puis un profil/classe adapté ; ne pas inventer la tâche métier et ne pas promettre un modèle exact si la policy peut le dégrader. Le JSON replié doit être inspectable et le texte lisible.
- Après initialisation correcte du polling, poster la nouvelle commande choisie ; poll, vérifier la file et schedule, puis autoriser run --once. Si defer, s'arrêter et comprendre le motif ; aucun épuisement artificiel, changement de compte ou override implicite pour forcer le test.
- Comparer demandé, prévu et configuré ; relever IDs job/run/décision/relevé, état final, validations métier et emplacement des artifacts. Vérifier source d'exécution et absence de publication involontaire.
- Faire inspecter le résultat par l'utilisateur, arrêter le worker à la fin et décider explicitement de transférer ou non les changements. Documenter toute surprise sans relancer automatiquement.

La recette réelle est une étape ultérieure, exécutée avec l'utilisateur. La livraison T6 ne dépend pas d'une dépense de quota réelle ; distinguer « prêt à tester » de « validé sur waar-micro-combat ».

## 7. Tests et livraison

| Groupe | Preuves obligatoires |
| --- | --- |
| Parsing | JSON identique nu/replié → même metadata ; LF/CRLF ; lignes vides ; toutes classes ; contrat complet/invalide ; tailles 16 384 et 16 385 octets UTF-8. |
| Structure | Préfixe reconnu puis fence/fermeture manquants, espaces de suffixe, nesting/texte structurel → invalid ; section ordinaire/quote/exemple hors position → absent ; JSON contenant des chaînes details sans fermeture prématurée. |
| Intégration | Vrai parseCommand → poll → SQLite → admission/runner simulés. Invalide sans worker_run ; modification du préfixe, summary, fence, fermeture, classe, contrat ou conversion de format après queue → annulation avant auth/checkout/executor. Inclure un témoin inchangé qui atteint le faux executor. |
| Non-régression | Ancien fence exact, commandes sans bloc, hash issue/PR, planchers Luna, override et les deux P1 T4 restent verts. Aucun reclassement persistant. |
| Notice | Extraire les exemples copiables et les faire parser ; vérifier les commandes contre le CLI/help livré avec processus simulés. Tous placeholders clairement signalés ; aucune connexion ni mutation GitHub pendant les tests documentaires. |
| Rendu | Fixture repliée par défaut, texte humain visible et JSON accessible en développant ; capture et provenance du moteur de rendu. Une preview locale n'est pas une preuve de rendu GitHub réel. Ne pas publier sur GitHub pour la recette sans autorisation. |

Mutation isolée obligatoire : trim du fence/fermeture réintroduit → la régression dédiée doit échouer ; restaurer → verte. Une simple assertion sur une chaîne de source ne suffit pas. `npm test`, contrôles de syntaxe, `git diff --check`. Build dashboard seulement si ses sources changent (ce n'est pas attendu).

Périmètre de fichiers : parseur et tests, raccord minimal de revalidation seulement si nécessaire, README, notice et checklist, journal. Pas de changement fonctionnel de la policy ou du dashboard. Si T5 est encore en chantier, attendre sa livraison plutôt que modifier ses fichiers simultanément.

Mettre à jour le journal avec preuves réellement exécutées et limites. **Pas de commit/push automatique** : livraison pour contre-recette, traitement des constats, puis commit sur demande. Si une ambiguïté de reconnaissance ou une régression répétée ne peut être résolue avec un test discriminant, demander une escalade, pas une extension silencieuse de grammaire.
