# Déploiement et exploitation

## Option A — Render (le plus simple)
1. Poussez ce dépôt sur GitHub (déjà fait).
2. Sur [render.com](https://render.com) : **New → Blueprint**, choisissez le dépôt. `render.yaml` crée le service Docker avec un disque persistant `/data`.
3. Renseignez `APP_URL` (adresse publique). `JWT_SECRET` est généré automatiquement.
4. Ouvrez l'adresse : créez le premier compte (Super Admin) ; les codes d'invitation sont visibles dans *Équipe*.

> Un disque persistant demande une offre payante. Sans disque, les données sont perdues à chaque redéploiement.

## Option B — VPS (Ubuntu) + Caddy
```bash
# Docker + Caddy installés
git clone https://github.com/Hadji224/linklink && cd linklink
cp .env.example .env     # éditez APP_URL, JWT_SECRET (openssl rand -hex 48)…
docker build -t linklink .
docker run -d --name linklink --restart unless-stopped --env-file .env \
  -p 127.0.0.1:3000:3000 -v /srv/linklink-data:/data linklink
# Caddyfile : remplacez le nom de domaine, puis
sudo caddy run --config Caddyfile   # HTTPS automatique
```
Sans Docker : `npm ci && npm run build && NODE_ENV=production DATA_DIR=/srv/linklink-data npm start` derrière Caddy.

## E-mails de notification (facultatif)
Définissez `SMTP_URL` (ex. `smtps://utilisateur:motdepasse@smtp.exemple.com`) et `MAIL_FROM`. Sans cela, seules les notifications dans l'application sont envoyées.

## Sauvegardes
- **Base** : automatique chaque jour dans `DATA_DIR/backups` (30 jours conservés). Manuel : `npm run backup`.
- **Fichiers** : `DATA_DIR/uploads` — copiez-le vers un second emplacement (ex. `rsync` ou snapshot du disque). Objectif du cahier : RPO 24 h, RTO 4 h.
- **Test de restauration mensuel** : `npm run backup:verify` (vérifie l'intégrité et compte les données).
- **Restaurer** : arrêter le serveur, copier la sauvegarde sur `DATA_DIR/linklink.db`, relancer.

## Journaux
`DATA_DIR/logs/access-AAAA-MM.log` (une ligne JSON par requête, sans contenu) ; purgés après 12 mois. Lisibles par le Super Admin via `GET /api/admin/access-logs`. Le journal d'activité applicatif est dans l'écran *Journal*.

## Checklist de mise en production
- [ ] HTTPS actif (le serveur envoie HSTS quand `NODE_ENV=production`)
- [ ] `JWT_SECRET` défini, `TRUST_PROXY=true` derrière un proxy
- [ ] Disque persistant monté sur `DATA_DIR`
- [ ] Sauvegarde des fichiers `uploads` programmée
- [ ] Premier compte créé, codes d'invitation distribués par canal sûr
- [ ] SMTP configuré (si e-mails souhaités)

## Retour arrière
Redéployer l'image précédente ; les données (sur le disque) sont conservées. Avant une mise à jour qui change le schéma, une copie de la base est faite automatiquement dans `backups/`.

## Mise à jour depuis la v1
Au premier démarrage, la base du premier MVP est migrée (comptes, salons, messages, fichiers rangés par dossier, rendez-vous). Une copie `linklink-v1-avant-migration-*.db` est conservée.
