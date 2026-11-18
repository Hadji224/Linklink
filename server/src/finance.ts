import { db, now, uid } from './db.js';
import { actsAs, audit, deny, hasOwnFn, holders, isOverdue, isSuspended, major, ownFunctions } from './access.js';
import { HttpError, type AuthUser } from './http.js';
import { notify } from './notify.js';
import { filterA } from "./async.js";

/* ---------------------------------------------------------------------------------------------
 * Workflow financier (spécification v1.2 §6). LinkLink n'effectue aucun paiement : il enregistre
 * les décisions, déclare les paiements et les rapproche de l'approbation.
 * ------------------------------------------------------------------------------------------- */

export type ExpenseStatus = 'draft' | 'pending' | 'blocked' | 'refused' | 'awaiting_payment' | 'paid' | 'discrepancy' | 'closed' | 'cancelled';

export interface ExpenseRow {
  id: string; requester_id: string | null; requester_name: string; beneficiary: string; beneficiary_user_id: string | null;
  amount_minor: number; currency: string; reason: string; project_id: string | null; status: ExpenseStatus; version: number;
  approvals_required: number; approved_minor: number | null; approved_currency: string | null; approved_beneficiary: string | null;
  justificatif: string; declarative_by: string | null; cosigned_by: string | null; decision_motive: string;
  created_at: string; updated_at: string; submitted_at: string | null; closed_at: string | null;
}
export interface PaymentRow {
  id: string; expense_id: string; cashier_id: string | null; cashier_name: string; amount_minor: number; currency: string;
  beneficiary: string; proof: string; discrepancy: string; status: 'recorded' | 'cancelled'; created_at: string;
}
interface ApprovalRow { id: string; expense_id: string; version: number; approver_id: string | null; approver_name: string; decision: 'approve' | 'refuse'; motive: string; mandate_id: string | null; created_at: string }

export const STATUS_FR: Record<ExpenseStatus, string> = {
  draft: 'Brouillon', pending: "En attente d'approbation", blocked: 'Bloquée — exception requise', refused: 'Refusée',
  awaiting_payment: 'Approuvée — en attente de paiement', paid: 'Payée', discrepancy: 'Écart à régulariser', closed: 'Clôturée', cancelled: 'Annulée',
};

export const sameBeneficiary = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export async function getExpense(id: string): Promise<ExpenseRow> {
  const e = await db.prepare('SELECT * FROM expenses WHERE id = ?').get(id) as unknown as ExpenseRow | undefined;
  if (!e) throw new HttpError(404, 'Dépense introuvable.');
  return e;
}
export const paymentsOf = async (id: string) => await db.prepare('SELECT * FROM expense_payments WHERE expense_id = ? ORDER BY created_at, rowid').all(id) as unknown as PaymentRow[];
export const approvalsOf = async (id: string) => await db.prepare('SELECT * FROM expense_approvals WHERE expense_id = ? ORDER BY created_at, rowid').all(id) as unknown as ApprovalRow[];

/** Mode 1 : le PDG approuve. Mode 2 (décision D8) : double approbation si le PDG demande ou bénéficie de la dépense. */
export async function approvalsRequiredFor(requesterId: string | null, beneficiaryUserId: string | null): Promise<1 | 2> {
  const pdgs = (await holders('pdg')).map((h) => h.id);
  if ((requesterId && pdgs.includes(requesterId)) || (beneficiaryUserId && pdgs.includes(beneficiaryUserId))) return 2;
  return 1;
}

/** Personnes qui pourraient (structurellement) approuver cette dépense, disponibilité mise à part. */
export async function structuralApprovers(e: Pick<ExpenseRow, 'requester_id' | 'beneficiary_user_id' | 'approvals_required'>): Promise<string[]> {
  const users = await db.prepare("SELECT id, role FROM users WHERE suspended_at IS NULL AND role <> 'guest'").all() as { id: string; role: string }[];
  const excluded = new Set([e.requester_id, e.beneficiary_user_id].filter(Boolean) as string[]);
  const pdgs = new Set((await holders('pdg')).map((h) => h.id));
  const cashiers = new Set((await holders('treasurer')).map((h) => h.id));
  if (e.approvals_required === 1) return users.filter((u) => !excluded.has(u.id) && pdgs.has(u.id)).map((u) => u.id);
  return users.filter((u) => u.role === 'member' && !excluded.has(u.id) && !pdgs.has(u.id) && !cashiers.has(u.id)).map((u) => u.id);
}

/** Approbateurs possibles maintenant (disponibles, ou titulaires d'un mandat de remplacement valide en mode 1). */
export async function currentApprovers(e: ExpenseRow): Promise<{ id: string; mandateId: string | null }[]> {
  const done = new Set((await approvalsOf(e.id)).filter((a) => a.version === e.version && a.decision === 'approve').map((a) => a.approver_id));
  if (e.approvals_required === 2) {
    return (await filterA((await structuralApprovers(e)), async (id) => !done.has(id) && !(await isSuspended(id)))).map((id) => ({ id, mandateId: null }));
  }
  const users = await db.prepare("SELECT id FROM users WHERE suspended_at IS NULL AND role <> 'guest'").all() as { id: string }[];
  const overdue = await isOverdue('expense', e.submitted_at);
  const out: { id: string; mandateId: string | null }[] = [];
  for (const u of users) {
    if (u.id === e.requester_id || u.id === e.beneficiary_user_id || done.has(u.id)) continue;
    if ((await hasOwnFn(u.id, 'treasurer'))) continue;
    const a = await actsAs(u.id, 'pdg', 'expense', overdue);
    if (a.ok) out.push({ id: u.id, mandateId: a.mandateId });
  }
  return out;
}

export async function paidMinor(e: ExpenseRow): Promise<number> {
  return (await paymentsOf(e.id))
    .filter((p) => p.status === 'recorded' && !p.discrepancy)
    .reduce((n, p) => n + p.amount_minor, 0);
}

export async function snapshot(e: ExpenseRow, note: string) {
  await db.prepare('INSERT INTO expense_versions (expense_id,version,snapshot,note,created_at) VALUES (?,?,?,?,?) ON CONFLICT (expense_id,version) DO UPDATE SET snapshot = excluded.snapshot, note = excluded.note, created_at = excluded.created_at').run(e.id, e.version, JSON.stringify({
        beneficiary: e.beneficiary, amount: major(e.amount_minor), currency: e.currency, reason: e.reason, projectId: e.project_id, status: e.status,
        approvals: (await approvalsOf(e.id)).filter((a) => a.version === e.version).map((a) => ({ by: a.approver_name, decision: a.decision, at: a.created_at })),
      }), note, now());
}

export async function notifyUsers(ids: Iterable<string | null | undefined>, n: { title: string; body?: string; link?: string; category?: 'info' | 'action' | 'urgent'; dedupe?: string }, except?: string) {
  for (const id of new Set([...ids].filter((x): x is string => !!x && x !== except))) {
    await notify({ userId: id, type: 'finance', category: n.category ?? 'info', title: n.title, body: n.body, link: n.link ?? '#finances', dedupeKey: n.dedupe ? `${n.dedupe}:${id}` : undefined });
  }
}

export const money = (minor: number, cur: string) => `${major(minor).toLocaleString('fr-FR')} ${cur}`;

/** Conflits d'intérêts calculables (§6.2) : C1 demandeur ≠ approbateur, C2 approbateur ≠ bénéficiaire, C3 payeur ≠ approbateur. */
export async function assertNoConflict(user: AuthUser, e: ExpenseRow, action: 'approve' | 'pay') {
  if (action === 'approve') {
    if (e.requester_id === user.id) throw await deny(user, 'expense_self_approval', 'Vous ne pouvez pas approuver votre propre demande de dépense.', 'expense', e.id);
    if (e.beneficiary_user_id === user.id) throw await deny(user, 'expense_beneficiary_approval', "Vous ne pouvez pas approuver une dépense dont vous êtes le bénéficiaire.", 'expense', e.id);
    if ((await hasOwnFn(user.id, 'treasurer'))) throw await deny(user, 'expense_cashier_approval', 'Le Caissier ne peut pas approuver une dépense qu\'il paiera.', 'expense', e.id);
  } else {
    const approved = (await approvalsOf(e.id)).filter((a) => a.version === e.version && a.decision === 'approve');
    if (approved.some((a) => a.approver_id === user.id)) throw await deny(user, 'expense_cashier_approval', "Vous avez approuvé cette dépense : vous ne pouvez pas aussi la payer.", 'expense', e.id);
  }
}

export async function auditExpense(user: AuthUser | null, action: string, e: ExpenseRow, summary: string, mandateId: string | null = null) {
  await audit(user, 'business', action, 'expense', e.id, summary, { mandateId });
}

export { uid, ownFunctions };
