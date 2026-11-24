import { useState, type FormEvent } from 'react';
import { api, downloadBlob, setToken } from '../api';
import { useAuth } from '../auth';
import { FN_LABEL, ROLE_LABEL, type User } from '../types';
import { Avatar, ErrorNote, Field, Modal, PageHeader, RoleChip, useConfirm, useToast } from '../ui';

export function Profile() {
  const { user, setUser, logout } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const [name, setName] = useState(user?.name ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [emailNotif, setEmailNotif] = useState(user?.emailNotif ?? true);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [error, setError] = useState('');
  const [pwError, setPwError] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [delPw, setDelPw] = useState('');
  const [delError, setDelError] = useState('');

  async function save(e: FormEvent) {
    e.preventDefault();
    setError('');
    try {
      const r = await api<{ user: User }>('/me', { method: 'PATCH', body: { name, email, emailNotif } });
      setUser({ ...r.user, emailNotif });
      toast.success('Profil enregistré');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Enregistrement impossible.');
    }
  }

  async function changePassword(e: FormEvent) {
    e.preventDefault();
    setPwError('');
    try {
      const r = await api<{ token: string }>('/me/password', { method: 'POST', body: { current, next } });
      setToken(r.token); // les autres appareils sont déconnectés, celui-ci reste connecté
      setCurrent('');
      setNext('');
      toast.success('Mot de passe modifié');
    } catch (err) {
      setPwError(err instanceof Error ? err.message : 'Modification impossible.');
    }
  }

  async function revokeAll() {
    if (!(await confirm({ title: 'Déconnecter tous mes appareils ?', message: "Toutes les sessions ouvertes (téléphone, ordinateur…) seront fermées. Celle-ci reste connectée.", confirmLabel: 'Déconnecter les autres appareils' }))) return;
    try {
      const r = await api<{ token: string }>('/me/sessions/revoke', { method: 'POST', body: {} });
      setToken(r.token);
      toast.success('Tous les autres appareils sont déconnectés');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Action impossible.');
    }
  }

  async function exportData() {
    try {
      await downloadBlob('/me/export', 'mes-donnees-linklink.json');
      toast.success('Export téléchargé');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Export impossible.');
    }
  }

  async function deleteAccount(e: FormEvent) {
    e.preventDefault();
    setDelError('');
    try {
      await api('/me', { method: 'DELETE', body: { password: delPw } });
      logout();
    } catch (err) {
      setDelError(err instanceof Error ? err.message : 'Suppression impossible.');
    }
  }

  if (!user) return null;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader title="Mon profil" />
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3 md:px-[max(0.75rem,calc((100%_-_42rem)/2))]">
        <section className="card flex items-center gap-4 p-4">
          <Avatar name={user.name} size={56} />
          <div>
            <p className="text-lg font-bold">{user.name}</p>
            <p className="text-sm text-slate">{user.email}</p>
            <div className="mt-1"><RoleChip role={user.role} /></div>
          </div>
        </section>

        <form onSubmit={save} className="card space-y-3 p-4">
          <h2 className="font-bold">Informations</h2>
          <Field label="Nom complet"><input className="field" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} autoComplete="name" /></Field>
          <Field label="Adresse e-mail"><input className="field" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" /></Field>
          <p className="text-sm text-slate">Votre rôle d'accès ({ROLE_LABEL[user.role]}) ne donne pas de pouvoir métier. {user.functions?.length ? <>Vos fonctions : <strong>{user.functions.map((f) => FN_LABEL[f]).join(', ')}</strong>.</> : 'Vous n\'avez pas de fonction pour l\'instant.'} Absences, mandats et accès d'urgence : <a className="font-semibold text-electric" href="#gouvernance/mandats">Gouvernance</a>.</p>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5 h-5 w-5 accent-[#135fea]" checked={emailNotif} onChange={(e) => setEmailNotif(e.target.checked)} />
            <span><strong>Recevoir les notifications par e-mail</strong><br /><span className="text-slate">Assignations, mentions, rappels d'échéance et de rendez-vous.</span></span>
          </label>
          <ErrorNote>{error}</ErrorNote>
          <button className="btn btn-primary">Enregistrer</button>
        </form>

        <form onSubmit={changePassword} className="card space-y-3 p-4">
          <h2 className="font-bold">Mot de passe</h2>
          <Field label="Mot de passe actuel"><input className="field" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required /></Field>
          <Field label="Nouveau mot de passe" hint="8 caractères minimum. Vos autres appareils seront déconnectés."><input className="field" type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" minLength={8} required /></Field>
          <ErrorNote>{pwError}</ErrorNote>
          <button className="btn btn-primary">Changer le mot de passe</button>
        </form>

        <section className="card space-y-3 p-4">
          <h2 className="font-bold">Sessions</h2>
          <p className="text-sm text-slate">Votre session reste ouverte 7 jours et se prolonge tant que vous utilisez l'application. Si vous avez perdu un téléphone ou utilisé un appareil partagé, fermez toutes les autres sessions.</p>
          <button className="btn btn-ghost" onClick={() => void revokeAll()}>Déconnecter tous mes appareils</button>
        </section>

        <section className="card space-y-3 p-4">
          <h2 className="font-bold">Mes données (RGPD)</h2>
          <p className="text-sm text-slate">Vous pouvez récupérer toutes vos données, ou supprimer votre compte. Détails dans la <a className="font-semibold text-electric underline" href="#legal/confidentialite">politique de confidentialité</a> et les <a className="font-semibold text-electric underline" href="#legal/cgu">conditions d'utilisation</a>.</p>
          <div className="flex flex-wrap gap-2">
            <button className="btn btn-ghost" onClick={() => void exportData()}>Exporter mes données</button>
            <button className="btn btn-danger" onClick={() => setDeleting(true)}>Supprimer mon compte</button>
          </div>
        </section>

        <button className="btn btn-ghost w-full" onClick={async () => { if (await confirm({ title: 'Se déconnecter ?', confirmLabel: 'Se déconnecter' })) logout(); }}>Se déconnecter</button>
      </div>

      {deleting && (
        <Modal title="Supprimer mon compte" onClose={() => setDeleting(false)}>
          <form onSubmit={deleteAccount} className="space-y-3">
            <p className="text-sm">Cette action est <strong>définitive</strong> : votre compte, vos messages, vos fichiers, vos commentaires et vos notifications seront supprimés.</p>
            <Field label="Confirmez avec votre mot de passe"><input className="field" type="password" value={delPw} onChange={(e) => setDelPw(e.target.value)} autoComplete="current-password" required /></Field>
            <ErrorNote>{delError}</ErrorNote>
            <div className="flex justify-end gap-2">
              <button type="button" className="btn btn-ghost" onClick={() => setDeleting(false)}>Annuler</button>
              <button className="btn btn-danger-solid">Supprimer définitivement</button>
            </div>
          </form>
        </Modal>
      )}
      <p className="pb-4 text-center text-xs text-slate">LinkLink {__APP_VERSION__}</p>
    </div>
  );
}
