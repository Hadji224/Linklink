import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { WebSocket } from 'ws';
import { Client, startServer, type Srv } from './helpers.js';

let srv: Srv;
let admin: Client, founder: Client, guest: Client, outsider: Client;
let projectId: string;

const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
const yesterday = () => new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  srv = await startServer();
  admin = new Client(srv.url);
  founder = new Client(srv.url);
  guest = new Client(srv.url);
  outsider = new Client(srv.url);
}, 30_000);
afterAll(() => srv.stop());

describe('Authentification & rôles (F-AUTH, §4.2)', () => {
  it("refuse l'inscription sans consentement RGPD", async () => {
    const r = await new Client(srv.url).post('/auth/register', { name: 'X', email: 'x@t.test', password: 'motdepasse123', consent: false });
    expect(r.status).toBe(400);
  });
  it('le premier compte devient Super Admin, sans code', async () => {
    await admin.register('Awa Admin', 'admin@t.test');
    expect(admin.user.role).toBe('admin');
  });
  it("exige le code d'invitation ensuite, et attribue le rôle selon le code", async () => {
    expect((await new Client(srv.url).post('/auth/register', { name: 'Z', email: 'z@t.test', password: 'motdepasse123', inviteCode: 'FAUX-CODE', consent: true })).status).toBe(403);
    await founder.register('Moussa Fondateur', 'f@t.test', srv.codes.member);
    expect(founder.user.role).toBe('member');
    await guest.register('Ibrahima Invité', 'g@t.test', srv.codes.guest);
    expect(guest.user.role).toBe('guest');
    await outsider.register('Fanta Invitée', 'o@t.test', srv.codes.guest);
  });
  it('mot de passe trop court refusé, e-mail en double refusé', async () => {
    expect((await new Client(srv.url).post('/auth/register', { name: 'A', email: 'a@t.test', password: 'court', inviteCode: srv.codes.member, consent: true })).status).toBe(400);
    expect((await new Client(srv.url).post('/auth/register', { name: 'A', email: 'F@T.test', password: 'motdepasse123', inviteCode: srv.codes.member, consent: true })).status).toBe(409);
  });
  it('connexion : mauvais mot de passe = 401, route protégée sans jeton = 401', async () => {
    expect((await new Client(srv.url).post('/auth/login', { email: 'f@t.test', password: 'mauvaisssss' })).status).toBe(401);
    expect((await new Client(srv.url).get('/projects')).status).toBe(401);
    expect((await new Client(srv.url).get('/health')).status).toBe(200);
  });
  it('matrice : code invité réservé au Super Admin, code fondateur visible des fondateurs, pas des invités', async () => {
    expect((await admin.get('/invite')).data.guestCode).toBeTruthy();
    const f = await founder.get('/invite');
    expect(f.data.code).toBe(srv.codes.member);
    expect(f.data.guestCode).toBeUndefined();
    expect((await guest.get('/invite')).status).toBe(403);
    expect((await founder.post('/invite/regenerate', {})).status).toBe(403);
  });
  it('gestion des rôles : Super Admin seulement, pas sur soi-même', async () => {
    expect((await founder.patch(`/members/${guest.user.id}/role`, { role: 'member' })).status).toBe(403);
    expect((await admin.patch(`/members/${admin.user.id}/role`, { role: 'member' })).status).toBe(400);
  });
});

describe('Projets (F-PROJ)', () => {
  it('un invité ne peut pas créer de projet ; un fondateur oui (et devient membre)', async () => {
    expect((await guest.post('/projects', { name: 'Interdit' })).status).toBe(403);
    const r = await founder.post('/projects', { name: 'Campus France', description: 'Dossiers', color: '#11C6D8' });
    expect(r.status).toBe(201);
    projectId = r.data.project.id;
    expect(r.data.project.members.map((m: any) => m.id)).toContain(founder.user.id);
    expect(r.data.project.folderId).toBeTruthy();
    expect(r.data.project.channelId).toBeTruthy();
  });
  it("seul le Super Admin supprime un projet", async () => {
    const p = (await founder.post('/projects', { name: 'Jetable' })).data.project;
    expect((await founder.del(`/projects/${p.id}`)).status).toBe(403);
    expect((await admin.del(`/projects/${p.id}`)).status).toBe(200);
  });
  it("un invité ne voit que ses projets (404 sinon), puis y accède une fois ajouté", async () => {
    expect((await guest.get('/projects')).data.projects).toHaveLength(0);
    expect((await guest.get(`/projects/${projectId}`)).status).toBe(404);
    expect((await founder.post(`/projects/${projectId}/members`, { userId: guest.user.id })).status).toBe(200);
    expect((await guest.get(`/projects/${projectId}`)).status).toBe(200);
    expect((await outsider.get(`/projects/${projectId}`)).status).toBe(404);
  });
  it('filtre par statut et recherche', async () => {
    expect((await admin.get('/projects?status=paused')).data.projects).toHaveLength(0);
    expect((await admin.get('/projects?q=campus')).data.projects).toHaveLength(1);
  });
});

describe('Tâches (F-TASK)', () => {
  let taskId: string;
  it('crée une tâche avec sous-tâches, tags et assignation → notification instantanée', async () => {
    const r = await founder.post('/tasks', { projectId, title: 'Rassembler les pièces', assigneeId: guest.user.id, dueDate: tomorrow(), priority: 'urgent', tags: ['visa'], subtasks: ['Passeport', 'Relevés'] });
    expect(r.status).toBe(201);
    taskId = r.data.task.id;
    expect(r.data.task.subtasks).toHaveLength(2);
    const notifs = (await guest.get('/notifications')).data;
    expect(notifs.notifications.some((n: any) => n.type === 'assigned')).toBe(true);
    expect(notifs.unread).toBeGreaterThan(0);
  });
  it("on ne peut pas assigner quelqu'un qui n'a pas accès au projet", async () => {
    expect((await founder.post('/tasks', { projectId, title: 'x', assigneeId: outsider.user.id })).status).toBe(400);
  });
  it("un invité ne crée pas de tâche (matrice) ; assigné, il change seulement le statut et ne supprime pas", async () => {
    expect((await guest.post('/tasks', { projectId, title: "Tâche de l'invité" })).status).toBe(403);
    const mine = await founder.post('/tasks', { projectId, title: 'Pour l\'invité', assigneeId: guest.user.id });
    expect((await guest.patch(`/tasks/${mine.data.task.id}`, { status: 'doing' })).data.task.status).toBe('doing');
    expect((await guest.del(`/tasks/${mine.data.task.id}`)).status).toBe(403);
    expect((await founder.del(`/tasks/${mine.data.task.id}`)).status).toBe(200);
  });
  it('un étranger au projet ne voit pas la tâche', async () => {
    expect((await outsider.get(`/tasks/${taskId}`)).status).toBe(404);
    expect((await outsider.get('/tasks')).data.tasks).toHaveLength(0);
  });
  it('sous-tâches, progression automatique et commentaires avec mention', async () => {
    const t = (await founder.get(`/tasks/${taskId}`)).data.task;
    await guest.patch(`/subtasks/${t.subtasks[0].id}`, { done: true });
    expect((await guest.get(`/tasks/${taskId}`)).data.task.subtasksDone).toBe(1);
    await founder.patch(`/tasks/${taskId}`, { status: 'done' });
    expect((await founder.get(`/projects/${projectId}`)).data.project.progress).toBe(100);
    await founder.post(`/tasks/${taskId}/comments`, { body: `Merci @${guest.user.name} !` });
    expect((await guest.get('/notifications')).data.notifications.some((n: any) => n.type === 'mention')).toBe(true);
  });
  it('« Ma journée » : tâches assignées dues aujourd\'hui ou en retard', async () => {
    const r = await founder.post('/tasks', { projectId, title: 'En retard', assigneeId: founder.user.id, dueDate: yesterday() });
    const day = await founder.get('/dashboard');
    expect(day.data.myTasksToday.map((t: any) => t.id)).toContain(r.data.task.id);
    expect(day.data.kpis.activeProjects).toBeGreaterThanOrEqual(1);
  });
  it('rappels J-1 et retard déclenchés au démarrage (dédoublonnés)', async () => {
    const due = await founder.post('/tasks', { projectId, title: 'Demain', assigneeId: founder.user.id, dueDate: tomorrow() });
    expect(due.status).toBe(201);
    await srv.restart();
    const n1 = (await founder.get('/notifications')).data.notifications;
    expect(n1.some((n: any) => n.type === 'due_soon' && n.title.includes('Demain'))).toBe(true);
    expect(n1.some((n: any) => n.type === 'overdue' && n.title.includes('En retard'))).toBe(true);
    await srv.restart();
    const n2 = (await founder.get('/notifications')).data.notifications;
    expect(n2.filter((n: any) => n.type === 'due_soon' && n.title.includes('Demain'))).toHaveLength(1);
  }, 30_000);
});

describe("Droits d'écriture sur les tâches (amendement v1.1 §5.3, §9.6, §16.3)", () => {
  let creator: Client, assignee: Client, observer: Client; // trois fondateurs : rôles sur la tâche
  let taskId: string;
  const dbFile = () => path.join(srv.dataDir, 'linklink.db');
  const sql = (q: string, ...args: any[]) => { const d = new DatabaseSync(dbFile()); try { return d.prepare(q).run(...args); } finally { d.close(); } };
  const task = async (c: Client, id = taskId) => (await c.get(`/tasks/${id}`)).data.task;
  const notifs = async (c: Client) => (await c.get('/notifications')).data.notifications as any[];

  beforeAll(async () => {
    creator = await new Client(srv.url).register('Créateur C', 'cr@t.test', srv.codes.member);
    assignee = await new Client(srv.url).register('Assigné A', 'as@t.test', srv.codes.member);
    observer = await new Client(srv.url).register('Observateur O', 'ob@t.test', srv.codes.member);
    taskId = (await creator.post('/tasks', { projectId, title: 'Tâche à droits', description: 'd', assigneeId: assignee.user.id, dueDate: tomorrow(), priority: 'high' })).data.task.id;
  });

  it('le rôle sur la tâche est calculé pour chacun, avec ses permissions', async () => {
    expect((await task(creator)).myRole).toBe('creator');
    expect((await task(assignee)).myRole).toBe('assignee');
    expect((await task(observer)).myRole).toBe('observer');
    expect((await task(admin)).myRole).toBe('admin');
    expect((await task(assignee)).permissions).toMatchObject({ edit: false, status: true, reassign: false, delete: false, subtask: true });
    expect((await task(observer)).permissions).toMatchObject({ edit: false, status: false, subtask: false, delete: false });
    expect((await task(creator)).permissions).toMatchObject({ edit: true, status: true, reassign: true, delete: true });
  });

  it("créateur et admin : tous les champs ; l'historique garde qui, quoi, ancienne → nouvelle valeur", async () => {
    const r = await creator.patch(`/tasks/${taskId}`, { title: 'Tâche à droits (v2)', priority: 'urgent', dueDate: '2030-01-31' });
    expect(r.status).toBe(200);
    expect((await admin.patch(`/tasks/${taskId}`, { description: 'modifiée par admin' })).status).toBe(200);
    const h = (await task(creator)).history;
    expect(h.find((x: any) => x.field === 'priority')).toMatchObject({ user: 'Créateur C', oldValue: 'high', newValue: 'urgent' });
    expect(h.find((x: any) => x.field === 'title').oldValue).toBe('Tâche à droits');
    expect(h.find((x: any) => x.field === 'dueDate').newValue).toBe('2030-01-31');
    expect(h.find((x: any) => x.field === 'description').user).toBe(admin.user.name);
  });

  it("assigné : seulement le statut (403 sinon), et le créateur est notifié du changement", async () => {
    const bad = await assignee.patch(`/tasks/${taskId}`, { title: 'Piraté', status: 'doing' });
    expect(bad.status).toBe(403);
    expect(bad.data.error ?? bad.data.message).toContain('vous ne pouvez modifier que le statut');
    expect((await task(assignee)).title).toBe('Tâche à droits (v2)');
    expect((await assignee.patch(`/tasks/${taskId}`, { assigneeId: null })).status).toBe(403); // ne peut pas se retirer
    expect((await assignee.patch(`/tasks/${taskId}`, { assigneeId: observer.user.id })).status).toBe(403); // ni réassigner
    expect((await assignee.patch(`/tasks/${taskId}`, { status: 'doing' })).data.task.status).toBe('doing');
    expect((await notifs(creator)).some((n) => n.type === 'task' && n.title.includes('En cours'))).toBe(true);
  });

  it("observateur : lecture seule (403 sur modification, statut, suppression, réassignation, sous-tâche) mais il commente", async () => {
    for (const body of [{ title: 'x' }, { status: 'done' }, { priority: 'low' }, { assigneeId: observer.user.id }]) {
      const r = await observer.patch(`/tasks/${taskId}`, body);
      expect(r.status).toBe(403);
      expect(r.data.error ?? r.data.message).toContain('lecture seule');
    }
    expect((await observer.del(`/tasks/${taskId}`)).status).toBe(403);
    expect((await observer.post(`/tasks/${taskId}/subtasks`, { title: 'non' })).status).toBe(403);
    const c = await observer.post(`/tasks/${taskId}/comments`, { body: 'Un avis extérieur' });
    expect(c.status).toBe(201);
    expect(c.data.task.comments.at(-1).user.id).toBe(observer.user.id);
    expect((await task(creator)).title).toBe('Tâche à droits (v2)');
  });

  it("une tentative refusée est journalisée et notifiée au créateur et à l'admin (§9.8), sans doublon dans l'heure", async () => {
    await observer.patch(`/tasks/${taskId}`, { title: 'encore' });
    const byObserver = (n: any) => n.type === 'security' && n.body.includes('Observateur O');
    const forCreator = (await notifs(creator)).filter(byObserver);
    const forAdmin = (await notifs(admin)).filter(byObserver);
    expect(forCreator).toHaveLength(1);
    expect(forAdmin).toHaveLength(1);
        expect((await notifs(assignee)).some((n) => n.type === 'security')).toBe(false);
    const log = (await admin.get('/activity')).data;
    expect(JSON.stringify(log)).toContain('Tentative refusée');
  });

  it('sous-tâches : créateur, assigné et admin peuvent en créer', async () => {
    expect((await assignee.post(`/tasks/${taskId}/subtasks`, { title: "Étape de l'assigné" })).status).toBe(201);
    expect((await creator.post(`/tasks/${taskId}/subtasks`, { title: 'Étape du créateur' })).status).toBe(201);
    expect((await admin.post(`/tasks/${taskId}/subtasks`, { title: "Étape de l'admin" })).status).toBe(201);
  });

  it("réassignation : créateur et admin ; l'ancien et le nouvel assigné sont prévenus ; l'historique garde les noms", async () => {
    const r = await creator.patch(`/tasks/${taskId}`, { assigneeId: observer.user.id });
    expect(r.status).toBe(200);
    expect((await notifs(observer)).some((n) => n.type === 'assigned')).toBe(true);
    expect((await notifs(assignee)).some((n) => n.title.includes("n'êtes plus assigné"))).toBe(true);
    expect((await task(creator)).history.find((x: any) => x.field === 'assignedTo')).toMatchObject({ oldValue: 'Assigné A', newValue: 'Observateur O' });
    await creator.patch(`/tasks/${taskId}`, { assigneeId: assignee.user.id }); // retour à la normale
  });

  it("créateur = assigné : tous les droits du créateur ; tâche non assignée : seuls créateur et admin", async () => {
    const self = (await creator.post('/tasks', { projectId, title: 'Pour moi', assigneeId: creator.user.id })).data.task;
    expect(self.myRole).toBe('creator');
    expect((await creator.patch(`/tasks/${self.id}`, { title: 'Pour moi, modifiée' })).status).toBe(200);
    const none = (await creator.post('/tasks', { projectId, title: 'Orpheline' })).data.task;
    expect(none.assignee).toBeNull();
    expect((await assignee.patch(`/tasks/${none.id}`, { status: 'doing' })).status).toBe(403);
    expect((await admin.patch(`/tasks/${none.id}`, { status: 'doing' })).status).toBe(200);
  });

  it("commentaires : jamais modifiés ; supprimés par leur auteur ou un admin, pas par le créateur de la tâche", async () => {
    const t = await observer.post(`/tasks/${taskId}/comments`, { body: 'À supprimer' });
    const cid = t.data.task.comments.at(-1).id;
    expect((await creator.del(`/tasks/${taskId}/comments/${cid}`)).status).toBe(403);
    expect((await assignee.del(`/tasks/${taskId}/comments/${cid}`)).status).toBe(403);
    expect((await observer.del(`/tasks/${taskId}/comments/${cid}`)).status).toBe(200);
    const mine = await creator.post(`/tasks/${taskId}/comments`, { body: 'Le mien' });
    expect((await admin.del(`/tasks/${taskId}/comments/${mine.data.task.comments.at(-1).id}`)).status).toBe(200);
    expect(() => sql("UPDATE task_comments SET body = 'trafiqué'")).toThrow(/modifié/);
  });

  it("l'historique est immuable en base", async () => {
    expect(() => sql("UPDATE task_history SET new_value = 'x'")).toThrow(/immuable/);
  });

  it("un commentaire arrive aussi au créateur et à l'assigné ; pièces jointes : chacun supprime les siennes, l'admin celles des autres", async () => {
    await observer.post(`/tasks/${taskId}/comments`, { body: 'Je passe' });
    expect((await notifs(creator)).some((n) => n.type === 'task' && n.title.includes('a commenté'))).toBe(true);
    const up = await observer.upload({ name: 'avis.pdf', content: '%PDF' }, { taskId });
    expect(up.status).toBe(201); // même en lecture seule
    const fid = up.data.file.id;
    expect((await creator.del(`/files/${fid}`)).status).toBe(403);
    expect((await observer.del(`/files/${fid}`)).status).toBe(200);
    const up2 = await observer.upload({ name: 'avis2.pdf', content: '%PDF' }, { taskId });
    expect((await admin.del(`/files/${up2.data.file.id}`)).status).toBe(200);
  });

  it("terminée depuis plus de 7 jours : verrouillée (assigné refusé), le créateur peut la rouvrir ; archivée : admin seulement", async () => {
    await assignee.patch(`/tasks/${taskId}`, { status: 'done' });
    expect((await task(creator)).lock).toBe('none');
    sql('UPDATE tasks SET completed_at = ? WHERE id = ?', new Date(Date.now() - 8 * 86_400_000).toISOString(), taskId);
    expect((await task(creator)).lock).toBe('locked');
    const locked = await assignee.patch(`/tasks/${taskId}`, { status: 'review' });
    expect(locked.status).toBe(403);
    expect(locked.data.error ?? locked.data.message).toContain('verrouillée');
    expect((await creator.patch(`/tasks/${taskId}`, { title: 'Trop tard' })).status).toBe(403); // le créateur ne peut que rouvrir
    expect((await admin.patch(`/tasks/${taskId}`, { priority: 'low' })).status).toBe(200); // l'admin garde la main
    expect((await creator.patch(`/tasks/${taskId}`, { status: 'review' })).status).toBe(200); // réouverture
    expect((await task(creator)).lock).toBe('none');
    // Archivage
    expect((await creator.post(`/tasks/${taskId}/archive`)).status).toBe(409); // pas terminée
    await creator.patch(`/tasks/${taskId}`, { status: 'done' });
    expect((await observer.post(`/tasks/${taskId}/archive`)).status).toBe(403);
    expect((await creator.post(`/tasks/${taskId}/archive`)).status).toBe(200);
    expect((await creator.patch(`/tasks/${taskId}`, { status: 'todo' })).status).toBe(403); // plus de réouverture
    expect((await creator.get('/tasks')).data.tasks.map((t: any) => t.id)).not.toContain(taskId);
    expect((await creator.get('/tasks?archived=1')).data.tasks.map((t: any) => t.id)).toContain(taskId);
    expect((await creator.post(`/tasks/${taskId}/unarchive`)).status).toBe(403);
    expect((await admin.post(`/tasks/${taskId}/unarchive`)).status).toBe(200);
  });

  it("suppression : créateur et admin seulement", async () => {
    const t = (await creator.post('/tasks', { projectId, title: 'À supprimer', assigneeId: assignee.user.id })).data.task;
    expect((await assignee.del(`/tasks/${t.id}`)).status).toBe(403);
    expect((await creator.del(`/tasks/${t.id}`)).status).toBe(200);
    const t2 = (await creator.post('/tasks', { projectId, title: 'Supprimée par admin' })).data.task;
    expect((await admin.del(`/tasks/${t2.id}`)).status).toBe(200);
  });

  it("transfert de propriété : Super Admin seulement, jamais vers un invité", async () => {
    const t = (await creator.post('/tasks', { projectId, title: 'À transférer', assigneeId: assignee.user.id })).data.task;
    expect((await creator.post(`/tasks/${t.id}/transfer`, { userId: observer.user.id })).status).toBe(403);
    expect((await admin.post(`/tasks/${t.id}/transfer`, { userId: guest.user.id })).status).toBe(400);
    const r = await admin.post(`/tasks/${t.id}/transfer`, { userId: observer.user.id });
    expect(r.status).toBe(200);
    expect(r.data.task.createdBy.id).toBe(observer.user.id);
    expect((await observer.patch(`/tasks/${t.id}`, { priority: 'low' })).status).toBe(200);
    expect(r.data.task.history.find((h: any) => h.field === 'createdBy')).toMatchObject({ oldValue: 'Créateur C', newValue: 'Observateur O' });
  });

  it("cas limites : créateur qui part → tâches en propriété admin (assignés prévenus) ; assigné qui part → non assignée", async () => {
    const leaver = await new Client(srv.url).register('Partant P', 'leave@t.test', srv.codes.member);
    const mine = (await leaver.post('/tasks', { projectId, title: 'Du partant', assigneeId: assignee.user.id })).data.task;
    const theirs = (await creator.post('/tasks', { projectId, title: 'Confiée au partant', assigneeId: leaver.user.id })).data.task;
    expect((await leaver.del('/me', { password: 'motdepasse123' })).status).toBe(200);
    const orphan = await task(admin, mine.id);
    expect(orphan.createdBy?.id).toBe(admin.user.id);
    expect(orphan.assignee.id).toBe(assignee.user.id);
    expect((await notifs(assignee)).some((n) => n.title.includes('a quitté'))).toBe(true);
    const freed = await task(creator, theirs.id);
    expect(freed.assignee).toBeNull();
    expect((await creator.patch(`/tasks/${theirs.id}`, { assigneeId: assignee.user.id })).status).toBe(200);
  });

  it("défense en profondeur : un invité observateur ne modifie rien non plus (appel direct à l'API)", async () => {
    const t = (await creator.post('/tasks', { projectId, title: 'Vue par un invité' })).data.task;
    const r = await guest.patch(`/tasks/${t.id}`, { status: 'done' });
    expect(r.status).toBe(403);
    expect((await guest.post(`/tasks/${t.id}/comments`, { body: "L'invité peut commenter" })).status).toBe(201);
  });
});

describe('Archivage (F-PROJ-04)', () => {
  it("seul un projet terminé s'archive ; un projet archivé est en lecture seule", async () => {
    const p = (await founder.post('/projects', { name: 'À archiver' })).data.project;
    expect((await founder.patch(`/projects/${p.id}`, { status: 'archived' })).status).toBe(400);
    await founder.patch(`/projects/${p.id}`, { status: 'done' });
    expect((await founder.patch(`/projects/${p.id}`, { status: 'archived' })).status).toBe(200);
    expect((await founder.post('/tasks', { projectId: p.id, title: 'Non' })).status).toBe(409);
    expect((await founder.patch(`/projects/${p.id}`, { name: 'Renommé' })).status).toBe(409);
    expect((await founder.get(`/projects/${p.id}`)).status).toBe(200);
  });
});

describe('Dossiers & fichiers (F-FILE, confidentialité)', () => {
  let projectFolder: string;
  it("n'accepte que les formats autorisés", async () => {
    projectFolder = (await founder.get(`/projects/${projectId}`)).data.project.folderId;
    expect((await founder.upload({ name: 'virus.exe', content: 'MZ' }, { folderId: projectFolder })).status).toBe(415);
    expect((await founder.upload({ name: 'page.html', content: '<script>' }, { folderId: projectFolder })).status).toBe(415);
    const ok = await founder.upload({ name: 'dossier.pdf', content: '%PDF-1.4' }, { folderId: projectFolder });
    expect(ok.status).toBe(201);
    expect(ok.data.file.mime).toBe('application/pdf');
  });
  it('arborescence : sous-dossiers, recherche par nom/auteur', async () => {
    const sub = await founder.post('/folders', { name: 'Visa', parentId: projectFolder });
    expect(sub.status).toBe(201);
    await founder.upload({ name: 'passeport.png', content: 'png' }, { folderId: sub.data.folder.id });
    expect((await founder.get('/files?q=passeport')).data.files).toHaveLength(1);
    expect((await founder.get(`/files?author=${admin.user.id}`)).data.files).toHaveLength(0);
    expect((await outsider.get(`/files?folderId=${projectFolder}`)).data.files).toHaveLength(0);
  });
  it('téléchargement en pièce jointe, aperçu réservé aux images', async () => {
    const f = (await founder.get(`/files?folderId=${projectFolder}`)).data.files[0];
    const dl = await founder.req('GET', `/files/${f.id}/download`, undefined, true);
    expect(dl.res.headers.get('content-disposition')).toMatch(/^attachment/);
    expect((await founder.get(`/files/${f.id}/preview`)).status).toBe(415);
  });
  it('niveaux : strict = auteur + Super Admin ; confidentiel = membres du projet ; interne = pas pour un invité hors projet', async () => {
    const strict = (await founder.upload({ name: 'strategie.pdf', content: 'x' }, { level: 'strict' })).data.file;
    expect((await admin.req('GET', `/files/${strict.id}/download`, undefined, true)).status).toBe(200);
    expect((await guest.req('GET', `/files/${strict.id}/download`, undefined, true)).status).toBe(404);
    const second = new Client(srv.url);
    await second.register('Second Fondateur', 'f2@t.test', srv.codes.member);
    expect((await second.req('GET', `/files/${strict.id}/download`, undefined, true)).status).toBe(404);
    const conf = (await founder.upload({ name: 'contrat.pdf', content: 'x' }, { level: 'confidential', folderId: projectFolder })).data.file;
    expect((await guest.req('GET', `/files/${conf.id}/download`, undefined, true)).status).toBe(200); // membre du projet
    expect((await second.req('GET', `/files/${conf.id}/download`, undefined, true)).status).toBe(404); // fondateur non concerné
    const internal = (await founder.upload({ name: 'note.txt', content: 'x' }, { level: 'internal' })).data.file;
    expect((await outsider.req('GET', `/files/${internal.id}/download`, undefined, true)).status).toBe(404);
    expect((await second.req('GET', `/files/${internal.id}/download`, undefined, true)).status).toBe(200);
    expect((await second.get('/files')).data.files.map((f: any) => f.name)).not.toContain('strategie.pdf');
  });
  it('suppression : chacun ses propres fichiers (invité compris), jamais ceux des autres ; Super Admin tout', async () => {
    const mine = (await founder.upload({ name: 'a.txt', content: 'a' })).data.file;
    expect((await guest.del(`/files/${mine.id}`)).status).toBe(404);
    const second = new Client(srv.url);
    await second.post('/auth/login', { email: 'f2@t.test', password: 'motdepasse123' }).then((r) => { second.token = r.data.token; });
    expect((await second.del(`/files/${mine.id}`)).status).toBe(403);
    expect((await founder.del(`/files/${mine.id}`)).status).toBe(200);
    const other = (await founder.upload({ name: 'b.txt', content: 'b' })).data.file;
    expect((await admin.del(`/files/${other.id}`)).status).toBe(200);
    const inProj = (await founder.upload({ name: 'c.txt', content: 'c' }, { folderId: projectFolder })).data.file;
    expect((await guest.del(`/files/${inProj.id}`)).status).toBe(403);
  });
  it('pièce jointe de tâche', async () => {
    const task = (await founder.post('/tasks', { projectId, title: 'Avec pièce' })).data.task;
    expect((await founder.upload({ name: 'pj.pdf', content: 'x' }, { taskId: task.id })).status).toBe(201);
    expect((await founder.get(`/tasks/${task.id}`)).data.task.attachments).toHaveLength(1);
  });
});

describe('Messagerie (F-MSG) : salons, DM, non lus, temps réel', () => {
  let general: string, annonces: string, dm: string;
  it('#annonces est réservé au Super Admin en écriture', async () => {
    const chans = (await founder.get('/channels')).data.channels;
    general = chans.find((c: any) => c.name === 'général').id;
    annonces = chans.find((c: any) => c.name === 'annonces').id;
    expect((await founder.post(`/channels/${annonces}/messages`, { body: 'non' })).status).toBe(403);
    expect((await admin.post(`/channels/${annonces}/messages`, { body: 'Bienvenue' })).status).toBe(201);
  });
  it('seul le Super Admin crée un salon', async () => {
    expect((await founder.post('/channels', { name: 'tech' })).status).toBe(403);
    expect((await admin.post('/channels', { name: 'tech' })).status).toBe(201);
    expect((await guest.get('/channels')).data.channels.map((c: any) => c.name)).not.toContain('tech');
  });
  it('messages directs privés : un tiers ne peut ni lire ni écrire', async () => {
    dm = (await founder.post('/dms', { userId: admin.user.id })).data.channel.id;
    await founder.post(`/channels/${dm}/messages`, { body: 'secret' });
    expect((await admin.get(`/channels/${dm}/messages`)).data.messages).toHaveLength(1);
    expect((await guest.get(`/channels/${dm}/messages`)).status).toBe(404);
    expect((await guest.post(`/channels/${dm}/messages`, { body: 'intrus' })).status).toBe(404);
    expect((await guest.get('/channels')).data.channels.some((c: any) => c.id === dm)).toBe(false);
    expect((await founder.post('/dms', { userId: founder.user.id })).status).toBe(400);
  });
  it('compteurs de non lus persistants, remis à zéro à la lecture', async () => {
    const before = (await admin.get('/channels')).data.channels.find((c: any) => c.id === dm);
    expect(before.unread).toBe(1);
    expect(before.name).toBe(founder.user.name);
    await admin.post(`/channels/${dm}/read`);
    expect((await admin.get('/channels')).data.channels.find((c: any) => c.id === dm).unread).toBe(0);
    expect((await admin.get('/dashboard')).data.unreadTotal).toBeGreaterThanOrEqual(0);
  });
  it("pièce jointe de DM : invisible pour un tiers", async () => {
    const r = await founder.upload({ name: 'prive.pdf', content: 'x' }, { channelId: dm });
    expect(r.status).toBe(201);
    expect((await guest.req('GET', `/files/${r.data.file.id}/download`, undefined, true)).status).toBe(404);
    expect((await admin.req('GET', `/files/${r.data.file.id}/download`, undefined, true)).status).toBe(200);
  });
  it('historique par pages de 50', async () => {
    for (let i = 0; i < 55; i++) await admin.post(`/channels/${general}/messages`, { body: `m${i}` });
    const page1 = (await admin.get(`/channels/${general}/messages`)).data;
    expect(page1.messages).toHaveLength(50);
    expect(page1.hasMore).toBe(true);
    const older = (await admin.get(`/channels/${general}/messages?before=${encodeURIComponent(page1.messages[0].createdAt)}`)).data;
    expect(older.messages.length).toBeGreaterThan(0);
  }, 20_000);
  it('temps réel : le message privé ne parvient qu\'à ses deux participants', async () => {
    const open = (c: Client) =>
      new Promise<{ ws: WebSocket; got: any[] }>((resolve) => {
        const ws = new WebSocket(`${srv.url.replace('http', 'ws')}/ws?token=${c.token}`);
        const got: any[] = [];
        ws.on('message', (d) => got.push(JSON.parse(String(d))));
        ws.on('open', () => resolve({ ws, got }));
      });
    const a = await open(admin);
    const g = await open(guest);
    await founder.post(`/channels/${dm}/messages`, { body: 'ping' });
    await new Promise((r) => setTimeout(r, 400));
    expect(a.got.some((e) => e.type === 'message' && e.message.body === 'ping')).toBe(true);
    expect(g.got.some((e) => e.type === 'message')).toBe(false);
    a.ws.close();
    g.ws.close();
  });
});

describe('Rendez-vous (F-RDV)', () => {
  it('un invité ne crée pas de RDV et ne voit pas ceux de l\'équipe ; il voit ceux de son projet', async () => {
    const start = new Date(Date.now() + 3 * 86_400_000).toISOString();
    expect((await guest.post('/meetings', { title: 'x', startsAt: start })).status).toBe(403);
    const team = await founder.post('/meetings', { title: 'Point équipe', startsAt: start, location: 'https://meet.test' });
    expect(team.status).toBe(201);
    const proj = await founder.post('/meetings', { title: 'RDV projet', startsAt: start, projectId });
    expect((await guest.get('/meetings')).data.meetings.map((m: any) => m.title)).toEqual(['RDV projet']);
    expect((await admin.get('/meetings')).data.meetings).toHaveLength(2);
    expect((await guest.post(`/meetings/${team.data.meeting.id}/rsvp`, { status: 'yes' })).status).toBe(404);
    expect((await guest.post(`/meetings/${proj.data.meeting.id}/rsvp`, { status: 'maybe' })).status).toBe(200);
    expect((await admin.post(`/meetings/${team.data.meeting.id}/rsvp`, { status: 'no' })).status).toBe(200);
    const list = (await founder.get('/meetings')).data.meetings.find((m: any) => m.title === 'Point équipe');
    expect(list.attendees.map((a: any) => a.status).sort()).toEqual(['no', 'yes']);
    expect((await admin.get('/notifications')).data.notifications.some((n: any) => n.type === 'meeting')).toBe(true);
  });
});

describe('Journal, RGPD, sécurité', () => {
  it("journal d'activité : Super Admin seulement", async () => {
    expect((await founder.get('/activity')).status).toBe(403);
    const a = await admin.get('/activity');
    expect(a.status).toBe(200);
    expect(a.data.activity.length).toBeGreaterThan(5);
    expect((await admin.get('/admin/access-logs')).status).toBe(200);
    expect((await founder.get('/admin/access-logs')).status).toBe(403);
    expect((await founder.get(`/projects/${projectId}/activity`)).data.activity.length).toBeGreaterThan(0);
  });
  it("promotion d'un fondateur en Super Admin : droits étendus, ancienne session invalidée, rétrogradation", async () => {
    const c = new Client(srv.url);
    await c.register('Promu Test', 'promu@t.test', srv.codes.member);
    expect((await c.get('/activity')).status).toBe(403);
    expect((await c.post('/channels', { name: 'promu' })).status).toBe(403);
    expect((await admin.patch(`/members/${c.user.id}/role`, { role: 'admin' })).status).toBe(200);
    expect((await c.get('/me')).status).toBe(401); // il doit se reconnecter pour appliquer son nouveau rôle
    c.token = (await c.post('/auth/login', { email: 'promu@t.test', password: 'motdepasse123' })).data.token;
    expect((await c.get('/activity')).status).toBe(200);
    expect((await c.post('/channels', { name: 'promu' })).status).toBe(201);
    expect((await admin.patch(`/members/${c.user.id}/role`, { role: 'member' })).status).toBe(200);
    c.token = (await c.post('/auth/login', { email: 'promu@t.test', password: 'motdepasse123' })).data.token;
    expect((await c.get('/activity')).status).toBe(403);
  });
  it('droit d\'accès : export JSON des données personnelles', async () => {
    const r = await founder.get('/me/export');
    expect(r.status).toBe(200);
    expect(r.data.profil.email).toBe('f@t.test');
    expect(r.data.messages.length).toBeGreaterThan(0);
    expect(JSON.stringify(r.data)).not.toContain('password');
  });
  it('profil : changement de nom/e-mail et de mot de passe (anciennes sessions invalidées)', async () => {
    const c = new Client(srv.url);
    await c.register('Temp User', 'temp@t.test', srv.codes.member);
    expect((await c.patch('/me', { name: 'Temp Renommé', emailNotif: false })).status).toBe(200);
    expect((await c.patch('/me', { email: 'f@t.test' })).status).toBe(409);
    const old = c.token;
    expect((await c.post('/me/password', { current: 'faux', next: 'nouveaumotdepasse' })).status).toBe(403);
    const r = await c.post('/me/password', { current: 'motdepasse123', next: 'nouveaumotdepasse' });
    c.token = old;
    expect((await c.get('/me')).status).toBe(401);
    c.token = r.data.token;
    expect((await c.get('/me')).status).toBe(200);
  });
  it("droit à l'oubli : suppression en cascade, dernier Super Admin protégé", async () => {
    const c = new Client(srv.url);
    await c.register('À Oublier', 'oublie@t.test', srv.codes.member);
    const f = (await c.upload({ name: 'perso.txt', content: 'x' })).data.file;
    const g = (await c.get('/channels')).data.channels[0].id;
    await c.post(`/channels/${g}/messages`, { body: 'à effacer ABC123' });
    expect((await c.del('/me', { password: 'faux' })).status).toBe(403);
    expect((await c.del('/me', { password: 'motdepasse123' })).status).toBe(200);
    expect((await admin.req('GET', `/files/${f.id}/download`, undefined, true)).status).toBe(404);
    const msgs = (await admin.get(`/channels/${g}/messages`)).data.messages;
    expect(JSON.stringify(msgs)).not.toContain('ABC123');
    expect((await admin.del('/me', { password: 'motdepasse123' })).status).toBe(400);
  });
  it('en-têtes de sécurité et CSP', async () => {
    const res = await fetch(srv.url + '/api/health');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
  });
  it('injection SQL dans la recherche : aucun effet', async () => {
    const r = await founder.get(`/files?q=${encodeURIComponent("' OR 1=1; DROP TABLE users; --")}`);
    expect(r.status).toBe(200);
    expect((await admin.get('/members')).data.members.length).toBeGreaterThan(3);
  });
});
