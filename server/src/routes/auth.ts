import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { z } from 'zod';
import { limitAuthAttempts, requireAdmin, requireAuth, requireStaff, signToken } from '../auth.js';
import { logActivity } from '../activity.js';
import { audit, capabilitiesOf, functionsOf, ownFunctions } from '../access.js';
import { db, ensureBootstrapPdg, getSetting, newInviteCode, now, setSetting, tx, uid, type Role, type UserRow } from '../db.js';
import { HttpError, idParam, me, parse } from '../http.js';
import { disconnectUser, emitAll, onlineUserIds } from '../realtime.js';
import { handOverTasksOf } from '../taskrules.js';
import { removeStored } from '../uploads.js';
import { mapA } from "../async.js";

export const publicApi = Router();
export const accountApi = Router();

const publicUser = async (r: Pick<UserRow, 'id' | 'name' | 'email' | 'role'>) => ({ id: r.id, name: r.name, email: r.email, role: r.role, functions: (await ownFunctions(r.id)) });

const registerSchema = z.object({
  name: z.string().trim().min(1, 'Le nom est obligatoire.').max(80),
  email: z.string().trim().toLowerCase().email('Adresse e-mail invalide.').max(200),
  password: z.string().min(8, 'Le mot de passe doit faire au moins 8 caractères.').max(200),
  inviteCode: z.string().trim().max(40).optional().default(''),
  consent: z.literal(true, { errorMap: () => ({ message: "Vous devez accepter la politique de confidentialité pour créer un compte." }) }),
});

publicApi.post('/auth/register', limitAuthAttempts, async (req, res) => {
  const input = parse(registerSchema, req.body);
  const isFirst = (await db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n === 0;
  let role: Role = 'admin';
  if (!isFirst) {
    const code = input.inviteCode.toUpperCase();
    if (code && code === ((await getSetting('invite_code')) ?? '').toUpperCase()) role = 'member';
    else if (code && code === ((await getSetting('guest_invite_code')) ?? '').toUpperCase()) role = 'guest';
    else throw new HttpError(403, "Code d'invitation incorrect.");
  }
  if ((await db.prepare('SELECT 1 FROM users WHERE email = ?').get(input.email))) {
    throw new HttpError(409, 'Cette adresse e-mail est déjà utilisée.');
  }
  const id = uid();
  const t = now();
  await db.prepare('INSERT INTO users (id,name,email,password_hash,role,consented_at,created_at) VALUES (?,?,?,?,?,?,?)').run(
        id, input.name, input.email, bcrypt.hashSync(input.password, 10), role, t, t,
      );
  if (isFirst) await ensureBootstrapPdg(); // l'administrateur technique tient la fonction PDG tant qu'aucun fondateur ne la reçoit
  const user = { id, name: input.name, email: input.email, role, functions: (await ownFunctions(id)) };
  await logActivity(user, 'register', 'user', id, `${input.name} a rejoint l'équipe (${role})`);
  emitAll({ type: 'members' });
  res.status(201).json({ token: signToken({ id, token_version: 0 }), user });
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Adresse e-mail invalide.'),
  password: z.string().min(1, 'Le mot de passe est obligatoire.'),
});

publicApi.post('/auth/login', limitAuthAttempts, async (req, res) => {
  const input = parse(loginSchema, req.body);
  const row = await db.prepare('SELECT * FROM users WHERE email = ?').get(input.email) as unknown as UserRow | undefined;
  if (!row || !bcrypt.compareSync(input.password, row.password_hash)) {
    throw new HttpError(401, 'E-mail ou mot de passe incorrect.');
  }
  if (row.suspended_at) {
    await audit({ id: row.id, name: row.name }, 'security', 'login_suspended', 'user', row.id, 'Connexion refusée : compte suspendu', { result: 'denied' });
    throw new HttpError(403, "Ce compte est suspendu. Contactez le PDG ou l'administrateur technique.");
  }
  res.json({ token: signToken(row), user: (await publicUser(row)) });
});

publicApi.get('/setup', async (_req, res) => {
  res.json({ hasUsers: (await db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n > 0 });
});

publicApi.get('/health', async (_req, res) => {
  await db.prepare('SELECT 1').get();
  res.json({ ok: true, time: now() });
});

/* ------------------------------ Compte connecté ------------------------------ */

accountApi.get('/me', async (req, res) => {
  const row = await db.prepare('SELECT * FROM users WHERE id = ?').get(me(req).id) as unknown as UserRow;
  res.json({
    user: { ...(await publicUser(row)), emailNotif: row.email_notif === 1, createdAt: row.created_at },
    effectiveFunctions: (await functionsOf(row.id)),
    can: (await capabilitiesOf({ id: row.id, role: row.role })),
  });
});

accountApi.patch('/me', async (req, res) => {
  const input = parse(
    z.object({
      name: z.string().trim().min(1, 'Le nom est obligatoire.').max(80).optional(),
      email: z.string().trim().toLowerCase().email('Adresse e-mail invalide.').max(200).optional(),
      emailNotif: z.boolean().optional(),
    }),
    req.body,
  );
  const id = me(req).id;
  if (input.email && (await db.prepare('SELECT 1 FROM users WHERE email = ? AND id <> ?').get(input.email, id))) {
    throw new HttpError(409, 'Cette adresse e-mail est déjà utilisée.');
  }
  const cur = await db.prepare('SELECT * FROM users WHERE id = ?').get(id) as unknown as UserRow;
  await db.prepare('UPDATE users SET name = ?, email = ?, email_notif = ? WHERE id = ?').run(
        input.name ?? cur.name, input.email ?? cur.email, input.emailNotif === undefined ? cur.email_notif : input.emailNotif ? 1 : 0, id,
      );
  emitAll({ type: 'members' });
  res.json({ user: (await publicUser({ ...cur, name: input.name ?? cur.name, email: input.email ?? cur.email })) });
});

accountApi.post('/me/password', limitAuthAttempts, async (req, res) => {
  const input = parse(
    z.object({
      current: z.string().min(1, 'Mot de passe actuel requis.'),
      next: z.string().min(8, 'Le nouveau mot de passe doit faire au moins 8 caractères.').max(200),
    }),
    req.body,
  );
  const row = await db.prepare('SELECT * FROM users WHERE id = ?').get(me(req).id) as unknown as UserRow;
  if (!bcrypt.compareSync(input.current, row.password_hash)) throw new HttpError(403, 'Mot de passe actuel incorrect.');
  await db.prepare('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?').run(
        bcrypt.hashSync(input.next, 10), row.id,
      );
  await logActivity(me(req), 'password', 'user', row.id, 'Mot de passe modifié');
  const fresh = { id: row.id, token_version: row.token_version + 1 };
  res.json({ token: signToken(fresh) });
});

/** Droit d'accès (RGPD) : export de toutes les données personnelles en un clic. */
accountApi.get('/me/export', async (req, res) => {
  const id = me(req).id;
  const q = async (sql: string) => await db.prepare(sql).all(id);
  const user = await db.prepare('SELECT id,name,email,role,email_notif,consented_at,created_at FROM users WHERE id = ?').get(id);
  res.setHeader('Content-Disposition', 'attachment; filename="mes-donnees-linklink.json"');
  res.json({
    exportedAt: now(),
    profil: user,
    messages: (await q('SELECT m.id, c.name AS salon, m.body, m.created_at FROM messages m JOIN channels c ON c.id = m.channel_id WHERE m.user_id = ?')),
    fichiers: (await q('SELECT id, name, mime, size, level, created_at FROM files WHERE user_id = ?')),
    taches_creees: (await q('SELECT id, title, status, priority, due_date, created_at FROM tasks WHERE created_by = ?')),
    taches_assignees: (await q('SELECT id, title, status, priority, due_date FROM tasks WHERE assignee_id = ?')),
    commentaires: (await q('SELECT id, task_id, body, created_at FROM task_comments WHERE user_id = ?')),
    rendez_vous_crees: (await q('SELECT id, title, starts_at FROM meetings WHERE created_by = ?')),
    reponses_rdv: (await q('SELECT meeting_id, status FROM rsvps WHERE user_id = ?')),
    notifications: (await q('SELECT type, title, body, created_at, read_at FROM notifications WHERE user_id = ?')),
    journal_activite: (await q('SELECT action, entity, summary, created_at FROM activity_log WHERE user_id = ?')),
  });
});

export async function eraseUser(userId: string) {
  const stored = (await db.prepare('SELECT stored_name FROM files WHERE user_id = ?').all(userId) as { stored_name: string }[]).map((f) => f.stored_name);
  const name = (await db.prepare('SELECT name FROM users WHERE id = ?').get(userId) as { name: string } | undefined)?.name ?? 'Ancien membre';
  await tx(async () => {
        await handOverTasksOf(userId, name); // tâches créées → propriété admin ; tâches assignées → non assignées
        await db.prepare("UPDATE activity_log SET user_name = 'Compte supprimé', user_id = NULL WHERE user_id = ?").run(userId);
        await db.prepare('DELETE FROM users WHERE id = ?').run(userId); // cascade : messages, fichiers, commentaires, notifications…
      });
  removeStored(stored);
  disconnectUser(userId);
  emitAll({ type: 'members' });
}

async function assertNotLastAdmin(userId: string) {
  const u = await db.prepare('SELECT role FROM users WHERE id = ?').get(userId) as { role: Role } | undefined;
  if (u?.role === 'admin' && (await db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin'").get() as { n: number }).n <= 1) {
    throw new HttpError(400, "Il doit rester un administrateur technique : transférez d'abord l'administration.");
  }
}

/** Droit à l'oubli : suppression du compte et de ses données (mot de passe demandé). */
accountApi.delete('/me', limitAuthAttempts, async (req, res) => {
  const { password } = parse(z.object({ password: z.string().min(1, 'Mot de passe requis.') }), req.body);
  const row = await db.prepare('SELECT * FROM users WHERE id = ?').get(me(req).id) as unknown as UserRow;
  if (!bcrypt.compareSync(password, row.password_hash)) throw new HttpError(403, 'Mot de passe incorrect.');
  await assertNotLastAdmin(row.id);
  await eraseUser(row.id);
  res.json({ ok: true });
});

/* --------------------------------- Équipe --------------------------------- */

accountApi.get('/members', async (_req, res) => {
  const online = new Set(onlineUserIds());
  const rows = await db.prepare('SELECT id, name, email, role, created_at, suspended_at FROM users ORDER BY created_at').all() as unknown as Pick<UserRow, 'id' | 'name' | 'email' | 'role' | 'created_at' | 'suspended_at'>[];
  res.json({ members: (await mapA(rows, async (r) => ({ ...(await publicUser(r)), createdAt: r.created_at, online: online.has(r.id), suspended: !!r.suspended_at }))) });
});

accountApi.patch('/members/:id/role', requireAdmin, async (req, res) => {
  const { role } = parse(z.object({ role: z.enum(['admin', 'member', 'guest']) }), req.body);
  const id = idParam(req);
  if (id === me(req).id) throw new HttpError(400, 'Vous ne pouvez pas modifier votre propre rôle.');
  const target = await db.prepare('SELECT id, name, role FROM users WHERE id = ?').get(id) as { id: string; name: string; role: Role } | undefined;
  if (!target) throw new HttpError(404, 'Membre introuvable.');
  if (role === 'admin' || target.role === 'admin') {
    throw new HttpError(400, "Le rôle d'administrateur technique ne change que par le transfert d'administration (menu Gouvernance).");
  }
  await db.prepare('UPDATE users SET role = ?, token_version = token_version + 1 WHERE id = ?').run(role, id);
  await logActivity(me(req), 'role', 'user', id, `Rôle de ${target.name} : ${target.role} → ${role}`);
  disconnectUser(id); // il devra se reconnecter pour appliquer son nouveau rôle
  emitAll({ type: 'members' });
  res.json({ ok: true });
});

accountApi.delete('/members/:id', requireAdmin, async (req, res) => {
  const id = idParam(req);
  if (id === me(req).id) throw new HttpError(400, 'Utilisez « Supprimer mon compte » pour votre propre compte.');
  const target = await db.prepare('SELECT name FROM users WHERE id = ?').get(id) as { name: string } | undefined;
  if (!target) throw new HttpError(404, 'Membre introuvable.');
  await logActivity(me(req), 'remove', 'user', id, `${target.name} a été retiré de l'équipe`);
  await eraseUser(id);
  res.json({ ok: true });
});

/* ------------------------- Codes d'invitation ------------------------- */

// Super Admin et Fondateurs peuvent inviter ; le code « invité » est réservé au Super Admin.
accountApi.get('/invite', requireStaff, async (req, res) => {
  res.json({
    code: (await getSetting('invite_code')),
    guestCode: me(req).role === 'admin' ? (await getSetting('guest_invite_code')) : undefined,
  });
});

accountApi.post('/invite/regenerate', requireAdmin, async (req, res) => {
  const { kind } = parse(z.object({ kind: z.enum(['member', 'guest']).default('member') }), req.body ?? {});
  const code = newInviteCode();
  await setSetting(kind === 'guest' ? 'guest_invite_code' : 'invite_code', code);
  await logActivity(me(req), 'invite', 'settings', kind, `Code d'invitation (${kind}) régénéré`);
  res.json({ code });
});

export { requireAuth };
