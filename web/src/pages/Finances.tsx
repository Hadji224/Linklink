import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { useApp } from '../data';
import { formatDateTime } from '../format';
import { useCan } from '../perm';
import { useRealtime } from '../realtime';
import { Empty, ErrorNote, Drawer, Icon, PageHeader, Spinner, useConfirm, useToast } from '../ui';
import { FormModal } from './FormModal';

interface Expense {
  id: string;
  requester: { id: string; name: string };
  beneficiary: string;
  amount: number;
  currency: string;
  reason: string;
  projectName: string | null;
  projectId: string | null;
  status: string;
  statusLabel: string;
  version: number;
  approvalsRequired: number;
  approvalsCount: number;
  approvedAmount: number | null;
  approvedCurrency: string | null;
  paidAmount: number;
  justificatif: string;
  declarative: boolean;
  cosigned: boolean;
  decisionMotive: string;
  createdAt: string;
  submittedAt: string | null;
  blockedValidation: boolean;
  permissions: { edit: boolean; submit: boolean; cancel: boolean; decide: boolean; pay: boolean; close: boolean; resolve: boolean; justify: boolean; cosign: boolean };
  approvals?: { id: string; version: number; by: string; decision: 'approve' | 'refuse'; motive: string; mandate: boolean; createdAt: string; current: boolean }[];
  payments?: { id: string; by: string; amount: number; currency: string; beneficiary: string; proof: string; discrepancy: string; status: string; createdAt: string }[];
}

const money = (n: number, c: string) => `${n.toLocaleString('fr-FR', { maximumFractionDigits: 2 })} ${c}`;
const TONE: Record<string, string> = {
  draft: 'bd-warning', pending: 'bd-electric', blocked: 'bd-danger', refused: 'bd-danger', awaiting_payment: 'bd-cyan', paid: 'bd-success', discrepancy: 'bd-danger', closed: 'bd-success', cancelled: 'bd-warning',
};
const StatusPill = ({ e }: { e: Pick<Expense, 'status' | 'statusLabel'> }) => <span className={`badge ${TONE[e.status] ?? ''}`}>{e.statusLabel}</span>;

const FILTERS: { id: string; label: string }[] = [
  { id: 'all', label: 'Toutes' }, { id: 'pending', label: 'À approuver' }, { id: 'awaiting_payment', label: 'À payer' }, { id: 'discrepancy', label: 'Écarts' }, { id: 'paid', label: 'Payées' }, { id: 'closed', label: 'Clôturées' },
];

export function Finances() {
  const { user } = useAuth();
  const { can } = useCan();
  const { epoch } = useRealtime();
  const { projects, members } = useApp();
  const toast = useToast();
  const [items, setItems] = useState<Expense[] | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('all');
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      setItems((await api<{ expenses: Expense[] }>('/expenses')).expenses);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Chargement impossible.');
    }
  }, []);
  useEffect(() => { void load(); }, [load, epoch]);

  const shown = useMemo(() => (items ?? []).filter((e) => filter === 'all' || e.status === filter), [items, filter]);
  const toDecide = (items ?? []).filter((e) => e.permissions.decide).length;
  const toPay = (items ?? []).filter((e) => e.permissions.pay).length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader title="Finances">
        {can('expense.create') && <button className="btn btn-primary" onClick={() => setCreating(true)}><Icon name="plus" className="h-4 w-4" /> Nouvelle demande</button>}
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto p-3 md:px-[max(0.75rem,calc((100%_-_56rem)/2))]">
        <p className="mb-3 text-sm text-slate">Toute dépense suit le même parcours : <strong>demande</strong> → <strong>approbation du PDG</strong> → <strong>paiement par le Caissier</strong> (avec preuve) → <strong>justificatif</strong> → clôture. LinkLink ne gère pas d'argent : il trace les décisions.</p>
        {(toDecide > 0 || toPay > 0) && (
          <p role="status" className="mb-3 rounded-xl bg-blue-50 px-3 py-2 text-sm font-semibold text-electric">
            {toDecide > 0 && `${toDecide} dépense${toDecide > 1 ? 's' : ''} attend${toDecide > 1 ? 'ent' : ''} votre approbation. `}
            {toPay > 0 && `${toPay} dépense${toPay > 1 ? 's' : ''} à payer.`}
          </p>
        )}
        <div role="group" aria-label="Filtrer par état" className="mb-3 flex flex-wrap gap-1">
          {FILTERS.map((f) => (
            <button key={f.id} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)} className={`min-h-9 rounded-full px-3 text-sm font-semibold ${filter === f.id ? 'bg-navy text-white' : 'bg-mist text-navy hover:bg-line'}`}>{f.label}</button>
          ))}
        </div>
        <ErrorNote>{error}</ErrorNote>
        {!items && !error && <Spinner />}
        {items && shown.length === 0 && <Empty icon="folder">Aucune dépense dans cette vue.</Empty>}
        <ul className="space-y-2">
          {shown.map((e) => (
            <li key={e.id}>
              <button onClick={() => setOpen(e.id)} className="card flex w-full flex-wrap items-center gap-3 p-3 text-left hover:border-electric">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-bold">{e.beneficiary} — {money(e.amount, e.currency)}</span>
                  <span className="block truncate text-sm text-slate">{e.reason}</span>
                  <span className="text-xs text-slate">Demandé par {e.requester.name}{e.id && e.requester.id === user?.id ? ' (vous)' : ''}{e.projectName ? ` · ${e.projectName}` : ''}{e.approvalsRequired === 2 ? ' · double approbation' : ''}</span>
                </span>
                <span className="flex flex-col items-end gap-1">
                  <StatusPill e={e} />
                  {e.blockedValidation && <span className="badge bd-danger">Validation bloquée</span>}
                  {(e.permissions.decide || e.permissions.pay || e.permissions.resolve) && <span className="badge bd-electric">Action attendue</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      {creating && (
        <FormModal
          title="Nouvelle demande de dépense"
          intro="La demande est soumise à l'approbation du PDG. Aucun paiement n'est possible avant."
          submitLabel="Soumettre la demande"
          fields={[
            { name: 'beneficiary', label: 'Bénéficiaire', required: true, maxLength: 120 },
            { name: 'amount', label: 'Montant', type: 'number', required: true, min: 0 },
            { name: 'currency', label: 'Devise', value: 'GNF', required: true, maxLength: 3, hint: 'Ex. GNF, USD, EUR.' },
            { name: 'reason', label: 'Motif', type: 'textarea', required: true, maxLength: 1000 },
            { name: 'projectId', label: 'Projet concerné (facultatif)', type: 'select', options: projects.filter((p) => p.status !== 'archived').map((p) => ({ value: p.id, label: p.name })) },
            { name: 'beneficiaryUserId', label: 'Le bénéficiaire est un membre ? (facultatif)', type: 'select', options: members.map((m) => ({ value: m.id, label: m.name })) },
          ]}
          onClose={() => setCreating(false)}
          onSubmit={async (v) => {
            await api('/expenses', { method: 'POST', body: { beneficiary: v.beneficiary, amount: Number(v.amount), currency: v.currency, reason: v.reason, projectId: v.projectId || null, beneficiaryUserId: v.beneficiaryUserId || null, submit: true } });
            toast.success('Demande soumise');
            await load();
          }}
        />
      )}
      {open && <ExpenseDrawer id={open} onClose={() => setOpen(null)} onChanged={load} />}
    </div>
  );
}

function ExpenseDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => Promise<void> }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { epoch } = useRealtime();
  const [e, setE] = useState<Expense | null>(null);
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState<null | 'refuse' | 'cancel' | 'pay' | 'justify' | 'edit' | { kind: 'discrepancy'; action: 'cancel_payment' | 'accept'; paymentId: string }>(null);

  const load = useCallback(async () => {
    try { setE((await api<{ expense: Expense }>(`/expenses/${id}`)).expense); } catch (err) { setError(err instanceof Error ? err.message : 'Chargement impossible.'); }
  }, [id]);
  useEffect(() => { void load(); }, [load, epoch]);

  async function act(path: string, body: unknown, ok: string, method: 'POST' | 'PUT' | 'PATCH' = 'POST') {
    setError('');
    try {
      const r = await api<{ expense: Expense }>(`/expenses/${id}${path}`, { method, body });
      setE(r.expense);
      toast.success(ok);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action impossible.');
      throw err;
    }
  }
  const quiet = (p: Promise<unknown>) => p.catch(() => {});

  return (
    <Drawer title={e ? `${e.beneficiary} — ${money(e.amount, e.currency)}` : 'Dépense'} subtitle={e ? <StatusPill e={e} /> : undefined} onClose={onClose}>
      {!e && !error && <Spinner />}
      <ErrorNote>{error}</ErrorNote>
      {e && (
        <div className="space-y-4">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-slate">Demandeur</dt><dd className="font-semibold">{e.requester.name}</dd>
            <dt className="text-slate">Motif</dt><dd className="whitespace-pre-wrap">{e.reason}</dd>
            {e.projectName && <><dt className="text-slate">Projet</dt><dd>{e.projectName}</dd></>}
            <dt className="text-slate">Approbations</dt><dd>{e.approvalsCount}/{e.approvalsRequired}{e.approvalsRequired === 2 ? ' (le PDG est concerné : deux autres fondateurs décident)' : ''}</dd>
            {e.approvedAmount !== null && <><dt className="text-slate">Montant approuvé</dt><dd>{money(e.approvedAmount, e.approvedCurrency ?? e.currency)} · payé : {money(e.paidAmount, e.approvedCurrency ?? e.currency)}</dd></>}
            <dt className="text-slate">Justificatif</dt><dd>{e.justificatif || 'Aucun'}{e.declarative ? (e.cosigned ? ' (déclaratif, contresigné)' : ' (déclaratif — contreseing du Caissier attendu)') : ''}</dd>
            {e.decisionMotive && <><dt className="text-slate">Motif de décision</dt><dd>{e.decisionMotive}</dd></>}
          </dl>
          {e.blockedValidation && <p role="alert" className="rounded-xl bg-red-50 px-3 py-2 text-sm font-semibold text-red-800">Aucun approbateur disponible : la dépense reste en attente (absence ou conflit d'intérêts). Le PDG peut accorder un mandat de remplacement.</p>}
          {e.status === 'discrepancy' && <p role="alert" className="rounded-xl bg-red-50 px-3 py-2 text-sm font-semibold text-red-800">Écart à régulariser : le paiement déclaré ne correspond pas à l'approbation. La dépense ne peut pas être clôturée.</p>}

          <div className="flex flex-wrap gap-2">
            {e.permissions.decide && <button className="btn btn-primary" onClick={async () => { if (await confirm({ title: 'Approuver cette dépense ?', message: `${money(e.amount, e.currency)} pour ${e.beneficiary}. Le Caissier pourra payer jusqu'à ce montant.`, confirmLabel: 'Approuver' })) await quiet(act('/decision', { decision: 'approve' }, 'Dépense approuvée')); }}>Approuver</button>}
            {e.permissions.decide && <button className="btn btn-ghost" onClick={() => setDialog('refuse')}>Refuser</button>}
            {e.permissions.submit && <button className="btn btn-primary" onClick={() => void quiet(act('/submit', {}, 'Demande soumise'))}>Soumettre</button>}
            {e.permissions.pay && <button className="btn btn-primary" onClick={() => setDialog('pay')}>Déclarer un paiement</button>}
            {e.permissions.justify && <button className="btn btn-ghost" onClick={() => setDialog('justify')}>Justificatif</button>}
            {e.permissions.cosign && <button className="btn btn-ghost" onClick={() => void quiet(act('/cosign', {}, 'Justificatif contresigné'))}>Contresigner</button>}
            {e.permissions.close && <button className="btn btn-primary" onClick={() => void quiet(act('/close', {}, 'Dépense clôturée'))}>Clôturer</button>}
            {e.permissions.edit && <button className="btn btn-ghost" onClick={() => setDialog('edit')}>Modifier</button>}
            {e.permissions.cancel && <button className="btn btn-danger" onClick={() => setDialog('cancel')}>Annuler la demande</button>}
          </div>
          {e.permissions.edit && e.status !== 'draft' && <p className="text-xs text-slate">Une modification importante (montant, bénéficiaire, devise, motif, projet) invalide l'approbation : elle devra être redonnée.</p>}

          <section aria-label="Approbations">
            <h3 className="mb-1 font-bold">Décisions</h3>
            {e.approvals?.length ? (
              <ul className="space-y-1 text-sm">{e.approvals.map((a) => <li key={a.id} className={a.current ? '' : 'opacity-50'}>{a.decision === 'approve' ? '✔ Approuvée' : '✖ Refusée'} par <strong>{a.by}</strong>{a.mandate ? ' (au titre d\'un mandat)' : ''}{a.motive ? ` — ${a.motive}` : ''} <span className="text-xs text-slate">· {formatDateTime(a.createdAt)}{a.current ? '' : ' · version précédente'}</span></li>)}</ul>
            ) : <p className="text-sm text-slate">Aucune décision pour l'instant.</p>}
          </section>
          <section aria-label="Paiements">
            <h3 className="mb-1 font-bold">Paiements déclarés</h3>
            {e.payments?.length ? (
              <ul className="space-y-1 text-sm">{e.payments.map((p) => (
                <li key={p.id} className={p.status === 'cancelled' ? 'line-through opacity-50' : ''}>
                  {money(p.amount, p.currency)} à <strong>{p.beneficiary}</strong> par {p.by} — preuve : {p.proof}
                  {p.discrepancy && <span className="block font-semibold text-red-700">Écart : {p.discrepancy}</span>}
                  {p.discrepancy && p.status === 'recorded' && e.permissions.resolve && (
                    <span className="mt-1 flex gap-2">
                      <button className="btn btn-ghost btn-sm" onClick={() => setDialog({ kind: 'discrepancy', action: 'cancel_payment', paymentId: p.id })}>Annuler ce paiement</button>
                      <button className="btn btn-ghost btn-sm" onClick={() => setDialog({ kind: 'discrepancy', action: 'accept', paymentId: p.id })}>Accepter l'écart</button>
                    </span>
                  )}
                </li>
              ))}</ul>
            ) : <p className="text-sm text-slate">Aucun paiement déclaré.</p>}
          </section>
        </div>
      )}
      {e && dialog === 'refuse' && <FormModal title="Refuser la dépense" fields={[{ name: 'motive', label: 'Motif du refus', type: 'textarea', required: true }]} submitLabel="Refuser" danger onClose={() => setDialog(null)} onSubmit={(v) => act('/decision', { decision: 'refuse', motive: v.motive }, 'Dépense refusée')} />}
      {e && dialog === 'cancel' && <FormModal title="Annuler la demande" fields={[{ name: 'motive', label: 'Motif', type: 'textarea', required: true }]} submitLabel="Annuler la demande" danger onClose={() => setDialog(null)} onSubmit={(v) => act('/cancel', { motive: v.motive }, 'Demande annulée')} />}
      {e && dialog === 'pay' && (
        <FormModal
          title="Déclarer un paiement"
          intro="Saisissez ce qui a réellement été payé, avec une preuve (reçu, référence). Tout écart avec l'approbation est signalé."
          fields={[
            { name: 'amount', label: 'Montant payé', type: 'number', required: true, value: String((e.approvedAmount ?? e.amount) - e.paidAmount), min: 0 },
            { name: 'currency', label: 'Devise', value: e.approvedCurrency ?? e.currency, required: true, maxLength: 3 },
            { name: 'beneficiary', label: 'Bénéficiaire réel', value: e.beneficiary, required: true },
            { name: 'proof', label: 'Preuve de paiement', required: true, hint: 'Numéro de reçu, référence de transfert…' },
          ]}
          onClose={() => setDialog(null)}
          onSubmit={(v) => act('/payments', { amount: Number(v.amount), currency: v.currency, beneficiary: v.beneficiary, proof: v.proof }, 'Paiement enregistré')}
        />
      )}
      {e && dialog === 'justify' && (
        <FormModal
          title="Justificatif"
          fields={[
            { name: 'note', label: 'Description du justificatif', type: 'textarea', required: true, value: e.justificatif, hint: 'Facture n°, reçu, photo conservée…' },
            { name: 'declarative', label: 'Pas de pièce disponible (justificatif déclaratif)', type: 'select', options: [{ value: 'no', label: 'Non, une pièce existe' }, { value: 'yes', label: 'Oui — déclaration signée, à contresigner par le Caissier' }], value: e.declarative ? 'yes' : 'no' },
          ]}
          onClose={() => setDialog(null)}
          onSubmit={(v) => act('/justificatif', { note: v.note, declarative: v.declarative === 'yes' }, 'Justificatif enregistré', 'PUT')}
        />
      )}
      {e && dialog === 'edit' && (
        <FormModal
          title="Modifier la demande"
          fields={[
            { name: 'beneficiary', label: 'Bénéficiaire', value: e.beneficiary, required: true },
            { name: 'amount', label: 'Montant', type: 'number', value: String(e.amount), required: true },
            { name: 'currency', label: 'Devise', value: e.currency, required: true, maxLength: 3 },
            { name: 'reason', label: 'Motif', type: 'textarea', value: e.reason, required: true },
          ]}
          onClose={() => setDialog(null)}
          onSubmit={(v) => act('', { beneficiary: v.beneficiary, amount: Number(v.amount), currency: v.currency, reason: v.reason }, 'Demande modifiée', 'PATCH')}
        />
      )}
      {e && typeof dialog === 'object' && dialog && (
        <FormModal
          title={dialog.action === 'accept' ? "Accepter l'écart" : 'Annuler le paiement en écart'}
          fields={[{ name: 'motive', label: 'Motif de la régularisation', type: 'textarea', required: true }]}
          onClose={() => setDialog(null)}
          onSubmit={(v) => act('/discrepancy', { action: dialog.action, paymentId: dialog.paymentId, motive: v.motive }, 'Écart régularisé')}
        />
      )}
    </Drawer>
  );
}
