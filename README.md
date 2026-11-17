# LinkLink — plateforme d'équipe

Application interne de LinkLink : **messages, projets, tâches, rendez-vous et dépôt de dossiers** au même endroit, pour remplacer les échanges de travail sur WhatsApp. Interface en français, utilisable sur téléphone (installable comme une application) et sur ordinateur.

## Fonctions (Phase 1 + spécification v1.2)

| Module | Contenu |
| --- | --- |
| **Comptes et rôles** | Inscription sur invitation (code `XXXX-XXXX`), premier compte = Administrateur technique (PDG de démarrage). Accès **Administrateur technique / Fondateur / Invité**, plus six **fonctions** (PDG, Coordinateur, Chef de projet, Chef d'infrastructures, Caissier, Chargé de communication) et des **mandats** bornés dans le temps. Profil, mot de passe, avatar (initiales). |
| **Projets** | Nom, description, couleur, statut (actif / en pause / terminé / archivé), membres, progression automatique, archivage (lecture seule). Onglets : vue d'ensemble, tâches, dossiers, messages, RDV, membres, activité. |
| **Tâches** | Kanban (glisser-déposer ou boutons), liste triable, calendrier mensuel, « Ma journée ». Priorités, échéances, étiquettes, sous-tâches, pièces jointes, commentaires avec @mentions. |
| **Documents** | Dossiers et sous-dossiers, un dossier par projet + « Messages », recherche (nom, auteur, date, niveau), aperçu des images, téléchargement sécurisé, **niveaux de confidentialité** (Public / Interne / Confidentiel / Strictement confidentiel). |
| **Messagerie** | Salons (`#général`, `#annonces` réservé au PDG, au Chargé de communication et à l'administrateur technique), salon automatique par projet, **messages directs privés**, temps réel (WebSocket), non lus persistants, historique par pages de 50, pièces jointes, @mentions. |
| **Rendez-vous** | Création (équipe ou projet), réponse Présent / Peut-être / Absent, export `.ics`, tri « à venir / passés ». |
| **Finances** | Demandes de dépense, double approbation si le PDG est concerné, plafond, paiement déclaré par le Caissier, écart à régulariser, justificatifs cosignés, clôture. |
| **Communications** | Cinq circuits de validation (courante, projet, officielle, technique, publicité payante), validateurs indépendants, voie de crise avec revue sous 24 h, publication par le Chargé de communication. |
| **Gouvernance** | Validations en attente et relances (24/48/120 h), fonctions, mandats et absences, règles de relance, accès d'urgence, transfert d'administration, suspension de compte. |
| **Journaux** | Activité, décisions métier, sécurité et urgence : immuables (protégés en base). |
| **Tableau de bord** | Mes tâches du jour, mes prochains RDV, messages non lus, 4 indicateurs. |
| **Notifications** | Dans l'application (temps réel) et par e-mail (si SMTP configuré) : assignation, mention, échéance J-1 / J-0, tâche en retard, nouveau RDV, rappels de RDV (24 h et 1 h). |
| **Traçabilité et RGPD** | Journaux immuables (métier, sécurité, urgence), journal d'accès conservé 12 mois, export des données personnelles, suppression de compte en cascade, consentement, pages CGU et confidentialité. |
| **Exploitation** | Sauvegarde quotidienne de la base (30 jours), script de test de restauration, route de santé `/api/health`, en-têtes de sécurité. |

La **Phase 2** du cahier des charges (portail client, partage externe, facturation) n'est pas incluse.

## Démarrer

Prérequis : [Node.js](https://nodejs.org) 22.13 ou plus récent.

```bash
npm install
npm run build     # compile l'interface web
npm start         # http://localhost:3000
```

Au lancement, le serveur affiche deux codes d'invitation : un pour les **Fondateurs**, un pour les **Invités internes**. Le premier compte créé devient **Administrateur technique** et tient la fonction PDG tant qu'aucun fondateur ne la reçoit.

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
- [Spécification v1.2 : état de l'implémentation](docs/specification-v1.2.md)
- [Conformité au cahier des charges](docs/conformite-cahier.md)
- [Déploiement et exploitation](docs/deploiement.md)
- [Sécurité (OWASP)](docs/securite.md)
- [Registre des traitements RGPD](docs/rgpd-registre.md)
- [Rapport de tests](docs/rapport-de-tests.md)

## Architecture

```
server/   API Express + WebSocket + SQLite (node:sqlite), TypeScript
  src/routes/   auth, gouvernance, projets, tâches, dépenses, communications, salons, fichiers, rendez-vous, divers
  src/access.ts fonctions, mandats, cumuls, capacités (can), journaux immuables
  src/perm.ts   règles d'accès (projets, salons, fichiers, confidentialité)
  src/jobs.ts   rappels automatiques et sauvegardes
web/      Interface React 19 + Tailwind v4 (Vite), charte graphique LinkLink v1.0
e2e/      Tests navigateur (Playwright + axe)
```

Les bases v1 à v3 sont migrées automatiquement (jusqu'au schéma v4) au premier lancement ; une copie est conservée dans `DATA_DIR/backups`.
