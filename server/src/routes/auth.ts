import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { z } from 'zod';
import { limitAuthAttempts, requireAdmin, requireAuth, requireStaff, signToken } from '../auth.js';
import { logActivity } from '../activity.js';
import { db, getSetting, newInviteCode, now, setSetting, tx, uid, type Role, type UserRow } from '../db.js';
import { HttpError, idParam, me, parse } from '../http.js';
import { disconnectUser, emitAll, onlineUserIds } from '../realtime.js';
import { removeStored } from '../uploads.js';

export const publicApi = Router();
export const accountApi = Router();

const publicUser = (r: Pick<UserRow, 'id' | 'name' | 'email' | 'role'>) => ({ id: r.id, name: r.name, email: r.email, role: r.role });

const registerSchema = z.object({
  name: z.string().trim().min(1, 'Le nom est obligatoire.').max(80),
  email: z.string().trim().toLowerCase().email('Adresse e-mail invalide.').max(200),
  password: z.string().min(8, 'Le mot de passe doit faire au moins 8 caractères.').max(200),
  inviteCode: z.string().trim().max(40).optional().default(''),
  consent: z.literal(true, { errorMap: () => ({ message: "Vous devez accepter la politique de confidentialité pour créer un compte." }) }),
});

publicApi.post('/auth/register', limitAuthAttempts, (req, res) => {
  const input = parse(registerSchema, req.body);
  const isFirst = (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n === 0;
  let role: Role = 'admin';
  if (!isFirst) {
    const code = input.inviteCode.toUpperCase();
    if (code && code === (getSetting('invite_code') ?? '').toUpperCase()) role = 'member';
    else if (code && code === (getSetting('guest_invite_code') ?? '').toUpperCase()) role = 'guest';
    else throw new HttpError(403, "Code d'invitation incorrect.");
  }
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(input.email)) {
    throw new HttpError(409, 'Cette adresse e-mail est déjà utilisée.');
  }
  const id = uid();
  const t = now();
  db.prepare('INSERT INTO users (id,name,email,password_hash,role,consented_at,created_at) VALUES (?,?,?,?,?,?,?)').run(
    id, input.name, input.email, bcrypt.hashSync(input.password, 10), role, t, t,
  );
  const user = { id, name: input.name, email: input.email, role };
  logActivity(user, 'register', 'user', id, `${input.name} a rejoint l'équipe (${role})`);
  emitAll({ type: 'members' });
  res.status(201).json({ token: signToken({ id, token_version: 0 }), user });
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Adresse e-mail invalide.'),
  password: z.string().min(1, 'Le mot de passe est obligatoire.'),
});

publicApi.post('/auth/login', limitAuthAttempts, (req, res) => {
  const input = parse(loginSchema, req.body);
  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(input.email) as unknown as UserRow | undefined;
  if (!row || !bcrypt.compareSync(input.password, row.password_hash)) {
    throw new HttpError(401, 'E-mail ou mot de passe incorrect.');
  }
  res.json({ token: signToken(row), user: publicUser(row) });
});

publicApi.get('/setup', (_req, res) => {
  res.json({ hasUsers: (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n > 0 });
});

publicApi.get('/health', (_req, res) => {
  db.prepare('SELECT 1').get();
  res.json({ ok: true, time: now() });
});

/* ------------------------------ Compte connecté ------------------------------ */

accountApi.get('/me', (req, res) => {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(me(req).id) as unknown as UserRow;
  res.json({ user: { ...publicUser(row), emailNotif: row.email_notif === 1, createdAt: row.created_at } });
});

accountApi.patch('/me', (req, res) => {
  const input = parse(
    z.object({
      name: z.string().trim().min(1, 'Le nom est obligatoire.').max(80).optional(),
      email: z.string().trim().toLowerCase().email('Adresse e-mail invalide.').max(200).optional(),
      emailNotif: z.boolean().optional(),
    }),
    req.body,
  );
  const id = me(req).id;
  if (input.email && db.prepare('SELECT 1 FROM users WHERE email = ? AND id <> ?').get(input.email, id)) {
    throw new HttpError(409, 'Cette adresse e-mail est déjà utilisée.');
  }
  const cur = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as unknown as UserRow;
  db.prepare('UPDATE users SET name = ?, email = ?, email_notif = ? WHERE id = ?').run(
    input.name ?? cur.name, input.email ?? cur.email, input.emailNotif === undefined ? cur.email_notif : input.emailNotif ? 1 : 0, id,
  );
  emitAll({ type: 'members' });
  res.json({ user: publicUser({ ...cur, name: input.name ?? cur.name, email: input.email ?? cur.email }) });
});

accountApi.post('/me/password', limitAuthAttempts, (req, res) => {
  const input = parse(
    z.object({
      current: z.string().min(1, 'Mot de passe actuel requis.'),
      next: z.string().min(8, 'Le nouveau mot de passe doit faire au moins 8 caractères.').max(200),
    }),
    req.body,
  );
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(me(req).id) as unknown as UserRow;
  if (!bcrypt.compareSync(input.current, row.password_hash)) throw new HttpError(403, 'Mot de passe actuel incorrect.');
  db.prepare('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?').run(
    bcrypt.hashSync(input.next, 10), row.id,
  );
  logActivity(me(req), 'password', 'user', row.id, 'Mot de passe modifié');
  const fresh = { id: row.id, token_version: row.token_version + 1 };
  res.json({ token: signToken(fresh) });
});

/** Droit d'accès (RGPD) : export de toutes les données personnelles en un clic. */
accountApi.get('/me/export', (req, res) => {
  const id = me(req).id;
  const q = (sql: string) => db.prepare(sql).all(id);
  const user = db.prepare('SELECT id,name,email,role,email_notif,consented_at,created_at FROM users WHERE id = ?').get(id);
  res.setHeader('Content-Disposition', 'attachment; filename="mes-donnees-linklink.json"');
  res.json({
    exportedAt: now(),
    profil: user,
    messages: q('SELECT m.id, c.name AS salon, m.body, m.created_at FROM messages m JOIN channels c ON c.id = m.channel_id WHERE m.user_id = ?'),
    fichiers: q('SELECT id, name, mime, size, level, created_at FROM files WHERE user_id = ?'),
    taches_creees: q('SELECT id, title, status, priority, due_date, created_at FROM tasks WHERE created_by = ?'),
    taches_assignees: q('SELECT id, title, status, priority, due_date FROM tasks WHERE assignee_id = ?'),
    commentaires: q('SELECT id, task_id, body, created_at FROM task_comments WHERE user_id = ?'),
    rendez_vous_crees: q('SELECT id, title, starts_at FROM meetings WHERE created_by = ?'),
    reponses_rdv: q('SELECT meeting_id, status FROM rsvps WHERE user_id = ?'),
    notifications: q('SELECT type, title, body, created_at, read_at FROM notifications WHERE user_id = ?'),
    journal_activite: q('SELECT action, entity, summary, created_at FROM activity_log WHERE user_id = ?'),
  });
});

export function eraseUser(userId: string) {
  const stored = (db.prepare('SELECT stored_name FROM files WHERE user_id = ?').all(userId) as { stored_name: string }[]).map((f) => f.stored_name);
  tx(() => {
    db.prepare("UPDATE activity_log SET user_name = 'Compte supprimé', user_id = NULL WHERE user_id = ?").run(userId);
    db.prepare('DELETE FROM users WHERE id = ?').run(userId); // cascade : messages, fichiers, commentaires, notifications…
  });
  removeStored(stored);
  disconnectUser(userId);
  emitAll({ type: 'members' });
}

function assertNotLastAdmin(userId: string) {
  const u = db.prepare('SELECT role FROM users WHERE id = ?').get(userId) as { role: Role } | undefined;
  if (u?.role === 'admin' && (db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin'").get() as { n: number }).n <= 1) {
    throw new HttpError(400, 'Il doit rester au moins un Super Admin.');
  }
}

/** Droit à l'oubli : suppression du compte et de ses données (mot de passe demandé). */
accountApi.delete('/me', limitAuthAttempts, (req, res) => {
  const { password } = parse(z.object({ password: z.string().min(1, 'Mot de passe requis.') }), req.body);
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(me(req).id) as unknown as UserRow;
  if (!bcrypt.compareSync(password, row.password_hash)) throw new HttpError(403, 'Mot de passe incorrect.');
  assertNotLastAdmin(row.id);
  eraseUser(row.id);
  res.json({ ok: true });
});

/* --------------------------------- Équipe --------------------------------- */

accountApi.get('/members', (_req, res) => {
  const online = new Set(onlineUserIds());
  const rows = db.prepare('SELECT id, name, email, role, created_at FROM users ORDER BY created_at').all() as unknown as Pick<UserRow, 'id' | 'name' | 'email' | 'role' | 'created_at'>[];
  res.json({ members: rows.map((r) => ({ ...publicUser(r), createdAt: r.created_at, online: online.has(r.id) })) });
});

accountApi.patch('/members/:id/role', requireAdmin, (req, res) => {
  const { role } = parse(z.object({ role: z.enum(['admin', 'member', 'guest']) }), req.body);
  const id = idParam(req);
  if (id === me(req).id) throw new HttpError(400, 'Vous ne pouvez pas modifier votre propre rôle.');
  const target = db.prepare('SELECT id, name, role FROM users WHERE id = ?').get(id) as { id: string; name: string; role: Role } | undefined;
  if (!target) throw new HttpError(404, 'Membre introuvable.');
  assertNotLastAdmin(id);
  db.prepare('UPDATE users SET role = ?, token_version = token_version + 1 WHERE id = ?').run(role, id);
  logActivity(me(req), 'role', 'user', id, `Rôle de ${target.name} : ${target.role} → ${role}`);
  disconnectUser(id); // il devra se reconnecter pour appliquer son nouveau rôle
  emitAll({ type: 'members' });
  res.json({ ok: true });
});

accountApi.delete('/members/:id', requireAdmin, (req, res) => {
  const id = idParam(req);
  if (id === me(req).id) throw new HttpError(400, 'Utilisez « Supprimer mon compte » pour votre propre compte.');
  const target = db.prepare('SELECT name FROM users WHERE id = ?').get(id) as { name: string } | undefined;
  if (!target) throw new HttpError(404, 'Membre introuvable.');
  logActivity(me(req), 'remove', 'user', id, `${target.name} a été retiré de l'équipe`);
  eraseUser(id);
  res.json({ ok: true });
});

/* ------------------------- Codes d'invitation ------------------------- */

// Super Admin et Fondateurs peuvent inviter ; le code « invité » est réservé au Super Admin.
accountApi.get('/invite', requireStaff, (req, res) => {
  res.json({
    code: getSetting('invite_code'),
    guestCode: me(req).role === 'admin' ? getSetting('guest_invite_code') : undefined,
  });
});

accountApi.post('/invite/regenerate', requireAdmin, (req, res) => {
  const { kind } = parse(z.object({ kind: z.enum(['member', 'guest']).default('member') }), req.body ?? {});
  const code = newInviteCode();
  setSetting(kind === 'guest' ? 'guest_invite_code' : 'invite_code', code);
  logActivity(me(req), 'invite', 'settings', kind, `Code d'invitation (${kind}) régénéré`);
  res.json({ code });
});

export { requireAuth };
