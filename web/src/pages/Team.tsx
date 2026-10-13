import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { formatShortDate } from '../format';
import type { Member } from '../types';
import { Avatar, ErrorNote, PageHeader, Spinner } from '../ui';

export function Team() {
  const { user, logout } = useAuth();
  const [members, setMembers] = useState<Member[] | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const isAdmin = user?.role === 'admin';

  const load = useCallback(async () => {
    try {
      const r = await api<{ members: Member[] }>('/members');
      setMembers(r.members);
      if (isAdmin) setCode((await api<{ code: string }>('/invite')).code);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Chargement impossible.');
    }
  }, [isAdmin]);

  useEffect(() => {
    void load();
  }, [load]);

  async function copy(label: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied(''), 2000);
    } catch {
      setError('Copie impossible : sélectionnez le texte manuellement.');
    }
  }

  async function regenerate() {
    if (!window.confirm("Générer un nouveau code ? L'ancien ne fonctionnera plus.")) return;
    try {
      setCode((await api<{ code: string }>('/invite/regenerate', { method: 'POST' })).code);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action impossible.');
    }
  }

  async function setRole(m: Member, role: 'admin' | 'member') {
    setError('');
    try {
      await api(`/members/${m.id}/role`, { method: 'PATCH', body: { role } });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action impossible.');
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader title="Équipe">
        <button className="btn btn-ghost" onClick={logout}>
          Se déconnecter
        </button>
      </PageHeader>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 md:mx-auto md:w-full md:max-w-3xl">
        <ErrorNote>{error}</ErrorNote>

        {isAdmin && code && (
          <section className="card space-y-2 border-amber-200 bg-amber-50 p-4">
            <h2 className="font-semibold">Inviter un membre</h2>
            <p className="text-sm text-slate-700">Envoyez-lui ce lien et ce code d'invitation. Il crée son compte lui-même.</p>
            <p className="rounded-lg bg-white px-3 py-2 text-center font-mono text-xl font-bold tracking-widest">{code}</p>
            <div className="flex flex-wrap gap-2">
              <button className="btn btn-ghost" onClick={() => void copy('code', code)}>
                {copied === 'code' ? 'Copié ✓' : 'Copier le code'}
              </button>
              <button className="btn btn-ghost" onClick={() => void copy('lien', location.origin)}>
                {copied === 'lien' ? 'Copié ✓' : "Copier l'adresse du site"}
              </button>
              <button className="btn btn-ghost" onClick={() => void regenerate()}>
                Nouveau code
              </button>
            </div>
          </section>
        )}

        {members === null && !error && <Spinner />}
        <ul className="space-y-2">
          {members?.map((m) => (
            <li key={m.id} className="card flex items-center gap-3 p-3">
              <Avatar name={m.name} size={40} />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">
                  {m.name}
                  {m.id === user?.id && <span className="ml-1 text-xs text-slate-400">(vous)</span>}
                </p>
                <p className="truncate text-xs text-slate-500">
                  {m.email} · membre depuis le {formatShortDate(m.createdAt)}
                </p>
              </div>
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${m.role === 'admin' ? 'bg-teal-100 text-teal-800' : 'bg-slate-100 text-slate-600'}`}>
                {m.role === 'admin' ? 'Admin' : 'Membre'}
              </span>
              {isAdmin && m.id !== user?.id && (
                <button className="btn btn-ghost !px-2.5 !py-1.5 text-xs" onClick={() => void setRole(m, m.role === 'admin' ? 'member' : 'admin')}>
                  {m.role === 'admin' ? 'Retirer admin' : 'Rendre admin'}
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
