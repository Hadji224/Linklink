import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { api, downloadFile } from '../api';
import { useAuth } from '../auth';
import { useApp } from '../data';
import { formatDateTime, formatDue, formatSize, todayStr } from '../format';
import { MentionTextarea } from '../Mention';
import { useRealtime, useRealtimeEvents } from '../realtime';
import { go } from '../route';
import {
  PRIORITY_LABEL, TASK_STATUS_LABEL,
  type Priority, type Task, type TaskDetail, type TaskStatus,
} from '../types';
import { Avatar, Empty, ErrorNote, Field, FileIcon, Icon, Modal, PageHeader, PriorityChip, Spinner, TaskStatusChip, useConfirm, useToast } from '../ui';

const STATUSES: TaskStatus[] = ['todo', 'doing', 'review', 'done'];
const PRIORITIES: Priority[] = ['urgent', 'high', 'medium', 'low'];
const PRIORITY_RANK: Record<Priority, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

type View = 'kanban' | 'list' | 'calendar' | 'day';
const VIEWS: { id: View; label: string; icon: 'kanban' | 'list' | 'calendar' | 'clock' }[] = [
  { id: 'kanban', label: 'Kanban', icon: 'kanban' },
  { id: 'list', label: 'Liste', icon: 'list' },
  { id: 'calendar', label: 'Calendrier', icon: 'calendar' },
  { id: 'day', label: 'Ma journée', icon: 'clock' },
];

function DueLabel({ task }: { task: Pick<Task, 'dueDate' | 'status'> }) {
  if (!task.dueDate) return null;
  const late = task.dueDate < todayStr() && task.status !== 'done';
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-semibold ${late ? 'text-red-700' : 'text-slate'}`}>
      <Icon name="clock" className="h-3.5 w-3.5" />
      {formatDue(task.dueDate)}
      {late && ' · en retard'}
    </span>
  );
}

function TaskCard({ task, onOpen, onMove, showProject, draggable }: { task: Task; onOpen: () => void; onMove?: (s: TaskStatus) => void; showProject: boolean; draggable: boolean }) {
  const idx = STATUSES.indexOf(task.status);
  return (
    <article
      draggable={draggable}
      onDragStart={(e: DragEvent) => e.dataTransfer.setData('text/task', task.id)}
      className="card cursor-pointer p-3 shadow-sm hover:border-electric"
      style={{ borderLeft: `4px solid ${task.project.color}` }}
    >
      <button onClick={onOpen} className="block w-full text-left">
        <h4 className="font-semibold leading-snug">{task.title}</h4>
        {showProject && <p className="mt-0.5 text-xs text-slate">{task.project.name}</p>}
      </button>
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
        <PriorityChip priority={task.priority} />
        <DueLabel task={task} />
        {task.subtasksTotal > 0 && <span className="text-xs text-slate">☑ {task.subtasksDone}/{task.subtasksTotal}</span>}
        {task.commentCount > 0 && <span className="text-xs text-slate">💬 {task.commentCount}</span>}
        {task.attachmentCount > 0 && <span className="text-xs text-slate">📎 {task.attachmentCount}</span>}
      </div>
      {task.tags.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {task.tags.map((t) => <span key={t} className="rounded-full bg-mist px-2 py-0.5 text-xs text-slate">#{t}</span>)}
        </div>
      )}
      <div className="mt-2 flex items-center justify-between">
        {task.assignee ? (
          <span className="flex items-center gap-1.5 text-xs text-slate"><Avatar name={task.assignee.name} size={22} />{task.assignee.name}</span>
        ) : (
          <span className="text-xs text-slate">Non assignée</span>
        )}
        {onMove && (
          <span className="flex gap-1">
            <button disabled={idx === 0} onClick={() => onMove(STATUSES[idx - 1] as TaskStatus)} className="rounded-md px-2 py-1 text-sm hover:bg-mist disabled:opacity-30" aria-label={`Déplacer vers ${TASK_STATUS_LABEL[STATUSES[idx - 1] ?? 'todo']}`}>◀</button>
            <button disabled={idx === STATUSES.length - 1} onClick={() => onMove(STATUSES[idx + 1] as TaskStatus)} className="rounded-md px-2 py-1 text-sm hover:bg-mist disabled:opacity-30" aria-label={`Déplacer vers ${TASK_STATUS_LABEL[STATUSES[idx + 1] ?? 'done']}`}>▶</button>
          </span>
        )}
      </div>
    </article>
  );
}

/* ------------------------------ Formulaire / détail ------------------------------ */

interface FormState { title: string; description: string; assigneeId: string; dueDate: string; priority: Priority; status: TaskStatus; tags: string }

function useAssignees(projectId: string) {
  const { members, projects } = useApp();
  const project = projects.find((p) => p.id === projectId);
  return members.filter((m) => m.role !== 'guest' || project?.members.some((pm) => pm.id === m.id));
}

function TaskForm({ projectId, initial, onChange, disabled }: { projectId: string; initial: FormState; onChange: (s: FormState) => void; disabled?: boolean }) {
  const [s, setS] = useState(initial);
  const people = useAssignees(projectId);
  const set = (patch: Partial<FormState>) => {
    const next = { ...s, ...patch };
    setS(next);
    onChange(next);
  };
  return (
    <div className="space-y-3">
      <Field label="Titre">
        <input className="field" value={s.title} onChange={(e) => set({ title: e.target.value })} maxLength={200} required disabled={disabled} />
      </Field>
      <Field label="Description">
        <textarea className="field" rows={3} value={s.description} onChange={(e) => set({ description: e.target.value })} maxLength={5000} disabled={disabled} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Assignée à">
          <select className="field" value={s.assigneeId} onChange={(e) => set({ assigneeId: e.target.value })} disabled={disabled}>
            <option value="">Personne</option>
            {people.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </Field>
        <Field label="Échéance">
          <input type="date" className="field" value={s.dueDate} onChange={(e) => set({ dueDate: e.target.value })} disabled={disabled} />
        </Field>
        <Field label="Priorité">
          <select className="field" value={s.priority} onChange={(e) => set({ priority: e.target.value as Priority })} disabled={disabled}>
            {PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
          </select>
        </Field>
        <Field label="Statut">
          <select className="field" value={s.status} onChange={(e) => set({ status: e.target.value as TaskStatus })} disabled={disabled}>
            {STATUSES.map((p) => <option key={p} value={p}>{TASK_STATUS_LABEL[p]}</option>)}
          </select>
        </Field>
      </div>
      <Field label="Étiquettes" hint="Séparées par des virgules.">
        <input className="field" value={s.tags} onChange={(e) => set({ tags: e.target.value })} placeholder="ex. visa, urgent" disabled={disabled} />
      </Field>
    </div>
  );
}

const parseTags = (s: string) => [...new Set(s.split(',').map((t) => t.trim().replace(/^#/, '')).filter(Boolean))].slice(0, 10);

function NewTaskModal({ projectId, projectChoices, onClose, onCreated }: { projectId?: string; projectChoices: { id: string; name: string }[]; onClose: () => void; onCreated: (t: Task) => void }) {
  const { user } = useAuth();
  const [pid, setPid] = useState(projectId ?? projectChoices[0]?.id ?? '');
  const [form, setForm] = useState<FormState>({ title: '', description: '', assigneeId: user?.id ?? '', dueDate: '', priority: 'medium', status: 'todo', tags: '' });
  const [subs, setSubs] = useState<string[]>([]);
  const [sub, setSub] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api<{ task: Task }>('/tasks', {
        method: 'POST',
        body: { projectId: pid, title: form.title, description: form.description, assigneeId: form.assigneeId || null, dueDate: form.dueDate || null, priority: form.priority, status: form.status, tags: parseTags(form.tags), subtasks: subs },
      });
      toast.success('Tâche créée');
      onCreated(r.task);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Création impossible.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Nouvelle tâche" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        {!projectId && (
          <Field label="Projet">
            <select className="field" value={pid} onChange={(e) => setPid(e.target.value)} required>
              {projectChoices.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
        )}
        <TaskForm key={pid} projectId={pid} initial={form} onChange={setForm} />
        <div>
          <span className="label">Sous-tâches (checklist)</span>
          <ul className="mt-1 space-y-1">
            {subs.map((s, i) => (
              <li key={i} className="flex items-center justify-between rounded-lg bg-mist px-3 py-1.5 text-sm">
                {s}
                <button type="button" onClick={() => setSubs(subs.filter((_, j) => j !== i))} aria-label={`Retirer ${s}`} className="text-slate hover:text-red-700"><Icon name="x" className="h-4 w-4" /></button>
              </li>
            ))}
          </ul>
          <div className="mt-1 flex gap-2">
            <input className="field" value={sub} onChange={(e) => setSub(e.target.value)} placeholder="Ajouter une étape" maxLength={200}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (sub.trim()) { setSubs([...subs, sub.trim()]); setSub(''); } } }} />
            <button type="button" className="btn btn-ghost" onClick={() => { if (sub.trim()) { setSubs([...subs, sub.trim()]); setSub(''); } }}>Ajouter</button>
          </div>
        </div>
        <ErrorNote>{error}</ErrorNote>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Annuler</button>
          <button className="btn btn-primary" disabled={busy || !form.title.trim() || !pid}>{busy ? 'Création…' : 'Créer la tâche'}</button>
        </div>
      </form>
    </Modal>
  );
}

function TaskModal({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { user } = useAuth();
  const { projects } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [error, setError] = useState('');
  const [form, setForm] = useState<FormState | null>(null);
  const [dirty, setDirty] = useState(false);
  const [newSub, setNewSub] = useState('');
  const [comment, setComment] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const { epoch } = useRealtime();

  const load = useCallback(async () => {
    try {
      const r = await api<{ task: TaskDetail }>(`/tasks/${id}`);
      setTask(r.task);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Tâche introuvable.');
    }
  }, [id]);

  useEffect(() => { void load(); }, [load, epoch]);
  useRealtimeEvents((e) => { if (e.type === 'task' && e.taskId === id) void load(); });

  useEffect(() => {
    if (task && !form) {
      setForm({ title: task.title, description: task.description, assigneeId: task.assignee?.id ?? '', dueDate: task.dueDate ?? '', priority: task.priority, status: task.status, tags: task.tags.join(', ') });
    }
  }, [task, form]);

  const archived = task ? projects.find((p) => p.id === task.projectId)?.status === 'archived' : false;

  async function run<T>(fn: () => Promise<T>, ok?: string) {
    setError('');
    try {
      const r = await fn();
      if (ok) toast.success(ok);
      onChanged();
      return r;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action impossible.');
    }
  }

  async function save() {
    if (!form) return;
    const r = await run(
      () => api<{ task: TaskDetail }>(`/tasks/${id}`, { method: 'PATCH', body: { title: form.title, description: form.description, assigneeId: form.assigneeId || null, dueDate: form.dueDate || null, priority: form.priority, status: form.status, tags: parseTags(form.tags) } }),
      'Tâche enregistrée',
    );
    if (r) { setTask(r.task); setDirty(false); }
  }

  const update = async (fn: () => Promise<{ task: TaskDetail }>) => { const r = await run(fn); if (r) setTask(r.task); };

  async function remove() {
    if (!(await confirm({ title: 'Supprimer cette tâche ?', message: 'Ses sous-tâches, commentaires et pièces jointes seront supprimés.', confirmLabel: 'Supprimer', danger: true }))) return;
    if (await run(() => api(`/tasks/${id}`, { method: 'DELETE' }), 'Tâche supprimée')) onClose();
  }

  async function upload(file?: File) {
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    fd.append('taskId', id);
    await run(() => api('/files', { method: 'POST', form: fd }), 'Pièce jointe ajoutée');
    if (fileInput.current) fileInput.current.value = '';
    void load();
  }

  if (!task || !form) {
    return <Modal title="Tâche" onClose={onClose}>{error ? <ErrorNote>{error}</ErrorNote> : <Spinner />}</Modal>;
  }

  return (
    <Modal title="Détail de la tâche" onClose={onClose} wide>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <a href={`#projets/${task.projectId}`} className="font-semibold text-electric hover:underline" style={{ borderLeft: `4px solid ${task.project.color}`, paddingLeft: 8 }}>{task.project.name}</a>
        <TaskStatusChip status={task.status} />
        <span className="text-slate">Créée par {task.createdBy?.name ?? 'un ancien membre'} · {formatDateTime(task.createdAt)}</span>
      </div>
      {archived && <p className="mb-3 rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate">Projet archivé : la tâche est en lecture seule.</p>}
      <TaskForm projectId={task.projectId} initial={form} disabled={archived} onChange={(s) => { setForm(s); setDirty(true); }} />
      <ErrorNote>{error}</ErrorNote>
      {!archived && (
        <div className="mt-3 flex flex-wrap justify-between gap-2">
          <button className="btn btn-primary" disabled={!dirty || !form.title.trim()} onClick={() => void save()}>Enregistrer</button>
          {user?.role !== 'guest' && <button className="btn btn-danger" onClick={() => void remove()}><Icon name="trash" className="h-4 w-4" /> Supprimer</button>}
        </div>
      )}

      <section className="mt-6" aria-label="Sous-tâches">
        <h3 className="font-bold">Sous-tâches {task.subtasks.length > 0 && <span className="text-sm font-normal text-slate">({task.subtasks.filter((s) => s.done).length}/{task.subtasks.length})</span>}</h3>
        <ul className="mt-2 space-y-1">
          {task.subtasks.map((s) => (
            <li key={s.id} className="flex items-center gap-2 rounded-lg px-1 py-1 hover:bg-mist">
              <input type="checkbox" className="h-5 w-5 accent-[#135fea]" checked={s.done} disabled={archived} id={`sub-${s.id}`}
                onChange={(e) => { const done = e.target.checked; setTask((t) => t && { ...t, subtasks: t.subtasks.map((x) => (x.id === s.id ? { ...x, done } : x)) }); void update(() => api(`/subtasks/${s.id}`, { method: 'PATCH', body: { done } })); }} />
              <label htmlFor={`sub-${s.id}`} className={`flex-1 text-sm ${s.done ? 'text-slate line-through' : ''}`}>{s.title}</label>
              {!archived && <button className="p-1 text-slate hover:text-red-700" aria-label={`Supprimer ${s.title}`} onClick={() => void update(() => api(`/subtasks/${s.id}`, { method: 'DELETE' }))}><Icon name="x" className="h-4 w-4" /></button>}
            </li>
          ))}
        </ul>
        {!archived && (
          <form className="mt-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (!newSub.trim()) return; const t = newSub.trim(); setNewSub(''); void update(() => api(`/tasks/${id}/subtasks`, { method: 'POST', body: { title: t } })); }}>
            <input className="field" aria-label="Nouvelle sous-tâche" placeholder="Ajouter une étape" value={newSub} onChange={(e) => setNewSub(e.target.value)} maxLength={200} />
            <button className="btn btn-ghost">Ajouter</button>
          </form>
        )}
      </section>

      <section className="mt-6" aria-label="Pièces jointes">
        <div className="flex items-center justify-between">
          <h3 className="font-bold">Pièces jointes</h3>
          {!archived && (
            <>
              <input ref={fileInput} type="file" className="hidden" aria-label="Ajouter une pièce jointe" onChange={(e) => void upload(e.target.files?.[0])} />
              <button className="btn btn-ghost btn-sm" onClick={() => fileInput.current?.click()}><Icon name="attach" className="h-4 w-4" /> Joindre</button>
            </>
          )}
        </div>
        {task.attachments.length === 0 && <p className="mt-2 text-sm text-slate">Aucune pièce jointe.</p>}
        <ul className="mt-2 space-y-1">
          {task.attachments.map((f) => (
            <li key={f.id}>
              <button onClick={() => void downloadFile(f.id, f.name)} className="flex w-full items-center gap-3 rounded-xl px-2 py-1.5 text-left hover:bg-mist" aria-label={`Télécharger ${f.name}`}>
                <FileIcon name={f.name} mime={f.mime} size={32} />
                <span className="min-w-0 flex-1 truncate text-sm font-semibold">{f.name}</span>
                <span className="text-xs text-slate">{formatSize(f.size)} · {f.uploadedBy}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-6" aria-label="Commentaires">
        <h3 className="font-bold">Commentaires</h3>
        {task.comments.length === 0 && <p className="mt-2 text-sm text-slate">Aucun commentaire. Utilisez @ pour mentionner quelqu'un.</p>}
        <ul className="mt-2 space-y-3">
          {task.comments.map((c) => (
            <li key={c.id} className="flex gap-2">
              <Avatar name={c.user.name} size={30} />
              <div className="min-w-0 flex-1 rounded-2xl bg-mist px-3 py-2">
                <p className="text-xs"><strong>{c.user.name}</strong> <span className="text-slate">· {formatDateTime(c.createdAt)}</span></p>
                <p className="whitespace-pre-wrap break-words text-sm">{c.body}</p>
              </div>
            </li>
          ))}
        </ul>
        {!archived && (
          <form className="mt-3 space-y-2" onSubmit={(e) => { e.preventDefault(); const b = comment.trim(); if (!b) return; setComment(''); void update(() => api(`/tasks/${id}/comments`, { method: 'POST', body: { body: b } })); }}>
            <MentionTextarea label="Votre commentaire" value={comment} onChange={setComment} placeholder="Écrire un commentaire…" />
            <div className="text-right"><button className="btn btn-primary btn-sm" disabled={!comment.trim()}>Commenter</button></div>
          </form>
        )}
      </section>
    </Modal>
  );
}

/* --------------------------------- Vues --------------------------------- */

function KanbanView({ tasks, onOpen, onMove, showProject, readOnly }: { tasks: Task[]; onOpen: (t: Task) => void; onMove: (t: Task, s: TaskStatus) => void; showProject: boolean; readOnly: boolean }) {
  const [over, setOver] = useState<TaskStatus | null>(null);
  return (
    <div className="flex h-full snap-x gap-3 overflow-x-auto p-3 md:grid md:grid-cols-4 md:overflow-x-visible">
      {STATUSES.map((s) => {
        const col = tasks.filter((t) => t.status === s).sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || (a.dueDate ?? '9').localeCompare(b.dueDate ?? '9'));
        return (
          <section
            key={s}
            aria-label={`${TASK_STATUS_LABEL[s]} (${col.length})`}
            onDragOver={(e) => { if (!readOnly) { e.preventDefault(); setOver(s); } }}
            onDragLeave={() => setOver(null)}
            onDrop={(e) => {
              setOver(null);
              const id = e.dataTransfer.getData('text/task');
              const t = tasks.find((x) => x.id === id);
              if (t && t.status !== s && !readOnly) onMove(t, s);
            }}
            className={`flex min-h-40 w-72 shrink-0 snap-start flex-col rounded-2xl bg-white/60 p-2 ring-1 md:w-auto ${over === s ? 'ring-2 ring-electric' : 'ring-line'}`}
          >
            <h3 className="px-1 pb-2 text-sm font-bold">{TASK_STATUS_LABEL[s]} <span className="font-normal text-slate">({col.length})</span></h3>
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
              {col.map((t) => <TaskCard key={t.id} task={t} showProject={showProject} draggable={!readOnly} onOpen={() => onOpen(t)} onMove={readOnly ? undefined : (st) => onMove(t, st)} />)}
              {col.length === 0 && <p className="px-2 py-4 text-center text-xs text-slate">Aucune tâche</p>}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function ListView({ tasks, onOpen, onToggle, showProject, readOnly }: { tasks: Task[]; onOpen: (t: Task) => void; onToggle: (t: Task) => void; showProject: boolean; readOnly: boolean }) {
  const [sort, setSort] = useState<'due' | 'priority' | 'assignee' | 'status'>('due');
  const sorted = useMemo(() => {
    const k = (t: Task) => sort === 'due' ? (t.dueDate ?? '9999') : sort === 'priority' ? String(PRIORITY_RANK[t.priority]) : sort === 'assignee' ? (t.assignee?.name ?? 'zzz') : String(STATUSES.indexOf(t.status));
    return [...tasks].sort((a, b) => k(a).localeCompare(k(b)));
  }, [tasks, sort]);
  return (
    <div className="p-3">
      <div className="mb-2 flex items-center gap-2 text-sm">
        <label htmlFor="sort" className="font-semibold">Trier par</label>
        <select id="sort" className="field !min-h-9 !w-auto !py-1" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
          <option value="due">Échéance</option><option value="priority">Priorité</option><option value="assignee">Assigné</option><option value="status">Statut</option>
        </select>
      </div>
      {sorted.length === 0 && <Empty>Aucune tâche.</Empty>}
      <ul className="space-y-2">
        {sorted.map((t) => (
          <li key={t.id} className="card flex items-center gap-3 p-3" style={{ borderLeft: `4px solid ${t.project.color}` }}>
            <input type="checkbox" className="h-5 w-5 shrink-0 accent-[#135fea]" checked={t.status === 'done'} disabled={readOnly} onChange={() => onToggle(t)} aria-label={`Terminer « ${t.title} »`} />
            <button onClick={() => onOpen(t)} className="min-w-0 flex-1 text-left">
              <span className={`block truncate font-semibold ${t.status === 'done' ? 'text-slate line-through' : ''}`}>{t.title}</span>
              <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                {showProject && <span className="text-xs text-slate">{t.project.name}</span>}
                <TaskStatusChip status={t.status} />
                <PriorityChip priority={t.priority} />
                <DueLabel task={t} />
              </span>
            </button>
            {t.assignee && <Avatar name={t.assignee.name} size={28} />}
          </li>
        ))}
      </ul>
    </div>
  );
}

function CalendarView({ tasks, onOpen }: { tasks: Task[]; onOpen: (t: Task) => void }) {
  const [cursor, setCursor] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const year = cursor.getFullYear(), month = cursor.getMonth();
  const first = (new Date(year, month, 1).getDay() + 6) % 7; // lundi en premier
  const days = new Date(year, month + 1, 0).getDate();
  const cells = Array.from({ length: Math.ceil((first + days) / 7) * 7 }, (_, i) => i - first + 1);
  const key = (d: number) => `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const byDay = new Map<string, Task[]>();
  for (const t of tasks) if (t.dueDate) byDay.set(t.dueDate, [...(byDay.get(t.dueDate) ?? []), t]);
  const noDate = tasks.filter((t) => !t.dueDate && t.status !== 'done');
  return (
    <div className="p-3">
      <div className="mb-2 flex items-center justify-between">
        <button className="btn btn-ghost btn-sm" onClick={() => setCursor(new Date(year, month - 1, 1))} aria-label="Mois précédent">←</button>
        <h3 className="font-bold capitalize">{cursor.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })}</h3>
        <button className="btn btn-ghost btn-sm" onClick={() => setCursor(new Date(year, month + 1, 1))} aria-label="Mois suivant">→</button>
      </div>
      <div className="grid grid-cols-7 gap-px overflow-hidden rounded-xl bg-line text-xs ring-1 ring-line">
        {['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'].map((d) => <div key={d} className="bg-mist py-1 text-center font-bold text-slate">{d}</div>)}
        {cells.map((d, i) => {
          const list = d >= 1 && d <= days ? (byDay.get(key(d)) ?? []) : [];
          const isToday = d >= 1 && d <= days && key(d) === todayStr();
          return (
            <div key={i} className={`min-h-16 bg-white p-1 md:min-h-24 ${d < 1 || d > days ? 'opacity-40' : ''}`}>
              <span className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-bold ${isToday ? 'bg-electric text-white' : ''}`}>{d >= 1 && d <= days ? d : ''}</span>
              {list.slice(0, 3).map((t) => (
                <button key={t.id} onClick={() => onOpen(t)} className={`mt-0.5 block w-full truncate rounded px-1 text-left text-[11px] font-semibold text-white ${t.status === 'done' ? 'line-through opacity-60' : ''}`} style={{ background: t.project.color }} title={t.title}>{t.title}</button>
              ))}
              {list.length > 3 && <span className="text-[11px] text-slate">+{list.length - 3}</span>}
            </div>
          );
        })}
      </div>
      {noDate.length > 0 && (
        <div className="mt-4">
          <h4 className="text-sm font-bold">Sans échéance</h4>
          <ul className="mt-1 space-y-1">{noDate.map((t) => <li key={t.id}><button className="text-sm text-electric hover:underline" onClick={() => onOpen(t)}>{t.title}</button></li>)}</ul>
        </div>
      )}
    </div>
  );
}

function DayView({ tasks, onOpen, onToggle, showProject }: { tasks: Task[]; onOpen: (t: Task) => void; onToggle: (t: Task) => void; showProject: boolean }) {
  const { user } = useAuth();
  const mine = tasks.filter((t) => t.assignee?.id === user?.id && t.status !== 'done');
  const today = todayStr();
  const due = mine.filter((t) => t.dueDate && t.dueDate <= today).sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? '') || PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);
  const doing = mine.filter((t) => t.status === 'doing' && !(t.dueDate && t.dueDate <= today));
  const Section = ({ title, list }: { title: string; list: Task[] }) => (
    <section className="mb-5">
      <h3 className="mb-2 font-bold">{title} <span className="font-normal text-slate">({list.length})</span></h3>
      {list.length === 0 ? <p className="text-sm text-slate">Rien ici. 🎉</p> : (
        <ul className="space-y-2">
          {list.map((t) => (
            <li key={t.id} className="card flex items-center gap-3 p-3" style={{ borderLeft: `4px solid ${t.project.color}` }}>
              <input type="checkbox" className="h-5 w-5 accent-[#135fea]" checked={false} onChange={() => onToggle(t)} aria-label={`Terminer « ${t.title} »`} />
              <button onClick={() => onOpen(t)} className="min-w-0 flex-1 text-left">
                <span className="block truncate font-semibold">{t.title}</span>
                <span className="flex flex-wrap items-center gap-2">{showProject && <span className="text-xs text-slate">{t.project.name}</span>}<PriorityChip priority={t.priority} /><DueLabel task={t} /></span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
  return (
    <div className="p-3">
      <Section title="À faire aujourd'hui (et en retard)" list={due} />
      <Section title="En cours" list={doing} />
    </div>
  );
}

/* ------------------------------ Tableau complet ------------------------------ */

export function TaskBoard({ projectId, readOnly = false, openTaskId, baseHref }: { projectId?: string; readOnly?: boolean; openTaskId?: string; baseHref: string }) {
  const { user } = useAuth();
  const { projects, refreshProjects } = useApp();
  const { epoch } = useRealtime();
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [error, setError] = useState('');
  const [view, setView] = useState<View>(() => (window.matchMedia('(min-width: 768px)').matches ? 'kanban' : 'list'));
  const [q, setQ] = useState('');
  const [onlyMine, setOnlyMine] = useState(false);
  const [creating, setCreating] = useState(false);
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      const r = await api<{ tasks: Task[] }>(`/tasks${projectId ? `?projectId=${projectId}` : ''}`);
      setTasks(r.tasks);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Chargement impossible.');
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load, epoch]);
  useRealtimeEvents((e) => { if (e.type === 'task' && (!projectId || e.projectId === projectId)) void load(); });

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (tasks ?? []).filter((t) => (!onlyMine || t.assignee?.id === user?.id) && (!needle || `${t.title} ${t.description} ${t.tags.join(' ')}`.toLowerCase().includes(needle)));
  }, [tasks, q, onlyMine, user?.id]);

  async function move(t: Task, status: TaskStatus) {
    setTasks((l) => l?.map((x) => (x.id === t.id ? { ...x, status } : x)) ?? l); // mise à jour immédiate
    try {
      await api(`/tasks/${t.id}`, { method: 'PATCH', body: { status } });
      void refreshProjects();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Déplacement impossible.');
      void load();
    }
  }
  const toggle = (t: Task) => move(t, t.status === 'done' ? 'todo' : 'done');

  const open = (t: Task) => go(`${baseHref}/${t.id}`);
  const closeModal = () => go(baseHref);
  const choices = projects.filter((p) => p.status !== 'archived');
  const showProject = !projectId;
  const canCreate = !readOnly && choices.length > 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-white px-3 py-2">
        <div role="group" aria-label="Affichage" className="flex overflow-hidden rounded-xl border border-line">
          {VIEWS.map((v) => (
            <button key={v.id} onClick={() => setView(v.id)} aria-pressed={view === v.id} className={`flex items-center gap-1.5 px-3 py-2 text-sm font-semibold ${view === v.id ? 'bg-electric text-white' : 'bg-white text-navy hover:bg-mist'}`}>
              <Icon name={v.icon} className="h-4 w-4" />
              <span className={view === v.id ? '' : 'sr-only sm:not-sr-only'}>{v.label}</span>
            </button>
          ))}
        </div>
        <div className="relative min-w-40 flex-1">
          <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate" />
          <input className="field !pl-9" placeholder="Rechercher une tâche" aria-label="Rechercher une tâche" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <label className="flex items-center gap-2 text-sm font-semibold"><input type="checkbox" className="h-5 w-5 accent-[#135fea]" checked={onlyMine} onChange={(e) => setOnlyMine(e.target.checked)} /> Mes tâches</label>
        {canCreate && <button className="btn btn-primary" onClick={() => setCreating(true)}><Icon name="plus" className="h-4 w-4" /> Nouvelle tâche</button>}
      </div>
      <ErrorNote>{error}</ErrorNote>
      <div className="min-h-0 flex-1 overflow-y-auto bg-mist">
        {tasks === null && !error && <Spinner />}
        {tasks && view === 'kanban' && <KanbanView tasks={visible} onOpen={open} onMove={move} showProject={showProject} readOnly={readOnly} />}
        {tasks && view === 'list' && <ListView tasks={visible} onOpen={open} onToggle={toggle} showProject={showProject} readOnly={readOnly} />}
        {tasks && view === 'calendar' && <CalendarView tasks={visible} onOpen={open} />}
        {tasks && view === 'day' && <DayView tasks={tasks} onOpen={open} onToggle={toggle} showProject={showProject} />}
      </div>
      {creating && (
        <NewTaskModal projectId={projectId} projectChoices={choices} onClose={() => setCreating(false)} onCreated={(t) => { setCreating(false); void load(); void refreshProjects(); open(t); }} />
      )}
      {openTaskId && <TaskModal key={openTaskId} id={openTaskId} onClose={closeModal} onChanged={() => { void load(); void refreshProjects(); }} />}
    </div>
  );
}

export function TasksPage({ taskId }: { taskId?: string }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader title="Tâches" />
      <div className="min-h-0 flex-1">
        <TaskBoard baseHref="#taches" openTaskId={taskId} />
      </div>
    </div>
  );
}
