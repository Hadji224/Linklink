import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin, requireStaff } from '../auth.js';
import { logActivity } from '../activity.js';
import { db, now, tx, uid } from '../db.js';
import { HttpError, idParam, me, parse } from '../http.js';
import { notify } from '../notify.js';
import { projectAudience, projectForRead, projectForWrite, getProject, visibleProjectIds, type ProjectRow } from '../perm.js';
import { emitTo } from '../realtime.js';
import { removeStored } from '../uploads.js';

export const projectsApi = Router();

const STATUSES = ['active', 'paused', 'done', 'archived'] as const;

export function shapeProject(p: ProjectRow) {
  const t = db
    .prepare("SELECT COUNT(*) AS total, SUM(status = 'done') AS done FROM tasks WHERE project_id = ?")
    .get(p.id) as { total: number; done: number | null };
  const members = db
    .prepare('SELECT u.id, u.name, u.role FROM project_members pm JOIN users u ON u.id = pm.user_id WHERE pm.project_id = ? ORDER BY u.name')
    .all(p.id) as { id: string; name: string; role: string }[];
  const folder = db.prepare("SELECT id FROM folders WHERE project_id = ? AND system = 'project'").get(p.id) as { id: string } | undefined;
  const channel = db.prepare("SELECT id FROM channels WHERE project_id = ? AND kind = 'project'").get(p.id) as { id: string } | undefined;
  const done = t.done ?? 0;
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    color: p.color,
    status: p.status,
    createdBy: p.created_by,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    tasksTotal: t.total,
    tasksDone: done,
    progress: t.total ? Math.round((done / t.total) * 100) : 0, // progression automatique
    members,
    folderId: folder?.id ?? null,
    channelId: channel?.id ?? null,
  };
}

const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Couleur invalide.');

const createSchema = z.object({
  name: z.string().trim().min(1, 'Le nom du projet est obligatoire.').max(80),
  description: z.string().trim().max(2000).optional().default(''),
  color: colorSchema.optional().default('#135FEA'),
  memberIds: z.array(z.string()).max(60).optional().default([]),
});

projectsApi.get('/projects', (req, res) => {
  const ids = visibleProjectIds(me(req));
  const q = String(req.query.q ?? '').trim().toLowerCase();
  const status = String(req.query.status ?? '');
  const rows = ids.length
    ? (db.prepare(`SELECT * FROM projects WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY updated_at DESC`).all(...ids) as unknown as ProjectRow[])
    : [];
  res.json({
    projects: rows
      .filter((p) => (!status || p.status === status) && (!q || (p.name + ' ' + p.description).toLowerCase().includes(q)))
      .map(shapeProject),
  });
});

projectsApi.post('/projects', requireStaff, (req, res) => {
  const input = parse(createSchema, req.body);
  const id = uid();
  const t = now();
  tx(() => {
    db.prepare('INSERT INTO projects (id,name,description,color,status,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(
      id, input.name, input.description, input.color, 'active', me(req).id, t, t,
    );
    const members = new Set([me(req).id, ...input.memberIds]); // le créateur devient membre
    for (const m of members) {
      if (db.prepare('SELECT 1 FROM users WHERE id = ?').get(m)) {
        db.prepare('INSERT INTO project_members (project_id,user_id) VALUES (?,?)').run(id, m);
      }
    }
    db.prepare("INSERT INTO folders (id,name,project_id,system,created_by,created_at) VALUES (?,?,?,?,?,?)").run(uid(), input.name, id, 'project', me(req).id, t);
    db.prepare("INSERT INTO channels (id,kind,name,description,project_id,created_at) VALUES (?,?,?,?,?,?)").run(uid(), 'project', input.name, `Discussions du projet ${input.name}`, id, t);
  });
  logActivity(me(req), 'create', 'project', id, `Projet « ${input.name} » créé`, id);
  for (const m of input.memberIds) {
    if (m !== me(req).id) notify({ userId: m, type: 'project', title: `Vous avez été ajouté au projet « ${input.name} »`, link: `#projets/${id}` });
  }
  emitTo(projectAudience(id), { type: 'project', projectId: id });
  res.status(201).json({ project: shapeProject(getProject(id)) });
});

projectsApi.get('/projects/:id', (req, res) => {
  res.json({ project: shapeProject(projectForRead(me(req), idParam(req))) });
});

projectsApi.patch('/projects/:id', requireStaff, (req, res) => {
  const id = idParam(req);
  const cur = projectForRead(me(req), id);
  const input = parse(
    z.object({
      name: z.string().trim().min(1).max(80).optional(),
      description: z.string().trim().max(2000).optional(),
      color: colorSchema.optional(),
      status: z.enum(STATUSES).optional(),
    }),
    req.body,
  );
  if (cur.status === 'archived') {
    // Un projet archivé reste consultable mais non modifiable : seul le désarchivage est permis.
    if (!(input.status && input.status !== 'archived' && Object.keys(input).length === 1)) {
      throw new HttpError(409, 'Ce projet est archivé : désarchivez-le pour le modifier.');
    }
  }
  if (input.status === 'archived' && cur.status !== 'done') {
    throw new HttpError(400, "Seul un projet terminé peut être archivé : passez-le d'abord au statut « Terminé ».");
  }
  const next = { ...cur, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) } as ProjectRow;
  tx(() => {
    db.prepare('UPDATE projects SET name=?, description=?, color=?, status=?, updated_at=? WHERE id=?').run(
      next.name, next.description, next.color, next.status, now(), id,
    );
    if (next.name !== cur.name) {
      db.prepare("UPDATE channels SET name=?, description=? WHERE project_id=? AND kind='project'").run(next.name, `Discussions du projet ${next.name}`, id);
      db.prepare("UPDATE folders SET name=? WHERE project_id=? AND system='project'").run(next.name, id);
    }
  });
  if (input.status && input.status !== cur.status) {
    logActivity(me(req), 'status', 'project', id, `Projet « ${next.name} » : ${cur.status} → ${next.status}`, id);
  } else {
    logActivity(me(req), 'update', 'project', id, `Projet « ${next.name} » modifié`, id);
  }
  emitTo(projectAudience(id), { type: 'project', projectId: id });
  res.json({ project: shapeProject(getProject(id)) });
});

projectsApi.delete('/projects/:id', requireAdmin, (req, res) => {
  const id = idParam(req);
  const p = getProject(id);
  const stored = (
    db
      .prepare(
        `WITH RECURSIVE tree(id) AS (
           SELECT id FROM folders WHERE project_id = ?
           UNION ALL SELECT f.id FROM folders f JOIN tree t ON f.parent_id = t.id)
         SELECT stored_name FROM files WHERE folder_id IN (SELECT id FROM tree)`,
      )
      .all(id) as { stored_name: string }[]
  ).map((r) => r.stored_name);
  const audience = projectAudience(id);
  logActivity(me(req), 'delete', 'project', id, `Projet « ${p.name} » supprimé`);
  db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  removeStored(stored);
  emitTo(audience, { type: 'project', projectId: id });
  res.json({ ok: true });
});

projectsApi.post('/projects/:id/members', requireStaff, (req, res) => {
  const id = idParam(req);
  const p = projectForWrite(me(req), id);
  const { userId } = parse(z.object({ userId: z.string() }), req.body);
  const u = db.prepare('SELECT id, name FROM users WHERE id = ?').get(userId) as { id: string; name: string } | undefined;
  if (!u) throw new HttpError(404, 'Membre introuvable.');
  db.prepare('INSERT OR IGNORE INTO project_members (project_id,user_id) VALUES (?,?)').run(id, userId);
  logActivity(me(req), 'member', 'project', id, `${u.name} ajouté au projet « ${p.name} »`, id);
  if (userId !== me(req).id) notify({ userId, type: 'project', title: `Vous avez été ajouté au projet « ${p.name} »`, link: `#projets/${id}` });
  emitTo(projectAudience(id), { type: 'project', projectId: id });
  res.json({ project: shapeProject(getProject(id)) });
});

projectsApi.delete('/projects/:id/members/:userId', requireStaff, (req, res) => {
  const id = idParam(req);
  const p = projectForWrite(me(req), id);
  const userId = idParam(req, 'userId');
  const u = db.prepare('SELECT name FROM users WHERE id = ?').get(userId) as { name: string } | undefined;
  const before = projectAudience(id);
  db.prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?').run(id, userId);
  logActivity(me(req), 'member', 'project', id, `${u?.name ?? 'Un membre'} retiré du projet « ${p.name} »`, id);
  emitTo(before, { type: 'project', projectId: id });
  res.json({ project: shapeProject(getProject(id)) });
});

projectsApi.get('/projects/:id/activity', (req, res) => {
  const id = idParam(req);
  projectForRead(me(req), id);
  const rows = db
    .prepare('SELECT id, user_name, action, summary, created_at FROM activity_log WHERE project_id = ? ORDER BY created_at DESC LIMIT 100')
    .all(id) as { id: string; user_name: string; action: string; summary: string; created_at: string }[];
  res.json({ activity: rows.map((r) => ({ id: r.id, userName: r.user_name, action: r.action, summary: r.summary, createdAt: r.created_at })) });
});
