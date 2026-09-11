# Dashboard local Pilot

Application React + Vite intégrée au dépôt du pilote. Aucun service Sites,
Cloudflare, accès réseau externe ou compte d'hébergement n'est nécessaire.

Depuis la racine du dépôt :

```powershell
npm --prefix dashboard ci
npm run dashboard:build
npm run dashboard
```

Ouvrir http://127.0.0.1:4173/. Sous Windows, `./start-dashboard.ps1` démarre le
serveur sans fenêtre ; `node src/cli.mjs stop-dashboard` arrête uniquement le
dashboard. `--port` et `--config` sont disponibles via `node src/cli.mjs dashboard`.

## Données réelles

La carte Quota & tokens lit `/api/quota` toutes les 15 secondes. Le serveur Node
lit la dernière ligne de `account_observations` en SQLite, sans écriture et sans
appeler Codex. Pour alimenter la table, utiliser l'observateur indépendant :
`./start-observer.ps1` ou `node src/cli.mjs observe --watch`.

- Choix de l'enveloppe ; toutes les fenêtres réellement renvoyées sont affichées.
- Pourcentage restant, date de reset, autorisation d'usage telle qu'observée.
- Cumul des tokens du compte et détail journalier fourni par Codex.
- Horodatage distinct des mesures, état inconnu, erreur réseau et relevé ancien
  au-delà de trois minutes. Les jours absents restent absents.
- Aucune attribution des tokens globaux aux missions ; les autres cartes et
  vues portent explicitement des données de démonstration.

Le serveur écoute uniquement sur `127.0.0.1`. Il sert les fichiers compilés du
dashboard et une projection limitée des données ; ni la base, ni les réponses
brutes du fournisseur, ni l'identité du compte ne sont exposées.

## Organisation

- `src/components/` : navigation et composants d'interface partagés.
- `src/features/overview/` : page d'ensemble, cartes Décisions et Missions.
- `src/features/quota/` : carte réelle, types API et lecture périodique.
- `src/features/activity/` : fil d'événements et vue Activité.
- `src/features/cases/` : exemples métier, vues Historique/Parcours/Escalades et détail.
- `../src/dashboard.mjs` : serveur HTTP local et lecture SQLite.

Pour modifier l'interface avec rechargement à chaud, laisser le serveur local
sur 4173 puis lancer `npm --prefix dashboard run dev`. Vite relaie `/api` vers ce
serveur. La compilation de livraison inclut la vérification TypeScript.

L'ancien prototype Sites et son dépôt Git ont été conservés dans
`../state/dashboard-sites-archive/`, ignoré par Git. Le dashboard actif est suivi
par le dépôt principal, sans dépôt Git imbriqué ni fichier de déploiement Sites.
