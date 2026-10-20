import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { formatDateTime } from '../format';
import { useRealtime } from '../realtime';
import type { ActivityItem } from '../types';
import { Empty, ErrorNote, PageHeader, Spinner } from '../ui';

export function Journal() {
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

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader title="Journal d'activité">
        <button className="btn btn-ghost btn-sm" onClick={() => void showLogs()}>Logs d'accès récents</button>
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto p-3 md:mx-auto md:w-full md:max-w-3xl">
        <p className="mb-3 text-sm text-slate">Qui a fait quoi. Visible uniquement par le Super Admin. Les journaux d'accès techniques sont conservés 12 mois.</p>
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
