import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { useApp } from '../data';
import { formatDateTime } from '../format';
import { useCan } from '../perm';
import { useRealtime } from '../realtime';
import { Drawer, Empty, ErrorNote, Icon, PageHeader, Spinner, useConfirm, useToast } from '../ui';
import { FormModal } from './FormModal';

interface Comm {
  id: string;
  family: 'internal' | 'official';
  kind: string;
  kindLabel: string;
  title: string;
  body: string;
  status: 'draft' | 'in_validation' | 'validated' | 'published' | 'refused' | 'withdrawn';
  version: number;
  crisis: boolean;
  author: { id: string | null; name: string };
  projectName: string | null;
  circuit: string[];
  openSlots: string[];
  blocked: string[];
  reviewDueAt: string | null;
  reviewedAt: string | null;
  reviewNote: string;
  decisionMotive: string;
  publishedAt: string | null;
  updatedAt: string;
  permissions: { edit: boolean; submit: boolean; validate: boolean; publish: boolean; withdraw: boolean; review: boolean };
  validateHint: string | null;
  validations?: { version: number; slot: string; by: string; decision: 'approve' | 'refuse'; motive: string; mandate: boolean; createdAt: string; current: boolean }[];
}

const STATUS_FR: Record<Comm['status'], string> = { draft: 'Brouillon', in_validation: 'En validation', validated: 'Validé — à publier', published: 'Publié', refused: 'Refusé', withdrawn: 'Retiré' };
const TONE: Record<Comm['status'], string> = { draft: 'bd-warning', in_validation: 'bd-electric', validated: 'bd-cyan', published: 'bd-success', refused: 'bd-danger', withdrawn: 'bd-slate' };
const KINDS: { value: string; label: string; help: string }[] = [
  { value: 'current', label: 'Publication courante', help: 'Validée par le Chargé de communication.' },
  { value: 'project', label: 'Contenu lié à un projet', help: 'Chargé de communication + Chef de projet du projet.' },
  { value: 'official', label: 'Annonce officielle / partenariat', help: 'PDG + Chargé de communication.' },
  { value: 'technical', label: 'Sujet technique sensible', help: "PDG + Chef d'infrastructures." },
  { value: 'paid_ad', label: 'Publicité payante', help: 'PDG + Chargé de communication + Caissier.' },
];

export function Communications() {
  const { user } = useAuth();
  const { can } = useCan();
  const { epoch } = useRealtime();
  const { projects } = useApp();
  const toast = useToast();
  const [items, setItems] = useState<Comm[] | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<'todo' | 'all' | 'published'>('todo');
  const [open, setOpen] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | 'draft' | 'announce' | 'service' | 'crisis'>(null);

  const load = useCallback(async () => {
    try { setItems((await api<{ communications: Comm[] }>('/communications')).communications); setError(''); }
    catch (e) { setError(e instanceof Error ? e.message : 'Chargement impossible.'); }
  }, []);
  useEffect(() => { void load(); }, [load, epoch]);

  const mineToDo = (c: Comm) => c.permissions.validate || c.permissions.publish || c.permissions.review || (c.permissions.submit && c.status !== 'published');
  const shown = useMemo(() => (items ?? []).filter((c) => (filter === 'all' ? true : filter === 'published' ? c.status === 'published' : mineToDo(c) || c.status === 'in_validation' || c.status === 'validated' || c.status === 'draft')), [items, filter]);
  const waiting = (items ?? []).filter((c) => c.permissions.validate || c.permissions.publish || c.permissions.review).length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader title="Communications">
        <div className="flex flex-wrap gap-2">
          {can('comm.prepare') && user?.role !== 'guest' && <button className="btn btn-primary" onClick={() => setDialog('draft')}><Icon name="plus" className="h-4 w-4" /> Nouveau contenu</button>}
          {can('announce.internal') && <button className="btn btn-ghost" onClick={() => setDialog('announce')}>Annonce interne</button>}
          {can('announce.service') && <button className="btn btn-ghost" onClick={() => setDialog('service')}>Avis de service</button>}
          {can('crisis.publish') && <button className="btn btn-danger" onClick={() => setDialog('crisis')}>Communication de crise</button>}
        </div>
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto p-3 md:mx-auto md:w-full md:max-w-4xl">
        <p className="mb-3 text-sm text-slate">Un contenu officiel est <strong>préparé</strong> par n'importe quel fondateur, <strong>validé</strong> par des personnes distinctes selon son type, puis <strong>publié</strong> par le Chargé de communication. Toute modification après validation annule les validations.</p>
        {waiting > 0 && <p role="status" className="mb-3 rounded-xl bg-blue-50 px-3 py-2 text-sm font-semibold text-electric">{waiting} contenu{waiting > 1 ? 's' : ''} attend{waiting > 1 ? 'ent' : ''} une action de votre part.</p>}
        <div role="group" aria-label="Filtrer" className="mb-3 flex gap-1">
          {([['todo', 'En cours'], ['published', 'Publiés'], ['all', 'Tous']] as const).map(([id, label]) => (
            <button key={id} aria-pressed={filter === id} onClick={() => setFilter(id)} className={`min-h-9 rounded-full px-3 text-sm font-semibold ${filter === id ? 'bg-navy text-white' : 'bg-mist text-navy hover:bg-line'}`}>{label}</button>
          ))}
        </div>
        <ErrorNote>{error}</ErrorNote>
        {!items && !error && <Spinner />}
        {items && shown.length === 0 && <Empty icon="chat">Aucun contenu dans cette vue.</Empty>}
        <ul className="space-y-2">
          {shown.map((c) => (
            <li key={c.id}>
              <button onClick={() => setOpen(c.id)} className="card flex w-full flex-wrap items-center gap-3 p-3 text-left hover:border-electric">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-bold">{c.crisis ? '🚨 ' : ''}{c.title}</span>
                  <span className="text-xs text-slate">{c.kindLabel} · par {c.author.name} · {formatDateTime(c.updatedAt)}{c.status === 'in_validation' && c.openSlots.length ? ` · attend : ${c.openSlots.join(', ')}` : ''}</span>
                </span>
                <span className="flex flex-col items-end gap-1">
                  <span className={`badge ${TONE[c.status]}`}>{STATUS_FR[c.status]}</span>
                  {c.blocked.length > 0 && <span className="badge bd-danger">Validation bloquée</span>}
                  {mineToDo(c) && c.status !== 'draft' && <span className="badge bd-electric">Action attendue</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      {dialog === 'draft' && (
        <FormModal
          title="Nouveau contenu à valider"
          intro="Choisissez le type : il détermine qui doit valider. Vous ne pouvez pas valider votre propre contenu."
          submitLabel="Soumettre à validation"
          fields={[
            { name: 'kind', label: 'Type de contenu', type: 'select', required: true, options: KINDS.map((k) => ({ value: k.value, label: `${k.label} — ${k.help}` })) },
            { name: 'projectId', label: 'Projet (pour un contenu lié à un projet)', type: 'select', options: projects.filter((p) => p.status !== 'archived').map((p) => ({ value: p.id, label: p.name })) },
            { name: 'title', label: 'Titre', required: true, maxLength: 150 },
            { name: 'body', label: 'Contenu', type: 'textarea', required: true, maxLength: 4000 },
          ]}
          onClose={() => setDialog(null)}
          onSubmit={async (v) => { await api('/communications', { method: 'POST', body: { kind: v.kind, projectId: v.projectId || null, title: v.title, body: v.body, submit: true } }); toast.success('Soumis à validation'); await load(); }}
        />
      )}
      {(dialog === 'announce' || dialog === 'service') && (
        <FormModal
          title={dialog === 'service' ? 'Avis technique de service' : 'Annonce interne'}
          intro="Publié immédiatement dans #annonces et notifié à toute l'équipe."
          submitLabel="Publier"
          fields={[{ name: 'title', label: 'Titre', required: true, maxLength: 150 }, { name: 'body', label: 'Message', type: 'textarea', required: true, maxLength: 4000 }]}
          onClose={() => setDialog(null)}
          onSubmit={async (v) => { await api('/announcements', { method: 'POST', body: { title: v.title, body: v.body, service: dialog === 'service' } }); toast.success('Publié'); await load(); }}
        />
      )}
      {dialog === 'crisis' && (
        <FormModal
          title="Communication de crise"
          intro="Voie rapide : publiée immédiatement, sans validation préalable. Le PDG doit la passer en revue sous 24 h (confirmation ou retrait)."
          submitLabel="Publier maintenant"
          danger
          fields={[{ name: 'title', label: 'Titre', required: true, maxLength: 150 }, { name: 'body', label: 'Message', type: 'textarea', required: true, maxLength: 4000 }]}
          onClose={() => setDialog(null)}
          onSubmit={async (v) => { await api('/communications/crisis', { method: 'POST', body: { title: v.title, body: v.body } }); toast.success('Communication de crise publiée'); await load(); }}
        />
      )}
      {open && <CommDrawer id={open} onClose={() => setOpen(null)} onChanged={load} />}
    </div>
  );
}

function CommDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => Promise<void> }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { epoch } = useRealtime();
  const [c, setC] = useState<Comm | null>(null);
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState<null | 'refuse' | 'edit' | 'withdraw' | 'review'>(null);

  const load = useCallback(async () => {
    try { setC((await api<{ communication: Comm }>(`/communications/${id}`)).communication); } catch (e) { setError(e instanceof Error ? e.message : 'Chargement impossible.'); }
  }, [id]);
  useEffect(() => { void load(); }, [load, epoch]);

  async function act(path: string, body: unknown, ok: string, method: 'POST' | 'PATCH' = 'POST') {
    setError('');
    try {
      const r = await api<{ communication: Comm }>(`/communications/${id}${path}`, { method, body });
      setC(r.communication);
      toast.success(ok);
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action impossible.');
      throw e;
    }
  }
  const quiet = (p: Promise<unknown>) => p.catch(() => {});

  return (
    <Drawer title={c?.title ?? 'Communication'} subtitle={c ? `${c.kindLabel} · version ${c.version}` : undefined} onClose={onClose}>
      {!c && !error && <Spinner />}
      <ErrorNote>{error}</ErrorNote>
      {c && (
        <div className="space-y-4">
          <p><span className={`badge ${TONE[c.status]}`}>{STATUS_FR[c.status]}</span> <span className="text-sm text-slate">par {c.author.name}{c.projectName ? ` · ${c.projectName}` : ''}</span></p>
          <p className="whitespace-pre-wrap rounded-xl bg-mist p-3 text-sm">{c.body}</p>
          {c.circuit.length > 0 && <p className="text-sm"><strong>Circuit :</strong> {c.circuit.join(' → ')} → publication par le Chargé de communication.{c.status === 'in_validation' && c.openSlots.length > 0 && <> Reste : <strong>{c.openSlots.join(', ')}</strong>.</>}</p>}
          {c.blocked.length > 0 && <p role="alert" className="rounded-xl bg-red-50 px-3 py-2 text-sm font-semibold text-red-800">Validation bloquée : aucun validateur indépendant disponible pour {c.blocked.join(', ')}. Le contenu reste en attente.</p>}
          {c.decisionMotive && <p className="text-sm"><strong>Motif :</strong> {c.decisionMotive}</p>}
          {c.crisis && <p className="text-sm">🚨 Communication de crise — revue due avant le {c.reviewDueAt ? formatDateTime(c.reviewDueAt) : '—'}{c.reviewedAt ? ` · revue faite : ${c.reviewNote}` : ''}</p>}
          {c.validateHint && c.status === 'in_validation' && <p className="text-xs text-slate">Vous ne pouvez pas valider : {c.validateHint}</p>}
          <div className="flex flex-wrap gap-2">
            {c.permissions.validate && <button className="btn btn-primary" onClick={async () => { if (await confirm({ title: 'Valider ce contenu ?', message: 'Votre validation engage la version actuelle du texte.', confirmLabel: 'Valider' })) await quiet(act('/validate', { decision: 'approve' }, 'Validation enregistrée')); }}>Valider</button>}
            {c.permissions.validate && <button className="btn btn-ghost" onClick={() => setDialog('refuse')}>Refuser</button>}
            {c.permissions.publish && <button className="btn btn-primary" onClick={async () => { if (await confirm({ title: 'Publier maintenant ?', message: 'Le contenu sera diffusé dans #annonces et notifié.', confirmLabel: 'Publier' })) await quiet(act('/publish', {}, 'Publié')); }}>Publier</button>}
            {c.permissions.submit && <button className="btn btn-primary" onClick={() => void quiet(act('/submit', {}, 'Soumis à validation'))}>Soumettre à validation</button>}
            {c.permissions.edit && <button className="btn btn-ghost" onClick={() => setDialog('edit')}>Modifier</button>}
            {c.permissions.review && <button className="btn btn-primary" onClick={() => setDialog('review')}>Revue de crise</button>}
            {c.permissions.withdraw && <button className="btn btn-danger" onClick={() => setDialog('withdraw')}>Retirer</button>}
          </div>
          {c.permissions.edit && ['in_validation', 'validated'].includes(c.status) && <p className="text-xs text-slate">Modifier ce contenu annule les validations déjà données : il repart en validation.</p>}
          <section aria-label="Validations">
            <h3 className="mb-1 font-bold">Validations</h3>
            {c.validations?.length ? <ul className="space-y-1 text-sm">{c.validations.map((v, i) => <li key={i} className={v.current ? '' : 'opacity-50'}>{v.decision === 'approve' ? '✔' : '✖'} <strong>{v.slot}</strong> — {v.by}{v.mandate ? " (au titre d'un mandat)" : ''}{v.motive ? ` : ${v.motive}` : ''} <span className="text-xs text-slate">· v{v.version}{v.current ? '' : ' (annulée)'}</span></li>)}</ul> : <p className="text-sm text-slate">Aucune validation pour l'instant.</p>}
          </section>
        </div>
      )}
      {c && dialog === 'refuse' && <FormModal title="Refuser le contenu" fields={[{ name: 'motive', label: 'Motif du refus', type: 'textarea', required: true }]} submitLabel="Refuser" danger onClose={() => setDialog(null)} onSubmit={(v) => act('/validate', { decision: 'refuse', motive: v.motive }, 'Contenu refusé')} />}
      {c && dialog === 'withdraw' && <FormModal title="Retirer le contenu" intro="Retrait immédiat d'un contenu trompeur ou dangereux." fields={[{ name: 'motive', label: 'Motif', type: 'textarea', required: true }]} submitLabel="Retirer" danger onClose={() => setDialog(null)} onSubmit={(v) => act('/withdraw', { motive: v.motive }, 'Contenu retiré')} />}
      {c && dialog === 'review' && (
        <FormModal title="Revue de la communication de crise" fields={[{ name: 'decision', label: 'Décision', type: 'select', required: true, options: [{ value: 'confirm', label: 'Confirmer la publication' }, { value: 'withdraw', label: 'Retirer le contenu' }] }, { name: 'note', label: 'Note de revue', type: 'textarea', required: true }]} onClose={() => setDialog(null)} onSubmit={(v) => act('/review', { decision: v.decision, note: v.note }, 'Revue enregistrée')} />
      )}
      {c && dialog === 'edit' && <FormModal title="Modifier le contenu" fields={[{ name: 'title', label: 'Titre', value: c.title, required: true, maxLength: 150 }, { name: 'body', label: 'Contenu', type: 'textarea', value: c.body, required: true, maxLength: 4000 }]} onClose={() => setDialog(null)} onSubmit={(v) => act('', { title: v.title, body: v.body }, 'Contenu modifié', 'PATCH')} />}
    </Drawer>
  );
}
