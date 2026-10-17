# Registre des traitements (RGPD, art. 30)

Responsable : LinkLink. Délégué : le Super Admin de la plateforme.

| Traitement | Finalité | Données | Personnes | Base légale | Destinataires | Durée |
| --- | --- | --- | --- | --- | --- | --- |
| Comptes et authentification | Accès sécurisé à la plateforme | Nom, e-mail, mot de passe haché, rôle, date de consentement | Membres de l'équipe, invités internes | Consentement et intérêt légitime (sécurité) | Équipe selon les rôles | Durée du compte |
| Collaboration (messages, tâches, commentaires, rendez-vous, fichiers) | Travail d'équipe | Contenus produits par les utilisateurs | Idem | Intérêt légitime / exécution de la mission | Participants selon accès et niveau de confidentialité | Durée du compte (suppression en cascade) |
| Notifications | Informer des échéances, mentions, rendez-vous | E-mail, événements | Idem | Intérêt légitime ; désactivable (e-mails) | Hébergeur SMTP (si activé) | 60 dernières conservées en liste |
| Journal d'activité | Traçabilité (qui a fait quoi) | Nom, action, date | Idem | Intérêt légitime (sécurité) | Super Admin | Anonymisé à la suppression du compte |
| Journaux d'accès | Sécurité, diagnostic | IP, identifiant, route, statut | Idem | Intérêt légitime (obligation de conservation) | Super Admin | 12 mois |
| Sauvegardes | Continuité | Copie de la base | Idem | Intérêt légitime | Administrateurs techniques | 30 jours |

## Droits des personnes
- **Accès / portabilité** : « Mon profil → Exporter mes données » (JSON).
- **Rectification** : modification du nom et de l'e-mail dans le profil.
- **Effacement** : « Mon profil → Supprimer mon compte » (mot de passe demandé) : compte, messages, fichiers, commentaires et notifications supprimés ; le journal d'activité est anonymisé. Le dernier Super Admin ne peut pas supprimer son compte.
- **Opposition** : e-mails de notification désactivables.

## Sous-traitants possibles
Hébergeur (UE de préférence) et fournisseur SMTP : à contractualiser (accord de traitement) avant la mise en production.
