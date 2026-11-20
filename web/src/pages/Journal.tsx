import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { formatDateTime } from '../format';
import { useRealtime } from '../realtime';
import type { ActivityItem } from '../types';
import { useCan } from '../perm';
import { go } from '../route';
import { Empty, ErrorNote, PageHeader, Spinner, Tabs } from '../ui';

type JournalTab = 'activite' | 'metier' | 'securite' | 'urgence';
interface Entry { id: string; userName: string; action: string; summary: string; details: string; mandate: boolean; result: string; createdAt: string }

/** Trois journaux immuables (spécification v1.2 §11) + l'activité générale. Chacun n'est visible que de ceux qui en ont besoin. */
export function Journal({ tab }: { tab?: string }) {
  const { can, isAdmin } = useCan();
  const tabs: { id: JournalTab; label: string }[] = [
    ...(isAdmin || can('journal.business') ? [{ id: 'activite' as const, label: 'Activité' }] : []),
    ...(can('journal.business') ? [{ id: 'metier' as const, label: 'Décisions métier' }] : []),
    ...(can('journal.security') ? [{ id: 'securite' as const, label: 'Sécurité' }] : []),
    ...(can('journal.emergency') ? [{ id: 'urgence' as const, label: 'Urgence' }] : []),
  ];
  const current = (tabs.find((t) => t.id === tab)?.id ?? tabs[0]?.id) as JournalTab | undefined;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader title="Journaux" />
      <Tabs<JournalTab> label="Journaux" value={current ?? 'activite'} onChange={(t) => go(`journal/${t}`)} tabs={tabs} />
      <div className="min-h-0 flex-1">
        {current === 'activite' && <Activity />}
        {current === 'metier' && <EntryList key="business" category="business" intro="Décisions et opérations métier : fonctions, dépenses, validations, projets, mandats. Réservé au PDG. Aucune entrée ne peut être modifiée ni supprimée." />}
        {current === 'securite' && <EntryList key="security" category="security" intro="Accès refusés, téléchargements sensibles, transferts d'administration, suspensions. Visible de l'administrateur technique et du Chef d'infrastructures. Immuable." />}
        {current === 'urgence' && <EntryList key="emergency" category="emergency" intro="Chaque usage de l'accès d'urgence, visible de tous les fondateurs. Immuable." />}
        {!current && <Empty icon="shield">Aucun journal n'est accessible avec votre profil.</Empty>}
      </div>
    </div>
  );
}

function EntryList({ category, intro }: { category: 'business' | 'security' | 'emergency'; intro: string }) {
  const { epoch } = useRealtime();
  const [items, setItems] = useState<Entry[] | null>(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    api<{ entries: Entry[] }>(`/journal/${category}?limit=200${q ? `&q=${encodeURIComponent(q)}` : ''}`).then((r) => { setItems(r.entries); setError(''); }).catch((e) => setError(e instanceof Error ? e.message : 'Chargement impossible.'));
  }, [category, q, epoch]);
  return (
    <div className="h-full overflow-y-auto p-3 md:px-[max(0.75rem,calc((100%_-_48rem)/2))]">
      <p className="mb-3 text-sm text-slate">{intro}</p>
      <input className="field mb-3" placeholder="Filtrer (nom, action…)" aria-label="Filtrer le journal" value={q} onChange={(e) => setQ(e.target.value)} />
      <ErrorNote>{error}</ErrorNote>
      {!items && !error && <Spinner />}
      {items && items.length === 0 && <Empty icon="shield">Aucune entrée.</Empty>}
      <ul className="divide-y divide-line overflow-hidden rounded-2xl bg-white ring-1 ring-line">
        {items?.map((i) => (
          <li key={i.id} className="px-4 py-2.5 text-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
              <span><strong>{i.userName}</strong> — {i.summary}{i.mandate && <span className="badge bd-cyan ml-2">Au titre d'un mandat</span>}{i.result === 'denied' && <span className="badge bd-danger ml-2">Refusé</span>}</span>
              <time className="text-xs text-slate" dateTime={i.createdAt}>{formatDateTime(i.createdAt)}</time>
            </div>
            {i.details && <p className="text-xs text-slate">{i.details}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Activity() {
  const { epoch } = useRealtime();
  const [items, setItems] = useState<ActivityItem[] | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState('');
  const [logs, setLogs] = useState<string[] | null>(null);
  const [q, setQ] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await api<{ activity: ActivityItem[]; hasMore: boolean }>('/activity?limit=100');
      setItems(r.activity);
      setMore(r.hasMore);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Chargement impossible.');
    }
  }, []);
  useEffect(() => { void load(); }, [load, epoch]);

  async function older() {
    const last = items?.at(-1);
    if (!last) return;
    const r = await api<{ activity: ActivityItem[]; hasMore: boolean }>(`/activity?limit=100&before=${encodeURIComponent(last.createdAt)}`);
    setItems((l) => [...(l ?? []), ...r.activity]);
    setMore(r.hasMore);
  }

  async function showLogs() {
    try {
      setLogs((await api<{ lines: string[] }>('/admin/access-logs')).lines);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Chargement impossible.');
    }
  }

  const needle = q.trim().toLowerCase();
  const shown = (items ?? []).filter((i) => !needle || `${i.userName} ${i.summary}`.toLowerCase().includes(needle));

  const { isAdmin } = useCan();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto p-3 md:px-[max(0.75rem,calc((100%_-_48rem)/2))]">
        <p className="mb-3 text-sm text-slate">Qui a fait quoi, dans les projets, tâches et fichiers. Visible de l'administrateur technique et du PDG. {isAdmin && <button className="font-semibold text-electric underline" onClick={() => void showLogs()}>Logs d'accès récents</button>}</p>
        <input className="field mb-3" placeholder="Filtrer (nom, action…)" aria-label="Filtrer le journal" value={q} onChange={(e) => setQ(e.target.value)} />
        <ErrorNote>{error}</ErrorNote>
        {!items && !error && <Spinner />}
        {items && shown.length === 0 && <Empty icon="shield">Aucune entrée.</Empty>}
        <ul className="divide-y divide-line overflow-hidden rounded-2xl bg-white ring-1 ring-line">
          {shown.map((i) => (
            <li key={i.id} className="flex flex-wrap items-baseline justify-between gap-x-3 px-4 py-2.5 text-sm">
              <span><strong>{i.userName}</strong> — {i.summary}</span>
              <time className="text-xs text-slate" dateTime={i.createdAt}>{formatDateTime(i.createdAt)}</time>
            </li>
          ))}
        </ul>
        {more && <div className="mt-3 text-center"><button className="btn btn-ghost btn-sm" onClick={() => void older()}>Entrées plus anciennes</button></div>}
        {logs && (
          <section className="mt-6" aria-label="Logs d'accès">
            <h2 className="mb-2 font-bold">Logs d'accès (200 dernières lignes)</h2>
            <pre className="max-h-80 overflow-auto rounded-2xl bg-navy p-3 text-[11px] leading-relaxed text-blue-100">{logs.join('\n') || 'Aucun log.'}</pre>
          </section>
        )}
      </div>
    </div>
  );
}
