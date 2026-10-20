# Rapport de tests

Dernière exécution complète : tous les tests passent.

| Suite | Commande | Résultat |
| --- | --- | --- |
| Types (serveur + web) | `npm run typecheck` | ✅ aucune erreur |
| API et règles métier (Vitest) | `npm test` | ✅ 58 tests |
| Parcours navigateur + accessibilité (Playwright, axe) | `npm run test:e2e` | ✅ 13 scénarios |
| Lighthouse (page de connexion, mobile simulé) | — | ✅ Performance 88 · Accessibilité 100 · Bonnes pratiques 100 · SEO 92 |
| Charge : 50 connexions simultanées pendant 8 s par route | autocannon | ✅ 0 erreur ; p97,5 : 56 ms (fichiers) à 284 ms (liste de 60 tâches) |
| Dépendances | `npm audit` | ✅ 0 vulnérabilité |

## Ce que couvrent les 58 tests d'API
Inscription (consentement, codes membre/invité, doublons, mot de passe court), matrice de permissions du cahier (§4.2), invisibilité des projets pour les invités non membres, tâches (assignation + notification, sous-tâches, progression, commentaires et mentions, rappels J-1 et retard dédoublonnés), archivage en lecture seule, fichiers (liste blanche de formats, niveaux de confidentialité, suppression selon le rôle, aperçu réservé aux images), messages directs privés (y compris pièces jointes et temps réel), non lus persistants, pagination, rendez-vous (visibilité, RSVP), journal réservé au Super Admin, export/suppression RGPD, invalidation des sessions, en-têtes de sécurité, injection SQL, **migration de la base v1**, promotion/rétrogradation de rôle, **droits d'écriture sur les tâches par rôle (créateur, assigné, admin, observateur : modification, statut, réassignation, suppression, sous-tâches, commentaires), historique immuable, verrouillage après 7 jours, archivage, transfert de propriété, alertes de tentatives refusées, départ d'un membre**.

## Scénarios navigateur
Connexion et consentement, invitations, projet → tâche → Kanban → sous-tâche → commentaire avec mention, invité limité, messagerie en temps réel (non lus, DM privé, #annonces, mention), documents (niveau, recherche, téléchargement, confidentialité), rendez-vous (RSVP en direct, `.ics`), profil/RGPD/journal/pages légales, archivage, **axe-core (WCAG AA) sur les écrans principaux**, **interface des tâches selon le rôle (assigné, observateur, admin)**, reconnexion du temps réel après coupure, session conservée au rechargement. Les captures (téléphone et ordinateur) sont produites dans `e2e/screens/` (non versionné).

## Lancer les tests navigateur
```bash
npx playwright install chromium     # une fois (ou CHROMIUM_PATH=/chemin/vers/chromium)
npm run test:e2e
```

## Non réalisé / à faire
- Firefox, Safari, Edge et iOS Safari (seul Chromium a été utilisé).
- Test du `Dockerfile` (aucun démon Docker disponible dans l'environnement de développement).
- Test d'envoi d'e-mails réels (nécessite un serveur SMTP).
- Mesure de l'upload de 25 Mo sur une vraie connexion.

Voir aussi [`conformite-cahier.md`](conformite-cahier.md).
