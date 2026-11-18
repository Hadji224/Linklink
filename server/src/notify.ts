import { db, now, uid } from './db.js';
import { sendMail } from './mailer.js';
import { emitTo } from './realtime.js';

export interface NotifyInput {
  userId: string;
  type: 'assigned' | 'mention' | 'due_soon' | 'due_today' | 'overdue' | 'meeting' | 'meeting_reminder' | 'project' | 'dm' | 'task' | 'security' | 'system' | 'validation' | 'finance' | 'communication';
  title: string;
  body?: string;
  link?: string;
  /** Évite les doublons (ex. rappel du jour) : une seule notification par clé et par personne. */
  dedupeKey?: string;
  email?: boolean;
  /** information générale, action attendue ou alerte urgente (§11.4) */
  category?: 'info' | 'action' | 'urgent';
}

export async function notify(n: NotifyInput) {
  const id = uid();
  const created = now();
  try {
    // ON CONFLICT : dans PostgreSQL, une erreur SQL annulerait la transaction en cours.
    const r = await db.prepare(
      'INSERT INTO notifications (id,user_id,type,title,body,link,dedupe_key,created_at,category) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING',
    ).run(id, n.userId, n.type, n.title, n.body ?? '', n.link ?? '', n.dedupeKey ?? null, created, n.category ?? (n.type === 'security' ? 'urgent' : 'info'));
    if (!r.changes) return false; // déjà envoyée (clé de dédoublonnage)
  } catch {
    return false; // destinataire introuvable
  }
  const category = n.category ?? (n.type === 'security' ? 'urgent' : 'info');
  const notification = { id, type: n.type, category, title: n.title, body: n.body ?? '', link: n.link ?? '', createdAt: created, readAt: null };
  emitTo([n.userId], { type: 'notification', notification });
  if (n.email !== false) {
    const u = await db.prepare('SELECT email, email_notif FROM users WHERE id = ?').get(n.userId) as
      | { email: string; email_notif: number }
      | undefined;
    if (u?.email_notif) sendMail(u.email, n.title, n.body ? `${n.title}\n${n.body}` : n.title, n.link);
  }
  return true;
}
