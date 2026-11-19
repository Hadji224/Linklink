# Déploiement et exploitation

Architecture recommandée (gratuite pour démarrer) :

| Brique | Service | Rôle |
|---|---|---|
| Interface (React) | **Vercel** | pages du site, build `npm run build -w web` |
| API + temps réel | **Render** (service web) | serveur Express + WebSocket |
| Base de données | **Neon** (PostgreSQL) | toutes les données, sauvegardes et restauration à un instant donné |
| Fichiers | **Google Drive** | pièces jointes ([guide](stockage-google-drive.md)) |

Ainsi, le serveur Render peut être redémarré, mis en veille ou redéployé **sans rien perdre** : il ne garde aucune donnée.

## 1. Base de données Neon
1. Créez un projet sur <https://neon.com> (PostgreSQL 17, région **Frankfurt** si votre serveur Render y est aussi).
2. Copiez l'adresse **Connection string** (`postgresql://…?sslmode=require`). Elle est secrète : mettez-la uniquement dans les variables d'environnement.
3. Au premier démarrage, le serveur crée seul les tables (table `schema_migrations`) et les données initiales.

## 2. Serveur sur Render
- **Blueprint** : *New → Blueprint* → ce dépôt (`render.yaml`, plan gratuit), ou service Docker/Node équivalent.
- Variables : `DATABASE_URL` (Neon), `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `APP_URL` (adresse du site), `CORS_ORIGIN` (adresse(s) du site Vercel, séparées par des virgules), `TRUST_PROXY=true`, `NODE_ENV=production`, `JWT_SECRET` (généré).
- Build : `npm ci && npm run build -w server` n'est pas nécessaire (le serveur s'exécute avec `tsx`) ; commande de démarrage : `npm run start -w server`.
- Le plan gratuit met le service en veille après 15 minutes sans requête (premier chargement ≈ 1 minute) : sans conséquence pour les données. Un plan payant supprime la veille.
- Vérifiez `https://<service>.onrender.com/api/health` → `{"ok":true,…,"storage":"drive"}`.

## 3. Interface sur Vercel
- Le fichier `vercel.json` du dépôt fixe le build (`npm run build -w web`, sortie `web/dist`), les en-têtes de sécurité et la redirection des pages.
- Variable de build : `VITE_API_URL=https://<service>.onrender.com`.
- La politique de sécurité (`connect-src` dans `vercel.json`) doit contenir l'adresse de l'API.

## 4. Premier démarrage
Ouvrez le site et **créez immédiatement le premier compte** : il devient Administrateur technique et PDG de démarrage. Les codes d'invitation sont ensuite visibles dans *Équipe* (ils sont aussi écrits dans les journaux du serveur au démarrage).

## Variante : un seul serveur (VPS + Caddy)
```bash
git clone https://github.com/Hadji224/Linklink && cd Linklink
cp .env.example .env     # DATABASE_URL, APP_URL, JWT_SECRET (openssl rand -hex 48)…
docker build -t linklink .
docker run -d --name linklink --restart unless-stopped --env-file .env -p 127.0.0.1:3000:3000 linklink
# Caddyfile : remplacez le nom de domaine, puis : sudo caddy run --config Caddyfile   (HTTPS automatique)
```
La base peut être un PostgreSQL local (`apt install postgresql`) ou Neon. Sans Docker : `npm ci && npm run build && NODE_ENV=production npm start`.

## E-mails de notification (facultatif)
Définissez `SMTP_URL` (ex. `smtps://utilisateur:motdepasse@smtp.exemple.com`) et `MAIL_FROM`. Sans cela, seules les notifications dans l'application sont envoyées.

## Sauvegardes
- **Base** : Neon conserve un historique et permet de **restaurer à un instant donné** (console Neon → *Restore*). En complément, une copie à vous : `DATABASE_URL=… npm run backup -w server` (nécessite `pg_dump`) crée `data/backups/linklink-AAAA-MM-JJ.dump`, vérifié à l'écriture. Restaurer : `pg_restore --clean --if-exists --no-owner -d "$DATABASE_URL" fichier.dump`.
- **Fichiers** : dans Google Drive (dossier « LinkLink »). Objectif du cahier : RPO 24 h, RTO 4 h.
- **Test de restauration mensuel** : restaurer la dernière copie dans une branche ou une base de test, puis vérifier le nombre de comptes et de projets.

## Données existantes (ancienne version SQLite)
```bash
DATABASE_URL=… npm run import:sqlite -w server -- chemin/linklink.db [--uploads chemin/uploads]
```
La base cible doit être vide ; les comptes, mots de passe, journaux et fichiers sont repris à l'identique. En cas d'erreur, rien n'est écrit.

## Écritures simultanées
Le serveur traite les requêtes qui modifient des données **l'une après l'autre** (comme SQLite le faisait), pour garantir par exemple qu'une règle « deux validations » ne soit jamais contournée par deux clics simultanés. Ne lancez donc qu'**une seule instance** du serveur ; pour plusieurs instances, il faudrait remplacer ce verrou par des verrous en base.

## Surveillance
Branchez [UptimeRobot](https://uptimerobot.com) (gratuit) sur `https://<api>/api/health` : alerte e-mail si le service ne répond plus (et il évite la mise en veille de Render). Les erreurs applicatives sortent sur la console du serveur (journaux Render).

## Journaux
`DATA_DIR/logs/access-AAAA-MM.log` (une ligne JSON par requête, sans contenu), purgés après 12 mois. **Sur un hébergement à disque éphémère (Render gratuit), ils sont perdus à chaque redémarrage** : l'objectif « 12 mois » du cahier exige un disque persistant (plan payant) ou un stockage de journaux externe. Le journal d'activité et les journaux immuables de l'application, eux, sont en base et conservés.

## Checklist de mise en production
- [ ] HTTPS actif (le serveur envoie HSTS quand `NODE_ENV=production`)
- [ ] `DATABASE_URL` (Neon) et `JWT_SECRET` définis, `TRUST_PROXY=true`
- [ ] Google Drive configuré : la ligne « Stockage des fichiers : Google Drive » apparaît dans les journaux
- [ ] Application Google **publiée** (« En production »), sinon le jeton expire en 7 jours
- [ ] `CORS_ORIGIN` = adresse(s) exacte(s) du site ; `VITE_API_URL` = adresse de l'API
- [ ] Premier compte créé, codes d'invitation distribués par canal sûr
- [ ] Une copie de sauvegarde faite (`npm run backup`)
- [ ] UptimeRobot sur `/api/health`

## Retour arrière
Redéployer le commit précédent. Les migrations de base ne font qu'ajouter (table `schema_migrations`) : pour une migration qui modifie des données, créez d'abord une branche Neon (instantanée) ou une copie `npm run backup`.
