import { db, now, uid } from './db.js';
import { HttpError, type AuthUser } from './http.js';
import { notify } from './notify.js';

/* ------------------------------------------------------------------------------------------
 * Contrôle d'accès central (spécification v1.2, §3.3 et §3.5) : les règles sont écrites ici,
 * dans le code, et testées. Ordre : compte → rôle d'accès → périmètre → fonctions et mandats →
 * état de l'objet → conflits → validations. Tout refus est journalisé.
 * ---------------------------------------------------------------------------------------- */

export type Fn = 'pdg' | 'coordinator' | 'project_lead' | 'infra_lead' | 'treasurer' | 'comms';
export const FUNCTIONS: Record<Fn, { label: string; unique: boolean }> = {
  pdg: { label: 'PDG', unique: true },
  coordinator: { label: 'Coordinateur', unique: true },
  project_lead: { label: 'Chef de projet', unique: false },
  infra_lead: { label: "Chef d'infrastructures", unique: true },
  treasurer: { label: 'Caissier', unique: true },
  comms: { label: 'Chargé de communication', unique: true },
};
export const FN_KEYS = Object.keys(FUNCTIONS) as Fn[];

export type MandateScope = 'technical_ops' | 'spokesperson' | 'validator_replacement' | 'interim';
export type ValidationType = 'expense' | 'archive' | 'communication' | 'account';
export const VALIDATION_TYPES: ValidationType[] = ['expense', 'archive', 'communication', 'account'];

type UserLite = Pick<AuthUser, 'id' | 'role'> & { name?: string };

/* ----------------------------------- Comptes et absences ----------------------------------- */

export function isSuspended(userId: string | null | undefined): boolean {
  if (!userId) return true;
  const r = db.prepare('SELECT suspended_at FROM users WHERE id = ?').get(userId) as { suspended_at: string | null } | undefined;
  return !r || !!r.suspended_at;
}

export function hasActiveAbsence(userId: string): boolean {
  const d = now().slice(0, 10);
  return !!db.prepare('SELECT 1 FROM absences WHERE user_id = ? AND ended_at IS NULL AND starts_on <= ? AND ends_on >= ?').get(userId, d, d);
}

/** Disponible = compte actif et pas d'absence déclarée en cours. */
export const isAvailable = (userId: string) => !isSuspended(userId) && !hasActiveAbsence(userId);

/* ----------------------------------------- Fonctions ----------------------------------------- */

export function ownFunctions(userId: string): Fn[] {
  if (isSuspended(userId)) return [];
  return (db.prepare('SELECT fn FROM user_functions WHERE user_id = ? AND ended_at IS NULL').all(userId) as { fn: Fn }[]).map((r) => r.fn);
}

export interface MandateRow {
  id: string; grantor_id: string | null; grantee_id: string; scope: MandateScope; fn: Fn | null;
  validation_type: ValidationType | null; for_user_id: string | null; reason: string;
  starts_at: string; ends_at: string; revoked_at: string | null; created_at: string;
}

/** Mandats valides maintenant : non révoqués, dans leurs dates, accordés par un PDG existant, mandataire actif. */
export function activeMandates(userId: string, scope?: MandateScope): MandateRow[] {
  if (isSuspended(userId)) return [];
  const t = now();
  const rows = db
    .prepare('SELECT * FROM mandates WHERE grantee_id = ? AND revoked_at IS NULL AND starts_at <= ? AND ends_at > ?' + (scope ? ' AND scope = ?' : ''))
    .all(...(scope ? [userId, t, t, scope] : [userId, t, t])) as unknown as MandateRow[];
  return rows;
}

/** Fonctions effectives : fonctions propres + fonctions reçues par mandat d'intérim. */
export function functionsOf(userId: string): Fn[] {
  const set = new Set<Fn>(ownFunctions(userId));
  for (const m of activeMandates(userId, 'interim')) if (m.fn) set.add(m.fn);
  return [...set];
}

export const hasFn = (userId: string, fn: Fn) => functionsOf(userId).includes(fn);
export const hasOwnFn = (userId: string, fn: Fn) => ownFunctions(userId).includes(fn);

export function holders(fn: Fn): { id: string; name: string }[] {
  return db
    .prepare(
      `SELECT u.id, u.name FROM user_functions f JOIN users u ON u.id = f.user_id
       WHERE f.fn = ? AND f.ended_at IS NULL AND u.suspended_at IS NULL ORDER BY u.created_at`,
    )
    .all(fn) as { id: string; name: string }[];
}

export const pdgIds = () => holders('pdg').map((h) => h.id);
export const adminIds = () => (db.prepare("SELECT id FROM users WHERE role = 'admin' AND suspended_at IS NULL").all() as { id: string }[]).map((r) => r.id);

export const isGuest = (u: UserLite) => u.role === 'guest';
export const isAdminRole = (u: UserLite) => u.role === 'admin';

/** Lecture des données financières : fondateurs ; l'administrateur technique seulement s'il a une fonction métier. */
export const canReadFinance = (u: UserLite) => u.role === 'member' || (u.role === 'admin' && functionsOf(u.id).length > 0);

/* ------------------------------------------ Mandats ------------------------------------------ */

/**
 * Un titulaire de mandat de remplacement peut agir à la place du titulaire de la fonction `fn`
 * lorsque tous les titulaires sont indisponibles (§10.4) ou que la validation est en retard.
 */
export function replacementMandate(userId: string, fn: Fn, type: ValidationType, overdue = false): MandateRow | null {
  const hs = holders(fn).map((h) => h.id).filter((id) => id !== userId);
  const mandates = activeMandates(userId, 'validator_replacement').filter(
    (m) => (!m.validation_type || m.validation_type === type) && (!m.fn || m.fn === fn),
  );
  if (!mandates.length) return null;
  const allGone = hs.every((id) => !isAvailable(id));
  if (!allGone && !overdue) return null;
  return mandates[0] ?? null;
}

/** Cette personne peut-elle décider en tant que titulaire de `fn` (en propre, par intérim ou par mandat de remplacement) ? */
export function actsAs(userId: string, fn: Fn, type: ValidationType, overdue = false): { ok: boolean; mandateId: string | null } {
  if (hasFn(userId, fn)) {
    const own = ownFunctions(userId).includes(fn);
    return { ok: true, mandateId: own ? null : (activeMandates(userId, 'interim').find((m) => m.fn === fn)?.id ?? null) };
  }
  const m = replacementMandate(userId, fn, type, overdue);
  return m ? { ok: true, mandateId: m.id } : { ok: false, mandateId: null };
}

/* ------------------------------------------- Cumuls ------------------------------------------- */

export interface CumulResult { forbidden?: string; needsDecision?: string; warning?: string }

/** Régimes du §3.4 : interdit (PDG + Caissier), signalé avec décision (administrateur + PDG), signalé (communication + PDG). */
export function cumulCheck(userId: string, role: string, fn: Fn): CumulResult {
  const own = new Set(ownFunctions(userId));
  own.add(fn);
  if (own.has('pdg') && own.has('treasurer')) {
    return { forbidden: 'PDG et Caissier ne peuvent pas être cumulés : la même personne approuverait et paierait une dépense.' };
  }
  if (own.has('pdg') && role === 'admin') {
    return { needsDecision: "Administrateur technique et PDG : décision explicite journalisée obligatoire (champ « décision de cumul »)." };
  }
  if (own.has('pdg') && own.has('comms')) {
    return { warning: 'PDG et Chargé de communication : le circuit « annonce officielle » restera en attente d\'un validateur indépendant.' };
  }
  return {};
}

/* ------------------------------------------- Journal ------------------------------------------- */

export type AuditCategory = 'business' | 'security' | 'emergency';

export function audit(
  user: { id: string | null; name: string } | null,
  category: AuditCategory,
  action: string,
  entity: string,
  entityId: string,
  summary: string,
  extra: { details?: string; mandateId?: string | null; result?: 'ok' | 'denied' } = {},
) {
  db.prepare(
    'INSERT INTO audit_log (id,category,user_id,user_name,action,entity,entity_id,summary,details,mandate_id,result,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
  ).run(uid(), category, user?.id ?? null, user?.name ?? 'Système', action, entity, entityId, summary.slice(0, 400), (extra.details ?? '').slice(0, 1000), extra.mandateId ?? null, extra.result ?? 'ok', now());
}

/** Refus 403 journalisé ; au-delà de 5 refus par heure, alerte urgente au PDG et à l'administrateur technique (§11.4). */
export function deny(user: AuthUser, action: string, message: string, entity = '', entityId = ''): never {
  audit(user, 'security', action, entity, entityId, `Refusé : ${message}`, { result: 'denied' });
  const hourStart = new Date(Date.now() - 3600_000).toISOString();
  const n = (db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE user_id = ? AND result = 'denied' AND created_at > ?").get(user.id, hourStart) as { n: number }).n;
  if (n >= 5) {
    for (const id of new Set([...pdgIds(), ...adminIds()])) {
      if (id === user.id) continue;
      notify({ userId: id, type: 'security', category: 'urgent', title: `Refus d'accès répétés : ${user.name}`, body: `${n} actions refusées sur la dernière heure.`, link: '#journal', dedupeKey: `denials:${user.id}:${now().slice(0, 13)}` });
    }
  }
  throw new HttpError(403, message);
}

/* ------------------------------------------ Capacités ------------------------------------------ */

export type Capability =
  | 'project.create' | 'project.delete' | 'project.reopen' | 'project.confirm_archive'
  | 'function.assign' | 'mandate.grant' | 'rules.edit'
  | 'finance.read' | 'expense.create' | 'expense.pay'
  | 'announce.internal' | 'announce.service' | 'crisis.publish' | 'comm.publish' | 'comm.prepare' | 'comm.withdraw'
  | 'journal.business' | 'journal.security' | 'journal.emergency' | 'infra.read'
  | 'tech.ops' | 'account.suspend';

const NEED: Record<string, string> = {
  'project.create': 'le PDG ou le Coordinateur',
  'project.delete': 'le PDG',
  'project.reopen': 'le PDG',
  'project.confirm_archive': 'le PDG',
  'function.assign': 'le PDG',
  'mandate.grant': 'le PDG',
  'rules.edit': 'le PDG',
  'finance.read': 'un fondateur',
  'expense.create': 'un fondateur avec une fonction',
  'expense.pay': 'le Caissier',
  'announce.internal': 'le PDG ou le Chargé de communication',
  'announce.service': "l'administrateur technique ou le Chef d'infrastructures mandaté",
  'crisis.publish': 'le PDG, ou le Chargé de communication avec un mandat de porte-parole',
  'comm.publish': 'le Chargé de communication',
  'comm.prepare': 'un fondateur',
  'comm.withdraw': 'le PDG ou le Chargé de communication',
  'journal.business': 'le PDG',
  'journal.security': "l'administrateur technique ou le Chef d'infrastructures",
  'journal.emergency': 'un fondateur',
  'infra.read': 'un fondateur',
  'tech.ops': "l'administrateur technique ou le Chef d'infrastructures mandaté",
  'account.suspend': "l'administrateur technique",
};

export function can(u: UserLite, cap: Capability): boolean {
  if (isGuest(u) || isSuspended(u.id)) return false;
  const f = new Set(functionsOf(u.id));
  switch (cap) {
    case 'project.create': return f.has('pdg') || f.has('coordinator');
    case 'project.delete':
    case 'project.reopen':
    case 'project.confirm_archive':
    case 'function.assign':
    case 'mandate.grant':
    case 'rules.edit':
    case 'journal.business': return f.has('pdg');
    case 'finance.read': return canReadFinance(u);
    case 'expense.create': return u.role === 'member' || (u.role === 'admin' && f.size > 0);
    case 'expense.pay': return hasOwnFn(u.id, 'treasurer');
    case 'announce.internal': return f.has('pdg') || f.has('comms');
    case 'announce.service': return u.role === 'admin' || (f.has('infra_lead') && activeMandates(u.id, 'technical_ops').length > 0);
    case 'crisis.publish': return f.has('pdg') || (f.has('comms') && activeMandates(u.id, 'spokesperson').length > 0);
    case 'comm.publish': return f.has('comms');
    case 'comm.prepare': return u.role !== 'guest';
    case 'comm.withdraw': return f.has('pdg') || f.has('comms');
    case 'journal.security': return u.role === 'admin' || f.has('infra_lead');
    case 'journal.emergency':
    case 'infra.read': return true;
    case 'tech.ops': return u.role === 'admin' || (f.has('infra_lead') && activeMandates(u.id, 'technical_ops').length > 0);
    case 'account.suspend': return u.role === 'admin';
  }
}

export function requireCap(user: AuthUser, cap: Capability, attempt: string, entity = '', entityId = ''): void {
  if (!can(user, cap)) deny(user, attempt, `Action réservée à ${NEED[cap] ?? 'une fonction habilitée'}.`, entity, entityId);
}

/** Capacités exposées à l'interface (pour masquer les boutons ; le serveur reste seul juge). */
export function capabilitiesOf(u: UserLite): Record<Capability, boolean> {
  const caps = Object.keys(NEED) as Capability[];
  return Object.fromEntries(caps.map((c) => [c, can(u, c)])) as Record<Capability, boolean>;
}

/* ------------------------------------------ Projets ------------------------------------------ */

export const projectLeadOf = (projectId: string): string | null =>
  (db.prepare('SELECT lead_id FROM projects WHERE id = ?').get(projectId) as { lead_id: string | null } | undefined)?.lead_id ?? null;

/** Projet orphelin : pas de responsable, ou responsable suspendu / absent (§7). */
export function isOrphan(projectId: string): boolean {
  const lead = projectLeadOf(projectId);
  return !lead || !isAvailable(lead) || !hasOwnFn(lead, 'project_lead');
}

export const isProjectLead = (userId: string, projectId: string) => projectLeadOf(projectId) === userId && !isSuspended(userId) && hasOwnFn(userId, 'project_lead');

/* ------------------------------------------ Règles de relance ------------------------------------------ */

export interface RuleRow { type: ValidationType; first_reminder_h: number; interval_h: number; escalation_h: number }
export const rules = () => db.prepare('SELECT * FROM validation_rules').all() as unknown as RuleRow[];
export const ruleFor = (type: ValidationType): RuleRow =>
  (db.prepare('SELECT * FROM validation_rules WHERE type = ?').get(type) as unknown as RuleRow | undefined) ?? { type, first_reminder_h: 24, interval_h: 48, escalation_h: 120 };

/** Retard : la validation dépasse son délai d'escalade (déverrouille un mandat de remplacement). */
export const isOverdue = (type: ValidationType, since: string | null): boolean =>
  !!since && Date.now() - Date.parse(since) > ruleFor(type).escalation_h * 3600_000;

export const minor = (amount: number) => Math.round(amount * 100);
export const major = (m: number) => m / 100;
