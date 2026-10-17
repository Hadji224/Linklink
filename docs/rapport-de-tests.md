# Rapport de tests

Dernière exécution complète : tous les tests passent.

| Suite | Commande | Résultat |
| --- | --- | --- |
| Types (serveur + web) | `npm run typecheck` | ✅ aucune erreur |
| API et règles métier (Vitest) | `npm test` | ✅ 40 tests |
| Parcours navigateur + accessibilité (Playwright, axe) | `npm run test:e2e` | ✅ 11 scénarios |
| Dépendances | `npm audit` | ✅ 0 vulnérabilité |

## Ce que couvrent les 40 tests d'API
Inscription (consentement, codes membre/invité, doublons, mot de passe court), matrice de permissions du cahier (§4.2), invisibilité des projets pour les invités non membres, tâches (assignation + notification, sous-tâches, progression, commentaires et mentions, rappels J-1 et retard dédoublonnés), archivage en lecture seule, fichiers (liste blanche de formats, niveaux de confidentialité, suppression selon le rôle, aperçu réservé aux images), messages directs privés (y compris pièces jointes et temps réel), non lus persistants, pagination, rendez-vous (visibilité, RSVP), journal réservé au Super Admin, export/suppression RGPD, invalidation des sessions, en-têtes de sécurité, injection SQL, **migration de la base v1**.

## Scénarios navigateur
Connexion et consentement, invitations, projet → tâche → Kanban → sous-tâche → commentaire avec mention, invité limité, messagerie en temps réel (non lus, DM privé, #annonces, mention), documents (niveau, recherche, téléchargement, confidentialité), rendez-vous (RSVP en direct, `.ics`), profil/RGPD/journal/pages légales, archivage, **axe-core (WCAG AA) sur les écrans principaux**, session conservée au rechargement. Les captures (téléphone et ordinateur) sont produites dans `e2e/screens/` (non versionné).

## Lancer les tests navigateur
```bash
npx playwright install chromium     # une fois (ou CHROMIUM_PATH=/chemin/vers/chromium)
npm run test:e2e
```

## Non réalisé / à faire
- Test de charge (cible du cahier : 50 utilisateurs simultanés, API < 300 ms p95).
- Audit Lighthouse et tests sur Safari/Firefox (seul Chromium a été utilisé).
- Test du `Dockerfile` (aucun démon Docker disponible dans l'environnement de développement).
- Test d'envoi d'e-mails réels (nécessite un serveur SMTP).
