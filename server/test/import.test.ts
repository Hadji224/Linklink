import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Client, createTestDatabase, startServer, type Srv } from './helpers.js';

// legacy-v4.db : vraie base de l'ancienne version SQLite (compte hadji@t.test / motdepasse123, un projet, une tâche, un message, un fichier).
const FIXTURE = path.resolve(import.meta.dirname, 'fixtures/legacy-v4.db');
const importer = (url: string) =>
  spawnSync(process.execPath, ['--no-warnings', '--import', 'tsx', 'scripts/import-sqlite.ts', FIXTURE], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, DATABASE_URL: url },
    encoding: 'utf8',
  });

let srv: Srv | undefined;
let drop: (() => Promise<void>) | undefined;
afterAll(async () => { await srv?.stop(); await drop?.(); });

describe('Import d\'une ancienne base SQLite', () => {
  it('reprend comptes, projets, tâches, messages et fichiers ; l\'ancien mot de passe fonctionne', async () => {
    const db = await createTestDatabase();
    drop = db.drop;
    const r = importer(db.url);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/users\s+1 lignes/);
    expect(r.stdout).not.toMatch(/ignorées/);

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linklink-import-'));
    fs.mkdirSync(path.join(dataDir, 'uploads'), { recursive: true });
    for (const f of fs.readdirSync(path.join(import.meta.dirname, 'fixtures/uploads'))) fs.copyFileSync(path.join(import.meta.dirname, 'fixtures/uploads', f), path.join(dataDir, 'uploads', f));
    srv = await startServer({ dataDir, databaseUrl: db.url });

    const c = new Client(srv.url);
    const login = await c.post('/auth/login', { email: 'hadji@t.test', password: 'motdepasse123' });
    expect(login.status).toBe(200);
    c.token = login.data.token;
    expect(login.data.user.role).toBe('admin');
    const projects = (await c.get('/projects')).data.projects;
    expect(projects.map((p: any) => p.name)).toEqual(['Projet Ancien']);
    const tasks = (await c.get(`/tasks?projectId=${projects[0].id}`)).data.tasks;
    expect(tasks[0].title).toBe('Tâche ancienne');
    expect((await c.get(`/tasks/${tasks[0].id}`)).data.task.subtasks).toHaveLength(2);
    const file = (await c.get('/files')).data.files[0];
    expect(file.name).toBe('ancien.txt');
    expect(await (await c.req('GET', `/files/${file.id}/download`, undefined, true)).res.text()).toContain('contenu du fichier ancien');
    // les données initiales ne sont pas dupliquées au démarrage
    expect((await srv.sql("SELECT COUNT(*) AS n FROM folders WHERE system = 'general'")).rows[0].n).toBe(1);
    // le journal immuable est conservé et reste protégé
    expect((await srv.sql('SELECT COUNT(*) AS n FROM audit_log')).rows[0].n).toBeGreaterThan(0);
  });

  it('refuse d\'écraser une base déjà utilisée', async () => {
    const r = importer(srv!.databaseUrl);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/import refusé/);
  });
});
