import fs from 'node:fs';
import path from 'node:path';
import { BACKUP_DIR, db, today } from './db.js';
import { purgeOldLogs } from './logger.js';
import { notify } from './notify.js';
import { meetingAudience } from './routes/meetings.js';

/** Rappels automatiques : tâches J-1 / J-0 / en retard, rendez-vous à 24 h et 1 h. Idempotent (clés de dédoublonnage). */
export function runReminders() {
  const d0 = today();
  const d1 = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const tasks = db
    .prepare(
      `SELECT t.id, t.title, t.due_date, t.assignee_id, t.created_by, t.project_id, p.name AS pname
       FROM tasks t JOIN projects p ON p.id = t.project_id
       WHERE t.status <> 'done' AND t.due_date IS NOT NULL AND t.due_date <= ? AND p.status NOT IN ('archived','done')`,
    )
    .all(d1) as { id: string; title: string; due_date: string; assignee_id: string | null; created_by: string | null; project_id: string; pname: string }[];
  for (const t of tasks) {
    const link = `#projets/${t.project_id}/taches/${t.id}`;
    if (t.due_date === d1 && t.assignee_id) {
      notify({ userId: t.assignee_id, type: 'due_soon', title: `Échéance demain : ${t.title}`, body: t.pname, link, dedupeKey: `due1:${t.id}:${t.due_date}` });
    } else if (t.due_date === d0 && t.assignee_id) {
      notify({ userId: t.assignee_id, type: 'due_today', title: `Échéance aujourd'hui : ${t.title}`, body: t.pname, link, dedupeKey: `due0:${t.id}:${t.due_date}` });
    } else if (t.due_date < d0) {
      // Retard : alerte au responsable et au créateur, une fois par jour.
      for (const u of new Set([t.assignee_id, t.created_by].filter(Boolean) as string[])) {
        notify({ userId: u, type: 'overdue', title: `Tâche en retard : ${t.title}`, body: `${t.pname} — échéance ${t.due_date}`, link, dedupeKey: `late:${t.id}:${d0}` });
      }
    }
  }
  const nowMs = Date.now();
  const meetings = db
    .prepare('SELECT id, title, starts_at, project_id FROM meetings WHERE starts_at > ? AND starts_at <= ?')
    .all(new Date(nowMs).toISOString(), new Date(nowMs + 24 * 3600_000).toISOString()) as { id: string; title: string; starts_at: string; project_id: string | null }[];
  for (const m of meetings) {
    const inMs = Date.parse(m.starts_at) - nowMs;
    const kind = inMs <= 3600_000 ? '1h' : '24h';
    const at = new Date(m.starts_at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Conakry' });
    for (const u of meetingAudience(m)) {
      const rsvp = db.prepare('SELECT status FROM rsvps WHERE meeting_id = ? AND user_id = ?').get(m.id, u) as { status: string } | undefined;
      if (rsvp?.status === 'no') continue;
      notify({ userId: u, type: 'meeting_reminder', title: kind === '1h' ? `Rendez-vous dans moins d'une heure : ${m.title}` : `Rendez-vous demain : ${m.title}`, body: `à ${at}`, link: '#rendez-vous', dedupeKey: `rdv${kind}:${m.id}` });
    }
  }
}

/** Sauvegarde quotidienne de la base (VACUUM INTO), 30 jours de rétention. */
export function runBackup() {
  const file = path.join(BACKUP_DIR, `linklink-${today()}.db`);
  if (!fs.existsSync(file)) db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const limit = Date.now() - 30 * 86_400_000;
  for (const f of fs.readdirSync(BACKUP_DIR)) {
    if (/^linklink-\d{4}-\d{2}-\d{2}\.db$/.test(f) && fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs < limit) fs.rmSync(path.join(BACKUP_DIR, f));
  }
}

export function startJobs() {
  const safe = (fn: () => void) => () => {
    try { fn(); } catch (e) { console.error('Tâche planifiée en échec :', e); }
  };
  const hourly = safe(() => { runReminders(); });
  const daily = safe(() => { runBackup(); purgeOldLogs(); });
  hourly(); daily();
  setInterval(hourly, 10 * 60_000).unref();
  setInterval(daily, 6 * 3600_000).unref();
}
