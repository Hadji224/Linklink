# Stockage des fichiers : Google Drive et pièces jointes temporaires

## Quels fichiers vont où
| Fichier | Où | Durée |
|---|---|---|
| **Documents** (module Documents) et **pièces jointes de tâches** | Google Drive (ou disque local si Drive n'est pas configuré) | Jusqu'à suppression |
| **Pièces jointes des messages** (images, fichiers envoyés dans un salon ou un message direct) | **Base PostgreSQL**, en relais temporaire, comme WhatsApp | `CHAT_FILE_RETENTION_DAYS` jours (30 par défaut), puis supprimées du serveur |

Pour les pièces jointes des messages :
- **L'appareil garde sa copie.** Dès qu'une image s'affiche ou qu'un fichier est téléchargé, le navigateur en garde une copie sur l'appareil ; elle reste lisible même après suppression sur le serveur. Un fichier jamais ouvert avant l'échéance s'affiche « expiré » et l'auteur doit le renvoyer.
- Taille maximale par pièce jointe : `CHAT_MAX_FILE_MB` (10 Mo). Au-delà, déposer le fichier dans Documents.
- La place occupée en base est plafonnée (`CHAT_STORE_BUDGET_MB`, 300 Mo, pour rester sous les 0,5 Go de Neon gratuit) : au-delà, les plus anciennes pièces jointes sont retirées en premier.
- La déconnexion volontaire efface les copies gardées sur l'appareil (ordinateur partagé) ; une session expirée les conserve.
- Le message reste dans la discussion avec le nom et la taille du fichier, marqué « expiré ».

# Stockage dans Google Drive

Quand Google Drive est configuré, **chaque fichier envoyé dans LinkLink est rangé dans un dossier « LinkLink » de votre Drive**, jamais sur le serveur. Les téléchargements et aperçus passent par le serveur : les droits LinkLink (rôles, projets, niveaux de confidentialité) restent appliqués, et aucun lien Drive public n'est créé. Supprimer un fichier (ou un compte, droit à l'oubli) le supprime **définitivement** de Drive.

## Ce qu'il faut savoir avant
- **Un compte Google dédié à l'équipe** est préférable à un compte personnel : il possède tous les fichiers. Activez la validation en deux étapes dessus.
- **Portée minimale** (`drive.file`) : l'application ne voit que les fichiers qu'elle a elle-même créés, jamais le reste du Drive.
- Les fichiers sont visibles dans le Drive de ce compte, dans le dossier « LinkLink ». Ne les supprimez pas à la main : le téléchargement dans LinkLink échouerait (vous pouvez les renommer ou les déplacer sans risque).
- Quota : celui du compte (15 Go gratuits). Limite par fichier côté LinkLink : `MAX_UPLOAD_MB` (25 Mo par défaut).
- Si Google Drive est indisponible, l'envoi d'un fichier échoue avec un message clair ; le reste de l'application continue de fonctionner.

## Mise en place (une seule fois, environ 15 minutes, faisable depuis un téléphone)

### 1. Créer le projet Google Cloud
1. Ouvrez <https://console.cloud.google.com> avec le compte Google choisi → **Nouveau projet** → nom « LinkLink ».
2. **API et services → Bibliothèque** → cherchez **Google Drive API** → **Activer**.

### 2. Écran de consentement — à publier absolument
1. **API et services → Écran de consentement OAuth** (ou *Google Auth platform*) → type d'utilisateur **Externe** → nom de l'application « LinkLink », adresse e-mail d'assistance = la vôtre.
2. **Publier l'application** (statut **« En production »**).
   > ⚠️ Si l'application reste en mode « Test », Google **invalide le jeton au bout de 7 jours** et les envois de fichiers s'arrêtent. La portée `drive.file` est « non sensible » : aucune vérification Google n'est demandée.

### 3. Créer l'identifiant OAuth
1. **Identifiants → Créer des identifiants → ID client OAuth**.
2. Type d'application : **Téléviseurs et appareils à saisie limitée**. Nom : « LinkLink serveur ».
3. Notez l'**ID client** et le **code secret du client**.

### 4. Obtenir le jeton de renouvellement
Sur n'importe quelle machine avec Node.js 22 et ce dépôt (Termux convient) :
```bash
cd linklink && npm ci
GOOGLE_CLIENT_ID="…" GOOGLE_CLIENT_SECRET="…" npm run drive:auth -w server
```
Le script affiche une adresse (`google.com/device`) et un code : ouvrez l'adresse sur votre téléphone, saisissez le code, connectez-vous avec le compte Google de l'équipe et autorisez. Le script affiche alors `GOOGLE_REFRESH_TOKEN=…`.

### 5. Configurer le serveur (Render → Environment)
Ajoutez directement dans le tableau de bord (ne les collez dans aucune conversation) :

| Variable | Valeur |
|---|---|
| `GOOGLE_CLIENT_ID` | l'ID client |
| `GOOGLE_CLIENT_SECRET` | le code secret |
| `GOOGLE_REFRESH_TOKEN` | le jeton affiché à l'étape 4 |

Redéployez. Dans les journaux du serveur, la ligne suivante confirme que tout fonctionne :
`Stockage des fichiers : Google Drive (connexion et dossier vérifiés)`. Le dossier « LinkLink » apparaît dans votre Drive. `GET /api/health` indique aussi `"storage":"drive"`.

## Reprendre des fichiers existants
- Les anciens fichiers stockés sur disque restent lisibles tant que le dossier `uploads` existe ; les nouveaux vont sur Drive (les deux moteurs coexistent).
- Import d'une ancienne base SQLite avec envoi des fichiers sur Drive :
  `npm run import:sqlite -w server -- linklink.db --uploads ./uploads` (avec `DATABASE_URL` et les variables Google définies).

## Dépannage
| Message dans les journaux | Cause | Solution |
|---|---|---|
| `jeton refusé (invalid_grant …)` | Jeton révoqué ou expiré (application restée en « Test ») | Publier l'application (étape 2) puis refaire l'étape 4 |
| `jeton refusé (invalid_client)` | ID ou secret erroné, ou mauvais type de client | Vérifier l'étape 3 (type « Téléviseurs… ») |
| `envoi refusé (403 … storageQuotaExceeded)` | Drive plein | Libérer de la place ou passer à un stockage supérieur |
| `envoi refusé (403 … accessNotConfigured)` | API Drive non activée | Étape 1.2 |
| Fichier « introuvable dans le stockage » | Supprimé à la main dans Drive | Le renvoyer dans LinkLink |
