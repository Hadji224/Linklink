import { Router } from 'express';
import { z } from 'zod';
import { actsAs, can, deny, hasOwnFn, holders, isOverdue, major, minor, ownFunctions, pdgIds, requireCap } from '../access.js';
import { db, now, tx, uid } from '../db.js';
import {
  approvalsOf, approvalsRequiredFor, assertNoConflict, auditExpense, currentApprovers, getExpense, money, notifyUsers, paidMinor, paymentsOf,
  sameBeneficiary, snapshot, STATUS_FR, structuralApprovers, type ExpenseRow,
} from '../finance.js';
import { HttpError, idParam, me, parse, type AuthUser } from '../http.js';
import { canSeeProject } from '../perm.js';

export const expensesApi = Router();

function assertFinanceRead(user: AuthUser) {
  if (!can(user, 'finance.read')) deny(user, 'finance_read', 'Les données financières sont réservées aux fondateurs.', 'expense');
}

const userName = (id: string | null) => (id ? ((db.prepare('SELECT name FROM users WHERE id = ?').get(id) as { name: string } | undefined)?.name ?? null) : null);

export function shapeExpense(e: ExpenseRow, user: AuthUser, detail = false) {
  const isRequester = e.requester_id === user.id;
  const open = ['draft', 'pending', 'blocked', 'awaiting_payment'].includes(e.status);
  const hasPayment = paymentsOf(e.id).some((p) => p.status === 'recorded');
  const approvers = e.status === 'pending' ? currentApprovers(e) : [];
  const myApprover = approvers.find((a) => a.id === user.id);
  const paid = paidMinor(e);
  const canCosign = e.declarative_by && !e.cosigned_by && hasOwnFn(user.id, 'treasurer');
  const base = {
    id: e.id,
    requester: { id: e.requester_id, name: e.requester_name },
    beneficiary: e.beneficiary,
    amount: major(e.amount_minor),
    currency: e.currency,
    reason: e.reason,
    projectId: e.project_id,
    projectName: e.project_id ? ((db.prepare('SELECT name FROM projects WHERE id = ?').get(e.project_id) as { name: string } | undefined)?.name ?? null) : null,
    status: e.status,
    statusLabel: STATUS_FR[e.status],
    version: e.version,
    approvalsRequired: e.approvals_required,
    approvalsCount: approvalsOf(e.id).filter((a) => a.version === e.version && a.decision === 'approve').length,
    approvedAmount: e.approved_minor === null ? null : major(e.approved_minor),
    approvedCurrency: e.approved_currency,
    paidAmount: major(paid),
    justificatif: e.justificatif,
    declarative: !!e.declarative_by,
    cosigned: !!e.cosigned_by,
    decisionMotive: e.decision_motive,
    createdAt: e.created_at,
    updatedAt: e.updated_at,
    submittedAt: e.submitted_at,
    blockedValidation: e.status === 'pending' && approvers.length === 0,
    permissions: {
      edit: isRequester && open && !hasPayment,
      submit: isRequester && (e.status === 'draft' || e.status === 'blocked'),
      cancel: (isRequester || pdgIds().includes(user.id)) && open && !hasPayment,
      decide: !!myApprover,
      pay: hasOwnFn(user.id, 'treasurer') && e.status === 'awaiting_payment',
      close: hasOwnFn(user.id, 'treasurer') && e.status === 'paid',
      resolve: e.status === 'discrepancy' && (e.approvals_required === 2 ? structuralApprovers(e).includes(user.id) : actsAs(user.id, 'pdg', 'expense', isOverdue('expense', e.submitted_at)).ok && user.id !== e.requester_id),
      justify: (isRequester || hasOwnFn(user.id, 'treasurer')) && !['cancelled', 'refused', 'closed'].includes(e.status),
      cosign: !!canCosign,
    },
  };
  if (!detail) return base;
  return {
    ...base,
    approvals: approvalsOf(e.id).map((a) => ({ id: a.id, version: a.version, by: a.approver_name, decision: a.decision, motive: a.motive, mandate: !!a.mandate_id, createdAt: a.created_at, current: a.version === e.version })),
    payments: paymentsOf(e.id).map((p) => ({ id: p.id, by: p.cashier_name, amount: major(p.amount_minor), currency: p.currency, beneficiary: p.beneficiary, proof: p.proof, discrepancy: p.discrepancy, status: p.status, createdAt: p.created_at })),
    versions: (db.prepare('SELECT version, snapshot, note, created_at FROM expense_versions WHERE expense_id = ? ORDER BY version').all(e.id) as { version: number; snapshot: string; note: string; created_at: string }[]).map((v) => ({ version: v.version, ...(JSON.parse(v.snapshot) as object), note: v.note, createdAt: v.created_at })),
  };
}

const currencySchema = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'Devise invalide (3 lettres, ex. GNF).');
const baseSchema = z.object({
  beneficiary: z.string().trim().min(1, 'Le bénéficiaire est obligatoire.').max(120),
  beneficiaryUserId: z.string().nullable().optional(),
  amount: z.number().positive('Le montant doit être positif.').max(1e12),
  currency: currencySchema.optional().default('GNF'),
  reason: z.string().trim().min(3, 'Le motif est obligatoire.').max(1000),
  projectId: z.string().nullable().optional(),
  submit: z.boolean().optional().default(false),
});

function assertProject(user: AuthUser, projectId: string | null | undefined) {
  if (projectId && !canSeeProject(user, projectId)) throw new HttpError(400, 'Projet introuvable.');
}

function submitExpense(user: AuthUser, e: ExpenseRow): ExpenseRow {
  const required = approvalsRequiredFor(e.requester_id, e.beneficiary_user_id);
  const probe = { ...e, approvals_required: required };
  const possible = structuralApprovers(probe).length >= required;
  const status = possible ? 'pending' : 'blocked';
  db.prepare('UPDATE expenses SET status = ?, approvals_required = ?, submitted_at = ?, updated_at = ? WHERE id = ?').run(status, required, now(), now(), e.id);
  const fresh = getExpense(e.id);
  auditExpense(user, 'expense_submit', fresh, `Dépense soumise : ${money(fresh.amount_minor, fresh.currency)} pour ${fresh.beneficiary}${status === 'blocked' ? ' — bloquée (aucun approbateur possible)' : ''}`);
  if (status === 'pending') {
    notifyUsers(currentApprovers(fresh).map((a) => a.id), { title: `Dépense à approuver : ${money(fresh.amount_minor, fresh.currency)}`, body: `${fresh.requester_name} — ${fresh.reason.slice(0, 100)}${required === 2 ? ' (double approbation)' : ''}`, category: 'action', dedupe: `exp:${fresh.id}:${fresh.version}` }, user.id);
  } else {
    notifyUsers([...pdgIds(), ...holders('coordinator').map((h) => h.id)], { title: 'Dépense bloquée : aucun approbateur possible', body: fresh.reason.slice(0, 100), category: 'urgent' }, user.id);
  }
  return fresh;
}

expensesApi.get('/expenses', (req, res) => {
  const user = me(req);
  assertFinanceRead(user);
  const status = String(req.query.status ?? '');
  const rows = db.prepare('SELECT * FROM expenses ORDER BY updated_at DESC LIMIT 500').all() as unknown as ExpenseRow[];
  res.json({ expenses: rows.filter((e) => !status || e.status === status).map((e) => shapeExpense(e, user)) });
});

expensesApi.post('/expenses', (req, res) => {
  const user = me(req);
  requireCap(user, 'expense.create', 'expense_create', 'expense');
  const input = parse(baseSchema, req.body);
  assertProject(user, input.projectId);
  if (input.beneficiaryUserId && !db.prepare('SELECT 1 FROM users WHERE id = ?').get(input.beneficiaryUserId)) throw new HttpError(400, 'Bénéficiaire introuvable.');
  const id = uid();
  const t = now();
  db.prepare(
    `INSERT INTO expenses (id,requester_id,requester_name,beneficiary,beneficiary_user_id,amount_minor,currency,reason,project_id,status,version,approvals_required,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,'draft',1,?,?,?)`,
  ).run(id, user.id, user.name, input.beneficiary, input.beneficiaryUserId ?? null, minor(input.amount), input.currency, input.reason, input.projectId ?? null, approvalsRequiredFor(user.id, input.beneficiaryUserId ?? null), t, t);
  auditExpense(user, 'expense_create', getExpense(id), `Demande de dépense créée : ${money(minor(input.amount), input.currency)} pour ${input.beneficiary}`);
  const fresh = input.submit ? submitExpense(user, getExpense(id)) : getExpense(id);
  res.status(201).json({ expense: shapeExpense(fresh, user, true) });
});

expensesApi.get('/expenses/:id', (req, res) => {
  assertFinanceRead(me(req));
  res.json({ expense: shapeExpense(getExpense(idParam(req)), me(req), true) });
});

// Modification : tout changement important (montant, bénéficiaire, devise, motif, projet) invalide l'approbation (§6.5).
expensesApi.patch('/expenses/:id', (req, res) => {
  const user = me(req);
  const e = getExpense(idParam(req));
  assertFinanceRead(user);
  if (e.requester_id !== user.id) deny(user, 'expense_edit', 'Seul le demandeur peut modifier sa demande.', 'expense', e.id);
  if (!['draft', 'pending', 'blocked', 'awaiting_payment', 'refused'].includes(e.status)) throw new HttpError(409, 'Cette dépense ne peut plus être modifiée.');
  if (paymentsOf(e.id).some((p) => p.status === 'recorded')) throw new HttpError(409, 'Un paiement est déjà enregistré : la dépense ne peut plus être modifiée.');
  const input = parse(baseSchema.partial().omit({ submit: true }), req.body);
  assertProject(user, input.projectId);
  const next = {
    beneficiary: input.beneficiary ?? e.beneficiary,
    beneficiary_user_id: input.beneficiaryUserId === undefined ? e.beneficiary_user_id : input.beneficiaryUserId,
    amount_minor: input.amount === undefined ? e.amount_minor : minor(input.amount),
    currency: input.currency ?? e.currency,
    reason: input.reason ?? e.reason,
    project_id: input.projectId === undefined ? e.project_id : input.projectId,
  };
  const important = next.beneficiary !== e.beneficiary || next.amount_minor !== e.amount_minor || next.currency !== e.currency || next.reason !== e.reason || next.project_id !== e.project_id;
  if (!important) return void res.json({ expense: shapeExpense(e, user, true) });
  const wasSubmitted = e.status !== 'draft';
  tx(() => {
    if (wasSubmitted) snapshot(e, 'Version avant modification importante');
    const required = approvalsRequiredFor(e.requester_id, next.beneficiary_user_id ?? null);
    const version = wasSubmitted ? e.version + 1 : e.version;
    // Un brouillon reste un brouillon ; toute dépense déjà soumise repart en approbation (les anciennes approbations restent consultables mais sans effet).
    const status = e.status === 'draft' || e.status === 'refused' ? 'draft' : 'pending';
    db.prepare(
      `UPDATE expenses SET beneficiary=?, beneficiary_user_id=?, amount_minor=?, currency=?, reason=?, project_id=?, version=?, approvals_required=?, status=?,
         approved_minor=NULL, approved_currency=NULL, approved_beneficiary=NULL, decision_motive='', submitted_at=?, updated_at=? WHERE id=?`,
    ).run(next.beneficiary, next.beneficiary_user_id ?? null, next.amount_minor, next.currency, next.reason, next.project_id ?? null, version, required, status, status === 'pending' ? now() : e.submitted_at, now(), e.id);
  });
  const fresh = getExpense(e.id);
  auditExpense(user, 'expense_modified', fresh, wasSubmitted
    ? `Dépense modifiée après soumission : version ${fresh.version}, approbation invalidée (${money(fresh.amount_minor, fresh.currency)} pour ${fresh.beneficiary})`
    : `Demande de dépense modifiée (${money(fresh.amount_minor, fresh.currency)} pour ${fresh.beneficiary})`);
  if (fresh.status === 'pending') {
    notifyUsers(currentApprovers(fresh).map((a) => a.id), { title: `Dépense modifiée, à ré-approuver : ${money(fresh.amount_minor, fresh.currency)}`, body: `${fresh.requester_name} — ${fresh.reason.slice(0, 100)}`, category: 'action', dedupe: `exp:${fresh.id}:${fresh.version}` }, user.id);
  }
  res.json({ expense: shapeExpense(fresh, user, true) });
});

expensesApi.post('/expenses/:id/submit', (req, res) => {
  const user = me(req);
  const e = getExpense(idParam(req));
  if (e.requester_id !== user.id) deny(user, 'expense_submit', 'Seul le demandeur peut soumettre sa demande.', 'expense', e.id);
  if (e.status !== 'draft' && e.status !== 'blocked') throw new HttpError(409, 'Cette dépense a déjà été soumise.');
  res.json({ expense: shapeExpense(submitExpense(user, e), user, true) });
});

expensesApi.post('/expenses/:id/cancel', (req, res) => {
  const user = me(req);
  const e = getExpense(idParam(req));
  const { motive } = parse(z.object({ motive: z.string().trim().min(3, 'Le motif est obligatoire.').max(500) }), req.body);
  if (!(e.requester_id === user.id || pdgIds().includes(user.id))) deny(user, 'expense_cancel', 'Seuls le demandeur et le PDG peuvent annuler une demande.', 'expense', e.id);
  if (!['draft', 'pending', 'blocked', 'awaiting_payment'].includes(e.status)) throw new HttpError(409, 'Cette dépense ne peut plus être annulée.');
  if (paymentsOf(e.id).some((p) => p.status === 'recorded')) throw new HttpError(409, 'Un paiement est enregistré : régularisez-le avant d\'annuler.');
  snapshot(e, 'Annulée : ' + motive);
  db.prepare("UPDATE expenses SET status='cancelled', decision_motive=?, updated_at=? WHERE id=?").run(motive, now(), e.id);
  auditExpense(user, 'expense_cancel', e, `Dépense annulée : ${motive}`);
  notifyUsers([e.requester_id], { title: 'Votre demande de dépense a été annulée', body: motive }, user.id);
  res.json({ expense: shapeExpense(getExpense(e.id), user, true) });
});

// Décision d'approbation : PDG (mode 1) ou deux autres fondateurs (mode 2, dépense du PDG).
expensesApi.post('/expenses/:id/decision', (req, res) => {
  const user = me(req);
  assertFinanceRead(user);
  const e = getExpense(idParam(req));
  const input = parse(z.object({ decision: z.enum(['approve', 'refuse']), motive: z.string().trim().max(500).optional().default('') }), req.body);
  if (e.status !== 'pending') throw new HttpError(409, "Cette dépense n'est pas en attente d'approbation.");
  assertNoConflict(user, e, 'approve');
  const mine = currentApprovers(e).find((a) => a.id === user.id);
  if (!mine) {
    if (e.approvals_required === 1) deny(user, 'expense_approve', "Seul le PDG (ou un titulaire de mandat valide) peut approuver une dépense.", 'expense', e.id);
    deny(user, 'expense_approve', "Vous ne faites pas partie des approbateurs de cette dépense (double approbation par deux autres fondateurs).", 'expense', e.id);
  }
  if (input.decision === 'refuse' && input.motive.length < 3) throw new HttpError(400, 'Le motif du refus est obligatoire.');
  db.prepare('INSERT INTO expense_approvals (id,expense_id,version,approver_id,approver_name,decision,motive,mandate_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(
    uid(), e.id, e.version, user.id, user.name, input.decision, input.motive, mine.mandateId, now(),
  );
  if (input.decision === 'refuse') {
    snapshot(e, 'Refusée');
    db.prepare("UPDATE expenses SET status='refused', decision_motive=?, updated_at=? WHERE id=?").run(input.motive, now(), e.id);
    auditExpense(user, 'expense_refuse', e, `Dépense refusée : ${input.motive}`, mine.mandateId);
    notifyUsers([e.requester_id], { title: `Votre dépense a été refusée (${money(e.amount_minor, e.currency)})`, body: input.motive, category: 'action' }, user.id);
  } else {
    const count = approvalsOf(e.id).filter((a) => a.version === e.version && a.decision === 'approve').length;
    if (count >= e.approvals_required) {
      db.prepare("UPDATE expenses SET status='awaiting_payment', approved_minor=amount_minor, approved_currency=currency, approved_beneficiary=beneficiary, decision_motive=?, updated_at=? WHERE id=?").run(input.motive, now(), e.id);
      auditExpense(user, 'expense_approve', e, `Dépense approuvée : ${money(e.amount_minor, e.currency)} pour ${e.beneficiary}${e.approvals_required === 2 ? ' (double approbation complète)' : ''}`, mine.mandateId);
      snapshot(getExpense(e.id), 'Approuvée');
      notifyUsers([e.requester_id, ...holders('treasurer').map((h) => h.id)], { title: `Dépense approuvée : ${money(e.amount_minor, e.currency)}`, body: `${e.beneficiary} — à payer par le Caissier`, category: 'action' }, user.id);
    } else {
      auditExpense(user, 'expense_approve_partial', e, `Première approbation (${count}/${e.approvals_required}) de la dépense de ${e.requester_name}`, mine.mandateId);
      notifyUsers(currentApprovers(getExpense(e.id)).map((a) => a.id), { title: 'Seconde approbation attendue', body: `${money(e.amount_minor, e.currency)} — ${e.requester_name}`, category: 'action' }, user.id);
    }
  }
  res.json({ expense: shapeExpense(getExpense(e.id), user, true) });
});

// Paiement déclaré par le Caissier, rapproché de l'approbation (§6.4).

expensesApi.post('/expenses/:id/payments', (req, res) => {
  const user = me(req);
  requireCap(user, 'expense.pay', 'expense_pay', 'expense', idParam(req));
  const e = getExpense(idParam(req));
  const input = parse(
    z.object({
      amount: z.number().positive('Le montant doit être positif.').max(1e12),
      currency: currencySchema.optional(),
      beneficiary: z.string().trim().min(1).max(120).optional(),
      proof: z.string().trim().min(3, 'Une preuve de paiement (reçu, référence) est obligatoire.').max(500),
    }),
    req.body,
  );
  if (e.status !== 'awaiting_payment') {
    if (['pending', 'draft', 'blocked', 'refused'].includes(e.status)) deny(user, 'expense_pay', "Aucun paiement avant l'approbation du PDG : cette dépense n'est pas approuvée.", 'expense', e.id);
    throw new HttpError(409, 'Cette dépense ne peut plus recevoir de paiement.');
  }
  assertNoConflict(user, e, 'pay');
  const currency = input.currency ?? (e.approved_currency as string);
  const beneficiary = input.beneficiary ?? (e.approved_beneficiary as string);
  const amountMinor = minor(input.amount);
  const mismatch: string[] = [];
  if (currency !== e.approved_currency) mismatch.push(`devise ${currency} au lieu de ${e.approved_currency}`);
  if (!sameBeneficiary(beneficiary, e.approved_beneficiary as string)) mismatch.push(`bénéficiaire « ${beneficiary} » au lieu de « ${e.approved_beneficiary} »`);
  if (!mismatch.length && paidMinor(e) + amountMinor > (e.approved_minor as number)) {
    throw new HttpError(409, `Paiement refusé : le total dépasserait le montant approuvé (${money(e.approved_minor as number, e.approved_currency as string)}).`);
  }
  if (currency === e.approved_currency && amountMinor > (e.approved_minor as number)) {
    throw new HttpError(409, `Paiement refusé : supérieur au montant approuvé (${money(e.approved_minor as number, e.approved_currency as string)}).`);
  }
  const discrepancy = mismatch.join(' ; ');
  const pid = uid();
  tx(() => {
    db.prepare('INSERT INTO expense_payments (id,expense_id,cashier_id,cashier_name,amount_minor,currency,beneficiary,proof,discrepancy,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(
      pid, e.id, user.id, user.name, amountMinor, currency, beneficiary, input.proof, discrepancy, 'recorded', now(),
    );
    if (discrepancy) db.prepare("UPDATE expenses SET status='discrepancy', updated_at=? WHERE id=?").run(now(), e.id);
    else if (paidMinor(getExpense(e.id)) >= (e.approved_minor as number)) db.prepare("UPDATE expenses SET status='paid', updated_at=? WHERE id=?").run(now(), e.id);
    else db.prepare('UPDATE expenses SET updated_at=? WHERE id=?').run(now(), e.id);
  });
  if (e.requester_id === user.id) auditExpense(user, 'expense_pay_flag', e, 'Signalé : le Caissier a lui-même demandé cette dépense (contrôle C4).');
  auditExpense(user, 'expense_pay', e, `Paiement déclaré : ${money(amountMinor, currency)} à ${beneficiary}${discrepancy ? ` — ÉCART : ${discrepancy}` : ''}`);
  if (discrepancy) {
    const approvers = approvalsOf(e.id).filter((a) => a.version === e.version && a.decision === 'approve').map((a) => a.approver_id);
    notifyUsers([...pdgIds(), ...approvers], { title: 'Écart de paiement à régulariser', body: `${money(e.amount_minor, e.currency)} — ${discrepancy}`, category: 'urgent' }, user.id);
  } else {
    notifyUsers([e.requester_id], { title: `Paiement enregistré : ${money(amountMinor, currency)}`, body: e.beneficiary }, user.id);
  }
  res.status(201).json({ expense: shapeExpense(getExpense(e.id), user, true) });
});

// Régularisation d'un écart : annuler le paiement déclaré, ou l'accepter (nouvelle décision d'un approbateur).
expensesApi.post('/expenses/:id/discrepancy', (req, res) => {
  const user = me(req);
  assertFinanceRead(user);
  const e = getExpense(idParam(req));
  if (e.status !== 'discrepancy') throw new HttpError(409, "Aucun écart à régulariser sur cette dépense.");
  const input = parse(z.object({ action: z.enum(['cancel_payment', 'accept']), paymentId: z.string(), motive: z.string().trim().min(3, 'Le motif est obligatoire.').max(500) }), req.body);
  const can = e.approvals_required === 2 ? structuralApprovers(e).includes(user.id) : actsAs(user.id, 'pdg', 'expense', isOverdue('expense', e.submitted_at)).ok && user.id !== e.requester_id;
  if (!can) deny(user, 'expense_regularize', "Seul un approbateur de cette dépense peut régulariser un écart.", 'expense', e.id);
  const p = paymentsOf(e.id).find((x) => x.id === input.paymentId && x.status === 'recorded' && x.discrepancy);
  if (!p) throw new HttpError(404, 'Paiement en écart introuvable.');
  tx(() => {
    if (input.action === 'cancel_payment') {
      db.prepare("UPDATE expense_payments SET status='cancelled' WHERE id=?").run(p.id);
    } else {
      db.prepare("UPDATE expense_payments SET discrepancy='' WHERE id=?").run(p.id);
      db.prepare('UPDATE expenses SET approved_currency=?, approved_beneficiary=? WHERE id=?').run(p.currency, p.beneficiary, e.id);
    }
    const stillOpen = paymentsOf(e.id).some((x) => x.status === 'recorded' && x.discrepancy);
    const fresh = getExpense(e.id);
    const settled = paidMinor(fresh) >= (fresh.approved_minor as number);
    db.prepare('UPDATE expenses SET status=?, updated_at=? WHERE id=?').run(stillOpen ? 'discrepancy' : settled ? 'paid' : 'awaiting_payment', now(), e.id);
  });
  auditExpense(user, 'expense_regularize', e, `Écart ${input.action === 'accept' ? 'accepté' : 'annulé (paiement retiré)'} : ${input.motive}`);
  notifyUsers([e.requester_id, ...holders('treasurer').map((h) => h.id)], { title: 'Écart de paiement régularisé', body: input.motive }, user.id);
  res.json({ expense: shapeExpense(getExpense(e.id), user, true) });
});

// Justificatif : modification non importante (aucune invalidation). Un justificatif déclaratif est signé puis contresigné.
expensesApi.put('/expenses/:id/justificatif', (req, res) => {
  const user = me(req);
  assertFinanceRead(user);
  const e = getExpense(idParam(req));
  if (!(e.requester_id === user.id || hasOwnFn(user.id, 'treasurer'))) deny(user, 'expense_justify', 'Seuls le demandeur et le Caissier peuvent renseigner le justificatif.', 'expense', e.id);
  if (['cancelled', 'refused', 'closed'].includes(e.status)) throw new HttpError(409, 'Cette dépense ne peut plus recevoir de justificatif.');
  const input = parse(z.object({ note: z.string().trim().min(3, 'Décrivez le justificatif.').max(500), declarative: z.boolean().optional().default(false) }), req.body);
  if (input.declarative) {
    db.prepare('UPDATE expenses SET justificatif=?, declarative_by=?, cosigned_by=NULL, updated_at=? WHERE id=?').run(input.note, e.requester_id === user.id ? user.id : e.requester_id, now(), e.id);
  } else {
    db.prepare('UPDATE expenses SET justificatif=?, declarative_by=NULL, cosigned_by=NULL, updated_at=? WHERE id=?').run(input.note, now(), e.id);
  }
  auditExpense(user, 'expense_justify', e, `Justificatif renseigné${input.declarative ? ' (déclaratif, contreseing du Caissier attendu)' : ''}`);
  if (input.declarative) notifyUsers(holders('treasurer').map((h) => h.id), { title: 'Justificatif déclaratif à contresigner', body: e.reason.slice(0, 100), category: 'action' }, user.id);
  res.json({ expense: shapeExpense(getExpense(e.id), user, true) });
});

expensesApi.post('/expenses/:id/cosign', (req, res) => {
  const user = me(req);
  requireCap(user, 'expense.pay', 'expense_cosign', 'expense', idParam(req));
  const e = getExpense(idParam(req));
  if (!e.declarative_by) throw new HttpError(409, "Aucun justificatif déclaratif à contresigner.");
  db.prepare('UPDATE expenses SET cosigned_by=?, updated_at=? WHERE id=?').run(user.id, now(), e.id);
  auditExpense(user, 'expense_cosign', e, 'Justificatif déclaratif contresigné par le Caissier');
  res.json({ expense: shapeExpense(getExpense(e.id), user, true) });
});

// Clôture : paiement complet, aucun écart, justificatif obligatoire (déclaratif : signé et contresigné).
expensesApi.post('/expenses/:id/close', (req, res) => {
  const user = me(req);
  requireCap(user, 'expense.pay', 'expense_close', 'expense', idParam(req));
  const e = getExpense(idParam(req));
  if (e.status === 'discrepancy') throw new HttpError(409, "Clôture impossible : un écart de paiement n'est pas régularisé.");
  if (e.status !== 'paid') throw new HttpError(409, 'Seule une dépense payée en totalité peut être clôturée.');
  if (!e.justificatif || (e.declarative_by && !e.cosigned_by)) {
    throw new HttpError(409, e.declarative_by ? 'Clôture impossible : le justificatif déclaratif doit être contresigné par le Caissier.' : 'Clôture impossible : un justificatif est exigé pour toute dépense.');
  }
  db.prepare("UPDATE expenses SET status='closed', closed_at=?, updated_at=? WHERE id=?").run(now(), now(), e.id);
  auditExpense(user, 'expense_close', e, `Dépense clôturée : ${money(e.amount_minor, e.currency)} pour ${e.beneficiary}`);
  notifyUsers([e.requester_id], { title: 'Dépense clôturée', body: e.reason.slice(0, 100) }, user.id);
  res.json({ expense: shapeExpense(getExpense(e.id), user, true) });
});
