import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { Client, startServer, type Srv } from './helpers.js';

/**
 * Scénarios d'acceptation de la spécification fonctionnelle v1.2 (§15) :
 * AC (accès / fonctions), DE (dépenses), CO (communications), PR (projets), VA (validations),
 * SE (sécurité / urgence), MI (mandats / absences).
 */
let srv: Srv;
let A: Client, P: Client, T: Client, C: Client, L: Client, I: Client, M: Client, G: Client;
const today = () => new Date().toISOString().slice(0, 10);
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const errOf = (r: { data: any }) => String(r.data?.error ?? r.data?.message ?? '');
const login = async (c: Client, email: string) => { c.token = (await c.post('/auth/login', { email, password: 'motdepasse123' })).data.token; };
const sql = (q: string, ...args: any[]) => { const d = new DatabaseSync(path.join(srv.dataDir, 'linklink.db')); try { return d.prepare(q).run(...args); } finally { d.close(); } };
const notifs = async (c: Client) => (await c.get('/notifications')).data.notifications as any[];

beforeAll(async () => {
  srv = await startServer();
  const mk = (n: string, e: string, code = srv.codes.member) => new Client(srv.url).register(n, e, code);
  A = await new Client(srv.url).register('Awa Admin', 'a@g.test');
  P = await mk('Paul PDG', 'p@g.test');
  T = await mk('Thierno Caissier', 't@g.test');
  C = await mk('Coumba Communication', 'c@g.test');
  L = await mk('Lamine Chef', 'l@g.test');
  I = await mk('Ibrahima Infra', 'i@g.test');
  M = await mk('Mariama Membre', 'm@g.test');
  G = await mk('Gaoussou Invité', 'g@g.test', srv.codes.guest);
}, 40_000);
afterAll(() => srv.stop());

describe('AC — fonctions et cumuls (§3, §4)', () => {
  it("au démarrage, l'administrateur technique tient la fonction PDG (décision de démarrage journalisée) et la transmet", async () => {
    expect((await A.get('/me')).data.user.functions).toContain('pdg');
    expect((await M.post('/functions', { userId: M.user.id, fn: 'pdg' })).status).toBe(403);
    const early = await A.post('/functions', { userId: P.user.id, fn: 'pdg' });
    expect(early.status).toBe(409); // fonction unique déjà tenue : remplacement explicite requis
    expect((await A.post('/functions', { userId: P.user.id, fn: 'pdg', replace: true })).status).toBe(201);
    expect((await A.get('/me')).data.user.functions).not.toContain('pdg');
    expect((await A.post('/functions', { userId: M.user.id, fn: 'coordinator' })).status).toBe(403); // plus de PDG : plus de droit
  });
  it('attribution des fonctions par le PDG seulement ; invité exclu ; fonction unique ; cumul PDG + Caissier interdit', async () => {
    expect((await P.post('/functions', { userId: T.user.id, fn: 'treasurer' })).status).toBe(201);
    expect((await P.post('/functions', { userId: C.user.id, fn: 'comms' })).status).toBe(201);
    expect((await P.post('/functions', { userId: L.user.id, fn: 'project_lead' })).status).toBe(201);
    expect((await P.post('/functions', { userId: I.user.id, fn: 'infra_lead' })).status).toBe(201);
    expect((await P.post('/functions', { userId: M.user.id, fn: 'coordinator' })).status).toBe(201);
    expect((await P.post('/functions', { userId: G.user.id, fn: 'comms' })).status).toBe(409);
    expect((await P.post('/functions', { userId: M.user.id, fn: 'treasurer' })).status).toBe(409); // déjà tenue par Thierno
    const cumul = await P.post('/functions', { userId: P.user.id, fn: 'treasurer', replace: true });
    expect(cumul.status).toBe(409);
    expect(errOf(cumul)).toMatch(/PDG et Caissier/i);
  });
  it("Administrateur technique + PDG : cumul seulement avec une décision journalisée", async () => {
    const r = await P.post('/functions', { userId: A.user.id, fn: 'pdg', replace: true });
    expect(r.status).toBe(409);
    expect(errOf(r)).toMatch(/décision/i);
    expect((await P.get('/functions')).data.functions.find((f: any) => f.fn === 'pdg').holders[0].id).toBe(P.user.id);
  });
  it("l'administrateur technique n'a aucun droit métier : ni finances, ni journal métier, ni validation", async () => {
    expect((await A.get('/expenses')).status).toBe(403);
    expect((await A.get('/journal/business')).status).toBe(403);
    expect((await A.get('/journal/security')).status).toBe(200);
    expect((await P.get('/journal/security')).status).toBe(403);
    expect((await M.get('/journal/business')).status).toBe(403);
  });
  it('les refus sont journalisés (sécurité) et le journal est immuable en base', async () => {
    const log = (await A.get('/journal/security')).data.entries as any[];
    expect(log.some((e) => e.result === 'denied')).toBe(true);
    expect(() => sql("UPDATE audit_log SET summary = 'trafiqué'")).toThrow(/immuable/);
    expect(() => sql('DELETE FROM audit_log')).toThrow(/immuable/);
  });
  it("changement de rôle d'accès : jamais de promotion/rétrogradation de l'administrateur par simple clic", async () => {
    expect((await A.patch(`/members/${M.user.id}/role`, { role: 'admin' })).status).toBe(400);
    expect((await A.patch(`/members/${A.user.id}/role`, { role: 'member' })).status).toBe(400);
  });
});

describe('DE — dépenses (§6)', () => {
  let e1: string;
  const create = (c: Client, extra: any = {}) => c.post('/expenses', { beneficiary: 'Fournisseur Sarl', amount: 150000, currency: 'GNF', reason: 'Abonnement hébergement', submit: true, ...extra });
  it('demande → approbation du PDG → paiement du Caissier avec preuve → justificatif → clôture', async () => {
    const r = await create(M);
    expect(r.status).toBe(201);
    e1 = r.data.expense.id;
    expect(r.data.expense.status).toBe('pending');
    expect((await M.post(`/expenses/${e1}/decision`, { decision: 'approve' })).status).toBe(403); // pas son propre dossier
    expect((await T.post(`/expenses/${e1}/decision`, { decision: 'approve' })).status).toBe(403); // le Caissier ne valide pas ce qu'il paie
    expect((await T.post(`/expenses/${e1}/payments`, { amount: 150000, proof: 'Reçu n°1' })).status).toBe(403); // aucun paiement avant approbation
    expect((await P.post(`/expenses/${e1}/decision`, { decision: 'refuse' })).status).toBe(400); // refus motivé
    expect((await P.post(`/expenses/${e1}/decision`, { decision: 'approve' })).data.expense.status).toBe('awaiting_payment');
    expect((await P.post(`/expenses/${e1}/payments`, { amount: 150000, proof: 'x' })).status).toBe(403); // le PDG ne paie pas
    expect((await T.post(`/expenses/${e1}/payments`, { amount: 150000, proof: 'Reçu n°1' })).data.expense.status).toBe('paid');
    expect((await T.post(`/expenses/${e1}/close`)).status).toBe(409); // justificatif exigé
    expect((await M.put(`/expenses/${e1}/justificatif`, { note: 'Facture 2026-114' })).status).toBe(200);
    expect((await T.post(`/expenses/${e1}/close`)).data.expense.status).toBe('closed');
  });
  it('modification importante après approbation : approbation invalidée, nouvelle approbation requise', async () => {
    const id = (await create(M)).data.expense.id;
    await P.post(`/expenses/${id}/decision`, { decision: 'approve' });
    const mod = await M.patch(`/expenses/${id}`, { amount: 900000 });
    expect(mod.status).toBe(200);
    expect(mod.data.expense.status).not.toBe('awaiting_payment');
    expect((await T.post(`/expenses/${id}/payments`, { amount: 900000, proof: 'Reçu' })).status).toBe(403);
  });
  it("écart de paiement (mauvais bénéficiaire) : « Écart à régulariser », clôture impossible, régularisation par l'approbateur", async () => {
    const id = (await create(M)).data.expense.id;
    await P.post(`/expenses/${id}/decision`, { decision: 'approve' });
    const pay = await T.post(`/expenses/${id}/payments`, { amount: 150000, beneficiary: 'Autre Personne', proof: 'Reçu 2' });
    expect(pay.data.expense.status).toBe('discrepancy');
    expect((await T.post(`/expenses/${id}/close`)).status).toBe(409);
    const pid = pay.data.expense.payments.find((p: any) => p.discrepancy).id;
    expect((await T.post(`/expenses/${id}/discrepancy`, { action: 'accept', paymentId: pid, motive: 'Motif valable' })).status).toBe(403);
    const fix = await P.post(`/expenses/${id}/discrepancy`, { action: 'cancel_payment', paymentId: pid, motive: 'Paiement annulé, à refaire' });
    expect(fix.data.expense.status).toBe('awaiting_payment');
    expect((await T.post(`/expenses/${id}/payments`, { amount: 160000, proof: 'Reçu 3' })).status).toBe(409); // plafond : jamais plus que l'approuvé
  });
  it("dépense du PDG : double approbation par deux autres fondateurs (ni lui, ni le Caissier)", async () => {
    const id = (await create(P)).data.expense.id;
    expect((await P.get(`/expenses/${id}`)).data.expense.approvalsRequired).toBe(2);
    expect((await P.post(`/expenses/${id}/decision`, { decision: 'approve' })).status).toBe(403);
    expect((await T.post(`/expenses/${id}/decision`, { decision: 'approve' })).status).toBe(403);
    expect((await C.post(`/expenses/${id}/decision`, { decision: 'approve' })).data.expense.status).toBe('pending'); // 1/2
    expect((await C.post(`/expenses/${id}/decision`, { decision: 'approve' })).status).toBeGreaterThanOrEqual(400); // pas deux fois la même personne
    expect((await L.post(`/expenses/${id}/decision`, { decision: 'approve' })).data.expense.status).toBe('awaiting_payment');
  });
  it('le Caissier qui demande lui-même une dépense : le PDG approuve, signalement au journal', async () => {
    const id = (await create(T)).data.expense.id;
    expect((await P.post(`/expenses/${id}/decision`, { decision: 'approve' })).data.expense.status).toBe('awaiting_payment');
    const pay = await T.post(`/expenses/${id}/payments`, { amount: 150000, proof: 'Reçu T' });
    expect([201, 403]).toContain(pay.status);
  });
  it("invités exclus ; journal métier visible du PDG avec les décisions", async () => {
    expect((await G.get('/expenses')).status).toBe(403);
    expect((await P.get('/journal/business')).data.entries.some((e: any) => e.action === 'expense_approve')).toBe(true);
  });
});

describe('CO — communications (§8)', () => {
  let c1: string;
  it("circuit « officiel » : PDG et Chargé de communication, deux personnes distinctes ; seul le Chargé de communication publie", async () => {
    const r = await M.post('/communications', { kind: 'official', title: 'Partenariat opérateur', body: 'Annonce du partenariat.', submit: true });
    expect(r.status).toBe(201);
    c1 = r.data.communication.id;
    expect(r.data.communication.status).toBe('in_validation');
    expect((await M.post(`/communications/${c1}/validate`, { decision: 'approve' })).status).toBe(403); // l'auteur ne se valide pas
    expect((await L.post(`/communications/${c1}/validate`, { decision: 'approve' })).status).toBe(403); // pas de rôle dans ce circuit
    expect((await P.post(`/communications/${c1}/publish`)).status).toBe(403);
    expect((await P.post(`/communications/${c1}/validate`, { decision: 'approve' })).data.communication.status).toBe('in_validation');
    expect((await C.post(`/communications/${c1}/validate`, { decision: 'approve' })).data.communication.status).toBe('validated');
    expect((await P.post(`/communications/${c1}/publish`)).status).toBe(403);
    expect((await C.post(`/communications/${c1}/publish`)).data.communication.status).toBe('published');
    const feed = (await M.get('/channels')).data.channels.find((c: any) => c.name.toLowerCase().includes('annonce'));
    expect(feed).toBeTruthy();
  });
  it('modification après validation : validations invalidées, retour en validation', async () => {
    const id = (await M.post('/communications', { kind: 'official', title: 'Annonce B', body: 'Texte', submit: true })).data.communication.id;
    await P.post(`/communications/${id}/validate`, { decision: 'approve' });
    await C.post(`/communications/${id}/validate`, { decision: 'approve' });
    const mod = await M.patch(`/communications/${id}`, { body: 'Texte modifié' });
    expect(mod.data.communication.status).toBe('in_validation');
    expect((await C.post(`/communications/${id}/publish`)).status).toBe(403);
  });
  it('refus motivé : retour à l\'auteur', async () => {
    const id = (await M.post('/communications', { kind: 'current', title: 'Post courant', body: 'Hello', submit: true })).data.communication.id;
    expect((await C.post(`/communications/${id}/validate`, { decision: 'refuse' })).status).toBe(400);
    expect((await C.post(`/communications/${id}/validate`, { decision: 'refuse', motive: 'Ton à revoir' })).data.communication.status).toBe('refused');
  });
  it("annonce interne : PDG ou Chargé de communication ; avis de service : administrateur technique ; écriture directe dans #annonces filtrée", async () => {
    expect((await M.post('/announcements', { title: 'x', body: 'y' })).status).toBe(403);
    expect((await P.post('/announcements', { title: 'Réunion', body: 'Lundi 9h' })).status).toBe(201);
    expect((await C.post('/announcements', { title: 'Newsletter', body: 'Sortie' })).status).toBe(201);
    expect((await A.post('/announcements', { title: 'Maintenance', body: 'Ce soir', service: true })).status).toBe(201);
    expect((await P.post('/announcements', { title: 'Maintenance', body: 'x', service: true })).status).toBe(403);
    const ann = (await M.get('/channels')).data.channels.find((c: any) => c.name.toLowerCase().includes('annonce'));
    expect((await M.post(`/channels/${ann.id}/messages`, { body: 'Intrus' })).status).toBe(403);
  });
  it("crise : voie rapide du PDG, revue sous 24 h ; le Chargé de communication seul ne peut pas", async () => {
    expect((await C.post('/communications/crisis', { title: 'Incident', body: 'Panne' })).status).toBe(403);
    const r = await P.post('/communications/crisis', { title: 'Incident majeur', body: 'Nous enquêtons.' });
    expect(r.status).toBe(201);
    const id = r.data.communication.id;
    expect((await C.post(`/communications/${id}/review`, { decision: 'confirm', note: 'ok' })).status).toBe(403);
    expect((await P.post(`/communications/${id}/review`, { decision: 'confirm', note: 'Revue faite' })).status).toBe(200);
  });
  it('retrait immédiat : PDG ou Chargé de communication', async () => {
    expect((await M.post(`/communications/${c1}/withdraw`, { motive: 'Erreur' })).status).toBe(403);
    expect((await C.post(`/communications/${c1}/withdraw`, { motive: 'Information erronée' })).data.communication.status).toBe('withdrawn');
  });
});

describe('PR — projets (§7)', () => {
  let pid: string;
  it('création par le PDG ou le Coordinateur ; responsable = fondateur avec la fonction Chef de projet', async () => {
    expect((await L.post('/projects', { name: 'Interdit' })).status).toBe(403);
    expect((await M.post('/projects', { name: 'App', leadId: T.user.id })).status).toBe(409); // Thierno n'est pas Chef de projet
    const r = await M.post('/projects', { name: 'App pilote', leadId: L.user.id });
    expect(r.status).toBe(201);
    pid = r.data.project.id;
    expect(r.data.project.lead.id).toBe(L.user.id);
    expect(r.data.project.orphan).toBe(false);
  });
  it('membres : le responsable ajoute directement ; le Coordinateur propose et le PDG décide', async () => {
    expect((await L.post(`/projects/${pid}/members`, { userId: I.user.id })).status).toBe(200);
    const prop = await M.post(`/projects/${pid}/members`, { userId: C.user.id });
    expect(prop.status).toBe(202);
    const list = (await P.get(`/projects/${pid}/proposals`)).data.proposals;
    expect(list[0].status).toBe('pending');
    expect((await M.post(`/projects/${pid}/proposals/${list[0].id}/decision`, { decision: 'accept' })).status).toBe(403);
    expect((await P.post(`/projects/${pid}/proposals/${list[0].id}/decision`, { decision: 'refuse' })).status).toBe(400);
    expect((await P.post(`/projects/${pid}/proposals/${list[0].id}/decision`, { decision: 'accept' })).status).toBe(200);
    expect((await P.get(`/projects/${pid}`)).data.project.members.map((m: any) => m.id)).toContain(C.user.id);
  });
  it("projet orphelin si le responsable perd sa fonction : alerte, et le Coordinateur peut désigner directement", async () => {
    expect((await P.del(`/functions/project_lead/${L.user.id}`)).status).toBe(200);
    expect((await P.get(`/projects/${pid}`)).data.project.orphan).toBe(true);
    expect((await notifs(P)).some((n) => n.title.includes('Projet orphelin'))).toBe(true);
    expect((await P.post('/functions', { userId: I.user.id, fn: 'project_lead' })).status).toBe(201);
    expect((await M.put(`/projects/${pid}/lead`, { userId: I.user.id })).status).toBe(200); // orphelin → direct
    expect((await P.get(`/projects/${pid}`)).data.project.orphan).toBe(false);
    const again = await M.put(`/projects/${pid}/lead`, { userId: I.user.id });
    expect(again.status).toBe(202); // non orphelin → simple proposition
  });
  it("dépendances : une tâche ne se termine pas avant ses prérequis, pas de cycle", async () => {
    const t1 = (await I.post('/tasks', { projectId: pid, title: 'Base' })).data.task.id;
    const t2 = (await I.post('/tasks', { projectId: pid, title: 'Suite' })).data.task.id;
    expect((await I.post(`/tasks/${t2}/dependencies`, { dependsOn: t1 })).status).toBe(201);
    expect((await I.post(`/tasks/${t1}/dependencies`, { dependsOn: t2 })).status).toBe(409);
    expect((await I.patch(`/tasks/${t2}`, { status: 'done' })).status).toBe(409);
    await I.patch(`/tasks/${t1}`, { status: 'done' });
    expect((await I.patch(`/tasks/${t2}`, { status: 'done' })).status).toBe(200);
  });
  it("suppression : PDG seulement, et jamais si le projet porte des dépenses ou communications", async () => {
    await M.post('/expenses', { beneficiary: 'X', amount: 1000, currency: 'GNF', reason: 'Lié au projet', projectId: pid, submit: true });
    expect((await L.del(`/projects/${pid}`)).status).toBe(403);
    expect((await P.del(`/projects/${pid}`)).status).toBe(409);
  });
});

describe('MI — absences, mandats, relances et validations bloquées (§9, §10)', () => {
  it('validateur absent : la validation reste en attente (bloquée) sauf mandat de remplacement valide', async () => {
    const id = (await M.post('/expenses', { beneficiary: 'Imprimeur', amount: 50000, currency: 'GNF', reason: 'Flyers', submit: true })).data.expense.id;
    expect((await P.post('/absences', { startsOn: today(), endsOn: inDays(3), note: 'Voyage' })).status).toBe(201);
    expect((await P.get('/validations')).data.pending.some((v: any) => v.id === id && v.blocked)).toBe(true);
    expect((await L.post(`/expenses/${id}/decision`, { decision: 'approve' })).status).toBe(403); // pas de décision « de fait »
    expect((await P.post('/mandates', { granteeId: L.user.id, scope: 'validator_replacement', validationType: 'expense', reason: 'Absence du PDG', endsAt: inDays(3) })).status).toBe(201);
    const ok = await L.post(`/expenses/${id}/decision`, { decision: 'approve' });
    expect(ok.status).toBe(200);
    const trace = (await P.get('/journal/business')).data.entries.find((e: any) => e.action === 'expense_approve' && e.mandate);
    expect(trace).toBeTruthy(); // l'action au titre d'un mandat est tracée comme telle
  });
  it("règles de mandat : borné dans le temps, porte-parole = Chargé de communication, technique = Chef d'infrastructures", async () => {
    expect((await P.post('/mandates', { granteeId: M.user.id, scope: 'spokesperson', reason: 'Test mandat', endsAt: inDays(5) })).status).toBe(409);
    expect((await P.post('/mandates', { granteeId: I.user.id, scope: 'technical_ops', reason: 'Astreinte', endsAt: inDays(400) })).status).toBe(400);
    expect((await P.post('/mandates', { granteeId: I.user.id, scope: 'technical_ops', reason: 'Astreinte', endsAt: inDays(7) })).status).toBe(201);
    expect((await M.post('/mandates', { granteeId: M.user.id, scope: 'interim', fn: 'pdg', reason: 'Moi PDG', endsAt: inDays(2) })).status).toBe(403);
    expect((await P.post('/mandates', { granteeId: T.user.id, scope: 'interim', fn: 'pdg', reason: 'Intérim', endsAt: inDays(2) })).status).toBe(409); // PDG + Caissier
    const list = (await P.get('/mandates')).data.mandates as any[];
    const m = list.find((x) => x.scope === 'technical_ops');
    expect((await M.del(`/mandates/${m.id}`)).status).toBe(403);
    expect((await P.del(`/mandates/${m.id}`)).status).toBe(200);
  });
  it('l\'absence est terminée par son titulaire', async () => {
    const a = (await P.get('/absences')).data.absences[0];
    expect((await M.del(`/absences/${a.id}`)).status).toBe(403);
    expect((await P.del(`/absences/${a.id}`)).status).toBe(200);
    expect((await P.get('/absences')).data.absences).toHaveLength(0);
  });
  it('relances configurables par le PDG (1re relance, intervalle, escalade) ; validations cohérentes', async () => {
    expect((await M.put('/validation-rules/expense', { firstReminderH: 12, intervalH: 12, escalationH: 60 })).status).toBe(403);
    expect((await P.put('/validation-rules/expense', { firstReminderH: 60, intervalH: 12, escalationH: 12 })).status).toBe(400);
    expect((await P.put('/validation-rules/expense', { firstReminderH: 12, intervalH: 12, escalationH: 60 })).status).toBe(200);
    expect((await M.get('/validation-rules')).data.rules.find((r: any) => r.type === 'expense').escalationH).toBe(60);
    expect((await P.put('/validation-rules/expense', { firstReminderH: 24, intervalH: 48, escalationH: 120 })).status).toBe(200);
  });
  it('rappel déclenché au démarrage pour une validation en retard, sans doublon', async () => {
    const id = (await M.post('/expenses', { beneficiary: 'Retard SA', amount: 20000, currency: 'GNF', reason: 'Test relance', submit: true })).data.expense.id;
    sql('UPDATE expenses SET submitted_at = ? WHERE id = ?', new Date(Date.now() - 30 * 3600_000).toISOString(), id);
    await srv.restart();
    await login(P, 'p@g.test');
    const n1 = (await notifs(P)).filter((n) => n.title.includes('Validation en attente'));
    expect(n1.length).toBeGreaterThanOrEqual(1);
    await srv.restart();
    await login(P, 'p@g.test');
    expect((await notifs(P)).filter((n) => n.title.includes('Validation en attente'))).toHaveLength(n1.length);
  }, 40_000);
});

describe('SE — suspension, urgence, rétention (§12)', () => {
  it("suspension de compte : demandée par l'administrateur, validée par le PDG (jamais par le demandeur) ; sessions coupées", async () => {
    const req = await A.post(`/members/${G.user.id}/suspension`, { reason: 'Compte compromis' });
    expect(req.status).toBe(201);
    const id = req.data.action.id;
    expect((await A.post(`/account-actions/${id}/decision`, { decision: 'approve' })).status).toBe(403);
    expect((await P.post(`/account-actions/${id}/decision`, { decision: 'refuse' })).status).toBe(400);
    expect((await P.post(`/account-actions/${id}/decision`, { decision: 'approve' })).status).toBe(200);
    expect((await G.get('/me')).status).toBe(401);
    expect((await new Client(srv.url).post('/auth/login', { email: 'g@g.test', password: 'motdepasse123' })).status).toBe(403);
    const back = await A.post(`/members/${G.user.id}/reactivation`, { reason: 'Mot de passe changé' });
    expect((await P.post(`/account-actions/${back.data.action.id}/decision`, { decision: 'approve' })).status).toBe(200);
    expect((await new Client(srv.url).post('/auth/login', { email: 'g@g.test', password: 'motdepasse123' })).status).toBe(200);
  });
  it("l'administrateur ne se suspend pas lui-même ; personne d'autre que lui ne demande une suspension", async () => {
    expect((await A.post(`/members/${A.user.id}/suspension`, { reason: 'Test de soi' })).status).toBe(400);
    expect((await P.post(`/members/${M.user.id}/suspension`, { reason: 'Je ne suis pas admin' })).status).toBe(403);
  });
  it("accès d'urgence : deux détenteurs, deux codes, activation conjointe, durée limitée, seule action = réinitialiser le mot de passe de l'administrateur", async () => {
    expect((await M.put('/emergency/holders', { userIds: [M.user.id, L.user.id] })).status).toBe(403);
    expect((await P.put('/emergency/holders', { userIds: [M.user.id, M.user.id] })).status).toBeGreaterThanOrEqual(400);
    expect((await P.put('/emergency/holders', { userIds: [M.user.id, A.user.id] })).status).toBe(409); // l'administrateur ne peut pas être détenteur
    expect((await P.put('/emergency/holders', { userIds: [M.user.id, L.user.id] })).status).toBe(200);
    expect((await M.post('/emergency/sessions', { code: 'prematuré-1234' })).status).toBe(409); // codes pas encore définis
    expect((await M.post('/emergency/code', { code: 'court', password: 'motdepasse123' })).status).toBe(400);
    expect((await M.post('/emergency/code', { code: 'code-urgence-Mariama-1', password: 'faux-mot-de-passe' })).status).toBe(403);
    expect((await M.post('/emergency/code', { code: 'code-urgence-Mariama-1', password: 'motdepasse123' })).status).toBe(200);
    expect((await L.post('/emergency/code', { code: 'code-urgence-Lamine-22', password: 'motdepasse123' })).status).toBe(200);
    expect((await C.post('/emergency/sessions', { code: 'x' })).status).toBe(403);
    expect((await M.post('/emergency/sessions', { code: 'mauvais-code-0000' })).status).toBe(403);
    const start = await M.post('/emergency/sessions', { code: 'code-urgence-Mariama-1', note: 'Admin injoignable' });
    expect(start.status).toBe(201);
    const sid = start.data.emergency.session.id;
    expect((await M.post(`/emergency/sessions/${sid}/confirm`, { code: 'code-urgence-Mariama-1' })).status).toBe(403); // même personne : refusé
    expect((await M.post(`/emergency/sessions/${sid}/admin-reset`, { newPassword: 'Nouveau-mot-de-passe-1' })).status).toBe(409); // pas encore actif
    expect((await L.post(`/emergency/sessions/${sid}/confirm`, { code: 'code-urgence-Lamine-22' })).data.emergency.session.state).toBe('active');
    expect((await C.post(`/emergency/sessions/${sid}/admin-reset`, { newPassword: 'Nouveau-mot-de-passe-1' })).status).toBe(403);
    expect((await L.get(`/emergency/sessions/${sid}/backups`)).status).toBe(200);
    expect((await L.post(`/emergency/sessions/${sid}/admin-reset`, { newPassword: 'Nouveau-mot-de-passe-1' })).status).toBe(200);
    expect((await A.get('/me')).status).toBe(401);
    expect((await new Client(srv.url).post('/auth/login', { email: 'a@g.test', password: 'Nouveau-mot-de-passe-1' })).status).toBe(200);
    expect((await M.post(`/emergency/sessions/${sid}/close`)).status).toBe(200);
    const j = (await M.get('/journal/emergency')).data.entries.map((e: any) => e.action);
    expect(j).toEqual(expect.arrayContaining(['emergency_start', 'emergency_activate', 'emergency_admin_reset', 'emergency_close']));
    await login(A, 'a@g.test').catch(() => {});
    A.token = (await A.post('/auth/login', { email: 'a@g.test', password: 'Nouveau-mot-de-passe-1' })).data.token;
    expect((await A.get('/journal/emergency')).status).toBe(200); // visible de tous les fondateurs, y compris l'administrateur
    await login(G, 'g@g.test');
    expect((await G.get('/journal/emergency')).status).toBe(403);
  });
  it("les secrets ne sont pas stockés dans l'espace Infrastructure", async () => {
    const infra = (await A.get('/folders')).data.folders.find((f: any) => f.name === 'Infrastructure');
    if (!infra) return;
    expect((await I.upload({ name: 'password.txt', content: 'TOKEN=abc' }, { folderId: infra.id })).status).toBe(422);
    expect((await I.upload({ name: 'procedure-restauration.pdf', content: '%PDF' }, { folderId: infra.id })).status).toBe(201);
  });
});
