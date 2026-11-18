import { Router } from 'express';
import { z } from 'zod';
import { requireStaff } from '../auth.js';
import { audit, can, requireCap } from '../access.js';
import { logActivity } from '../activity.js';
import { db, now, today, tx, uid, type Role } from '../db.js';
import { HttpError, idParam, me, parse, type AuthUser } from '../http.js';
import { findMentions } from '../mentions.js';
import { notify } from '../notify.js';
import { canSeeProject, projectAudience, projectForRead, projectForWrite, visibleProjectIds } from '../perm.js';
import { emitTo } from '../realtime.js';
import {
  denyTask, recordHistory, requireTaskPermission, taskHistory, taskLock, taskPermissions, taskRole, type HistoryField,
} from '../taskrules.js';
import { removeStored } from '../uploads.js';
import { forEachA, mapA, someA } from "../async.js";

export const tasksApi = Router();

interface TaskRow {
  id: string;
  project_id: string;
  title: string;
  description: string;
  status: 'todo' | 'doing' | 'review' | 'done';
  priority: 'urgent' | 'high' | 'medium' | 'low';
  assignee_id: string | null;
  due_date: string | null;
  tags: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  archived_at: string | null;
}

const STATUS = ['todo', 'doing', 'review', 'done'] as const;
const PRIORITY = ['urgent', 'high', 'medium', 'low'] as const;
const STATUS_FR: Record<string, string> = { todo: 'À faire', doing: 'En cours', review: 'En révision', done: 'Terminé' };

const userRef = async (id: string | null) =>
  id ? ((await db.prepare('SELECT id, name FROM users WHERE id = ?').get(id) as { id: string; name: string } | undefined) ?? null) : null;
const userName = async (id: string | null) => (await userRef(id))?.name ?? null;

const depsOf = async (taskId: string) =>
  await db.prepare('SELECT t.id, t.title, t.status FROM task_dependencies d JOIN tasks t ON t.id = d.depends_on WHERE d.task_id = ? ORDER BY d.created_at').all(taskId) as { id: string; title: string; status: string }[];
const unfinishedDeps = async (taskId: string) => (await depsOf(taskId)).filter((d) => d.status !== 'done');

async function shapeTask(user: AuthUser, t: TaskRow, detail = false) {
  const project = await db.prepare('SELECT id, name, color, status FROM projects WHERE id = ?').get(t.project_id) as { id: string; name: string; color: string; status: string };
  const sub = await db.prepare('SELECT COUNT(*) AS total, SUM(done) AS done FROM subtasks WHERE task_id = ?').get(t.id) as { total: number; done: number | null };
  const projectOpen = project.status !== 'archived';
  const perms = await taskPermissions(user, t);
  const base = {
    id: t.id,
    projectId: t.project_id,
    project,
    title: t.title,
    description: t.description,
    status: t.status,
    priority: t.priority,
    assignee: (await userRef(t.assignee_id)),
    createdBy: (await userRef(t.created_by)),
    dueDate: t.due_date,
    tags: JSON.parse(t.tags) as string[],
    createdAt: t.created_at,
    completedAt: t.completed_at,
    archivedAt: t.archived_at,
    subtasksTotal: sub.total,
    subtasksDone: sub.done ?? 0,
    commentCount: (await db.prepare('SELECT COUNT(*) AS n FROM task_comments WHERE task_id = ?').get(t.id) as { n: number }).n,
    attachmentCount: (await db.prepare('SELECT COUNT(*) AS n FROM files WHERE task_id = ?').get(t.id) as { n: number }).n,
    // Rôle de l'utilisateur sur CETTE tâche et ce qu'il peut y faire (l'interface s'en sert ; l'API revérifie toujours).
    blockedBy: (await unfinishedDeps(t.id)).length,
    myRole: (await taskRole(user, t)),
    lock: taskLock(t),
    permissions: projectOpen ? perms : { edit: false, status: false, reassign: false, delete: false, subtask: false, archive: false, unarchive: false },
  };
  if (!detail) return base;
  return {
    ...base,
    dependsOn: (await depsOf(t.id)).map((d) => ({ id: d.id, title: d.title, status: d.status })),
    dependents: (await db.prepare('SELECT t.id, t.title, t.status FROM task_dependencies d JOIN tasks t ON t.id = d.task_id WHERE d.depends_on = ?').all(t.id) as { id: string; title: string; status: string }[]),
    subtasks: (await db.prepare('SELECT id, title, done FROM subtasks WHERE task_id = ? ORDER BY position, rowid').all(t.id) as { id: string; title: string; done: number }[]).map((s) => ({ id: s.id, title: s.title, done: s.done === 1 })),
    comments: (await mapA((
          await db
                    .prepare('SELECT c.id, c.body, c.created_at, u.id AS uid, u.name FROM task_comments c JOIN users u ON u.id = c.user_id WHERE c.task_id = ? ORDER BY c.created_at')
                    .all(t.id) as { id: string; body: string; created_at: string; uid: string; name: string }[]
        ), async (c) => ({ id: c.id, body: c.body, createdAt: c.created_at, user: { id: c.uid, name: c.name }, canDelete: (await taskRole(user, t)) === 'admin' || c.uid === user.id }))),
    attachments: (await mapA((
          await db
                    .prepare('SELECT f.id, f.name, f.size, f.mime, f.created_at, f.user_id, u.name AS uname FROM files f JOIN users u ON u.id = f.user_id WHERE f.task_id = ? ORDER BY f.created_at')
                    .all(t.id) as { id: string; name: string; size: number; mime: string; created_at: string; user_id: string; uname: string }[]
        ), async (f) => ({ id: f.id, name: f.name, size: f.size, mime: f.mime, createdAt: f.created_at, uploadedBy: f.uname, canDelete: (await taskRole(user, t)) === 'admin' || f.user_id === user.id }))),
    history: (await taskHistory(t.id)),
  };
}

async function loadTask(id: string): Promise<TaskRow> {
  const t = await db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as unknown as TaskRow | undefined;
  if (!t) throw new HttpError(404, 'Tâche introuvable.');
  return t;
}

/** Charge la tâche en vérifiant que l'utilisateur voit son projet (404 sinon : on ne révèle pas son existence). */
async function taskForRead(req: Parameters<typeof me>[0], id: string): Promise<TaskRow> {
  const t = await loadTask(id);
  if (!(await canSeeProject(me(req), t.project_id))) throw new HttpError(404, 'Tâche introuvable.');
  return t;
}

const emitTask = async (t: Pick<TaskRow, 'id' | 'project_id'>) => emitTo((await projectAudience(t.project_id)), { type: 'task', taskId: t.id, projectId: t.project_id });

async function assertAssignee(projectId: string, assigneeId: string | null | undefined) {
  if (!assigneeId) return;
  const u = await db.prepare('SELECT id, role FROM users WHERE id = ?').get(assigneeId) as { id: string; role: Role } | undefined;
  if (!u) throw new HttpError(400, 'Personne assignée introuvable.');
  if (!(await projectAudience(projectId)).includes(assigneeId)) throw new HttpError(400, "Cette personne n'a pas accès à ce projet : ajoutez-la d'abord aux membres.");
}

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date d'échéance invalide.");
const tagsSchema = z.array(z.string().trim().min(1).max(30)).max(10);
const link = (t: Pick<TaskRow, 'id' | 'project_id'>) => `#projets/${t.project_id}/taches/${t.id}`;

tasksApi.get('/tasks', async (req, res) => {
  const ids = await visibleProjectIds(me(req));
  if (!ids.length) return void res.json({ tasks: [] });
  const where = [`t.project_id IN (${ids.map(() => '?').join(',')})`];
  const args: (string | number)[] = [...ids];
  const { projectId, assignee, status, q, due, archived } = req.query as Record<string, string | undefined>;
  where.push(archived === '1' ? 't.archived_at IS NOT NULL' : 't.archived_at IS NULL'); // les tâches archivées ne polluent pas les vues
  if (projectId) { where.push('t.project_id = ?'); args.push(projectId); }
  if (assignee) { where.push('t.assignee_id = ?'); args.push(assignee === 'me' ? me(req).id : assignee); }
  if (status && (STATUS as readonly string[]).includes(status)) { where.push('t.status = ?'); args.push(status); }
  if (q) { where.push('(t.title LIKE ? OR t.description LIKE ? OR t.tags LIKE ?)'); const like = `%${q}%`; args.push(like, like, like); }
  if (due === 'today') { where.push("t.due_date <= ? AND t.status <> 'done'"); args.push(today()); }
  const rows = await db
      .prepare(`SELECT t.* FROM tasks t JOIN projects p ON p.id = t.project_id WHERE ${where.join(' AND ')} ORDER BY t.created_at DESC LIMIT 1000`)
      .all(...args) as unknown as TaskRow[];
  res.json({ tasks: (await mapA(rows, async (t) => await shapeTask(me(req), t))) });
});

const createSchema = z.object({
  projectId: z.string(),
  title: z.string().trim().min(1, 'Le titre est obligatoire.').max(200),
  description: z.string().trim().max(5000).optional().default(''),
  assigneeId: z.string().nullable().optional(),
  dueDate: dateSchema.nullable().optional(),
  priority: z.enum(PRIORITY).optional().default('medium'),
  status: z.enum(STATUS).optional().default('todo'),
  tags: tagsSchema.optional().default([]),
  subtasks: z.array(z.string().trim().min(1).max(200)).max(50).optional().default([]),
});

// Matrice §4.2 : un invité ne crée pas de tâche. Le créateur devient propriétaire.
tasksApi.post('/tasks', requireStaff, async (req, res) => {
  const input = parse(createSchema, req.body);
  const project = await projectForWrite(me(req), input.projectId);
  await assertAssignee(input.projectId, input.assigneeId);
  const id = uid();
  const t = now();
  await tx(async () => {
        await db.prepare(
                'INSERT INTO tasks (id,project_id,title,description,status,priority,assignee_id,due_date,tags,created_by,created_at,updated_at,completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
              ).run(id, input.projectId, input.title, input.description, input.status, input.priority, input.assigneeId ?? null, input.dueDate ?? null, JSON.stringify(input.tags), me(req).id, t, t, input.status === 'done' ? t : null);
        await forEachA(input.subtasks, async (s, i) => await db.prepare('INSERT INTO subtasks (id,task_id,title,position) VALUES (?,?,?,?)').run(uid(), id, s, i));
      });
  await logActivity(me(req), 'create', 'task', id, `Tâche « ${input.title} » créée`, input.projectId);
  if (input.assigneeId && input.assigneeId !== me(req).id) {
    await notify({ userId: input.assigneeId, type: 'assigned', title: `${me(req).name} vous a assigné une tâche`, body: `${input.title} — ${project.name}`, link: `#projets/${input.projectId}/taches/${id}` });
  }
  const task = await loadTask(id);
  await emitTask(task);
  res.status(201).json({ task: (await shapeTask(me(req), task, true)) });
});

tasksApi.get('/tasks/:id', async (req, res) => {
  res.json({ task: (await shapeTask(me(req), (await taskForRead(req, idParam(req))), true)) });
});

const patchSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(5000).optional(),
  assigneeId: z.string().nullable().optional(),
  dueDate: dateSchema.nullable().optional(),
  priority: z.enum(PRIORITY).optional(),
  status: z.enum(STATUS).optional(),
  tags: tagsSchema.optional(),
});

/**
 * §9.6 : authentification → chargement → rôle sur la tâche → filtrage des champs selon les droits
 * → 403 si interdit → mise à jour + historique → diffusion temps réel.
 */
tasksApi.patch('/tasks/:id', async (req, res) => {
  const user = me(req);
  const cur = await taskForRead(req, idParam(req));
  const project = await projectForWrite(user, cur.project_id);
  const input = parse(patchSchema, req.body);
  const sent = (Object.keys(input) as (keyof typeof input)[]).filter((k) => input[k] !== undefined);
  if (!sent.length) throw new HttpError(400, 'Aucune modification à enregistrer.');

  // Droits par catégorie de champ.
  if (sent.includes('assigneeId')) await requireTaskPermission(user, cur, 'reassign', 'réassigner la tâche');
  if (sent.some((k) => k !== 'status' && k !== 'assigneeId')) await requireTaskPermission(user, cur, 'edit', `modifier ${sent.filter((k) => k !== 'status' && k !== 'assigneeId').join(', ')}`);
  if (sent.includes('status')) await requireTaskPermission(user, cur, 'status', 'changer le statut');
  if (input.assigneeId !== undefined) await assertAssignee(cur.project_id, input.assigneeId);
  if (input.status === 'done' && cur.status !== 'done') {
    const open = await unfinishedDeps(cur.id);
    if (open.length) throw new HttpError(409, `Cette tâche dépend de tâches non terminées : ${open.slice(0, 3).map((d) => `« ${d.title} »`).join(', ')}. Terminez-les d'abord.`);
  }

  const next = {
    title: input.title ?? cur.title,
    description: input.description ?? cur.description,
    assignee_id: input.assigneeId === undefined ? cur.assignee_id : input.assigneeId,
    due_date: input.dueDate === undefined ? cur.due_date : input.dueDate,
    priority: input.priority ?? cur.priority,
    status: input.status ?? cur.status,
    tags: input.tags ? JSON.stringify(input.tags) : cur.tags,
  };
  const changes: [HistoryField, string | null, string | null][] = [];
  if (next.title !== cur.title) changes.push(['title', cur.title, next.title]);
  if (next.description !== cur.description) changes.push(['description', cur.description, next.description]);
  if (next.status !== cur.status) changes.push(['status', cur.status, next.status]);
  if (next.priority !== cur.priority) changes.push(['priority', cur.priority, next.priority]);
  if (next.due_date !== cur.due_date) changes.push(['dueDate', cur.due_date, next.due_date]);
  if (next.assignee_id !== cur.assignee_id) changes.push(['assignedTo', (await userName(cur.assignee_id)), (await userName(next.assignee_id))]);
  if (next.tags !== cur.tags) changes.push(['tags', (JSON.parse(cur.tags) as string[]).join(', ') || null, (JSON.parse(next.tags) as string[]).join(', ') || null]);
  if (!changes.length) return void res.json({ task: (await shapeTask(user, cur, true)) });

  const completedAt = next.status === 'done' ? (cur.status === 'done' ? cur.completed_at : now()) : null;
  await tx(async () => {
        await db.prepare('UPDATE tasks SET title=?, description=?, assignee_id=?, due_date=?, priority=?, status=?, tags=?, completed_at=?, updated_at=? WHERE id=?').run(
                next.title, next.description, next.assignee_id, next.due_date, next.priority, next.status, next.tags, completedAt, now(), cur.id,
              );
        for (const [field, from, to] of changes) await recordHistory(user, cur.id, field, from, to);
      });
  if (next.status !== cur.status) {
    await logActivity(user, 'status', 'task', cur.id, `Tâche « ${next.title} » : ${STATUS_FR[cur.status]} → ${STATUS_FR[next.status]}`, cur.project_id);
    // Changement de statut → notification au créateur.
    if (cur.created_by && cur.created_by !== user.id) {
      await notify({ userId: cur.created_by, type: 'task', title: `${user.name} a passé « ${next.title} » à « ${STATUS_FR[next.status]} »`, body: project.name, link: link(cur) });
    }
  } else {
    await logActivity(user, 'update', 'task', cur.id, `Tâche « ${next.title} » modifiée`, cur.project_id);
  }
  if (next.assignee_id !== cur.assignee_id) {
    // Un changement d'assigné notifie l'ancien et le nouveau.
    if (next.assignee_id && next.assignee_id !== user.id) {
      await notify({ userId: next.assignee_id, type: 'assigned', title: `${user.name} vous a assigné une tâche`, body: `${next.title} — ${project.name}`, link: link(cur) });
    }
    if (cur.assignee_id && cur.assignee_id !== user.id) {
      await notify({ userId: cur.assignee_id, type: 'task', title: `Vous n'êtes plus assigné(e) à « ${next.title} »`, body: `${user.name} a réassigné la tâche — ${project.name}`, link: link(cur) });
    }
  }
  const task = await loadTask(cur.id);
  await emitTask(task);
  res.json({ task: (await shapeTask(user, task, true)) });
});

tasksApi.delete('/tasks/:id', async (req, res) => {
  const user = me(req);
  const cur = await taskForRead(req, idParam(req));
  await projectForWrite(user, cur.project_id);
  await requireTaskPermission(user, cur, 'delete', 'supprimer la tâche');
  const stored = (await db.prepare('SELECT stored_name FROM files WHERE task_id = ?').all(cur.id) as { stored_name: string }[]).map((f) => f.stored_name);
  await tx(async () => {
        await db.prepare('DELETE FROM files WHERE task_id = ?').run(cur.id);
        await db.prepare('DELETE FROM tasks WHERE id = ?').run(cur.id);
      });
  removeStored(stored);
  await logActivity(user, 'delete', 'task', cur.id, `Tâche « ${cur.title} » supprimée`, cur.project_id);
  await emitTask(cur);
  res.json({ ok: true });
});

/* ------------------------ Archivage, désarchivage, transfert ------------------------ */

// Une tâche terminée peut être archivée par son créateur ou un admin : lecture seule définitive (sauf admin).
tasksApi.post('/tasks/:id/archive', async (req, res) => {
  const user = me(req);
  const cur = await taskForRead(req, idParam(req));
  await projectForWrite(user, cur.project_id);
  if (cur.status !== 'done' && (await taskRole(user, cur)) !== 'observer') throw new HttpError(409, 'Seule une tâche terminée peut être archivée.');
  await requireTaskPermission(user, cur, 'archive', 'archiver la tâche');
  await tx(async () => {
        await db.prepare('UPDATE tasks SET archived_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), cur.id);
        await recordHistory(user, cur.id, 'archived', null, 'oui');
      });
  await logActivity(user, 'archive', 'task', cur.id, `Tâche « ${cur.title} » archivée`, cur.project_id);
  await emitTask(cur);
  res.json({ task: (await shapeTask(user, (await loadTask(cur.id)), true)) });
});

tasksApi.post('/tasks/:id/unarchive', async (req, res) => {
  const user = me(req);
  const cur = await taskForRead(req, idParam(req));
  await projectForWrite(user, cur.project_id);
  await requireTaskPermission(user, cur, 'unarchive', 'désarchiver la tâche');
  await tx(async () => {
        await db.prepare('UPDATE tasks SET archived_at = NULL, updated_at = ? WHERE id = ?').run(now(), cur.id);
        await recordHistory(user, cur.id, 'archived', 'oui', null);
      });
  await logActivity(user, 'unarchive', 'task', cur.id, `Tâche « ${cur.title} » désarchivée`, cur.project_id);
  await emitTask(cur);
  res.json({ task: (await shapeTask(user, (await loadTask(cur.id)), true)) });
});

// Transfert de propriété : action réservée au PDG et au chef du projet (créateur parti, tâche orpheline…).
tasksApi.post('/tasks/:id/transfer', async (req, res) => {
  const user = me(req);
  const cur = await taskForRead(req, idParam(req));
  if ((await taskRole(user, cur)) !== 'admin') throw await denyTask(user, cur, 'reassign', 'transférer la propriété');
  const { userId } = parse(z.object({ userId: z.string() }), req.body);
  const target = await db.prepare('SELECT id, name, role FROM users WHERE id = ?').get(userId) as { id: string; name: string; role: Role } | undefined;
  if (!target) throw new HttpError(404, 'Membre introuvable.');
  if (target.role === 'guest') throw new HttpError(400, 'Une tâche ne peut être transférée qu\'à un Fondateur.');
  await tx(async () => {
        await db.prepare('UPDATE tasks SET created_by = ?, updated_at = ? WHERE id = ?').run(target.id, now(), cur.id);
        await recordHistory(user, cur.id, 'createdBy', (await userName(cur.created_by)) ?? 'Administration', target.name);
      });
  await logActivity(user, 'transfer', 'task', cur.id, `Tâche « ${cur.title} » transférée à ${target.name}`, cur.project_id);
  if (target.id !== user.id) await notify({ userId: target.id, type: 'task', title: `${user.name} vous a transféré « ${cur.title} »`, body: 'Vous en êtes désormais le propriétaire.', link: link(cur) });
  await emitTask(cur);
  res.json({ task: (await shapeTask(user, (await loadTask(cur.id)), true)) });
});

/* ------------------------------- Sous-tâches ------------------------------- */

// Créateur, assigné et admin peuvent gérer les sous-tâches ; les observateurs, non.
async function subtaskTask(req: Parameters<typeof me>[0], attempt: string) {
  const s = await db.prepare('SELECT task_id FROM subtasks WHERE id = ?').get(idParam(req, 'sid')) as { task_id: string } | undefined;
  if (!s) throw new HttpError(404, 'Sous-tâche introuvable.');
  const t = await taskForRead(req, s.task_id);
  await projectForWrite(me(req), t.project_id);
  await requireTaskPermission(me(req), t, 'subtask', attempt);
  return t;
}

/* ------------------------- Dépendances entre tâches (§9.3) ------------------------- */

async function reaches(from: string, target: string, seen = new Set<string>()): Promise<boolean> {
  if (from === target) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  return await someA((await db.prepare('SELECT depends_on FROM task_dependencies WHERE task_id = ?').all(from) as { depends_on: string }[]), async (r) => await reaches(r.depends_on, target, seen));
}

tasksApi.post('/tasks/:id/dependencies', async (req, res) => {
  const user = me(req);
  const cur = await taskForRead(req, idParam(req));
  await projectForWrite(user, cur.project_id);
  await requireTaskPermission(user, cur, 'edit', 'ajouter une dépendance');
  const { dependsOn } = parse(z.object({ dependsOn: z.string() }), req.body);
  const dep = await db.prepare('SELECT id, title, project_id FROM tasks WHERE id = ?').get(dependsOn) as { id: string; title: string; project_id: string } | undefined;
  if (!dep || dep.project_id !== cur.project_id) throw new HttpError(404, 'Tâche prérequise introuvable dans ce projet.');
  if (dep.id === cur.id) throw new HttpError(400, 'Une tâche ne peut pas dépendre d\'elle-même.');
  if ((await reaches(dep.id, cur.id))) throw new HttpError(409, 'Dépendance circulaire refusée : la tâche choisie dépend déjà (directement ou non) de celle-ci.');
  await db.prepare('INSERT OR IGNORE INTO task_dependencies (id,task_id,depends_on,created_by,created_at) VALUES (?,?,?,?,?)').run(uid(), cur.id, dep.id, user.id, now());
  await audit(user, 'business', 'task_dependency', 'task', cur.id, `« ${cur.title} » dépend désormais de « ${dep.title} »`);
  await emitTask(cur);
  res.status(201).json({ task: (await shapeTask(user, (await loadTask(cur.id)), true)) });
});

tasksApi.delete('/tasks/:id/dependencies/:depId', async (req, res) => {
  const user = me(req);
  const cur = await taskForRead(req, idParam(req));
  await projectForWrite(user, cur.project_id);
  await requireTaskPermission(user, cur, 'edit', 'retirer une dépendance');
  await db.prepare('DELETE FROM task_dependencies WHERE task_id = ? AND depends_on = ?').run(cur.id, idParam(req, 'depId'));
  await emitTask(cur);
  res.json({ task: (await shapeTask(user, (await loadTask(cur.id)), true)) });
});

tasksApi.post('/tasks/:id/subtasks', async (req, res) => {
  const cur = await taskForRead(req, idParam(req));
  await projectForWrite(me(req), cur.project_id);
  await requireTaskPermission(me(req), cur, 'subtask', 'ajouter une sous-tâche');
  const { title } = parse(z.object({ title: z.string().trim().min(1, 'Titre requis.').max(200) }), req.body);
  const pos = (await db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM subtasks WHERE task_id = ?').get(cur.id) as { p: number }).p;
  await db.prepare('INSERT INTO subtasks (id,task_id,title,position) VALUES (?,?,?,?)').run(uid(), cur.id, title, pos);
  await emitTask(cur);
  res.status(201).json({ task: (await shapeTask(me(req), (await loadTask(cur.id)), true)) });
});

tasksApi.patch('/subtasks/:sid', async (req, res) => {
  const t = await subtaskTask(req, 'modifier une sous-tâche');
  const input = parse(z.object({ done: z.boolean().optional(), title: z.string().trim().min(1).max(200).optional() }), req.body);
  const cur = await db.prepare('SELECT title, done FROM subtasks WHERE id = ?').get(idParam(req, 'sid')) as { title: string; done: number };
  await db.prepare('UPDATE subtasks SET title = ?, done = ? WHERE id = ?').run(input.title ?? cur.title, input.done === undefined ? cur.done : input.done ? 1 : 0, idParam(req, 'sid'));
  await emitTask(t);
  res.json({ task: (await shapeTask(me(req), (await loadTask(t.id)), true)) });
});

tasksApi.delete('/subtasks/:sid', async (req, res) => {
  const t = await subtaskTask(req, 'supprimer une sous-tâche');
  await db.prepare('DELETE FROM subtasks WHERE id = ?').run(idParam(req, 'sid'));
  await emitTask(t);
  res.json({ task: (await shapeTask(me(req), (await loadTask(t.id)), true)) });
});

/* -------------------------- Commentaires et mentions -------------------------- */

// Tout le monde peut commenter (invités inclus), quel que soit son rôle sur la tâche.
tasksApi.post('/tasks/:id/comments', async (req, res) => {
  const user = me(req);
  const cur = await taskForRead(req, idParam(req));
  await projectForWrite(user, cur.project_id);
  const { body } = parse(z.object({ body: z.string().trim().min(1, 'Commentaire vide.').max(3000) }), req.body);
  await db.prepare('INSERT INTO task_comments (id,task_id,user_id,body,created_at) VALUES (?,?,?,?,?)').run(uid(), cur.id, user.id, body, now());
  await logActivity(user, 'comment', 'task', cur.id, `Commentaire sur « ${cur.title} »`, cur.project_id);
  const mentioned = new Set((await findMentions(body, (await projectAudience(cur.project_id)))).filter((u) => u !== user.id));
  for (const u of mentioned) {
    await notify({ userId: u, type: 'mention', title: `${user.name} vous a mentionné`, body: `« ${cur.title} » : ${body.slice(0, 140)}`, link: link(cur) });
  }
  // Commentaire sur une tâche dont je suis créateur ou assigné → notification (sans doublon avec une mention).
  for (const u of new Set([cur.created_by, cur.assignee_id].filter((x): x is string => !!x && x !== user.id && !mentioned.has(x)))) {
    await notify({ userId: u, type: 'task', title: `${user.name} a commenté « ${cur.title} »`, body: body.slice(0, 140), link: link(cur) });
  }
  await emitTask(cur);
  res.status(201).json({ task: (await shapeTask(user, (await loadTask(cur.id)), true)) });
});

// Un commentaire n'est jamais modifié ; seul son auteur ou un admin peut le supprimer (pas le créateur de la tâche).
tasksApi.delete('/tasks/:id/comments/:cid', async (req, res) => {
  const user = me(req);
  const cur = await taskForRead(req, idParam(req));
  await projectForWrite(user, cur.project_id);
  const c = await db.prepare('SELECT id, user_id FROM task_comments WHERE id = ? AND task_id = ?').get(idParam(req, 'cid'), cur.id) as { id: string; user_id: string } | undefined;
  if (!c) throw new HttpError(404, 'Commentaire introuvable.');
  if ((await taskRole(user, cur)) !== 'admin' && c.user_id !== user.id) throw await denyTask(user, cur, 'comment', 'supprimer le commentaire de quelqu\'un d\'autre');
  await db.prepare('DELETE FROM task_comments WHERE id = ?').run(c.id);
  await logActivity(user, 'delete', 'comment', c.id, `Commentaire supprimé sur « ${cur.title} »`, cur.project_id);
  await emitTask(cur);
  res.json({ task: (await shapeTask(user, (await loadTask(cur.id)), true)) });
});

export { projectForRead };
