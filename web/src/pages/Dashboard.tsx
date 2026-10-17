import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { useApp } from '../data';
import { formatDateTime, formatDue } from '../format';
import { useRealtime, useRealtimeEvents } from '../realtime';
import type { Dashboard as Data } from '../types';
import { Empty, ErrorNote, Icon, PageHeader, PriorityChip, Spinner, type IconName } from '../ui';

function Kpi({ label, value, icon, href }: { label: string; value: number; icon: IconName; href: string }) {
  return (
    <a href={href} className="card flex items-center gap-3 p-4 hover:border-electric">
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-mist text-electric"><Icon name={icon} /></span>
      <span className="min-w-0">
        <span className="block text-2xl font-bold leading-none">{value}</span>
        <span className="block text-xs font-semibold leading-tight text-slate">{label}</span>
      </span>
    </a>
  );
}

export function Dashboard() {
  const { user } = useAuth();
  const { unreadMessages } = useApp();
  const { epoch } = useRealtime();
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setData(await api<Data>('/dashboard'));
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Chargement impossible.');
    }
  }, []);
  useEffect(() => { void load(); }, [load, epoch]);
  useRealtimeEvents((e) => { if (['task', 'meeting', 'message', 'project', 'file'].includes(e.type)) void load(); });

  const hour = new Date().getHours();
  const hello = hour < 18 ? 'Bonjour' : 'Bonsoir';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader title={`${hello} ${user?.name.split(' ')[0] ?? ''}`} />
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3 md:p-5">
        <ErrorNote>{error}</ErrorNote>
        {!data && !error && <Spinner />}
        {data && (
          <>
            <section aria-label="Indicateurs" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Kpi label="Projets actifs" value={data.kpis.activeProjects} icon="projects" href="#projets" />
              <Kpi label="Tâches terminées cette semaine" value={data.kpis.tasksDoneThisWeek} icon="check" href="#taches" />
              <Kpi label="Rendez-vous cette semaine" value={data.kpis.meetingsThisWeek} icon="calendar" href="#rendez-vous" />
              <Kpi label="Nouveaux fichiers (7 jours)" value={data.kpis.newFiles} icon="folder" href="#documents" />
            </section>

            <div className="grid gap-4 lg:grid-cols-3">
              <section className="card min-w-0 p-4 lg:col-span-2" aria-label="Mes tâches du jour">
                <div className="mb-2 flex items-center justify-between">
                  <h2 className="font-bold">Mes tâches du jour</h2>
                  <a href="#taches" className="text-sm font-semibold text-electric hover:underline">Toutes les tâches</a>
                </div>
                {data.myTasksToday.length === 0 ? (
                  <Empty>Aucune tâche à rendre aujourd'hui. 🎉</Empty>
                ) : (
                  <ul className="space-y-2">
                    {data.myTasksToday.map((t) => (
                      <li key={t.id}>
                        <a href={`#projets/${t.project.id}/taches/${t.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-line p-3 hover:bg-mist" style={{ borderLeft: `4px solid ${t.project.color}` }}>
                          <span className="min-w-0 flex-1 basis-40">
                            <span className="block truncate font-semibold">{t.title}</span>
                            <span className="text-xs text-slate">{t.project.name}</span>
                          </span>
                          <PriorityChip priority={t.priority} />
                          <span className={`text-xs font-semibold ${t.overdue ? 'text-red-700' : 'text-slate'}`}>{t.overdue ? 'En retard' : formatDue(t.dueDate)}</span>
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <div className="min-w-0 space-y-4">
                <section className="card p-4" aria-label="Rendez-vous à venir">
                  <h2 className="mb-2 font-bold">Rendez-vous à venir</h2>
                  {data.upcomingMeetings.length === 0 ? <Empty>Aucun rendez-vous prévu.</Empty> : (
                    <ul className="space-y-2">
                      {data.upcomingMeetings.map((m) => (
                        <li key={m.id}>
                          <a href="#rendez-vous" className="block rounded-xl p-2 hover:bg-mist">
                            <span className="block font-semibold">{m.title}</span>
                            <span className="text-xs text-slate">{formatDateTime(m.startsAt)}</span>
                          </a>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
                <section className="card p-4" aria-label="Messages non lus">
                  <h2 className="mb-2 font-bold">Messages non lus {unreadMessages > 0 && <span className="text-sm font-normal text-slate">({unreadMessages})</span>}</h2>
                  {data.unreadChannels.length === 0 ? <Empty>Vous êtes à jour.</Empty> : (
                    <ul className="space-y-1">
                      {data.unreadChannels.map((c) => (
                        <li key={c.id}>
                          <a href="#messages" className="flex items-center justify-between rounded-xl p-2 hover:bg-mist">
                            <span className="font-semibold">{c.kind === 'dm' ? c.name : `# ${c.name}`}</span>
                            <span className="rounded-full bg-cyan px-2 text-xs font-bold text-navy">{c.unread}</span>
                          </a>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
