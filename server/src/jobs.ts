import fs from 'node:fs';
import path from 'node:path';
import { db, now, today } from './db.js';
import { storage } from './storage.js';
import { purgeOldLogs } from './logger.js';
import { notify } from './notify.js';
import { meetingAudience } from './routes/meetings.js';
import { expireEmergency } from './routes/governance.js';
import { runValidationReminders } from './validations.js';

/** Rappels automatiques : tâches J-1 / J-0 / en retard, rendez-vous à 24 h et 1 h. Idempotent (clés de dédoublonnage). */
export async function runReminders() {
  const d0 = today();
  const d1 = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const tasks = await db
      .prepare(
        `SELECT t.id, t.title, t.due_date, t.assignee_id, t.created_by, t.project_id, p.name AS pname
       FROM tasks t JOIN projects p ON p.id = t.project_id
       WHERE t.status <> 'done' AND t.due_date IS NOT NULL AND t.due_date <= ? AND p.status NOT IN ('archived','done')`,
      )
      .all(d1) as { id: string; title: string; due_date: string; assignee_id: string | null; created_by: string | null; project_id: string; pname: string }[];
  for (const t of tasks) {
    const link = `#projets/${t.project_id}/taches/${t.id}`;
    if (t.due_date === d1 && t.assignee_id) {
      await notify({ userId: t.assignee_id, type: 'due_soon', title: `Échéance demain : ${t.title}`, body: t.pname, link, dedupeKey: `due1:${t.id}:${t.due_date}` });
    } else if (t.due_date === d0 && t.assignee_id) {
      await notify({ userId: t.assignee_id, type: 'due_today', title: `Échéance aujourd'hui : ${t.title}`, body: t.pname, link, dedupeKey: `due0:${t.id}:${t.due_date}` });
    } else if (t.due_date < d0) {
      // Retard : alerte au responsable et au créateur, une fois par jour.
      for (const u of new Set([t.assignee_id, t.created_by].filter(Boolean) as string[])) {
        await notify({ userId: u, type: 'overdue', title: `Tâche en retard : ${t.title}`, body: `${t.pname} — échéance ${t.due_date}`, link, dedupeKey: `late:${t.id}:${d0}` });
      }
    }
  }
  const nowMs = Date.now();
  const meetings = await db
      .prepare('SELECT id, title, starts_at, project_id FROM meetings WHERE starts_at > ? AND starts_at <= ?')
      .all(new Date(nowMs).toISOString(), new Date(nowMs + 24 * 3600_000).toISOString()) as { id: string; title: string; starts_at: string; project_id: string | null }[];
  for (const m of meetings) {
    const inMs = Date.parse(m.starts_at) - nowMs;
    const kind = inMs <= 3600_000 ? '1h' : '24h';
    const at = new Date(m.starts_at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Conakry' });
    for (const u of (await meetingAudience(m))) {
      const rsvp = await db.prepare('SELECT status FROM rsvps WHERE meeting_id = ? AND user_id = ?').get(m.id, u) as { status: string } | undefined;
      if (rsvp?.status === 'no') continue;
      await notify({ userId: u, type: 'meeting_reminder', title: kind === '1h' ? `Rendez-vous dans moins d'une heure : ${m.title}` : `Rendez-vous demain : ${m.title}`, body: `à ${at}`, link: '#rendez-vous', dedupeKey: `rdv${kind}:${m.id}` });
    }
  }
}

/** Plafond de place occupée par les pièces jointes des salons en base (Neon gratuit : 0,5 Go au total). */
const CHAT_STORE_BUDGET = (Number(process.env.CHAT_STORE_BUDGET_MB) || 300) * 1024 * 1024;

/** Marque les fichiers « expirés » (le message reste, avec le nom et la taille) et libère la place en base. */
async function purgeKeys(keys: string[]) {
  if (!keys.length) return 0;
  await db.run("UPDATE files SET purged_at = ?, stored_name = 'expired' WHERE stored_name = ANY(?)", now(), keys as never);
  await storage.remove(keys);
  return keys.length;
}

/**
 * Relais temporaire des pièces jointes de salons (modèle WhatsApp) :
 *  1. supprime les fichiers arrivés à échéance (CHAT_FILE_RETENTION_DAYS, 30 jours par défaut) ;
 *  2. si la place dépasse le plafond, supprime les plus anciens d'abord ;
 *  3. nettoie les fichiers orphelins (envoi interrompu).
 * Les appareils qui ont déjà ouvert le fichier en gardent une copie.
 */
export async function purgeChatFiles(): Promise<{ expired: number; overBudget: number; orphans: number }> {
  const due = (await db.all<{ stored_name: string }>("SELECT stored_name FROM files WHERE purged_at IS NULL AND expires_at IS NOT NULL AND expires_at <= ? AND stored_name LIKE 'db:%'", now())).map((r) => r.stored_name);
  const expired = await purgeKeys(due);

  // Place : on retire les plus anciens, un par un, jusqu'à repasser sous le plafond (et pas un de plus).
  let overBudget = 0;
  for (let round = 0; round < 20; round++) {
    const total = (await db.get<{ n: number }>('SELECT COALESCE(SUM(size),0) AS n FROM file_blobs'))?.n ?? 0;
    let excess = total - CHAT_STORE_BUDGET;
    if (excess <= 0) break;
    const oldest = await db.all<{ key: string; size: number }>('SELECT key, size FROM file_blobs ORDER BY created_at LIMIT 100');
    if (!oldest.length) break;
    const take: string[] = [];
    for (const f of oldest) {
      if (excess <= 0) break;
      take.push(f.key);
      excess -= f.size;
    }
    overBudget += await purgeKeys(take);
  }

  const orphanKeys = (await db.all<{ key: string }>('SELECT key FROM file_blobs WHERE created_at < ? AND key NOT IN (SELECT stored_name FROM files)', new Date(Date.now() - 86_400_000).toISOString())).map((r) => r.key);
  if (orphanKeys.length) await storage.remove(orphanKeys);
  return { expired, overBudget, orphans: orphanKeys.length };
}

export function startJobs() {
  const safe = (fn: () => Promise<void>) => async () => {
    try { await fn(); } catch (e) { console.error('Tâche planifiée en échec :', e); }
  };
  const hourly = safe(async () => { await runReminders(); await runValidationReminders(); await expireEmergency(); });
  const daily = safe(async () => { await purgeOldLogs(); });
  const purge = safe(async () => {
    const r = await purgeChatFiles();
    if (r.expired || r.overBudget || r.orphans) console.log(`Pièces jointes des salons : ${r.expired} expirée(s), ${r.overBudget} retirée(s) (place), ${r.orphans} orpheline(s).`);
  });
  void hourly();
  void daily();
  void purge();
  setInterval(hourly, 10 * 60_000).unref();
  setInterval(daily, 6 * 3600_000).unref();
  setInterval(purge, Number(process.env.CHAT_PURGE_EVERY_MS) || 3600_000).unref();
}
