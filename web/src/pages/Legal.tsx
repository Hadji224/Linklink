import type { ReactNode } from 'react';
import { Logo } from '../ui';

const H = ({ children }: { children: ReactNode }) => <h2 className="mt-6 text-lg font-bold">{children}</h2>;

function Cgu() {
  return (
    <>
      <h1 className="text-2xl font-bold">Conditions d'utilisation</h1>
      <p className="mt-2 text-sm text-slate">Version 1.0 — plateforme interne LinkLink</p>
      <H>1. Objet</H>
      <p className="mt-2">La plateforme LinkLink est l'outil interne de l'équipe : messages, projets et tâches, rendez-vous et dépôt de documents. Elle remplace les échanges de travail sur WhatsApp. L'accès se fait uniquement sur invitation.</p>
      <H>2. Rôles</H>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        <li><strong>Administrateur technique</strong> : exploitation de la plateforme (comptes, sauvegardes, sécurité). Il ne décide pas des dépenses ni des publications.</li>
        <li><strong>Fondateurs</strong> : tiennent une ou plusieurs fonctions (PDG, Coordinateur, Chef de projet, Chef d'infrastructures, Caissier, Chargé de communication), attribuées par le PDG.</li>
        <li><strong>Fondateur</strong> : accès aux projets et aux salons, création de projets et de rendez-vous.</li>
        <li><strong>Invité interne</strong> : prestataire temporaire, accès limité aux projets auxquels il est ajouté.</li>
      </ul>
      <H>3. Règles d'usage</H>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        <li>Ton respectueux et professionnel : aucun propos agressif, méprisant ou discriminatoire.</li>
        <li>Aucune annonce officielle (lancement, partenariat, résultat, décision) sans validation au bon niveau.</li>
        <li>Chaque document déposé reçoit un niveau de confidentialité : <em>Public</em>, <em>Interne</em>, <em>Confidentiel</em> ou <em>Strictement confidentiel</em>. Choisissez le niveau adapté, et ne diffusez pas à l'extérieur ce qui n'est pas public.</li>
        <li>Les accès techniques, mots de passe et données sensibles ne se partagent qu'en niveau « Strictement confidentiel », jamais dans un salon ouvert.</li>
        <li>Ne déposez que des contenus dont vous avez le droit de disposer.</li>
      </ul>
      <H>4. Compte et sécurité</H>
      <p className="mt-2">Vous êtes responsable de votre mot de passe. Ne le partagez pas. En cas de doute sur la sécurité de votre compte, changez votre mot de passe depuis votre profil et prévenez l'administrateur technique. Les actions importantes sont enregistrées dans un journal d'activité consultable par l'administrateur technique et le PDG (journaux métier, sécurité et urgence non modifiables).</p>
      <H>5. Fin d'accès</H>
      <p className="mt-2">L'administrateur technique peut suspendre un accès (validé par le PDG). Vous pouvez à tout moment supprimer votre compte depuis votre profil (voir la politique de confidentialité).</p>
    </>
  );
}

function Privacy() {
  return (
    <>
      <h1 className="text-2xl font-bold">Politique de confidentialité</h1>
      <p className="mt-2 text-sm text-slate">Version 1.0 — plateforme interne LinkLink</p>
      <H>1. Données collectées</H>
      <p className="mt-2">Nous collectons uniquement le nécessaire : nom, adresse e-mail, mot de passe (stocké sous forme chiffrée irréversible), rôle, date de consentement, ainsi que le contenu que vous produisez (messages, tâches, commentaires, fichiers, réponses aux rendez-vous) et un journal d'activité.</p>
      <H>2. Finalités</H>
      <p className="mt-2">Faire fonctionner la plateforme (authentification, collaboration, notifications) et assurer la sécurité et la traçabilité (journal d'activité, journaux d'accès). Aucune donnée n'est vendue ni utilisée à des fins publicitaires.</p>
      <H>3. Accès et confidentialité</H>
      <p className="mt-2">L'accès est limité selon les rôles et selon le niveau de confidentialité de chaque document. Les messages directs ne sont lisibles que par leurs deux participants.</p>
      <H>4. Durées de conservation</H>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        <li>Compte et contenus : tant que le compte existe.</li>
        <li>Journaux d'accès techniques : 12 mois.</li>
        <li>Sauvegardes de la base : 30 jours.</li>
      </ul>
      <H>5. Vos droits</H>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        <li><strong>Accès</strong> : exportez toutes vos données en un clic depuis <a className="font-semibold text-electric underline" href="#profil">Mon profil</a>.</li>
        <li><strong>Rectification</strong> : modifiez votre nom et votre e-mail depuis votre profil.</li>
        <li><strong>Effacement</strong> : supprimez votre compte depuis votre profil ; vos messages, fichiers, commentaires et notifications sont supprimés en cascade.</li>
      </ul>
      <p className="mt-2">Pour toute question ou demande, contactez l'administrateur technique, qui assure le rôle de délégué à la protection des données.</p>
      <H>6. Cookies et stockage local</H>
      <p className="mt-2">Aucun cookie de suivi. Votre navigateur conserve uniquement un jeton de session (30 jours) pour vous garder connecté ; il est effacé à la déconnexion.</p>
      <H>7. Hébergement et sécurité</H>
      <p className="mt-2">Connexion chiffrée (HTTPS), mots de passe hachés, en-têtes de sécurité, limitation des tentatives de connexion, fichiers servis uniquement en téléchargement, sauvegardes quotidiennes.</p>
    </>
  );
}

export function Legal({ doc, standalone }: { doc?: string; standalone: boolean }) {
  return (
    <div className="h-full overflow-y-auto bg-mist">
      <div className="mx-auto max-w-2xl px-4 py-6">
        <div className="mb-4 flex items-center justify-between">
          <Logo className="h-14" />
          <a href={standalone ? '#' : '#profil'} className="btn btn-ghost btn-sm">← Retour</a>
        </div>
        <article className="card p-5 text-[15px] leading-relaxed">{doc === 'confidentialite' ? <Privacy /> : <Cgu />}</article>
        <p className="mt-4 text-center text-sm">
          <a className="font-semibold text-electric underline" href="#legal/cgu">Conditions d'utilisation</a> ·{' '}
          <a className="font-semibold text-electric underline" href="#legal/confidentialite">Confidentialité</a>
        </p>
      </div>
    </div>
  );
}
