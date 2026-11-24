import type { Request } from 'express';
import { hashPassword, verifyPassword } from '../passwords.js';
import { assertAccountOpen, recordAuthFailure } from '../ratelimit.js';
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { z } from 'zod';
import {
  actsAs, activeMandates, adminIds, audit, can, cumulCheck, deny, FN_KEYS, FUNCTIONS, functionsOf, hasActiveAbsence, holders, isAvailable,
  isOrphan, isOverdue, ownFunctions, pdgIds, requireCap, rules, ruleFor, type Fn, type ValidationType, VALIDATION_TYPES,
} from '../access.js';
import { db, now, tx, uid } from '../db.js';
import { HttpError, idParam, me, parse, type AuthUser } from '../http.js';
import { notify } from '../notify.js';
import { disconnectUser, emitAll } from '../realtime.js';
import { accountApprovers, pendingFor, pendingItems } from '../validations.js';
import { filterA, mapA } from "../async.js";

export const governanceApi = Router();

const nameOf = async (id: string | null | undefined) => (id ? ((await db.prepare('SELECT name FROM users WHERE id = ?').get(id) as { name: string } | undefined)?.name ?? 'Utilisateur supprimé') : 'Système');
const getUser = async (id: string) => {
  const u = await db.prepare('SELECT id, name, role, suspended_at FROM users WHERE id = ?').get(id) as { id: string; name: string; role: string; suspended_at: string | null } | undefined;
  if (!u) throw new HttpError(404, 'Membre introuvable.');
  return u;
};
const requireStaffUser = async (user: AuthUser) => {
  if (user.role === 'guest') throw await deny(user, 'guest_governance', "Les invités n'ont pas accès à la gouvernance de l'équipe.");
};
const notifyMany = async (ids: Iterable<string>, n: Omit<Parameters<typeof notify>[0], 'userId'>, except?: string) => {
  for (const id of new Set(ids)) if (id !== except) await notify({ ...n, userId: id });
};

/* ------------------------------------------ Fonctions ------------------------------------------ */

async function shapeFunctions() {
  return await mapA(FN_KEYS, async (fn) => ({
      fn,
      label: FUNCTIONS[fn].label,
      unique: FUNCTIONS[fn].unique,
      holders: (await mapA((await holders(fn)), async (h) => ({ ...h, available: (await isAvailable(h.id)) }))),
    }));
}

const orphanedLeadsOf = async (userId: string) =>
  await db.prepare("SELECT id, name FROM projects WHERE lead_id = ? AND status <> 'archived'").all(userId) as { id: string; name: string }[];

/** Un responsable de projet part (fonction retirée, suspension) : les projets deviennent orphelins, on prévient. */
export async function warnOrphans(userId: string, why: string) {
  const projects = await orphanedLeadsOf(userId);
  if (!projects.length) return;
  const to = [...(await pdgIds()), ...(await holders('coordinator')).map((h) => h.id)];
  for (const p of projects) {
    await notifyMany(to, { type: 'project', category: 'urgent', title: `Projet orphelin : ${p.name}`, body: why, link: `#projets/${p.id}`, dedupeKey: `orphan:${p.id}:${now().slice(0, 10)}` });
  }
}

governanceApi.get('/functions', async (req, res) => {
  await requireStaffUser(me(req));
  res.json({ functions: (await shapeFunctions()) });
});

const assignSchema = z.object({
  userId: z.string(),
  fn: z.enum(['pdg', 'coordinator', 'project_lead', 'infra_lead', 'treasurer', 'comms']),
  note: z.string().trim().max(300).optional().default(''),
  cumulDecision: z.string().trim().max(500).optional().default(''),
  replace: z.boolean().optional().default(false),
});

governanceApi.post('/functions', async (req, res) => {
  const user = me(req);
  const input = parse(assignSchema, req.body);
  const target = await getUser(input.userId);
  const noPdg = (await holders('pdg')).length === 0;
  // Règle de démarrage : tant qu'aucun PDG n'existe, l'administrateur technique peut en désigner un.
  if (!(input.fn === 'pdg' && noPdg && user.role === 'admin')) await requireCap(user, 'function.assign', 'function_assign', 'user', target.id);
  if (target.suspended_at) throw new HttpError(409, 'Ce compte est suspendu : il ne peut pas recevoir de fonction.');
  if (target.role === 'guest') throw new HttpError(409, "Un invité ne peut pas recevoir de fonction : il n'est pas fondateur.");
  const current = await holders(input.fn);
  if (current.some((h) => h.id === target.id)) throw new HttpError(409, `${target.name} a déjà la fonction ${FUNCTIONS[input.fn].label}.`);
  if (FUNCTIONS[input.fn].unique && current.length && !input.replace) {
    throw new HttpError(409, `La fonction ${FUNCTIONS[input.fn].label} est déjà tenue par ${current[0]?.name}. Confirmez le remplacement pour la transmettre.`);
  }
  const cumul = await cumulCheck(target.id, target.role, input.fn);
  if (cumul.forbidden) {
    await audit(user, 'security', 'function_cumul_refused', 'user', target.id, `Cumul refusé pour ${target.name} : ${cumul.forbidden}`, { result: 'denied' });
    throw new HttpError(409, cumul.forbidden);
  }
  if (cumul.needsDecision && input.cumulDecision.length < 10) {
    throw new HttpError(409, `${cumul.needsDecision} Renseignez la décision de cumul (au moins 10 caractères).`);
  }
  const replaced = FUNCTIONS[input.fn].unique ? current : [];
  await tx(async () => {
        for (const r of replaced) await db.prepare('UPDATE user_functions SET ended_at = ? WHERE user_id = ? AND fn = ? AND ended_at IS NULL').run(now(), r.id, input.fn);
        await db.prepare('INSERT INTO user_functions (id,user_id,fn,assigned_by,note,started_at) VALUES (?,?,?,?,?,?)').run(uid(), target.id, input.fn, user.id, input.note, now());
      });
  await audit(user, 'business', 'function_assign', 'user', target.id, `Fonction ${FUNCTIONS[input.fn].label} attribuée à ${target.name}${replaced.length ? ` (en remplacement de ${replaced.map((r) => r.name).join(', ')})` : ''}`, {
        details: [input.note, input.cumulDecision && `Décision de cumul : ${input.cumulDecision}`, cumul.warning].filter(Boolean).join(' | '),
      });
  if (cumul.needsDecision || cumul.warning) await audit(user, 'security', 'function_cumul', 'user', target.id, `Cumul autorisé pour ${target.name} : ${input.cumulDecision || cumul.warning}`);
  await notify({ userId: target.id, type: 'system', category: 'action', title: `Nouvelle fonction : ${FUNCTIONS[input.fn].label}`, body: input.note, link: '#equipe' });
  for (const r of replaced) {
    await notify({ userId: r.id, type: 'system', category: 'info', title: `Vous n'êtes plus ${FUNCTIONS[input.fn].label}`, link: '#equipe' });
    if (input.fn === 'project_lead') await warnOrphans(r.id, `${r.name} n'est plus chef de projet.`);
  }
  emitAll({ type: 'members' });
  res.status(201).json({ functions: (await shapeFunctions()), warning: cumul.warning ?? null });
});

governanceApi.delete('/functions/:fn/:userId', async (req, res) => {
  const user = me(req);
  const fn = parse(z.enum(['pdg', 'coordinator', 'project_lead', 'infra_lead', 'treasurer', 'comms']), idParam(req, 'fn')) as Fn;
  const target = await getUser(idParam(req, 'userId'));
  await requireCap(user, 'function.assign', 'function_remove', 'user', target.id);
  if (fn === 'pdg' && (await holders('pdg')).length <= 1) {
    throw new HttpError(409, 'Désignez d\'abord un successeur (remplacement) : l\'équipe ne peut pas rester sans PDG.');
  }
  const r = await db.prepare('UPDATE user_functions SET ended_at = ? WHERE user_id = ? AND fn = ? AND ended_at IS NULL').run(now(), target.id, fn);
  if (!r.changes) throw new HttpError(404, `${target.name} n'a pas cette fonction.`);
  await audit(user, 'business', 'function_remove', 'user', target.id, `Fonction ${FUNCTIONS[fn].label} retirée à ${target.name}`);
  await notify({ userId: target.id, type: 'system', title: `Fonction retirée : ${FUNCTIONS[fn].label}`, link: '#equipe' });
  if (fn === 'project_lead') await warnOrphans(target.id, `${target.name} n'est plus chef de projet.`);
  emitAll({ type: 'members' });
  res.json({ functions: (await shapeFunctions()) });
});

/* ------------------------------------------- Mandats ------------------------------------------- */

const shapeMandate = async (m: import('../access.js').MandateRow) => ({
  id: m.id, grantee: { id: m.grantee_id, name: (await nameOf(m.grantee_id)) }, grantor: (await nameOf(m.grantor_id)), scope: m.scope, fn: m.fn, validationType: m.validation_type,
  reason: m.reason, startsAt: m.starts_at, endsAt: m.ends_at, revokedAt: m.revoked_at, createdAt: m.created_at,
  active: !m.revoked_at && m.starts_at <= now() && m.ends_at > now(),
});

governanceApi.get('/mandates', async (req, res) => {
  await requireStaffUser(me(req));
  const rows = await db.prepare('SELECT * FROM mandates ORDER BY created_at DESC LIMIT 100').all() as unknown as import('../access.js').MandateRow[];
  res.json({ mandates: await mapA(rows, (m) => shapeMandate(m)) });
});

const mandateSchema = z.object({
  granteeId: z.string(),
  scope: z.enum(['technical_ops', 'spokesperson', 'validator_replacement', 'interim']),
  fn: z.enum(['pdg', 'coordinator', 'project_lead', 'infra_lead', 'treasurer', 'comms']).optional(),
  validationType: z.enum(['expense', 'archive', 'communication', 'account']).optional(),
  reason: z.string().trim().min(5, 'Le motif du mandat est obligatoire.').max(500),
  endsAt: z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'Date de fin invalide.'),
  startsAt: z.string().optional(),
});

const MAX_MANDATE_DAYS = 180;

governanceApi.post('/mandates', async (req, res) => {
  const user = me(req);
  await requireCap(user, 'mandate.grant', 'mandate_grant');
  const input = parse(mandateSchema, req.body);
  const grantee = await getUser(input.granteeId);
  if (grantee.suspended_at || grantee.role === 'guest') throw new HttpError(409, 'Le mandataire doit être un fondateur actif.');
  const start = input.startsAt && !Number.isNaN(Date.parse(input.startsAt)) ? new Date(input.startsAt).toISOString() : now();
  const end = new Date(input.endsAt).toISOString();
  if (end <= start) throw new HttpError(400, 'La date de fin doit être postérieure au début.');
  if (Date.parse(end) - Date.parse(start) > MAX_MANDATE_DAYS * 86_400_000) throw new HttpError(400, `Un mandat est limité dans le temps : ${MAX_MANDATE_DAYS} jours au maximum.`);
  if (input.scope === 'technical_ops' && !(await ownFunctions(grantee.id)).includes('infra_lead')) throw new HttpError(409, "Un mandat d'opérations techniques ne se donne qu'au Chef d'infrastructures.");
  if (input.scope === 'spokesperson' && !(await ownFunctions(grantee.id)).includes('comms')) throw new HttpError(409, 'Un mandat de porte-parole ne se donne qu\'au Chargé de communication.');
  if (input.scope === 'interim') {
    if (!input.fn) throw new HttpError(400, 'Indiquez la fonction assurée par intérim.');
    const own = new Set((await ownFunctions(grantee.id)));
    own.add(input.fn);
    if (own.has('pdg') && own.has('treasurer')) throw new HttpError(409, 'Interim refusé : PDG et Caissier ne peuvent pas être cumulés.');
  }
  if (input.scope === 'validator_replacement' && !input.validationType) throw new HttpError(400, 'Indiquez le type de validation remplacé.');
  const id = uid();
  await db.prepare('INSERT INTO mandates (id,grantor_id,grantee_id,scope,fn,validation_type,reason,starts_at,ends_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(
        id, user.id, grantee.id, input.scope, input.fn ?? null, input.validationType ?? null, input.reason, start, end, now(),
      );
  await audit(user, 'business', 'mandate_grant', 'mandate', id, `Mandat « ${input.scope} » donné à ${grantee.name} jusqu'au ${end.slice(0, 10)}`, { details: input.reason, mandateId: id });
  await notify({ userId: grantee.id, type: 'system', category: 'action', title: `Mandat reçu : ${input.scope}`, body: `${input.reason} (jusqu'au ${end.slice(0, 10)})`, link: '#equipe' });
  res.status(201).json({ mandate: (await shapeMandate(await db.prepare('SELECT * FROM mandates WHERE id = ?').get(id) as never)) });
});

governanceApi.delete('/mandates/:id', async (req, res) => {
  const user = me(req);
  const m = await db.prepare('SELECT * FROM mandates WHERE id = ?').get(idParam(req)) as unknown as import('../access.js').MandateRow | undefined;
  if (!m) throw new HttpError(404, 'Mandat introuvable.');
  if (m.grantor_id !== user.id) await requireCap(user, 'mandate.grant', 'mandate_revoke', 'mandate', m.id);
  if (m.revoked_at) throw new HttpError(409, 'Ce mandat est déjà révoqué.');
  await db.prepare('UPDATE mandates SET revoked_at = ? WHERE id = ?').run(now(), m.id);
  await audit(user, 'business', 'mandate_revoke', 'mandate', m.id, `Mandat « ${m.scope} » de ${(await nameOf(m.grantee_id))} révoqué`, { mandateId: m.id });
  await notify({ userId: m.grantee_id, type: 'system', title: `Mandat révoqué : ${m.scope}`, link: '#equipe' });
  res.json({ ok: true });
});

/* ------------------------------------------- Absences ------------------------------------------- */

governanceApi.get('/absences', async (req, res) => {
  await requireStaffUser(me(req));
  const rows = await db.prepare('SELECT * FROM absences WHERE ended_at IS NULL AND ends_on >= ? ORDER BY starts_on').all(now().slice(0, 10)) as { id: string; user_id: string; starts_on: string; ends_on: string; note: string }[];
  res.json({ absences: (await mapA(rows, async (a) => ({ id: a.id, user: { id: a.user_id, name: (await nameOf(a.user_id)) }, startsOn: a.starts_on, endsOn: a.ends_on, note: a.note, current: (await hasActiveAbsence(a.user_id)) }))) });
});

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date invalide (AAAA-MM-JJ).');
governanceApi.post('/absences', async (req, res) => {
  const user = me(req);
  await requireStaffUser(user);
  const input = parse(z.object({ userId: z.string().optional(), startsOn: dateSchema, endsOn: dateSchema, note: z.string().trim().max(300).optional().default('') }), req.body);
  const targetId = input.userId ?? user.id;
  const target = await getUser(targetId);
  if (targetId !== user.id && !((await can(user, 'function.assign')) || user.role === 'admin')) throw await deny(user, 'absence_for_other', "Seul le PDG ou l'administrateur technique peut déclarer l'absence d'un autre membre.", 'user', targetId);
  if (input.endsOn < input.startsOn) throw new HttpError(400, 'La fin doit être postérieure au début.');
  const id = uid();
  await db.prepare('INSERT INTO absences (id,user_id,starts_on,ends_on,note,declared_by,created_at) VALUES (?,?,?,?,?,?,?)').run(id, targetId, input.startsOn, input.endsOn, input.note, user.id, now());
  await audit(user, 'business', 'absence_declare', 'user', targetId, `Absence de ${target.name} du ${input.startsOn} au ${input.endsOn}`, { details: input.note });
  const fns = await ownFunctions(targetId);
  if (fns.length || (await orphanedLeadsOf(targetId)).length) {
    await notifyMany([...(await pdgIds()), ...(await adminIds())], { type: 'system', category: 'action', title: `Absence déclarée : ${target.name}`, body: `${fns.map((f) => FUNCTIONS[f].label).join(', ') || 'Responsable de projet'} — ${input.startsOn} → ${input.endsOn}. Pensez à un intérim.`, link: '#equipe' }, targetId);
  }
  if (input.startsOn <= now().slice(0, 10)) await warnOrphans(targetId, `${target.name} est absent·e.`);
  res.status(201).json({ id });
});

governanceApi.delete('/absences/:id', async (req, res) => {
  const user = me(req);
  const a = await db.prepare('SELECT * FROM absences WHERE id = ?').get(idParam(req)) as { id: string; user_id: string } | undefined;
  if (!a) throw new HttpError(404, 'Absence introuvable.');
  if (a.user_id !== user.id && !((await can(user, 'function.assign')) || user.role === 'admin')) throw await deny(user, 'absence_end_other', "Vous ne pouvez pas mettre fin à l'absence d'un autre membre.", 'user', a.user_id);
  await db.prepare('UPDATE absences SET ended_at = ? WHERE id = ?').run(now(), a.id);
  await audit(user, 'business', 'absence_end', 'user', a.user_id, `Absence de ${(await nameOf(a.user_id))} terminée`);
  res.json({ ok: true });
});

/* ----------------------------------- Règles de relance (PDG) ----------------------------------- */

governanceApi.get('/validation-rules', async (req, res) => {
  await requireStaffUser(me(req));
  res.json({ rules: (await rules()).map((r) => ({ type: r.type, firstReminderH: r.first_reminder_h, intervalH: r.interval_h, escalationH: r.escalation_h })) });
});

governanceApi.put('/validation-rules/:type', async (req, res) => {
  const user = me(req);
  await requireCap(user, 'rules.edit', 'rules_edit');
  const type = parse(z.enum(['expense', 'archive', 'communication', 'account']), idParam(req, 'type')) as ValidationType;
  const input = parse(z.object({ firstReminderH: z.number().int().min(1).max(720), intervalH: z.number().int().min(1).max(720), escalationH: z.number().int().min(1).max(2160) }), req.body);
  if (input.escalationH <= input.firstReminderH) throw new HttpError(400, "L'escalade doit venir après la première relance.");
  const before = await ruleFor(type);
  await db.prepare('UPDATE validation_rules SET first_reminder_h=?, interval_h=?, escalation_h=?, updated_by=?, updated_at=? WHERE type=?').run(input.firstReminderH, input.intervalH, input.escalationH, user.id, now(), type);
  await audit(user, 'business', 'rules_edit', 'validation_rule', type, `Relances « ${type} » : ${before.first_reminder_h}/${before.interval_h}/${before.escalation_h} h → ${input.firstReminderH}/${input.intervalH}/${input.escalationH} h`);
  res.json({ ok: true });
});

/* ------------------------------------------- Journaux ------------------------------------------- */

governanceApi.get('/journal/:category', async (req, res) => {
  const user = me(req);
  const category = parse(z.enum(['business', 'security', 'emergency']), idParam(req, 'category'));
  await requireCap(user, category === 'business' ? 'journal.business' : category === 'security' ? 'journal.security' : 'journal.emergency', `journal_${category}`);
  if (user.role === 'guest') throw await deny(user, 'journal_guest', 'Réservé aux fondateurs.');
  const q = String(req.query.q ?? '').trim().toLowerCase();
  const limit = Math.min(Number(req.query.limit) || 100, 300);
  const rows = await db.prepare('SELECT * FROM audit_log WHERE category = ? ORDER BY created_at DESC, rowid DESC LIMIT 1000').all(category) as {
    id: string; user_id: string | null; user_name: string; action: string; entity: string; entity_id: string; summary: string; details: string; mandate_id: string | null; result: string; created_at: string;
  }[];
  res.json({
    category,
    entries: rows
      .filter((r) => !q || `${r.user_name} ${r.action} ${r.summary} ${r.details}`.toLowerCase().includes(q))
      .slice(0, limit)
      .map((r) => ({ id: r.id, userName: r.user_name, action: r.action, entity: r.entity, entityId: r.entity_id, summary: r.summary, details: r.details, mandate: !!r.mandate_id, result: r.result, createdAt: r.created_at })),
  });
});

/* ------------------------------------------ Validations ------------------------------------------ */

governanceApi.get('/validations', async (req, res) => {
  const user = me(req);
  await requireStaffUser(user);
  const mine = await pendingFor(user.id, user.role);
  res.json({
    pending: mine.map((i) => ({ type: i.type, id: i.id, title: i.title, detail: i.detail, since: i.since, link: i.link, blocked: i.blocked, blockedReason: i.blockedReason, overdue: i.overdue, canDecide: i.approvers.includes(user.id) })),
  });
});

governanceApi.get('/governance/overview', async (req, res) => {
  const user = me(req);
  await requireStaffUser(user);
  await expireEmergency();
  const orphans = await filterA((await db.prepare("SELECT id, name FROM projects WHERE status IN ('active','paused')").all() as { id: string; name: string }[]), async (p) => await isOrphan(p.id));
  const discrepancies = (await db.prepare("SELECT COUNT(*) AS n FROM expenses WHERE status = 'discrepancy'").get() as { n: number }).n;
  res.json({
    functions: (await shapeFunctions()),
    me: { functions: (await ownFunctions(user.id)), effectiveFunctions: (await functionsOf(user.id)), mandates: (await activeMandates(user.id)).map((m) => ({ id: m.id, scope: m.scope, fn: m.fn, endsAt: m.ends_at })) },
    blocked: (await pendingItems()).filter((i) => i.blocked).map((i) => ({ type: i.type, id: i.id, title: i.title, reason: i.blockedReason, link: i.link })),
    orphans,
    discrepancies,
  });
});

/* ------------------------------------- Accès d'urgence (§12) ------------------------------------- */

const EMERGENCY_PENDING_MIN = 30;
const EMERGENCY_ACTIVE_H = 2;

export async function expireEmergency() {
  const t = now();
  for (const s of await db.prepare("SELECT id, state FROM emergency_sessions WHERE state IN ('pending','active') AND expires_at < ?").all(t) as { id: string; state: string }[]) {
    await db.prepare("UPDATE emergency_sessions SET state = 'expired', closed_at = ? WHERE id = ?").run(t, s.id);
    await audit(null, 'emergency', 'emergency_expired', 'emergency', s.id, `Accès d'urgence expiré automatiquement (${s.state === 'active' ? 'fin de la durée limitée' : 'seconde confirmation non reçue'})`);
  }
}

const emergencyHolders = async () => await db.prepare('SELECT user_id, code_hash, code_set_at FROM emergency_holders').all() as { user_id: string; code_hash: string | null; code_set_at: string | null }[];
const currentSession = async () => await db.prepare("SELECT * FROM emergency_sessions WHERE state IN ('pending','active') ORDER BY created_at DESC LIMIT 1").get() as
  | { id: string; state: 'pending' | 'active'; first_holder: string; second_holder: string | null; created_at: string; activated_at: string | null; expires_at: string; note: string }
  | undefined;

async function shapeEmergency(user: AuthUser) {
  await expireEmergency();
  const hs = await emergencyHolders();
  const s = await currentSession();
  const mine = hs.find((h) => h.user_id === user.id);
  return {
    holders: (await mapA(hs, async (h) => ({ id: h.user_id, name: (await nameOf(h.user_id)), codeSet: !!h.code_hash }))),
    ready: hs.length === 2 && hs.every((h) => !!h.code_hash),
    isHolder: !!mine,
    codeSet: !!mine?.code_hash,
    canDesignate: (await can(user, 'function.assign')),
    session: s ? { id: s.id, state: s.state, firstHolder: (await nameOf(s.first_holder)), secondHolder: s.second_holder ? (await nameOf(s.second_holder)) : null, createdAt: s.created_at, activatedAt: s.activated_at, expiresAt: s.expires_at, canConfirm: s.state === 'pending' && !!mine && s.first_holder !== user.id, mine: s.first_holder === user.id || s.second_holder === user.id } : null,
  };
}

governanceApi.get('/emergency', async (req, res) => {
  await requireStaffUser(me(req));
  res.json({ emergency: (await shapeEmergency(me(req))) });
});

governanceApi.put('/emergency/holders', async (req, res) => {
  const user = me(req);
  await requireCap(user, 'function.assign', 'emergency_designate');
  const { userIds } = parse(z.object({ userIds: z.array(z.string()).length(2, 'Désignez exactement deux détenteurs.') }), req.body);
  if (new Set(userIds).size !== 2) throw new HttpError(400, 'Les deux détenteurs doivent être deux personnes différentes.');
  for (const id of userIds) {
    const u = await getUser(id);
    if (u.role !== 'member' || u.suspended_at) throw new HttpError(409, `${u.name} ne peut pas être détenteur : un fondateur actif est requis (l'administrateur technique et les invités sont exclus).`);
  }
  await tx(async () => {
        for (const h of (await emergencyHolders())) if (!userIds.includes(h.user_id)) await db.prepare('DELETE FROM emergency_holders WHERE user_id = ?').run(h.user_id);
        for (const id of userIds) await db.prepare('INSERT OR IGNORE INTO emergency_holders (user_id, designated_by, designated_at) VALUES (?,?,?)').run(id, user.id, now());
      });
  await audit(user, 'emergency', 'emergency_holders', 'emergency', '', `Détenteurs d'urgence désignés : ${(await mapA(userIds, (u) => nameOf(u))).join(' et ')}`);
  for (const id of userIds) await notify({ userId: id, type: 'security', category: 'action', title: "Vous êtes détenteur d'un accès d'urgence", body: 'Définissez votre code personnel depuis votre profil (jamais partagé).', link: '#profil' });
  res.json({ emergency: (await shapeEmergency(user)) });
});

governanceApi.post('/emergency/code', async (req, res) => {
  const user = me(req);
  const { code, password } = parse(z.object({ code: z.string().min(10, 'Le code doit faire au moins 10 caractères.').max(100), password: z.string().min(1) }), req.body);
  if (!(await emergencyHolders()).some((h) => h.user_id === user.id)) throw await deny(user, 'emergency_code_not_holder', "Vous n'êtes pas détenteur d'un accès d'urgence.");
  const row = await db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id) as { password_hash: string };
  await assertAccountOpen(`pw:${user.id}`);
  if (!(await verifyPassword(password, row.password_hash)).ok) {
    await recordAuthFailure(req, `pw:${user.id}`, 'code d\'urgence');
    throw new HttpError(403, 'Mot de passe incorrect.');
  }
  await db.prepare('UPDATE emergency_holders SET code_hash = ?, code_set_at = ? WHERE user_id = ?').run(await hashPassword(code), now(), user.id);
  await audit(user, 'emergency', 'emergency_code_set', 'emergency', user.id, `${user.name} a défini son code d'urgence`);
  res.json({ emergency: (await shapeEmergency(user)) });
});

async function checkCode(user: AuthUser, code: string, req: Request) {
  const h = (await emergencyHolders()).find((x) => x.user_id === user.id);
  if (!h?.code_hash) throw await deny(user, 'emergency_no_code', "Vous n'avez pas de code d'urgence valide.");
  await assertAccountOpen(`emergency:${user.id}`);
  if (!(await verifyPassword(code, h.code_hash)).ok) {
    await recordAuthFailure(req, `emergency:${user.id}`, 'code d\'urgence');
    await audit(user, 'emergency', 'emergency_bad_code', 'emergency', '', `Code d'urgence incorrect saisi par ${user.name}`, { result: 'denied' });
    await notifyMany([...(await pdgIds()), ...(await adminIds())], { type: 'security', category: 'urgent', title: `Code d'urgence incorrect : ${user.name}`, link: '#journal' }, user.id);
    throw new HttpError(403, "Code d'urgence incorrect.");
  }
}

governanceApi.post('/emergency/sessions', async (req, res) => {
  const user = me(req);
  const { code, note } = parse(z.object({ code: z.string().min(1), note: z.string().trim().max(500).optional().default('') }), req.body);
  await expireEmergency();
  if ((await currentSession())) throw new HttpError(409, "Une procédure d'urgence est déjà en cours.");
  const hs = await emergencyHolders();
  if (hs.length !== 2 || hs.some((h) => !h.code_hash)) throw new HttpError(409, "Les deux détenteurs doivent d'abord être désignés et avoir défini leur code.");
  await checkCode(user, code, req);
  const id = uid();
  await db.prepare("INSERT INTO emergency_sessions (id,state,first_holder,created_at,expires_at,note) VALUES (?,?,?,?,?,?)").run(id, 'pending', user.id, now(), new Date(Date.now() + EMERGENCY_PENDING_MIN * 60_000).toISOString(), note);
  await audit(user, 'emergency', 'emergency_start', 'emergency', id, `${user.name} a demandé un accès d'urgence — seconde confirmation attendue`, { details: note });
  const other = hs.find((h) => h.user_id !== user.id)?.user_id;
  await notifyMany([other, ...(await pdgIds()), ...(await adminIds())].filter(Boolean) as string[], { type: 'security', category: 'urgent', title: "Accès d'urgence demandé", body: `${user.name} demande l'accès d'urgence. Le second détenteur doit confirmer sous ${EMERGENCY_PENDING_MIN} min.`, link: '#equipe' }, user.id);
  res.status(201).json({ emergency: (await shapeEmergency(user)) });
});

governanceApi.post('/emergency/sessions/:id/confirm', async (req, res) => {
  const user = me(req);
  const { code } = parse(z.object({ code: z.string().min(1) }), req.body);
  await expireEmergency();
  const s = await currentSession();
  if (!s || s.id !== idParam(req) || s.state !== 'pending') throw new HttpError(409, 'Aucune demande en attente de confirmation (elle a peut-être expiré).');
  if (s.first_holder === user.id) throw new HttpError(403, "L'activation exige deux personnes différentes : vous ne pouvez pas confirmer votre propre demande.");
  await checkCode(user, code, req);
  await db.prepare("UPDATE emergency_sessions SET state='active', second_holder=?, activated_at=?, expires_at=? WHERE id=?").run(user.id, now(), new Date(Date.now() + EMERGENCY_ACTIVE_H * 3600_000).toISOString(), s.id);
  await audit(user, 'emergency', 'emergency_activate', 'emergency', s.id, `Accès d'urgence activé par ${(await nameOf(s.first_holder))} et ${user.name} (durée limitée : ${EMERGENCY_ACTIVE_H} h)`);
  const everyone = (await db.prepare("SELECT id FROM users WHERE suspended_at IS NULL AND role <> 'guest'").all() as { id: string }[]).map((r) => r.id);
  await notifyMany(everyone, { type: 'security', category: 'urgent', title: "Accès d'urgence activé", body: `Activé par ${(await nameOf(s.first_holder))} et ${user.name}. Consultez le journal d'urgence.`, link: '#journal' });
  res.json({ emergency: (await shapeEmergency(user)) });
});

async function activeSessionFor(user: AuthUser, id: string) {
  await expireEmergency();
  const s = await currentSession();
  if (!s || s.id !== id || s.state !== 'active') throw new HttpError(409, "Aucun accès d'urgence actif (il a peut-être expiré).");
  if (s.first_holder !== user.id && s.second_holder !== user.id) throw await deny(user, 'emergency_not_participant', "Seuls les deux détenteurs qui ont activé l'accès peuvent l'utiliser.");
  return s;
}

governanceApi.get('/emergency/sessions/:id/backups', async (req, res) => {
  const user = me(req);
  const s = await activeSessionFor(user, idParam(req));
  await audit(user, 'emergency', 'emergency_backups_list', 'emergency', s.id, `${user.name} a consulté la liste des sauvegardes`);
  // Les sauvegardes sont gérées par PostgreSQL (restauration à un instant donné, côté hébergeur) : aucun fichier local à lister.
  const files: { name: string; size: number; at: string }[] = [];
  res.json({ backups: files.sort((a, b) => b.at.localeCompare(a.at)) });
});

/** Seule action sensible permise : réinitialiser le mot de passe de l'administrateur technique (§12.2). */
governanceApi.post('/emergency/sessions/:id/admin-reset', async (req, res) => {
  const user = me(req);
  const s = await activeSessionFor(user, idParam(req));
  const { newPassword } = parse(z.object({ newPassword: z.string().min(12, 'Le mot de passe doit faire au moins 12 caractères.').max(200) }), req.body);
  const admin = await db.prepare("SELECT id, name FROM users WHERE role = 'admin' AND suspended_at IS NULL LIMIT 1").get() as { id: string; name: string } | undefined;
  if (!admin) throw new HttpError(404, "Aucun administrateur technique actif.");
  await db.prepare('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?').run(await hashPassword(newPassword), admin.id);
  disconnectUser(admin.id);
  await audit(user, 'emergency', 'emergency_admin_reset', 'user', admin.id, `Mot de passe de l'administrateur technique ${admin.name} réinitialisé par ${user.name}`);
  const everyone = (await db.prepare("SELECT id FROM users WHERE suspended_at IS NULL AND role <> 'guest'").all() as { id: string }[]).map((r) => r.id);
  await notifyMany(everyone, { type: 'security', category: 'urgent', title: "Mot de passe de l'administrateur réinitialisé (urgence)", link: '#journal' });
  void s;
  res.json({ ok: true });
});

governanceApi.post('/emergency/sessions/:id/close', async (req, res) => {
  const user = me(req);
  await expireEmergency();
  const s = await currentSession();
  if (!s || s.id !== idParam(req)) throw new HttpError(409, "Cette procédure d'urgence n'est plus en cours.");
  if (s.first_holder !== user.id && s.second_holder !== user.id && !(await can(user, 'function.assign')) && user.role !== 'admin') throw await deny(user, 'emergency_close', 'Action réservée aux détenteurs, au PDG ou à l\'administrateur technique.');
  await db.prepare("UPDATE emergency_sessions SET state='closed', closed_at=? WHERE id=?").run(now(), s.id);
  await audit(user, 'emergency', 'emergency_close', 'emergency', s.id, `Accès d'urgence clos par ${user.name}`);
  await notifyMany([...(await pdgIds()), ...(await adminIds())], { type: 'security', title: "Accès d'urgence clos", link: '#journal' }, user.id);
  res.json({ emergency: (await shapeEmergency(user)) });
});

/* ------------------------------ Transfert de l'administration technique (§12.5) ------------------------------ */

interface TransferRow { id: string; from_user: string; to_user: string; state: 'pending' | 'verifying' | 'done' | 'refused'; decided_by: string | null; motive: string; created_at: string; updated_at: string }
const activeTransfer = async () => await db.prepare("SELECT * FROM admin_transfers WHERE state IN ('pending','verifying') ORDER BY created_at DESC LIMIT 1").get() as unknown as TransferRow | undefined;
const shapeTransfer = async (t: TransferRow | undefined) =>
  t ? { id: t.id, from: { id: t.from_user, name: (await nameOf(t.from_user)) }, to: { id: t.to_user, name: (await nameOf(t.to_user)) }, state: t.state, motive: t.motive, createdAt: t.created_at } : null;

governanceApi.get('/admin-transfer', async (req, res) => {
  const user = me(req);
  await requireStaffUser(user);
  const t = await activeTransfer();
  const last = await db.prepare('SELECT * FROM admin_transfers ORDER BY created_at DESC LIMIT 5').all() as unknown as TransferRow[];
  res.json({ transfer: (await shapeTransfer(t)), history: await mapA(last, (x) => shapeTransfer(x)), canRequest: user.role === 'admin' && !t, canDecide: !!t && t.state === 'pending' && (await transferApprovers(t)).includes(user.id), canConfirm: !!t && t.state === 'verifying' && t.to_user === user.id });
});

async function transferApprovers(t: TransferRow): Promise<string[]> {
  const exclude = new Set([t.from_user, t.to_user]);
  const pdgs = await filterA((await holders('pdg')).map((h) => h.id), async (id) => !exclude.has(id) && (await isAvailable(id)));
  if (pdgs.length) return pdgs;
  return await filterA((await db.prepare("SELECT id FROM users WHERE role = 'member' AND suspended_at IS NULL").all() as { id: string }[]).map((r) => r.id), async (id) => !exclude.has(id) && (await isAvailable(id)));
}

governanceApi.post('/admin-transfer', async (req, res) => {
  const user = me(req);
  if (user.role !== 'admin') throw await deny(user, 'admin_transfer_request', "Seul l'administrateur technique peut demander son transfert.");
  const { toUserId, motive } = parse(z.object({ toUserId: z.string(), motive: z.string().trim().min(5, 'Le motif est obligatoire.').max(500) }), req.body);
  if ((await activeTransfer())) throw new HttpError(409, 'Un transfert est déjà en cours.');
  const to = await getUser(toUserId);
  if (to.id === user.id) throw new HttpError(400, 'Choisissez un autre membre.');
  if (to.role !== 'member' || to.suspended_at) throw new HttpError(409, 'Le successeur doit être un fondateur actif.');
  const id = uid();
  await db.prepare("INSERT INTO admin_transfers (id,from_user,to_user,state,motive,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run(id, user.id, to.id, 'pending', motive, now(), now());
  await audit(user, 'security', 'admin_transfer_request', 'user', to.id, `Transfert de l'administration technique demandé : ${user.name} → ${to.name}`, { details: motive });
  const t = await activeTransfer() as TransferRow;
  await notifyMany((await transferApprovers(t)), { type: 'validation', category: 'action', title: "Transfert de l'administration technique à valider", body: `${user.name} → ${to.name}`, link: '#equipe' });
  res.status(201).json({ transfer: (await shapeTransfer(t)) });
});

governanceApi.post('/admin-transfer/:id/decision', async (req, res) => {
  const user = me(req);
  const { decision, motive } = parse(z.object({ decision: z.enum(['approve', 'refuse']), motive: z.string().trim().max(500).optional().default('') }), req.body);
  const t = await activeTransfer();
  if (!t || t.id !== idParam(req) || t.state !== 'pending') throw new HttpError(409, "Ce transfert n'attend plus de décision.");
  if (!(await transferApprovers(t)).includes(user.id)) throw await deny(user, 'admin_transfer_decide', 'La validation revient au PDG (ou, à défaut, à un autre fondateur sans conflit).', 'admin_transfer', t.id);
  if (decision === 'refuse') {
    if (motive.length < 3) throw new HttpError(400, 'Un refus doit être motivé.');
    await db.prepare("UPDATE admin_transfers SET state='refused', decided_by=?, motive=motive||?, updated_at=? WHERE id=?").run(user.id, ` | Refus : ${motive}`, now(), t.id);
    await audit(user, 'security', 'admin_transfer_refused', 'user', t.to_user, `Transfert d'administration refusé par ${user.name}`, { details: motive });
    await notify({ userId: t.from_user, type: 'security', title: "Transfert d'administration refusé", body: motive, link: '#equipe' });
    return res.json({ transfer: null });
  }
  // Étape intermédiaire : le successeur devient administrateur, puis doit confirmer son accès avant la rétrogradation de l'ancien.
  await tx(async () => {
        await db.prepare("UPDATE users SET role = 'admin', token_version = token_version + 1 WHERE id = ?").run(t.to_user);
        await db.prepare("UPDATE admin_transfers SET state='verifying', decided_by=?, updated_at=? WHERE id=?").run(user.id, now(), t.id);
      });
  disconnectUser(t.to_user);
  await audit(user, 'security', 'admin_transfer_approved', 'user', t.to_user, `Transfert d'administration validé par ${user.name} : ${(await nameOf(t.to_user))} est promu, en attente de sa confirmation`);
  await notify({ userId: t.to_user, type: 'security', category: 'action', title: "Confirmez votre accès d'administrateur technique", body: "Reconnectez-vous puis confirmez : l'ancien administrateur sera alors rétrogradé.", link: '#equipe' });
  res.json({ transfer: (await shapeTransfer((await activeTransfer()))) });
});

governanceApi.post('/admin-transfer/:id/confirm', async (req, res) => {
  const user = me(req);
  const t = await activeTransfer();
  if (!t || t.id !== idParam(req) || t.state !== 'verifying') throw new HttpError(409, "Ce transfert n'attend pas de confirmation.");
  if (t.to_user !== user.id) throw await deny(user, 'admin_transfer_confirm', 'Seul le successeur désigné peut confirmer.', 'admin_transfer', t.id);
  await tx(async () => {
        await db.prepare("UPDATE users SET role = 'member', token_version = token_version + 1 WHERE id = ?").run(t.from_user);
        await db.prepare("UPDATE admin_transfers SET state='done', updated_at=? WHERE id=?").run(now(), t.id);
      });
  disconnectUser(t.from_user);
  await audit(user, 'security', 'admin_transfer_done', 'user', t.to_user, `Administration technique transférée : ${(await nameOf(t.from_user))} → ${user.name}`);
  await notifyMany([...(await pdgIds()), t.from_user], { type: 'security', category: 'info', title: "Administration technique transférée", body: `Nouvel administrateur : ${user.name}`, link: '#equipe' }, user.id);
  emitAll({ type: 'members' });
  res.json({ ok: true });
});

governanceApi.post('/admin-transfer/:id/cancel', async (req, res) => {
  const user = me(req);
  const t = await activeTransfer();
  if (!t || t.id !== idParam(req)) throw new HttpError(409, "Ce transfert n'est plus en cours.");
  if (t.from_user !== user.id && !(await can(user, 'function.assign'))) throw await deny(user, 'admin_transfer_cancel', "Seuls l'administrateur sortant ou le PDG peuvent annuler.", 'admin_transfer', t.id);
  await tx(async () => {
        if (t.state === 'verifying') await db.prepare("UPDATE users SET role = 'member', token_version = token_version + 1 WHERE id = ? AND role = 'admin'").run(t.to_user);
        await db.prepare("UPDATE admin_transfers SET state='refused', updated_at=?, motive=motive||' | Annulé' WHERE id=?").run(now(), t.id);
      });
  if (t.state === 'verifying') disconnectUser(t.to_user);
  await audit(user, 'security', 'admin_transfer_cancelled', 'user', t.to_user, `Transfert d'administration annulé par ${user.name}`);
  res.json({ ok: true });
});

/* ------------------------------------ Suspension de compte (§12.3) ------------------------------------ */

const shapeAction = async (a: { id: string; user_id: string; user_name: string; action: string; reason: string; status: string; motive: string; created_at: string; requested_by: string | null }, userId: string) => ({
  id: a.id, userId: a.user_id, userName: a.user_name, action: a.action, reason: a.reason, status: a.status, motive: a.motive, createdAt: a.created_at, requestedBy: (await nameOf(a.requested_by)),
  canDecide: a.status === 'pending' && (await accountApprovers(a)).approvers.includes(userId),
});

governanceApi.get('/account-actions', async (req, res) => {
  const user = me(req);
  await requireStaffUser(user);
  const rows = await db.prepare('SELECT * FROM account_actions ORDER BY created_at DESC LIMIT 50').all() as never as Parameters<typeof shapeAction>[0][];
  res.json({ actions: (await mapA(rows, async (a) => await shapeAction(a, user.id))) });
});

function requestAccountAction(action: 'suspend' | 'reactivate') {
  return async (req: import('express').Request, res: import('express').Response) => {
    const user = me(req);
    await requireCap(user, 'account.suspend', `account_${action}_request`);
    const { reason } = parse(z.object({ reason: z.string().trim().min(5, 'Le motif est obligatoire.').max(500) }), req.body);
    const target = await getUser(idParam(req));
    if (target.id === user.id) throw new HttpError(400, 'Vous ne pouvez pas agir sur votre propre compte.');
    if (target.role === 'admin') throw new HttpError(409, "Le compte de l'administrateur technique ne se suspend pas : utilisez le transfert ou l'accès d'urgence.");
    if (action === 'suspend' && target.suspended_at) throw new HttpError(409, 'Ce compte est déjà suspendu.');
    if (action === 'reactivate' && !target.suspended_at) throw new HttpError(409, "Ce compte n'est pas suspendu.");
    if ((await db.prepare("SELECT 1 FROM account_actions WHERE user_id = ? AND status = 'pending'").get(target.id))) throw new HttpError(409, 'Une demande est déjà en attente pour ce compte.');
    const id = uid();
    await db.prepare('INSERT INTO account_actions (id,user_id,user_name,action,reason,requested_by,created_at) VALUES (?,?,?,?,?,?,?)').run(id, target.id, target.name, action, reason, user.id, now());
    await audit(user, 'security', `account_${action}_request`, 'user', target.id, `${action === 'suspend' ? 'Suspension' : 'Réactivation'} du compte de ${target.name} demandée`, { details: reason });
    const row = await db.prepare('SELECT * FROM account_actions WHERE id = ?').get(id) as never as Parameters<typeof shapeAction>[0];
    await notifyMany((await accountApprovers(row as never)).approvers, { type: 'validation', category: 'action', title: `${action === 'suspend' ? 'Suspension' : 'Réactivation'} à valider : ${target.name}`, body: reason, link: '#equipe' });
    res.status(201).json({ action: (await shapeAction(row, user.id)) });
  };
}
governanceApi.post('/members/:id/suspension', requestAccountAction('suspend'));
governanceApi.post('/members/:id/reactivation', requestAccountAction('reactivate'));

governanceApi.post('/account-actions/:id/decision', async (req, res) => {
  const user = me(req);
  const { decision, motive } = parse(z.object({ decision: z.enum(['approve', 'refuse']), motive: z.string().trim().max(500).optional().default('') }), req.body);
  const a = await db.prepare('SELECT * FROM account_actions WHERE id = ?').get(idParam(req)) as never as (Parameters<typeof shapeAction>[0] & { status: string }) | undefined;
  if (!a) throw new HttpError(404, 'Demande introuvable.');
  if (a.status !== 'pending') throw new HttpError(409, 'Cette demande a déjà été traitée.');
  if (!(await accountApprovers(a as never)).approvers.includes(user.id)) throw await deny(user, 'account_action_decide', 'La validation revient au PDG (ou, à défaut, à un autre fondateur sans conflit).', 'user', a.user_id);
  if (decision === 'refuse' && motive.length < 3) throw new HttpError(400, 'Un refus doit être motivé.');
  await tx(async () => {
        await db.prepare('UPDATE account_actions SET status = ?, decided_by = ?, motive = ?, decided_at = ? WHERE id = ?').run(decision === 'approve' ? 'approved' : 'refused', user.id, motive, now(), a.id);
        if (decision !== 'approve') return;
        if (a.action === 'suspend') {
          await db.prepare('UPDATE users SET suspended_at = ?, token_version = token_version + 1 WHERE id = ?').run(now(), a.user_id);
          await db.prepare('UPDATE user_functions SET ended_at = ? WHERE user_id = ? AND ended_at IS NULL').run(now(), a.user_id);
          await db.prepare('UPDATE mandates SET revoked_at = ? WHERE (grantee_id = ? OR grantor_id = ?) AND revoked_at IS NULL').run(now(), a.user_id, a.user_id);
        } else {
          await db.prepare('UPDATE users SET suspended_at = NULL, token_version = token_version + 1 WHERE id = ?').run(a.user_id);
        }
      });
  await audit(user, 'security', `account_${a.action}_${decision}`, 'user', a.user_id, `${a.action === 'suspend' ? 'Suspension' : 'Réactivation'} de ${a.user_name} ${decision === 'approve' ? 'validée' : 'refusée'} par ${user.name}`, { details: motive });
  if (decision === 'approve' && a.action === 'suspend') {
    disconnectUser(a.user_id);
    await warnOrphans(a.user_id, `${a.user_name} est suspendu·e.`);
  }
  await notify({ userId: a.requested_by ?? '', type: 'security', title: `Demande ${decision === 'approve' ? 'validée' : 'refusée'} : ${a.user_name}`, body: motive, link: '#equipe' });
  emitAll({ type: 'members' });
  res.json({ ok: true });
});

void isOverdue;
void VALIDATION_TYPES;
void actsAs;
