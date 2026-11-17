# Spécification fonctionnelle v1.2 — état de l'implémentation

Ce document relie chaque chapitre de la *Spécification fonctionnelle LinkLink v1.2* au code et aux tests, et liste honnêtement les simplifications retenues.

## Modèle d'accès
- **Rôles d'accès** (inchangés en base) : `admin` = **Administrateur technique** (unique), `member` = **Fondateur**, `guest` = **Invité**.
- **Six fonctions** attribuées par le PDG (`user_functions`) : PDG, Coordinateur, Chef de projet, Chef d'infrastructures, Caissier, Chargé de communication. Fonction unique par personne et par titre, retrait/remplacement explicite, tout est journalisé.
- **Cumuls** (`access.ts › cumulCheck`) : PDG + Caissier interdit ; Administrateur technique + PDG seulement avec une décision journalisée ; Chargé de communication + PDG : avertissement.
- **Mandats** (`mandates`) : exploitation technique, porte-parole, remplacement d'un validateur, intérim ; ≤ 180 jours, révocables, actions journalisées « au titre d'un mandat ». **Absences** déclarées (le validateur absent reste en attente sauf remplaçant mandaté).
- Au démarrage, si aucun PDG n'existe, l'administrateur technique tient la fonction PDG (décision journalisée `Amorçage`) jusqu'à ce qu'il la transmette.
- Le rôle d'administrateur ne change que par **transfert d'administration** (demande → accord du PDG ou d'un autre fondateur → confirmation du successeur → rétrogradation de l'ancien).

## Modules
| Chapitre | Code serveur | Écran | Tests |
| --- | --- | --- | --- |
| Fonctions, mandats, absences | `routes/governance.ts`, `access.ts` | Gouvernance › Fonctions, Mandats | `governance.test.ts` (AC, MI) |
| Dépenses (brouillon → approbation → paiement → clôture, double approbation si le PDG est demandeur/bénéficiaire, plafond, écart à régulariser, justificatif + cosignature, modification importante = approbation invalidée) | `finance.ts`, `routes/expenses.ts` | Finances | `governance.test.ts` (DE) |
| Communications (5 circuits, validateurs indépendants, crise avec revue sous 24 h, modification après validation = validations invalidées, publication par le Chargé de communication, retrait) | `comms.ts`, `routes/communications.ts` | Communications | `governance.test.ts` (CO) |
| Projets (responsable avec fonction, détection des projets orphelins, propositions du Coordinateur, archivage en deux temps, réouverture, suppression par le PDG sans dépenses ni communications) | `routes/projects.ts` | Projets | `api.test.ts`, `governance.test.ts` (PR), e2e « archivage » |
| Tâches (rôles PDG/responsable, Coordinateur, créateur, assigné, observateur ; dépendances sans cycle) | `taskrules.ts`, `routes/tasks.ts` | Tâches | `api.test.ts`, `governance.test.ts` |
| Validations en attente, relances 24 h / 48 h / 120 h paramétrables par le PDG, escalade | `validations.ts`, `jobs.ts` | Gouvernance › Validations, Règles | `governance.test.ts` (VA) |
| Journaux immuables (métier, sécurité, urgence) — triggers SQL « immuable » | `db.ts`, `access.ts › audit` | Journaux | `migration.test.ts`, `governance.test.ts` |
| Accès d'urgence (deux détenteurs désignés par le PDG, codes personnels, activation conjointe, 2 h, seulement réinitialisation du mot de passe de l'administrateur + liste des sauvegardes) | `routes/governance.ts › /emergency` | Gouvernance › Sécurité | `governance.test.ts` (SE) |
| Suspension de compte (demandée par l'administrateur, validée par le PDG) | `routes/governance.ts › /account-actions` | Gouvernance › Validations | `governance.test.ts` (SE) |
| Dossier « Infrastructure » : refus des noms de fichiers évoquant un secret | `routes/files.ts` | Documents | `governance.test.ts` |

## Simplifications assumées
1. **Création de compte par code d'invitation** : pas de validation du PDG à l'inscription (le code reste le contrôle d'accès).
2. **Accès d'urgence limité** à la réinitialisation du mot de passe de l'administrateur et à la liste des sauvegardes ; aucune autre action n'est ouverte.
3. **L'administrateur technique ne lit pas les finances** ni les décisions métier sauf s'il tient une fonction (PDG de démarrage compris).
4. **Justificatif** : déclaratif + cosignature (pas de contrôle automatique du document).
5. **Statuts de projet** conservés (`active`, `paused`, `done`, `archived`) ; `done` signifie « Terminé — en attente d'archivage par le PDG ».
6. **Migration** : la base v3 est migrée en v4 avec copie de sécurité (`avant-migration-v4`) ; les anciens salons gardent leur description.
