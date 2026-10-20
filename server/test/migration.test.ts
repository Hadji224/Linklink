import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Client, startServer, type Srv } from './helpers.js';

const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
let srv: Srv | undefined;
afterAll(() => srv?.stop());

// Schéma de la v1 (premier MVP) : la base existante d'un utilisateur doit survivre à la mise à jour.
const V1 = `
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')), created_at TEXT NOT NULL);
CREATE TABLE channels (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL DEFAULT '', admin_only INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE files (id TEXT PRIMARY KEY, name TEXT NOT NULL, stored_name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL,
  folder TEXT NOT NULL DEFAULT 'Général', user_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL);
CREATE TABLE messages (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL DEFAULT '', file_id TEXT REFERENCES files(id) ON DELETE SET NULL, created_at TEXT NOT NULL);
CREATE TABLE meetings (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', location TEXT NOT NULL DEFAULT '', starts_at TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL);
CREATE TABLE rsvps (meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL, PRIMARY KEY (meeting_id, user_id));
`;

describe('Migration v1 → v2', () => {
  it('conserve comptes, messages, fichiers et rendez-vous', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linklink-mig-'));
    const db = new DatabaseSync(path.join(dir, 'linklink.db'));
    db.exec(V1);
    // mot de passe « motdepasse123 » (bcrypt, coût 10)
    const hash = '$2a$10$abcdefghijklmnopqrstuuJ8k8n9J6bqz5N1m3m0xQe3d8o8Zl9uq';
    const t = '2026-01-01T10:00:00.000Z';
    db.prepare("INSERT INTO users VALUES ('u1','Ancien Admin','ancien@t.test',?, 'admin', ?)").run(hash, t);
    db.prepare("INSERT INTO settings VALUES ('invite_code','AAAA-BBBB')").run();
    db.prepare("INSERT INTO channels VALUES ('c1','général','',0,?)").run(t);
    db.prepare("INSERT INTO files VALUES ('f1','ancien.pdf','stored1','application/pdf',10,'Application mobile','u1',?)").run(t);
    db.prepare("INSERT INTO files VALUES ('f2','chat.txt','stored2','text/plain',5,'Général','u1',?)").run(t);
    db.prepare("INSERT INTO messages VALUES ('m1','c1','u1','Vieux message',NULL,?)").run(t);
    db.prepare("INSERT INTO messages VALUES ('m2','c1','u1','',  'f2',?)").run(t);
    db.prepare("INSERT INTO meetings VALUES ('r1','Vieux RDV','','', '2030-01-01T10:00:00.000Z','u1',?)").run(t);
    db.prepare("INSERT INTO rsvps VALUES ('r1','u1','yes')").run();
    db.close();

    srv = await startServer(dir);
    expect(srv.codes.member).toBe('AAAA-BBBB'); // le code d'invitation existant est conservé
    expect(fs.readdirSync(path.join(dir, 'backups')).some((f) => f.startsWith('linklink-v1-avant-migration'))).toBe(true);

    // On se reconnecte avec un nouveau compte invité pour constater les données (le hash factice ci-dessus ne sert pas à se connecter).
    const c = new Client(srv.url);
    await c.register('Nouveau', 'nouveau@t.test', 'AAAA-BBBB');
    const members = (await c.get('/members')).data.members;
    expect(members.find((m: any) => m.email === 'ancien@t.test').role).toBe('admin');
    const channels = (await c.get('/channels')).data.channels;
    const general = channels.find((x: any) => x.name === 'général');
    const msgs = (await c.get(`/channels/${general.id}/messages`)).data.messages;
    expect(msgs.map((m: any) => m.body)).toContain('Vieux message');
    expect(msgs.some((m: any) => m.file?.name === 'chat.txt')).toBe(true);
    const folders = (await c.get('/folders')).data.folders;
    const cf = folders.find((f: any) => f.name === 'Application mobile');
    expect(cf).toBeTruthy();
    expect((await c.get(`/files?folderId=${cf.id}`)).data.files.map((f: any) => f.name)).toEqual(['ancien.pdf']);
    expect((await c.get('/meetings')).data.meetings.map((m: any) => m.title)).toContain('Vieux RDV');
  });
});

describe('Migration v2 → v3 (droits sur les tâches)', () => {
  it("une base v2 existante gagne l'archivage, l'historique et les index sans perdre ses tâches", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linklink-mig3-'));
    let s = await startServer(dir);
    const c = await new Client(s.url).register('Admin', 'admin@t.test');
    const pid = (await c.post('/projects', { name: 'Projet v2' })).data.project.id;
    const tid = (await c.post('/tasks', { projectId: pid, title: 'Tâche existante', assigneeId: c.user.id })).data.task.id;
    await s.stop();
    // On remet la base dans l'état d'une v2 : sans archived_at, sans historique, sans déclencheurs.
    const db = new DatabaseSync(path.join(dir, 'linklink.db'));
    db.exec(`DROP TRIGGER task_history_immutable; DROP TRIGGER task_comments_immutable; DROP TABLE task_history;
      DROP INDEX idx_tasks_creator; DROP INDEX idx_tasks_status; DROP INDEX idx_tasks_due; DROP INDEX idx_comments_task;
      ALTER TABLE tasks DROP COLUMN archived_at; PRAGMA user_version = 2;`);
    db.close();
    s = srv = await startServer(dir);
    const c2 = new Client(s.url);
    const login = await c2.post('/auth/login', { email: 'admin@t.test', password: 'motdepasse123' });
    c2.token = login.data.token;
    const t = (await c2.get(`/tasks/${tid}`)).data.task;
    expect(t.title).toBe('Tâche existante');
    expect(t.myRole).toBe('admin'); // le premier compte est Super Admin
    expect((await c2.patch(`/tasks/${tid}`, { priority: 'urgent' })).data.task.history).toHaveLength(1);
    const after = new DatabaseSync(path.join(dir, 'linklink.db'));
    expect((after.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(3);
    after.close();
  });
});
