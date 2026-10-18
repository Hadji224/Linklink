# LinkLink — plateforme d'équipe

Application interne de LinkLink : **messages, projets, tâches, rendez-vous et dépôt de dossiers** au même endroit, pour remplacer les échanges de travail sur WhatsApp. Interface en français, utilisable sur téléphone (installable comme une application) et sur ordinateur.

## Fonctions (Phase 1)

| Module | Contenu |
| --- | --- |
| **Comptes et rôles** | Inscription sur invitation (code `XXXX-XXXX`), premier compte = Super Admin. Rôles **Super Admin / Fondateur / Invité interne** avec la matrice de permissions du cahier des charges. Profil, mot de passe, avatar (initiales). |
| **Projets** | Nom, description, couleur, statut (actif / en pause / terminé / archivé), membres, progression automatique, archivage (lecture seule). Onglets : vue d'ensemble, tâches, dossiers, messages, RDV, membres, activité. |
| **Tâches** | Kanban (glisser-déposer ou boutons), liste triable, calendrier mensuel, « Ma journée ». Priorités, échéances, étiquettes, sous-tâches, pièces jointes, commentaires avec @mentions. |
| **Documents** | Dossiers et sous-dossiers, un dossier par projet + « Messages », recherche (nom, auteur, date, niveau), aperçu des images, téléchargement sécurisé, **niveaux de confidentialité** (Public / Interne / Confidentiel / Strictement confidentiel). |
| **Messagerie** | Salons (`#général`, `#annonces` réservé au Super Admin), salon automatique par projet, **messages directs privés**, temps réel (WebSocket), non lus persistants, historique par pages de 50, pièces jointes, @mentions. |
| **Rendez-vous** | Création (équipe ou projet), réponse Présent / Peut-être / Absent, export `.ics`, tri « à venir / passés ». |
| **Tableau de bord** | Mes tâches du jour, mes prochains RDV, messages non lus, 4 indicateurs. |
| **Notifications** | Dans l'application (temps réel) et par e-mail (si SMTP configuré) : assignation, mention, échéance J-1 / J-0, tâche en retard, nouveau RDV, rappels de RDV (24 h et 1 h). |
| **Traçabilité et RGPD** | Journal d'activité (Super Admin), journal d'accès conservé 12 mois, export des données personnelles, suppression de compte en cascade, consentement, pages CGU et confidentialité. |
| **Exploitation** | Sauvegarde quotidienne de la base (30 jours), script de test de restauration, route de santé `/api/health`, en-têtes de sécurité. |

La **Phase 2** du cahier des charges (portail client, partage externe, facturation) n'est pas incluse.

## Démarrer

Prérequis : [Node.js](https://nodejs.org) 22.13 ou plus récent.

```bash
npm install
npm run build     # compile l'interface web
npm start         # http://localhost:3000
```

Au lancement, le serveur affiche deux codes d'invitation : un pour les **Fondateurs**, un pour les **Invités internes**. Le premier compte créé devient **Super Admin**.

### Développement

```bash
npm run dev         # serveur (3000) + interface avec rechargement (5173)
npm run typecheck
npm test            # tests de l'API (Vitest)
npm run test:e2e    # tests navigateur (Playwright) — voir docs/rapport-de-tests.md
```

## Configuration

Voir `.env.example`. Variables principales : `PORT`, `DATA_DIR` (base, fichiers, sauvegardes, logs), `TRUST_PROXY`, `JWT_SECRET`, `MAX_UPLOAD_MB`, `APP_URL`, `SMTP_URL`, `MAIL_FROM`.

Toutes les données sont dans `DATA_DIR` : **mettez ce dossier sur un disque persistant**.

## Mise en ligne

Dockerfile, `render.yaml` (Render) et `Caddyfile` (VPS + HTTPS automatique) sont fournis. Pas à pas dans [`docs/deploiement.md`](docs/deploiement.md).

## Documentation

- [Guide utilisateur](docs/guide-utilisateur.md) ([PDF](docs/guide-utilisateur.pdf))
- [Conformité au cahier des charges](docs/conformite-cahier.md)
- [Déploiement et exploitation](docs/deploiement.md)
- [Sécurité (OWASP)](docs/securite.md)
- [Registre des traitements RGPD](docs/rgpd-registre.md)
- [Rapport de tests](docs/rapport-de-tests.md)

## Architecture

```
server/   API Express + WebSocket + SQLite (node:sqlite), TypeScript
  src/routes/   auth, projets, tâches, salons, fichiers, rendez-vous, divers
  src/perm.ts   toutes les règles d'accès (projets, salons, fichiers, confidentialité)
  src/jobs.ts   rappels automatiques et sauvegardes
web/      Interface React 19 + Tailwind v4 (Vite), charte graphique LinkLink v1.0
e2e/      Tests navigateur (Playwright + axe)
```

La base v1 (premier MVP) est migrée automatiquement au premier lancement ; une copie est conservée dans `DATA_DIR/backups`.
