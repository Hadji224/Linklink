import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { useApp } from '../data';
import { formatDateTime, formatDay, formatTime, icsFor, toLocalInputValue } from '../format';
import { useRealtime, useRealtimeEvents } from '../realtime';
import type { Meeting, RsvpStatus } from '../types';
import { Empty, ErrorNote, Field, Icon, Modal, PageHeader, Spinner, useConfirm, useToast } from '../ui';

const STATUS_LABEL: Record<RsvpStatus, string> = { yes: 'Présent', maybe: 'Peut-être', no: 'Absent' };
const STATUS_STYLE: Record<RsvpStatus, string> = {
  yes: 'bg-emerald-50 text-emerald-800',
  maybe: 'bg-amber-50 text-amber-900',
  no: 'bg-slate-100 text-slate-700',
};

function downloadIcs(m: Meeting) {
  const blob = new Blob([icsFor(m)], { type: 'text/calendar;charset=utf-8' });
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
  const confirm = useConfirm();
  const toast = useToast();
  const [error, setError] = useState('');
  const canDelete = user?.role === 'admin' || (user?.role === 'member' && user.id === m.createdBy?.id);

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
    if (!(await confirm({ title: `Supprimer « ${m.title} » ?`, confirmLabel: 'Supprimer', danger: true }))) return;
    try {
      await api(`/meetings/${m.id}`, { method: 'DELETE' });
      toast.success('Rendez-vous supprimé');
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Suppression impossible.');
    }
  }

  const start = new Date(m.startsAt);
  return (
    <article className={`card flex gap-3 p-3 ${past ? 'opacity-70' : ''}`}>
      <div className="flex h-14 w-14 shrink-0 flex-col items-center justify-center rounded-xl bg-mist text-electric">
        <span className="text-xl font-bold leading-none">{start.getDate()}</span>
        <span className="text-xs font-semibold uppercase">{start.toLocaleDateString('fr-FR', { month: 'short' })}</span>
      </div>
      <div className="min-w-0 flex-1">
        <h3 className="font-bold">{m.title}</h3>
        <p className="text-sm text-slate">{formatDay(m.startsAt)} à {formatTime(m.startsAt)}</p>
        {m.project && <a href={`#projets/${m.project.id}`} className="text-xs font-semibold text-electric hover:underline" style={{ borderLeft: `3px solid ${m.project.color}`, paddingLeft: 6 }}>Projet : {m.project.name}</a>}
        {m.location && (
          <p className="truncate text-sm text-slate">
            📍 {isUrl(m.location) ? <a href={m.location} target="_blank" rel="noopener noreferrer" className="font-semibold text-electric underline">{m.location}</a> : m.location}
          </p>
        )}
        {m.description && <p className="mt-1 whitespace-pre-wrap text-sm">{m.description}</p>}
        {m.createdBy && <p className="mt-1 text-xs text-slate">Organisé par {m.createdBy.name}</p>}

        <div className="mt-2 flex flex-wrap gap-1.5">
          {(['yes', 'maybe', 'no'] as RsvpStatus[]).map((s) => (
            <button key={s} onClick={() => void rsvp(s)} aria-pressed={m.myStatus === s}
              className={`min-h-9 rounded-full border px-3 text-sm font-semibold ${m.myStatus === s ? 'border-electric bg-electric text-white' : 'border-line bg-white hover:bg-mist'}`}>
              {STATUS_LABEL[s]}
            </button>
          ))}
          <button onClick={() => downloadIcs(m)} className="min-h-9 rounded-full border border-line bg-white px-3 text-sm font-semibold hover:bg-mist">+ Agenda</button>
          {canDelete && (
            <button onClick={() => void remove()} className="rounded-full px-2 text-slate hover:text-red-700" aria-label={`Supprimer ${m.title}`}><Icon name="trash" className="h-4 w-4" /></button>
          )}
        </div>

        {m.attendees.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {(['yes', 'maybe', 'no'] as RsvpStatus[]).flatMap((s) =>
              m.attendees.filter((a) => a.status === s).map((p) => (
                <span key={p.userId} className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[s]}`}>{p.name} · {STATUS_LABEL[s].toLowerCase()}</span>
              )),
            )}
          </div>
        )}
        <ErrorNote>{error}</ErrorNote>
      </div>
    </article>
  );
}

export function NewMeetingModal({ projectId, onClose, onCreated }: { projectId?: string; onClose: () => void; onCreated: () => void }) {
  const { projects } = useApp();
  const toast = useToast();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const defaultStart = new Date(Date.now() + 24 * 3600_000);
  defaultStart.setMinutes(0, 0, 0);

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
          projectId: projectId ?? (String(form.get('projectId') ?? '') || null),
        },
      });
      toast.success('Rendez-vous créé');
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Création impossible.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Nouveau rendez-vous" onClose={onClose}>
      <form onSubmit={create} className="space-y-3">
        <Field label="Titre"><input name="title" className="field" placeholder="ex. Point hebdomadaire" required maxLength={120} /></Field>
        <Field label="Date et heure"><input name="startsAt" type="datetime-local" className="field" defaultValue={toLocalInputValue(defaultStart)} required /></Field>
        <Field label="Lieu ou lien de visio (facultatif)"><input name="location" className="field" placeholder="Bureau, Google Meet, https://…" maxLength={200} /></Field>
        {!projectId && (
          <Field label="Projet (facultatif)" hint="Un rendez-vous de projet n'est visible que de ses participants ; sinon, de toute l'équipe.">
            <select name="projectId" className="field" defaultValue="">
              <option value="">Aucun — toute l'équipe</option>
              {projects.filter((p) => p.status !== 'archived').map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
        )}
        <Field label="Détails (facultatif)"><textarea name="description" rows={3} className="field" maxLength={2000} /></Field>
        <ErrorNote>{error}</ErrorNote>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Annuler</button>
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Création…' : 'Créer le rendez-vous'}</button>
        </div>
      </form>
    </Modal>
  );
}

/** Liste de rendez-vous : toute l'équipe, ou un projet précis. */
export function MeetingList({ projectId, readOnly = false }: { projectId?: string; readOnly?: boolean }) {
  const { user } = useAuth();
  const { epoch } = useRealtime();
  const [meetings, setMeetings] = useState<Meeting[] | null>(null);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api<{ meetings: Meeting[] }>('/meetings');
      setMeetings(projectId ? r.meetings.filter((m) => m.project?.id === projectId) : r.meetings);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Chargement impossible.');
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load, epoch]);
  useRealtimeEvents((e) => { if (e.type === 'meeting') void load(); });

  const nowMs = Date.now();
  // Un rendez-vous reste « à venir » jusqu'à 2 h après son début (F-RDV-04).
  const upcoming = meetings?.filter((m) => +new Date(m.startsAt) + 2 * 3600_000 >= nowMs) ?? [];
  const past = (meetings?.filter((m) => +new Date(m.startsAt) + 2 * 3600_000 < nowMs) ?? []).reverse();
  const canCreate = user?.role !== 'guest' && !readOnly;

  return (
    <div className="space-y-3">
      {canCreate && (
        <div className="text-right"><button className="btn btn-primary" onClick={() => setShowForm(true)}><Icon name="plus" className="h-4 w-4" /> Nouveau</button></div>
      )}
      <ErrorNote>{error}</ErrorNote>
      {meetings === null && !error && <Spinner />}
      {meetings && upcoming.length === 0 && <Empty>Aucun rendez-vous à venir.{canCreate ? ' Créez-en un avec « Nouveau ».' : ''}</Empty>}
      {upcoming.map((m) => <MeetingCard key={m.id} m={m} onChange={() => void load()} />)}
      {past.length > 0 && (
        <details className="pt-2">
          <summary className="cursor-pointer text-sm font-semibold text-slate">Rendez-vous passés ({past.length})</summary>
          <div className="mt-2 space-y-3">{past.map((m) => <MeetingCard key={m.id} m={m} onChange={() => void load()} past />)}</div>
        </details>
      )}
      {meetings && upcoming[0] && <p className="pb-2 text-center text-xs text-slate">Prochain : {formatDateTime(upcoming[0].startsAt)}</p>}
      {showForm && <NewMeetingModal projectId={projectId} onClose={() => setShowForm(false)} onCreated={() => { setShowForm(false); void load(); }} />}
    </div>
  );
}

export function Meetings() {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader title="Rendez-vous" />
      <div className="min-h-0 flex-1 overflow-y-auto p-3 md:mx-auto md:w-full md:max-w-3xl">
        <MeetingList />
      </div>
    </div>
  );
}
