import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, startServer, type Srv } from './helpers.js';

let srv: Srv;
let admin: Client, founder: Client;

// Plus petit PNG valide (1 × 1 pixel) ; un JPEG et un WebP ne servent ici qu'à leurs premiers octets.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

const send = (c: Client, bytes: Buffer, name: string, type: string) => {
  const fd = new FormData();
  fd.append('file', new Blob([bytes], { type }), name);
  return c.req('PUT', '/branding/logo', fd);
};

beforeAll(async () => {
  srv = await startServer();
  admin = await new Client(srv.url).register('Admin', 'a@t.test');
  founder = await new Client(srv.url).register('Fondatrice', 'f@t.test', srv.codes.member);
});
afterAll(async () => { await srv?.stop(); });

describe('Logo personnalisé de la plateforme', () => {
  it('par défaut : aucun logo personnalisé, lisible sans être connecté', async () => {
    const c = new Client(srv.url);
    const r = await c.get('/branding');
    expect(r.status).toBe(200);
    expect(r.data).toEqual({ custom: false, version: null });
    expect((await c.get('/branding/logo')).status).toBe(404);
  });

  it("seuls l'admin technique, le PDG et le Chargé de communication peuvent le changer", async () => {
    expect((await send(founder, PNG, 'logo.png', 'image/png')).status).toBe(403);
    expect((await founder.del('/branding/logo')).status).toBe(403);
    expect(admin.user.role).toBe('admin');
    const me = (await admin.get('/me')).data;
    expect(me.user?.can?.['branding.edit'] ?? me.can?.['branding.edit']).toBe(true);
  });

  it('un PNG valide est enregistré, restitué tel quel à tout le monde, et journalisé', async () => {
    const r = await send(admin, PNG, 'logo.png', 'image/png');
    expect(r.status).toBe(200);
    expect(r.data.custom).toBe(true);

    const pub = new Client(srv.url);
    const info = (await pub.get('/branding')).data;
    expect(info).toMatchObject({ custom: true, version: r.data.version });
    const img = await pub.req('GET', '/branding/logo', undefined, true);
    expect(img.res.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await img.res.arrayBuffer()).equals(PNG)).toBe(true);

    const log = (await srv.sql("SELECT action FROM audit_log WHERE action = 'branding_logo_set'")).rows;
    expect(log).toHaveLength(1);
  });

  it('refuse un SVG (script possible), un faux PNG et un fichier trop lourd', async () => {
    expect((await send(admin, SVG, 'logo.svg', 'image/svg+xml')).status).toBe(415);
    expect((await send(admin, Buffer.from('pas une image'), 'faux.png', 'image/png')).status).toBe(415);
    const big = Buffer.concat([PNG, Buffer.alloc(1024 * 1024 + 10)]);
    expect((await send(admin, big, 'gros.png', 'image/png')).status).toBe(413);
    // l'ancien logo est conservé
    expect((await new Client(srv.url).get('/branding')).data.custom).toBe(true);
  });

  it('un JPEG est accepté (type détecté par les octets, pas par le nom) puis on peut rétablir le logo d’origine', async () => {
    const r = await send(admin, JPEG, 'photo.png', 'image/png');
    expect(r.status).toBe(200);
    const img = await new Client(srv.url).req('GET', '/branding/logo', undefined, true);
    expect(img.res.headers.get('content-type')).toBe('image/jpeg');

    expect((await admin.del('/branding/logo')).status).toBe(200);
    expect((await new Client(srv.url).get('/branding')).data).toEqual({ custom: false, version: null });
    expect((await new Client(srv.url).get('/branding/logo')).status).toBe(404);
  });
});
