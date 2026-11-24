import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { Client, startServer, type Srv } from './helpers.js';

// Secrets générés à chaque exécution : aucune valeur fixe dans le dépôt.
const JWT_SECRET = crypto.randomBytes(32).toString('hex');
const BOOT = crypto.randomBytes(12).toString('hex');
const wsUrl = (s: Srv, q: string) => `${s.url.replace('http', 'ws')}/ws?${q}`;
const attempt = (url: string, origin?: string) =>
  new Promise<'open' | number>((resolve) => {
    const ws = new WebSocket(url, origin ? { headers: { origin } } : undefined);
    ws.on('open', () => { ws.close(); resolve('open'); });
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    ws.on('error', () => {});
  });
const login = (s: Srv, email: string, password: string) => new Client(s.url).post('/auth/login', { email, password });

describe('Initialisation du premier compte (BOOTSTRAP_SECRET)', () => {
  let hosted: Srv, locked: Srv;
  beforeAll(async () => {
    hosted = await startServer({ env: { RENDER: '1', BOOTSTRAP_SECRET: BOOT, JWT_SECRET } });
    locked = await startServer({ env: { RENDER: '1', BOOTSTRAP_SECRET: '' } });
  }, 60_000);
  afterAll(async () => { await hosted?.stop(); await locked?.stop(); });

  const reg = (s: Srv, extra: Record<string, unknown>) =>
    new Client(s.url).post('/auth/register', { name: 'Premier', email: 'p@t.test', password: 'motdepasse123', inviteCode: '', consent: true, ...extra });

  it("hébergé sans secret défini : l'inscription du premier compte est verrouillée (503)", async () => {
    expect((await reg(locked, {})).status).toBe(503);
    const setup = (await new Client(locked.url).get('/setup')).data;
    expect(setup).toMatchObject({ hasUsers: false, bootstrapRequired: false, bootstrapLocked: true });
  });

  it('hébergé avec secret : refusé sans le secret ou avec un faux, accepté avec le bon', async () => {
    expect((await new Client(hosted.url).get('/setup')).data).toMatchObject({ bootstrapRequired: true, bootstrapLocked: false });
    expect((await reg(hosted, {})).status).toBe(403);
    expect((await reg(hosted, { bootstrapSecret: 'mauvais' })).status).toBe(403);
    const ok = await reg(hosted, { bootstrapSecret: BOOT });
    expect(ok.status).toBe(201);
    expect(ok.data.user.role).toBe('admin');
    expect((await new Client(hosted.url).get('/setup')).data).toMatchObject({ hasUsers: true, bootstrapRequired: false });
  });
});

describe('Sécurité du serveur', () => {
  let srv: Srv;
  let admin: Client, founder: Client, guest: Client;

  beforeAll(async () => {
    srv = await startServer({ env: { JWT_SECRET, AUTH_FAIL_LIMIT_ACCOUNT: '4', AUTH_FAIL_LIMIT_IP: '12', USER_QUOTA_MB: '0.002' } });
    admin = await new Client(srv.url).register('Admin', 'a@t.test');
    founder = await new Client(srv.url).register('Fondatrice', 'f@t.test', srv.codes.member);
    guest = await new Client(srv.url).register('Invité', 'g@t.test', srv.codes.guest);
  }, 60_000);
  afterAll(async () => { await srv?.stop(); });

  describe('Codes d\'invitation', () => {
    it("l'invitation expire : un code périmé est refusé, la régénération remet une échéance", async () => {
      const past = new Date(Date.now() - 1000).toISOString();
      await srv.sql("UPDATE settings SET value = ? WHERE key = 'invite_code_expires_at'", past);
      const r = await new Client(srv.url).post('/auth/register', { name: 'X', email: 'x@t.test', password: 'motdepasse123', inviteCode: srv.codes.member, consent: true });
      expect(r.status).toBe(403);
      const regen = await admin.post('/invite/regenerate', { kind: 'member' });
      expect(regen.status).toBe(200);
      const inv = (await admin.get('/invite')).data;
      expect(new Date(inv.expiresAt).getTime()).toBeGreaterThan(Date.now() + 20 * 86_400_000);
      expect(inv.code).not.toBe(srv.codes.member);
      srv.codes.member = inv.code;
    });
    it('un invité ne voit jamais les codes', async () => {
      expect((await guest.get('/invite')).status).toBe(403);
    });
  });

  describe('WebSocket par ticket', () => {
    it("le ticket sert une seule fois, le jeton de session dans l'adresse est refusé", async () => {
      const t = (await founder.post('/ws-ticket')).data.ticket as string;
      expect(await attempt(wsUrl(srv, `ticket=${t}`))).toBe('open');
      expect(await attempt(wsUrl(srv, `ticket=${t}`))).toBe(401);
      expect(await attempt(wsUrl(srv, `token=${founder.token}`))).toBe(401);
      expect(await attempt(wsUrl(srv, ''))).toBe(401);
    });
    it('un ticket expiré est refusé', async () => {
      const t = (await founder.post('/ws-ticket')).data.ticket as string;
      await srv.sql("UPDATE ws_tickets SET expires_at = ?", new Date(Date.now() - 1000).toISOString());
      expect(await attempt(wsUrl(srv, `ticket=${t}`))).toBe(401);
    });
    it("une origine étrangère est refusée même avec un ticket valide", async () => {
      const t = (await founder.post('/ws-ticket')).data.ticket as string;
      expect(await attempt(wsUrl(srv, `ticket=${t}`), 'https://pirate.example')).toBe(403);
      const t2 = (await founder.post('/ws-ticket')).data.ticket as string;
      expect(await attempt(wsUrl(srv, `ticket=${t2}`), srv.url)).toBe('open');
    });
    it('sans connexion on ne reçoit pas de ticket', async () => {
      expect((await new Client(srv.url).post('/ws-ticket')).status).toBe(401);
    });
  });

  describe('Annuaire et santé', () => {
    it("un invité ne voit ni e-mails ni dates d'inscription des membres", async () => {
      const m = (await guest.get('/members')).data.members as any[];
      expect(m.length).toBeGreaterThan(1);
      for (const x of m) {
        expect(x.email).toBeUndefined();
        expect(x.createdAt).toBeUndefined();
      }
      const staff = (await founder.get('/members')).data.members as any[];
      expect(staff.every((x) => typeof x.email === 'string')).toBe(true);
    });
    it('/health ne révèle ni le stockage ni la configuration', async () => {
      const r = await new Client(srv.url).get('/health');
      expect(r.status).toBe(200);
      expect(Object.keys(r.data).sort()).toEqual(['ok', 'time']);
    });
  });

  describe('Mots de passe', () => {
    it("un ancien hash bcrypt reste valable puis est remplacé par scrypt à la connexion", async () => {
      const c = await new Client(srv.url).register('Ancien', 'ancien@t.test', srv.codes.member);
      await srv.sql('UPDATE users SET password_hash = ? WHERE id = ?', bcrypt.hashSync('motdepasse123', 4), c.user.id);
      expect((await srv.sql('SELECT password_hash h FROM users WHERE id = ?', c.user.id)).rows[0].h).toMatch(/^\$2/);
      expect((await login(srv, 'ancien@t.test', 'motdepasse123')).status).toBe(200);
      expect((await srv.sql('SELECT password_hash h FROM users WHERE id = ?', c.user.id)).rows[0].h).toMatch(/^scrypt\$/);
      expect((await login(srv, 'ancien@t.test', 'motdepasse123')).status).toBe(200);
      expect((await login(srv, 'ancien@t.test', 'autre-mot-de-passe')).status).toBe(401);
    });
  });

  describe('Sessions', () => {
    it("un jeton de plus d'un jour est renouvelé automatiquement (X-Refreshed-Token), un jeton récent non", async () => {
      expect((await founder.get('/me')).res.headers.get('x-refreshed-token')).toBeNull();
      const tv = (await srv.sql('SELECT token_version tv FROM users WHERE id = ?', founder.user.id)).rows[0].tv;
      const old = jwt.sign({ sub: founder.user.id, tv, iat: Math.floor(Date.now() / 1000) - 2 * 86_400 }, JWT_SECRET, { expiresIn: '7d' });
      const c = new Client(srv.url);
      c.token = old;
      const r = await c.get('/me');
      expect(r.status).toBe(200);
      const fresh = r.res.headers.get('x-refreshed-token');
      expect(fresh).toBeTruthy();
      c.token = fresh as string;
      expect((await c.get('/me')).status).toBe(200);
      const exp = (jwt.decode(fresh as string) as { exp: number; iat: number });
      expect(exp.exp - exp.iat).toBe(7 * 86_400);
    });
    it('« Déconnecter tous mes appareils » invalide les anciens jetons et en rend un neuf', async () => {
      const c = await new Client(srv.url).register('Multi', 'multi@t.test', srv.codes.member);
      const other = new Client(srv.url);
      other.token = (await login(srv, 'multi@t.test', 'motdepasse123')).data.token;
      expect((await other.get('/me')).status).toBe(200);
      const r = await c.post('/me/sessions/revoke');
      expect(r.status).toBe(200);
      expect((await other.get('/me')).status).toBe(401);
      expect((await c.get('/me')).status).toBe(401);
      c.token = r.data.token;
      expect((await c.get('/me')).status).toBe(200);
    });
  });

  describe('Anti force brute', () => {
    it('par compte : le compte est temporairement bloqué après trop d\'échecs, même avec le bon mot de passe', async () => {
      await new Client(srv.url).register('Cible', 'cible@t.test', srv.codes.member);
      for (let i = 0; i < 4; i++) expect((await login(srv, 'cible@t.test', 'faux-mot-de-passe')).status).toBe(401);
      expect((await login(srv, 'cible@t.test', 'motdepasse123')).status).toBe(429);
      const notes = (await admin.get('/notifications')).data.notifications as any[];
      expect(notes.some((n) => /Échecs de connexion répétés/.test(n.title))).toBe(true);
      // un autre compte n'est pas touché
      expect((await login(srv, 'f@t.test', 'motdepasse123')).status).toBe(200);
    });
    it('seuls les échecs comptent : des connexions réussies en rafale ne bloquent personne', async () => {
      for (let i = 0; i < 15; i++) expect((await login(srv, 'f@t.test', 'motdepasse123')).status).toBe(200);
    });
    it('un mauvais code d\'invitation compte comme un échec', async () => {
      const before = (await srv.sql("SELECT COALESCE(SUM(count),0) n FROM rate_limits WHERE key LIKE 'fail:ip:%'")).rows[0].n;
      const r = await new Client(srv.url).post('/auth/register', { name: 'X', email: 'x2@t.test', password: 'motdepasse123', inviteCode: 'FAUX', consent: true });
      expect(r.status).toBe(403);
      const after = (await srv.sql("SELECT COALESCE(SUM(count),0) n FROM rate_limits WHERE key LIKE 'fail:ip:%'")).rows[0].n;
      expect(after).toBeGreaterThan(before);
    });
    it("par adresse : après trop d'échecs sur des comptes différents, l'adresse est bloquée", async () => {
      const s2 = await startServer({ env: { AUTH_FAIL_LIMIT_IP: '5', AUTH_FAIL_LIMIT_ACCOUNT: '100' } });
      try {
        await new Client(s2.url).register('Admin', 'a@t.test');
        for (let i = 0; i < 5; i++) expect((await login(s2, `inconnu${i}@t.test`, 'x'.repeat(12))).status).toBe(401);
        expect((await login(s2, 'a@t.test', 'motdepasse123')).status).toBe(429);
      } finally {
        await s2.stop();
      }
    });
  });

  describe('Journal d\'accès en base', () => {
    it('les requêtes sont enregistrées en base et lisibles par le Super Admin seulement', async () => {
      await founder.get('/me');
      expect((await founder.get('/admin/access-logs')).status).toBe(403);
      const r = await admin.get('/admin/access-logs');
      expect(r.status).toBe(200);
      const lines = (r.data.lines as string[]).map((l) => JSON.parse(l));
      expect(lines.some((l) => l.path.includes('/me') && l.user === founder.user.id)).toBe(true);
      expect((await srv.sql('SELECT COUNT(*) n FROM access_logs')).rows[0].n).toBeGreaterThan(0);
    });
    it('les lignes de plus de 12 mois sont purgées au démarrage des tâches', async () => {
      await srv.sql("INSERT INTO access_logs (t, ip, user_id, method, path, status, ms) VALUES (?, '1.1.1.1', NULL, 'GET', '/ancien', 200, 1)", new Date(Date.now() - 400 * 86_400_000).toISOString());
      await srv.restart();
      await new Promise((r) => setTimeout(r, 500));
      expect((await srv.sql("SELECT COUNT(*) n FROM access_logs WHERE path = '/ancien'")).rows[0].n).toBe(0);
    });
  });

  describe('Fichiers', () => {
    it("le contenu doit correspondre à l'extension (415 sinon)", async () => {
      expect((await founder.upload({ name: 'faux.pdf', content: 'ceci est du texte', raw: true })).status).toBe(415);
      expect((await founder.upload({ name: 'faux.png', content: '<html>', raw: true })).status).toBe(415);
      expect((await founder.upload({ name: 'renomme.png', content: 'x', raw: true, type: 'image/jpeg' })).status).toBe(415);
      expect((await founder.upload({ name: 'faux.docx', content: 'MZ\x90', raw: true })).status).toBe(415);
      expect((await founder.upload({ name: 'note.txt', content: 'a\0b', raw: true })).status).toBe(415);
      expect((await founder.upload({ name: 'vrai.pdf', content: 'ok' })).status).toBe(201);
      expect((await founder.upload({ name: 'vrai.png', content: 'ok' })).status).toBe(201);
      expect((await founder.upload({ name: 'texte.txt', content: 'bonjour' })).status).toBe(201);
    });
    it('quota de stockage par personne (413 au-delà)', async () => {
      const c = await new Client(srv.url).register('Quota', 'quota@t.test', srv.codes.member);
      expect((await c.upload({ name: 'a.txt', content: 'x'.repeat(1500) })).status).toBe(201);
      const r = await c.upload({ name: 'b.txt', content: 'x'.repeat(1500) });
      expect(r.status).toBe(413);
      expect(r.data.error).toMatch(/Quota/);
      // un autre compte garde son propre quota
      expect((await founder.upload({ name: 'c.txt', content: 'x'.repeat(1500) })).status).toBe(201);
    });
  });
});
