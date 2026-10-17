import { Router } from 'express';
import { z } from 'zod';
import { requireStaff } from '../auth.js';
import { logActivity } from '../activity.js';
import { db, now, today, tx, uid, type Role } from '../db.js';
import { HttpError, idParam, me, parse } from '../http.js';
import { findMentions } from '../mentions.js';
import { notify } from '../notify.js';
import { canSeeProject, projectAudience, projectForRead, projectForWrite, visibleProjectIds } from '../perm.js';
import { emitTo } from '../realtime.js';
import { removeStored } from '../uploads.js';

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
}

const STATUS = ['todo', 'doing', 'review', 'done'] as const;
const PRIORITY = ['urgent', 'high', 'medium', 'low'] as const;

const userRef = (id: string | null) =>
  id ? ((db.prepare('SELECT id, name FROM users WHERE id = ?').get(id) as { id: string; name: string } | undefined) ?? null) : null;

function shapeTask(t: TaskRow, detail = false) {
  const project = db.prepare('SELECT id, name, color, status FROM projects WHERE id = ?').get(t.project_id) as { id: string; name: string; color: string; status: string };
  const sub = db.prepare('SELECT COUNT(*) AS total, SUM(done) AS done FROM subtasks WHERE task_id = ?').get(t.id) as { total: number; done: number | null };
  const base = {
    id: t.id,
    projectId: t.project_id,
    project,
    title: t.title,
    description: t.description,
    status: t.status,
    priority: t.priority,
    assignee: userRef(t.assignee_id),
    createdBy: userRef(t.created_by),
    dueDate: t.due_date,
    tags: JSON.parse(t.tags) as string[],
    createdAt: t.created_at,
    completedAt: t.completed_at,
    subtasksTotal: sub.total,
    subtasksDone: sub.done ?? 0,
    commentCount: (db.prepare('SELECT COUNT(*) AS n FROM task_comments WHERE task_id = ?').get(t.id) as { n: number }).n,
    attachmentCount: (db.prepare('SELECT COUNT(*) AS n FROM files WHERE task_id = ?').get(t.id) as { n: number }).n,
  };
  if (!detail) return base;
  return {
    ...base,
    subtasks: (db.prepare('SELECT id, title, done FROM subtasks WHERE task_id = ? ORDER BY position, rowid').all(t.id) as { id: string; title: string; done: number }[]).map((s) => ({ id: s.id, title: s.title, done: s.done === 1 })),
    comments: (
      db
        .prepare('SELECT c.id, c.body, c.created_at, u.id AS uid, u.name FROM task_comments c JOIN users u ON u.id = c.user_id WHERE c.task_id = ? ORDER BY c.created_at')
        .all(t.id) as { id: string; body: string; created_at: string; uid: string; name: string }[]
    ).map((c) => ({ id: c.id, body: c.body, createdAt: c.created_at, user: { id: c.uid, name: c.name } })),
    attachments: (
      db
        .prepare('SELECT f.id, f.name, f.size, f.mime, f.created_at, u.name AS uname FROM files f JOIN users u ON u.id = f.user_id WHERE f.task_id = ? ORDER BY f.created_at')
        .all(t.id) as { id: string; name: string; size: number; mime: string; created_at: string; uname: string }[]
    ).map((f) => ({ id: f.id, name: f.name, size: f.size, mime: f.mime, createdAt: f.created_at, uploadedBy: f.uname })),
  };
}

function loadTask(id: string): TaskRow {
  const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as unknown as TaskRow | undefined;
  if (!t) throw new HttpError(404, 'Tâche introuvable.');
  return t;
}

/** Charge la tâche en vérifiant que l'utilisateur voit son projet. */
function taskForRead(req: Parameters<typeof me>[0], id: string): TaskRow {
  const t = loadTask(id);
  if (!canSeeProject(me(req), t.project_id)) throw new HttpError(404, 'Tâche introuvable.');
  return t;
}

const emitTask = (t: TaskRow) => emitTo(projectAudience(t.project_id), { type: 'task', taskId: t.id, projectId: t.project_id });

function assertAssignee(projectId: string, assigneeId: string | null | undefined) {
  if (!assigneeId) return;
  const u = db.prepare('SELECT id, role FROM users WHERE id = ?').get(assigneeId) as { id: string; role: Role } | undefined;
  if (!u) throw new HttpError(400, 'Personne assignée introuvable.');
  if (!projectAudience(projectId).includes(assigneeId)) throw new HttpError(400, "Cette personne n'a pas accès à ce projet : ajoutez-la d'abord aux membres.");
}

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date d'échéance invalide.");
const tagsSchema = z.array(z.string().trim().min(1).max(30)).max(10);

tasksApi.get('/tasks', (req, res) => {
  const ids = visibleProjectIds(me(req));
  if (!ids.length) return void res.json({ tasks: [] });
  const where = [`t.project_id IN (${ids.map(() => '?').join(',')})`];
  const args: (string | number)[] = [...ids];
  const { projectId, assignee, status, q, due } = req.query as Record<string, string | undefined>;
  if (projectId) { where.push('t.project_id = ?'); args.push(projectId); }
  if (assignee) { where.push('t.assignee_id = ?'); args.push(assignee === 'me' ? me(req).id : assignee); }
  if (status && (STATUS as readonly string[]).includes(status)) { where.push('t.status = ?'); args.push(status); }
  if (q) { where.push('(t.title LIKE ? OR t.description LIKE ? OR t.tags LIKE ?)'); const like = `%${q}%`; args.push(like, like, like); }
  if (due === 'today') { where.push("t.due_date <= ? AND t.status <> 'done'"); args.push(today()); }
  const rows = db
    .prepare(`SELECT t.* FROM tasks t JOIN projects p ON p.id = t.project_id WHERE ${where.join(' AND ')} ORDER BY t.created_at DESC LIMIT 1000`)
    .all(...args) as unknown as TaskRow[];
  res.json({ tasks: rows.map((t) => shapeTask(t)) });
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

tasksApi.post('/tasks', (req, res) => {
  const input = parse(createSchema, req.body);
  const project = projectForWrite(me(req), input.projectId);
  assertAssignee(input.projectId, input.assigneeId);
  const id = uid();
  const t = now();
  tx(() => {
    db.prepare(
      'INSERT INTO tasks (id,project_id,title,description,status,priority,assignee_id,due_date,tags,created_by,created_at,updated_at,completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    ).run(id, input.projectId, input.title, input.description, input.status, input.priority, input.assigneeId ?? null, input.dueDate ?? null, JSON.stringify(input.tags), me(req).id, t, t, input.status === 'done' ? t : null);
    input.subtasks.forEach((s, i) => db.prepare('INSERT INTO subtasks (id,task_id,title,position) VALUES (?,?,?,?)').run(uid(), id, s, i));
  });
  logActivity(me(req), 'create', 'task', id, `Tâche « ${input.title} » créée`, input.projectId);
  if (input.assigneeId && input.assigneeId !== me(req).id) {
    notify({ userId: input.assigneeId, type: 'assigned', title: `${me(req).name} vous a assigné une tâche`, body: `${input.title} — ${project.name}`, link: `#projets/${input.projectId}/taches/${id}` });
  }
  const task = loadTask(id);
  emitTask(task);
  res.status(201).json({ task: shapeTask(task, true) });
});

tasksApi.get('/tasks/:id', (req, res) => {
  res.json({ task: shapeTask(taskForRead(req, idParam(req)), true) });
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

tasksApi.patch('/tasks/:id', (req, res) => {
  const cur = taskForRead(req, idParam(req));
  const project = projectForWrite(me(req), cur.project_id);
  const input = parse(patchSchema, req.body);
  if (input.assigneeId !== undefined) assertAssignee(cur.project_id, input.assigneeId);
  const next = {
    title: input.title ?? cur.title,
    description: input.description ?? cur.description,
    assignee_id: input.assigneeId === undefined ? cur.assignee_id : input.assigneeId,
    due_date: input.dueDate === undefined ? cur.due_date : input.dueDate,
    priority: input.priority ?? cur.priority,
    status: input.status ?? cur.status,
    tags: input.tags ? JSON.stringify(input.tags) : cur.tags,
  };
  const completedAt = next.status === 'done' ? (cur.status === 'done' ? cur.completed_at : now()) : null;
  db.prepare('UPDATE tasks SET title=?, description=?, assignee_id=?, due_date=?, priority=?, status=?, tags=?, completed_at=?, updated_at=? WHERE id=?').run(
    next.title, next.description, next.assignee_id, next.due_date, next.priority, next.status, next.tags, completedAt, now(), cur.id,
  );
  if (next.status !== cur.status) {
    logActivity(me(req), 'status', 'task', cur.id, `Tâche « ${next.title} » : ${cur.status} → ${next.status}`, cur.project_id);
  } else {
    logActivity(me(req), 'update', 'task', cur.id, `Tâche « ${next.title} » modifiée`, cur.project_id);
  }
  if (next.assignee_id && next.assignee_id !== cur.assignee_id && next.assignee_id !== me(req).id) {
    notify({ userId: next.assignee_id, type: 'assigned', title: `${me(req).name} vous a assigné une tâche`, body: `${next.title} — ${project.name}`, link: `#projets/${cur.project_id}/taches/${cur.id}` });
  }
  const task = loadTask(cur.id);
  emitTask(task);
  res.json({ task: shapeTask(task, true) });
});

tasksApi.delete('/tasks/:id', requireStaff, (req, res) => {
  const cur = taskForRead(req, idParam(req));
  projectForWrite(me(req), cur.project_id);
  const stored = (db.prepare('SELECT stored_name FROM files WHERE task_id = ?').all(cur.id) as { stored_name: string }[]).map((f) => f.stored_name);
  tx(() => {
    db.prepare('DELETE FROM files WHERE task_id = ?').run(cur.id);
    db.prepare('DELETE FROM tasks WHERE id = ?').run(cur.id);
  });
  removeStored(stored);
  logActivity(me(req), 'delete', 'task', cur.id, `Tâche « ${cur.title} » supprimée`, cur.project_id);
  emitTask(cur);
  res.json({ ok: true });
});

/* ------------------------------- Sous-tâches ------------------------------- */

tasksApi.post('/tasks/:id/subtasks', (req, res) => {
  const cur = taskForRead(req, idParam(req));
  projectForWrite(me(req), cur.project_id);
  const { title } = parse(z.object({ title: z.string().trim().min(1, 'Titre requis.').max(200) }), req.body);
  const pos = (db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM subtasks WHERE task_id = ?').get(cur.id) as { p: number }).p;
  db.prepare('INSERT INTO subtasks (id,task_id,title,position) VALUES (?,?,?,?)').run(uid(), cur.id, title, pos);
  emitTask(cur);
  res.status(201).json({ task: shapeTask(loadTask(cur.id), true) });
});

function subtaskTask(req: Parameters<typeof me>[0]) {
  const s = db.prepare('SELECT task_id FROM subtasks WHERE id = ?').get(idParam(req, 'sid')) as { task_id: string } | undefined;
  if (!s) throw new HttpError(404, 'Sous-tâche introuvable.');
  const t = taskForRead(req, s.task_id);
  projectForWrite(me(req), t.project_id);
  return t;
}

tasksApi.patch('/subtasks/:sid', (req, res) => {
  const t = subtaskTask(req);
  const input = parse(z.object({ done: z.boolean().optional(), title: z.string().trim().min(1).max(200).optional() }), req.body);
  const cur = db.prepare('SELECT title, done FROM subtasks WHERE id = ?').get(idParam(req, 'sid')) as { title: string; done: number };
  db.prepare('UPDATE subtasks SET title = ?, done = ? WHERE id = ?').run(input.title ?? cur.title, input.done === undefined ? cur.done : input.done ? 1 : 0, idParam(req, 'sid'));
  emitTask(t);
  res.json({ task: shapeTask(loadTask(t.id), true) });
});

tasksApi.delete('/subtasks/:sid', (req, res) => {
  const t = subtaskTask(req);
  db.prepare('DELETE FROM subtasks WHERE id = ?').run(idParam(req, 'sid'));
  emitTask(t);
  res.json({ task: shapeTask(loadTask(t.id), true) });
});

/* -------------------------- Commentaires et mentions -------------------------- */

tasksApi.post('/tasks/:id/comments', (req, res) => {
  const cur = taskForRead(req, idParam(req));
  projectForWrite(me(req), cur.project_id);
  const { body } = parse(z.object({ body: z.string().trim().min(1, 'Commentaire vide.').max(3000) }), req.body);
  db.prepare('INSERT INTO task_comments (id,task_id,user_id,body,created_at) VALUES (?,?,?,?,?)').run(uid(), cur.id, me(req).id, body, now());
  logActivity(me(req), 'comment', 'task', cur.id, `Commentaire sur « ${cur.title} »`, cur.project_id);
  for (const uidMentioned of findMentions(body, projectAudience(cur.project_id))) {
    if (uidMentioned === me(req).id) continue;
    notify({ userId: uidMentioned, type: 'mention', title: `${me(req).name} vous a mentionné`, body: `« ${cur.title} » : ${body.slice(0, 140)}`, link: `#projets/${cur.project_id}/taches/${cur.id}` });
  }
  emitTask(cur);
  res.status(201).json({ task: shapeTask(loadTask(cur.id), true) });
});

export { projectForRead };
