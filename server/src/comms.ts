import { db, now } from './db.js';
import { actsAs, isAvailable, isOrphan, isOverdue, isProjectLead, isSuspended, type Fn } from './access.js';
import { HttpError } from './http.js';
import { filterA, someA } from "./async.js";

/* ---------------------------------------------------------------------------------------------
 * Workflow de communication (spécification v1.2 §8). Circuits (§8.2) : chaque case (« slot »)
 * doit être remplie par une personne distincte ; l'auteur ne remplit que la case « communication ».
 * ------------------------------------------------------------------------------------------- */

export type CommKind = 'announcement' | 'service' | 'current' | 'project' | 'official' | 'technical' | 'paid_ad' | 'crisis';
export type CommStatus = 'draft' | 'in_validation' | 'validated' | 'published' | 'refused' | 'withdrawn';
export type Slot = 'comms' | 'pdg' | 'project_lead' | 'infra_lead' | 'treasurer';

export interface CommRow {
  id: string; author_id: string | null; author_name: string; family: 'internal' | 'official'; kind: CommKind; title: string; body: string;
  project_id: string | null; status: CommStatus; version: number; crisis: number; review_due_at: string | null; reviewed_at: string | null;
  review_note: string; decision_motive: string; published_at: string | null; published_by: string | null; submitted_at: string | null;
  created_at: string; updated_at: string;
}
interface ValidationRow { id: string; comm_id: string; version: number; slot: Slot; validator_id: string | null; validator_name: string; decision: 'approve' | 'refuse'; motive: string; mandate_id: string | null; created_at: string }

export const CIRCUITS: Record<'current' | 'project' | 'official' | 'technical' | 'paid_ad', Slot[]> = {
  current: ['comms'],
  project: ['comms', 'project_lead'],
  official: ['pdg', 'comms'],
  technical: ['pdg', 'infra_lead'],
  paid_ad: ['pdg', 'comms', 'treasurer'],
};
export const SLOT_FR: Record<Slot, string> = { comms: 'Chargé de communication', pdg: 'PDG', project_lead: 'Chef de projet du projet', infra_lead: "Chef d'infrastructures", treasurer: 'Caissier' };
export const KIND_FR: Record<CommKind, string> = {
  announcement: 'Annonce interne', service: 'Avis technique de service', current: 'Publication courante', project: 'Contenu lié à un projet',
  official: 'Annonce officielle / partenariat', technical: 'Sujet technique sensible', paid_ad: 'Publicité payante', crisis: 'Communication de crise',
};

export async function getComm(id: string): Promise<CommRow> {
  const c = await db.prepare('SELECT * FROM communications WHERE id = ?').get(id) as unknown as CommRow | undefined;
  if (!c) throw new HttpError(404, 'Communication introuvable.');
  return c;
}

export const validationsOf = async (id: string) => await db.prepare('SELECT * FROM communication_validations WHERE comm_id = ? ORDER BY created_at, rowid').all(id) as unknown as ValidationRow[];

export function slotsOf(c: Pick<CommRow, 'kind'>): Slot[] {
  return (CIRCUITS as Record<string, Slot[]>)[c.kind] ?? [];
}

const currentApprovals = async (c: CommRow) => (await validationsOf(c.id)).filter((v) => v.version === c.version && v.decision === 'approve');
export const openSlots = async (c: CommRow): Promise<Slot[]> => {
  const filled = new Set((await currentApprovals(c)).map((v) => v.slot));
  return slotsOf(c).filter((s) => !filled.has(s));
};

/** Cette personne peut-elle remplir cette case ? (fonction, ou mandat de remplacement valide) */
export async function qualifiesFor(userId: string, slot: Slot, c: CommRow): Promise<{ ok: boolean; mandateId: string | null }> {
  if ((await isSuspended(userId))) return { ok: false, mandateId: null };
  const overdue = await isOverdue('communication', c.submitted_at);
  if (slot === 'project_lead') {
    if (c.project_id && (await isProjectLead(userId, c.project_id))) return { ok: true, mandateId: null };
    if (c.project_id && (await isOrphan(c.project_id))) return await actsAs(userId, 'project_lead', 'communication', true);
    return { ok: false, mandateId: null };
  }
  return await actsAs(userId, slot as Fn, 'communication', overdue);
}

/** Case que cette personne remplirait maintenant, avec les règles d'indépendance (§8.4). */
export async function slotFor(userId: string, c: CommRow): Promise<{ slot: Slot; mandateId: string | null } | { error: string }> {
  const open = await openSlots(c);
  if (!open.length) return { error: 'Toutes les validations sont déjà obtenues.' };
  const already = (await currentApprovals(c)).some((v) => v.validator_id === userId);
  if (already) return { error: 'Vous avez déjà validé cette version : un validateur indépendant est requis pour les autres étapes.' };
  let sawAuthor = false;
  for (const slot of open) {
    if (c.author_id === userId && slot !== 'comms') { sawAuthor = true; continue; }
    const q = await qualifiesFor(userId, slot, c);
    if (q.ok) return { slot, mandateId: q.mandateId };
  }
  if (sawAuthor) return { error: "L'auteur ne peut pas valider les autres étapes de son propre contenu : un validateur indépendant est requis." };
  return { error: "Vous ne faites pas partie du circuit de validation de ce contenu." };
}

/** Une case ouverte sans aucune personne disponible = validation bloquée. */
export async function blockedSlots(c: CommRow): Promise<Slot[]> {
  if (c.status !== 'in_validation') return [];
  const users = await db.prepare("SELECT id FROM users WHERE suspended_at IS NULL AND role <> 'guest'").all() as { id: string }[];
  const approvedBy = new Set((await currentApprovals(c)).map((v) => v.validator_id));
  return filterA(await openSlots(c), async (slot) => !(await someA(users, async (u) => {
      if (approvedBy.has(u.id) || !(await isAvailable(u.id)) && !(await actsAs(u.id, slot as Fn, 'communication', true)).ok) return false;
      if (c.author_id === u.id && slot !== 'comms') return false;
      return (await qualifiesFor(u.id, slot, c)).ok;
    })));
}

export async function snapshotVersion(c: CommRow) {
  await db.prepare('INSERT INTO communication_versions (comm_id,version,title,body,created_at) VALUES (?,?,?,?,?) ON CONFLICT (comm_id,version) DO UPDATE SET title = excluded.title, body = excluded.body, created_at = excluded.created_at').run(c.id, c.version, c.title, c.body, now());
}
