import { db, now } from './db.js';
import { actsAs, hasActiveAbsence, holders, isAvailable, isOverdue, pdgIds, ruleFor, type Fn, type ValidationType } from './access.js';
import { currentApprovers, type ExpenseRow } from './finance.js';
import { blockedSlots, openSlots, qualifiesFor, SLOT_FR, type CommRow } from './comms.js';
import { notify } from './notify.js';

/* ---------------------------------------------------------------------------------------------
 * Validations en attente (spécification v1.2 §10) : une seule vue pour les quatre types
 * (dépense, archivage de projet, communication, compte), avec détection du blocage et relances
 * (1re relance, intervalle, escalade — réglables par le PDG).
 * ------------------------------------------------------------------------------------------- */

export interface PendingItem {
  type: ValidationType;
  id: string;
  title: string;
  detail: string;
  since: string;
  link: string;
  /** personnes qui peuvent décider maintenant */
  approvers: string[];
  blocked: boolean;
  blockedReason: string;
  overdue: boolean;
}

const users = () => db.prepare("SELECT id FROM users WHERE suspended_at IS NULL AND role <> 'guest'").all() as { id: string }[];

function pdgApprovers(type: ValidationType, since: string, exclude: Set<string> = new Set(), fallbackFounders = false): { approvers: string[]; blocked: boolean } {
  const overdue = isOverdue(type, since);
  let approvers = users().filter((u) => !exclude.has(u.id) && isAvailable(u.id) && actsAs(u.id, 'pdg', type, overdue).ok).map((u) => u.id);
  if (!approvers.length && fallbackFounders) {
    approvers = (db.prepare("SELECT id FROM users WHERE suspended_at IS NULL AND role = 'member'").all() as { id: string }[]).map((r) => r.id).filter((id) => !exclude.has(id) && isAvailable(id));
  }
  return { approvers, blocked: approvers.length === 0 };
}

/** Décideurs d'une action sur un compte : le PDG, sauf s'il est la personne visée ou l'initiateur (alors un autre fondateur). */
export function accountApprovers(a: { user_id: string; requested_by: string | null; created_at: string }) {
  const exclude = new Set([a.user_id, a.requested_by].filter(Boolean) as string[]);
  const isPdgInvolved = holders('pdg').some((h) => exclude.has(h.id));
  return pdgApprovers('account', a.created_at, new Set([a.user_id]), isPdgInvolved);
}

export function pendingItems(): PendingItem[] {
  const out: PendingItem[] = [];

  for (const e of db.prepare("SELECT * FROM expenses WHERE status = 'pending'").all() as unknown as ExpenseRow[]) {
    const ap = currentApprovers(e).map((a) => a.id).filter((id) => isAvailable(id));
    out.push({
      type: 'expense', id: e.id, title: `Dépense : ${e.beneficiary}`, detail: `${(e.amount_minor / 100).toLocaleString('fr-FR')} ${e.currency} — ${e.reason}`,
      since: e.submitted_at ?? e.updated_at, link: '#finances', approvers: ap, blocked: ap.length === 0,
      blockedReason: "Aucun approbateur indépendant n'est disponible (demandeur, bénéficiaire et Caissier sont exclus).",
      overdue: isOverdue('expense', e.submitted_at),
    });
  }

  for (const p of db.prepare("SELECT id, name, done_at, updated_at, lead_id FROM projects WHERE status = 'done'").all() as { id: string; name: string; done_at: string | null; updated_at: string; lead_id: string | null }[]) {
    const since = p.done_at ?? p.updated_at;
    const { approvers, blocked } = pdgApprovers('archive', since, new Set());
    out.push({
      type: 'archive', id: p.id, title: `Archivage : ${p.name}`, detail: 'Projet terminé — le PDG confirme ou refuse l\'archivage.', since, link: `#projets/${p.id}`,
      approvers, blocked, blockedReason: 'Aucun PDG disponible et aucun mandat de remplacement valide.', overdue: isOverdue('archive', since),
    });
  }

  for (const c of db.prepare("SELECT * FROM communications WHERE status = 'in_validation'").all() as unknown as CommRow[]) {
    const since = c.submitted_at ?? c.updated_at;
    const open = openSlots(c);
    const ap = new Set<string>();
    for (const slot of open) for (const u of users()) if (isAvailable(u.id) && !(c.author_id === u.id && slot !== 'comms') && qualifiesFor(u.id, slot, c).ok) ap.add(u.id);
    const blocked = blockedSlots(c);
    out.push({
      type: 'communication', id: c.id, title: `Communication : ${c.title}`, detail: `Validations attendues : ${open.map((s) => SLOT_FR[s]).join(', ')}`, since, link: '#communications',
      approvers: [...ap], blocked: blocked.length > 0,
      blockedReason: blocked.length ? `Aucun validateur indépendant disponible pour : ${blocked.map((s) => SLOT_FR[s]).join(', ')}.` : '',
      overdue: isOverdue('communication', since),
    });
  }

  for (const a of db.prepare("SELECT * FROM account_actions WHERE status = 'pending'").all() as { id: string; user_id: string; user_name: string; action: string; reason: string; requested_by: string | null; created_at: string }[]) {
    const { approvers, blocked } = accountApprovers(a);
    out.push({
      type: 'account', id: a.id, title: `${a.action === 'suspend' ? 'Suspension' : 'Réactivation'} du compte de ${a.user_name}`, detail: a.reason, since: a.created_at, link: '#equipe',
      approvers, blocked, blockedReason: 'Aucun PDG disponible et aucun mandat de remplacement valide.', overdue: isOverdue('account', a.created_at),
    });
  }
  return out.sort((x, y) => x.since.localeCompare(y.since));
}

/** Items qui concernent cette personne : elle peut décider, ou elle suit (PDG / administrateur) les blocages. */
export function pendingFor(userId: string, role: string): PendingItem[] {
  const isPdg = holders('pdg').some((h) => h.id === userId);
  return pendingItems().filter((i) => i.approvers.includes(userId) || ((isPdg || role === 'admin') && i.blocked));
}

/* ------------------------------------------- Relances ------------------------------------------- */

const hoursSince = (iso: string) => (Date.now() - Date.parse(iso)) / 3600_000;
const LABEL: Record<ValidationType, string> = { expense: 'Dépense', archive: 'Archivage de projet', communication: 'Communication', account: 'Action sur un compte' };

/** Relances : 1re à `first_reminder_h`, puis toutes les `interval_h`, escalade à `escalation_h`. Idempotent. */
export function runValidationReminders() {
  for (const it of pendingItems()) {
    const rule = ruleFor(it.type);
    const h = hoursSince(it.since);
    if (h >= rule.first_reminder_h && h < rule.escalation_h) {
      const k = 1 + Math.floor((h - rule.first_reminder_h) / Math.max(1, rule.interval_h));
      for (const id of it.approvers) {
        notify({ userId: id, type: 'validation', category: 'action', title: `Validation en attente : ${it.title}`, body: `${LABEL[it.type]} — en attente depuis ${Math.floor(h)} h.`, link: it.link, dedupeKey: `remind:${it.type}:${it.id}:${k}` });
      }
    }
    if (h >= rule.escalation_h) {
      // Escalade : au PDG ; si le PDG est lui-même le validateur (ou absent), à un autre fondateur.
      const pdgs = pdgIds();
      let targets = pdgs.filter((id) => isAvailable(id) && !it.approvers.includes(id));
      if (!targets.length) {
        targets = (db.prepare("SELECT id FROM users WHERE suspended_at IS NULL AND role = 'member'").all() as { id: string }[]).map((r) => r.id).filter((id) => isAvailable(id) && !it.approvers.includes(id));
      }
      for (const id of new Set([...targets, ...it.approvers])) {
        notify({ userId: id, type: 'validation', category: 'urgent', title: `Escalade — validation en retard : ${it.title}`, body: it.blocked ? it.blockedReason : `${LABEL[it.type]} en attente depuis ${Math.floor(h)} h.`, link: it.link, dedupeKey: `escalate:${it.type}:${it.id}` });
      }
    }
  }

  // Absence déclarée de plus de 30 jours : alerte une fois à l'administrateur technique et au PDG (§10.4).
  const rows = db.prepare('SELECT id, user_id, starts_on, ends_on, warned_at FROM absences WHERE ended_at IS NULL AND warned_at IS NULL').all() as { id: string; user_id: string; starts_on: string; ends_on: string }[];
  for (const a of rows) {
    const days = (Date.parse(a.ends_on) - Date.parse(a.starts_on)) / 86_400_000;
    if (days > 30 && hasActiveAbsence(a.user_id)) {
      const name = (db.prepare('SELECT name FROM users WHERE id = ?').get(a.user_id) as { name: string } | undefined)?.name ?? '';
      const admins = (db.prepare("SELECT id FROM users WHERE role = 'admin' AND suspended_at IS NULL").all() as { id: string }[]).map((r) => r.id);
      for (const id of new Set([...pdgIds(), ...admins])) {
        if (id !== a.user_id) notify({ userId: id, type: 'system', category: 'action', title: `Absence de plus de 30 jours : ${name}`, body: 'Envisagez un intérim ou une réaffectation des responsabilités.', link: '#equipe', dedupeKey: `absence30:${a.id}` });
      }
      db.prepare('UPDATE absences SET warned_at = ? WHERE id = ?').run(now(), a.id);
    }
  }

  // Revue de communication de crise en retard (24 h).
  for (const c of db.prepare("SELECT id, title, review_due_at FROM communications WHERE crisis = 1 AND reviewed_at IS NULL AND review_due_at IS NOT NULL AND review_due_at < ?").all(now()) as { id: string; title: string }[]) {
    for (const id of pdgIds()) notify({ userId: id, type: 'communication', category: 'urgent', title: `Revue de crise en retard : ${c.title}`, link: '#communications', dedupeKey: `crisis-review:${c.id}` });
  }
}

export type { Fn };
