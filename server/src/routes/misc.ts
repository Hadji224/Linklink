import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../auth.js';
import { can, deny } from '../access.js';
import { db, now, today } from '../db.js';
import { flushAccessLogs } from '../logger.js';
import { idParam, me, parse } from '../http.js';
import { canSeeFolder, isStaff, visibleProjectIds } from '../perm.js';
import { canSeeMeeting } from './meetings.js';
import { unreadByChannel } from './channels.js';
import { filterA } from "../async.js";

export const miscApi = Router();

/* ------------------------------- Notifications ------------------------------- */

miscApi.get('/notifications', async (req, res) => {
  const rows = await db
      .prepare('SELECT id, type, title, body, link, created_at, read_at, category FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 60')
      .all(me(req).id) as { id: string; type: string; title: string; body: string; link: string; created_at: string; read_at: string | null; category: string }[];
  const unread = (await db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(me(req).id) as { n: number }).n;
  res.json({
    unread,
    notifications: rows.map((r) => ({ id: r.id, type: r.type, category: r.category, title: r.title, body: r.body, link: r.link, createdAt: r.created_at, readAt: r.read_at })),
  });
});

miscApi.post('/notifications/read', async (req, res) => {
  const { ids } = parse(z.object({ ids: z.array(z.string()).max(200).optional() }), req.body ?? {});
  if (ids?.length) {
    for (const id of ids) await db.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL').run(now(), id, me(req).id);
  } else {
    await db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(now(), me(req).id);
  }
  res.json({ ok: true });
});

/* ------------------------------- Tableau de bord ------------------------------- */

miscApi.get('/dashboard', async (req, res) => {
  const user = me(req);
  const projectIds = await visibleProjectIds(user);
  const inProjects = projectIds.length ? projectIds.map(() => '?').join(',') : "''";
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const weekStart = (() => {
    const d = new Date();
    const day = (d.getUTCDay() + 6) % 7; // lundi = 0
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() - day);
    return d;
  })();
  const weekEnd = new Date(weekStart.getTime() + 7 * 86_400_000);

  const myTasks = await db
      .prepare(
        `SELECT t.id, t.title, t.priority, t.status, t.due_date, t.project_id, p.name AS pname, p.color
       FROM tasks t JOIN projects p ON p.id = t.project_id
       WHERE t.assignee_id = ? AND t.status <> 'done' AND t.due_date IS NOT NULL AND t.due_date <= ? AND p.status <> 'archived'
       ORDER BY t.due_date, t.priority LIMIT 30`,
      )
      .all(user.id, today()) as { id: string; title: string; priority: string; status: string; due_date: string; project_id: string; pname: string; color: string }[];

  const meetings = await filterA((await db.prepare('SELECT m.id, m.title, m.starts_at, m.location, m.project_id FROM meetings m WHERE m.starts_at >= ? ORDER BY m.starts_at LIMIT 100').all(new Date(Date.now() - 2 * 3600_000).toISOString()) as {
      id: string; title: string; starts_at: string; location: string; project_id: string | null;
    }[]), async (m) => await canSeeMeeting(user, m));

  const unread = await unreadByChannel(user);

  const countTasksDone = (await db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE project_id IN (${inProjects}) AND completed_at >= ?`).get(...projectIds, weekStart.toISOString()) as { n: number }).n;
  const newFiles = (await filterA((await db.prepare(`SELECT f.id, f.user_id, f.level, f.channel_id, f.folder_id FROM files f WHERE f.created_at >= ?`).all(weekAgo) as unknown as { id: string; user_id: string; level: never; channel_id: string | null; folder_id: string }[]), async (f) => !f.channel_id && (await canSeeFolder(user, f.folder_id)))).length;

  res.json({
    myTasksToday: myTasks.map((t) => ({ id: t.id, title: t.title, priority: t.priority, status: t.status, dueDate: t.due_date, overdue: t.due_date < today(), project: { id: t.project_id, name: t.pname, color: t.color } })),
    upcomingMeetings: meetings.slice(0, 5).map((m) => ({ id: m.id, title: m.title, startsAt: m.starts_at, location: m.location })),
    unreadChannels: unread.slice(0, 5).map((c) => ({ id: c.id, name: c.name, kind: c.kind, unread: c.unread })),
    unreadTotal: unread.reduce((n, c) => n + c.unread, 0),
    kpis: {
      activeProjects: (await db.prepare(`SELECT COUNT(*) AS n FROM projects WHERE status = 'active' AND id IN (${inProjects})`).get(...projectIds) as { n: number }).n,
      tasksDoneThisWeek: countTasksDone,
      meetingsThisWeek: meetings.filter((m) => m.starts_at >= weekStart.toISOString() && m.starts_at < weekEnd.toISOString()).length,
      newFiles,
    },
    staff: isStaff(user),
  });
});

/* ----------------------- Journal d'activité (Super Admin) ----------------------- */

miscApi.get('/activity', async (req, res) => {
  if (!(me(req).role === 'admin' || (await can(me(req), 'journal.business')))) throw await deny(me(req), 'activity_read', "Le journal d'activité est réservé à l'administrateur technique et au PDG.");
  const limit = Math.min(Number(req.query.limit) || 100, 300);
  const before = typeof req.query.before === 'string' ? req.query.before : '9999';
  const rows = await db
      .prepare('SELECT id, user_name, action, entity, summary, created_at FROM activity_log WHERE created_at < ? ORDER BY created_at DESC LIMIT ?')
      .all(before, limit) as { id: string; user_name: string; action: string; entity: string; summary: string; created_at: string }[];
  res.json({ activity: rows.map((r) => ({ id: r.id, userName: r.user_name, action: r.action, entity: r.entity, summary: r.summary, createdAt: r.created_at })), hasMore: rows.length === limit });
});

// Logs d'accès (conservés 12 mois, en base) : lecture réservée au Super Admin. Les 200 dernières lignes, la plus récente en bas.
miscApi.get('/admin/access-logs', requireAdmin, async (_req, res) => {
  await flushAccessLogs();
  const rows = (await db.all<{ t: string; ip: string | null; user_id: string | null; method: string; path: string; status: number; ms: number }>(
    'SELECT t, ip, user_id, method, path, status, ms FROM access_logs ORDER BY id DESC LIMIT 200',
  )).reverse();
  res.json({ lines: rows.map((r) => JSON.stringify({ t: r.t, ip: r.ip, user: r.user_id, method: r.method, path: r.path, status: r.status, ms: r.ms })) });
});

export { idParam };
