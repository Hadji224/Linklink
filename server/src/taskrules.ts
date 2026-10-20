import { db, now, uid } from './db.js';
import { logActivity } from './activity.js';
import { HttpError, type AuthUser } from './http.js';
import { notify } from './notify.js';

/**
 * Droits d'écriture sur les tâches (amendement v1.1, §5.3 et §9.6).
 * Le rôle est calculé PAR TÂCHE : créateur, assigné, admin ou observateur.
 */
export type TaskRole = 'admin' | 'creator' | 'assignee' | 'observer';
export type TaskLock = 'none' | 'locked' | 'archived';

export const LOCK_AFTER_DAYS = 7;

export interface TaskRules {
  id: string;
  project_id: string;
  title: string;
  status: string;
  assignee_id: string | null;
  created_by: string | null;
  completed_at: string | null;
  archived_at: string | null;
}

export function taskRole(user: Pick<AuthUser, 'id' | 'role'>, t: Pick<TaskRules, 'assignee_id' | 'created_by'>): TaskRole {
  if (user.role === 'admin') return 'admin';
  if (t.created_by === user.id) return 'creator'; // créateur = assigné : le rôle le plus permissif l'emporte
  if (t.assignee_id === user.id) return 'assignee';
  return 'observer';
}

/** Archivée → lecture seule définitive ; terminée depuis plus de 7 jours → verrouillée (le créateur peut la rouvrir). */
export function taskLock(t: Pick<TaskRules, 'status' | 'completed_at' | 'archived_at'>): TaskLock {
  if (t.archived_at) return 'archived';
  if (t.status === 'done' && t.completed_at && Date.now() - Date.parse(t.completed_at) > LOCK_AFTER_DAYS * 86_400_000) return 'locked';
  return 'none';
}

export interface TaskPermissions {
  /** titre, description, échéance, priorité, étiquettes */
  edit: boolean;
  status: boolean;
  reassign: boolean;
  delete: boolean;
  subtask: boolean;
  archive: boolean;
  unarchive: boolean;
}

export function taskPermissions(user: Pick<AuthUser, 'id' | 'role'>, t: TaskRules): TaskPermissions {
  const role = taskRole(user, t);
  const lock = taskLock(t);
  const none: TaskPermissions = { edit: false, status: false, reassign: false, delete: false, subtask: false, archive: false, unarchive: false };
  if (role === 'admin') return { edit: true, status: true, reassign: true, delete: true, subtask: true, archive: lock !== 'archived' && t.status === 'done', unarchive: lock === 'archived' };
  if (role === 'observer' || lock === 'archived') return none;
  if (lock === 'locked') return role === 'creator' ? { ...none, status: true } : none; // le créateur peut seulement rouvrir
  if (role === 'creator') return { edit: true, status: true, reassign: true, delete: true, subtask: true, archive: t.status === 'done', unarchive: false };
  return { ...none, status: true, subtask: true }; // assigné
}

export type TaskAction = keyof TaskPermissions;
type DenyAction = TaskAction | 'comment';

const READ_ONLY = 'Vous êtes en lecture seule sur cette tâche. Seuls le créateur, l\'assigné (statut) et les admins peuvent la modifier.';

function reason(user: AuthUser, t: TaskRules, action: DenyAction): string {
  if (action === 'comment') return "Seul l'auteur du commentaire ou un admin peut le supprimer.";
  const role = taskRole(user, t);
  const lock = taskLock(t);
  if (role === 'observer') return action === 'delete' ? 'Seuls le créateur et les admins peuvent supprimer.' : READ_ONLY;
  if (lock === 'archived') return 'Cette tâche est archivée : elle est en lecture seule (seul un admin peut la modifier).';
  if (lock === 'locked') return `Cette tâche est verrouillée (terminée depuis plus de ${LOCK_AFTER_DAYS} jours). Le créateur peut la rouvrir ; sinon seuls les admins peuvent la modifier.`;
  if (action === 'reassign') return 'Seuls le créateur et les admins peuvent réassigner.';
  if (action === 'delete') return 'Seuls le créateur et les admins peuvent supprimer.';
  if (action === 'archive') return 'Seul le créateur ou un admin peut archiver une tâche terminée.';
  if (action === 'unarchive') return 'Seul un admin peut désarchiver une tâche.';
  if (action === 'edit') return "En tant qu'assigné, vous ne pouvez modifier que le statut.";
  return READ_ONLY;
}

/**
 * Refus 403 + détection des tentatives non autorisées (§9.8) : journal d'activité,
 * notification (in-app + e-mail si configuré) au créateur et aux admins. Le journal d'accès
 * du serveur contient déjà l'utilisateur, la tâche (chemin) et le code 403.
 */
export function denyTask(user: AuthUser, t: TaskRules, action: DenyAction, attempt: string): never {
  const message = reason(user, t, action);
  logActivity(user, 'denied', 'task', t.id, `Tentative refusée sur « ${t.title} » : ${attempt}`, t.project_id);
  const hour = now().slice(0, 13);
  const admins = (db.prepare("SELECT id FROM users WHERE role = 'admin'").all() as { id: string }[]).map((a) => a.id);
  for (const target of new Set([t.created_by, ...admins].filter((x): x is string => !!x && x !== user.id))) {
    notify({
      userId: target,
      type: 'security',
      title: `Modification refusée sur « ${t.title} »`,
      body: `${user.name} a tenté : ${attempt}`,
      link: `#projets/${t.project_id}/taches/${t.id}`,
      dedupeKey: `deny:${t.id}:${user.id}:${hour}`, // une alerte par personne, tâche et heure
    });
  }
  throw new HttpError(403, message);
}

export function requireTaskPermission(user: AuthUser, t: TaskRules, action: TaskAction, attempt: string) {
  if (!taskPermissions(user, t)[action]) denyTask(user, t, action, attempt);
}

/* ------------------------------ Historique (§5.3.4) ------------------------------ */

export type HistoryField = 'title' | 'description' | 'status' | 'priority' | 'dueDate' | 'assignedTo' | 'tags' | 'createdBy' | 'archived';

export function recordHistory(
  actor: { id: string | null; name: string },
  taskId: string,
  field: HistoryField,
  oldValue: string | null,
  newValue: string | null,
) {
  const clip = (v: string | null) => (v === null ? null : v.slice(0, 500));
  db.prepare('INSERT INTO task_history (id,task_id,user_id,user_name,field,old_value,new_value,created_at) VALUES (?,?,?,?,?,?,?,?)').run(
    uid(), taskId, actor.id, actor.name, field, clip(oldValue), clip(newValue), now(),
  );
}

export function taskHistory(taskId: string) {
  return (
    db
      .prepare('SELECT id, user_id, user_name, field, old_value, new_value, created_at FROM task_history WHERE task_id = ? ORDER BY created_at, rowid')
      .all(taskId) as { id: string; user_id: string | null; user_name: string; field: string; old_value: string | null; new_value: string | null; created_at: string }[]
  ).map((h) => ({ id: h.id, user: h.user_name || 'Système', field: h.field, oldValue: h.old_value, newValue: h.new_value, createdAt: h.created_at }));
}

/* ------------------- Départ d'un membre (cas limites §16.3) ------------------- */

/**
 * À appeler AVANT la suppression d'un compte :
 *  - les tâches qu'il a créées restent actives et passent en propriété admin (notification aux assignés) ;
 *  - les tâches qui lui étaient assignées redeviennent « non assignées » (seul le créateur peut les réassigner).
 */
export function handOverTasksOf(userId: string, userName: string) {
  const heir = db.prepare("SELECT id, name FROM users WHERE role = 'admin' AND id <> ? ORDER BY created_at LIMIT 1").get(userId) as { id: string; name: string } | undefined;
  const system = { id: null, name: 'Système' };
  const created = db.prepare('SELECT id, title, project_id, assignee_id FROM tasks WHERE created_by = ?').all(userId) as { id: string; title: string; project_id: string; assignee_id: string | null }[];
  for (const t of created) {
    db.prepare('UPDATE tasks SET created_by = ?, updated_at = ? WHERE id = ?').run(heir?.id ?? null, now(), t.id);
    recordHistory(system, t.id, 'createdBy', userName, heir?.name ?? 'Administration');
    if (t.assignee_id && t.assignee_id !== userId) {
      notify({ userId: t.assignee_id, type: 'task', title: `Le créateur de « ${t.title} » a quitté l'équipe`, body: 'La tâche reste active et passe sous la responsabilité des admins.', link: `#projets/${t.project_id}/taches/${t.id}` });
    }
  }
  const assigned = db.prepare('SELECT id, title, project_id, created_by FROM tasks WHERE assignee_id = ?').all(userId) as { id: string; title: string; project_id: string; created_by: string | null }[];
  for (const t of assigned) {
    db.prepare('UPDATE tasks SET assignee_id = NULL, updated_at = ? WHERE id = ?').run(now(), t.id);
    recordHistory(system, t.id, 'assignedTo', userName, null);
    if (t.created_by && t.created_by !== userId) {
      notify({ userId: t.created_by, type: 'task', title: `« ${t.title} » n'est plus assignée`, body: `${userName} a quitté l'équipe.`, link: `#projets/${t.project_id}/taches/${t.id}` });
    }
  }
}
