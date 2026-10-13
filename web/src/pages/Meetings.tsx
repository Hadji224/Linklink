import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { formatDateTime, formatDay, formatTime, toLocalInputValue } from '../format';
import { useRealtime, useRealtimeEvents } from '../realtime';
import type { Meeting, RsvpStatus } from '../types';
import { ErrorNote, Icon, PageHeader, Spinner } from '../ui';

const STATUS_LABEL: Record<RsvpStatus, string> = { yes: 'Présent', maybe: 'Peut-être', no: 'Absent' };
const STATUS_STYLE: Record<RsvpStatus, string> = {
  yes: 'bg-emerald-100 text-emerald-800',
  maybe: 'bg-amber-100 text-amber-800',
  no: 'bg-slate-200 text-slate-600',
};

/** Fichier .ics : permet d'ajouter le rendez-vous à Google Agenda, Apple Calendrier, Outlook… */
function downloadIcs(m: Meeting) {
  const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
  const start = new Date(m.startsAt);
  const end = new Date(start.getTime() + 60 * 60_000);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//LinkLink//FR',
    'BEGIN:VEVENT',
    `UID:${m.id}@linklink`,
    `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${stamp(start)}`,
    `DTEND:${stamp(end)}`,
    `SUMMARY:${esc(m.title)}`,
    m.location ? `LOCATION:${esc(m.location)}` : '',
    m.description ? `DESCRIPTION:${esc(m.description)}` : '',
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean);
  const blob = new Blob([lines.join('\r\n')], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${m.title.replace(/[^\p{L}\p{N}]+/gu, '-').slice(0, 40) || 'rendez-vous'}.ics`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const isUrl = (s: string) => /^https?:\/\/\S+$/.test(s);

function MeetingCard({ m, onChange, past }: { m: Meeting; onChange: () => void; past?: boolean }) {
  const { user } = useAuth();
  const [error, setError] = useState('');
  const canDelete = user?.role === 'admin' || user?.id === m.createdBy.id;

  async function rsvp(status: RsvpStatus) {
    setError('');
    try {
      await api(`/meetings/${m.id}/rsvp`, { method: 'POST', body: { status } });
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action impossible.');
    }
  }

  async function remove() {
    if (!window.confirm(`Supprimer « ${m.title} » ?`)) return;
    try {
      await api(`/meetings/${m.id}`, { method: 'DELETE' });
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Suppression impossible.');
    }
  }

  const start = new Date(m.startsAt);
  const groups = (['yes', 'maybe', 'no'] as RsvpStatus[]).map((s) => ({
    status: s,
    people: m.attendees.filter((a) => a.status === s),
  }));

  return (
    <article className={`card flex gap-3 p-3 ${past ? 'opacity-70' : ''}`}>
      <div className="flex h-14 w-14 shrink-0 flex-col items-center justify-center rounded-xl bg-teal-50 text-teal-800">
        <span className="text-xl font-bold leading-none">{start.getDate()}</span>
        <span className="text-xs uppercase">{start.toLocaleDateString('fr-FR', { month: 'short' })}</span>
      </div>
      <div className="min-w-0 flex-1">
        <h3 className="font-semibold">{m.title}</h3>
        <p className="text-sm text-slate-600">
          {formatDay(m.startsAt)} à {formatTime(m.startsAt)}
        </p>
        {m.location && (
          <p className="truncate text-sm text-slate-600">
            📍{' '}
            {isUrl(m.location) ? (
              <a href={m.location} target="_blank" rel="noopener noreferrer" className="text-teal-800 underline">
                {m.location}
              </a>
            ) : (
              m.location
            )}
          </p>
        )}
        {m.description && <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{m.description}</p>}
        <p className="mt-1 text-xs text-slate-400">Organisé par {m.createdBy.name}</p>

        <div className="mt-2 flex flex-wrap gap-1.5">
          {(['yes', 'maybe', 'no'] as RsvpStatus[]).map((s) => (
            <button
              key={s}
              onClick={() => void rsvp(s)}
              aria-pressed={m.myStatus === s}
              className={`rounded-full border px-3 py-1 text-sm font-medium ${
                m.myStatus === s ? 'border-teal-700 bg-teal-700 text-white' : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
              }`}
            >
              {STATUS_LABEL[s]}
            </button>
          ))}
          <button onClick={() => downloadIcs(m)} className="rounded-full border border-slate-300 px-3 py-1 text-sm text-slate-700 hover:bg-slate-50">
            + Agenda
          </button>
          {canDelete && (
            <button onClick={() => void remove()} className="rounded-full px-2 py-1 text-slate-400 hover:text-red-600" aria-label="Supprimer">
              <Icon name="trash" className="h-4 w-4" />
            </button>
          )}
        </div>

        {m.attendees.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {groups.flatMap((g) =>
              g.people.map((p) => (
                <span key={p.userId} className={`rounded-full px-2 py-0.5 text-xs ${STATUS_STYLE[g.status]}`}>
                  {p.name} · {STATUS_LABEL[g.status].toLowerCase()}
                </span>
              )),
            )}
          </div>
        )}
        <ErrorNote>{error}</ErrorNote>
      </div>
    </article>
  );
}

export function Meetings() {
  const { epoch } = useRealtime();
  const [meetings, setMeetings] = useState<Meeting[] | null>(null);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api<{ meetings: Meeting[] }>('/meetings');
      setMeetings(r.meetings);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Chargement impossible.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, epoch]);

  useRealtimeEvents((e) => {
    if (e.type === 'meeting') void load();
  });

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError('');
    try {
      await api('/meetings', {
        method: 'POST',
        body: {
          title: String(form.get('title') ?? ''),
          startsAt: new Date(String(form.get('startsAt'))).toISOString(),
          location: String(form.get('location') ?? ''),
          description: String(form.get('description') ?? ''),
        },
      });
      setShowForm(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Création impossible.');
    } finally {
      setBusy(false);
    }
  }

  const nowMs = Date.now();
  // Un rendez-vous reste « à venir » jusqu'à 2 h après son début.
  const upcoming = meetings?.filter((m) => +new Date(m.startsAt) + 2 * 3600_000 >= nowMs) ?? [];
  const past = (meetings?.filter((m) => +new Date(m.startsAt) + 2 * 3600_000 < nowMs) ?? []).reverse();
  const defaultStart = new Date(Date.now() + 24 * 3600_000);
  defaultStart.setMinutes(0, 0, 0);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader title="Rendez-vous">
        <button className="btn btn-primary" onClick={() => setShowForm((v) => !v)}>
          <Icon name="plus" className="h-4 w-4" /> Nouveau
        </button>
      </PageHeader>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 md:mx-auto md:w-full md:max-w-3xl">
        {showForm && (
          <form onSubmit={create} className="card space-y-3 border-teal-200 bg-teal-50/40 p-4">
            <label className="block text-sm font-medium">
              Titre
              <input name="title" className="field mt-1" placeholder="ex. Point hebdomadaire" required maxLength={120} />
            </label>
            <label className="block text-sm font-medium">
              Date et heure
              <input name="startsAt" type="datetime-local" className="field mt-1" defaultValue={toLocalInputValue(defaultStart)} required />
            </label>
            <label className="block text-sm font-medium">
              Lieu ou lien de visio (facultatif)
              <input name="location" className="field mt-1" placeholder="Bureau, Google Meet, https://…" maxLength={200} />
            </label>
            <label className="block text-sm font-medium">
              Détails (facultatif)
              <textarea name="description" rows={3} className="field mt-1" maxLength={2000} />
            </label>
            <div className="flex gap-2">
              <button className="btn btn-primary" disabled={busy}>
                {busy ? 'Création…' : 'Créer le rendez-vous'}
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setShowForm(false)}>
                Annuler
              </button>
            </div>
          </form>
        )}

        <ErrorNote>{error}</ErrorNote>
        {meetings === null && !error && <Spinner />}

        {meetings && upcoming.length === 0 && (
          <p className="py-10 text-center text-sm text-slate-500">Aucun rendez-vous à venir. Créez-en un avec « Nouveau ».</p>
        )}
        {upcoming.map((m) => (
          <MeetingCard key={m.id} m={m} onChange={() => void load()} />
        ))}

        {past.length > 0 && (
          <details className="pt-2">
            <summary className="cursor-pointer text-sm font-medium text-slate-600">Rendez-vous passés ({past.length})</summary>
            <div className="mt-2 space-y-3">
              {past.map((m) => (
                <MeetingCard key={m.id} m={m} onChange={() => void load()} past />
              ))}
            </div>
          </details>
        )}
        {meetings && meetings.length > 0 && (
          <p className="pb-2 text-center text-xs text-slate-400">Prochain : {upcoming[0] ? formatDateTime(upcoming[0].startsAt) : '—'}</p>
        )}
      </div>
    </div>
  );
}
