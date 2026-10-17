# Sécurité — contrôles par risque (OWASP Top 10)

| Risque | Mesures dans LinkLink |
| --- | --- |
| **A01 Contrôle d'accès** | Toutes les règles côté serveur (`server/src/perm.ts`) : projets invisibles (404) pour les non-membres invités, messages directs réservés à leurs deux participants, fichiers filtrés par niveau de confidentialité, annonces réservées au Super Admin, matrice de permissions testée automatiquement. Le temps réel n'envoie les données privées qu'aux personnes autorisées. |
| **A02 Cryptographie** | Mots de passe hachés (bcrypt) ; sessions JWT signées (30 jours) ; HTTPS + HSTS en production ; secret via `JWT_SECRET`. |
| **A03 Injection** | Requêtes SQL paramétrées exclusivement ; validation de toutes les entrées (zod) ; React échappe le contenu (aucun HTML injecté), liens en `rel="noopener noreferrer"`. |
| **A04 Conception** | Inscription sur invitation seulement, consentement explicite, rôles minimaux, suppression en cascade. |
| **A05 Configuration** | En-têtes : CSP stricte, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, COOP, HSTS. |
| **A06 Composants** | Dépendances minimales, `npm audit` sans vulnérabilité connue lors de la livraison. |
| **A07 Authentification** | Limitation des tentatives de connexion par IP ; changement de mot de passe ou de rôle = anciennes sessions invalidées ; jeton en en-tête `Authorization` (pas de cookie : pas de CSRF). |
| **A08 Intégrité** | Liste blanche des extensions déposables ; type MIME déduit de l'extension, jamais du client ; téléchargement en `attachment` ; aperçu limité aux images (sandbox CSP). |
| **A09 Journalisation** | Journal d'activité (qui a fait quoi) et journal d'accès, conservé 12 mois ; téléchargements de documents confidentiels tracés. |
| **A10 SSRF** | Le serveur n'effectue aucune requête sortante pilotée par l'utilisateur. |

**Limites connues** : limiteur de tentatives en mémoire (une seule instance) ; chiffrement « au repos » à assurer par l'hébergeur (disque chiffré) ; pas de double authentification (prévu en évolution).
