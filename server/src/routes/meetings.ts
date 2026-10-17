import { Router } from 'express';
import { z } from 'zod';
import { requireStaff } from '../auth.js';
import { logActivity } from '../activity.js';
import { db, now, uid } from '../db.js';
import { HttpError, idParam, me, parse, type AuthUser } from '../http.js';
import { notify } from '../notify.js';
import { canSeeProject, isStaff, projectAudience, projectForWrite } from '../perm.js';
import { emitTo } from '../realtime.js';

export const meetingsApi = Router();

interface MeetingRow {
  id: string; title: string; description: string; location: string; starts_at: string;
  project_id: string | null; created_by: string | null; creator_name: string | null;
}

const MEETING_SELECT = `
  SELECT m.id, m.title, m.description, m.location, m.starts_at, m.project_id, m.created_by, u.name AS creator_name
  FROM meetings m LEFT JOIN users u ON u.id = m.created_by`;

/** Les rendez-vous « équipe » sont réservés à l'équipe ; ceux d'un projet à ses participants. */
export function canSeeMeeting(user: AuthUser, m: Pick<MeetingRow, 'project_id'>) {
  return m.project_id ? canSeeProject(user, m.project_id) : isStaff(user);
}

export function meetingAudience(m: Pick<MeetingRow, 'project_id'>): string[] {
  if (m.project_id) return projectAudience(m.project_id);
  return (db.prepare("SELECT id FROM users WHERE role <> 'guest'").all() as { id: string }[]).map((r) => r.id);
}

function shapeMeeting(row: MeetingRow, viewerId: string) {
  const rsvps = db
    .prepare('SELECT r.user_id, r.status, u.name FROM rsvps r JOIN users u ON u.id = r.user_id WHERE r.meeting_id = ? ORDER BY u.name')
    .all(row.id) as { user_id: string; status: 'yes' | 'maybe' | 'no'; name: string }[];
  const project = row.project_id
    ? (db.prepare('SELECT id, name, color FROM projects WHERE id = ?').get(row.project_id) as { id: string; name: string; color: string } | undefined) ?? null
    : null;
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    location: row.location,
    startsAt: row.starts_at,
    project,
    createdBy: row.created_by ? { id: row.created_by, name: row.creator_name ?? '' } : null,
    attendees: rsvps.map((r) => ({ userId: r.user_id, name: r.name, status: r.status })),
    myStatus: rsvps.find((r) => r.user_id === viewerId)?.status ?? null,
  };
}

const load = (id: string) => db.prepare(`${MEETING_SELECT} WHERE m.id = ?`).get(id) as unknown as MeetingRow | undefined;

meetingsApi.get('/meetings', (req, res) => {
  const rows = db.prepare(`${MEETING_SELECT} ORDER BY m.starts_at LIMIT 500`).all() as unknown as MeetingRow[];
  res.json({ meetings: rows.filter((m) => canSeeMeeting(me(req), m)).map((r) => shapeMeeting(r, me(req).id)) });
});

const meetingSchema = z.object({
  title: z.string().trim().min(1, 'Le titre est obligatoire.').max(120),
  description: z.string().trim().max(2000).optional().default(''),
  location: z.string().trim().max(200).optional().default(''),
  projectId: z.string().nullable().optional(),
  startsAt: z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'Date invalide.').transform((s) => new Date(s).toISOString()),
});

meetingsApi.post('/meetings', requireStaff, (req, res) => {
  const input = parse(meetingSchema, req.body);
  if (input.projectId) projectForWrite(me(req), input.projectId);
  const id = uid();
  db.prepare('INSERT INTO meetings (id,title,description,location,starts_at,project_id,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)').run(
    id, input.title, input.description, input.location, input.startsAt, input.projectId ?? null, me(req).id, now(),
  );
  db.prepare('INSERT INTO rsvps (meeting_id,user_id,status) VALUES (?,?,?)').run(id, me(req).id, 'yes'); // l'organisateur est présent
  logActivity(me(req), 'create', 'meeting', id, `Rendez-vous « ${input.title} » créé`, input.projectId ?? null);
  const row = load(id) as MeetingRow;
  const audience = meetingAudience(row);
  const when = new Date(input.startsAt).toLocaleString('fr-FR', { dateStyle: 'full', timeStyle: 'short', timeZone: 'Africa/Conakry' });
  for (const u of audience) {
    if (u !== me(req).id) notify({ userId: u, type: 'meeting', title: `Nouveau rendez-vous : ${input.title}`, body: when, link: '#rendez-vous' });
  }
  emitTo(audience, { type: 'meeting', meetingId: id });
  res.status(201).json({ meeting: shapeMeeting(row, me(req).id) });
});

meetingsApi.post('/meetings/:id/rsvp', (req, res) => {
  const { status } = parse(z.object({ status: z.enum(['yes', 'maybe', 'no']) }), req.body);
  const row = load(idParam(req));
  if (!row || !canSeeMeeting(me(req), row)) throw new HttpError(404, 'Rendez-vous introuvable.');
  db.prepare(
    'INSERT INTO rsvps (meeting_id,user_id,status) VALUES (?,?,?) ON CONFLICT(meeting_id,user_id) DO UPDATE SET status = excluded.status',
  ).run(row.id, me(req).id, status);
  emitTo(meetingAudience(row), { type: 'meeting', meetingId: row.id });
  res.json({ ok: true });
});

meetingsApi.delete('/meetings/:id', requireStaff, (req, res) => {
  const row = load(idParam(req));
  if (!row || !canSeeMeeting(me(req), row)) throw new HttpError(404, 'Rendez-vous introuvable.');
  if (row.created_by !== me(req).id && me(req).role !== 'admin') {
    throw new HttpError(403, "Seul l'organisateur ou le Super Admin peut supprimer ce rendez-vous.");
  }
  const audience = meetingAudience(row);
  db.prepare('DELETE FROM meetings WHERE id = ?').run(row.id);
  logActivity(me(req), 'delete', 'meeting', row.id, `Rendez-vous « ${row.title} » supprimé`, row.project_id);
  emitTo(audience, { type: 'meeting', meetingId: row.id });
  res.json({ ok: true });
});
