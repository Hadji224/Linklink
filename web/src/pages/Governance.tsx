import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { useApp } from '../data';
import { formatDateTime, formatShortDate } from '../format';
import { go } from '../route';
import { useCan } from '../perm';
import { useRealtime } from '../realtime';
import { FN_KEYS, FN_LABEL, type Fn } from '../types';
import { Empty, ErrorNote, PageHeader, Spinner, Tabs, useConfirm, useToast } from '../ui';
import { FormModal } from './FormModal';

type TabId = 'validations' | 'fonctions' | 'mandats' | 'regles' | 'securite';

interface Pending { type: string; id: string; title: string; detail: string; since: string; link: string; blocked: boolean; blockedReason: string; overdue: boolean; canDecide: boolean }
interface FnRow { fn: Fn; label: string; unique: boolean; holders: { id: string; name: string; available: boolean }[] }
interface Mandate { id: string; grantee: { id: string; name: string }; grantor: string; scope: string; fn: string | null; validationType: string | null; reason: string; endsAt: string; revokedAt: string | null; active: boolean }
interface Absence { id: string; user: { id: string; name: string }; startsOn: string; endsOn: string; note: string; current: boolean }
interface Rule { type: string; firstReminderH: number; intervalH: number; escalationH: number }
interface AccountAction { id: string; userId: string; userName: string; action: string; reason: string; status: string; motive: string; createdAt: string; requestedBy: string; canDecide: boolean }
interface Transfer { id: string; from: { id: string; name: string }; to: { id: string; name: string }; state: string; motive: string }
interface Emergency {
  holders: { id: string; name: string; codeSet: boolean }[]; ready: boolean; isHolder: boolean; codeSet: boolean; canDesignate: boolean;
  session: null | { id: string; state: 'pending' | 'active'; firstHolder: string; secondHolder: string | null; createdAt: string; activatedAt: string | null; expiresAt: string; canConfirm: boolean; mine: boolean };
}

const TYPE_FR: Record<string, string> = { expense: 'Dépense', archive: 'Archivage', communication: 'Communication', account: 'Compte' };
const SCOPE_FR: Record<string, string> = { technical_ops: "Opérations techniques", spokesperson: 'Porte-parole', validator_replacement: 'Remplacement de validateur', interim: 'Intérim' };
const MANDATE_TYPE_ROUTE: Record<string, string> = { expense: '#finances', archive: '#projets', communication: '#communications', account: '#gouvernance' };

export function Governance({ tab }: { tab?: string }) {
  const { epoch } = useRealtime();
  const { can } = useCan();
  const current: TabId = (['validations', 'fonctions', 'mandats', 'regles', 'securite'].includes(tab ?? '') ? tab : 'validations') as TabId;
  const [pending, setPending] = useState<Pending[]>([]);
  useEffect(() => { api<{ pending: Pending[] }>('/validations').then((r) => setPending(r.pending)).catch(() => {}); }, [epoch, current]);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader title="Gouvernance" />
      <Tabs<TabId>
        label="Sections de la gouvernance"
        value={current}
        onChange={(t) => go(`gouvernance/${t}`)}
        tabs={[
          { id: 'validations', label: 'Validations', badge: pending.filter((p) => p.canDecide).length },
          { id: 'fonctions', label: 'Fonctions' },
          { id: 'mandats', label: 'Mandats et absences' },
          { id: 'regles', label: 'Relances' },
          { id: 'securite', label: can('function.assign') || can('journal.security') ? 'Sécurité et urgence' : 'Urgence' },
        ]}
      />
      <div className="min-h-0 flex-1 overflow-y-auto p-3 md:mx-auto md:w-full md:max-w-4xl">
        {current === 'validations' && <ValidationsTab pending={pending} />}
        {current === 'fonctions' && <FunctionsTab />}
        {current === 'mandats' && <MandatesTab />}
        {current === 'regles' && <RulesTab />}
        {current === 'securite' && <SecurityTab />}
      </div>
    </div>
  );
}

/* ------------------------------------------------ Validations ------------------------------------------------ */

function ValidationsTab({ pending }: { pending: Pending[] }) {
  const [overview, setOverview] = useState<{ blocked: { type: string; id: string; title: string; reason: string }[]; orphans: { id: string; name: string }[]; discrepancies: number } | null>(null);
  useEffect(() => { api<typeof overview>('/governance/overview').then(setOverview).catch(() => {}); }, []);
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate">Tout ce qui attend une décision. Une validation dont le décideur est absent <strong>reste en attente</strong> : personne ne décide « de fait ». Seul un mandat de remplacement valide débloque la situation.</p>
      <section aria-label="À traiter">
        <h2 className="mb-2 font-bold">En attente</h2>
        {pending.length === 0 && <Empty icon="check">Aucune validation en attente.</Empty>}
        <ul className="space-y-2">
          {pending.map((p) => (
            <li key={`${p.type}:${p.id}`}>
              <a href={p.link.startsWith('#') ? p.link : `#${p.link}`} className="card flex flex-wrap items-center gap-3 p-3 hover:border-electric">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-bold">{p.title}</span>
                  <span className="block truncate text-sm text-slate">{TYPE_FR[p.type] ?? p.type} · en attente depuis le {formatShortDate(p.since)} — {p.detail}</span>
                  {p.blocked && <span className="block text-sm font-semibold text-red-700">Bloquée : {p.blockedReason}</span>}
                </span>
                {p.canDecide && <span className="badge bd-electric">À vous de décider</span>}
                {p.overdue && <span className="badge bd-danger">En retard</span>}
              </a>
            </li>
          ))}
        </ul>
      </section>
      {overview && (overview.orphans.length > 0 || overview.discrepancies > 0) && (
        <section aria-label="Alertes">
          <h2 className="mb-2 font-bold">Alertes</h2>
          <ul className="space-y-2">
            {overview.orphans.map((o) => <li key={o.id}><a className="card block p-3 hover:border-electric" href={`#projets/${o.id}`}>Projet sans responsable disponible : <strong>{o.name}</strong></a></li>)}
            {overview.discrepancies > 0 && <li><a className="card block p-3 hover:border-electric" href="#finances">{overview.discrepancies} écart{overview.discrepancies > 1 ? 's' : ''} de paiement à régulariser</a></li>}
          </ul>
        </section>
      )}
      <p className="text-xs text-slate">Vers : <a className="font-semibold text-electric" href={MANDATE_TYPE_ROUTE.expense}>Finances</a> · <a className="font-semibold text-electric" href={MANDATE_TYPE_ROUTE.communication}>Communications</a> · <a className="font-semibold text-electric" href="#projets">Projets</a></p>
    </div>
  );
}

/* ------------------------------------------------- Fonctions ------------------------------------------------- */

function FunctionsTab() {
  const { members, refreshMembers } = useApp();
  const { refreshMe } = useAuth();
  const { can, isAdmin } = useCan();
  const toast = useToast();
  const confirm = useConfirm();
  const [rows, setRows] = useState<FnRow[] | null>(null);
  const [error, setError] = useState('');
  const [assign, setAssign] = useState<Fn | null>(null);
  const [needDecision, setNeedDecision] = useState<{ fn: Fn; userId: string; replace: boolean; message: string } | null>(null);
  const load = useCallback(async () => setRows((await api<{ functions: FnRow[] }>('/functions')).functions), []);
  useEffect(() => { void load().catch((e) => setError(e.message)); }, [load]);

  const noPdg = rows ? (rows.find((r) => r.fn === 'pdg')?.holders.length ?? 0) === 0 : false;
  const allowed = can('function.assign') || (isAdmin && noPdg);
  const candidates = members.filter((m) => m.role !== 'guest' && !m.suspended);

  async function submit(fn: Fn, userId: string, replace: boolean, cumulDecision = '') {
    try {
      const r = await api<{ warning: string | null }>('/functions', { method: 'POST', body: { userId, fn, replace, cumulDecision } });
      toast.success(r.warning ? `Fonction attribuée. Attention : ${r.warning}` : 'Fonction attribuée');
      await Promise.all([load(), refreshMembers(), refreshMe()]);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Action impossible.';
      if (/décision de cumul/i.test(message)) { setNeedDecision({ fn, userId, replace, message }); return; }
      throw e;
    }
  }
  async function remove(fn: Fn, id: string, name: string) {
    if (!(await confirm({ title: `Retirer « ${FN_LABEL[fn]} » à ${name} ?`, confirmLabel: 'Retirer', danger: true }))) return;
    try { await api(`/functions/${fn}/${id}`, { method: 'DELETE' }); await Promise.all([load(), refreshMembers(), refreshMe()]); toast.success('Fonction retirée'); }
    catch (e) { setError(e instanceof Error ? e.message : 'Action impossible.'); }
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-slate">Les six fonctions de l'équipe. Le rôle d'accès (Administrateur technique, Fondateur, Invité) ne donne aucun pouvoir métier : ce sont les fonctions qui en donnent. <strong>PDG et Caissier ne peuvent pas être cumulés.</strong></p>
      <ErrorNote>{error}</ErrorNote>
      {!rows && <Spinner />}
      {noPdg && <p role="alert" className="rounded-xl bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-900">Aucun PDG n'est désigné : l'administrateur technique peut en désigner un.</p>}
      <ul className="space-y-2">
        {FN_KEYS.map((fn) => {
          const row = rows?.find((r) => r.fn === fn);
          return (
            <li key={fn} className="card p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-bold">{FN_LABEL[fn]} <span className="text-xs font-normal text-slate">{row?.unique ? '· fonction unique' : '· plusieurs titulaires possibles'}</span></h3>
                {allowed && (fn !== 'pdg' || can('function.assign') || noPdg) && <button className="btn btn-ghost btn-sm" onClick={() => setAssign(fn)}>{row?.unique && row.holders.length ? 'Remplacer' : 'Attribuer'}</button>}
              </div>
              {row?.holders.length ? (
                <ul className="mt-2 flex flex-wrap gap-2">
                  {row.holders.map((h) => (
                    <li key={h.id} className="flex items-center gap-1 rounded-full bg-mist px-3 py-1 text-sm font-semibold">
                      {h.name}{!h.available && <span className="text-xs font-normal text-amber-800"> (absent·e)</span>}
                      {can('function.assign') && !(fn === 'pdg' && row.holders.length <= 1) && <button aria-label={`Retirer ${FN_LABEL[fn]} à ${h.name}`} className="ml-1 text-slate hover:text-red-700" onClick={() => void remove(fn, h.id, h.name)}>✕</button>}
                    </li>
                  ))}
                </ul>
              ) : <p className="mt-1 text-sm text-slate">Personne pour l'instant.</p>}
            </li>
          );
        })}
      </ul>
      {assign && (
        <FormModal
          title={`${FN_LABEL[assign]} — attribuer`}
          intro={rows?.find((r) => r.fn === assign)?.holders.length && rows.find((r) => r.fn === assign)?.unique ? 'Cette fonction est déjà tenue : la nouvelle personne la remplace.' : undefined}
          fields={[
            { name: 'userId', label: 'Fondateur', type: 'select', required: true, options: candidates.map((m) => ({ value: m.id, label: m.name })) },
            { name: 'note', label: 'Note (facultatif)', maxLength: 300 },
          ]}
          onClose={() => setAssign(null)}
          onSubmit={(v) => submit(assign, v.userId ?? '', !!rows?.find((r) => r.fn === assign)?.unique && !!rows.find((r) => r.fn === assign)?.holders.length)}
        />
      )}
      {needDecision && (
        <FormModal
          title="Décision de cumul"
          intro={needDecision.message}
          fields={[{ name: 'decision', label: 'Décision journalisée', type: 'textarea', required: true, hint: 'Qui a décidé, pourquoi, pour combien de temps.' }]}
          submitLabel="Confirmer le cumul"
          onClose={() => setNeedDecision(null)}
          onSubmit={(v) => submit(needDecision.fn, needDecision.userId, needDecision.replace, v.decision)}
        />
      )}
    </div>
  );
}

/* --------------------------------------------- Mandats et absences --------------------------------------------- */

function MandatesTab() {
  const { user } = useAuth();
  const { members } = useApp();
  const { can } = useCan();
  const toast = useToast();
  const confirm = useConfirm();
  const [mandates, setMandates] = useState<Mandate[]>([]);
  const [absences, setAbsences] = useState<Absence[]>([]);
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState<null | 'mandate' | 'absence'>(null);
  const load = useCallback(async () => {
    const [m, a] = await Promise.all([api<{ mandates: Mandate[] }>('/mandates'), api<{ absences: Absence[] }>('/absences')]);
    setMandates(m.mandates); setAbsences(a.absences);
  }, []);
  useEffect(() => { void load().catch((e) => setError(e.message)); }, [load]);
  const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
  const staff = members.filter((m) => m.role !== 'guest' && !m.suspended);

  return (
    <div className="space-y-5">
      <ErrorNote>{error}</ErrorNote>
      <section aria-label="Absences">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-bold">Absences déclarées</h2>
          <button className="btn btn-primary btn-sm" onClick={() => setDialog('absence')}>Déclarer une absence</button>
        </div>
        <p className="mb-2 text-sm text-slate">Pendant une absence, vos validations restent en attente (elles ne sont jamais prises « de fait » par un autre) sauf mandat de remplacement. Au-delà de 30 jours, l'équipe est alertée.</p>
        {absences.length === 0 && <p className="text-sm text-slate">Aucune absence déclarée.</p>}
        <ul className="space-y-2">
          {absences.map((a) => (
            <li key={a.id} className="card flex flex-wrap items-center gap-3 p-3">
              <span className="min-w-0 flex-1"><strong>{a.user.name}</strong> — du {a.startsOn} au {a.endsOn}{a.note ? ` · ${a.note}` : ''}{a.current && <span className="badge bd-warning ml-2">En cours</span>}</span>
              {(a.user.id === user?.id || can('function.assign') || user?.role === 'admin') && (
                <button className="btn btn-ghost btn-sm" onClick={async () => { try { await api(`/absences/${a.id}`, { method: 'DELETE' }); await load(); toast.success('Absence terminée'); } catch (e) { setError(e instanceof Error ? e.message : 'Action impossible.'); } }}>Terminer</button>
              )}
            </li>
          ))}
        </ul>
      </section>
      <section aria-label="Mandats">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-bold">Mandats</h2>
          {can('mandate.grant') && <button className="btn btn-primary btn-sm" onClick={() => setDialog('mandate')}>Donner un mandat</button>}
        </div>
        <p className="mb-2 text-sm text-slate">Un mandat est écrit, motivé, limité dans le temps (180 jours au maximum), révocable, et chaque action faite à ce titre est marquée comme telle dans le journal.</p>
        {mandates.length === 0 && <p className="text-sm text-slate">Aucun mandat.</p>}
        <ul className="space-y-2">
          {mandates.map((m) => (
            <li key={m.id} className={`card flex flex-wrap items-center gap-3 p-3 ${m.active ? '' : 'opacity-60'}`}>
              <span className="min-w-0 flex-1">
                <strong>{SCOPE_FR[m.scope] ?? m.scope}</strong> → {m.grantee.name}
                {m.fn ? ` (${FN_LABEL[m.fn as Fn] ?? m.fn})` : ''}{m.validationType ? ` · ${TYPE_FR[m.validationType]}` : ''}
                <span className="block text-sm text-slate">{m.reason} · jusqu'au {formatShortDate(m.endsAt)} · donné par {m.grantor}{m.revokedAt ? ' · révoqué' : !m.active ? ' · expiré' : ''}</span>
              </span>
              {m.active && (can('mandate.grant') || m.grantor === user?.name) && (
                <button className="btn btn-ghost btn-sm" onClick={async () => { if (!(await confirm({ title: 'Révoquer ce mandat ?', confirmLabel: 'Révoquer', danger: true }))) return; try { await api(`/mandates/${m.id}`, { method: 'DELETE' }); await load(); toast.success('Mandat révoqué'); } catch (e) { setError(e instanceof Error ? e.message : 'Action impossible.'); } }}>Révoquer</button>
              )}
            </li>
          ))}
        </ul>
      </section>
      {dialog === 'absence' && (
        <FormModal
          title="Déclarer une absence"
          fields={[
            ...(can('function.assign') || user?.role === 'admin' ? [{ name: 'userId', label: 'Pour (vous par défaut)', type: 'select' as const, options: staff.map((m) => ({ value: m.id, label: m.name })) }] : []),
            { name: 'startsOn', label: 'Du', type: 'date', required: true, value: inDays(0) },
            { name: 'endsOn', label: "Jusqu'au", type: 'date', required: true, value: inDays(7) },
            { name: 'note', label: 'Note (facultatif)', maxLength: 300 },
          ]}
          onClose={() => setDialog(null)}
          onSubmit={async (v) => { await api('/absences', { method: 'POST', body: { userId: v.userId || undefined, startsOn: v.startsOn, endsOn: v.endsOn, note: v.note } }); toast.success('Absence enregistrée'); await load(); }}
        />
      )}
      {dialog === 'mandate' && (
        <FormModal
          title="Donner un mandat"
          fields={[
            { name: 'scope', label: 'Type de mandat', type: 'select', required: true, options: Object.entries(SCOPE_FR).map(([value, label]) => ({ value, label })) },
            { name: 'granteeId', label: 'Mandataire', type: 'select', required: true, options: staff.map((m) => ({ value: m.id, label: m.name })) },
            { name: 'fn', label: 'Fonction assurée (intérim)', type: 'select', options: FN_KEYS.map((f) => ({ value: f, label: FN_LABEL[f] })) },
            { name: 'validationType', label: 'Validation remplacée', type: 'select', options: Object.entries(TYPE_FR).map(([value, label]) => ({ value, label })) },
            { name: 'endsAt', label: "Jusqu'au", type: 'date', required: true, value: inDays(14) },
            { name: 'reason', label: 'Motif', type: 'textarea', required: true },
          ]}
          onClose={() => setDialog(null)}
          onSubmit={async (v) => { await api('/mandates', { method: 'POST', body: { scope: v.scope, granteeId: v.granteeId, fn: v.fn || undefined, validationType: v.validationType || undefined, endsAt: new Date(`${v.endsAt}T23:59:59`).toISOString(), reason: v.reason } }); toast.success('Mandat accordé'); await load(); }}
        />
      )}
    </div>
  );
}

/* --------------------------------------------------- Relances --------------------------------------------------- */

function RulesTab() {
  const { can } = useCan();
  const toast = useToast();
  const [rules, setRules] = useState<Rule[]>([]);
  const [edit, setEdit] = useState<Rule | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => setRules((await api<{ rules: Rule[] }>('/validation-rules')).rules), []);
  useEffect(() => { void load().catch((e) => setError(e.message)); }, [load]);
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate">Quand une validation traîne, LinkLink relance le décideur, puis escalade. Par défaut : première relance à 24 h, puis toutes les 48 h, escalade à 120 h. Le PDG peut ajuster ces délais.</p>
      <ErrorNote>{error}</ErrorNote>
      <ul className="space-y-2">
        {rules.map((r) => (
          <li key={r.type} className="card flex flex-wrap items-center gap-3 p-3">
            <span className="min-w-0 flex-1"><strong>{TYPE_FR[r.type] ?? r.type}</strong><span className="block text-sm text-slate">1re relance : {r.firstReminderH} h · puis toutes les {r.intervalH} h · escalade : {r.escalationH} h</span></span>
            {can('rules.edit') && <button className="btn btn-ghost btn-sm" onClick={() => setEdit(r)}>Modifier</button>}
          </li>
        ))}
      </ul>
      {edit && (
        <FormModal
          title={`Relances — ${TYPE_FR[edit.type] ?? edit.type}`}
          fields={[
            { name: 'a', label: 'Première relance (heures)', type: 'number', value: String(edit.firstReminderH), required: true, min: 1 },
            { name: 'b', label: 'Intervalle (heures)', type: 'number', value: String(edit.intervalH), required: true, min: 1 },
            { name: 'c', label: 'Escalade (heures)', type: 'number', value: String(edit.escalationH), required: true, min: 1 },
          ]}
          onClose={() => setEdit(null)}
          onSubmit={async (v) => { await api(`/validation-rules/${edit.type}`, { method: 'PUT', body: { firstReminderH: Number(v.a), intervalH: Number(v.b), escalationH: Number(v.c) } }); toast.success('Délais enregistrés'); await load(); }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------- Sécurité et urgence ------------------------------------------- */

function SecurityTab() {
  const { user } = useAuth();
  const { members, refreshMembers } = useApp();
  const { can, isAdmin } = useCan();
  const { epoch } = useRealtime();
  const toast = useToast();
  const [actions, setActions] = useState<AccountAction[]>([]);
  const [transfer, setTransfer] = useState<{ transfer: Transfer | null; canRequest: boolean; canDecide: boolean; canConfirm: boolean } | null>(null);
  const [em, setEm] = useState<Emergency | null>(null);
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState<null | 'transfer' | 'holders' | 'code' | 'start' | 'confirm' | 'reset' | { kind: 'decide'; id: string; decision: 'approve' | 'refuse' } | { kind: 'transferRefuse'; id: string }>(null);
  const [backups, setBackups] = useState<{ name: string; size: number; at: string }[] | null>(null);
  const founders = members.filter((m) => m.role === 'member' && !m.suspended);

  const load = useCallback(async () => {
    const [a, t, e] = await Promise.all([api<{ actions: AccountAction[] }>('/account-actions'), api<typeof transfer>('/admin-transfer'), api<{ emergency: Emergency }>('/emergency')]);
    setActions(a.actions); setTransfer(t); setEm(e.emergency);
  }, []);
  useEffect(() => { void load().catch((e) => setError(e.message)); }, [load, epoch]);
  const guard = async (fn: () => Promise<unknown>, ok: string) => {
    try { await fn(); toast.success(ok); await load(); } catch (e) { setError(e instanceof Error ? e.message : 'Action impossible.'); }
  };
  const s = em?.session;

  return (
    <div className="space-y-5">
      <ErrorNote>{error}</ErrorNote>

      <section aria-label="Suspensions de compte" className="space-y-2">
        <h2 className="font-bold">Suspension de compte</h2>
        <p className="text-sm text-slate">L'administrateur technique demande, le PDG valide : personne ne se suspend ni ne se réactive seul. Une suspension coupe les sessions et met fin aux fonctions du compte.</p>
        {isAdmin && (
          <div className="flex flex-wrap gap-2">
            {members.filter((m) => m.id !== user?.id && m.role !== 'admin').map((m) => (
              <button key={m.id} className="btn btn-ghost btn-sm" onClick={() => setDialog({ kind: 'decide', id: m.id, decision: m.suspended ? 'approve' : 'refuse' })}>
                {m.suspended ? 'Réactiver' : 'Suspendre'} {m.name}
              </button>
            ))}
          </div>
        )}
        <ul className="space-y-2">
          {actions.filter((a) => a.status === 'pending' || a.canDecide).slice(0, 10).map((a) => (
            <li key={a.id} className="card flex flex-wrap items-center gap-3 p-3">
              <span className="min-w-0 flex-1"><strong>{a.action === 'suspend' ? 'Suspension' : 'Réactivation'} — {a.userName}</strong><span className="block text-sm text-slate">{a.reason} · demandé par {a.requestedBy}</span></span>
              {a.canDecide && (<>
                <button className="btn btn-primary btn-sm" onClick={() => guard(() => api(`/account-actions/${a.id}/decision`, { method: 'POST', body: { decision: 'approve' } }).then(refreshMembers), 'Décision enregistrée')}>Valider</button>
                <button className="btn btn-ghost btn-sm" onClick={() => setDialog({ kind: 'transferRefuse', id: `acct:${a.id}` })}>Refuser</button>
              </>)}
            </li>
          ))}
          {actions.filter((a) => a.status === 'pending').length === 0 && <li className="text-sm text-slate">Aucune demande en attente.</li>}
        </ul>
      </section>

      <section aria-label="Transfert de l'administration" className="space-y-2">
        <h2 className="font-bold">Transfert de l'administration technique</h2>
        <p className="text-sm text-slate">Étapes : demande → validation du PDG → le successeur se reconnecte et confirme → l'ancien administrateur redevient fondateur.</p>
        {transfer?.transfer ? (
          <div className="card p-3 text-sm">
            <p><strong>{transfer.transfer.from.name}</strong> → <strong>{transfer.transfer.to.name}</strong> · {transfer.transfer.state === 'pending' ? 'en attente de validation' : 'en attente de confirmation du successeur'}</p>
            <p className="text-slate">{transfer.transfer.motive}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {transfer.canDecide && <button className="btn btn-primary btn-sm" onClick={() => guard(() => api(`/admin-transfer/${transfer.transfer!.id}/decision`, { method: 'POST', body: { decision: 'approve' } }), 'Transfert validé')}>Valider</button>}
              {transfer.canDecide && <button className="btn btn-ghost btn-sm" onClick={() => setDialog({ kind: 'transferRefuse', id: `transfer:${transfer.transfer!.id}` })}>Refuser</button>}
              {transfer.canConfirm && <button className="btn btn-primary btn-sm" onClick={() => guard(() => api(`/admin-transfer/${transfer.transfer!.id}/confirm`, { method: 'POST' }), 'Transfert terminé')}>Confirmer mon accès</button>}
              {(isAdmin || can('function.assign')) && <button className="btn btn-ghost btn-sm" onClick={() => guard(() => api(`/admin-transfer/${transfer.transfer!.id}/cancel`, { method: 'POST' }), 'Transfert annulé')}>Annuler</button>}
            </div>
          </div>
        ) : transfer?.canRequest ? <button className="btn btn-ghost" onClick={() => setDialog('transfer')}>Demander le transfert</button> : <p className="text-sm text-slate">Aucun transfert en cours.</p>}
      </section>

      <section aria-label="Accès d'urgence" className="space-y-2">
        <h2 className="font-bold">Accès d'urgence (verre brisé)</h2>
        <p className="text-sm text-slate">Pour le cas où l'administrateur technique est injoignable. Deux détenteurs désignés par le PDG, deux codes personnels, activation conjointe, durée limitée à 2 h. La seule action possible : réinitialiser le mot de passe de l'administrateur technique (et consulter la liste des sauvegardes). Tout est journalisé et notifié à toute l'équipe.</p>
        {em && (
          <div className="card space-y-2 p-3 text-sm">
            <p>Détenteurs : {em.holders.length ? em.holders.map((h) => `${h.name}${h.codeSet ? ' (code défini)' : ' (code à définir)'}`).join(' · ') : 'aucun désigné'}</p>
            <div className="flex flex-wrap gap-2">
              {em.canDesignate && <button className="btn btn-ghost btn-sm" onClick={() => setDialog('holders')}>Désigner les deux détenteurs</button>}
              {em.isHolder && <button className="btn btn-ghost btn-sm" onClick={() => setDialog('code')}>{em.codeSet ? 'Changer mon code' : 'Définir mon code'}</button>}
              {em.isHolder && em.ready && !s && <button className="btn btn-danger btn-sm" onClick={() => setDialog('start')}>Demander l'accès d'urgence</button>}
            </div>
            {s && (
              <div className="rounded-xl bg-red-50 p-3" role="status">
                <p className="font-semibold text-red-900">{s.state === 'pending' ? `Demande de ${s.firstHolder} — seconde confirmation attendue avant ${formatDateTime(s.expiresAt)}` : `Accès actif jusqu'à ${formatDateTime(s.expiresAt)}`}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {s.canConfirm && <button className="btn btn-danger btn-sm" onClick={() => setDialog('confirm')}>Confirmer avec mon code</button>}
                  {s.state === 'active' && s.mine && <button className="btn btn-ghost btn-sm" onClick={() => setDialog('reset')}>Réinitialiser le mot de passe de l'administrateur</button>}
                  {s.state === 'active' && s.mine && <button className="btn btn-ghost btn-sm" onClick={() => guard(async () => setBackups((await api<{ backups: { name: string; size: number; at: string }[] }>(`/emergency/sessions/${s.id}/backups`)).backups), 'Liste chargée')}>Voir les sauvegardes</button>}
                  <button className="btn btn-ghost btn-sm" onClick={() => guard(() => api(`/emergency/sessions/${s.id}/close`, { method: 'POST' }), 'Accès clos')}>Clore</button>
                </div>
                {backups && <ul className="mt-2 text-xs">{backups.map((b) => <li key={b.name}>{b.name} — {Math.round(b.size / 1024)} Ko — {formatDateTime(b.at)}</li>)}{backups.length === 0 && <li>Aucune sauvegarde.</li>}</ul>}
              </div>
            )}
          </div>
        )}
      </section>

      {dialog === 'transfer' && (
        <FormModal title="Demander le transfert de l'administration" fields={[{ name: 'to', label: 'Successeur (fondateur)', type: 'select', required: true, options: founders.map((m) => ({ value: m.id, label: m.name })) }, { name: 'motive', label: 'Motif', type: 'textarea', required: true }]} onClose={() => setDialog(null)} onSubmit={(v) => guard(() => api('/admin-transfer', { method: 'POST', body: { toUserId: v.to, motive: v.motive } }), 'Demande envoyée')} />
      )}
      {dialog === 'holders' && (
        <FormModal title="Détenteurs de l'accès d'urgence" intro="Deux fondateurs différents (ni l'administrateur technique, ni un invité)." fields={[{ name: 'a', label: 'Premier détenteur', type: 'select', required: true, options: founders.map((m) => ({ value: m.id, label: m.name })) }, { name: 'b', label: 'Second détenteur', type: 'select', required: true, options: founders.map((m) => ({ value: m.id, label: m.name })) }]} onClose={() => setDialog(null)} onSubmit={(v) => guard(() => api('/emergency/holders', { method: 'PUT', body: { userIds: [v.a, v.b] } }), 'Détenteurs désignés')} />
      )}
      {dialog === 'code' && (
        <FormModal title="Mon code d'urgence" intro="Personnel, jamais partagé, jamais affiché. Au moins 10 caractères." fields={[{ name: 'code', label: "Code d'urgence", type: 'password', required: true }, { name: 'password', label: 'Votre mot de passe (confirmation)', type: 'password', required: true }]} onClose={() => setDialog(null)} onSubmit={(v) => guard(() => api('/emergency/code', { method: 'POST', body: { code: v.code, password: v.password } }), 'Code enregistré')} />
      )}
      {dialog === 'start' && (
        <FormModal title="Demander l'accès d'urgence" intro="Le second détenteur sera alerté ; toute l'équipe sera informée." fields={[{ name: 'code', label: 'Votre code', type: 'password', required: true }, { name: 'note', label: 'Motif', type: 'textarea', required: true }]} submitLabel="Demander" danger onClose={() => setDialog(null)} onSubmit={(v) => guard(() => api('/emergency/sessions', { method: 'POST', body: { code: v.code, note: v.note } }), 'Demande envoyée au second détenteur')} />
      )}
      {dialog === 'confirm' && s && (
        <FormModal title="Confirmer l'accès d'urgence" fields={[{ name: 'code', label: 'Votre code', type: 'password', required: true }]} submitLabel="Activer" danger onClose={() => setDialog(null)} onSubmit={(v) => guard(() => api(`/emergency/sessions/${s.id}/confirm`, { method: 'POST', body: { code: v.code } }), 'Accès activé')} />
      )}
      {dialog === 'reset' && s && (
        <FormModal title="Réinitialiser le mot de passe de l'administrateur" intro="Communiquez le nouveau mot de passe à l'administrateur par un canal sûr, puis clôturez l'accès." fields={[{ name: 'pw', label: 'Nouveau mot de passe (12 caractères minimum)', type: 'password', required: true }]} danger onClose={() => setDialog(null)} onSubmit={(v) => guard(() => api(`/emergency/sessions/${s.id}/admin-reset`, { method: 'POST', body: { newPassword: v.pw } }), 'Mot de passe réinitialisé')} />
      )}
      {dialog && typeof dialog === 'object' && dialog.kind === 'decide' && (
        <FormModal
          title={dialog.decision === 'approve' ? 'Demander la réactivation' : 'Demander la suspension'}
          intro="La demande est soumise à la validation du PDG."
          fields={[{ name: 'reason', label: 'Motif', type: 'textarea', required: true }]}
          onClose={() => setDialog(null)}
          onSubmit={(v) => guard(() => api(`/members/${(dialog as { id: string }).id}/${(dialog as { decision: string }).decision === 'approve' ? 'reactivation' : 'suspension'}`, { method: 'POST', body: { reason: v.reason } }), 'Demande envoyée au PDG')}
        />
      )}
      {dialog && typeof dialog === 'object' && dialog.kind === 'transferRefuse' && (
        <FormModal
          title="Refuser"
          fields={[{ name: 'motive', label: 'Motif du refus', type: 'textarea', required: true }]}
          danger
          submitLabel="Refuser"
          onClose={() => setDialog(null)}
          onSubmit={(v) => {
            const [kind, id] = (dialog as { id: string }).id.split(':') as [string, string];
            return guard(() => api(kind === 'acct' ? `/account-actions/${id}/decision` : `/admin-transfer/${id}/decision`, { method: 'POST', body: { decision: 'refuse', motive: v.motive } }), 'Refus enregistré');
          }}
        />
      )}
    </div>
  );
}
