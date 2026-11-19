# Sécurité — contrôles par risque (OWASP Top 10)

| Risque | Mesures dans LinkLink |
| --- | --- |
| **A01 Contrôle d'accès** | Toutes les règles côté serveur (`server/src/perm.ts`) : projets invisibles (404) pour les non-membres invités, messages directs réservés à leurs deux participants, fichiers filtrés par niveau de confidentialité, annonces réservées au PDG, au Chargé de communication et à l'administrateur technique ; capacités calculées côté serveur par fonction et par mandat (`can`), refus journalisés, matrice de permissions testée automatiquement. Le temps réel n'envoie les données privées qu'aux personnes autorisées. |
| **A02 Cryptographie** | Mots de passe hachés (bcrypt) ; sessions JWT signées (30 jours) ; HTTPS + HSTS en production ; secret via `JWT_SECRET`. |
| **A03 Injection** | Requêtes SQL paramétrées exclusivement ; validation de toutes les entrées (zod) ; React échappe le contenu (aucun HTML injecté), liens en `rel="noopener noreferrer"`. |
| **A04 Conception** | Inscription sur invitation seulement, consentement explicite, séparation des pouvoirs (PDG ≠ Caissier, double approbation), accès d'urgence borné (deux détenteurs, 2 h), suppression en cascade. |
| **A05 Configuration** | En-têtes : CSP stricte, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, COOP, HSTS. |
| **A06 Composants** | Dépendances minimales, `npm audit` sans vulnérabilité connue lors de la livraison. |
| **A07 Authentification** | Limitation des tentatives de connexion par IP ; changement de mot de passe ou de rôle = anciennes sessions invalidées ; jeton en en-tête `Authorization` (pas de cookie : pas de CSRF). |
| **A08 Intégrité** | Liste blanche des extensions déposables ; type MIME déduit de l'extension, jamais du client ; téléchargement en `attachment` ; aperçu limité aux images (sandbox CSP). |
| **A09 Journalisation** | Journal d'activité, journal d'accès (12 mois) et **journaux métier, sécurité et urgence immuables** (triggers SQL interdisant modification et suppression) ; refus, téléchargements confidentiels et accès d'urgence tracés. |
| **A10 SSRF** | Le serveur n'effectue aucune requête sortante pilotée par l'utilisateur. |

**Limites connues** : limiteur de tentatives en mémoire (une seule instance) ; chiffrement « au repos » assuré par les hébergeurs (Neon et Google Drive chiffrent les données ; vérifiez-le dans leurs conditions) ; pas de double authentification (prévu en évolution).

## Stockage externe (v1.2 · PostgreSQL + Google Drive)
- **Base** : connexion TLS (`sslmode=require`), requêtes paramétrées (aucune concaténation de valeurs utilisateur), journaux et historiques protégés par des **triggers PostgreSQL** (modification et suppression refusées, même par SQL direct).
- **Google Drive** : portée minimale `drive.file` (le serveur ne voit que ses propres fichiers) ; jeton de renouvellement uniquement dans les variables d'environnement ; aucun lien public créé ; téléchargements servis par l'API après contrôle des droits. Le compte Google propriétaire doit avoir la validation en deux étapes.
- **Écritures sérialisées** par le serveur (une instance) : pas de contournement des règles « deux validations » par requêtes simultanées.
