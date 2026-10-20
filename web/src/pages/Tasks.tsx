import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { api, downloadFile } from '../api';
import { useAuth } from '../auth';
import { useApp } from '../data';
import { formatDateTime, formatDue, formatSize, todayStr } from '../format';
import { MentionTextarea } from '../Mention';
import { useRealtime, useRealtimeEvents } from '../realtime';
import { go } from '../route';
import {
  PRIORITY_LABEL, TASK_ROLE_LABEL, TASK_STATUS_LABEL,
  type Priority, type Task, type TaskDetail, type TaskHistoryEntry, type TaskStatus,
} from '../types';
import {
  Avatar, Button, CheckBox, Drawer, Empty, ErrorNote, Field, FileIcon, Icon, Menu, Modal, PageHeader, PRIORITY_COLOR, PriorityChip,
  SkeletonList, Skeleton, TASK_STATUS_STYLE, TaskStatusChip, Tooltip, useConfirm, useToast, type MenuItem,
} from '../ui';

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

/** Échéance ; une tâche non terminée dont la date est passée porte un badge « En retard » visible par tous. */
function DueLabel({ task }: { task: Pick<Task, 'dueDate' | 'status'> }) {
  if (!task.dueDate) return null;
  const late = task.dueDate < todayStr() && task.status !== 'done';
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`inline-flex items-center gap-1 text-xs font-semibold ${late ? 'text-danger-ink' : 'text-slate'}`}>
        <Icon name="clock" className="h-3.5 w-3.5" />
        {formatDue(task.dueDate)}
      </span>
      {late && <span className="badge bd-danger">En retard</span>}
    </span>
  );
}

/** Pastille discrète quand la tâche n'est pas modifiable par l'utilisateur. */
function LockMark({ task }: { task: Pick<Task, 'lock' | 'myRole' | 'permissions'> }) {
  const label = task.lock === 'archived' ? 'Archivée : lecture seule' : task.lock === 'locked' ? 'Verrouillée (terminée depuis plus de 7 jours)' : task.myRole === 'observer' ? 'Lecture seule' : '';
  if (!label) return null;
  return (
    <Tooltip label={label}>
      <span className="inline-flex text-slate" role="img" aria-label={label}><Icon name={task.myRole === 'observer' && task.lock === 'none' ? 'eye' : 'lock'} className="h-3.5 w-3.5" /></span>
    </Tooltip>
  );
}

function TaskCard({ task, onOpen, onMove, showProject, draggable, justMoved }: { task: Task; onOpen: () => void; onMove?: (s: TaskStatus) => void; showProject: boolean; draggable: boolean; justMoved?: boolean }) {
  const idx = STATUSES.indexOf(task.status);
  return (
    <article
      draggable={draggable}
      onDragStart={(e: DragEvent) => e.dataTransfer.setData('text/task', task.id)}
      className={`card card-hover cursor-pointer p-3 shadow-sm ${justMoved ? 'moved-in' : ''}`}
      style={{ borderLeft: `4px solid ${PRIORITY_COLOR[task.priority]}` }} // D4.4 : la couleur du bord = la priorité
    >
      <button onClick={onOpen} className="block w-full text-left">
        <h4 className="!text-[0.95rem] font-semibold leading-snug">{task.title}</h4>
        {showProject && (
          <p className="mt-0.5 flex items-center gap-1.5 text-xs text-slate">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: task.project.color }} aria-hidden />
            {task.project.name}
          </p>
        )}
      </button>
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
        <PriorityChip priority={task.priority} />
        <DueLabel task={task} />
        {task.subtasksTotal > 0 && <span className="text-xs text-slate">☑ {task.subtasksDone}/{task.subtasksTotal}</span>}
        {task.commentCount > 0 && <span className="text-xs text-slate">💬 {task.commentCount}</span>}
        {task.attachmentCount > 0 && <span className="text-xs text-slate">📎 {task.attachmentCount}</span>}
        <LockMark task={task} />
      </div>
      {task.tags.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {task.tags.map((t) => <span key={t} className="rounded-full bg-cloud px-2 py-0.5 text-xs text-slate">#{t}</span>)}
        </div>
      )}
      <div className="mt-2 flex items-center justify-between">
        {task.assignee ? (
          <span className="flex items-center gap-1.5 text-xs text-slate"><Avatar name={task.assignee.name} size={22} />{task.assignee.name}</span>
        ) : (
          <span className="text-xs text-slate">Non assignée</span>
        )}
        {onMove && task.permissions.status && (
          <span className="flex gap-1">
            <button disabled={idx === 0} onClick={() => onMove(STATUSES[idx - 1] as TaskStatus)} className="icon-btn" aria-label={`Déplacer vers ${TASK_STATUS_LABEL[STATUSES[idx - 1] ?? 'todo']}`}>◀</button>
            <button disabled={idx === STATUSES.length - 1} onClick={() => onMove(STATUSES[idx + 1] as TaskStatus)} className="icon-btn" aria-label={`Déplacer vers ${TASK_STATUS_LABEL[STATUSES[idx + 1] ?? 'done']}`}>▶</button>
          </span>
        )}
      </div>
    </article>
  );
}

/* ------------------------------ Formulaire / détail ------------------------------ */

interface FormState { title: string; description: string; assigneeId: string; dueDate: string; priority: Priority; status: TaskStatus; tags: string }

const fromTask = (t: Task): FormState => ({ title: t.title, description: t.description, assigneeId: t.assignee?.id ?? '', dueDate: t.dueDate ?? '', priority: t.priority, status: t.status, tags: t.tags.join(', ') });

function useAssignees(projectId: string) {
  const { members, projects } = useApp();
  const project = projects.find((p) => p.id === projectId);
  return members.filter((m) => m.role !== 'guest' || project?.members.some((pm) => pm.id === m.id));
}

/**
 * Formulaire contrôlé. Chaque groupe de champs a son propre droit (amendement §5.3.3) :
 * `edit` = titre, description, échéance, priorité, étiquettes · `reassign` = assigné · `status` = statut (création seulement).
 * Un champ interdit est grisé (lecture seule) avec le curseur « non autorisé ».
 */
function TaskForm({ projectId, value, onChange, can = { edit: true, reassign: true, status: true }, showStatus = false }: {
  projectId: string; value: FormState; onChange: (s: FormState) => void; can?: { edit: boolean; reassign: boolean; status: boolean }; showStatus?: boolean;
}) {
  const people = useAssignees(projectId);
  const set = (patch: Partial<FormState>) => onChange({ ...value, ...patch });
  const ro = (allowed: boolean) => ({ disabled: !allowed, title: allowed ? undefined : 'Lecture seule : vous ne pouvez pas modifier ce champ' });
  return (
    <div className="space-y-3">
      <Field label="Titre">
        <input className="field" value={value.title} onChange={(e) => set({ title: e.target.value })} maxLength={200} required {...ro(can.edit)} />
      </Field>
      <Field label="Description">
        <textarea className="field t-prose" rows={3} value={value.description} onChange={(e) => set({ description: e.target.value })} maxLength={5000} {...ro(can.edit)} />
      </Field>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Assignée à">
          <select className="field" value={value.assigneeId} onChange={(e) => set({ assigneeId: e.target.value })} {...ro(can.reassign)}>
            <option value="">Personne</option>
            {people.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </Field>
        <Field label="Échéance">
          <input type="date" className="field" value={value.dueDate} onChange={(e) => set({ dueDate: e.target.value })} {...ro(can.edit)} />
        </Field>
        <Field label="Priorité">
          <select className="field" value={value.priority} onChange={(e) => set({ priority: e.target.value as Priority })} {...ro(can.edit)}>
            {PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
          </select>
        </Field>
        {showStatus && (
          <Field label="Statut">
            <select className="field" value={value.status} onChange={(e) => set({ status: e.target.value as TaskStatus })} {...ro(can.status)}>
              {STATUSES.map((p) => <option key={p} value={p}>{TASK_STATUS_LABEL[p]}</option>)}
            </select>
          </Field>
        )}
      </div>
      <Field label="Étiquettes" hint="Séparées par des virgules.">
        <input className="field" value={value.tags} onChange={(e) => set({ tags: e.target.value })} placeholder="ex. visa, urgent" {...ro(can.edit)} />
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
        <p className="rounded-lg bg-info-bg px-3 py-2 text-xs text-info-ink">Vous serez le créateur de cette tâche : vous pourrez tout modifier. La personne assignée pourra changer le statut ; les autres membres pourront la consulter et la commenter.</p>
        <TaskForm key={pid} projectId={pid} value={form} onChange={setForm} showStatus />
        <div>
          <span className="label">Sous-tâches (checklist)</span>
          <ul className="mt-1 space-y-1">
            {subs.map((s, i) => (
              <li key={i} className="flex items-center justify-between rounded-lg bg-cloud px-3 py-1.5 text-sm">
                {s}
                <button type="button" onClick={() => setSubs(subs.filter((_, j) => j !== i))} aria-label={`Retirer ${s}`} className="icon-btn"><Icon name="x" className="h-4 w-4" /></button>
              </li>
            ))}
          </ul>
          <div className="mt-1 flex gap-2">
            <input className="field" value={sub} onChange={(e) => setSub(e.target.value)} placeholder="Ajouter une étape" aria-label="Nouvelle étape" maxLength={200}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (sub.trim()) { setSubs([...subs, sub.trim()]); setSub(''); } } }} />
            <button type="button" className="btn btn-ghost" onClick={() => { if (sub.trim()) { setSubs([...subs, sub.trim()]); setSub(''); } }}>Ajouter</button>
          </div>
        </div>
        <ErrorNote>{error}</ErrorNote>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Annuler</button>
          <Button loading={busy} loadingLabel="Création…" disabled={!form.title.trim() || !pid}>Créer la tâche</Button>
        </div>
      </form>
    </Modal>
  );
}

/* ----------------------- Statut : sélecteur coloré (assigné, créateur, admin) ----------------------- */

function StatusStepper({ status, allowed, onPick }: { status: TaskStatus; allowed: boolean; onPick: (s: TaskStatus) => void }) {
  return (
    <div role="group" aria-label="Statut de la tâche" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {STATUSES.map((s) => {
        const on = status === s;
        return (
          <button
            key={s}
            type="button"
            aria-pressed={on}
            disabled={!allowed || on}
            onClick={() => onPick(s)}
            title={allowed ? undefined : 'Lecture seule : vous ne pouvez pas changer le statut'}
            className={`min-h-11 rounded-xl border px-2 text-sm font-semibold transition-colors ${on ? `${TASK_STATUS_STYLE[s]} border-current` : 'border-line bg-white text-slate hover:bg-cloud'} ${!allowed ? 'cursor-not-allowed opacity-60' : ''} ${on ? 'cursor-default' : ''}`}
          >
            {on && '✓ '}{TASK_STATUS_LABEL[s]}
          </button>
        );
      })}
    </div>
  );
}

/* -------------------------------- Historique (§5.3.4) -------------------------------- */

const FIELD_LABEL: Record<string, string> = { title: 'le titre', description: 'la description', status: 'le statut', priority: 'la priorité', dueDate: "l'échéance", assignedTo: "l'assigné", tags: 'les étiquettes', createdBy: 'le propriétaire', archived: "l'archivage" };

function historyValue(field: string, v: string | null) {
  if (v === null || v === '') return 'aucun(e)';
  if (field === 'status') return `« ${TASK_STATUS_LABEL[v as TaskStatus] ?? v} »`;
  if (field === 'priority') return `« ${PRIORITY_LABEL[v as Priority] ?? v} »`;
  if (field === 'dueDate') return formatDue(v);
  if (field === 'description') return v.length > 60 ? `« ${v.slice(0, 60)}… »` : `« ${v} »`;
  return `« ${v} »`;
}

function historySentence(h: TaskHistoryEntry) {
  if (h.field === 'archived') return `${h.user} a ${h.newValue ? 'archivé' : 'désarchivé'} la tâche`;
  if (h.field === 'createdBy') return `${h.user} a transféré la propriété de « ${h.oldValue} » à « ${h.newValue} »`;
  return `${h.user} a changé ${FIELD_LABEL[h.field] ?? h.field} de ${historyValue(h.field, h.oldValue)} à ${historyValue(h.field, h.newValue)}`;
}

function TransferModal({ taskId, onClose, onDone }: { taskId: string; onClose: () => void; onDone: (t: TaskDetail) => void }) {
  const { members } = useApp();
  const toast = useToast();
  const people = members.filter((m) => m.role !== 'guest');
  const [to, setTo] = useState(people[0]?.id ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api<{ task: TaskDetail }>(`/tasks/${taskId}/transfer`, { method: 'POST', body: { userId: to } });
      toast.success('Propriété transférée');
      onDone(r.task);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Transfert impossible.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Transférer la propriété" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <p className="text-sm text-slate">Le nouveau propriétaire obtient les droits du créateur sur cette tâche. L'historique conserve ce transfert.</p>
        <Field label="Nouveau propriétaire">
          <select className="field" value={to} onChange={(e) => setTo(e.target.value)}>{people.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select>
        </Field>
        <ErrorNote>{error}</ErrorNote>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Annuler</button>
          <Button loading={busy} disabled={!to}>Transférer</Button>
        </div>
      </form>
    </Modal>
  );
}

/* ------------------------------ Panneau de détail (drawer) ------------------------------ */

function TaskDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { projects } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [error, setError] = useState('');
  const [form, setForm] = useState<FormState | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [newSub, setNewSub] = useState('');
  const [comment, setComment] = useState('');
  const [transfer, setTransfer] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const { epoch } = useRealtime();

  const load = useCallback(async () => {
    try {
      const r = await api<{ task: TaskDetail }>(`/tasks/${id}`);
      setTask(r.task);
      if (!dirtyRef.current) setForm(fromTask(r.task)); // ne jamais écraser une saisie en cours
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Tâche introuvable.');
    }
  }, [id]);

  useEffect(() => { void load(); }, [load, epoch]);
  useRealtimeEvents((e) => { if (e.type === 'task' && e.taskId === id) void load(); });

  const projectArchived = task ? projects.find((p) => p.id === task.projectId)?.status === 'archived' : false;

  async function run<T>(fn: () => Promise<T>, ok?: string) {
    setError('');
    try {
      const r = await fn();
      if (ok) toast.success(ok);
      onChanged();
      return r;
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Action impossible.';
      setError(msg);
      toast.error(msg);
      void load(); // revient à l'état réel côté serveur
    }
  }

  const apply = (t: TaskDetail) => { setTask(t); if (!dirtyRef.current) setForm(fromTask(t)); };
  const update = async (fn: () => Promise<{ task: TaskDetail }>, ok?: string) => { const r = await run(fn, ok); if (r) apply(r.task); return r; };

  /** N'envoie QUE les champs modifiés : le serveur refuse tout champ interdit au rôle de l'utilisateur. */
  async function save() {
    if (!form || !task) return;
    const body: Record<string, unknown> = {};
    if (form.title !== task.title) body.title = form.title;
    if (form.description !== task.description) body.description = form.description;
    if (form.assigneeId !== (task.assignee?.id ?? '')) body.assigneeId = form.assigneeId || null;
    if (form.dueDate !== (task.dueDate ?? '')) body.dueDate = form.dueDate || null;
    if (form.priority !== task.priority) body.priority = form.priority;
    if (parseTags(form.tags).join(',') !== task.tags.join(',')) body.tags = parseTags(form.tags);
    if (!Object.keys(body).length) { setDirty(false); return; }
    setBusy(true);
    const r = await run(() => api<{ task: TaskDetail }>(`/tasks/${id}`, { method: 'PATCH', body }), 'Tâche enregistrée');
    setBusy(false);
    if (r) { setDirty(false); setTask(r.task); setForm(fromTask(r.task)); }
  }

  async function remove() {
    if (!(await confirm({ title: 'Supprimer cette tâche ?', message: 'Ses sous-tâches, commentaires, pièces jointes et son historique seront supprimés.', confirmLabel: 'Supprimer', danger: true }))) return;
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
    return (
      <Drawer title="Tâche" onClose={onClose}>
        {error ? <ErrorNote>{error}</ErrorNote> : <div role="status" aria-busy="true" className="space-y-4"><span className="sr-only">Chargement…</span><Skeleton className="h-6 w-2/3" /><Skeleton className="h-24 w-full" /><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" /></div>}
      </Drawer>
    );
  }

  const perms = task.permissions;
  const readOnlyAll = !perms.edit && !perms.status;
  const menu: MenuItem[] = [
    ...(perms.archive ? [{ label: 'Archiver (lecture seule)', icon: 'archive' as const, onSelect: () => void update(() => api(`/tasks/${id}/archive`, { method: 'POST', body: {} }), 'Tâche archivée') }] : []),
    ...(perms.unarchive ? [{ label: 'Désarchiver', icon: 'archive' as const, onSelect: () => void update(() => api(`/tasks/${id}/unarchive`, { method: 'POST', body: {} }), 'Tâche désarchivée') }] : []),
    ...(task.myRole === 'admin' ? [{ label: 'Transférer la propriété', icon: 'transfer' as const, onSelect: () => setTransfer(true) }] : []),
    ...(perms.delete ? [{ label: 'Supprimer la tâche', icon: 'trash' as const, danger: true, onSelect: () => void remove() }] : []),
  ];

  return (
    <Drawer
      title={task.title}
      onClose={onClose}
      subtitle={
        <span className="flex flex-wrap items-center gap-x-2">
          <a href={`#projets/${task.projectId}`} className="font-semibold text-electric hover:underline"><span className="mr-1.5 inline-block h-2 w-2 rounded-full" style={{ background: task.project.color }} aria-hidden />{task.project.name}</a>
          <span>· Créée par {task.createdBy?.name ?? 'les admins'} · {formatDateTime(task.createdAt)}</span>
        </span>
      }
      actions={menu.length > 0 && !projectArchived ? <Menu label="Actions sur la tâche" items={menu} /> : undefined}
    >
      {/* Rôle sur la tâche et état */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className={`badge ${task.myRole === 'observer' ? 'bd-slate' : 'bd-electric'}`}>{task.myRole === 'observer' ? '👁️ Lecture seule' : `Votre rôle : ${TASK_ROLE_LABEL[task.myRole]}`}</span>
        <TaskStatusChip status={task.status} />
        <PriorityChip priority={task.priority} />
        {task.lock === 'locked' && <span className="badge bd-warning">🔒 Verrouillée</span>}
        {task.lock === 'archived' && <span className="badge bd-slate">🗄️ Archivée</span>}
        <DueLabel task={task} />
      </div>
      {projectArchived && <p className="mb-3 rounded-lg bg-cloud px-3 py-2 text-sm text-slate">Projet archivé : la tâche est en lecture seule.</p>}
      {!projectArchived && task.lock === 'archived' && <p className="mb-3 rounded-lg bg-cloud px-3 py-2 text-sm text-slate">Cette tâche est archivée : lecture seule définitive (seul un admin peut la modifier ou la désarchiver). Vous pouvez toujours la commenter.</p>}
      {!projectArchived && task.lock === 'locked' && <p className="mb-3 rounded-lg bg-warning-bg px-3 py-2 text-sm text-warning-ink">Terminée depuis plus de 7 jours, cette tâche est verrouillée.{perms.status ? ' En tant que créateur, vous pouvez la rouvrir en changeant son statut.' : ' Seuls son créateur (pour la rouvrir) et les admins peuvent encore agir dessus.'}</p>}
      {!projectArchived && task.lock === 'none' && task.myRole === 'observer' && <p className="mb-3 rounded-lg bg-cloud px-3 py-2 text-sm text-slate">Seuls le créateur, l'assigné (statut) et les admins peuvent modifier cette tâche. Vous pouvez la commenter et joindre un fichier.</p>}
      {!projectArchived && task.lock === 'none' && task.myRole === 'assignee' && <p className="mb-3 rounded-lg bg-info-bg px-3 py-2 text-sm text-info-ink">Cette tâche vous est assignée : vous pouvez changer son statut, ajouter des sous-tâches et la commenter. Le reste est réservé au créateur.</p>}

      <section aria-label="Statut" className="mb-4">
        <h3 className="t-overline mb-2">Statut</h3>
        <StatusStepper status={task.status} allowed={perms.status} onPick={(s) => void update(() => api(`/tasks/${id}`, { method: 'PATCH', body: { status: s } }))} />
      </section>

      <TaskForm projectId={task.projectId} value={form} can={{ edit: perms.edit, reassign: perms.reassign, status: false }} onChange={(s) => { setForm(s); setDirty(true); }} />
      <ErrorNote>{error}</ErrorNote>
      {perms.edit || perms.reassign ? (
        <div className="mt-3 flex justify-end">
          <Button loading={busy} disabled={!dirty || !form.title.trim()} onClick={() => void save()}>Enregistrer</Button>
        </div>
      ) : null}

      <section className="mt-6" aria-labelledby="sub-h">
        <h3 id="sub-h" className="t-h4">Sous-tâches {task.subtasks.length > 0 && <span className="text-sm font-normal text-slate">({task.subtasks.filter((s) => s.done).length}/{task.subtasks.length})</span>}</h3>
        {task.subtasks.length === 0 && <p className="mt-2 text-sm text-slate">Aucune sous-tâche.</p>}
        <ul className="mt-2 space-y-1">
          {task.subtasks.map((s) => (
            <li key={s.id} className="flex items-center gap-3 rounded-lg px-1 py-1 hover:bg-cloud">
              <CheckBox checked={s.done} disabled={!perms.subtask || projectArchived} id={`sub-${s.id}`} label={`Terminer « ${s.title} »`}
                onChange={(done) => { setTask((t) => t && { ...t, subtasks: t.subtasks.map((x) => (x.id === s.id ? { ...x, done } : x)) }); void update(() => api(`/subtasks/${s.id}`, { method: 'PATCH', body: { done } })); }} />
              <label htmlFor={`sub-${s.id}`} className={`flex-1 text-sm ${s.done ? 'text-slate line-through' : ''}`}>{s.title}</label>
              {perms.subtask && !projectArchived && <button className="icon-btn" aria-label={`Supprimer ${s.title}`} onClick={() => void update(() => api(`/subtasks/${s.id}`, { method: 'DELETE' }))}><Icon name="x" className="h-4 w-4" /></button>}
            </li>
          ))}
        </ul>
        {perms.subtask && !projectArchived && (
          <form className="mt-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (!newSub.trim()) return; const t = newSub.trim(); setNewSub(''); void update(() => api(`/tasks/${id}/subtasks`, { method: 'POST', body: { title: t } })); }}>
            <input className="field" aria-label="Nouvelle sous-tâche" placeholder="Ajouter une étape" value={newSub} onChange={(e) => setNewSub(e.target.value)} maxLength={200} />
            <button className="btn btn-ghost">Ajouter</button>
          </form>
        )}
      </section>

      <section className="mt-6" aria-labelledby="att-h">
        <div className="flex items-center justify-between">
          <h3 id="att-h" className="t-h4">Pièces jointes</h3>
          {!projectArchived && (
            <>
              <input ref={fileInput} type="file" className="hidden" aria-label="Ajouter une pièce jointe" onChange={(e) => void upload(e.target.files?.[0])} />
              <button className="btn btn-ghost btn-sm" onClick={() => fileInput.current?.click()}><Icon name="attach" className="h-4 w-4" /> Joindre</button>
            </>
          )}
        </div>
        {task.attachments.length === 0 && <p className="mt-2 text-sm text-slate">Aucune pièce jointe.</p>}
        <ul className="mt-2 space-y-1">
          {task.attachments.map((f) => (
            <li key={f.id} className={`flex items-center gap-1 ${Date.now() - Date.parse(f.createdAt) < 4000 ? 'pop-in' : ''}`}>
              <button onClick={() => void downloadFile(f.id, f.name)} className="flex min-w-0 flex-1 items-center gap-3 rounded-xl px-2 py-1.5 text-left hover:bg-cloud" aria-label={`Télécharger ${f.name}`}>
                <FileIcon name={f.name} mime={f.mime} size={32} />
                <span className="min-w-0 flex-1 truncate text-sm font-semibold">{f.name}</span>
                <span className="text-xs text-slate">{formatSize(f.size)} · {f.uploadedBy}</span>
              </button>
              {f.canDelete && !projectArchived && (
                <button className="icon-btn" aria-label={`Supprimer la pièce jointe ${f.name}`}
                  onClick={async () => { if (await confirm({ title: `Supprimer « ${f.name} » ?`, confirmLabel: 'Supprimer', danger: true })) await update(async () => { await api(`/files/${f.id}`, { method: 'DELETE' }); return (await api<{ task: TaskDetail }>(`/tasks/${id}`)); }, 'Pièce jointe supprimée'); }}>
                  <Icon name="trash" className="h-4 w-4" />
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-6" aria-labelledby="com-h">
        <h3 id="com-h" className="t-h4">Commentaires</h3>
        {task.comments.length === 0 && <p className="mt-2 text-sm text-slate">Aucun commentaire. Utilisez @ pour mentionner quelqu'un.</p>}
        <ul className="mt-2 space-y-3">
          {task.comments.map((c) => (
            <li key={c.id} className="flex gap-2">
              <Avatar name={c.user.name} size={30} />
              <div className="min-w-0 flex-1 rounded-2xl bg-cloud px-3 py-2">
                <p className="flex items-center justify-between gap-2 text-xs">
                  <span><strong>{c.user.name}</strong> <span className="text-slate">· {formatDateTime(c.createdAt)}</span></span>
                  {c.canDelete && !projectArchived && (
                    <button className="icon-btn !min-h-8 !min-w-8" aria-label={`Supprimer le commentaire de ${c.user.name}`}
                      onClick={async () => { if (await confirm({ title: 'Supprimer ce commentaire ?', confirmLabel: 'Supprimer', danger: true })) void update(() => api(`/tasks/${id}/comments/${c.id}`, { method: 'DELETE' }), 'Commentaire supprimé'); }}>
                      <Icon name="trash" className="h-4 w-4" />
                    </button>
                  )}
                </p>
                <p className="t-prose whitespace-pre-wrap break-words text-sm">{c.body}</p>
              </div>
            </li>
          ))}
        </ul>
        {!projectArchived && (
          <form className="mt-3 space-y-2" onSubmit={(e) => { e.preventDefault(); const b = comment.trim(); if (!b) return; setComment(''); void update(() => api(`/tasks/${id}/comments`, { method: 'POST', body: { body: b } })); }}>
            <MentionTextarea label="Votre commentaire" value={comment} onChange={setComment} placeholder="Écrire un commentaire…" />
            <div className="text-right"><button className="btn btn-primary btn-sm" disabled={!comment.trim()}>Commenter</button></div>
          </form>
        )}
      </section>

      <section className="mt-6" aria-labelledby="his-h">
        <h3 id="his-h" className="t-h4 flex items-center gap-2"><Icon name="history" className="h-5 w-5 text-slate" /> Historique</h3>
        {task.history.length === 0 && <p className="mt-2 text-sm text-slate">Aucune modification pour l'instant.</p>}
        <ol className="mt-2 space-y-2 border-l-2 border-line pl-4">
          {task.history.map((h) => (
            <li key={h.id} className="relative text-sm">
              <span className="absolute -left-[1.4rem] top-1.5 h-2 w-2 rounded-full bg-electric" aria-hidden />
              {historySentence(h)}
              <span className="block text-xs text-slate">{formatDateTime(h.createdAt)}</span>
            </li>
          ))}
        </ol>
      </section>
      {readOnlyAll && <span className="sr-only">Tâche en lecture seule</span>}
      {transfer && <TransferModal taskId={id} onClose={() => setTransfer(false)} onDone={(t) => { setTransfer(false); apply(t); onChanged(); }} />}
    </Drawer>
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
        {tasks === null && !error && <div className="p-3"><SkeletonList rows={5} /></div>}
        {tasks && view === 'kanban' && <KanbanView tasks={visible} onOpen={open} onMove={move} showProject={showProject} readOnly={readOnly} />}
        {tasks && view === 'list' && <ListView tasks={visible} onOpen={open} onToggle={toggle} showProject={showProject} readOnly={readOnly} />}
        {tasks && view === 'calendar' && <CalendarView tasks={visible} onOpen={open} />}
        {tasks && view === 'day' && <DayView tasks={tasks} onOpen={open} onToggle={toggle} showProject={showProject} />}
      </div>
      {creating && (
        <NewTaskModal projectId={projectId} projectChoices={choices} onClose={() => setCreating(false)} onCreated={(t) => { setCreating(false); void load(); void refreshProjects(); open(t); }} />
      )}
      {openTaskId && <TaskDrawer key={openTaskId} id={openTaskId} onClose={closeModal} onChanged={() => { void load(); void refreshProjects(); }} />}
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
