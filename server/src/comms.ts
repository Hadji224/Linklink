import { db, now } from './db.js';
import { actsAs, isAvailable, isOrphan, isOverdue, isProjectLead, isSuspended, type Fn } from './access.js';
import { HttpError } from './http.js';

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

export function getComm(id: string): CommRow {
  const c = db.prepare('SELECT * FROM communications WHERE id = ?').get(id) as unknown as CommRow | undefined;
  if (!c) throw new HttpError(404, 'Communication introuvable.');
  return c;
}

export const validationsOf = (id: string) => db.prepare('SELECT * FROM communication_validations WHERE comm_id = ? ORDER BY created_at, rowid').all(id) as unknown as ValidationRow[];

export function slotsOf(c: Pick<CommRow, 'kind'>): Slot[] {
  return (CIRCUITS as Record<string, Slot[]>)[c.kind] ?? [];
}

const currentApprovals = (c: CommRow) => validationsOf(c.id).filter((v) => v.version === c.version && v.decision === 'approve');
export const openSlots = (c: CommRow): Slot[] => {
  const filled = new Set(currentApprovals(c).map((v) => v.slot));
  return slotsOf(c).filter((s) => !filled.has(s));
};

/** Cette personne peut-elle remplir cette case ? (fonction, ou mandat de remplacement valide) */
export function qualifiesFor(userId: string, slot: Slot, c: CommRow): { ok: boolean; mandateId: string | null } {
  if (isSuspended(userId)) return { ok: false, mandateId: null };
  const overdue = isOverdue('communication', c.submitted_at);
  if (slot === 'project_lead') {
    if (c.project_id && isProjectLead(userId, c.project_id)) return { ok: true, mandateId: null };
    if (c.project_id && isOrphan(c.project_id)) return actsAs(userId, 'project_lead', 'communication', true);
    return { ok: false, mandateId: null };
  }
  return actsAs(userId, slot as Fn, 'communication', overdue);
}

/** Case que cette personne remplirait maintenant, avec les règles d'indépendance (§8.4). */
export function slotFor(userId: string, c: CommRow): { slot: Slot; mandateId: string | null } | { error: string } {
  const open = openSlots(c);
  if (!open.length) return { error: 'Toutes les validations sont déjà obtenues.' };
  const already = currentApprovals(c).some((v) => v.validator_id === userId);
  if (already) return { error: 'Vous avez déjà validé cette version : un validateur indépendant est requis pour les autres étapes.' };
  let sawAuthor = false;
  for (const slot of open) {
    if (c.author_id === userId && slot !== 'comms') { sawAuthor = true; continue; }
    const q = qualifiesFor(userId, slot, c);
    if (q.ok) return { slot, mandateId: q.mandateId };
  }
  if (sawAuthor) return { error: "L'auteur ne peut pas valider les autres étapes de son propre contenu : un validateur indépendant est requis." };
  return { error: "Vous ne faites pas partie du circuit de validation de ce contenu." };
}

/** Une case ouverte sans aucune personne disponible = validation bloquée. */
export function blockedSlots(c: CommRow): Slot[] {
  if (c.status !== 'in_validation') return [];
  const users = db.prepare("SELECT id FROM users WHERE suspended_at IS NULL AND role <> 'guest'").all() as { id: string }[];
  const approvedBy = new Set(currentApprovals(c).map((v) => v.validator_id));
  return openSlots(c).filter((slot) => !users.some((u) => {
    if (approvedBy.has(u.id) || !isAvailable(u.id) && !actsAs(u.id, slot as Fn, 'communication', true).ok) return false;
    if (c.author_id === u.id && slot !== 'comms') return false;
    return qualifiesFor(u.id, slot, c).ok;
  }));
}

export function snapshotVersion(c: CommRow) {
  db.prepare('INSERT OR REPLACE INTO communication_versions (comm_id,version,title,body,created_at) VALUES (?,?,?,?,?)').run(c.id, c.version, c.title, c.body, now());
}
