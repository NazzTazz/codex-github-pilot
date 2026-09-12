# Pilot — deux workers Codex CLI, deux comptes locaux

Spécification fonctionnelle et technique — 12 septembre 2026.

Première livraison ciblée : [T2.5 — Observation multi-compte locale](TRANCHE-2.5-SPEC.md), à implémenter avant T3/T4. Elle livre la surveillance simultanée sans changement du compte d'exécution ; les mécanismes de relais ci-dessous restent une extension ultérieure.

Statut : demandé, à implémenter. Ce document complète la [spécification quota-aware](quota-aware-scheduling-spec.md). Il définit l'extension locale multi-compte ; il ne prétend pas que les tranches mono-worker en cours la livrent déjà. Lors de cette extension, les règles ci-dessous prévalent pour l'identité des comptes, leur sélection et le relais. Aucun protocole distant ni seconde installation de Codex n'est nécessaire.

## 1. Besoin et résultat attendu

L'utilisateur travaille dans Codex CLI. Sur la même machine, Pilot doit pouvoir disposer de deux workers authentifiés séparément : un compte Pro Lite principal et un compte Plus de secours. Les noms de plans sont des libellés utilisateur ; les droits et capacités viennent des observations du compte réellement connecté.

Pilot affiche les quotas de chaque worker et permet à l'utilisateur de choisir celui qui consomme. Lorsque le quota hebdomadaire principal restant de Lite descend strictement sous 10 %, une alerte propose le relais vers Plus. Ce seuil ne concerne ni la réserve Luna ni les enveloppes Spark. Le seuil n'autorise pas le transfert. Aucun découpage du quota en grosses tranches, aucune conversion tokens/pourcentage et aucune réservation fictive de capacité.

## 2. Isolation locale des comptes

Une installation Codex CLI commune, deux processus et deux répertoires `CODEX_HOME` distincts :

| Worker | Répertoire local proposé | Compte attendu |
| --- | --- | --- |
| `lite` | `C:\Users\trist\.codex-pro-lite` | Pro Lite |
| `plus` | `C:\Users\trist\.codex-plus` | Plus |

Ces chemins sont des exemples de configuration locale, jamais des constantes du programme. Chaque répertoire est créé et authentifié une fois, en sélectionnant explicitement le compte voulu lors de `codex login`. Le stockage `cli_auth_credentials_store = "file"` place les credentials dans le `auth.json` propre à ce répertoire. Conserver ces fichiers hors du dépôt ; ne pas les copier entre workers. Une migration du compte existant doit être explicite et ne doit pas modifier sa connexion en cours.

Codex documente [le stockage de l'authentification](https://learn.chatgpt.com/docs/auth) et [l'état local sous CODEX_HOME](https://learn.chatgpt.com/docs/config-file/config-advanced). Les dossiers isolent aussi configuration, historique et caches. Les réglages et extensions nécessaires doivent être provisionnés dans chaque environnement ; leur présence dans le dossier actuel ne suffit pas.

Pilot passe `CODEX_HOME` dans l'environnement de chaque processus enfant, sans changer l'environnement global du processus orchestrateur ni celui de Windows. Le même environnement filtré doit servir à login/status, doctor, observation app-server, catalogue et exécution. Aucun partage mutable de `process.env` entre lancements. Garder le filtrage des clés API et les protections actuelles de l'executor ; aucun fallback vers une facturation API.

Le polling n'effectue pas de login/logout et ne remplace pas les credentials. Un compte absent ou différent du compte attendu rend uniquement cette cible indisponible ; Pilot exige une nouvelle association explicite avant de réutiliser ses observations.

## 3. Identités et observation

La configuration locale de chaque worker comprend un ID stable, un libellé, la commande Codex, son dossier Codex, son `targetId`, son `capacityScopeId` et ses profils offerts. La sélection active référence cet ID, jamais le seul nom du plan.

L'identité de quota est celle du compte, pas celle du processus. Deux workers authentifiés au même compte partagent un scope canonique, ses incidents et ses quotas : un second dossier ne crée pas une réserve supplémentaire. Utiliser la liaison pseudonyme locale au compte réel ; ne pas exposer les credentials, email, identifiant fournisseur brut ou chemins dans le dashboard.

Chaque compte possède ses observations datées et sa fraîcheur. Un observateur multi-cible peut collecter les deux comptes avec des clients isolés ; ses verrous et lectures doivent être scoped afin qu'une collecte ne bloque pas l'autre. La panne d'un compte ne doit pas supprimer ou remplacer les observations de l'autre. Ne jamais utiliser le dernier relevé global pour admettre un worker.

Les incidents sont locaux au scope et au pool. Une limite Lite ne bloque pas Plus. Les tokens lifetime et leurs deltas restent propres au compte ; aucune différence ne se calcule entre deux comptes.

## 4. Affichage et choix du compte

Afficher une carte par worker avec :

- Libellé de compte, plan observé, état de connexion, worker actif ou de secours.
- Toutes les enveloppes effectivement exposées par ce compte, chacune avec son libellé, son quota restant, sa durée lorsqu'elle est connue et sa date de reset avec fuseau explicite. Aucun nombre fixe de jauges ni paire 5 heures/semaine imposée.
- Date du relevé et état frais, périmé, inconnu ou en erreur ; inconnu ne signifie jamais zéro.
- Disponibilité pour le profil demandé et motifs de blocage dans les seules enveloppes qui lui sont applicables, ou incident correspondant.
- Tâche en cours et état du relais éventuel.

Configuration constatée par l'utilisateur le 12 septembre 2026, à couvrir dans les fixtures et l'affichage :

| Compte | Jauges |
| --- | --- |
| Plus | Principale 5 heures ; principale hebdomadaire |
| Pro Lite | Principale hebdomadaire ; réserve Luna ; Spark 5 heures ; Spark globale |

Pro Lite n'a pas de jauge principale 5 heures dans cette configuration. Ne pas confondre sa jauge Spark 5 heures avec une limite applicable à Sol. La durée de Spark globale et celle de la réserve Luna ne sont pas présumées : utiliser les métadonnées fournisseur, sinon afficher la durée comme inconnue. Cette liste décrit le besoin observé, pas un catalogue immuable déduit du nom commercial du plan.

Identifier les enveloppes par leur identifiant fournisseur et leur fenêtre, et les profils auxquels elles s'appliquent par les métadonnées de capacité vérifiées ; ne pas leur donner un sens d'après leur ordre dans la réponse ou leur seule durée. Une enveloppe inconnue reste visible sans devenir automatiquement une capacité admissible. L'affichage de la réserve Luna ou de Spark n'autorise pas leur sélection par le scheduler. Spark reste hors de la policy existante tant qu'une prise en charge explicite n'est pas livrée.

Si des workers partagent un compte, indiquer « quota partagé » et ne pas additionner leurs jauges. Conserver les statistiques de tokens séparées des jauges de quota. Ne pas fusionner weekly principale, réserve Luna et Spark en un pourcentage total.

L'alerte Lite sous 10 % montre simultanément les jauges de Plus et propose un choix explicite : continuer Lite, activer Plus ou mettre les admissions en pause. Une absence de réponse suspend les nouvelles admissions concernées ; elle n'autorise ni changement de compte ni dégradation du modèle. Une tâche déjà lancée continue jusqu'à sa fin ou sa limite, sauf arrêt explicite de l'utilisateur.

Une décision de continuer Lite vaut pour la fenêtre hebdomadaire observée, jusqu'à révocation ou indisponibilité technique. Ne pas répéter l'alerte à chaque poll. Une nouvelle fenêtre est réarmée après observation fraîche, pas sur la seule horloge. L'état de l'alerte et le choix sont persistés à travers les redémarrages.

## 5. Relais et politique de modèle

Après accord pour Plus, arrêter les nouvelles admissions sur Lite et sélectionner Plus pour les suivantes. Lite reste consultable et observable. Sa réactivation exige une décision utilisateur ; son reset ne provoque pas de retour automatique.

Le relais conserve le profil demandé, notamment Sol, et son effort. Il ne constitue pas une autorisation de passer à Luna, Terra ou à un effort inférieur. Dans ce mode de continuité, la sélection du compte et l'alerte précèdent les dégradations économiques de la matrice mono-compte : celle-ci ne doit pas dégrader silencieusement une tâche pendant l'attente ou après le relais. Les exigences, permissions, profils offerts et capacités techniques continuent à s'appliquer. Une autre politique de dégradation reste un choix distinct et explicite.

Avant toute admission, vérifier les observations fraîches du compte choisi, son identité attendue, les enveloppes applicables au profil demandé, les permissions fournisseur, le catalogue et les incidents. Pour Plus dans la configuration constatée, un solde hebdomadaire positif ne suffit pas si les 5 heures principales sont épuisées. Pour Sol sur Lite, ne pas exiger une fenêtre principale 5 heures inexistante et ne pas appliquer les limites Spark. Une réserve Luna positive ne prouve pas que Sol est disponible. Si Plus est indisponible lors du relais, afficher la raison et attendre le choix utilisateur ; aucun retour automatique vers Lite ni fallback modèle.

Pour la première livraison, les deux workers sont configurés et leurs comptes peuvent être observés simultanément, mais une seule tâche Pilot s'exécute à la fois. Une bascule demandée pendant un run est marquée en attente ; le run garde son compte et son assignment immuables, puis le relais s'applique. L'exécution parallèle de tâches différentes est une extension distincte, avec isolation des worktrees et admission adaptée.

Une tâche interrompue par une limite peut être terminée sur Plus après une demande explicite de reprise. Ce n'est pas un simple changement de compte sur un processus vivant : conserver la tentative initiale et créer une tentative liée. Avant cette reprise, vérifier que le premier processus est arrêté, préserver le checkout et tous les fichiers nouveaux, puis fournir un état de passation comprenant révision, demande, changements, validations effectuées et travail restant. Ne pas supposer qu'un identifiant de session Codex est portable entre comptes. Aucun double écrivain, aucune remise en file automatique d'un travail partiel. Si la reprise n'est pas disponible dans la première livraison, l'interface doit le dire et conserver les artifacts ; elle ne doit pas annoncer « terminer sur Plus » comme fonction opérationnelle.

## 6. Audit et intégration

Persister la sélection active, l'alerte et ses acquittements, ainsi que chaque demande de relais : acteur local, date, source, destination, état demandé/appliqué/annulé, motif et relevés utilisés. Le choix doit être atomique avec l'admission : un changement concurrent invalide l'admission et impose une réévaluation avant lancement.

Chaque tentative conserve worker, cible, scope, compte pseudonyme local, observation utilisée et profil exact. L'historique des anciennes tentatives reste inchangé. Les tentatives liées par reprise gardent leurs consommations respectives ; la consommation externe du compte ne leur est pas attribuée.

Ne pas lancer deux Pilot indépendants contre la même file pour simuler cette fonctionnalité. Un seul orchestrateur possède la sélection et le verrou d'admission. L'observateur reste en lecture et ne change pas la file. Le contrôle initial peut être une commande CLI locale ; un futur bouton dashboard devra appeler un point de mutation explicitement protégé, sans convertir les routes GET actuelles en commandes.

## 7. Critères d'acceptation

Validation par clients Codex simulés, horloge injectée et données anonymisées ; aucun appel modèle ni épuisement réel de quota requis.

1. Deux workers transmettent chacun leur dossier à tous leurs appels Codex, même pendant des observations concurrentes ; aucun mélange d'authentification.
2. Les fixtures Plus affichent deux jauges et les fixtures Pro Lite quatre, avec les libellés ci-dessus, sans jauge principale 5 heures fictive sur Lite. Une enveloppe supplémentaire ou absente se reflète dans l'affichage. Deux workers du même compte affichent un quota partagé, sans double comptage.
3. À 10 % exactement, pas d'alerte sous-seuil ; à 9 %, une alerte persistante sans bascule ni dégradation automatique. Continuer, basculer et suspendre survivent au redémarrage.
4. Un accord pour Plus sélectionne son compte et garde Sol/effort demandés. Lite n'admet plus de tâches après application du relais.
5. Plus à court de fenêtre 5 heures, périmé, déconnecté ou associé au mauvais compte entraîne une attente motivée, jamais un fallback implicite.
6. Une bascule pendant un run ne modifie pas son assignment et ne lance pas de second écrivain. Une reprise autorisée conserve les artifacts et crée une tentative liée.
7. Le reset Lite ne le réactive pas automatiquement ; les incidents et deltas restent isolés par compte.
8. Les routes de lecture et le dashboard n'exposent aucun credential ou chemin d'authentification ; une sélection concurrente est revalidée avant admission.
9. Spark épuisé sur Lite ne bloque pas Sol si sa capacité principale est établie ; Luna disponible ne débloque pas Sol si la principale est épuisée. L'alerte sous 10 % examine uniquement la weekly principale Lite, indépendamment de la position des enveloppes dans la réponse. Les durées non établies restent inconnues.

Livraison attendue : isolation des comptes et observation par worker, affichage des deux capacités, puis alerte et relais explicite avec audit. La reprise inter-compte doit être livrée et validée séparément avant d'être présentée comme disponible. La configuration mono-compte existante reste compatible.
