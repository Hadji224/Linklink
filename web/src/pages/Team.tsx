import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { useApp } from '../data';
import { formatShortDate } from '../format';
import { go } from '../route';
import { ROLE_LABEL, type Role } from '../types';
import { Avatar, ErrorNote, Icon, PageHeader, RoleChip, useConfirm, useToast } from '../ui';

function CodeBox({ label, code, onRegenerate, help }: { label: string; code: string; onRegenerate?: () => void; help: string }) {
  const toast = useToast();
  return (
    <div className="card p-4">
      <h3 className="font-bold">{label}</h3>
      <p className="mt-0.5 text-sm text-slate">{help}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <code className="rounded-xl bg-mist px-4 py-2 text-xl font-bold tracking-widest" aria-label={`Code ${code.split('').join(' ')}`}>{code}</code>
        <button className="btn btn-ghost btn-sm" onClick={async () => {
          try { await navigator.clipboard.writeText(code); toast.success('Code copié'); } catch { toast.error('Copie impossible : sélectionnez le code à la main.'); }
        }}>Copier</button>
        {onRegenerate && <button className="btn btn-ghost btn-sm" onClick={onRegenerate}>Régénérer</button>}
      </div>
    </div>
  );
}

export function Team() {
  const { user } = useAuth();
  const { members, refreshMembers } = useApp();
  const confirm = useConfirm();
  const toast = useToast();
  const [codes, setCodes] = useState<{ code?: string; guestCode?: string }>({});
  const [error, setError] = useState('');
  const isAdmin = user?.role === 'admin';
  const canInvite = user?.role !== 'guest';

  useEffect(() => {
    if (canInvite) api<{ code: string; guestCode?: string }>('/invite').then(setCodes).catch(() => {});
  }, [canInvite]);

  async function regenerate(kind: 'member' | 'guest') {
    if (!(await confirm({ title: "Régénérer le code d'invitation ?", message: "L'ancien code ne fonctionnera plus.", confirmLabel: 'Régénérer' }))) return;
    try {
      const r = await api<{ code: string }>('/invite/regenerate', { method: 'POST', body: { kind } });
      setCodes((c) => (kind === 'guest' ? { ...c, guestCode: r.code } : { ...c, code: r.code }));
      toast.success('Nouveau code créé');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action impossible.');
    }
  }

  async function setRole(id: string, role: Role) {
    setError('');
    try {
      await api(`/members/${id}/role`, { method: 'PATCH', body: { role } });
      await refreshMembers();
      toast.success('Rôle modifié');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action impossible.');
    }
  }

  async function remove(id: string, name: string) {
    if (!(await confirm({ title: `Retirer ${name} ?`, message: 'Son compte et ses messages, fichiers et commentaires seront supprimés.', confirmLabel: 'Retirer', danger: true }))) return;
    try {
      await api(`/members/${id}`, { method: 'DELETE' });
      await refreshMembers();
      toast.success(`${name} a été retiré`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action impossible.');
    }
  }

  const online = members.filter((m) => m.online).length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader title="Équipe">
        <span className="text-sm text-slate">{members.length} membre{members.length > 1 ? 's' : ''} · {online} en ligne</span>
      </PageHeader>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3 md:mx-auto md:w-full md:max-w-3xl">
        <ErrorNote>{error}</ErrorNote>
        <ul className="space-y-2" aria-label="Membres">
          {members.map((m) => (
            <li key={m.id} className="card flex flex-wrap items-center gap-3 p-3">
              <Avatar name={m.name} size={44} online={m.online} />
              <div className="min-w-0 flex-1">
                <p className="truncate font-bold">{m.name} {m.id === user?.id && <span className="text-sm font-normal text-electric">(vous)</span>}</p>
                {m.role !== 'guest' || isAdmin ? <p className="truncate text-sm text-slate">{m.email}</p> : null}
                <p className="text-xs text-slate">Arrivé le {formatShortDate(m.createdAt)}</p>
              </div>
              {isAdmin && m.id !== user?.id ? (
                <select aria-label={`Rôle de ${m.name}`} className="field !w-auto" value={m.role} onChange={(e) => void setRole(m.id, e.target.value as Role)}>
                  {(Object.keys(ROLE_LABEL) as Role[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                </select>
              ) : <RoleChip role={m.role} />}
              {m.id !== user?.id && (
                <button className="btn btn-ghost btn-sm" onClick={() => go(`messages/dm/${m.id}`)} aria-label={`Écrire à ${m.name}`}><Icon name="chat" className="h-4 w-4" /> Écrire</button>
              )}
              {isAdmin && m.id !== user?.id && (
                <button className="rounded-lg p-2 text-slate hover:bg-red-50 hover:text-red-700" aria-label={`Retirer ${m.name}`} onClick={() => void remove(m.id, m.name)}><Icon name="trash" className="h-5 w-5" /></button>
              )}
            </li>
          ))}
        </ul>

        {canInvite && codes.code && (
          <CodeBox label="Code d'invitation — Fondateurs" code={codes.code} help="À donner à un nouveau fondateur : il pourra créer son compte avec ce code." onRegenerate={isAdmin ? () => void regenerate('member') : undefined} />
        )}
        {isAdmin && codes.guestCode && (
          <CodeBox label="Code d'invitation — Invités internes" code={codes.guestCode} help="Pour un prestataire temporaire : accès limité aux projets où vous l'ajoutez." onRegenerate={() => void regenerate('guest')} />
        )}
      </div>
    </div>
  );
}
