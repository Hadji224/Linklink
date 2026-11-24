import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, startServer, type Srv } from './helpers.js';

let srv: Srv;
let admin: Client;
let general = '';
const tmpFiles = () => fs.readdirSync(path.join(srv.dataDir, 'tmp'));
const localFiles = () => fs.readdirSync(path.join(srv.dataDir, 'uploads'));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const blobs = async () => Number((await srv.sql('SELECT COUNT(*) AS n FROM file_blobs')).rows[0].n);

beforeAll(async () => {
  // La purge tourne toutes les 300 ms ; plafond de place très bas (0,002 Mo ≈ 2 Ko) pour tester la règle « les plus anciens d'abord ».
  srv = await startServer({ env: { CHAT_PURGE_EVERY_MS: '300', CHAT_STORE_BUDGET_MB: '0.002', CHAT_MAX_FILE_MB: '1' } });
  admin = await new Client(srv.url).register('Admin', 'a@t.test');
  general = (await admin.get('/channels')).data.channels.find((c: any) => c.name === 'général').id;
});
afterAll(async () => { await srv?.stop(); });

describe('Pièces jointes des salons : relais temporaire (modèle WhatsApp)', () => {
  it('une pièce jointe de salon est rangée en base (db:…), avec une date d’expiration, jamais sur le disque', async () => {
    const r = await admin.upload({ name: 'photo.txt', content: 'abc', type: 'text/plain' }, { channelId: general });
    expect(r.status).toBe(201);
    const row = (await srv.sql('SELECT stored_name, expires_at, purged_at FROM files WHERE id = ?', r.data.file.id)).rows[0];
    expect(row.stored_name).toMatch(/^db:[0-9a-f-]{36}$/);
    expect(row.purged_at).toBeNull();
    const days = (Date.parse(row.expires_at) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThanOrEqual(30);
    expect(r.data.message.file).toMatchObject({ name: 'photo.txt', expired: false });
    expect(r.data.message.file.expiresAt).toBe(row.expires_at);
    expect(localFiles()).toHaveLength(0);
    expect(tmpFiles()).toHaveLength(0);
  });

  it('le contenu exact (octets bruts) est restitué au téléchargement et à l’aperçu', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 255, 10, 13, 200, 1, 2, 3]);
    const fd = new FormData();
    fd.append('channelId', general);
    fd.append('file', new Blob([bytes], { type: 'image/png' }), 'Éléphant.png');
    const r = await admin.req('POST', '/files', fd);
    expect(r.status).toBe(201);
    const prev = await admin.req('GET', `/files/${r.data.file.id}/preview`, undefined, true);
    expect(Buffer.from(await prev.res.arrayBuffer())).toEqual(bytes);
    const dl = await admin.req('GET', `/files/${r.data.file.id}/download`, undefined, true);
    expect(dl.res.headers.get('content-disposition')).toMatch(/attachment/);
    expect(Buffer.from(await dl.res.arrayBuffer())).toEqual(bytes);
    expect((await new Client(srv.url).req('GET', `/files/${r.data.file.id}/download`, undefined, true)).status).toBe(401);
  });

  it('un fichier de Documents (hors salon) ne passe PAS par ce relais : disque local, sans expiration', async () => {
    const r = await admin.upload({ name: 'statuts.txt', content: 'important', type: 'text/plain' });
    expect(r.status).toBe(201);
    const row = (await srv.sql('SELECT stored_name, expires_at FROM files WHERE id = ?', r.data.file.id)).rows[0];
    expect(row.stored_name).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.expires_at).toBeNull();
    expect(r.data.file.expired).toBe(false);
  });

  it('au-delà de la taille permise pour un salon : 413 et rien n’est conservé', async () => {
    const before = await blobs();
    const big = 'x'.repeat(1024 * 1024 + 10);
    const r = await admin.upload({ name: 'gros.txt', content: big, type: 'text/plain' }, { channelId: general });
    expect(r.status).toBe(413);
    expect(await blobs()).toBe(before);
    expect(tmpFiles()).toHaveLength(0);
  });

  it('échéance atteinte : le fichier est supprimé du serveur, le message reste, le téléchargement répond 410', async () => {
    const r = await admin.upload({ name: 'vieux.txt', content: 'zzz', type: 'text/plain' }, { channelId: general });
    const id = r.data.file.id;
    await srv.sql('UPDATE files SET expires_at = ? WHERE id = ?', new Date(Date.now() - 1000).toISOString(), id);
    let row: any;
    for (let i = 0; i < 30; i++) {
      await wait(200);
      row = (await srv.sql('SELECT stored_name, purged_at FROM files WHERE id = ?', id)).rows[0];
      if (row.purged_at) break;
    }
    expect(row.purged_at).toBeTruthy();
    expect(row.stored_name).toBe('expired');
    const gone = await admin.req('GET', `/files/${id}/download`);
    expect(gone.status).toBe(410);
    expect(gone.data.error).toMatch(/expiré/);
    // le message est toujours là, marqué « expiré »
    const msgs = (await admin.get(`/channels/${general}/messages`)).data.messages;
    expect(msgs.find((m: any) => m.file?.id === id).file).toMatchObject({ name: 'vieux.txt', expired: true });
  });

  it('place limitée : les plus anciens fichiers sont retirés d’abord, le plus récent survit', async () => {
    const mk = async (name: string) => (await admin.upload({ name, content: 'y'.repeat(1500), type: 'text/plain' }, { channelId: general })).data.file.id;
    const a = await mk('ancien.txt');
    await wait(20);
    const b = await mk('recent.txt');
    let ra: any, rb: any;
    for (let i = 0; i < 40; i++) {
      await wait(200);
      ra = (await srv.sql('SELECT purged_at FROM files WHERE id = ?', a)).rows[0];
      rb = (await srv.sql('SELECT purged_at FROM files WHERE id = ?', b)).rows[0];
      if (ra.purged_at) break;
    }
    expect(ra.purged_at).toBeTruthy(); // le plus ancien est parti
    // le plafond est ~2 Ko : un seul fichier de 1,5 Ko tient ; le plus récent est conservé
    expect(rb.purged_at).toBeNull();
    expect((await admin.req('GET', `/files/${b}/download`, undefined, true)).status).toBe(200);
  });

  it('la suppression d’un message-fichier retire aussi le contenu de la base', async () => {
    await wait(700); // laisse la purge précédente se terminer
    const r = await admin.upload({ name: 'a-supprimer.txt', content: 'k', type: 'text/plain' }, { channelId: general });
    const key = (await srv.sql('SELECT stored_name FROM files WHERE id = ?', r.data.file.id)).rows[0].stored_name;
    expect((await admin.del(`/files/${r.data.file.id}`)).status).toBe(200);
    await wait(300);
    expect((await srv.sql('SELECT 1 FROM file_blobs WHERE key = ?', key)).rows).toHaveLength(0);
  });
});
