# Registre des traitements (RGPD, art. 30)

Responsable : LinkLink. Délégué : l'administrateur technique de la plateforme.

| Traitement | Finalité | Données | Personnes | Base légale | Destinataires | Durée |
| --- | --- | --- | --- | --- | --- | --- |
| Comptes et authentification | Accès sécurisé à la plateforme | Nom, e-mail, mot de passe haché, rôle, date de consentement | Membres de l'équipe, invités internes | Consentement et intérêt légitime (sécurité) | Équipe selon les rôles | Durée du compte |
| Collaboration (messages, tâches, commentaires, rendez-vous, fichiers) | Travail d'équipe | Contenus produits par les utilisateurs | Idem | Intérêt légitime / exécution de la mission | Participants selon accès et niveau de confidentialité | Durée du compte (suppression en cascade) |
| Notifications | Informer des échéances, mentions, rendez-vous | E-mail, événements | Idem | Intérêt légitime ; désactivable (e-mails) | Hébergeur SMTP (si activé) | 60 dernières conservées en liste |
| Journal d'activité | Traçabilité (qui a fait quoi) | Nom, action, date | Idem | Intérêt légitime (sécurité) | Administrateur technique, PDG | Anonymisé à la suppression du compte |
| Journaux d'accès | Sécurité, diagnostic | IP, identifiant, route, statut (stockés dans la base, table `access_logs`) | Idem | Intérêt légitime (obligation de conservation) | Administrateur technique, PDG ; sous-traitant : Neon | 12 mois (purge automatique quotidienne) |
| Compteurs anti force brute | Sécurité (blocage des tentatives abusives) | IP, clé de compte (adresse e-mail normalisée) | Idem | Intérêt légitime (sécurité) | Serveur uniquement | Fenêtre de 15 min, purge automatique |
| Sauvegardes | Continuité | Copie de la base (PostgreSQL / Neon) | Idem | Intérêt légitime | Administrateurs techniques ; sous-traitant : Neon | Historique Neon (selon l'offre) + copies à la demande |
| Fichiers déposés (Documents, tâches) | Partage de documents | Contenu des fichiers | Équipe | Intérêt légitime | Selon niveau de confidentialité ; sous-traitant : Google (Drive) | Jusqu'à suppression (définitive dans Drive) |
| Pièces jointes des messages | Échange de fichiers dans les discussions | Contenu des fichiers | Participants du salon | Intérêt légitime | Selon l'accès au salon ; sous-traitant : Neon (base). Copie locale sur l'appareil de chaque lecteur (effacée à la déconnexion volontaire) | 30 jours sur le serveur (réglable), puis suppression automatique |

## Droits des personnes
- **Accès / portabilité** : « Mon profil → Exporter mes données » (JSON).
- **Rectification** : modification du nom et de l'e-mail dans le profil.
- **Effacement** : « Mon profil → Supprimer mon compte » (mot de passe demandé) : compte, messages, fichiers, commentaires et notifications supprimés ; le journal d'activité est anonymisé. L'administrateur technique ne peut pas supprimer son compte : il doit d'abord transférer l'administration.
- **Opposition** : e-mails de notification désactivables.

## Sous-traitants possibles
Hébergeur (UE de préférence) et fournisseur SMTP : à contractualiser (accord de traitement) avant la mise en production.
