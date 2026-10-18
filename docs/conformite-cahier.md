# Conformité au cahier des charges (v1.0)

Légende : ✅ conforme · 🟡 partiel / écart assumé · ⛔ non fait · 🌐 dépend de l'hébergement ou de l'équipe

## §3.1 Périmètre Phase 1
| Exigence | État | Où / remarque |
| --- | --- | --- |
| Authentification et comptes | ✅ | `routes/auth.ts`, écran de connexion |
| Gestion des fondateurs (rôles, permissions) | ✅ | 3 rôles ; matrice §4.2 testée (`server/test/api.test.ts`) |
| Projets (création, membres, statut) | ✅ | `routes/projects.ts`, `pages/Projects.tsx` |
| Tâches (Kanban, liste, assignation, priorités) | ✅ | + calendrier, Ma journée |
| Dossiers (upload, arborescence, recherche) | ✅ | `routes/files.ts`, `pages/Documents.tsx` |
| Messagerie salons + messages directs | ✅ | `routes/channels.ts`, `pages/Chat.tsx` |
| RDV avec RSVP | ✅ | `routes/meetings.ts` |
| Tableau de bord personnel et global | ✅ | `pages/Dashboard.tsx` |
| Notifications in-app + e-mail | ✅ | e-mail actif seulement si `SMTP_URL` est configuré (non testé avec un vrai serveur SMTP) |
| Journal d'activité | ✅ | `activity_log`, écran Journal (Super Admin) |
| Code d'invitation | ✅ | + second code pour les invités internes |

## §4.2 Matrice des permissions
13 lignes sur 13 appliquées côté serveur. Précision d'interprétation : « Fondateur : accès aux projets » = tous les projets ; l'Invité ne voit que ceux où il est membre.

## §5 Modules
| Réf. | État | Remarque |
| --- | --- | --- |
| F-AUTH-01 à 03 | ✅ | Déconnexion depuis *Équipe* et depuis *Profil*. Avatar = initiales colorées. |
| F-PROJ-01 à 04 | ✅ | Vue grille/liste, filtres de statut, 7 onglets, progression automatique, archivage (uniquement depuis « Terminé »). |
| F-TASK-01 à 05 | ✅ | Rappels J-1, J-0, retard (alerte au responsable et au créateur). |
| F-FILE-01 | ✅ | Glisser-déposer + sélection multiple, 25 Mo (`MAX_UPLOAD_MB`), liste blanche de formats. |
| F-FILE-02, 03, 04 | ✅ | Arborescence illimitée, recherche nom/auteur/date/niveau, téléchargement en pièce jointe, icônes colorées, aperçu des images. Pas d'aperçu PDF/Office dans le navigateur. |
| F-FILE-05 (Phase 2) | ⛔ | Hors Phase 1. |
| F-MSG-01 à 05 | ✅ | |
| F-RDV-01 à 04 | ✅ | |
| F-DASH-01, 02 | ✅ | |
| F-EQ-01 à 03 | ✅ | |
| F-CLIENT (Phase 2) | ⛔ | Hors Phase 1 (O5 « structure prête à ouvrir » : non préparée). |

## §6 Non-fonctionnel
| Exigence | État | Mesure / remarque |
| --- | --- | --- |
| Chargement initial < 2 s | 🟡 | Lighthouse mobile simulé (4G lente) : FCP 1,8 s, LCP 2,9 s. Sur ordinateur ou bon réseau, nettement meilleur. |
| API < 300 ms (p95) | ✅ | Test de charge, 50 connexions simultanées : p97,5 de 56 à 284 ms selon la route (la plus lourde : liste de 60 tâches). |
| 50+ utilisateurs simultanés | ✅ | idem |
| Upload 25 Mo < 15 s | 🟡 | Non mesuré (dépend de la connexion). |
| Navigateurs Chrome, Firefox, Safari, Edge | 🟡 | Testé sur Chromium ; lancé aussi sur téléphone via Termux (navigateur non précisé). Firefox, Safari, Edge non testés. |
| Mobile-first ≥ 375 px, PWA | ✅ | Testé à 390 px. Manifeste + icônes ; pas de service worker (pas de mode hors-ligne). |
| WCAG AA, clavier, ARIA | ✅ | axe-core sans violation sur les écrans principaux ; Lighthouse accessibilité 100. |
| Feedback (toasts, spinners, erreurs) | ✅ | |
| HTTPS, TLS 1.3 | 🌐 | Fourni par Caddy/Render. HSTS envoyé en production. |
| Chiffrement au repos (AES-256) | 🌐 | Non fait par l'application : utiliser un disque chiffré chez l'hébergeur. |
| bcrypt, CSRF, XSS, injection SQL | ✅ | Voir `docs/securite.md` (bcrypt coût 10, jeton en en-tête : pas de CSRF). |
| Logs d'accès 12 mois | ✅ | `DATA_DIR/logs`, purge automatique. |
| Sauvegarde BDD quotidienne, rétention 30 j | ✅ | Automatique. |
| Fichiers : réplication géographique | 🌐 | À mettre en place côté hébergement (rsync/S3). |
| Test de restauration mensuel | 🟡 | Script fourni (`npm run backup:verify`) ; à planifier par l'équipe. |
| RGPD : registre, accès, oubli | ✅ | `docs/rgpd-registre.md`, export et suppression dans le profil. |
| Hébergement UE | 🌐 | Choix de l'hébergeur. |
| CGU + confidentialité | ✅ | Pages `#legal/cgu` et `#legal/confidentialite` (textes à faire valider juridiquement). |

## §7–8 Architecture et données
- Stack conforme (React 19, Vite, Tailwind v4, Express, node:sqlite, ws, JWT + bcryptjs, Multer, Zod). ✅
- Structure du projet : conforme, avec en plus `routes/projects.ts`, `tasks.ts`, `misc.ts` ; les routes « membres » sont dans `routes/auth.ts` (pas de `routes/members.ts` séparé). 🟡 cosmétique
- Modèle de données : **étendu** par rapport au §8.1 (rôle `guest`, projets, tâches, dossiers, notifications, journal…). Écarts volontaires : `files.folder` (texte) est devenu `folder_id` (arborescence) ; `files.uploaded_by` s'appelle `user_id` ; le code d'invitation est dans `settings` (deux codes) plutôt que dans une table `invites`. 🟡
- Index prévus (§8.3) : tous présents. ✅
- Table `clients` (Phase 2) : non créée. ⛔

## §9 Sécurité
Authentification, autorisation (`requireAuth`, rôles, contrôles par ressource), protection des données, RGPD, journalisation : ✅. « DPO = le Super Admin » : formulé sans nom dans les CGU.

## §10 Design
Palette, Inter (auto-hébergée), rayons 12/16 px, logo officiel (fourni par la charte, jamais redessiné ; symbole seul sur tuile claire), sidebar bleu nuit, barre du bas mobile, composants récurrents : ✅. Le §10.2 du cahier décrit un logo sur fond bleu nuit arrondi ; la charte impose le logo officiel sur fond clair, c'est elle qui a été suivie. Barre du bas : 4 onglets + « Plus » (le cahier prévoyait 4 onglets pour 4 pages ; il y en a maintenant 10).

## §14 Tests
| Scénario critique §14.2 | Test |
| --- | --- |
| Inscription → connexion → dashboard | e2e + API ✅ |
| Salon → message → temps réel | e2e + API ✅ |
| Upload → recherche → téléchargement | e2e + API ✅ |
| RDV → RSVP → .ics | e2e ✅ |
| Invitation d'un membre → compte | e2e + API ✅ |
| Promotion en admin → droits | API ✅ |
| Reconnexion WebSocket après coupure | e2e ✅ |

Critères §14.3 : scénarios 100 % ✅ ; Lighthouse 88 (> 85) ✅ ; audit OWASP documenté ✅ ; Chrome/Chromium ✅, **Firefox/Safari/Edge non testés** 🟡 ; iOS Safari non testé 🟡. Outils : Vitest pour l'API (pas de Testing Library côté composants).

## §13 Livrables
README ✅ · guide utilisateur PDF ✅ · rapport de tests ✅ · guide de déploiement ✅ · tests automatisés ✅ · charte appliquée ✅. **Non produits** : maquettes Figma/HTML, journal de bord de développement, planning détaillé. Dépôt « privé » : le dépôt est public (voir la remarque confidentialité du README).

## §15 Déploiement
Variables d'environnement, Caddy/Nginx, disque persistant, CGU en ligne, test de restauration, rollback : documentés ✅ (Dockerfile non testé : pas de démon Docker disponible ici). Monitoring (UptimeRobot/Sentry) : route `/api/health` fournie, outils à brancher 🌐. Branches `dev` et `main` créées ✅. Environnements staging/prod (`staging.linklink.gn`, `app.linklink.gn`) : à créer 🌐.

## Objectifs secondaires §2.3
- Identité produit forte ✅ · base scalable pour 50+ utilisateurs ✅ (SQLite : voir limites dans `docs/deploiement.md`)
- **Documenter les process internes (SOP) dans la plateforme** : ⛔ pas de module dédié (contournement : dossier de projet « Procédures » dans Documents).
- Préparer l'ouverture externe : ⛔ Phase 2.
