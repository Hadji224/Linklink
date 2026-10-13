# LinkLink

Application d'organisation et de communication de l'équipe LinkLink.
Elle remplace WhatsApp pour trois usages : **discuter**, **organiser les rendez-vous** et **déposer les dossiers**.

## Fonctions

- **Messages en direct** dans des salons (`#général`, `#annonces`, et ceux que les admins créent). Pièces jointes, liens cliquables, historique, compteur de messages non lus.
- **Rendez-vous** : création avec date, lieu ou lien de visio, réponse « Présent / Peut-être / Absent » de chacun, export vers l'agenda du téléphone (`.ics`).
- **Documents** : dépôt de fichiers (25 Mo max) classés par dossier, recherche, téléchargement. Les fichiers envoyés dans un salon sont aussi rangés ici.
- **Équipe** : liste des membres, rôles admin / membre, code d'invitation.
- Utilisable sur téléphone (installable comme une application depuis le navigateur) et sur ordinateur.

## Démarrer

Prérequis : [Node.js](https://nodejs.org) 22.13 ou plus récent.

```bash
npm install
npm run build     # compile l'interface web
npm start         # lance le serveur sur http://localhost:3000
```

Au lancement, le serveur affiche le **code d'invitation** des nouveaux membres.

1. Ouvrez http://localhost:3000 : le **premier compte créé devient administrateur**.
2. Les autres membres créent leur compte avec le code d'invitation (visible dans l'onglet *Équipe* pour les admins, et renouvelable).

### Développement

```bash
npm run dev       # serveur (port 3000) + interface avec rechargement (port 5173)
npm run typecheck # vérification des types
```

## Configuration

| Variable      | Rôle                                                              | Défaut         |
| ------------- | ----------------------------------------------------------------- | -------------- |
| `PORT`        | Port du serveur                                                   | `3000`         |
| `DATA_DIR`    | Dossier de la base de données et des fichiers déposés             | `server/data`  |
| `TRUST_PROXY` | `true` si le serveur est derrière un proxy (Nginx, Render…)       | désactivé      |

Toutes les données (base SQLite + fichiers) sont dans `DATA_DIR` : **sauvegardez ce dossier** régulièrement.

## Mise en ligne

Pour que l'équipe y accède depuis ses téléphones, hébergez le serveur sur une machine qui reste allumée (VPS, Render, Railway, Fly.io…) avec un **disque persistant** monté sur `DATA_DIR`, et servez-le en **HTTPS** (indispensable pour les mots de passe et pour installer l'application sur le téléphone).

## Architecture

```
server/   API Express + WebSocket (temps réel) + SQLite (node:sqlite), TypeScript
web/      Interface React + Tailwind (Vite), TypeScript
```

- Authentification par e-mail + mot de passe (bcrypt), session par jeton JWT de 30 jours.
- Les salons sont ouverts à tous les membres connectés ; `#annonces` est réservé aux admins en écriture.
- Les fichiers sont téléchargés en pièce jointe (jamais exécutés par le navigateur).

## Pistes pour la suite

- Messages privés entre deux membres et salons privés
- Notifications push sur téléphone
- Appels / visio intégrés
- Rappels automatiques avant un rendez-vous
- Sauvegarde automatique et export des données
