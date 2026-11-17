import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { useApp } from '../data';
import { formatDateTime } from '../format';
import { useCan } from '../perm';
import { go } from '../route';
import { STATUS_LABEL, TASK_STATUS_LABEL, type ActivityItem, type Project, type ProjectStatus, type Task } from '../types';
import { Avatar, AvatarStack, Empty, ErrorNote, Field, Icon, Modal, PageHeader, ProgressBar, RoleChip, Spinner, StatusChip, Tabs, useConfirm, useToast } from '../ui';
import { ChatPanel } from './Chat';
import { FileBrowser } from './Documents';
import { FormModal } from './FormModal';
import { MeetingList } from './Meetings';
import { TaskBoard } from './Tasks';

const PALETTE = ['#135FEA', '#11C6D8', '#081B4B', '#0E4CC0', '#0B7A8A', '#526079', '#3B4FB8', '#C4571A'];

function ColorPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <div role="radiogroup" aria-label="Couleur du projet" className="flex flex-wrap gap-2">
      {PALETTE.map((c) => (
        <button key={c} type="button" role="radio" aria-checked={value === c} aria-label={c} onClick={() => onChange(c)}
          className={`h-9 w-9 rounded-full ${value === c ? 'ring-2 ring-navy ring-offset-2' : ''}`} style={{ background: c }} />
      ))}
    </div>
  );
}

function ProjectForm({ project, onClose, onSaved }: { project?: Project; onClose: () => void; onSaved: (p: Project) => void }) {
  const { members } = useApp();
  const { user } = useAuth();
  const toast = useToast();
  const [name, setName] = useState(project?.name ?? '');
  const [description, setDescription] = useState(project?.description ?? '');
  const [color, setColor] = useState(project?.color ?? PALETTE[0]!);
  const [status, setStatus] = useState<ProjectStatus>(project?.status ?? 'active');
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [leadId, setLeadId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = project
        ? await api<{ project: Project }>(`/projects/${project.id}`, { method: 'PATCH', body: { name, description, color, status } })
        : await api<{ project: Project }>('/projects', { method: 'POST', body: { name, description, color, memberIds, leadId: leadId || null } });
      toast.success(project ? 'Projet modifié' : 'Projet créé');
      onSaved(r.project);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Enregistrement impossible.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={project ? 'Modifier le projet' : 'Nouveau projet'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Nom du projet"><input className="field" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} /></Field>
        <Field label="Description"><textarea className="field" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} /></Field>
        <div><span className="label">Couleur d'identification</span><div className="mt-1"><ColorPicker value={color} onChange={setColor} /></div></div>
        {project && (project.status === 'active' || project.status === 'paused') && (
          <Field label="Statut" hint="La fin de projet se déclare depuis la vue d'ensemble : le responsable déclare « terminé », le PDG confirme l'archivage.">
            <select className="field" value={status} onChange={(e) => setStatus(e.target.value as ProjectStatus)}>
              {(['active', 'paused'] as ProjectStatus[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
            </select>
          </Field>
        )}
        {!project && (
          <Field label="Responsable du projet" hint="Un fondateur ayant la fonction « Chef de projet ». Sans responsable, le projet est signalé comme orphelin.">
            <select className="field" value={leadId} onChange={(e) => setLeadId(e.target.value)}>
              <option value="">Aucun pour l'instant</option>
              {members.filter((m) => m.functions?.includes('project_lead') && !m.suspended).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </Field>
        )}
        {!project && (
          <fieldset>
            <legend className="label">Membres (vous et le responsable êtes ajoutés automatiquement)</legend>
            <div className="mt-1 max-h-44 space-y-1 overflow-y-auto">
              {members.filter((m) => m.id !== user?.id).map((m) => (
                <label key={m.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-mist">
                  <input type="checkbox" className="h-5 w-5 accent-[#135fea]" checked={memberIds.includes(m.id)} onChange={(e) => setMemberIds(e.target.checked ? [...memberIds, m.id] : memberIds.filter((x) => x !== m.id))} />
                  <Avatar name={m.name} size={26} /> <span className="text-sm font-semibold">{m.name}</span> <RoleChip role={m.role} />
                </label>
              ))}
            </div>
          </fieldset>
        )}
        <ErrorNote>{error}</ErrorNote>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Annuler</button>
          <button className="btn btn-primary" disabled={busy || !name.trim()}>{busy ? 'Enregistrement…' : project ? 'Enregistrer' : 'Créer le projet'}</button>
        </div>
      </form>
    </Modal>
  );
}

function ProjectCard({ p, list }: { p: Project; list: boolean }) {
  return (
    <a href={`#projets/${p.id}`} className={`card block overflow-hidden hover:border-electric ${p.status === 'archived' ? 'opacity-75' : ''}`}>
      <div className="h-1.5" style={{ background: p.color }} />
      <div className={`p-4 ${list ? 'flex flex-wrap items-center gap-4' : ''}`}>
        <div className={list ? 'min-w-0 flex-1' : ''}>
          <div className="flex items-start justify-between gap-2">
            <h3 className="font-bold leading-snug">{p.name}</h3>
            <StatusChip status={p.status} />
          </div>
          {p.orphan && <span className="badge bd-warning mt-1">Sans responsable disponible</span>}
          {p.description && <p className="mt-1 line-clamp-2 text-sm text-slate">{p.description}</p>}
        </div>
        <div className={list ? 'w-full sm:w-64' : 'mt-3'}>
          <div className="mb-1 flex justify-between text-xs font-semibold text-slate"><span>{p.tasksDone}/{p.tasksTotal} tâches</span><span>{p.progress}%</span></div>
          <ProgressBar value={p.progress} color={p.color} label={`Progression de ${p.name}`} />
          <div className="mt-3"><AvatarStack names={p.members.map((m) => m.name)} max={5} size={26} /></div>
        </div>
      </div>
    </a>
  );
}

export function Projects() {
  const { user } = useAuth();
  const { can } = useCan();
  const { projects, refreshProjects } = useApp();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'all' | ProjectStatus>('all');
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [creating, setCreating] = useState(false);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return projects.filter((p) => (status === 'all' ? p.status !== 'archived' || false : p.status === status) && (!needle || `${p.name} ${p.description}`.toLowerCase().includes(needle)));
  }, [projects, q, status]);
  const filters: ('all' | ProjectStatus)[] = ['all', 'active', 'paused', 'done', 'archived'];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader title="Projets">
        {can('project.create') && <button className="btn btn-primary" onClick={() => setCreating(true)}><Icon name="plus" className="h-4 w-4" /> Nouveau projet</button>}
      </PageHeader>
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-white px-3 py-2">
        <div className="relative min-w-44 flex-1">
          <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate" />
          <input className="field !pl-9" placeholder="Rechercher un projet" aria-label="Rechercher un projet" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div role="group" aria-label="Filtrer par statut" className="flex flex-wrap gap-1">
          {filters.map((f) => (
            <button key={f} aria-pressed={status === f} onClick={() => setStatus(f)} className={`min-h-9 rounded-full px-3 text-sm font-semibold ${status === f ? 'bg-navy text-white' : 'bg-mist text-navy hover:bg-line'}`}>
              {f === 'all' ? 'Tous' : STATUS_LABEL[f]}
            </button>
          ))}
        </div>
        <div role="group" aria-label="Affichage" className="flex overflow-hidden rounded-xl border border-line">
          <button aria-pressed={view === 'grid'} aria-label="Grille" onClick={() => setView('grid')} className={`p-2 ${view === 'grid' ? 'bg-electric text-white' : 'bg-white'}`}><Icon name="grid" className="h-5 w-5" /></button>
          <button aria-pressed={view === 'list'} aria-label="Liste" onClick={() => setView('list')} className={`p-2 ${view === 'list' ? 'bg-electric text-white' : 'bg-white'}`}><Icon name="list" className="h-5 w-5" /></button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3 md:p-5">
        {shown.length === 0 && (
          <Empty action={can('project.create') && status === 'all' && !q ? <button className="btn btn-primary" onClick={() => setCreating(true)}>Créer le premier projet</button> : undefined}>
            {user?.role === 'guest' && projects.length === 0 ? "Vous n'avez pas encore été ajouté à un projet." : projects.length === 0 && !can('project.create') ? "Aucun projet pour l'instant : seuls le PDG et le Coordinateur en créent." : 'Aucun projet ne correspond.'}
          </Empty>
        )}
        <div className={view === 'grid' ? 'grid gap-3 sm:grid-cols-2 xl:grid-cols-3' : 'space-y-3'}>
          {shown.map((p) => <ProjectCard key={p.id} p={p} list={view === 'list'} />)}
        </div>
      </div>
      {creating && <ProjectForm onClose={() => setCreating(false)} onSaved={(p) => { setCreating(false); void refreshProjects(); go(`projets/${p.id}`); }} />}
    </div>
  );
}

/* --------------------------------- Détail --------------------------------- */

type TabId = 'apercu' | 'taches' | 'dossiers' | 'messages' | 'rdv' | 'membres' | 'activite';

function Overview({ p, onEdit, onChanged }: { p: Project; onEdit: () => void; onChanged: () => Promise<void> }) {
  const { members } = useApp();
  const confirm = useConfirm();
  const toast = useToast();
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [dialog, setDialog] = useState<null | 'done' | 'refuse' | 'reopen' | 'lead'>(null);
  useEffect(() => { api<{ tasks: Task[] }>(`/tasks?projectId=${p.id}`).then((r) => setTasks(r.tasks)).catch(() => setTasks([])); }, [p.id, p.tasksDone, p.tasksTotal]);
  const counts = (['todo', 'doing', 'review', 'done'] as const).map((s) => ({ s, n: tasks?.filter((t) => t.status === s).length ?? 0 }));
  const next = (tasks ?? []).filter((t) => t.status !== 'done' && t.dueDate).sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? '')).slice(0, 5);
  const open = (tasks ?? []).filter((t) => t.status !== 'done');
  const perms = p.permissions;

  async function call(path: string, method: 'POST' | 'PUT' | 'DELETE', body: unknown, ok: string) {
    await api(`/projects/${p.id}${path}`, { method, body });
    toast.success(ok);
    await onChanged();
  }
  async function remove() {
    if (!(await confirm({ title: `Supprimer « ${p.name} » ?`, message: 'Tâches, dossiers, fichiers et messages du projet seront supprimés définitivement. Impossible si des dépenses ou communications y sont liées.', confirmLabel: 'Supprimer', danger: true }))) return;
    try { await api(`/projects/${p.id}`, { method: 'DELETE' }); toast.success('Projet supprimé'); await onChanged(); go('projets'); }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Suppression impossible.'); }
  }
  const leads = members.filter((m) => m.functions?.includes('project_lead') && !m.suspended);

  return (
    <div className="space-y-4 p-3 md:p-5">
      {p.orphan && p.status !== 'archived' && <p role="alert" className="rounded-xl bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-900">Ce projet n'a pas de responsable disponible. {perms?.designateLead ? 'Désignez-en un.' : perms?.proposeLead ? 'Proposez un responsable au PDG.' : 'Le PDG ou le Coordinateur doit en désigner un.'}</p>}
      {p.status === 'done' && <p role="status" className="rounded-xl bg-blue-50 px-3 py-2 text-sm font-semibold text-electric">Projet terminé — en attente de la confirmation d'archivage par le PDG.</p>}
      {p.archiveMotive && p.status === 'active' && <p role="status" className="rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900"><strong>Archivage refusé :</strong> {p.archiveMotive}</p>}
      <section className="card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-bold">Progression automatique</h2>
          <span className="text-2xl font-bold">{p.progress}%</span>
        </div>
        <div className="mt-2"><ProgressBar value={p.progress} color={p.color} label="Progression du projet" /></div>
        <p className="mt-1 text-sm text-slate">{p.tasksDone} tâche{p.tasksDone > 1 ? 's' : ''} terminée{p.tasksDone > 1 ? 's' : ''} sur {p.tasksTotal}. Responsable : <strong>{p.lead?.name ?? 'aucun'}</strong>.</p>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {counts.map(({ s, n }) => <div key={s} className="rounded-xl bg-mist p-3 text-center"><span className="block text-xl font-bold">{n}</span><span className="text-xs font-semibold text-slate">{TASK_STATUS_LABEL[s]}</span></div>)}
        </div>
      </section>
      {p.description && <section className="card p-4"><h2 className="font-bold">Description</h2><p className="mt-1 whitespace-pre-wrap text-sm">{p.description}</p></section>}
      <section className="card p-4">
        <h2 className="font-bold">Prochaines échéances</h2>
        {next.length === 0 ? <p className="mt-1 text-sm text-slate">Aucune échéance à venir.</p> : (
          <ul className="mt-2 space-y-1">{next.map((t) => <li key={t.id}><a className="flex justify-between gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-mist" href={`#projets/${p.id}/taches/${t.id}`}><span className="truncate font-semibold">{t.title}</span><span className="shrink-0 text-slate">{t.dueDate}</span></a></li>)}</ul>
        )}
      </section>
      {perms && (
        <div className="flex flex-wrap gap-2">
          {perms.edit && <button className="btn btn-ghost" onClick={onEdit}><Icon name="edit" className="h-4 w-4" /> Modifier</button>}
          {(perms.designateLead || perms.proposeLead) && <button className="btn btn-ghost" onClick={() => setDialog('lead')}>{perms.designateLead ? 'Désigner le responsable' : 'Proposer un responsable'}</button>}
          {perms.declareDone && <button className="btn btn-primary" onClick={() => setDialog('done')}>Déclarer le projet terminé</button>}
          {perms.decideArchive && <button className="btn btn-primary" onClick={async () => { if (await confirm({ title: "Confirmer l'archivage ?", message: 'Le projet restera consultable mais ne sera plus modifiable.', confirmLabel: 'Archiver' })) { try { await call('/archive-decision', 'POST', { decision: 'approve' }, 'Projet archivé'); } catch (e) { toast.error(e instanceof Error ? e.message : 'Action impossible.'); } } }}>Confirmer l'archivage</button>}
          {perms.decideArchive && <button className="btn btn-ghost" onClick={() => setDialog('refuse')}>Refuser l'archivage</button>}
          {perms.reopen && <button className="btn btn-ghost" onClick={() => setDialog('reopen')}>Rouvrir</button>}
          {perms.delete && <button className="btn btn-danger" onClick={() => void remove()}><Icon name="trash" className="h-4 w-4" /> Supprimer</button>}
        </div>
      )}
      {dialog === 'done' && (
        <FormModal
          title="Déclarer le projet terminé"
          intro={open.length ? `${open.length} tâche${open.length > 1 ? 's sont' : ' est'} encore ouverte${open.length > 1 ? 's' : ''} : justifiez chacune (reportée ou annulée). Le PDG confirmera ensuite l'archivage.` : "Toutes les tâches sont terminées. Le PDG confirmera ensuite l'archivage."}
          fields={open.map((t) => ({ name: t.id, label: `« ${t.title} » — pourquoi reste-t-elle ouverte ?`, required: true, maxLength: 500 }))}
          submitLabel="Déclarer terminé"
          onClose={() => setDialog(null)}
          onSubmit={(v) => call('/done', 'POST', { notes: open.map((t) => ({ taskId: t.id, kind: 'postponed', note: v[t.id] ?? '' })) }, 'Projet déclaré terminé')}
        />
      )}
      {dialog === 'refuse' && <FormModal title="Refuser l'archivage" intro="Le projet repasse « Actif » avec ce motif." fields={[{ name: 'motive', label: 'Motif', type: 'textarea', required: true }]} submitLabel="Refuser" danger onClose={() => setDialog(null)} onSubmit={(v) => call('/archive-decision', 'POST', { decision: 'refuse', motive: v.motive }, 'Archivage refusé')} />}
      {dialog === 'reopen' && <FormModal title="Rouvrir le projet" fields={[{ name: 'motive', label: 'Motif de réouverture', type: 'textarea', required: true }]} onClose={() => setDialog(null)} onSubmit={(v) => call('/reopen', 'POST', { motive: v.motive }, 'Projet rouvert')} />}
      {dialog === 'lead' && <FormModal title={perms?.designateLead ? 'Désigner le responsable' : 'Proposer un responsable'} intro="Le responsable doit avoir la fonction « Chef de projet »." fields={[{ name: 'userId', label: 'Chef de projet', type: 'select', required: true, options: leads.map((m) => ({ value: m.id, label: m.name })) }]} onClose={() => setDialog(null)} onSubmit={(v) => call('/lead', 'PUT', { userId: v.userId }, perms?.designateLead ? 'Responsable désigné' : 'Proposition envoyée au PDG')} />}
    </div>
  );
}

interface Proposal { id: string; action: string; target: { id: string; name: string }; proposedBy: string; status: string; motive: string; createdAt: string }
const ACTION_FR: Record<string, string> = { add_member: 'Ajouter', remove_member: 'Retirer', set_lead: 'Désigner comme responsable' };

function MembersTab({ p, readOnly }: { p: Project; readOnly: boolean }) {
  const { members, refreshProjects } = useApp();
  const { can } = useCan();
  const toast = useToast();
  const [adding, setAdding] = useState('');
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [refuse, setRefuse] = useState<Proposal | null>(null);
  const perms = p.permissions;
  const mayAct = !readOnly && !!perms && (perms.manageMembers || perms.proposeMembers);
  const candidates = members.filter((m) => !p.members.some((x) => x.id === m.id) && !m.suspended);
  const loadProposals = useCallback(() => api<{ proposals: Proposal[] }>(`/projects/${p.id}/proposals`).then((r) => setProposals(r.proposals)).catch(() => {}), [p.id]);
  useEffect(() => { void loadProposals(); }, [loadProposals, p.pendingProposals]);

  async function act(fn: () => Promise<unknown>, ok: string) {
    try { await fn(); toast.success(ok); void refreshProjects(); void loadProposals(); } catch (e) { toast.error(e instanceof Error ? e.message : 'Action impossible.'); }
  }
  const pending = proposals.filter((x) => x.status === 'pending');
  return (
    <div className="space-y-3 p-3 md:p-5">
      {mayAct && candidates.length > 0 && (
        <div className="card flex flex-wrap items-end gap-2 p-3">
          <Field label={perms?.manageMembers ? 'Ajouter un membre' : 'Proposer un membre (le PDG décide)'}>
            <select className="field" value={adding} onChange={(e) => setAdding(e.target.value)}>
              <option value="">Choisir…</option>
              {candidates.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </Field>
          <button className="btn btn-primary" disabled={!adding} onClick={() => void act(async () => { await api(`/projects/${p.id}/members`, { method: 'POST', body: { userId: adding } }); setAdding(''); }, perms?.manageMembers ? 'Membre ajouté' : 'Proposition envoyée')}>{perms?.manageMembers ? 'Ajouter' : 'Proposer'}</button>
        </div>
      )}
      <ul className="space-y-2">
        {p.members.map((m) => (
          <li key={m.id} className="card flex items-center gap-3 p-3">
            <Avatar name={m.name} size={38} />
            <span className="min-w-0 flex-1 truncate font-semibold">{m.name}{p.lead?.id === m.id && <span className="badge bd-electric ml-2">Responsable</span>}</span>
            <RoleChip role={m.role} />
            {mayAct && p.lead?.id !== m.id && <button className="rounded-lg p-2 text-slate hover:bg-red-50 hover:text-red-700" aria-label={`Retirer ${m.name} du projet`} onClick={() => void act(() => api(`/projects/${p.id}/members/${m.id}`, { method: 'DELETE' }), perms?.manageMembers ? 'Membre retiré' : 'Proposition envoyée')}><Icon name="x" className="h-5 w-5" /></button>}
          </li>
        ))}
      </ul>
      {pending.length > 0 && (
        <section aria-label="Propositions en attente" className="space-y-2">
          <h3 className="font-bold">Propositions du Coordinateur</h3>
          <ul className="space-y-2">
            {pending.map((x) => (
              <li key={x.id} className="card flex flex-wrap items-center gap-3 p-3 text-sm">
                <span className="min-w-0 flex-1">{ACTION_FR[x.action] ?? x.action} <strong>{x.target.name}</strong> <span className="text-slate">· proposé par {x.proposedBy}</span></span>
                {can('function.assign') && <>
                  <button className="btn btn-primary btn-sm" onClick={() => void act(() => api(`/projects/${p.id}/proposals/${x.id}/decision`, { method: 'POST', body: { decision: 'accept' } }), 'Proposition acceptée')}>Accepter</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setRefuse(x)}>Refuser</button>
                </>}
              </li>
            ))}
          </ul>
        </section>
      )}
      <p className="text-xs text-slate">Le responsable du projet et le PDG gèrent les membres ; le Coordinateur propose. Les fondateurs voient tous les projets ; les invités internes ne voient que ceux où ils sont membres.</p>
      {refuse && <FormModal title="Refuser la proposition" fields={[{ name: 'motive', label: 'Motif', type: 'textarea', required: true }]} danger submitLabel="Refuser" onClose={() => setRefuse(null)} onSubmit={(v) => api(`/projects/${p.id}/proposals/${refuse.id}/decision`, { method: 'POST', body: { decision: 'refuse', motive: v.motive } }).then(() => { toast.success('Proposition refusée'); void loadProposals(); void refreshProjects(); })} />}
    </div>
  );
}

function ActivityTab({ id }: { id: string }) {
  const [items, setItems] = useState<ActivityItem[] | null>(null);
  useEffect(() => { api<{ activity: ActivityItem[] }>(`/projects/${id}/activity`).then((r) => setItems(r.activity)).catch(() => setItems([])); }, [id]);
  return (
    <div className="p-3 md:p-5">
      {!items && <Spinner />}
      {items && items.length === 0 && <Empty icon="history">Aucune activité pour l'instant.</Empty>}
      <ul className="divide-y divide-line overflow-hidden rounded-2xl bg-white ring-1 ring-line">
        {items?.map((i) => <li key={i.id} className="flex flex-wrap items-baseline justify-between gap-x-3 px-4 py-2.5 text-sm"><span><strong>{i.userName}</strong> — {i.summary}</span><time className="text-xs text-slate" dateTime={i.createdAt}>{formatDateTime(i.createdAt)}</time></li>)}
      </ul>
    </div>
  );
}

export function ProjectDetail({ id, tab, taskId }: { id: string; tab?: string; taskId?: string }) {
  const { projects, refreshProjects, channels } = useApp();
  const [editing, setEditing] = useState(false);
  const [missing, setMissing] = useState(false);
  const p = projects.find((x) => x.id === id);
  const current: TabId = (['apercu', 'taches', 'dossiers', 'messages', 'rdv', 'membres', 'activite'].includes(tab ?? '') ? tab : 'apercu') as TabId;

  useEffect(() => {
    if (p) return;
    const t = setTimeout(() => setMissing(true), 1500);
    return () => clearTimeout(t);
  }, [p]);

  if (!p) {
    return (
      <div className="flex h-full flex-col"><PageHeader title="Projet" back={{ href: '#projets', label: 'Projets' }} />{missing ? <Empty>Projet introuvable ou accès non autorisé.</Empty> : <Spinner />}</div>
    );
  }
  const archived = p.status === 'archived';
  const unread = channels.find((c) => c.id === p.channelId)?.unread ?? 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader title={p.name} back={{ href: '#projets', label: 'Projets' }}>
        <StatusChip status={p.status} />
        <span className="hidden w-32 sm:block"><ProgressBar value={p.progress} color={p.color} label="Progression" /></span>
        <span className="text-sm font-bold">{p.progress}%</span>
      </PageHeader>
      <div style={{ height: 3, background: p.color }} />
      <Tabs<TabId>
        label="Sections du projet"
        value={current}
        onChange={(t) => go(`projets/${id}/${t}`)}
        tabs={[
          { id: 'apercu', label: "Vue d'ensemble" }, { id: 'taches', label: 'Tâches' }, { id: 'dossiers', label: 'Dossiers' },
          { id: 'messages', label: 'Messages', badge: unread }, { id: 'rdv', label: 'RDV' }, { id: 'membres', label: 'Membres' }, { id: 'activite', label: 'Activité' },
        ]}
      />
      {archived && <p role="status" className="bg-slate-100 px-4 py-2 text-sm font-semibold text-slate">Projet archivé : consultable, mais non modifiable.</p>}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {current === 'apercu' && <Overview p={p} onEdit={() => setEditing(true)} onChanged={refreshProjects} />}
        {current === 'taches' && <div className="min-h-0 flex-1"><TaskBoard projectId={id} readOnly={archived} openTaskId={taskId} baseHref={`#projets/${id}/taches`} /></div>}
        {current === 'dossiers' && p.folderId && <FileBrowser key={p.folderId} rootFolderId={p.folderId} readOnly={archived} />}
        {current === 'messages' && p.channelId && <div className="min-h-0 flex-1"><ChatPanel channelId={p.channelId} active /></div>}
        {current === 'rdv' && <div className="p-3 md:p-5"><MeetingList projectId={id} readOnly={archived} /></div>}
        {current === 'membres' && <MembersTab p={p} readOnly={archived} />}
        {current === 'activite' && <ActivityTab id={id} />}
      </div>
      {editing && <ProjectForm project={p} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); void refreshProjects(); }} />}
    </div>
  );
}
