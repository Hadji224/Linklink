import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeDrive } from './fakedrive.js';
import { Client, startServer, type Srv } from './helpers.js';

let drive: Awaited<ReturnType<typeof startFakeDrive>>;
let srv: Srv;
let admin: Client;
const tmpFiles = () => fs.readdirSync(path.join(srv.dataDir, 'tmp'));
const localFiles = () => fs.readdirSync(path.join(srv.dataDir, 'uploads'));

beforeAll(async () => {
  drive = await startFakeDrive();
  srv = await startServer({ env: drive.env });
  admin = await new Client(srv.url).register('Admin', 'a@t.test');
});
afterAll(async () => { await srv?.stop(); await drive?.stop(); });

describe('Stockage Google Drive (serveur Google simulé)', () => {
  it('un fichier envoyé arrive dans le dossier Drive « LinkLink », jamais sur le disque du serveur', async () => {
    const r = await admin.upload({ name: 'rapport.txt', content: 'bonjour drive', type: 'text/plain' });
    expect(r.status).toBe(201);
    const row = (await srv.sql('SELECT stored_name FROM files WHERE id = ?', r.data.file.id)).rows[0];
    expect(row.stored_name).toMatch(/^drive:/);
    const [f] = drive.userFiles();
    expect(f?.name).toBe('rapport.txt');
    expect(f?.data.toString()).toBe('bonjour drive');
    const folder = drive.files.get(f?.parents[0] as string);
    expect(folder?.name).toBe('LinkLink');
    expect(localFiles()).toHaveLength(0);
    expect(tmpFiles()).toHaveLength(0); // copie temporaire effacée
  });

  it('le téléchargement passe par le serveur (droits appliqués) et renvoie le contenu exact', async () => {
    const list = (await admin.get('/files')).data.files;
    const id = list.find((f: any) => f.name === 'rapport.txt').id;
    const d = await admin.req('GET', `/files/${id}/download`, undefined, true);
    expect(d.status).toBe(200);
    expect(d.res.headers.get('content-disposition')).toMatch(/attachment; filename="rapport\.txt"/);
    expect(await d.res.text()).toBe('bonjour drive');
    // un inconnu n'obtient rien
    expect((await new Client(srv.url).req('GET', `/files/${id}/download`, undefined, true)).status).toBe(401);
  });

  it('accents et fichiers binaires intacts', async () => {
    const bytes = Buffer.from([0, 255, 10, 13, 200, 1, 2, 3]);
    const fd = new FormData();
    fd.append('file', new Blob([bytes], { type: 'image/png' }), 'Éléphant été.png');
    const r = await admin.req('POST', '/files', fd);
    expect(r.status).toBe(201);
    const got = await admin.req('GET', `/files/${r.data.file.id}/preview`, undefined, true);
    expect(Buffer.from(await got.res.arrayBuffer())).toEqual(bytes);
    expect(drive.userFiles().some((f) => f.name === 'Éléphant été.png')).toBe(true);
  });

  it('la suppression retire aussi le fichier de Drive', async () => {
    const before = drive.userFiles().length;
    const id = (await admin.get('/files')).data.files.find((f: any) => f.name === 'rapport.txt').id;
    expect((await admin.del(`/files/${id}`)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 300)); // suppression en arrière-plan
    expect(drive.userFiles().length).toBe(before - 1);
    expect(drive.userFiles().some((f) => f.name === 'rapport.txt')).toBe(false);
  });

  it('refus avant envoi (format interdit, secret dans Infrastructure) : rien n’arrive sur Drive', async () => {
    const before = drive.userFiles().length;
    expect((await admin.upload({ name: 'virus.exe', content: 'x' })).status).toBe(415);
    const infra = (await admin.get('/folders')).data.folders.find((f: any) => f.name === 'Infrastructure');
    expect((await admin.upload({ name: 'secret-prod.txt', content: 'SECRET=1' }, { folderId: infra.id })).status).toBe(422);
    expect(drive.userFiles().length).toBe(before);
    expect(tmpFiles()).toHaveLength(0);
  });

  it('panne de Drive : erreur claire (502), aucune ligne orpheline en base, rien de temporaire', async () => {
    const rows = (await srv.sql('SELECT COUNT(*) AS n FROM files')).rows[0].n;
    drive.state.failUploads = 10; // plus que le nombre de tentatives
    const r = await admin.upload({ name: 'perdu.txt', content: 'x' });
    expect(r.status).toBe(502);
    expect(r.data.error).toMatch(/Google Drive/);
    drive.state.failUploads = 0;
    expect((await srv.sql('SELECT COUNT(*) AS n FROM files')).rows[0].n).toBe(rows);
    expect(tmpFiles()).toHaveLength(0);
  });

  it('une erreur passagère (500 une fois) est rejouée automatiquement', async () => {
    drive.state.failUploads = 1;
    expect((await admin.upload({ name: 'passager.txt', content: 'ok' })).status).toBe(201);
  });

  it('jeton expiré (401) : renouvelé sans que l’utilisateur le voie', async () => {
    const tokens = drive.state.tokens;
    drive.state.expireNext = true;
    expect((await admin.upload({ name: 'jeton.txt', content: 'ok' })).status).toBe(201);
    expect(drive.state.tokens).toBeGreaterThan(tokens);
  });

  it('le dossier Drive est retrouvé après un redémarrage (pas recréé)', async () => {
    const creations = drive.state.folderCreations;
    await srv.restart();
    admin = new Client(srv.url);
    await admin.post('/auth/login', {}).catch(() => {});
    const login = await admin.post('/auth/login', { email: 'a@t.test', password: 'motdepasse123' });
    admin.token = login.data.token;
    expect((await admin.upload({ name: 'apres.txt', content: 'ok' })).status).toBe(201);
    expect(drive.state.folderCreations).toBe(creations);
  });

  it('droit à l’oubli : les fichiers de la personne supprimée disparaissent de Drive', async () => {
    const guest = await new Client(srv.url).register('À Oublier', 'oublie@t.test', srv.codes.member);
    const r = await guest.upload({ name: 'perso.txt', content: 'x' });
    expect(r.status).toBe(201);
    expect(drive.userFiles().some((f) => f.name === 'perso.txt')).toBe(true);
    const del = await guest.req('DELETE', '/me', { password: 'motdepasse123' });
    expect(del.status).toBe(200);
    await new Promise((r2) => setTimeout(r2, 300));
    expect(drive.userFiles().some((f) => f.name === 'perso.txt')).toBe(false);
  });
});
